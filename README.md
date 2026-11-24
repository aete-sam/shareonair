# ShareOnAir

Share text and files with every device on the same Wi-Fi / Ethernet network.
No codes, no links, no accounts: open the site, then upload or download.

- Text sharing: Save, Copy, Clear, with live updates on every device
- Files: up to **50 MB each**, **5 at a time**, **200 MB per network**, with drag-and-drop, paste and progress bars
- Live "devices online" count (Server-Sent Events)
- Everything auto-deletes after 1 hour
- No dependencies: only Node.js 18+

## How "same network" works
The server groups visitors by **public IP address**. Every device behind one router
shares one public IPv4, so they land in the same space. IPv6 devices are grouped by their
/64 network prefix. If you run the server inside your own LAN, all private-IP devices share one space.

## Run locally
```bash
node server.js        # or: npm start
# open http://localhost:3000, or http://<your-PC-LAN-IP>:3000 from your phone
```

## Deploy (so it works like airforshare.com)
It needs a host that runs a real Node server. Serverless hosts like Vercel or Netlify won't work,
because they cap request bodies at a few MB.

**Render (free):** push this folder to GitHub → New → Web Service → Build command: *(blank)* →
Start command: `node server.js`. Done.
Railway, Fly.io, Koyeb or any VPS work the same way.

If you put **Nginx** in front, add `client_max_body_size 60m;` and `proxy_buffering off;`.
On **Cloudflare**, the free plan allows 100 MB uploads, so 50 MB is fine.

## Settings (environment variables)
| Variable | Default | Meaning |
|---|---|---|
| `PORT` | 3000 | Port to listen on |
| `MAX_FILE_MB` | 50 | Max size per file |
| `MAX_FILES_AT_ONCE` | 5 | Simultaneous uploads per device |
| `MAX_ROOM_MB` | 200 | Total storage per network |
| `MAX_TOTAL_MB` | 2048 | Total storage for the whole server, across all networks. Keep it below your host's free disk space |
| `MAX_UPLOADS_TOTAL` | 20 | Simultaneous uploads for the whole server |
| `TTL_HOURS` | 1 | Auto-delete after (hours) |
| `TRUST_PROXY` | 1 | Read real IP from `X-Forwarded-For`. Set to `0` if exposed directly with no proxy |

## Files
- `server.js`: HTTP server, network grouping, uploads, downloads, live updates, expiry
- `public/index.html`: the whole frontend (one file)
