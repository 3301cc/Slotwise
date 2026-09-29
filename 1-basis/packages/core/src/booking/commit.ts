/**
 * The single write path for a booking — phone assistant and web page both go
 * through here, so they can never disagree about who got a slot.
 *
 *   1. reserve the guard window in-process (synchronous; a parallel request in
 *      the same millisecond is rejected right here)
 *   2. repo.createBookingIfFree — atomic conflict check + insert
 *      (MemoryRepo: keyed mutex · Prisma: advisory xact lock + exclusion constraint)
 *   3. release the reservation — the row is committed and visible now
 *
 * The availability check that offered the slot happens BEFORE this (read-only,
 * `isBookableStart`); this function is only about writing safely.
 *
 * Nothing here talks to Google/Microsoft. Follow-ups (calendar push,
 * confirmation) are recorded by the repository as outbox rows INSIDE the same
 * transaction (apps/web: CalendarSyncJob) and executed by the job worker with
 * retries — a provider outage can delay a calendar entry, never a booking.
 */

import { addMinutes } from "../time";
import type { BookingRecord, CommandStamp, CreateBookingData, VoiceRepo } from "../voice/types";
import { defaultReservations, type SlotReservations } from "./reservations";

export type SlotTakenReason = "reserved" | "conflict" | "lock_timeout";

export class SlotTakenError extends Error {
  readonly code = "SLOT_TAKEN" as const;
  constructor(
    public readonly reason: SlotTakenReason,
    message = "That time is not available any more",
  ) {
    super(message);
    this.name = "SlotTakenError";
  }
}

export interface BookingGuard {
  bufferBeforeMin: number;
  bufferAfterMin: number;
  /** Per-call ordering stamp (voice channel) — verified inside the write transaction; a stale command throws StaleCommandError. */
  command?: CommandStamp;
}

export interface CommitDeps {
  repo: Pick<VoiceRepo, "createBookingIfFree">;
  reservations?: SlotReservations;
}

export async function commitBooking(deps: CommitDeps, data: CreateBookingData, guard: BookingGuard): Promise<BookingRecord> {
  const reservations = deps.reservations ?? defaultReservations;
  const guardStart = addMinutes(data.startsAt, -guard.bufferBeforeMin);
  const guardEnd = addMinutes(data.endsAt, guard.bufferAfterMin);

  // 1. millisecond-scale marker — synchronous, so "same instant" requests are ordered here
  const reservation = reservations.tryReserve(data.hostUserId, guardStart, guardEnd);
  if (!reservation) throw new SlotTakenError("reserved", "A parallel request is booking this time right now");

  try {
    // 2. authoritative, atomic write
    const booking = await deps.repo.createBookingIfFree(data, guard);
    if (!booking) throw new SlotTakenError("conflict");
    return booking;
  } finally {
    // 3. the row (or the failure) is final — drop the marker
    reservations.release(reservation.token);
  }
}
