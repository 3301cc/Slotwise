"use strict";
/*
 * Routen des KI-Agenten – reine Funktionen (input → { status, body, headers }), Adapter in api/_lib/http.js.
 *
 *   POST /api/agent/voice-webhook   Twilio Voice (Anrufbeginn + jede Äußerung). Antwort: TwiML.
 *   POST /api/agent/intake          { from, text } – E-Mail-/Text-Kanal. Antwort: { reply, done }.
 *   GET  /api/agent/activity?since= Live-Feed (Bearer WAITLIST_ADMIN_TOKEN)
 *   GET  /api/agent/settings        Einstellungen lesen (Bearer)
 *   PUT  /api/agent/settings        Einstellungen schreiben (Bearer) – gelten ab dem nächsten Modellaufruf
 *   GET  /api/agent/week?start=     Kalender der Woche (Bearer)
 *   POST /api/agent/decision        { id, action:"approve"|"reject" } – Vorschlag freigeben/ablehnen (Bearer)
 *   GET  /api/agent/status          Bereitschaft (welche Variablen fehlen) – ohne Werte
 *   GET  /api/agent/tasks           Praxismodus: offene Aufgaben (Rezept, Überweisung, Rückruf, Terminänderung) (Bearer)
 *   POST /api/agent/tasks           { id } – Aufgabe erledigt (Bearer)
 */
const crypto = require("node:crypto");
const { twiml, validSignature, keypadUtterance } = require("./twilio");

const json = (status, body, headers) => ({ status, body, headers: { "Content-Type": "application/json; charset=utf-8", ...headers } });
const xml = (body) => ({ status: 200, body, headers: { "Content-Type": "text/xml; charset=utf-8" } });

function authorized(config, headers) {
  const given = String((headers && headers.authorization) || "").replace(/^Bearer\s+/i, "");
  const a = Buffer.from(given), b = Buffer.from(config.adminToken || "");
  return Boolean(config.adminToken) && a.length === b.length && crypto.timingSafeEqual(a, b);
}
const unauthorized = () => json(401, { error: "unauthorized" }, { "WWW-Authenticate": "Bearer" });

