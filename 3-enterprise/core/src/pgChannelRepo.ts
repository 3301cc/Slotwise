/**
 * Postgres-Implementierung von ChannelRepo (Teardown) und GuardRepo (Webhook-Eingang).
 *
 * Migration (Ergänzung zu webhook_channels):
 *   ALTER TABLE webhook_channels
 *     ADD COLUMN IF NOT EXISTS stop_requested_at    timestamptz,
 *     ADD COLUMN IF NOT EXISTS stopped_at           timestamptz,
 *     ADD COLUMN IF NOT EXISTS stop_note            text,
 *     ADD COLUMN IF NOT EXISTS stop_attempts        int NOT NULL DEFAULT 0,
 *     ADD COLUMN IF NOT EXISTS next_stop_attempt_at timestamptz,
 *     ADD COLUMN IF NOT EXISTS last_stop_error      text;
 *   -- KEIN FK mit ON DELETE CASCADE auf scim_users: die Zeile muss die User-Löschung überleben,
 *   -- bis das Abo beim Provider nachweislich beendet ist. Danach räumt der Purge-Job sie ab.
 *   CREATE INDEX webhook_channels_due_stop ON webhook_channels (next_stop_attempt_at)
 *     WHERE stop_requested_at IS NOT NULL AND stopped_at IS NULL;
 *   CREATE UNIQUE INDEX webhook_channels_sub ON webhook_channels (provider, provider_subscription_id);
 *   CREATE UNIQUE INDEX webhook_channels_one_live ON webhook_channels (pipeline_id)
 *     WHERE stop_requested_at IS NULL AND stopped_at IS NULL;
 */
import type { PgLike } from "./retryQueue.js";
import type { ChannelRepo } from "./subscriptionTeardown.js";
import type { GoogleChannel, GoogleGuardRepo, GoogleJob } from "./googleWebhook.js";
import type { GuardChannel, GuardRepo } from "./webhookGuard.js";
import { HANDSHAKE_KIND } from "./handshakeWorker.js";
import { RENEW_KIND, type RenewalRepo, type RenewTarget } from "./renewalWorker.js";
import type { WebhookChannel } from "./types.js";

const COLS = `c.id, c.tenant_id, c.user_id, c.provider, c.provider_subscription_id, c.provider_resource_id,
  c.client_state, c.expires_at, c.stop_requested_at, c.stopped_at, c.stop_attempts, c.next_stop_attempt_at, c.last_stop_error`;

type Row = {
  id: string;
  tenant_id: string;
  user_id: string;
  provider: "microsoft" | "google";
  provider_subscription_id: string;
  provider_resource_id: string | null;
  client_state: string | null;
  expires_at: Date | null;
  stop_requested_at: Date | null;
  stopped_at: Date | null;
  stop_attempts: number;
  next_stop_attempt_at: Date | null;
  last_stop_error: string | null;
  pipeline_id?: string;
  pipeline_status?: string;
};

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);
const toChannel = (r: Row): WebhookChannel => ({
  id: r.id,
  tenantId: r.tenant_id,
  userId: r.user_id,
  provider: r.provider,
  providerSubscriptionId: r.provider_subscription_id,
  providerResourceId: r.provider_resource_id,
  clientState: r.client_state,
  expiresAt: iso(r.expires_at),
  stopRequestedAt: iso(r.stop_requested_at),
  stoppedAt: iso(r.stopped_at),
  stopAttempts: r.stop_attempts,
  nextStopAttemptAt: iso(r.next_stop_attempt_at),
  lastStopError: r.last_stop_error,
});

/** Lease für einen Stop-Versuch: so lange gilt ein Channel als "in Arbeit" und wird nicht doppelt geholt. */
const STOP_LEASE = "2 minutes";

export class PgChannelRepo implements ChannelRepo, GuardRepo, GoogleGuardRepo, RenewalRepo {
  constructor(private readonly pool: PgLike) {}

  async listOpenForUser(tenantId: string, userId: string): Promise<WebhookChannel[]> {
    const res = await this.pool.query<Row>(
      `SELECT ${COLS} FROM webhook_channels c WHERE c.tenant_id = $1 AND c.user_id = $2 AND c.stopped_at IS NULL`,
      [tenantId, userId],
    );
    return res.rows.map(toChannel);
  }

  async claimDueStops(nowIso: string, limit: number): Promise<WebhookChannel[]> {
    // Claim = next_stop_attempt_at um die Lease nach vorn schieben. Kein offener Transaktions-Lock über
    // HTTP-Aufrufe hinweg; stirbt der Worker, ist der Channel nach Ablauf der Lease wieder fällig.
    const res = await this.pool.query<Row>(
      `WITH due AS (
         SELECT id FROM webhook_channels
          WHERE stop_requested_at IS NOT NULL AND stopped_at IS NULL
            AND ((stop_attempts = 0 AND next_stop_attempt_at IS NULL) OR next_stop_attempt_at <= $1::timestamptz)
          ORDER BY next_stop_attempt_at NULLS FIRST
          LIMIT $2
          FOR UPDATE SKIP LOCKED
       )
       UPDATE webhook_channels c SET next_stop_attempt_at = $1::timestamptz + interval '${STOP_LEASE}'
         FROM due WHERE c.id = due.id
       RETURNING ${COLS}`,
      [nowIso, limit],
    );
    return res.rows.map(toChannel);
  }

