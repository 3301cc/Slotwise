import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { SlotReservations } from "../src/booking/reservations";
import { type HostCandidate, NoEligibleHostError, type RoutingMatch, bookWithRouting, matchesAnswers, rankCandidates, rankRoundRobin } from "../src/booking/routing";
import { toWallClock, zonedToUtc } from "../src/time";
import { DEMO_CALLER, DEMO_NUMBER, MemoryRepo, type MemorySeed, demoSeed } from "../src/voice/memory-repo";
import { VoiceServiceError, VoiceToolService } from "../src/voice/service";
import type { CreateBookingData, EventTypeRecord, HostRecord } from "../src/voice/types";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-09-29T07:41:00Z");
const at = (d: string, t: string) => zonedToUtc(d, t, TZ);

const base = {
  organizationId: "org_nordlicht",
  eventTypeId: "evt_demo",
  source: "WEB" as const,
  attendeeEmail: null,
  attendeePhone: null,
  attendeeTz: TZ,
  note: null,
};

describe("rankRoundRobin", () => {
  it("priority → load → rotation → id", () => {
    const ranked = rankRoundRobin([
      { hostUserId: "c", priority: 0, upcomingBookings: 1, lastAssignedAt: new Date(3) },
      { hostUserId: "a", priority: 0, upcomingBookings: 1, lastAssignedAt: new Date(1) },
      { hostUserId: "b", priority: 0, upcomingBookings: 0, lastAssignedAt: new Date(9) },
      { hostUserId: "vip", priority: 5, upcomingBookings: 7, lastAssignedAt: new Date(9) },
      { hostUserId: "d", priority: 0, upcomingBookings: 1, lastAssignedAt: null },
    ]).map((c) => c.hostUserId);
    assert.deepEqual(ranked, ["vip", "b", "d", "a", "c"]);
  });
});

