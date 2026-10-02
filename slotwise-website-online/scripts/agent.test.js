"use strict";
// node --test scripts/agent.test.js – KI-Agent ohne Netz: Fake-Modell, Memory-Store, SMS ins Array.
const test = require("node:test");
const assert = require("node:assert");
const { fromEnv } = require("../api/_lib/core/config");
const { memoryStore } = require("../api/_lib/core/store");
const { createAgent, agentReadiness } = require("../api/_lib/core/agent/agent");
const { L0_TOOLS, toBedrockTools } = require("../api/_lib/core/agent/tools");
const { detectModifyIntent, ToolRouter } = require("../api/_lib/core/agent/toolRouter");
const { REFUSAL_MODIFY_DE, buildSystemPrompt } = require("../api/_lib/core/agent/systemPrompt");
const { validSignature, twiml } = require("../api/_lib/core/agent/twilio");
const { signRequest, normalize } = require("../api/_lib/core/agent/bedrock");
const { createCalendar } = require("../api/_lib/core/agent/calendar");
const api = require("../api/_lib/core/agent/api");

const quiet = { log() {}, error() {} };
const SECRET = "s".repeat(40);
function build(env = {}) {
  const sms = [];
  const store = memoryStore();
  const config = fromEnv({ AGENT_MODEL: "fake", WAITLIST_SECRET: SECRET, AGENT_COMPANY: "Nordlicht", AGENT_HOST_NAME: "Jana", ...env });
  const agent = createAgent(config, { store, log: quiet, sendSms: async (to, text) => { sms.push({ to, text }); } });
  return { agent, sms, store, config };
}
const code = (sms) => sms[sms.length - 1].text.match(/\d{6}/)[0];

test("L0-Freeze: nur die sechs erlaubten Tools, Bedrock-Format korrekt", () => {
  assert.deepStrictEqual(L0_TOOLS.map((t) => t.name), ["find_availability", "send_otp", "verify_otp", "create_booking", "send_booking_link_sms", "handover_to_human"]);
  assert.ok(!L0_TOOLS.some((t) => /reschedule|cancel|read_booking/.test(t.name)));
  const b = toBedrockTools();
  assert.ok(b.every((t) => t.toolSpec && t.toolSpec.inputSchema.json.type === "object"));
});

test("Intent-Gate erkennt Änderungs- und Auskunftswünsche deterministisch", () => {
  for (const u of ["Ich möchte meinen Termin am Montag verschieben.", "Bitte stornieren Sie den Termin von Frau Müller.", "Habe ich morgen einen Termin?", "Wann ist mein Termin?", "Can you cancel my appointment?"]) assert.ok(detectModifyIntent(u), u);
  for (const u of ["Ich hätte gern einen neuen Termin nächste Woche.", "Haben Sie am Donnerstag etwas frei?"]) assert.ok(!detectModifyIntent(u), u);
});

test("System-Prompt trägt die Dashboard-Einstellungen", () => {
  const p = buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-09-30T08:00:00Z", settings: { autonomy: "auto", maxPerDay: 3, instructions: "Freitags nichts nach 14 Uhr." } });
  assert.match(p, /fest gebucht/); assert.match(p, /Höchstens 3 Termine pro Tag/); assert.match(p, /Freitags nichts nach 14 Uhr/);
  const d = buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-09-30T08:00:00Z", settings: { autonomy: "draft", maxPerDay: 4, instructions: "" } });
  assert.match(d, /VORSCHLAG/); assert.match(d, /Keine weiteren Anweisungen/);
});

test("ToolRouter: unbekanntes Tool wird abgelehnt, create_booking ohne OTP-Token abgelehnt", async () => {
  const audit = [];
  const r = new ToolRouter({ otp: { async put() {}, async get() { return null; }, async del() {}, async incr() { return 1; } }, audit: { async write(e) { audit.push(e); } }, hmacSecret: SECRET, async sendSms() {} });
  const s = { callSid: "CA1", tenantId: "t", hostId: "h", callerCli: null, language: "de" };
  assert.strictEqual((await r.route(s, { name: "cancel_booking", arguments: {} })).kind, "refuse");
  assert.strictEqual((await r.route(s, { name: "create_booking", arguments: { phone_e164: "+491", otp_token: "x" } })).reason, "otp_missing");
  assert.strictEqual(audit.length, 2);
});

test("Telefon, Entwurfsmodus: Vorschlag (indigo) statt Buchung, OTP per SMS, Feed-Einträge", async () => {
  const { agent, sms } = build();
  const t = (u) => agent.turn({ sessionId: "CA1", from: "+4915112345678", utterance: u });
  const r1 = await t("Ich hätte gern einen Termin nächste Woche.");
  assert.match(r1.say, /Frei wären/);
  await t("Der erste passt. Ich heiße Lena Test, lena@test.de, 0151 12345678");
  assert.strictEqual(sms.length, 1); assert.strictEqual(sms[0].to, "+4915112345678");
  const r3 = await t(code(sms));
  assert.match(r3.say, /vorgemerkt/); assert.ok(r3.done);
  const week = await agent.calendar.week(new Date().toISOString(), new Date(Date.now() + 14 * 86400000).toISOString());
  assert.strictEqual(week.length, 1); assert.strictEqual(week[0].kind, "proposed"); assert.strictEqual(week[0].with, "Lena Test");
  const feed = await agent.activity.list();
  assert.ok(feed.some((e) => e.kind === "proposed" && /lena@test.de/.test(e.text)));
});