  async markStopped(channelId: string, atIso: string, note: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_channels
          SET stopped_at = $2::timestamptz, stop_note = $3,
              stop_requested_at = COALESCE(stop_requested_at, $2::timestamptz),
              next_stop_attempt_at = NULL
        WHERE id = $1 AND stopped_at IS NULL`,
      [channelId, atIso, note],
    );
  }

  async recordStopFailure(channelId: string, f: { attempts: number; nextAttemptAtIso: string | null; error: string }): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_channels
          SET stop_attempts = $2, next_stop_attempt_at = $3::timestamptz, last_stop_error = left($4, 1000)
        WHERE id = $1 AND stopped_at IS NULL`,
      [channelId, f.attempts, f.nextAttemptAtIso, f.error],
    );
  }

  /** Ein Roundtrip für alle Subscriptions eines Notification-Batches (statt N Einzelabfragen). */
  async findBySubscriptionIds(providerSubscriptionIds: readonly string[]): Promise<Map<string, GuardChannel>> {
    const out = new Map<string, GuardChannel>();
    if (providerSubscriptionIds.length === 0) return out;
    const res = await this.pool.query<Row>(
      `SELECT ${COLS}, c.pipeline_id, COALESCE(p.status, 'missing') AS pipeline_status
         FROM webhook_channels c LEFT JOIN pipelines p ON p.id = c.pipeline_id AND p.tenant_id = c.tenant_id
        WHERE c.provider = 'microsoft' AND c.provider_subscription_id = ANY($1::text[])`,
      [providerSubscriptionIds],
    );
    for (const r of res.rows) {
      out.set(r.provider_subscription_id, { ...toChannel(r), pipelineId: r.pipeline_id as string, pipelineStatus: r.pipeline_status as string });
    }
    return out;
  }

  async findBySubscriptionId(providerSubscriptionId: string): Promise<GuardChannel | null> {
    return (await this.findBySubscriptionIds([providerSubscriptionId])).get(providerSubscriptionId) ?? null;
  }

  /** subscriptionRemoved-Lifecycle-Events eines Batches in einem UPDATE */
  async markStoppedMany(channelIds: readonly string[], atIso: string, note: string): Promise<void> {
    if (channelIds.length === 0) return;
    await this.pool.query(
      `UPDATE webhook_channels
          SET stopped_at = $2::timestamptz, stop_note = $3,
              stop_requested_at = COALESCE(stop_requested_at, $2::timestamptz),
              next_stop_attempt_at = NULL
        WHERE id = ANY($1::text[]) AND stopped_at IS NULL`,
      [channelIds, atIso, note],
    );
  }

  // --- Google-Push-Notifications ------------------------------------------------------------------
  async findGoogleChannel(channelId: string): Promise<GoogleChannel | null> {
    const res = await this.pool.query<Row & { last_message_number: string | number | null }>(
      `SELECT ${COLS}, c.pipeline_id, COALESCE(p.status, 'missing') AS pipeline_status, c.last_message_number
         FROM webhook_channels c LEFT JOIN pipelines p ON p.id = c.pipeline_id AND p.tenant_id = c.tenant_id
        WHERE c.provider = 'google' AND c.provider_subscription_id = $1`,
      [channelId],
    );
    const r = res.rows[0];
    if (!r) return null;
    return {
      ...toChannel(r),
      pipelineId: r.pipeline_id as string,
      pipelineStatus: r.pipeline_status as string,
      lastMessageNumber: r.last_message_number === null ? null : Number(r.last_message_number),
    };
  }

  /**
   * EINE Anweisung: Message-Number nur vorwärts schreiben (Replay-Schutz, auch bei parallelen Zustellungen –
   * die Zeilensperre des UPDATE serialisiert sie) und nur dann den Job einstellen.
   */
  async acceptGoogleNotification(channelId: string, messageNumber: number, tenantId: string, job: GoogleJob | null): Promise<{ fresh: boolean; queued: boolean }> {
    const res = await this.pool.query<{ fresh: string | number; queued: string | number }>(
      `WITH upd AS (
         UPDATE webhook_channels
            SET last_message_number = $2::bigint
          WHERE id = $1 AND provider = 'google' AND stopped_at IS NULL AND stop_requested_at IS NULL
            AND (last_message_number IS NULL OR last_message_number < $2::bigint)
          RETURNING id
       ), ins AS (
         INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
         SELECT $3, $4::text, $5::text, $6::jsonb, now() FROM upd WHERE $4::text IS NOT NULL
         ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING
         RETURNING id
       )
       SELECT (SELECT count(*) FROM upd) AS fresh, (SELECT count(*) FROM ins) AS queued`,
      [channelId, messageNumber, tenantId, job?.kind ?? null, job?.dedupeKey ?? null, job ? JSON.stringify(job.payload) : null],
    );
    const r = res.rows[0];
    return { fresh: Number(r?.fresh ?? 0) > 0, queued: Number(r?.queued ?? 0) > 0 };
  }

  // --- Verlängerung der Graph-Abos (renewalWorker.ts, Migration 006) ------------------------------
  async getRenewTarget(tenantId: string, channelId: string): Promise<RenewTarget | null> {
    const res = await this.pool.query<{
      id: string; tenant_id: string; user_id: string; provider: "microsoft" | "google"; provider_subscription_id: string;
      expires_at: Date | null; live: boolean | string; pipeline_id: string; pipeline_status: string;
      owner_active: boolean | string | null; owner_created_at: Date | null;
    }>(
      `SELECT c.id, c.tenant_id, c.user_id, c.provider, c.provider_subscription_id, c.expires_at,
              (c.stop_requested_at IS NULL AND c.stopped_at IS NULL) AS live,
              c.pipeline_id, COALESCE(p.status, 'missing') AS pipeline_status,
              (u.active AND u.deletion_requested_at IS NULL) AS owner_active, u.created_at AS owner_created_at
         FROM webhook_channels c
         LEFT JOIN pipelines p  ON p.id = c.pipeline_id AND p.tenant_id = c.tenant_id
         LEFT JOIN scim_users u ON u.id = c.user_id     AND u.tenant_id = c.tenant_id
        WHERE c.tenant_id = $1 AND c.id = $2`,
      [tenantId, channelId],
    );
    const r = res.rows[0];
    if (!r) return null;
    const b = (v: boolean | string | null) => v === true || v === "t" || v === "true";
    return {
      channelId: r.id, tenantId: r.tenant_id, userId: r.user_id, provider: r.provider, providerSubscriptionId: r.provider_subscription_id,
      expiresAt: iso(r.expires_at), live: b(r.live), pipelineId: r.pipeline_id, pipelineStatus: r.pipeline_status,
      ownerActive: b(r.owner_active), ownerCreatedAt: iso(r.owner_created_at),
    };
  }

  async extendExpiry(channelId: string, expiresAtIso: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE webhook_channels
          SET expires_at = $2::timestamptz, last_renewed_at = now(), renew_error = NULL, renew_paused_until = NULL
        WHERE id = $1 AND stop_requested_at IS NULL AND stopped_at IS NULL`,
      [channelId, expiresAtIso],
    );
    return res.rowCount === 1;
  }

  async markGoneAndRecreate(channelId: string, note: string, handshakePayload: Record<string, unknown>): Promise<{ marked: boolean; queued: boolean }> {
    const res = await this.pool.query<{ marked: string | number; queued: string | number }>(
      `WITH upd AS (
         UPDATE webhook_channels
            SET stopped_at = now(), stop_note = $2, stop_requested_at = COALESCE(stop_requested_at, now()), next_stop_attempt_at = NULL
          WHERE id = $1 AND stop_requested_at IS NULL AND stopped_at IS NULL
          RETURNING tenant_id, pipeline_id
       ), ins AS (
         INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
         SELECT upd.tenant_id, $3::text, 'handshake:' || upd.pipeline_id, $4::jsonb, now() FROM upd
         ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING
         RETURNING id
       )
       SELECT (SELECT count(*) FROM upd) AS marked, (SELECT count(*) FROM ins) AS queued`,
      [channelId, note, HANDSHAKE_KIND, JSON.stringify(handshakePayload)],
    );
    const r = res.rows[0];
    return { marked: Number(r?.marked ?? 0) > 0, queued: Number(r?.queued ?? 0) > 0 };
  }

  async pauseRenewal(channelId: string, untilIso: string, error: string): Promise<void> {
    await this.pool.query(
      `UPDATE webhook_channels SET renew_paused_until = $2::timestamptz, renew_error = left($3, 1000) WHERE id = $1`,
      [channelId, untilIso, error],
    );
  }

  /**
   * Ein INSERT … SELECT für alle Abos, die innerhalb von horizonMs ablaufen. run_at wird über spreadMs
   * gestreut (kein Lastspitzen-Takt bei Graph), aber nie später als 10 min vor Ablauf.
   */
  async scheduleDueRenewals(horizonMs: number, spreadMs: number, limit: number): Promise<number> {
    const res = await this.pool.query(
      `INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
       SELECT c.tenant_id, $1::text, 'renew:' || c.id, jsonb_build_object('channelId', c.id),
              GREATEST(now(), LEAST(now() + random() * ($3::bigint * interval '1 millisecond'), c.expires_at - interval '10 minutes'))
         FROM webhook_channels c
         JOIN pipelines p ON p.id = c.pipeline_id AND p.tenant_id = c.tenant_id AND p.status = 'active'
        WHERE c.provider = 'microsoft' AND c.stop_requested_at IS NULL AND c.stopped_at IS NULL
          AND c.expires_at < now() + ($2::bigint * interval '1 millisecond')
          AND (c.renew_paused_until IS NULL OR c.renew_paused_until < now())
        ORDER BY c.expires_at
        LIMIT $4
       ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`,
      [RENEW_KIND, Math.round(horizonMs), Math.round(spreadMs), limit],
    );
    return res.rowCount ?? 0;
  }
}
