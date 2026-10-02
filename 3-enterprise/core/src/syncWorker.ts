/**
 * Kalenderabgleich (Job "pipeline.delta_sync", Payload { pipelineId, full }).
 *
 * Quelle: Microsoft-365-Postfach des Inhabers, users/{entraObjectId}/calendarView/delta über ein Zeitfenster
 * (Default jetzt − 1 Tag … jetzt + 90 Tage). Ziel (pipelines.target_kind):
 *   account  zweites Postfach derselben Person, ggf. in einem verknüpften Entra-Mandanten (eigenes App-Token)
 *            oder – target_provider google – Primärkalender in einem verknüpften Google Workspace (googleCalendar.ts,
 *            domänenweite Delegation, Token keyless über googleAuth.ts)
 *   team     Team-/Abteilungskalender im eigenen Mandanten
 *   booking  Buchungsseite – KEIN Provider-Schreibzugriff, nur sync_event_map (Busy-API liest daraus)
 *
 * Ablauf je Job:
 *   1. Pipeline lesen; nicht aktiv / Inhaber inaktiv → Job erledigt, NICHTS wird aufgerufen
 *   2. Ziel erneut gegen die Admin-Allowlist prüfen (wie die API) – sonst config_error + Alarm, kein Aufruf
 *   3. Sync-Lease auf der Pipeline (höchstens ein Lauf je Pipeline, auch über mehrere Tasks)
 *   4. Delta lesen: gespeicherter deltaLink, sonst (full, fehlend, Fenster älter als 24 h) frisches Delta;
 *      @odata.nextLink folgen; 410/syncStateNotFound → Zustand verwerfen und einmal frisch beginnen
 *   5. Je Termin: Schleifenschutz → entfernt/abgesagt/frei → Zielblock löschen; belegt/abwesend → anlegen/ändern
 *   6. deltaLink + last_synced_at erst speichern, wenn ALLE Seiten angewandt sind (sonst wiederholt der nächste
 *      Lauf die Seiten; sync_event_map + changeKey machen das idempotent)
 *
 * Harte Regeln:
 *   * VOR JEDEM Provider-Aufruf (Lesen wie Schreiben) wird der Pipeline-Status neu gelesen (ENTERPRISE-
 *     ARCHITEKTUR.md §2, assert_pipeline_alive): revoked/paused/Inhaber deaktiviert → Lauf endet sofort.
 *     Höchstens der eine Aufruf, der beim Commit der Deaktivierung schon unterwegs war, läuft noch zu Ende.
 *   * Keine Termininhalte in Datenbank oder Log: gespeichert werden nur IDs, Beginn, Ende, changeKey; geloggt
 *     werden Zähler und Codes. Fehlertexte von Graph gehen nur als Code/Status weiter (classifyGraphError).
 *   * busy-Modus: das Ziel bekommt Beginn, Ende, showAs=busy und den busyLabel als Betreff – sonst nichts.
 *     full-Modus: zusätzlich Betreff und Ort (displayName); Text und Teilnehmer NIE. Private/vertrauliche
 *     Termine werden auch im full-Modus wie busy übertragen.
 *   * Schleifenschutz: Ein Quelltermin, dessen ID irgendwo im Mandanten als target_event_id steht (oder der
 *     unsere transactionId-Kennung trägt), wird nie übertragen.
 *   * Doppelte nach Absturz: Vor dem POST wird die Zuordnung als "Anlage begonnen" (target_event_id NULL)
 *     gespeichert; jeder angelegte Termin trägt transactionId (Graph-Idempotenz) und eine
 *     singleValueExtendedProperty mit einem Hash aus Pipeline + Quell-ID. Findet der nächste Lauf eine begonnene
 *     Anlage, sucht er den Termin über diese Eigenschaft, statt einen zweiten anzulegen.
 *   * Fehler: classifyGraphError + Backoff wie beim Handshake; endgültig → Pipeline blocked_scope/config_error/
 *     error + Alarm, last_sync_error = Code.
 */
import { createHash } from "node:crypto";
import { classifyGoogleError, classifyGraphError, type ErrorDecision, type FailureCategory, type GraphFailure } from "./errorHandler.js";
import { ForeignEventError, GoogleAuthError, GoogleCallError, GraphCallError, RunAborted } from "./syncErrors.js";
import type { GraphTokenSource } from "./appToken.js";
import type { DelayedJobQueue, Job } from "./retryQueue.js";
import { fullModeAllowed, googleWorkspaceFor, recheckStoredTarget, type ResolvedTarget, type StoredTarget, type SyncAllowlist } from "./syncTargets.js";
import { verifyIdentity } from "./identity.js";
import type { GoogleTokenSource } from "./googleAuth.js";
import { createGoogleCaller, GoogleCalendarWriter, verifyGoogleIdentity, type GoogleCaller } from "./googleCalendar.js";
import type { FetchLike } from "./types.js";

export const SYNC_KIND = "pipeline.delta_sync";
export const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
/** Markierung jedes von CalenSync angelegten Zieltermins (Wert: Hash, kein Inhalt) */
export const SOURCE_REF_PROPERTY_ID = "String {6f1d4a3c-2b8e-4c55-9a7d-0c1e5ca1e5c0} Name CalenSyncSourceRef";
/** transactionId-Präfix (GUID-Form) – zweite Schleifenschutz-Linie, auch gegen einen zweiten CalenSync-Stack */
export const TX_PREFIX = "ca1e5c";
export const DEFAULT_BUSY_LABEL = "Beschäftigt";

export interface SyncPayload {
  pipelineId: string;
  full: boolean;
  attempts?: Partial<Record<"scope_propagation" | "transient" | "token", number>>;
}

export interface SyncContext {
  status: string;
  ownerActive: boolean;
  /** Entra-Objekt-ID des Inhabers = Quellpostfach */
  ownerEntraObjectId: string | null;
  /** scim_users.user_name (UPN) – für die Same-Person-Prüfung */
  ownerUserName: string | null;
  mode: "busy" | "full";
  busyLabel: string | null;
  target: StoredTarget;
  deltaLink: string | null;
  deltaStartedAt: Date | null;
  /** Anlage der Pipeline – Anker des 403-Propagationsfensters (neuer RBAC-Scope für Teampostfächer) */
  createdAt: Date | null;
  /** account: letzte erfolgreiche Graph-Prüfung "dieselbe Person" und Merkmal */
  identityVerifiedAt?: Date | null;
  identityAttribute?: string | null;
  /** zuletzt tatsächlich geschriebener Modus */
  effectiveMode?: "busy" | "full" | null;
}

