/**
 * Pipeline anlegen (Dashboard: „Kalender verbinden“) – race-frei gegen gleichzeitiges Offboarding.
 *
 * Ablauf in EINER Transaktion (Read Committed) nach dem Sperrprotokoll aus scim/src/prismaStore.ts:
 *   1. lockUserForWrite()             pg_advisory_xact_lock(tenant, user) – dieselbe Sperre wie SCIM-Deaktivierung
 *   2. User lesen                     erst NACH der Sperre → frischer Snapshot: aktiv und nicht gelöscht?
 *   2b. Ziel gegen die Allowlist      (core/src/syncTargets.ts, rein funktional; userName aus Schritt 2)
 *                                     nicht erlaubt → target_not_allowed (422), nichts geschrieben
 *   3. Idempotency-Key prüfen         gleicher Key + gleiche Nutzlast → vorhandene Pipeline zurück;
 *                                     gleicher Key + andere Nutzlast → idempotency_conflict (422)
 *   4. Limit prüfen                   max. aktive (nicht revoked) Pipelines je User – exakt, weil serialisiert
 *   5. Pipeline anlegen (pending)     + Job "pipeline.handshake" in job_queue – derselbe Commit (Outbox)
 *
 * Weil SCIM-Deaktivierung und -Löschung dieselbe Sperre zuerst nehmen, gibt es nur zwei Reihenfolgen:
 *   Deaktivierung zuerst → Schritt 2 sieht active = false → 404, keine Pipeline
 *   Anlage zuerst        → Deaktivierung sieht die neue Pipeline und setzt sie auf revoked
 * Ein gesperrter User kann so nie eine aktive Pipeline behalten (im pgbench-Test geprüft).
 */
import { randomUUID } from "node:crypto";
import { TEARDOWN_JOB_KIND } from "../../core/src/teardownJob.js";
import { CLEANUP_KIND } from "../../core/src/cleanupWorker.js";
import { teardownDedupeKey } from "../../scim/src/types.js";
import { lockUserForWrite, withTxRetry, type PipelineRow, type PrismaLike } from "../../scim/src/prismaStore.js";
import {
  EMPTY_ALLOWLIST, fullModeAllowed, parseTargetRequest, resolveSyncTarget, targetLabel,
  type ResolvedTarget, type SyncAllowlist, type SyncTargetKind, type TargetRejection, type TargetRequest,
} from "../../core/src/syncTargets.js";
import type { IdentitySubject, IdentityVerdict } from "../../core/src/identity.js";

/** Graph-Prüfung "dieselbe Person" (core/src/identity.ts); läuft VOR der Transaktion, nie unter der User-Sperre */
export type IdentityCheck = (tenantId: string, s: IdentitySubject) => Promise<IdentityVerdict>;

export type PipelineMode = "busy" | "full";

export interface CreatePipelineInput {
  tenantId: string;
  /** Entra-Objekt-ID aus dem geprüften Token (scim_users.external_id) */
  entraObjectId: string;
  mode: PipelineMode;
  busyLabel: string | null;
  idempotencyKey: string;
  /** gewünschtes Ziel (syntaktisch geprüft); erlaubt ist es erst nach resolveSyncTarget im Store */
  target: TargetRequest;
}

export interface PipelineDto {
  id: string;
  status: string;
  mode: PipelineMode;
  busyLabel: string | null;
  /** Anzeige: Zielart + Label – nie ein Postfach (Google: provider "google") */
  target?: { kind: SyncTargetKind; label: string | null; provider?: "google" } | null;
}

export type CreatePipelineResult =
  | { kind: "created" | "replayed"; pipeline: PipelineDto }
  | { kind: "user_not_provisioned" }
  | { kind: "target_not_allowed"; reason: TargetRejection }
  /** Graph vorübergehend nicht erreichbar → 503 + Retry-After, nie "erlaubt" */
  | { kind: "identity_unavailable"; retryAfterSeconds: number }
  | { kind: "idempotency_conflict" }
  | { kind: "limit_reached"; limit: number };

export interface EndPipelineInput {
  tenantId: string;
  entraObjectId: string;
  pipelineId: string;
}

export interface EndedPipelineDto {
  id: string;
  status: "revoked";
  /** pending = Zieltermine werden gerade entfernt; done = nichts mehr von CalenSync im Zielkalender */
  cleanup: "pending" | "done";
}

export type EndPipelineResult =
  | { kind: "ended" | "already_ended"; pipeline: EndedPipelineDto }
  | { kind: "user_not_provisioned" }
  | { kind: "not_found" };

