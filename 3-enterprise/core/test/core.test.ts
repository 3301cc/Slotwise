import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPE_PROPAGATION,
  backoffDelayMs,
  classifyGraphError,
  handleHandshakeFailure,
  HandshakeWorker,
  HANDSHAKE_KIND,
  InMemoryDelayedJobQueue,
  SubscriptionTeardown,
  handleGraphWebhook,
  type AppTokenProvider,
  type ChannelRepo,
  type FetchLike,
  type GuardChannel,
  type HandshakePayload,
  type HandshakeTarget,
  type WebhookChannel,
} from "../src/index.js";

const MIN = 60_000;
/** Mitte des Jitter-Bands → exakt der Nominalwert */
const noJitter = () => 0.5;
/** Unterkante des Bands; bei Retry-After = exakt Retry-After */
const lowEdge = () => 0;
const T0 = new Date("2026-10-01T08:00:00Z");

// ---------------------------------------------------------------------------------------------------
// Hilfen
// ---------------------------------------------------------------------------------------------------
interface Call { url: string; method: string; headers: Record<string, string>; body?: string }
type Reply = { status: number; body?: string; headers?: Record<string, string> } | "hang" | Error;

function fakeFetch(route: (c: Call) => Reply): { fetchFn: FetchLike; calls: Call[] } {
  const calls: Call[] = [];
  const fetchFn: FetchLike = (url, init) => {
    const c = { url, method: init.method, headers: init.headers, body: init.body };
    calls.push(c);
    const r = route(c);
    if (r instanceof Error) return Promise.reject(r);
    if (r === "hang") {
      return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    }
    const h = Object.fromEntries(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
    return Promise.resolve({ status: r.status, headers: { get: (n: string) => h[n.toLowerCase()] ?? null }, text: async () => r.body ?? "" });
  };
  return { fetchFn, calls };
}

function tokens(): AppTokenProvider & { invalidated: number } {
  let n = 0;
  return {
    invalidated: 0,
    async getToken() { return `tok-${n}`; },
    invalidate() { n += 1; this.invalidated += 1; },
  };
}

function channel(over: Partial<WebhookChannel> = {}): WebhookChannel {
  return {
    id: "ch-1", tenantId: "acme", userId: "u-1", provider: "microsoft", providerSubscriptionId: "sub-1",
    providerResourceId: null, clientState: "cs-secret", expiresAt: "2026-10-05T00:00:00Z",
    stopRequestedAt: T0.toISOString(), stoppedAt: null, stopAttempts: 0, nextStopAttemptAt: null, lastStopError: null,
    ...over,
  };
}

class MemChannels implements ChannelRepo {
  constructor(public rows: WebhookChannel[]) {}
  log: string[] = [];
  async listOpenForUser(t: string, u: string) { return this.rows.filter((r) => r.tenantId === t && r.userId === u && !r.stoppedAt).map((r) => ({ ...r })); }
  async claimDueStops(nowIso: string) {
    return this.rows.filter((r) => r.stopRequestedAt && !r.stoppedAt && ((r.stopAttempts === 0 && !r.nextStopAttemptAt) || (r.nextStopAttemptAt && r.nextStopAttemptAt <= nowIso))).map((r) => ({ ...r }));
  }
  async markStopped(id: string, at: string, note: string) {
    const r = this.rows.find((x) => x.id === id)!;
    r.stoppedAt = at; r.stopRequestedAt ??= at; r.nextStopAttemptAt = null; this.log.push(`stopped:${id}:${note}`);
  }
  async recordStopFailure(id: string, f: { attempts: number; nextAttemptAtIso: string | null; error: string }) {
    const r = this.rows.find((x) => x.id === id)!;
    r.stopAttempts = f.attempts; r.nextStopAttemptAt = f.nextAttemptAtIso; r.lastStopError = f.error; this.log.push(`failure:${id}`);
  }
}

// ---------------------------------------------------------------------------------------------------
// Backoff
// ---------------------------------------------------------------------------------------------------
test("Backoff: nominal 30 → 60 → 120 → 240 → 240 min, Jitter symmetrisch ±15 %", () => {
  const d = [1, 2, 3, 4, 5].map((n) => backoffDelayMs(SCOPE_PROPAGATION, n, noJitter) / MIN);
  assert.deepEqual(d, [30, 60, 120, 240, 240]);
  assert.equal(backoffDelayMs(SCOPE_PROPAGATION, 1, lowEdge), 25.5 * MIN);
  const hi = backoffDelayMs(SCOPE_PROPAGATION, 1, () => 0.999999);
  assert.ok(hi < 34.5 * MIN && hi > 34.49 * MIN, `Oberkante: ${hi / MIN}`);
});

// ---------------------------------------------------------------------------------------------------
// Fehlerklassifikation
// ---------------------------------------------------------------------------------------------------
const err403 = (code: string, message = "Access is denied.") => ({ status: 403, retryAfter: null, body: JSON.stringify({ error: { code, message } }) });

test("403 ErrorAccessDenied 10 min nach Provisionierung → Retry in 30 min", () => {
  const d = classifyGraphError(err403("ErrorAccessDenied"), { now: new Date(T0.getTime() + 10 * MIN), grantedAt: T0, attempts: {}, random: noJitter });
  assert.equal(d.action, "retry");
  assert.equal(d.action === "retry" && d.category, "scope_propagation");
  assert.equal(d.action === "retry" && d.delayMs, 30 * MIN);
});

test("403 'Access to OData is disabled' nach 3 Versuchen → 240 min", () => {
  const d = classifyGraphError(err403("", "Access to OData is disabled."), {
    now: new Date(T0.getTime() + 3.5 * 60 * MIN), grantedAt: T0, attempts: { scope_propagation: 3 }, random: noJitter,
  });
  assert.equal(d.action === "retry" && d.delayMs, 240 * MIN);
});

test("403 nach Ablauf des Propagation-Fensters → blocked_scope + Alarm", () => {
  const d = classifyGraphError(err403("ErrorAccessDenied"), { now: new Date(T0.getTime() + 9 * 60 * MIN), grantedAt: T0, attempts: { scope_propagation: 5 } });
  assert.deepEqual([d.action, d.action === "fail" && d.category], ["fail", "blocked_scope"]);
});

test("403 Authorization_RequestDenied → sofort config_error, kein Warten", () => {
  const d = classifyGraphError(err403("Authorization_RequestDenied", "Insufficient privileges to complete the operation."), { now: T0, grantedAt: T0, attempts: {} });
  assert.deepEqual([d.action, d.action === "fail" && d.category], ["fail", "config"]);
});

test("404 MailboxNotEnabledForRESTAPI kurz nach Lizenzzuweisung → Propagation-Retry", () => {
  const d = classifyGraphError({ status: 404, retryAfter: null, body: JSON.stringify({ error: { code: "MailboxNotEnabledForRESTAPI", message: "The mailbox is either inactive, soft-deleted, or is hosted on-premise." } }) },
    { now: new Date(T0.getTime() + 5 * MIN), grantedAt: T0, attempts: {}, random: noJitter });
  assert.equal(d.action === "retry" && d.category, "scope_propagation");
});

test("429 mit Retry-After 120 → mindestens 120 s", () => {
  const d = classifyGraphError({ status: 429, retryAfter: "120", body: "" }, { now: T0, grantedAt: T0, attempts: {}, random: lowEdge });
  assert.equal(d.action === "retry" && d.category, "transient");
  assert.equal(d.action === "retry" && d.delayMs, 120_000);
});

test("handleHandshakeFailure: Retry stellt Job zurück, zählt Kategorie hoch, Pipeline pending_scope", async () => {
  const calls: string[] = [];
  let saved: HandshakePayload | null = null;
  const job = { id: "j1", tenantId: "acme", payload: { pipelineId: "p1", userId: "u1", grantedAt: T0.toISOString(), attempts: {} } as HandshakePayload };
  const d = await handleHandshakeFailure(job, err403("ErrorAccessDenied"), {
    reschedule: async (_id, delay, payload) => { calls.push(`reschedule:${delay / MIN}`); saved = payload; return true; },
    failJob: async () => { calls.push("fail"); return true; },
    setPipelineStatus: async (_t, _p, s) => { calls.push(`status:${s}`); },
    alert: async () => { calls.push("alert"); },
  }, new Date(T0.getTime() + MIN), noJitter);
  assert.equal(d.action, "retry");
  assert.deepEqual(calls, ["reschedule:30", "status:pending_scope"]);
  assert.deepEqual(saved!.attempts, { scope_propagation: 1 });
});

// ---------------------------------------------------------------------------------------------------
// Handshake-Worker: 403 blockiert keine anderen Pipelines
// ---------------------------------------------------------------------------------------------------
test("Worker: frischer User bekommt 403, anderer User wird im selben Tick aktiviert", async () => {
  let now = T0.getTime();
  const queue = new InMemoryDelayedJobQueue(() => now);
  const targets: Record<string, HandshakeTarget> = {
    pNew: { status: "pending", ownerActive: true, hasLiveChannel: false, entraObjectId: "oid-new" },
    pOld: { status: "pending", ownerActive: true, hasLiveChannel: false, entraObjectId: "oid-old" },
  };
  const activated: string[] = [];
  const statuses: string[] = [];
  let replicated = false;
  const { fetchFn, calls } = fakeFetch((c) => {
    const body = JSON.parse(c.body ?? "{}") as { resource?: string };
    if (body.resource === "users/oid-new/events" && !replicated) return err403("ErrorAccessDenied");
    return { status: 201, body: JSON.stringify({ id: "sub-old", expirationDateTime: "2026-10-07T08:00:00Z" }) };
  });
  const w = new HandshakeWorker({
    queue, fetchFn, tokens: tokens(), workerId: "w1", random: noJitter, now: () => new Date(now),
    notificationUrl: "https://acme.calensync.de/webhooks/graph", lifecycleNotificationUrl: "https://acme.calensync.de/webhooks/graph/lifecycle",
    pipelines: {
      getHandshakeTarget: async (_t, id) => targets[id] ?? null,
      activateWithChannel: async (_t, id) => { activated.push(id); targets[id].hasLiveChannel = true; },
    },
    sinks: { setPipelineStatus: async (_t, id, s) => { statuses.push(`${id}:${s}`); }, alert: async () => {} },
  });
  for (const id of ["pNew", "pOld"]) {
    await queue.enqueue("acme", HANDSHAKE_KIND, { pipelineId: id, userId: `u-${id}`, grantedAt: T0.toISOString(), attempts: {} }, { dedupeKey: `handshake:${id}` });
  }

  const r1 = await w.tick();
  assert.deepEqual({ a: r1.activated, r: r1.rescheduled }, { a: 1, r: 1 });
  assert.deepEqual(activated, ["pOld"]);
  assert.deepEqual(statuses, ["pNew:pending_scope"]);
  assert.equal(calls.filter((c) => c.method === "POST").length, 2);

  // 29 min später: noch nichts fällig
  now += 29 * MIN;
  assert.equal((await w.tick()).claimed, 0);

  // 31 min: Exchange repliziert noch → zweiter Retry in 60 min
  now += 2 * MIN;
  const r2 = await w.tick();
  assert.equal(r2.rescheduled, 1);
  const row = [...queue.rows.values()].find((j) => (j.payload as HandshakePayload).pipelineId === "pNew")!;
  assert.equal(row.runAt.getTime() - now, 60 * MIN);

  // 60 min später ist der Scope repliziert → Aktivierung
  now += 60 * MIN;
  replicated = true;
  const r3 = await w.tick();
  assert.equal(r3.activated, 1);
  assert.deepEqual(activated, ["pOld", "pNew"]);
});

test("Worker: revoked Pipeline wird nie durch alten Retry wiederbelebt", async () => {
  const queue = new InMemoryDelayedJobQueue(() => T0.getTime());
  const { fetchFn, calls } = fakeFetch(() => ({ status: 201, body: "{}" }));
  const w = new HandshakeWorker({
    queue, fetchFn, tokens: tokens(), workerId: "w1",
    notificationUrl: "https://x/n", lifecycleNotificationUrl: "https://x/l",
    pipelines: { getHandshakeTarget: async () => ({ status: "revoked", ownerActive: false, hasLiveChannel: false, entraObjectId: "o" }), activateWithChannel: async () => { throw new Error("darf nicht passieren"); } },
    sinks: { setPipelineStatus: async () => {}, alert: async () => {} },
  });
  await queue.enqueue("acme", HANDSHAKE_KIND, { pipelineId: "p", userId: "u", grantedAt: null, attempts: {} });
  const r = await w.tick();
  assert.equal(r.dropped, 1);
  assert.equal(calls.length, 0);
});

test("Worker: DB-Fehler nach erfolgreichem Graph-POST → Abo wird wieder gelöscht (keine Waise)", async () => {
  const queue = new InMemoryDelayedJobQueue(() => T0.getTime());
  const { fetchFn, calls } = fakeFetch((c) => (c.method === "POST" ? { status: 201, body: JSON.stringify({ id: "sub-x" }) } : { status: 204 }));
  const w = new HandshakeWorker({
    queue, fetchFn, tokens: tokens(), workerId: "w1", random: noJitter, now: () => T0,
    notificationUrl: "https://x/n", lifecycleNotificationUrl: "https://x/l",
    pipelines: { getHandshakeTarget: async () => ({ status: "pending", ownerActive: true, hasLiveChannel: false, entraObjectId: "o" }), activateWithChannel: async () => { throw new Error("unique violation webhook_channels_one_live"); } },
    sinks: { setPipelineStatus: async () => {}, alert: async () => {} },
  });
  await queue.enqueue("acme", HANDSHAKE_KIND, { pipelineId: "p", userId: "u", grantedAt: T0.toISOString(), attempts: {} });
  const r = await w.tick();
  assert.equal(r.rescheduled, 1);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    "POST https://graph.microsoft.com/v1.0/subscriptions",
    "DELETE https://graph.microsoft.com/v1.0/subscriptions/sub-x",
  ]);
});

