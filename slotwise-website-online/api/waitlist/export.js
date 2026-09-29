"use strict";
// GET /api/waitlist/export   Authorization: Bearer <WAITLIST_ADMIN_TOKEN>   → CSV aller bestätigten Einträge
const crypto = require("node:crypto");
const W = require("../_lib/waitlist");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return W.send(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });

  const expected = process.env.WAITLIST_ADMIN_TOKEN || (W.IS_DEPLOYED ? "" : "local-admin");
  const given = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given), b = Buffer.from(expected);
  if (!expected || a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return W.send(res, 401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
  }

  try {
    const all = await W.store.all();
    const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const rows = Object.entries(all)
      .sort((x, y) => String(x[1].confirmedAt).localeCompare(String(y[1].confirmedAt)))
      .map(([email, e]) => [email, e.source, e.confirmedAt].map(q).join(","));
    return W.send(res, 200, ["email,source,confirmed_at", ...rows].join("\n") + "\n", {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="slotwise-warteliste.csv"',
    });
  } catch (err) {
    console.error("[waitlist] Export fehlgeschlagen:", err.message);
    return W.send(res, 502, { error: "upstream_failed" });
  }
};
