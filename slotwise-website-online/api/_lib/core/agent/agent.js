"use strict";
/*
 * Orchestrator des KI-Agenten – plattformunabhängig (reine Daten rein, reine Daten raus).
 *
 *   Nutzeräußerung ──▶ Intent-Gate (deterministisch) ──▶ Modell (Bedrock) ──▶ ToolRouter (Allow-List, OTP)
 *                 ──▶ Tool-Ausführung (Kalender, SMS) ──▶ Aktivitätslog ──▶ Antworttext
 *
 * Ein Gespräch (Telefon oder E-Mail) ist eine Session im Store: Nachrichtenverlauf im Converse-Format.
 * Vercel-Funktionen sind zustandslos, daher liegt der Verlauf nicht im Prozess, sondern im Store (TTL 1 h).
 *
 * Autonomie (Dashboard): "auto"  → create_booking bucht fest (kind booked, grün)
 *                        "draft" → create_booking legt einen Vorschlag an (kind proposed, indigo), Host gibt frei
 * Konflikt (Slot inzwischen belegt) → kind conflict (rot), Alternative wird angeboten.
 */
const crypto = require("node:crypto");
const { readiness } = require("../config");
const { normalizeEmail } = require("../email");
const { toBedrockTools, L0_TOOLS } = require("./tools");
const { toolsFor, createTasks, DISCLOSURE_PRAXIS_DE, TASK_TYPES } = require("./praxis");
const { buildSystemPrompt, DISCLOSURE_DE } = require("./systemPrompt");
const { ToolRouter, otpStoreFrom } = require("./toolRouter");
const { createModel } = require("./bedrock");
const { createCalendar, formatForSpeech } = require("./calendar");
const { createActivity } = require("./activity");
const { createSettings } = require("./settings");
const { smsSender, consoleSms } = require("./twilio");
const { createStore } = require("../store");

const SESSION_TTL_SEC = 3600;
const MAX_TOOL_ROUNDS = 4;

function agentReadiness(config) {
  const base = readiness(config);
  const missing = [...base.missing];
  if (config.deployed && !config.agent.aws && config.agent.model !== "fake") missing.push("AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY");
  if (config.deployed && !config.agent.twilio) missing.push("TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER");
  return { ready: missing.length === 0, mode: base.mode, missing };
}