// ---------------------------------------------------------------------------------------------------
// Teardown
// ---------------------------------------------------------------------------------------------------
test("Teardown: DELETE an graph.microsoft.com/v1.0/subscriptions/{id}, 204 → stopped", async () => {
  const repo = new MemChannels([channel()]);
  const { fetchFn, calls } = fakeFetch(() => ({ status: 204 }));
  const r = await new SubscriptionTeardown({ channels: repo, tokens: tokens(), fetchFn, now: () => T0 }).terminateForUser("acme", "u-1");
  assert.equal(r.stopped, 1);
  assert.equal(calls[0].method, "DELETE");
  assert.equal(calls[0].url, "https://graph.microsoft.com/v1.0/subscriptions/sub-1");
  assert.match(calls[0].headers.Authorization, /^Bearer tok-/);
  assert.equal(repo.rows[0].stoppedAt, T0.toISOString());
});

test("Teardown: 404 zählt als erledigt, Google ruft channels.stop mit resourceId", async () => {
  const repo = new MemChannels([
    channel({ id: "a", providerSubscriptionId: "gone" }),
    channel({ id: "b", provider: "google", providerSubscriptionId: "gch", providerResourceId: "res-9" }),
  ]);
  const { fetchFn, calls } = fakeFetch((c) => (c.url.includes("googleapis") ? { status: 204 } : { status: 404 }));
  const r = await new SubscriptionTeardown({ channels: repo, tokens: tokens(), fetchFn, now: () => T0 }).terminateForUser("acme", "u-1");
  assert.deepEqual({ s: r.stopped, g: r.alreadyGone }, { s: 1, g: 1 });
  const g = calls.find((c) => c.url.includes("googleapis"))!;
  assert.equal(g.url, "https://www.googleapis.com/calendar/v3/channels/stop");
  assert.deepEqual(JSON.parse(g.body!), { id: "gch", resourceId: "res-9" });
});

