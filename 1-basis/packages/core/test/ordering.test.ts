/**
 * Per-call ordering guard: state-changing commands (book / reschedule / cancel /
 * end) carry the unix-ms time of the speech event behind them. A command that
 * is older than the newest one already applied for the same call is refused
 * (409 STALE_COMMAND) — whatever order the requests happen to ARRIVE in.
 */
import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { SlotReservations } from "../src/booking/reservations";
import { DEMO_CALLER, DEMO_NUMBER, MemoryRepo, demoSeed } from "../src/voice/memory-repo";
import { VoiceServiceError, VoiceToolService } from "../src/voice/service";

const NOW = new Date("2026-09-29T07:41:00Z");
const T0 = NOW.getTime(); // the call starts here; speech events are T0 + seconds
const at = (sec: number) => T0 + sec * 1000;
const WED_0900 = "2026-09-30T07:00:00.000Z";
const WED_1000 = "2026-09-30T08:00:00.000Z";
const isStale = (e: unknown) => e instanceof VoiceServiceError && e.code === "STALE_COMMAND" && e.status === 409;

describe("ordering guard — clientTimestamp per call", () => {
  let repo: MemoryRepo;
  let svc: VoiceToolService;
  let interactionId: string;

  beforeEach(async () => {
    repo = new MemoryRepo(demoSeed());
    svc = new VoiceToolService(repo, { now: () => NOW, reservations: new SlotReservations() });
    interactionId = (await svc.startSession({ callSid: "CA_order", from: DEMO_CALLER, to: DEMO_NUMBER })).interactionId;
  });

  const book = (clientTimestamp?: number, startsAt = WED_0900) =>
    svc.bookAppointment({ interactionId, eventTypeSlug: "demo-call", startsAt, attendee: { name: "Lena Hoffmann" }, answers: { company: "X", employees: "1-9" }, clientTimestamp });

  it("a delayed 'reschedule' arriving after a later 'cancel' is refused and the booking stays cancelled", async () => {
    const b = await book(at(10)); // "Donnerstag 9 Uhr bitte"          t = 10 s
    await svc.cancelBooking({ interactionId, bookingId: b.id, clientTimestamp: at(40) }); // "Nein, doch absagen"  t = 40 s

    // The reschedule the caller asked for at t = 25 s got stuck in a retry loop and arrives now.
    await assert.rejects(svc.rescheduleBooking({ interactionId, bookingId: b.id, startsAt: WED_1000, clientTimestamp: at(25) }), isStale);
    assert.equal((await repo.getBooking(b.id))!.status, "CANCELLED", "the later decision of the caller stands");

    const i = (await repo.getInteraction(interactionId))!;
    assert.equal(i.lastCommandTool, "cancel_appointment");
    assert.equal(i.lastCommandAt!.getTime(), at(40), "the clock stays at the newest APPLIED command");
    assert.equal(i.outcome, "CANCELLED");
    const audit = i.toolCalls.at(-1)!;
    assert.deepEqual([audit.tool, audit.ok, audit.code, audit.clientAt], ["reschedule_appointment", false, "STALE_COMMAND", new Date(at(25)).toISOString()], "the refused command is audited with its speech-event time");
  });

  it("a delayed 'book' after a later 'cancel' cannot resurrect the appointment", async () => {
    const b = await book(at(10));
    await svc.cancelBooking({ interactionId, bookingId: b.id, clientTimestamp: at(30) });
    // late retry of an *earlier* booking attempt for another slot (the first attempt's response was lost)
    await assert.rejects(book(at(20), WED_1000), isStale);
    assert.equal([...repo.bookings.values()].filter((x) => x.status !== "CANCELLED" && x.interactionId === interactionId).length, 0);
  });

  it("a retry of the SAME command (equal stamp) passes and hits the idempotency, not the guard", async () => {
    const b1 = await book(at(10));
    const b2 = await book(at(10)); // response of the first attempt lost in a 504 → client retries with the same stamp
    assert.equal(b2.id, b1.id);
    assert.equal(b2.alreadyExisted, true);

    await svc.cancelBooking({ interactionId, bookingId: b1.id, clientTimestamp: at(20) });
    const again = await svc.cancelBooking({ interactionId, bookingId: b1.id, clientTimestamp: at(20) }); // retried cancel
    assert.equal(again.status, "CANCELLED");
  });

  it("commands in the right order flow normally: book → reschedule → cancel", async () => {
    const b = await book(at(10));
    const moved = await svc.rescheduleBooking({ interactionId, bookingId: b.id, startsAt: WED_1000, clientTimestamp: at(20) });
    assert.equal(moved.status, "RESCHEDULED");
    const gone = await svc.cancelBooking({ interactionId, bookingId: b.id, clientTimestamp: at(30) });
    assert.equal(gone.status, "CANCELLED");
  });

  it("is independent of arrival order: whichever of two racing commands arrives first, the NEWER one wins", async () => {
    const arrivals = Array.from({ length: 20 }, (_, i) => (i % 2 ? "reschedule-first" : "cancel-first") as "cancel-first" | "reschedule-first");
    for (const arrival of arrivals) {
      // writeDelay widens the window between "read the booking" and "write it" — the classic lost-update race
      const r = new MemoryRepo(demoSeed(), { writeDelay: () => new Promise((res) => setTimeout(res, 2)) });
      const s = new VoiceToolService(r, { now: () => NOW, reservations: new SlotReservations() });
      const id = (await s.startSession({ callSid: `CA_${arrival}_${Math.random()}`, from: DEMO_CALLER, to: DEMO_NUMBER })).interactionId;
      const b = await s.bookAppointment({ interactionId: id, eventTypeSlug: "demo-call", startsAt: WED_0900, attendee: { name: "A" }, answers: { company: "X", employees: "1-9" }, clientTimestamp: at(10) });

      const reschedule = () => s.rescheduleBooking({ interactionId: id, bookingId: b.id, startsAt: WED_1000, clientTimestamp: at(20) }); // said first
      const cancel = () => s.cancelBooking({ interactionId: id, bookingId: b.id, clientTimestamp: at(30) }); // said last
      const results = await Promise.allSettled(arrival === "cancel-first" ? [cancel(), reschedule()] : [reschedule(), cancel()]);

      const final = (await r.getBooking(b.id))!;
      assert.equal(final.status, "CANCELLED", `${arrival}: the caller's last word (cancel) is the final state`);
      if (arrival === "cancel-first") {
        // cancel applied → the older reschedule is refused as stale
        assert.equal(results[0]!.status, "fulfilled");
        assert.ok(results[1]!.status === "rejected" && isStale(results[1]!.reason));
      } else {
        // reschedule started first but the two interleave: it either applied before the cancel (both fulfilled)
        // or the cancel claimed the clock first and the reschedule was refused as stale — never anything else
        assert.equal(results[1]!.status, "fulfilled", "the newer cancel always applies");
        assert.ok(results[0]!.status === "fulfilled" || isStale(results[0]!.reason), "the older reschedule is applied or refused as stale");
      }
    }
  });

  it("CONTROL — the same race WITHOUT stamps is a lost update (this is the bug the guard closes)", async () => {
    // No clientTimestamp anywhere: reschedule reads the booking, the cancel lands in the write window, the reschedule
    // then overwrites it. Proves the harness can see the race — the guarded runs above are not passing by accident.
    let lostUpdates = 0;
    for (let i = 0; i < 10; i++) {
      const r = new MemoryRepo(demoSeed(), { writeDelay: () => new Promise((res) => setTimeout(res, 2)) });
      const s = new VoiceToolService(r, { now: () => NOW, reservations: new SlotReservations() });
      const id = (await s.startSession({ callSid: `CA_ctrl_${i}`, from: DEMO_CALLER, to: DEMO_NUMBER })).interactionId;
      const b = await s.bookAppointment({ interactionId: id, eventTypeSlug: "demo-call", startsAt: WED_0900, attendee: { name: "A" }, answers: { company: "X", employees: "1-9" } });
      await Promise.allSettled([
        s.rescheduleBooking({ interactionId: id, bookingId: b.id, startsAt: WED_1000 }), // said first, slow
        s.cancelBooking({ interactionId: id, bookingId: b.id }), // said last, fast
      ]);
      if ((await r.getBooking(b.id))!.status !== "CANCELLED") lostUpdates++;
    }
    assert.ok(lostUpdates > 0, `unstamped commands must exhibit the lost update at least once in 10 runs (got ${lostUpdates})`);
  });

  it("three commands of one call racing (book-retry 10, reschedule 20, cancel 30): the final state is always the newest", async () => {
    for (let i = 0; i < 20; i++) {
      const r = new MemoryRepo(demoSeed(), { writeDelay: () => new Promise((res) => setTimeout(res, 1 + (i % 3))) });
      const s = new VoiceToolService(r, { now: () => NOW, reservations: new SlotReservations() });
      const id = (await s.startSession({ callSid: `CA_three_${i}`, from: DEMO_CALLER, to: DEMO_NUMBER })).interactionId;
      const b = await s.bookAppointment({ interactionId: id, eventTypeSlug: "demo-call", startsAt: WED_0900, attendee: { name: "A" }, answers: { company: "X", employees: "1-9" }, clientTimestamp: at(10) });
      const cmds = [
        () => s.bookAppointment({ interactionId: id, eventTypeSlug: "demo-call", startsAt: WED_0900, attendee: { name: "A" }, answers: { company: "X", employees: "1-9" }, clientTimestamp: at(10) }), // late retry
        () => s.rescheduleBooking({ interactionId: id, bookingId: b.id, startsAt: WED_1000, clientTimestamp: at(20) }),
        () => s.cancelBooking({ interactionId: id, bookingId: b.id, clientTimestamp: at(30) }),
      ];
      // rotate the launch order every run
      const order = [0, 1, 2].map((k) => cmds[(k + i) % 3]!);
      const results = await Promise.allSettled(order.map((fn) => fn()));
      const cancelIdx = order.indexOf(cmds[2]!);
      assert.equal(results[cancelIdx]!.status, "fulfilled", `run ${i}: the newest command (cancel) always applies`);
      for (const [k, res] of results.entries()) {
        if (res.status === "rejected") assert.ok(isStale(res.reason) || (res.reason instanceof VoiceServiceError && res.reason.code === "BOOKING_NOT_FOUND"), `run ${i}, cmd ${k}: only STALE_COMMAND (or not-found after cancel) may reject, got ${String(res.reason)}`);
      }
      assert.equal((await r.getBooking(b.id))!.status, "CANCELLED", `run ${i}`);
      assert.equal([...r.bookings.values()].filter((x) => x.interactionId === id && x.status !== "CANCELLED").length, 0, `run ${i}: the late book retry never created a second appointment`);
      const info = (await r.getInteraction(id))!;
      assert.equal(info.lastCommandAt!.getTime(), at(30), `run ${i}: the clock ends on the newest stamp`);
    }
  });

  it("end_call: a stale call_started checkpoint (MISSED) delivered after a booking only closes the call", async () => {
    const b = await book(at(10));
    assert.equal(b.status, "CONFIRMED");

    // the worker died; the sweeper delivers the MISSED checkpoint stamped at call start (t = 0)
    const res = await svc.endSession(interactionId, { outcome: "MISSED", durationSec: 0, summary: "Verbindung abgebrochen", clientTimestamp: at(0) });
    assert.deepEqual(res, { ok: true, outcome: "BOOKED", ignored: true }, "confirmed (ok) so the outbox deletes the row, but ignored");
    const i = (await repo.getInteraction(interactionId))!;
    assert.equal(i.outcome, "BOOKED", "the booking outcome survives");
    assert.ok(i.endedAt, "…and the call is nevertheless closed");
    assert.equal(i.summary ?? null, null, "the stale summary is not written");

    // the real hangup result (stamped later) still applies normally
    const fin = await svc.endSession(interactionId, { outcome: "BOOKED", durationSec: 95, summary: "Termin gebucht.", clientTimestamp: at(95) });
    assert.deepEqual(fin, { ok: true, outcome: "BOOKED" });
    assert.equal((await repo.getInteraction(interactionId))!.summary, "Termin gebucht.");
  });

  it("garbage stamps are rejected as INVALID_INPUT; a missing stamp (legacy client) is not enforced", async () => {
    await assert.rejects(book(NOW.getTime() + 10 * 60_000), (e: unknown) => e instanceof VoiceServiceError && e.code === "INVALID_INPUT" && /future/.test(e.message));
    const b = await book(at(10));
    await svc.cancelBooking({ interactionId, bookingId: b.id, clientTimestamp: at(30) });
    // no stamp → no ordering information → the command is treated like before (idempotent cancel here)
    const r = await svc.cancelBooking({ interactionId, bookingId: b.id });
    assert.equal(r.status, "CANCELLED");
    assert.equal((await repo.getInteraction(interactionId))!.lastCommandAt!.getTime(), at(30), "an unstamped command never moves the clock");
  });

  it("the guard is per call: another call's older command is not affected", async () => {
    const b = await book(at(10));
    await svc.cancelBooking({ interactionId, bookingId: b.id, clientTimestamp: at(50) });
    const other = (await svc.startSession({ callSid: "CA_other", from: "+4917155223399", to: DEMO_NUMBER })).interactionId;
    const ob = await svc.bookAppointment({ interactionId: other, eventTypeSlug: "demo-call", startsAt: WED_1000, attendee: { name: "B" }, answers: { company: "Y", employees: "250+" }, clientTimestamp: at(5) });
    assert.equal(ob.status, "CONFIRMED");
  });
});
