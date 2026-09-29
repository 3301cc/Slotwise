"use strict";
// POST /api/waitlist  { email, consent: true, source?, company? (Honigtopf) }
const W = require("../_lib/waitlist");

module.exports = async function handler(req, res) {
  if (req.method !== "POST") return W.send(res, 405, { error: "method_not_allowed" }, { Allow: "POST" });

  const state = W.readiness();
  if (!state.ready) {
    console.error("[waitlist] nicht eingerichtet, es fehlt:", state.missing.join(", "));
    return W.send(res, 503, { error: "not_configured" });
  }

  const body = await W.readJson(req);
  if (!body) return W.send(res, 400, { error: "invalid_body" });

  // Honigtopf: Bots füllen das versteckte Feld aus. Antwort sieht aus wie Erfolg, passiert aber nichts.
  if (typeof body.company === "string" && body.company.trim() !== "") return W.send(res, 202, { status: "pending" });

  const email = W.normalizeEmail(body.email);
  if (!email) return W.send(res, 422, { error: "invalid_email" });
  if (body.consent !== true) return W.send(res, 422, { error: "consent_required" });
  const source = W.SOURCES.has(body.source) ? body.source : "start";

  try {
    if (await W.rateLimited(W.clientIp(req))) return W.send(res, 429, { error: "rate_limited" }, { "Retry-After": "600" });

    // Bereits bestätigt: keine zweite Mail, gleiche Antwort (verrät nicht, wer eingetragen ist).
    if (await W.store.get(email)) return W.send(res, 202, { status: "pending" });

    const base = W.siteUrl(req);
    const token = W.sign({ p: "confirm", e: email, s: source, x: Date.now() + W.TOKEN_TTL_MS });
    const confirmUrl = `${base}/api/waitlist/confirm?t=${encodeURIComponent(token)}`;

    if (W.mailConfigured()) {
      await W.sendMail({
        to: email,
        subject: "Bitte bestätige deine Anmeldung zur Slotwise-Warteliste",
        text: [
          "Hallo,",
          "",
          "du hast dich für die Warteliste von Slotwise eingetragen. Bitte bestätige deine E-Mail-Adresse:",
          confirmUrl,
          "",
          "Der Link gilt 72 Stunden. Warst du das nicht, ignoriere diese Mail einfach – dann speichern wir nichts.",
          "",
          "Slotwise",
          `${base}/datenschutz`,
        ].join("\n"),
        html: `<p>Hallo,</p><p>du hast dich für die Warteliste von Slotwise eingetragen. Bitte bestätige deine E-Mail-Adresse:</p>
<p><a href="${W.escapeHtml(confirmUrl)}" style="display:inline-block;background:#059669;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Anmeldung bestätigen</a></p>
<p style="color:#64748b;font-size:13px">Der Link gilt 72 Stunden. Warst du das nicht, ignoriere diese Mail einfach – dann speichern wir nichts.</p>
<p style="color:#64748b;font-size:13px">Slotwise · <a href="${W.escapeHtml(base)}/datenschutz">Datenschutz</a></p>`,
      });
      return W.send(res, 202, { status: "pending" });
    }

    // Nur lokal erreichbar (readiness verlangt Mailversand im Deployment).
    console.log(`[waitlist] Bestätigungslink für ${email}: ${confirmUrl}`);
    return W.send(res, 202, { status: "pending", devConfirmUrl: confirmUrl });
  } catch (err) {
    console.error("[waitlist] Fehler:", err.message);
    return W.send(res, 502, { error: "upstream_failed" });
  }
};
