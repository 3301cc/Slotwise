/**
 * Slot reservations — the millisecond-scale "this slot is being written" marker.
 *
 * `tryReserve` is SYNCHRONOUS on purpose: JavaScript runs one task at a time,
 * so two requests that arrive "at the same millisecond" are still serialised by
 * the event loop, and whichever reaches `tryReserve` first wins. The loser is
 * rejected immediately — it never waits on a database lock, and it never even
 * gets the slot offered again while the winner's transaction is in flight
 * (`busyOverlay` is merged into the availability engine's busy list).
 *
 * Scope: one process. It is the fast path, not the guarantee. The guarantee
 * across processes/instances is the repository's atomic insert (Postgres:
 * advisory transaction lock + GiST exclusion constraint). Reservations expire
 * after `ttlMs` so a crashed request can never poison a slot.
 */

import type { BusyBlock } from "../availability/engine";

export interface SlotReservation {
  token: string;
  hostUserId: string;
  start: Date; // guard start (buffers included)
  end: Date; // guard end
  expiresAt: number;
}

export class SlotReservations {
  private readonly byHost = new Map<string, SlotReservation[]>();
  private seq = 0;

  constructor(
    private readonly ttlMs = 5_000,
    private readonly now: () => number = () => Date.now(),
  ) {}

  /**
   * Reserve [start, end) for `hostUserId`. Returns null when an active
   * reservation overlaps — i.e. a parallel request is already writing there.
   */
  tryReserve(hostUserId: string, start: Date, end: Date): SlotReservation | null {
    const active = this.active(hostUserId);
    if (active.some((r) => start < r.end && r.start < end)) return null;
    const reservation: SlotReservation = {
      token: `${hostUserId}:${++this.seq}`,
      hostUserId,
      start,
      end,
      expiresAt: this.now() + this.ttlMs,
    };
    active.push(reservation);
    this.byHost.set(hostUserId, active);
    return reservation;
  }

  release(token: string): void {
    const [hostUserId] = token.split(":", 1);
    if (!hostUserId) return;
    const list = (this.byHost.get(hostUserId) ?? []).filter((r) => r.token !== token);
    if (list.length) this.byHost.set(hostUserId, list);
    else this.byHost.delete(hostUserId);
  }

  /** Active reservations as busy blocks — merged into availability so in-flight slots are not offered. */
  busyOverlay(hostUserId: string, from: Date, to: Date): BusyBlock[] {
    return this.active(hostUserId)
      .filter((r) => r.start < to && r.end > from)
      .map((r) => ({ start: r.start, end: r.end }));
  }

  size(hostUserId?: string): number {
    if (hostUserId) return this.active(hostUserId).length;
    let n = 0;
    for (const host of this.byHost.keys()) n += this.active(host).length;
    return n;
  }

  private active(hostUserId: string): SlotReservation[] {
    const now = this.now();
    const list = (this.byHost.get(hostUserId) ?? []).filter((r) => r.expiresAt > now);
    if (list.length) this.byHost.set(hostUserId, list);
    else this.byHost.delete(hostUserId);
    return list;
  }
}

/** Process-wide registry shared by the voice service and the web booking path. */
export const defaultReservations = new SlotReservations();
