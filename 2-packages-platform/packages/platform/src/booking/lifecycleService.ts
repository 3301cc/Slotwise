/**
 * R1 · Option C · Anwendung der Zustandsmaschine auf gespeicherte Buchungen.
 *
 * Reihenfolge je Aufruf: Buchung + Richtlinie unter FOR UPDATE laden →
 * validateBookingStateTransition (rein) → Gebühr/Erstattung über den
 * Zahlungsadapter → UPDATE mit SET LOCAL slotwise.actor (DB-Guard aus 0004) →
 * Benachrichtigung. Alles in einer Transaktion; schlägt der Zahlungsschritt
 * fehl, bleibt der Status unverändert und der Aufruf ist wiederholbar.
 */
import type { PaymentAdapter } from '../adapters/ports.js';
import type { Db, Tx } from '../metering/ledger.js';
import type { Outbox } from '../sync/outbox.js';
import type { CalendarSyncJob } from '../sync/types.js';
import { validatePolicy, type EventTypePolicy } from './policy.js';
import { validateBookingStateTransition, type Actor, type FeeOutcome, type TransitionResult } from './stateMachine.js';
import type { BookingStatus, Clock, Logger } from './types.js';

export interface LifecycleBooking {
  id: string;
  tenantId: string;
  hostId: string;
  eventTypeId: string;
  startUtc: Date;
  endUtc: Date;
  status: BookingStatus;
  rescheduleCount: number;
  prepaidCents: number;
  paymentId: string | null;
  feeCents: number;
  feeAssessedAt: Date | null;
  refundCents: number;
  bookerEmail: string;
  bookerName: string;
  notes: string | null;
  externalEventId: string | null;
  externalCalendarId: string | null;
}

export interface LifecycleRepository {
  /** Lädt Buchung und Richtlinie gesperrt (FOR UPDATE) innerhalb der Transaktion. */
  loadForUpdate(tx: Tx, bookingId: string): Promise<{ booking: LifecycleBooking; policy: EventTypePolicy } | null>;
  applyTransition(tx: Tx, bookingId: string, actor: Actor, actorUserId: string | null, to: BookingStatus, fee: FeeOutcome, reason: string, now: Date): Promise<void>;
  /** IDs bestätigter Buchungen, deren No-Show-Fenster abgelaufen ist (Sicht bookings_auto_complete). */
  listAutoCompletable(tx: Tx, limit: number): Promise<string[]>;
}

export interface LifecycleNotifier {
  bookingCancelled(b: LifecycleBooking, by: Actor, fee: FeeOutcome): Promise<void>;
  bookingNoShow(b: LifecycleBooking, fee: FeeOutcome): Promise<void>;
  feeWaived(b: LifecycleBooking, refundCents: number): Promise<void>;
}

/** Löst je Tenant den Zahlungsadapter auf (Registry + Zugangsdaten); null, wenn keiner verbunden ist. */
export type PaymentResolver = (tenantId: string) => Promise<PaymentAdapter | null>;

export class TransitionDeniedError extends Error {
  readonly httpStatus = 409;
  constructor(public readonly result: Extract<TransitionResult, { allowed: false }>) {
    super(result.message);
  }
}

export class LifecycleService {
  constructor(
    private readonly db: Db,
    private readonly repo: LifecycleRepository,
    private readonly payments: PaymentResolver,
    private readonly notifier: LifecycleNotifier,
    private readonly clock: Clock,
    private readonly log: Logger,
    private readonly outbox: Outbox,
  ) {}

  cancel(bookingId: string, actor: Actor, actorUserId: string | null, acceptLateFee: boolean): Promise<TransitionResult> {
    return this.transition(bookingId, actor, actorUserId, (b, p, now) => {
      const free = validateBookingStateTransition(b.status, 'cancelled_free', b.startUtc, now, p, this.opts(b, actor));
      if (free.allowed || !free.allowed && free.alternative !== 'cancelled_late') return free;
      // Kostenfreie Frist verstrichen: nur mit ausdrücklicher Bestätigung der Gebühr (UI zeigt Betrag vorher an).
      if (!acceptLateFee) return free;
      return validateBookingStateTransition(b.status, 'cancelled_late', b.startUtc, now, p, this.opts(b, actor));
    });
  }

