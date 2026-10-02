"use strict";
// node --test scripts/google.test.js – „Google Kalender verbinden“ ohne Netz: fetch ist gefälscht, Secret und Tokens sind Attrappen.
const os = require("node:os");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const crypto = require("node:crypto");

// Vor dem ersten require von http.js: der Adapter liest die Umgebung einmal je Prozess.
const CLIENT_SECRET = "GOCSPX-test-client-secret-FAKE";
const SITE = "https://calensync.example";
process.env.GOOGLE_CLIENT_SECRET = CLIENT_SECRET;
process.env.SITE_URL = SITE;
process.env.WAITLIST_DATA_FILE = path.join(os.tmpdir(), `google-test-${process.pid}-${Date.now()}.json`);
delete process.env.VERCEL;
delete process.env.NODE_ENV;
delete process.env.GOOGLE_CLIENT_ID;
delete process.env.WAITLIST_ADMIN_TOKEN;
delete process.env.TENANTS_JSON;

const test = require("node:test");
const assert = require("node:assert");
const { fromEnv, DEFAULT_GOOGLE_CLIENT_ID } = require("../api/_lib/core/config");
const { memoryStore } = require("../api/_lib/core/store");
const { createGoogle, tokenKey, seal, unseal, SCOPE_FREEBUSY, SCOPE_EVENTS, CONN_KEY, HKDF_INFO } = require("../api/_lib/core/google");
const { createCalendar, parseBusySource } = require("../api/_lib/core/agent/calendar");
const { createAgent } = require("../api/_lib/core/agent/agent");
const googleFn = require("../api/google/[action].js");

const WL_SECRET = "w".repeat(40);
const REFRESH = "1//refresh-token-FAKE-abcdef";
const ACCESS = "ya29.access-token-FAKE";
const ACCESS2 = "ya29.access-token-FAKE-2";
const CODE = "4/0-auth-code-FAKE";
const T0 = Date.parse("2026-09-28T06:00:00Z"); // Montag 08:00 Berlin
test.after(() => fs.rmSync(process.env.WAITLIST_DATA_FILE, { force: true }));

function captureLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}
const b64u = (s) => Buffer.from(s).toString("base64url");
const idToken = (over = {}) => `${b64u('{"alg":"RS256"}')}.${b64u(JSON.stringify({ iss: "https://accounts.google.com", aud: DEFAULT_GOOGLE_CLIENT_ID, sub: "1234567890", email: "Praxis@Example.de", email_verified: true, exp: Math.floor(T0 / 1000) + 30 * 86400, ...over }))}.sig`;
const tokenOk = (over = {}) => ({ status: 200, body: { access_token: ACCESS, expires_in: 3599, refresh_token: REFRESH, token_type: "Bearer", scope: `openid ${SCOPE_FREEBUSY} ${SCOPE_EVENTS} https://www.googleapis.com/auth/userinfo.email`, id_token: idToken(), ...over } });

/**
 * Fake-Google: routes = { token, revoke, freeBusy, insert, remove } → (call) => { status, body } | Promise | wirft.
 * Jeder Aufruf landet in calls mit Art, URL, init und geparstem Body.
 */
function fakeGoogle(routes = {}) {
  const calls = [];
  const kindOf = (u, init) => {
    if (u.startsWith("https://oauth2.googleapis.com/token")) return "token";
    if (u.startsWith("https://oauth2.googleapis.com/revoke")) return "revoke";
    if (u.startsWith("https://www.googleapis.com/calendar/v3/freeBusy")) return "freeBusy";
    if (u.includes("/calendars/primary/events") && init.method === "DELETE") return "remove";
    if (u.includes("/calendars/primary/events")) return "insert";
    return "other";
  };
  const defaults = {
    token: () => tokenOk(),
    revoke: () => ({ status: 200, body: {} }),
    freeBusy: () => ({ status: 200, body: { kind: "calendar#freeBusy", calendars: { primary: { busy: [] } } } }),
    insert: (c) => ({ status: 200, body: { id: c.body.id, status: "confirmed" } }),
    remove: () => ({ status: 204, body: null }),
  };
  const fetch = async (url, init = {}) => {
    const u = String(url);
    const kind = kindOf(u, init);
    let body = null;
    if (typeof init.body === "string") body = /urlencoded/.test((init.headers || {})["Content-Type"] || "") ? Object.fromEntries(new URLSearchParams(init.body)) : JSON.parse(init.body);
    const call = { kind, url: u, init, body };
    calls.push(call);
    const r = await (routes[kind] || defaults[kind] || (() => ({ status: 404, body: {} })))(call);
    return { status: r.status, ok: r.status >= 200 && r.status < 300, json: async () => (typeof r.body === "string" ? JSON.parse(r.body) : r.body) };
  };
  return { fetch, calls, of: (k) => calls.filter((c) => c.kind === k) };
}

