/**
 * Verlängerung der Graph-Abos: RenewalWorker mit In-Memory-Queue, Fake-Repo und Fake-Graph.
 * Die SQL-Seite (Scheduler, Neuanlage in einem Statement) prüft pgQueue.pg.test.ts gegen PostgreSQL.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  GRAPH_SUBSCRIPTION_LIFETIME_MS, InMemoryDelayedJobQueue, RENEW_KIND, RenewalScheduler, RenewalWorker,
  type AppTokenProvider, type FetchLike, type RenewalAlert, type RenewalRepo, type RenewTarget,
} from "../src/index.js";

const MIN = 60_000;
const T0 = new Date("2026-10-01T08:00:00Z");
const noJitter = () => 0.5;

interface Call { url: string; method: string; body?: string; auth: string }
type Reply = { status: number; body?: string; headers?: Record<string, string> } | Error;

function graph(replies: Reply[]): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = async (url, init) => {
    calls.push({ url, method: init.method, body: init.body, auth: init.headers.Authorization ?? "" });
    const r = replies.shift() ?? { status: 500 };
    if (r instanceof Error) throw r;
    return { status: r.status, headers: { get: (n: string) => r.headers?.[n] ?? null }, text: async () => r.body ?? "" };
  };
  return { fetchFn, calls };
}

function tokens() {
  let n = 0;
  const invalidated: string[] = [];
  const t: AppTokenProvider = { getToken: async () => `tok-${++n}`, invalidate: (tenant) => void invalidated.push(tenant) };
  return { t, invalidated };
}

const target = (o: Partial<RenewTarget> = {}): RenewTarget => ({
  channelId: "c1", tenantId: "acme", userId: "u1", provider: "microsoft", providerSubscriptionId: "sub/1?x", expiresAt: T0.toISOString(),
  live: true, pipelineId: "p1", pipelineStatus: "active", ownerActive: true, ownerCreatedAt: "2026-09-01T00:00:00.000Z", ...o,
});

function fakeRepo(t: RenewTarget | null) {
  const log: string[] = [];
  const recreated: Array<Record<string, unknown>> = [];
  const repo: RenewalRepo = {
    getRenewTarget: async () => t,
    extendExpiry: async (id, at) => { log.push(`extend:${id}:${at}`); return true; },
    markGoneAndRecreate: async (id, note, payload) => { log.push(`gone:${id}:${note}`); recreated.push(payload); return { marked: true, queued: true }; },
    pauseRenewal: async (id, until) => { log.push(`pause:${id}:${until}`); },
    scheduleDueRenewals: async (h, s, l) => { log.push(`schedule:${h}:${s}:${l}`); return 3; },
  };
  return { repo, log, recreated };
}

async function setup(t: RenewTarget | null, replies: Reply[]) {
  let now = T0.getTime();
  const queue = new InMemoryDelayedJobQueue(() => now, noJitter);
  const g = graph(replies);
  const tk = tokens();
  const r = fakeRepo(t);
  const alerts: RenewalAlert[] = [];
  const w = new RenewalWorker({ queue, repo: r.repo, tokens: tk.t, fetchFn: g.fetchFn, workerId: "w1", alert: (a) => void alerts.push(a),
    now: () => new Date(now), random: noJitter });
  await queue.enqueue("acme", RENEW_KIND, { channelId: "c1" }, { dedupeKey: "renew:c1" });
  const job = () => [...queue.rows.values()][0]!;
  return { w, queue, g, tk, r, alerts, job, advance: (ms: number) => { now += ms; } };
}

test("Renewal: 200 → PATCH mit neuer Ablaufzeit (6 Tage), bestätigte Zeit von Graph wird gespeichert", async () => {
  const graphExpiry = "2026-10-07T07:59:00.0000000Z";
  const s = await setup(target(), [{ status: 200, body: JSON.stringify({ id: "sub/1?x", expirationDateTime: graphExpiry }) }]);
  const r = await s.w.tick();
  assert.equal(r.renewed, 1);
  assert.equal(s.g.calls.length, 1);
  assert.equal(s.g.calls[0]!.method, "PATCH");
  assert.equal(s.g.calls[0]!.url, "https://graph.microsoft.com/v1.0/subscriptions/sub%2F1%3Fx", "ID URL-kodiert");
  assert.deepEqual(JSON.parse(s.g.calls[0]!.body ?? "{}"), { expirationDateTime: new Date(T0.getTime() + GRAPH_SUBSCRIPTION_LIFETIME_MS).toISOString() });
  assert.deepEqual(s.r.log, [`extend:c1:${graphExpiry}`]);
  assert.equal(s.job().status, "done");
});

test("Renewal: Offboarding hat Vorrang – gestoppt, Pipeline nicht aktiv, User inaktiv, Google, unbekannt → kein Graph-Aufruf", async () => {
  for (const t of [target({ live: false }), target({ pipelineStatus: "revoked" }), target({ pipelineStatus: "paused" }),
    target({ ownerActive: false }), target({ provider: "google" }), null]) {
    const s = await setup(t, []);
    assert.equal((await s.w.tick()).dropped, 1, JSON.stringify(t));
    assert.equal(s.g.calls.length, 0);
    assert.equal(s.job().status, "done");
  }
});

test("Renewal: 404 → Channel gestoppt + Handshake-Neuanlage mit Provisionierungszeit als grantedAt", async () => {
  const s = await setup(target(), [{ status: 404, body: '{"error":{"code":"ResourceNotFound"}}' }]);
  assert.equal((await s.w.tick()).recreated, 1);
  assert.deepEqual(s.r.log, ["gone:c1:renew_404_subscription_gone"]);
  assert.deepEqual(s.r.recreated, [{ pipelineId: "p1", userId: "u1", grantedAt: "2026-09-01T00:00:00.000Z", attempts: {} }]);
});

test("Renewal: 401 → Token verwerfen, sofort zweiter Versuch mit neuem Token", async () => {
  const s = await setup(target(), [{ status: 401 }, { status: 200, body: "{}" }]);
  assert.equal((await s.w.tick()).renewed, 1);
  assert.deepEqual(s.g.calls.map((c) => c.auth), ["Bearer tok-1", "Bearer tok-2"]);
  assert.deepEqual(s.tk.invalidated, ["acme"]);
});

test("Renewal: 429 mit Retry-After wird nie unterschritten; 503/Timeout → Backoff; nach 8 Versuchen Alarm + Pause", async () => {
  const s = await setup(target(), [{ status: 429, headers: { "Retry-After": "120" } }]);
  assert.equal((await s.w.tick()).rescheduled, 1);
  const runAt = s.job().runAt.getTime() - T0.getTime();
  assert.ok(runAt >= 120_000, `Retry-After respektiert (${runAt} ms)`);

  // Dauerhaft 503 bzw. Netzwerkfehler: Versuche 2…8 rescheduled, Versuch 8 endgültig
  const replies: Reply[] = [];
  for (let i = 0; i < 10; i++) replies.push(i % 2 ? new Error("ETIMEDOUT") : { status: 503 });
  const f = await setup(target(), replies);
  let outcome = "";
  for (let i = 1; i <= 8; i++) {
    f.advance(24 * 60 * MIN);
    const r = await f.w.tick();
    outcome = r.failed ? "failed" : r.rescheduled ? "rescheduled" : "?";
    if (i < 8) assert.equal(outcome, "rescheduled", `Versuch ${i}`);
  }
  assert.equal(outcome, "failed");
  assert.equal(f.job().status, "failed");
  assert.equal(f.alerts.length, 1);
  assert.equal(f.alerts[0]!.kind, "renewal_failed");
  assert.match(f.r.log.at(-1) ?? "", /^pause:c1:/, "Scheduler stellt den Channel 6 h nicht neu ein");
});

test("Renewal: 403 → Backoff im Propagationsfenster (30 min, 60 min …), nach 4 Versuchen Alarm; 400 sofort Alarm", async () => {
  const s = await setup(target(), Array.from({ length: 4 }, () => ({ status: 403, body: '{"error":{"code":"ErrorAccessDenied"}}' })));
  await s.w.tick();
  assert.equal(s.job().runAt.getTime() - T0.getTime(), 30 * MIN);
  for (let i = 0; i < 3; i++) { s.advance(5 * 60 * MIN); await s.w.tick(); }
  assert.equal(s.job().status, "failed");
  assert.equal(s.alerts[0]?.status, 403);

  const b = await setup(target(), [{ status: 400, body: '{"error":{"code":"InvalidRequest"}}' }]);
  assert.equal((await b.w.tick()).failed, 1);
  assert.equal(b.alerts[0]?.status, 400);
  assert.equal(b.g.calls.length, 1, "kein Retry bei 400");
});

test("Renewal: kaputte Payload und gestoppter Worker", async () => {
  let now = T0.getTime();
  const queue = new InMemoryDelayedJobQueue(() => now, noJitter);
  const r = fakeRepo(target());
  const g = graph([]);
  const w = new RenewalWorker({ queue, repo: r.repo, tokens: tokens().t, fetchFn: g.fetchFn, workerId: "w1", alert: () => {}, now: () => new Date(now) });
  await queue.enqueue("acme", RENEW_KIND, { channelId: 42 });
  assert.equal((await w.tick()).dropped, 1);
  assert.equal(g.calls.length, 0);
  w.stop();
  await queue.enqueue("acme", RENEW_KIND, { channelId: "c1" });
  assert.equal((await w.tick()).claimed, 0, "nach stop() keine neuen Jobs");
  now += 1;
});

test("Scheduler: Standardwerte 24 h Horizont, 30 min Streuung, 1 000 je Lauf", async () => {
  const r = fakeRepo(null);
  assert.equal(await new RenewalScheduler(r.repo).tick(), 3);
  assert.deepEqual(r.log, [`schedule:${24 * 60 * MIN}:${30 * MIN}:1000`]);
});