test("Telefon, Automatik: feste Buchung (grün), Tageslimit greift, falscher Code wird abgewiesen", async () => {
  const { agent, sms } = build();
  await agent.settings.save({ autonomy: "auto", maxPerDay: 1 });
  const t = (sid, u) => agent.turn({ sessionId: sid, from: "+4917699999999", utterance: u });
  await t("A", "Termin diese Woche bitte");
  await t("A", "Der erste. Name: Max Muster, max@firma.de, 0176 99999999");
  const wrong = await t("A", "000000");
  assert.match(wrong.say, /stimmt leider nicht/);
  const ok = await t("A", code(sms));
  assert.match(ok.say, /fest eingetragen/);
  const week = await agent.calendar.week(new Date().toISOString(), new Date(Date.now() + 14 * 86400000).toISOString());
  assert.strictEqual(week[0].kind, "booked");
  // zweiter Anruf: erster Tag ist voll (Limit 1) → anderer Tag
  const r = await t("B", "Termin diese Woche bitte");
  const firstDay = week[0].start.slice(0, 10);
  assert.ok(!r.say.includes(new Date(firstDay).getDate() + ". "), "Tageslimit: der volle Tag wird nicht mehr angeboten");
});

test("Konflikt: Slot inzwischen belegt → rot im Feed, Alternative", async () => {
  const { agent, sms } = build();
  await agent.settings.save({ autonomy: "auto", maxPerDay: 12 });
  const t = (u) => agent.turn({ sessionId: "C", from: "+4915155555555", utterance: u });
  await t("Termin bitte"); await t("Der erste. Name: Eva Test, eva@test.de, 0151 55555555");
  const sess = await agent.store.getJson("agent:session:C");
  const first = sess.messages.flatMap((m) => m.content).find((c) => c.toolResult).toolResult.content[0].json.slots[0];
  await agent.calendar.addBlocked({ start: first.start, end: first.end, title: "Privat", source: "icloud" }); // externer Kalender belegt den Slot
  const r = await t(code(sms));
  assert.match(r.say, /inzwischen belegt/);
  assert.ok((await agent.activity.list()).some((e) => e.kind === "conflict" && /iCloud/.test(e.text)));
});

test("Änderungswunsch wird vor dem Modell abgefangen", async () => {
  const { agent } = build();
  const r = await agent.turn({ sessionId: "D", utterance: "Ich möchte meinen Termin am Montag verschieben." });
  assert.strictEqual(r.say, REFUSAL_MODIFY_DE);
});

test("E-Mail-Kanal: intake liefert Antwort, Sitzung je Absender", async () => {
  const { agent } = build();
  const r = await agent.intake({ from: "max@firma.de", text: "Hallo, ich brauche nächste Woche einen Termin." });
  assert.strictEqual(r.status, 200); assert.match(r.body.reply, /Frei wären/);
  assert.strictEqual((await agent.intake({ from: "kaputt", text: "x" })).status, 422);
});