function setup({ env = {}, routes, store = memoryStore(), log = captureLog(), clock } = {}) {
  const t = clock || { now: T0 };
  const config = fromEnv({ GOOGLE_CLIENT_SECRET: CLIENT_SECRET, SITE_URL: SITE, WAITLIST_SECRET: WL_SECRET, ...env });
  const fg = fakeGoogle(routes);
  const g = createGoogle(config, { store, fetch: fg.fetch, log, now: () => t.now });
  return { g, fg, store, log, clock: t, config };
}
async function startFlow(g, tenantId = "default") {
  const r = await g.connect({}, tenantId);
  assert.strictEqual(r.status, 200);
  const url = new URL(r.body.url);
  const cookie = r.headers["Set-Cookie"].split(";")[0];
  return { url, state: url.searchParams.get("state"), cookie, setCookie: r.headers["Set-Cookie"] };
}
const finish = (g, flow, query = {}) => g.callback({ query: { code: CODE, state: flow.state, scope: "x", ...query }, headers: { cookie: `other=1; ${flow.cookie}` } });
async function connected(opts = {}) {
  const s = setup(opts);
  const flow = await startFlow(s.g, opts.tenantId);
  const r = await finish(s.g, flow);
  assert.strictEqual(r.redirect, "/dashboard/?google=connected");
  return { ...s, flow };
}
const reason = (r) => new URL(r.redirect, SITE).searchParams.get("reason");

// ---------------------------------------------------------------------------------------------------------------------
test("Konfiguration: ohne Secret, SITE_URL, WAITLIST_SECRET oder Store aus – alle Endpunkte 503 { enabled: false }", async () => {
  const cfg = fromEnv({});
  assert.deepStrictEqual([cfg.google.clientId, cfg.google.clientSecret, cfg.google.error], [DEFAULT_GOOGLE_CLIENT_ID, "", ""], "Client-ID mit Standardwert, Secret leer");
  assert.strictEqual(fromEnv({ GOOGLE_CLIENT_ID: "123-abc.apps.googleusercontent.com" }).google.clientId, "123-abc.apps.googleusercontent.com");
  const bad = fromEnv({ GOOGLE_CLIENT_ID: "kaputt", GOOGLE_CLIENT_SECRET: CLIENT_SECRET }).google;
  assert.ok(bad.error && !bad.clientSecret && !bad.error.includes(CLIENT_SECRET), "ungültige Client-ID: aus, Fehlertext ohne Secret");

  const off = [
    ["ohne Secret", { GOOGLE_CLIENT_SECRET: "" }],
    ["ohne SITE_URL", { SITE_URL: "" }],
    ["SITE_URL ohne https", { SITE_URL: "http://calensync.example" }],
    ["Deployment ohne WAITLIST_SECRET", { VERCEL: "1", WAITLIST_SECRET: "", KV_REST_API_URL: "https://r", KV_REST_API_TOKEN: "t" }],
    ["Deployment ohne Redis", { VERCEL: "1" }],
  ];
  for (const [name, env] of off) {
    const log = captureLog();
    const { g } = setup({ env, log });
    assert.strictEqual(g.enabled, false, name);
    assert.strictEqual(g.forTenant("default"), null, `${name}: keine Kalenderquelle`);
    for (const r of [await g.connect({}, "default"), await g.callback({ query: {} }), await g.status({}, "default"), await g.disconnect({}, "default")]) {
      assert.deepStrictEqual([r.status, r.body], [503, { enabled: false }], name);
    }
    assert.ok(!log.lines.join("\n").includes(CLIENT_SECRET), `${name}: Secret nicht im Log`);
  }
  assert.strictEqual(createGoogle(fromEnv({ GOOGLE_CLIENT_SECRET: CLIENT_SECRET, SITE_URL: SITE }), { log: captureLog() }).enabled, false, "ohne Store aus");
  assert.strictEqual(setup().g.enabled, true);
  assert.strictEqual(setup({ env: { SITE_URL: "http://localhost:3000" } }).g.redirectUri, "http://localhost:3000/api/google/callback", "lokal erlaubt");
  assert.strictEqual(setup().g.redirectUri, `${SITE}/api/google/callback`, "Redirect-URI exakt aus SITE_URL");
});

// ---------------------------------------------------------------------------------------------------------------------
// HTTP: Vercel-Funktion über einen echten node:http-Server
function listen(fn) {
  return new Promise((resolve) => { const srv = http.createServer(fn); srv.listen(0, "127.0.0.1", () => resolve(srv)); });
}
async function request(srv, method, p, { headers = {}, body } = {}) {
  const { port } = srv.address();
  const res = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers, body, redirect: "manual" });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* kein JSON */ }
  return { status: res.status, headers: res.headers, json };
}

