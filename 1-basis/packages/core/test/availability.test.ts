import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computeSlots, isSlotFree, pickSpread, windowsForDate } from "../src/availability/engine";
import { addMinutes, toWallClock, tzOffsetMs, zonedToUtc } from "../src/time";

const TZ = "Europe/Berlin";
const weekdays = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" }));

describe("time helpers", () => {
  it("converts Berlin wall clock to UTC across DST", () => {
    // CEST (+2) on 29 Sep 2026
    assert.equal(zonedToUtc("2026-09-29", "09:00", TZ).toISOString(), "2026-09-29T07:00:00.000Z");
    // CET (+1) on 2 Nov 2026 (DST ends 25 Oct 2026)
    assert.equal(zonedToUtc("2026-11-02", "09:00", TZ).toISOString(), "2026-11-02T08:00:00.000Z");
    assert.equal(tzOffsetMs(new Date("2026-09-29T07:00:00Z"), TZ), 2 * 3_600_000);
  });

  it("round-trips wall clock parts", () => {
    const wc = toWallClock(new Date("2026-09-29T07:30:00Z"), TZ);
    assert.deepEqual([wc.date, wc.time, wc.weekday], ["2026-09-29", "09:30", 2]);
  });
});

describe("computeSlots", () => {
  const now = new Date("2026-09-29T06:00:00Z"); // 08:00 Berlin, Tuesday

  it("produces 30-min slots inside working hours minus busy blocks", () => {
    const busy = [
      { start: zonedToUtc("2026-09-29", "10:00", TZ), end: zonedToUtc("2026-09-29", "10:30", TZ) },
      { start: zonedToUtc("2026-09-29", "11:00", TZ), end: zonedToUtc("2026-09-29", "11:45", TZ) },
      { start: zonedToUtc("2026-09-29", "12:00", TZ), end: zonedToUtc("2026-09-29", "13:00", TZ) },
    ];
    const slots = computeSlots({
      timezone: TZ,
      rules: weekdays,
      eventType: { durationMin: 30, slotIntervalMin: 30, minNoticeMin: 0 },
      busy,
      from: zonedToUtc("2026-09-29", "00:00", TZ),
      to: zonedToUtc("2026-09-29", "23:59", TZ),
      now,
    });
    const times = slots.map((s) => toWallClock(s.start, TZ).time);
    // 09:00–17:00 = 16 half-hours, minus 10:00, 11:00, 11:30, 12:00, 12:30 → 11 slots
    assert.deepEqual(times, ["09:00", "09:30", "10:30", "13:00", "13:30", "14:00", "14:30", "15:00", "15:30", "16:00", "16:30"]);
  });

  it("respects minNotice, buffers and date overrides", () => {
    const slots = computeSlots({
      timezone: TZ,
      rules: weekdays,
      overrides: [{ date: "2026-09-30", startTime: null, endTime: null }], // day off
      eventType: { durationMin: 45, slotIntervalMin: 30, bufferAfterMin: 15, minNoticeMin: 120 },
      busy: [{ start: zonedToUtc("2026-09-29", "14:00", TZ), end: zonedToUtc("2026-09-29", "14:30", TZ) }],
      from: now,
      to: zonedToUtc("2026-09-30", "23:59", TZ),
      now,
    });
    const byDay = new Map<string, string[]>();
    for (const s of slots) {
      const wc = toWallClock(s.start, TZ);
      byDay.set(wc.date, [...(byDay.get(wc.date) ?? []), wc.time]);
    }
    assert.equal(byDay.has("2026-09-30"), false, "override removes the whole day");
    const tue = byDay.get("2026-09-29") ?? [];
    assert.equal(tue[0], "10:00", "minNotice 120 min from 08:00 → first slot 10:00");
    // 45 min + 15 buffer = 60 min guard: 13:00 would end 13:45 (+15 → 14:00) OK; 13:30 collides with 14:00 busy.
    assert.ok(tue.includes("13:00"));
    assert.ok(!tue.includes("13:30"));
    assert.ok(!tue.includes("14:00"));
    assert.equal(tue.at(-1), "16:00", "16:00–16:45 (+15 buffer = 17:00) is the last fit");
  });

  it("does not offer weekends and returns [] when nothing fits", () => {
    const slots = computeSlots({
      timezone: TZ,
      rules: weekdays,
      eventType: { durationMin: 30 },
      busy: [],
      from: zonedToUtc("2026-10-03", "00:00", TZ), // Saturday
      to: zonedToUtc("2026-10-04", "23:59", TZ), // Sunday
      now,
    });
    assert.deepEqual(slots, []);
  });

  it("windowsForDate applies a partial override", () => {
    const w = windowsForDate("2026-09-29", 2, weekdays, [{ date: "2026-09-29", startTime: "14:00", endTime: "16:00" }], TZ);
    assert.equal(w.length, 1);
    assert.equal(toWallClock(w[0]!.start, TZ).time, "14:00");
  });

  it("isSlotFree uses half-open intervals (back-to-back is fine)", () => {
    const a = zonedToUtc("2026-09-29", "10:00", TZ);
    const busy = [{ start: addMinutes(a, 30), end: addMinutes(a, 60) }];
    assert.equal(isSlotFree(a, addMinutes(a, 30), busy), true);
    assert.equal(isSlotFree(a, addMinutes(a, 31), busy), false);
  });
});

