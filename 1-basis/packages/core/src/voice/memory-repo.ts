/**
 * In-memory VoiceRepo — used by unit tests and by `scripts/demo-call.ts`.
 * Seeded with the data shown in docs/design/slotwise-dashboard-v1.html
 * (Nordlicht Consulting / Jana Krüger, Europe/Berlin, 30-min slots).
 */

import type { BusyBlock } from "../availability/engine";
import { KeyedMutex } from "../booking/keyed-mutex";
import { addMinutes, zonedToUtc } from "../time";
import { normalizePhone } from "./service";
import { StaleCommandError } from "./types";
import type {
  AgentRecord,
  BookingRecord,
  CommandStamp,
  CreateBookingData,
  EventTypeHostRecord,
  EventTypeRecord,
  HostRecord,
  InteractionRecord,
  OrgRecord,
  RoutingMatch,
  ToolCallAudit,
  VoiceRepo,
} from "./types";

export interface MemorySeed {
  org: OrgRecord;
  agent: AgentRecord;
  phoneNumbers: Array<{ e164: string; agentId: string }>;
  hosts: HostRecord[];
  eventTypes: EventTypeRecord[];
  /** Round-robin pools: eventTypeId → members (`match` = answer-based segment rules, see routing.ts). */
  eventTypeHosts?: Record<string, Array<{ hostUserId: string; priority?: number; lastAssignedAt?: Date | null; match?: RoutingMatch[] | null }>>;
  bookings: BookingRecord[];
  /** External calendar busy cache (Google/Microsoft), keyed by host id. */
  externalBusy: Record<string, BusyBlock[]>;
}

let counter = 0;
const nextId = (prefix: string) => `${prefix}_${(++counter).toString(36).padStart(4, "0")}`;

export interface MemoryRepoOptions {
  /**
   * Test-only: skip the per-host mutex so the conflict check and the insert can
   * interleave — reproduces the race the mutex exists to prevent.
   */
  unsafeNoLock?: boolean;
  /** Test-only: artificial latency inside the critical section (widens the race window). */
  writeDelay?: () => Promise<void>;
}