test("HTTP: connect/status/disconnect nur mit Bearer, falsche Methode 405, unbekannte Aktion 404, Cache-Control no-store", async () => {
  const srv = await listen((req, res) => googleFn(req, res));
  try {
    const auth = { Authorization: "Bearer local-admin", "Content-Type": "application/json" };
    for (const [m, p] of [["POST", "/api/google/connect"], ["GET", "/api/google/status"], ["POST", "/api/google/disconnect"]]) {
      const r = await request(srv, m, p, { body: m === "POST" ? "{}" : undefined, headers: { "Content-Type": "application/json" } });
      assert.strictEqual(r.status, 401, `${m} ${p} ohne Token`);
      const wrong = await request(srv, m, p, { body: m === "POST" ? "{}" : undefined, headers: { ...auth, Authorization: "Bearer local-admin-x" } });
      assert.strictEqual(wrong.status, 401, `${m} ${p} falscher Token`);
    }
    const r405 = await request(srv, "GET", "/api/google/connect", { headers: auth });
    assert.deepStrictEqual([r405.status, r405.headers.get("allow")], [405, "POST"]);
    assert.strictEqual((await request(srv, "POST", "/api/google/callback", { headers: auth, body: "{}" })).status, 405);
    assert.strictEqual((await request(srv, "GET", "/api/google/nope", { headers: auth })).status, 404);

    const st = await request(srv, "GET", "/api/google/status", { headers: auth });
    assert.deepStrictEqual([st.status, st.json], [200, { enabled: true, connected: false }]);
    assert.strictEqual(st.headers.get("cache-control"), "no-store");

    const c = await request(srv, "POST", "/api/google/connect", { headers: auth, body: "{}" });
    assert.strictEqual(c.status, 200);
    assert.strictEqual(c.headers.get("cache-control"), "no-store");
    assert.match(c.json.url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/);
    assert.match(c.headers.get("set-cookie"), /^sw_google_oauth=[A-Za-z0-9_-]{43}; Max-Age=600; Path=\/api\/google; HttpOnly; SameSite=Lax; Secure$/);

    // Rücksprung ohne gültigen state: 302 ins Dashboard (auch Set-Cookie bei Weiterleitung), kein Google-Text
    const cb = await request(srv, "GET", "/api/google/callback?code=x&state=y&error_description=%3Cscript%3E");
    assert.strictEqual(cb.status, 302);
    assert.strictEqual(cb.headers.get("location"), "/dashboard/?google=error&reason=invalid_state");
    assert.match(cb.headers.get("set-cookie"), /^sw_google_oauth=; Max-Age=0/);
    const denied = await request(srv, "GET", "/api/google/callback?error=access_denied&state=y");
    assert.strictEqual(denied.headers.get("location"), "/dashboard/?google=error&reason=access_denied");
    const other = await request(srv, "GET", "/api/google/callback?error=Something+%3Cevil%3E");
    assert.strictEqual(other.headers.get("location"), "/dashboard/?google=error&reason=google_error", "Googles Fehlertext wird nie übernommen");
  } finally { srv.close(); }
});

