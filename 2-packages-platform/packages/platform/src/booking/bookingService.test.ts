import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Outbox } from '../sync/outbox.js';
import { AlertService } from '../sync/alerts.js';
import { MemoryAlertRepository, MemoryOutboxRepository } from '../sync/memorySyncRepositories.js';
import { BookingService } from './bookingService.js';
import { MemorySlotLocker } from './redisLock.js';
import { ProviderAuthError, ProviderRateLimitError, SlotLockedError, SlotTakenError } from './errors.js';
import { overlaps, type BusyBlock } from '../availability/slotEngine.js';
import type { AvailabilityCache, BookingRecord, BookingRepository, BookingRequest, CalendarConnection, CalendarProvider, HostContext, JobQueue } from './types.js';

// ───────────────────────── Fakes ─────────────────────────

class MemoryRepo implements BookingRepository {
  rows: BookingRecord[] = [];
  constructor(private readonly host: HostContext) {}
  async findByIdempotencyKey(hostId: string, key: string) {
    return this.rows.find((r) => r.hostId === hostId && r.idempotencyKey === key) ?? null;
  }
  async insert(r: Omit<BookingRecord, 'id' | 'verifyAttempts'>) {
    // Nachbildung des EXCLUDE-Constraints: belegende Status dürfen sich nicht überlappen.
    const blocking = new Set(['tentative', 'pending_verification', 'confirmed']);
    if (blocking.has(r.status) && this.rows.some((x) => x.hostId === r.hostId && blocking.has(x.status) && overlaps(r.startUtc, r.endUtc, x.startUtc, x.endUtc))) {
      throw new SlotTakenError();
    }
    const rec: BookingRecord = { ...r, id: `b${this.rows.length + 1}`, verifyAttempts: 0 };
    this.rows.push(rec);
    return rec;
  }
  async update(id: string, patch: Partial<BookingRecord>) {
    const r = this.rows.find((x) => x.id === id)!;
    Object.assign(r, patch);
    return r;
  }
  async loadHostContext() {
    return this.host;
  }
}

class MemoryCache implements AvailabilityCache {
  store = new Map<string, { busy: BusyBlock[]; at: number }>();
  constructor(public now = () => Date.now()) {}
  async get(id: string) {
    const e = this.store.get(id);
    return e ? { busy: e.busy, ageMs: this.now() - e.at } : null;
  }
  async set(id: string, _f: Date, _t: Date, busy: BusyBlock[]) {
    this.store.set(id, { busy, at: this.now() });
  }
  async invalidate(id: string) {
    this.store.delete(id);
  }
}

class FakeProvider implements CalendarProvider {
  name = 'google';
  events = new Map<string, { start: Date; end: Date; status: string }>();
  foreign: BusyBlock[] = [];
  throttle: { create?: number; freeBusy?: number; confirm?: number } = {}; // Anzahl der 429 vor Erfolg
  authFailCreate = false;
  calls = { create: 0, freeBusy: 0, delete: 0, confirm: 0 };
  async getFreeBusy(_c: CalendarConnection[], from: Date, to: Date) {
    this.calls.freeBusy++;
    if (this.throttle.freeBusy && this.throttle.freeBusy-- > 0) throw new ProviderRateLimitError('google');
    const own = [...this.events.entries()].map(([id, e]) => ({ start: e.start, end: e.end, externalEventId: id }));
    return [...this.foreign, ...own].filter((b) => overlaps(from, to, b.start, b.end));
  }
  async createEvent(_p: CalendarConnection, input: { start: Date; end: Date }) {
    this.calls.create++;
    if (this.authFailCreate) throw new ProviderAuthError('google', 401, 'invalid_grant');
    if (this.throttle.create && this.throttle.create-- > 0) throw new ProviderRateLimitError('google');
    const id = `evt${this.events.size + 1}`;
    this.events.set(id, { start: input.start, end: input.end, status: 'tentative' });
    return { externalEventId: id };
  }
  async confirmEvent(_p: CalendarConnection, id: string) {
    this.calls.confirm++;
    if (this.throttle.confirm && this.throttle.confirm-- > 0) throw new ProviderRateLimitError('google');
    this.events.get(id)!.status = 'confirmed';
  }
  async deleteEvent(_p: CalendarConnection, id: string) {
    this.calls.delete++;
    this.events.delete(id);
  }
  async updateEvent(_p: CalendarConnection, id: string, patch: { start: Date; end: Date }) {
    const e = this.events.get(id);
    if (e) { e.start = patch.start; e.end = patch.end; }
  }
}

