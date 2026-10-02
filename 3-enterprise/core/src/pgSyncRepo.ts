/**
 * Postgres-Implementierung für den Sync-Worker (SyncRepo), den SyncScheduler und die Busy-API der Buchungsseite.
 *
 * Jede Methode ist EINE Anweisung (kein gehaltener Client, keine Transaktion über einen Provider-Aufruf hinweg).
 * Sperrreihenfolge wie ENTERPRISE-ARCHITEKTUR.md §7 (scim_users → pipelines → … → job_queue): Anweisungen, die
 * mehrere Tabellen berühren, lesen/sperren pipelines vor sync_event_map. Die SCIM-Kappung (revokeInTx) setzt
 * pipelines.status in ihrer Transaktion; der Worker liest den Status vor jedem Provider-Aufruf neu
 * (getSyncContext) und schreibt nie den Status einer revoked-Pipeline um.
 *
 * Gespeichert werden nur IDs, Zeiten, changeKey, Delta-Link und Fehler-CODES – nie Termininhalte.
 */
import type { PgLike } from "./retryQueue.js";
import type { MapRow, SyncContext, SyncRepo, SyncScheduleRepo } from "./syncWorker.js";
import { SYNC_KIND } from "./syncWorker.js";
import type { CleanupContext, CleanupRepo } from "./cleanupWorker.js";
import type { PendingCleanups } from "./teardownJob.js";

const bool = (v: unknown): boolean => v === true || v === "t" || v === "true";
const date = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(v as string));

type CtxRow = {
  status: string;
  owner_active: boolean | string;
  entra_object_id: string | null;
  user_name: string | null;
  mode: string | null;
  busy_label: string | null;
  target_kind: string | null;
  target_mailbox: string | null;
  target_entra_tenant_id: string | null;
  target_ref: string | null;
  target_provider: string | null;
  target_workspace_id: string | null;
  source_delta_link: string | null;
  source_delta_started_at: Date | string | null;
  created_at: Date | string | null;
  identity_verified_at: Date | string | null;
  identity_attribute: string | null;
  effective_mode: string | null;
};

type MapDbRow = { source_event_id: string; target_event_id: string | null; change_key: string | null; start_at: Date | string; end_at: Date | string; archived: boolean | string };
const toMap = (r: MapDbRow): MapRow => ({
  sourceEventId: r.source_event_id, targetEventId: r.target_event_id, changeKey: r.change_key,
  startAt: new Date(r.start_at), endAt: new Date(r.end_at), archived: bool(r.archived),
});
const MAP_COLS = `source_event_id, target_event_id, change_key, start_at, end_at, (archived_at IS NOT NULL) AS archived`;

export interface BusyInterval {
  start: Date;
  end: Date;
}

export interface BusyRepo {
  /**
   * ZUSAMMENGEFASSTE Belegt-Intervalle aller aktiven booking-Pipelines des Mandanten, auf [from, to) beschnitten,
   * ohne Nutzerbezug. Mehr als maxIntervals zusammengefasste Intervalle → BusyTooManyError (nie stilles Abschneiden).
   */
  busyIntervals(tenantId: string, from: Date, to: Date, maxIntervals?: number): Promise<BusyInterval[]>;
}

/** Ergebnis wäre größer als die harte Obergrenze → API antwortet 503 busy_too_many */
export class BusyTooManyError extends Error {
  constructor(readonly max: number) {
    super(`mehr als ${max} Belegt-Intervalle`);
  }
}
export const BUSY_MAX_INTERVALS = 5_000;

export class PgSyncRepo implements SyncRepo, SyncScheduleRepo, BusyRepo, CleanupRepo, PendingCleanups {
  constructor(private readonly pool: PgLike) {}

