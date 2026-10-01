/**
 * Prisma-Implementierung des ScimStore (PostgreSQL / Aurora).
 *
 * Bewusst gegen ein strukturelles Minimal-Interface typisiert statt gegen den generierten PrismaClient:
 * so kompiliert dieses Modul unabhängig vom generierten Client, und jeder echte PrismaClient mit dem Schema
 * aus prisma/schema.prisma (Repo-Root) erfüllt das Interface.
 *
 * Kern-Garantie (transaktionale Outbox): Kappung und Teardown-Auftrag sind EIN Commit.
 *   pipelines → 'revoked' · provider_tokens → gelöscht · webhook_channels → stop_requested
 *   + Job "subscription.teardown" in job_queue. Den Provider-Aufruf macht ausschließlich der Worker.
 *   Die Transaktion aufzulösen würde Dual-Write-Lücken öffnen (User gesperrt, Job verloren → Abo läuft weiter).
 *
 * Deadlock-Freiheit statt Serializable:
 *   1. READ COMMITTED – keine Serialisierungsabbrüche (40001). Unter SERIALIZABLE scheiterten im Lasttest
 *      (64 parallele Clients, 200 User, On-/Offboarding im Wechsel) rund ein Drittel aller Transaktionen.
 *   2. Feste Sperrreihenfolge: JEDE schreibende Transaktion auf User-Daten nimmt ZUERST
 *      pg_advisory_xact_lock(hashtext(tenant), hashtext(user)) und danach Zeilensperren immer in derselben
 *      Reihenfolge: scim_users → pipelines → provider_tokens → webhook_channels → job_queue.
 *      Gleiche Reihenfolge überall ⇒ kein Warte-Zyklus möglich ⇒ kein Deadlock (Coffman: keine zirkuläre
 *      Wartebedingung). Transaktionen verschiedener User berühren disjunkte Zeilen und warten nie aufeinander.
 *   3. SET LOCAL lock_timeout = 3s: hängt eine Sperre trotzdem, bricht die Transaktion kontrolliert ab statt
 *      den SCIM-Request zu blockieren. withTxRetry wiederholt (Jitter) und meldet danach StoreBusyError → 503.
 *   4. Prisma: maxWait 2 s (Verbindung aus dem Pool), timeout 5 s (gesamte Transaktion).
 *   Pipelines/Tokens anlegende Pfade (Dashboard, OAuth-Callback) MÜSSEN lockUserForWrite() aufrufen und im
 *   selben Commit active = true und deletion_requested_at IS NULL prüfen – sonst entsteht ein Token für einen
 *   gerade deaktivierten User.
 *
 * markDeletedAndEnqueueTeardown (SCIM DELETE) macht im selben Commit aus dem User einen PII-freien Tombstone.
 * Endgültig gelöscht wird er erst nach erfolgreichem Teardown über purgeDeletedUser (Worker).
 *
 * Datenbankzugang: IAM-Datenbank-Authentifizierung, kein Passwort. Prisma bekommt die Verbindung über den
 * Driver-Adapter @prisma/adapter-pg mit dem pg-Pool aus @calensync/core createIamPgPool() – jeder neue
 * Pool-Connect holt sich ein frisches 15-Minuten-Token. Eine statische DATABASE_URL mit Token würde nach
 * 15 Minuten bei neuen Verbindungen scheitern.
 * Ab Commit liest jeder Sync-Worker "revoked" und fasst die Pipeline nicht mehr an (Worker prüft Status vor
 * jedem Provider-Call); Tokens, mit denen er weitermachen könnte, existieren nicht mehr.
 *
 * Audit-Log: Hash-Kette je Mandant (hash = SHA-256(prevHash || kanonisches Event)). Eine nachträgliche
 * Änderung oder Löschung einer Zeile bricht die Kette und ist beim Export (SIEM) nachweisbar.
 */
import { createHash } from "node:crypto";
import {
  TEARDOWN_JOB_KIND,
  teardownDedupeKey,
  type AuditEvent,
  type PipelineRevocationReason,
  type RevocationResult,
  type ScimStore,
  type UserRecord,
  StoreBusyError,
} from "./types.js";

// any statt Record<string, unknown>: Prismas generierte Delegates verlangen exakte Argument-Typen (SelectSubset),
// ein Record mit Index-Signatur wäre dem echten PrismaClient nicht zuweisbar (Rückgabetypen bleiben geprüft).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;

