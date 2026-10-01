/**
 * Integrationstests gegen echtes PostgreSQL (≥ 14). Ohne DATABASE_URL werden sie übersprungen.
 *   DATABASE_URL=postgres://qa:qa@localhost:5432/coreq npm run test:pg
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import { PgChannelRepo, PgDelayedJobQueue, PgPipelineRepo, RENEW_KIND } from "../src/index.js";

const url = process.env.DATABASE_URL;
const skip = !url;
const pool = url ? new pg.Pool({ connectionString: url, max: 4 }) : (null as unknown as pg.Pool);
const MIN = 60_000;

const DDL = `
DROP TABLE IF EXISTS job_queue, webhook_channels, pipelines;
CREATE TABLE job_queue (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL, kind text NOT NULL, dedupe_key text, payload jsonb NOT NULL,
  run_at timestamptz NOT NULL DEFAULT now(), attempts int NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
  locked_by text, locked_until timestamptz, last_error text,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX job_queue_queued_dedupe ON job_queue (kind, dedupe_key) WHERE status = 'queued';
CREATE INDEX job_queue_due ON job_queue (run_at) WHERE status = 'queued';
CREATE TABLE pipelines (id text PRIMARY KEY, tenant_id text NOT NULL, status text NOT NULL);
CREATE TABLE webhook_channels (
  id text PRIMARY KEY, tenant_id text NOT NULL, user_id text NOT NULL, pipeline_id text NOT NULL,
  provider text NOT NULL, provider_subscription_id text NOT NULL, provider_resource_id text,
  client_state text, expires_at timestamptz,
  stop_requested_at timestamptz, stopped_at timestamptz, stop_note text,
  stop_attempts int NOT NULL DEFAULT 0, next_stop_attempt_at timestamptz, last_stop_error text);
CREATE UNIQUE INDEX webhook_channels_sub ON webhook_channels (provider, provider_subscription_id);
CREATE UNIQUE INDEX webhook_channels_one_live ON webhook_channels (pipeline_id) WHERE stop_requested_at IS NULL AND stopped_at IS NULL;
`;

before(async () => { if (!skip) await pool.query(DDL); });
after(async () => { if (!skip) await pool.end(); });

test("Queue: 30-min-Delay wird mit DB-Uhr gesetzt und erst danach geclaimt", { skip }, async () => {
  const q = new PgDelayedJobQueue(pool);
  const id = await q.enqueue("acme", "pipeline.handshake", { pipelineId: "p1" }, { delayMs: 30 * MIN, dedupeKey: "handshake:p1" });
  assert.ok(id);
  assert.equal((await q.claimDue("w1", 10, 60_000)).length, 0);
  const { rows } = await pool.query("SELECT round(extract(epoch FROM run_at - now()) / 60) AS m FROM job_queue WHERE id = $1", [id]);
  assert.equal(Number(rows[0].m), 30);
  await pool.query("UPDATE job_queue SET run_at = now() - interval '1 second' WHERE id = $1", [id]);
  const claimed = await q.claimDue("w1", 10, 60_000);
  assert.deepEqual(claimed.map((j) => [j.id, j.attempts, (j.payload as { pipelineId: string }).pipelineId]), [[id, 1, "p1"]]);
});

test("Queue: dedupeKey – max. ein wartender Job, laufender blockiert keinen neuen", { skip }, async () => {
  await pool.query("TRUNCATE job_queue");
  const q = new PgDelayedJobQueue(pool);
  assert.ok(await q.enqueue("acme", "pipeline.delta_sync", {}, { dedupeKey: "delta:p1" }));
  assert.equal(await q.enqueue("acme", "pipeline.delta_sync", {}, { dedupeKey: "delta:p1" }), null);
  const [running] = await q.claimDue("w1", 1, 60_000);
  assert.ok(running);
  assert.ok(await q.enqueue("acme", "pipeline.delta_sync", {}, { dedupeKey: "delta:p1" }), "neuer wartender Job trotz laufendem");
});

test("Queue: SKIP LOCKED – zwei Worker claimen disjunkte Jobs", { skip }, async () => {
  await pool.query("TRUNCATE job_queue");
  const q = new PgDelayedJobQueue(pool);
  for (let i = 0; i < 20; i++) await q.enqueue("acme", "pipeline.handshake", { i });
  const [a, b] = await Promise.all([q.claimDue("wA", 15, 60_000), q.claimDue("wB", 15, 60_000)]);
  const ids = new Set([...a, ...b].map((j) => j.id));
  assert.equal(ids.size, a.length + b.length, "kein Job doppelt");
  assert.equal(ids.size, 20);
});

test("Queue: reschedule/complete nur durch den Lease-Halter; abgelaufene Lease wird neu vergeben", { skip }, async () => {
  await pool.query("TRUNCATE job_queue");
  const q = new PgDelayedJobQueue(pool);
  await q.enqueue("acme", "pipeline.handshake", { p: 1 });
  const [j] = await q.claimDue("wA", 1, 60_000);
  assert.equal(await q.complete(j.id, "wB"), false, "fremder Worker darf nicht abschließen");
  // Task stirbt beim Deployment: Lease abgelaufen
  await pool.query("UPDATE job_queue SET locked_until = now() - interval '1 second' WHERE id = $1", [j.id]);
  const [again] = await q.claimDue("wB", 1, 60_000);
  assert.equal(again.id, j.id);
  assert.equal(again.attempts, 2);
  assert.equal(await q.reschedule(j.id, "wA", 30 * MIN, { p: 1 }, "late"), false, "alter Halter ist raus");
  assert.equal(await q.reschedule(j.id, "wB", 30 * MIN, { p: 1, attempts: { scope_propagation: 1 } }, "HTTP 403 ErrorAccessDenied"), true);
  const { rows } = await pool.query("SELECT status, payload, last_error FROM job_queue WHERE id = $1", [j.id]);
  assert.equal(rows[0].status, "queued");
  assert.deepEqual(rows[0].payload, { p: 1, attempts: { scope_propagation: 1 } });
});

test("Channels: Stop-Claim mit Lease, Fehler planen Retry, Stop überlebt User-Löschung", { skip }, async () => {
  await pool.query("TRUNCATE webhook_channels, pipelines");
  await pool.query(`INSERT INTO pipelines VALUES ('p1','acme','revoked')`);
  await pool.query(`INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, client_state, stop_requested_at)
                    VALUES ('c1','acme','u1','p1','microsoft','sub-1','cs', now())`);
  const repo = new PgChannelRepo(pool);
  const now = new Date().toISOString();
  const first = await repo.claimDueStops(now, 10);
  assert.deepEqual(first.map((c) => c.id), ["c1"]);
  assert.equal((await repo.claimDueStops(now, 10)).length, 0, "Lease verhindert Doppel-Claim");
  await repo.recordStopFailure("c1", { attempts: 1, nextAttemptAtIso: new Date(Date.now() - 1000).toISOString(), error: "HTTP 503" });
  assert.equal((await repo.claimDueStops(new Date().toISOString(), 10)).length, 1);
  await repo.markStopped("c1", new Date().toISOString(), "stopped");
  assert.equal((await repo.listOpenForUser("acme", "u1")).length, 0);
  const g = await repo.findBySubscriptionId("sub-1");
  assert.equal(g?.pipelineStatus, "revoked");
  assert.ok(g?.stoppedAt);
});

test("enqueueMany: ein Statement, sortiert, Duplikate im Batch zusammengefasst, Jobs ohne Key bleiben einzeln", { skip }, async () => {
  await pool.query("TRUNCATE job_queue");
  const q = new PgDelayedJobQueue(pool);
  const n = await q.enqueueMany([
    { tenantId: "acme", kind: "pipeline.delta_sync", dedupeKey: "delta:p2", payload: { p: 2 } },
    { tenantId: "acme", kind: "pipeline.delta_sync", dedupeKey: "delta:p1", payload: { p: 1 } },
    { tenantId: "acme", kind: "pipeline.delta_sync", dedupeKey: "delta:p1", payload: { p: "dup" } },
    { tenantId: "acme", kind: "x", payload: { a: 1 } },
    { tenantId: "acme", kind: "x", payload: { a: 2 } },
  ]);
  assert.equal(n, 4);
  const { rows } = await pool.query("SELECT kind, dedupe_key, payload FROM job_queue ORDER BY kind, dedupe_key NULLS LAST, payload::text");
  assert.deepEqual(rows.map((r) => [r.kind, r.dedupe_key, r.payload]), [
    ["pipeline.delta_sync", "delta:p1", { p: 1 }],
    ["pipeline.delta_sync", "delta:p2", { p: 2 }],
    ["x", null, { a: 1 }],
    ["x", null, { a: 2 }],
  ]);
  assert.equal(await q.enqueueMany([{ tenantId: "acme", kind: "pipeline.delta_sync", dedupeKey: "delta:p1", payload: {} }]), 0, "wartender Job → nichts neu");
});

test("Channels: findBySubscriptionIds – ein Lookup für viele IDs", { skip }, async () => {
  const repo = new PgChannelRepo(pool);
  const m = await repo.findBySubscriptionIds(["sub-1", "gibt-es-nicht"]);
  assert.deepEqual([...m.keys()], ["sub-1"]);
  assert.equal(m.get("sub-1")?.pipelineStatus, "revoked");
});

test("PgPipelineRepo: Ziel lesen, Channel + Aktivierung atomar, zweiter lebender Channel scheitert", { skip }, async () => {
  await pool.query(`DROP TABLE IF EXISTS scim_users CASCADE`);
  await pool.query(`CREATE TABLE scim_users (id text PRIMARY KEY, tenant_id text NOT NULL, external_id text, active boolean NOT NULL DEFAULT true, deletion_requested_at timestamptz)`);
  await pool.query(`TRUNCATE webhook_channels, pipelines`);
  await pool.query(`INSERT INTO scim_users VALUES ('u7', 'acme', 'oid-7', true, NULL)`);
  await pool.query(`ALTER TABLE pipelines ADD COLUMN IF NOT EXISTS owner_user_id text`);
  await pool.query(`INSERT INTO pipelines (id, tenant_id, status, owner_user_id) VALUES ('p7', 'acme', 'pending', 'u7')`);
  const repo = new PgPipelineRepo(pool);
  assert.deepEqual(await repo.getHandshakeTarget("acme", "p7"), { status: "pending", ownerActive: true, hasLiveChannel: false, entraObjectId: "oid-7" });
  await repo.activateWithChannel("acme", "p7", { userId: "u7", providerSubscriptionId: "sub-77", clientState: "cs", expiresAt: "2026-10-07T00:00:00Z" });
  assert.deepEqual(await repo.getHandshakeTarget("acme", "p7"), { status: "active", ownerActive: true, hasLiveChannel: true, entraObjectId: "oid-7" });
  await assert.rejects(repo.activateWithChannel("acme", "p7", { userId: "u7", providerSubscriptionId: "sub-78", clientState: "cs", expiresAt: "2026-10-07T00:00:00Z" }));
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM webhook_channels WHERE pipeline_id = 'p7'");
  assert.equal(Number(rows[0].n), 1, "zweites Abo nicht gespeichert, Worker löscht es bei Graph wieder");
  await repo.setPipelineStatus("acme", "p7", "pending_scope");
  await pool.query(`UPDATE pipelines SET status = 'revoked' WHERE id = 'p7'`);
  await repo.setPipelineStatus("acme", "p7", "active");
  assert.equal((await repo.getHandshakeTarget("acme", "p7"))?.status, "revoked", "revoked bleibt revoked");
});

test("Google-Channel: Lookup, atomarer Accept mit Replay-Schutz, sync ohne Job, gestoppt = kein Fortschritt", { skip }, async () => {
  await pool.query(`ALTER TABLE webhook_channels ADD COLUMN IF NOT EXISTS last_message_number bigint`);
  await pool.query(`TRUNCATE job_queue`);
  await pool.query(`DELETE FROM webhook_channels WHERE id IN ('g1')`);
  await pool.query(`INSERT INTO pipelines (id, tenant_id, status) VALUES ('pg1', 'acme', 'active') ON CONFLICT (id) DO UPDATE SET status = 'active'`);
  await pool.query(`INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, provider_resource_id, client_state)
                    VALUES ('g1', 'acme', 'u1', 'pg1', 'google', 'gchan-1', 'gres-1', 'tok_${"a".repeat(39)}')`);
  const repo = new PgChannelRepo(pool);
  const ch = await repo.findGoogleChannel("gchan-1");
  assert.deepEqual([ch?.id, ch?.pipelineStatus, ch?.providerResourceId, ch?.lastMessageNumber], ["g1", "active", "gres-1", null]);
  assert.equal(await repo.findGoogleChannel("sub-1"), null, "Microsoft-Abo ist kein Google-Channel");

  const job = { kind: "pipeline.delta_sync", dedupeKey: "delta:pg1", payload: { pipelineId: "pg1", full: false } };
  assert.deepEqual(await repo.acceptGoogleNotification("g1", 1, "acme", null), { fresh: true, queued: false }, "sync");
  assert.deepEqual(await repo.acceptGoogleNotification("g1", 5, "acme", job), { fresh: true, queued: true });
  assert.deepEqual(await repo.acceptGoogleNotification("g1", 5, "acme", job), { fresh: false, queued: false }, "Replay");
  assert.deepEqual(await repo.acceptGoogleNotification("g1", 4, "acme", job), { fresh: false, queued: false }, "veraltet");
  assert.deepEqual(await repo.acceptGoogleNotification("g1", 9, "acme", job), { fresh: true, queued: false }, "wartender Job bündelt");
  await pool.query(`UPDATE webhook_channels SET stop_requested_at = now() WHERE id = 'g1'`);
  assert.deepEqual(await repo.acceptGoogleNotification("g1", 12, "acme", job), { fresh: false, queued: false }, "gestoppt");
  const { rows } = await pool.query(`SELECT last_message_number FROM webhook_channels WHERE id = 'g1'`);
  assert.equal(Number(rows[0].last_message_number), 9);
});

test("PgPipelineRepo: Aktivierung scheitert, wenn SCIM den User während des Graph-POST deaktiviert hat", { skip }, async () => {
  await pool.query(`TRUNCATE webhook_channels`);
  await pool.query(`INSERT INTO scim_users VALUES ('u8', 'acme', 'oid-8', true, NULL), ('u9', 'acme', 'oid-9', true, NULL) ON CONFLICT (id) DO UPDATE SET active = true`);
  await pool.query(`INSERT INTO pipelines (id, tenant_id, status, owner_user_id) VALUES ('p8', 'acme', 'pending', 'u8'), ('p9', 'acme', 'pending', 'u9')
                    ON CONFLICT (id) DO UPDATE SET status = 'pending'`);
  const repo = new PgPipelineRepo(pool);
  // Deaktivierung (wie revokeInTx): User inaktiv + Pipeline revoked im selben Commit
  await pool.query(`UPDATE scim_users SET active = false WHERE id = 'u8'`);
  await pool.query(`UPDATE pipelines SET status = 'revoked' WHERE id = 'p8'`);
  await assert.rejects(repo.activateWithChannel("acme", "p8", { userId: "u8", providerSubscriptionId: "sub-88", clientState: "cs", expiresAt: "2026-10-07T00:00:00Z" }), /nicht mehr aktivierbar/);
  // Nur der User inaktiv (Pipeline noch pending) → ebenfalls kein Channel
  await pool.query(`UPDATE scim_users SET active = false WHERE id = 'u9'`);
  await assert.rejects(repo.activateWithChannel("acme", "p9", { userId: "u9", providerSubscriptionId: "sub-99", clientState: "cs", expiresAt: "2026-10-07T00:00:00Z" }));
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM webhook_channels WHERE pipeline_id IN ('p8', 'p9')`);
  assert.equal(Number(rows[0].n), 0, "kein Channel für deaktivierte User – Worker löscht die Abos bei Graph");
});

test("Renewal-SQL: Scheduler wählt nur fällige, lebende, aktive Microsoft-Abos; Verlängern; 404-Neuanlage in einem Statement", { skip }, async () => {
  await pool.query(`ALTER TABLE webhook_channels ADD COLUMN IF NOT EXISTS last_renewed_at timestamptz,
                    ADD COLUMN IF NOT EXISTS renew_error text, ADD COLUMN IF NOT EXISTS renew_paused_until timestamptz`);
  await pool.query(`ALTER TABLE scim_users ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now()`);
  await pool.query(`TRUNCATE job_queue, webhook_channels`);
  await pool.query(`INSERT INTO scim_users (id, tenant_id, external_id, active) VALUES ('ur', 'acme', 'oid-r', true) ON CONFLICT (id) DO UPDATE SET active = true`);
  await pool.query(`INSERT INTO pipelines (id, tenant_id, status, owner_user_id) VALUES
      ('pr1','acme','active','ur'), ('pr2','acme','active','ur'), ('pr3','acme','revoked','ur'), ('pr4','acme','active','ur'),
      ('pr5','acme','active','ur'), ('pr6','acme','active','ur'), ('pr7','acme','active','ur')
    ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, owner_user_id = 'ur'`);
  const ch = (id: string, pid: string, provider: string, expiresIn: string, extra = "") =>
    pool.query(`INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, client_state, expires_at ${extra ? ", " + extra.split("=")[0] : ""})
                VALUES ('${id}', 'acme', 'ur', '${pid}', '${provider}', 'sub-${id}', 'cs', now() + interval '${expiresIn}' ${extra ? ", " + extra.split("=")[1] : ""})`);
  await ch("r1", "pr1", "microsoft", "2 hours");                                   // fällig
  await ch("r2", "pr2", "microsoft", "5 days");                                    // noch nicht fällig
  await ch("r3", "pr3", "microsoft", "2 hours");                                   // Pipeline revoked
  await ch("r4", "pr4", "google", "2 hours");                                      // Google: kein PATCH-Renewal
  await ch("r5", "pr5", "microsoft", "2 hours", "stop_requested_at=now()");        // Teardown läuft
  await ch("r6", "pr6", "microsoft", "2 hours", "renew_paused_until=now() + interval '1 hour'"); // nach Fehler pausiert
  await ch("r7", "pr7", "microsoft", "5 minutes");                                 // knapp: run_at darf nicht gestreut werden

  const repo = new PgChannelRepo(pool);
  assert.equal(await repo.scheduleDueRenewals(24 * 60 * MIN, 30 * MIN, 100), 2);
  assert.equal(await repo.scheduleDueRenewals(24 * 60 * MIN, 30 * MIN, 100), 0, "dedupe: zweiter Lauf stellt nichts doppelt ein");
  const { rows: jobs } = await pool.query(`SELECT dedupe_key, payload, extract(epoch FROM run_at - now()) AS in_s FROM job_queue WHERE kind = $1 ORDER BY dedupe_key`, [RENEW_KIND]);
  assert.deepEqual(jobs.map((j) => j.dedupe_key), ["renew:r1", "renew:r7"]);
  assert.ok(Number(jobs[0].in_s) <= 30 * 60 + 1, "gestreut höchstens 30 min");
  assert.ok(Number(jobs[1].in_s) <= 1, "läuft in < 10 min ab → sofort");

  const t = await repo.getRenewTarget("acme", "r1");
  assert.deepEqual([t?.live, t?.pipelineStatus, t?.ownerActive, t?.provider, typeof t?.ownerCreatedAt], [true, "active", true, "microsoft", "string"]);
  assert.equal(await repo.extendExpiry("r1", "2026-10-10T00:00:00Z"), true);
  assert.equal(await repo.extendExpiry("r5", "2026-10-10T00:00:00Z"), false, "gestoppter Channel wird nicht verlängert");

  const gone = await repo.markGoneAndRecreate("r2", "renew_404_subscription_gone", { pipelineId: "pr2", userId: "ur", grantedAt: null, attempts: {} });
  assert.deepEqual(gone, { marked: true, queued: true });
  assert.deepEqual(await repo.markGoneAndRecreate("r2", "x", {}), { marked: false, queued: false }, "zweimal = no-op");
  const { rows: hs } = await pool.query(`SELECT dedupe_key, payload->>'pipelineId' AS pid FROM job_queue WHERE kind = 'pipeline.handshake'`);
  assert.deepEqual(hs.map((r) => [r.dedupe_key, r.pid]), [["handshake:pr2", "pr2"]]);
  const { rows: st } = await pool.query(`SELECT stopped_at IS NOT NULL AS s, stop_note FROM webhook_channels WHERE id = 'r2'`);
  assert.equal(st[0].stop_note, "renew_404_subscription_gone");

  await repo.pauseRenewal("r1", new Date(Date.now() + 60 * MIN).toISOString(), "HTTP 400");
  await pool.query(`UPDATE webhook_channels SET expires_at = now() + interval '1 hour' WHERE id = 'r1'`);
  await pool.query(`DELETE FROM job_queue WHERE kind = $1`, [RENEW_KIND]);
  assert.equal(await repo.scheduleDueRenewals(24 * 60 * MIN, 30 * MIN, 100), 1, "nur r7, r1 ist pausiert");
});