test("Teardown: 401 → Token verwerfen, sofort ein zweiter Versuch", async () => {
  const repo = new MemChannels([channel()]);
  let n = 0;
  const { fetchFn } = fakeFetch(() => (++n === 1 ? { status: 401 } : { status: 204 }));
  const t = tokens();
  const r = await new SubscriptionTeardown({ channels: repo, tokens: t, fetchFn, now: () => T0 }).terminateForUser("acme", "u-1");
  assert.equal(r.stopped, 1);
  assert.equal(t.invalidated, 1);
});

test("Teardown: Graph hängt → Budget greift, Retry geplant, kein Throw", async () => {
  const repo = new MemChannels([channel()]);
  const { fetchFn } = fakeFetch(() => "hang");
  const started = Date.now();
  const r = await new SubscriptionTeardown({ channels: repo, tokens: tokens(), fetchFn, now: () => T0, random: noJitter }).terminateForUser("acme", "u-1", 150);
  assert.ok(Date.now() - started < 2_000);
  assert.equal(r.timedOut, true);
  assert.equal(r.retryScheduled, 1);
  assert.equal(repo.rows[0].stopAttempts, 1);
  assert.equal(repo.rows[0].nextStopAttemptAt, new Date(T0.getTime() + 30_000).toISOString());
});

