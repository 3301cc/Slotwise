import type { AvailabilityRule, BusyBlock } from '../availability/slotEngine.js';

export type BookingStatus =
  | 'tentative'
  | 'pending_verification'
  | 'confirmed'
  | 'rescheduled'
  | 'cancelled_free'
  | 'cancelled_late'
  | 'cancelled_conflict'
  | 'no_show'
  | 'completed';

export interface CalendarConnection {
  id: string;
  hostId: string;
  provider: 'google' | 'microsoft' | 'caldav' | 'exchange_onprem';
  externalId: string;
  isPrimary: boolean;
  isBlocking: boolean;
}

export interface HostContext {
  hostId: string;
  tenantId: string;
  timezone: string;
  rules: AvailabilityRule[];
  connections: CalendarConnection[];
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  minNoticeMinutes: number;
}

export interface BookingRequest {
  idempotencyKey: string;
  hostId: string;
  eventTypeId: string;
  startUtc: Date;
  endUtc: Date;
  bookerTimezone: string;
  booker: { name: string; email: string; phone?: string };
  notes?: string;
}

export interface BookingRecord {
  id: string;
  hostId: string;
  eventTypeId: string;
  startUtc: Date;
  endUtc: Date;
  status: BookingStatus;
  bookerTimezone: string;
  hostTimezoneAtBooking: string;
  externalEventId: string | null;
  externalCalendarId: string | null;
  idempotencyKey: string;
  verifyAttempts: number;
}

/** Ergebnis von createBooking. `pending` = Provider hat gedrosselt, Verifikation läuft asynchron. */
export type BookingResult =
  | { kind: 'confirmed'; booking: BookingRecord }
  | { kind: 'pending'; booking: BookingRecord; verifyBy: Date };

// ---------------------------------------------------------------------------
// Ports (Hexagonal): Implementierungen in infra/
// ---------------------------------------------------------------------------

export interface CalendarProvider {
  readonly name: string;
  /** Belegt-Blöcke aller übergebenen Kalender im Fenster. Muss bei 429 ProviderRateLimitError werfen. */
  getFreeBusy(connections: CalendarConnection[], from: Date, to: Date): Promise<BusyBlock[]>;
  /** Legt den Termin im Primärkalender an, Status tentative. Liefert die externe Event-ID. */
  createEvent(primary: CalendarConnection, input: { start: Date; end: Date; title: string; description: string; attendeeEmail: string; status: 'tentative' | 'confirmed' }): Promise<{ externalEventId: string }>;
  confirmEvent(primary: CalendarConnection, externalEventId: string): Promise<void>;
  /** Zeit oder Titel eines bestehenden Eintrags ändern (Verschiebung durch den Gastgeber, Notizänderung). */
  updateEvent(primary: CalendarConnection, externalEventId: string, patch: { start: Date; end: Date; title?: string; description?: string }): Promise<void>;
  deleteEvent(primary: CalendarConnection, externalEventId: string): Promise<void>;
}

export interface AvailabilityCache {
  /** Liefert Blöcke plus Alter des Cache-Eintrags; null bei Miss. */
  get(connectionId: string, from: Date, to: Date): Promise<{ busy: BusyBlock[]; ageMs: number } | null>;
  set(connectionId: string, from: Date, to: Date, busy: BusyBlock[], ttlMs: number): Promise<void>;
  invalidate(connectionId: string): Promise<void>;
}

export interface SlotLocker {
  /** SET NX PX; liefert Token oder null, wenn der Lock vergeben ist. */
  acquire(key: string, ttlMs: number): Promise<string | null>;
  /** Compare-and-delete über Lua, damit nur der Inhaber freigibt. */
  release(key: string, token: string): Promise<void>;
}

export interface BookingRepository {
  findByIdempotencyKey(hostId: string, key: string): Promise<BookingRecord | null>;
  /** Wirft SlotTakenError, wenn der EXCLUDE-Constraint (SQLSTATE 23P01) greift. */
  insert(record: Omit<BookingRecord, 'id' | 'verifyAttempts'>): Promise<BookingRecord>;
  update(id: string, patch: Partial<Pick<BookingRecord, 'status' | 'externalEventId' | 'externalCalendarId' | 'verifyAttempts'>>): Promise<BookingRecord>;
  loadHostContext(hostId: string): Promise<HostContext>;
}

export interface JobQueue {
  enqueue(name: 'verify-booking', payload: { bookingId: string }, opts: { delayMs: number }): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}