export class MemoryRepo implements VoiceRepo {
  readonly interactions = new Map<string, InteractionRecord>();
  readonly bookings = new Map<string, BookingRecord>();
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly seed: MemorySeed,
    private readonly opts: MemoryRepoOptions = {},
  ) {
    for (const b of seed.bookings) this.bookings.set(b.id, b);
  }

  async resolveNumber(toE164: string) {
    const hit = this.seed.phoneNumbers.find((p) => normalizePhone(p.e164) === normalizePhone(toE164));
    if (!hit || hit.agentId !== this.seed.agent.id) return null;
    return { org: this.seed.org, agent: this.seed.agent };
  }

  async getEventTypes(organizationId: string) {
    return this.seed.eventTypes.filter((e) => e.organizationId === organizationId);
  }

  async getHost(userId: string) {
    return this.seed.hosts.find((h) => h.id === userId) ?? null;
  }

  readonly assignments = new Map<string, Date>(); // `${eventTypeId}:${hostUserId}` → lastAssignedAt

  async getEventTypeHosts(eventTypeId: string): Promise<EventTypeHostRecord[]> {
    const pool = this.seed.eventTypeHosts?.[eventTypeId] ?? [];
    const now = new Date();
    return pool.map((m) => ({
      hostUserId: m.hostUserId,
      priority: m.priority ?? 0,
      upcomingBookings: [...this.bookings.values()].filter((b) => b.hostUserId === m.hostUserId && b.status !== "CANCELLED" && b.endsAt > now).length,
      lastAssignedAt: this.assignments.get(`${eventTypeId}:${m.hostUserId}`) ?? m.lastAssignedAt ?? null,
      match: m.match ?? null,
    }));
  }

  async markHostAssigned(eventTypeId: string, hostUserId: string, at: Date) {
    this.assignments.set(`${eventTypeId}:${hostUserId}`, at);
  }

  async getBusy(hostUserId: string, from: Date, to: Date): Promise<BusyBlock[]> {
    const own = [...this.bookings.values()]
      .filter((b) => b.hostUserId === hostUserId && b.status !== "CANCELLED")
      .map((b) => ({ start: b.startsAt, end: b.endsAt }));
    const external = this.seed.externalBusy[hostUserId] ?? [];
    return [...own, ...external].filter((b) => b.start < to && b.end > from);
  }

  async createInteraction(data: Omit<InteractionRecord, "id" | "toolCalls" | "outcome"> & { outcome?: InteractionRecord["outcome"] }) {
    const rec: InteractionRecord = { ...data, id: nextId("int"), outcome: data.outcome ?? "IN_PROGRESS", toolCalls: [] };
    this.interactions.set(rec.id, rec);
    return rec;
  }

  async getInteraction(id: string) {
    return this.interactions.get(id) ?? null;
  }

  async getInteractionByProviderCallId(providerCallId: string) {
    return [...this.interactions.values()].find((i) => i.providerCallId === providerCallId) ?? null;
  }

  async updateInteraction(id: string, patch: Partial<InteractionRecord>, command?: CommandStamp) {
    return this.withCommand(command, async () => {
      const cur = this.interactions.get(id);
      if (!cur) throw new Error(`interaction ${id} not found`);
      const next = { ...cur, ...patch };
      this.interactions.set(id, next);
      return next;
    });
  }

  async appendToolCall(id: string, entry: ToolCallAudit) {
    const cur = this.interactions.get(id);
    if (cur) cur.toolCalls.push(entry);
  }

  /**
   * Ordering guard, same contract as the Prisma repo: verify + record the stamp
   * and run the write as ONE critical section per call (keyed mutex ≙ the row
   * lock on CallInteraction in Postgres). Two commands of one call can interleave
   * everywhere else, never here — so the newer one wins whatever arrives first.
   */
  private async withCommand<T>(command: CommandStamp | undefined, fn: () => Promise<T>): Promise<T> {
    if (!command) return fn();
    return this.mutex.run(`call:${command.interactionId}`, async () => {
      const cur = this.interactions.get(command.interactionId);
      if (!cur) throw new Error(`interaction ${command.interactionId} not found`);
      const last = cur.lastCommandAt ?? null;
      if (last && last.getTime() > command.at.getTime()) throw new StaleCommandError(command, last, cur.lastCommandTool ?? null);
      this.interactions.set(cur.id, { ...cur, lastCommandAt: command.at, lastCommandTool: command.tool });
      return fn();
    });
  }

  /**
   * Mirrors the Prisma implementation: conflict check + insert as ONE atomic
   * step per host. Postgres gets that from an advisory transaction lock; here a
   * keyed mutex serialises the critical section so two concurrent calls can
   * never both see "free".
   */
  async createBookingIfFree(data: CreateBookingData, guard: { bufferBeforeMin: number; bufferAfterMin: number; command?: CommandStamp }) {
    const write = () => this.checkAndInsert(data, guard);
    // lock order: call → host (the Prisma repo takes the host advisory lock first, then the call row; no cycle: updateBooking never takes the host lock)
    return this.withCommand(guard.command, () => (this.opts.unsafeNoLock ? write() : this.mutex.run(`host:${data.hostUserId}`, write)));
  }

  private async checkAndInsert(data: CreateBookingData, guard: { bufferBeforeMin: number; bufferAfterMin: number }) {
    const guardStart = addMinutes(data.startsAt, -guard.bufferBeforeMin);
    const guardEnd = addMinutes(data.endsAt, guard.bufferAfterMin);
    const busy = await this.getBusy(data.hostUserId, guardStart, guardEnd);
    if (this.opts.writeDelay) await this.opts.writeDelay();
    if (busy.length > 0) return null;
    const now = new Date();
    const rec: BookingRecord = {
      ...data,
      id: nextId("bk"),
      status: "CONFIRMED",
      attendeePhone: data.attendeePhone ? normalizePhone(data.attendeePhone) : null,
      attendeeEmail: data.attendeeEmail ?? null,
      note: data.note ?? null,
      answers: data.answers ?? null,
      interactionId: data.interactionId ?? null,
      cancelReason: null,
      createdAt: now,
      updatedAt: now,
    };
    this.bookings.set(rec.id, rec);
    return rec;
  }

  async getBooking(id: string) {
    return this.bookings.get(id) ?? null;
  }

  async findUpcomingBookingsByPhone(organizationId: string, phoneE164: string, from: Date) {
    const phone = normalizePhone(phoneE164);
    return [...this.bookings.values()]
      .filter(
        (b) =>
          b.organizationId === organizationId &&
          b.status !== "CANCELLED" &&
          b.endsAt > from &&
          normalizePhone(b.attendeePhone ?? "") === phone,
      )
      .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  }

  async updateBooking(id: string, patch: Partial<BookingRecord>, command?: CommandStamp) {
    return this.withCommand(command, async () => {
      const cur = this.bookings.get(id);
      if (!cur) throw new Error(`booking ${id} not found`);
      const next = { ...cur, ...patch, updatedAt: new Date() };
      this.bookings.set(id, next);
      return next;
    });
  }

  async findBookingByInteractionAndStart(interactionId: string, startsAt: Date) {
    return (
      [...this.bookings.values()].find(
        (b) => b.interactionId === interactionId && b.startsAt.getTime() === startsAt.getTime() && b.status !== "CANCELLED",
      ) ?? null
    );
  }
}

// ── Seed: the dashboard mockup as data ─────────────────────────────────────

export const DEMO_NUMBER = "+4930555123456"; // the org's Twilio number (IE1)