test("Twilio-Signatur: Referenzvektor aus der Twilio-Doku, TwiML-Aufbau", () => {
  const ok = validSignature({ authToken: "12345", url: "https://mycompany.com/myapp.php?foo=1&bar=2", params: { CallSid: "CA1234567890ABCDE", Caller: "+12349013030", Digits: "1234", From: "+12349013030", To: "+18005551212" }, signature: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=" });
  assert.ok(ok);
  assert.ok(!validSignature({ authToken: "12345", url: "https://mycompany.com/myapp.php?foo=1&bar=2", params: { CallSid: "X" }, signature: "0/KCTR6DLpKmkAf8muzZqo1nDgQ=" }));
  const x = twiml({ say: 'Hallo & "Welt"', gather: true, actionUrl: "https://x/api/agent/voice-webhook" });
  assert.match(x, /<Gather input="speech dtmf" numDigits="1" language="de-DE"/); assert.match(x, /Hallo &amp; &quot;Welt&quot;/);
  assert.match(twiml({ say: "Tschüss", hangup: true }), /<Hangup\/>/);
  assert.match(twiml({ say: "Moment", dial: "+49301" }), /<Dial>\+49301<\/Dial>/);
});

test("Voice-Webhook: Signaturpflicht im Deployment, TwiML-Antworten", async () => {
  const { agent, config } = build({ VERCEL: "1", TWILIO_ACCOUNT_SID: "AC1", TWILIO_AUTH_TOKEN: "tok", TWILIO_FROM_NUMBER: "+491", KV_REST_API_URL: "https://r", KV_REST_API_TOKEN: "t", MAILJET_API_KEY: "k", MAILJET_API_SECRET: "s", WAITLIST_FROM_EMAIL: "a@b.de", AWS_ACCESS_KEY_ID: "AK", AWS_SECRET_ACCESS_KEY: "SK" });
  const bad = await api.voiceWebhook(agent, config, { body: { CallSid: "CA1" }, headers: {}, fullUrl: "https://x/api/agent/voice-webhook", baseUrl: "https://x" });
  assert.strictEqual(bad.status, 403);
  const { agent: local, config: lc } = build();
  const start = await api.voiceWebhook(local, lc, { body: { CallSid: "CA9", From: "+491" }, headers: {}, fullUrl: "http://l/api/agent/voice-webhook", baseUrl: "http://l" });
  assert.strictEqual(start.headers["Content-Type"], "text/xml; charset=utf-8"); assert.match(start.body, /digitalen Terminassistenten von Nordlicht/); assert.match(start.body, /<Gather/);
});

test("Bereitschaft: im Deployment fehlen AWS und Twilio, lokal bereit", () => {
  const prod = agentReadiness(fromEnv({ VERCEL: "1", WAITLIST_SECRET: SECRET, KV_REST_API_URL: "https://r", KV_REST_API_TOKEN: "t", MAILJET_API_KEY: "k", MAILJET_API_SECRET: "s", WAITLIST_FROM_EMAIL: "a@b.de" }));
  assert.deepStrictEqual(prod.missing, ["AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY", "TWILIO_ACCOUNT_SID/TWILIO_AUTH_TOKEN/TWILIO_FROM_NUMBER"]);
  assert.ok(agentReadiness(fromEnv({})).ready);
});

test("SigV4: Signatur deterministisch und mit Session-Token; Converse-Antwort normalisiert", () => {
  const h = signRequest({ method: "POST", url: "https://bedrock-runtime.eu-central-1.amazonaws.com/model/eu.anthropic.claude-3-5-haiku-20241022-v1:0/converse", headers: { "content-type": "application/json" }, body: "{}", region: "eu-central-1", service: "bedrock", accessKeyId: "AKIA", secretAccessKey: "SECRET", now: new Date("2026-09-30T08:00:00Z") });
  assert.match(h.Authorization, /^AWS4-HMAC-SHA256 Credential=AKIA\/20260930\/eu-central-1\/bedrock\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=[0-9a-f]{64}$/);
  assert.strictEqual(h["x-amz-date"], "20260930T080000Z");
  const h2 = signRequest({ method: "POST", url: "https://h/x", headers: {}, body: "", region: "r", service: "s", accessKeyId: "a", secretAccessKey: "b", sessionToken: "tok", now: new Date(0) });
  assert.match(h2.Authorization, /SignedHeaders=host;x-amz-date;x-amz-security-token/);
  const n = normalize({ output: { message: { role: "assistant", content: [{ text: "Hi" }, { toolUse: { toolUseId: "t1", name: "find_availability", input: { from: "a" } } }] } }, stopReason: "tool_use" });
  assert.strictEqual(n.text, "Hi"); assert.deepStrictEqual(n.toolUses, [{ id: "t1", name: "find_availability", input: { from: "a" } }]);
});

test("Kalender: Arbeitszeit, Blocker und Tageslimit; Freigabe verschiebt Vorschlag zu Buchung", async () => {
  const store = memoryStore();
  const cal = createCalendar(store, { timezone: "Europe/Berlin", now: () => Date.parse("2026-09-28T06:00:00Z") }); // Montag 08:00 Berlin
  const slots = await cal.findAvailability({ from: "2026-09-28T06:00:00Z", to: "2026-09-29T00:00:00Z", durationMinutes: 30, limit: 20 });
  assert.strictEqual(slots[0].start, "2026-09-28T07:00:00.000Z", "frühestens 09:00 Berlin = 07:00Z"); // 1h Vorlauf → 09:00
  assert.ok(slots.every((s) => s.start.endsWith("Z")));
  await cal.addBlocked({ start: "2026-09-28T07:00:00Z", end: "2026-09-28T09:00:00Z", title: "Privat", source: "icloud" });
  const after = await cal.findAvailability({ from: "2026-09-28T06:00:00Z", to: "2026-09-29T00:00:00Z", durationMinutes: 30, limit: 1 });
  assert.strictEqual(after[0].start, "2026-09-28T09:00:00.000Z");
  await cal.addProposal({ id: "p1", start: "2026-09-28T09:00:00Z", end: "2026-09-28T09:30:00Z", title: "Erstgespräch", with: "A" });
  assert.strictEqual((await cal.findAvailability({ from: "2026-09-28T06:00:00Z", to: "2026-09-29T00:00:00Z", maxPerDay: 1, limit: 5 })).length, 0, "Tageslimit zählt Vorschläge mit");
  const p = await cal.decide("p1", "approve");
  assert.strictEqual(p.id, "p1");
  const week = await cal.week("2026-09-28T00:00:00Z", "2026-10-05T00:00:00Z");
  assert.deepStrictEqual(week.map((s) => s.kind).sort(), ["blocked", "booked"]);
});

// ---------- CalenSync Enterprise: Belegungen für die Buchung (ENTERPRISE_BUSY_URL) ----------
const { parseBusySource } = require("../api/_lib/core/agent/calendar");
const { parseTenants, tenantConfig } = require("../api/_lib/core/tenants");
const BUSY_URL = "https://acme.calensync.de/api/v1/availability/busy";
/** Fake-fetch: protokolliert Aufrufe; reply(url, init) liefert { status, body } oder wirft */
function fakeBusyFetch(reply) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url: new URL(url), init });
    const r = await reply(new URL(url), init);
    return { ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body) };
  };
  return { fetch, calls };
}

