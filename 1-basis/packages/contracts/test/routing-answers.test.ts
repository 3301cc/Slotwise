/**
 * The real zod validator (buildAnswersSchema) feeding the real routing engine
 * (@slotwise/core bookWithRouting): a "Mitarbeiteranzahl" answer decides
 * whether User A (small companies) or User B (enterprises) takes the slot.
 * packages/core/test/routing.test.ts covers the engine in depth with a
 * zod-free validator; this test closes the gap to the actual schema.
 */
import {
  type EventTypeRecord,
  type HostRecord,
  MemoryRepo,
  type MemorySeed,
  NoEligibleHostError,
  SlotReservations,
  bookWithRouting,
  zonedToUtc,
} from "@slotwise/core";
import { describe, expect, it } from "vitest";
import { buildAnswersSchema, checkRoutingMatch, compactAnswers, parseBookingFields, parseRoutingMatch } from "../src/booking-fields";

const TZ = "Europe/Berlin";
const NOW = new Date("2026-09-29T07:41:00Z");
const at = (d: string, t: string) => zonedToUtc(d, t, TZ);

const RAW_FIELDS = [
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
];
const fields = parseBookingFields(RAW_FIELDS);
const schema = buildAnswersSchema(fields);

// what the dashboard would store in EventTypeHost.match (JSON)
const SMALL_JSON = [{ field: "employees", values: ["1-9", "10-49"] }];
const ENTERPRISE_JSON = [{ field: "employees", values: ["50-249", "250+"] }];

function seed(): MemorySeed {
  const rules = [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" }));
  const a: HostRecord = { id: "usr_a", organizationId: "org", name: "Anna Klein", timezone: TZ, rules, overrides: [] };
  const b: HostRecord = { id: "usr_b", organizationId: "org", name: "Ben Groß", timezone: TZ, rules, overrides: [] };
  const et: EventTypeRecord = {
    id: "evt",
    organizationId: "org",
    slug: "beratung",
    title: "Beratung",
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    slotIntervalMin: 30,
    minNoticeMin: 120,
    maxDaysAhead: 60,
    hostUserId: a.id,
    routing: "ROUND_ROBIN",
    bookingFields: RAW_FIELDS,
    isActive: true,
    bookableByAi: true,
  };
  return {
    org: { id: "org", name: "Segment GmbH", slug: "segment", timezone: TZ, locale: "de", dataRetentionDays: 30 },
    agent: { id: "agt", organizationId: "org", name: "Assistent", languages: ["de"], storeTranscripts: false, bookableEventTypeIds: [et.id], isActive: true },
    phoneNumbers: [],
    hosts: [a, b],
    eventTypes: [et],
    eventTypeHosts: { [et.id]: [{ hostUserId: a.id, match: parseRoutingMatch(SMALL_JSON) }, { hostUserId: b.id, match: parseRoutingMatch(ENTERPRISE_JSON) }] },
    bookings: [],
    externalBusy: {},
  };
}

/** Server-action shape: the form posts `answers` as a JSON string. */
async function book(repo: MemoryRepo, rawAnswers: string, startsAt: Date) {
  const r = schema.safeParse(JSON.parse(rawAnswers));
  if (!r.success) throw new Error(r.error.issues.map((i) => `${String(i.path[0])}: ${i.message}`).join("; "));
  const eventType = (await repo.getEventTypes("org"))[0]!;
  return bookWithRouting(
    { repo, reservations: new SlotReservations() },
    {
      eventType,
      startsAt,
      now: NOW,
      data: { organizationId: "org", eventTypeId: eventType.id, source: "WEB", attendeeName: "Kunde", attendeeEmail: null, attendeePhone: null, attendeeTz: TZ, note: null, answers: compactAnswers(r.data as Record<string, unknown>) },
    },
  );
}

describe("routing rules ⇄ bookingFields (zod)", () => {
  it("parses the JSON column and cross-checks rules against the field definition", () => {
    expect(parseRoutingMatch(SMALL_JSON)).toEqual(SMALL_JSON);
    expect(parseRoutingMatch(null)).toBeNull();
    expect(parseRoutingMatch([])).toBeNull();
    expect(parseRoutingMatch({ field: "employees" })).toBeNull(); // broken → catch-all, never a crash
    expect(checkRoutingMatch(parseRoutingMatch(ENTERPRISE_JSON)!, fields)).toEqual([]);
    expect(checkRoutingMatch([{ field: "employees", values: ["1000"] }], fields)).toEqual(['"employees": unknown option "1000"']);
    expect(checkRoutingMatch([{ field: "company", values: ["x"] }], fields)).toEqual(['"company" is text; routing rules need select/multiselect']);
    expect(checkRoutingMatch([{ field: "nope", values: ["x"] }], fields)).toEqual(['unknown field "nope"']);
  });

  it("every option lands on exactly the configured member, deterministically", async () => {
    const expected: Record<string, string> = { "1-9": "usr_a", "10-49": "usr_a", "50-249": "usr_b", "250+": "usr_b" };
    for (const order of [Object.keys(expected), Object.keys(expected).reverse()]) {
      const repo = new MemoryRepo(seed());
      for (const [i, employees] of order.entries()) {
        const r = await book(repo, JSON.stringify({ company: " Firma ", employees }), at("2026-09-30", `${9 + i}:00`.padStart(5, "0")));
        expect(r.hostUserId).toBe(expected[employees]);
        expect(r.routedBy).toBe("MATCH");
        expect(r.booking.answers).toEqual({ company: "Firma", employees });
      }
    }
  });

  it("zod rejects bad payloads before routing; a valid but unserved segment is a NoEligibleHostError", async () => {
    const repo = new MemoryRepo(seed());
    await expect(book(repo, JSON.stringify({ company: "X" }), at("2026-09-30", "09:00"))).rejects.toThrow(/Mitarbeiteranzahl ist erforderlich/);
    await expect(book(repo, JSON.stringify({ company: "X", employees: "1000" }), at("2026-09-30", "09:00"))).rejects.toThrow(/employees/);
    await expect(book(repo, JSON.stringify({ company: "X", employees: "1-9", hostUserId: "usr_b" }), at("2026-09-30", "09:00"))).rejects.toThrow(/hostUserId/);
    expect(repo.bookings.size).toBe(0);

    const s = seed();
    s.eventTypeHosts = { evt: [{ hostUserId: "usr_b", match: parseRoutingMatch(ENTERPRISE_JSON) }] };
    await expect(book(new MemoryRepo(s), JSON.stringify({ company: "X", employees: "1-9" }), at("2026-09-30", "09:00"))).rejects.toBeInstanceOf(NoEligibleHostError);
  });
});
