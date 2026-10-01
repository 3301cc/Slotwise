// Integrationstest: Frontend-Client gegen den echten App-Server (ohne Browser; CORS prüft app.test.ts)
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createServer } from "node:http";
import { createCalensyncApi, CalensyncApiError } from "./calensyncApi.js";
import { createAppServer } from "../app/src/server.js";
import { createCorsPolicy } from "../app/src/cors.js";
import { EntraTokenVerifier } from "../app/src/entraAuth.js";
import { InMemoryDelayedJobQueue, type FetchLike } from "../core/src/index.js";
import { MemoryScimStore } from "../scim/src/memoryStore.js";
import { HashedTokenAuthenticator } from "../scim/src/auth.js";
import type { CreatePipelineInput, CreatePipelineResult, PipelineStore } from "../app/src/pipelineStore.js";

const TID = "11111111-2222-3333-4444-555555555555", AUD = "api://calensync-acme";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks: FetchLike = async () => ({ status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k", use: "sig" }] }) });
const now = Math.floor(Date.now() / 1000);
const tok = (c: Record<string, unknown> = {}) => {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: `https://login.microsoftonline.com/${TID}/v2.0`, aud: AUD, tid: TID, oid: "oid-42", scp: "Sync.Read", exp: now + 600, ...c })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};

async function server(statusImpl: (oid: string) => Promise<unknown>, pipelines?: PipelineStore) {
  const app = createAppServer({
    tenantId: "acme",
    webhook: { queue: new InMemoryDelayedJobQueue(), securityEvent: () => {}, repo: { findBySubscriptionIds: async () => new Map(), markStoppedMany: async () => {} } },
    googleWebhook: { queue: new InMemoryDelayedJobQueue(), securityEvent: () => {}, repo: { findGoogleChannel: async () => null, acceptGoogleNotification: async () => ({ fresh: false, queued: false }) } },
    scim: { store: new MemoryScimStore(), baseUrl: "x", newId: randomUUID, auth: new HashedTokenAuthenticator("p".repeat(40), async () => []) },
    cors: createCorsPolicy(["https://app.calensync.de"]),
    auth: new EntraTokenVerifier({ tenantId: TID, audiences: [AUD], requiredScope: "Sync.Read", fetchFn: jwks }),
    status: { getSyncStatus: async (_t, oid) => (await statusImpl(oid)) as never },
    pipelines: pipelines ?? { createPipeline: async () => ({ kind: "user_not_provisioned" }) },
    writeScope: "Sync.Write",
    log: () => {},
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  return { url: `http://localhost:${(app.server.address() as AddressInfo).port}`, close: () => app.server.close() };
}

test("Frontend-Client: 200, 401 → einmal Token erneuern, 404, 403-Scope", async () => {
  const s = await server(async (oid) => (oid === "oid-42" ? { user: { active: true }, pipelines: [] } : null));
  try {
    const calls: boolean[] = [];
    let first = true;
    const api = createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async ({ forceRefresh }) => { calls.push(forceRefresh); if (first) { first = false; return tok({ exp: now - 3600 }); } return tok(); } });
    assert.deepEqual(await api.getSyncStatus(), { user: { active: true }, pipelines: [] });
    assert.deepEqual(calls, [false, true], "abgelaufenes Token → einmal forceRefresh");
    await assert.rejects(createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => tok({ oid: "neu" }) }).getSyncStatus(), (e: unknown) => e instanceof CalensyncApiError && e.kind === "not_provisioned");
    await assert.rejects(createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => tok({ scp: "User.Read" }) }).getSyncStatus(), (e: unknown) => e instanceof CalensyncApiError && e.kind === "forbidden");
    await assert.rejects(createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => "kaputt" }).getSyncStatus(), (e: unknown) => e instanceof CalensyncApiError && e.kind === "unauthenticated");
  } finally { s.close(); }
});