test("CalenSync-Belegungen: blockieren Slots, Abruf mit Token und Fenster, 60-s-Zwischenspeicher, letzte Prüfung frisch", async () => {
  let clock = Date.parse("2026-09-28T06:00:00Z"); // Montag 08:00 Berlin
  const busy = [{ start: "2026-09-28T07:00:00Z", end: "2026-09-28T08:00:00Z" }, { start: "kaputt", end: "x" }];
  const f = fakeBusyFetch(() => ({ status: 200, body: { busy } }));
  const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now: () => clock, log: quiet, busySource: parseBusySource(BUSY_URL, "tok-cache"), fetch: f.fetch });
  const win = { from: "2026-09-28T06:00:00Z", to: "2026-09-29T00:00:00Z", durationMinutes: 30, limit: 3 };
  const slots = await cal.findAvailability(win);
  assert.strictEqual(slots[0].start, "2026-09-28T08:00:00.000Z", "09:00–10:00 Berlin aus Outlook belegt → erst 10:00");
  assert.strictEqual(f.calls.length, 1);
  const c = f.calls[0];
  assert.strictEqual(c.url.origin + c.url.pathname, BUSY_URL);
  assert.strictEqual(c.init.headers.Authorization, "Bearer tok-cache");
  assert.ok(c.init.signal instanceof AbortSignal, "Timeout-Signal gesetzt");
  const from = Date.parse(c.url.searchParams.get("from")), to = Date.parse(c.url.searchParams.get("to"));
  assert.ok(from <= Date.parse(win.from) + 3600000 && to >= Date.parse(win.to) && to - from <= 62 * 86400000, "Fenster deckt die Suche ab, höchstens 62 Tage");
  await cal.findAvailability(win);
  assert.strictEqual(f.calls.length, 1, "zweite Suche innerhalb 60 s aus dem Zwischenspeicher");
  clock += 61_000;
  await cal.findAvailability(win);
  assert.strictEqual(f.calls.length, 2, "nach 60 s neu abgefragt");
  const hit = await cal.conflictFor("2026-09-28T07:30:00Z", "2026-09-28T08:00:00Z");
  assert.strictEqual(f.calls.length, 3, "conflictFor fragt immer frisch");
  assert.deepStrictEqual([hit.source, hit.kind, hit.title], ["microsoft", "blocked", "Belegt"]);
  assert.strictEqual(await cal.conflictFor("2026-09-28T08:00:00Z", "2026-09-28T08:30:00Z"), null, "angrenzender Slot ist frei");
  await cal.addBlocked({ start: "2026-09-28T09:00:00Z", end: "2026-09-28T10:00:00Z", title: "Privat", source: "icloud" });
  const n = f.calls.length;
  assert.strictEqual((await cal.conflictFor("2026-09-28T09:00:00Z", "2026-09-28T09:30:00Z")).source, "icloud");
  assert.strictEqual(f.calls.length, n, "lokaler Konflikt reicht, kein Abruf nötig");
});

test("CalenSync-Belegungen: Ausfall → Suche fail-open, letzte Prüfung fail-closed (Timeout 3 s, HTTP-Fehler, kaputte Antwort)", async () => {
  const now = () => Date.parse("2026-09-28T06:00:00Z");
  const win = { from: "2026-09-28T06:00:00Z", to: "2026-09-29T00:00:00Z", durationMinutes: 30, limit: 2 };
  const cases = {
    netzwerk: () => { throw new TypeError("fetch failed"); },
    http500: () => ({ status: 500, body: { error: "x" } }),
    http401: () => ({ status: 401, body: { error: "invalid_token" } }),
    ohneListe: () => ({ status: 200, body: { free: [] } }),
    keinJson: () => ({ status: 200, body: "<html>" }),
  };
  for (const [name, reply] of Object.entries(cases)) {
    const f = fakeBusyFetch(reply);
    const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now, log: quiet, busySource: parseBusySource(BUSY_URL, `tok-${name}`), fetch: f.fetch });
    assert.strictEqual((await cal.findAvailability(win)).length, 2, `${name}: Slots trotzdem angeboten`);
    const c = await cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z");
    assert.ok(c && c.unverified && c.kind === "unverified", `${name}: Slot gilt als belegt`);
  }
  // echter Timeout: Antwort kommt nie, Abbruch nach 3 s über das Signal
  const hang = fakeBusyFetch((_u, init) => new Promise((_r, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason))));
  const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now, log: quiet, busySource: parseBusySource(BUSY_URL, "tok-hang"), fetch: hang.fetch });
  const t0 = Date.now();
  assert.ok((await cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z")).unverified);
  const ms = Date.now() - t0;
  assert.ok(ms >= 2900 && ms < 5000, `Timeout nach ~3 s (${ms} ms)`);
});

test("CalenSync-Belegungen: Agent bucht bei nicht prüfbarem Kalender nicht und bietet Buchungslink an", async () => {
  const sms = [], store = memoryStore();
  const config = fromEnv({ AGENT_MODEL: "fake", WAITLIST_SECRET: SECRET, ENTERPRISE_BUSY_URL: BUSY_URL, ENTERPRISE_BUSY_TOKEN: "tok-agent" });
  let down = false;
  const f = fakeBusyFetch(() => { if (down) throw new TypeError("fetch failed"); return { status: 200, body: { busy: [] } }; });
  const agent = createAgent(config, { store, log: quiet, fetch: f.fetch, sendSms: async (to, text) => { sms.push({ to, text }); } });
  await agent.settings.save({ autonomy: "auto", maxPerDay: 12 });
  const t = (u) => agent.turn({ sessionId: "E1", from: "+4915155555555", utterance: u });
  await t("Termin bitte"); await t("Der erste. Name: Eva Test, eva@test.de, 0151 55555555");
  assert.ok(f.calls.length >= 1, "Suche hat CalenSync gefragt");
  down = true;
  const r = await t(code(sms));
  assert.match(r.say, /nicht verbindlich bestätigen/);
  const week = await agent.calendar.week(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 30 * 86400000).toISOString());
  assert.ok(!week.some((s) => s.kind === "booked" || s.kind === "proposed"), "nichts gebucht oder vorgemerkt");
  assert.ok((await agent.activity.list()).some((e) => e.kind === "conflict" && /nicht prüfbar/.test(e.text)));
});

