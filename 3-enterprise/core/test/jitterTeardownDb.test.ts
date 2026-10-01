import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SCOPE_PROPAGATION,
  backoffDelayMs,
  classifyGraphError,
  enqueueDelayMs,
  createIamPgPool,
  IAM_TOKEN_TTL_SECONDS,
  iamDbSettingsFromEnv,
  iamPoolConfig,
  InMemoryDelayedJobQueue,
  respectRetryAfter,
  TEARDOWN_JOB_KIND,
  TeardownJobWorker,
  type TeardownAuditEvent,
  type TeardownJobPayload,
  type WebhookChannel,
} from "../src/index.js";

const MIN = 60_000;
const T0 = Date.parse("2026-10-01T00:00:00Z");

/** Deterministischer PRNG (mulberry32), damit die Verteilungstests reproduzierbar sind */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------------------------------
// Jitter gegen Onboarding-Wellen
// ---------------------------------------------------------------------------------------------------
test("Massen-Onboarding: 50 gleichzeitige 403 → Retries über ≥ 7 min verteilt, alle im Band 25,5–34,5 min", () => {
  const random = rng(1);
  const err = { status: 403, retryAfter: null, body: JSON.stringify({ error: { code: "ErrorAccessDenied", message: "Access is denied." } }) };
  const delays = Array.from({ length: 50 }, () => {
    const d = classifyGraphError(err, { now: new Date(T0 + MIN), grantedAt: new Date(T0), attempts: {}, random });
    assert.equal(d.action, "retry");
    return d.action === "retry" ? d.delayMs : 0;
  });
  const min = Math.min(...delays), max = Math.max(...delays);
  assert.ok(min >= 25.5 * MIN && max < 34.5 * MIN, `außerhalb ±15 %: ${min / MIN}–${max / MIN}`);
  assert.ok(max - min >= 7 * MIN, `Spreizung zu klein: ${(max - min) / MIN} min`);
  // Ohne Jitter landen alle 50 in derselben Minute; mit Jitter höchstens eine Handvoll pro Minute
  const perMinute = new Map<number, number>();
  for (const d of delays) perMinute.set(Math.floor(d / MIN), (perMinute.get(Math.floor(d / MIN)) ?? 0) + 1);
  const peak = Math.max(...perMinute.values());
  assert.ok(peak <= 12, `Spitze ${peak} Retries in einer Minute`);
});

test("Wellen sammeln sich nicht wieder: Spreizung wächst über die Runden", () => {
  const random = rng(7);
  let t = new Array(50).fill(0);
  const spread: number[] = [];
  for (let attempt = 1; attempt <= 4; attempt++) {
    t = t.map((x) => x + backoffDelayMs(SCOPE_PROPAGATION, attempt, random));
    spread.push((Math.max(...t) - Math.min(...t)) / MIN);
  }
  assert.ok(spread[3] > spread[0], `Runde 1: ${spread[0]} min, Runde 4: ${spread[3]} min`);
});

test("Retry-After wird nie unterschritten, gleiche Werte werden nach oben gestreut", () => {
  const random = rng(3);
  const v = Array.from({ length: 20 }, () => respectRetryAfter(120_000, 15_000, random));
  assert.ok(v.every((x) => x >= 120_000 && x < 138_000));
  assert.ok(new Set(v).size > 15);
});

test("enqueue({ spreadMs }) verteilt Erstversuche gleichmäßig", async () => {
  const random = rng(11);
  const q = new InMemoryDelayedJobQueue(() => T0, random);
  for (let i = 0; i < 50; i++) await q.enqueue("acme", "pipeline.handshake", { i }, { spreadMs: 2 * MIN });
  const at = [...q.rows.values()].map((j) => j.runAt.getTime() - T0);
  assert.ok(Math.min(...at) >= 0 && Math.max(...at) < 2 * MIN);
  assert.equal(enqueueDelayMs({ delayMs: 1000, spreadMs: 0 }), 1000);
});