test("Teardown: 503 mit Retry-After 600 → nächster Versuch frühestens in 10 min; Worker holt ihn dann", async () => {
  const repo = new MemChannels([channel()]);
  let now = T0.getTime();
  let up = false;
  const { fetchFn } = fakeFetch(() => (up ? { status: 204 } : { status: 503, headers: { "Retry-After": "600" } }));
  const td = new SubscriptionTeardown({ channels: repo, tokens: tokens(), fetchFn, now: () => new Date(now), random: lowEdge });
  await td.terminateForUser("acme", "u-1");
  assert.equal(repo.rows[0].nextStopAttemptAt, new Date(now + 600_000).toISOString());
  now += 5 * MIN;
  assert.equal((await td.runDueStops()).channels, 0);
  now += 6 * MIN;
  up = true;
  assert.equal((await td.runDueStops()).stopped, 1);
});

test("Teardown: abgelaufenes Abo → expired, kein Provider-Aufruf", async () => {
  const repo = new MemChannels([channel({ expiresAt: "2026-09-30T00:00:00Z" })]);
  const { fetchFn, calls } = fakeFetch(() => ({ status: 500 }));
  const r = await new SubscriptionTeardown({ channels: repo, tokens: tokens(), fetchFn, now: () => T0 }).terminateForUser("acme", "u-1");
  assert.equal(r.stopped, 1);
  assert.equal(calls.length, 0);
  assert.deepEqual(repo.log, ["stopped:ch-1:expired"]);
});