function createAgent(config, deps = {}) {
  const store = deps.store || createStore(config);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const model = deps.model !== undefined ? deps.model : createModel(config);
  const sendSms = deps.sendSms || (config.agent.twilio ? smsSender(config.agent.twilio) : consoleSms(log.log));
  const calendar = deps.calendar || createCalendar(store, { timezone: config.agent.timezone, now });
  const activity = deps.activity || createActivity(store, now);
  const settings = deps.settings || createSettings(store, now);
  const tasks = deps.tasks || createTasks(store, now);
  const router = new ToolRouter({ otp: otpStoreFrom(store), audit: activity.audit, hmacSecret: config.secret || "local-dev-secret-not-for-production-use", sendSms, now });
  const state = agentReadiness(config);

  const sessionKey = (id) => `agent:session:${id}`;
  async function loadSession(id, init) {
    return (await store.getJson(sessionKey(id))) || { id, messages: [], turns: 0, startedAt: new Date(now()).toISOString(), ...init };
  }
  const saveSession = (s) => store.setJson(sessionKey(s.id), s, SESSION_TTL_SEC);

  async function execTool(session, name, args, cfg) {
    if (name === "find_availability") {
      const slots = await calendar.findAvailability({ from: args.from, to: args.to, durationMinutes: args.duration_minutes || 30, maxPerDay: cfg.maxPerDay });
      return { tool: name, slots };
    }
    if (name === "send_booking_link_sms") {
      await sendSms(args.phone_e164, `Ihr Link zur Terminbuchung bei ${config.agent.company}: ${config.siteUrl || ""}/book`);
      await activity.log({ kind: "info", text: `Buchungslink per SMS an ${mask(args.phone_e164)} geschickt`, channel: session.channel });
      return { tool: name, sent: true };
    }
    if (name === "create_task") {
      const t = await tasks.add({ ...args, channel: session.channel });
      await activity.log({ kind: "task", text: `${TASK_TYPES[t.type]} von ${t.name} aufgenommen – Aufgabe für das Praxisteam, Rückruf an ${mask(t.phone)}`, ref: { type: "task", id: t.id }, channel: session.channel });
      return { tool: name, created: true, say: "Ich habe Ihren Wunsch für das Praxisteam aufgenommen. Die Praxis prüft ihn und meldet sich bei Ihnen. Auf Wiederhören!" };
    }
    if (name === "create_booking") {
      const start = args.start, end = new Date(Date.parse(start) + (args.duration_minutes || 30) * 60000).toISOString();
      const conflict = await calendar.conflictFor(start, end);
      const who = `${args.name} (${args.email})`;
      if (conflict) {
        const alt = await calendar.findAvailability({ from: end, to: new Date(Date.parse(end) + 7 * 86400000).toISOString(), durationMinutes: args.duration_minutes || 30, limit: 2, maxPerDay: cfg.maxPerDay });
        await activity.log({ kind: "conflict", text: `Doppelbuchung verhindert: ${formatForSpeech(Date.parse(start), calendar.timezone)} kollidiert mit „${conflict.title || "Termin"}“ (${srcLabel(conflict.source)}) – Alternative angeboten`, channel: session.channel });
        return { tool: name, booked: false, conflict: true, alternatives: alt, say: `Dieser Termin ist inzwischen belegt. ${alt.length ? `Frei wäre ${alt.map((a) => a.label).join(" oder ")}.` : "Ich schicke Ihnen den Buchungslink per SMS."}` };
      }
      if ((await calendar.countOnDay(start)) >= cfg.maxPerDay) {
        await activity.log({ kind: "info", text: `Tageslimit (${cfg.maxPerDay}) erreicht – Anfrage von ${who} auf den nächsten freien Tag verwiesen`, channel: session.channel });
        return { tool: name, booked: false, say: "An diesem Tag sind alle Termine vergeben. Soll ich den nächsten freien Tag vorschlagen?" };
      }
      const slot = { id: crypto.randomUUID(), start, end, title: "Erstgespräch", with: args.name, email: args.email, phone: args.phone_e164, notes: args.notes || "", source: "ai", channel: session.channel, createdAt: new Date(now()).toISOString() };
      const label = formatForSpeech(Date.parse(start), calendar.timezone);
      if (cfg.autonomy === "auto") {
        await calendar.addBooking(slot);
        await activity.log({ kind: "booked", text: `${session.channel === "email" ? "Per E-Mail" : "Telefonisch"} gebucht: ${slot.title} mit ${args.name}, ${label} – Bestätigung per SMS versendet`, ref: { type: "slot", id: slot.id }, channel: session.channel });
        await sendSms(args.phone_e164, `Ihr Termin bei ${config.agent.company}: ${label}. Bis dann!`).catch((e) => log.error("[agent] SMS:", e.message));
        return { tool: name, booked: true, proposal: false, slot: { id: slot.id, start, end }, say: `Ihr Termin ist fest eingetragen: ${label}. Sie bekommen eine SMS-Bestätigung. Auf Wiederhören!` };
      }
      await calendar.addProposal(slot);
      await activity.log({ kind: "proposed", text: `Terminanfrage von ${args.email} analysiert und Slot vorgeschlagen: ${label} – wartet auf deine Freigabe`, ref: { type: "slot", id: slot.id }, channel: session.channel });
      return { tool: name, booked: false, proposal: true, slot: { id: slot.id, start, end }, say: `Ich habe ${label} für Sie vorgemerkt. Sobald ${config.agent.hostName} freigibt, bekommen Sie die Bestätigung per SMS. Auf Wiederhören!` };
    }
    return { tool: name, error: "unknown_tool" };
  }

  return {
    state, store, calendar, activity, settings, model, tasks,

    /** Begrüßung mit KI-Hinweis; im Praxismodus mit Notruf-Hinweis. */
    async disclosure() {
      const cfg = await settings.get();
      return (cfg.industry === "praxis" ? DISCLOSURE_PRAXIS_DE : DISCLOSURE_DE).replace("{{company}}", config.agent.company);
    },

    /**
     * Eine Gesprächsrunde. input: { sessionId, channel:"phone"|"email", from?, utterance }
     * → { say, done, handover, escalationPhone? }
     */
    async turn({ sessionId, channel = "phone", from = null, utterance }) {
      if (!model) return { say: "Der Assistent ist gerade nicht verfügbar. Bitte versuchen Sie es später noch einmal.", done: true, handover: false };
      const session = await loadSession(sessionId, { channel, from });
      const cfg = await settings.get();
      const routerSession = { callSid: sessionId, tenantId: "default", hostId: "host", callerCli: from, language: "de", industry: cfg.industry || "business" };
      const text = String(utterance || "").trim();
      session.turns += 1;

      if (!text) {
        session.silence = (session.silence || 0) + 1;
        await saveSession(session);
        return session.silence >= 2 ? { say: "Ich habe nichts gehört. Auf Wiederhören.", done: true, handover: false } : { say: "Sind Sie noch da? Für wann hätten Sie den Termin gern?", done: false, handover: false };
      }

      // 1) Deterministisches Gate vor dem Modell
      const gate = await router.gateUtterance(routerSession, text);
      if (gate && gate.kind === "emergency") {
        session.messages.push({ role: "user", content: [{ text }] }, { role: "assistant", content: [{ text: gate.say }] });
        await saveSession(session);
        await activity.log({ kind: "conflict", text: "Notfall-Stichwort erkannt – Anrufer auf 112 / 116 117 verwiesen und an das Praxisteam übergeben", channel });
        return { say: gate.say, done: true, handover: true, escalationPhone: config.agent.escalationPhone };
      }
      if (gate) {
        session.messages.push({ role: "user", content: [{ text }] }, { role: "assistant", content: [{ text: gate.say }] });
        await saveSession(session);
        const what = { medical_question: "Medizinische Frage nicht beantwortet – Termin oder Rückruf angeboten", modify_intent_task: "Änderungswunsch erkannt – bestehende Termine bleiben gesperrt, Aufgabe fürs Team wird aufgenommen" }[gate.reason];
        await activity.log({ kind: "info", text: what || `Änderungswunsch am Telefon abgelehnt (L0-Freeze) – Buchungslink oder Übergabe angeboten`, channel });
        return { say: gate.say, done: false, handover: false };
      }

      // 2) Modell mit dynamischem System-Prompt (Dashboard-Einstellungen fließen sofort ein)
      const system = buildSystemPrompt({ company: config.agent.company, hostName: config.agent.hostName, timezone: calendar.timezone, language: "de", nowIso: new Date(now()).toISOString(), channel, settings: cfg });
      session.messages.push({ role: "user", content: [{ text }] });
      let say = "", done = false, handover = false;

      try {
        for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
          const res = await model.converse({ system, messages: session.messages, tools: toBedrockTools(toolsFor(L0_TOOLS, cfg.industry)) });
          session.messages.push(res.assistantMessage || { role: "assistant", content: [{ text: res.text || "…" }] });
          if (res.text) say = res.text;
          if (!res.toolUses.length) break;

          const results = [];
          for (const tu of res.toolUses) {
            const decision = await router.route(routerSession, { name: tu.name, arguments: tu.input });
            let payload;
            if (decision.kind === "refuse") { payload = { tool: tu.name, refused: true, say: decision.say }; say = decision.say; }
            else if (decision.kind === "handover") { payload = { tool: tu.name, handover: true }; handover = true; done = true; }
            else if (["send_otp", "verify_otp"].includes(decision.name)) payload = { tool: decision.name, ...decision.arguments };
            else payload = await execTool(session, decision.name, decision.arguments, cfg);
            if (payload.say && !res.text) say = payload.say;
            if (payload.booked || payload.proposal || payload.created) done = true;
            results.push({ toolResult: { toolUseId: tu.id, content: [{ json: payload }] } });
          }
          session.messages.push({ role: "user", content: results });
          if (handover) break;
        }
      } catch (err) {
        log.error("[agent] Modellfehler:", err.message);
        await activity.log({ kind: "info", text: "Modellaufruf fehlgeschlagen – Anrufer auf Buchungsseite verwiesen", channel });
        say = "Entschuldigung, da ist etwas schiefgelaufen. Ich schicke Ihnen den Link zur Buchungsseite per SMS."; done = true;
      }

      if (handover) {
        await activity.log({ kind: "info", text: `Gespräch an einen Menschen übergeben${config.agent.escalationPhone ? "" : " (keine Rufnummer hinterlegt – Rückruf angeboten)"}`, channel });
        say = say || (config.agent.escalationPhone ? "Einen Moment, ich verbinde Sie." : "Im Moment ist niemand erreichbar. Wir rufen Sie zurück.");
      }
      if (session.turns >= 12 && !done) { done = true; say = `${say} Ich schicke Ihnen den Buchungslink per SMS. Auf Wiederhören.`; }
      await saveSession(session);
      return { say: say || "Können Sie das bitte wiederholen?", done, handover, escalationPhone: handover ? config.agent.escalationPhone : undefined };
    },

    /** E-Mail-Eingang: eine Nachricht, eine Antwort (Sitzung je Absender, damit Rückfragen zusammenhängen). */
    async intake({ channel = "email", from, text }) {
      const email = normalizeEmail(from);
      if (!email) return { status: 422, body: { error: "invalid_from" } };
      const sessionId = `email:${crypto.createHash("sha256").update(email).digest("hex").slice(0, 16)}`;
      const r = await this.turn({ sessionId, channel, from: email, utterance: text });
      return { status: 200, body: { reply: r.say, done: r.done, handover: r.handover } };
    },
  };
}

const mask = (p) => String(p || "").replace(/(\+\d{2,3})\d+(\d{2})$/, "$1…$2");
const srcLabel = (s) => ({ google: "Google Kalender", icloud: "iCloud", microsoft: "Microsoft 365", ai: "KI-Agent", manual: "manuell" })[s] || "Kalender";

module.exports = { createAgent, agentReadiness };
