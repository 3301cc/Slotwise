/**
 * Host routing for an event type — SINGLE (one host) or ROUND_ROBIN over a
 * pool (e.g. Jana, Mehdi, Lena). Pure ranking + a commit loop that reuses
 * `commitBooking()` per candidate, so routing never weakens the double-booking
 * guarantee: each candidate host is tried under its own reservation + lock.
 *
 * Routing decision, in order:
 *   0. answer-based segment rules (`HostCandidate.match`, fed by the validated
 *      `bookingFields` answers — e.g. "Mitarbeiteranzahl 250+ → User B"):
 *        · members whose rules match the answers   → tier MATCH   (tried first)
 *        · members without rules                    → tier FALLBACK (catch-all)
 *        · members whose rules do NOT match         → excluded
 *      A pool where every member has rules is strictly segmented: a payload
 *      that matches nobody is rejected with `NoEligibleHostError` *before* any
 *      lock is taken — never silently handed to the wrong person.
 *   1. only hosts that are actually free at the slot (rules + busy) qualify
 *   2. higher `priority` first (lets a senior take precedence if configured)
 *   3. fewer upcoming bookings first (load balance)
 *   4. least recently assigned first (rotation)
 *   5. stable tie-break on hostUserId
 *
 * Everything above is deterministic: same pool state + same answers → same host.
 */

import { type AvailabilityInput, isBookableStart } from "../availability/engine";
import { addMinutes } from "../time";
import type { CommandStamp, CreateBookingData, EventTypeRecord, HostRecord, RoutingMatch, VoiceRepo } from "../voice/types";
import { type BookingGuard, type CommitDeps, SlotTakenError, commitBooking } from "./commit";

export type RoutingStrategy = "SINGLE" | "ROUND_ROBIN";
export type { RoutingMatch };

export interface HostCandidate {
  hostUserId: string;
  priority: number;
  upcomingBookings: number;
  lastAssignedAt: Date | null;
  /** Answer-based segment rules; `null`/`[]` = catch-all (see file header). */
  match?: RoutingMatch[] | null;
}

export type RoutingAnswers = Record<string, unknown>;

/** Thrown when segment rules exclude every member of the pool for these answers. */
export class NoEligibleHostError extends Error {
  readonly code = "NO_ELIGIBLE_HOST" as const;
  constructor(
    public readonly eventTypeId: string,
    public readonly unmatchedFields: string[],
  ) {
    super(`No team member is configured for these answers (${unmatchedFields.join(", ") || "no rules matched"})`);
    this.name = "NoEligibleHostError";
  }
}

export function rankRoundRobin(candidates: HostCandidate[]): HostCandidate[] {
  return [...candidates].sort(
    (a, b) =>
      b.priority - a.priority ||
      a.upcomingBookings - b.upcomingBookings ||
      (a.lastAssignedAt?.getTime() ?? 0) - (b.lastAssignedAt?.getTime() ?? 0) ||
      a.hostUserId.localeCompare(b.hostUserId),
  );
}

// ── answer-based segment rules ──────────────────────────────────────────────

/** Answer value → comparable strings (select → [v], multiselect → v[], number/boolean → [String(v)]). */
function answerValues(v: unknown): string[] {
  if (v === undefined || v === null || v === "") return [];
  if (Array.isArray(v)) return v.filter((x) => x !== undefined && x !== null && x !== "").map(String);
  return [String(v)];
}

/** One rule holds when at least one of the answer's values is in `rule.values` (OR). */
export function matchesRule(rule: RoutingMatch, answers: RoutingAnswers | null | undefined): boolean {
  const have = answerValues(answers?.[rule.field]);
  return have.some((v) => rule.values.includes(v));
}

/** All of a member's rules must hold (AND). No rules → catch-all → `true`. */
export function matchesAnswers(match: RoutingMatch[] | null | undefined, answers: RoutingAnswers | null | undefined): boolean {
  if (!match?.length) return true;
  return match.every((rule) => matchesRule(rule, answers));
}

export type RoutingTier = "MATCH" | "FALLBACK";

/**
 * Applies the segment rules and returns the candidates in the order they will
 * be tried: matching specialists (round-robin among themselves) first, then
 * catch-all members (round-robin), non-matching members dropped.
 */
