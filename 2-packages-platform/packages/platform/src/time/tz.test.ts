import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getOffsetMinutes, minusMinutes, utcToWall, wallToUtc, weekdayOf, isValidTimezone } from './tz.js';
import { slotLabel } from '../widget/slotLabel.js';
import { computeSlots } from '../availability/slotEngine.js';

const BERLIN = 'Europe/Berlin';

test('Offset-Sprung am 29.03.2026 (Beginn Sommerzeit, 01:00Z)', () => {
  assert.equal(getOffsetMinutes(BERLIN, new Date('2026-03-29T00:59:00Z')), 60);
  assert.equal(getOffsetMinutes(BERLIN, new Date('2026-03-29T01:00:00Z')), 120);
});

test('Offset-Sprung am 25.10.2026 (Ende Sommerzeit, 01:00Z)', () => {
  assert.equal(getOffsetMinutes(BERLIN, new Date('2026-10-25T00:59:00Z')), 120);
  assert.equal(getOffsetMinutes(BERLIN, new Date('2026-10-25T01:00:00Z')), 60);
});

test('wallToUtc: 08:30 Berlin am Tag vor/nach der Umstellung', () => {
  assert.equal(wallToUtc({ year: 2026, month: 3, day: 28, hour: 8, minute: 30 }, BERLIN).toISOString(), '2026-03-28T07:30:00.000Z');
  assert.equal(wallToUtc({ year: 2026, month: 3, day: 29, hour: 8, minute: 30 }, BERLIN).toISOString(), '2026-03-29T06:30:00.000Z');
  assert.equal(wallToUtc({ year: 2026, month: 10, day: 24, hour: 8, minute: 30 }, BERLIN).toISOString(), '2026-10-24T06:30:00.000Z');
  assert.equal(wallToUtc({ year: 2026, month: 10, day: 25, hour: 8, minute: 30 }, BERLIN).toISOString(), '2026-10-25T07:30:00.000Z');
});

test('wallToUtc: Lücke 02:30 am 29.03. wird auf 03:30 MESZ verschoben', () => {
  const d = wallToUtc({ year: 2026, month: 3, day: 29, hour: 2, minute: 30 }, BERLIN);
  assert.equal(d.toISOString(), '2026-03-29T01:30:00.000Z');
  assert.equal(utcToWall(d, BERLIN).hour, 3);
});

test('wallToUtc: Überlappung 02:30 am 25.10. liefert zweites Vorkommen (MEZ)', () => {
  const d = wallToUtc({ year: 2026, month: 10, day: 25, hour: 2, minute: 30 }, BERLIN);
  assert.equal(d.toISOString(), '2026-10-25T01:30:00.000Z');
});

