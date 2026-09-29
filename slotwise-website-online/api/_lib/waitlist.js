"use strict";
/*
 * Warteliste – gemeinsame Logik für die Vercel-Funktionen unter api/waitlist/.
 *
 * Ablauf (Double-Opt-in, ohne Vorab-Speicherung):
 *   1. POST /api/waitlist        prüft die Adresse und verschickt einen signierten Bestätigungslink.
 *                                Unbestätigte Adressen werden NICHT gespeichert.
 *   2. GET  /api/waitlist/confirm?t=…   prüft Signatur + Ablauf, legt den Eintrag an.
 *   3. GET  /api/waitlist/unsubscribe?t=…  entfernt den Eintrag.
 *   4. GET  /api/waitlist/export  (Bearer WAITLIST_ADMIN_TOKEN) liefert CSV.
 *
 * Umgebungsvariablen (Vercel → Settings → Environment Variables):
 *   WAITLIST_SECRET            zufälliger String ≥ 32 Zeichen (Signatur der Links)       Pflicht
 *   KV_REST_API_URL / KV_REST_API_TOKEN                                                   Pflicht
 *     (oder UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN) – Redis mit REST-API, Region Frankfurt
 *   MAILJET_API_KEY / MAILJET_API_SECRET                                                  Pflicht
 *   WAITLIST_FROM_EMAIL        verifizierte Absenderadresse bei Mailjet                   Pflicht
 *   WAITLIST_FROM_NAME         Absendername (Standard „Slotwise“)
 *   WAITLIST_NOTIFY_EMAIL      optional: Benachrichtigung bei jeder Bestätigung
 *   WAITLIST_ADMIN_TOKEN       optional: Zugriff auf den CSV-Export
 *   SITE_URL                   z. B. https://slotwise.app (sonst Vercel-Produktions-URL)
 *
 * Lokal (ohne VERCEL-Umgebung) genügt nichts davon: Einträge landen in .data/waitlist.json,
 * der Bestätigungslink wird in der Konsole ausgegeben und in der Antwort mitgeliefert.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const IS_DEPLOYED = Boolean(process.env.VERCEL);
const TOKEN_TTL_MS = 72 * 60 * 60 * 1000;
const SOURCES = new Set(["start", "anmelden", "demo", "preise", "ki-agent", "footer", "login"]);
const REDIS_KEY = "waitlist:v1";

// ---------- Validierung ----------
// Pragmatisch statt RFC-vollständig: ein @, keine Leerzeichen, Domain mit Punkt und TLD ≥ 2.
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  const [local] = email.split("@");
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return EMAIL_RE.test(email) ? email : null;
}

// ---------- Signierte Tokens ----------
function secret() {
  const s = process.env.WAITLIST_SECRET;
  if (s && s.length >= 32) return s;
  if (!IS_DEPLOYED) return "local-dev-secret-not-for-production-use";
  return null;
}
const b64u = (buf) => Buffer.from(buf).toString("base64url");

function sign(payload) {
  const body = b64u(JSON.stringify(payload));
  const mac = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  return `${body}.${mac}`;
}

function verify(token, purpose) {
  if (typeof token !== "string" || token.length > 1024 || !token.includes(".")) return { ok: false, reason: "invalid" };
  const [body, mac] = token.split(".");
  const expected = crypto.createHmac("sha256", secret()).update(body).digest("base64url");
  const a = Buffer.from(mac || ""), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
  let data;
  try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid" }; }
  if (data.p !== purpose || !normalizeEmail(data.e)) return { ok: false, reason: "invalid" };
  if (data.x && Date.now() > data.x) return { ok: false, reason: "expired" };
  return { ok: true, data };
}

// ---------- Speicher ----------
function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url: url.replace(/\/$/, ""), token } : null;
}

async function redis(cmd) {
  const cfg = redisConfig();
  const res = await fetch(cfg.url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.token}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok || json.error) throw new Error(`redis: ${json.error || res.status}`);
  return json.result;
}

const DEV_FILE = path.join(process.cwd(), ".data", "waitlist.json");
function devRead() {
  try { return JSON.parse(fs.readFileSync(DEV_FILE, "utf8")); } catch { return {}; }
}
function devWrite(all) {
  fs.mkdirSync(path.dirname(DEV_FILE), { recursive: true });
  fs.writeFileSync(DEV_FILE, JSON.stringify(all, null, 2));
}

const store = {
  async get(email) {
    if (redisConfig()) { const v = await redis(["HGET", REDIS_KEY, email]); return v ? JSON.parse(v) : null; }
    return devRead()[email] || null;
  },
  async put(email, entry) {
    if (redisConfig()) return redis(["HSET", REDIS_KEY, email, JSON.stringify(entry)]);
    const all = devRead(); all[email] = entry; devWrite(all);
  },
  async remove(email) {
    if (redisConfig()) return redis(["HDEL", REDIS_KEY, email]);
    const all = devRead(); delete all[email]; devWrite(all);
  },
  async all() {
    if (redisConfig()) {
      const flat = (await redis(["HGETALL", REDIS_KEY])) || [];
      const out = {};
      for (let i = 0; i < flat.length; i += 2) out[flat[i]] = JSON.parse(flat[i + 1]);
      return out;
    }
    return devRead();
  },
};

// ---------- Rate-Limit (5 Anfragen je IP in 10 Minuten) ----------
const memHits = new Map();
async function rateLimited(ip) {
  const key = crypto.createHash("sha256").update(`rl:${ip}`).digest("hex").slice(0, 32);
  if (redisConfig()) {
    const n = await redis(["INCR", `waitlist:rl:${key}`]);
    if (n === 1) await redis(["EXPIRE", `waitlist:rl:${key}`, 600]);
    return n > 5;
  }
  const now = Date.now();
  const hits = (memHits.get(key) || []).filter((t) => now - t < 600000);
  hits.push(now);
  memHits.set(key, hits);
  return hits.length > 5;
}

// ---------- Mail (Mailjet, Sitz Paris) ----------
function mailConfigured() {
  return Boolean(process.env.MAILJET_API_KEY && process.env.MAILJET_API_SECRET && process.env.WAITLIST_FROM_EMAIL);
}

async function sendMail({ to, subject, text, html }) {
  const auth = Buffer.from(`${process.env.MAILJET_API_KEY}:${process.env.MAILJET_API_SECRET}`).toString("base64");
  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      Messages: [{
        From: { Email: process.env.WAITLIST_FROM_EMAIL, Name: process.env.WAITLIST_FROM_NAME || "Slotwise" },
        To: [{ Email: to }],
        Subject: subject,
        TextPart: text,
        HTMLPart: html,
      }],
    }),
  });
  if (!res.ok) throw new Error(`mailjet: ${res.status} ${await res.text().catch(() => "")}`);
}

// ---------- HTTP-Helfer ----------
function siteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL.replace(/\/$/, "");
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (!IS_DEPLOYED) return `http://${req.headers.host || "localhost:3000"}`;
  return null;
}

function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  return (typeof fwd === "string" && fwd.split(",")[0].trim()) || req.socket?.remoteAddress || "unknown";
}

async function readJson(req) {
  if (req.body && typeof req.body === "object") return req.body;
  if (typeof req.body === "string") { try { return JSON.parse(req.body); } catch { return null; } }
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 10_000) return null; chunks.push(c); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch { return null; }
}

function send(res, status, body, headers = {}) {
  res.statusCode = status;
  res.setHeader("Cache-Control", "no-store");
  for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
  if (body === undefined) return res.end();
  if (typeof body === "string") return res.end(body);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.end(JSON.stringify(body));
}

function redirect(res, location) {
  send(res, 303, undefined, { Location: location });
}

/** Produktiv nur, wenn Signatur, Speicher und Mailversand eingerichtet sind. */
function readiness() {
  if (!IS_DEPLOYED) return { ready: true, mode: "local" };
  const missing = [];
  if (!secret()) missing.push("WAITLIST_SECRET");
  if (!redisConfig()) missing.push("KV_REST_API_URL/KV_REST_API_TOKEN");
  if (!mailConfigured()) missing.push("MAILJET_API_KEY/MAILJET_API_SECRET/WAITLIST_FROM_EMAIL");
  return { ready: missing.length === 0, mode: "production", missing };
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

module.exports = {
  IS_DEPLOYED, TOKEN_TTL_MS, SOURCES, normalizeEmail, sign, verify, store, rateLimited,
  mailConfigured, sendMail, siteUrl, clientIp, readJson, send, redirect, readiness, escapeHtml,
};