export interface MapRow {
  sourceEventId: string;
  /** NULL: Buchungsseite, oder Anlage beim Provider begonnen, aber nicht bestätigt */
  targetEventId: string | null;
  changeKey: string | null;
  startAt: Date;
  endAt: Date;
  /** aus dem Sync-Fenster gefallen: kein Abgleich/keine Busy-API, aber die Bereinigung löscht den Zieltermin */
  archived?: boolean;
}

export interface SyncRepo {
  getSyncContext(tenantId: string, pipelineId: string): Promise<SyncContext | null>;
  /** true = Lease erhalten (frei, abgelaufen oder schon unsere) */
  acquireSyncLease(tenantId: string, pipelineId: string, owner: string, leaseMs: number): Promise<boolean>;
  releaseSyncLease(tenantId: string, pipelineId: string, owner: string): Promise<void>;
  getMappings(pipelineId: string, sourceEventIds: readonly string[]): Promise<Map<string, MapRow>>;
  listMappings(pipelineId: string): Promise<MapRow[]>;
  /** Welche dieser IDs sind Zieltermine irgendeiner Pipeline des Mandanten? (ein Lookup je Seite) */
  findCalensyncTargetIds(tenantId: string, eventIds: readonly string[]): Promise<Set<string>>;
  upsertMapping(tenantId: string, pipelineId: string, row: MapRow): Promise<void>;
  deleteMapping(pipelineId: string, sourceEventId: string): Promise<void>;
  /** Zuordnung behalten (Zieltermin existiert weiter), aber als aus dem Fenster gefallen markieren */
  archiveMapping(pipelineId: string, sourceEventId: string): Promise<void>;
  /** Graph hat "dieselbe Person" bestätigt (Zeitpunkt + Merkmal, nie der Wert) */
  markIdentityVerified(tenantId: string, pipelineId: string, attribute: string): Promise<void>;
  /** deltaLink/Fensterbeginn setzen; synced = true → last_synced_at = now(), last_sync_error = errorCode */
  saveSyncState(tenantId: string, pipelineId: string, s: {
    deltaLink: string | null; deltaStartedAt: Date | null; synced: boolean; errorCode?: string | null; effectiveMode?: "busy" | "full";
  }): Promise<void>;
  setSyncError(tenantId: string, pipelineId: string, code: string | null): Promise<void>;
  setPipelineStatus(tenantId: string, pipelineId: string, status: "blocked_scope" | "config_error" | "error"): Promise<void>;
}

/** Dashboard-sichtbarer Status nach endgültigem Fehler */
const TERMINAL_STATUS: Record<string, "blocked_scope" | "config_error" | "error"> = {
  blocked_scope: "blocked_scope", config: "config_error", invalid_request: "error", exhausted: "error",
};

export interface SyncAlert {
  tenantId: string;
  pipelineId: string;
  category: FailureCategory | "target_not_allowed" | "identity_unverified" | "foreign_event";
  reason: string;
}

export interface SyncDeps {
  queue: Pick<DelayedJobQueue, "claimDue" | "complete" | "reschedule" | "fail">;
  repo: SyncRepo;
  tokens: GraphTokenSource;
  /** Google-Ziele (DWD, keyless); fehlt es, gelten Google-Ziele als nicht konfiguriert (config_error) */
  googleTokens?: GoogleTokenSource;
  fetchFn: FetchLike;
  allowlist: SyncAllowlist;
  workerId: string;
  alert: (a: SyncAlert) => Promise<void> | void;
  /** strukturierte Zeilen – nur Zähler und Codes */
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  random?: () => number;
  options?: Partial<SyncOptions>;
}

export interface SyncOptions {
  /** Fenster rückwärts/vorwärts ab jetzt */
  pastMs: number;
  futureMs: number;
  /** danach wird das Fenster mit einem frischen Delta neu aufgespannt (calendarView-Delta hat ein festes Fenster) */
  rewindowAfterMs: number;
  /** showAs=tentative als belegt übertragen (Default aus) */
  includeTentative: boolean;
  pageSize: number;
  maxPages: number;
  /** Zeitbudget je Lauf; danach Abbruch ohne Fortschritt zu speichern, Wiederholung mit Backoff */
  runBudgetMs: number;
  /** Sync-Lease je Pipeline (sollte ≥ runBudgetMs sein) */
  leaseMs: number;
  requestTimeoutMs: number;
  /** wartet ein zweiter Job auf die Lease, kommt er nach dieser Zeit wieder */
  leaseBusyDelayMs: number;
  /** account: "dieselbe Person" spätestens nach dieser Zeit erneut per Graph prüfen */
  identityMaxAgeMs: number;
}

const DAY = 24 * 60 * 60_000;
export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  pastMs: DAY, futureMs: 90 * DAY, rewindowAfterMs: DAY, includeTentative: false, pageSize: 100, maxPages: 500,
  runBudgetMs: 8 * 60_000, leaseMs: 10 * 60_000, requestTimeoutMs: 20_000, leaseBusyDelayMs: 30_000,
  identityMaxAgeMs: DAY,
};

export type SyncOutcome = "synced" | "dropped" | "stopped" | "busy" | "rescheduled" | "failed";

// GraphCallError (unerwarteter Provider-Status; body nur klassifiziert, nie gespeichert/geloggt) und RunAborted
// (Checkpoint-Abbruch) liegen in syncErrors.ts und werden hier re-exportiert.
export { GraphCallError, GoogleCallError, GoogleAuthError, ForeignEventError, RunAborted } from "./syncErrors.js";
/** Pipeline nicht mehr aktiv / Ziel geändert – sofort aufhören, nichts mehr aufrufen */
class PipelineStopped extends RunAborted {}
class RunBudgetExceeded extends RunAborted {}
/** SIGTERM: laufenden Abgleich am nächsten Checkpoint beenden und sofort neu einstellen (Lease wird freigegeben) */
class ShuttingDown extends RunAborted {}
/** Graph sagt: Zielpostfach gehört nicht derselben Person (oder Merkmal leer) – nie schreiben */
class IdentityRejected extends Error {}