// ---------------------------------------------------------------------------------------------------------------------
test("connect: Autorisierungs-URL mit PKCE (S256), state, offline, consent, Scopes; state nur gehasht im Store", async () => {
  const { g, store } = setup();
  const flow = await startFlow(g);
  const p = flow.url.searchParams;
  assert.strictEqual(flow.url.origin + flow.url.pathname, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.strictEqual(p.get("client_id"), DEFAULT_GOOGLE_CLIENT_ID);
  assert.strictEqual(p.get("redirect_uri"), `${SITE}/api/google/callback`);
  assert.strictEqual(p.get("response_type"), "code");
  assert.deepStrictEqual(p.get("scope").split(" "), ["openid", "email", SCOPE_FREEBUSY, SCOPE_EVENTS]);
  assert.deepStrictEqual([p.get("access_type"), p.get("prompt"), p.get("include_granted_scopes"), p.get("code_challenge_method")], ["offline", "consent", "true", "S256"]);
  assert.match(flow.state, /^[A-Za-z0-9_-]{43}$/);
  assert.match(p.get("code_challenge"), /^[A-Za-z0-9_-]{43}$/);
  assert.ok(!p.has("client_secret") && !flow.url.toString().includes(CLIENT_SECRET), "Secret nie in der URL");
  assert.strictEqual(await store.getJson(`google:state:${flow.state}`), null, "Klartext-state ist kein Schlüssel");
  const rec = await store.getJson(`google:state:${crypto.createHash("sha256").update(flow.state).digest("hex")}`, T0);
  assert.strictEqual(rec.tenantId, "default");
  assert.strictEqual(crypto.createHash("sha256").update(rec.verifier).digest("base64url"), p.get("code_challenge"), "Challenge = S256(verifier)");
  const second = await startFlow(g);
  assert.notStrictEqual(second.state, flow.state, "jeder Start bekommt einen neuen state");
});

test("callback: tauscht den Code mit PKCE-Verifier, speichert den Refresh-Token verschlüsselt, Status verbunden", async () => {
  const log = captureLog();
  const { g, fg, store, flow } = await connected({ log });
  const [tok] = fg.of("token");
  assert.deepStrictEqual(
    [tok.body.grant_type, tok.body.code, tok.body.client_id, tok.body.client_secret, tok.body.redirect_uri],
    ["authorization_code", CODE, DEFAULT_GOOGLE_CLIENT_ID, CLIENT_SECRET, `${SITE}/api/google/callback`],
  );
  assert.strictEqual(crypto.createHash("sha256").update(tok.body.code_verifier).digest("base64url"), flow.url.searchParams.get("code_challenge"), "Verifier passt zur Challenge");
  assert.ok(tok.init.signal instanceof AbortSignal, "Timeout-Signal gesetzt");

  const rec = await store.getJson(CONN_KEY);
  const raw = JSON.stringify(rec);
  assert.ok(!raw.includes(REFRESH) && !raw.includes(ACCESS), "weder Refresh- noch Access-Token im Klartext");
  assert.match(rec.refreshToken, /^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  const key = tokenKey(WL_SECRET);
  assert.strictEqual(unseal(key, rec.refreshToken, "google:default"), REFRESH, "mit HKDF-Schlüssel entschlüsselbar");
  assert.strictEqual(Buffer.compare(key, Buffer.from(crypto.hkdfSync("sha256", WL_SECRET, Buffer.alloc(0), HKDF_INFO, 32))), 0);
  assert.throws(() => unseal(key, rec.refreshToken, "google:anderer-mandant"), "an den Mandanten gebunden (AAD)");
  assert.throws(() => unseal(tokenKey("x".repeat(40)), rec.refreshToken, "google:default"), "anderes WAITLIST_SECRET");
  const tampered = rec.refreshToken.slice(0, -2) + (rec.refreshToken.endsWith("A") ? "BB" : "AA");
  assert.throws(() => unseal(key, tampered, "google:default"), "Veränderung fällt auf");
  assert.deepStrictEqual(rec.scopes.sort(), ["https://www.googleapis.com/auth/userinfo.email", "openid", SCOPE_EVENTS, SCOPE_FREEBUSY].sort());

  const st = await g.status({}, "default");
  assert.deepStrictEqual(st.body, { enabled: true, connected: true, email: "praxis@example.de", connectedAt: new Date(T0).toISOString(), writeEvents: true });
  assert.strictEqual(fg.of("token").length, 1, "Access-Token aus der Antwort im Speicher, keine Erneuerung nötig");
  assert.ok(!log.lines.join("\n").includes("praxis@example.de"), "E-Mail-Adresse nicht im Log");
});

test("state: genau einmal einlösbar, läuft nach 10 Minuten ab, an Mandant und Browser gebunden", async () => {
  // einmalig
  const a = setup();
  const flow = await startFlow(a.g);
  assert.strictEqual((await finish(a.g, flow)).redirect, "/dashboard/?google=connected");
  const again = await finish(a.g, flow);
  assert.strictEqual(reason(again), "invalid_state", "zweite Einlösung abgelehnt");
  assert.strictEqual(a.fg.of("token").length, 1, "Code nur einmal getauscht");

  // abgelaufen
  const b = setup();
  const late = await startFlow(b.g);
  b.clock.now += 601_000;
  assert.strictEqual(reason(await finish(b.g, late)), "invalid_state");
  assert.strictEqual(b.fg.of("token").length, 0);

  // ohne bzw. mit fremdem Browser-Cookie
  const c = setup();
  const f1 = await startFlow(c.g);
  assert.strictEqual(reason(await c.g.callback({ query: { code: CODE, state: f1.state }, headers: {} })), "session_mismatch");
  const f2 = await startFlow(c.g), f3 = await startFlow(c.g);
  assert.strictEqual(reason(await c.g.callback({ query: { code: CODE, state: f2.state }, headers: { cookie: f3.cookie } })), "session_mismatch", "Cookie eines anderen Ablaufs passt nicht");
  assert.strictEqual(reason(await c.g.callback({ query: { code: CODE, state: f3.state }, headers: { cookie: f3.cookie } })), null, "f3 mit eigenem Cookie funktioniert");
  assert.strictEqual(c.fg.of("token").length, 1);

  // Mandanten: Verbindung landet im Datenraum des Mandanten, der den Ablauf gestartet hat
  const TENANTS_JSON = JSON.stringify([{ id: "praxis-a", adminToken: "a".repeat(32) }, { id: "praxis-b", adminToken: "b".repeat(32) }]);
  const m = setup({ env: { TENANTS_JSON } });
  const fa = await startFlow(m.g, "praxis-a");
  assert.strictEqual((await finish(m.g, fa)).redirect, "/dashboard/?google=connected");
  assert.strictEqual((await m.g.status({}, "praxis-a")).body.connected, true);
  assert.strictEqual((await m.g.status({}, "praxis-b")).body.connected, false, "anderer Mandant bleibt getrennt");
  assert.ok(await m.store.getJson(`t:praxis-a:${CONN_KEY}`), "Schlüsselraum t:praxis-a:");
  assert.strictEqual(await m.store.getJson(CONN_KEY), null, "nichts im Einzelbetrieb-Schlüssel");
  // Mandant inzwischen aus TENANTS_JSON entfernt → abgelehnt
  const gone = setup({ env: { TENANTS_JSON }, store: m.store });
  const fb = await startFlow(gone.g, "praxis-x");
  assert.strictEqual(reason(await finish(gone.g, fb)), "invalid_state");
});

test("callback: fehlender freebusy-Scope, kein Refresh-Token, kaputtes id_token, Token-Fehler → Fehler-Weiterleitung ohne Speichern", async () => {
  const cases = [
    ["missing_scope", () => tokenOk({ scope: `openid email ${SCOPE_EVENTS}` }), true],
    ["no_refresh_token", () => tokenOk({ refresh_token: undefined }), true],
    ["invalid_id_token", () => tokenOk({ id_token: idToken({ aud: "999-fremd.apps.googleusercontent.com" }) }), true],
    ["invalid_id_token", () => tokenOk({ id_token: idToken({ iss: "https://evil.example" }) }), true],
    ["invalid_id_token", () => tokenOk({ id_token: "kaputt" }), true],
    ["token_exchange_failed", () => ({ status: 400, body: { error: "invalid_grant", error_description: "Bad Request <b>" } }), false],
    ["token_exchange_failed", () => { throw new TypeError("fetch failed"); }, false],
  ];
  for (const [code, token, revokes] of cases) {
    const { g, fg, store } = setup({ routes: { token } });
    const r = await finish(g, await startFlow(g));
    assert.strictEqual(r.redirect, `/dashboard/?google=error&reason=${code}`, code);
    assert.strictEqual(await store.getJson(CONN_KEY), null, `${code}: nichts gespeichert`);
    assert.strictEqual(fg.of("revoke").length, revokes ? 1 : 0, `${code}: erhaltener Zugriff wird widerrufen`);
  }
  // events.owned abgewählt: verbunden, aber ohne Termine eintragen
  const { g, store } = setup({ routes: { token: () => tokenOk({ scope: `openid email ${SCOPE_FREEBUSY}` }) } });
  assert.strictEqual((await finish(g, await startFlow(g))).redirect, "/dashboard/?google=connected");
  assert.strictEqual((await g.status({}, "default")).body.writeEvents, false);
  assert.ok(await store.getJson(CONN_KEY));
});

// ---------------------------------------------------------------------------------------------------------------------
test("Access-Token: im Speicher, Erneuerung ~60 s vor Ablauf, parallele Aufrufe teilen eine Erneuerung", async () => {
  let n = 0;
  const s = await connected({ routes: { token: (c) => (c.body.grant_type === "refresh_token" ? { status: 200, body: { access_token: `${ACCESS2}-${++n}`, expires_in: 3600, token_type: "Bearer" } } : tokenOk()) } });
  const conn = await s.g.forTenant("default").connection();
  await conn.freeBusy("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z");
  assert.strictEqual(s.fg.of("freeBusy")[0].init.headers.Authorization, `Bearer ${ACCESS}`, "Token aus dem Callback");
  assert.strictEqual(s.fg.of("token").length, 1);

  s.clock.now = T0 + 3599_000 - 59_000; // weniger als 60 s Restlaufzeit
  await Promise.all([conn.freeBusy("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z"), conn.freeBusy("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z")]);
  const refreshes = s.fg.of("token").filter((c) => c.body.grant_type === "refresh_token");
  assert.strictEqual(refreshes.length, 1, "eine Erneuerung für zwei parallele Aufrufe");
  assert.deepStrictEqual([refreshes[0].body.refresh_token, refreshes[0].body.client_id, refreshes[0].body.client_secret], [REFRESH, DEFAULT_GOOGLE_CLIENT_ID, CLIENT_SECRET]);
  assert.ok(refreshes[0].init.signal instanceof AbortSignal);
  assert.strictEqual(s.fg.of("freeBusy").at(-1).init.headers.Authorization, `Bearer ${ACCESS2}-1`);
  await conn.freeBusy("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z");
  assert.strictEqual(s.fg.of("token").length, 2, "danach wieder aus dem Speicher");

  // anderer Prozess (frische Instanz, gleicher Store): erneuert beim ersten Zugriff mit dem gespeicherten Refresh-Token
  const other = createGoogle(s.config, { store: s.store, fetch: s.fg.fetch, log: captureLog(), now: () => s.clock.now });
  await (await other.forTenant("default").connection()).freeBusy("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z");
  assert.strictEqual(s.fg.of("token").filter((c) => c.body.grant_type === "refresh_token").length, 2);
});

test("invalid_grant bei der Erneuerung → getrennt, lastError reconnect_required, keine Quelle mehr", async () => {
  const log = captureLog();
  const s = await connected({ log, routes: { token: (c) => (c.body.grant_type === "refresh_token" ? { status: 400, body: { error: "invalid_grant", error_description: "Token has been expired or revoked." } } : tokenOk()) } });
  s.clock.now = T0 + 3600_000;
  const conn = await s.g.forTenant("default").connection();
  await assert.rejects(conn.freeBusy("2026-09-28T00:00:00Z", "2026-09-29T00:00:00Z"), /invalid_grant/);
  const st = (await s.g.status({}, "default")).body;
  assert.deepStrictEqual([st.connected, st.lastError, st.email], [false, "reconnect_required", "praxis@example.de"]);
  assert.strictEqual(await s.g.forTenant("default").connection(), null, "nicht mehr verbunden");
  const rec = await s.store.getJson(CONN_KEY);
  assert.strictEqual(rec.refreshToken, null, "Token gelöscht");
  assert.ok(!log.lines.join("\n").includes("expired or revoked"), "Googles Fehlertext nicht im Log");
  // neu verbinden behebt es
  s.clock.now = T0 + 7200_000;
  const flow = await startFlow(s.g);
  assert.strictEqual((await finish(s.g, flow)).redirect, "/dashboard/?google=connected");
  assert.deepStrictEqual((await s.g.status({}, "default")).body.lastError, undefined);
});

test("disconnect: widerruft den Refresh-Token bei Google und löscht die Verbindung; Widerruf best effort", async () => {
  const s = await connected();
  const r = await s.g.disconnect({}, "default");
  assert.deepStrictEqual([r.status, r.body], [200, { ok: true, revoked: true }]);
  const [rv] = s.fg.of("revoke");
  assert.strictEqual(rv.url, "https://oauth2.googleapis.com/revoke");
  assert.strictEqual(rv.body.token, REFRESH, "der entschlüsselte Refresh-Token wird widerrufen");
  assert.ok(!rv.url.includes(REFRESH), "Token im Body, nicht in der URL");
  assert.strictEqual(await s.store.getJson(CONN_KEY), null);
  assert.deepStrictEqual((await s.g.status({}, "default")).body, { enabled: true, connected: false });
  assert.strictEqual(await s.g.forTenant("default").connection(), null);

  const down = await connected({ routes: { revoke: () => { throw new TypeError("fetch failed"); } } });
  const r2 = await down.g.disconnect({}, "default");
  assert.deepStrictEqual(r2.body, { ok: true, revoked: false }, "Google nicht erreichbar: trotzdem gelöscht");
  assert.strictEqual(await down.store.getJson(CONN_KEY), null);
  assert.deepStrictEqual((await down.g.disconnect({}, "default")).body, { ok: true, revoked: false }, "nichts verbunden: ok");
});

// ---------------------------------------------------------------------------------------------------------------------
// Kalender: Belegt-Abgleich mit Google zusätzlich zu CalenSync
const quiet = { log() {}, error() {} };
const win = { from: "2026-09-28T06:00:00Z", to: "2026-09-29T00:00:00Z", durationMinutes: 30, limit: 3 };

test("Kalender: Google-Belegungen blockieren Slots (zusammen mit CalenSync), 60-s-Zwischenspeicher, letzte Prüfung frisch", async () => {
  const s = await connected({ routes: { freeBusy: () => ({ status: 200, body: { calendars: { primary: { busy: [{ start: "2026-09-28T08:00:00Z", end: "2026-09-28T09:00:00Z" }, { start: "x", end: "y" }] } } } }) } });
  const msCalls = [];
  const msFetch = async (url) => { msCalls.push(url); return { ok: true, status: 200, json: async () => ({ busy: [{ start: "2026-09-28T07:00:00Z", end: "2026-09-28T08:00:00Z" }] }) }; };
  const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now: () => s.clock.now, log: quiet, busySource: parseBusySource("https://acme.calensync.de/api/v1/availability/busy", "tok-google-merge"), fetch: msFetch, google: s.g.forTenant("default") });
  const slots = await cal.findAvailability(win);
  assert.strictEqual(slots[0].start, "2026-09-28T09:00:00.000Z", "09–10 Outlook + 10–11 Google belegt → erst 11:00 Berlin");
  const fb = s.fg.of("freeBusy");
  assert.strictEqual(fb.length, 1);
  assert.deepStrictEqual(fb[0].body.items, [{ id: "primary" }]);
  const from = Date.parse(fb[0].body.timeMin), to = Date.parse(fb[0].body.timeMax);
  assert.ok(from <= Date.parse(win.from) + 3600000 && to >= Date.parse(win.to) && to - from <= 62 * 86400000, "Fenster deckt die Suche ab, höchstens 62 Tage");
  assert.ok(fb[0].init.signal instanceof AbortSignal);
  await cal.findAvailability(win);
  assert.strictEqual(s.fg.of("freeBusy").length, 1, "innerhalb 60 s aus dem Zwischenspeicher");
  s.clock.now += 61_000;
  await cal.findAvailability(win);
  assert.strictEqual(s.fg.of("freeBusy").length, 2, "nach 60 s neu");
  const hit = await cal.conflictFor("2026-09-28T08:30:00Z", "2026-09-28T09:00:00Z");
  assert.strictEqual(s.fg.of("freeBusy").length, 3, "conflictFor fragt frisch");
  assert.deepStrictEqual([hit.source, hit.kind, hit.title], ["google", "blocked", "Belegt"]);
  assert.strictEqual((await cal.conflictFor("2026-09-28T07:30:00Z", "2026-09-28T08:00:00Z")).source, "microsoft");
  assert.strictEqual(await cal.conflictFor("2026-09-28T09:00:00Z", "2026-09-28T09:30:00Z"), null, "frei in beiden");

  // nicht verbunden: keine Quelle, keine Sperre, kein Abruf
  await s.g.disconnect({}, "default");
  const n = s.fg.calls.length;
  assert.strictEqual((await cal.findAvailability(win))[0].start, "2026-09-28T08:00:00.000Z");
  assert.strictEqual(await cal.conflictFor("2026-09-28T08:30:00Z", "2026-09-28T09:00:00Z"), null);
  assert.strictEqual(s.fg.calls.length, n, "ohne Verbindung kein Google-Aufruf");
});

