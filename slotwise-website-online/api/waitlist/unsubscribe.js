"use strict";
// GET /api/waitlist/unsubscribe?t=…  → entfernt den Eintrag (Link steht in jeder späteren Mail).
const W = require("../_lib/waitlist");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return W.send(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
  if (!W.readiness().ready) return W.redirect(res, "/?warteliste=fehler");

  const check = W.verify(new URL(req.url, "http://x").searchParams.get("t"), "unsub");
  if (!check.ok) return W.redirect(res, "/?warteliste=ungueltig");
  try {
    await W.store.remove(check.data.e);
    return W.redirect(res, "/?warteliste=abgemeldet");
  } catch (err) {
    console.error("[waitlist] Austragen fehlgeschlagen:", err.message);
    return W.redirect(res, "/?warteliste=fehler");
  }
};

/** Für spätere Launch-Mails: persönlicher Austragen-Link. */
module.exports.unsubscribeUrl = (base, email) =>
  `${base}/api/waitlist/unsubscribe?t=${encodeURIComponent(W.sign({ p: "unsub", e: email }))}`;