  markNoShow(bookingId: string, actorUserId: string | null): Promise<TransitionResult> {
    return this.transition(bookingId, 'host', actorUserId, (b, p, now) => validateBookingStateTransition(b.status, 'no_show', b.startUtc, now, p, this.opts(b, 'host')));
  }

  complete(bookingId: string, actor: 'host' | 'system', actorUserId: string | null): Promise<TransitionResult> {
    return this.transition(bookingId, actor, actorUserId, (b, p, now) => validateBookingStateTransition(b.status, 'completed', b.startUtc, now, p, this.opts(b, actor)));
  }

  /** Kulanz: Gebühr erlassen; target = cancelled_free (mit Erstattung) oder completed (doch erschienen). */
  waiveFee(bookingId: string, actorUserId: string | null, target: 'cancelled_free' | 'completed'): Promise<TransitionResult> {
    return this.transition(bookingId, 'host', actorUserId, (b, p, now) => validateBookingStateTransition(b.status, target, b.startUtc, now, p, this.opts(b, 'host')));
  }

  /** Verschieben = alte Buchung → rescheduled; die neue Buchung legt der BookingService mit rescheduled_from_id an. */
  markRescheduled(bookingId: string, actor: 'booker' | 'host', actorUserId: string | null): Promise<TransitionResult> {
    return this.transition(bookingId, actor, actorUserId, (b, p, now) => validateBookingStateTransition(b.status, 'rescheduled', b.startUtc, now, p, this.opts(b, actor)));
  }

  /** Worker-Job: bestätigte Termine nach Ablauf des No-Show-Fensters abschließen. */
  async autoCompleteBatch(limit = 200): Promise<number> {
    const ids = await this.db.transaction((tx) => this.repo.listAutoCompletable(tx, limit));
    let n = 0;
    for (const id of ids) {
      const r = await this.complete(id, 'system', null);
      if (r.allowed) n++;
    }
    if (n) this.log.info('booking.autocomplete', { count: n });
    return n;
  }

  private opts(b: LifecycleBooking, actor: Actor) {
    return { actor, endUtc: b.endUtc, rescheduleCount: b.rescheduleCount, prepaidCents: b.prepaidCents, feeAssessedAt: b.feeAssessedAt };
  }

  private async transition(bookingId: string, actor: Actor, actorUserId: string | null, decide: (b: LifecycleBooking, p: EventTypePolicy, now: Date) => TransitionResult): Promise<TransitionResult> {
    return this.db.transaction(async (tx) => {
      const loaded = await this.repo.loadForUpdate(tx, bookingId);
      if (!loaded) throw new Error(`Buchung ${bookingId} nicht gefunden`);
      const { booking, policy } = loaded;
      const now = this.clock.now();
      const result = decide(booking, validatePolicy(policy), now);
      if (!result.allowed) {
        this.log.info('booking.transition.denied', { bookingId, from: booking.status, to: result.to, code: result.code, actor });
        return { result, syncJob: null as CalendarSyncJob | null };
      }

      // Geldbewegung vor dem Statuswechsel: schlägt sie fehl, rollt die Transaktion zurück.
      await this.settle(booking, result.fee);

      await this.repo.applyTransition(tx, bookingId, actor, actorUserId, result.to, result.fee, result.reason, now);
      this.log.info('booking.transition', { bookingId, from: booking.status, to: result.to, actor, fee: result.fee.amountCents, refund: result.fee.refundPrepaymentCents });

      // Outbox in derselben Transaktion: Kalendereintrag entfernen, wenn der Termin nicht mehr stattfindet.
      let syncJob: CalendarSyncJob | null = null;
      if (booking.externalCalendarId && ['cancelled_free', 'cancelled_late', 'rescheduled'].includes(result.to) && booking.externalEventId) {
        syncJob = await this.outbox.enqueue(tx, { tenantId: booking.tenantId, hostId: booking.hostId, bookingId: booking.id, connectionId: booking.externalCalendarId, operation: 'DELETE', payload: {} });
      }

      const after = { ...booking, status: result.to };
      if (result.to === 'cancelled_free' || result.to === 'cancelled_late') {
        if (result.fee.waived) await this.notifier.feeWaived(after, result.fee.refundPrepaymentCents);
        else await this.notifier.bookingCancelled(after, actor, result.fee);
      } else if (result.to === 'no_show') await this.notifier.bookingNoShow(after, result.fee);
      else if (result.to === 'completed' && result.fee.waived) await this.notifier.feeWaived(after, 0);
      return { result, syncJob };
    }).then(async ({ result, syncJob }) => {
      // Nach dem Commit: Relay anstoßen (NOTIFY und Sweep decken den Rest ab).
      if (syncJob) await this.outbox.kick(syncJob);
      return result;
    });
  }

