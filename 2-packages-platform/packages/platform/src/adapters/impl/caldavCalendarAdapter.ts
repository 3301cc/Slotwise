/**
 * R1 · Option A · Referenz-Adapter Stufe 1: CalDAV (RFC 4791) über fetch.
 *
 * Funktioniert gegen Nextcloud, mailbox.org, Open-Xchange, Radicale, Baïkal.
 * Kein SDK: REPORT calendar-query mit expand (Server löst Wiederholungen auf),
 * PUT/DELETE für Ereignisse, ETag-basiertes Update (If-Match).
 *
 * connection.externalId = absolute URL der Kalender-Collection (mit Slash am Ende).
 * credentials.secrets   = { username, password }  (App-Passwort, aus dem Vault)
 * credentials.config    = { timezone, all_day_events_block? }
 */
import { randomUUID } from 'node:crypto';
import type { BusyBlock } from '../../availability/slotEngine.js';
import { ProviderAuthError, ProviderNotFoundError, ProviderRateLimitError, ProviderUnavailableError } from '../../booking/errors.js';
import type { CalendarConnection } from '../../booking/types.js';
import type { OwnEvent, ReconcilableCalendarProvider } from '../../booking/reconciler.js';
import { wallToUtc, isValidTimezone } from '../../time/tz.js';
import { catalogById } from '../catalog.js';
import type { AdapterMetadata } from '../metadata.js';
import type { CalendarAdapter } from '../ports.js';
import type { AdapterCredentials } from '../registry.js';

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;

const PROVIDER = 'caldav';
export const OWN_UID_SUFFIX = '@slotwise.de';

export class CalDavCalendarAdapter implements CalendarAdapter, ReconcilableCalendarProvider {
  readonly name = PROVIDER;
  readonly meta: AdapterMetadata & { category: 'calendar' };
  private readonly auth: string;
  private readonly timezone: string;
  private readonly allDayBlocks: boolean;

  constructor(private readonly credentials: AdapterCredentials, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
    const meta = catalogById().get('caldav');
    if (!meta || meta.category !== 'calendar') throw new Error('Katalogeintrag caldav fehlt');
    this.meta = meta as AdapterMetadata & { category: 'calendar' };
    const { username, password } = credentials.secrets;
    if (!username || !password) throw new Error('CalDAV: username und password fehlen');
    this.auth = 'Basic ' + Buffer.from(`${username}:${password}`, 'utf8').toString('base64');
    const tz = credentials.config.timezone;
    if (!isValidTimezone(tz)) throw new Error('CalDAV: config.timezone muss eine gültige IANA-Zone sein');
    this.timezone = tz;
    this.allDayBlocks = credentials.config.all_day_events_block === 'true';
  }

  async healthCheck(): Promise<void> {
    const url = this.credentials.config.calendar_home ?? this.credentials.config.server_url;
    if (!url) throw new Error('CalDAV: config.server_url fehlt');
    const res = await this.request(url, 'PROPFIND', { Depth: '0' }, `<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`);
    if (res.status !== 207) throw new Error(`CalDAV: PROPFIND ${url} antwortete ${res.status}`);
  }