interface CountResult {
  count: number;
}

export interface ScimUserRow {
  id: string;
  tenantId: string;
  userName: string;
  userNameNormalized: string;
  externalId: string | null;
  active: boolean;
  displayName: string | null;
  givenName: string | null;
  familyName: string | null;
  formattedName: string | null;
  emails: unknown;
  department: string | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
  deprovisionedAt: Date | null;
  deletionRequestedAt?: Date | null;
}

export interface PipelineRow {
  id: string;
  tenantId: string;
  ownerUserId: string;
  status: string;
  mode: string | null;
  busyLabel: string | null;
  idempotencyKey: string | null;
}

interface AuditRow {
  seq: bigint | number;
  hash: string;
}

export interface PrismaTx {
  scimUser: {
    findFirst(args: Args): Promise<ScimUserRow | null>;
    findMany(args: Args): Promise<ScimUserRow[]>;
    count(args: Args): Promise<number>;
    create(args: Args): Promise<unknown>;
    updateMany(args: Args): Promise<CountResult>;
    deleteMany(args: Args): Promise<CountResult>;
  };
  pipeline: {
    updateMany(args: Args): Promise<CountResult>;
    count(args: Args): Promise<number>;
    findFirst(args: Args): Promise<PipelineRow | null>;
    create(args: Args): Promise<PipelineRow>;
  };
  providerToken: { deleteMany(args: Args): Promise<CountResult> };
  webhookChannel: { updateMany(args: Args): Promise<CountResult> };
  auditEvent: {
    findFirst(args: Args): Promise<AuditRow | null>;
    create(args: Args): Promise<unknown>;
  };
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
}

export interface PrismaLike extends PrismaTx {
  $transaction<T>(
    fn: (tx: PrismaTx) => Promise<T>,
    options?: { isolationLevel?: "Serializable" | "ReadCommitted"; maxWait?: number; timeout?: number },
  ): Promise<T>;
}

function toRecord(r: ScimUserRow): UserRecord {
  const name =
    r.givenName === null && r.familyName === null && r.formattedName === null
      ? null
      : {
          ...(r.givenName !== null ? { givenName: r.givenName } : {}),
          ...(r.familyName !== null ? { familyName: r.familyName } : {}),
          ...(r.formattedName !== null ? { formatted: r.formattedName } : {}),
        };
  return {
    id: r.id,
    tenantId: r.tenantId,
    userName: r.userName,
    userNameNormalized: r.userNameNormalized,
    externalId: r.externalId,
    active: r.active,
    displayName: r.displayName,
    name,
    emails: Array.isArray(r.emails) ? (r.emails as UserRecord["emails"]) : [],
    department: r.department,
    version: r.version,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
    deprovisionedAt: r.deprovisionedAt ? r.deprovisionedAt.toISOString() : null,
  };
}

function toData(u: UserRecord): Args {
  return {
    userName: u.userName,
    userNameNormalized: u.userNameNormalized,
    externalId: u.externalId,
    active: u.active,
    displayName: u.displayName,
    givenName: u.name?.givenName ?? null,
    familyName: u.name?.familyName ?? null,
    formattedName: u.name?.formatted ?? null,
    emails: u.emails,
    department: u.department,
    version: u.version,
    updatedAt: new Date(u.updatedAt),
    deprovisionedAt: u.deprovisionedAt ? new Date(u.deprovisionedAt) : null,
  };
}

/** Kanonische JSON-Serialisierung (sortierte Schlüssel) für reproduzierbare Hashes. */
function canonical(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  const o = v as Record<string, unknown>;
  return `{${Object.keys(o)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
    .join(",")}}`;
}

/** Transaktionsoptionen für alle User-Schreibvorgänge */
export const USER_TX_OPTIONS = { isolationLevel: "ReadCommitted", maxWait: 2_000, timeout: 5_000 } as const;

/**
 * Erste Anweisung jeder schreibenden User-Transaktion: begrenzt Sperrwartezeit und serialisiert alle
 * Schreibvorgänge EINES Users. Muss vor jeder Zeilensperre stehen (feste Sperrreihenfolge).
 */
