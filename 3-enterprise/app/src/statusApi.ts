/**
 * Dashboard-API v1 – lesend, im Namen des angemeldeten Nutzers.
 *
 *   GET /api/v1/me/sync-status   → Status der eigenen Kalender-Pipelines (eine SQL-Abfrage, kein N+1)
 *
 * Bewusst keine Endpunkte zum Anlegen von Webhooks: Graph-Subscriptions legt ausschließlich der
 * Handshake-Worker mit App-Credentials an. Ein Browser darf nie eine notificationUrl bestimmen.
 */
import type { PgLike } from "../../core/src/retryQueue.js";

export interface PipelineStatus {
  id: string;
  status: string;
  /** Webhook-Abo bei Microsoft aktiv und bis wann (Erneuerung macht der Worker) */
  subscription: { active: boolean; expiresAt: string | null };
}

export interface SyncStatus {
  user: { active: boolean };
  pipelines: PipelineStatus[];
}

export interface StatusRepo {
  getSyncStatus(tenantId: string, entraObjectId: string): Promise<SyncStatus | null>;
}

type Row = {
  user_active: boolean | string;
  pipeline_id: string | null;
  pipeline_status: string | null;
  channel_expires_at: Date | string | null;
  channel_live: boolean | string | null;
};
const bool = (v: boolean | string | null): boolean => v === true || v === "t" || v === "true";

export class PgStatusRepo implements StatusRepo {
  constructor(private readonly pool: PgLike) {}

  async getSyncStatus(tenantId: string, entraObjectId: string): Promise<SyncStatus | null> {
    // Ein Roundtrip: User + alle Pipelines + jeweils der lebende Channel (LATERAL, höchstens einer je Pipeline)
    const res = await this.pool.query<Row>(
      `SELECT (u.active AND u.deletion_requested_at IS NULL) AS user_active,
              p.id AS pipeline_id, p.status AS pipeline_status,
              c.expires_at AS channel_expires_at, (c.id IS NOT NULL) AS channel_live
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
      });
    }
    return { user: { active: bool(res.rows[0].user_active) }, pipelines };
  }
}
