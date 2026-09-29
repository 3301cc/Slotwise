import { test } from 'node:test';
import assert from 'node:assert/strict';
import { LifecycleService, type LifecycleBooking, type LifecycleRepository } from './lifecycleService.js';
import { DEFAULT_POLICY, type EventTypePolicy } from './policy.js';
import type { Actor, FeeOutcome } from './stateMachine.js';
import type { Tx } from '../metering/ledger.js';
import type { PaymentAdapter } from '../adapters/ports.js';
import type { BookingStatus } from './types.js';
import { Outbox } from '../sync/outbox.js';
import { MemoryOutboxRepository } from '../sync/memorySyncRepositories.js';

const MIN = 60_000;
const START = new Date('2026-10-25T08:00:00Z');

class MemoryRepo implements LifecycleRepository {
  bookings = new Map<string, LifecycleBooking>();
  policies = new Map<string, EventTypePolicy>();
  applied: { id: string; actor: Actor; to: BookingStatus; fee: FeeOutcome; reason: string }[] = [];
  async loadForUpdate(_tx: Tx, id: string) {
    const b = this.bookings.get(id);
    if (!b) return null;
    return { booking: { ...b }, policy: this.policies.get(b.eventTypeId)! };
  }
  async applyTransition(_tx: Tx, id: string, actor: Actor, _u: string | null, to: BookingStatus, fee: FeeOutcome, reason: string, now: Date) {
    const b = this.bookings.get(id)!;
    b.status = to;
    if (fee.chargeable) { b.feeCents = fee.amountCents; b.feeAssessedAt = now; }
    if (fee.waived) { b.feeCents = 0; }
    if (fee.refundPrepaymentCents > 0) b.refundCents += fee.refundPrepaymentCents;
    if (to === 'rescheduled' && actor === 'booker') b.rescheduleCount++;
    this.applied.push({ id, actor, to, fee, reason });
  }
  async listAutoCompletable() { return []; }
}

const fakeTx: Tx = { query: async () => ({ rows: [], rowCount: 0 }) };
const db = { transaction: async <T,>(fn: (tx: Tx) => Promise<T>) => fn(fakeTx) };

function setup(policy: Partial<EventTypePolicy>, booking: Partial<LifecycleBooking> = {}) {
  const repo = new MemoryRepo();
  repo.policies.set('et', { eventTypeId: 'et', ...DEFAULT_POLICY, ...policy });
  repo.bookings.set('b1', {
    id: 'b1', tenantId: 't1', hostId: 'h1', eventTypeId: 'et', startUtc: START, endUtc: new Date(START.getTime() + 30 * MIN), status: 'confirmed',
    rescheduleCount: 0, prepaidCents: 0, paymentId: null, feeCents: 0, feeAssessedAt: null, refundCents: 0, bookerEmail: 'kai@example.de', bookerName: 'Kai', notes: null,
    externalEventId: 'ev_1', externalCalendarId: 'c1', ...booking,
  });
  const refunds: { id: string; cents: number }[] = [];
  const payment = { refund: async (id: string, cents: number) => { refunds.push({ id, cents }); return { refundId: 're_1' }; } } as unknown as PaymentAdapter;
  const notes: string[] = [];
  const notifier = {
    bookingCancelled: async (_b: LifecycleBooking, by: Actor, fee: FeeOutcome) => { notes.push(`cancelled:${by}:${fee.amountCents}`); },
    bookingNoShow: async (_b: LifecycleBooking, fee: FeeOutcome) => { notes.push(`noshow:${fee.amountCents}`); },
    feeWaived: async (_b: LifecycleBooking, refund: number) => { notes.push(`waived:${refund}`); },
  };
  let now = new Date('2026-10-20T10:00:00Z');
  const log = { info() {}, warn() {}, error() {} };
  const outboxRepo = new MemoryOutboxRepository();
  const svc = new LifecycleService(db, repo, async () => payment, notifier, { now: () => now }, log, new Outbox(outboxRepo, log));
  return { svc, repo, refunds, notes, outboxRepo, setNow: (d: Date) => { now = d; } };
}

test('Lifecycle: fristgerechte Stornierung mit Vorkasse-Erstattung', async () => {
  const { svc, repo, refunds, notes } = setup({ feeMode: 'prepaid_forfeit', feeAppliesTo: 'both', priceCents: 5000, noShowFeeCents: 5000 }, { prepaidCents: 5000, paymentId: 'tr_1' });
  const r = await svc.cancel('b1', 'booker', null, false);
  assert.equal(r.allowed && r.to, 'cancelled_free');
  assert.deepEqual(refunds, [{ id: 'tr_1', cents: 5000 }]);
  assert.equal(repo.bookings.get('b1')!.refundCents, 5000);
  assert.deepEqual(notes, ['cancelled:booker:0']);
});

