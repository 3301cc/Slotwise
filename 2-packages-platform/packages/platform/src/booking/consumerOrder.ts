/**
 * R1 · Option C · § 312j BGB (Button-Lösung) und Verbraucherinformationen.
 *
 * Regel: Begründet die Buchung eine Zahlungspflicht (Vorkasse, Ausfall- oder
 * Stornogebühr), muss bei Verbrauchern
 *   1. die Schaltfläche mit "zahlungspflichtig buchen" oder einer ebenso
 *      eindeutigen Formulierung beschriftet sein (§ 312j Abs. 3 BGB) – sonst
 *      kommt kein Vertrag zustande (§ 312j Abs. 4 BGB);
 *   2. unmittelbar vor der Schaltfläche stehen: wesentliche Merkmale der
 *      Leistung, Gesamtpreis, Laufzeit/Kündigung soweit einschlägig
 *      (§ 312j Abs. 2 BGB i. V. m. Art. 246a § 1 Abs. 1 S. 1 Nr. 1, 5, 11, 12 EGBGB);
 *   3. eine pauschalierte Ausfallgebühr den Nachweis eines geringeren Schadens
 *      zulassen (§ 309 Nr. 5 lit. b BGB), sonst ist die Klausel unwirksam;
 *   4. das Widerrufsrecht behandelt werden: Termin innerhalb von 14 Tagen nur mit
 *      ausdrücklicher Zustimmung zur vorzeitigen Ausführung (§ 356 Abs. 4 BGB)
 *      bzw. Ausschluss bei Freizeitveranstaltungen mit festem Termin
 *      (§ 312g Abs. 2 Nr. 9 BGB).
 *
 * Das Widget rendert `OrderRequirements` genau so; das Backend lehnt eine
 * Buchung ab, wenn der mitgesendete Nachweis (OrderEvidence) nicht zu den
 * berechneten Anforderungen passt. Die Formulierungen wurden für die
 * rechtliche Freigabe vorbereitet und sind zentral hier änderbar.
 */
import { createHash } from 'node:crypto';
import { formatHHMM, isoDateIn, zoneAbbreviation } from '../time/tz.js';
import { createsPaymentObligation, feeFor, type EventTypePolicy } from './policy.js';
import { deadlinesFor } from './stateMachine.js';

export type OrderButtonLabel = 'Zahlungspflichtig buchen' | 'Termin buchen';

export interface OrderRequirements {
  isConsumer: boolean;
  paymentObligation: boolean;
  /** Pflichtbeschriftung der Schaltfläche. */
  buttonLabel: OrderButtonLabel;
  /** Pflichtangaben unmittelbar über der Schaltfläche, in Anzeigereihenfolge. */
  infoLines: string[];
  /** Checkbox-Texte, die aktiv bestätigt werden müssen (nicht vorangekreuzt). */
  consents: { key: 'early_performance' | 'fee_terms'; text: string }[];
  /** Hinweis zum Widerrufsrecht, der neben der Schaltfläche steht. */
  withdrawalNotice: string;
  /** SHA-256 über die angezeigten Texte; wird mit der Buchung gespeichert. */
  contentHash: string;
}

export interface OrderInput {
  policy: EventTypePolicy;
  eventTypeName: string;
  durationMinutes: number;
  startUtc: Date;
  endUtc: Date;
  bookerTimezone: string;
  hostName: string;
  nowUtc: Date;
  isConsumer: boolean;
}

const WITHDRAWAL_DAYS = 14;

export function euro(cents: number): string {
  return new Intl.NumberFormat('de-DE', { style: 'currency', currency: 'EUR' }).format(cents / 100);
}

function whenLabel(instant: Date, tz: string): string {
  const d = isoDateIn(instant, tz);
  const [y, m, day] = d.split('-');
  return `${day}.${m}.${y}, ${formatHHMM(instant, tz)} Uhr (${zoneAbbreviation(instant, tz)})`;
}