export async function lockUserForWrite(tx: PrismaTx, tenantId: string, userId: string): Promise<void> {
  await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${tenantId}), hashtext(${userId}))`;
}

/** Postgres-/Prisma-Fehler, bei denen eine Wiederholung der GANZEN Transaktion sinnvoll ist */
const RETRYABLE_PG = new Set(["40001", "40P01", "55P03"]); // serialization_failure, deadlock_detected, lock_not_available
const RETRYABLE_PRISMA = new Set(["P2034", "P2028"]); // Schreibkonflikt/Deadlock, Transaktions-API (z. B. maxWait)

export function isRetryableTxError(err: unknown): boolean {
  const e = err as { code?: unknown; meta?: { code?: unknown } } | null;
  if (!e || typeof e !== "object") return false;
  if (typeof e.code === "string" && (RETRYABLE_PRISMA.has(e.code) || RETRYABLE_PG.has(e.code))) return true;
  return typeof e.meta?.code === "string" && RETRYABLE_PG.has(e.meta.code);
}

/**
 * Führt fn als Transaktion aus; bei Lock-Timeout/Deadlock/Serialisierungsabbruch bis zu 3 Versuche mit
 * Jitter (25–75 ms, 50–150 ms). Danach StoreBusyError. Sicher, weil jede Transaktion idempotent ist.
 */
export async function withTxRetry<T>(
  db: PrismaLike,
  fn: (tx: PrismaTx) => Promise<T>,
  opts: { attempts?: number; sleep?: (ms: number) => Promise<void>; random?: () => number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const random = opts.random ?? Math.random;
  let last: unknown;
  for (let i = 1; i <= attempts; i++) {
    try {
      return await db.$transaction(fn, USER_TX_OPTIONS);
    } catch (err) {
      if (!isRetryableTxError(err)) throw err;
      last = err;
      if (i < attempts) await sleep(Math.round(50 * 2 ** (i - 1) * (0.5 + random())));
    }
  }
  throw new StoreBusyError(attempts, last);
}

/** Kappung innerhalb einer bestehenden Transaktion; stellt den Teardown-Job im selben Commit ein. */
async function revokeInTx(
  tx: PrismaTx,
  tenantId: string,
  userId: string,
  reason: PipelineRevocationReason,
  now: Date,
  purgeUser: boolean,
): Promise<RevocationResult> {
  const pipelines = await tx.pipeline.updateMany({
    where: { tenantId, ownerUserId: userId, status: { not: "revoked" } },
    data: { status: "revoked", revokedReason: reason, revokedAt: now },
  });
  const tokens = await tx.providerToken.deleteMany({ where: { tenantId, userId } });
  const channels = await tx.webhookChannel.updateMany({
    where: { tenantId, userId, stopRequestedAt: null, stoppedAt: null },
    data: { stopRequestedAt: now },
  });
  // Immer einstellen (Dedupe über den partiellen Unique-Index): ein IdP-Retry heilt so auch einen Teardown,
  // dessen Job früher verloren ging. Ein schon wartender Job desselben Schlüssels bleibt der einzige.
  const payload = JSON.stringify({ userId, purgeUser, requestedAt: now.toISOString() });
  const inserted = await tx.$executeRaw`
    INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
    VALUES (${tenantId}, ${TEARDOWN_JOB_KIND}, ${teardownDedupeKey(userId, purgeUser)}, ${payload}::jsonb, now())
    ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`;
  return {
    pipelinesRevoked: pipelines.count,
    tokensDestroyed: tokens.count,
    subscriptionsQueuedForStop: channels.count,
    teardownJobQueued: inserted === 1,
  };
}

export class PrismaScimStore implements ScimStore {
  constructor(private readonly db: PrismaLike) {}

  async findById(tenantId: string, id: string) {
    const r = await this.db.scimUser.findFirst({ where: { tenantId, id, deletionRequestedAt: null } });
    return r ? toRecord(r) : null;
  }

  async findByUserName(tenantId: string, userNameNormalized: string) {
    const r = await this.db.scimUser.findFirst({ where: { tenantId, userNameNormalized, deletionRequestedAt: null } });
    return r ? toRecord(r) : null;
  }

  async findByExternalId(tenantId: string, externalId: string) {
    const r = await this.db.scimUser.findFirst({ where: { tenantId, externalId, deletionRequestedAt: null } });
    return r ? toRecord(r) : null;
  }

  async list(tenantId: string, offset: number, limit: number) {
    const [total, rows] = await Promise.all([
      this.db.scimUser.count({ where: { tenantId, deletionRequestedAt: null } }),
      this.db.scimUser.findMany({
        where: { tenantId, deletionRequestedAt: null },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        skip: offset,
        take: limit,
      }),
    ]);
    return { total, items: rows.map(toRecord) };
  }

  async insert(u: UserRecord) {
    await this.db.scimUser.create({
      data: { id: u.id, tenantId: u.tenantId, createdAt: new Date(u.createdAt), ...toData(u) },
    });
  }

  async update(u: UserRecord, expectedVersion: number) {
    const res = await this.db.scimUser.updateMany({
      where: { tenantId: u.tenantId, id: u.id, version: expectedVersion, deletionRequestedAt: null },
      data: toData(u),
    });
    return res.count === 1;
  }

  async revokeSyncForUser(tenantId: string, userId: string, reason: PipelineRevocationReason): Promise<RevocationResult> {
    return withTxRetry(this.db, async (tx) => {
      await lockUserForWrite(tx, tenantId, userId);
      return revokeInTx(tx, tenantId, userId, reason, new Date(), false);
    });
  }

  async deactivateAndRevoke(
    u: UserRecord,
    expectedVersion: number,
    reason: PipelineRevocationReason,
  ): Promise<{ revocation: RevocationResult; userWritten: boolean }> {
    return withTxRetry(this.db, async (tx) => {
      await lockUserForWrite(tx, u.tenantId, u.id);
      // Sperrreihenfolge: scim_users → pipelines → provider_tokens → webhook_channels → job_queue
      const written = await tx.scimUser.updateMany({
        where: { tenantId: u.tenantId, id: u.id, version: expectedVersion, deletionRequestedAt: null },
        data: toData(u),
      });
      const revocation = await revokeInTx(tx, u.tenantId, u.id, reason, new Date(u.updatedAt), false);
      return { revocation, userWritten: written.count === 1 };
    });
  }

  async markDeletedAndEnqueueTeardown(tenantId: string, userId: string, atIso: string): Promise<RevocationResult | null> {
    return withTxRetry(this.db, async (tx) => {
      await lockUserForWrite(tx, tenantId, userId);
      const at = new Date(atIso);
      const scrubbed = await tx.scimUser.updateMany({
        where: { tenantId, id: userId, deletionRequestedAt: null },
        data: {
          userName: `deleted-${userId}`,
          userNameNormalized: `deleted-${userId}`,
          externalId: null,
          active: false,
          displayName: null,
          givenName: null,
          familyName: null,
          formattedName: null,
          emails: [],
          department: null,
          version: { increment: 1 },
          updatedAt: at,
          deletionRequestedAt: at,
        },
      });
      if (scrubbed.count !== 1) return null; // existiert nicht oder bereits gelöscht – nichts gesperrt außer dem Advisory-Lock
      await tx.scimUser.updateMany({ where: { tenantId, id: userId, deprovisionedAt: null }, data: { deprovisionedAt: at } });
      return revokeInTx(tx, tenantId, userId, "scim_deleted", at, true);
    });
  }

  async purgeDeletedUser(tenantId: string, userId: string): Promise<boolean> {
    // Nur Tombstones. Gleiche Sperrreihenfolge wie oben (User-Lock → scim_users → per Cascade pipelines).
    // webhook_channels hängen bewusst nicht per Cascade am User.
    return withTxRetry(this.db, async (tx) => {
      await lockUserForWrite(tx, tenantId, userId);
      const res = await tx.scimUser.deleteMany({ where: { tenantId, id: userId, deletionRequestedAt: { not: null } } });
      return res.count === 1;
    });
  }

  async appendAudit(e: AuditEvent) {
    await this.db.$transaction(async (tx) => {
      // Serialisiert die Kette je Mandant (transaktionsgebundener Advisory Lock)
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"audit:" + e.tenantId}))`;
      const last = await tx.auditEvent.findFirst({
        where: { tenantId: e.tenantId },
        orderBy: { seq: "desc" },
        select: { seq: true, hash: true },
      });
      const prevHash = last?.hash ?? "0".repeat(64);
      const payload = canonical({ ...e, prevHash });
      const hash = createHash("sha256").update(prevHash).update(payload).digest("hex");
      await tx.auditEvent.create({
        data: {
          tenantId: e.tenantId,
          requestId: e.requestId,
          actor: e.actor,
          action: e.action,
          targetUserId: e.targetUserId,
          outcome: e.outcome,
          detail: e.detail,
          at: new Date(e.at),
          prevHash,
          hash,
        },
      });
    });
  }
}
