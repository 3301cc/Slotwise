"use strict";
/*
 * Eigenständiger Server ohne Vercel – für Hetzner, OVH, Docker oder jeden Node-Host.
 *   node server/standalone.js            (PORT, HOST aus der Umgebung; Standard 3000 / 0.0.0.0)
 * Liefert die statische Website (SPA-Rewrite auf index.html) und die API unter /api/.
 * Gleiche Umgebungsvariablen wie auf Vercel (website-src/README.md); statt Upstash geht jeder
 * Redis mit REST-Schnittstelle, oder WAITLIST_DATA_FILE für einen Einzelserver mit JSON-Datei.
 * Hinter einem Reverse-Proxy (nginx/Caddy) X-Forwarded-For und X-Forwarded-Proto setzen.
 */
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { apiHandler } = require("../api/_lib/http");

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".woff": "font/woff", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };
const HEADERS = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin", "X-Frame-Options": "DENY", "Permissions-Policy": "camera=(), microphone=(), geolocation=()" };

function serveStatic(req, res) {
  const { pathname } = new URL(req.url, "http://local");
  let file = path.normalize(path.join(ROOT, decodeURIComponent(pathname)));
  const hidden = /[\\/](\.data|api|server|scripts|node_modules)([\\/]|$)/.test(file) || path.basename(file).startsWith(".");
  if (!file.startsWith(ROOT) || hidden || !fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(ROOT, "index.html");
  for (const [k, v] of Object.entries(HEADERS)) res.setHeader(k, v);
  res.setHeader("Content-Type", TYPES[path.extname(file)] || "application/octet-stream");
  if (file.startsWith(path.join(ROOT, "assets"))) res.setHeader("Cache-Control", "public, max-age=3600");
  fs.createReadStream(file).pipe(res);
}

const server = http.createServer((req, res) => {
  if (new URL(req.url, "http://local").pathname.startsWith("/api/")) return apiHandler(req, res);
  serveStatic(req, res);
});

if (require.main === module) {
  server.listen(PORT, HOST, () => console.log(`Slotwise: http://${HOST}:${PORT}`));
}
module.exports = { server, serveStatic };
