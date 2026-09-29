/**
 * VoiceToolService — the business side of every tool the phone assistant can call.
 *
 * apps/voice never touches the database; it calls the internal HTTP API, whose
 * route handlers are thin wrappers around these methods. Every call is written
 * to the interaction's `toolCalls` audit trail.
 */

import { computeSlots, isBookableStart, pickSpread, type Slot } from "../availability/engine";
import { SlotTakenError } from "../booking/commit";
import { defaultReservations, type SlotReservations } from "../booking/reservations";
import { NoEligibleHostError, bookWithRouting, poolFor } from "../booking/routing";
import { addDays, addMinutes, formatForSpeech, zonedToUtc } from "../time";
import { type CommandStamp, StaleCommandError } from "./types";
import type {
  AgentRecord,
  BookingRecord,
  CallbackRequest,
  CallOutcome,
  EventTypeRecord,
  InteractionRecord,
  OrgRecord,
  VoiceRepo,
} from "./types";

export type VoiceErrorCode =
  | "UNKNOWN_NUMBER"
  | "AGENT_INACTIVE"
  | "SESSION_NOT_FOUND"
  | "EVENT_TYPE_NOT_FOUND"
  | "HOST_NOT_FOUND"
  | "SLOT_TAKEN"
  | "BOOKING_NOT_FOUND"
  | "NO_ELIGIBLE_HOST"
  | "STALE_COMMAND"
  | "INVALID_INPUT";

export class VoiceServiceError extends Error {
  constructor(
    public readonly code: VoiceErrorCode,
    message: string,
    public readonly status = 400,
  ) {
    super(message);
    this.name = "VoiceServiceError";
  }
}

// ── Public DTOs (what the internal API returns) ─────────────────────────────

export interface SessionDTO {
  interactionId: string;
  org: { id: string; name: string; slug: string; timezone: string; locale: "de" | "en" };
  agent: {
    id: string;
    name: string;
    languages: string[];
    greeting: string;
    persona: string | null;
    escalationPhone: string | null;
    storeTranscripts: boolean;
  };
  eventTypes: Array<{ slug: string; title: string; durationMin: number; description: string | null; bookingFields: unknown[] }>;
  caller: { phoneMasked: string; hasUpcomingBookings: boolean };
}

export interface SlotDTO {
  start: string; // ISO UTC
  end: string;
  spoken: string; // "Donnerstag, 1. Oktober, 10:00" in org locale/timezone
}

export interface BookingDTO {
  id: string;
  eventType: { slug: string; title: string };
  hostUserId: string;
  startsAt: string;
  endsAt: string;
  spoken: string;
  status: BookingRecord["status"];
  attendeeName: string;
}

export interface EndSessionInput {
  outcome: CallOutcome;
  durationSec: number;
  summary: string;
  language?: string;
  transcript?: unknown;
  callback?: CallbackRequest | null;
  /** Speech-event time (unix ms) of the hangup / checkpoint — see `enforceOrder`. */
  clientTimestamp?: number;
}

/** A client timestamp further in the future than this is garbage (clock skew is otherwise irrelevant: only timestamps of ONE call are compared). */
export const MAX_FUTURE_SKEW_MS = 5 * 60_000;

/**
 * Validates answers against the event type's bookingFields. Lives outside core
 * (needs zod — see @slotwise/contracts buildAnswersSchema). Must throw a
 * VoiceServiceError("INVALID_INPUT", …) whose message tells the model what to ask.
 */
export type AnswersValidator = (eventType: EventTypeRecord, answers: Record<string, unknown>) => Record<string, unknown>;

export interface VoiceServiceOptions {
  now?: () => Date;
  /** In-process slot reservations; defaults to the process-wide registry shared with the web booking path. */
  reservations?: SlotReservations;
  answersValidator?: AnswersValidator;
}

