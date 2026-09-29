/**
 * Availability engine — pure function, no I/O.
 *
 * Inputs: weekly rules + date overrides (host's wall clock), an event type's
 * timing config, and every busy block we know about (own bookings + external
 * calendar cache). Output: bookable slots as UTC instants.
 *
 * Booking creation MUST re-run `isSlotFree` inside a DB transaction with a
 * row lock on the host — this module only computes, it never reserves.
 */

import {
  addDays,
  addMinutes,
  compareLocalDate,
  type LocalDate,
  type LocalTime,
  nextLocalDate,
  toWallClock,
  zonedToUtc,
} from "../time";

export interface AvailabilityRule {
  weekday: number; // 0 = Sunday … 6
  startTime: LocalTime; // "09:00"
  endTime: LocalTime; // "17:00"
}

export interface DateOverride {
  date: LocalDate;
  startTime?: LocalTime | null; // both null/undefined → unavailable all day
  endTime?: LocalTime | null;
}

export interface EventTypeTiming {
  durationMin: number;
  bufferBeforeMin?: number;
  bufferAfterMin?: number;
  slotIntervalMin?: number; // defaults to durationMin
  minNoticeMin?: number; // earliest bookable = now + minNotice
  maxDaysAhead?: number; // latest bookable = now + maxDaysAhead
}

export interface BusyBlock {
  start: Date;
  end: Date;
}

export interface Slot {
  start: Date;
  end: Date;
}

export interface AvailabilityInput {
  timezone: string; // host's IANA zone; rules/overrides are in this zone
  rules: AvailabilityRule[];
  overrides?: DateOverride[];
  eventType: EventTypeTiming;
  busy: BusyBlock[];
  from: Date;
  to: Date;
  now?: Date;
}

interface Window {
  start: Date;
  end: Date;
}

/** Half-open interval overlap: [aStart, aEnd) ∩ [bStart, bEnd) ≠ ∅ */
export function overlaps(aStart: Date, aEnd: Date, bStart: Date, bEnd: Date): boolean {
  return aStart < bEnd && bStart < aEnd;
}

/** Windows (UTC) in which the host is available on `date`, per overrides then weekly rules. */
export function windowsForDate(
  date: LocalDate,
  weekday: number,
  rules: AvailabilityRule[],
  overrides: DateOverride[],
  timezone: string,
): Window[] {
  const override = overrides.find((o) => o.date === date);
  if (override) {
    if (!override.startTime || !override.endTime) return [];
    return [
      {
        start: zonedToUtc(date, override.startTime, timezone),
        end: zonedToUtc(date, override.endTime, timezone),
      },
    ];
  }
  return rules
    .filter((r) => r.weekday === weekday)
    .map((r) => ({
      start: zonedToUtc(date, r.startTime, timezone),
      end: zonedToUtc(date, r.endTime, timezone),
    }))
    .filter((w) => w.end > w.start);
}

/** True when the slot (plus buffers) collides with no busy block. */
export function isSlotFree(
  start: Date,
  end: Date,
  busy: BusyBlock[],
  bufferBeforeMin = 0,
  bufferAfterMin = 0,
): boolean {
  const guardStart = addMinutes(start, -bufferBeforeMin);
  const guardEnd = addMinutes(end, bufferAfterMin);
  return !busy.some((b) => overlaps(guardStart, guardEnd, b.start, b.end));
}

export function computeSlots(input: AvailabilityInput): Slot[] {
  const {
    timezone,
    rules,
    overrides = [],
    eventType,
    busy,
    from,
    to,
    now = new Date(),
  } = input;

  const duration = eventType.durationMin;
  if (!Number.isFinite(duration) || duration <= 0) throw new Error("durationMin must be > 0");
  const interval = eventType.slotIntervalMin && eventType.slotIntervalMin > 0 ? eventType.slotIntervalMin : duration;
  const bufferBefore = eventType.bufferBeforeMin ?? 0;
  const bufferAfter = eventType.bufferAfterMin ?? 0;

  const earliest = new Date(Math.max(from.getTime(), addMinutes(now, eventType.minNoticeMin ?? 0).getTime()));
  const latest =
    eventType.maxDaysAhead != null
      ? new Date(Math.min(to.getTime(), addDays(now, eventType.maxDaysAhead).getTime()))
      : to;
  if (latest <= earliest) return [];

  // Sort busy once; the list is small (days × events), a linear scan per slot is fine for MVP.
  const sortedBusy = [...busy].sort((a, b) => a.start.getTime() - b.start.getTime());

  const slots: Slot[] = [];
  // Walk local dates from (from − 1 day) to (to + 1 day) to cover zone offsets at the edges.
  let date = toWallClock(addDays(earliest, -1), timezone).date;
  const lastDate = toWallClock(addDays(latest, 1), timezone).date;

  while (compareLocalDate(date, lastDate) <= 0) {
    const weekday = toWallClock(zonedToUtc(date, "12:00", timezone), timezone).weekday;
    for (const w of windowsForDate(date, weekday, rules, overrides, timezone)) {
      // Align first candidate to the window start, then step by interval.
      for (let start = w.start; addMinutes(start, duration) <= w.end; start = addMinutes(start, interval)) {
        const end = addMinutes(start, duration);
        if (start < earliest) continue;
        if (end > latest) break;
        if (!isSlotFree(start, end, sortedBusy, bufferBefore, bufferAfter)) continue;
        slots.push({ start, end });
      }
    }
    date = nextLocalDate(date);
  }

  slots.sort((a, b) => a.start.getTime() - b.start.getTime());
  return dedupe(slots);
}

/**
 * True when `start` is exactly one of the slots the rules would offer right now
 * (window, interval alignment, notice, buffers, busy blocks). Used as the final
 * gate before a booking is written — by phone and by web alike.
 */
export function isBookableStart(input: Omit<AvailabilityInput, "from" | "to">, start: Date): boolean {
  const end = addMinutes(start, input.eventType.durationMin);
  return computeSlots({ ...input, from: addMinutes(start, -1), to: addMinutes(end, 1) }).some(
    (s) => s.start.getTime() === start.getTime(),
  );
}

function dedupe(slots: Slot[]): Slot[] {
  const out: Slot[] = [];
  let lastKey = -1;
  for (const s of slots) {
    const key = s.start.getTime();
    if (key !== lastKey) out.push(s);
    lastKey = key;
  }
  return out;
}

/**
 * Pick up to `max` slots spread across days so a voice assistant can offer
 * "Tuesday 10:00 or Wednesday 14:00" rather than five slots in one morning.
 * Optional `preferred` ("morning" | "afternoon") biases the pick.
 */
export function pickSpread(
  slots: Slot[],
  max: number,
  timezone: string,
  preferred?: "morning" | "afternoon" | null,
  perDay = 2,
): Slot[] {
  const byDay = new Map<string, Slot[]>();
  for (const s of slots) {
    const wc = toWallClock(s.start, timezone);
    const isMorning = wc.hour < 12;
    if (preferred === "morning" && !isMorning) continue;
    if (preferred === "afternoon" && isMorning) continue;
    const list = byDay.get(wc.date) ?? [];
    if (list.length < perDay) list.push(s);
    byDay.set(wc.date, list);
  }
  const out: Slot[] = [];
  for (const list of byDay.values()) {
    for (const s of list) {
      if (out.length >= max) return out;
      out.push(s);
    }
  }
  // Preference filtered everything out → fall back to unfiltered.
  if (out.length === 0 && preferred) return pickSpread(slots, max, timezone, null, perDay);
  return out;
}
