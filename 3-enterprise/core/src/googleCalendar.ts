/**
 * Google Calendar als Sync-ZIEL (account + provider google): Schreiber, Aufrufer mit Checkpoint, Prüfung
 * "dieselbe Person" über die Admin SDK Directory API.
 *
 * Geschrieben wird ausschließlich in den PRIMÄRKALENDER des per DWD impersonierten Postfachs
 * (calendars/primary/events, Subjekt = geprüftes Zielpostfach, Scope calendar.events):
 *   busy  summary = busyLabel, transparency "opaque", Beginn/Ende – sonst nichts (kein description/location/attendees)
 *   full  zusätzlich summary = Betreff, location = Ort; private Termine wie busy (eventToBlock in syncWorker.ts)
 * Jeder Termin trägt eine deterministische ID (base32hex des sourceRef-Hashes aus Pipeline + Quelltermin, Google
 * erlaubt eigene IDs [a-v0-9]{5,1024}) und extendedProperties.private.calensyncRef = derselbe Hash (kein Inhalt).
 * Damit ist die Anlage nach einem Absturz idempotent: 409 beim Einfügen = existiert schon → PATCH (auch ein
 * zwischenzeitlich gelöschter Termin derselben ID wird so wiederhergestellt). 404/410 beim Löschen = erledigt.
 *
 * Dieselbe Person (verifyGoogleIdentity): Directory users.get des Zielpostfachs (Subjekt = directoryAdminSubject,
 * Scope admin.directory.user.readonly) → externalIds[type=organization] muss exakt der employeeId des Inhabers in
 * Entra entsprechen (Graph, Heim-Token). Kein Wert wird gespeichert oder geloggt.
 *
 * Warum ein eigenes Directory-Subjekt statt des Zielnutzers mit viewType=domain_public: Die Mitarbeiter-ID gehört
 * zu den Admin-Feldern und ist in der öffentlichen Domänenansicht nicht zuverlässig enthalten. Minimal ist deshalb
 * ein eigener Workspace-Nutzer mit einer benutzerdefinierten Admin-Rolle, die NUR "Nutzer → Lesen" erlaubt.
 */
import { GoogleCallError, RunAborted } from "./syncErrors.js";
import { SCOPE_CALENDAR_EVENTS, SCOPE_DIRECTORY_USER_READONLY, type GoogleTokenSource } from "./googleAuth.js";
import { parseGoogleError } from "./errorHandler.js";
import type { IdentityVerdict } from "./identity.js";
import type { GraphCaller, TargetBlock, TargetWriter } from "./syncWorker.js";
import type { FetchLike } from "./types.js";

export const GOOGLE_CALENDAR_BASE = "https://www.googleapis.com/calendar/v3";
export const GOOGLE_DIRECTORY_BASE = "https://admin.googleapis.com/admin/directory/v1";
/** Schlüssel der privaten Extended Property an jedem von CalenSync angelegten Google-Termin (Wert: Hash) */
export const GOOGLE_REF_PROPERTY = "calensyncRef";
const GRAPH = "https://graph.microsoft.com/v1.0";

export type GoogleCaller = (method: string, url: string, body: Record<string, unknown> | undefined, subject: string, scope: string) =>
  Promise<{ status: number; text: string; retryAfter: string | null }>;

/**
 * Google-Aufruf mit Pflicht-Checkpoint VOR jedem Versuch (auch vor der Wiederholung nach 401), Token je
 * (Dienstkonto, Subjekt, Scope). Gegenstück zu createGraphCaller.
 */
export function createGoogleCaller(
  tokens: GoogleTokenSource,
  fetchFn: FetchLike,
  serviceAccountEmail: string,
  timeoutMs: number,
  checkpoint: () => Promise<void>,
): GoogleCaller {
  return async (method, url, body, subject, scope) => {
    const once = async () => {
      await checkpoint();
      const token = await tokens.getDelegatedToken(serviceAccountEmail, subject, scope);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      const res = await fetchFn(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get("Retry-After") };
    };
    const first = await once();
    if (first.status !== 401) return first;
    tokens.invalidateDelegatedToken(serviceAccountEmail, subject, scope);
    return once();
  };
}

