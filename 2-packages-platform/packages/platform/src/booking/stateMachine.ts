/**
 * R1 · Option C · Zustandsmaschine für Buchungen mit Fristen und Gebühren.
 *
 * validateBookingStateTransition() ist eine reine Funktion: keine I/O, keine
 * Uhr, keine Zufälligkeit. Alle Zeiten sind UTC-Instants; Fristen sind Dauern
 * (siehe policy.ts). Die Funktion liefert entweder den erlaubten Übergang mit
 * Gebührenergebnis oder eine sprechende Ablehnung mit Code für die API.
 *
 * Zustandstabelle (from → to · Akteur · Bedingung):
 *
 *   ∅                    → tentative            booker/host/system · start ≥ now + minNotice
 *   ∅                    → confirmed            system · R0-Lock-Prozess (Kalender bestätigt), start ≥ now + minNotice
 *   ∅                    → pending_verification system · R0-Lock-Prozess (Provider gedrosselt), start ≥ now + minNotice
 *   tentative            → pending_verification system
 *   tentative            → confirmed            system
 *   tentative            → cancelled_conflict   system
 *   pending_verification → confirmed            system
 *   pending_verification → cancelled_conflict   system
 *   pending_verification → cancelled_free       booker/host        · jederzeit (nichts zugesagt)
 *   confirmed            → cancelled_free       booker · now ≤ start − cancelCutoff
 *                                               host/system · jederzeit (Gastgeber trägt Ausfall)
 *   confirmed            → cancelled_late       booker · start − cancelCutoff < now < start · Gebühr nach feeAppliesTo
 *   confirmed            → rescheduled          booker · now ≤ start − rescheduleCutoff ∧ count < maxReschedules
 *                                               host · now < start
 *   confirmed            → no_show              host/system · start + grace ≤ now ≤ end + noShowWindow · Gebühr nach feeAppliesTo
 *   confirmed            → completed            host/system · now ≥ end
 *   no_show              → completed            host · Korrektur innerhalb feeWaiveWindow, Gebühr entfällt
 *   no_show              → cancelled_free       host · Kulanz innerhalb feeWaiveWindow, Gebühr entfällt
 *   cancelled_late       → cancelled_free       host · Kulanz innerhalb feeWaiveWindow, Gebühr entfällt
 *   rescheduled, cancelled_*, completed          → Endzustände (außer den Kulanzpfaden oben)
 */
import type { BookingStatus } from './types.js';
import { feeFor, type EventTypePolicy, type FeeMode } from './policy.js';

export type Actor = 'booker' | 'host' | 'system';

export interface FeeOutcome {
  /** Gebühr fällt an und ist einzuziehen (bzw. Vorkasse einzubehalten). */
  chargeable: boolean;
  amountCents: number;
  mode: FeeMode;
  basis: 'no_show' | 'late_cancel' | null;
  /** Eine zuvor festgesetzte Gebühr wird erlassen (Kulanzpfad). */
  waived: boolean;
  /** Vorkasse ist zu erstatten (kostenfreie Stornierung oder Absage durch Gastgeber). */
  refundPrepaymentCents: number;
}

export interface TransitionOptions {
  /** Wer den Übergang auslöst. Standard: booker (strengste Regeln). */
  actor: Actor;
  /** Terminende; Standard: Terminbeginn (relevant für completed und das No-Show-Fenster). */
  endUtc: Date;
  /** Zahl bisheriger Verschiebungen durch die buchende Person in dieser Buchungskette. */
  rescheduleCount: number;
  /** Bereits per Vorkasse gezahlter Betrag in Cent. */
  prepaidCents: number;
  /** Zeitpunkt, zu dem cancelled_late/no_show gesetzt wurde (für den Kulanzpfad). */
  feeAssessedAt: Date | null;
}

export type TransitionDenialCode =
  | 'UNKNOWN_TRANSITION'
  | 'ACTOR_NOT_ALLOWED'
  | 'MIN_NOTICE'
  | 'RESCHEDULE_CUTOFF'
  | 'RESCHEDULE_LIMIT'
  | 'ALREADY_STARTED'
  | 'NOT_STARTED'
  | 'NO_SHOW_GRACE'
  | 'NO_SHOW_WINDOW'
  | 'NOT_ENDED'
  | 'WAIVE_WINDOW'
  | 'FREE_CANCEL_CUTOFF_PASSED';

export type TransitionResult =
  | { allowed: true; from: BookingStatus | null; to: BookingStatus; actor: Actor; fee: FeeOutcome; reason: string }
  | { allowed: false; from: BookingStatus | null; to: BookingStatus; actor: Actor; code: TransitionDenialCode; message: string; alternative?: BookingStatus; deadline?: Date };

const NO_FEE = (refund = 0): FeeOutcome => ({ chargeable: false, amountCents: 0, mode: 'none', basis: null, waived: false, refundPrepaymentCents: refund });

const MIN = 60_000;

