/**
 * Sync-API: Allowlist in APP_CONFIG, GET /api/v1/me/sync-targets, sync-status mit Ziel/letztem Abgleich,
 * GET /api/v1/availability/busy (statisches Token, Zeitraum, Zusammenfassung, kein Nutzerbezug).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigError, loadConfig, syncAllowlistFrom } from "../src/config.js";
import { createCorsPolicy } from "../src/cors.js";
import { EntraTokenVerifier } from "../src/entraAuth.js";
import { createAppServer, type AppServerDeps } from "../src/server.js";
import { PgStatusRepo } from "../src/statusApi.js";
import { parseBusyRange } from "../src/availabilityApi.js";
import { BusyTooManyError, InMemoryDelayedJobQueue, type BusyInterval, type FetchLike, type PgLike, type SyncAllowlist } from "../../core/src/index.js";
import { MemoryScimStore } from "../../scim/src/memoryStore.js";
import { HashedTokenAuthenticator } from "../../scim/src/auth.js";

const TID = "11111111-2222-3333-4444-555555555555";
const LINKED = "99999999-8888-7777-6666-555555555555";
const AUD = "api://calensync-acme";
const ORIGIN = "https://app.calensync.de";
const BOOKING_TOKEN = "bk_" + "Z".repeat(45);

// ---------------------------------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------------------------------
const secrets = {
  entraTenantId: TID, graphClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", graphCertSha256Hex: "ab".repeat(32),
  scimTokenPepper: "p".repeat(40), scimTokens: [{ tenantId: "acme", sha256Hex: "cd".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }],
};
const env = (extra: Record<string, unknown>) => ({
  NODE_ENV: "production", TENANT_ID: "acme", PUBLIC_BASE_URL: "https://acme.calensync.de", CORS_ALLOWED_ORIGINS: ORIGIN,
  API_AUDIENCE: AUD, DB_HOST: "h", DB_NAME: "calensync", DB_USER: "calensync_app", DB_IAM_AUTH: "true", AWS_REGION: "eu-central-1",
  APP_CONFIG: JSON.stringify({ ...secrets, ...extra }),
});

test("Config: Sync-Ziele optional; angegeben streng geprüft und normalisiert", () => {
  const empty = loadConfig(env({}));
  assert.deepEqual(syncAllowlistFrom(empty.secrets), { homeEntraTenantId: TID, ownDomains: [], ownDomainsIdentityAttribute: "objectId", linkedTenants: [], teamCalendars: [], bookingEnabled: false });
  assert.equal(empty.secrets.syncTentative, false);
  const full = loadConfig(env({
    ownDomains: ["Acme-Alias.example"],
    linkedTenants: [{ entraTenantId: LINKED.toUpperCase(), label: "Tochter GmbH", domains: ["Tochter.example"] }],
    teamCalendars: [{ id: "vertrieb", mailbox: "Vertrieb@Acme.example", label: "Vertrieb" }],
    bookingApiToken: BOOKING_TOKEN, syncTentative: true,
  }));
  assert.deepEqual(syncAllowlistFrom(full.secrets), {
    homeEntraTenantId: TID, ownDomains: ["acme-alias.example"], ownDomainsIdentityAttribute: "objectId",
    linkedTenants: [{ entraTenantId: LINKED, label: "Tochter GmbH", domains: ["tochter.example"], identityAttribute: "employeeId" }],
    teamCalendars: [{ id: "vertrieb", mailbox: "vertrieb@acme.example", label: "Vertrieb", allowFullMode: false }], bookingEnabled: true,
  });
  assert.equal(full.secrets.syncTentative, true);
  const bad: Array<[Record<string, unknown>, RegExp]> = [
    [{ ownDomains: ["*.acme.example"] }, /ownDomains\[0\]/],
    [{ ownDomains: "acme.example" }, /ownDomains/],
    [{ linkedTenants: [{ entraTenantId: "x", label: "a", domains: ["a.de"] }] }, /GUID/],
    [{ linkedTenants: [{ entraTenantId: TID, label: "a", domains: ["a.de"] }] }, /eigener Mandant/],
    [{ linkedTenants: [{ entraTenantId: LINKED, label: "a", domains: [] }] }, /mindestens eine Domain/],
    [{ linkedTenants: [{ entraTenantId: LINKED, label: "<b>", domains: ["a.de"] }] }, /label/],
    [{ teamCalendars: [{ id: "Vertrieb!", mailbox: "v@a.de", label: "V" }] }, /id/],
    [{ teamCalendars: [{ id: "v", mailbox: "kein-postfach", label: "V" }] }, /mailbox/],
    [{ teamCalendars: [{ id: "v", mailbox: "v@a.de", label: "V" }, { id: "v", mailbox: "w@a.de", label: "W" }] }, /doppelte id/],
    [{ bookingApiToken: "kurz" }, /bookingApiToken/],
    [{ syncTentative: "ja" }, /syncTentative/],
    [{ linkedTenants: [{ entraTenantId: LINKED, label: "a", domains: ["a.de"], identityAttribute: "objectId" }] }, /nur im eigenen Mandanten/],
    [{ linkedTenants: [{ entraTenantId: LINKED, label: "a", domains: ["a.de"], identityAttribute: "mail" }] }, /identityAttribute/],
    [{ ownDomainsIdentityAttribute: "upn" }, /ownDomainsIdentityAttribute/],
    [{ teamCalendars: [{ id: "v", mailbox: "v@a.de", label: "V", allowFullMode: "ja" }] }, /allowFullMode/],
  ];
  for (const [extra, re] of bad) assert.throws(() => loadConfig(env(extra)), (e: unknown) => e instanceof ConfigError && re.test(e.message), JSON.stringify(extra));
});

// ---------------------------------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------------------------------
const ALLOW: SyncAllowlist = {
  homeEntraTenantId: TID, ownDomains: ["acme-alias.example"],
  linkedTenants: [{ entraTenantId: LINKED, label: "Tochter GmbH", domains: ["tochter.example"] }],
  teamCalendars: [{ id: "vertrieb", mailbox: "vertrieb@acme.example", label: "Vertrieb" }], bookingEnabled: true,
};
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks: FetchLike = async () => ({ status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k", use: "sig" }] }) });
const nowSec = Math.floor(Date.now() / 1000);
const tok = (c: Record<string, unknown> = {}) => {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: `https://login.microsoftonline.com/${TID}/v2.0`, aud: AUD, tid: TID, oid: "oid-42",
    scp: "Sync.Read", iat: nowSec, nbf: nowSec - 5, exp: nowSec + 600, ...c })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};

async function withApp(over: Partial<AppServerDeps>, fn: (port: number, sec: Array<Record<string, unknown>>) => Promise<void>) {
  const sec: Array<Record<string, unknown>> = [];
  const app = createAppServer({
    tenantId: "acme",
    webhook: { queue: new InMemoryDelayedJobQueue(), securityEvent: () => {}, repo: { findBySubscriptionIds: async () => new Map(), markStoppedMany: async () => {} } },
    googleWebhook: { queue: new InMemoryDelayedJobQueue(), securityEvent: () => {}, repo: { findGoogleChannel: async () => null, acceptGoogleNotification: async () => ({ fresh: false, queued: false }) } },
    scim: { store: new MemoryScimStore(), baseUrl: "x", newId: randomUUID, auth: new HashedTokenAuthenticator("p".repeat(40), async () => []) },
    cors: createCorsPolicy([ORIGIN]),
    auth: new EntraTokenVerifier({ tenantId: TID, audiences: [AUD], requiredScope: "Sync.Read", fetchFn: jwks }),
    status: { getSyncStatus: async () => null },
    pipelines: { createPipeline: async () => ({ kind: "user_not_provisioned" }) },
    log: () => {},
    security: { security: (event, f) => sec.push({ event, ...(f ?? {}) }) },
    ...over,
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    await fn((app.server.address() as AddressInfo).port, sec);
  } finally {
    app.server.close();
  }
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, unknown> }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} }));
    });
    r.on("error", reject);
    r.end();
  });
}

test("GET /me/sync-targets: Vorschläge aus dem eigenen userName, Teams nur id+label, Sync.Read reicht, 404 ohne Provisionierung", async () => {
  const owners = { getActiveUserName: async (_t: string, oid: string) => (oid === "oid-42" ? "Max.Muster@acme.example" : null) };
  await withApp({ syncTargets: { allowlist: ALLOW, owners } }, async (port) => {
    const r = await call(port, "GET", "/api/v1/me/sync-targets", { Authorization: `Bearer ${tok()}`, Origin: ORIGIN });
    assert.equal(r.status, 200);
    assert.deepEqual(r.json, {
      account: { allowed: true, suggestions: [
        { entraTenantId: null, label: "acme-alias.example", mailbox: "max.muster@acme-alias.example", verified: false },
        { entraTenantId: LINKED, label: "Tochter GmbH", mailbox: "max.muster@tochter.example", verified: false },
      ] },
      team: [{ id: "vertrieb", label: "Vertrieb", fullMode: false }],
      booking: { enabled: true },
    });
    assert.equal(JSON.stringify(r.json).includes("vertrieb@acme.example"), false, "kein Team-Postfach im Browser");
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
    const other = await call(port, "GET", "/api/v1/me/sync-targets", { Authorization: `Bearer ${tok({ oid: "oid-fremd" })}` });
    assert.deepEqual([other.status, other.json.error], [404, "user_not_provisioned"]);
    assert.equal((await call(port, "GET", "/api/v1/me/sync-targets")).status, 401);
  });
  await withApp({ syncTargets: { allowlist: { ...ALLOW, ownDomains: [], linkedTenants: [], bookingEnabled: false }, owners } }, async (port) => {
    const r = await call(port, "GET", "/api/v1/me/sync-targets", { Authorization: `Bearer ${tok()}` });
    assert.deepEqual(r.json.account, { allowed: false, suggestions: [] });
    assert.deepEqual(r.json.booking, { enabled: false });
  });
});

test("sync-status: Ziel nur als Art + Label, letzter Abgleich, Fehler nur als Code (PgStatusRepo mit Fake-Pool)", async () => {
  const rows = [
    { user_active: true, pipeline_id: "p1", pipeline_status: "active", channel_expires_at: "2026-10-07T00:00:00Z", channel_live: true,
      target_kind: "account", target_mailbox: "max.muster@tochter.example", target_entra_tenant_id: LINKED, target_ref: null,
      last_synced_at: "2026-10-01T08:00:00Z", last_sync_error: null },
    { user_active: true, pipeline_id: "p2", pipeline_status: "blocked_scope", channel_expires_at: null, channel_live: false,
      target_kind: "team", target_mailbox: "vertrieb@acme.example", target_entra_tenant_id: null, target_ref: "vertrieb",
      last_synced_at: null, last_sync_error: "blocked_scope" },
    { user_active: true, pipeline_id: "p3", pipeline_status: "active", channel_expires_at: null, channel_live: false,
      target_kind: null, target_mailbox: null, target_entra_tenant_id: null, target_ref: null, last_synced_at: null, last_sync_error: null },
  ];
  const sql: string[] = [];
  const pool: PgLike = { query: async (text: string) => { sql.push(text); return { rows: rows as never[], rowCount: rows.length }; } };
  const s = await new PgStatusRepo(pool, ALLOW).getSyncStatus("acme", "oid-42");
  assert.deepEqual(s?.pipelines.map((p) => [p.id, p.target, p.lastSyncedAt, p.lastError]), [
    ["p1", { kind: "account", label: "Tochter GmbH" }, "2026-10-01T08:00:00.000Z", null],
    ["p2", { kind: "team", label: "Vertrieb" }, null, "blocked_scope"],
    ["p3", null, null, null],
  ]);
  assert.equal(JSON.stringify(s).includes("@"), false, "kein Postfach in der Antwort");
  assert.equal(sql.length, 1, "weiterhin eine Abfrage");
});

test("GET /availability/busy: Token timing-sicher, Zeitraum geprüft, Intervalle zusammengefasst, ohne Nutzerbezug", async () => {
  const calls: Array<[string, string, string]> = [];
  const d = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 2, h, m));
  const repo = { busyIntervals: async (t: string, from: Date, to: Date): Promise<BusyInterval[]> => {
    calls.push([t, from.toISOString(), to.toISOString()]);
    return [{ start: d(9), end: d(10) }, { start: d(9, 30), end: d(11) }, { start: d(13), end: d(14) }, { start: d(6), end: d(8, 30) }];
  } };
  await withApp({ booking: { token: BOOKING_TOKEN, repo } }, async (port, sec) => {
    const q = "/api/v1/availability/busy?from=2026-10-02T08:00:00Z&to=2026-10-03T00:00:00%2B02:00";
    const okR = await call(port, "GET", q, { Authorization: `Bearer ${BOOKING_TOKEN}` });
    assert.equal(okR.status, 200);
    assert.deepEqual(okR.json, { busy: [
      { start: "2026-10-02T08:00:00.000Z", end: "2026-10-02T08:30:00.000Z" },
      { start: "2026-10-02T09:00:00.000Z", end: "2026-10-02T11:00:00.000Z" },
      { start: "2026-10-02T13:00:00.000Z", end: "2026-10-02T14:00:00.000Z" },
    ] });
    assert.deepEqual(calls, [["acme", "2026-10-02T08:00:00.000Z", "2026-10-02T22:00:00.000Z"]]);

    const wrong = await call(port, "GET", q, { Authorization: `Bearer ${BOOKING_TOKEN.slice(0, -1)}X` });
    assert.deepEqual([wrong.status, wrong.json.error], [401, "invalid_token"]);
    assert.match(String(wrong.headers["www-authenticate"]), /invalid_token/);
    assert.equal((await call(port, "GET", q)).status, 401);
    assert.equal((await call(port, "GET", q, { Authorization: `Bearer ${tok()}` })).status, 401, "Entra-Token gilt hier nicht");
    assert.equal(JSON.stringify(sec).includes(BOOKING_TOKEN.slice(0, 20)), false, "Token nie im Sicherheits-Log");
    assert.deepEqual(sec.map((e) => e.code), ["booking_token_invalid", "booking_token_missing", "booking_token_missing"]);
    assert.equal(calls.length, 1, "ohne gültiges Token keine DB-Abfrage");

    const auth = { Authorization: `Bearer ${BOOKING_TOKEN}` };
    for (const [qs, status, error] of [
      ["", 400, "invalid_range"],
      ["?from=2026-10-02&to=2026-10-03", 400, "invalid_range"],
      ["?from=2026-10-02T08:00:00&to=2026-10-03T08:00:00", 400, "invalid_range"],
      ["?from=2026-10-03T08:00:00Z&to=2026-10-02T08:00:00Z", 400, "invalid_range"],
      ["?from=2026-10-02T08:00:00Z&from=2026-10-01T08:00:00Z&to=2026-10-03T08:00:00Z", 400, "invalid_range"],
      ["?from=2026-10-01T00:00:00Z&to=2026-12-03T00:00:01Z", 422, "range_too_large"],
    ] as const) {
      const r = await call(port, "GET", `/api/v1/availability/busy${qs}`, auth);
      assert.deepEqual([r.status, r.json.error], [status, error], qs);
    }
    assert.equal(parseBusyRange("/x?from=2026-10-01T00:00:00Z&to=2026-12-02T00:00:00Z").ok, true, "genau 62 Tage");
    // CORS wie die übrige API: fremde Origin abgewiesen
    assert.equal((await call(port, "GET", q, { ...auth, Origin: "https://evil.example" })).status, 403);
  });
  await withApp({ booking: { token: null, repo } }, async (port) => {
    const r = await call(port, "GET", "/api/v1/availability/busy?from=2026-10-02T08:00:00Z&to=2026-10-03T08:00:00Z", { Authorization: `Bearer ${BOOKING_TOKEN}` });
    assert.deepEqual([r.status, r.json.error], [404, "booking_api_disabled"]);
  });
});

test("Review #5: sync-targets zeigt je Team fullMode; Review #3: zu viele Belegt-Intervalle → 503 busy_too_many statt Abschneiden", async () => {
  const owners = { getActiveUserName: async () => "Max.Muster@acme.example" };
  const allow = { ...ALLOW, teamCalendars: [{ ...ALLOW.teamCalendars[0], allowFullMode: true }, { id: "empfang", mailbox: "empfang@acme.example", label: "Empfang" }] };
  await withApp({ syncTargets: { allowlist: allow, owners } }, async (port) => {
    const r = await call(port, "GET", "/api/v1/me/sync-targets", { Authorization: `Bearer ${tok()}` });
    assert.deepEqual(r.json.team, [{ id: "vertrieb", label: "Vertrieb", fullMode: true }, { id: "empfang", label: "Empfang", fullMode: false }]);
  });
  const repo = { busyIntervals: async (): Promise<BusyInterval[]> => { throw new BusyTooManyError(5000); } };
  await withApp({ booking: { token: BOOKING_TOKEN, repo } }, async (port) => {
    const r = await call(port, "GET", "/api/v1/availability/busy?from=2026-10-02T08:00:00Z&to=2026-10-03T00:00:00Z", { Authorization: `Bearer ${BOOKING_TOKEN}` });
    assert.deepEqual([r.status, r.json], [503, { error: "busy_too_many", max: 5000 }]);
  });
});