test("Frontend-Client: 503 mit Retry-After wird wiederholt, dann Erfolg; Netzwerkfehler sauber gemeldet", async () => {
  let n = 0;
  const s = await server(async () => { if (++n === 1) throw new Error("DB weg"); return { user: { active: true }, pipelines: [] }; });
  try {
    const api = createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => tok(), maxRetries: 2 });
    const t0 = Date.now();
    assert.equal((await api.getSyncStatus()).user.active, true);
    assert.ok(Date.now() - t0 >= 4000, "Retry-After: 5 respektiert (−15 % Jitter)");
  } finally { s.close(); }
  const dead = createServer(); await new Promise<void>((r) => dead.listen(0, "127.0.0.1", r)); const port = (dead.address() as AddressInfo).port; dead.close();
  await assert.rejects(createCalensyncApi({ apiBaseUrl: `http://localhost:${port}`, getAccessToken: async () => tok() }).getSyncStatus(), (e: unknown) => e instanceof CalensyncApiError && e.kind === "network");
});

/** In-Memory-Store mit derselben Idempotenz-/Limit-Semantik wie PrismaPipelineStore */
function memoryPipelines(limit = 2) {
  const rows = new Map<string, { id: string; status: string; mode: "busy" | "full"; busyLabel: string | null }>();
  const seen: CreatePipelineInput[] = [];
  const store: PipelineStore = {
    createPipeline: async (i): Promise<CreatePipelineResult> => {
      seen.push(i);
      const hit = rows.get(i.idempotencyKey);
      if (hit) return hit.mode === i.mode && hit.busyLabel === i.busyLabel ? { kind: "replayed", pipeline: hit } : { kind: "idempotency_conflict" };
      if (rows.size >= limit) return { kind: "limit_reached", limit };
      const row = { id: randomUUID(), status: "pending", mode: i.mode, busyLabel: i.busyLabel };
      rows.set(i.idempotencyKey, row);
      return { kind: "created", pipeline: row };
    },
  };
  return { store, rows, seen };
}
const writeTok = () => tok({ scp: "Sync.Read Sync.Write" });

test("Frontend-Client: createPipeline – Anlage, Replay mit gleichem Key, Limit, Eingabefehler, fehlender Scope", async () => {
  const m = memoryPipelines(2);
  const s = await server(async () => null, m.store);
  try {
    const api = createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => writeTok() });
    const key = randomUUID();
    const a = await api.createPipeline({ mode: "busy", busyLabel: "Termin" }, key);
    assert.deepEqual([a.status, a.mode, a.busyLabel, a.replayed], ["pending", "busy", "Termin", false]);
    const b = await api.createPipeline({ mode: "busy", busyLabel: "Termin" }, key);
    assert.deepEqual([b.id, b.replayed], [a.id, true]);
    await assert.rejects(api.createPipeline({ mode: "full" }, key), (e: unknown) => e instanceof CalensyncApiError && e.kind === "invalid_request" && e.status === 422);
    await api.createPipeline({ mode: "full" });
    await assert.rejects(api.createPipeline({ mode: "full" }), (e: unknown) => e instanceof CalensyncApiError && e.kind === "limit_reached");
    await assert.rejects(api.createPipeline({ mode: "busy", busyLabel: "<script>" }), (e: unknown) => e instanceof CalensyncApiError && e.kind === "invalid_request" && e.status === 400);
    await assert.rejects(createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => tok() }).createPipeline({ mode: "full" }),
      (e: unknown) => e instanceof CalensyncApiError && e.kind === "forbidden");
    assert.equal(m.rows.size, 2);
  } finally { s.close(); }
});

test("Frontend-Client: Antwort geht verloren → Retry mit demselben Key, genau eine Pipeline", async () => {
  const m = memoryPipelines(5);
  const s = await server(async () => null, m.store);
  try {
    let lost = 0;
    const keys: string[] = [];
    // Erster POST erreicht den Server, die Antwort wird aber „unterwegs“ verworfen (Proxy-Reset, Funkloch)
    const flaky: typeof fetch = async (input, init) => {
      const k = new Headers(init?.headers).get("idempotency-key");
      if (k) keys.push(k);
      const res = await fetch(input, init);
      if (init?.method === "POST" && lost++ === 0) { await res.arrayBuffer(); throw new TypeError("fetch failed"); }
      return res;
    };
    const p = await createCalensyncApi({ apiBaseUrl: s.url, getAccessToken: async () => writeTok(), fetchFn: flaky }).createPipeline({ mode: "full" });
    assert.equal(p.replayed, true, "zweiter Versuch bekommt die bereits angelegte Pipeline");
    assert.equal(m.rows.size, 1);
    assert.equal(keys.length, 2);
    assert.equal(keys[0], keys[1], "derselbe Idempotency-Key bei der Wiederholung");
  } finally { s.close(); }
});