test("CalenSync-Belegungen: Konfiguration nur mit https und Token, Mandanten mit eigenen Werten ohne Vererbung", () => {
  const silent = { error() {} };
  assert.deepStrictEqual(parseBusySource(BUSY_URL, "t"), { url: BUSY_URL, token: "t" });
  assert.strictEqual(parseBusySource("", ""), null);
  assert.strictEqual(parseBusySource("http://acme.calensync.de/x", "t", silent), null, "kein Klartext-HTTP");
  assert.strictEqual(parseBusySource("https://u:p@acme.calensync.de/x", "t", silent), null, "keine Zugangsdaten in der URL");
  assert.strictEqual(parseBusySource(BUSY_URL, "", silent), null, "Token Pflicht");
  assert.ok(parseBusySource("http://localhost:4000/api/v1/availability/busy", "t"), "lokal erlaubt");
  assert.strictEqual(fromEnv({}).agent.enterpriseBusy, null);
  const config = fromEnv({ ENTERPRISE_BUSY_URL: BUSY_URL, ENTERPRISE_BUSY_TOKEN: "global" });
  const [a, b] = parseTenants(JSON.stringify([
    { id: "firma-a", adminToken: "a".repeat(32), enterpriseBusyUrl: "https://a.calensync.de/api/v1/availability/busy", enterpriseBusyToken: "tok-a" },
    { id: "firma-b", adminToken: "b".repeat(32) },
  ]), silent);
  assert.deepStrictEqual(tenantConfig(config, a).agent.enterpriseBusy, { url: "https://a.calensync.de/api/v1/availability/busy", token: "tok-a" });
  assert.strictEqual(tenantConfig(config, b).agent.enterpriseBusy, null, "Mandant ohne eigene Werte erbt nichts");
  assert.strictEqual(tenantConfig(config, null).agent.enterpriseBusy.token, "global");
});

// ---------- Praxismodus (Arzt- und Zahnarztpraxen) ----------
const { detectEmergency, detectMedicalQuestion, EMERGENCY_DE, MEDICAL_REFUSAL_DE, MODIFY_PRAXIS_DE, toolsFor } = require("../api/_lib/core/agent/praxis");

async function buildPraxis(env) {
  const b = build(env);
  await b.agent.settings.save({ industry: "praxis" });
  return b;
}

test("Praxis: Notfall- und Medizin-Erkennung deterministisch", () => {
  for (const u of ["Mein Mann hat starke Brustschmerzen", "Ich krieg kaum Luft", "Sie ist bewusstlos", "Es ist ein Notfall!", "Ich will mir etwas antun", "Er blutet stark am Kopf"]) assert.ok(detectEmergency(u), u);
  for (const u of ["Ich brauche ein Folgerezept", "Termin zur Kontrolle bitte", "Ich hätte gern eine Prophylaxe"]) assert.ok(!detectEmergency(u), u);
  for (const u of ["Ist das gefährlich?", "Soll ich die Tabletten absetzen?", "Was bedeutet mein Befund?", "Welche Dosis soll ich nehmen?"]) assert.ok(detectMedicalQuestion(u), u);
  for (const u of ["Ich brauche einen Termin", "Haben Sie Donnerstag frei?"]) assert.ok(!detectMedicalQuestion(u), u);
});

test("Praxis: create_task nur im Praxismodus angeboten und erlaubt", async () => {
  assert.ok(!toolsFor(L0_TOOLS, "business").some((t) => t.name === "create_task"));
  assert.ok(toolsFor(L0_TOOLS, "praxis").some((t) => t.name === "create_task"));
  const r = new ToolRouter({ otp: { async put() {}, async get() { return null; }, async del() {}, async incr() { return 1; } }, audit: { async write() {} }, hmacSecret: SECRET, async sendSms() {} });
  const base = { callSid: "CA1", tenantId: "t", hostId: "h", callerCli: null, language: "de" };
  assert.strictEqual((await r.route({ ...base, industry: "business" }, { name: "create_task", arguments: {} })).kind, "refuse");
  assert.strictEqual((await r.route({ ...base, industry: "praxis" }, { name: "create_task", arguments: { type: "callback" } })).kind, "execute");
});

test("Praxis: Notfall beendet das Gespräch mit 112-Hinweis und Übergabe, ohne Modell", async () => {
  const { agent } = await buildPraxis();
  const r = await agent.turn({ sessionId: "P1", from: "+4915112345678", utterance: "Mein Vater hat Brustschmerzen und Atemnot" });
  assert.strictEqual(r.say, EMERGENCY_DE); assert.ok(r.done && r.handover);
  assert.ok((await agent.activity.list()).some((e) => e.kind === "conflict" && /112/.test(e.text)));
});

test("Praxis: medizinische Frage wird abgelehnt, Änderungswunsch wird Aufgabe", async () => {
  const { agent } = await buildPraxis();
  assert.strictEqual((await agent.turn({ sessionId: "P2", utterance: "Ist das gefährlich, wenn der Zahn pocht?" })).say, MEDICAL_REFUSAL_DE);
  const t = (u) => agent.turn({ sessionId: "P3", from: "+4915112345678", utterance: u });
  assert.strictEqual((await t("Ich möchte meinen Termin am Montag absagen.")).say, MODIFY_PRAXIS_DE);
  const r = await t("Mein Name ist Anna Schmidt, 0151 12345678");
  assert.ok(r.done); assert.match(r.say, /Praxisteam/);
  const tasks = await agent.tasks.list();
  assert.strictEqual(tasks.length, 1); assert.strictEqual(tasks[0].type, "change_request"); assert.strictEqual(tasks[0].name, "Anna Schmidt");
});

test("Praxis: Rezeptwunsch → Aufgabe mit Geburtsdatum, Feed-Eintrag, erledigt markieren über API", async () => {
  const { agent, config } = await buildPraxis({ WAITLIST_ADMIN_TOKEN: "adm" });
  const t = (u) => agent.turn({ sessionId: "P4", from: "+4915112345678", utterance: u });
  assert.match((await t("Ich brauche ein Folgerezept für mein Blutdruckmittel.")).say, /Geburtsdatum/);
  await t("Ich heiße Peter Kühn, geboren 03.07.1958, 0151 12345678");
  const [task] = await agent.tasks.list();
  assert.strictEqual(task.type, "prescription"); assert.strictEqual(task.dateOfBirth, "1958-07-03"); assert.strictEqual(task.label, "Rezeptwunsch");
  assert.ok((await agent.activity.list()).some((e) => e.kind === "task" && /Rezeptwunsch von Peter Kühn/.test(e.text)));
  const auth = { authorization: "Bearer adm" };
  assert.strictEqual((await api.tasks(agent, config, { headers: {}, query: {} })).status, 401);
  assert.strictEqual((await api.tasks(agent, config, { headers: auth, query: {} })).body.items.length, 1);
  assert.strictEqual((await api.taskDone(agent, config, { headers: auth, body: { id: task.id } })).status, 200);
  assert.strictEqual((await api.tasks(agent, config, { headers: auth, query: {} })).body.items.length, 0);
});