  async getCleanupContext(tenantId: string, pipelineId: string): Promise<CleanupContext | null> {
    // Bewusst OHNE Join auf scim_users: nach SCIM-DELETE ist der Nutzer ein PII-freier Tombstone
    const res = await this.pool.query<{ status: string; target_kind: string | null; target_mailbox: string | null;
      target_entra_tenant_id: string | null; target_ref: string | null; target_provider: string | null; target_workspace_id: string | null;
      cleanup_requested_at: Date | string | null; cleanup_done_at: Date | string | null }>(
      `SELECT status, target_kind, target_mailbox, target_entra_tenant_id, target_ref, target_provider, target_workspace_id,
              cleanup_requested_at, cleanup_done_at
         FROM pipelines WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pipelineId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      status: r.status,
      target: { kind: r.target_kind, mailbox: r.target_mailbox, entraTenantId: r.target_entra_tenant_id, ref: r.target_ref,
        provider: r.target_provider ?? "microsoft", workspaceId: r.target_workspace_id },
      cleanupRequestedAt: date(r.cleanup_requested_at),
      cleanupDoneAt: date(r.cleanup_done_at),
    };
  }

  /** EINE Anweisung, Reihenfolge pipelines → sync_event_map; nur wenn die Bereinigung noch offen ist */
  async completeCleanup(tenantId: string, pipelineId: string): Promise<void> {
    await this.pool.query(
      `WITH done AS (
         UPDATE pipelines
            SET cleanup_done_at = now(), target_mailbox = NULL, source_delta_link = NULL, source_delta_started_at = NULL,
                sync_lease_owner = NULL, sync_lease_until = NULL,
                last_sync_error = CASE WHEN last_sync_error LIKE 'cleanup_%' THEN NULL ELSE last_sync_error END
          WHERE tenant_id = $1 AND id = $2 AND cleanup_requested_at IS NOT NULL AND cleanup_done_at IS NULL
         RETURNING id
       )
       DELETE FROM sync_event_map m USING done WHERE m.pipeline_id = done.id`,
      [tenantId, pipelineId],
    );
  }

  async pendingCleanupsForUser(tenantId: string, userId: string): Promise<number> {
    const res = await this.pool.query<{ n: number | string }>(
      `SELECT count(*) AS n FROM pipelines
        WHERE tenant_id = $1 AND owner_user_id = $2 AND cleanup_requested_at IS NOT NULL AND cleanup_done_at IS NULL`,
      [tenantId, userId],
    );
    return Number(res.rows[0]?.n ?? 0);
  }

  async getSyncContext(tenantId: string, pipelineId: string): Promise<SyncContext | null> {
    const res = await this.pool.query<CtxRow>(
      `SELECT p.status, (u.active AND u.deletion_requested_at IS NULL) AS owner_active,
              u.external_id AS entra_object_id, u.user_name, p.mode, p.busy_label,
              p.target_kind, p.target_mailbox, p.target_entra_tenant_id, p.target_ref, p.target_provider, p.target_workspace_id,
              p.source_delta_link, p.source_delta_started_at, p.created_at,
              p.identity_verified_at, p.identity_attribute, p.effective_mode
         FROM pipelines p JOIN scim_users u ON u.id = p.owner_user_id AND u.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, pipelineId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      status: r.status,
      ownerActive: bool(r.owner_active),
      ownerEntraObjectId: r.entra_object_id,
      ownerUserName: r.user_name,
      mode: r.mode === "full" ? "full" : "busy",
      busyLabel: r.busy_label,
      target: { kind: r.target_kind, mailbox: r.target_mailbox, entraTenantId: r.target_entra_tenant_id, ref: r.target_ref,
        provider: r.target_provider ?? "microsoft", workspaceId: r.target_workspace_id },
      deltaLink: r.source_delta_link,
      deltaStartedAt: date(r.source_delta_started_at),
      createdAt: date(r.created_at),
      identityVerifiedAt: date(r.identity_verified_at),
      identityAttribute: r.identity_attribute,
      effectiveMode: r.effective_mode === "full" || r.effective_mode === "busy" ? r.effective_mode : null,
    };
  }