test("Kalender: Google-Ausfall → Suche fail-open, letzte Prüfung fail-closed (Timeout 3 s, HTTP-Fehler, Kalenderfehler)", async () => {
  const cases = {
    netzwerk: () => { throw new TypeError("fetch failed"); },
    http500: () => ({ status: 500, body: { error: { code: 500, status: "INTERNAL", message: "x" } } }),
    kalenderfehler: () => ({ status: 200, body: { calendars: { primary: { errors: [{ domain: "global", reason: "backendError" }], busy: [] } } } }),
    ohneListe: () => ({ status: 200, body: { calendars: {} } }),
  };
  for (const [name, freeBusy] of Object.entries(cases)) {
    const s = await connected({ routes: { freeBusy } });
    const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now: () => s.clock.now, log: quiet, google: s.g.forTenant("default") });
    assert.strictEqual((await cal.findAvailability({ ...win, limit: 2 })).length, 2, `${name}: Slots trotzdem angeboten`);
    const c = await cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z");
    assert.ok(c && c.unverified && c.kind === "unverified" && c.source === "google", `${name}: Slot gilt als belegt`);
  }
  // echter Timeout: Google antwortet nie, Abbruch nach 3 s
  const log = captureLog();
  const s = await connected({ routes: { freeBusy: (call) => new Promise((_r, reject) => call.init.signal.addEventListener("abort", () => reject(call.init.signal.reason))) } });
  const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now: () => s.clock.now, log, google: s.g.forTenant("default") });
  const t0 = Date.now();
  const [slots, c] = await Promise.all([cal.findAvailability({ ...win, limit: 2 }), cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z")]);
  const ms = Date.now() - t0;
  assert.strictEqual(slots.length, 2, "fail-open");
  assert.ok(c.unverified, "fail-closed");
  assert.ok(ms >= 2900 && ms < 5000, `Timeout nach ~3 s (${ms} ms)`);
  assert.ok(log.lines.some((l) => /Google-Kalender-Prüfung fehlgeschlagen, Slot gilt als belegt/.test(l)));
  assert.ok(log.lines.some((l) => /Slots ohne Google-Abgleich/.test(l)));
});