export class VoiceToolService {
  private readonly now: () => Date;
  private readonly reservations: SlotReservations;
  private readonly answersValidator: AnswersValidator | undefined;

  constructor(
    private readonly repo: VoiceRepo,
    opts: VoiceServiceOptions = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.reservations = opts.reservations ?? defaultReservations;
    this.answersValidator = opts.answersValidator;
  }

  // ── 1. session ─────────────────────────────────────────────────────────────

  async startSession(input: { callSid: string; from: string; to: string }): Promise<SessionDTO> {
    const resolved = await this.repo.resolveNumber(input.to);
    if (!resolved) throw new VoiceServiceError("UNKNOWN_NUMBER", `No agent configured for ${input.to}`, 404);
    const { org, agent } = resolved;
    if (!agent.isActive) throw new VoiceServiceError("AGENT_INACTIVE", "Agent is disabled", 409);

    // Idempotent: Twilio may retry the webhook.
    const existing = await this.repo.getInteractionByProviderCallId(input.callSid);
    const startedAt = this.now();
    const interaction =
      existing ??
      (await this.repo.createInteraction({
        organizationId: org.id,
        agentId: agent.id,
        direction: "INBOUND",
        providerCallId: input.callSid,
        fromNumber: input.from,
        toNumber: input.to,
        startedAt,
        expiresAt: addDays(startedAt, org.dataRetentionDays),
      }));

    const eventTypes = await this.bookableEventTypes(org, agent);
    const upcoming = await this.repo.findUpcomingBookingsByPhone(org.id, input.from, startedAt);

    return {
      interactionId: interaction.id,
      org: { id: org.id, name: org.name, slug: org.slug, timezone: org.timezone, locale: org.locale },
      agent: {
        id: agent.id,
        name: agent.name,
        languages: agent.languages,
        greeting: agent.greeting ?? defaultGreeting(org, agent),
        persona: agent.persona ?? null,
        escalationPhone: agent.escalationPhone ?? null,
        storeTranscripts: agent.storeTranscripts,
      },
      eventTypes: eventTypes.map((e) => ({
        slug: e.slug,
        title: e.title,
        durationMin: e.durationMin,
        description: e.description ?? null,
        bookingFields: Array.isArray(e.bookingFields) ? e.bookingFields : [],
      })),
      caller: { phoneMasked: maskPhone(input.from), hasUpcomingBookings: upcoming.length > 0 },
    };
  }

  // ── 2. check_availability ──────────────────────────────────────────────────

  async checkAvailability(input: {
    interactionId: string;
    eventTypeSlug: string;
    from?: string; // ISO or YYYY-MM-DD; defaults to now
    to?: string; // defaults to from + 7 days
    preferred?: "morning" | "afternoon" | null;
    max?: number;
  }): Promise<{ slots: SlotDTO[]; timezone: string }> {
    return this.audited(input.interactionId, "check_availability", input, async () => {
      const { org, eventType, host } = await this.context(input.interactionId, input.eventTypeSlug);
      const now = this.now();
      const from = input.from ? parseDateInput(input.from, org.timezone, now) : now;
      const to = input.to ? parseDateInput(input.to, org.timezone, now, true) : addDays(from, 7);
      if (to <= from) throw new VoiceServiceError("INVALID_INPUT", "`to` must be after `from`");

      // Union over every host in the pool (ROUND_ROBIN) — a slot is offered when at
      // least one team member is free. Busy = own bookings + external calendars +
      // slots another request is writing right now.
      const pool = await poolFor(this.repo, eventType);
      const merged = new Map<number, Slot>();
      for (const member of pool) {
        const h = member.hostUserId === host.id ? host : await this.repo.getHost(member.hostUserId);
        if (!h) continue;
        const busy = [
          ...(await this.repo.getBusy(h.id, addDays(from, -1), addDays(to, 1))),
          ...this.reservations.busyOverlay(h.id, addDays(from, -1), addDays(to, 1)),
        ];
        for (const s of computeSlots({ timezone: h.timezone, rules: h.rules, overrides: h.overrides, eventType, busy, from, to, now })) {
          merged.set(s.start.getTime(), s);
        }
      }
      const slots = [...merged.values()].sort((a, b) => a.start.getTime() - b.start.getTime());
      const picked = pickSpread(slots, Math.min(input.max ?? 6, 20), org.timezone, input.preferred ?? null);
      return { slots: picked.map((s) => this.slotDTO(s, org)), timezone: org.timezone };
    });
  }