/** Statische Tabelle erlaubter Paare inkl. Akteure – Grundlage für die Zeitprüfungen und den DB-Trigger. */
export const TRANSITION_TABLE: readonly { from: BookingStatus | null; to: BookingStatus; actors: readonly Actor[] }[] = [
  { from: null, to: 'tentative', actors: ['booker', 'host', 'system'] },
  { from: null, to: 'confirmed', actors: ['system'] },
  { from: null, to: 'pending_verification', actors: ['system'] },
  { from: 'tentative', to: 'pending_verification', actors: ['system'] },
  { from: 'tentative', to: 'confirmed', actors: ['system'] },
  { from: 'tentative', to: 'cancelled_conflict', actors: ['system'] },
  { from: 'pending_verification', to: 'confirmed', actors: ['system'] },
  { from: 'pending_verification', to: 'cancelled_conflict', actors: ['system'] },
  { from: 'pending_verification', to: 'cancelled_free', actors: ['booker', 'host', 'system'] },
  { from: 'confirmed', to: 'cancelled_free', actors: ['booker', 'host', 'system'] },
  { from: 'confirmed', to: 'cancelled_late', actors: ['booker'] },
  { from: 'confirmed', to: 'rescheduled', actors: ['booker', 'host'] },
  { from: 'confirmed', to: 'no_show', actors: ['host', 'system'] },
  { from: 'confirmed', to: 'completed', actors: ['host', 'system'] },
  { from: 'no_show', to: 'completed', actors: ['host'] },
  { from: 'no_show', to: 'cancelled_free', actors: ['host'] },
  { from: 'cancelled_late', to: 'cancelled_free', actors: ['host'] },
];

export function isTransitionKnown(from: BookingStatus | null, to: BookingStatus): boolean {
  return TRANSITION_TABLE.some((t) => t.from === from && t.to === to);
}