test("Buchung: Termin best effort im Google-Hauptkalender (ohne Telefonnummer), googleEventId an der Buchung; Fehler bricht nichts ab", async () => {
  const s = await connected();
  const store = memoryStore();
  const cal = createCalendar(store, { timezone: "Europe/Berlin", now: () => s.clock.now, log: quiet, google: s.g.forTenant("default") });
  const slot = { id: "b1", start: "2026-09-29T08:00:00Z", end: "2026-09-29T08:30:00Z", title: "Erstgespräch", with: "Eva Test", email: "eva@test.de", phone: "+4915155555555", notes: "Rückenschmerzen", channel: "phone" };
  const saved = await cal.addBooking(slot);
  const [ins] = s.fg.of("insert");
  assert.strictEqual(ins.url, "https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=none");
  assert.strictEqual(ins.body.summary, "Termin: Eva Test");
  assert.deepStrictEqual(ins.body.start, { dateTime: slot.start, timeZone: "Europe/Berlin" });
  assert.deepStrictEqual(ins.body.end, { dateTime: slot.end, timeZone: "Europe/Berlin" });
  assert.match(ins.body.id, /^[a-v0-9]{5,1024}$/, "gültige, aus der Buchung abgeleitete Termin-ID");
  assert.strictEqual(ins.body.visibility, "private");
  const all = JSON.stringify(ins.body);
  for (const secret of ["+4915155555555", "155555555", "eva@test.de", "Rückenschmerzen"]) assert.ok(!all.includes(secret), `kein ${secret} bei Google`);
  assert.ok(!ins.body.attendees, "keine Einladung an Anrufende");
  assert.strictEqual(saved.googleEventId, ins.body.id);
  const stored = (await store.listRange("cal:bookings", 10));
  assert.strictEqual(stored.length, 1, "genau einmal gespeichert");
  assert.strictEqual(stored[0].googleEventId, ins.body.id);

  // ohne Namen
  await cal.addBooking({ id: "b2", start: "2026-09-29T09:00:00Z", end: "2026-09-29T09:30:00Z" });
  assert.strictEqual(s.fg.of("insert")[1].body.summary, "Termin (CalenSync)");
  // Freigabe eines Vorschlags = Buchung → Termin
  await cal.addProposal({ id: "p1", start: "2026-09-29T10:00:00Z", end: "2026-09-29T10:30:00Z", title: "Termin", with: "Anna Praxis" });
  const approved = await cal.decide("p1", "approve");
  assert.strictEqual(s.fg.of("insert")[2].body.summary, "Termin: Anna Praxis");
  assert.ok(approved.googleEventId && approved.kind === "booked");
  await cal.addProposal({ id: "p2", start: "2026-09-29T11:00:00Z", end: "2026-09-29T11:30:00Z", with: "X" });
  await cal.decide("p2", "reject");
  assert.strictEqual(s.fg.of("insert").length, 3, "Ablehnung legt nichts an, Vorschläge auch nicht");
  // Löschen (für künftige Stornierungen)
  assert.strictEqual(await cal.removeGoogleEvent(saved), true);
  assert.match(s.fg.of("remove")[0].url, new RegExp(`/calendars/primary/events/${saved.googleEventId}\\?sendUpdates=none$`));

  // Google-Fehler: Buchung trotzdem gespeichert, ohne googleEventId
  for (const insert of [() => ({ status: 403, body: { error: { status: "PERMISSION_DENIED", message: "x" } } }), () => { throw new TypeError("fetch failed"); }]) {
    const log = captureLog();
    const f = await connected({ routes: { insert } });
    const st = memoryStore();
    const c2 = createCalendar(st, { timezone: "Europe/Berlin", now: () => f.clock.now, log, google: f.g.forTenant("default") });
    const b = await c2.addBooking({ ...slot, id: "b9" });
    assert.strictEqual(b.googleEventId, undefined);
    assert.strictEqual((await st.listRange("cal:bookings", 10)).length, 1, "Buchung gespeichert");
    assert.ok(log.lines.some((l) => /Buchung bleibt bestehen/.test(l)));
  }
  // events.owned abgewählt: kein Eintrag, kein Aufruf
  const ro = await connected({ routes: { token: () => tokenOk({ scope: `openid ${SCOPE_FREEBUSY}` }) } });
  const c3 = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now: () => ro.clock.now, log: quiet, google: ro.g.forTenant("default") });
  assert.strictEqual((await c3.addBooking({ ...slot, id: "b10" })).googleEventId, undefined);
  assert.strictEqual(ro.fg.of("insert").length, 0);
});

