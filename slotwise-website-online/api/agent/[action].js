"use strict";
// Vercel-Einstieg für die Dashboard-Endpunkte des Agenten:
//   GET /api/agent/activity · POST /api/agent/decision · GET/PUT /api/agent/settings
//   GET /api/agent/status   · GET/POST /api/agent/tasks · GET /api/agent/week
// Eine Funktion statt sechs, weil Vercel im Hobby-Plan höchstens 12 Funktionen je Deployment erlaubt.
// Twilio (voice-webhook) und E-Mail (intake) bleiben eigene Dateien.
const { routes, writeResult } = require("../_lib/http");

const ACTIONS = new Set(["activity", "decision", "settings", "status", "tasks", "week"]);
const json = { "Content-Type": "application/json" };

module.exports = (req, res) => {
  const fromQuery = req.query && typeof req.query.action === "string" ? req.query.action : "";
  const action = fromQuery || new URL(req.url || "/", "http://local").pathname.replace(/\/$/, "").split("/").pop();
  if (!ACTIONS.has(action)) return writeResult(res, { status: 404, body: { error: "not_found" }, headers: json });
  const method = String(req.method || "GET").toUpperCase();
  const route = routes[`${method} /api/agent/${action}`];
  if (route) return route(req, res);
  const allow = Object.keys(routes).filter((k) => k.endsWith(` /api/agent/${action}`)).map((k) => k.split(" ")[0]).join(", ");
  return writeResult(res, { status: 405, body: { error: "method_not_allowed" }, headers: { ...json, Allow: allow } });
};
