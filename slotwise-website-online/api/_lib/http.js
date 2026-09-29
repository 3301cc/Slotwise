"use strict";
/*
 * HTTP-Adapter: übersetzt zwischen der Plattform und der reinen Geschäftslogik.
 *
 *   Geschäftslogik  (api/_lib/core/*)     kennt nur { body, query, headers, ip, baseUrl } → { status, body, headers, redirect }
 *   Adapter         (diese Datei)         liest node:http-Objekte, Express/Fastify-Requests oder Vercel-Requests
 *
 * Plattform-Eigenheiten sind hier gebündelt und sonst nirgends:
 *   - Vercel liefert req.body bereits geparst (Objekt) und req.query als Objekt.
 *   - Express mit body-parser: ebenfalls req.body als Objekt; ohne: Stream.
 *   - node:http: nur Stream, query steckt in req.url.
 */
const { fromEnv } = require("./core/config");
const { createWaitlist } = require("./core/waitlist");

const MAX_BODY = 10_000;

const { createAgent } = require("./core/agent/agent");
const agentApi = require("./core/agent/api");

/** Eine Instanz je Prozess (Vercel: je Function-Container). */
let instance = null, agentInstance = null;
function getWaitlist() {
  if (!instance) instance = createWaitlist(fromEnv());
  return instance;
}
function getAgent() {
  if (!agentInstance) { const wl = getWaitlist(); agentInstance = createAgent(wl.config, { store: wl.store }); }
  return agentInstance;
}

function parseText(text, contentType) {
  if (!text) return {};
  if (/application\/x-www-form-urlencoded/i.test(contentType || "")) return Object.fromEntries(new URLSearchParams(text));
  try { return JSON.parse(text); } catch { return null; }
}
async function readBody(req) {
  const ct = (req.headers && req.headers["content-type"]) || "";
  if (req.body !== undefined && req.body !== null) {
    if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;   // Vercel, Express+json()/urlencoded()
    if (typeof req.body === "string") return parseText(req.body, ct);
    if (Buffer.isBuffer(req.body)) return parseText(req.body.toString("utf8"), ct);
  }
  if (typeof req[Symbol.asyncIterator] !== "function") return null;          // kein Stream (z. B. Test-Objekt)
  const chunks = []; let size = 0;
  for await (const c of req) { size += c.length; if (size > MAX_BODY) return null; chunks.push(c); }
  return parseText(Buffer.concat(chunks).toString("utf8"), ct);
}

function baseUrlFor(req, config) {
  if (config.siteUrl) return config.siteUrl;
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return host ? `${proto}://${host}` : "";
}

/** Normalisiert node:http / Express / Fastify(raw) / Vercel zu reinen Daten. */
async function toInput(req, config) {
  const url = new URL(req.url || "/", "http://local");
  const query = req.query && typeof req.query === "object" && !Array.isArray(req.query)
    ? req.query
    : Object.fromEntries(url.searchParams);
  const fwd = req.headers["x-forwarded-for"];
  const ip = (typeof fwd === "string" && fwd.split(",")[0].trim()) || (req.socket && req.socket.remoteAddress) || "unknown";
  const method = (req.method || "GET").toUpperCase();
  const proto = String(req.headers["x-forwarded-proto"] || "http").split(",")[0].trim();
  const host = req.headers["x-forwarded-host"] || req.headers.host || "localhost";
  return {
    method,
    path: url.pathname,
    fullUrl: `${proto}://${host}${req.url || "/"}`,   // exakt die von außen aufgerufene Adresse (Twilio-Signatur)
    query,
    headers: req.headers || {},
    ip,
    baseUrl: baseUrlFor(req, config),
    body: method === "POST" || method === "PUT" ? await readBody(req) : undefined,
  };
}

