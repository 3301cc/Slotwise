"use strict";
// node --test scripts/tenants.test.js – Mandantentrennung über die echte Routen-Tabelle (eigener Prozess, eigene Umgebung).
const test = require("node:test");
const assert = require("node:assert");

const A = { id: "praxis-berger", company: "Praxis Dr. Berger", hostName: "Dr. Berger", adminToken: "a".repeat(32), phoneNumbers: ["+492111111111"] };
const B = { id: "kanzlei-krueger", company: "Kanzlei Krüger", hostName: "Frau Krüger", adminToken: "b".repeat(32), phoneNumbers: ["+492112222222"] };
const DATA = require("node:path").join(require("node:os").tmpdir(), `tenants-test-${process.pid}-${Date.now()}.json`);
Object.assign(process.env, { WAITLIST_DATA_FILE: DATA, AGENT_MODEL: "fake", WAITLIST_SECRET: "s".repeat(40), TENANTS_JSON: JSON.stringify([A, B, { id: "Kaputt!", adminToken: "x" }]) });
delete process.env.VERCEL;

const { routes } = require("../api/_lib/http");
const { parseTenants, loadTenants, tenantByToken, tenantByNumber, normalizeE164 } = require("../api/_lib/core/tenants");
const { fromEnv } = require("../api/_lib/core/config");
const { agentReadiness } = require("../api/_lib/core/agent/agent");

