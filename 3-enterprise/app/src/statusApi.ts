/**
 * Dashboard-API v1 – lesend, im Namen des angemeldeten Nutzers.
 *
 *   GET /api/v1/me/sync-status   → Status der eigenen Kalender-Pipelines (eine SQL-Abfrage, kein N+1)
 *   GET /api/v1/me/sync-targets  → wählbare Ziele laut Admin-Allowlist (Vorschläge aus dem eigenen userName)
 *
 * Bewusst keine Endpunkte zum Anlegen von Webhooks: Graph-Subscriptions legt ausschließlich der
 * Handshake-Worker mit App-Credentials an. Ein Browser darf nie eine notificationUrl bestimmen.
 */
import type { PgLike } from "../../core/src/retryQueue.js";
import {
  accountSuggestions, EMPTY_ALLOWLIST, targetLabel,
  type AccountSuggestion, type SyncAllowlist, type SyncTargetKind,
} from "../../core/src/syncTargets.js";

export interface PipelineStatus {
  id: string;
  status: string;
  /** Webhook-Abo bei Microsoft aktiv und bis wann (Erneuerung macht der Worker) */
  subscription: { active: boolean; expiresAt: string | null };
  /** Ziel als Art + Label (nie ein Postfach); null = Altbestand ohne Ziel */
  target: { kind: SyncTargetKind; label: string | null } | null;
  lastSyncedAt: string | null;
  /** nur ein Code (z. B. transient, blocked_scope, target_not_allowed, event_rejected, cleanup_failed) */
  lastError: string | null;
  /** nach dem Beenden: Zieltermine werden entfernt (pending) bzw. sind entfernt (done); sonst null */
  cleanup: "pending" | "done" | null;
}

export interface SyncStatus {
  user: { active: boolean };
  pipelines: PipelineStatus[];
}

export interface StatusRepo {
  getSyncStatus(tenantId: string, entraObjectId: string): Promise<SyncStatus | null>;
}

export interface SyncTargetsResponse {
  account: { allowed: boolean; suggestions: AccountSuggestion[] };
  team: Array<{ id: string; label: string }>;
  booking: { enabled: boolean };
}

export interface OwnerLookup {
  /** userName (UPN) eines aktiven, nicht gelöschten Nutzers; null = nicht (mehr) provisioniert */
  getActiveUserName(tenantId: string, entraObjectId: string): Promise<string | null>;
}

/** Wählbare Ziele für den angemeldeten Nutzer – Team-Postfächer werden nie ausgeliefert, nur id + label */
export function syncTargetsFor(allow: SyncAllowlist, ownerUserName: string): SyncTargetsResponse {
  const suggestions = accountSuggestions(allow, ownerUserName);
  return {
    account: { allowed: suggestions.length > 0, suggestions },
    team: allow.teamCalendars.map((t) => ({ id: t.id, label: t.label })),
    booking: { enabled: allow.bookingEnabled },
  };
}

type Row = {
  user_active: boolean | string;
  pipeline_id: string | null;
  pipeline_status: string | null;
  channel_expires_at: Date | string | null;
  channel_live: boolean | string | null;
  target_kind: string | null;
  target_mailbox: string | null;
  target_entra_tenant_id: string | null;
  target_ref: string | null;
  last_synced_at: Date | string | null;
  last_sync_error: string | null;
  cleanup_requested_at: Date | string | null;
  cleanup_done_at: Date | string | null;
};
const bool = (v: boolean | string | null): boolean => v === true || v === "t" || v === "true";

export class PgStatusRepo implements StatusRepo, OwnerLookup {
  constructor(
    private readonly pool: PgLike,
    private readonly allow: SyncAllowlist = EMPTY_ALLOWLIST,
  ) {}

  async getActiveUserName(tenantId: string, entraObjectId: string): Promise<string | null> {
    const res = await this.pool.query<{ user_name: string }>(
      `SELECT user_name FROM scim_users
        WHERE tenant_id = $1 AND external_id = $2 AND active AND deletion_requested_at IS NULL`,
      [tenantId, entraObjectId],
    );
    return res.rows[0]?.user_name ?? null;
  }

  async getSyncStatus(tenantId: string, entraObjectId: string): Promise<SyncStatus | null> {
    // Ein Roundtrip: User + alle Pipelines + jeweils der lebende Channel (LATERAL, höchstens einer je Pipeline)
    const res = await this.pool.query<Row>(
      `SELECT (u.active AND u.deletion_requested_at IS NULL) AS user_active,
              p.id AS pipeline_id, p.status AS pipeline_status,
              c.expires_at AS channel_expires_at, (c.id IS NOT NULL) AS channel_live,
              p.target_kind, p.target_mailbox, p.target_entra_tenant_id, p.target_ref,
              p.last_synced_at, p.last_sync_error, p.cleanup_requested_at, p.cleanup_done_at
         FROM scim_users u
         LEFT JOIN pipelines p ON p.owner_user_id = u.id AND p.tenant_id = u.tenant_id
         LEFT JOIN LATERAL (
           SELECT id, expires_at FROM webhook_channels
            WHERE pipeline_id = p.id AND stop_requested_at IS NULL AND stopped_at IS NULL
            LIMIT 1
         ) c ON true
        WHERE u.tenant_id = $1 AND u.external_id = $2 AND u.deletion_requested_at IS NULL
        ORDER BY p.id`,
      [tenantId, entraObjectId],
    );
    if (res.rows.length === 0) return null;
    const pipelines: PipelineStatus[] = [];
    for (const r of res.rows) {
      if (!r.pipeline_id || !r.pipeline_status) continue;
      pipelines.push({
        id: r.pipeline_id,
        status: r.pipeline_status,
        subscription: {
          active: bool(r.channel_live),
          expiresAt: r.channel_expires_at ? new Date(r.channel_expires_at).toISOString() : null,
        },
        target: targetLabel(this.allow, { kind: r.target_kind, mailbox: r.target_mailbox, entraTenantId: r.target_entra_tenant_id, ref: r.target_ref }),
        lastSyncedAt: r.last_synced_at ? new Date(r.last_synced_at).toISOString() : null,
        lastError: r.last_sync_error ?? null,
        cleanup: r.cleanup_requested_at ? (r.cleanup_done_at ? "done" : "pending") : null,
      });
    }
    return { user: { active: bool(res.rows[0].user_active) }, pipelines };
  }
}