test("Agent: feste Buchung trotz Google-Fehler beim Eintragen; Google nicht prüfbar → keine Buchung", async () => {
  const SECRET = "s".repeat(40);
  async function run(routes) {
    const s = await connected({ routes, clock: { now: Date.now() } });
    const sms = [], store = memoryStore();
    const config = fromEnv({ AGENT_MODEL: "fake", WAITLIST_SECRET: SECRET });
    const agent = createAgent(config, { store, log: quiet, google: s.g.forTenant("default"), sendSms: async (to, text) => { sms.push({ to, text }); } });
    await agent.settings.save({ autonomy: "auto", maxPerDay: 12 });
    const t = (u) => agent.turn({ sessionId: "G1", from: "+4915155555555", utterance: u });
    await t("Termin bitte"); await t("Der erste. Name: Eva Test, eva@test.de, 0151 55555555");
    const r = await t(sms[sms.length - 1].text.match(/\d{6}/)[0]);
    const week = await agent.calendar.week(new Date(Date.now() - 86400000).toISOString(), new Date(Date.now() + 30 * 86400000).toISOString());
    return { r, week, s, agent };
  }
  const broken = await run({ insert: () => ({ status: 500, body: { error: { status: "INTERNAL" } } }) });
  assert.match(broken.r.say, /fest eingetragen/);
  assert.ok(broken.week.some((x) => x.kind === "booked" && !x.googleEventId), "gebucht, ohne Google-Termin");
  assert.ok(broken.s.fg.of("freeBusy").length >= 1, "Suche und letzte Prüfung haben Google gefragt");

  const ok = await run({});
  assert.ok(ok.week.some((x) => x.kind === "booked" && x.googleEventId));
  assert.ok((await ok.agent.activity.list()).some((e) => e.kind === "booked" && /im Google Kalender eingetragen/.test(e.text)));

  let calls = 0;
  const down = await run({ freeBusy: () => { if (++calls > 1) throw new TypeError("fetch failed"); return { status: 200, body: { calendars: { primary: { busy: [] } } } }; } });
  assert.match(down.r.say, /nicht verbindlich bestätigen/);
  assert.ok(!down.week.some((x) => x.kind === "booked"), "nichts gebucht");
  assert.ok((await down.agent.activity.list()).some((e) => e.kind === "conflict" && /Google Kalender gerade nicht prüfbar/.test(e.text)));
});