export interface PipelineStore {
  createPipeline(input: CreatePipelineInput): Promise<CreatePipelineResult>;
  /** DELETE /api/v1/me/pipelines/{id} – fehlt es, antwortet die Route 404 */
  endPipeline?(input: EndPipelineInput): Promise<EndPipelineResult>;
}

type StoredPipeline = PipelineRow & { targetKind?: string | null; targetMailbox?: string | null; targetEntraTenantId?: string | null; targetRef?: string | null;
  targetProvider?: string | null; targetWorkspaceId?: string | null };

const toDto = (p: StoredPipeline, allow: SyncAllowlist): PipelineDto => ({
  id: p.id, status: p.status, mode: (p.mode === "full" ? "full" : "busy") as PipelineMode, busyLabel: p.busyLabel,
  target: targetLabel(allow, { kind: p.targetKind ?? null, mailbox: p.targetMailbox ?? null, entraTenantId: p.targetEntraTenantId ?? null, ref: p.targetRef ?? null,
    provider: p.targetProvider ?? null, workspaceId: p.targetWorkspaceId ?? null }),
});
const providerOf = (t: Pick<ResolvedTarget, "provider">): "microsoft" | "google" => t.provider ?? "microsoft";

export class PrismaPipelineStore implements PipelineStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly maxActivePipelines = 5,
    private readonly newId: () => string = randomUUID,
    /** Admin-Allowlist der Sync-Ziele (APP_CONFIG); leer = kein Ziel wählbar */
    private readonly targets: SyncAllowlist = EMPTY_ALLOWLIST,
    /** fehlt sie, sind account-Ziele (außer Opt-in localPart) nicht anlegbar */
    private readonly identity?: IdentityCheck,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Ziel + Modus + dieselbe Person – ohne DB-Sperre (Graph-Aufruf). Ergebnis wird unter der Sperre erneut geprüft. */
  private async precheck(i: CreatePipelineInput, ownerUserName: string | null, ownerObjectId: string | null):
      Promise<{ ok: true; target: ResolvedTarget; verifiedAttribute: string | null } | { ok: false; result: CreatePipelineResult }> {
    const t = resolveSyncTarget(this.targets, ownerUserName, i.target);
    if (!t.ok) return { ok: false, result: { kind: "target_not_allowed", reason: t.reason } };
    if (i.mode === "full" && !fullModeAllowed(this.targets, t.target)) {
      return { ok: false, result: { kind: "target_not_allowed", reason: "full_mode_not_allowed" } };
    }
    if (t.target.kind !== "account") return { ok: true, target: t.target, verifiedAttribute: null };
    const attribute = t.target.identityAttribute ?? "employeeId";
    if (attribute === "localPart") return { ok: true, target: t.target, verifiedAttribute: "localPart" };
    if (!this.identity || !ownerObjectId) return { ok: false, result: { kind: "target_not_allowed", reason: "identity_unverified" } };
    // Google: Directory API + Graph (Dispatcher in main.ts); Microsoft: Graph in beiden Mandanten
    const v = await this.identity(i.tenantId, { ownerObjectId, mailbox: t.target.mailbox ?? "", entraTenantId: t.target.entraTenantId, attribute,
      ...(providerOf(t.target) === "google" ? { provider: "google" as const, workspaceId: t.target.workspaceId ?? null } : {}) });
    if (v.kind === "unavailable") {
      const sec = Number(v.retryAfter);
      return { ok: false, result: { kind: "identity_unavailable", retryAfterSeconds: Number.isFinite(sec) && sec > 0 ? Math.min(Math.ceil(sec), 300) : 5 } };
    }
    if (v.kind === "rejected") return { ok: false, result: { kind: "target_not_allowed", reason: "identity_unverified" } };
    return { ok: true, target: t.target, verifiedAttribute: attribute };
  }

  endPipeline(i: EndPipelineInput): Promise<EndPipelineResult> {
    return endPipelineInStore(this.db, i);
  }

  async createPipeline(i: CreatePipelineInput): Promise<CreatePipelineResult> {
    // User-ID vorab ohne Sperre auflösen (nur für den Sperrschlüssel); maßgeblich ist die Prüfung NACH der Sperre
    const pre = await this.db.scimUser.findFirst({
      where: { tenantId: i.tenantId, externalId: i.entraObjectId, deletionRequestedAt: null },
      select: { id: true, userName: true },
    });
    if (!pre) return { kind: "user_not_provisioned" };
    const userId = pre.id;
    // Ziel/Modus/Person VOR der Sperre (Graph-Aufruf darf die SCIM-Sperre nie halten); Objekt-ID = oid aus dem Token
    const pc = await this.precheck(i, pre.userName ?? null, i.entraObjectId);
    if (!pc.ok) return pc.result;
    const verifiedAt = pc.verifiedAttribute && pc.verifiedAttribute !== "localPart" ? this.now() : null;

    return withTxRetry(this.db, async (tx) => {
      await lockUserForWrite(tx, i.tenantId, userId);

      const user = await tx.scimUser.findFirst({
        where: { tenantId: i.tenantId, id: userId, active: true, deletionRequestedAt: null },
        select: { id: true, createdAt: true, userName: true },
      });
      if (!user) return { kind: "user_not_provisioned" } as const;

      // Ziel erneut NACH der Sperre (frischer userName); muss dasselbe Ziel ergeben wie die Vorprüfung
      const t = resolveSyncTarget(this.targets, user.userName ?? null, i.target);
      if (!t.ok) return { kind: "target_not_allowed", reason: t.reason } as const;
      const target = t.target;
      if (target.mailbox !== pc.target.mailbox || target.entraTenantId !== pc.target.entraTenantId
          || providerOf(target) !== providerOf(pc.target) || (target.workspaceId ?? null) !== (pc.target.workspaceId ?? null)) {
        return { kind: "target_not_allowed", reason: "identity_unverified" } as const;
      }

      const existing = await tx.pipeline.findFirst({
        where: { tenantId: i.tenantId, ownerUserId: userId, idempotencyKey: i.idempotencyKey },
      });
      if (existing) {
        // Gleicher Key mit anderer Nutzlast ist ein Client-Fehler – nie still die alte Pipeline zurückgeben
        const ex = existing as StoredPipeline;
        const same = existing.mode === i.mode && (existing.busyLabel ?? null) === i.busyLabel
          && (ex.targetKind ?? null) === target.kind && (ex.targetMailbox ?? null) === target.mailbox
          && (ex.targetEntraTenantId ?? null) === target.entraTenantId && (ex.targetRef ?? null) === target.ref
          && (ex.targetProvider ?? "microsoft") === providerOf(target) && (ex.targetWorkspaceId ?? null) === (target.workspaceId ?? null);
        return same ? ({ kind: "replayed", pipeline: toDto(ex, this.targets) } as const) : ({ kind: "idempotency_conflict" } as const);
      }

      const active = await tx.pipeline.count({ where: { tenantId: i.tenantId, ownerUserId: userId, status: { not: "revoked" } } });
      if (active >= this.maxActivePipelines) return { kind: "limit_reached", limit: this.maxActivePipelines } as const;

      const created = await tx.pipeline.create({
        data: {
          id: this.newId(),
          tenantId: i.tenantId,
          ownerUserId: userId,
          status: "pending",
          mode: i.mode,
          busyLabel: i.busyLabel,
          idempotencyKey: i.idempotencyKey,
          targetKind: target.kind,
          targetMailbox: target.mailbox,
          targetEntraTenantId: target.entraTenantId,
          targetRef: target.ref,
          targetProvider: providerOf(target),
          targetWorkspaceId: target.workspaceId ?? null,
          identityVerifiedAt: verifiedAt,
          identityAttribute: pc.verifiedAttribute,
        },
      });

      // Handshake-Job im selben Commit; grantedAt = Provisionierung (Anker für das 403-Propagationsfenster)
      const payload = JSON.stringify({
        pipelineId: created.id,
        userId,
        grantedAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : null,
        attempts: {},
      });
      await tx.$executeRaw`
        INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
        VALUES (${i.tenantId}, ${"pipeline.handshake"}, ${`handshake:${created.id}`}, ${payload}::jsonb, now())
        ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`;

      return { kind: "created", pipeline: toDto(created as StoredPipeline, this.targets) } as const;
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// Pipeline beenden (DELETE /api/v1/me/pipelines/{id}) – gleiche Sperre und Outbox wie die SCIM-Kappung:
//   Sperre → User aktiv? → eigene Pipeline? → revoked + cleanup_requested_at → Abos dieser Pipeline stop_requested
//   → Job subscription.teardown (stoppt nur angeforderte Abos bzw. die nicht aktiver Pipelines) → Job
//   pipeline.target_cleanup (entfernt alle von CalenSync angelegten Zieltermine). Alles EIN Commit.
// Reihenfolge scim_users → pipelines → webhook_channels → job_queue (ENTERPRISE-ARCHITEKTUR.md §7).
// ---------------------------------------------------------------------------------------------------
type CleanupCols = { cleanupRequestedAt?: Date | null; cleanupDoneAt?: Date | null };
const cleanupState = (p: CleanupCols): "pending" | "done" => (p.cleanupRequestedAt && !p.cleanupDoneAt ? "pending" : "done");

export async function endPipelineInStore(db: PrismaLike, i: EndPipelineInput, now: () => Date = () => new Date()): Promise<EndPipelineResult> {
  const pre = await db.scimUser.findFirst({
    where: { tenantId: i.tenantId, externalId: i.entraObjectId, deletionRequestedAt: null },
    select: { id: true },
  });
  if (!pre) return { kind: "user_not_provisioned" };
  const userId = pre.id;
  return withTxRetry(db, async (tx) => {
    await lockUserForWrite(tx, i.tenantId, userId);
    const user = await tx.scimUser.findFirst({
      where: { tenantId: i.tenantId, id: userId, active: true, deletionRequestedAt: null },
      select: { id: true },
    });
    if (!user) return { kind: "user_not_provisioned" } as const;
    // Nur eigene Pipelines; fremde IDs sind nicht von unbekannten zu unterscheiden (404, nie 403)
    const p = await tx.pipeline.findFirst({ where: { tenantId: i.tenantId, id: i.pipelineId, ownerUserId: userId } });
    if (!p) return { kind: "not_found" } as const;
    if (p.status === "revoked") {
      return { kind: "already_ended", pipeline: { id: p.id, status: "revoked", cleanup: cleanupState(p as CleanupCols) } } as const;
    }
    const at = now();
    await tx.pipeline.updateMany({
      where: { tenantId: i.tenantId, id: p.id, ownerUserId: userId, status: { not: "revoked" } },
      data: { status: "revoked", revokedReason: "user_ended", revokedAt: at, cleanupRequestedAt: at },
    });
    await tx.webhookChannel.updateMany({
      where: { tenantId: i.tenantId, pipelineId: p.id, stopRequestedAt: null, stoppedAt: null },
      data: { stopRequestedAt: at },
    });
    const teardown = JSON.stringify({ userId, purgeUser: false, requestedAt: at.toISOString() });
    await tx.$executeRaw`
      INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
      VALUES (${i.tenantId}, ${TEARDOWN_JOB_KIND}, ${teardownDedupeKey(userId, false)}, ${teardown}::jsonb, now())
      ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`;
    const cleanup = JSON.stringify({ pipelineId: p.id });
    await tx.$executeRaw`
      INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
      VALUES (${i.tenantId}, ${CLEANUP_KIND}, ${`cleanup:${p.id}`}, ${cleanup}::jsonb, now())
      ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`;
    return { kind: "ended", pipeline: { id: p.id, status: "revoked", cleanup: "pending" } } as const;
  });
}

// ---------------------------------------------------------------------------------------------------
// Eingabeprüfung für POST /api/v1/me/pipelines (strikt: unbekannte Felder → Fehler)
// ---------------------------------------------------------------------------------------------------
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
// eslint-disable-next-line no-control-regex -- Steuerzeichen und Bidi-Overrides gezielt ausschließen
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/;

export type BodyCheck =
  | { ok: true; mode: PipelineMode; busyLabel: string | null; target: TargetRequest }
  /** status 422 nur für target_required, sonst 400 */
  | { ok: false; error: string; status?: 422 };

export function parseIdempotencyKey(v: string | string[] | undefined): string | null {
  return typeof v === "string" && IDEMPOTENCY_KEY.test(v) ? v : null;
}

export function parseCreatePipelineBody(body: unknown): BodyCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body_must_be_object" };
  const keys = Object.keys(body);
  for (const k of keys) if (k !== "mode" && k !== "busyLabel" && k !== "target") return { ok: false, error: `unknown_field:${k.slice(0, 32)}` };
  const o = body as { mode?: unknown; busyLabel?: unknown; target?: unknown };
  if (o.mode !== "busy" && o.mode !== "full") return { ok: false, error: "mode_must_be_busy_or_full" };
  let busyLabel: string | null = null;
  if (o.busyLabel !== undefined && o.busyLabel !== null) {
    if (typeof o.busyLabel !== "string") return { ok: false, error: "busyLabel_must_be_string" };
    const label = o.busyLabel.normalize("NFC").trim();
    if (label.length < 1 || label.length > 64) return { ok: false, error: "busyLabel_length_1_64" };
    if (LABEL_FORBIDDEN.test(label)) return { ok: false, error: "busyLabel_invalid_characters" };
    busyLabel = label;
  }
  if (o.mode === "full" && busyLabel !== null) return { ok: false, error: "busyLabel_only_for_busy" };
  if (o.target === undefined || o.target === null) return { ok: false, error: "target_required", status: 422 };
  const t = parseTargetRequest(o.target);
  if (!t.ok) return { ok: false, error: t.error };
  return { ok: true, mode: o.mode, busyLabel, target: t.target };
}
