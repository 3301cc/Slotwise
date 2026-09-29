/**
 * Records and repository contract used by the voice tool service.
 * These mirror the Prisma models 1:1 but stay framework-free so the service
 * can be unit-tested with an in-memory repo and reused by the mock server.
 */

import type { AvailabilityRule, BusyBlock, DateOverride } from "../availability/engine";

export type CallOutcome =
  | "IN_PROGRESS"
  | "BOOKED"
  | "RESCHEDULED"
  | "CANCELLED"
  | "CONFIRMED"
  | "TRANSFERRED"
  | "MISSED"
  | "INFO"
  | "FAILED"
  | "CALLBACK_REQUESTED";

export type BookingStatus = "CONFIRMED" | "RESCHEDULED" | "CANCELLED" | "NEEDS_ATTENTION";
export type BookingSource = "WEB" | "AI_PHONE" | "MANUAL";

export interface OrgRecord {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  locale: "de" | "en";
  dataRetentionDays: number;
}

export interface AgentRecord {
  id: string;
  organizationId: string;
  name: string;
  languages: string[];
  greeting?: string | null;
  persona?: string | null;
  escalationPhone?: string | null;
  storeTranscripts: boolean;
  bookableEventTypeIds: string[];
  isActive: boolean;
}

export interface EventTypeRecord {
  id: string;
  organizationId: string;
  slug: string;
  title: string;
  description?: string | null;
  durationMin: number;
  bufferBeforeMin: number;
  bufferAfterMin: number;
  slotIntervalMin: number;
  minNoticeMin: number;
  maxDaysAhead: number;
  hostUserId: string; // default host / SINGLE
  routing: "SINGLE" | "ROUND_ROBIN";
  bookingFields?: unknown | null; // BookingField[] JSON (validated via @slotwise/contracts)
  isActive: boolean;
  bookableByAi: boolean;
}

export interface HostRecord {
  id: string;
  organizationId: string;
  name: string;
  timezone: string;
  rules: AvailabilityRule[];
  overrides: DateOverride[];
}