// ---------------------------------------------------------------------------------------------------
// Graph-Termin → Zielblock (rein funktional)
// ---------------------------------------------------------------------------------------------------
interface GraphDateTime { dateTime?: unknown; timeZone?: unknown }
export interface GraphEvent {
  id?: unknown;
  "@removed"?: unknown;
  isCancelled?: unknown;
  showAs?: unknown;
  isAllDay?: unknown;
  sensitivity?: unknown;
  type?: unknown;
  changeKey?: unknown;
  transactionId?: unknown;
  start?: GraphDateTime;
  end?: GraphDateTime;
  subject?: unknown;
  location?: { displayName?: unknown };
}

export interface TargetBlock {
  start: Date;
  end: Date;
  isAllDay: boolean;
  changeKey: string | null;
  /** Request-Body für POST/PATCH (ohne Markierungen) */
  body: Record<string, unknown>;
}

const UTC_ZONES = new Set(["utc", "etc/utc", "tzone://microsoft/utc", "coordinated universal time", "gmt", "etc/gmt"]);
const DT = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.\d+)?(Z)?$/;

/** Graph liefert mit Prefer outlook.timezone="UTC" lokale Zeiten in UTC; andere Zonen lehnen wir ab (null) */
function parseUtc(v: GraphDateTime | undefined): { date: string; time: string; at: Date } | null {
  if (!v || typeof v.dateTime !== "string") return null;
  const tz = typeof v.timeZone === "string" ? v.timeZone.toLowerCase() : "utc";
  if (!UTC_ZONES.has(tz)) return null;
  const m = DT.exec(v.dateTime);
  if (!m) return null;
  const at = new Date(`${m[1]}T${m[2]}Z`);
  return Number.isNaN(at.getTime()) ? null : { date: m[1], time: m[2], at };
}

const clamp = (s: unknown, n: number): string | null => (typeof s === "string" && s.trim() !== "" ? s.trim().slice(0, n) : null);

export function eventToBlock(e: GraphEvent, o: { mode: "busy" | "full"; busyLabel: string | null; includeTentative: boolean }): TargetBlock | null {
  const showAs = typeof e.showAs === "string" ? e.showAs : "";
  if (!(showAs === "busy" || showAs === "oof" || (o.includeTentative && showAs === "tentative"))) return null;
  const s = parseUtc(e.start);
  const en = parseUtc(e.end);
  if (!s || !en) return null;
  const isAllDay = e.isAllDay === true;
  let start: Date, end: Date, startDt: string, endDt: string;
  if (isAllDay) {
    // Ganztägig: Datum zählt, nicht die Uhrzeit (Outlook speichert ganztägige Termine "schwebend")
    start = new Date(`${s.date}T00:00:00Z`);
    end = new Date(`${en.date}T00:00:00Z`);
    if (end <= start) end = new Date(start.getTime() + DAY);
    startDt = `${s.date}T00:00:00`;
    endDt = `${end.toISOString().slice(0, 10)}T00:00:00`;
  } else {
    start = s.at;
    end = en.at;
    if (end <= start) return null; // Null-Dauer belegt nichts
    startDt = `${s.date}T${s.time}`;
    endDt = `${en.date}T${en.time}`;
  }
  const privateEvent = e.sensitivity === "private" || e.sensitivity === "confidential" || e.sensitivity === "personal";
  const copyDetails = o.mode === "full" && !privateEvent;
  const body: Record<string, unknown> = {
    subject: (copyDetails ? clamp(e.subject, 255) : null) ?? o.busyLabel ?? DEFAULT_BUSY_LABEL,
    showAs: copyDetails ? showAs : "busy",
    isAllDay,
    start: { dateTime: startDt, timeZone: "UTC" },
    end: { dateTime: endDt, timeZone: "UTC" },
    isReminderOn: false,
  };
  if (copyDetails) {
    const loc = clamp(e.location?.displayName, 255);
    if (loc) body.location = { displayName: loc };
  }
  return { start, end, isAllDay, changeKey: typeof e.changeKey === "string" ? e.changeKey : null, body };
}

/** Nicht umkehrbarer Bezug Zieltermin → (Pipeline, Quelltermin); steht als Extended Property am Zieltermin */
export function sourceRef(pipelineId: string, sourceEventId: string): string {
  return createHash("sha256").update(`${pipelineId}\u0000${sourceEventId}`).digest("hex").slice(0, 40);
}

/** Deterministische transactionId (GUID-Form, Präfix TX_PREFIX) – gleicher Stand des Quelltermins = gleiche ID */
export function transactionIdFor(pipelineId: string, sourceEventId: string, changeKey: string | null): string {
  const h = createHash("sha256").update(`${pipelineId}\u0000${sourceEventId}\u0000${changeKey ?? ""}`).digest("hex");
  return `${TX_PREFIX}${h.slice(0, 2)}-${h.slice(2, 6)}-${h.slice(6, 10)}-${h.slice(10, 14)}-${h.slice(14, 26)}`;
}

/** Nur Graph-v1.0-URLs folgen (nextLink/deltaLink kommen aus Antworten bzw. der DB – kein SSRF über Links) */
function safeGraphLink(v: unknown): string | null {
  if (typeof v !== "string" || !v.startsWith(`${GRAPH_BASE}/`)) return null;
  try {
    const u = new URL(v);
    return u.origin === "https://graph.microsoft.com" && !u.username && !u.password ? v : null;
  } catch {
    return null;
  }
}

/**
 * Graph-Aufruf mit Pflicht-Checkpoint VOR jedem Versuch (auch vor der Wiederholung nach 401) und Token des
 * jeweiligen Entra-Mandanten. Gemeinsam für Sync- und Bereinigungs-Worker.
 */
