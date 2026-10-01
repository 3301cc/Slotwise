/**
 * Migration 007 + Sync-SQL gegen echtes PostgreSQL. Ohne DATABASE_URL übersprungen.
 *   DATABASE_URL=postgres://postgres@127.0.0.1:55432/postgres node --test dist/app/test/sync.pg.test.js
 * Legt eine EIGENE Wegwerf-Datenbank an (CREATEDB nötig) und migriert sie mit 000–007 – unabhängig von
 * migrations.pg.test (die eine leere DB erwartet) und parallel lauffähig.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import pg from "pg";
import { PrismaClient } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { runMigrations } from "../src/migrations.js";
import { PrismaPipelineStore } from "../src/pipelineStore.js";
import { PrismaScimStore, type PrismaLike } from "../../scim/src/prismaStore.js";
import { PgStatusRepo } from "../src/statusApi.js";
import {
  CLEANUP_KIND, createLogger, GRAPH_BASE, PgChannelRepo, PgDelayedJobQueue, PgPipelineRepo, PgSyncRepo, SYNC_KIND, SyncWorker,
  TargetCleanupWorker, TeardownJobWorker,
  type FetchLike, type SyncAllowlist,
} from "../../core/src/index.js";

const url = process.env.DATABASE_URL;
const skip = !url;
const dbName = `calensync_sync_${randomBytes(4).toString("hex")}`;
let admin: pg.Client;
let pool: pg.Pool;
const HOME = "11111111-2222-3333-4444-555555555555";
const ALLOW: SyncAllowlist = {
  homeEntraTenantId: HOME, ownDomains: [], linkedTenants: [],
  teamCalendars: [{ id: "vertrieb", mailbox: "vertrieb@acme.example", label: "Vertrieb" }], bookingEnabled: true,
};

before(async () => {
  if (skip) return;
  admin = new pg.Client({ connectionString: url });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${dbName}`);
  const u = new URL(url!);
  u.pathname = `/${dbName}`;
  const mig = new pg.Client({ connectionString: u.toString() });
  await mig.connect();
  const dir = join(process.cwd(), "core/migrations");
  await runMigrations(mig, dir, { bootstrap: true, log: () => {} });
  const r = await runMigrations(mig, dir, { bootstrap: false, log: () => {} });
  assert.ok(r.applied.includes("007_sync.sql"));
  await mig.end();
  pool = new pg.Pool({ connectionString: u.toString(), max: 4 });
});

after(async () => {
  if (skip) return;
  await pool.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await admin.end();
});

async function seed(): Promise<void> {
  await pool.query(`TRUNCATE scim_users, pipelines, sync_event_map, job_queue, webhook_channels CASCADE`);
  await pool.query(`INSERT INTO scim_users (id, tenant_id, user_name, user_name_normalized, external_id)
                    VALUES ('u1', 'acme', 'Max.Muster@acme.example', 'max.muster@acme.example', 'oid-1'),
                           ('u2', 'acme', 'eva@acme.example', 'eva@acme.example', 'oid-2'),
                           ('u3', 'other', 'x@other.example', 'x@other.example', 'oid-3')`);
  await pool.query(`INSERT INTO pipelines (id, tenant_id, owner_user_id, status, mode, busy_label, target_kind, target_mailbox, target_ref)
                    VALUES ('p-team', 'acme', 'u1', 'active', 'busy', 'Termin', 'team', 'vertrieb@acme.example', 'vertrieb'),
                           ('p-book', 'acme', 'u1', 'active', 'busy', NULL, 'booking', NULL, NULL),
                           ('p-book2', 'acme', 'u2', 'active', 'busy', NULL, 'booking', NULL, NULL),
                           ('p-book-off', 'acme', 'u2', 'revoked', 'busy', NULL, 'booking', NULL, NULL),
                           ('p-other', 'other', 'u3', 'active', 'busy', NULL, 'booking', NULL, NULL),
                           ('p-legacy', 'acme', 'u1', 'active', 'busy', NULL, NULL, NULL, NULL)`);
}

test("Migration 007: Spalten, Checks, Tabelle, Indizes, FK-Cascade, Rechte; erneutes Ausführen ist ein No-op", { skip }, async () => {
  const cols = await pool.query(`SELECT column_name FROM information_schema.columns WHERE table_name = 'pipelines' AND column_name LIKE ANY (ARRAY['target_%', 'source_%', 'last_sync%', 'sync_lease%']) ORDER BY 1`);
  assert.deepEqual(cols.rows.map((r) => r.column_name as string).sort(), ["last_sync_error", "last_synced_at", "source_delta_link", "source_delta_started_at",
    "sync_lease_owner", "sync_lease_until", "target_entra_tenant_id", "target_kind", "target_mailbox", "target_ref"]);
  const idx = await pool.query(`SELECT indexname FROM pg_indexes WHERE tablename = 'sync_event_map' ORDER BY 1`);
  assert.deepEqual(idx.rows.map((r) => r.indexname), ["sync_event_map_pipeline_id_start_at_idx", "sync_event_map_pkey", "sync_event_map_tenant_id_target_event_id_idx"]);
  const priv = await pool.query(`SELECT has_table_privilege('calensync_app', 'sync_event_map', 'SELECT, INSERT, UPDATE, DELETE') AS dml,
                                        has_table_privilege('calensync_app', 'sync_event_map', 'TRUNCATE') AS trunc`);
  assert.deepEqual(priv.rows[0], { dml: true, trunc: false });

  await seed();
  const bad = [
    `UPDATE pipelines SET target_kind = 'google' WHERE id = 'p-team'`,
    `UPDATE pipelines SET target_mailbox = 'x@y.de' WHERE id = 'p-book'`,
    `UPDATE pipelines SET target_ref = NULL WHERE id = 'p-team'`,
    `UPDATE pipelines SET last_sync_error = 'Fehler: Termin "Vorstand" abgelehnt' WHERE id = 'p-team'`,
    `INSERT INTO sync_event_map (tenant_id, pipeline_id, source_event_id, start_at, end_at) VALUES ('acme', 'p-team', 's', now(), now() - interval '1 h')`,
    `INSERT INTO sync_event_map (tenant_id, pipeline_id, source_event_id, start_at, end_at) VALUES ('acme', 'gibt-es-nicht', 's', now(), now())`,
  ];
  for (const q of bad) await assert.rejects(pool.query(q), /violates|constraint/, q);
  await pool.query(`UPDATE pipelines SET last_sync_error = 'blocked_scope' WHERE id = 'p-team'`);

  // Idempotenz: Datei noch einmal roh ausführen (wie ein zweiter Migrator nach manuellem Eingriff)
  const sql = (await import("node:fs")).readFileSync(join(process.cwd(), "core/migrations/007_sync.sql"), "utf8");
  await pool.query(sql);

  // FK: Pipeline weg → Zuordnungen weg (Purge des Users kaskadiert über pipelines)
  await pool.query(`INSERT INTO sync_event_map (tenant_id, pipeline_id, source_event_id, start_at, end_at) VALUES ('acme', 'p-team', 's1', now(), now())`);
  await pool.query(`DELETE FROM scim_users WHERE id = 'u1'`);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_event_map`)).rows[0].n, 0);
});

test("PgSyncRepo: Kontext, Lease, Zuordnungen, Schleifen-Lookup je Mandant, Zustand, Status, Scheduler", { skip }, async () => {
  await seed();
  const repo = new PgSyncRepo(pool);
  const ctx = await repo.getSyncContext("acme", "p-team");
  assert.deepEqual({ ...ctx, createdAt: null }, {
    status: "active", ownerActive: true, ownerEntraObjectId: "oid-1", ownerUserName: "Max.Muster@acme.example", mode: "busy", busyLabel: "Termin",
    target: { kind: "team", mailbox: "vertrieb@acme.example", entraTenantId: null, ref: "vertrieb" }, deltaLink: null, deltaStartedAt: null, createdAt: null,
  });
  assert.equal(await repo.getSyncContext("other", "p-team"), null, "fremder Mandant sieht nichts");

  assert.equal(await repo.acquireSyncLease("acme", "p-team", "job-1", 60_000), true);
  assert.equal(await repo.acquireSyncLease("acme", "p-team", "job-2", 60_000), false);
  assert.equal(await repo.acquireSyncLease("acme", "p-team", "job-1", 60_000), true, "eigene Lease verlängern");
  await repo.releaseSyncLease("acme", "p-team", "job-2");
  assert.equal(await repo.acquireSyncLease("acme", "p-team", "job-2", 60_000), false, "fremdes Release wirkt nicht");
  await repo.releaseSyncLease("acme", "p-team", "job-1");
  assert.equal(await repo.acquireSyncLease("acme", "p-team", "job-2", 60_000), true);

  const at = new Date("2026-10-02T09:00:00Z");
  const end = new Date("2026-10-02T10:00:00Z");
  await repo.upsertMapping("acme", "p-team", { sourceEventId: "A", targetEventId: null, changeKey: null, startAt: at, endAt: end });
  await repo.upsertMapping("acme", "p-team", { sourceEventId: "A", targetEventId: "T-A", changeKey: "ck1", startAt: at, endAt: end });
  await repo.upsertMapping("other", "p-other", { sourceEventId: "Z", targetEventId: "T-Z", changeKey: "c", startAt: at, endAt: end });
  await repo.upsertMapping("acme", "gibt-es-nicht", { sourceEventId: "Q", targetEventId: "T-Q", changeKey: "c", startAt: at, endAt: end });
  const m = await repo.getMappings("p-team", ["A", "B"]);
  assert.deepEqual([...m.values()], [{ sourceEventId: "A", targetEventId: "T-A", changeKey: "ck1", startAt: at, endAt: end }]);
  assert.deepEqual([...await repo.findCalensyncTargetIds("acme", ["T-A", "T-Z", "x"])], ["T-A"], "nur Zieltermine des eigenen Mandanten");
  assert.equal((await repo.listMappings("p-team")).length, 1);
  await repo.deleteMapping("p-team", "A");
  assert.equal((await repo.listMappings("p-team")).length, 0);

  await repo.saveSyncState("acme", "p-team", { deltaLink: `${GRAPH_BASE}/x?$deltatoken=1`, deltaStartedAt: at, synced: true, errorCode: "event_rejected" });
  let p = (await pool.query(`SELECT source_delta_link, source_delta_started_at, last_synced_at, last_sync_error FROM pipelines WHERE id = 'p-team'`)).rows[0];
  assert.deepEqual([p.source_delta_link, new Date(p.source_delta_started_at).toISOString(), p.last_synced_at !== null, p.last_sync_error],
    [`${GRAPH_BASE}/x?$deltatoken=1`, at.toISOString(), true, "event_rejected"]);
  await repo.saveSyncState("acme", "p-team", { deltaLink: null, deltaStartedAt: null, synced: false });
  p = (await pool.query(`SELECT source_delta_link, last_sync_error FROM pipelines WHERE id = 'p-team'`)).rows[0];
  assert.deepEqual([p.source_delta_link, p.last_sync_error], [null, "event_rejected"], "Reset lässt Fehlercode stehen");
  await repo.setPipelineStatus("acme", "p-book-off", "error");
  assert.equal((await pool.query(`SELECT status FROM pipelines WHERE id = 'p-book-off'`)).rows[0].status, "revoked", "revoked bleibt revoked");

  // Scheduler: aktive Pipelines mit Ziel, nie synchronisiert → je ein Job; zweiter Lauf → dedupe
  const n1 = await repo.scheduleDueSyncs(12 * 3_600_000, 60_000, 100);
  const jobs = (await pool.query(`SELECT dedupe_key, payload FROM job_queue WHERE kind = $1 ORDER BY 1`, [SYNC_KIND])).rows;
  assert.equal(n1, 3);
  assert.deepEqual(jobs.map((j) => j.dedupe_key), ["delta:p-book", "delta:p-book2", "delta:p-other"], "p-team gerade synchronisiert, legacy/revoked nie");
  assert.equal(await repo.scheduleDueSyncs(12 * 3_600_000, 60_000, 100), 0);
});

test("Busy-API-SQL: nur aktive booking-Pipelines aktiver Nutzer des Mandanten, Überlappung mit dem Zeitraum", { skip }, async () => {
  await seed();
  const repo = new PgSyncRepo(pool);
  const iv = (h1: number, h2: number) => ({ startAt: new Date(Date.UTC(2026, 9, 2, h1)), endAt: new Date(Date.UTC(2026, 9, 2, h2)) });
  await repo.upsertMapping("acme", "p-book", { sourceEventId: "a", targetEventId: null, changeKey: "c", ...iv(9, 10) });
  await repo.upsertMapping("acme", "p-book2", { sourceEventId: "b", targetEventId: null, changeKey: "c", ...iv(9, 11) });
  await repo.upsertMapping("acme", "p-book2", { sourceEventId: "late", targetEventId: null, changeKey: "c", ...iv(20, 21) });
  await repo.upsertMapping("acme", "p-book-off", { sourceEventId: "c", targetEventId: null, changeKey: "c", ...iv(12, 13) });
  await repo.upsertMapping("acme", "p-team", { sourceEventId: "d", targetEventId: "T-d", changeKey: "c", ...iv(14, 15) });
  await repo.upsertMapping("other", "p-other", { sourceEventId: "e", targetEventId: null, changeKey: "c", ...iv(16, 17) });
  const rows = await repo.busyIntervals("acme", new Date(Date.UTC(2026, 9, 2, 8)), new Date(Date.UTC(2026, 9, 2, 19)));
  assert.deepEqual(rows.map((r) => [r.start.getUTCHours(), r.end.getUTCHours()]), [[9, 10], [9, 11]]);
  await pool.query(`UPDATE scim_users SET active = false WHERE id = 'u2'`);
  assert.equal((await repo.busyIntervals("acme", new Date(Date.UTC(2026, 9, 2, 8)), new Date(Date.UTC(2026, 9, 2, 19)))).length, 1, "deaktivierter Nutzer zählt nicht");
});

test("Handshake-Aktivierung stellt den ersten vollen Sync im selben Statement ein; sync-status liest Ziel + Zustand", { skip }, async () => {
  await seed();
  await pool.query(`UPDATE pipelines SET status = 'pending' WHERE id = 'p-team'`);
  await new PgPipelineRepo(pool).activateWithChannel("acme", "p-team", { userId: "u1", providerSubscriptionId: "sub-1", clientState: "cs", expiresAt: "2026-10-07T00:00:00Z" });
  const j = (await pool.query(`SELECT dedupe_key, payload FROM job_queue WHERE kind = $1`, [SYNC_KIND])).rows;
  assert.deepEqual(j, [{ dedupe_key: "delta:p-team", payload: { pipelineId: "p-team", full: true } }]);

  await pool.query(`UPDATE pipelines SET last_synced_at = '2026-10-01T08:00:00Z', last_sync_error = 'transient' WHERE id = 'p-team'`);
  const st = await new PgStatusRepo(pool, ALLOW).getSyncStatus("acme", "oid-1");
  const team = st?.pipelines.find((p) => p.id === "p-team");
  assert.deepEqual([team?.target, team?.lastSyncedAt, team?.lastError, team?.subscription.active], [{ kind: "team", label: "Vertrieb" }, "2026-10-01T08:00:00.000Z", "transient", true]);
  assert.equal(st?.pipelines.find((p) => p.id === "p-legacy")?.target, null);
  assert.equal(await new PgStatusRepo(pool, ALLOW).getActiveUserName("acme", "oid-1"), "Max.Muster@acme.example");
  assert.equal(await new PgStatusRepo(pool, ALLOW).getActiveUserName("other", "oid-1"), null);
});

test("Ende-zu-Ende auf PostgreSQL: Worker + Queue + Repo; KANARIE steht danach in KEINER Tabelle und in keiner Logzeile", { skip }, async () => {
  await seed();
  const c = `KANARIE-${randomBytes(6).toString("hex")}`;
  const ev = (id: string, o: Record<string, unknown> = {}) => ({
    id, showAs: "busy", isAllDay: false, changeKey: `ck-${id}`, subject: `${c}-subject`, bodyPreview: `${c}-preview`,
    body: { content: `${c}-body` }, location: { displayName: `${c}-location` }, attendees: [{ emailAddress: { address: `${c}@x.example` } }],
    start: { dateTime: "2026-10-02T09:00:00.0000000", timeZone: "UTC" }, end: { dateTime: "2026-10-02T10:00:00.0000000", timeZone: "UTC" }, ...o,
  });
  const sent: string[] = [];
  let seq = 0;
  const fetchFn: FetchLike = async (u, init) => {
    if (init.body) sent.push(init.body);
    const res = (status: number, body: unknown) => ({ status, headers: { get: () => null }, text: async () => JSON.stringify(body) });
    if (u.includes("/calendarView/delta")) {
      // Runde 1 = frisches Delta, Runde 2 = gespeicherter deltaLink
      const second = u.includes("deltatoken=r1");
      const value = second
        ? [ev("A", { changeKey: "ck-A2", start: { dateTime: "2026-10-02T09:30:00", timeZone: "UTC" } }), ev("B", { showAs: "free" }), ev("C")]
        : [ev("A"), ev("B", { showAs: "oof" })];
      return res(200, { value, "@odata.deltaLink": `${GRAPH_BASE}/users/oid-1/calendarView/delta?$deltatoken=${second ? "r2" : "r1"}` });
    }
    if (init.method === "POST") return res(201, { id: `T-${++seq}` });
    if (init.method === "PATCH") return res(200, {});
    if (init.method === "DELETE") return { status: 204, headers: { get: () => null }, text: async () => "" };
    return res(404, {});
  };
  const lines: string[] = [];
  const logger = createLogger({ service: "t", write: (x) => lines.push(x), flushOnExit: false });
  const queue = new PgDelayedJobQueue(pool, () => 0.5);
  const worker = new SyncWorker({
    queue, repo: new PgSyncRepo(pool), fetchFn, allowlist: ALLOW, workerId: "w1",
    tokens: { getGraphToken: async () => "tok", invalidateGraphToken: () => {} },
    alert: (a) => logger.alert("worker_alert", { ...a }),
    log: (e) => logger.info(String(e.msg), e),
  });
  for (const pid of ["p-team", "p-book"]) await queue.enqueue("acme", SYNC_KIND, { pipelineId: pid, full: true }, { dedupeKey: `delta:${pid}` });
  const r1 = await worker.tick(10);
  assert.equal(r1.synced, 2);
  for (const pid of ["p-team", "p-book"]) await queue.enqueue("acme", SYNC_KIND, { pipelineId: pid, full: false }, { dedupeKey: `delta:${pid}` });
  assert.equal((await worker.tick(10)).synced, 2);
  logger.flush();

  const map = (await pool.query(`SELECT pipeline_id, source_event_id, target_event_id FROM sync_event_map ORDER BY 1, 2`)).rows;
  assert.deepEqual(map.map((m) => `${m.pipeline_id}/${m.source_event_id}/${m.target_event_id ?? "-"}`).sort(),
    ["p-book/A/-", "p-book/C/-", "p-team/A/T-1", "p-team/C/T-3"].sort());
  const pRow = (await pool.query(`SELECT source_delta_link, last_sync_error, sync_lease_owner FROM pipelines WHERE id = 'p-team'`)).rows[0];
  assert.match(pRow.source_delta_link, /deltatoken=r2/);
  assert.equal(pRow.sync_lease_owner, null);

  // Jede Zeile jeder Tabelle als Text durchsuchen
  const tables = (await pool.query(`SELECT tablename FROM pg_tables WHERE schemaname = 'public'`)).rows.map((r) => r.tablename as string);
  assert.ok(tables.includes("sync_event_map") && tables.includes("job_queue") && tables.includes("audit_events"));
  for (const t of tables) {
    const hit = await pool.query(`SELECT count(*)::int AS n FROM ${t} x WHERE x::text LIKE $1`, [`%${c}%`]);
    assert.equal(hit.rows[0].n, 0, `Tabelle ${t}`);
  }
  assert.equal(lines.join("").includes(c), false, "Log");
  assert.ok(sent.length > 0);
  assert.equal(sent.some((b) => b.includes(c)), false, "busy-Modus: kein Inhalt im Request an das Ziel");
});

test("Echter Prisma-Client: Pipeline mit Ziel anlegen (Spalten-Mapping 007), Replay, Ablehnung", { skip }, async () => {
  await seed();
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const allow: SyncAllowlist = { ...ALLOW, ownDomains: ["acme-alias.example"] };
    const store = new PrismaPipelineStore(prisma as unknown as PrismaLike, 10, () => "p-new", allow);
    const r = await store.createPipeline({ tenantId: "acme", entraObjectId: "oid-1", mode: "busy", busyLabel: null,
      idempotencyKey: "key-0000000000000042", target: { kind: "account", mailbox: "max.muster@acme-alias.example", entraTenantId: null } });
    assert.deepEqual(r, { kind: "created", pipeline: { id: "p-new", status: "pending", mode: "busy", busyLabel: null, target: { kind: "account", label: "acme-alias.example" } } });
    const row = (await pool.query(`SELECT target_kind, target_mailbox, target_entra_tenant_id, target_ref FROM pipelines WHERE id = 'p-new'`)).rows[0];
    assert.deepEqual(row, { target_kind: "account", target_mailbox: "max.muster@acme-alias.example", target_entra_tenant_id: null, target_ref: null });
    const replay = await store.createPipeline({ tenantId: "acme", entraObjectId: "oid-1", mode: "busy", busyLabel: null,
      idempotencyKey: "key-0000000000000042", target: { kind: "account", mailbox: "max.muster@acme-alias.example", entraTenantId: null } });
    assert.equal(replay.kind, "replayed");
    const denied = await store.createPipeline({ tenantId: "acme", entraObjectId: "oid-1", mode: "busy", busyLabel: null,
      idempotencyKey: "key-0000000000000043", target: { kind: "account", mailbox: "eva@acme-alias.example", entraTenantId: null } });
    assert.deepEqual(denied, { kind: "target_not_allowed", reason: "not_same_person" });

  } finally {
    await prisma.$disconnect();
  }
});

const withPrisma = async (fn: (prisma: PrismaLike) => Promise<void>) => {
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    await fn(prisma as unknown as PrismaLike);
  } finally {
    await prisma.$disconnect();
  }
};
const jobs = async (kind: string) => (await pool.query(`SELECT dedupe_key FROM job_queue WHERE kind = $1 ORDER BY 1`, [kind])).rows.map((r) => r.dedupe_key as string);

test("SCIM-Kappung: Bereinigung wird im SELBEN Commit angefordert – scheitert ein Teil, bleibt alles beim Alten", { skip }, async () => {
  await seed();
  await withPrisma(async (prisma) => {
    const store = new PrismaScimStore(prisma);
    // Rollback-Beweis: Trigger lässt den Cleanup-INSERT scheitern → Kappung, Teardown-Job, Abo-Stopp: nichts davon bleibt
    await pool.query(`CREATE OR REPLACE FUNCTION fail_cleanup() RETURNS trigger AS $f$ BEGIN
      IF NEW.kind = 'pipeline.target_cleanup' THEN RAISE EXCEPTION 'cleanup insert blockiert'; END IF; RETURN NEW; END $f$ LANGUAGE plpgsql`);
    await pool.query(`CREATE TRIGGER fail_cleanup BEFORE INSERT ON job_queue FOR EACH ROW EXECUTE FUNCTION fail_cleanup()`);
    await pool.query(`INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, client_state)
                      VALUES ('ch-team', 'acme', 'u1', 'p-team', 'microsoft', 'sub-team', 'cs')`);
    await assert.rejects(store.revokeSyncForUser("acme", "u1", "scim_deactivated"), /cleanup insert blockiert/);
    assert.deepEqual((await pool.query(`SELECT status, cleanup_requested_at FROM pipelines WHERE id = 'p-team'`)).rows[0], { status: "active", cleanup_requested_at: null });
    assert.deepEqual(await jobs("subscription.teardown"), []);
    assert.equal((await pool.query(`SELECT stop_requested_at FROM webhook_channels WHERE id = 'ch-team'`)).rows[0].stop_requested_at, null);
    await pool.query(`DROP TRIGGER fail_cleanup ON job_queue`);

    await store.revokeSyncForUser("acme", "u1", "scim_deactivated");
    assert.deepEqual(await jobs(CLEANUP_KIND), ["cleanup:p-book", "cleanup:p-legacy", "cleanup:p-team"]);
    assert.deepEqual(await jobs("subscription.teardown"), ["teardown:u1"]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pipelines WHERE owner_user_id = 'u1' AND (status <> 'revoked' OR cleanup_requested_at IS NULL)`)).rows[0].n, 0);
  });
});

test("DELETE /me/pipelines (endPipeline, echter Prisma): nur diese Pipeline, Jobs im selben Commit; Teardown stoppt nur ihr Abo", { skip }, async () => {
  await seed();
  await pool.query(`INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, client_state)
                    VALUES ('ch-team', 'acme', 'u1', 'p-team', 'microsoft', 'sub-team', 'cs'), ('ch-book', 'acme', 'u1', 'p-book', 'microsoft', 'sub-book', 'cs')`);
  await withPrisma(async (prisma) => {
    const store = new PrismaPipelineStore(prisma, 10, undefined, ALLOW);
    const r = await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-1", pipelineId: "p-book" });
    assert.deepEqual(r, { kind: "ended", pipeline: { id: "p-book", status: "revoked", cleanup: "pending" } });
    assert.deepEqual((await pool.query(`SELECT id, status, revoked_reason FROM pipelines WHERE owner_user_id = 'u1' AND id IN ('p-book', 'p-team') ORDER BY id`)).rows,
      [{ id: "p-book", status: "revoked", revoked_reason: "user_ended" }, { id: "p-team", status: "active", revoked_reason: null }]);
    assert.deepEqual(await jobs(CLEANUP_KIND), ["cleanup:p-book"]);
    assert.deepEqual(await jobs("subscription.teardown"), ["teardown:u1"]);
    assert.deepEqual((await new PgChannelRepo(pool).listOpenForUser("acme", "u1")).map((c) => c.id), ["ch-book"], "Abo der weiter aktiven Pipeline bleibt");
    assert.equal((await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-1", pipelineId: "p-book2" })).kind, "not_found", "fremde Pipeline");
    assert.equal((await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-1", pipelineId: "p-book" })).kind, "already_ended");
  });
});

test("SCIM-DELETE: Tombstone behält Zielpostfach + Termin-IDs bis zur Bereinigung; danach genullt, erst dann Purge (inkl. Cascade)", { skip }, async () => {
  await seed();
  const repo = new PgSyncRepo(pool);
  const at = new Date("2026-10-02T09:00:00Z");
  await repo.upsertMapping("acme", "p-team", { sourceEventId: "s1", targetEventId: "T-1", changeKey: "c", startAt: at, endAt: at });
  await repo.upsertMapping("acme", "p-team", { sourceEventId: "s2", targetEventId: "T-2", changeKey: "c", startAt: at, endAt: at });
  await repo.upsertMapping("acme", "p-book", { sourceEventId: "b1", targetEventId: null, changeKey: "c", startAt: at, endAt: at });
  await withPrisma(async (prisma) => {
    const scim = new PrismaScimStore(prisma);
    await scim.markDeletedAndEnqueueTeardown("acme", "u1", new Date().toISOString());
    assert.deepEqual((await pool.query(`SELECT user_name, external_id FROM scim_users WHERE id = 'u1'`)).rows[0], { user_name: "deleted-u1", external_id: null });
    assert.equal((await pool.query(`SELECT target_mailbox FROM pipelines WHERE id = 'p-team'`)).rows[0].target_mailbox, "vertrieb@acme.example");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_event_map`)).rows[0].n, 3);
    assert.equal(await repo.pendingCleanupsForUser("acme", "u1"), 3);

    const queue = new PgDelayedJobQueue(pool, () => 0.5);
    const purged: string[] = [];
    const teardown = new TeardownJobWorker({
      queue, workerId: "w1", random: () => 0.5, cleanups: repo,
      teardown: { terminateForUser: async () => ({ channels: 0, stopped: 0, alreadyGone: 0, retryScheduled: 0, failed: 0, timedOut: false, details: [] }) },
      channels: new PgChannelRepo(pool),
      users: { purgeDeletedUser: async (t, u) => { const ok = await scim.purgeDeletedUser(t, u); if (ok) purged.push(u); return ok; } },
      audit: async () => {}, alert: async () => {},
    });
    assert.equal((await teardown.tick(10)).rescheduled, 1, "Purge wartet auf die Bereinigung");
    assert.deepEqual(purged, []);

    const sent: string[] = [];
    const fetchFn: FetchLike = async (u, init) => {
      sent.push(`${init.method} ${decodeURIComponent(u.replace(GRAPH_BASE, ""))}`);
      return { status: u.endsWith("T-2") ? 404 : 204, headers: { get: () => null }, text: async () => "" };
    };
    const cleanup = new TargetCleanupWorker({ queue, repo, fetchFn, allowlist: ALLOW, workerId: "w1", alert: () => {},
      tokens: { getGraphToken: async () => "tok", invalidateGraphToken: () => {} } });
    const r = await cleanup.tick(10);
    assert.equal(r.cleaned, 3);
    assert.deepEqual(sent.sort(), ["DELETE /users/vertrieb@acme.example/events/T-1", "DELETE /users/vertrieb@acme.example/events/T-2"]);
    assert.deepEqual((await pool.query(`SELECT id, target_mailbox, cleanup_done_at IS NOT NULL AS done FROM pipelines WHERE owner_user_id = 'u1' ORDER BY id`)).rows,
      [{ id: "p-book", target_mailbox: null, done: true }, { id: "p-legacy", target_mailbox: null, done: true }, { id: "p-team", target_mailbox: null, done: true }]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM sync_event_map`)).rows[0].n, 0);

    await pool.query(`UPDATE job_queue SET run_at = now() WHERE kind = 'subscription.teardown'`);
    assert.equal((await teardown.tick(10)).purged, 1);
    assert.deepEqual(purged, ["u1"]);
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM pipelines WHERE owner_user_id = 'u1'`)).rows[0].n, 0, "Tombstone + Pipelines endgültig weg");
  });
});
