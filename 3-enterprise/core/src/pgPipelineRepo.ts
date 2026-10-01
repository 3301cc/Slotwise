/**
 * Postgres-Implementierung für den Handshake-Worker (PipelineRepo) und seine Status-Senke.
 * Jede Methode ist EINE Anweisung – atomar ohne explizite Transaktion, kein gehaltener Client.
 */
import type { HandshakeTarget, PipelineRepo } from "./handshakeWorker.js";
import type { PgLike } from "./retryQueue.js";

type TargetRow = {
  status: HandshakeTarget["status"];
  owner_active: boolean | string;
  entra_object_id: string | null;
  has_live_channel: boolean | string;
};

const bool = (v: boolean | string): boolean => v === true || v === "t" || v === "true";

export class PgPipelineRepo implements PipelineRepo {
  constructor(private readonly pool: PgLike) {}

  async getHandshakeTarget(tenantId: string, pipelineId: string): Promise<HandshakeTarget | null> {
    const res = await this.pool.query<TargetRow>(
      `SELECT p.status,
              (u.active AND u.deletion_requested_at IS NULL) AS owner_active,
              u.external_id AS entra_object_id,
              EXISTS (SELECT 1 FROM webhook_channels c
                       WHERE c.pipeline_id = p.id AND c.stop_requested_at IS NULL AND c.stopped_at IS NULL) AS has_live_channel
         FROM pipelines p JOIN scim_users u ON u.id = p.owner_user_id AND u.tenant_id = p.tenant_id
        WHERE p.tenant_id = $1 AND p.id = $2`,
      [tenantId, pipelineId],
    );
    const r = res.rows[0];
    if (!r || !r.entra_object_id) return null;
    return { status: r.status, ownerActive: bool(r.owner_active), hasLiveChannel: bool(r.has_live_channel), entraObjectId: r.entra_object_id };
  }

  /**
   * Channel anlegen + Pipeline aktivieren in EINER Anweisung (datenmodifizierende CTE).
   *
   * Offboarding-Race: Zwischen getHandshakeTarget und hier liegt der Graph-POST (Sekunden). Deaktiviert SCIM
   * den User in dieser Zeit, setzt es im selben Commit die Pipeline auf revoked. FOR UPDATE auf der Pipeline-
   * Zeile wartet auf diesen Commit und liest danach den frischen Status (Read Committed prüft gesperrte Zeilen
   * neu). Revoked oder inaktiv → nichts geschrieben → Fehler → der Worker löscht das Abo bei Graph wieder.
   */
  async activateWithChannel(
    tenantId: string,
    pipelineId: string,
    ch: { userId: string; providerSubscriptionId: string; clientState: string; expiresAt: string },
  ): Promise<void> {
    const res = await this.pool.query<{ activated: string | number }>(
      `WITH ok AS (
         SELECT p.id FROM pipelines p
          WHERE p.tenant_id = $1 AND p.id = $2 AND p.status NOT IN ('revoked', 'paused')
            AND EXISTS (SELECT 1 FROM scim_users u
                         WHERE u.id = p.owner_user_id AND u.tenant_id = p.tenant_id
                           AND u.active AND u.deletion_requested_at IS NULL)
          FOR UPDATE OF p
       ), ins AS (
         INSERT INTO webhook_channels (id, tenant_id, user_id, pipeline_id, provider, provider_subscription_id, client_state, expires_at)
         SELECT gen_random_uuid()::text, $1, $3, ok.id, 'microsoft', $4, $5, $6::timestamptz FROM ok
         RETURNING pipeline_id
       ), upd AS (
         UPDATE pipelines SET status = 'active'
          WHERE tenant_id = $1 AND id = (SELECT pipeline_id FROM ins)
         RETURNING id
       )
       SELECT (SELECT count(*) FROM upd) AS activated`,
      [tenantId, pipelineId, ch.userId, ch.providerSubscriptionId, ch.clientState, ch.expiresAt],
    );
    if (Number(res.rows[0]?.activated ?? 0) !== 1) {
      throw new Error("Pipeline nicht mehr aktivierbar (revoked/paused oder Nutzer deaktiviert)");
    }
  }

  /** Senke für handleHandshakeFailure: sichtbarer Status im Dashboard. Revoked bleibt revoked. */
  async setPipelineStatus(tenantId: string, pipelineId: string, status: string): Promise<void> {
    await this.pool.query(
      `UPDATE pipelines SET status = $3 WHERE tenant_id = $1 AND id = $2 AND status <> 'revoked'`,
      [tenantId, pipelineId, status],
    );
  }
}