export function orderRequirements(i: OrderInput): OrderRequirements {
  const p = i.policy;
  const obligation = createsPaymentObligation(p);
  const isConsumer = i.isConsumer;
  const lines: string[] = [];
  const consents: OrderRequirements['consents'] = [];
  const dl = deadlinesFor(i.startUtc, i.endUtc, p);

  // Nr. 1 EGBGB: wesentliche Eigenschaften
  lines.push(`Leistung: ${i.eventTypeName} mit ${i.hostName}, ${i.durationMinutes} Minuten, am ${whenLabel(i.startUtc, i.bookerTimezone)}.`);

  // Nr. 5 EGBGB: Gesamtpreis
  if (p.priceCents > 0) lines.push(`Gesamtpreis: ${euro(p.priceCents)} inkl. MwSt., zahlbar bei Buchung.`);
  else lines.push('Die Buchung selbst ist kostenlos.');

  const lateFee = feeFor(p, 'late_cancel');
  const noShowFee = feeFor(p, 'no_show');
  if (lateFee > 0 || noShowFee > 0) {
    const parts: string[] = [];
    lines.push(`Kostenfreie Stornierung bis ${whenLabel(dl.freeCancelUntil, i.bookerTimezone)}; Verschieben bis ${whenLabel(dl.rescheduleUntil, i.bookerTimezone)} (höchstens ${p.maxReschedules}-mal).`);
    if (lateFee > 0) parts.push(`bei Absage nach dieser Frist ${euro(lateFee)}`);
    if (noShowFee > 0) parts.push(`bei Nichterscheinen ${euro(noShowFee)}`);
    const how = p.feeMode === 'prepaid_forfeit' ? 'wird von der Vorkasse einbehalten' : p.feeMode === 'charge_on_file' ? 'wird über das hinterlegte Zahlungsmittel belastet' : 'wird in Rechnung gestellt';
    lines.push(`Ausfallpauschale: ${parts.join(', ')}; ${how}.`);
    if (isConsumer) {
      // § 309 Nr. 5 lit. b BGB – ohne diesen Satz ist die Pauschale gegenüber Verbrauchern unwirksam.
      lines.push('Ihnen bleibt der Nachweis gestattet, dass ein Schaden überhaupt nicht entstanden oder wesentlich niedriger ist als die Pauschale.');
      consents.push({ key: 'fee_terms', text: `Ich habe die Stornobedingungen und die Ausfallpauschale (${[lateFee > 0 ? euro(lateFee) : null, noShowFee > 0 ? euro(noShowFee) : null].filter(Boolean).join(' / ')}) zur Kenntnis genommen.` });
    }
  } else {
    lines.push(`Stornierung und Verschieben kostenfrei bis ${whenLabel(dl.freeCancelUntil, i.bookerTimezone)}.`);
  }

  // Widerrufsrecht
  let withdrawalNotice: string;
  if (!isConsumer) {
    withdrawalNotice = 'Geschäftliche Buchung; ein gesetzliches Widerrufsrecht besteht nicht.';
  } else if (p.withdrawalRight === 'excluded_312g_2_9') {
    withdrawalNotice = 'Für diese Leistung mit festem Termin besteht kein Widerrufsrecht (§ 312g Abs. 2 Nr. 9 BGB).';
  } else {
    const withinWithdrawal = i.startUtc.getTime() < i.nowUtc.getTime() + WITHDRAWAL_DAYS * 86_400_000;
    withdrawalNotice = `Sie haben das Recht, diesen Vertrag binnen ${WITHDRAWAL_DAYS} Tagen ohne Angabe von Gründen zu widerrufen. Die Widerrufsbelehrung erhalten Sie mit der Buchungsbestätigung.`;
    if (withinWithdrawal && obligation) {
      consents.push({
        key: 'early_performance',
        text: 'Ich verlange ausdrücklich, dass die Leistung vor Ablauf der Widerrufsfrist beginnt, und weiß, dass ich mein Widerrufsrecht mit vollständiger Vertragserfüllung verliere (§ 356 Abs. 4 BGB).',
      });
    }
  }

  // Auch bei Unternehmern dieselbe Beschriftung: eindeutig, und die Verbrauchereigenschaft ist bei Buchung nicht sicher prüfbar.
  const buttonLabel: OrderButtonLabel = obligation ? 'Zahlungspflichtig buchen' : 'Termin buchen';

  const contentHash = createHash('sha256').update(JSON.stringify({ buttonLabel, lines, consents: consents.map((c) => c.text), withdrawalNotice })).digest('hex');

  return { isConsumer, paymentObligation: obligation, buttonLabel, infoLines: lines, consents, withdrawalNotice, contentHash };
}

/** Was das Widget mit der Buchung zurücksendet und was in bookings.legal_notice_snapshot landet. */
export interface OrderEvidence {
  buttonLabelShown: string;
  contentHash: string;
  consentsGiven: ('early_performance' | 'fee_terms')[];
  shownAt: string; // ISO
  isConsumer: boolean;
  locale: string;
  userAgent: string;
}

export class OrderEvidenceError extends Error {
  readonly httpStatus = 422;
  constructor(public readonly code: 'BUTTON_LABEL' | 'CONTENT_MISMATCH' | 'CONSENT_MISSING' | 'STALE', message: string) {
    super(message);
  }
}

/**
 * Serverseitige Prüfung vor dem Anlegen einer zahlungspflichtigen Buchung:
 * Beschriftung, Inhalt und Pflicht-Zustimmungen müssen zu den berechneten
 * Anforderungen passen; sonst wäre der Vertrag nach § 312j Abs. 4 BGB nicht
 * zustande gekommen und Slotwise würde eine unwirksame Buchung speichern.
 */
export function assertOrderEvidence(req: OrderRequirements, ev: OrderEvidence, nowUtc: Date, maxAgeMs = 60 * 60_000): void {
  if (ev.buttonLabelShown !== req.buttonLabel) throw new OrderEvidenceError('BUTTON_LABEL', `Schaltfläche war "${ev.buttonLabelShown}", verlangt ist "${req.buttonLabel}"`);
  if (ev.contentHash !== req.contentHash) throw new OrderEvidenceError('CONTENT_MISMATCH', 'Angezeigte Pflichtangaben entsprechen nicht dem aktuellen Stand; bitte Buchung neu laden');
  for (const c of req.consents) {
    if (!ev.consentsGiven.includes(c.key)) throw new OrderEvidenceError('CONSENT_MISSING', `Zustimmung "${c.key}" fehlt`);
  }
  const shown = Date.parse(ev.shownAt);
  if (!Number.isFinite(shown) || nowUtc.getTime() - shown > maxAgeMs || shown > nowUtc.getTime() + 5 * 60_000) throw new OrderEvidenceError('STALE', 'Anzeige der Pflichtangaben ist zu alt oder ungültig');
}