  private async settle(b: LifecycleBooking, fee: FeeOutcome): Promise<void> {
    if (fee.refundPrepaymentCents > 0) {
      if (!b.paymentId) throw new Error(`Buchung ${b.id}: Erstattung ohne payment_id`);
      const adapter = await this.payments(b.tenantId);
      if (!adapter) throw new Error(`Tenant ${b.tenantId}: kein Zahlungsadapter für Erstattung verbunden`);
      await adapter.refund(b.paymentId, fee.refundPrepaymentCents, fee.waived ? 'Slotwise: Gebühr erlassen' : 'Slotwise: Terminabsage');
    }
    if (fee.chargeable && fee.mode === 'charge_on_file') {
      // Belastung eines hinterlegten Zahlungsmittels erfolgt über den Checkout-Flow des Anbieters
      // (Mandat/Setup-Intent); hier wird nur sichergestellt, dass ein Adapter existiert.
      const adapter = await this.payments(b.tenantId);
      if (!adapter) throw new Error(`Tenant ${b.tenantId}: charge_on_file ohne verbundenen Zahlungsadapter`);
    }
    // prepaid_forfeit: Einbehalt = keine Aktion; invoice: Rechnungslauf liest bookings.fee_cents.
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL-Implementierung des Repositories
// ---------------------------------------------------------------------------

export class PgLifecycleRepository implements LifecycleRepository {
  async loadForUpdate(tx: Tx, bookingId: string): Promise<{ booking: LifecycleBooking; policy: EventTypePolicy } | null> {
    const { rows } = await tx.query(
      `SELECT b.id, b.tenant_id, b.host_id, b.event_type_id, b.start_utc, b.end_utc, b.status, b.reschedule_count, b.prepaid_cents, b.payment_id,
              b.fee_cents, b.fee_assessed_at, b.refund_cents, b.booker_email, b.booker_name, b.notes, b.external_event_id, b.external_calendar_id,
              p.min_notice_minutes, p.cancel_cutoff_minutes, p.reschedule_cutoff_minutes, p.max_reschedules, p.no_show_fee_cents, p.late_cancel_fee_cents,
              p.fee_mode, p.fee_applies_to, p.no_show_grace_minutes, p.no_show_window_minutes, p.fee_waive_window_minutes, p.withdrawal_right, p.price_cents
         FROM bookings b
         LEFT JOIN event_type_policies p ON p.event_type_id = b.event_type_id
        WHERE b.id = $1
        FOR UPDATE OF b`,
      [bookingId],
    );
    const r = rows[0];
    if (!r) return null;
    const booking: LifecycleBooking = {
      id: String(r.id), tenantId: String(r.tenant_id), hostId: String(r.host_id), eventTypeId: String(r.event_type_id),
      startUtc: new Date(r.start_utc as string), endUtc: new Date(r.end_utc as string), status: r.status as BookingStatus,
      rescheduleCount: Number(r.reschedule_count ?? 0), prepaidCents: Number(r.prepaid_cents ?? 0), paymentId: (r.payment_id as string | null) ?? null,
      feeCents: Number(r.fee_cents ?? 0), feeAssessedAt: r.fee_assessed_at ? new Date(r.fee_assessed_at as string) : null, refundCents: Number(r.refund_cents ?? 0),
      bookerEmail: String(r.booker_email ?? ''),
      bookerName: String(r.booker_name ?? ''),
      notes: (r.notes as string | null) ?? null,
      externalEventId: (r.external_event_id as string | null) ?? null,
      externalCalendarId: (r.external_calendar_id as string | null) ?? null,
    };
    const policy: EventTypePolicy = r.fee_mode === null || r.fee_mode === undefined
      ? { eventTypeId: booking.eventTypeId, minNoticeMinutes: 120, cancelCutoffMinutes: 1440, rescheduleCutoffMinutes: 1440, maxReschedules: 2, noShowFeeCents: 0, lateCancelFeeCents: null, feeMode: 'none', feeAppliesTo: 'no_show', noShowGraceMinutes: 15, noShowWindowMinutes: 10080, feeWaiveWindowMinutes: 43200, withdrawalRight: 'applies', priceCents: 0 }
      : {
          eventTypeId: booking.eventTypeId,
          minNoticeMinutes: Number(r.min_notice_minutes), cancelCutoffMinutes: Number(r.cancel_cutoff_minutes), rescheduleCutoffMinutes: Number(r.reschedule_cutoff_minutes),
          maxReschedules: Number(r.max_reschedules), noShowFeeCents: Number(r.no_show_fee_cents), lateCancelFeeCents: r.late_cancel_fee_cents === null ? null : Number(r.late_cancel_fee_cents),
          feeMode: r.fee_mode as EventTypePolicy['feeMode'], feeAppliesTo: r.fee_applies_to as EventTypePolicy['feeAppliesTo'],
          noShowGraceMinutes: Number(r.no_show_grace_minutes), noShowWindowMinutes: Number(r.no_show_window_minutes), feeWaiveWindowMinutes: Number(r.fee_waive_window_minutes),
          withdrawalRight: r.withdrawal_right as EventTypePolicy['withdrawalRight'], priceCents: Number(r.price_cents),
        };
    return { booking, policy };
  }

  async applyTransition(tx: Tx, bookingId: string, actor: Actor, actorUserId: string | null, to: BookingStatus, fee: FeeOutcome, reason: string, now: Date): Promise<void> {
    // Der Guard-Trigger liest slotwise.actor; SET LOCAL gilt nur für diese Transaktion.
    await tx.query(`SELECT set_config('slotwise.actor', $1, true)`, [actor]);
    const sets = [`status = $2`];
    const values: unknown[] = [bookingId, to];
    if (fee.chargeable) {
      values.push(fee.amountCents, fee.basis, now);
      sets.push(`fee_cents = $${values.length - 2}`, `fee_basis = $${values.length - 1}`, `fee_assessed_at = $${values.length}`);
    }
    if (fee.waived) {
      values.push(now);
      sets.push(`fee_cents = 0`, `fee_basis = NULL`, `fee_waived_at = $${values.length}`);
    }
    if (fee.refundPrepaymentCents > 0) {
      values.push(fee.refundPrepaymentCents);
      sets.push(`refund_cents = refund_cents + $${values.length}`);
    }
    if (to === 'rescheduled' && actor === 'booker') sets.push(`reschedule_count = reschedule_count + 1`);
    const { rowCount } = await tx.query(`UPDATE bookings SET ${sets.join(', ')} WHERE id = $1`, values);
    if (rowCount !== 1) throw new Error(`Buchung ${bookingId}: Statuswechsel nicht geschrieben`);
    await tx.query(`UPDATE booking_events SET reason = $2, actor_user_id = $3 WHERE id = (SELECT max(id) FROM booking_events WHERE booking_id = $1)`, [bookingId, reason, actorUserId]);
  }

  async listAutoCompletable(tx: Tx, limit: number): Promise<string[]> {
    const { rows } = await tx.query<{ id: string }>(`SELECT id FROM bookings_auto_complete LIMIT $1`, [limit]);
    return rows.map((r) => r.id);
  }
}
