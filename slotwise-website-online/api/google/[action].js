"use strict";
// Vercel-Einstieg für „Google Kalender verbinden“:
//   POST /api/google/connect · GET /api/google/callback · GET /api/google/status · POST /api/google/disconnect
// Eine Funktion statt vier (Vercel Hobby: höchstens 12 Funktionen je Deployment). Logik: api/_lib/core/google.js.
const { routes, writeResult } = require("../_lib/http");

const ACTIONS = new Set(["connect", "callback", "status", "disconnect"]);
const json = { "Content-Type": "application/json" };

module.exports = (req, res) => {
  const fromQuery = req.query && typeof req.query.action === "string" ? req.query.action : "";
  const action = fromQuery || new URL(req.url || "/", "http://local").pathname.replace(/\/$/, "").split("/").pop();
  if (!ACTIONS.has(action)) return writeResult(res, { status: 404, body: { error: "not_found" }, headers: json });
  const method = String(req.method || "GET").toUpperCase();
  const route = routes[`${method} /api/google/${action}`];
  if (route) return route(req, res);
  const allow = Object.keys(routes).filter((k) => k.endsWith(` /api/google/${action}`)).map((k) => k.split(" ")[0]).join(", ");
  return writeResult(res, { status: 405, body: { error: "method_not_allowed" }, headers: { ...json, Allow: allow } });
};
