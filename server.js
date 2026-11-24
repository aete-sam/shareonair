// ShareOnAir — share text & files with devices on the same network.
// Zero dependencies: needs only Node.js 18+.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { pipeline } = require('stream/promises');

// ---------- Config (override with environment variables) ----------
const PORT = Number(process.env.PORT) || 3000;
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB) || 50;          // per file
const MAX_FILES_AT_ONCE = Number(process.env.MAX_FILES_AT_ONCE) || 5; // simultaneous uploads per device
const MAX_ROOM_MB = Number(process.env.MAX_ROOM_MB) || 500;         // total storage per network
const TTL_HOURS = Number(process.env.TTL_HOURS) || 1;               // auto-delete after
const TRUST_PROXY = process.env.TRUST_PROXY !== '0';                // read X-Forwarded-For (needed on Render/Railway/etc.)
const MAX_TEXT = 100000;                                            // characters

const MAX_FILE = MAX_FILE_MB * 1024 * 1024;
const MAX_ROOM_BYTES = MAX_ROOM_MB * 1024 * 1024;
const TTL_MS = TTL_HOURS * 3600 * 1000;
const DATA_DIR = path.join(__dirname, 'data');
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');
const ASSETS_DIR = path.join(__dirname, 'public', 'assets');

// ---------- Network detection ----------
function clientIp(req) {
  let ip = req.socket.remoteAddress || '';
  if (TRUST_PROXY) {
    const fwd = req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for'];
    if (fwd) ip = String(fwd).split(',')[0].trim();
  }
  if (ip.startsWith('::ffff:')) ip = ip.slice(7); // IPv4-mapped IPv6
  return ip;
}

function expandIPv6(ip) {
  ip = ip.split('%')[0];
  const parts = ip.split('::');
  const head = parts[0] ? parts[0].split(':') : [];
  if (parts.length === 1) return head.map(p => p.padStart(4, '0')).join(':');
  const tail = parts[1] ? parts[1].split(':') : [];
  const fill = Array(Math.max(0, 8 - head.length - tail.length)).fill('0');
  return [...head, ...fill, ...tail].map(p => p.padStart(4, '0')).join(':');
}

function isPrivate(ip) {
  return /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(ip) ||
    ip === '::1' || /^(fc|fd|fe80)/i.test(ip);
}

// Devices behind the same router share one public IPv4. With IPv6 every device has
// its own address, but they share the same /64 prefix — so we group by that.
function networkKey(ip) {
  if (isPrivate(ip)) return 'local-network'; // server running inside the LAN
  if (ip.includes(':')) return expandIPv6(ip).split(':').slice(0, 4).join(':') + '::/64';
  return ip;
}

// ---------- Rooms (one per network) ----------
const rooms = new Map();
const uploadsInProgress = new Map(); // ip -> count

function getRoom(req) {
  const id = crypto.createHash('sha256').update(networkKey(clientIp(req))).digest('hex').slice(0, 20);
  let room = rooms.get(id);
  if (!room) {
    room = { id, text: '', textUpdated: 0, files: new Map(), bytes: 0, clients: new Set() };
    rooms.set(id, room);
  }
  return room;
}

function stateOf(room) {
  return {
    text: room.text,
    textUpdated: room.textUpdated,
    files: [...room.files.values()]
      .sort((a, b) => b.uploaded - a.uploaded)
      .map(({ id, name, size, uploaded }) => ({ id, name, size, uploaded })),
    used: room.bytes,
    devices: room.clients.size,
    limits: { maxFile: MAX_FILE, maxFiles: MAX_FILES_AT_ONCE, maxRoom: MAX_ROOM_BYTES, maxText: MAX_TEXT, ttlHours: TTL_HOURS },
  };
}

function broadcast(room) {
  const msg = `data: ${JSON.stringify(stateOf(room))}\n\n`;
  for (const res of room.clients) res.write(msg);
}

// ---------- Helpers ----------
function send(res, code, obj, headers = {}) {
  if (res.headersSent) return;
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(body);
}