test('Lifecycle: Stornierung schreibt DELETE in die Outbox (idempotent), Abschluss nicht', async () => {
  const { svc, outboxRepo, setNow } = setup({});
  await svc.cancel('b1', 'host', 'u1', false);
  assert.deepEqual(outboxRepo.jobs.map((j) => [j.operation, j.bookingId, j.connectionId, j.status]), [['DELETE', 'b1', 'c1', 'PENDING']]);
  const { svc: svc2, outboxRepo: repo2, setNow: setNow2 } = setup({});
  setNow2(new Date(START.getTime() + 60 * MIN));
  await svc2.complete('b1', 'host', 'u1');
  assert.equal(repo2.jobs.length, 0, 'abgeschlossene Termine bleiben im Kalender');
  setNow(new Date());
});

test('Lifecycle: späte Absage nur mit Gebührenbestätigung; Einbehalt und Teilerstattung', async () => {
  const { svc, repo, refunds, setNow } = setup({ feeMode: 'prepaid_forfeit', feeAppliesTo: 'both', priceCents: 5000, noShowFeeCents: 5000, lateCancelFeeCents: 2000 }, { prepaidCents: 5000, paymentId: 'tr_1' });
  setNow(new Date(START.getTime() - 2 * 60 * MIN));
  const denied = await svc.cancel('b1', 'booker', null, false);
  assert.equal(denied.allowed, false);
  assert.equal(!denied.allowed && denied.code, 'FREE_CANCEL_CUTOFF_PASSED');
  assert.equal(repo.bookings.get('b1')!.status, 'confirmed', 'ohne Bestätigung keine Änderung');

  const accepted = await svc.cancel('b1', 'booker', null, true);
  assert.equal(accepted.allowed && accepted.to, 'cancelled_late');
  assert.equal(repo.bookings.get('b1')!.feeCents, 2000);
  assert.deepEqual(refunds, [{ id: 'tr_1', cents: 3000 }]);
});

test('Lifecycle: Erstattung ohne Zahlungsadapter rollt den Statuswechsel zurück', async () => {
  const { repo } = setup({}, { prepaidCents: 1000, paymentId: 'tr_1' });
  const log = { info() {}, warn() {}, error() {} };
  const svc = new LifecycleService(db, repo, async () => null, { bookingCancelled: async () => {}, bookingNoShow: async () => {}, feeWaived: async () => {} }, { now: () => new Date('2026-10-20T10:00:00Z') }, log, new Outbox(new MemoryOutboxRepository(), log));
  await assert.rejects(svc.cancel('b1', 'host', 'u1', false), /kein Zahlungsadapter/);
  assert.equal(repo.applied.length, 0);
});

test('Lifecycle: No-Show durch Gastgeber, danach Kulanz mit Erstattung', async () => {
  const { svc, repo, refunds, notes, setNow } = setup({ feeMode: 'prepaid_forfeit', feeAppliesTo: 'no_show', priceCents: 3000, noShowFeeCents: 3000 }, { prepaidCents: 3000, paymentId: 'tr_9' });
  setNow(new Date(START.getTime() + 10 * MIN));
  const early = await svc.markNoShow('b1', 'u1');
  assert.equal(!early.allowed && early.code, 'NO_SHOW_GRACE');
  setNow(new Date(START.getTime() + 16 * MIN));
  const ns = await svc.markNoShow('b1', 'u1');
  assert.equal(ns.allowed && ns.fee.amountCents, 3000);
  assert.equal(repo.bookings.get('b1')!.status, 'no_show');
  assert.deepEqual(refunds, []);
  setNow(new Date(START.getTime() + 3 * 24 * 60 * MIN));
  const w = await svc.waiveFee('b1', 'u1', 'cancelled_free');
  assert.equal(w.allowed && w.fee.waived, true);
  assert.deepEqual(refunds, [{ id: 'tr_9', cents: 3000 }]);
  assert.equal(repo.bookings.get('b1')!.feeCents, 0);
  assert.deepEqual(notes, ['noshow:3000', 'waived:3000']);
});

test('Lifecycle: Verschieben zählt nur für die buchende Person', async () => {
  const { svc, repo } = setup({ maxReschedules: 1 });
  assert.equal((await svc.markRescheduled('b1', 'booker', null)).allowed, true);
  assert.equal(repo.bookings.get('b1')!.rescheduleCount, 1);
  repo.bookings.get('b1')!.status = 'confirmed'; // Folgebuchung in der Kette
  const second = await svc.markRescheduled('b1', 'booker', null);
  assert.equal(!second.allowed && second.code, 'RESCHEDULE_LIMIT');
  assert.equal((await svc.markRescheduled('b1', 'host', 'u1')).allowed, true);
  assert.equal(repo.bookings.get('b1')!.rescheduleCount, 1);
});
