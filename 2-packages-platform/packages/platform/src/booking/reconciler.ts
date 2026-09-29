/**
 * R1 · Option B · Reconciler für Kalender und Buchungen.
 *
 * Der Write-then-Verify-Lock aus R0 legt Kalendereinträge an, bevor die
 * Buchung committet ist. Bricht der Prozess dazwischen ab (Prozess-Crash,
 * Provider-Fehler beim deleteEvent, verlorener Job), bleiben drei Arten von
 * Inkonsistenzen zurück, die dieser Job periodisch behebt:
 *
 *   1. Verwaiste Kalendereinträge: von Slotwise angelegt, aber keine aktive
 *      Buchung verweist darauf → löschen (erst nach ORPHAN_MIN_AGE_MS, damit
 *      laufende Buchungsprozesse nicht gestört werden).
 *   2. Fehlende Kalendereinträge: bestätigte Buchung, deren Eintrag der Gastgeber
 *      im Kalender gelöscht hat → markieren und Gastgeber informieren, nicht
 *      automatisch stornieren (der Gastgeber entscheidet).
 *   3. Hängende pending_verification-Buchungen ohne Job (Queue-Verlust) →
 *      verify-booking erneut einreihen; verifyPendingJob beendet sie sauber.
 *
 * Läuft je Host in einem Fenster [now − LOOKBACK, now + HORIZON]; alle
 * Aktionen sind idempotent, Fehler eines Hosts brechen die anderen nicht ab.
 */
import type { CalendarConnection, CalendarProvider, Clock, JobQueue, Logger } from './types.js';
import type { BookingStatus } from './types.js';
import { PENDING_VERIFY_DEADLINE_MS } from './bookingService.js';
import { withRetry, type RetryOptions } from './retry.js';

export interface OwnEvent {
  externalEventId: string;
  status: 'tentative' | 'confirmed' | 'cancelled';
  createdAt: Date | null;
  start: Date;
  end: Date;
}

/** Provider, die ihre eigenen Einträge auflisten können (CalDAV, Google mit privateExtendedProperty, Graph mit singleValueExtendedProperties). */
export interface ReconcilableCalendarProvider extends CalendarProvider {
  listOwnEvents(primary: CalendarConnection, from: Date, to: Date): Promise<OwnEvent[]>;
}

export function isReconcilable(p: CalendarProvider): p is ReconcilableCalendarProvider {
  return typeof (p as ReconcilableCalendarProvider).listOwnEvents === 'function';
}

export interface ReconcilerBooking {
  id: string;
  tenantId: string;
  hostId: string;
  status: BookingStatus;
  externalEventId: string | null;
  startUtc: Date;
  endUtc: Date;
  createdAt: Date;
}

export interface ReconcilerRepository {
  listHostIds(): Promise<string[]>;
  loadPrimaryConnection(hostId: string): Promise<CalendarConnection | null>;
  /** Buchungen des Hosts im Fenster, alle Status. */
  listBookings(hostId: string, from: Date, to: Date): Promise<ReconcilerBooking[]>;
  /** pending_verification älter als `olderThan`. */
  listStalePending(olderThan: Date): Promise<ReconcilerBooking[]>;
  /** Buchungen des Hosts mit offenen Outbox-Jobs (PENDING/RETRY/RUNNING): der Relay ist zuständig, nicht der Reconciler. */
  listBookingIdsWithOpenSyncJobs(hostId: string): Promise<Set<string>>;
  markExternalEventMissing(bookingId: string, at: Date): Promise<void>;
  clearExternalEventMissing(bookingId: string): Promise<void>;
  recordRun(run: ReconcileReport): Promise<void>;
}

export interface ReconcilerNotifier {
  externalEventMissing(b: ReconcilerBooking): Promise<void>;
}

export interface ReconcileReport {
  hostId: string | null;
  startedAt: Date;
  finishedAt: Date;
  hostsChecked: number;
  orphansDeleted: string[];
  missingFlagged: string[];
  pendingRequeued: string[];
  errors: { hostId: string; message: string }[];
}

export interface ReconcilerDeps {
  repo: ReconcilerRepository;
  providers: Record<string, CalendarProvider>;
  queue: JobQueue;
  notifier: ReconcilerNotifier;
  clock: Clock;
  log: Logger;
  retry?: RetryOptions;
}

export const ORPHAN_MIN_AGE_MS = 20 * 60_000; // > Lock-TTL (20 s) + Pending-Frist (10 min) + Reserve
export const LOOKBACK_MS = 2 * 24 * 3600_000;
export const HORIZON_MS = 90 * 24 * 3600_000;
export const STALE_PENDING_GRACE_MS = 5 * 60_000;

