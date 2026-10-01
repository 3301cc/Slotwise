"use strict";
/*
 * Mandanten (mehrere Praxen bzw. Unternehmen auf einer Installation).
 *
 * Konfiguration über TENANTS_JSON (siehe config.js), z. B.:
 *   [{"id":"praxis-berger","company":"Praxis Dr. Berger","hostName":"Dr. Berger","adminToken":"<mind. 24 Zeichen>",
 *     "phoneNumbers":["+4921112345678"],"escalationPhone":"+492119876543",
 *     "enterpriseBusyUrl":"https://acme.calensync.de/api/v1/availability/busy","enterpriseBusyToken":"<Token>"}]
 * enterpriseBusyUrl/-Token sind optional (CalenSync-Belegungen für die Buchung, siehe agent/calendar.js). Mandanten erben
 * ENTERPRISE_BUSY_URL/-TOKEN bewusst NICHT – sonst würde der Kalender einer Firma die Termine einer anderen sperren.
 *
 * Ohne TENANTS_JSON bleibt alles wie bisher: ein Mandant "default", Zugang über WAITLIST_ADMIN_TOKEN.
 *
 * Trennung:
 *   - Daten:   jeder Mandant bekommt einen eigenen Schlüsselraum im Store (Präfix t:<id>:) – Einstellungen, Kalender,
 *              Aktivität, Aufgaben, OTPs und Gesprächsverläufe können sich nicht vermischen.
 *   - Zugang:  Dashboard-/API-Zugriff per Token des Mandanten; ein Token öffnet nur die eigenen Daten.
 *   - Telefon: eingehende Anrufe werden über die angerufene Nummer (Twilio "To") dem Mandanten zugeordnet.
 * Grenze: Das ist eine Token-Lösung, kein Benutzerkonto-System. Für Praxen mit mehreren Mitarbeitenden braucht es
 * später echte Konten mit Rollen und Protokoll.
 */
const crypto = require("node:crypto");
const { parseBusySource } = require("./agent/calendar");

const ID_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const RESERVED_IDS = new Set(["default"]); // "default" = Einzelbetrieb (Agent-Cache und Schlüssel ohne Präfix)

/** Rufnummer auf E.164 bringen: Leerzeichen, Bindestriche, Klammern, Punkte, Schrägstriche weg; 00 → +. Ungültig → "". */
function normalizeE164(raw) {
  const n = String(raw ?? "").trim().replace(/[\s\-()./]/g, "").replace(/^00/, "+");
  return E164.test(n) ? n : "";
}

/**
 * Liest TENANTS_JSON → { tenants, error }.
 *   - Einzelne kaputte Einträge (id/adminToken ungültig) werden mit Grund verworfen (die Nummer bleibt dann unvergeben).
 *   - Widersprüche machen die GANZE Konfiguration ungültig (error gesetzt, tenants leer): ungültiges JSON, reservierte
 *     id "default", doppelte ids, doppelte adminTokens, doppelte Rufnummern (nach E.164-Normalisierung), adminToken
 *     gleich WAITLIST_ADMIN_TOKEN. Dann antworten die Agenten-Routen mit 503 und /api/agent/status nennt den Grund –
 *     bewusst kein Rückfall in den Einzelbetrieb (sonst landeten Anrufe/Zugriffe beim falschen Mandanten).
 * Fehlertexte und Logs enthalten nie Tokens, nur ids und Positionen.
 */
