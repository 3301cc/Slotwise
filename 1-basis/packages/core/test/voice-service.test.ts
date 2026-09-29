import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import { toWallClock } from "../src/time";
import { DEMO_CALLER, DEMO_NUMBER, MemoryRepo, demoSeed } from "../src/voice/memory-repo";
import { VoiceServiceError, VoiceToolService, maskPhone, normalizePhone } from "../src/voice/service";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-09-29T07:41:00Z"); // 09:41 Berlin — same as the first feed card

describe("VoiceToolService — inbound call flow", () => {
  let repo: MemoryRepo;
  let svc: VoiceToolService;

  beforeEach(() => {
    repo = new MemoryRepo(demoSeed());
    svc = new VoiceToolService(repo, { now: () => NOW });
  });

  it("starts a session for a known number and is idempotent per CallSid", async () => {
    const s1 = await svc.startSession({ callSid: "CA123", from: DEMO_CALLER, to: DEMO_NUMBER });
    const s2 = await svc.startSession({ callSid: "CA123", from: DEMO_CALLER, to: DEMO_NUMBER });
    assert.equal(s1.interactionId, s2.interactionId);
    assert.equal(s1.org.slug, "nordlicht");
    assert.equal(s1.caller.phoneMasked, "+49 30 4467 ••81");
    assert.match(s1.agent.greeting, /digitale Assistent von Nordlicht Consulting/);
    assert.deepEqual(
      s1.eventTypes.map((e) => e.slug),
      ["demo-call", "onboarding"],
    );
  });

  it("rejects unknown numbers", async () => {
    await assert.rejects(
      svc.startSession({ callSid: "CA999", from: DEMO_CALLER, to: "+4930000000" }),
      (e: unknown) => e instanceof VoiceServiceError && e.code === "UNKNOWN_NUMBER",
    );
  });

  it("offers the union of the round-robin pool, minus bookings, lunch and minNotice", async () => {
    const { interactionId } = await svc.startSession({ callSid: "CA1", from: DEMO_CALLER, to: DEMO_NUMBER });
    const { slots } = await svc.checkAvailability({ interactionId, eventTypeSlug: "demo-call", from: "2026-09-29", to: "2026-09-29", max: 20 });
    const times = slots.map((s) => toWallClock(new Date(s.start), TZ).time);
    // 09:41 + 120 min notice → 11:41. Jana: booked 10:00/11:00, lunch 12–13 → 13:00.
    // Mehdi (10–18) and Lena (9–15) are free at 12:00 → the pool offers 12:00 first.
    assert.deepEqual(times, ["12:00", "12:30"], "pickSpread default = 2 per day");
    assert.match(slots[0]!.spoken, /Dienstag, 29\. September/);

    // "onboarding" is SINGLE (Jana only): her lunch block and bookings apply directly
    const single = await svc.checkAvailability({ interactionId, eventTypeSlug: "onboarding", from: "2026-09-29", to: "2026-09-29", max: 20 });
    assert.equal(toWallClock(new Date(single.slots[0]!.start), TZ).time, "13:00");
  });

  it("books a slot, writes the audit trail and marks the interaction BOOKED", async () => {
    const { interactionId } = await svc.startSession({ callSid: "CA2", from: DEMO_CALLER, to: DEMO_NUMBER });
    const { slots } = await svc.checkAvailability({ interactionId, eventTypeSlug: "demo-call", from: "2026-10-01", to: "2026-10-01" });
    const chosen = slots[0]!;
    assert.equal(toWallClock(new Date(chosen.start), TZ).time, "09:00"); // Thursday afternoon is a workshop

    const booking = await svc.bookAppointment({
      interactionId,
      eventTypeSlug: "demo-call",
      startsAt: chosen.start,
      attendee: { name: "Lena Hoffmann", note: "wants a demo this week" },
    });
    assert.equal(booking.alreadyExisted, false);
    assert.equal(booking.status, "CONFIRMED");

    // same call, same slot again → idempotent
    const again = await svc.bookAppointment({ interactionId, eventTypeSlug: "demo-call", startsAt: chosen.start, attendee: { name: "Lena Hoffmann" } });
    assert.equal(again.alreadyExisted, true);
    assert.equal(again.id, booking.id);

    const interaction = await repo.getInteraction(interactionId);
    assert.equal(interaction?.outcome, "BOOKED");
    assert.deepEqual(
      interaction?.toolCalls.map((t) => [t.tool, t.ok]),
      [["check_availability", true], ["book_appointment", true], ["book_appointment", true]],
    );
    // phone numbers never land unmasked in the audit trail
    assert.equal(JSON.stringify(interaction?.toolCalls).includes(DEMO_CALLER), false);
  });

  it("refuses a slot that is taken or outside the rules", async () => {
    const { interactionId } = await svc.startSession({ callSid: "CA3", from: DEMO_CALLER, to: DEMO_NUMBER });
    const taken = new Date("2026-09-29T08:00:00Z"); // 10:00 Berlin = Müller GmbH
    await assert.rejects(
      svc.bookAppointment({ interactionId, eventTypeSlug: "demo-call", startsAt: taken.toISOString(), attendee: { name: "X" } }),
      (e: unknown) => e instanceof VoiceServiceError && e.code === "SLOT_TAKEN",
    );
    const sunday = new Date("2026-10-04T08:00:00Z");
    await assert.rejects(
      svc.bookAppointment({ interactionId, eventTypeSlug: "demo-call", startsAt: sunday.toISOString(), attendee: { name: "X" } }),
      (e: unknown) => e instanceof VoiceServiceError && e.code === "SLOT_TAKEN",
    );
  });

  it("finds, reschedules and cancels only the caller's own bookings", async () => {
    // Müller GmbH calls from their number
    const { interactionId } = await svc.startSession({ callSid: "CA4", from: "+49 89 215307", to: DEMO_NUMBER });
    const { bookings } = await svc.findBookings({ interactionId });
    assert.equal(bookings.length, 1);
    assert.equal(bookings[0]!.attendeeName, "Müller GmbH");

    const moved = await svc.rescheduleBooking({ interactionId, bookingId: bookings[0]!.id, startsAt: "2026-10-02T09:00:00Z" });
    assert.equal(moved.status, "RESCHEDULED");
    assert.equal(toWallClock(new Date(moved.startsAt), TZ).time, "11:00");

    // another caller cannot touch it
    const other = await svc.startSession({ callSid: "CA5", from: DEMO_CALLER, to: DEMO_NUMBER });
    await assert.rejects(
      svc.cancelBooking({ interactionId: other.interactionId, bookingId: bookings[0]!.id }),
      (e: unknown) => e instanceof VoiceServiceError && e.code === "BOOKING_NOT_FOUND",
    );

    const cancelled = await svc.cancelBooking({ interactionId, bookingId: bookings[0]!.id, reason: "sick" });
    assert.equal(cancelled.status, "CANCELLED");
    // retried cancel (e.g. the first 200 was lost in a gateway timeout) stays a success
    const again = await svc.cancelBooking({ interactionId, bookingId: bookings[0]!.id, reason: "sick" });
    assert.equal(again.status, "CANCELLED");
  });

  it("stores a callback request and forces the CALLBACK_REQUESTED outcome", async () => {
    const { interactionId } = await svc.startSession({ callSid: "CA7", from: DEMO_CALLER, to: DEMO_NUMBER });
    const res = await svc.endSession(interactionId, {
      outcome: "INFO",
      durationSec: 80,
      summary: "Rückruf erbeten …",
      callback: { name: "Lena Hoffmann", phone: "030 4467 1281", topic: "Demo diese Woche", requestedAt: 1_790_000_000 },
    });
    assert.equal(res.outcome, "CALLBACK_REQUESTED");
    const i = await repo.getInteraction(interactionId);
    assert.equal(i?.callbackRequest?.phone, "+493044671281");
  });

  it("ends the session, drops the transcript when the agent has storeTranscripts=false", async () => {
    const { interactionId } = await svc.startSession({ callSid: "CA6", from: DEMO_CALLER, to: DEMO_NUMBER });
    const res = await svc.endSession(interactionId, {
      outcome: "INFO",
      durationSec: 112,
      summary: "Caller asked for opening hours.",
      transcript: [{ role: "user", text: "…" }],
    });
    assert.equal(res.outcome, "INFO");
    const i = await repo.getInteraction(interactionId);
    assert.equal(i?.transcript, null);
    assert.equal(i?.durationSec, 112);
    assert.ok(i?.endedAt);
  });
});

describe("phone helpers", () => {
  it("masks like the dashboard feed and normalises German numbers", () => {
    assert.equal(maskPhone("+493044671281"), "+49 30 4467 ••81");
    assert.equal(normalizePhone("030 4467 1281"), "+493044671281");
    assert.equal(normalizePhone("0049 30 44671281"), "+493044671281");
  });
});
