import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_POLICY, PolicyValidationError, createsPaymentObligation, feeFor, validatePolicy, type EventTypePolicy } from './policy.js';
import { TRANSITION_TABLE, deadlinesFor, isTransitionKnown, validateBookingStateTransition } from './stateMachine.js';
import { assertOrderEvidence, orderRequirements, OrderEvidenceError, type OrderEvidence } from './consumerOrder.js';
import { formatHHMM, isoDateIn, wallToUtc } from '../time/tz.js';
import type { BookingStatus } from './types.js';

const MIN = 60_000;
const policy = (over: Partial<EventTypePolicy> = {}): EventTypePolicy => validatePolicy({ eventTypeId: 'et_1', ...DEFAULT_POLICY, ...over });
const FEE = policy({ feeMode: 'charge_on_file', feeAppliesTo: 'both', noShowFeeCents: 4000, lateCancelFeeCents: 2500 });

// Termin: Sonntag 25.10.2026, 09:00 Europe/Berlin (MEZ, nach dem Wechsel) = 08:00Z, 30 Minuten
const START = wallToUtc({ year: 2026, month: 10, day: 25, hour: 9, minute: 0 }, 'Europe/Berlin');
const END = new Date(START.getTime() + 30 * MIN);

test('Fixture: Terminbeginn ist 08:00Z (MEZ nach dem Wechsel)', () => {
  assert.equal(START.toISOString(), '2026-10-25T08:00:00.000Z');
});

test('Policy-Validierung: Invarianten', () => {
  assert.throws(() => policy({ noShowFeeCents: 100 }), (e: unknown) => e instanceof PolicyValidationError && e.field === 'feeMode');
  assert.throws(() => policy({ feeMode: 'invoice' }), (e: unknown) => e instanceof PolicyValidationError && e.field === 'noShowFeeCents');
  assert.throws(() => policy({ feeMode: 'charge_on_file', noShowFeeCents: 100, minNoticeMinutes: 3000, cancelCutoffMinutes: 1440 }), /cancelCutoffMinutes/);
  assert.throws(() => policy({ maxReschedules: -1 }), /maxReschedules/);
  assert.equal(createsPaymentObligation(policy()), false);
  assert.equal(createsPaymentObligation(FEE), true);
  assert.equal(feeFor(policy({ feeMode: 'invoice', feeAppliesTo: 'no_show', noShowFeeCents: 1000 }), 'late_cancel'), 0);
  assert.equal(feeFor(FEE, 'late_cancel'), 2500);
  assert.equal(feeFor(policy({ feeMode: 'invoice', feeAppliesTo: 'both', noShowFeeCents: 1000 }), 'late_cancel'), 1000, 'lateCancelFee null → wie No-Show');
});

test('Anlage: Mindestvorlauf exakt an der Grenze', () => {
  const p = policy({ minNoticeMinutes: 120 });
  const exactly = new Date(START.getTime() - 120 * MIN);
  assert.equal(validateBookingStateTransition(null, 'tentative', START, exactly, p).allowed, true);
  const late = validateBookingStateTransition(null, 'tentative', START, new Date(exactly.getTime() + 1), p);
  assert.equal(late.allowed, false);
  assert.equal(!late.allowed && late.code, 'MIN_NOTICE');
  // R0-Pfade legen direkt confirmed/pending an (system)
  assert.equal(validateBookingStateTransition(null, 'confirmed', START, exactly, p, { actor: 'system' }).allowed, true);
  assert.equal(validateBookingStateTransition(null, 'confirmed', START, exactly, p, { actor: 'booker' }).allowed, false);
});