test("Praxis: Begrüßung mit Notruf-Hinweis, Prompt mit Praxisregeln, Einstellungen behalten industry", async () => {
  const { agent } = await buildPraxis();
  assert.match(await agent.disclosure(), /von Nordlicht.*112/s);
  await agent.settings.save({ autonomy: "auto", maxPerDay: 6, instructions: "" }); // KI-Panel speichert ohne industry
  assert.strictEqual((await agent.settings.get()).industry, "praxis");
  const p = buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-10-01T08:00:00Z", settings: await agent.settings.get() });
  assert.match(p, /Praxismodus/); assert.match(p, /116 117/);
  const { agent: biz } = build();
  assert.doesNotMatch(buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-10-01T08:00:00Z", settings: await biz.settings.get() }), /Praxismodus/);
  assert.strictEqual((await biz.turn({ sessionId: "B1", utterance: "Ich möchte meinen Termin am Montag verschieben." })).say, REFUSAL_MODIFY_DE);
});

test("Praxis: erweiterte Notfall-Erkennung, Verneinung, Englisch/Türkisch", () => {
  for (const u of ["Mir ist schwindelig und ich sehe doppelt", "Ich hab mich verletzt, alles voller Blut", "Mein Kind hat 40 Grad Fieber", "Mein Sohn hat 39,5 Fieber", "Ich habe Herzrasen", "my chest hurts", "Benim kalbim ağrıyor", "Kein Notfall, aber mein Vater hat Brustschmerzen"]) assert.ok(detectEmergency(u), u);
  for (const u of ["Es ist kein Notfall, ich brauche nur ein Rezept", "Ist nicht dringend, nur eine Kontrolle", "Ich habe 38 Grad Fieber und brauche eine Krankschreibung"]) assert.ok(!detectEmergency(u), u);
});

test("Praxis: Modell erkennt unklaren Notfall (zweite Stufe) → 112-Text und Übergabe", async () => {
  const { agent } = await buildPraxis();
  const r = await agent.turn({ sessionId: "P9", utterance: "Mein Mann fühlt sich ganz komisch an" });
  assert.strictEqual(r.say, EMERGENCY_DE); assert.ok(r.done && r.handover);
  assert.ok((await agent.activity.list()).some((e) => e.kind === "conflict" && /Möglicher Notfall/.test(e.text)));
});

test("Praxis: Buchung ohne SMS-Code und E-Mail, immer nur Vorschlag (auch bei Autonomie auto)", async () => {
  const { agent, sms } = await buildPraxis();
  await agent.settings.save({ autonomy: "auto" });
  const t = (u) => agent.turn({ sessionId: "P10", from: "+4915112345678", utterance: u });
  await t("Ich hätte gern einen Termin zur Kontrolle nächste Woche.");
  const r = await t("Der erste passt. Mein Name ist Maria Lindner, geboren 30.11.1967, 0151 12345678");
  assert.ok(r.done); assert.match(r.say, /vorgemerkt/);
  assert.strictEqual(sms.length, 0, "kein OTP, keine Bestätigung vor Freigabe");
  const week = await agent.calendar.week(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 14 * 86400000).toISOString());
  assert.ok(week.some((s) => s.kind === "proposed" && s.with === "Maria Lindner" && s.title === "Kontrolle"));
  const prompt = buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-10-01T08:00:00Z", settings: await agent.settings.get() });
  assert.match(prompt, /nie nach E-Mail-Adresse oder Bestätigungscodes/);
});

test("Praxis: Rückruf-Modus bietet keine Kalenderwerkzeuge an, Router lehnt sie ab", async () => {
  assert.deepStrictEqual(toolsFor(L0_TOOLS, "praxis", "off").map((t) => t.name), ["send_booking_link_sms", "handover_to_human", "create_task"]);
  const r = new ToolRouter({ otp: { async put() {}, async get() { return null; }, async del() {}, async incr() { return 1; } }, audit: { async write() {} }, hmacSecret: SECRET, async sendSms() {} });
  const s = { callSid: "CA1", tenantId: "t", hostId: "h", callerCli: null, language: "de", industry: "praxis", toolNames: toolsFor(L0_TOOLS, "praxis", "off").map((t) => t.name) };
  assert.strictEqual((await r.route(s, { name: "find_availability", arguments: {} })).kind, "refuse");
  assert.strictEqual((await r.route(s, { name: "create_booking", arguments: {} })).kind, "refuse");
  const { agent } = await buildPraxis();
  await agent.settings.save({ praxisBooking: "off" });
  const p = buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-10-01T08:00:00Z", settings: await agent.settings.get() });
  assert.match(p, /Rückruf-Modus/);
});

test("Taste 0: sofort zum Team, im Praxismodus mit Rückrufwunsch", async () => {
  const { agent, config } = await buildPraxis();
  const res = await api.voiceWebhook(agent, config, { body: { CallSid: "CA7", From: "+4915112345678", Digits: "0" }, headers: {}, fullUrl: "http://l/api/agent/voice-webhook", baseUrl: "http://l" });
  assert.match(res.body, /rufen Sie zurück/); assert.match(res.body, /<Hangup\/>/);
  const [task] = await agent.tasks.list();
  assert.strictEqual(task.type, "callback"); assert.strictEqual(task.phone, "+4915112345678");
  assert.match(await agent.disclosure(), /Taste 0/);
});

