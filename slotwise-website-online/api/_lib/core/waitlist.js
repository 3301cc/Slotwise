"use strict";
/*
 * Warteliste – Geschäftslogik, unabhängig von Vercel, Express, Fastify oder node:http.
 *
 * Jede Operation bekommt ein einfaches Objekt und liefert ein einfaches Ergebnis:
 *   Eingabe:  { body?, query?, headers?, ip?, baseUrl? }      (alles reine Daten)
 *   Ausgabe:  { status, body?, headers?, redirect? }          (Adapter schreiben das in die Antwort)
 *
 * Ablauf (Double-Opt-in, ohne Vorab-Speicherung):
 *   subscribe    prüft die Adresse und verschickt einen signierten Bestätigungslink; speichert nichts.
 *   confirm      prüft Signatur + Ablauf, legt den Eintrag an.
 *   unsubscribe  entfernt den Eintrag.
 *   exportCsv    liefert alle bestätigten Einträge (Bearer-Token).
 */
const crypto = require("node:crypto");
const { readiness } = require("./config");
const { normalizeEmail, escapeHtml } = require("./email");
const { createTokens } = require("./tokens");
const { createStore } = require("./store");
const { createMailer } = require("./mailer");

const SOURCES = new Set(["start", "anmelden", "demo", "preise", "ki-agent", "footer", "login", "dashboard", "praxen"]);