test("Praxismodus: kein Patientenname im Google-Termin (Art. 9 DSGVO), Unternehmensmodus mit Name", async () => {
  const s = await connected();
  const agent = createAgent(fromEnv({ AGENT_MODEL: "fake", WAITLIST_SECRET: WL_SECRET }), { store: memoryStore(), log: quiet, now: () => s.clock.now, google: s.g.forTenant("default"), sendSms: async () => {} });
  await agent.settings.save({ industry: "praxis" });
  await agent.calendar.addProposal({ id: "px1", start: "2026-09-29T08:00:00Z", end: "2026-09-29T08:30:00Z", title: "Kontrolle", with: "Peter Kühn", dateOfBirth: "1970-01-01", phone: "+4915100000000" });
  await agent.calendar.decide("px1", "approve");
  const ins = s.fg.of("insert")[0].body;
  assert.strictEqual(ins.summary, "Termin (CalenSync)");
  assert.ok(!JSON.stringify(ins).includes("Kühn") && !JSON.stringify(ins).includes("1970"), "weder Name noch Geburtsdatum bei Google");
  await agent.settings.save({ industry: "business" });
  await agent.calendar.addBooking({ id: "bz1", start: "2026-09-29T09:00:00Z", end: "2026-09-29T09:30:00Z", with: "Eva Test" });
  assert.strictEqual(s.fg.of("insert")[1].body.summary, "Termin: Eva Test");
});

test("Logs: weder Client-Secret noch Tokens, Codes oder Verifier – über den ganzen Ablauf inkl. Fehlern", async () => {
  const log = captureLog();
  let refreshMode = "ok";
  const s = await connected({
    log,
    routes: {
      token: (c) => {
        if (c.body.grant_type !== "refresh_token") return tokenOk();
        if (refreshMode === "fail") return { status: 500, body: { error: "server_error", error_description: `echo ${c.body.client_secret} ${c.body.refresh_token}` } };
        if (refreshMode === "grant") return { status: 400, body: { error: "invalid_grant" } };
        return { status: 200, body: { access_token: ACCESS2, expires_in: 3600 } };
      },
      freeBusy: () => ({ status: 403, body: { error: { status: "PERMISSION_DENIED", message: `echo ${ACCESS}` } } }),
      insert: () => ({ status: 400, body: { error: { status: "INVALID_ARGUMENT", message: `echo ${ACCESS}` } } }),
    },
  });
  await s.g.connect({}, "default"); // weiterer Start
  const cal = createCalendar(memoryStore(), { timezone: "Europe/Berlin", now: () => s.clock.now, log, google: s.g.forTenant("default") });
  await cal.findAvailability(win);
  await cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z");
  await cal.addBooking({ id: "b1", start: "2026-09-29T08:00:00Z", end: "2026-09-29T08:30:00Z", with: "Eva" });
  s.clock.now += 3600_000; refreshMode = "fail";
  await cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z");
  refreshMode = "grant";
  await cal.conflictFor("2026-09-28T07:00:00Z", "2026-09-28T07:30:00Z");
  const fail = setup({ log, routes: { token: () => ({ status: 401, body: { error: "invalid_client", error_description: CLIENT_SECRET } }) } });
  await finish(fail.g, await startFlow(fail.g));
  const out = log.lines.join("\n");
  assert.ok(log.lines.length >= 4, "es wurde geloggt");
  const verifiers = s.fg.of("token").map((c) => c.body.code_verifier).filter(Boolean);
  for (const secret of [CLIENT_SECRET, REFRESH, ACCESS, ACCESS2, CODE, WL_SECRET, ...verifiers]) assert.ok(!out.includes(secret), `nicht im Log: ${secret.slice(0, 6)}…`);
  assert.match(out, /HTTP 403 PERMISSION_DENIED/, "nur Status und Code");
});

test("seal/unseal: zufälliger IV, Format v1", () => {
  const key = tokenKey(WL_SECRET);
  const a = seal(key, "geheim", "google:x"), b = seal(key, "geheim", "google:x");
  assert.notStrictEqual(a, b);
  assert.strictEqual(unseal(key, a, "google:x"), "geheim");
  assert.throws(() => unseal(key, "v2.a.b.c", "google:x"));
});