// Reply to an upload we refuse without reading the whole body.
function refuse(req, res, code, error) {
  send(res, code, { error }, { Connection: 'close' });
  req.resume();
  setTimeout(() => req.destroy(), 5000).unref();
}

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(new Error('Body too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function contentDisposition(name) {
  const ascii = name.replace(/[^\x20-\x7e]|["\\]/g, '_');
  const utf8 = encodeURIComponent(name).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  return `attachment; filename="${ascii}"; filename*=UTF-8''${utf8}`;
}

// ---------- Handlers ----------
async function handleUpload(req, res, room, ip) {
  const len = Number(req.headers['content-length']);
  if (!Number.isFinite(len) || len < 0) return refuse(req, res, 411, 'Missing file size');
  if (len > MAX_FILE) return refuse(req, res, 413, `File is larger than ${MAX_FILE_MB} MB`);
  if (room.bytes + len > MAX_ROOM_BYTES) return refuse(req, res, 507, `Network storage is full (${MAX_ROOM_MB} MB). Delete some files first.`);
  const active = uploadsInProgress.get(ip) || 0;
  if (active >= MAX_FILES_AT_ONCE) return refuse(req, res, 429, `Only ${MAX_FILES_AT_ONCE} uploads at a time`);

  let name = 'file';
  try { name = decodeURIComponent(req.headers['x-file-name'] || 'file'); } catch {}
  name = path.basename(name.replace(/\\/g, '/')).replace(/[\x00-\x1f\x7f]/g, '').slice(0, 200) || 'file';

  // Reserve the slot and the space before any await, so parallel requests can't slip past the limits.
  room.bytes += len;
  uploadsInProgress.set(ip, active + 1);

  const id = crypto.randomBytes(9).toString('base64url');
  const dir = path.join(DATA_DIR, room.id);
  const filePath = path.join(dir, id);
  let released = false;
  const release = ok => {
    if (released) return; released = true;
    const n = (uploadsInProgress.get(ip) || 1) - 1;
    n ? uploadsInProgress.set(ip, n) : uploadsInProgress.delete(ip);
    if (!ok) room.bytes -= len;
  };

  let received = 0;
  try { await fsp.mkdir(dir, { recursive: true }); }
  catch { release(false); return refuse(req, res, 500, 'Storage error'); }
  const out = fs.createWriteStream(filePath);
  req.on('data', c => {
    received += c.length;
    if (received > len) req.destroy(new Error('Body larger than declared'));
  });

  try {
    await pipeline(req, out);
    if (received !== len) throw new Error('Incomplete upload');
  } catch (e) {
    release(false);
    fsp.unlink(filePath).catch(() => {});
    return send(res, 400, { error: 'Upload interrupted' });
  }

  release(true);
  room.files.set(id, { id, name, size: received, uploaded: Date.now(), path: filePath });
  broadcast(room);
  send(res, 200, { ok: true, id });
}

function handleDownload(req, res, room, id) {
  const f = room.files.get(id);
  if (!f) return send(res, 404, { error: 'File not found (it may have expired)' });
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Content-Length': f.size,
    'Content-Disposition': contentDisposition(f.name),
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(f.path).on('error', () => res.destroy()).pipe(res);
}

async function deleteFile(room, id) {
  const f = room.files.get(id);
  if (!f) return false;
  room.files.delete(id);
  room.bytes -= f.size;
  await fsp.unlink(f.path).catch(() => {});
  return true;
}

// ---------- Server ----------
const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    const ip = clientIp(req);
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');

    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
      return fs.createReadStream(INDEX_HTML).pipe(res);
    }
    if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
    const asset = p.match(/^\/assets\/([\w-]+\.png)$/);
    if (req.method === 'GET' && asset) {
      const file = path.join(ASSETS_DIR, asset[1]);
      return fs.stat(file, (err, st) => {
        if (err || !st.isFile()) return send(res, 404, { error: 'Not found' });
        res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': st.size, 'Cache-Control': 'public, max-age=86400' });
        fs.createReadStream(file).pipe(res);
      });
    }

    const room = getRoom(req);

    if (req.method === 'GET' && p === '/api/events') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
      res.write('retry: 3000\n\n');
      room.clients.add(res);
      broadcast(room); // sends state to the new client and updates device count for others
      const ping = setInterval(() => res.write(': ping\n\n'), 25000);
      req.on('close', () => { clearInterval(ping); room.clients.delete(res); broadcast(room); });
      return;
    }
    if (req.method === 'GET' && p === '/api/state') return send(res, 200, stateOf(room));

    if (req.method === 'POST' && p === '/api/text') {
      const body = await readJson(req, MAX_TEXT * 4 + 1024);
      room.text = String(body.text ?? '').slice(0, MAX_TEXT);
      room.textUpdated = Date.now();
      broadcast(room);
      return send(res, 200, { ok: true });
    }

    if (req.method === 'POST' && p === '/api/upload') return handleUpload(req, res, room, ip);

    const m = p.match(/^\/api\/files\/([\w-]+)$/);
    if (m && req.method === 'GET') return handleDownload(req, res, room, m[1]);
    if (m && req.method === 'DELETE') {
      if (!(await deleteFile(room, m[1]))) return send(res, 404, { error: 'File not found' });
      broadcast(room);
      return send(res, 200, { ok: true });
    }

    send(res, 404, { error: 'Not found' });
  } catch (e) {
    console.error(e);
    send(res, 500, { error: 'Server error' });
  }
});

// Big files on slow Wi-Fi can take a while — allow up to 30 minutes per request.
server.requestTimeout = 30 * 60 * 1000;

// ---------- Expiry ----------
async function cleanup() {
  const cutoff = Date.now() - TTL_MS;
  for (const room of rooms.values()) {
    let changed = false;
    for (const f of [...room.files.values()]) if (f.uploaded < cutoff) { await deleteFile(room, f.id); changed = true; }
    if (room.text && room.textUpdated < cutoff) { room.text = ''; changed = true; }
    if (changed) broadcast(room);
    if (!room.files.size && !room.text && !room.clients.size) {
      rooms.delete(room.id);
      fsp.rm(path.join(DATA_DIR, room.id), { recursive: true, force: true }).catch(() => {});
    }
  }
}

(async () => {
  // Shared items live in memory + temp folder; start clean on each boot.
  await fsp.rm(DATA_DIR, { recursive: true, force: true });
  await fsp.mkdir(DATA_DIR, { recursive: true });
  setInterval(cleanup, 5 * 60 * 1000).unref();
  server.listen(PORT, () => console.log(`ShareOnAir running on http://localhost:${PORT}`));
})();