describe("pickSpread", () => {
  it("spreads across days and honours a preference", () => {
    const mk = (d: string, t: string) => {
      const start = zonedToUtc(d, t, TZ);
      return { start, end: addMinutes(start, 30) };
    };
    const slots = [
      mk("2026-09-29", "09:00"),
      mk("2026-09-29", "09:30"),
      mk("2026-09-29", "14:00"),
      mk("2026-09-30", "09:00"),
      mk("2026-09-30", "15:00"),
      mk("2026-10-01", "10:00"),
    ];
    const spread = pickSpread(slots, 4, TZ).map((s) => toWallClock(s.start, TZ));
    assert.deepEqual(
      spread.map((w) => `${w.date} ${w.time}`),
      ["2026-09-29 09:00", "2026-09-29 09:30", "2026-09-30 09:00", "2026-09-30 15:00"],
    );
    const pm = pickSpread(slots, 4, TZ, "afternoon").map((s) => toWallClock(s.start, TZ).time);
    assert.deepEqual(pm, ["14:00", "15:00"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Concurrency — two requests for the same slot at the same millisecond.
// Layers under test: SlotReservations (sync marker) → commitBooking →
// MemoryRepo.createBookingIfFree (keyed mutex). Only one may succeed.
// ─────────────────────────────────────────────────────────────────────────────
import { KeyedMutex } from "../src/booking/keyed-mutex";
import { SlotReservations } from "../src/booking/reservations";
import { SlotTakenError, commitBooking } from "../src/booking/commit";
import { DEMO_CALLER, DEMO_NUMBER, MemoryRepo, demoSeed } from "../src/voice/memory-repo";
import { VoiceServiceError, VoiceToolService } from "../src/voice/service";
import type { CreateBookingData } from "../src/voice/types";

const SLOT = zonedToUtc("2026-10-02", "09:00", TZ); // Friday 09:00 Berlin — free in the demo seed
const NOW = new Date("2026-09-29T07:41:00Z");
const tick = () => new Promise<void>((r) => setTimeout(r, 2));

function bookingData(name: string, start = SLOT): CreateBookingData {
  return {
    organizationId: "org_nordlicht",
    eventTypeId: "evt_demo",
    hostUserId: "usr_jana",
    startsAt: start,
    endsAt: addMinutes(start, 30),
    source: "WEB",
    attendeeName: name,
    attendeePhone: null,
    attendeeEmail: null,
    attendeeTz: TZ,
    note: null,
  };
}

const settled = <T,>(ps: Promise<T>[]) => Promise.allSettled(ps);
const fulfilled = <T,>(rs: PromiseSettledResult<T>[]) => rs.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled");
const rejected = <T,>(rs: PromiseSettledResult<T>[]) => rs.filter((r): r is PromiseRejectedResult => r.status === "rejected");

describe("concurrency — same slot, same millisecond", () => {
  it("SlotReservations: the second reserve of an overlapping window in the same tick is rejected", () => {
    let clock = 1_000;
    const res = new SlotReservations(50, () => clock);
    const a = res.tryReserve("usr_jana", SLOT, addMinutes(SLOT, 30));
    const b = res.tryReserve("usr_jana", SLOT, addMinutes(SLOT, 30)); // same ms, same window
    const c = res.tryReserve("usr_jana", addMinutes(SLOT, 15), addMinutes(SLOT, 45)); // overlapping
    const d = res.tryReserve("usr_jana", addMinutes(SLOT, 30), addMinutes(SLOT, 60)); // adjacent → fine
    const e = res.tryReserve("usr_other", SLOT, addMinutes(SLOT, 30)); // other host → fine
    assert.ok(a && d && e);
    assert.equal(b, null);
    assert.equal(c, null);
    assert.deepEqual(res.busyOverlay("usr_jana", SLOT, addMinutes(SLOT, 60)).length, 2);

    res.release(a.token);
    assert.ok(res.tryReserve("usr_jana", SLOT, addMinutes(SLOT, 30)), "released → reservable again");
    clock += 100; // TTL passed → a crashed request cannot poison the slot
    assert.equal(res.size("usr_jana"), 0);
  });

  it("MemoryRepo WITHOUT the lock double-books (regression guard: proves the test can see the race)", async () => {
    const naive = new MemoryRepo(demoSeed(), { unsafeNoLock: true, writeDelay: tick });
    const [a, b] = await Promise.all([
      naive.createBookingIfFree(bookingData("A"), { bufferBeforeMin: 0, bufferAfterMin: 0 }),
      naive.createBookingIfFree(bookingData("B"), { bufferBeforeMin: 0, bufferAfterMin: 0 }),
    ]);
    assert.ok(a && b, "both checks ran before either insert — this is the bug the mutex fixes");
  });

  it("MemoryRepo WITH the keyed mutex: exactly one of two simultaneous inserts succeeds", async () => {
    const repo = new MemoryRepo(demoSeed(), { writeDelay: tick });
    const results = await Promise.all([
      repo.createBookingIfFree(bookingData("A"), { bufferBeforeMin: 0, bufferAfterMin: 0 }),
      repo.createBookingIfFree(bookingData("B"), { bufferBeforeMin: 0, bufferAfterMin: 0 }),
    ]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal([...repo.bookings.values()].filter((b) => b.startsAt.getTime() === SLOT.getTime()).length, 1);
  });

  it("commitBooking: the loser is rejected by the reservation before touching the repo", async () => {
    const repo = new MemoryRepo(demoSeed(), { writeDelay: tick });
    const reservations = new SlotReservations();
    let repoCalls = 0;
    const counting = {
      createBookingIfFree: (d: CreateBookingData, g: { bufferBeforeMin: number; bufferAfterMin: number }) => {
        repoCalls++;
        return repo.createBookingIfFree(d, g);
      },
    };
    const guard = { bufferBeforeMin: 0, bufferAfterMin: 0 };
    const rs = await settled([
      commitBooking({ repo: counting, reservations }, bookingData("A"), guard),
      commitBooking({ repo: counting, reservations }, bookingData("B"), guard), // same tick, same slot
    ]);
    assert.equal(fulfilled(rs).length, 1);
    const err = rejected(rs)[0]!.reason;
    assert.ok(err instanceof SlotTakenError);
    assert.equal(err.reason, "reserved", "rejected by the in-flight marker, not by the DB");
    assert.equal(repoCalls, 1, "the parallel request never reached the repository");
    assert.equal(reservations.size(), 0, "reservation released after commit");
  });

  it("VoiceToolService: two callers book the same slot at once → one BOOKED, one SLOT_TAKEN", async () => {
    const repo = new MemoryRepo(demoSeed(), { writeDelay: tick });
    const svc = new VoiceToolService(repo, { now: () => NOW, reservations: new SlotReservations() });
    const s1 = await svc.startSession({ callSid: "CA_race_1", from: DEMO_CALLER, to: DEMO_NUMBER });
    const s2 = await svc.startSession({ callSid: "CA_race_2", from: "+49 40 3311 6464", to: DEMO_NUMBER });
    for (const s of [s1, s2]) await svc.checkAvailability({ interactionId: s.interactionId, eventTypeSlug: "demo-call", from: "2026-10-02", to: "2026-10-02" });

    const rs = await settled([
      svc.bookAppointment({ interactionId: s1.interactionId, eventTypeSlug: "demo-call", startsAt: SLOT.toISOString(), attendee: { name: "Caller 1" } }),
      svc.bookAppointment({ interactionId: s2.interactionId, eventTypeSlug: "demo-call", startsAt: SLOT.toISOString(), attendee: { name: "Caller 2" } }),
    ]);
    assert.equal(fulfilled(rs).length, 1);
    const loser = rejected(rs)[0]!.reason;
    assert.ok(loser instanceof VoiceServiceError && loser.code === "SLOT_TAKEN", `loser must get SLOT_TAKEN, got ${loser}`);
    assert.equal([...repo.bookings.values()].filter((b) => b.startsAt.getTime() === SLOT.getTime()).length, 1);

    // the losing caller asks again and is offered the next free slot, not the taken one
    const again = await svc.checkAvailability({ interactionId: s2.interactionId, eventTypeSlug: "demo-call", from: "2026-10-02", to: "2026-10-02" });
    assert.ok(!again.slots.some((x) => x.start === SLOT.toISOString()));
  });

  it("stress: 25 simultaneous requests for one slot → exactly one booking", async () => {
    const repo = new MemoryRepo(demoSeed(), { writeDelay: tick });
    const reservations = new SlotReservations();
    const guard = { bufferBeforeMin: 0, bufferAfterMin: 0 };
    const rs = await settled(Array.from({ length: 25 }, (_, i) => commitBooking({ repo, reservations }, bookingData(`P${i}`), guard)));
    assert.equal(fulfilled(rs).length, 1);
    assert.equal(rejected(rs).length, 24);
    assert.ok(rejected(rs).every((r) => r.reason instanceof SlotTakenError));
  });

  it("in-flight reservation hides the slot from a parallel availability check", async () => {
    const repo = new MemoryRepo(demoSeed());
    const reservations = new SlotReservations();
    const svc = new VoiceToolService(repo, { now: () => NOW, reservations });
    const s = await svc.startSession({ callSid: "CA_overlay", from: DEMO_CALLER, to: DEMO_NUMBER });
    const r = reservations.tryReserve("usr_jana", SLOT, addMinutes(SLOT, 30))!; // someone is writing 09:00 right now
    const { slots } = await svc.checkAvailability({ interactionId: s.interactionId, eventTypeSlug: "demo-call", from: "2026-10-02", to: "2026-10-02", max: 20 });
    assert.ok(!slots.some((x) => x.start === SLOT.toISOString()), "09:00 must not be offered while reserved");
    reservations.release(r.token);
    const after = await svc.checkAvailability({ interactionId: s.interactionId, eventTypeSlug: "demo-call", from: "2026-10-02", to: "2026-10-02", max: 20 });
    assert.ok(after.slots.some((x) => x.start === SLOT.toISOString()), "offered again once released");
  });

  it("KeyedMutex serialises per key and runs different keys concurrently", async () => {
    const m = new KeyedMutex();
    const order: string[] = [];
    await Promise.all([
      m.run("a", async () => { order.push("a1-start"); await tick(); order.push("a1-end"); }),
      m.run("a", async () => { order.push("a2-start"); await tick(); order.push("a2-end"); }),
      m.run("b", async () => { order.push("b1-start"); await tick(); order.push("b1-end"); }),
    ]);
    assert.deepEqual(order.filter((x) => x.startsWith("a")), ["a1-start", "a1-end", "a2-start", "a2-end"]);
    assert.equal(order.indexOf("b1-start") < order.indexOf("a1-end"), true, "b ran while a1 was still in flight");
    assert.equal(m.isBusy("a"), false);
  });
});
