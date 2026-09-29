/**
 * STW-102 · Write-then-Verify-Lock
 *
 *  1. Frische   Free/Busy aus Cache, wenn jünger als FRESH_MS, sonst live laden.
 *  2. Lock      Redis SET NX PX 20000 auf (host, startUtc).
 *  3. Schreiben Termin als tentative in den Primärkalender.
 *  4. Verify    Free/Busy live über alle blockierenden Kalender; fremder Block => zurückrollen.
 *  5. Commit    Postgres-Insert (EXCLUDE-Constraint), Kalendereintrag auf confirmed.
 *
 * 429-Pfade:
 *  - Schritt 3 drosselt nach Retries  => Buchung als pending_verification OHNE Event-ID, Job legt Event an und verifiziert.
 *  - Schritt 4 drosselt nach Retries  => Buchung als pending_verification MIT Event-ID, Job verifiziert.
 *  In beiden Fällen bleibt der Lock bis zum Ende des Requests, danach schützt der DB-Constraint.
 */
import { computeSlots, isSlotInsideRules, overlaps, type BusyBlock } from '../availability/slotEngine.js';
import { ProviderAuthError, ProviderRateLimitError, ProviderUnavailableError, SlotLockedError, SlotOutsideAvailabilityError, SlotTakenError } from './errors.js';
import { slotLockKey } from './redisLock.js';
import { withRetry, type RetryOptions } from './retry.js';
import type { AvailabilityCache, BookingRecord, BookingRepository, BookingRequest, BookingResult, CalendarProvider, Clock, HostContext, JobQueue, Logger, SlotLocker } from './types.js';
import type { Outbox } from '../sync/outbox.js';
import type { AlertService } from '../sync/alerts.js';
import type { PgLike } from './pgBookingRepository.js';

export interface BookingServiceDeps {
  repo: BookingRepository;
  cache: AvailabilityCache;
  locker: SlotLocker;
  providers: Record<string, CalendarProvider>; // key = provider name
  queue: JobQueue;
  clock: Clock;
  log: Logger;
  retry?: RetryOptions;
  /** R2: Outbox für CONFIRM nach gescheiterter Kalender-Bestätigung; `db` führt den Insert aus (kein Lock mehr aktiv). */
  outbox: Outbox;
  db: PgLike;
  /** R2: 401 beim Anlegen → Verbindung braucht Reauth, Tenant wird gewarnt, Buchung schlägt fehl. */
  alerts: AlertService;
}

export const LOCK_TTL_MS = 20_000;
export const FRESH_MS = 30_000; // Cache-Alter, ab dem vor dem Lock neu gelesen wird
export const CACHE_TTL_MS = 90_000;
export const PENDING_VERIFY_DELAY_MS = 15_000;
export const PENDING_VERIFY_DEADLINE_MS = 10 * 60_000;

export class BookingService {
  constructor(private readonly d: BookingServiceDeps) {}