  // ── 3. book_appointment ────────────────────────────────────────────────────

  async bookAppointment(input: {
    interactionId: string;
    eventTypeSlug: string;
    startsAt: string; // ISO UTC, must be one of the offered slot starts
    attendee: { name: string; phone?: string | null; email?: string | null; note?: string | null };
    /** Validated by the caller against the event type's bookingFields (contracts). Stored as-is. */
    answers?: Record<string, unknown> | null;
    /** Unix ms of the caller's utterance (voice worker). Ordering guard — see `enforceOrder`. */
    clientTimestamp?: number;
  }): Promise<BookingDTO & { alreadyExisted: boolean }> {
    return this.audited(input.interactionId, "book_appointment", input, async () => {
      const { org, interaction, eventType } = await this.context(input.interactionId, input.eventTypeSlug);
      const startsAt = new Date(input.startsAt);
      if (Number.isNaN(startsAt.getTime())) throw new VoiceServiceError("INVALID_INPUT", "startsAt is not a date");
      if (!input.attendee.name?.trim()) throw new VoiceServiceError("INVALID_INPUT", "attendee.name is required");

      // Idempotency: same call, same start → return the existing booking.
      const dup = await this.repo.findBookingByInteractionAndStart(interaction.id, startsAt);
      if (dup) return { ...this.bookingDTO(dup, eventType, org), alreadyExisted: true };

      // Custom questions (bookingFields) — validated before routing/locking.
      const answers = this.answersValidator ? this.answersValidator(eventType, input.answers ?? {}) : (input.answers ?? null);

      // Ordering guard: verified inside the booking transaction (see `stamp`).
      const command = this.stamp(interaction, "book_appointment", input.clientTimestamp);

      // Route to a free team member (SINGLE → the default host) and commit under
      // reservation + lock. Per-host rule/busy validation happens inside.
      let booking: BookingRecord;
      try {
        const routed = await bookWithRouting(
          { repo: this.repo, reservations: this.reservations },
          {
            eventType,
            startsAt,
            now: this.now(),
            command,
            data: {
              organizationId: org.id,
              eventTypeId: eventType.id,
              source: "AI_PHONE",
              attendeeName: input.attendee.name.trim().slice(0, 120),
              attendeePhone: input.attendee.phone ?? interaction.fromNumber,
              attendeeEmail: input.attendee.email ?? null,
              attendeeTz: org.timezone,
              note: input.attendee.note?.trim().slice(0, 500) ?? null,
              answers: answers && Object.keys(answers).length ? answers : null,
              interactionId: interaction.id,
            },
          },
        );
        booking = routed.booking;
      } catch (e) {
        if (e instanceof SlotTakenError) throw new VoiceServiceError("SLOT_TAKEN", `That time is not available any more (${e.reason})`, 409);
        if (e instanceof StaleCommandError) throw stale(e);
        if (e instanceof NoEligibleHostError) {
          // strictly segmented pool, nobody configured for these answers — a config gap, not the caller's fault
          throw new VoiceServiceError("NO_ELIGIBLE_HOST", `No team member handles these answers (${e.unmatchedFields.join(", ")}); offer the escalation number`, 422);
        }
        throw e;
      }
      await this.repo.updateInteraction(interaction.id, { outcome: "BOOKED" });
      return { ...this.bookingDTO(booking, eventType, org), alreadyExisted: false };
    });
  }