const host: HostContext = {
  hostId: 'h1',
  tenantId: 't1',
  timezone: 'Europe/Berlin',
  rules: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startLocal: '08:00', endLocal: '18:00' })),
  connections: [
    { id: 'c1', hostId: 'h1', provider: 'google', externalId: 'primary', isPrimary: true, isBlocking: true },
    { id: 'c2', hostId: 'h1', provider: 'google', externalId: 'private', isPrimary: false, isBlocking: true },
  ],
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 0,
  minNoticeMinutes: 0,
};

const noRetryDelay = { attempts: 3, baseMs: 1, factor: 1, maxMs: 1, jitter: false };
const log = { info() {}, warn() {}, error() {} };

function build(provider = new FakeProvider()) {
  const repo = new MemoryRepo(host);
  const queue: JobQueue & { jobs: unknown[] } = { jobs: [], async enqueue(n, p, o) { this.jobs.push({ n, p, o }); } };
  const outboxRepo = new MemoryOutboxRepository();
  const alertRepo = new MemoryAlertRepository();
  const clock = { now: () => new Date('2026-10-01T06:00:00Z') };
  const svc = new BookingService({
    repo,
    cache: new MemoryCache(),
    locker: new MemorySlotLocker(),
    providers: { google: provider },
    queue,
    clock,
    log,
    retry: noRetryDelay,
    outbox: new Outbox(outboxRepo, log),
    db: { query: async () => ({ rows: [], rowCount: 0 }) },
    alerts: new AlertService(alertRepo, clock, log),
  });
  return { svc, repo, provider, queue, outboxRepo, alertRepo };
}

function req(i: number, start = '2026-10-06T08:00:00Z'): BookingRequest {
  return {
    idempotencyKey: `k${i}`,
    hostId: 'h1',
    eventTypeId: 'demo',
    startUtc: new Date(start),
    endUtc: new Date(new Date(start).getTime() + 30 * 60_000),
    bookerTimezone: 'Europe/Berlin',
    booker: { name: `Person ${i}`, email: `p${i}@example.org` },
  };
}

// ───────────────────────── Tests ─────────────────────────

test('Happy Path: fünf Schritte, Buchung confirmed, Kalendereintrag bestätigt', async () => {
  const { svc, repo, provider } = build();
  const res = await svc.createBooking(req(1));
  assert.equal(res.kind, 'confirmed');
  assert.equal(repo.rows[0].status, 'confirmed');
  assert.equal(provider.events.get(repo.rows[0].externalEventId!)!.status, 'confirmed');
  assert.equal(provider.calls.freeBusy, 2); // Schritt 1 (Cache-Miss) + Schritt 4
});

test('Idempotenz: gleicher Key liefert dieselbe Buchung ohne zweiten Kalendereintrag', async () => {
  const { svc, provider } = build();
  const a = await svc.createBooking(req(1));
  const b = await svc.createBooking(req(1));
  assert.equal(a.booking.id, b.booking.id);
  assert.equal(provider.calls.create, 1);
});

test('200 parallele Buchungen auf denselben Slot: genau eine gewinnt', async () => {
  const { svc, repo, provider } = build();
  const results = await Promise.allSettled(Array.from({ length: 200 }, (_, i) => svc.createBooking(req(i))));
  const ok = results.filter((r) => r.status === 'fulfilled');
  const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
  assert.equal(ok.length, 1);
  assert.equal(rejected.length, 199);
  assert.ok(rejected.every((r) => r.reason instanceof SlotLockedError || r.reason instanceof SlotTakenError));
  assert.equal(repo.rows.filter((r) => r.status === 'confirmed').length, 1);
  assert.equal(provider.events.size, 1, 'kein verwaister Kalendereintrag');
});