  async createBooking(req: BookingRequest): Promise<BookingResult> {
    // Idempotenz auf API-Ebene: gleicher Key => gleiche Antwort, kein zweiter Kalendereintrag.
    const existing = await this.d.repo.findByIdempotencyKey(req.hostId, req.idempotencyKey);
    if (existing) return this.toResult(existing);

    const host = await this.d.repo.loadHostContext(req.hostId);
    if (!isSlotInsideRules(req.startUtc, req.endUtc, host.timezone, host.rules)) {
      throw new SlotOutsideAvailabilityError();
    }
    const primary = host.connections.find((c) => c.isPrimary);
    if (!primary) throw new Error(`Host ${req.hostId} hat keinen Primärkalender.`);
    const provider = this.d.providers[primary.provider];
    const blocking = host.connections.filter((c) => c.isBlocking);
    const window = this.verifyWindow(req, host);

    // ── Schritt 1: Frische ────────────────────────────────────────────────
    const busy = await this.freeBusyFresh(blocking, window, provider);
    if (this.hasForeignConflict(busy, req, null)) {
      throw new SlotTakenError(await this.alternatives(host, busy, req));
    }

    // ── Schritt 2: Lock ───────────────────────────────────────────────────
    const key = slotLockKey(req.hostId, req.startUtc);
    const token = await this.d.locker.acquire(key, LOCK_TTL_MS);
    if (!token) throw new SlotLockedError(await this.alternatives(host, busy, req));

    let externalEventId: string | null = null;
    try {
      // ── Schritt 3: Schreiben (tentative) ───────────────────────────────
      try {
        const created = await withRetry(
          () =>
            provider.createEvent(primary, {
              start: req.startUtc,
              end: req.endUtc,
              title: `Slotwise: ${req.booker.name}`,
              description: req.notes ?? '',
              attendeeEmail: req.booker.email,
              status: 'tentative',
            }),
          this.d.retry,
        );
        externalEventId = created.externalEventId;
      } catch (err) {
        if (err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) {
          return this.persistPending(req, host, primary.id, null, 'create_throttled');
        }
        if (err instanceof ProviderAuthError) {
          // Kein Retry sinnvoll: Alarm für den Tenant, Buchende bekommen einen klaren Fehler (503), nichts wird gespeichert.
          await this.d.alerts.raise({ tenantId: host.tenantId, code: 'CALENDAR_REAUTH_REQUIRED', connectionId: primary.id, hostId: host.hostId, jobId: null, detail: err.message });
        }
        throw err;
      }

      // ── Schritt 4: Live-Verifikation über alle blockierenden Kalender ──
      let liveBusy: BusyBlock[];
      try {
        liveBusy = await withRetry(() => provider.getFreeBusy(blocking, window.from, window.to), this.d.retry);
      } catch (err) {
        if (err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) {
          return this.persistPending(req, host, primary.id, externalEventId, 'verify_throttled');
        }
        throw err;
      }
      await this.refreshCache(blocking, window, liveBusy);

      if (this.hasForeignConflict(liveBusy, req, externalEventId)) {
        await this.safeDelete(provider, primary, externalEventId);
        externalEventId = null;
        throw new SlotTakenError(await this.alternatives(host, liveBusy, req));
      }

      // ── Schritt 5: Commit ──────────────────────────────────────────────
      let record: BookingRecord;
      try {
        record = await this.d.repo.insert({
          hostId: req.hostId,
          eventTypeId: req.eventTypeId,
          startUtc: req.startUtc,
          endUtc: req.endUtc,
          status: 'confirmed',
          bookerTimezone: req.bookerTimezone,
          hostTimezoneAtBooking: host.timezone,
          externalEventId,
          externalCalendarId: primary.id,
          idempotencyKey: req.idempotencyKey,
        });
      } catch (err) {
        // EXCLUDE-Constraint hat eine parallele Buchung erkannt: Kalendereintrag zurücknehmen.
        if (err instanceof SlotTakenError) {
          await this.safeDelete(provider, primary, externalEventId);
          externalEventId = null;
        }
        throw err;
      }
      // Bestätigung im Kalender ist nicht kritisch für die Buchung: schlägt sie fehl, übernimmt die Outbox (CONFIRM-Job).
      try {
        await withRetry(() => provider.confirmEvent(primary, externalEventId!), this.d.retry);
      } catch (err) {
        this.d.log.warn('confirmEvent fehlgeschlagen, Outbox übernimmt', { bookingId: record.id, err: String(err) });
        const job = await this.d.outbox.enqueue(this.d.db, { tenantId: host.tenantId, hostId: host.hostId, bookingId: record.id, connectionId: primary.id, operation: 'CONFIRM', payload: {} });
        await this.d.outbox.kick(job);
      }
      this.d.log.info('booking.confirmed', { bookingId: record.id, hostId: req.hostId });
      return { kind: 'confirmed', booking: record };
    } finally {
      await this.d.locker.release(key, token);
    }
  }

  // ───────────────────────────────────────────────────────────────────────
  // Hilfsfunktionen
  // ───────────────────────────────────────────────────────────────────────

  private verifyWindow(req: BookingRequest, host: HostContext) {
    return {
      from: new Date(req.startUtc.getTime() - host.bufferBeforeMinutes * 60_000),
      to: new Date(req.endUtc.getTime() + host.bufferAfterMinutes * 60_000),
    };
  }