const ACTIVE: ReadonlySet<BookingStatus> = new Set(['tentative', 'pending_verification', 'confirmed']);

export class CalendarReconciler {
  constructor(private readonly d: ReconcilerDeps) {}

  async run(hostId: string | null): Promise<ReconcileReport> {
    const startedAt = this.d.clock.now();
    const report: ReconcileReport = { hostId, startedAt, finishedAt: startedAt, hostsChecked: 0, orphansDeleted: [], missingFlagged: [], pendingRequeued: [], errors: [] };
    const hosts = hostId ? [hostId] : await this.d.repo.listHostIds();
    for (const h of hosts) {
      try {
        await this.reconcileHost(h, report);
        report.hostsChecked++;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push({ hostId: h, message });
        this.d.log.error('reconcile.host.failed', { hostId: h, err: message });
      }
    }
    await this.requeueStalePending(report);
    report.finishedAt = this.d.clock.now();
    await this.d.repo.recordRun(report);
    this.d.log.info('reconcile.done', { hosts: report.hostsChecked, orphans: report.orphansDeleted.length, missing: report.missingFlagged.length, requeued: report.pendingRequeued.length, errors: report.errors.length });
    return report;
  }

  private async reconcileHost(hostId: string, report: ReconcileReport): Promise<void> {
    const primary = await this.d.repo.loadPrimaryConnection(hostId);
    if (!primary) return;
    const provider = this.d.providers[primary.provider];
    if (!provider) throw new Error(`Kein Provider für ${primary.provider}`);
    if (!isReconcilable(provider)) {
      this.d.log.warn('reconcile.provider.unsupported', { hostId, provider: primary.provider });
      return;
    }
    const now = this.d.clock.now();
    const from = new Date(now.getTime() - LOOKBACK_MS);
    const to = new Date(now.getTime() + HORIZON_MS);

    const [events, bookings, openSync] = await Promise.all([
      withRetry(() => provider.listOwnEvents(primary, from, to), this.d.retry),
      this.d.repo.listBookings(hostId, from, to),
      this.d.repo.listBookingIdsWithOpenSyncJobs(hostId),
    ]);
    const byEvent = new Map<string, ReconcilerBooking>();
    for (const b of bookings) if (b.externalEventId) byEvent.set(b.externalEventId, b);

    // 1. Verwaiste Einträge
    for (const ev of events) {
      if (ev.status === 'cancelled') continue;
      const b = byEvent.get(ev.externalEventId);
      const referencedByActive = b !== undefined && ACTIVE.has(b.status);
      if (referencedByActive) continue;
      if (b && openSync.has(b.id)) continue; // DELETE-Job läuft bereits über die Outbox
      const age = ev.createdAt ? now.getTime() - ev.createdAt.getTime() : Number.POSITIVE_INFINITY;
      if (age < ORPHAN_MIN_AGE_MS) continue; // Buchungsprozess läuft möglicherweise noch
      await withRetry(() => provider.deleteEvent(primary, ev.externalEventId), this.d.retry);
      report.orphansDeleted.push(ev.externalEventId);
      this.d.log.warn('reconcile.orphan.deleted', { hostId, externalEventId: ev.externalEventId, bookingStatus: b?.status ?? null });
    }

    // 2. Fehlende Einträge bei bestätigten Buchungen (nur, wenn der Termin noch bevorsteht)
    const eventIds = new Set(events.map((e) => e.externalEventId));
    for (const b of bookings) {
      if (b.status !== 'confirmed' || !b.externalEventId || b.startUtc.getTime() < now.getTime()) continue;
      if (openSync.has(b.id)) continue; // CREATE/CONFIRM noch unterwegs
      if (eventIds.has(b.externalEventId)) {
        await this.d.repo.clearExternalEventMissing(b.id);
        continue;
      }
      await this.d.repo.markExternalEventMissing(b.id, now);
      await this.d.notifier.externalEventMissing(b);
      report.missingFlagged.push(b.id);
      this.d.log.warn('reconcile.event.missing', { hostId, bookingId: b.id, externalEventId: b.externalEventId });
    }
  }

  private async requeueStalePending(report: ReconcileReport): Promise<void> {
    const now = this.d.clock.now();
    const olderThan = new Date(now.getTime() - PENDING_VERIFY_DEADLINE_MS - STALE_PENDING_GRACE_MS);
    const stale = await this.d.repo.listStalePending(olderThan);
    for (const b of stale) {
      await this.d.queue.enqueue('verify-booking', { bookingId: b.id }, { delayMs: 0 });
      report.pendingRequeued.push(b.id);
      this.d.log.warn('reconcile.pending.requeued', { bookingId: b.id, ageMs: now.getTime() - b.createdAt.getTime() });
    }
  }
}
