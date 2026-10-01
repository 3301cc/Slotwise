import {
  TEARDOWN_JOB_KIND,
  teardownDedupeKey,
  type AuditEvent,
  type PipelineRevocationReason,
  type RevocationResult,
  type ScimStore,
  type TeardownJobPayload,
  type UserRecord,
} from "./types.js";

/**
 * In-Memory-Implementierung für Tests und lokale Entwicklung. Bildet dieselben Garantien ab wie die
 * Prisma-Variante (Mandantentrennung, Optimistic Locking, idempotente Kappung) – NICHT für Produktion.
 */
export interface MemPipeline {
  id: string;
  tenantId: string;
  ownerUserId: string;
  status: "active" | "paused" | "revoked";
  revokedReason: string | null;
}

export interface MemToken {
  tenantId: string;
  userId: string;
  provider: "microsoft" | "google";
}

export interface MemSubscription {
  tenantId: string;
  userId: string;
  state: "active" | "stop_requested" | "stopped";
}

export interface MemJob {
  kind: string;
  dedupeKey: string;
  payload: TeardownJobPayload;
  status: "queued" | "running" | "done";
}

export class MemoryScimStore implements ScimStore {
  users = new Map<string, UserRecord>();
  /** Schlüssel tenant::id → deletion_requested_at */
  tombstones = new Map<string, string>();
  jobs: MemJob[] = [];
  pipelines: MemPipeline[] = [];
  tokens: MemToken[] = [];
  subscriptions: MemSubscription[] = [];
  auditLog: AuditEvent[] = [];
  revokeCalls = 0;

  private key(tenantId: string, id: string): string {
    return `${tenantId}::${id}`;
  }

  private visible(u: UserRecord): boolean {
    return !this.tombstones.has(this.key(u.tenantId, u.id));
  }

  async findById(tenantId: string, id: string) {
    const u = this.users.get(this.key(tenantId, id));
    return u && this.visible(u) ? structuredClone(u) : null;
  }

  async findByUserName(tenantId: string, n: string) {
    for (const u of this.users.values()) if (u.tenantId === tenantId && u.userNameNormalized === n && this.visible(u)) return structuredClone(u);
    return null;
  }

  async findByExternalId(tenantId: string, externalId: string) {
    for (const u of this.users.values()) if (u.tenantId === tenantId && u.externalId === externalId && this.visible(u)) return structuredClone(u);
    return null;
  }

  async list(tenantId: string, offset: number, limit: number) {
    const all = [...this.users.values()]
      .filter((u) => u.tenantId === tenantId && this.visible(u))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
    return { total: all.length, items: all.slice(offset, offset + limit).map((u) => structuredClone(u)) };
  }

  async insert(user: UserRecord) {
    this.users.set(this.key(user.tenantId, user.id), structuredClone(user));
  }

  async update(user: UserRecord, expectedVersion: number) {
    const k = this.key(user.tenantId, user.id);
    const cur = this.users.get(k);
    if (!cur || this.tombstones.has(k) || cur.version !== expectedVersion) return false;
    this.users.set(k, structuredClone(user));
    return true;
  }

  async revokeSyncForUser(tenantId: string, userId: string, reason: PipelineRevocationReason): Promise<RevocationResult> {
    const r = this.revokeCore(tenantId, userId, reason);
    return { ...r, teardownJobQueued: this.enqueueTeardown(userId, false, new Date().toISOString()) };
  }

  async deactivateAndRevoke(user: UserRecord, expectedVersion: number, reason: PipelineRevocationReason) {
    // Single-threaded: die Methode läuft ohne await-Unterbrechung und ist damit atomar wie die DB-Transaktion
    const k = this.key(user.tenantId, user.id);
    const cur = this.users.get(k);
    const userWritten = !!cur && !this.tombstones.has(k) && cur.version === expectedVersion;
    if (userWritten) this.users.set(k, structuredClone(user));
    const r = this.revokeCore(user.tenantId, user.id, reason);
    return { revocation: { ...r, teardownJobQueued: this.enqueueTeardown(user.id, false, user.updatedAt) }, userWritten };
  }

  private revokeCore(tenantId: string, userId: string, reason: PipelineRevocationReason) {
    this.revokeCalls++;
    let pipelinesRevoked = 0;
    for (const p of this.pipelines) {
      if (p.tenantId === tenantId && p.ownerUserId === userId && p.status !== "revoked") {
        p.status = "revoked";
        p.revokedReason = reason;
        pipelinesRevoked++;
      }
    }
    const before = this.tokens.length;
    this.tokens = this.tokens.filter((t) => !(t.tenantId === tenantId && t.userId === userId));
    let subscriptionsQueuedForStop = 0;
    for (const s of this.subscriptions) {
      if (s.tenantId === tenantId && s.userId === userId && s.state === "active") {
        s.state = "stop_requested";
        subscriptionsQueuedForStop++;
      }
    }
    return { pipelinesRevoked, tokensDestroyed: before - this.tokens.length, subscriptionsQueuedForStop };
  }

  /** Nachbildung von INSERT … ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING */
  private enqueueTeardown(userId: string, purgeUser: boolean, requestedAt: string): boolean {
    const dedupeKey = teardownDedupeKey(userId, purgeUser);
    if (this.jobs.some((j) => j.kind === TEARDOWN_JOB_KIND && j.dedupeKey === dedupeKey && j.status === "queued")) return false;
    this.jobs.push({ kind: TEARDOWN_JOB_KIND, dedupeKey, payload: { userId, purgeUser, requestedAt }, status: "queued" });
    return true;
  }

  async markDeletedAndEnqueueTeardown(tenantId: string, userId: string, atIso: string): Promise<RevocationResult | null> {
    const k = this.key(tenantId, userId);
    const u = this.users.get(k);
    if (!u || this.tombstones.has(k)) return null;
    const r = this.revokeCore(tenantId, userId, "scim_deleted");
    // PII sofort entfernen; übrig bleibt nur die interne ID bis zum Purge
    this.users.set(k, {
      ...u,
      userName: `deleted-${u.id}`,
      userNameNormalized: `deleted-${u.id}`,
      externalId: null,
      active: false,
      displayName: null,
      name: null,
      emails: [],
      department: null,
      version: u.version + 1,
      updatedAt: atIso,
      deprovisionedAt: u.deprovisionedAt ?? atIso,
    });
    this.tombstones.set(k, atIso);
    return { ...r, teardownJobQueued: this.enqueueTeardown(userId, true, atIso) };
  }

  async purgeDeletedUser(tenantId: string, userId: string): Promise<boolean> {
    const k = this.key(tenantId, userId);
    if (!this.tombstones.has(k)) return false;
    this.tombstones.delete(k);
    this.users.delete(k);
    this.pipelines = this.pipelines.filter((p) => !(p.tenantId === tenantId && p.ownerUserId === userId)); // FK-Cascade
    return true;
  }

  async appendAudit(event: AuditEvent) {
    this.auditLog.push(structuredClone(event));
  }
}
