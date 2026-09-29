/**
 * Internal voice API contract — validated at the HTTP boundary in apps/web,
 * mirrored as JSON Schema for apps/voice (see scripts/export-jsonschema.ts).
 *
 * Keep this file in sync with ARCHITECTURE.md §6.
 */

import { z } from "zod";
import { bookingFields } from "./booking-fields";

// ── primitives ──────────────────────────────────────────────────────────────

export const e164 = z
  .string()
  .trim()
  .regex(/^\+?[0-9 ()-]{6,20}$/, "phone must look like +49 30 1234567");

export const isoInstant = z
  .string()
  .refine((v) => !Number.isNaN(Date.parse(v)), "must be an ISO-8601 instant");

/** ISO instant or YYYY-MM-DD (interpreted in the org timezone). */
export const dateOrInstant = z
  .string()
  .refine((v) => /^\d{4}-\d{2}-\d{2}$/.test(v) || !Number.isNaN(Date.parse(v)), "ISO instant or YYYY-MM-DD");

/**
 * Unix time in MILLISECONDS of the speech event behind a command (the caller's
 * utterance / the hangup), stamped by the voice worker and strictly increasing
 * within one call. apps/web applies a command only if no newer one was already
 * applied for the same session — a late retry of "reschedule" can never undo a
 * later "cancel" (ARCHITECTURE.md §6, "ordering"). Optional for legacy clients;
 * the voice worker always sends it. Coerced: arrives as a string in GET queries.
 */
export const clientTimestamp = z.coerce.number().int().min(1_000_000_000_000, "unix ms").max(9_999_999_999_999, "unix ms");

export const callOutcome = z.enum([
  "IN_PROGRESS",
  "BOOKED",
  "RESCHEDULED",
  "CANCELLED",
  "CONFIRMED",
  "TRANSFERRED",
  "MISSED",
  "INFO",
  "FAILED",
  "CALLBACK_REQUESTED",
]);
export type CallOutcome = z.infer<typeof callOutcome>;

export const bookingStatus = z.enum(["CONFIRMED", "RESCHEDULED", "CANCELLED", "NEEDS_ATTENTION"]);

// ── POST /api/internal/voice/session ────────────────────────────────────────

export const sessionRequest = z.object({
  callSid: z.string().min(8).max(64),
  from: e164,
  to: e164,
});
export type SessionRequest = z.infer<typeof sessionRequest>;

export const sessionResponse = z.object({
  interactionId: z.string(),
  org: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    timezone: z.string(),
    locale: z.enum(["de", "en"]),
  }),
  agent: z.object({
    id: z.string(),
    name: z.string(),
    languages: z.array(z.string()),
    greeting: z.string(),
    persona: z.string().nullable(),
    escalationPhone: z.string().nullable(),
    storeTranscripts: z.boolean(),
  }),
  eventTypes: z.array(
    z.object({
      slug: z.string(),
      title: z.string(),
      durationMin: z.number().int().positive(),
      description: z.string().nullable(),
      /** Custom questions the assistant must ask (required ones) before booking. */
      bookingFields: bookingFields.default([]),
    }),
  ),
  caller: z.object({ phoneMasked: z.string(), hasUpcomingBookings: z.boolean() }),
});
export type SessionResponse = z.infer<typeof sessionResponse>;

// ── POST /api/internal/voice/availability  (tool: check_availability) ───────

export const availabilityRequest = z.object({
  interactionId: z.string(),
  eventTypeSlug: z.string().min(1).max(64),
  from: dateOrInstant.optional(),
  to: dateOrInstant.optional(),
  preferred: z.enum(["morning", "afternoon"]).nullable().optional(),
  max: z.number().int().min(1).max(20).optional(),
  clientTimestamp: clientTimestamp.optional(), // read-only tool: logged, never enforced
});
export type AvailabilityRequest = z.infer<typeof availabilityRequest>;

export const slot = z.object({ start: isoInstant, end: isoInstant, spoken: z.string() });
export const availabilityResponse = z.object({ slots: z.array(slot), timezone: z.string() });
export type AvailabilityResponse = z.infer<typeof availabilityResponse>;