export function createGraphCaller(
  tokens: GraphTokenSource,
  fetchFn: FetchLike,
  tenantId: string,
  timeoutMs: number,
  checkpoint: () => Promise<void>,
): GraphCaller {
  return async (method, url, body, entraTenantId, prefer) => {
    const once = async () => {
      await checkpoint();
      const token = await tokens.getGraphToken(tenantId, entraTenantId);
      const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (prefer) headers.Prefer = prefer;
      const res = await fetchFn(url, {
        method, headers, body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get("Retry-After") };
    };
    const first = await once();
    if (first.status !== 401) return first;
    tokens.invalidateGraphToken(tenantId, entraTenantId);
    return once();
  };
}

// ---------------------------------------------------------------------------------------------------
// Ziel-Schreiber
// ---------------------------------------------------------------------------------------------------
export type GraphCaller = (method: string, url: string, body: Record<string, unknown> | undefined, entraTenantId: string | null, prefer?: string) =>
  Promise<{ status: number; text: string; retryAfter: string | null }>;

export interface TargetWriter {
  readonly kind: "graph" | "google" | "booking";
  /** Liefert die ID des Zieltermins (booking: null) */
  create(block: TargetBlock, ref: string, transactionId: string): Promise<string | null>;
  update(targetEventId: string, block: TargetBlock): Promise<"ok" | "gone">;
  /** 404 = schon weg = erledigt */
  delete(targetEventId: string): Promise<void>;
  /** Wiederfinden einer begonnenen Anlage über die Extended Property */
  findByRef(ref: string): Promise<string | null>;
}

const IMMUTABLE = 'IdType="ImmutableId"';

/** Schreibt in /users/{mailbox}/events – Postfach kommt ausschließlich aus dem geprüften Ziel */
export class GraphCalendarWriter implements TargetWriter {
  readonly kind = "graph" as const;
  private readonly base: string;
  constructor(private readonly call: GraphCaller, mailbox: string, private readonly entraTenantId: string | null) {
    this.base = `${GRAPH_BASE}/users/${encodeURIComponent(mailbox)}/events`;
  }

  async create(block: TargetBlock, ref: string, transactionId: string): Promise<string> {
    const r = await this.call("POST", this.base, {
      ...block.body,
      transactionId,
      singleValueExtendedProperties: [{ id: SOURCE_REF_PROPERTY_ID, value: ref }],
    }, this.entraTenantId, IMMUTABLE);
    if (r.status !== 201 && r.status !== 200) throw new GraphCallError(r.status, r.text, r.retryAfter);
    const id = (JSON.parse(r.text) as { id?: unknown }).id;
    if (typeof id !== "string" || id === "") throw new GraphCallError(502, "", null);
    return id;
  }

  async update(targetEventId: string, block: TargetBlock): Promise<"ok" | "gone"> {
    const r = await this.call("PATCH", `${this.base}/${encodeURIComponent(targetEventId)}`, block.body, this.entraTenantId, IMMUTABLE);
    if (r.status === 404) return "gone"; // im Ziel gelöscht → neu anlegen
    if (r.status !== 200) throw new GraphCallError(r.status, r.text, r.retryAfter);
    return "ok";
  }

  async delete(targetEventId: string): Promise<void> {
    const r = await this.call("DELETE", `${this.base}/${encodeURIComponent(targetEventId)}`, undefined, this.entraTenantId, IMMUTABLE);
    if (r.status !== 204 && r.status !== 200 && r.status !== 404) throw new GraphCallError(r.status, r.text, r.retryAfter);
  }

  async findByRef(ref: string): Promise<string | null> {
    if (!/^[0-9a-f]{40}$/.test(ref)) return null;
    const filter = `singleValueExtendedProperties/Any(ep: ep/id eq '${SOURCE_REF_PROPERTY_ID}' and ep/value eq '${ref}')`;
    const r = await this.call("GET", `${this.base}?$filter=${encodeURIComponent(filter)}&$select=id&$top=1`, undefined, this.entraTenantId, IMMUTABLE);
    if (r.status !== 200) throw new GraphCallError(r.status, r.text, r.retryAfter);
    const id = (JSON.parse(r.text) as { value?: Array<{ id?: unknown }> }).value?.[0]?.id;
    return typeof id === "string" ? id : null;
  }
}

/** Buchungsseite: nur die Zuordnung (Zeiten) wird gespeichert; kein Provider-Aufruf */
export class BookingWriter implements TargetWriter {
  readonly kind = "booking" as const;
  async create(): Promise<null> { return null; }
  async update(): Promise<"ok"> { return "ok"; }
  async delete(): Promise<void> {}
  async findByRef(): Promise<null> { return null; }
}

// ---------------------------------------------------------------------------------------------------
// Worker
// ---------------------------------------------------------------------------------------------------
export interface SyncStats {
  pages: number;
  created: number;
  updated: number;
  deleted: number;
  unchanged: number;
  loopSkipped: number;
  rejected: number;
  pruned: number;
  archived: number;
  resets: number;
  /** Google: Termin unter unserer bzw. gespeicherter ID trägt nicht unsere Markierung – nie angefasst */
  foreign: number;
}

interface Run {
  job: Job<SyncPayload>;
  tenantId: string;
  pipelineId: string;
  ctx: SyncContext;
  target: ResolvedTarget;
  writer: TargetWriter;
  stats: SyncStats;
  deadline: number;
  /** tatsächlich geschriebener Modus (full → busy, wenn das Team full nicht erlaubt) */
  mode: "busy" | "full";
  /** Modus hat sich gegenüber dem letzten Lauf geändert → alle Zieltermine einmal neu schreiben */
  forceRewrite: boolean;
}

const alive = (c: SyncContext | null): c is SyncContext => c !== null && c.status === "active" && c.ownerActive && !!c.ownerEntraObjectId;
const sameTarget = (a: ResolvedTarget, b: ResolvedTarget) =>
  a.kind === b.kind && a.mailbox === b.mailbox && (a.entraTenantId ?? null) === (b.entraTenantId ?? null) && (a.ref ?? null) === (b.ref ?? null)
  && (a.provider ?? "microsoft") === (b.provider ?? "microsoft") && (a.workspaceId ?? null) === (b.workspaceId ?? null);

/** Entscheidung für einen Provider-Fehler: Google-Aufrufe nach Googles Format, alles andere nach Graph */
export function classifyProviderError(err: GraphCallError, ctx: Parameters<typeof classifyGraphError>[1]): ErrorDecision {
  if (err instanceof GoogleCallError) {
    return classifyGoogleError({ status: err.status, body: err.body, retryAfter: err.retryAfter,
      ...(err instanceof GoogleAuthError ? { authStage: err.stage, authCode: err.code } : {}) }, ctx);
  }
  return classifyGraphError({ status: err.status, body: err.body, retryAfter: err.retryAfter }, ctx);
}

export class SyncWorker {
  private stopping = false;
  private inflight = new Set<Promise<unknown>>();
  private readonly o: SyncOptions;

  constructor(private readonly d: SyncDeps) {
    this.o = { ...DEFAULT_SYNC_OPTIONS, ...(d.options ?? {}) };
  }

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  stop(): void {
    this.stopping = true;
  }

  async drained(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  async tick(limit = 5, leaseMs = this.o.leaseMs): Promise<Record<SyncOutcome, number> & { claimed: number }> {
    const r = { claimed: 0, synced: 0, dropped: 0, stopped: 0, busy: 0, rescheduled: 0, failed: 0 };
    if (this.stopping) return r;
    const jobs = await this.d.queue.claimDue(this.d.workerId, limit, leaseMs, [SYNC_KIND]);
    r.claimed = jobs.length;
    const run = Promise.allSettled(jobs.map((j) => this.process(j as Job<SyncPayload>)));
    this.inflight.add(run);
    try {
      for (const s of await run) {
        if (s.status === "fulfilled") r[s.value] += 1;
        else r.failed += 1; // DB-Ausfall: Lease läuft ab, Job kommt zurück
      }
    } finally {
      this.inflight.delete(run);
    }
    return r;
  }

  /** Job zurückstellen; existiert schon ein wartender Job derselben Pipeline (dedupe), übernimmt der */
  private async reschedule(job: Job<SyncPayload>, delayMs: number, payload: SyncPayload, reason: string): Promise<void> {
    try {
      await this.d.queue.reschedule(job.id, this.d.workerId, delayMs, payload, reason);
    } catch {
      await this.d.queue.complete(job.id, this.d.workerId);
    }
  }

  private async process(job: Job<SyncPayload>): Promise<SyncOutcome> {
    const { queue, workerId, repo } = this.d;
    const pipelineId = typeof job.payload?.pipelineId === "string" ? job.payload.pipelineId : "";
    const payload: SyncPayload = { pipelineId, full: job.payload?.full === true, attempts: job.payload?.attempts ?? {} };
    const ctx = pipelineId ? await repo.getSyncContext(job.tenantId, pipelineId) : null;

    // Offboarding/Pause hat Vorrang: kein einziger Provider-Aufruf
    if (!alive(ctx)) {
      await queue.complete(job.id, workerId);
      return "dropped";
    }
    if (ctx.target.kind === null) {
      // Altbestand vor 007: kein Ziel gewählt → nichts zu tun, sichtbar im Dashboard
      await repo.setSyncError(job.tenantId, pipelineId, "target_missing");
      await queue.complete(job.id, workerId);
      return "dropped";
    }
    // Zweite Prüfung der Allowlist (die erste macht die API bei der Anlage)
    const check = recheckStoredTarget(this.d.allowlist, ctx.ownerUserName, ctx.target);
    if (!check.ok) {
      const reason = `target_not_allowed:${check.reason}`;
      await queue.fail(job.id, workerId, reason);
      await repo.setPipelineStatus(job.tenantId, pipelineId, "config_error");
      await repo.setSyncError(job.tenantId, pipelineId, "target_not_allowed");
      await this.d.alert({ tenantId: job.tenantId, pipelineId, category: "target_not_allowed", reason });
      return "failed";
    }

    const workspace = googleWorkspaceFor(this.d.allowlist, check.target);
    if (check.target.provider === "google" && (!workspace || !this.d.googleTokens)) {
      // Google-Ziel erlaubt, aber kein Token-Provider (googleWorkloadIdentity fehlt) → nichts aufrufen
      const reason = "google_not_configured";
      await queue.fail(job.id, workerId, reason);
      await repo.setPipelineStatus(job.tenantId, pipelineId, "config_error");
      await repo.setSyncError(job.tenantId, pipelineId, "config");
      await this.d.alert({ tenantId: job.tenantId, pipelineId, category: "config", reason });
      return "failed";
    }

    if (!(await repo.acquireSyncLease(job.tenantId, pipelineId, job.id, this.o.leaseMs))) {
      await this.reschedule(job, this.o.leaseBusyDelayMs, payload, "sync_lease_busy");
      return "busy";
    }

    const target = check.target;
    // full in einen Team-Kalender nur mit allowFullMode; sonst inhaltsfrei schreiben (nie Inhalte)
    const mode = ctx.mode === "full" && !fullModeAllowed(this.d.allowlist, target) ? "busy" : ctx.mode;
    const run: Run = {
      job, tenantId: job.tenantId, pipelineId, ctx, target, mode,
      forceRewrite: (ctx.effectiveMode ?? null) !== null && ctx.effectiveMode !== mode,
      writer: target.kind === "booking" ? new BookingWriter()
        : workspace ? new GoogleCalendarWriter(this.googleCaller(job.tenantId, pipelineId, ctx, target, workspace.serviceAccountEmail), target.mailbox ?? "")
        : new GraphCalendarWriter(this.caller(job.tenantId, pipelineId, ctx, target), target.mailbox ?? "", target.entraTenantId),
      stats: { pages: 0, created: 0, updated: 0, deleted: 0, unchanged: 0, loopSkipped: 0, rejected: 0, pruned: 0, archived: 0, resets: 0, foreign: 0 },
      deadline: this.now().getTime() + this.o.runBudgetMs,
    };
    try {
      if (target.kind === "account") await this.ensureIdentity(run);
      await this.sync(run, payload.full);
      await queue.complete(job.id, workerId);
      if (run.stats.foreign > 0) {
        // Fremder Termin unter einer CalenSync-ID: nichts geändert/gelöscht, aber ein Admin soll es sich ansehen
        await this.d.alert({ tenantId: job.tenantId, pipelineId, category: "foreign_event", reason: `foreign_event:${run.stats.foreign}` });
      }
      this.d.log?.({ level: "info", msg: "sync_done", pipelineId, target: target.kind, provider: target.provider ?? "microsoft", full: payload.full, ...run.stats });
      return "synced";
    } catch (err) {
      if (err instanceof ShuttingDown) {
        await this.reschedule(job, 5_000, payload, "worker_shutdown");
        return "rescheduled";
      }
      if (err instanceof PipelineStopped) {
        await queue.complete(job.id, workerId);
        this.d.log?.({ level: "info", msg: "sync_stopped", pipelineId, ...run.stats });
        return "stopped";
      }
      if (err instanceof IdentityRejected) {
        // Nicht dieselbe Person (mehr): kein einziger Schreibzugriff, sichtbar + Alarm, Admin muss handeln
        const reason = `identity_unverified:${err.message}`;
        await queue.fail(job.id, workerId, reason);
        await this.d.repo.setPipelineStatus(job.tenantId, pipelineId, "config_error");
        await this.d.repo.setSyncError(job.tenantId, pipelineId, "identity_unverified");
        await this.d.alert({ tenantId: job.tenantId, pipelineId, category: "identity_unverified", reason });
        return "failed";
      }
      return this.handleFailure(run, payload, err);
    } finally {
      await repo.releaseSyncLease(job.tenantId, pipelineId, job.id).catch(() => undefined);
    }
  }

  private async handleFailure(run: Run, payload: SyncPayload, err: unknown): Promise<SyncOutcome> {
    const { queue, workerId, repo } = this.d;
    let failure: GraphFailure;
    if (err instanceof GraphCallError) failure = { status: err.status, body: err.body, retryAfter: err.retryAfter };
    else if (err instanceof RunBudgetExceeded) failure = { status: 503, body: "", retryAfter: null };
    // Netzwerk/Timeout/DB: nur der Fehlername (Meldungen können URLs mit IDs enthalten)
    else failure = { status: 0, body: err instanceof Error ? err.name : "error", retryAfter: null };

    const cctx = { now: this.now(), grantedAt: run.ctx.createdAt, attempts: payload.attempts ?? {}, random: this.d.random };
    const decision = err instanceof GraphCallError ? classifyProviderError(err, cctx) : classifyGraphError(failure, cctx);
    this.d.log?.({ level: decision.action === "retry" ? "warn" : "error", msg: "sync_failed", pipelineId: run.pipelineId,
      status: failure.status, category: decision.category, action: decision.action, ...run.stats });

    if (decision.action === "retry") {
      const attempts = { ...(payload.attempts ?? {}), [decision.category]: ((payload.attempts ?? {})[decision.category] ?? 0) + 1 };
      await this.reschedule(run.job, decision.delayMs, { ...payload, attempts }, decision.reason);
      await repo.setSyncError(run.tenantId, run.pipelineId, decision.category);
      return "rescheduled";
    }
    await queue.fail(run.job.id, workerId, decision.reason);
    await repo.setPipelineStatus(run.tenantId, run.pipelineId, TERMINAL_STATUS[decision.category] ?? "error");
    await repo.setSyncError(run.tenantId, run.pipelineId, decision.category);
    await this.d.alert({ tenantId: run.tenantId, pipelineId: run.pipelineId, category: decision.category, reason: decision.reason });
    return "failed";
  }

  /**
   * assert_pipeline_alive: frischer Pipeline-Zustand vor JEDEM Provider-Aufruf. Endet die Pipeline oder ändert
   * sich ihr Ziel/Modus, bricht der Lauf ab (PipelineStopped → Job erledigt, kein Fortschritt gespeichert).
   */
  private async checkpoint(tenantId: string, pipelineId: string, ctx0: SyncContext, target0: ResolvedTarget): Promise<void> {
    if (this.stopping) throw new ShuttingDown("shutdown");
    const c = await this.d.repo.getSyncContext(tenantId, pipelineId);
    if (!alive(c)) throw new PipelineStopped("pipeline_not_alive");
    const chk = recheckStoredTarget(this.d.allowlist, c.ownerUserName, c.target);
    if (!chk.ok || !sameTarget(chk.target, target0) || c.mode !== ctx0.mode || c.busyLabel !== ctx0.busyLabel
        || c.ownerEntraObjectId !== ctx0.ownerEntraObjectId) {
      throw new PipelineStopped("pipeline_changed");
    }
  }

  private caller(tenantId: string, pipelineId: string, ctx: SyncContext, target: ResolvedTarget): GraphCaller {
    return createGraphCaller(this.d.tokens, this.d.fetchFn, tenantId, this.o.requestTimeoutMs,
      () => this.checkpoint(tenantId, pipelineId, ctx, target));
  }

  private googleCaller(tenantId: string, pipelineId: string, ctx: SyncContext, target: ResolvedTarget, serviceAccountEmail: string): GoogleCaller {
    return createGoogleCaller(this.d.googleTokens as GoogleTokenSource, this.d.fetchFn, serviceAccountEmail, this.o.requestTimeoutMs,
      () => this.checkpoint(tenantId, pipelineId, ctx, target));
  }

  /**
   * account: "dieselbe Person" per Graph – vor dem ersten Schreiben, nach Wechsel des Merkmals und spätestens
   * alle identityMaxAgeMs. Jeder Aufruf läuft über den Checkpoint (Pipeline noch aktiv?).
   */
  private async ensureIdentity(run: Run): Promise<void> {
    const attribute = run.target.identityAttribute ?? "employeeId";
    if (attribute === "localPart") return; // Opt-in ohne Graph (syncTargets.ts)
    const at = run.ctx.identityVerifiedAt ?? null;
    if (at && run.ctx.identityAttribute === attribute && this.now().getTime() - at.getTime() < this.o.identityMaxAgeMs) return;
    const graph = this.caller(run.tenantId, run.pipelineId, run.ctx, run.target);
    const ws = googleWorkspaceFor(this.d.allowlist, run.target);
    const verdict = ws
      // Google: Directory API (Subjekt = directoryAdminSubject, nur Lesen) gegen Graph-employeeId des Inhabers
      ? await verifyGoogleIdentity(graph, this.googleCaller(run.tenantId, run.pipelineId, run.ctx, run.target, ws.serviceAccountEmail), {
        ownerObjectId: run.ctx.ownerEntraObjectId ?? "", mailbox: run.target.mailbox ?? "",
        directoryAdminSubject: ws.directoryAdminSubject ?? null, attribute: "employeeId",
      })
      : await verifyIdentity(graph, {
        ownerObjectId: run.ctx.ownerEntraObjectId ?? "", mailbox: run.target.mailbox ?? "", entraTenantId: run.target.entraTenantId, attribute,
      });
    if (verdict.kind === "unavailable") throw new GraphCallError(verdict.status, verdict.body, verdict.retryAfter);
    if (verdict.kind === "rejected") throw new IdentityRejected(verdict.why);
    await this.d.repo.markIdentityVerified(run.tenantId, run.pipelineId, attribute);
  }

  private initialDeltaUrl(ctx: SyncContext, now: Date): string {
    const start = new Date(now.getTime() - this.o.pastMs).toISOString();
    const end = new Date(now.getTime() + this.o.futureMs).toISOString();
    return `${GRAPH_BASE}/users/${encodeURIComponent(ctx.ownerEntraObjectId ?? "")}/calendarView/delta`
      + `?startDateTime=${encodeURIComponent(start)}&endDateTime=${encodeURIComponent(end)}`;
  }

  private async sync(run: Run, full: boolean): Promise<void> {
    const { repo } = this.d;
    const now = this.now();
    const read = this.caller(run.tenantId, run.pipelineId, run.ctx, run.target);
    const prefer = `odata.maxpagesize=${this.o.pageSize}, outlook.timezone="UTC", ${IMMUTABLE}`;
    const stored = safeGraphLink(run.ctx.deltaLink);
    const stale = !run.ctx.deltaStartedAt || now.getTime() - run.ctx.deltaStartedAt.getTime() > this.o.rewindowAfterMs;
    let fresh = full || !stored || stale || run.forceRewrite;
    let url = fresh ? this.initialDeltaUrl(run.ctx, now) : (stored as string);
    let windowStart = new Date(now.getTime() - this.o.pastMs);
    const seen = new Set<string>();
    let deltaLink: string | null = null;

    for (let page = 0; ; page++) {
      if (page >= this.o.maxPages || this.now().getTime() > run.deadline) throw new RunBudgetExceeded();
      const r = await read("GET", url, undefined, null, prefer);
      if (r.status === 410 || (r.status === 400 && /syncStateNotFound|syncStateInvalid|resyncRequired/i.test(r.text))) {
        // Delta-Zustand bei Microsoft verfallen → einmal frisch beginnen (voller Abgleich mit Bereinigung)
        if (run.stats.resets >= 1) throw new GraphCallError(r.status, r.text, r.retryAfter);
        run.stats.resets += 1;
        await repo.saveSyncState(run.tenantId, run.pipelineId, { deltaLink: null, deltaStartedAt: null, synced: false });
        fresh = true;
        seen.clear();
        windowStart = new Date(this.now().getTime() - this.o.pastMs);
        url = this.initialDeltaUrl(run.ctx, this.now());
        continue;
      }
      if (r.status !== 200) throw new GraphCallError(r.status, r.text, r.retryAfter);
      run.stats.pages += 1;
      const body = JSON.parse(r.text) as { value?: unknown; "@odata.nextLink"?: unknown; "@odata.deltaLink"?: unknown };
      await this.applyPage(run, Array.isArray(body.value) ? (body.value as GraphEvent[]) : [], seen);
      const next = safeGraphLink(body["@odata.nextLink"]);
      if (next) {
        url = next;
        continue;
      }
      deltaLink = safeGraphLink(body["@odata.deltaLink"]);
      if (!deltaLink) throw new GraphCallError(502, "", null); // weder nextLink noch deltaLink: Antwort unbrauchbar
      break;
    }

    // Frisches Delta = vollständiges Bild des Fensters: Zuordnungen, die nicht mehr vorkamen, sind gelöscht
    // (im Fenster → Zieltermin löschen) oder aus dem Fenster gefallen (Vergangenheit → ARCHIVIEREN: der Zieltermin
    // bleibt stehen, seine ID bleibt für die Bereinigung erhalten). Archivierte werden nie neu angelegt/gelöscht.
    if (fresh) {
      for (const row of await repo.listMappings(run.pipelineId)) {
        if (seen.has(row.sourceEventId)) continue;
        if (row.archived) {
          if (run.forceRewrite && row.targetEventId && run.writer.kind !== "booking") await this.rewriteArchived(run, row.targetEventId);
          continue;
        }
        if (row.endAt.getTime() < windowStart.getTime()) {
          if (run.writer.kind === "booking") {
            await repo.deleteMapping(run.pipelineId, row.sourceEventId); // Buchungsseite: es gibt keinen Zieltermin
            run.stats.pruned += 1;
          } else {
            if (run.forceRewrite && row.targetEventId) await this.rewriteArchived(run, row.targetEventId);
            await repo.archiveMapping(run.pipelineId, row.sourceEventId);
            run.stats.archived += 1;
          }
        } else {
          await this.removeBlock(run, row.sourceEventId, row);
        }
      }
    }
    const downgraded = run.mode !== run.ctx.mode;
    await repo.saveSyncState(run.tenantId, run.pipelineId, {
      deltaLink, deltaStartedAt: fresh ? now : run.ctx.deltaStartedAt, synced: true, effectiveMode: run.mode,
      errorCode: run.stats.rejected > 0 ? "event_rejected" : downgraded ? "full_mode_not_allowed" : null,
    });
  }

  /** Modus-Wechsel full → busy: vergangene (archivierte) Zieltermine inhaltsfrei überschreiben (ohne Zeiten) */
  private async rewriteArchived(run: Run, targetEventId: string): Promise<void> {
    const body = { subject: run.ctx.busyLabel ?? DEFAULT_BUSY_LABEL, showAs: "busy", location: { displayName: "" } };
    await run.writer.update(targetEventId, { start: new Date(0), end: new Date(0), isAllDay: false, changeKey: null, body });
  }

  private async applyPage(run: Run, page: GraphEvent[], seen: Set<string>): Promise<void> {
    // Graph: dieselbe Ressource kann in einer Delta-Antwort mehrfach vorkommen – maßgeblich ist das letzte
    // Vorkommen. Ohne Zusammenfassung würden zwei POSTs zwei Zieltermine anlegen (einer verwaist).
    const last = new Map<string, GraphEvent>();
    for (const e of page) {
      if (typeof e.id !== "string" || e.id === "") continue;
      last.delete(e.id);
      last.set(e.id, e);
    }
    const events = [...last.values()];
    const ids = [...last.keys()];
    if (ids.length === 0) return;
    const loops = await this.d.repo.findCalensyncTargetIds(run.tenantId, ids);
    const maps = await this.d.repo.getMappings(run.pipelineId, ids);
    for (const e of events) {
      if (typeof e.id !== "string" || e.id === "") continue;
      seen.add(e.id);
      if (this.now().getTime() > run.deadline) throw new RunBudgetExceeded();
      // Schleifenschutz: selbst angelegte Zieltermine (dieser oder einer anderen Pipeline) nie übertragen
      if (loops.has(e.id) || (typeof e.transactionId === "string" && e.transactionId.toLowerCase().startsWith(TX_PREFIX))) {
        run.stats.loopSkipped += 1;
        continue;
      }
      const row = maps.get(e.id) ?? null;
      if (e["@removed"] !== undefined || e.isCancelled === true || e.type === "seriesMaster") {
        if (row) await this.removeBlock(run, e.id, row);
        continue;
      }
      const block = eventToBlock(e, { mode: run.mode, busyLabel: run.ctx.busyLabel, includeTentative: this.o.includeTentative });
      if (!block) {
        if (row) await this.removeBlock(run, e.id, row); // z. B. busy → free
        continue;
      }
      await this.upsertBlock(run, e.id, block, row);
    }
  }

  private async removeBlock(run: Run, sourceEventId: string, row: MapRow): Promise<void> {
    if (run.writer.kind !== "booking") {
      const id = row.targetEventId ?? (await run.writer.findByRef(sourceRef(run.pipelineId, sourceEventId)));
      try {
        if (id) await run.writer.delete(id);
      } catch (err) {
        if (!(err instanceof ForeignEventError)) throw err;
        // nie einen fremden Termin löschen; Zuordnung vergessen (event_rejected + Alarm am Ende des Laufs)
        run.stats.rejected += 1;
        run.stats.foreign += 1;
      }
    }
    await this.d.repo.deleteMapping(run.pipelineId, sourceEventId);
    run.stats.deleted += 1;
  }

  private async upsertBlock(run: Run, sourceEventId: string, block: TargetBlock, row: MapRow | null): Promise<void> {
    const { repo } = this.d;
    const confirmed = row !== null && (run.writer.kind === "booking" || row.targetEventId !== null);
    if (confirmed && !row.archived && !run.forceRewrite && row.changeKey !== null && row.changeKey === block.changeKey
        && row.startAt.getTime() === block.start.getTime() && row.endAt.getTime() === block.end.getTime()) {
      run.stats.unchanged += 1;
      return;
    }
    const mapRow = (targetEventId: string | null, changeKey: string | null): MapRow =>
      ({ sourceEventId, targetEventId, changeKey, startAt: block.start, endAt: block.end });

    if (run.writer.kind === "booking") {
      await repo.upsertMapping(run.tenantId, run.pipelineId, mapRow(null, block.changeKey));
      if (row) run.stats.updated += 1;
      else run.stats.created += 1;
      return;
    }

    const ref = sourceRef(run.pipelineId, sourceEventId);
    let creating = false;
    try {
      // Begonnene, unbestätigte Anlage (Absturz zwischen POST und Speichern)? Erst suchen, dann ggf. anlegen.
      let targetId = row ? (row.targetEventId ?? (await run.writer.findByRef(ref))) : null;
      // Wechsel full → busy: einen früher kopierten Ort ausdrücklich leeren (PATCH ändert nur genannte Felder)
      const patch = run.forceRewrite && run.mode === "busy" ? { ...block, body: { ...block.body, location: { displayName: "" } } } : block;
      if (targetId && (await run.writer.update(targetId, patch)) === "ok") {
        await repo.upsertMapping(run.tenantId, run.pipelineId, mapRow(targetId, block.changeKey));
        run.stats.updated += 1;
        return;
      }
      // "Anlage begonnen" VOR dem POST festhalten (changeKey NULL → nie als unverändert übersprungen)
      await repo.upsertMapping(run.tenantId, run.pipelineId, mapRow(null, null));
      creating = true;
      targetId = await run.writer.create(block, ref, transactionIdFor(run.pipelineId, sourceEventId, block.changeKey));
      await repo.upsertMapping(run.tenantId, run.pipelineId, mapRow(targetId, block.changeKey));
      run.stats.created += 1;
    } catch (err) {
      // Ein einzelner vom Ziel abgelehnter Termin (400/422) blockiert nicht die ganze Pipeline
      // (nicht die Token-Kette: deren 400 – z. B. invalid_grant – betrifft die ganze Pipeline, nicht einen Termin)
      if (err instanceof GraphCallError && !(err instanceof GoogleAuthError) && (err.status === 400 || err.status === 422)) {
        run.stats.rejected += 1;
        if (err instanceof ForeignEventError) run.stats.foreign += 1;
        // abgelehnte Anlage: nichts angelegt → Markierung entfernen (nächste Änderung versucht es erneut)
        if (creating) await repo.deleteMapping(run.pipelineId, sourceEventId);
        return;
      }
      throw err;
    }
  }
}

// ---------------------------------------------------------------------------------------------------
// Scheduler: regelmäßiger Abgleich auch ohne Webhook (Fenster wandert, Erst-Sync nach dem Deployment)
// ---------------------------------------------------------------------------------------------------
export interface SyncScheduleRepo {
  /** Stellt delta_sync-Jobs für aktive Pipelines mit Ziel ein, deren letzter Abgleich älter als staleMs ist */
  scheduleDueSyncs(staleMs: number, spreadMs: number, limit: number): Promise<number>;
}

export class SyncScheduler {
  constructor(
    private readonly repo: SyncScheduleRepo,
    private readonly o: { staleMs?: number; spreadMs?: number; limit?: number } = {},
  ) {}

  tick(): Promise<number> {
    return this.repo.scheduleDueSyncs(this.o.staleMs ?? 12 * 60 * 60_000, this.o.spreadMs ?? 30 * 60_000, this.o.limit ?? 1_000);
  }
}