/** Schreibt ein Ergebnis der Geschäftslogik in eine node:http-/Express-/Vercel-Antwort. */
function writeResult(res, result) {
  res.statusCode = result.status;
  res.setHeader("Cache-Control", "no-store");
  if (result.redirect) { res.setHeader("Location", result.redirect); return res.end(); }
  for (const [k, v] of Object.entries(result.headers || {})) res.setHeader(k, v);
  if (result.body === undefined) return res.end();
  res.end(typeof result.body === "string" ? result.body : JSON.stringify(result.body));
}

/**
 * Baut aus einer Core-Operation einen (req, res)-Handler, wie ihn Vercel, node:http und Express erwarten.
 *   module.exports = handler("POST", (wl, input) => wl.subscribe(input));
 */
function handler(method, run) {
  return async function (req, res) {
    const wl = getWaitlist();
    const input = await toInput(req, wl.config);
    if (input.method !== method) return writeResult(res, { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: method, "Content-Type": "application/json" } });
    if ((method === "POST" || method === "PUT") && input.body === null) return writeResult(res, { status: 400, body: { error: "invalid_body" }, headers: { "Content-Type": "application/json" } });
    try {
      writeResult(res, await run(wl, input));
    } catch (err) {
      console.error("[waitlist] unerwarteter Fehler:", err);
      writeResult(res, { status: 500, body: { error: "internal" }, headers: { "Content-Type": "application/json" } });
    }
  };
}

/** Routen-Tabelle – von Vercel-Dateien, dem Standalone-Server und Express gleichermaßen genutzt. */
const routes = {
  "POST /api/waitlist": handler("POST", (wl, i) => wl.subscribe(i)),
  "GET /api/waitlist/confirm": handler("GET", (wl, i) => wl.confirm(i)),
  "GET /api/waitlist/unsubscribe": handler("GET", (wl, i) => wl.unsubscribe(i)),
  "GET /api/waitlist/export": handler("GET", (wl, i) => wl.exportCsv(i)),
  "GET /api/waitlist/stats": handler("GET", (wl, i) => wl.stats(i)),
  // KI-Agent
  "POST /api/agent/voice-webhook": handler("POST", (wl, i) => agentApi.voiceWebhook(getAgent(), wl.config, i)),
  "POST /api/agent/intake": handler("POST", (wl, i) => agentApi.intake(getAgent(), wl.config, i)),
  "GET /api/agent/activity": handler("GET", (wl, i) => agentApi.activity(getAgent(), wl.config, i)),
  "GET /api/agent/settings": handler("GET", (wl, i) => agentApi.getSettings(getAgent(), wl.config, i)),
  "PUT /api/agent/settings": handler("PUT", (wl, i) => agentApi.putSettings(getAgent(), wl.config, i)),
  "GET /api/agent/week": handler("GET", (wl, i) => agentApi.week(getAgent(), wl.config, i)),
  "POST /api/agent/decision": handler("POST", (wl, i) => agentApi.decision(getAgent(), wl.config, i)),
  "GET /api/agent/status": handler("GET", (wl, i) => agentApi.status(getAgent(), wl.config, i)),
};

/** Ein einzelner Handler für alle Routen (node:http, Express `app.use(apiHandler)`, Fastify über `fastify-express`). */
function apiHandler(req, res, next) {
  const path = new URL(req.url || "/", "http://local").pathname.replace(/\/$/, "");
  const key = `${(req.method || "GET").toUpperCase()} ${path}`;
  const known = Object.keys(routes).find((k) => k.split(" ")[1] === path);
  if (routes[key]) return routes[key](req, res);
  if (known) return writeResult(res, { status: 405, body: { error: "method_not_allowed" }, headers: { Allow: known.split(" ")[0], "Content-Type": "application/json" } });
  if (typeof next === "function") return next();
  return writeResult(res, { status: 404, body: { error: "not_found" }, headers: { "Content-Type": "application/json" } });
}

module.exports = { handler, routes, apiHandler, toInput, writeResult, getWaitlist, getAgent, readBody };