const voice = (agent, config, body) => api.voiceWebhook(agent, config, { body, headers: {}, fullUrl: "http://l/api/agent/voice-webhook", baseUrl: "http://l" });

test("Tastatur, Unternehmensmodus: getippter SMS-Code mit führender 0 ist der Code, keine Übergabe", async () => {
  const { agent, config, sms, store } = build();
  const from = "+4915112345678";
  const start = await voice(agent, config, { CallSid: "CK1", From: from });
  assert.match(start.body, /<Gather input="speech dtmf" numDigits="6" finishOnKey="#" timeout="5"/);
  await voice(agent, config, { CallSid: "CK1", From: from, SpeechResult: "Ich hätte gern einen Termin nächste Woche." });
  await voice(agent, config, { CallSid: "CK1", From: from, SpeechResult: "Der erste passt. Ich heiße Lena Test, lena@test.de, 0151 12345678" });
  assert.strictEqual(sms.length, 1);
  // Code deterministisch auf "012345" setzen (sonst zufällig)
  const key = `otp:default:CK1:${from}`;
  const rec = await store.getJson(key);
  await store.setJson(key, { ...rec, code: "012345" }, 300);
  const r = await voice(agent, config, { CallSid: "CK1", From: from, Digits: "012345" });
  assert.match(r.body, /vorgemerkt/); assert.doesNotMatch(r.body, /<Dial>|mit dem Team/);
  const feed = await agent.activity.list();
  assert.ok(!feed.some((e) => /Taste 0/.test(e.text)), "keine Übergabe");
  assert.ok(feed.some((e) => e.kind === "proposed"));
  const sess = await store.getJson("agent:session:CK1");
  assert.ok(sess.messages.some((m) => m.role === "user" && m.content.some((c) => c.text === "Tastatureingabe: 012345")));
});

test("Tastatur, Unternehmensmodus: nur eine einzelne 0 übergibt an das Team", async () => {
  const { agent, config } = build({ AGENT_ESCALATION_PHONE: "+49301234567" });
  const r = await voice(agent, config, { CallSid: "CK2", From: "+4915100000000", Digits: "0" });
  assert.match(r.body, /<Dial>\+49301234567<\/Dial>/);
  assert.ok((await agent.activity.list()).some((e) => /Taste 0/.test(e.text)));
  // "00" oder "0#"-Reste sind keine Übergabe – nur die einzelne 0
  const r2 = await voice(agent, config, { CallSid: "CK3", From: "+4915100000000", Digits: "00" });
  assert.doesNotMatch(r2.body, /<Dial>/);
});

test("Tastatur, Praxismodus: eine Taste genügt, 0 → Praxisteam", async () => {
  const { agent, config } = await buildPraxis();
  const start = await voice(agent, config, { CallSid: "CK4", From: "+4915112345678" });
  assert.match(start.body, /<Gather input="speech dtmf" numDigits="1" language/);
  const r = await voice(agent, config, { CallSid: "CK4", From: "+4915112345678", Digits: "0" });
  assert.match(r.body, /rufen Sie zurück/);
  assert.strictEqual((await agent.tasks.list())[0].type, "callback");
});

test("Praxis: Brust/Atem-Formulierungen, Umlaute an Wortgrenzen, Absage nennt 112", () => {
  for (const u of ["Ich habe Schmerzen in der Brust", "Druck auf der Brust und linker Arm taub", "Ich habe Luftnot", "Ich kann kaum atmen", "Ich bekomme keine Luft", "Ich möchte sterben", "Er hat einen allergischen Schock", "Überdosis Tabletten genommen", "Annem bayıldı"]) assert.ok(detectEmergency(u), u);
  for (const u of ["Mein Gesicht ist taub, ganz plötzlich", "Es ist nicht dringend aber mein Herz rast"]) assert.ok(detectEmergency(u), u);
  for (const u of ["Termin zur Kontrolle bitte", "Nicht dringend, nur eine Überweisung", "Ich brauche eine Überweisung zum Kardiologen"]) assert.ok(!detectEmergency(u), u);
  assert.match(MEDICAL_REFUSAL_DE, /112/);
  assert.match(MEDICAL_REFUSAL_DE, /116 117/);
  // Medizinische Frage mit Notfallbezug: Absage enthält in jedem Fall den Notruf-Hinweis
  for (const u of ["Ich kann kaum atmen, ist das gefährlich?", "Ich habe Schmerzen in der Brust, soll ich ins Krankenhaus?"]) assert.ok(detectEmergency(u), u);
});

test("Praxis: Bestands- oder Neupatient – Folgerezept nur für Bestandspatienten, Aufnahmestopp", async () => {
  const { NEW_NO_RX_DE, NEW_CLOSED_DE } = require("../api/_lib/core/agent/praxis");
  const { agent } = await buildPraxis();
  const t = (id, u) => agent.turn({ sessionId: id, from: "+4915112345678", utterance: u });
  await t("N1", "Ich brauche ein Folgerezept, ich war aber noch nie bei Ihnen.");
  assert.strictEqual((await t("N1", "Ich heiße Eva Neu, geboren 01.02.1990, 0151 12345678")).say, NEW_NO_RX_DE);
  assert.strictEqual((await agent.tasks.list()).length, 0);
  await t("N2", "Ich brauche ein Folgerezept für mein Blutdruckmittel.");
  await t("N2", "Ich heiße Peter Kühn, geboren 03.07.1958, 0151 12345678");
  const [task] = await agent.tasks.list();
  assert.strictEqual(task.patientStatus, "existing");
  await agent.settings.save({ newPatients: "closed" });
  await t("N3", "Bitte um Rückruf, ich war noch nie bei Ihnen.");
  assert.strictEqual((await t("N3", "Mein Name ist Ida Klein, 0151 12345678")).say, NEW_CLOSED_DE);
  const p = buildSystemPrompt({ company: "X", hostName: "Y", timezone: "Europe/Berlin", language: "de", nowIso: "2026-10-01T08:00:00Z", settings: await agent.settings.get() });
  assert.match(p, /Aufnahmestopp/); assert.match(p, /schon einmal bei uns in Behandlung/);
});