  async getFreeBusy(connections: CalendarConnection[], from: Date, to: Date): Promise<BusyBlock[]> {
    const out: BusyBlock[] = [];
    for (const c of connections) {
      const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data><c:expand start="${icsUtc(from)}" end="${icsUtc(to)}"/></c:calendar-data></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icsUtc(from)}" end="${icsUtc(to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
      const res = await this.request(c.externalId, 'REPORT', { Depth: '1' }, body);
      if (res.status !== 207) throw new ProviderUnavailableError(PROVIDER, res.status);
      const xml = await res.text();
      for (const ics of extractCalendarData(xml)) {
        for (const ev of parseVEvents(ics, this.timezone)) {
          if (ev.transparent || ev.cancelled) continue;
          if (ev.allDay && !this.allDayBlocks) continue;
          if (ev.end <= from || ev.start >= to) continue;
          out.push({ start: ev.start, end: ev.end, externalEventId: ev.uid });
        }
      }
    }
    return out;
  }

  /** Von Slotwise angelegte Einträge (UID …@slotwise.de) im Fenster – Grundlage des Reconcilers. */
  async listOwnEvents(primary: CalendarConnection, from: Date, to: Date): Promise<OwnEvent[]> {
    const body = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"><c:time-range start="${icsUtc(from)}" end="${icsUtc(to)}"/></c:comp-filter></c:comp-filter></c:filter>
</c:calendar-query>`;
    const res = await this.request(primary.externalId, 'REPORT', { Depth: '1' }, body);
    if (res.status !== 207) throw new ProviderUnavailableError(PROVIDER, res.status);
    const out: OwnEvent[] = [];
    for (const ics of extractCalendarData(await res.text())) {
      for (const ev of parseVEvents(ics, this.timezone)) {
        if (!ev.uid.endsWith(OWN_UID_SUFFIX)) continue;
        out.push({ externalEventId: ev.uid, status: ev.status === 'CONFIRMED' ? 'confirmed' : ev.cancelled ? 'cancelled' : 'tentative', createdAt: ev.createdAt, start: ev.start, end: ev.end });
      }
    }
    return out;
  }

  async createEvent(primary: CalendarConnection, input: { start: Date; end: Date; title: string; description: string; attendeeEmail: string; status: 'tentative' | 'confirmed' }): Promise<{ externalEventId: string }> {
    const uid = `${randomUUID()}${OWN_UID_SUFFIX}`;
    const ics = buildIcs({ uid, start: input.start, end: input.end, title: input.title, description: input.description, attendeeEmail: input.attendeeEmail, status: input.status, sequence: 0, dtstamp: new Date() });
    const res = await this.request(eventUrl(primary.externalId, uid), 'PUT', { 'If-None-Match': '*', 'Content-Type': 'text/calendar; charset=utf-8' }, ics);
    if (res.status !== 201 && res.status !== 204) throw new ProviderUnavailableError(PROVIDER, res.status);
    return { externalEventId: uid };
  }

  async confirmEvent(primary: CalendarConnection, externalEventId: string): Promise<void> {
    await this.rewrite(primary, externalEventId, (l) => (l.startsWith('STATUS:') ? 'STATUS:CONFIRMED' : l));
  }

  async updateEvent(primary: CalendarConnection, externalEventId: string, patch: { start: Date; end: Date; title?: string; description?: string }): Promise<void> {
    await this.rewrite(primary, externalEventId, (l) => {
      if (l.startsWith('DTSTART')) return `DTSTART:${icsUtc(patch.start)}`;
      if (l.startsWith('DTEND')) return `DTEND:${icsUtc(patch.end)}`;
      if (l.startsWith('SUMMARY:') && patch.title !== undefined) return `SUMMARY:${escText(patch.title)}`;
      if (l.startsWith('DESCRIPTION:') && patch.description !== undefined) return `DESCRIPTION:${escText(patch.description)}`;
      return l;
    });
  }

  async deleteEvent(primary: CalendarConnection, externalEventId: string): Promise<void> {
    const res = await this.request(eventUrl(primary.externalId, externalEventId), 'DELETE', {});
    if (res.status !== 204 && res.status !== 200 && res.status !== 404) throw new ProviderUnavailableError(PROVIDER, res.status);
  }

  /** GET → Zeilen umschreiben → PUT mit If-Match (ETag); SEQUENCE und LAST-MODIFIED werden immer fortgeschrieben. */
  private async rewrite(primary: CalendarConnection, uid: string, mapLine: (line: string) => string): Promise<void> {
    const url = eventUrl(primary.externalId, uid);
    const got = await this.request(url, 'GET', {});
    if (got.status === 404) throw new ProviderNotFoundError(PROVIDER, uid);
    if (got.status !== 200) throw new ProviderUnavailableError(PROVIDER, got.status);
    const etag = got.headers.get('etag');
    const current = await got.text();
    const updated = unfold(current)
      .map((l) => (l.startsWith('SEQUENCE:') ? `SEQUENCE:${Number(l.slice(9)) + 1}` : l.startsWith('LAST-MODIFIED:') ? `LAST-MODIFIED:${icsUtc(new Date())}` : mapLine(l)))
      .map(fold)
      .join('\r\n');
    const headers: Record<string, string> = { 'Content-Type': 'text/calendar; charset=utf-8' };
    if (etag) headers['If-Match'] = etag;
    const put = await this.request(url, 'PUT', headers, updated);
    if (put.status === 412) throw new ProviderUnavailableError(PROVIDER, 412); // ETag-Konflikt: erneut lesen und schreiben (Retry)
    if (put.status !== 204 && put.status !== 201 && put.status !== 200) throw new ProviderUnavailableError(PROVIDER, put.status);
  }

  private async request(url: string, method: string, headers: Record<string, string>, body?: string) {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(url, { method, headers: { Authorization: this.auth, 'User-Agent': 'Slotwise/1.0 (+https://slotwise.de)', ...headers }, body });
    } catch (err) {
      throw new ProviderUnavailableError(PROVIDER, undefined);
    }
    if (res.status === 429) throw new ProviderRateLimitError(PROVIDER, retryAfterMs(res.headers.get('retry-after')));
    if (res.status >= 500) throw new ProviderUnavailableError(PROVIDER, res.status);
    if (res.status === 401 || res.status === 403) throw new ProviderAuthError(PROVIDER, res.status, url);
    return res;
  }
}

// ---------------------------------------------------------------------------
// iCalendar-Hilfsfunktionen (nur der Teil, den Slotwise braucht)
// ---------------------------------------------------------------------------

export function icsUtc(d: Date): string {
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function eventUrl(collection: string, uid: string): string {
  return `${collection.endsWith('/') ? collection : collection + '/'}${encodeURIComponent(uid)}.ics`;
}

function retryAfterMs(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return s * 1000;
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/** RFC 5545 §3.1: Zeilen, die mit Leerzeichen/Tab beginnen, gehören zur vorigen. */
export function unfold(ics: string): string[] {
  const raw = ics.split(/\r?\n/);
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && out.length) out[out.length - 1] += line.slice(1);
    else if (line.length) out.push(line);
  }
  return out;
}

function fold(line: string): string {
  const bytes = Buffer.from(line, 'utf8');
  if (bytes.length <= 75) return line;
  const parts: string[] = [];
  let cur = '';
  for (const ch of line) {
    if (Buffer.byteLength(cur + ch, 'utf8') > 74) {
      parts.push(cur);
      cur = ' ' + ch;
    } else cur += ch;
  }
  parts.push(cur);
  return parts.join('\r\n');
}

function escText(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

export function buildIcs(e: { uid: string; start: Date; end: Date; title: string; description: string; attendeeEmail: string; status: 'tentative' | 'confirmed'; sequence: number; dtstamp: Date }): string {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Slotwise//Booking//DE',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsUtc(e.dtstamp)}`,
    `DTSTART:${icsUtc(e.start)}`,
    `DTEND:${icsUtc(e.end)}`,
    `SUMMARY:${escText(e.title)}`,
    `DESCRIPTION:${escText(e.description)}`,
    `STATUS:${e.status === 'tentative' ? 'TENTATIVE' : 'CONFIRMED'}`,
    `SEQUENCE:${e.sequence}`,
    'TRANSP:OPAQUE',
    `LAST-MODIFIED:${icsUtc(e.dtstamp)}`,
  ];
  if (e.attendeeEmail) lines.push(`ATTENDEE;CUTYPE=INDIVIDUAL;ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED:mailto:${e.attendeeEmail}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.map(fold).join('\r\n') + '\r\n';
}

export interface ParsedEvent {
  uid: string;
  start: Date;
  end: Date;
  allDay: boolean;
  transparent: boolean;
  cancelled: boolean;
  /** STATUS-Wert in Großbuchstaben, leer wenn nicht gesetzt */
  status: string;
  /** DTSTAMP bzw. CREATED, null wenn beides fehlt */
  createdAt: Date | null;
}

/** Zieht alle <calendar-data>-Inhalte aus einer Multistatus-Antwort (XML-Entities werden dekodiert). */
export function extractCalendarData(xml: string): string[] {
  const out: string[] = [];
  const re = /<(?:[\w-]+:)?calendar-data[^>]*>([\s\S]*?)<\/(?:[\w-]+:)?calendar-data>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(xml))) {
    const inner = m[1].replace(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/, '$1');
    out.push(inner.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#13;/g, '\r').replace(/&#10;/g, '\n').replace(/&amp;/g, '&'));
  }
  return out;
}

function parseDateProp(value: string, params: Record<string, string>, fallbackTz: string): { instant: Date; allDay: boolean } {
  if (params.VALUE === 'DATE' || /^\d{8}$/.test(value)) {
    const y = Number(value.slice(0, 4)), mo = Number(value.slice(4, 6)), d = Number(value.slice(6, 8));
    return { instant: wallToUtc({ year: y, month: mo, day: d, hour: 0, minute: 0 }, fallbackTz), allDay: true };
  }
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})?(Z)?$/.exec(value);
  if (!m) throw new Error(`Ungültiger iCalendar-Zeitwert: ${value}`);
  const wall = { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]), hour: Number(m[4]), minute: Number(m[5]), second: Number(m[6] ?? '0') };
  if (m[7] === 'Z') return { instant: new Date(Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second)), allDay: false };
  const tz = params.TZID && isValidTimezone(params.TZID) ? params.TZID : fallbackTz;
  return { instant: wallToUtc(wall, tz), allDay: false };
}

function parseDuration(v: string): number {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(v);
  if (!m) throw new Error(`Ungültige DURATION: ${v}`);
  const sign = m[1] === '-' ? -1 : 1;
  const ms = ((Number(m[2] ?? 0) * 7 + Number(m[3] ?? 0)) * 86_400 + Number(m[4] ?? 0) * 3600 + Number(m[5] ?? 0) * 60 + Number(m[6] ?? 0)) * 1000;
  return sign * ms;
}

export function parseVEvents(ics: string, fallbackTz: string): ParsedEvent[] {
  const lines = unfold(ics);
  const events: ParsedEvent[] = [];
  let cur: Record<string, { value: string; params: Record<string, string> }> | null = null;
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (line === 'END:VEVENT' && cur) {
      const uid = cur.UID?.value ?? '';
      const startP = cur.DTSTART;
      if (startP) {
        const s = parseDateProp(startP.value, startP.params, fallbackTz);
        let end: Date;
        if (cur.DTEND) end = parseDateProp(cur.DTEND.value, cur.DTEND.params, fallbackTz).instant;
        else if (cur.DURATION) end = new Date(s.instant.getTime() + parseDuration(cur.DURATION.value));
        else end = s.allDay ? new Date(s.instant.getTime() + 86_400_000) : s.instant;
        const stampSrc = cur.CREATED ?? cur.DTSTAMP;
        events.push({
          uid,
          start: s.instant,
          end,
          allDay: s.allDay,
          transparent: (cur.TRANSP?.value ?? 'OPAQUE').toUpperCase() === 'TRANSPARENT',
          cancelled: (cur.STATUS?.value ?? '').toUpperCase() === 'CANCELLED',
          status: (cur.STATUS?.value ?? '').toUpperCase(),
          createdAt: stampSrc ? parseDateProp(stampSrc.value, stampSrc.params, 'UTC').instant : null,
        });
      }
      cur = null;
      continue;
    }
    if (!cur) continue;
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    const head = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const [name, ...paramParts] = head.split(';');
    const params: Record<string, string> = {};
    for (const p of paramParts) {
      const eq = p.indexOf('=');
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, '');
    }
    const key = name.toUpperCase();
    // RECURRENCE-ID-Instanzen und expand-Ergebnisse teilen die UID: jede Instanz eigenständig zählen.
    if (['DTSTART', 'DTEND', 'DURATION', 'UID', 'TRANSP', 'STATUS', 'DTSTAMP', 'CREATED'].includes(key)) cur[key] = { value, params };
  }
  return events;
}

/** Factory für die Registry. */
export function caldavFactory(fetchImpl?: FetchLike) {
  return (credentials: AdapterCredentials) => new CalDavCalendarAdapter(credentials, fetchImpl);
}