  // ── 4. find_bookings ───────────────────────────────────────────────────────

  async findBookings(input: { interactionId: string; phone?: string }): Promise<{ bookings: BookingDTO[] }> {
    return this.audited(input.interactionId, "find_bookings", input, async () => {
      const { org, interaction } = await this.context(input.interactionId);
      const phone = input.phone ?? interaction.fromNumber;
      const bookings = await this.repo.findUpcomingBookingsByPhone(org.id, phone, this.now());
      const eventTypes = await this.repo.getEventTypes(org.id);
      return {
        bookings: bookings.map((b) => {
          const et = eventTypes.find((e) => e.id === b.eventTypeId);
          return this.bookingDTO(b, et, org);
        }),
      };
    });
  }

  // ── 5. reschedule / cancel ─────────────────────────────────────────────────

  async rescheduleBooking(input: { interactionId: string; bookingId: string; startsAt: string; clientTimestamp?: number }): Promise<BookingDTO> {
    return this.audited(input.interactionId, "reschedule_appointment", input, async () => {
      const { org, interaction } = await this.context(input.interactionId);
      // Ordering guard first: a late reschedule after a newer cancel is reported as STALE_COMMAND,
      // not as "booking not found" — the model must not go looking for another booking.
      const command = this.stamp(interaction, "reschedule_appointment", input.clientTimestamp);
      const booking = await this.ownBooking(org, interaction, input.bookingId);
      const eventTypes = await this.repo.getEventTypes(org.id);
      const eventType = eventTypes.find((e) => e.id === booking.eventTypeId);
      if (!eventType) throw new VoiceServiceError("EVENT_TYPE_NOT_FOUND", "Event type missing", 500);
      const host = await this.repo.getHost(booking.hostUserId);
      if (!host) throw new VoiceServiceError("HOST_NOT_FOUND", "Host missing", 500);

      const startsAt = new Date(input.startsAt);
      const endsAt = addMinutes(startsAt, eventType.durationMin);
      const busy = (await this.repo.getBusy(host.id, addDays(startsAt, -1), addDays(endsAt, 1))).filter(
        // The booking's own block must not count against itself.
        (b) => !(b.start.getTime() === booking.startsAt.getTime() && b.end.getTime() === booking.endsAt.getTime()),
      );
      const ok = isBookableStart(
        { timezone: host.timezone, rules: host.rules, overrides: host.overrides, eventType, busy, now: this.now() },
        startsAt,
      );
      if (!ok) throw new VoiceServiceError("SLOT_TAKEN", "That time is not available", 409);

      const updated = await this.guarded(() => this.repo.updateBooking(booking.id, { startsAt, endsAt, status: "RESCHEDULED" }, command));
      await this.repo.updateInteraction(interaction.id, { outcome: "RESCHEDULED" });
      return this.bookingDTO(updated, eventType, org);
    });
  }

  async cancelBooking(input: { interactionId: string; bookingId: string; reason?: string; clientTimestamp?: number }): Promise<BookingDTO> {
    return this.audited(input.interactionId, "cancel_appointment", input, async () => {
      const { org, interaction } = await this.context(input.interactionId);
      const command = this.stamp(interaction, "cancel_appointment", input.clientTimestamp);
      // Idempotent: a retried cancel (response lost in a 504) must not turn into "not found".
      const booking = await this.ownBooking(org, interaction, input.bookingId, { allowCancelled: true });
      const et = (await this.repo.getEventTypes(org.id)).find((e) => e.id === booking.eventTypeId);
      if (booking.status === "CANCELLED") return this.bookingDTO(booking, et, org);
      const updated = await this.guarded(() =>
        this.repo.updateBooking(
          booking.id,
          { status: "CANCELLED", cancelReason: input.reason?.slice(0, 200) ?? "cancelled by caller via phone assistant" },
          command,
        ),
      );
      await this.repo.updateInteraction(interaction.id, { outcome: "CANCELLED" });
      return this.bookingDTO(updated, et, org);
    });
  }