function loadTenants(raw, log = console, { waitlistAdminToken = "" } = {}) {
  if (!raw || !String(raw).trim()) return { tenants: [], error: "" };
  const fail = (error) => { log.error(`[tenants] Konfigurationsfehler: ${error} – Mandantenbetrieb gesperrt`); return { tenants: [], error }; };
  let list;
  try { list = JSON.parse(raw); } catch { return fail("TENANTS_JSON ist kein gültiges JSON"); }
  if (!Array.isArray(list)) return fail("TENANTS_JSON muss eine Liste (Array) sein");
  const problems = [];
  const ids = new Map(), tokens = new Map(), numbers = new Map();
  const out = [];
  list.forEach((t, i) => {
    const pos = `Eintrag ${i + 1}`;
    if (t && typeof t === "object" && RESERVED_IDS.has(String(t.id || "").toLowerCase())) { problems.push(`${pos}: id "${String(t.id)}" ist reserviert`); return; }
    const why = !t || typeof t !== "object" ? "kein Objekt"
      : !ID_RE.test(String(t.id || "")) ? "id fehlt oder ungültig"
      : String(t.adminToken || "").length < 24 ? "adminToken fehlt oder kürzer als 24 Zeichen"
      : null;
    if (why) { log.error(`[tenants] ${pos} verworfen (${why})`); return; }
    const label = `${pos} ("${t.id}")`;
    if (ids.has(t.id)) problems.push(`${label}: id doppelt (wie ${ids.get(t.id)})`);
    else ids.set(t.id, label);
    const token = String(t.adminToken);
    if (tokens.has(token)) problems.push(`${label}: adminToken identisch mit ${tokens.get(token)}`);
    else tokens.set(token, label);
    if (waitlistAdminToken && token === waitlistAdminToken) problems.push(`${label}: adminToken identisch mit WAITLIST_ADMIN_TOKEN`);
    const phones = [];
    for (const rawNo of Array.isArray(t.phoneNumbers) ? t.phoneNumbers : []) {
      const n = normalizeE164(rawNo);
      if (!n) { log.error(`[tenants] ${label}: Rufnummer ignoriert (kein E.164)`); continue; }
      if (phones.includes(n)) continue; // doppelt im selben Eintrag: harmlos
      if (numbers.has(n)) problems.push(`${label}: Rufnummer ${n} schon bei ${numbers.get(n)}`);
      else numbers.set(n, label);
      phones.push(n);
    }
    out.push({
      id: t.id,
      company: String(t.company || t.id).slice(0, 120),
      hostName: String(t.hostName || "das Team").slice(0, 120),
      adminToken: token,
      phoneNumbers: phones,
      escalationPhone: normalizeE164(t.escalationPhone),
      enterpriseBusy: parseBusySource(t.enterpriseBusyUrl, t.enterpriseBusyToken, log),
    });
  });
  if (problems.length) return fail(`TENANTS_JSON: ${problems.join("; ")}`);
  return { tenants: out, error: "" };
}

/** Nur die gültigen Mandanten (leer bei Konfigurationsfehler). */
function parseTenants(raw, log = console, opts) {
  return loadTenants(raw, log, opts).tenants;
}

/** Store-Hülle mit eigenem Schlüsselraum. Nur die Methoden, die der Agent nutzt. */
function scopedStore(store, tenantId) {
  const k = (key) => `t:${tenantId}:${key}`;
  return {
    kind: store.kind,
    getJson: (key, ...a) => store.getJson(k(key), ...a),
    setJson: (key, ...a) => store.setJson(k(key), ...a),
    delKey: (key) => store.delKey(k(key)),
    incrWithTtl: (key, ...a) => store.incrWithTtl(k(key), ...a),
    listPush: (key, ...a) => store.listPush(k(key), ...a),
    listRange: (key, ...a) => store.listRange(k(key), ...a),
    listReplace: (key, ...a) => store.listReplace(k(key), ...a),
    listRemove: (key, ...a) => store.listRemove(k(key), ...a),
  };
}

/** Konfiguration aus Sicht eines Mandanten: eigener Token, eigener Name, eigene Weiterleitungsnummer. */
function tenantConfig(config, tenant) {
  if (!tenant) return { ...config, tenantId: "default" };
  return {
    ...config,
    tenantId: tenant.id,
    adminToken: tenant.adminToken,
    agent: { ...config.agent, company: tenant.company, hostName: tenant.hostName, escalationPhone: tenant.escalationPhone || config.agent.escalationPhone, enterpriseBusy: tenant.enterpriseBusy || null },
  };
}

const safeEq = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };

/** Mandant zum Bearer-Token. Prüft alle Einträge in konstanter Reihenfolge (kein frühes Abbrechen). */
function tenantByToken(tenants, headers) {
  const given = String((headers && headers.authorization) || "").replace(/^Bearer\s+/i, "");
  if (!given) return null;
  let hit = null;
  for (const t of tenants) if (safeEq(given, t.adminToken) && !hit) hit = t;
  return hit;
}

/** Mandant zur angerufenen Nummer. */
function tenantByNumber(tenants, to) {
  const n = normalizeE164(to);
  return (n && tenants.find((t) => t.phoneNumbers.includes(n))) || null;
}

module.exports = { loadTenants, parseTenants, normalizeE164, scopedStore, tenantConfig, tenantByToken, tenantByNumber };
