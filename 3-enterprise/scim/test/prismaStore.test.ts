/**
 * PrismaScimStore gegen ein In-Memory-Double des PrismaLike-Interfaces:
 *   * Kill-Switch in einer Transaktion, nur eigene Mandantenzeilen, idempotent
 *   * Audit-Hash-Kette: lückenlos, jede Manipulation bricht die Verifikation
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { PrismaScimStore, withTxRetry, type PrismaLike, type PrismaTx } from "../src/prismaStore.js";
import { StoreBusyError } from "../src/types.js";

type Row = Record<string, any>;

function matches(row: Row, where: Row): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === "object" && "not" in v) return (row[k] ?? null) !== v.not;
    return (row[k] ?? null) === v;
  });
}

function apply(row: Row, data: Row) {
  for (const [k, v] of Object.entries(data)) {
    row[k] = v !== null && typeof v === "object" && "increment" in v ? row[k] + (v as { increment: number }).increment : v;
  }
}

function fakeDb() {
  const t = { scimUser: [] as Row[], pipeline: [] as Row[], providerToken: [] as Row[], webhookChannel: [] as Row[],
    jobs: [] as Row[], audit: [] as Row[], ops: [] as string[], txOptions: [] as unknown[] };
  let transactions = 0;
  const updateMany = (rows: Row[], name = "?") => async (a: Row) => {
    t.ops.push(name);
    let count = 0;
    for (const r of rows) if (matches(r, a.where)) { apply(r, a.data); count++; }
    return { count };
  };
  const tx: PrismaTx = {
    scimUser: {
      findFirst: async () => null, findMany: async () => [], count: async () => 0, create: async () => ({}),
      updateMany: async (a: Row) => updateMany(t.scimUser, "scim_users")(a),
      deleteMany: async (a: Row) => {
        const before = t.scimUser.length;
        t.scimUser = t.scimUser.filter((r) => !matches(r, a.where));
        return { count: before - t.scimUser.length };
      },
    },
    pipeline: {
      updateMany: updateMany(t.pipeline, "pipelines"),
      // Pipeline-Anlage (app/src/pipelineStore.ts) wird in app/test/pipelines.test.ts geprüft
      count: async () => { throw new Error("nicht erwartet"); },
      findFirst: async () => { throw new Error("nicht erwartet"); },
      create: async () => { throw new Error("nicht erwartet"); },
    },
    providerToken: {
      deleteMany: async (a: Row) => {
        t.ops.push("provider_tokens");
        const before = t.providerToken.length;
        t.providerToken = t.providerToken.filter((r) => !matches(r, a.where));
        return { count: before - t.providerToken.length };
      },
    },
    webhookChannel: { updateMany: updateMany(t.webhookChannel, "webhook_channels") },
    auditEvent: {
      findFirst: async (a: Row) => {
        const rows = t.audit.filter((r) => r.tenantId === a.where.tenantId);
        return rows.length ? { seq: rows.length, hash: rows[rows.length - 1].hash } : null;
      },
      create: async (a: Row) => { t.audit.push(a.data); return a.data; },
    },
    // job_queue-INSERT mit ON CONFLICT … WHERE status = 'queued' DO NOTHING nachgebildet
    $executeRaw: async (q: TemplateStringsArray, ...v: unknown[]) => {
      const sql = q.join("$");
      if (sql.includes("lock_timeout")) { t.ops.push("lock_timeout"); return 0; }
      if (sql.includes("pg_advisory_xact_lock(hashtext($), hashtext($))")) { t.ops.push(`user_lock:${v.join("/")}`); return 1; }
      if (sql.includes("INSERT INTO job_queue")) t.ops.push("job_queue");
      if (!sql.includes("INSERT INTO job_queue")) return 0;
      assert.match(sql, /ON CONFLICT \(kind, dedupe_key\) WHERE status = 'queued' DO NOTHING/);
      const [tenantId, kind, dedupeKey, payload] = v as string[];
      if (t.jobs.some((j) => j.kind === kind && j.dedupeKey === dedupeKey && j.status === "queued")) return 0;
      t.jobs.push({ tenantId, kind, dedupeKey, payload: JSON.parse(payload), status: "queued" });
      return 1;
    },
  };
  const db: PrismaLike = { ...tx, $transaction: async (fn, o) => { transactions++; t.txOptions.push(o); return fn(tx); } };
  return { db, t, transactions: () => transactions };
}

function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")}}`;
}

/** Verifikation, wie sie ein SIEM-Export oder Auditor durchführt */
function verifyChain(rows: Row[]): boolean {
  let prev = "0".repeat(64);
  for (const r of rows) {
    if (r.prevHash !== prev) return false;
    const ev = { tenantId: r.tenantId, requestId: r.requestId, actor: r.actor, action: r.action, targetUserId: r.targetUserId,
      outcome: r.outcome, detail: r.detail, at: r.at.toISOString(), prevHash: prev };
    const h = createHash("sha256").update(prev).update(canonical(ev)).digest("hex");
    if (h !== r.hash) return false;
    prev = h;
  }
  return true;
}