export interface BookingRecord {
  id: string;
  organizationId: string;
  eventTypeId: string;
  hostUserId: string;
  startsAt: Date;
  endsAt: Date;
  status: BookingStatus;
  source: BookingSource;
  attendeeName: string;
  attendeePhone?: string | null;
  attendeeEmail?: string | null;
  attendeeTz: string;
  note?: string | null;
  answers?: Record<string, unknown> | null; // ⚑ answers to bookingFields
  cancelReason?: string | null;
  interactionId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ToolCallAudit {
  at: string; // ISO, server time
  clientAt?: string; // ISO, the speech event on the voice worker (clientTimestamp), when sent
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  code?: string;
  ms: number;
}

export interface InteractionRecord {
  id: string;
  organizationId: string;
  agentId: string;
  direction: "INBOUND" | "OUTBOUND";
  providerCallId: string;
  fromNumber: string;
  toNumber: string;
  startedAt: Date;
  endedAt?: Date | null;
  durationSec?: number | null;
  outcome: CallOutcome;
  summary?: string | null;
  language?: string | null;
  transcript?: unknown | null;
  toolCalls: ToolCallAudit[];
  callbackRequest?: CallbackRequest | null;
  /** Ordering guard: speech-event time of the newest state-changing command applied for this call (see CommandStamp). */
  lastCommandAt?: Date | null;
  lastCommandTool?: string | null;
  expiresAt: Date;
}

/**
 * Ordering stamp of a state-changing command: `at` = speech-event time on the
 * voice worker (unix ms, strictly increasing per call). Verified INSIDE the
 * write transaction of the repo (row lock on the call): the write happens only
 * if no newer command was applied for this call, and records itself as the
 * newest. Equal `at` passes (retry of the same command).
 */
export interface CommandStamp {
  interactionId: string;
  tool: string;
  at: Date;
}

/** Thrown by a repo write when a newer command of the same call was already applied. */
export class StaleCommandError extends Error {
  readonly code = "STALE_COMMAND" as const;
  constructor(
    public readonly command: CommandStamp,
    public readonly lastCommandAt: Date,
    public readonly lastCommandTool: string | null,
  ) {
    super(`${command.tool} at ${command.at.toISOString()} is older than ${lastCommandTool ?? "a command"} at ${lastCommandAt.toISOString()}`);
    this.name = "StaleCommandError";
  }
}

/** Caller asked to be called back (backend outage during the call, or preference). */
export interface CallbackRequest {
  name?: string | null;
  phone: string; // ⚑ E.164
  topic: string;
  preferredTime?: string | null;
  requestedAt: number; // unix seconds
}

export interface CreateBookingData {
  organizationId: string;
  eventTypeId: string;
  hostUserId: string;
  startsAt: Date;
  endsAt: Date;
  source: BookingSource;
  attendeeName: string;
  attendeePhone?: string | null;
  attendeeEmail?: string | null;
  attendeeTz: string;
  note?: string | null;
  answers?: Record<string, unknown> | null;
  interactionId?: string | null;
}

/**
 * Answer-based routing rule on a pool member: the member only takes bookings
 * whose answer to `field` (a bookingFields key) is one of `values`. Several
 * rules on one member are AND-ed; several values are OR-ed. Example —
 * "User B takes enterprises": `{ field: "employees", values: ["50-249", "250+"] }`.
 */
export interface RoutingMatch {
  field: string;
  values: string[];
}

/** Round-robin pool member with the state the ranking needs. */
export interface EventTypeHostRecord {
  hostUserId: string;
  priority: number;
  upcomingBookings: number;
  lastAssignedAt: Date | null;
  /** Segment rules (see RoutingMatch). `null`/empty → catch-all member. */
  match?: RoutingMatch[] | null;
}

/**
 * Repository the service talks to. The Prisma implementation lives in apps/web;
 * `MemoryRepo` in this package backs tests and the standalone mock server.
 *
 * `createBookingIfFree` is the one method with a hard requirement: it must
 * check for conflicts and insert atomically (transaction + host row lock in
 * Postgres) and return `null` when the slot is no longer free.
 */
export interface VoiceRepo {
  resolveNumber(toE164: string): Promise<{ org: OrgRecord; agent: AgentRecord } | null>;
  getEventTypes(organizationId: string): Promise<EventTypeRecord[]>;
  getHost(userId: string): Promise<HostRecord | null>;
  /** Busy blocks for the host in [from, to): own bookings (non-cancelled) + external calendar cache. */
  getBusy(hostUserId: string, from: Date, to: Date): Promise<BusyBlock[]>;
  /** Round-robin pool of an event type (empty when none configured → caller falls back to hostUserId). */
  getEventTypeHosts(eventTypeId: string): Promise<EventTypeHostRecord[]>;
  markHostAssigned(eventTypeId: string, hostUserId: string, at: Date): Promise<void>;

  createInteraction(
    data: Omit<InteractionRecord, "id" | "toolCalls" | "outcome"> & { outcome?: CallOutcome },
  ): Promise<InteractionRecord>;
  getInteraction(id: string): Promise<InteractionRecord | null>;
  getInteractionByProviderCallId(providerCallId: string): Promise<InteractionRecord | null>;
  /** With `command`: verify-and-record the ordering stamp in the same transaction (throws StaleCommandError). */
  updateInteraction(id: string, patch: Partial<InteractionRecord>, command?: CommandStamp): Promise<InteractionRecord>;
  appendToolCall(id: string, entry: ToolCallAudit): Promise<void>;

  /** `guard.command`: the ordering stamp, verified + recorded inside the same transaction (throws StaleCommandError). */
  createBookingIfFree(
    data: CreateBookingData,
    guard: { bufferBeforeMin: number; bufferAfterMin: number; command?: CommandStamp },
  ): Promise<BookingRecord | null>;
  getBooking(id: string): Promise<BookingRecord | null>;
  findUpcomingBookingsByPhone(organizationId: string, phoneE164: string, from: Date): Promise<BookingRecord[]>;
  updateBooking(id: string, patch: Partial<BookingRecord>, command?: CommandStamp): Promise<BookingRecord>;
  findBookingByInteractionAndStart(interactionId: string, startsAt: Date): Promise<BookingRecord | null>;
}
