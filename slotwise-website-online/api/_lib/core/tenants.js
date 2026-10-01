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

/** Liest TENANTS_JSON. Ungültige Einträge werden mit Grund verworfen statt still übernommen. */
function parseTenants(raw, log = console) {
  if (!raw) return [];
  let list;
  try { list = JSON.parse(raw); } catch { log.error("[tenants] TENANTS_JSON ist kein gültiges JSON – ignoriert"); return []; }
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const t of list) {
    const why = !t || typeof t !== "object" ? "kein Objekt"
      : !ID_RE.test(String(t.id || "")) ? "id fehlt oder ungültig"
      : seen.has(t.id) ? "id doppelt"
      : String(t.adminToken || "").length < 24 ? "adminToken fehlt oder kürzer als 24 Zeichen"
      : null;
    if (why) { log.error(`[tenants] Eintrag verworfen (${why})`); continue; }
    seen.add(t.id);
    out.push({
      id: t.id,
      company: String(t.company || t.id).slice(0, 120),
      hostName: String(t.hostName || "das Team").slice(0, 120),
      adminToken: String(t.adminToken),
      phoneNumbers: (Array.isArray(t.phoneNumbers) ? t.phoneNumbers : []).map(String).filter((n) => E164.test(n)),
      escalationPhone: E164.test(String(t.escalationPhone || "")) ? String(t.escalationPhone) : "",
      enterpriseBusy: parseBusySource(t.enterpriseBusyUrl, t.enterpriseBusyToken, log),
    });
  }
  return out;
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
  const n = String(to || "").replace(/\s+/g, "");
  return tenants.find((t) => t.phoneNumbers.includes(n)) || null;
}

module.exports = { parseTenants, scopedStore, tenantConfig, tenantByToken, tenantByNumber };