export function validateBookingStateTransition(
  currentStatus: BookingStatus | null,
  newStatus: BookingStatus,
  startUtc: Date,
  nowUtc: Date,
  policy: EventTypePolicy,
  options: Partial<TransitionOptions> = {},
): TransitionResult {
  const actor: Actor = options.actor ?? 'booker';
  const ctx: Omit<TransitionOptions, 'actor'> = {
    endUtc: options.endUtc ?? startUtc,
    rescheduleCount: options.rescheduleCount ?? 0,
    prepaidCents: options.prepaidCents ?? 0,
    feeAssessedAt: options.feeAssessedAt ?? null,
  };
  const deny = (code: TransitionDenialCode, message: string, extra: { alternative?: BookingStatus; deadline?: Date } = {}): TransitionResult => ({
    allowed: false, from: currentStatus, to: newStatus, actor, code, message, ...extra,
  });
  const ok = (fee: FeeOutcome, reason: string): TransitionResult => ({ allowed: true, from: currentStatus, to: newStatus, actor, fee, reason });

  const entry = TRANSITION_TABLE.find((t) => t.from === currentStatus && t.to === newStatus);
  if (!entry) return deny('UNKNOWN_TRANSITION', `Übergang ${currentStatus ?? '∅'} → ${newStatus} ist nicht vorgesehen`);
  if (!entry.actors.includes(actor)) return deny('ACTOR_NOT_ALLOWED', `${actor} darf ${currentStatus ?? '∅'} → ${newStatus} nicht auslösen`);

  const start = startUtc.getTime();
  const now = nowUtc.getTime();
  const end = ctx.endUtc.getTime();
  const freeCancelDeadline = new Date(start - policy.cancelCutoffMinutes * MIN);
  const rescheduleDeadline = new Date(start - policy.rescheduleCutoffMinutes * MIN);

  switch (`${currentStatus ?? '∅'}→${newStatus}`) {
    case '∅→tentative':
    case '∅→confirmed':
    case '∅→pending_verification': {
      const earliest = now + policy.minNoticeMinutes * MIN;
      if (start < earliest) return deny('MIN_NOTICE', `Mindestvorlauf ${policy.minNoticeMinutes} Minuten unterschritten`, { deadline: new Date(earliest) });
      return ok(NO_FEE(), 'Buchung angelegt');
    }

    case 'confirmed→cancelled_free': {
      if (actor === 'booker') {
        if (now >= start) return deny('ALREADY_STARTED', 'Der Termin hat bereits begonnen; Stornierung nicht mehr möglich');
        if (now > freeCancelDeadline.getTime()) {
          return deny('FREE_CANCEL_CUTOFF_PASSED', `Kostenfreie Stornierung war bis ${freeCancelDeadline.toISOString()} möglich`, { alternative: 'cancelled_late', deadline: freeCancelDeadline });
        }
      }
      return ok(NO_FEE(ctx.prepaidCents), actor === 'booker' ? 'Fristgerecht storniert' : 'Vom Gastgeber abgesagt, keine Gebühr');
    }

    case 'confirmed→cancelled_late': {
      if (now >= start) return deny('ALREADY_STARTED', 'Der Termin hat bereits begonnen', { alternative: 'no_show' });
      if (now <= freeCancelDeadline.getTime()) {
        return deny('UNKNOWN_TRANSITION', 'Stornierung liegt noch innerhalb der kostenfreien Frist', { alternative: 'cancelled_free', deadline: freeCancelDeadline });
      }
      const amount = feeFor(policy, 'late_cancel');
      if (amount === 0) return ok(NO_FEE(ctx.prepaidCents), 'Späte Absage ohne Gebühr laut Richtlinie');
      return ok(feeOutcome(policy, 'late_cancel', amount, ctx.prepaidCents), `Späte Absage nach Frist ${freeCancelDeadline.toISOString()}`);
    }

    case 'pending_verification→cancelled_free':
      return ok(NO_FEE(ctx.prepaidCents), 'Noch nicht bestätigte Buchung zurückgezogen');

    case 'confirmed→rescheduled': {
      if (now >= start) return deny('ALREADY_STARTED', 'Der Termin hat bereits begonnen; Verschieben nicht mehr möglich');
      if (actor === 'booker') {
        if (now > rescheduleDeadline.getTime()) return deny('RESCHEDULE_CUTOFF', `Verschieben war bis ${rescheduleDeadline.toISOString()} möglich`, { deadline: rescheduleDeadline });
        if (ctx.rescheduleCount >= policy.maxReschedules) return deny('RESCHEDULE_LIMIT', `Höchstens ${policy.maxReschedules} Verschiebungen erlaubt`);
      }
      // Vorkasse wandert auf die Folgebuchung, keine Erstattung hier.
      return ok(NO_FEE(0), actor === 'booker' ? `Verschiebung ${ctx.rescheduleCount + 1} von ${policy.maxReschedules}` : 'Vom Gastgeber verschoben');
    }

    case 'confirmed→no_show': {
      const graceEnd = start + policy.noShowGraceMinutes * MIN;
      const windowEnd = end + policy.noShowWindowMinutes * MIN;
      if (now < graceEnd) return deny('NO_SHOW_GRACE', `Nichterscheinen erst ab ${new Date(graceEnd).toISOString()} markierbar`, { deadline: new Date(graceEnd) });
      if (now > windowEnd) return deny('NO_SHOW_WINDOW', `Fenster für Nichterscheinen endete ${new Date(windowEnd).toISOString()}`, { alternative: 'completed' });
      const amount = feeFor(policy, 'no_show');
      if (amount === 0) return ok(NO_FEE(0), 'Nichterscheinen ohne Gebühr laut Richtlinie');
      return ok(feeOutcome(policy, 'no_show', amount, ctx.prepaidCents), 'Nichterscheinen mit Gebühr');
    }

    case 'confirmed→completed': {
      if (now < end) return deny('NOT_ENDED', 'Der Termin ist noch nicht beendet', { deadline: ctx.endUtc });
      return ok(NO_FEE(0), 'Termin abgeschlossen');
    }

    case 'no_show→completed':
    case 'no_show→cancelled_free':
    case 'cancelled_late→cancelled_free': {
      const assessedAt = ctx.feeAssessedAt?.getTime() ?? start;
      const waiveEnd = assessedAt + policy.feeWaiveWindowMinutes * MIN;
      if (now > waiveEnd) return deny('WAIVE_WINDOW', `Kulanzfrist endete ${new Date(waiveEnd).toISOString()}`);
      const refund = newStatus === 'cancelled_free' ? ctx.prepaidCents : 0;
      return ok({ chargeable: false, amountCents: 0, mode: policy.feeMode, basis: null, waived: true, refundPrepaymentCents: refund }, 'Gebühr aus Kulanz erlassen');
    }

    default:
      // Systempfade ohne Zeitbedingung (tentative/pending → confirmed/conflict)
      return ok(NO_FEE(newStatus === 'cancelled_conflict' ? ctx.prepaidCents : 0), 'Systemübergang');
  }
}

function feeOutcome(policy: EventTypePolicy, basis: 'no_show' | 'late_cancel', amount: number, prepaidCents: number): FeeOutcome {
  if (policy.feeMode === 'prepaid_forfeit') {
    // Einbehalt bis zur Höhe der Gebühr, Rest der Vorkasse zurück.
    const kept = Math.min(amount, prepaidCents);
    return { chargeable: kept > 0, amountCents: kept, mode: policy.feeMode, basis, waived: false, refundPrepaymentCents: prepaidCents - kept };
  }
  return { chargeable: true, amountCents: amount, mode: policy.feeMode, basis, waived: false, refundPrepaymentCents: 0 };
}

/** Fristen als Instants für die Anzeige im Widget und in E-Mails. */
export function deadlinesFor(startUtc: Date, endUtc: Date, policy: EventTypePolicy): { freeCancelUntil: Date; rescheduleUntil: Date; noShowFrom: Date; noShowUntil: Date } {
  const s = startUtc.getTime();
  return {
    freeCancelUntil: new Date(s - policy.cancelCutoffMinutes * MIN),
    rescheduleUntil: new Date(s - policy.rescheduleCutoffMinutes * MIN),
    noShowFrom: new Date(s + policy.noShowGraceMinutes * MIN),
    noShowUntil: new Date(endUtc.getTime() + policy.noShowWindowMinutes * MIN),
  };
}