test('Erinnerung 24 h vorher ist ein absolutes Intervall, keine Wanduhrzeit', () => {
  // Sonntag 29.03. 09:00 MESZ = 07:00Z. Naiv ("09:00 am Vortag") wäre 08:00Z, korrekt ist 07:00Z.
  const start = wallToUtc({ year: 2026, month: 3, day: 29, hour: 9, minute: 0 }, BERLIN);
  assert.equal(start.toISOString(), '2026-03-29T07:00:00.000Z');
  assert.equal(minusMinutes(start, 24 * 60).toISOString(), '2026-03-28T07:00:00.000Z');
  // Montag 26.10. 09:00 MEZ = 08:00Z. Erinnerung 25.10. 08:00Z: die Umstellung war um 01:00Z,
  // also ist es bereits 09:00 MEZ. Naiv ("09:00 am Vortag" = 09:00 MESZ = 07:00Z) wäre eine Stunde zu früh.
  const start2 = wallToUtc({ year: 2026, month: 10, day: 26, hour: 9, minute: 0 }, BERLIN);
  assert.equal(minusMinutes(start2, 24 * 60).toISOString(), '2026-10-25T08:00:00.000Z');
  assert.equal(utcToWall(minusMinutes(start2, 24 * 60), BERLIN).hour, 9);
  // Und über die Umstellung hinweg: Sonntag 25.10. 09:00 MEZ (08:00Z) minus 24 h = Samstag 24.10. 08:00Z = 10:00 MESZ.
  const start3 = wallToUtc({ year: 2026, month: 10, day: 25, hour: 9, minute: 0 }, BERLIN);
  assert.equal(minusMinutes(start3, 24 * 60).toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(utcToWall(minusMinutes(start3, 24 * 60), BERLIN).hour, 10);
});

test('weekdayOf: 29.03.2026 ist Sonntag (6), 26.10.2026 ist Montag (0)', () => {
  assert.equal(weekdayOf({ year: 2026, month: 3, day: 29 }), 6);
  assert.equal(weekdayOf({ year: 2026, month: 10, day: 26 }), 0);
});

test('Slot-Engine: Mo–Fr 08:30–10:00 rund um den 25.10.2026, alles in UTC', () => {
  const slots = computeSlots({
    hostTimezone: BERLIN,
    rules: [0, 1, 2, 3, 4].map((weekday) => ({ weekday, startLocal: '08:30', endLocal: '10:00' })),
    busy: [],
    from: new Date('2026-10-23T00:00:00Z'),
    to: new Date('2026-10-27T00:00:00Z'),
    durationMinutes: 30,
    now: new Date('2026-10-20T00:00:00Z'),
  });
  const iso = slots.map((s) => s.start.toISOString());
  // Freitag 23.10. (MESZ, +2): 08:30 lokal = 06:30Z; Montag 26.10. (MEZ, +1): 08:30 lokal = 07:30Z
  assert.deepEqual(iso, [
    '2026-10-23T06:30:00.000Z',
    '2026-10-23T07:00:00.000Z',
    '2026-10-23T07:30:00.000Z',
    '2026-10-26T07:30:00.000Z',
    '2026-10-26T08:00:00.000Z',
    '2026-10-26T08:30:00.000Z',
  ]);
});

test('Slot-Engine: Puffer und Belegt-Blöcke', () => {
  const slots = computeSlots({
    hostTimezone: BERLIN,
    rules: [{ weekday: 1, startLocal: '09:00', endLocal: '11:00' }], // Di 06.10.2026
    busy: [{ start: new Date('2026-10-06T07:30:00Z'), end: new Date('2026-10-06T08:00:00Z'), externalEventId: 'x' }], // 09:30–10:00 lokal
    from: new Date('2026-10-06T00:00:00Z'),
    to: new Date('2026-10-07T00:00:00Z'),
    durationMinutes: 30,
    bufferBeforeMinutes: 15,
    bufferAfterMinutes: 15,
    now: new Date('2026-10-01T00:00:00Z'),
  });
  // 09:00 (Puffer bis 09:45 kollidiert mit 09:30), 09:30 belegt, 10:00 (Puffer ab 09:45 kollidiert), 10:30 frei
  assert.deepEqual(slots.map((s) => s.start.toISOString()), ['2026-10-06T08:30:00.000Z']);
});

test('Doppeltes Label: London-Buchender, Berliner Host, nach dem 25.10.', () => {
  const start = new Date('2026-10-26T08:00:00Z'); // 09:00 MEZ = 08:00 GMT
  const l = slotLabel(start, new Date('2026-10-26T08:30:00Z'), 'Europe/London', BERLIN);
  assert.equal(l.primary, '08:00–08:30 Uhr');
  assert.equal(l.secondary, '09:00–09:30 Uhr in Europe/Berlin (Host)');
  assert.equal(l.dayShift, 0);
});

test('Doppeltes Label: Tagesverschiebung für Buchende in Sydney', () => {
  const start = new Date('2026-10-26T16:00:00Z'); // 17:00 MEZ, 03:00 (+11) am 27.10. in Sydney
  const l = slotLabel(start, new Date('2026-10-26T16:30:00Z'), 'Australia/Sydney', BERLIN);
  assert.equal(l.dayShift, 1);
  assert.equal(l.isoDateBooker, '2026-10-27');
});

test('Gleicher Offset, kein Sekundärlabel', () => {
  const l = slotLabel(new Date('2026-10-06T08:00:00Z'), new Date('2026-10-06T08:30:00Z'), 'Europe/Vienna', BERLIN);
  assert.equal(l.secondary, null);
});

test('Zonenvalidierung', () => {
  assert.equal(isValidTimezone('Europe/Berlin'), true);
  assert.equal(isValidTimezone('Mars/Olympus'), false);
  assert.equal(isValidTimezone(''), false);
  assert.equal(isValidTimezone(null), false);
});