  // ── 6. end_call ────────────────────────────────────────────────────────────

  async endSession(interactionId: string, input: EndSessionInput): Promise<{ ok: true; outcome: CallOutcome; ignored?: boolean }> {
    const interaction = await this.repo.getInteraction(interactionId);
    if (!interaction) throw new VoiceServiceError("SESSION_NOT_FOUND", "Unknown interaction", 404);
    const resolved = await this.repo.resolveNumber(interaction.toNumber);
    const storeTranscripts = resolved?.agent.storeTranscripts ?? false;

    // Ordering guard for the outbox: a call_started checkpoint (MISSED, stamped at call start) or a
    // callback checkpoint delivered by the sweeper AFTER a later command must not overwrite the
    // outcome. The call still counts as ended; the row is confirmed (ok) so the outbox deletes it.
    let command: CommandStamp | undefined;
    try {
      command = this.stamp(interaction, "end_call", input.clientTimestamp);
    } catch (e) {
      if (!(e instanceof VoiceServiceError) || e.code !== "STALE_COMMAND") throw e;
      return this.closeStale(interaction, input);
    }

    // A booking already recorded wins over whatever the model reports — except a
    // callback request, which the owner must act on within minutes.
    const outcome: CallOutcome =
      input.callback ? "CALLBACK_REQUESTED"
      : interaction.outcome !== "IN_PROGRESS" && input.outcome === "INFO" ? interaction.outcome
      : input.outcome;

    try {
      await this.repo.updateInteraction(
        interactionId,
        {
          outcome,
          endedAt: this.now(),
          durationSec: Math.max(0, Math.round(input.durationSec)),
          summary: input.summary.slice(0, 1000),
          language: input.language ?? null,
          transcript: storeTranscripts ? (input.transcript ?? null) : null, // data minimisation
          callbackRequest: input.callback
            ? { ...input.callback, phone: normalizePhone(input.callback.phone), topic: input.callback.topic.slice(0, 300) }
            : null,
        },
        command,
      );
    } catch (e) {
      if (!(e instanceof StaleCommandError)) throw e;
      return this.closeStale(interaction, input); // lost the race against a newer command — same answer
    }
    return { ok: true, outcome };
  }

  /** A stale end result: never touch outcome/summary, but make sure the call is closed. Confirmed so the outbox deletes it. */
  private async closeStale(interaction: InteractionRecord, input: EndSessionInput): Promise<{ ok: true; outcome: CallOutcome; ignored: true }> {
    const fresh = (await this.repo.getInteraction(interaction.id)) ?? interaction;
    if (!fresh.endedAt) {
      await this.repo.updateInteraction(interaction.id, { endedAt: this.now(), durationSec: fresh.durationSec ?? Math.max(0, Math.round(input.durationSec)) });
    }
    return { ok: true, outcome: fresh.outcome, ignored: true };
  }