// ---------------------------------------------------------------------------------------------------
// Webhook-Guard
// ---------------------------------------------------------------------------------------------------
function guardSetup(ch: Partial<GuardChannel>) {
  const queue = new InMemoryDelayedJobQueue(() => T0.getTime());
  const sec: string[] = [];
  const full: GuardChannel = { ...channel({ stopRequestedAt: null }), pipelineId: "p1", pipelineStatus: "active", ...ch };
  const deps = {
    queue,
    repo: {
      lookups: 0,
      async findBySubscriptionIds(ids: readonly string[]) {
        this.lookups += 1;
        const m = new Map<string, GuardChannel>();
        for (const id of ids) if (id === full.providerSubscriptionId) m.set(id, full);
        return m;
      },
      markStoppedMany: async () => {},
    },
    securityEvent: (e: { kind: string }) => sec.push(e.kind),
    now: () => T0,
  };
  return { queue, sec, deps };
}
const note = (over: Record<string, unknown> = {}) => ({ value: [{ subscriptionId: "sub-1", clientState: "cs-secret", changeType: "updated", ...over }] });

test("Guard: validationToken wird als text/plain zurückgegeben", async () => {
  const { deps } = guardSetup({});
  const r = await handleGraphWebhook({ query: { validationToken: "abc 123" }, body: null }, deps);
  assert.deepEqual([r.status, r.contentType, r.body], [200, "text/plain", "abc 123"]);
});