async function call(route, { method, body, token, query = {} }) {
  const req = { method, url: "/" + (Object.keys(query).length ? "?" + new URLSearchParams(query) : ""), headers: { host: "l", ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body, query };
  const res = { statusCode: 0, headers: {}, body: "", setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { this.body = b || ""; } };
  await routes[route](req, res);
  let json = null; try { json = JSON.parse(res.body); } catch { /* XML */ }
  return { status: res.statusCode, body: res.body, json };
}

test("TENANTS_JSON: ungültige Einträge werden verworfen, Token-Zuordnung", () => {
  const quiet = { error() {} };
  const list = parseTenants(JSON.stringify([A, B, { id: "Kaputt!", adminToken: "x" }]), quiet);
  assert.deepStrictEqual(list.map((t) => t.id), ["praxis-berger", "kanzlei-krueger"]);
  assert.strictEqual(tenantByToken(list, { authorization: `Bearer ${B.adminToken}` }).id, "kanzlei-krueger");
  assert.strictEqual(tenantByToken(list, { authorization: "Bearer falsch" }), null);
  assert.deepStrictEqual(parseTenants("kein json", quiet), []);
});

test("Mandanten: ohne gültigen Token kein Zugriff", async () => {
  assert.strictEqual((await call("GET /api/agent/settings", { method: "GET" })).status, 401);
  assert.strictEqual((await call("GET /api/agent/settings", { method: "GET", token: "c".repeat(32) })).status, 401);
});

test("Mandanten: Einstellungen und Aufgaben bleiben getrennt", async () => {
  const putA = await call("PUT /api/agent/settings", { method: "PUT", token: A.adminToken, body: { industry: "praxis", maxPerDay: 7 } });
  assert.strictEqual(putA.status, 200); assert.strictEqual(putA.json.industry, "praxis");
  const getB = await call("GET /api/agent/settings", { method: "GET", token: B.adminToken });
  assert.strictEqual(getB.json.industry, "business"); assert.strictEqual(getB.json.maxPerDay, 4);

  // Taste 0 bei Praxis A (angerufene Nummer bestimmt den Mandanten) → Rückrufwunsch nur bei A
  const voice = await call("POST /api/agent/voice-webhook", { method: "POST", body: { CallSid: "CA1", From: "+4915112345678", To: A.phoneNumbers[0], Digits: "0" } });
  assert.match(voice.body, /<Response>/);
  assert.strictEqual((await call("GET /api/agent/tasks", { method: "GET", token: A.adminToken })).json.items.length, 1);
  assert.strictEqual((await call("GET /api/agent/tasks", { method: "GET", token: B.adminToken })).json.items.length, 0);
  const feedB = await call("GET /api/agent/activity", { method: "GET", token: B.adminToken });
  assert.ok(!feedB.json.items.some((e) => /Taste 0/.test(e.text)));
});

test("Mandanten: Begrüßung mit dem Namen der angerufenen Praxis, unbekannte Nummer wird abgewiesen", async () => {
  await call("PUT /api/agent/settings", { method: "PUT", token: A.adminToken, body: { industry: "praxis" } });
  const a = await call("POST /api/agent/voice-webhook", { method: "POST", body: { CallSid: "CA2", From: "+491", To: A.phoneNumbers[0] } });
  assert.match(a.body, /Assistenten von Praxis Dr\. Berger/);
  const b = await call("POST /api/agent/voice-webhook", { method: "POST", body: { CallSid: "CA3", From: "+491", To: B.phoneNumbers[0] } });
  assert.match(b.body, /Kanzlei Krüger/);
  const x = await call("POST /api/agent/voice-webhook", { method: "POST", body: { CallSid: "CA4", From: "+491", To: "+499999999" } });
  assert.match(x.body, /nicht vergeben/);
});

const quiet = { error() {} };
test("TENANTS_JSON: Widersprüche sperren die ganze Konfiguration, Fehlertext und Log ohne Tokens", () => {
  const C = { id: "zahnarzt-ost", adminToken: "c".repeat(32), phoneNumbers: ["+492113333333"] };
  const cases = [
    [[A, { ...C, id: "default" }], /id "default" ist reserviert/],
    [[A, { ...C, id: "Default" }], /reserviert/],
    [[A, B, { ...C, id: A.id }], /id doppelt/],
    [[A, { ...C, adminToken: A.adminToken }], /adminToken identisch mit Eintrag 1/],
    [[A, { ...C, phoneNumbers: ["+49 211 1111111"] }], /Rufnummer \+492111111111 schon bei Eintrag 1/],
    [[A, { ...C, phoneNumbers: ["0049 (211) 111-1111"] }], /Rufnummer \+492111111111 schon bei/],
    ["kein json", /kein gültiges JSON/],
    [{ id: "x" }, /Liste/],
  ];
  for (const [input, re] of cases) {
    const logged = [];
    const r = loadTenants(typeof input === "string" ? input : JSON.stringify(input), { error: (m) => logged.push(m) });
    assert.deepStrictEqual(r.tenants, [], String(re));
    assert.match(r.error, re);
    for (const text of [r.error, ...logged]) for (const tok of [A.adminToken, B.adminToken, C.adminToken]) assert.ok(!text.includes(tok), "kein Token im Text");
  }
  // Mandanten-Token gleich WAITLIST_ADMIN_TOKEN (würde den Wartelisten-Export öffnen)
  assert.match(loadTenants(JSON.stringify([A]), quiet, { waitlistAdminToken: A.adminToken }).error, /WAITLIST_ADMIN_TOKEN/);
  // Gültig: Nummern werden normalisiert, Doppelung im selben Eintrag ist harmlos, Zuordnung auch mit Leerzeichen
  const ok = loadTenants(JSON.stringify([{ ...C, phoneNumbers: ["+49 211 3333333", "+492113333333", "00492113333334"] }]), quiet);
  assert.strictEqual(ok.error, "");
  assert.deepStrictEqual(ok.tenants[0].phoneNumbers, ["+492113333333", "+492113333334"]);
  assert.strictEqual(tenantByNumber(ok.tenants, "+49 211 3333334").id, "zahnarzt-ost");
  assert.strictEqual(normalizeE164("0211 12345"), "");
});

test("TENANTS_JSON ungültig: Status nennt den Grund, Agenten-Routen gesperrt statt Einzelbetrieb", async () => {
  const cfg = fromEnv({ AGENT_MODEL: "fake", TENANTS_JSON: JSON.stringify([A, { ...B, id: "default" }]) });
  assert.deepStrictEqual(cfg.tenants, []);
  const state = agentReadiness(cfg);
  assert.strictEqual(state.ready, false);
  assert.ok(state.missing.some((m) => /TENANTS_JSON.*reserviert/.test(m)));

  const wl = require("../api/_lib/http").getWaitlist();
  wl.config.tenantsError = "TENANTS_JSON: Test";
  try {
    const s = await call("GET /api/agent/settings", { method: "GET", token: A.adminToken });
    assert.strictEqual(s.status, 503); assert.strictEqual(s.json.error, "config_error");
    const v = await call("POST /api/agent/voice-webhook", { method: "POST", body: { CallSid: "CA9", From: "+491", To: A.phoneNumbers[0] } });
    assert.match(v.body, /nicht erreichbar/); assert.match(v.body, /<Hangup\/>/);
  } finally { wl.config.tenantsError = ""; }
});
