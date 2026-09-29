import type { PgLike } from './pgBookingRepository.js';
import type { ReconcileReport, ReconcilerBooking, ReconcilerRepository } from './reconciler.js';
import type { BookingStatus, CalendarConnection } from './types.js';

function rowToBooking(r: Record<string, unknown>): ReconcilerBooking {
  return {
    id: String(r.id),
    tenantId: String(r.tenant_id ?? ''),
    hostId: String(r.host_id),
    status: r.status as BookingStatus,
    externalEventId: (r.external_event_id as string | null) ?? null,
    startUtc: new Date(r.start_utc as string),
    endUtc: new Date(r.end_utc as string),
    createdAt: new Date(r.created_at as string),
  };
}

export class PgReconcilerRepository implements ReconcilerRepository {
  constructor(private readonly db: PgLike) {}

  async listHostIds(): Promise<string[]> {
    const { rows } = await this.db.query<{ host_id: string }>(`SELECT DISTINCT host_id FROM calendar_connections WHERE is_primary ORDER BY host_id`);
    return rows.map((r) => r.host_id);
  }

  async loadPrimaryConnection(hostId: string): Promise<CalendarConnection | null> {
    const { rows } = await this.db.query(`SELECT id, host_id, provider, external_id, is_primary, is_blocking FROM calendar_connections WHERE host_id = $1 AND is_primary LIMIT 1`, [hostId]);
    const r = rows[0];
    if (!r) return null;
    return { id: String(r.id), hostId: String(r.host_id), provider: r.provider as CalendarConnection['provider'], externalId: String(r.external_id), isPrimary: true, isBlocking: Boolean(r.is_blocking) };
  }

  async listBookings(hostId: string, from: Date, to: Date): Promise<ReconcilerBooking[]> {
    const { rows } = await this.db.query(
      `SELECT id, tenant_id, host_id, status, external_event_id, start_utc, end_utc, created_at FROM bookings
        WHERE host_id = $1 AND start_utc < $3 AND end_utc > $2`,
      [hostId, from, to],
    );
    return rows.map(rowToBooking);
  }

  async listStalePending(olderThan: Date): Promise<ReconcilerBooking[]> {
    const { rows } = await this.db.query(
      `SELECT id, tenant_id, host_id, status, external_event_id, start_utc, end_utc, created_at FROM bookings
        WHERE status = 'pending_verification' AND created_at < $1 ORDER BY created_at LIMIT 500`,
      [olderThan],
    );
    return rows.map(rowToBooking);
  }

  async listBookingIdsWithOpenSyncJobs(hostId: string): Promise<Set<string>> {
    const { rows } = await this.db.query<{ booking_id: string }>(
      `SELECT DISTINCT booking_id FROM calendar_sync_jobs WHERE host_id = $1 AND status IN ('PENDING', 'RETRY', 'RUNNING')`,
      [hostId],
    );
    return new Set(rows.map((r) => r.booking_id));
  }

  async markExternalEventMissing(bookingId: string, at: Date): Promise<void> {
    await this.db.query(`UPDATE bookings SET external_event_missing_at = COALESCE(external_event_missing_at, $2) WHERE id = $1`, [bookingId, at]);
  }

  async clearExternalEventMissing(bookingId: string): Promise<void> {
    await this.db.query(`UPDATE bookings SET external_event_missing_at = NULL WHERE id = $1 AND external_event_missing_at IS NOT NULL`, [bookingId]);
  }

  async recordRun(run: ReconcileReport): Promise<void> {
    await this.db.query(
      `INSERT INTO reconciler_runs (host_id, started_at, finished_at, hosts_checked, orphans_deleted, missing_flagged, pending_requeued, errors)
       VALUES ($1, $2, $3, $4, $5, $6::uuid[], $7::uuid[], $8::jsonb)`,
      [run.hostId, run.startedAt, run.finishedAt, run.hostsChecked, run.orphansDeleted, run.missingFlagged, run.pendingRequeued, JSON.stringify(run.errors)],
    );
    await this.db.query(`SELECT prune_reconciler_runs()`);
  }
}