test("Löschfristen: Aufgaben 30 Tage, Termine 90 Tage nach Ende, Protokoll 90 Tage; Frisches bleibt", async () => {
  const { createRetention } = require("../api/_lib/core/agent/retention");
  const store = memoryStore();
  const DAY = 86400000, T = Date.parse("2026-10-01T12:00:00Z");
  const iso = (ms) => new Date(ms).toISOString();
  await store.listPush("agent:tasks", { id: "alt", at: iso(T - 31 * DAY), name: "Alt", dateOfBirth: "1950-01-01" }, 200);
  await store.listPush("agent:tasks", { id: "neu", at: iso(T - 2 * DAY), name: "Neu" }, 200);
  await store.listPush("cal:bookings", { id: "b-alt", start: iso(T - 92 * DAY), end: iso(T - 91 * DAY), dateOfBirth: "1960-02-02" }, 500);
  await store.listPush("cal:bookings", { id: "b-neu", start: iso(T - 10 * DAY), end: iso(T - 10 * DAY + 1800000) }, 500);
  await store.listPush("cal:proposals", { id: "p-alt", start: iso(T - 100 * DAY), end: iso(T - 100 * DAY + 1800000) }, 500);
  await store.listPush("cal:blocked", { id: "ohne-ende" }, 500);
  await store.listPush("agent:activity", { id: "a-alt", at: iso(T - 95 * DAY) }, 200);
  await store.listPush("agent:activity", { id: "a-neu", at: iso(T - 1 * DAY) }, 200);
  const r = createRetention(store, () => T);
  const res = await r.sweep();
  assert.deepStrictEqual(res, { tasks: 1, activity: 1, bookings: 1, proposals: 1, blocked: 0 });
  assert.deepStrictEqual((await store.listRange("agent:tasks", 200)).map((x) => x.id), ["neu"]);
  assert.deepStrictEqual((await store.listRange("cal:bookings", 500)).map((x) => x.id), ["b-neu"]);
  assert.deepStrictEqual((await store.listRange("cal:proposals", 500)).length, 0);
  assert.deepStrictEqual((await store.listRange("cal:blocked", 500)).map((x) => x.id), ["ohne-ende"], "ohne Zeitangabe nie löschen");
  assert.deepStrictEqual((await store.listRange("agent:activity", 200)).map((x) => x.id), ["a-neu"]);
  assert.ok(!JSON.stringify(await store.listRange("cal:bookings", 500)).includes("1960-02-02"), "Geburtsdatum alter Termine ist weg");
  assert.strictEqual(await r.sweep(), null, "gedrosselt: zweiter Lauf binnen 6 h tut nichts");
});

test("Löschfristen: listRemove entfernt gezielt, parallel neu angelegte Einträge bleiben; Fristen per Umgebung", async () => {
  const { createRetention } = require("../api/_lib/core/agent/retention");
  const store = memoryStore();
  const T = Date.parse("2026-10-01T12:00:00Z");
  await store.listPush("agent:tasks", { id: "alt", at: new Date(T - 40 * 86400000).toISOString() }, 200);
  const realRange = store.listRange.bind(store);
  // Zwischen Lesen und Löschen kommt eine neue Aufgabe dazu (Race mit einem laufenden Anruf)
  store.listRange = async (key, n) => { const r = await realRange(key, n); if (key === "agent:tasks") await store.listPush("agent:tasks", { id: "frisch", at: new Date(T).toISOString() }, 200); return r; };
  await createRetention(store, () => T).sweep({ force: true });
  store.listRange = realRange;
  assert.deepStrictEqual((await store.listRange("agent:tasks", 200)).map((x) => x.id), ["frisch"]);
  const cfg = fromEnv({ AGENT_MODEL: "fake", WAITLIST_SECRET: SECRET, AGENT_RETENTION_TASKS_DAYS: "14" });
  assert.strictEqual(createRetention(store, () => T, cfg.agent.retention).days.tasksDays, 14);
  assert.strictEqual(createRetention(store, () => T, fromEnv({ AGENT_MODEL: "fake", WAITLIST_SECRET: SECRET }).agent.retention).days.calendarDays, 90);
});

test("Löschfristen: redisRestStore.listRemove nutzt LREM je Eintrag (kein DEL/RPUSH)", async () => {
  const { redisRestStore } = require("../api/_lib/core/store");
  const calls = [];
  const orig = global.fetch;
  global.fetch = async (url, init) => { calls.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ result: 1 }) }; };
  try {
    const s = redisRestStore({ url: "https://redis.example", token: "t" });
    const n = await s.listRemove("t:a:agent:tasks", [{ id: "x", at: "2026-01-01T00:00:00.000Z" }]);
    assert.strictEqual(n, 1);
  } finally { global.fetch = orig; }
  assert.deepStrictEqual(calls.map((c) => c[0]), ["LREM"]);
  assert.strictEqual(calls[0][1], "sw:t:a:agent:tasks");
  assert.strictEqual(calls[0][3], JSON.stringify({ id: "x", at: "2026-01-01T00:00:00.000Z" }));
});