describe("bookWithRouting — Jana / Mehdi / Lena pool", () => {
  it("rotates fairly across free team members and skips those who are not free", async () => {
    const repo = new MemoryRepo(demoSeed());
    const deps = { repo, reservations: new SlotReservations() };
    const eventType = (await repo.getEventTypes("org_nordlicht")).find((e) => e.slug === "demo-call")!;
    const book = (d: string, t: string, name: string) =>
      bookWithRouting(deps, { eventType, startsAt: at(d, t), now: NOW, data: { ...base, attendeeName: name } });

    // 09:00 Wednesday: Mehdi starts at 10:00 → only Jana and Lena qualify
    const r1 = await book("2026-09-30", "09:00", "One");
    const r2 = await book("2026-09-30", "09:30", "Two");
    assert.deepEqual([r1.hostUserId, r2.hostUserId].sort(), ["usr_jana", "usr_lena"], "both morning-capable hosts get one each");

    // 16:00 Wednesday: Lena ends at 15:00 → Jana or Mehdi; whoever was assigned least recently / least loaded
    const r3 = await book("2026-09-30", "16:00", "Three");
    assert.equal(r3.hostUserId, "usr_mehdi", "Mehdi has no bookings yet → least loaded");

    // Same slot again → a different free member takes it; a third request finds nobody
    const r4 = await book("2026-09-30", "16:00", "Four");
    assert.notEqual(r4.hostUserId, r3.hostUserId);
    await assert.rejects(book("2026-09-30", "16:00", "Five"), /No team member is free/);
  });

  it("SINGLE routing always books the default host and ignores the pool", async () => {
    const repo = new MemoryRepo(demoSeed());
    const eventType = (await repo.getEventTypes("org_nordlicht")).find((e) => e.slug === "onboarding")!;
    const r = await bookWithRouting({ repo, reservations: new SlotReservations() }, { eventType, startsAt: at("2026-09-30", "14:00"), now: NOW, data: { ...base, eventTypeId: eventType.id, attendeeName: "Solo" } });
    assert.equal(r.hostUserId, "usr_jana");
  });

  it("two simultaneous requests for one slot land on two different members — no double booking, no loss", async () => {
    const repo = new MemoryRepo(demoSeed(), { writeDelay: () => new Promise((r) => setTimeout(r, 2)) });
    const deps = { repo, reservations: new SlotReservations() };
    const eventType = (await repo.getEventTypes("org_nordlicht")).find((e) => e.slug === "demo-call")!;
    const slot = at("2026-10-01", "11:00"); // Jana, Mehdi, Lena all free (Thursday workshop starts 13:00)
    const results = await Promise.all(
      ["A", "B", "C"].map((n) => bookWithRouting(deps, { eventType, startsAt: slot, now: NOW, data: { ...base, attendeeName: n } })),
    );
    const hosts = results.map((r) => r.hostUserId).sort();
    assert.deepEqual(hosts, ["usr_jana", "usr_lena", "usr_mehdi"], "three parallel requests → three different hosts");
    await assert.rejects(
      bookWithRouting(deps, { eventType, startsAt: slot, now: NOW, data: { ...base, attendeeName: "D" } }),
      /No team member is free/,
    );
  });

  it("voice service exposes the routed host and stores answers", async () => {
    const repo = new MemoryRepo(demoSeed());
    const svc = new VoiceToolService(repo, { now: () => NOW, reservations: new SlotReservations() });
    const s = await svc.startSession({ callSid: "CA_rr", from: DEMO_CALLER, to: DEMO_NUMBER });
    assert.equal(s.eventTypes.find((e) => e.slug === "demo-call")!.bookingFields.length, 4, "session carries the custom questions");
    const { slots } = await svc.checkAvailability({ interactionId: s.interactionId, eventTypeSlug: "demo-call", from: "2026-09-30", to: "2026-09-30" });
    const b = await svc.bookAppointment({
      interactionId: s.interactionId,
      eventTypeSlug: "demo-call",
      startsAt: slots[0]!.start,
      attendee: { name: "Lena Hoffmann" },
      answers: { company: "Müller GmbH", employees: "10-49" },
    });
    assert.ok(["usr_jana", "usr_lena", "usr_mehdi"].includes(b.hostUserId));
    assert.equal(toWallClock(new Date(b.startsAt), TZ).time, "09:00");
    assert.deepEqual((await repo.getBooking(b.id))!.answers, { company: "Müller GmbH", employees: "10-49" });
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Answer-based routing — "Mitarbeiteranzahl" decides who takes the appointment
//
//   User A (Anna Klein)  → small companies   employees ∈ { 1-9, 10-49 }
//   User B (Ben Groß)    → enterprises       employees ∈ { 50-249, 250+ }
//
// Full path per incoming payload (what apps/web's server action and the
// voice service do): parse → validate against bookingFields → bookWithRouting.
// Core is zod-free, so the validator below re-implements the semantics of
// contracts' buildAnswersSchema (strict keys, required, select options,
// multiselect any-of, trimming); the zod version itself is covered in
// packages/contracts/test (booking-fields + routing-answers).
// ═══════════════════════════════════════════════════════════════════════════


// ── 1. the booking-field schema (same JSON shape as EventType.bookingFields) ──

interface Field {
  key: string;
  label: string;
  type: "text" | "select" | "multiselect";
  required: boolean;
  options?: ReadonlyArray<{ value: string; label: string }>;
}

const BERATUNG_FIELDS: readonly Field[] = [
  { key: "company", label: "Firma", type: "text", required: true },
  {
    key: "employees",
    label: "Mitarbeiteranzahl",
    type: "select",
    required: true,
    options: [
      { value: "1-9", label: "1–9" },
      { value: "10-49", label: "10–49" },
      { value: "50-249", label: "50–249" },
      { value: "250+", label: "250+" },
    ],
  },
  {
    key: "topics",
    label: "Themen",
    type: "multiselect",
    required: false,
    options: [
      { value: "phone", label: "KI-Telefonassistent" },
      { value: "crm", label: "CRM-Anbindung" },
    ],
  },
];

const SMALL: RoutingMatch[] = [{ field: "employees", values: ["1-9", "10-49"] }];
const ENTERPRISE: RoutingMatch[] = [{ field: "employees", values: ["50-249", "250+"] }];

/** Which member every option must end up with — the oracle for the tests below. */
const EXPECTED_HOST: Record<string, string> = { "1-9": "usr_a", "10-49": "usr_a", "50-249": "usr_b", "250+": "usr_b" };

// ── validator with buildAnswersSchema semantics (see header) ─────────────────

class AnswersError extends Error {
  constructor(public readonly fieldErrors: Record<string, string>) {
    super(`invalid answers: ${Object.entries(fieldErrors).map(([k, v]) => `${k} → ${v}`).join("; ")}`);
  }
}

function validateAnswers(fields: readonly Field[], raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) throw new AnswersError({ _form: "Antworten konnten nicht gelesen werden." });
  const input = raw as Record<string, unknown>;
  const errors: Record<string, string> = {};
  const out: Record<string, unknown> = {};
  const known = new Set(fields.map((f) => f.key));
  for (const k of Object.keys(input)) if (!known.has(k)) errors[k] = `Unbekanntes Feld "${k}"`; // strict object
  for (const f of fields) {
    const v = input[f.key];
    const blank = v === undefined || v === null || v === "" || v === false || (Array.isArray(v) && v.length === 0);
    if (blank) {
      if (f.required) errors[f.key] = `${f.label} ist erforderlich`;
      continue;
    }
    const allowed = new Set((f.options ?? []).map((o) => o.value));
    switch (f.type) {
      case "text":
        if (typeof v !== "string") errors[f.key] = `${f.label}: ungültiger Wert`;
        else if (!v.trim()) errors[f.key] = `${f.label} ist erforderlich`;
        else out[f.key] = v.trim();
        break;
      case "select":
        if (typeof v !== "string" || !allowed.has(v)) errors[f.key] = `${f.label}: bitte eine Option wählen`;
        else out[f.key] = v;
        break;
      case "multiselect": {
        const arr = typeof v === "string" ? [v] : v;
        if (!Array.isArray(arr) || arr.some((x) => typeof x !== "string" || !allowed.has(x))) errors[f.key] = `${f.label}: ungültige Option`;
        else out[f.key] = arr;
        break;
      }
    }
  }
  if (Object.keys(errors).length) throw new AnswersError(errors);
  return out;
}

// ── 2. the team: two members with identical availability — only the rule decides ──

function segmentSeed(opts: { catchAll?: boolean; onlyEnterprise?: boolean } = {}): MemorySeed {
  const tz = "Europe/Berlin";
  const orgId = "org_segment";
  const weekdays = (start: string, end: string) => [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: start, endTime: end }));
  const userA: HostRecord = { id: "usr_a", organizationId: orgId, name: "Anna Klein", timezone: tz, rules: weekdays("09:00", "17:00"), overrides: [] };
  const userB: HostRecord = { id: "usr_b", organizationId: orgId, name: "Ben Groß", timezone: tz, rules: weekdays("09:00", "17:00"), overrides: [] };
  const userC: HostRecord = { id: "usr_c", organizationId: orgId, name: "Chris Allround", timezone: tz, rules: weekdays("09:00", "17:00"), overrides: [] };
  const beratung: EventTypeRecord = {
    id: "evt_beratung",
    organizationId: orgId,
    slug: "beratung",
    title: "Beratungsgespräch",
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    slotIntervalMin: 30,
    minNoticeMin: 120,
    maxDaysAhead: 60,
    hostUserId: userA.id,
    routing: "ROUND_ROBIN",
    bookingFields: BERATUNG_FIELDS,
    isActive: true,
    bookableByAi: true,
  };
  const pool = opts.onlyEnterprise
    ? [{ hostUserId: userB.id, match: ENTERPRISE }]
    : [
        { hostUserId: userA.id, match: SMALL },
        { hostUserId: userB.id, match: ENTERPRISE },
        ...(opts.catchAll ? [{ hostUserId: userC.id, priority: 9 }] : []), // high priority must NOT beat a matching specialist
      ];
  return {
    org: { id: orgId, name: "Segment GmbH", slug: "segment", timezone: tz, locale: "de", dataRetentionDays: 30 },
    agent: { id: "agt_segment", organizationId: orgId, name: "Assistent", languages: ["de"], storeTranscripts: false, bookableEventTypeIds: [beratung.id], isActive: true },
    phoneNumbers: [{ e164: "+4930555987654", agentId: "agt_segment" }],
    hosts: [userA, userB, userC],
    eventTypes: [beratung],
    eventTypeHosts: { [beratung.id]: pool },
    bookings: [],
    externalBusy: {},
  };
}

/** MemoryRepo that counts write attempts — proves invalid payloads never reach the locked write path. */
class CountingRepo extends MemoryRepo {
  writes = 0;
  override async createBookingIfFree(data: CreateBookingData, guard: { bufferBeforeMin: number; bufferAfterMin: number }) {
    this.writes++;
    return super.createBookingIfFree(data, guard);
  }
}

/** The pipeline under test: raw incoming payload (web = JSON string, voice = object) → validated answers → routed commit. */
function pipeline(repo: CountingRepo, reservations = new SlotReservations()) {
  const deps = { repo, reservations };
  return {
    deps,
    async book(rawAnswers: string | Record<string, unknown>, startsAt: Date, attendeeName = "Kunde") {
      const eventType = (await repo.getEventTypes("org_segment"))[0]!;
      const parsed: unknown = typeof rawAnswers === "string" ? JSON.parse(rawAnswers) : rawAnswers; // web form posts a JSON string
      const answers = validateAnswers(BERATUNG_FIELDS, parsed); // BEFORE any routing / locking
      return bookWithRouting(deps, {
        eventType,
        startsAt,
        now: NOW,
        data: { organizationId: "org_segment", eventTypeId: eventType.id, source: "WEB", attendeeName, attendeeEmail: null, attendeePhone: null, attendeeTz: TZ, note: null, answers },
      });
    },
  };
}

const WED = "2026-09-30";

describe("rankCandidates — segment rules (pure)", () => {
  const A: HostCandidate = { hostUserId: "usr_a", priority: 0, upcomingBookings: 0, lastAssignedAt: null, match: SMALL };
  const B: HostCandidate = { hostUserId: "usr_b", priority: 0, upcomingBookings: 0, lastAssignedAt: null, match: ENTERPRISE };
  const C: HostCandidate = { hostUserId: "usr_c", priority: 9, upcomingBookings: 0, lastAssignedAt: null }; // catch-all, high priority
  const ids = (r: HostCandidate[]) => r.map((c) => c.hostUserId);

  it("matching specialist first, catch-all as fallback, non-matching excluded", () => {
    assert.deepEqual(rankCandidates([A, B, C], { employees: "1-9" }).map((c) => [c.hostUserId, c.tier]), [["usr_a", "MATCH"], ["usr_c", "FALLBACK"]]);
    assert.deepEqual(ids(rankCandidates([A, B, C], { employees: "250+" })), ["usr_b", "usr_c"]);
    assert.deepEqual(ids(rankCandidates([A, B, C], {})), ["usr_c"], "no answer → only the catch-all qualifies");
    assert.deepEqual(ids(rankCandidates([A, B], { employees: "5000" })), [], "strict pool + unknown value → nobody");
  });

  it("is deterministic regardless of pool order", () => {
    const pool = [A, B, C];
    for (let i = 0; i < 50; i++) {
      const shuffled = [...pool].sort(() => Math.random() - 0.5);
      assert.deepEqual(ids(rankCandidates(shuffled, { employees: "50-249" })), ["usr_b", "usr_c"]);
    }
  });

  it("multiselect answers match any-of; several rules on one member are AND-ed; numbers/booleans compare as strings", () => {
    assert.equal(matchesAnswers([{ field: "topics", values: ["crm"] }], { topics: ["phone", "crm"] }), true);
    assert.equal(matchesAnswers([{ field: "topics", values: ["crm"] }], { topics: ["phone"] }), false);
    assert.equal(matchesAnswers([...SMALL, { field: "topics", values: ["crm"] }], { employees: "1-9", topics: ["crm"] }), true);
    assert.equal(matchesAnswers([...SMALL, { field: "topics", values: ["crm"] }], { employees: "1-9" }), false, "second rule unmet");
    assert.equal(matchesAnswers([{ field: "seats", values: ["12"] }], { seats: 12 }), true);
    assert.equal(matchesAnswers([{ field: "vip", values: ["true"] }], { vip: true }), true);
    assert.equal(matchesAnswers([], { employees: "1-9" }), true, "no rules = catch-all");
  });
});

describe("integration — Mitarbeiteranzahl → User A (small) / User B (enterprise)", () => {
  it("parses + validates every incoming payload and assigns exactly the configured member", async () => {
    const repo = new CountingRepo(segmentSeed());
    const p = pipeline(repo);
    let slot = 0;
    for (const [employees, expectedHost] of Object.entries(EXPECTED_HOST)) {
      const payload = JSON.stringify({ company: `  Firma ${employees}  `, employees, topics: ["crm"] }); // as posted by the web form
      const r = await p.book(payload, at(WED, `${9 + slot++}:00`.padStart(5, "0")));
      assert.equal(r.hostUserId, expectedHost, `employees=${employees} → ${expectedHost}`);
      assert.equal(r.routedBy, "MATCH", "assignment came from the segment rule, not the fallback");
      assert.equal(r.booking.hostUserId, expectedHost, "the persisted booking carries the same host");
      assert.deepEqual(r.booking.answers, { company: `Firma ${employees}`, employees, topics: ["crm"] }, "answers stored trimmed/compacted");
    }
    assert.equal(repo.writes, 4, "one locked write per booking");
  });

  it("is deterministic: order of arrival, rotation state and load never move a payload across segments", async () => {
    // fresh repo, payloads in reverse order, plus a heavy pre-load on both members
    const repo = new CountingRepo(segmentSeed());
    const p = pipeline(repo);
    const options = Object.keys(EXPECTED_HOST).reverse();
    const days = ["2026-09-30", "2026-10-01", "2026-10-02"]; // Wed, Thu, Fri
    for (const [i, day] of days.entries()) {
      for (const [j, employees] of options.entries()) {
        const r = await p.book({ company: "X", employees }, at(day, `${9 + j}:00`.padStart(5, "0")));
        assert.equal(r.hostUserId, EXPECTED_HOST[employees], `round ${i}, employees=${employees}`);
      }
    }
    const load = (await repo.getEventTypeHosts("evt_beratung")).map((h) => [h.hostUserId, h.upcomingBookings]);
    assert.deepEqual(load, [["usr_a", 6], ["usr_b", 6]], "each member only ever received their own segment");
  });

  it("same slot, both segments: A and B are booked independently; a second small company is refused even though B is free", async () => {
    const repo = new CountingRepo(segmentSeed());
    const p = pipeline(repo);
    const slot = at(WED, "10:00");
    assert.equal((await p.book({ company: "Klein GmbH", employees: "10-49" }, slot)).hostUserId, "usr_a");
    // B is free at 10:00 but is NOT allowed to take a small company
    await assert.rejects(p.book({ company: "Winzig UG", employees: "1-9" }, slot), /No team member is free/);
    assert.equal((await p.book({ company: "Groß AG", employees: "250+" }, slot)).hostUserId, "usr_b");
    await assert.rejects(p.book({ company: "Konzern SE", employees: "50-249" }, slot), /No team member is free/);
    assert.equal(repo.bookings.size, 2);
  });

  it("rejects invalid payloads with field-level messages BEFORE any lock, reservation or write", async () => {
    const repo = new CountingRepo(segmentSeed());
    const reservations = new SlotReservations();
    const p = pipeline(repo, reservations);
    const slot = at(WED, "11:00");
    const cases: Array<[string, string | Record<string, unknown>, string]> = [
      ["missing required question", { company: "X" }, "employees → Mitarbeiteranzahl ist erforderlich"],
      ["blank select", JSON.stringify({ company: "X", employees: "" }), "Mitarbeiteranzahl ist erforderlich"],
      ["value outside the options", { company: "X", employees: "1000" }, "Mitarbeiteranzahl: bitte eine Option wählen"],
      ["array for a select", { company: "X", employees: ["1-9"] }, "bitte eine Option wählen"],
      ["unknown multiselect value", { company: "X", employees: "1-9", topics: ["nope"] }, "Themen: ungültige Option"],
      ["whitespace-only required text", { company: "   ", employees: "1-9" }, "Firma ist erforderlich"],
      ["injected key (strict object)", { company: "X", employees: "1-9", hostUserId: "usr_b" }, 'Unbekanntes Feld "hostUserId"'],
      ["not an object", JSON.stringify(["1-9"]), "Antworten konnten nicht gelesen werden"],
    ];
    for (const [name, payload, expectedMessage] of cases) {
      await assert.rejects(p.book(payload, slot), (e: unknown) => e instanceof AnswersError && e.message.includes(expectedMessage), name);
    }
    await assert.rejects(p.book("{not json", slot), SyntaxError, "malformed JSON from the client");
    assert.equal(repo.writes, 0, "no write attempted");
    assert.equal(repo.bookings.size, 0, "nothing persisted");
    assert.deepEqual(reservations.busyOverlay("usr_a", at(WED, "00:00"), at("2026-10-01", "00:00")), [], "no reservation left behind");
    assert.deepEqual(reservations.busyOverlay("usr_b", at(WED, "00:00"), at("2026-10-01", "00:00")), []);
  });

  it("valid answers that nobody is configured for → NoEligibleHostError, no write (strictly segmented pool)", async () => {
    const repo = new CountingRepo(segmentSeed({ onlyEnterprise: true }));
    const p = pipeline(repo);
    await assert.rejects(
      p.book({ company: "Klein GmbH", employees: "1-9" }, at(WED, "09:00")),
      (e: unknown) => e instanceof NoEligibleHostError && e.code === "NO_ELIGIBLE_HOST" && e.unmatchedFields.includes("employees"),
    );
    assert.equal(repo.writes, 0);
    assert.equal((await p.book({ company: "Groß AG", employees: "250+" }, at(WED, "09:00"))).hostUserId, "usr_b");
  });

  it("catch-all member: takes what no specialist matches or can serve — but never outranks a free specialist", async () => {
    const seed = segmentSeed({ catchAll: true });
    seed.externalBusy = { usr_b: [{ start: at(WED, "14:00"), end: at(WED, "15:00") }] }; // B in a meeting 14–15
    const repo = new CountingRepo(seed);
    const p = pipeline(repo);

    const enterpriseFree = await p.book({ company: "Groß AG", employees: "250+" }, at(WED, "09:00"));
    assert.deepEqual([enterpriseFree.hostUserId, enterpriseFree.routedBy], ["usr_b", "MATCH"], "B free → B, despite C's priority 9");

    const enterpriseBusy = await p.book({ company: "Konzern SE", employees: "250+" }, at(WED, "14:00"));
    assert.deepEqual([enterpriseBusy.hostUserId, enterpriseBusy.routedBy], ["usr_c", "FALLBACK"], "B busy → catch-all C, not A");
    assert.deepEqual(enterpriseBusy.triedHosts, ["usr_c"], "A (non-matching) was never even tried");

    const small = await p.book({ company: "Klein GmbH", employees: "1-9" }, at(WED, "14:00"));
    assert.equal(small.hostUserId, "usr_a");
  });

  it("concurrency: 2 small + 2 enterprise requests for one slot → exactly one A, one B, no cross-segment leak", async () => {
    const repo = new CountingRepo(segmentSeed(), { writeDelay: () => new Promise((r) => setTimeout(r, 2)) });
    const p = pipeline(repo);
    const slot = at(WED, "15:00");
    const results = await Promise.allSettled([
      p.book({ company: "S1", employees: "1-9" }, slot, "S1"),
      p.book({ company: "E1", employees: "250+" }, slot, "E1"),
      p.book({ company: "S2", employees: "10-49" }, slot, "S2"),
      p.book({ company: "E2", employees: "50-249" }, slot, "E2"),
    ]);
    const ok = results.filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof p.book>>> => r.status === "fulfilled").map((r) => r.value);
    assert.deepEqual(ok.map((r) => r.hostUserId).sort(), ["usr_a", "usr_b"]);
    for (const r of ok) assert.equal(EXPECTED_HOST[String(r.booking.answers?.employees)], r.hostUserId, "winner sits in the right segment");
    assert.equal(results.filter((r) => r.status === "rejected").length, 2);
    assert.equal(repo.bookings.size, 2);
  });

  it("voice channel: VoiceToolService with an answersValidator routes the caller's answers the same way", async () => {
    const repo = new CountingRepo(segmentSeed());
    const svc = new VoiceToolService(repo, {
      now: () => NOW,
      reservations: new SlotReservations(),
      answersValidator: (eventType, answers) => {
        try {
          return validateAnswers(eventType.bookingFields as readonly Field[], answers);
        } catch (e) {
          if (e instanceof AnswersError) throw new VoiceServiceError("INVALID_INPUT", `Missing or invalid answers — ask the caller: ${Object.values(e.fieldErrors).join("; ")}`, 400);
          throw e;
        }
      },
    });
    const s = await svc.startSession({ callSid: "CA_seg", from: "+493044671281", to: "+4930555987654" });
    assert.deepEqual((s.eventTypes[0]!.bookingFields as Field[]).map((f) => f.key), ["company", "employees", "topics"], "the assistant sees which questions to ask");

    const booked = await svc.bookAppointment({
      interactionId: s.interactionId,
      eventTypeSlug: "beratung",
      startsAt: at(WED, "09:30").toISOString(),
      attendee: { name: "Frau Groß" },
      answers: { company: "Groß AG", employees: "250+" },
    });
    assert.equal(booked.hostUserId, "usr_b");
    assert.deepEqual((await repo.getBooking(booked.id))!.answers, { company: "Groß AG", employees: "250+" });

    await assert.rejects(
      svc.bookAppointment({ interactionId: s.interactionId, eventTypeSlug: "beratung", startsAt: at(WED, "10:30").toISOString(), attendee: { name: "Herr Klein" }, answers: { company: "Klein GmbH" } }),
      (e: unknown) => e instanceof VoiceServiceError && e.code === "INVALID_INPUT" && /Mitarbeiteranzahl ist erforderlich/.test(e.message),
    );
    assert.equal(repo.writes, 1, "the invalid call never reached the write path");

    // nobody configured → 422 NO_ELIGIBLE_HOST, the assistant is told to escalate instead of retrying
    const strict = new CountingRepo(segmentSeed({ onlyEnterprise: true }));
    const svc2 = new VoiceToolService(strict, { now: () => NOW, reservations: new SlotReservations(), answersValidator: (et, a) => validateAnswers(et.bookingFields as readonly Field[], a) });
    const s2 = await svc2.startSession({ callSid: "CA_seg2", from: "+493044671281", to: "+4930555987654" });
    await assert.rejects(
      svc2.bookAppointment({ interactionId: s2.interactionId, eventTypeSlug: "beratung", startsAt: at(WED, "09:00").toISOString(), attendee: { name: "Herr Klein" }, answers: { company: "Klein GmbH", employees: "1-9" } }),
      (e: unknown) => e instanceof VoiceServiceError && e.code === "NO_ELIGIBLE_HOST" && e.status === 422,
    );
    assert.equal(strict.writes, 0);
  });
});
