/**
 * R1 · Option C · Fristen- und Gebührenrichtlinie je Terminart.
 *
 * Alle Fristen sind Dauern in Minuten relativ zum Terminbeginn (UTC-Instant).
 * Damit sind sie unabhängig von Zeitzonen und Sommerzeitwechseln: "24 Stunden
 * vorher" bleibt 24 Stunden, auch wenn dazwischen die Uhr umgestellt wird.
 * Die Anzeige in Wanduhrzeit (z. B. "bis Samstag 10:00 Uhr") berechnet das
 * Widget über src/time/tz.ts aus dem Instant.
 */

/** Wie eine Gebühr eingezogen wird. */
export type FeeMode =
  | 'none' // keine Gebühr, Felder werden ignoriert
  | 'prepaid_forfeit' // Anzahlung/Vorkasse bei Buchung, wird bei Ausfall einbehalten
  | 'charge_on_file' // Zahlungsmittel bei Buchung hinterlegt (Mollie/Stripe), Belastung bei Ausfall
  | 'invoice'; // Rechnung im Nachhinein (nur B2B sinnvoll)

/** Wofür die Gebühr gilt. */
export type FeeAppliesTo = 'no_show' | 'late_cancel' | 'both';

export interface EventTypePolicy {
  eventTypeId: string;
  /** Mindestvorlauf: Buchung nur, wenn Terminbeginn ≥ jetzt + minNotice. */
  minNoticeMinutes: number;
  /** Kostenfreie Stornierung bis Terminbeginn − cancelCutoff. Danach cancelled_late. */
  cancelCutoffMinutes: number;
  /** Verschieben durch die buchende Person bis Terminbeginn − rescheduleCutoff. */
  rescheduleCutoffMinutes: number;
  /** Maximale Zahl der Verschiebungen durch die buchende Person je Buchungskette. */
  maxReschedules: number;
  /** Gebühr bei Nichterscheinen in Cent (0 = keine). */
  noShowFeeCents: number;
  /** Gebühr bei später Absage in Cent; null = wie noShowFeeCents. */
  lateCancelFeeCents: number | null;
  feeMode: FeeMode;
  feeAppliesTo: FeeAppliesTo;
  /** Karenz nach Terminbeginn, bevor der Gastgeber "nicht erschienen" markieren darf. */
  noShowGraceMinutes: number;
  /** Fenster nach Terminende, in dem no_show noch gesetzt werden kann (danach nur completed). */
  noShowWindowMinutes: number;
  /** Frist, innerhalb derer der Gastgeber eine Gebühr aus Kulanz erlassen kann. */
  feeWaiveWindowMinutes: number;
  /**
   * Widerrufsrecht des Verbrauchers (§ 312g BGB):
   *  applies           → 14 Tage Widerrufsrecht; Termin innerhalb der Frist nur mit
   *                      ausdrücklicher Zustimmung zur vorzeitigen Leistung (§ 356 Abs. 4 BGB)
   *  excluded_312g_2_9 → Freizeitveranstaltung mit festem Termin, kein Widerrufsrecht
   */
  withdrawalRight: 'applies' | 'excluded_312g_2_9';
  /** Preis der Leistung selbst (Vorkasse) in Cent, 0 = kostenlos. */
  priceCents: number;
}

export const DEFAULT_POLICY: Omit<EventTypePolicy, 'eventTypeId'> = {
  minNoticeMinutes: 120,
  cancelCutoffMinutes: 24 * 60,
  rescheduleCutoffMinutes: 24 * 60,
  maxReschedules: 2,
  noShowFeeCents: 0,
  lateCancelFeeCents: null,
  feeMode: 'none',
  feeAppliesTo: 'no_show',
  noShowGraceMinutes: 15,
  noShowWindowMinutes: 7 * 24 * 60,
  feeWaiveWindowMinutes: 30 * 24 * 60,
  withdrawalRight: 'applies',
  priceCents: 0,
};

export class PolicyValidationError extends Error {
  readonly httpStatus = 422;
  constructor(public readonly field: keyof EventTypePolicy, message: string) {
    super(`${field}: ${message}`);
  }
}

export function validatePolicy(p: EventTypePolicy): EventTypePolicy {
  const nonNeg = (k: keyof EventTypePolicy) => {
    const v = p[k];
    if (!Number.isInteger(v) || (v as number) < 0) throw new PolicyValidationError(k, 'ganzzahlig und ≥ 0');
  };
  for (const k of ['minNoticeMinutes', 'cancelCutoffMinutes', 'rescheduleCutoffMinutes', 'maxReschedules', 'noShowFeeCents', 'noShowGraceMinutes', 'noShowWindowMinutes', 'feeWaiveWindowMinutes', 'priceCents'] as const) nonNeg(k);
  if (p.lateCancelFeeCents !== null && (!Number.isInteger(p.lateCancelFeeCents) || p.lateCancelFeeCents < 0)) throw new PolicyValidationError('lateCancelFeeCents', 'ganzzahlig, ≥ 0 oder null');
  if (!['none', 'prepaid_forfeit', 'charge_on_file', 'invoice'].includes(p.feeMode)) throw new PolicyValidationError('feeMode', 'unbekannt');
  if (!['no_show', 'late_cancel', 'both'].includes(p.feeAppliesTo)) throw new PolicyValidationError('feeAppliesTo', 'unbekannt');
  if (!['applies', 'excluded_312g_2_9'].includes(p.withdrawalRight)) throw new PolicyValidationError('withdrawalRight', 'unbekannt');
  if (p.feeMode !== 'none' && p.noShowFeeCents === 0 && (p.lateCancelFeeCents ?? 0) === 0) throw new PolicyValidationError('noShowFeeCents', 'feeMode gesetzt, aber keine Gebühr > 0');
  if (p.feeMode === 'none' && (p.noShowFeeCents > 0 || (p.lateCancelFeeCents ?? 0) > 0)) throw new PolicyValidationError('feeMode', 'Gebühr > 0 erfordert einen feeMode');
  if (p.feeMode === 'prepaid_forfeit' && p.priceCents === 0 && p.noShowFeeCents === 0) throw new PolicyValidationError('feeMode', 'prepaid_forfeit ohne Vorkasse-Betrag');
  if (p.feeMode === 'prepaid_forfeit' && p.noShowFeeCents > Math.max(p.priceCents, p.noShowFeeCents)) throw new PolicyValidationError('noShowFeeCents', 'darf die Vorkasse nicht übersteigen');
  if (p.cancelCutoffMinutes < p.minNoticeMinutes && p.feeMode !== 'none') {
    // Sonst könnte eine Buchung entstehen, die schon bei Anlage in der Gebührenzone liegt.
    throw new PolicyValidationError('cancelCutoffMinutes', 'muss ≥ minNoticeMinutes sein, wenn Gebühren gelten');
  }
  return p;
}

/** Gebühr für eine Ausfallart nach Richtlinie, 0 wenn nicht anwendbar. */
export function feeFor(p: EventTypePolicy, basis: 'no_show' | 'late_cancel'): number {
  if (p.feeMode === 'none') return 0;
  if (p.feeAppliesTo !== 'both' && p.feeAppliesTo !== basis) return 0;
  return basis === 'no_show' ? p.noShowFeeCents : (p.lateCancelFeeCents ?? p.noShowFeeCents);
}

/** Ob die Buchung überhaupt eine Zahlungspflicht begründen kann (§ 312j Abs. 3 BGB). */
export function createsPaymentObligation(p: EventTypePolicy): boolean {
  return p.priceCents > 0 || feeFor(p, 'no_show') > 0 || feeFor(p, 'late_cancel') > 0;
}
