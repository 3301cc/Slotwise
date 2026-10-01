import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { ConfigError, loadConfig, parseOrigins } from "../src/config.js";
import { createCorsPolicy } from "../src/cors.js";
import { AuthError, EntraTokenVerifier } from "../src/entraAuth.js";
import { createAppServer } from "../src/server.js";
import type { StatusRepo } from "../src/statusApi.js";
import { InMemoryDelayedJobQueue, type FetchLike, type GuardChannel } from "../../core/src/index.js";
import { MemoryScimStore } from "../../scim/src/memoryStore.js";
import { HashedTokenAuthenticator, hashToken } from "../../scim/src/auth.js";

const TID = "11111111-2222-3333-4444-555555555555";
const AUD = "api://calensync-acme";
const ORIGIN = "https://app.calensync.de";

// ---------------------------------------------------------------------------------------------------
// Konfiguration
// ---------------------------------------------------------------------------------------------------
const secrets = {
  entraTenantId: TID, graphClientId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", graphCertSha256Hex: "ab".repeat(32),
  scimTokenPepper: "p".repeat(40), scimTokens: [{ tenantId: "acme", sha256Hex: "cd".repeat(32), expiresAt: "2099-01-01T00:00:00Z" }],
};
const baseEnv = {
  NODE_ENV: "production", TENANT_ID: "acme", PUBLIC_BASE_URL: "https://acme.calensync.de", CORS_ALLOWED_ORIGINS: ORIGIN,
  API_AUDIENCE: AUD, DB_HOST: "h", DB_NAME: "calensync", DB_USER: "calensync_app", DB_IAM_AUTH: "true", AWS_REGION: "eu-central-1",
  APP_CONFIG: JSON.stringify(secrets),
};

test("Config: gültige Produktions-Umgebung wird geladen, Pool ≤ 20", () => {
  const c = loadConfig({ ...baseEnv, DB_POOL_MAX: "20" });
  assert.deepEqual([c.port, c.db.poolMax, c.corsAllowedOrigins, c.api.requiredScope], [8080, 20, [ORIGIN], "Sync.Read"]);
  assert.throws(() => loadConfig({ ...baseEnv, DB_POOL_MAX: "50" }), ConfigError);
});

test("Config: unsichere Werte brechen den Start ab", () => {
  assert.throws(() => parseOrigins("*", true), /Wildcard/);
  assert.throws(() => parseOrigins("http://app.calensync.de", true), /nur https/);
  assert.throws(() => parseOrigins("https://app.calensync.de/", true), /ohne Pfad/);
  assert.deepEqual(parseOrigins("http://localhost:5173", false), ["http://localhost:5173"]);
  assert.throws(() => parseOrigins("http://localhost:5173", true), /nur https/);
  assert.throws(() => loadConfig({ ...baseEnv, DB_PASSWORD: "x" }), /Statisches DB-Passwort/);
  assert.throws(() => loadConfig({ ...baseEnv, APP_CONFIG: JSON.stringify({ ...secrets, scimTokenPepper: "kurz" }) }), /32 Zeichen/);
  assert.throws(() => loadConfig({ ...baseEnv, APP_CONFIG: "{" }), /kein gültiges JSON/);
});