const BASE32HEX = "0123456789abcdefghijklmnopqrstuv";
/** sourceRef (40 Hex = 20 Bytes) → 32 Zeichen base32hex: gültige Google-Event-ID, deterministisch, nicht umkehrbar */
export function googleEventIdFromRef(ref: string): string | null {
  if (!/^[0-9a-f]{40}$/.test(ref)) return null;
  const bytes = Buffer.from(ref, "hex");
  let out = "";
  let buf = 0;
  let bits = 0;
  for (const b of bytes) {
    buf = (buf << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += BASE32HEX[(buf >>> (bits - 5)) & 31];
      bits -= 5;
    }
    buf &= (1 << bits) - 1;
  }
  return out; // 160 Bit = genau 32 Zeichen, kein Rest
}

/**
 * Graph-förmiger Zielblock (eventToBlock) → Google-Event. Whitelist: nur Zeit, summary, transparency, location,
 * reminders. Teilblöcke (Umschreiben archivierter Termine ohne Zeiten) ergeben einen Teil-PATCH.
 */
export function toGoogleEvent(body: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (typeof body.subject === "string") out.summary = body.subject;
  // Ziel ist immer "belegt" (busy und oof); frei/mit Vorbehalt kommen gar nicht erst hier an
  if (body.showAs !== undefined) out.transparency = "opaque";
  const loc = (body.location as { displayName?: unknown } | undefined)?.displayName;
  if (typeof loc === "string") out.location = loc; // "" leert einen früher kopierten Ort (full → busy)
  const s = (body.start as { dateTime?: unknown } | undefined)?.dateTime;
  const e = (body.end as { dateTime?: unknown } | undefined)?.dateTime;
  if (typeof s === "string" && typeof e === "string") {
    if (body.isAllDay === true) {
      out.start = { date: s.slice(0, 10) };
      out.end = { date: e.slice(0, 10) };
    } else {
      out.start = { dateTime: `${s}Z`, timeZone: "UTC" };
      out.end = { dateTime: `${e}Z`, timeZone: "UTC" };
    }
  }
  if (body.isReminderOn === false) out.reminders = { useDefault: false, overrides: [] };
  return out;
}

/** Schreibt in calendars/primary/events des impersonierten Postfachs – Postfach kommt nur aus dem geprüften Ziel */
export class GoogleCalendarWriter implements TargetWriter {
  readonly kind = "google" as const;
  private readonly base = `${GOOGLE_CALENDAR_BASE}/calendars/primary/events`;
  constructor(private readonly call: GoogleCaller, private readonly mailbox: string) {}

  private req(method: string, url: string, body?: Record<string, unknown>) {
    return this.call(method, url, body, this.mailbox, SCOPE_CALENDAR_EVENTS);
  }

  private url(id: string): string {
    return `${this.base}/${encodeURIComponent(id)}?sendUpdates=none`;
  }

  async create(block: TargetBlock, ref: string): Promise<string> {
    const id = googleEventIdFromRef(ref);
    if (!id) throw new GoogleCallError(400, "", null);
    const event = { ...toGoogleEvent(block.body), extendedProperties: { private: { [GOOGLE_REF_PROPERTY]: ref } } };
    const r = await this.req("POST", `${this.base}?sendUpdates=none`, { id, ...event });
    if (r.status === 200 || r.status === 201) return id;
    if (r.status !== 409) throw new GoogleCallError(r.status, r.text, r.retryAfter);
    // ID existiert schon (Absturz nach dem Einfügen, oder früher gelöscht): vollständig überschreiben + bestätigen
    const p = await this.req("PATCH", this.url(id), { ...event, status: "confirmed" });
    if (p.status !== 200) throw new GoogleCallError(p.status, p.text, p.retryAfter);
    return id;
  }

  async update(targetEventId: string, block: TargetBlock): Promise<"ok" | "gone"> {
    const r = await this.req("PATCH", this.url(targetEventId), toGoogleEvent(block.body));
    if (r.status === 404 || r.status === 410) return "gone";
    if (r.status !== 200) throw new GoogleCallError(r.status, r.text, r.retryAfter);
    // Im Ziel gelöscht (Google behält den Termin als "cancelled") → wie 404: neu anlegen bzw. nicht wiederbeleben
    try {
      if ((JSON.parse(r.text) as { status?: unknown }).status === "cancelled") return "gone";
    } catch { /* leere Antwort: ok */ }
    return "ok";
  }

  async delete(targetEventId: string): Promise<void> {
    const r = await this.req("DELETE", this.url(targetEventId));
    if (r.status !== 204 && r.status !== 200 && r.status !== 404 && r.status !== 410) throw new GoogleCallError(r.status, r.text, r.retryAfter);
  }