test("Guard: aktive Pipeline → 202 + ein Delta-Job, Burst wird gebündelt", async () => {
  const { deps, queue } = guardSetup({});
  for (let i = 0; i < 5; i++) assert.equal((await handleGraphWebhook({ query: {}, body: note() }, deps)).status, 202);
  const jobs = [...queue.rows.values()].filter((j) => j.kind === "pipeline.delta_sync");
  assert.equal(jobs.length, 1);
});

test("Guard: Channel mit stop_requested → verworfen, Stop-Job eingestellt, kein Sync", async () => {
  const { deps, queue } = guardSetup({ stopRequestedAt: T0.toISOString(), pipelineStatus: "revoked" });
  const r = await handleGraphWebhook({ query: {}, body: note() }, deps);
  assert.equal(r.status, 202);
  assert.equal(r.stats.reasons.channel_stopped_or_revoked, 1);
  assert.deepEqual([...queue.rows.values()].map((j) => [j.kind, j.dedupeKey]), [["subscription.teardown", "teardown:u-1"]]);
});

test("Guard: falscher clientState → verworfen + Sicherheitsereignis", async () => {
  const { deps, queue, sec } = guardSetup({});
  const r = await handleGraphWebhook({ query: {}, body: note({ clientState: "geraten" }) }, deps);
  assert.equal(r.stats.reasons.client_state_mismatch, 1);
  assert.deepEqual(sec, ["client_state_mismatch"]);
  assert.equal(queue.rows.size, 0);
});

test("Guard: lifecycle 'missed' → voller Delta-Resync", async () => {
  const { deps, queue } = guardSetup({});
  await handleGraphWebhook({ query: {}, body: note({ lifecycleEvent: "missed" }) }, deps);
  const j = [...queue.rows.values()][0];
  assert.equal(j.kind, "pipeline.delta_sync");
  assert.deepEqual(j.payload, { pipelineId: "p1", full: true });
});

test("Guard: 50 Notifications in einem Request → genau 1 Lookup + 1 Enqueue, missed schlägt Delta", async () => {
  const { deps, queue } = guardSetup({});
  const value = Array.from({ length: 50 }, (_, i) => ({ subscriptionId: i % 10 === 9 ? `unbekannt-${i}` : "sub-1", clientState: "cs-secret",
    ...(i === 7 ? { lifecycleEvent: "missed" } : {}) }));
  const r = await handleGraphWebhook({ query: {}, body: { value } }, deps);
  assert.equal(r.status, 202);
  assert.deepEqual([r.stats.accepted, r.stats.reasons.unknown_subscription, r.stats.dbRoundtrips, r.stats.jobsQueued], [45, 5, 2, 1]);
  assert.equal(deps.repo.lookups, 1);
  const jobs = [...queue.rows.values()];
  assert.deepEqual(jobs.map((j) => j.payload), [{ pipelineId: "p1", full: true }]);
});

test("Guard: Datenbank langsamer als das Budget → 503 (Graph stellt erneut zu), kein Hängen", async () => {
  const { deps } = guardSetup({});
  const slow = { ...deps, budgetMs: 50, repo: { ...deps.repo, findBySubscriptionIds: () => new Promise<Map<string, GuardChannel>>((r) => setTimeout(() => r(new Map()), 500)) } };
  const t0 = Date.now();
  const r = await handleGraphWebhook({ query: {}, body: note() }, slow);
  assert.equal(r.status, 503);
  assert.ok(Date.now() - t0 < 300);
});

test("Guard: DB-Fehler → 503 statt 202 (nichts quittiert, was nicht gespeichert ist)", async () => {
  const { deps } = guardSetup({});
  const broken = { ...deps, queue: { enqueueMany: async () => { throw new Error("connection terminated"); } } };
  assert.equal((await handleGraphWebhook({ query: {}, body: note() }, broken)).status, 503);
});

test("Guard: mehr als maxNotifications → 413", async () => {
  const { deps } = guardSetup({});
  const r = await handleGraphWebhook({ query: {}, body: { value: new Array(3).fill({ subscriptionId: "sub-1" }) } }, { ...deps, maxNotifications: 2 });
  assert.equal(r.status, 413);
});

