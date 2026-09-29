import { SlotTakenError } from './errors.js';
import type { BookingRecord, BookingRepository, HostContext } from './types.js';

/** Minimale pg-Schnittstelle (node-postgres Pool/Client-kompatibel). */
export interface PgLike {
  query<T = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: T[]; rowCount: number | null }>;
}

const COLS = `id, host_id, event_type_id, start_utc, end_utc, status, booker_timezone,
  host_timezone_at_booking, external_event_id, external_calendar_id, idempotency_key, verify_attempts`;

function rowToRecord(r: Record<string, unknown>): BookingRecord {
  return {
    id: r.id as string,
    hostId: r.host_id as string,
    eventTypeId: r.event_type_id as string,
    startUtc: new Date(r.start_utc as string),
    endUtc: new Date(r.end_utc as string),
    status: r.status as BookingRecord['status'],
    bookerTimezone: r.booker_timezone as string,
    hostTimezoneAtBooking: r.host_timezone_at_booking as string,
    externalEventId: (r.external_event_id as string | null) ?? null,
    externalCalendarId: (r.external_calendar_id as string | null) ?? null,
    idempotencyKey: r.idempotency_key as string,
    verifyAttempts: Number(r.verify_attempts ?? 0),
  };
}

export class PgBookingRepository implements BookingRepository {
  constructor(private readonly db: PgLike) {}

  async findByIdempotencyKey(hostId: string, key: string): Promise<BookingRecord | null> {
    const { rows } = await this.db.query(`SELECT ${COLS} FROM bookings WHERE host_id = $1 AND idempotency_key = $2`, [hostId, key]);
    return rows[0] ? rowToRecord(rows[0]) : null;
  }

  async insert(r: Omit<BookingRecord, 'id' | 'verifyAttempts'>): Promise<BookingRecord> {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO bookings (host_id, event_type_id, start_utc, end_utc, status, booker_timezone,
           host_timezone_at_booking, external_event_id, external_calendar_id, idempotency_key)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING ${COLS}`,
        [r.hostId, r.eventTypeId, r.startUtc, r.endUtc, r.status, r.bookerTimezone, r.hostTimezoneAtBooking, r.externalEventId, r.externalCalendarId, r.idempotencyKey],
      );
      return rowToRecord(rows[0]);
    } catch (err) {
      // 23P01 = exclusion_violation: paralleler Insert hat gewonnen.
      if (typeof err === 'object' && err && (err as { code?: string }).code === '23P01') throw new SlotTakenError();
      // 23505 auf dem Idempotency-Index: gleicher Request zweimal, Aufrufer liest den Bestand.
      if (typeof err === 'object' && err && (err as { code?: string }).code === '23505') {
        const existing = await this.findByIdempotencyKey(r.hostId, r.idempotencyKey);
        if (existing) return existing;
      }
      throw err;
    }
  }

  async update(id: string, patch: Partial<Pick<BookingRecord, 'status' | 'externalEventId' | 'externalCalendarId' | 'verifyAttempts'>>): Promise<BookingRecord> {
    const sets: string[] = [];
    const vals: unknown[] = [];
    const push = (col: string, v: unknown) => {
      vals.push(v);
      sets.push(`${col} = $${vals.length}`);
    };
    if (patch.status !== undefined) push('status', patch.status);
    if (patch.externalEventId !== undefined) push('external_event_id', patch.externalEventId);
    if (patch.externalCalendarId !== undefined) push('external_calendar_id', patch.externalCalendarId);
    if (patch.verifyAttempts !== undefined) push('verify_attempts', patch.verifyAttempts);
    vals.push(id);
    const { rows } = await this.db.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING ${COLS}`, vals);
    return rowToRecord(rows[0]);
  }

  async loadHostContext(hostId: string): Promise<HostContext> {
    const host = await this.db.query<{ tenant_id: string; timezone: string; buffer_before: number; buffer_after: number; min_notice: number }>(
      `SELECT tenant_id, timezone, COALESCE(buffer_before_minutes,0) AS buffer_before, COALESCE(buffer_after_minutes,0) AS buffer_after,
              COALESCE(min_notice_minutes,0) AS min_notice FROM hosts WHERE id = $1`,
      [hostId],
    );
    if (!host.rows[0]) throw new Error(`Host ${hostId} nicht gefunden`);
    const rules = await this.db.query<{ weekday: number; start_local: string; end_local: string }>(
      `SELECT weekday, to_char(start_local,'HH24:MI') AS start_local, to_char(end_local,'HH24:MI') AS end_local FROM availability_rules WHERE host_id = $1`,
      [hostId],
    );
    const conns = await this.db.query<{ id: string; provider: string; external_id: string; is_primary: boolean; is_blocking: boolean }>(
      `SELECT id, provider, external_id, is_primary, is_blocking FROM calendar_connections WHERE host_id = $1`,
      [hostId],
    );
    return {
      hostId,
      tenantId: host.rows[0].tenant_id,
      timezone: host.rows[0].timezone,
      bufferBeforeMinutes: host.rows[0].buffer_before,
      bufferAfterMinutes: host.rows[0].buffer_after,
      minNoticeMinutes: host.rows[0].min_notice,
      rules: rules.rows.map((r) => ({ weekday: r.weekday, startLocal: r.start_local, endLocal: r.end_local })),
      connections: conns.rows.map((c) => ({
        id: c.id,
        hostId,
        provider: c.provider as HostContext['connections'][number]['provider'],
        externalId: c.external_id,
        isPrimary: c.is_primary,
        isBlocking: c.is_blocking,
      })),
    };
  }
}