// ---------------------------------------------------------------------------------------------------
// Teardown-Worker
// ---------------------------------------------------------------------------------------------------
function ch(over: Partial<WebhookChannel> = {}): WebhookChannel {
  return {
    id: "c1", tenantId: "acme", userId: "u1", provider: "microsoft", providerSubscriptionId: "s1", providerResourceId: null,
    clientState: "x", expiresAt: null, stopRequestedAt: new Date(T0).toISOString(), stoppedAt: null, stopAttempts: 0,
    nextStopAttemptAt: null, lastStopError: null, ...over,
  };
}

function setup(opts: { stopSucceeds: boolean[]; maxWaitMs?: number }) {
  let now = T0;
  const channels = [ch()];
  const queue = new InMemoryDelayedJobQueue(() => now, () => 0.5);
  const audits: TeardownAuditEvent[] = [];
  const alerts: string[] = [];
  const purged: string[] = [];
  let call = 0;
  const worker = new TeardownJobWorker({
    queue,
    workerId: "w1",
    now: () => new Date(now),
    random: () => 0.5,
    maxWaitMs: opts.maxWaitMs,
    channels: { listOpenForUser: async () => channels.filter((c) => !c.stoppedAt) },
    teardown: {
      terminateForUser: async () => {
        const ok = opts.stopSucceeds[call++] ?? false;
        if (ok) channels[0].stoppedAt = new Date(now).toISOString();
        return { channels: 1, stopped: ok ? 1 : 0, alreadyGone: 0, retryScheduled: ok ? 0 : 1, failed: 0, timedOut: !ok,
          details: [{ channelId: "c1", provider: "microsoft", status: ok ? "stopped" : "retry_scheduled", reason: ok ? undefined : "HTTP 503" }] };
      },
    },
    users: { purgeDeletedUser: async (_t, u) => { purged.push(u); return true; } },
    audit: async (e) => { audits.push(e); },
    alert: async (e) => { alerts.push(e.kind); },
  });
  const advance = (ms: number) => { now += ms; };
  return { worker, queue, audits, alerts, purged, advance };
}

const payload = (purgeUser: boolean): TeardownJobPayload => ({ userId: "u1", purgeUser, requestedAt: new Date(T0).toISOString() });

test("Teardown-Job: Microsoft down → Job mit Backoff zurück, User bleibt; danach Erfolg → Purge", async () => {
  const s = setup({ stopSucceeds: [false, true] });
  await s.queue.enqueue("acme", TEARDOWN_JOB_KIND, payload(true), { dedupeKey: "purge:u1" });

  const r1 = await s.worker.tick();
  assert.equal(r1.rescheduled, 1);
  assert.deepEqual(s.purged, [], "Datensatz fällt erst nach Erfolg");
  const job = [...s.queue.rows.values()][0];
  assert.equal(job.runAt.getTime() - T0, 30_000, "1. Retry nominal 30 s");
  assert.match(job.lastError ?? "", /1 Abo\(s\) offen: HTTP 503/);

  s.advance(31_000);
  const r2 = await s.worker.tick();
  assert.equal(r2.purged, 1);
  assert.deepEqual(s.purged, ["u1"]);
  assert.deepEqual(s.audits.map((a) => [a.action, a.outcome]), [["scim.user.subscriptions_terminated", "success"], ["scim.user.purged", "success"]]);
  assert.equal(job.status, "done");
});

test("Teardown-Job ohne purgeUser (Deaktivierung): stoppt Abos, löscht nichts", async () => {
  const s = setup({ stopSucceeds: [true] });
  await s.queue.enqueue("acme", TEARDOWN_JOB_KIND, payload(false), { dedupeKey: "teardown:u1" });
  const r = await s.worker.tick();
  assert.equal(r.completed, 1);
  assert.deepEqual(s.purged, []);
});