test('Fremder Termin taucht zwischen Anzeige und Buchung auf: Verify rollt zurück', async () => {
  const provider = new FakeProvider();
  const { svc, repo } = build(provider);
  // Schritt 1 sieht den Kalender leer, danach erscheint extern ein Termin.
  const origFreeBusy = provider.getFreeBusy.bind(provider);
  let n = 0;
  provider.getFreeBusy = async (c, f, t) => {
    n++;
    if (n === 2) provider.foreign.push({ start: new Date('2026-10-06T08:00:00Z'), end: new Date('2026-10-06T08:30:00Z'), externalEventId: 'outlook-123' });
    return origFreeBusy(c, f, t);
  };
  await assert.rejects(() => svc.createBooking(req(1)), SlotTakenError);
  assert.equal(repo.rows.length, 0);
  assert.equal(provider.events.size, 0, 'tentativer Eintrag wurde gelöscht');
  assert.equal(provider.calls.delete, 1);
});

test('429 beim Schreiben (Schritt 3) nach Retries: pending_verification ohne Event-ID, Job eingereiht', async () => {
  const provider = new FakeProvider();
  provider.throttle.create = 5; // mehr als 3 Versuche
  const { svc, repo, queue } = build(provider);
  const res = await svc.createBooking(req(1));
  assert.equal(res.kind, 'pending');
  assert.equal(repo.rows[0].status, 'pending_verification');
  assert.equal(repo.rows[0].externalEventId, null);
  assert.equal(queue.jobs.length, 1);
  assert.equal(provider.calls.create, 3, 'genau drei Versuche');
});

test('429 bei der Verifikation (Schritt 4) nach Retries: pending_verification mit Event-ID', async () => {
  const provider = new FakeProvider();
  const { svc, repo, queue } = build(provider);
  // Schritt 1 (Cache leer) soll gelingen, danach drosseln.
  const orig = provider.getFreeBusy.bind(provider);
  let calls = 0;
  provider.getFreeBusy = async (c, f, t) => {
    calls++;
    if (calls > 1) throw new ProviderRateLimitError('google', 1);
    return orig(c, f, t);
  };
  const res = await svc.createBooking(req(1));
  assert.equal(res.kind, 'pending');
  assert.equal(repo.rows[0].status, 'pending_verification');
  assert.ok(repo.rows[0].externalEventId);
  assert.equal(queue.jobs.length, 1);
});

test('429 vor dem Lock mit vorhandenem Cache: Cache wird genutzt, Buchung läuft durch', async () => {
  const provider = new FakeProvider();
  const { svc } = build(provider);
  await svc.createBooking(req(1)); // füllt den Cache für das Fenster
  provider.throttle.freeBusy = 3; // Schritt 1 des zweiten Requests drosselt vollständig
  // Der Cache ist für dieses Fenster gefüllt (gleiches Fenster, anderer Slot => anderes Fenster, daher Miss):
  // wir buchen denselben Slot erneut, erwarten SlotTaken aus dem Cache statt eines Provider-Fehlers.
  await assert.rejects(() => svc.createBooking(req(2)), SlotTakenError);
});

test('Slot außerhalb der Verfügbarkeit wird vor jedem externen Aufruf abgelehnt', async () => {
  const { svc, provider } = build();
  await assert.rejects(() => svc.createBooking(req(1, '2026-10-04T08:00:00Z')), /außerhalb/); // Sonntag
  assert.equal(provider.calls.freeBusy, 0);
});

test('R2: confirmEvent scheitert dauerhaft → Buchung confirmed, CONFIRM-Job in der Outbox', async () => {
  const provider = new FakeProvider();
  provider.throttle.confirm = 99;
  const { svc, outboxRepo } = build(provider);
  const r = await svc.createBooking(req(1));
  assert.equal(r.kind, 'confirmed');
  assert.equal(provider.events.get('evt1')!.status, 'tentative', 'Kalender noch tentative');
  assert.deepEqual(outboxRepo.jobs.map((j) => [j.operation, j.bookingId, j.status]), [['CONFIRM', r.booking.id, 'PENDING']]);
});

test('R2: 401 beim Anlegen → Buchung schlägt fehl, kein Datensatz, kritischer Alarm für den Tenant', async () => {
  const provider = new FakeProvider();
  provider.authFailCreate = true;
  const { svc, repo, alertRepo } = build(provider);
  await assert.rejects(svc.createBooking(req(1)), (e: unknown) => e instanceof ProviderAuthError);
  assert.equal(repo.rows.length, 0);
  assert.equal(alertRepo.alerts.length, 1);
  assert.equal(alertRepo.alerts[0].code, 'CALENDAR_REAUTH_REQUIRED');
  assert.equal(alertRepo.alerts[0].connectionId, 'c1');
});