// ── POST /api/internal/voice/bookings  (tool: book_appointment) ─────────────

export const bookRequest = z.object({
  interactionId: z.string(),
  eventTypeSlug: z.string().min(1).max(64),
  startsAt: isoInstant,
  attendee: z.object({
    name: z.string().trim().min(1).max(120),
    phone: e164.nullable().optional(),
    email: z.string().email().max(200).nullable().optional(),
    note: z.string().max(500).nullable().optional(),
  }),
  /** Answers to the event type's bookingFields, keyed by field key. Validated server-side. */
  answers: z.record(z.string(), z.unknown()).optional(),
  clientTimestamp: clientTimestamp.optional(),
});
export type BookRequest = z.infer<typeof bookRequest>;

export const bookingDTO = z.object({
  id: z.string(),
  eventType: z.object({ slug: z.string(), title: z.string() }),
  startsAt: isoInstant,
  endsAt: isoInstant,
  spoken: z.string(),
  status: bookingStatus,
  attendeeName: z.string(),
});
export const bookResponse = bookingDTO.extend({ alreadyExisted: z.boolean() });
export type BookResponse = z.infer<typeof bookResponse>;

// ── GET /api/internal/voice/bookings?interactionId=&phone=  (tool: find_bookings)

export const findBookingsRequest = z.object({
  interactionId: z.string(),
  phone: e164.optional(),
  clientTimestamp: clientTimestamp.optional(),
});
export const findBookingsResponse = z.object({ bookings: z.array(bookingDTO) });

// ── PATCH /api/internal/voice/bookings/:id  (tools: reschedule_/cancel_appointment)

export const patchBookingRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("reschedule"), interactionId: z.string(), startsAt: isoInstant, clientTimestamp: clientTimestamp.optional() }),
  z.object({ action: z.literal("cancel"), interactionId: z.string(), reason: z.string().max(200).optional(), clientTimestamp: clientTimestamp.optional() }),
]);
export type PatchBookingRequest = z.infer<typeof patchBookingRequest>;

// ── POST /api/internal/voice/session/:id/end  (tool: end_call) ──────────────

export const endSessionRequest = z.object({
  outcome: callOutcome,
  durationSec: z.number().int().min(0),
  summary: z.string().max(1000),
  language: z.string().max(8).optional(),
  transcript: z.array(z.object({ role: z.enum(["assistant", "user"]), text: z.string() })).optional(),
  /** Set by the voice worker when the backend was down mid-call and the caller asked to be called back. */
  callback: z
    .object({
      name: z.string().max(120).nullable().optional(),
      phone: e164,
      topic: z.string().max(300),
      preferredTime: z.string().max(120).nullable().optional(),
      requestedAt: z.number(),
    })
    .optional(),
  /** Hangup time (final result) or checkpoint time (call_started / callback checkpoint). */
  clientTimestamp: clientTimestamp.optional(),
});
export type EndSessionRequest = z.infer<typeof endSessionRequest>;

/** `ignored: true` = a newer command of this call was already applied; the row is still confirmed (ok) so the outbox deletes it. */
export const endSessionResponse = z.object({ ok: z.literal(true), outcome: callOutcome, ignored: z.boolean().optional() });

// ── error envelope ──────────────────────────────────────────────────────────

export const errorResponse = z.object({
  error: z.object({ code: z.string(), message: z.string() }),
});
export type ErrorResponse = z.infer<typeof errorResponse>;

/** Everything the Python side needs, keyed by tool name. */
export const voiceContract = {
  session: { request: sessionRequest, response: sessionResponse },
  check_availability: { request: availabilityRequest, response: availabilityResponse },
  book_appointment: { request: bookRequest, response: bookResponse },
  find_bookings: { request: findBookingsRequest, response: findBookingsResponse },
  patch_booking: { request: patchBookingRequest, response: bookingDTO },
  end_call: { request: endSessionRequest, response: endSessionResponse },
} as const;