  async acquireSyncLease(tenantId: string, pipelineId: string, owner: string, leaseMs: number): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE pipelines SET sync_lease_owner = $3, sync_lease_until = now() + ($4::bigint * interval '1 millisecond')
        WHERE tenant_id = $1 AND id = $2
          AND (sync_lease_until IS NULL OR sync_lease_until < now() OR sync_lease_owner = $3)`,
      [tenantId, pipelineId, owner, Math.max(1, Math.round(leaseMs))],
    );
    return res.rowCount === 1;
  }

  async releaseSyncLease(tenantId: string, pipelineId: string, owner: string): Promise<void> {
    await this.pool.query(
      `UPDATE pipelines SET sync_lease_owner = NULL, sync_lease_until = NULL
        WHERE tenant_id = $1 AND id = $2 AND sync_lease_owner = $3`,
      [tenantId, pipelineId, owner],
    );
  }

  async getMappings(pipelineId: string, sourceEventIds: readonly string[]): Promise<Map<string, MapRow>> {
    if (sourceEventIds.length === 0) return new Map();
    const res = await this.pool.query<MapDbRow>(
      `SELECT ${MAP_COLS} FROM sync_event_map
        WHERE pipeline_id = $1 AND source_event_id = ANY($2::text[])`,
      [pipelineId, [...sourceEventIds]],
    );
    return new Map(res.rows.map((r) => [r.source_event_id, toMap(r)]));
  }

  async listMappings(pipelineId: string): Promise<MapRow[]> {
    const res = await this.pool.query<MapDbRow>(
      `SELECT ${MAP_COLS} FROM sync_event_map WHERE pipeline_id = $1`,
      [pipelineId],
    );
    return res.rows.map(toMap);
  }

  async findCalensyncTargetIds(tenantId: string, eventIds: readonly string[]): Promise<Set<string>> {
    if (eventIds.length === 0) return new Set();
    const res = await this.pool.query<{ target_event_id: string }>(
      `SELECT DISTINCT target_event_id FROM sync_event_map WHERE tenant_id = $1 AND target_event_id = ANY($2::text[])`,
      [tenantId, [...eventIds]],
    );
    return new Set(res.rows.map((r) => r.target_event_id));
  }

  /**
   * Upsert nur, solange die Pipeline existiert (kein FK-Fehler nach einem Purge). Bewusst auch für eine gerade
   * widerrufene Pipeline: Ein bereits angelegter Zieltermin soll in der Zuordnung stehen (Nachweis, Aufräumen).
   */
  async upsertMapping(tenantId: string, pipelineId: string, row: MapRow): Promise<void> {
    await this.pool.query(
      `INSERT INTO sync_event_map (tenant_id, pipeline_id, source_event_id, target_event_id, change_key, start_at, end_at, updated_at)
       SELECT p.tenant_id, p.id, $3, $4, $5, $6::timestamptz, $7::timestamptz, now()
         FROM pipelines p WHERE p.tenant_id = $1 AND p.id = $2
       ON CONFLICT (pipeline_id, source_event_id) DO UPDATE
         SET target_event_id = EXCLUDED.target_event_id, change_key = EXCLUDED.change_key,
             start_at = EXCLUDED.start_at, end_at = EXCLUDED.end_at, updated_at = now(), archived_at = NULL`,
      [tenantId, pipelineId, row.sourceEventId, row.targetEventId, row.changeKey, row.startAt.toISOString(), row.endAt.toISOString()],
    );
  }

  async archiveMapping(pipelineId: string, sourceEventId: string): Promise<void> {
    await this.pool.query(
      `UPDATE sync_event_map SET archived_at = now(), updated_at = now() WHERE pipeline_id = $1 AND source_event_id = $2 AND archived_at IS NULL`,
      [pipelineId, sourceEventId],
    );
  }

  async markIdentityVerified(tenantId: string, pipelineId: string, attribute: string): Promise<void> {
    await this.pool.query(
      `UPDATE pipelines SET identity_verified_at = now(), identity_attribute = $3 WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pipelineId, attribute],
    );
  }

  async deleteMapping(pipelineId: string, sourceEventId: string): Promise<void> {
    await this.pool.query(`DELETE FROM sync_event_map WHERE pipeline_id = $1 AND source_event_id = $2`, [pipelineId, sourceEventId]);
  }

  async saveSyncState(
    tenantId: string,
    pipelineId: string,
    s: { deltaLink: string | null; deltaStartedAt: Date | null; synced: boolean; errorCode?: string | null; effectiveMode?: "busy" | "full" },
  ): Promise<void> {
    await this.pool.query(
      `UPDATE pipelines
          SET source_delta_link = $3, source_delta_started_at = $4::timestamptz,
              last_synced_at = CASE WHEN $5 THEN now() ELSE last_synced_at END,
              last_sync_error = CASE WHEN $5 THEN $6 ELSE last_sync_error END,
              effective_mode = COALESCE($7, effective_mode)
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, pipelineId, s.deltaLink, s.deltaStartedAt ? s.deltaStartedAt.toISOString() : null, s.synced, s.errorCode ?? null, s.effectiveMode ?? null],
    );
  }

  async setSyncError(tenantId: string, pipelineId: string, code: string | null): Promise<void> {
    await this.pool.query(`UPDATE pipelines SET last_sync_error = $3 WHERE tenant_id = $1 AND id = $2`, [tenantId, pipelineId, code]);
  }

  /** Revoked bleibt revoked (wie PgPipelineRepo.setPipelineStatus) */
  async setPipelineStatus(tenantId: string, pipelineId: string, status: "blocked_scope" | "config_error" | "error"): Promise<void> {
    await this.pool.query(
      `UPDATE pipelines SET status = $3 WHERE tenant_id = $1 AND id = $2 AND status <> 'revoked'`,
      [tenantId, pipelineId, status],
    );
  }

  /** Ein INSERT … SELECT je Lauf, gestreut über spreadMs; dedupe "delta:<pipelineId>" wie der Webhook-Eingang */
  async scheduleDueSyncs(staleMs: number, spreadMs: number, limit: number): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
       SELECT p.tenant_id, $4, 'delta:' || p.id, jsonb_build_object('pipelineId', p.id, 'full', false),
              now() + (floor(random() * $2::bigint) * interval '1 millisecond')
         FROM pipelines p JOIN scim_users u ON u.id = p.owner_user_id AND u.tenant_id = p.tenant_id
        WHERE p.status = 'active' AND p.target_kind IS NOT NULL
          AND u.active AND u.deletion_requested_at IS NULL
          AND (p.last_synced_at IS NULL OR p.last_synced_at < now() - ($1::bigint * interval '1 millisecond'))
        ORDER BY p.last_synced_at NULLS FIRST, p.id
        LIMIT $3
       ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`,
      [Math.round(staleMs), Math.max(1, Math.round(spreadMs)), limit, SYNC_KIND],
    );
    return res.rowCount ?? 0;
  }

  /**
   * Zusammenfassen IN SQL (range_agg, PostgreSQL ≥ 14): überlappende und angrenzende Intervalle aller Pipelines
   * werden zu einem Multirange verschmolzen – das Ergebnis ist vollständig, egal wie viele Termine es gibt.
   * Archivierte Zuordnungen (aus dem Sync-Fenster gefallen) zählen nicht. Harte Obergrenze nur für die AUSGABE:
   * mehr als maxIntervals → BusyTooManyError (503), nie stilles Abschneiden.
   */
  async busyIntervals(tenantId: string, from: Date, to: Date, maxIntervals = BUSY_MAX_INTERVALS): Promise<BusyInterval[]> {
    const res = await this.pool.query<{ start_at: Date | string; end_at: Date | string }>(
      `SELECT lower(r) AS start_at, upper(r) AS end_at
         FROM (
           SELECT unnest(range_agg(tstzrange(greatest(m.start_at, $2::timestamptz), least(m.end_at, $3::timestamptz), '[)'))) AS r
             FROM pipelines p
             JOIN scim_users u ON u.id = p.owner_user_id AND u.tenant_id = p.tenant_id
             JOIN sync_event_map m ON m.pipeline_id = p.id
            WHERE p.tenant_id = $1 AND m.tenant_id = $1 AND p.target_kind = 'booking' AND p.status = 'active'
              AND u.active AND u.deletion_requested_at IS NULL AND m.archived_at IS NULL
              AND m.start_at < $3::timestamptz AND m.end_at > $2::timestamptz
         ) merged
        WHERE NOT isempty(r)
        ORDER BY 1
        LIMIT $4`,
      [tenantId, from.toISOString(), to.toISOString(), maxIntervals + 1],
    );
    if (res.rows.length > maxIntervals) throw new BusyTooManyError(maxIntervals);
    return res.rows.map((r) => ({ start: new Date(r.start_at), end: new Date(r.end_at) }));
  }
}

/** Überlappende/angrenzende Intervalle zusammenfassen und auf [from, to) beschneiden */
export function mergeBusyIntervals(rows: readonly BusyInterval[], from: Date, to: Date): BusyInterval[] {
  const lo = from.getTime();
  const hi = to.getTime();
  const clipped = rows
    .map((r) => ({ s: Math.max(lo, r.start.getTime()), e: Math.min(hi, r.end.getTime()) }))
    .filter((r) => r.e > r.s)
    .sort((a, b) => a.s - b.s || a.e - b.e);
  const out: Array<{ s: number; e: number }> = [];
  for (const r of clipped) {
    const last = out[out.length - 1];
    if (last && r.s <= last.e) last.e = Math.max(last.e, r.e);
    else out.push({ ...r });
  }
  return out.map((r) => ({ start: new Date(r.s), end: new Date(r.e) }));
}
