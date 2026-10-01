/**
 * Busy-API für die CalenSync-Buchungsseite:  GET /api/v1/availability/busy?from=<ISO>&to=<ISO>
 *
 *   * Server-zu-Server: statisches Bearer-Token `bookingApiToken` aus APP_CONFIG, timing-sicher verglichen
 *     (SHA-256 beider Seiten → gleiche Länge → timingSafeEqual). Das Token gehört NIE in den Browser.
 *   * Antwort { busy: [{ start, end }] } – über alle aktiven booking-Pipelines des Mandanten zusammengefasst,
 *     überlappende/angrenzende Intervalle verschmolzen, auf [from, to) beschnitten, ohne Nutzerbezug.
 *   * Zeitraum höchstens 62 Tage; from/to als ISO-8601 MIT Zeitzone (Z oder ±hh:mm).
 */
import { createHash, timingSafeEqual } from "node:crypto";

export const BUSY_MAX_RANGE_MS = 62 * 24 * 60 * 60_000;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/;

const digest = (s: string) => createHash("sha256").update(s, "utf8").digest();

export type BookingAuthResult = "ok" | "missing" | "invalid";

/** Prüft "Authorization: Bearer <token>" gegen das konfigurierte Token */
export function createBookingTokenCheck(token: string): (header: string | undefined) => BookingAuthResult {
  const expected = digest(token);
  return (header) => {
    const m = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header ?? "");
    if (!m) return "missing";
    return timingSafeEqual(digest(m[1]), expected) ? "ok" : "invalid";
  };
}

export type RangeCheck = { ok: true; from: Date; to: Date } | { ok: false; error: "invalid_range" | "range_too_large" };

export function parseBusyRange(rawUrl: string): RangeCheck {
  let q: URLSearchParams;
  try {
    q = new URL(rawUrl, "http://localhost").searchParams;
  } catch {
    return { ok: false, error: "invalid_range" };
  }
  const f = q.getAll("from");
  const t = q.getAll("to");
  if (f.length !== 1 || t.length !== 1 || !ISO.test(f[0]) || !ISO.test(t[0])) return { ok: false, error: "invalid_range" };
  const from = new Date(f[0]);
  const to = new Date(t[0]);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) return { ok: false, error: "invalid_range" };
  if (to.getTime() - from.getTime() > BUSY_MAX_RANGE_MS) return { ok: false, error: "range_too_large" };
  return { ok: true, from, to };
}