/** Custom questions of the "Demo call" event type (see packages/contracts booking-fields.ts). */
export const DEMO_BOOKING_FIELDS = [
  { key: "company", label: "Firma", type: "text", required: true, placeholder: "Müller GmbH" },
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
    key: "budget",
    label: "Budget pro Monat",
    type: "select",
    required: false,
    options: [
      { value: "lt500", label: "unter 500 €" },
      { value: "500-2000", label: "500–2.000 €" },
      { value: "gt2000", label: "über 2.000 €" },
    ],
  },
  { key: "topics", label: "Interessante Themen", type: "multiselect", required: false, options: [{ value: "phone", label: "KI-Telefonassistent" }, { value: "booking", label: "Online-Buchung" }, { value: "crm", label: "CRM-Anbindung" }] },
] as const;
export const DEMO_CALLER = "+493044671281"; // shows as "+49 30 4467 ••81" in the feed

export function demoSeed(today = "2026-09-29"): MemorySeed {
  const tz = "Europe/Berlin";
  const org: OrgRecord = {
    id: "org_nordlicht",
    name: "Nordlicht Consulting",
    slug: "nordlicht",
    timezone: tz,
    locale: "de",
    dataRetentionDays: 30,
  };
  const host: HostRecord = {
    id: "usr_jana",
    organizationId: org.id,
    name: "Jana Krüger",
    timezone: tz,
    rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "09:00", endTime: "17:00" })),
    overrides: [{ date: "2026-10-03", startTime: null, endTime: null }], // Tag der Deutschen Einheit
  };
  const demo: EventTypeRecord = {
    id: "evt_demo",
    organizationId: org.id,
    slug: "demo-call",
    title: "Demo call",
    description: "30-minute product demo by phone",
    durationMin: 30,
    bufferBeforeMin: 0,
    bufferAfterMin: 0,
    slotIntervalMin: 30,
    minNoticeMin: 120,
    maxDaysAhead: 60,
    hostUserId: host.id,
    routing: "ROUND_ROBIN",
    bookingFields: DEMO_BOOKING_FIELDS,
    isActive: true,
    bookableByAi: true,
  };
  const onboarding: EventTypeRecord = {
    ...demo,
    id: "evt_onboarding",
    slug: "onboarding",
    title: "Onboarding",
    description: "45-minute onboarding session",
    durationMin: 45,
    bufferAfterMin: 15,
    routing: "SINGLE",
    bookingFields: null,
  };
  // Team for the round-robin pool of "Demo call": Jana (owner), Mehdi, Lena.
  const mehdi: HostRecord = { ...host, id: "usr_mehdi", name: "Mehdi Bekri", rules: [1, 2, 3, 4, 5].map((weekday) => ({ weekday, startTime: "10:00", endTime: "18:00" })), overrides: [] };
  const lena: HostRecord = { ...host, id: "usr_lena", name: "Lena Hoffmann", rules: [1, 2, 3, 4].map((weekday) => ({ weekday, startTime: "09:00", endTime: "15:00" })), overrides: [] };
  const agent: AgentRecord = {
    id: "agt_assistent",
    organizationId: org.id,
    name: "Assistent",
    languages: ["de", "en"],
    greeting: null,
    persona: "Freundlich, knapp, duzt nicht. Bietet maximal zwei Terminvorschläge auf einmal an.",
    escalationPhone: "+4930555123400",
    storeTranscripts: false,
    bookableEventTypeIds: [demo.id, onboarding.id],
    isActive: true,
  };

  const mk = (id: string, et: EventTypeRecord, date: string, time: string, name: string, phone: string): BookingRecord => {
    const startsAt = zonedToUtc(date, time, tz);
    return {
      id,
      organizationId: org.id,
      eventTypeId: et.id,
      hostUserId: host.id,
      startsAt,
      endsAt: addMinutes(startsAt, et.durationMin),
      status: "CONFIRMED",
      source: "WEB",
      attendeeName: name,
      attendeePhone: phone,
      attendeeEmail: null,
      attendeeTz: tz,
      note: null,
      cancelReason: null,
      interactionId: null,
      createdAt: new Date(`${today}T00:00:00Z`),
      updatedAt: new Date(`${today}T00:00:00Z`),
    };
  };

  return {
    org,
    agent,
    phoneNumbers: [{ e164: DEMO_NUMBER, agentId: agent.id }],
    hosts: [host, mehdi, lena],
    eventTypes: [demo, onboarding],
    eventTypeHosts: { [demo.id]: [{ hostUserId: host.id }, { hostUserId: mehdi.id }, { hostUserId: lena.id }] },
    bookings: [
      mk("bk_mueller", demo, today, "10:00", "Müller GmbH", "+4989215307"),
      mk("bk_weber", onboarding, today, "11:00", "S. Weber", "+49171552239"),
    ],
    externalBusy: {
      // From the Google Calendar busy cache: lunch block every day this week + a Thursday workshop.
      [host.id]: [
        ...["2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02"].map((d) => ({
          start: zonedToUtc(d, "12:00", tz),
          end: zonedToUtc(d, "13:00", tz),
        })),
        { start: zonedToUtc("2026-10-01", "13:00", tz), end: zonedToUtc("2026-10-01", "17:00", tz) },
      ],
    },
  };
}