module.exports = {
  async status(agent) {
    return json(200, { ready: agent.state.ready, mode: agent.state.mode, missing: agent.state.missing, model: agent.model ? agent.model.kind : null });
  },

  async voiceWebhook(agent, config, input) {
    const p = input.body || {};
    // Signatur: im Deployment Pflicht; lokal (kein Twilio konfiguriert) übersprungen
    if (config.agent.twilio) {
      const ok = validSignature({ authToken: config.agent.twilio.authToken, url: input.fullUrl, params: p, signature: input.headers["x-twilio-signature"] });
      if (!ok) return { status: 403, body: "invalid signature", headers: { "Content-Type": "text/plain" } };
    } else if (config.deployed) {
      return { status: 503, body: "twilio not configured", headers: { "Content-Type": "text/plain" } };
    }
    const callSid = String(p.CallSid || "");
    if (!callSid) return { status: 400, body: "CallSid missing", headers: { "Content-Type": "text/plain" } };
    const actionUrl = `${config.siteUrl || input.baseUrl}/api/agent/voice-webhook`;
    const from = p.From ? String(p.From) : null;

    // Tastatur je Modus: Praxis = eine Taste ("0" → Praxisteam), Unternehmen = bis zu 6 Ziffern für den SMS-Code
    const keypad = (await agent.settings.get()).industry === "praxis" ? "single" : "code";

    // Anrufbeginn: Offenlegung (DSGVO/KI-VO), dann zuhören
    if (p.SpeechResult === undefined && !p.Digits) {
      await agent.activity.log({ kind: "info", text: `Eingehender Anruf von ${from ? from.replace(/(\+\d{2,3})\d+(\d{2})$/, "$1…$2") : "unbekannt"} angenommen – Assistent stellt sich vor`, channel: "phone" });
      return xml(twiml({ say: await agent.disclosure(), gather: true, actionUrl, keypad }));
    }
    // Taste 0 allein (keine weiteren Ziffern): sofort zum Team (Notausgang, unabhängig vom Modell).
    // Ein getippter Code, der mit 0 beginnt ("012345"), ist KEINE Übergabe, sondern geht an den Agenten.
    const digits = String(p.Digits || "").trim();
    if (digits === "0" && !String(p.SpeechResult || "").trim()) {
      const h = await agent.keyHandover({ sessionId: callSid, from });
      return xml(h.escalationPhone ? twiml({ say: h.say, dial: h.escalationPhone }) : twiml({ say: h.say, hangup: true }));
    }
    const utterance = String(p.SpeechResult || "").trim() || keypadUtterance(digits);
    const r = await agent.turn({ sessionId: callSid, channel: "phone", from, utterance });
    if (r.handover && r.escalationPhone) return xml(twiml({ say: r.say, dial: r.escalationPhone }));
    if (r.done) return xml(twiml({ say: r.say, hangup: true }));
    return xml(twiml({ say: r.say, gather: true, actionUrl, keypad }));
  },

  async intake(agent, config, input) {
    const b = input.body || {};
    if (config.deployed && !authorized(config, input.headers)) return unauthorized(); // bis ein Mail-Provider-Webhook mit eigener Signatur angebunden ist
    if (typeof b.text !== "string" || !b.text.trim()) return json(422, { error: "text_required" });
    const r = await agent.intake({ channel: b.channel === "chat" ? "chat" : "email", from: b.from, text: b.text.slice(0, 4000) });
    return json(r.status, r.body);
  },

  async activity(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    const since = input.query.since || null;
    const limit = Math.min(100, Number(input.query.limit) || 30);
    await agent.sweepRetention();
    return json(200, { items: await agent.activity.list({ limit, since }), serverTime: new Date().toISOString() });
  },

  async getSettings(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    return json(200, await agent.settings.get());
  },
  async putSettings(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    const saved = await agent.settings.save(input.body || {});
    await agent.activity.log({ kind: "info", text: `Einstellungen geändert: ${saved.autonomy === "auto" ? "bucht automatisch" : "legt Entwürfe vor"}, max. ${saved.maxPerDay} Termine/Tag${saved.industry === "praxis" ? ", Praxismodus" : ""}` });
    return json(200, saved);
  },

  async week(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    const start = input.query.start ? new Date(input.query.start) : mondayOf(new Date(), agent.calendar.timezone);
    if (Number.isNaN(start.getTime())) return json(422, { error: "invalid_start" });
    const end = new Date(start.getTime() + 7 * 86400000);
    return json(200, { start: start.toISOString(), end: end.toISOString(), slots: await agent.calendar.week(start.toISOString(), end.toISOString()) });
  },

  async tasks(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    await agent.sweepRetention();
    return json(200, { items: await agent.tasks.list({ includeDone: input.query.done === "1" }) });
  },
  async taskDone(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    const id = input.body && input.body.id;
    if (!id) return json(422, { error: "id_required" });
    if (!(await agent.tasks.markDone(String(id)))) return json(404, { error: "not_found" });
    await agent.activity.log({ kind: "info", text: "Aufgabe als erledigt markiert", ref: { type: "task", id: String(id) } });
    return json(200, { ok: true });
  },

  async decision(agent, config, input) {
    if (!authorized(config, input.headers)) return unauthorized();
    const { id, action } = input.body || {};
    if (!id || !["approve", "reject"].includes(action)) return json(422, { error: "invalid_decision" });
    const p = await agent.calendar.decide(String(id), action);
    if (!p) return json(404, { error: "not_found" });
    await agent.activity.log({ kind: action === "approve" ? "booked" : "info", text: action === "approve" ? `Vorschlag „${p.title} mit ${p.with}“ freigegeben – Bestätigung geht raus` : `Vorschlag „${p.title} mit ${p.with}“ abgelehnt – Alternative wird angeboten`, ref: { type: "slot", id: p.id } });
    return json(200, { ok: true, slot: { ...p, kind: action === "approve" ? "booked" : "rejected" } });
  },
};

function mondayOf(d, tz) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d).map((p) => [p.type, p.value]));
  const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(parts.weekday);
  const m = new Date(`${parts.year}-${parts.month}-${parts.day}T00:00:00Z`);
  m.setUTCDate(m.getUTCDate() - wd);
  return m;
}
