"use strict";
// Lokaler Server: statische Dateien + api/*-Funktionen wie auf Vercel.  node scripts/dev-server.js [port]
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.argv[2] || process.env.PORT || 3000);
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json" };

function apiHandler(urlPath) {
  const rel = urlPath.replace(/^\/api\//, "").replace(/\/$/, "");
  if (!rel || rel.split("/").some((p) => p.startsWith("_") || p === "..")) return null;
  for (const f of [`${rel}.js`, `${rel}/index.js`]) {
    const file = path.join(ROOT, "api", f);
    if (fs.existsSync(file)) return require(file);
  }
  return null;
}

http.createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://localhost");
  if (pathname.startsWith("/api/")) {
    const h = apiHandler(pathname);
    if (!h) { res.statusCode = 404; return res.end("not found"); }
    try { await h(req, res); } catch (e) { console.error(e); res.statusCode = 500; res.end("error"); }
    return;
  }
  let file = path.join(ROOT, decodeURIComponent(pathname));
  if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory() || file.includes(`${path.sep}.data`)) {
    file = path.join(ROOT, "index.html"); // SPA-Rewrite wie in vercel.json
  }
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  fs.createReadStream(file).pipe(res);
}).listen(PORT, () => console.log(`Slotwise lokal: http://localhost:${PORT}`));