  /** Maps a StaleCommandError thrown by a repo write to the 409 the voice worker understands. */
  private async guarded<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof StaleCommandError) throw stale(e);
      throw e;
    }
  }

  // ── helpers ────────────────────────────────────────────────────────────────

  /**
   * Ordering guard for state-changing commands of one call (ARCHITECTURE.md §6).
   * The voice worker stamps every request with the unix-ms time of the speech
   * event behind it, strictly increasing within the call; retries carry the
   * SAME stamp. The stamp travels into the repo write (`CommandStamp`), which
   * verifies it under a row lock on the call inside the SAME transaction as the
   * booking change: a command older than the newest applied one is refused with
   * 409 STALE_COMMAND — whatever order the requests arrive in, on however many
   * instances. Equal stamps pass (the existing idempotency answers a retry).
   * Without a stamp (legacy client, demo script) nothing is enforced.
   */
  private stamp(interaction: InteractionRecord, tool: string, clientTimestamp: number | undefined): CommandStamp | undefined {
    if (clientTimestamp === undefined) return undefined;
    const at = new Date(clientTimestamp);
    if (Number.isNaN(at.getTime())) throw new VoiceServiceError("INVALID_INPUT", "clientTimestamp is not a unix-ms time");
    if (at.getTime() > this.now().getTime() + MAX_FUTURE_SKEW_MS) throw new VoiceServiceError("INVALID_INPUT", "clientTimestamp lies in the future");
    const command = { interactionId: interaction.id, tool, at };
    // Fast fail on what we already know (no write, not authoritative — the write re-checks under the lock):
    // saves the availability work and answers STALE_COMMAND instead of e.g. "booking not found".
    if (interaction.lastCommandAt && interaction.lastCommandAt.getTime() > at.getTime()) {
      throw stale(new StaleCommandError(command, interaction.lastCommandAt, interaction.lastCommandTool ?? null));
    }
    return command;
  }

  private async context(interactionId: string, eventTypeSlug?: string) {
    const interaction = await this.repo.getInteraction(interactionId);
    if (!interaction) throw new VoiceServiceError("SESSION_NOT_FOUND", "Unknown interaction", 404);
    const resolved = await this.repo.resolveNumber(interaction.toNumber);
    if (!resolved) throw new VoiceServiceError("UNKNOWN_NUMBER", "Number no longer configured", 404);
    const { org, agent } = resolved;

    if (!eventTypeSlug) return { org, agent, interaction, eventType: undefined as never, host: undefined as never };

    const eventType = (await this.bookableEventTypes(org, agent)).find((e) => e.slug === eventTypeSlug);
    if (!eventType) throw new VoiceServiceError("EVENT_TYPE_NOT_FOUND", `Unknown event type "${eventTypeSlug}"`, 404);
    const host = await this.repo.getHost(eventType.hostUserId);
    if (!host) throw new VoiceServiceError("HOST_NOT_FOUND", "Host has no availability configured", 500);
    return { org, agent, interaction, eventType, host };
  }

  private async bookableEventTypes(org: OrgRecord, agent: AgentRecord): Promise<EventTypeRecord[]> {
    const all = await this.repo.getEventTypes(org.id);
    const allowed = new Set(agent.bookableEventTypeIds);
    return all.filter((e) => e.isActive && e.bookableByAi && (allowed.size === 0 || allowed.has(e.id)));
  }

  /** Only bookings of this org that belong to the caller's phone number. */
  private async ownBooking(
    org: OrgRecord,
    interaction: InteractionRecord,
    bookingId: string,
    opts: { allowCancelled?: boolean } = {},
  ): Promise<BookingRecord> {
    const booking = await this.repo.getBooking(bookingId);
    if (
      !booking ||
      booking.organizationId !== org.id ||
      (booking.status === "CANCELLED" && !opts.allowCancelled) ||
      normalizePhone(booking.attendeePhone ?? "") !== normalizePhone(interaction.fromNumber)
    ) {
      throw new VoiceServiceError("BOOKING_NOT_FOUND", "No such booking for this caller", 404);
    }
    return booking;
  }

  private async audited<T>(
    interactionId: string,
    tool: string,
    args: Record<string, unknown>,
    fn: () => Promise<T>,
  ): Promise<T> {
    const t0 = Date.now();
    try {
      const result = await fn();
      await this.repo.appendToolCall(interactionId, {
        at: new Date().toISOString(),
        ...clientAt(args),
        tool,
        args: redact(args),
        ok: true,
        ms: Date.now() - t0,
      });
      return result;
    } catch (err) {
      const code = err instanceof VoiceServiceError ? err.code : "INTERNAL";
      // Best effort — an unknown interaction cannot be audited.
      if (code !== "SESSION_NOT_FOUND") {
        await this.repo
          .appendToolCall(interactionId, {
            at: new Date().toISOString(),
            ...clientAt(args),
            tool,
            args: redact(args),
            ok: false,
            code,
            ms: Date.now() - t0,
          })
          .catch(() => undefined);
      }
      throw err;
    }
  }

  private slotDTO(s: Slot, org: OrgRecord): SlotDTO {
    return {
      start: s.start.toISOString(),
      end: s.end.toISOString(),
      spoken: formatForSpeech(s.start, org.timezone, org.locale),
    };
  }

  private bookingDTO(b: BookingRecord, et: EventTypeRecord | undefined, org: OrgRecord): BookingDTO {
    return {
      id: b.id,
      eventType: { slug: et?.slug ?? "unknown", title: et?.title ?? "Termin" },
      hostUserId: b.hostUserId,
      startsAt: b.startsAt.toISOString(),
      endsAt: b.endsAt.toISOString(),
      spoken: formatForSpeech(b.startsAt, org.timezone, org.locale),
      status: b.status,
      attendeeName: b.attendeeName,
    };
  }
}