const json = (status, body, headers) => ({ status, body, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const redirect = (location) => ({ status: 303, redirect: location });

function createWaitlist(config, deps = {}) {
  const state = readiness(config);
  const store = deps.store || createStore(config);
  const mailer = deps.mailer !== undefined ? deps.mailer : createMailer(config);
  const tokens = deps.tokens || createTokens(config.secret || "local-dev-secret-not-for-production-use");
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());

  function confirmUrl(baseUrl, email, source) {
    const t = tokens.sign({ p: "confirm", e: email, s: source, x: now() + config.tokenTtlMs });
    return `${baseUrl}/api/waitlist/confirm?t=${encodeURIComponent(t)}`;
  }
  function unsubscribeUrl(baseUrl, email) {
    return `${baseUrl}/api/waitlist/unsubscribe?t=${encodeURIComponent(tokens.sign({ p: "unsub", e: email }))}`;
  }
  function authorized(headers) {
    const given = String((headers && headers.authorization) || "").replace(/^Bearer\s+/i, "");
    const a = Buffer.from(given), b = Buffer.from(config.adminToken || "");
    return Boolean(config.adminToken) && a.length === b.length && crypto.timingSafeEqual(a, b);
  }
  async function rateLimited(ip) {
    const key = crypto.createHash("sha256").update(`rl:${ip || "unknown"}`).digest("hex").slice(0, 32);
    const n = await store.incrWithTtl(key, config.rateLimit.windowSec, now());
    return n > config.rateLimit.max;
  }

  return {
    config,
    state,
    tokens,
    store,
    unsubscribeUrl,

    /** POST { email, consent: true, source?, company? (Honigtopf) } */
    async subscribe({ body, ip, baseUrl }) {
      if (!state.ready) {
        log.error("[waitlist] nicht eingerichtet, es fehlt:", state.missing.join(", "));
        return json(503, { error: "not_configured" });
      }
      if (!body || typeof body !== "object") return json(400, { error: "invalid_body" });
      // Honigtopf: Bots füllen das versteckte Feld aus. Antwort sieht aus wie Erfolg, passiert aber nichts.
      if (typeof body.company === "string" && body.company.trim() !== "") return json(202, { status: "pending" });

      const email = normalizeEmail(body.email);
      if (!email) return json(422, { error: "invalid_email" });
      if (body.consent !== true) return json(422, { error: "consent_required" });
      const source = SOURCES.has(body.source) ? body.source : "start";
      if (!baseUrl) return json(500, { error: "base_url_missing" });

      try {
        if (await rateLimited(ip)) return json(429, { error: "rate_limited" }, { "Retry-After": String(config.rateLimit.windowSec) });
        // Bereits bestätigt: keine zweite Mail, gleiche Antwort (verrät nicht, wer eingetragen ist).
        if (await store.get(email)) return json(202, { status: "pending" });

        const url = confirmUrl(baseUrl, email, source);
        if (!mailer) {
          log.log(`[waitlist] Bestätigungslink für ${email}: ${url}`);
          return json(202, { status: "pending", devConfirmUrl: url });
        }
        await mailer.send({
          to: email,
          subject: "Bitte bestätige deine Anmeldung zur CalenSync-Warteliste",
          text: ["Hallo,", "", "du hast dich für die Warteliste von CalenSync eingetragen. Bitte bestätige deine E-Mail-Adresse:", url, "",
            "Der Link gilt 72 Stunden. Warst du das nicht, ignoriere diese Mail einfach – dann speichern wir nichts.", "", "CalenSync", `${baseUrl}/datenschutz`].join("\n"),
          html: `<p>Hallo,</p><p>du hast dich für die Warteliste von CalenSync eingetragen. Bitte bestätige deine E-Mail-Adresse:</p>
<p><a href="${escapeHtml(url)}" style="display:inline-block;background:#4f46e5;color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">Anmeldung bestätigen</a></p>
<p style="color:#64748b;font-size:13px">Der Link gilt 72 Stunden. Warst du das nicht, ignoriere diese Mail einfach – dann speichern wir nichts.</p>
<p style="color:#64748b;font-size:13px">CalenSync · <a href="${escapeHtml(baseUrl)}/datenschutz">Datenschutz</a></p>`,
        });
        return json(202, { status: "pending" });
      } catch (err) {
        log.error("[waitlist] Fehler:", err.message);
        return json(502, { error: "upstream_failed" });
      }
    },

    /** GET ?t=… */
    async confirm({ query, baseUrl }) {
      if (!state.ready) return redirect("/?warteliste=fehler");
      const check = tokens.verify(query && query.t, "confirm", now());
      if (!check.ok) return redirect(`/?warteliste=${check.reason === "expired" ? "abgelaufen" : "ungueltig"}`);
      const { e: email, s } = check.data;
      const source = SOURCES.has(s) ? s : "start";
      try {
        if (!(await store.get(email))) {
          await store.put(email, { source, confirmedAt: new Date(now()).toISOString() });
          if (config.notifyEmail && mailer && baseUrl) {
            const unsub = unsubscribeUrl(baseUrl, email);
            await mailer.send({
              to: config.notifyEmail,
              subject: `Warteliste: neuer Eintrag (${source})`,
              text: `${email} hat die Anmeldung bestätigt.\nQuelle: ${source}\nAustragen: ${unsub}`,
              html: `<p><strong>${escapeHtml(email)}</strong> hat die Anmeldung bestätigt.<br>Quelle: ${escapeHtml(source)}</p><p><a href="${escapeHtml(unsub)}">Austragen</a></p>`,
            }).catch((err) => log.error("[waitlist] Benachrichtigung fehlgeschlagen:", err.message));
          }
        }
        return redirect("/?warteliste=bestaetigt");
      } catch (err) {
        log.error("[waitlist] Bestätigung fehlgeschlagen:", err.message);
        return redirect("/?warteliste=fehler");
      }
    },

    /** GET ?t=… */
    async unsubscribe({ query }) {
      if (!state.ready) return redirect("/?warteliste=fehler");
      const check = tokens.verify(query && query.t, "unsub", now());
      if (!check.ok) return redirect("/?warteliste=ungueltig");
      try {
        await store.remove(check.data.e);
        return redirect("/?warteliste=abgemeldet");
      } catch (err) {
        log.error("[waitlist] Austragen fehlgeschlagen:", err.message);
        return redirect("/?warteliste=fehler");
      }
    },

    /** GET, Authorization: Bearer <adminToken> → { confirmed } (nur die Zahl, keine Adressen) */
    async stats({ headers }) {
      if (!authorized(headers)) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      try {
        const all = await store.all();
        return json(200, { confirmed: Object.keys(all).length });
      } catch (err) {
        log.error("[waitlist] Statistik fehlgeschlagen:", err.message);
        return json(502, { error: "upstream_failed" });
      }
    },

    /** GET, Authorization: Bearer <adminToken> */
    async exportCsv({ headers }) {
      if (!authorized(headers)) return json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });
      try {
        const all = await store.all();
        const q = (v) => `"${String(v ?? "").replace(/"/g, '""')}"`;
        const rows = Object.entries(all)
          .sort((x, y) => String(x[1].confirmedAt).localeCompare(String(y[1].confirmedAt)))
          .map(([email, e]) => [email, e.source, e.confirmedAt].map(q).join(","));
        return {
          status: 200,
          body: ["email,source,confirmed_at", ...rows].join("\n") + "\n",
          headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": 'attachment; filename="slotwise-warteliste.csv"' },
        };
      } catch (err) {
        log.error("[waitlist] Export fehlgeschlagen:", err.message);
        return json(502, { error: "upstream_failed" });
      }
    },
  };
}

module.exports = { createWaitlist, SOURCES };
