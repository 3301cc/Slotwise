"use strict";
// GET /api/waitlist/confirm?t=…  → legt den Eintrag an und leitet auf die Startseite zurück.
const W = require("../_lib/waitlist");

module.exports = async function handler(req, res) {
  if (req.method !== "GET") return W.send(res, 405, { error: "method_not_allowed" }, { Allow: "GET" });
  if (!W.readiness().ready) return W.redirect(res, "/?warteliste=fehler");

  const t = new URL(req.url, "http://x").searchParams.get("t");
  const check = W.verify(t, "confirm");
  if (!check.ok) return W.redirect(res, `/?warteliste=${check.reason === "expired" ? "abgelaufen" : "ungueltig"}`);

  const { e: email, s: source } = check.data;
  try {
    if (!(await W.store.get(email))) {
      await W.store.put(email, { source: W.SOURCES.has(source) ? source : "start", confirmedAt: new Date().toISOString() });

      if (process.env.WAITLIST_NOTIFY_EMAIL && W.mailConfigured()) {
        const unsub = `${W.siteUrl(req)}/api/waitlist/unsubscribe?t=${encodeURIComponent(W.sign({ p: "unsub", e: email }))}`;
        await W.sendMail({
          to: process.env.WAITLIST_NOTIFY_EMAIL,
          subject: `Warteliste: neuer Eintrag (${source})`,
          text: `${email} hat die Anmeldung bestätigt.\nQuelle: ${source}\nAustragen: ${unsub}`,
          html: `<p><strong>${W.escapeHtml(email)}</strong> hat die Anmeldung bestätigt.<br>Quelle: ${W.escapeHtml(source)}</p><p><a href="${W.escapeHtml(unsub)}">Austragen</a></p>`,
        }).catch((err) => console.error("[waitlist] Benachrichtigung fehlgeschlagen:", err.message));
      }
    }
    return W.redirect(res, "/?warteliste=bestaetigt");
  } catch (err) {
    console.error("[waitlist] Bestätigung fehlgeschlagen:", err.message);
    return W.redirect(res, "/?warteliste=fehler");
  }
};