test('Kostenfreie Stornierung: Grenze ist inklusiv, danach cancelled_late mit Gebühr', () => {
  const cutoff = new Date(START.getTime() - 24 * 60 * MIN); // 24.10.2026 08:00Z = 10:00 MESZ
  assert.equal(cutoff.toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(formatHHMM(cutoff, 'Europe/Berlin'), '10:00', 'Wanduhr am Vortag: 10:00 MESZ, weil dazwischen die Uhr zurückgestellt wird');

  const onTime = validateBookingStateTransition('confirmed', 'cancelled_free', START, cutoff, FEE, { prepaidCents: 0 });
  assert.equal(onTime.allowed, true);
  assert.equal(onTime.allowed && onTime.fee.chargeable, false);

  const oneMsLate = validateBookingStateTransition('confirmed', 'cancelled_free', START, new Date(cutoff.getTime() + 1), FEE);
  assert.equal(oneMsLate.allowed, false);
  assert.equal(!oneMsLate.allowed && oneMsLate.code, 'FREE_CANCEL_CUTOFF_PASSED');
  assert.equal(!oneMsLate.allowed && oneMsLate.alternative, 'cancelled_late');
  assert.equal(!oneMsLate.allowed && oneMsLate.deadline?.toISOString(), cutoff.toISOString());

  const late = validateBookingStateTransition('confirmed', 'cancelled_late', START, new Date(cutoff.getTime() + 1), FEE);
  assert.equal(late.allowed, true);
  assert.deepEqual(late.allowed && late.fee, { chargeable: true, amountCents: 2500, mode: 'charge_on_file', basis: 'late_cancel', waived: false, refundPrepaymentCents: 0 });

  // cancelled_late innerhalb der Frist ist falsch – Hinweis auf cancelled_free
  const wrong = validateBookingStateTransition('confirmed', 'cancelled_late', START, cutoff, FEE);
  assert.equal(wrong.allowed, false);
  assert.equal(!wrong.allowed && wrong.alternative, 'cancelled_free');

  // Nach Terminbeginn keine Stornierung mehr
  const afterStart = validateBookingStateTransition('confirmed', 'cancelled_late', START, START, FEE);
  assert.equal(!afterStart.allowed && afterStart.code, 'ALREADY_STARTED');
});

test('Gastgeber sagt ab: jederzeit kostenfrei, Vorkasse wird erstattet', () => {
  const r = validateBookingStateTransition('confirmed', 'cancelled_free', START, new Date(START.getTime() - 5 * MIN), FEE, { actor: 'host', prepaidCents: 3000 });
  assert.equal(r.allowed, true);
  assert.equal(r.allowed && r.fee.refundPrepaymentCents, 3000);
  const asBooker = validateBookingStateTransition('confirmed', 'cancelled_free', START, new Date(START.getTime() - 5 * MIN), FEE, { actor: 'booker', prepaidCents: 3000 });
  assert.equal(asBooker.allowed, false);
});

test('Vorkasse-Einbehalt: Gebühr wird bis zur Höhe der Vorkasse einbehalten, Rest erstattet', () => {
  const p = policy({ feeMode: 'prepaid_forfeit', feeAppliesTo: 'both', priceCents: 5000, noShowFeeCents: 5000, lateCancelFeeCents: 2000 });
  const late = validateBookingStateTransition('confirmed', 'cancelled_late', START, new Date(START.getTime() - 60 * MIN), p, { prepaidCents: 5000 });
  assert.deepEqual(late.allowed && late.fee, { chargeable: true, amountCents: 2000, mode: 'prepaid_forfeit', basis: 'late_cancel', waived: false, refundPrepaymentCents: 3000 });
  const noShow = validateBookingStateTransition('confirmed', 'no_show', START, new Date(START.getTime() + 20 * MIN), p, { actor: 'host', prepaidCents: 5000, endUtc: END });
  assert.deepEqual(noShow.allowed && noShow.fee, { chargeable: true, amountCents: 5000, mode: 'prepaid_forfeit', basis: 'no_show', waived: false, refundPrepaymentCents: 0 });
});

test('Verschieben: Frist, Limit, Akteur', () => {
  const p = policy({ rescheduleCutoffMinutes: 12 * 60, maxReschedules: 2 });
  const deadline = new Date(START.getTime() - 12 * 60 * MIN);
  assert.equal(validateBookingStateTransition('confirmed', 'rescheduled', START, deadline, p, { rescheduleCount: 1 }).allowed, true);
  const tooLate = validateBookingStateTransition('confirmed', 'rescheduled', START, new Date(deadline.getTime() + 1), p, { rescheduleCount: 0 });
  assert.equal(!tooLate.allowed && tooLate.code, 'RESCHEDULE_CUTOFF');
  const limit = validateBookingStateTransition('confirmed', 'rescheduled', START, deadline, p, { rescheduleCount: 2 });
  assert.equal(!limit.allowed && limit.code, 'RESCHEDULE_LIMIT');
  // Gastgeber darf bis Terminbeginn ohne Limit verschieben
  assert.equal(validateBookingStateTransition('confirmed', 'rescheduled', START, new Date(START.getTime() - 1), p, { actor: 'host', rescheduleCount: 9 }).allowed, true);
  assert.equal(validateBookingStateTransition('confirmed', 'rescheduled', START, START, p, { actor: 'host' }).allowed, false);
});

test('No-Show: Karenz, Fenster, Gebühr, Kulanz', () => {
  const graceEnd = new Date(START.getTime() + 15 * MIN);
  const early = validateBookingStateTransition('confirmed', 'no_show', START, new Date(graceEnd.getTime() - 1), FEE, { actor: 'host', endUtc: END });
  assert.equal(!early.allowed && early.code, 'NO_SHOW_GRACE');
  const ok = validateBookingStateTransition('confirmed', 'no_show', START, graceEnd, FEE, { actor: 'host', endUtc: END });
  assert.equal(ok.allowed && ok.fee.amountCents, 4000);
  const windowEnd = new Date(END.getTime() + 7 * 24 * 60 * MIN);
  assert.equal(validateBookingStateTransition('confirmed', 'no_show', START, windowEnd, FEE, { actor: 'host', endUtc: END }).allowed, true);
  const tooLate = validateBookingStateTransition('confirmed', 'no_show', START, new Date(windowEnd.getTime() + 1), FEE, { actor: 'host', endUtc: END });
  assert.equal(!tooLate.allowed && tooLate.code, 'NO_SHOW_WINDOW');
  assert.equal(!tooLate.allowed && tooLate.alternative, 'completed');
  // Buchende Person darf sich nicht selbst als no_show markieren
  assert.equal(!validateBookingStateTransition('confirmed', 'no_show', START, graceEnd, FEE, { actor: 'booker' }).allowed, true);

  // Kulanz: Gebühr erlassen, innerhalb des Fensters
  const assessedAt = graceEnd;
  const waive = validateBookingStateTransition('no_show', 'cancelled_free', START, new Date(assessedAt.getTime() + 29 * 24 * 60 * MIN), FEE, { actor: 'host', feeAssessedAt: assessedAt, prepaidCents: 1000 });
  assert.equal(waive.allowed && waive.fee.waived, true);
  assert.equal(waive.allowed && waive.fee.refundPrepaymentCents, 1000);
  const waiveLate = validateBookingStateTransition('no_show', 'cancelled_free', START, new Date(assessedAt.getTime() + 31 * 24 * 60 * MIN), FEE, { actor: 'host', feeAssessedAt: assessedAt });
  assert.equal(!waiveLate.allowed && waiveLate.code, 'WAIVE_WINDOW');
  // Korrektur "doch erschienen" → completed ohne Erstattung der Vorkasse (Leistung erbracht)
  const corrected = validateBookingStateTransition('no_show', 'completed', START, new Date(assessedAt.getTime() + 60 * MIN), FEE, { actor: 'host', feeAssessedAt: assessedAt, prepaidCents: 1000 });
  assert.equal(corrected.allowed && corrected.fee.refundPrepaymentCents, 0);
});

test('Abschluss erst nach Terminende; Systemübergänge ohne Zeitbedingung', () => {
  const notEnded = validateBookingStateTransition('confirmed', 'completed', START, new Date(END.getTime() - 1), FEE, { actor: 'system', endUtc: END });
  assert.equal(!notEnded.allowed && notEnded.code, 'NOT_ENDED');
  assert.equal(validateBookingStateTransition('confirmed', 'completed', START, END, FEE, { actor: 'system', endUtc: END }).allowed, true);
  assert.equal(validateBookingStateTransition('pending_verification', 'confirmed', START, START, FEE, { actor: 'system' }).allowed, true);
  const conflict = validateBookingStateTransition('pending_verification', 'cancelled_conflict', START, START, FEE, { actor: 'system', prepaidCents: 700 });
  assert.equal(conflict.allowed && conflict.fee.refundPrepaymentCents, 700);
  assert.equal(validateBookingStateTransition('pending_verification', 'confirmed', START, START, FEE, { actor: 'booker' }).allowed, false);
});

test('Unbekannte Übergänge und Endzustände', () => {
  const statuses: BookingStatus[] = ['tentative', 'pending_verification', 'confirmed', 'rescheduled', 'cancelled_free', 'cancelled_late', 'cancelled_conflict', 'no_show', 'completed'];
  for (const from of ['rescheduled', 'cancelled_free', 'cancelled_conflict', 'completed'] as const) {
    for (const to of statuses) assert.equal(isTransitionKnown(from, to), false, `${from} → ${to} muss Endzustand sein`);
  }
  const r = validateBookingStateTransition('completed', 'confirmed', START, START, FEE, { actor: 'system' });
  assert.equal(!r.allowed && r.code, 'UNKNOWN_TRANSITION');
  // Tabelle und Funktion stimmen überein: jedes Tabellenpaar ist bekannt
  for (const t of TRANSITION_TABLE) assert.ok(isTransitionKnown(t.from, t.to));
});

test('Sommerzeit: Fristen sind Dauern, Wanduhr-Anzeige folgt der Zone', () => {
  // Termin Montag 30.03.2026 09:00 MESZ (Tag nach dem Wechsel am 29.03.) = 07:00Z
  const start = wallToUtc({ year: 2026, month: 3, day: 30, hour: 9, minute: 0 }, 'Europe/Berlin');
  assert.equal(start.toISOString(), '2026-03-30T07:00:00.000Z');
  const dl = deadlinesFor(start, new Date(start.getTime() + 30 * MIN), policy({ cancelCutoffMinutes: 36 * 60 }));
  // 36 h vorher als Dauer: 28.03.2026 19:00Z = 20:00 MEZ (nicht 21:00), weil die Nacht 29.03. eine Stunde kürzer ist
  assert.equal(dl.freeCancelUntil.toISOString(), '2026-03-28T19:00:00.000Z');
  assert.equal(isoDateIn(dl.freeCancelUntil, 'Europe/Berlin'), '2026-03-28');
  assert.equal(formatHHMM(dl.freeCancelUntil, 'Europe/Berlin'), '20:00');
  // Für eine buchende Person in Lissabon (WET → WEST am selben Tag) zeigt dieselbe Frist 19:00
  assert.equal(formatHHMM(dl.freeCancelUntil, 'Europe/Lisbon'), '19:00');
  // Die Entscheidung selbst hängt nur vom Instant ab:
  const p = policy({ cancelCutoffMinutes: 36 * 60 });
  assert.equal(validateBookingStateTransition('confirmed', 'cancelled_free', start, dl.freeCancelUntil, p).allowed, true);
  assert.equal(validateBookingStateTransition('confirmed', 'cancelled_free', start, new Date(dl.freeCancelUntil.getTime() + 1), p).allowed, false);
});

// ---------------------------------------------------------------------------
// § 312j BGB
// ---------------------------------------------------------------------------

const orderInput = (p: EventTypePolicy, over: Partial<Parameters<typeof orderRequirements>[0]> = {}) => ({
  policy: p,
  eventTypeName: 'Erstberatung',
  durationMinutes: 30,
  startUtc: START,
  endUtc: END,
  bookerTimezone: 'Europe/Berlin',
  hostName: 'Jana Weber',
  nowUtc: new Date('2026-10-20T10:00:00Z'),
  isConsumer: true,
  ...over,
});

test('§ 312j: kostenlose Buchung → "Termin buchen", keine Zustimmungen', () => {
  const r = orderRequirements(orderInput(policy()));
  assert.equal(r.buttonLabel, 'Termin buchen');
  assert.equal(r.paymentObligation, false);
  assert.deepEqual(r.consents, []);
  assert.match(r.infoLines[0], /Erstberatung mit Jana Weber, 30 Minuten, am 25\.10\.2026, 09:00 Uhr \(MEZ\)/);
  assert.match(r.infoLines.join(' '), /kostenlos/);
});

test('§ 312j: Gebühr → "Zahlungspflichtig buchen", Pflichtangaben, § 309 Nr. 5 b, § 356 Abs. 4', () => {
  const r = orderRequirements(orderInput(FEE));
  assert.equal(r.buttonLabel, 'Zahlungspflichtig buchen');
  const text = r.infoLines.join('\n');
  assert.match(text, /Kostenfreie Stornierung bis 24\.10\.2026, 10:00 Uhr \(MESZ\)/);
  assert.match(text, /bei Absage nach dieser Frist 25,00\s?€/);
  assert.match(text, /bei Nichterscheinen 40,00\s?€/);
  assert.match(text, /hinterlegte Zahlungsmittel/);
  assert.match(text, /Nachweis gestattet, dass ein Schaden überhaupt nicht entstanden/);
  assert.deepEqual(r.consents.map((c) => c.key), ['fee_terms', 'early_performance'], 'Termin in 5 Tagen liegt in der Widerrufsfrist');
  assert.match(r.withdrawalNotice, /binnen 14 Tagen/);

  // Termin außerhalb der 14 Tage: keine Zustimmung zur vorzeitigen Leistung nötig
  const far = orderRequirements(orderInput(FEE, { nowUtc: new Date('2026-10-01T10:00:00Z') }));
  assert.deepEqual(far.consents.map((c) => c.key), ['fee_terms']);

  // Freizeitveranstaltung mit festem Termin: Ausschluss § 312g Abs. 2 Nr. 9
  const leisure = orderRequirements(orderInput({ ...FEE, withdrawalRight: 'excluded_312g_2_9' }));
  assert.match(leisure.withdrawalNotice, /§ 312g Abs\. 2 Nr\. 9 BGB/);
  assert.deepEqual(leisure.consents.map((c) => c.key), ['fee_terms']);

  // Unternehmer: keine Verbraucherklauseln, Beschriftung bleibt eindeutig
  const b2b = orderRequirements(orderInput(FEE, { isConsumer: false }));
  assert.equal(b2b.buttonLabel, 'Zahlungspflichtig buchen');
  assert.deepEqual(b2b.consents, []);
  assert.ok(!b2b.infoLines.join(' ').includes('Nachweis gestattet'));
  assert.notEqual(b2b.contentHash, r.contentHash);
});

test('§ 312j: Vorkasse zeigt Gesamtpreis, Nachweisprüfung lehnt falsche Beschriftung, alten Inhalt und fehlende Zustimmung ab', () => {
  const p = policy({ feeMode: 'prepaid_forfeit', feeAppliesTo: 'no_show', priceCents: 8900, noShowFeeCents: 8900 });
  const r = orderRequirements(orderInput(p));
  assert.match(r.infoLines.join(' '), /Gesamtpreis: 89,00\s?€ inkl\. MwSt\./);
  const now = new Date('2026-10-20T10:05:00Z');
  const good: OrderEvidence = { buttonLabelShown: r.buttonLabel, contentHash: r.contentHash, consentsGiven: ['fee_terms', 'early_performance'], shownAt: '2026-10-20T10:00:00Z', isConsumer: true, locale: 'de-DE', userAgent: 'test' };
  assert.doesNotThrow(() => assertOrderEvidence(r, good, now));
  assert.throws(() => assertOrderEvidence(r, { ...good, buttonLabelShown: 'Termin buchen' }, now), (e: unknown) => e instanceof OrderEvidenceError && e.code === 'BUTTON_LABEL');
  assert.throws(() => assertOrderEvidence(r, { ...good, contentHash: 'x' }, now), (e: unknown) => e instanceof OrderEvidenceError && e.code === 'CONTENT_MISMATCH');
  assert.throws(() => assertOrderEvidence(r, { ...good, consentsGiven: ['fee_terms'] }, now), (e: unknown) => e instanceof OrderEvidenceError && e.code === 'CONSENT_MISSING');
  assert.throws(() => assertOrderEvidence(r, { ...good, shownAt: '2026-10-20T08:00:00Z' }, now), (e: unknown) => e instanceof OrderEvidenceError && e.code === 'STALE');
});