export function rankCandidates(pool: HostCandidate[], answers: RoutingAnswers | null | undefined): Array<HostCandidate & { tier: RoutingTier }> {
  const matched: HostCandidate[] = [];
  const fallback: HostCandidate[] = [];
  for (const c of pool) {
    if (!c.match?.length) fallback.push(c);
    else if (matchesAnswers(c.match, answers)) matched.push(c);
  }
  return [
    ...rankRoundRobin(matched).map((c) => ({ ...c, tier: "MATCH" as const })),
    ...rankRoundRobin(fallback).map((c) => ({ ...c, tier: "FALLBACK" as const })),
  ];
}

export interface RoutingRepo extends Pick<VoiceRepo, "createBookingIfFree" | "getHost" | "getBusy"> {
  getEventTypeHosts(eventTypeId: string): Promise<HostCandidate[]>;
  markHostAssigned(eventTypeId: string, hostUserId: string, at: Date): Promise<void>;
}

/** Hosts in the event type's pool (SINGLE → just the default host). */
export async function poolFor(repo: RoutingRepo, eventType: EventTypeRecord): Promise<HostCandidate[]> {
  if (eventType.routing !== "ROUND_ROBIN") {
    return [{ hostUserId: eventType.hostUserId, priority: 0, upcomingBookings: 0, lastAssignedAt: null }];
  }
  const pool = await repo.getEventTypeHosts(eventType.id);
  return pool.length ? pool : [{ hostUserId: eventType.hostUserId, priority: 0, upcomingBookings: 0, lastAssignedAt: null }];
}

export interface RoutedBooking {
  hostUserId: string;
  booking: Awaited<ReturnType<typeof commitBooking>>;
  triedHosts: string[];
  /** SINGLE: the default host. MATCH: a segment rule selected the host. FALLBACK: catch-all member. */
  routedBy: "SINGLE" | RoutingTier;
}

/**
 * Route + commit. Applies the segment rules to `data.answers` (already
 * validated by the caller against bookingFields), validates the slot per host
 * (its own rules/busy), then tries candidates in order until one commit
 * succeeds. A candidate that loses a race (`SlotTakenError`) simply yields to
 * the next one.
 */
export async function bookWithRouting(
  deps: CommitDeps & { repo: RoutingRepo },
  input: {
    eventType: EventTypeRecord;
    startsAt: Date;
    data: Omit<CreateBookingData, "hostUserId" | "startsAt" | "endsAt">;
    now: Date;
    /** Ordering stamp of the voice command behind this booking (see CommandStamp). */
    command?: CommandStamp;
  },
): Promise<RoutedBooking> {
  const { eventType, startsAt, now } = input;
  const endsAt = addMinutes(startsAt, eventType.durationMin);
  const guard: BookingGuard = { bufferBeforeMin: eventType.bufferBeforeMin, bufferAfterMin: eventType.bufferAfterMin, command: input.command };
  const tried: string[] = [];

  const pool = await poolFor(deps.repo, eventType);
  const ranked = rankCandidates(pool, input.data.answers);
  if (ranked.length === 0) {
    // strictly segmented pool and nobody is configured for these answers
    const fields = [...new Set(pool.flatMap((c) => (c.match ?? []).map((r) => r.field)))];
    throw new NoEligibleHostError(eventType.id, fields);
  }

  for (const candidate of ranked) {
    const host = await deps.repo.getHost(candidate.hostUserId);
    if (!host) continue;
    if (!(await hostIsFree(deps.repo, host, eventType, startsAt, endsAt, now))) continue;
    tried.push(host.id);
    try {
      const booking = await commitBooking(deps, { ...input.data, hostUserId: host.id, startsAt, endsAt }, guard);
      if (eventType.routing === "ROUND_ROBIN") await deps.repo.markHostAssigned(eventType.id, host.id, now);
      return { hostUserId: host.id, booking, triedHosts: tried, routedBy: eventType.routing === "ROUND_ROBIN" ? candidate.tier : "SINGLE" };
    } catch (e) {
      if (e instanceof SlotTakenError) continue; // this host just got taken — next in rotation
      throw e;
    }
  }
  throw new SlotTakenError("conflict", "No team member is free at that time any more");
}

async function hostIsFree(
  repo: RoutingRepo,
  host: HostRecord,
  eventType: EventTypeRecord,
  startsAt: Date,
  endsAt: Date,
  now: Date,
): Promise<boolean> {
  const busy = await repo.getBusy(host.id, addMinutes(startsAt, -24 * 60), addMinutes(endsAt, 24 * 60));
  const input: Omit<AvailabilityInput, "from" | "to"> = {
    timezone: host.timezone,
    rules: host.rules,
    overrides: host.overrides,
    eventType,
    busy,
    now,
  };
  return isBookableStart(input, startsAt);
}