describe("PrismaScimStore", () => {
  it("revokeSyncForUser: eine Transaktion, nur eigene Zeilen, idempotent", async () => {
    const { db, t, transactions } = fakeDb();
    t.pipeline.push(
      { tenantId: "acme", ownerUserId: "u1", status: "active" },
      { tenantId: "acme", ownerUserId: "u2", status: "active" },
      { tenantId: "other", ownerUserId: "u1", status: "active" },
    );
    t.providerToken.push({ tenantId: "acme", userId: "u1" }, { tenantId: "other", userId: "u1" });
    t.webhookChannel.push({ tenantId: "acme", userId: "u1", stopRequestedAt: null, stoppedAt: null });
    const store = new PrismaScimStore(db);

    const r1 = await store.revokeSyncForUser("acme", "u1", "scim_deactivated");
    assert.deepEqual(r1, { pipelinesRevoked: 1, tokensDestroyed: 1, subscriptionsQueuedForStop: 1, teardownJobQueued: true });
    assert.equal(transactions(), 1);
    assert.equal(t.pipeline[1].status, "active", "anderer User unberührt");
    assert.equal(t.pipeline[2].status, "active", "anderer Mandant unberührt");
    assert.equal(t.providerToken.length, 1);
    assert.deepEqual(t.jobs.map((j) => [j.kind, j.dedupeKey, j.payload.purgeUser]), [["subscription.teardown", "teardown:u1", false]]);

    const r2 = await store.revokeSyncForUser("acme", "u1", "scim_deactivated");
    assert.deepEqual(r2, { pipelinesRevoked: 0, tokensDestroyed: 0, subscriptionsQueuedForStop: 0, teardownJobQueued: false });
    assert.equal(t.jobs.length, 1, "kein zweiter wartender Teardown-Job");
  });

  it("markDeletedAndEnqueueTeardown: Tombstone ohne PII + Kappung + Purge-Job in EINER Transaktion", async () => {
    const { db, t, transactions } = fakeDb();
    t.scimUser.push({ tenantId: "acme", id: "u1", userName: "max@acme.example", userNameNormalized: "max@acme.example",
      externalId: "oid-1", active: true, displayName: "Max", givenName: "Max", familyName: "Mustermann", formattedName: null,
      emails: [{ value: "max@acme.example" }], department: "Vertrieb", version: 3, deprovisionedAt: null, deletionRequestedAt: null });
    t.pipeline.push({ tenantId: "acme", ownerUserId: "u1", status: "active" });
    t.webhookChannel.push({ tenantId: "acme", userId: "u1", stopRequestedAt: null, stoppedAt: null });
    const store = new PrismaScimStore(db);

    const r = await store.markDeletedAndEnqueueTeardown("acme", "u1", "2026-10-01T10:00:00.000Z");
    assert.equal(transactions(), 1);
    assert.deepEqual(r, { pipelinesRevoked: 1, tokensDestroyed: 0, subscriptionsQueuedForStop: 1, teardownJobQueued: true });
    const u = t.scimUser[0];
    assert.equal(JSON.stringify(u).toLowerCase().includes("mustermann"), false);
    assert.equal(JSON.stringify(u).includes("max@"), false);
    assert.deepEqual([u.active, u.version, u.deletionRequestedAt.toISOString()], [false, 4, "2026-10-01T10:00:00.000Z"]);
    assert.deepEqual(t.jobs.map((j) => [j.dedupeKey, j.payload.purgeUser]), [["purge:u1", true]]);

    assert.equal(await store.markDeletedAndEnqueueTeardown("acme", "u1", "2026-10-01T10:01:00.000Z"), null, "zweites DELETE");
    assert.equal(await store.purgeDeletedUser("other", "u1"), false, "fremder Mandant");
    assert.equal(await store.purgeDeletedUser("acme", "u1"), true);
    assert.equal(t.scimUser.length, 0);
  });

  it("Audit-Hash-Kette ist verifizierbar und erkennt Manipulation", async () => {
    const { db, t } = fakeDb();
    const store = new PrismaScimStore(db);
    for (const action of ["scim.user.create", "scim.user.deactivate", "scim.user.delete"]) {
      await store.appendAudit({ tenantId: "acme", requestId: action, actor: "scim:entra", action, targetUserId: "u1",
        outcome: "success", detail: { n: action.length }, at: "2026-10-01T10:00:00.000Z" });
    }
    assert.equal(t.audit.length, 3);
    assert.ok(verifyChain(t.audit));
    t.audit[1].action = "scim.user.patch";          // nachträgliche Änderung
    assert.equal(verifyChain(t.audit), false);
    t.audit[1].action = "scim.user.deactivate";
    t.audit.splice(1, 1);                            // nachträgliche Löschung
    assert.equal(verifyChain(t.audit), false);
  });

  it("Deadlock-Schutz: Read Committed, User-Sperre zuerst, feste Sperrreihenfolge in allen Pfaden", async () => {
    const { db, t } = fakeDb();
    t.scimUser.push({ tenantId: "acme", id: "u1", version: 1, deletionRequestedAt: null, deprovisionedAt: null });
    const store = new PrismaScimStore(db);
    const order = ["scim_users", "pipelines", "provider_tokens", "webhook_channels", "job_queue"];
    const isOrdered = (ops: string[]) => {
      const idx = ops.filter((o) => order.includes(o)).map((o) => order.indexOf(o));
      return idx.every((v, i) => i === 0 || v >= idx[i - 1]);
    };

    await store.revokeSyncForUser("acme", "u1", "scim_deactivated");
    assert.deepEqual(t.ops.slice(0, 2), ["lock_timeout", "user_lock:acme/u1"]);
    assert.ok(isOrdered(t.ops), t.ops.join(" → "));

    t.ops.length = 0;
    const r = await store.deactivateAndRevoke({ tenantId: "acme", id: "u1", userName: "x", userNameNormalized: "x", externalId: null,
      active: false, displayName: null, name: null, emails: [], department: null, version: 2, createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z", deprovisionedAt: "2026-10-01T10:00:00.000Z" }, 1, "scim_deactivated");
    assert.equal(r.userWritten, true);
    assert.deepEqual(t.ops.slice(0, 3), ["lock_timeout", "user_lock:acme/u1", "scim_users"]);
    assert.ok(isOrdered(t.ops), t.ops.join(" → "));

    t.ops.length = 0;
    await store.markDeletedAndEnqueueTeardown("acme", "u1", "2026-10-01T11:00:00.000Z");
    assert.deepEqual(t.ops.slice(0, 3), ["lock_timeout", "user_lock:acme/u1", "scim_users"]);
    assert.ok(isOrdered(t.ops), t.ops.join(" → "));

    t.ops.length = 0;
    await store.purgeDeletedUser("acme", "u1");
    assert.deepEqual(t.ops.slice(0, 2), ["lock_timeout", "user_lock:acme/u1"]);

    assert.ok(t.txOptions.every((o) => JSON.stringify(o) === JSON.stringify({ isolationLevel: "ReadCommitted", maxWait: 2000, timeout: 5000 })));
  });

  it("deactivateAndRevoke bei Versionskonflikt: User nicht geschrieben, Kappung trotzdem committed", async () => {
    const { db, t } = fakeDb();
    t.scimUser.push({ tenantId: "acme", id: "u1", version: 5, deletionRequestedAt: null, active: true });
    t.providerToken.push({ tenantId: "acme", userId: "u1" });
    const store = new PrismaScimStore(db);
    const r = await store.deactivateAndRevoke({ tenantId: "acme", id: "u1", userName: "x", userNameNormalized: "x", externalId: null,
      active: false, displayName: null, name: null, emails: [], department: null, version: 4, createdAt: "2026-10-01T00:00:00.000Z",
      updatedAt: "2026-10-01T10:00:00.000Z", deprovisionedAt: null }, 3, "scim_deactivated");
    assert.equal(r.userWritten, false);
    assert.equal(t.scimUser[0].active, true);
    assert.equal(t.providerToken.length, 0, "Token trotzdem vernichtet");
  });

  it("withTxRetry: Deadlock/Lock-Timeout → bis zu 3 Versuche, danach StoreBusyError; andere Fehler sofort", async () => {
    let calls = 0;
    const slept: number[] = [];
    const flaky = (codes: unknown[]): PrismaLike => ({
      $transaction: async (fn: (tx: PrismaTx) => Promise<unknown>) => {
        const c = codes[calls++];
        if (c) throw c;
        return fn({} as PrismaTx);
      },
    }) as unknown as PrismaLike;
    const opts = { sleep: async (ms: number) => { slept.push(ms); }, random: () => 0.5 };

    assert.equal(await withTxRetry(flaky([{ code: "P2034" }, { code: "P2010", meta: { code: "55P03" } }]), async () => "ok", opts), "ok");
    assert.deepEqual([calls, slept], [3, [50, 100]]);

    calls = 0;
    await assert.rejects(withTxRetry(flaky([{ code: "P2034" }, { code: "P2034" }, { code: "40P01" }]), async () => "x", opts), StoreBusyError);

    calls = 0;
    await assert.rejects(withTxRetry(flaky([new Error("syntax error")]), async () => "x", opts), /syntax error/);
    assert.equal(calls, 1);
  });
});

