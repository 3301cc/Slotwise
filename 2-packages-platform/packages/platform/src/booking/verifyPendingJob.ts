/**
 * Worker für Buchungen im Status pending_verification.
 * Läuft mit Verzögerung und Backoff, bis der Provider wieder antwortet.
 * Nach Ablauf der Frist (10 min) wird die Buchung als cancelled_conflict
 * geschlossen und der Buchende mit Alternativen benachrichtigt.
 */
import { overlaps } from '../availability/slotEngine.js';
import { ProviderAuthError, ProviderRateLimitError, ProviderUnavailableError } from './errors.js';
import type { AlertService } from '../sync/alerts.js';
import { withRetry, type RetryOptions } from './retry.js';
import { PENDING_VERIFY_DEADLINE_MS } from './bookingService.js';
import type { BookingRecord, BookingRepository, CalendarProvider, Clock, JobQueue, Logger } from './types.js';

export interface Notifier {
  bookingConfirmed(b: BookingRecord): Promise<void>;
  bookingFailed(b: BookingRecord, reason: 'conflict' | 'timeout'): Promise<void>;
}

export interface VerifyJobDeps {
  repo: BookingRepository;
  providers: Record<string, CalendarProvider>;
  queue: JobQueue;
  notifier: Notifier;
  clock: Clock;
  log: Logger;
  retry?: RetryOptions;
  loadBooking(id: string): Promise<BookingRecord & { createdAt: Date }>;
  /** R2: 401 während der Verifikation → Alarm; die Buchung wird sofort als nicht verifizierbar geschlossen. */
  alerts: AlertService;
}

const BACKOFF_MS = [15_000, 30_000, 60_000, 120_000, 120_000, 120_000];

export async function verifyPendingBooking(d: VerifyJobDeps, bookingId: string): Promise<void> {
  const b = await d.loadBooking(bookingId);
  if (b.status !== 'pending_verification') return; // bereits erledigt (Idempotenz des Jobs)

  const host = await d.repo.loadHostContext(b.hostId);
  const primary = host.connections.find((c) => c.isPrimary)!;
  const provider = d.providers[primary.provider];
  const blocking = host.connections.filter((c) => c.isBlocking);
  const from = new Date(b.startUtc.getTime() - host.bufferBeforeMinutes * 60_000);
  const to = new Date(b.endUtc.getTime() + host.bufferAfterMinutes * 60_000);

  try {
    let externalEventId = b.externalEventId;
    if (!externalEventId) {
      const created = await withRetry(
        () => provider.createEvent(primary, { start: b.startUtc, end: b.endUtc, title: 'Slotwise (Verifikation)', description: '', attendeeEmail: '', status: 'tentative' }),
        d.retry,
      );
      externalEventId = created.externalEventId;
      await d.repo.update(b.id, { externalEventId });
    }

    const busy = await withRetry(() => provider.getFreeBusy(blocking, from, to), d.retry);
    const conflict = busy.some((x) => x.externalEventId !== externalEventId && overlaps(b.startUtc, b.endUtc, x.start, x.end));

    if (conflict) {
      await withRetry(() => provider.deleteEvent(primary, externalEventId!), d.retry);
      const updated = await d.repo.update(b.id, { status: 'cancelled_conflict', externalEventId: null });
      await d.notifier.bookingFailed(updated, 'conflict');
      d.log.warn('booking.verify.conflict', { bookingId: b.id });
      return;
    }

    await withRetry(() => provider.confirmEvent(primary, externalEventId!), d.retry);
    const updated = await d.repo.update(b.id, { status: 'confirmed' });
    await d.notifier.bookingConfirmed(updated);
    d.log.info('booking.verify.confirmed', { bookingId: b.id, attempts: b.verifyAttempts + 1 });
  } catch (err) {
    if (err instanceof ProviderAuthError) {
      // Wiederholen ist zwecklos; der Host muss neu verbinden. Buchende werden sofort informiert.
      await d.alerts.raise({ tenantId: host.tenantId, code: 'CALENDAR_REAUTH_REQUIRED', connectionId: primary.id, hostId: host.hostId, jobId: null, detail: err.message });
      const updated = await d.repo.update(b.id, { status: 'cancelled_conflict', verifyAttempts: b.verifyAttempts + 1 });
      await d.notifier.bookingFailed(updated, 'timeout');
      d.log.error('booking.verify.auth_failed', { bookingId: b.id, connectionId: primary.id });
      return;
    }
    if (!(err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError)) throw err;
    const attempts = b.verifyAttempts + 1;
    const expired = d.clock.now().getTime() - b.createdAt.getTime() > PENDING_VERIFY_DEADLINE_MS;
    if (expired) {
      const updated = await d.repo.update(b.id, { status: 'cancelled_conflict', verifyAttempts: attempts });
      await d.notifier.bookingFailed(updated, 'timeout');
      d.log.error('booking.verify.timeout', { bookingId: b.id, attempts });
      return;
    }
    await d.repo.update(b.id, { verifyAttempts: attempts });
    const delayMs = BACKOFF_MS[Math.min(attempts, BACKOFF_MS.length - 1)];
    await d.queue.enqueue('verify-booking', { bookingId: b.id }, { delayMs });
    d.log.warn('booking.verify.retry', { bookingId: b.id, attempts, delayMs });
  }
}
