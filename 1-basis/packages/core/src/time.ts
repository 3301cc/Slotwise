/**
 * Timezone helpers built on Intl only — no date library needed for the engine.
 * All public inputs/outputs are UTC `Date`s plus IANA zone strings; wall-clock
 * values are `YYYY-MM-DD` and `HH:mm` strings in that zone.
 */

export type LocalDate = string; // "2026-09-29"
export type LocalTime = string; // "09:00"

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function dtf(timeZone: string): Intl.DateTimeFormat {
  let f = dtfCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      weekday: "short",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    dtfCache.set(timeZone, f);
  }
  return f;
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export interface WallClock {
  date: LocalDate;
  time: LocalTime;
  weekday: number; // 0 = Sunday … 6 = Saturday
  year: number;
  month: number; // 1–12
  day: number;
  hour: number;
  minute: number;
}

/** Break a UTC instant into wall-clock parts in `timeZone`. */
export function toWallClock(instant: Date, timeZone: string): WallClock {
  const parts = dtf(timeZone).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? "";
  const year = Number(get("year"));
  const month = Number(get("month"));
  const day = Number(get("day"));
  const hour = Number(get("hour"));
  const minute = Number(get("minute"));
  const weekday = WEEKDAYS[get("weekday")] ?? 0;
  return {
    date: `${year}-${pad(month)}-${pad(day)}`,
    time: `${pad(hour)}:${pad(minute)}`,
    weekday,
    year,
    month,
    day,
    hour,
    minute,
  };
}

/** Offset of `timeZone` from UTC at `instant`, in milliseconds (Berlin in summer = +7 200 000). */
export function tzOffsetMs(instant: Date, timeZone: string): number {
  const w = toWallClock(instant, timeZone);
  const second = Number(
    dtf(timeZone)
      .formatToParts(instant)
      .find((p) => p.type === "second")?.value ?? 0,
  );
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, second);
  return asUtc - Math.floor(instant.getTime() / 1000) * 1000;
}

/**
 * Convert a wall-clock date + time in `timeZone` to a UTC instant.
 * Handles DST transitions with a two-pass offset correction.
 */
export function zonedToUtc(date: LocalDate, time: LocalTime, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const [hh, mm] = time.split(":").map(Number) as [number, number];
  const guess = Date.UTC(y, m - 1, d, hh, mm, 0);
  const offset1 = tzOffsetMs(new Date(guess), timeZone);
  const candidate = guess - offset1;
  const offset2 = tzOffsetMs(new Date(candidate), timeZone);
  return new Date(offset1 === offset2 ? candidate : guess - offset2);
}

export function addMinutes(d: Date, minutes: number): Date {
  return new Date(d.getTime() + minutes * MINUTE);
}

export function addDays(d: Date, days: number): Date {
  return new Date(d.getTime() + days * DAY);
}

/** Next calendar day (as `YYYY-MM-DD`) — pure string arithmetic via UTC. */
export function nextLocalDate(date: LocalDate): LocalDate {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const next = new Date(Date.UTC(y, m - 1, d) + DAY);
  return `${next.getUTCFullYear()}-${pad(next.getUTCMonth() + 1)}-${pad(next.getUTCDate())}`;
}

export function compareLocalDate(a: LocalDate, b: LocalDate): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    dtf(tz);
    return true;
  } catch {
    return false;
  }
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/** "2026-10-01T08:00:00.000Z" → "Do., 1. Okt., 10:00" (de) — for the assistant to read aloud. */
export function formatForSpeech(instant: Date, timeZone: string, locale = "de"): string {
  return new Intl.DateTimeFormat(locale === "de" ? "de-DE" : "en-GB", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(instant);
}