// ── small utilities ────────────────────────────────────────────────────────

function defaultGreeting(org: OrgRecord, agent: AgentRecord): string {
  return org.locale === "de"
    ? `Hallo, hier ist ${agent.name}, der digitale Assistent von ${org.name}. Ich kann Termine buchen, verschieben oder absagen. Wie kann ich helfen?`
    : `Hello, this is ${agent.name}, the digital assistant of ${org.name}. I can book, move or cancel appointments. How can I help?`;
}

/** "+493044671281" → "+49 30 4467 ••81" — the format used in the dashboard feed. */
export function maskPhone(e164: string): string {
  const digits = e164.replace(/\D/g, "");
  if (digits.length < 8) return "••••";
  const cc = digits.slice(0, 2);
  const area = digits.slice(2, 4);
  const mid = digits.slice(4, 8);
  const last = digits.slice(-2);
  return `+${cc} ${area} ${mid} ••${last}`;
}

export function normalizePhone(raw: string): string {
  const digits = raw.replace(/[^\d+]/g, "");
  if (digits.startsWith("+")) return digits;
  if (digits.startsWith("00")) return `+${digits.slice(2)}`;
  if (digits.startsWith("0")) return `+49${digits.slice(1)}`; // MVP: German default
  return `+${digits}`;
}

/**
 * Accepts ISO instants or `YYYY-MM-DD` (interpreted in `timezone`,
 * start-of-day; end-of-day when `inclusiveEnd`).
 */
function parseDateInput(value: string, timezone: string, now: Date, inclusiveEnd = false): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return inclusiveEnd ? zonedToUtc(value, "23:59", timezone) : zonedToUtc(value, "00:00", timezone);
  }
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new VoiceServiceError("INVALID_INPUT", `Bad date: ${value}`);
  return d < now && !inclusiveEnd ? now : d;
}

function stale(e: StaleCommandError): VoiceServiceError {
  return new VoiceServiceError(
    "STALE_COMMAND",
    `Ignored: a newer command of this call (${e.lastCommandTool ?? "unknown"} at ${e.lastCommandAt.toISOString()}) was already applied after this ${e.command.tool} (${e.command.at.toISOString()})`,
    409,
  );
}

/** The voice worker's speech-event stamp, as ISO, for the audit trail (only when sent). */
function clientAt(args: Record<string, unknown>): { clientAt?: string } {
  const ts = args.clientTimestamp;
  if (typeof ts !== "number" || !Number.isFinite(ts)) return {};
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? {} : { clientAt: d.toISOString() };
}

function redact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "attendee" && v && typeof v === "object") {
      const a = v as Record<string, unknown>;
      out[k] = { name: a.name, phone: typeof a.phone === "string" ? maskPhone(a.phone) : a.phone, hasNote: !!a.note };
    } else if (k === "phone" && typeof v === "string") {
      out[k] = maskPhone(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}