// ---------------------------------------------------------------------------------------------------
// Entra-Token
// ---------------------------------------------------------------------------------------------------
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const KID = "test-kid-1";
let jwksCalls = 0;
const jwksFetch: FetchLike = async (url) => {
  jwksCalls++;
  assert.equal(url, `https://login.microsoftonline.com/${TID}/discovery/v2.0/keys`);
  const body = JSON.stringify({ keys: [{ ...jwk, kid: KID, use: "sig", alg: "RS256" }] });
  return { status: 200, headers: { get: () => null }, text: async () => body };
};
const nowSec = Math.floor(Date.now() / 1000);
function token(claims: Record<string, unknown>, kid = KID, key = privateKey): string {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT", kid })).toString("base64url");
  const p = Buffer.from(JSON.stringify({
    iss: `https://login.microsoftonline.com/${TID}/v2.0`, aud: AUD, tid: TID, oid: "oid-42", scp: "Sync.Read",
    iat: nowSec, nbf: nowSec - 5, exp: nowSec + 3600, name: "Max", ...claims,
  })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), key).toString("base64url")}`;
}
const verifier = () => new EntraTokenVerifier({ tenantId: TID, audiences: [AUD], requiredScope: "Sync.Read", fetchFn: jwksFetch });

test("Entra: gültiges Token → Principal; JWKS wird gecacht", async () => {
  jwksCalls = 0;
  const v = verifier();
  const p = await v.verifyAuthorizationHeader(`Bearer ${token({})}`);
  assert.deepEqual([p.oid, p.tid, p.scopes], ["oid-42", TID, ["Sync.Read"]]);
  await v.verify(token({}));
  assert.equal(jwksCalls, 1);
});

test("Entra: jede Abweichung wird abgewiesen", async () => {
  const v = verifier();
  const other = generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey;
  const cases: Array<[string, string, number]> = [
    ["fremder Schlüssel", token({}, KID, other), 401],
    ["abgelaufen", token({ exp: nowSec - 3600 }), 401],
    ["anderer Mandant", token({ tid: "99999999-2222-3333-4444-555555555555" }), 401],
    ["falscher Issuer", token({ iss: "https://evil.example/v2.0" }), 401],
    ["falsche Audience", token({ aud: "api://andere-app" }), 401],
    ["fehlender Scope", token({ scp: "User.Read" }), 403],
    ["unbekannte kid", token({}, "unbekannt"), 401],
  ];
  for (const [name, t, status] of cases) {
    await assert.rejects(v.verify(t), (e: unknown) => e instanceof AuthError && e.status === status, name);
  }
  const [h, p] = token({}).split(".");
  const none = `${Buffer.from(JSON.stringify({ alg: "none", kid: KID })).toString("base64url")}.${p}.`;
  await assert.rejects(v.verifyAuthorizationHeader(`Bearer ${none}x`), AuthError, "alg none");
  void h;
});

// ---------------------------------------------------------------------------------------------------
// HTTP-Server: Routing, CORS, Absicherung
// ---------------------------------------------------------------------------------------------------
const SCIM_TOKEN = "scim-" + "t".repeat(40);
const securityEvents: Array<Record<string, unknown>> = [];
const GOOGLE_TOKEN = "tok_" + "g".repeat(39);
async function withApp(fn: (port: number) => Promise<void>) {
  const queue = new InMemoryDelayedJobQueue();
  const ch: GuardChannel = { id: "c1", tenantId: "acme", userId: "u1", provider: "microsoft", providerSubscriptionId: "sub-1",
    providerResourceId: null, clientState: "cs-1", expiresAt: null, stopRequestedAt: null, stoppedAt: null, stopAttempts: 0,
    nextStopAttemptAt: null, lastStopError: null, pipelineId: "p1", pipelineStatus: "active" };
  const status: StatusRepo = {
    getSyncStatus: async (_t, oid) => (oid === "oid-42" ? { user: { active: true }, pipelines: [{ id: "p1", status: "active", subscription: { active: true, expiresAt: null }, target: null, lastSyncedAt: null, lastError: null, cleanup: null }] } : null),
  };
  const pepper = "p".repeat(40);
  const app = createAppServer({
    tenantId: "acme",
    webhook: { queue, securityEvent: () => {}, repo: {
      findBySubscriptionIds: async (ids) => new Map(ids.filter((i) => i === "sub-1").map((i) => [i, ch] as const)),
      markStoppedMany: async () => {},
    } },
    googleWebhook: { queue, securityEvent: () => {}, repo: {
      findGoogleChannel: async (id) => (id === "gchan-1" ? { ...ch, provider: "google", providerSubscriptionId: "gchan-1", providerResourceId: "gres-1",
        clientState: GOOGLE_TOKEN, lastMessageNumber: null } : null),
      acceptGoogleNotification: async () => ({ fresh: true, queued: true }),
    } },
    scim: { store: new MemoryScimStore(), baseUrl: "https://acme.calensync.de/scim/v2", newId: randomUUID,
      auth: new HashedTokenAuthenticator(pepper, async () => [{ tenantId: "acme", sha256Hex: hashToken(pepper, SCIM_TOKEN), expiresAt: "2099-01-01T00:00:00Z" }]) },
    cors: createCorsPolicy([ORIGIN]),
    auth: verifier(),
    status,
    pipelines: { createPipeline: async () => ({ kind: "user_not_provisioned" }) },
    log: () => {},
    security: { security: (event, f) => securityEvents.push({ event, ...(f ?? {}) }) },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    await fn((app.server.address() as AddressInfo).port);
    app.startDraining();
    assert.equal((await call((app.server.address() as AddressInfo).port, "GET", "/healthz")).status, 503, "drainierend");
  } finally {
    app.server.close();
  }
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; text: string }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path, headers: { ...headers, ...(body ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, text }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("Server: Healthcheck, Webhook, SCIM, API inkl. CORS – und die Sperren", async () => {
  await withApp(async (port) => {
    // Healthcheck + Sicherheitsheader
    const h = await call(port, "GET", "/healthz");
    assert.equal(h.status, 200);
    assert.match(String(h.headers["strict-transport-security"]), /max-age=63072000/);

    // Webhook: Validierung + Annahme
    assert.equal((await call(port, "POST", "/webhooks/graph?validationToken=abc")).text, "abc");
    const wh = await call(port, "POST", "/webhooks/graph", { "Content-Type": "application/json" }, JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState: "cs-1" }] }));
    assert.equal(wh.status, 202);

    // Google-Push: nur Header, gültig → 200; Browser-Origin → 403; Pfad-Trick → 400
    const g = { "X-Goog-Channel-ID": "gchan-1", "X-Goog-Channel-Token": GOOGLE_TOKEN, "X-Goog-Resource-ID": "gres-1",
      "X-Goog-Resource-State": "exists", "X-Goog-Message-Number": "3" };
    assert.equal((await call(port, "POST", "/webhooks/google", g)).status, 200);
    assert.equal((await call(port, "POST", "/webhooks/google", { ...g, Origin: ORIGIN })).status, 403);
    assert.equal((await call(port, "POST", "/webhooks/google/..%2f..%2fapi/v1/me/sync-status", g)).status, 400);

    // Pfad-Tricks gegen die WAF-Ausnahme für /webhooks/
    assert.equal((await call(port, "GET", "/webhooks/../api/v1/me/sync-status")).status, 400);
    assert.equal((await call(port, "GET", "/webhooks/%2e%2e/api/v1/me/sync-status")).status, 400);

    // SCIM: Token nötig, Browser-Origin gesperrt
    assert.equal((await call(port, "GET", "/scim/v2/Users")).status, 401);
    assert.equal((await call(port, "GET", "/scim/v2/Users", { Authorization: `Bearer ${SCIM_TOKEN}` })).status, 200);
    assert.equal((await call(port, "GET", "/scim/v2/Users", { Authorization: `Bearer ${SCIM_TOKEN}`, Origin: ORIGIN })).status, 403);

    // CORS-Preflight: erlaubte Origin
    const pre = await call(port, "OPTIONS", "/api/v1/me/sync-status", { Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "authorization" });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(pre.headers["access-control-allow-credentials"], undefined, "keine Cookies");
    assert.equal(pre.headers.vary, "Origin");
    // fremde Origin, Wildcard-Versuch, unerlaubter Header
    const evil = await call(port, "OPTIONS", "/api/v1/me/sync-status", { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" });
    assert.deepEqual([evil.status, evil.headers["access-control-allow-origin"]], [403, undefined]);
    assert.equal((await call(port, "OPTIONS", "/api/v1/me/sync-status", { Origin: `${ORIGIN}.evil.example`, "Access-Control-Request-Method": "GET" })).status, 403);
    assert.equal((await call(port, "OPTIONS", "/api/v1/me/sync-status", { Origin: ORIGIN, "Access-Control-Request-Method": "GET", "Access-Control-Request-Headers": "x-admin" })).status, 403);

    // API: ohne Token 401, mit Token 200 + CORS-Header, falscher Scope 403
    const noTok = await call(port, "GET", "/api/v1/me/sync-status", { Origin: ORIGIN });
    assert.equal(noTok.status, 401);
    assert.match(String(noTok.headers["www-authenticate"]), /invalid_token/);
    const ok = await call(port, "GET", "/api/v1/me/sync-status", { Origin: ORIGIN, Authorization: `Bearer ${token({})}` });
    assert.equal(ok.status, 200);
    assert.equal(ok.headers["access-control-allow-origin"], ORIGIN);
    assert.equal(JSON.parse(ok.text).pipelines[0].status, "active");
    assert.equal((await call(port, "GET", "/api/v1/me/sync-status", { Origin: ORIGIN, Authorization: `Bearer ${token({ scp: "User.Read" })}` })).status, 403);
    assert.equal((await call(port, "GET", "/api/v1/me/sync-status", { Authorization: `Bearer ${token({ oid: "unbekannt" })}` })).status, 404);
  });
});

test("Server: Sicherheitsereignisse werden strukturiert gemeldet – ohne Token im Log", async () => {
  securityEvents.length = 0;
  await withApp(async (port) => {
    await call(port, "GET", "/webhooks/../api/x");
    await call(port, "GET", "/scim/v2/Users", { Authorization: "Bearer falsch-" + "x".repeat(40) });
    await call(port, "GET", "/scim/v2/Users", { Origin: ORIGIN });
    await call(port, "OPTIONS", "/api/v1/me/sync-status", { Origin: "https://evil.example", "Access-Control-Request-Method": "GET" });
    await call(port, "GET", "/api/v1/me/sync-status", { Authorization: `Bearer ${token({ exp: nowSec - 3600 })}` });
    await call(port, "GET", "/api/v1/me/sync-status", { Authorization: `Bearer ${token({ scp: "User.Read" })}` });
    await call(port, "GET", "/healthz", { "X-Request-Id": "evil\r\nX-Injected: 1" }).catch(() => undefined);
  });
  assert.deepEqual(securityEvents.map((e) => e.event), [
    "bad_path", "scim_auth_failed", "scim_browser_origin", "cors_origin_rejected", "api_auth_failed", "api_insufficient_scope",
  ]);
  assert.equal(securityEvents[4].code, "token_expired");
  for (const e of securityEvents) assert.match(String(e.requestId), /^[0-9a-f-]{36}$|^[A-Za-z0-9._-]{1,100}$/);
  assert.equal(JSON.stringify(securityEvents).includes("falsch-"), false, "Bearer-Token nicht im Ereignis");
});

test("Server: unsichere X-Request-Id wird ersetzt", async () => {
  await withApp(async (port) => {
    const ok = await call(port, "GET", "/healthz", { "X-Request-Id": "abc-123_x.y" });
    assert.equal(ok.headers["x-request-id"], "abc-123_x.y");
    const bad = await call(port, "GET", "/healthz", { "X-Request-Id": "a b<script>" });
    assert.match(String(bad.headers["x-request-id"]), /^[0-9a-f-]{36}$/);
  });
});

