/**
 * Zeitzonen-Engine ohne Abhängigkeiten. Baut auf Intl.DateTimeFormat auf,
 * das die IANA-Datenbank des Laufzeitsystems nutzt (Node 22, alle aktuellen
 * Browser). Alle Instants sind UTC-Millisekunden bzw. Date-Objekte, Wanduhr-
 * zeiten sind reine Zahlen-Tupel und tragen die Zone immer explizit.
 */

export interface WallTime {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number; // 0-59
  second?: number;
}

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function formatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

/** Wirft, wenn die Zone dem Laufzeitsystem unbekannt ist. */
export function assertIanaTimezone(tz: string): void {
  try {
    formatter(tz);
  } catch {
    throw new RangeError(`Unbekannte IANA-Zeitzone: ${tz}`);
  }
}

export function isValidTimezone(tz: string | null | undefined): tz is string {
  if (!tz || typeof tz !== 'string' || tz.length > 64) return false;
  try {
    formatter(tz);
    return true;
  } catch {
    return false;
  }
}

/** Wanduhrzeit einer Zone zu einem UTC-Instant. */
export function utcToWall(instant: Date, tz: string): WallTime & { weekday: number } {
  const parts = formatter(tz).formatToParts(instant);
  const num = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const wd = parts.find((p) => p.type === 'weekday')!.value; // Mon..Sun
  const weekday = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(wd); // 0 = Montag
  return {
    year: num('year'),
    month: num('month'),
    day: num('day'),
    hour: num('hour') === 24 ? 0 : num('hour'),
    minute: num('minute'),
    second: num('second'),
    weekday,
  };
}

/** Offset der Zone zum UTC-Instant in Minuten (Berlin im Sommer: +120). */
export function getOffsetMinutes(tz: string, instant: Date): number {
  const w = utcToWall(instant, tz);
  const asUtc = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second ?? 0);
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

/**
 * Wanduhrzeit in einer Zone zum UTC-Instant.
 *
 * Verhalten an den Umstellungstagen:
 * - Lücke (29.03.2026 02:30 Europe/Berlin existiert nicht): Ergebnis liegt
 *   eine Stunde später (03:30 MESZ). Wer 02:30 anfragt, bekommt den ersten
 *   existierenden Zeitpunkt danach.
 * - Überlappung (25.10.2026 02:30 existiert zweimal): Ergebnis ist das zweite
 *   Vorkommen (02:30 MEZ). Für Verfügbarkeitsregeln ist das irrelevant, weil
 *   keine Regel im Fenster 02:00-03:00 liegt; für Buchungen wird der Instant
 *   ohnehin vom Client als UTC gesendet.
 */
export function wallToUtc(wall: WallTime, tz: string): Date {
  const guess = Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second ?? 0);
  const off1 = getOffsetMinutes(tz, new Date(guess));
  let utc = guess - off1 * 60_000;
  const off2 = getOffsetMinutes(tz, new Date(utc));
  if (off2 !== off1) utc = guess - off2 * 60_000;
  return new Date(utc);
}

/** Kalendertag (y, m, d) um n Tage verschieben, unabhängig von Zonen. */
export function addDays(date: { year: number; month: number; day: number }, n: number) {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + n));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Wochentag eines Kalendertags, 0 = Montag … 6 = Sonntag (zonenunabhängig). */
export function weekdayOf(date: { year: number; month: number; day: number }): number {
  const js = new Date(Date.UTC(date.year, date.month - 1, date.day)).getUTCDay(); // 0 = So
  return (js + 6) % 7;
}

/** Instant minus Intervall. Erinnerungen werden NUR so berechnet, nie über Wanduhrzeit. */
export function minusMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() - minutes * 60_000);
}

export function formatHHMM(instant: Date, tz: string): string {
  const w = utcToWall(instant, tz);
  return `${String(w.hour).padStart(2, '0')}:${String(w.minute).padStart(2, '0')}`;
}

/** Kalenderdatum eines Instants in einer Zone als ISO-Tagesstring (YYYY-MM-DD). */
export function isoDateIn(instant: Date, tz: string): string {
  const w = utcToWall(instant, tz);
  return `${w.year}-${String(w.month).padStart(2, '0')}-${String(w.day).padStart(2, '0')}`;
}

/** Kurzname des Offsets, z. B. "MESZ" oder "GMT+2", für das Zeitlabel im Widget. */
export function zoneAbbreviation(instant: Date, tz: string, locale = 'de-DE'): string {
  const parts = new Intl.DateTimeFormat(locale, { timeZone: tz, timeZoneName: 'short' }).formatToParts(instant);
  return parts.find((p) => p.type === 'timeZoneName')?.value ?? tz;
}
