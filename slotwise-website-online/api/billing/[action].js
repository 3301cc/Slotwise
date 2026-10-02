"use strict";
// Vercel-Einstieg für den Stripe-Abo-Checkout:
//   GET /api/billing/config · POST /api/billing/checkout · POST /api/billing/webhook
// Eine Funktion statt drei (Vercel Hobby: höchstens 12 Funktionen je Deployment). Logik: api/_lib/core/billing.js.
// Der Webhook liest den Roh-Body selbst (http.js, readRawBody) – req.body von Vercel wird dafür nicht angefasst.
const { routes, writeResult } = require("../_lib/http");

const ACTIONS = new Set(["config", "checkout", "webhook"]);
const json = { "Content-Type": "application/json" };

module.exports = (req, res) => {
  const fromQuery = req.query && typeof req.query.action === "string" ? req.query.action : "";
  const action = fromQuery || new URL(req.url || "/", "http://local").pathname.replace(/\/$/, "").split("/").pop();
  if (!ACTIONS.has(action)) return writeResult(res, { status: 404, body: { error: "not_found" }, headers: json });
  const method = String(req.method || "GET").toUpperCase();
  const route = routes[`${method} /api/billing/${action}`];
  if (route) return route(req, res);
  const allow = Object.keys(routes).filter((k) => k.endsWith(` /api/billing/${action}`)).map((k) => k.split(" ")[0]).join(", ");
  return writeResult(res, { status: 405, body: { error: "method_not_allowed" }, headers: { ...json, Allow: allow } });
};