  /** Cache nutzen, wenn jung genug; sonst live laden. Nur der Live-Pfad kann drosseln. */
  private async freeBusyFresh(blocking: HostContext['connections'], window: { from: Date; to: Date }, provider: CalendarProvider): Promise<BusyBlock[]> {
    const cached = await Promise.all(blocking.map((c) => this.d.cache.get(c.id, window.from, window.to)));
    const allFresh = cached.every((c) => c && c.ageMs <= FRESH_MS);
    if (allFresh) return cached.flatMap((c) => c!.busy);
    try {
      const live = await withRetry(() => provider.getFreeBusy(blocking, window.from, window.to), this.d.retry);
      await this.refreshCache(blocking, window, live);
      return live;
    } catch (err) {
      // Vor dem Lock ist Drosselung kein Grund abzubrechen: mit dem (älteren) Cache weiterarbeiten,
      // Schritt 4 verifiziert ohnehin live.
      if ((err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError) && cached.every(Boolean)) {
        this.d.log.warn('freeBusy live fehlgeschlagen, nutze Cache', { err: String(err) });
        return cached.flatMap((c) => c!.busy);
      }
      throw err;
    }
  }

  private async refreshCache(blocking: HostContext['connections'], window: { from: Date; to: Date }, busy: BusyBlock[]) {
    await Promise.all(blocking.map((c) => this.d.cache.set(c.id, window.from, window.to, busy, CACHE_TTL_MS)));
  }

  /** Konflikt = irgendein Block überlappt den gepufferten Slot und ist nicht unser eigener Eintrag. */
  private hasForeignConflict(busy: BusyBlock[], req: BookingRequest, ownEventId: string | null): boolean {
    return busy.some((b) => b.externalEventId !== ownEventId && overlaps(req.startUtc, req.endUtc, b.start, b.end));
  }

  private async alternatives(host: HostContext, busy: BusyBlock[], req: BookingRequest): Promise<Date[]> {
    const duration = (req.endUtc.getTime() - req.startUtc.getTime()) / 60_000;
    const slots = computeSlots({
      hostTimezone: host.timezone,
      rules: host.rules,
      busy,
      from: req.startUtc,
      to: new Date(req.startUtc.getTime() + 7 * 24 * 60 * 60_000),
      durationMinutes: duration,
      bufferBeforeMinutes: host.bufferBeforeMinutes,
      bufferAfterMinutes: host.bufferAfterMinutes,
      minNoticeMinutes: host.minNoticeMinutes,
      now: this.d.clock.now(),
    });
    return slots.filter((s) => s.start.getTime() !== req.startUtc.getTime()).slice(0, 3).map((s) => s.start);
  }

  private async safeDelete(provider: CalendarProvider, primary: HostContext['connections'][number], externalEventId: string | null) {
    if (!externalEventId) return;
    try {
      await withRetry(() => provider.deleteEvent(primary, externalEventId), this.d.retry);
    } catch (err) {
      // Wird vom Reconciler aufgeräumt (Kalendereinträge ohne Buchung); nie den Fehler verschlucken, aber nicht eskalieren.
      this.d.log.error('deleteEvent fehlgeschlagen, Reconciler nötig', { externalEventId, err: String(err) });
    }
  }

  private async persistPending(req: BookingRequest, host: HostContext, primaryId: string, externalEventId: string | null, reason: string): Promise<BookingResult> {
    const record = await this.d.repo.insert({
      hostId: req.hostId,
      eventTypeId: req.eventTypeId,
      startUtc: req.startUtc,
      endUtc: req.endUtc,
      status: 'pending_verification',
      bookerTimezone: req.bookerTimezone,
      hostTimezoneAtBooking: host.timezone,
      externalEventId,
      externalCalendarId: primaryId,
      idempotencyKey: req.idempotencyKey,
    });
    await this.d.queue.enqueue('verify-booking', { bookingId: record.id }, { delayMs: PENDING_VERIFY_DELAY_MS });
    this.d.log.warn('booking.pending_verification', { bookingId: record.id, reason });
    return { kind: 'pending', booking: record, verifyBy: new Date(this.d.clock.now().getTime() + PENDING_VERIFY_DEADLINE_MS) };
  }

  private toResult(b: BookingRecord): BookingResult {
    return b.status === 'pending_verification'
      ? { kind: 'pending', booking: b, verifyBy: new Date(this.d.clock.now().getTime() + PENDING_VERIFY_DEADLINE_MS) }
      : { kind: 'confirmed', booking: b };
  }
}