  /** Deterministische ID – kein Aufruf nötig; existiert der Termin nicht, liefern PATCH/DELETE 404 */
  async findByRef(ref: string): Promise<string | null> {
    return googleEventIdFromRef(ref);
  }
}

// ---------------------------------------------------------------------------------------------------
// Dieselbe Person: Google Directory (Ziel) vs. Microsoft Graph (Inhaber)
// ---------------------------------------------------------------------------------------------------
export interface GoogleIdentitySubject {
  /** Entra-Objekt-ID des Inhabers (Heim-Mandant) */
  ownerObjectId: string;
  /** Google-Zielpostfach (Primäradresse) */
  mailbox: string;
  /** Workspace-Nutzer mit Admin-Rolle "Nutzer: Lesen" */
  directoryAdminSubject: string | null;
  attribute: "employeeId" | "localPart";
}

const transient = (status: number) => status === 0 || status === 429 || status >= 500;
const RATE = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded"]);

async function safeCall<T extends { status: number; text: string; retryAfter: string | null }>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof RunAborted) throw err;
    if (err instanceof GoogleCallError) return { status: err.status, text: "", retryAfter: err.retryAfter };
    return { status: 0, text: "", retryAfter: null };
  }
}

export async function verifyGoogleIdentity(graph: GraphCaller, google: GoogleCaller, s: GoogleIdentitySubject): Promise<IdentityVerdict> {
  if (s.attribute === "localPart") return { kind: "verified", attribute: "localPart" };
  if (!s.directoryAdminSubject) return { kind: "rejected", why: "forbidden" }; // ohne Directory-Subjekt nie "verified"

  const url = `${GOOGLE_DIRECTORY_BASE}/users/${encodeURIComponent(s.mailbox)}?projection=basic&viewType=admin_view&fields=primaryEmail,suspended,externalIds`;
  const g = await safeCall(() => google("GET", url, undefined, s.directoryAdminSubject as string, SCOPE_DIRECTORY_USER_READONLY));
  if (g.status !== 200) {
    const rate = g.status === 403 && RATE.has(parseGoogleError(g.text).reason);
    if (transient(g.status) || rate) return { kind: "unavailable", status: rate ? 429 : g.status, body: "", retryAfter: g.retryAfter };
    return { kind: "rejected", why: g.status === 404 ? "target_not_found" : "forbidden" };
  }
  let user: { primaryEmail?: unknown; suspended?: unknown; externalIds?: unknown };
  try {
    user = JSON.parse(g.text) as typeof user;
  } catch {
    return { kind: "unavailable", status: 502, body: "", retryAfter: null };
  }
  // Nur die Primäradresse (DWD-Subjekt muss sie sein); Alias oder gesperrtes Konto → nie schreiben
  if (typeof user.primaryEmail !== "string" || user.primaryEmail.toLowerCase() !== s.mailbox.toLowerCase()) return { kind: "rejected", why: "target_not_found" };
  if (user.suspended === true) return { kind: "rejected", why: "target_not_found" };
  const ids = Array.isArray(user.externalIds) ? user.externalIds as Array<{ type?: unknown; value?: unknown }> : [];
  const values = [...new Set(ids.filter((x) => x && x.type === "organization" && typeof x.value === "string" && x.value.trim() !== "").map((x) => x.value as string))];
  // keine oder mehrdeutige Mitarbeiter-ID → nicht prüfbar → nie "verified"
  if (values.length !== 1) return { kind: "rejected", why: "attribute_missing" };

  const o = await safeCall(() => graph("GET", `${GRAPH}/users/${encodeURIComponent(s.ownerObjectId)}?$select=id,employeeId`, undefined, null));
  if (o.status !== 200) {
    if (transient(o.status)) return { kind: "unavailable", status: o.status, body: o.text, retryAfter: o.retryAfter };
    return { kind: "rejected", why: "forbidden" };
  }
  let a: unknown;
  try {
    a = (JSON.parse(o.text) as { employeeId?: unknown }).employeeId;
  } catch {
    return { kind: "unavailable", status: 502, body: "", retryAfter: null };
  }
  if (typeof a !== "string" || a.trim() === "") return { kind: "rejected", why: "attribute_missing" };
  return a === values[0] ? { kind: "verified", attribute: "employeeId" } : { kind: "rejected", why: "different_person" };
}