test("Teardown-Job: Notbremse nach maxWait → Purge + Alarm, kein Endlos-Retry", async () => {
  const s = setup({ stopSucceeds: [false, false], maxWaitMs: 60 * MIN });
  await s.queue.enqueue("acme", TEARDOWN_JOB_KIND, payload(true));
  await s.worker.tick();
  s.advance(61 * MIN);
  const r = await s.worker.tick();
  assert.equal(r.deadline_purged, 1);
  assert.deepEqual(s.alerts, ["teardown_deadline"]);
  assert.deepEqual(s.purged, ["u1"]);
});

// ---------------------------------------------------------------------------------------------------
// IAM-Datenbank-Authentifizierung
// ---------------------------------------------------------------------------------------------------
const CA = "-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n";

test("IAM-Pool: jedes Connect holt ein frisches Token, TLS mit Hostname-Prüfung, kein statisches Passwort", async () => {
  let n = 0;
  const cfg = iamPoolConfig(
    { host: "acme-aurora.cluster-abc.eu-central-1.rds.amazonaws.com", port: 5432, database: "calensync", user: "calensync_app", region: "eu-central-1", caPem: CA },
    { getAuthToken: async () => `token-${++n}` },
  );
  assert.equal(typeof cfg.password, "function");
  assert.equal(await cfg.password(), "token-1");
  assert.equal(await cfg.password(), "token-2");
  assert.deepEqual([cfg.ssl.rejectUnauthorized, cfg.ssl.servername], [true, "acme-aurora.cluster-abc.eu-central-1.rds.amazonaws.com"]);
});

test("IAM-Settings: Start bricht ab bei statischem Passwort oder fehlender IAM-Auth", async () => {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  const caFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "ca-")), "ca.pem");
  fs.writeFileSync(caFile, CA);
  const base = { DB_IAM_AUTH: "true", DB_HOST: "h", DB_NAME: "calensync", DB_USER: "calensync_app", AWS_REGION: "eu-central-1", DB_CA_BUNDLE: caFile };
  assert.equal(iamDbSettingsFromEnv(base).port, 5432);
  assert.throws(() => iamDbSettingsFromEnv({ ...base, DB_PASSWORD: "x" }), /Statisches DB-Passwort/);
  assert.throws(() => iamDbSettingsFromEnv({ ...base, DATABASE_URL: "postgres://app:geheim@h/db" }), /Statisches DB-Passwort/);
  assert.equal(iamDbSettingsFromEnv({ ...base, DATABASE_URL: "postgres://app@h/db" }).user, "calensync_app");
  assert.throws(() => iamDbSettingsFromEnv({ ...base, DB_IAM_AUTH: "false" }), /DB_IAM_AUTH/);
});

test("IAM-Pool: harte Grenzen – Lebensdauer 600 s (< 900 s Token-TTL), max 20, Leerlauf 30 s", () => {
  const cfg = iamPoolConfig(
    { host: "h", port: 5432, database: "calensync", user: "calensync_app", region: "eu-central-1", caPem: CA, max: 50 },
    { getAuthToken: async () => "t" },
  );
  assert.deepEqual([cfg.maxLifetimeSeconds, cfg.max, cfg.idleTimeoutMillis, cfg.connectionTimeoutMillis], [600, 20, 30_000, 5_000]);
  assert.ok(cfg.maxLifetimeSeconds < IAM_TOKEN_TTL_SECONDS);
});

test("createIamPgPool: 'error'-Listener ist immer angehängt (kein Prozessabsturz bei Failover)", () => {
  const listeners: Array<(e: Error) => void> = [];
  const logged: string[] = [];
  class FakePool {
    constructor(readonly config: unknown) {}
    on(_ev: "error", l: (e: Error) => void) { listeners.push(l); return this; }
    async end() {}
  }
  const pool = createIamPgPool(FakePool, { host: "h", port: 5432, database: "d", user: "u", region: "eu-central-1", caPem: CA },
    (m, e) => logged.push(`${m}: ${e?.message}`), { getAuthToken: async () => "t" });
  assert.equal(listeners.length, 1);
  listeners[0](new Error("terminating connection due to administrator command"));
  assert.match(logged[0], /administrator command/);
  assert.equal((pool.config as { maxLifetimeSeconds: number }).maxLifetimeSeconds, 600);
});
