/**
 * Fehlerbehandlung für Graph-Aufrufe im Pipeline-Handshake (Subscription anlegen, erster Delta-Sync).
 *
 * Problem: Ein per SCIM frisch angelegter User wird über die Sicherheitsgruppe in den Exchange-RBAC-Scope
 * aufgenommen. Exchange Online cached diese Berechtigungen 30 min bis 2 h. In dieser Zeit liefert Graph
 * 403 ErrorAccessDenied – obwohl alles korrekt konfiguriert ist. Ebenso 404, solange das Postfach nach der
 * Lizenzzuweisung noch nicht angelegt ist.
 *
 * Regel:
 *   * 403/404 innerhalb des Propagation-Fensters (Default 8 h ab Freigabe) → Retry nach nominal 30, 60, 120,
 *     240, 240 … min, jeweils ±15 % Jitter (backoff.ts) – entzerrt Onboarding-Wellen
 *   * 403 nach dem Fenster → endgültig "blocked_scope" + Admin-Alarm (Postfach liegt außerhalb des Scopes –
 *     das ist dann gewollt oder ein Konfigurationsfehler, aber kein Replikationsproblem mehr)
 *   * 403 Authorization_RequestDenied → Entra-Berechtigung/Admin-Consent fehlt → sofort "config" + Alarm
 *   * 429 / 5xx / Netzwerk → kurzer exponentieller Backoff, Retry-After wird respektiert
 *   * 400 / sonstige 4xx → endgültig, Alarm (Fehler auf unserer Seite)
 *
 * Kein Fall blockiert andere Pipelines: der Job wird mit run_at in die Zukunft zurückgestellt, die Queue
 * arbeitet die übrigen Jobs weiter ab (kein Head-of-Line-Blocking).
 */
import { SCOPE_PROPAGATION, TRANSIENT, backoffDelayMs, respectRetryAfter } from "./backoff.js";

export interface GraphFailure {
  /** 0 = Netzwerk/Timeout */
  status: number;
  body: string;
  retryAfter: string | null;
}

export type FailureCategory = "scope_propagation" | "transient" | "token" | "blocked_scope" | "config" | "invalid_request" | "exhausted";

export type ErrorDecision =
  | { action: "retry"; category: "scope_propagation" | "transient" | "token"; delayMs: number; reason: string }
  | { action: "fail"; category: "blocked_scope" | "config" | "invalid_request" | "exhausted"; reason: string; alert: true };

export interface ClassifyContext {
  now: Date;
  /** Zeitpunkt, ab dem der User im Scope sein SOLLTE (SCIM-Provisionierung bzw. Aufnahme in die Gruppe). */
  grantedAt: Date | null;
  /** Bisherige Versuche je Kategorie (aus dem Job-Payload) */
  attempts: Partial<Record<"scope_propagation" | "transient" | "token", number>>;
  propagationWindowMs?: number;
  random?: () => number;
}

export const DEFAULT_PROPAGATION_WINDOW_MS = 8 * 60 * 60_000;
const MAX_TRANSIENT_ATTEMPTS = 12; // ≈ 4–5 h mit TRANSIENT-Policy
const MAX_TOKEN_ATTEMPTS = 3;

export function parseGraphError(body: string): { code: string; message: string } {
  try {
    const j = JSON.parse(body) as { error?: { code?: unknown; message?: unknown } };
    return { code: String(j.error?.code ?? ""), message: String(j.error?.message ?? "") };
  } catch {
    return { code: "", message: body.slice(0, 200) };
  }
}

function retryAfterMs(v: string | null, now: Date): number {
  if (!v) return 0;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now.getTime());
}

const SCOPE_DENIED_CODES = new Set(["ErrorAccessDenied", "AccessDenied", "ErrorAccessDeniedForMailbox"]);
const MAILBOX_NOT_READY_CODES = new Set(["MailboxNotEnabledForRESTAPI", "MailboxNotFound", "ErrorItemNotFound", "ResourceNotFound", "ErrorNonExistentMailbox"]);

export function classifyGraphError(f: GraphFailure, ctx: ClassifyContext): ErrorDecision {
  const { code, message } = parseGraphError(f.body);
  const tag = `HTTP ${f.status}${code ? ` ${code}` : ""}`;
  const window = ctx.propagationWindowMs ?? DEFAULT_PROPAGATION_WINDOW_MS;
  const inWindow = ctx.grantedAt !== null && ctx.now.getTime() - ctx.grantedAt.getTime() < window;
  const next = (k: "scope_propagation" | "transient" | "token") => (ctx.attempts[k] ?? 0) + 1;

  const propagationRetry = (reason: string): ErrorDecision => ({
    action: "retry",
    category: "scope_propagation",
    delayMs: backoffDelayMs(SCOPE_PROPAGATION, next("scope_propagation"), ctx.random),
    reason,
  });

  // Netzwerk, Drosselung, Serverfehler
  if (f.status === 0 || f.status === 429 || f.status >= 500) {
    const n = next("transient");
    if (n > MAX_TRANSIENT_ATTEMPTS) {
      return { action: "fail", category: "exhausted", reason: `${tag}: ${n - 1} transiente Fehlversuche`, alert: true };
    }
    const delayMs = respectRetryAfter(retryAfterMs(f.retryAfter, ctx.now), backoffDelayMs(TRANSIENT, n, ctx.random), ctx.random);
    return { action: "retry", category: "transient", delayMs, reason: tag };
  }

  if (f.status === 401) {
    const n = next("token");
    if (n > MAX_TOKEN_ATTEMPTS) return { action: "fail", category: "config", reason: `${tag}: App-Token wird wiederholt abgelehnt`, alert: true };
    return { action: "retry", category: "token", delayMs: 5_000 * n, reason: tag };
  }

  if (f.status === 403) {
    // Entra-Ebene: Application Permission fehlt oder Admin-Consent wurde entzogen → wartet nicht auf Replikation
    if (code === "Authorization_RequestDenied" || /insufficient privileges/i.test(message)) {
      return { action: "fail", category: "config", reason: `${tag}: Entra-Berechtigung fehlt (Admin-Consent prüfen)`, alert: true };
    }
    // Exchange-Ebene: RBAC-Scope (bzw. Legacy Application Access Policy) noch nicht repliziert
    if (SCOPE_DENIED_CODES.has(code) || /access to odata is disabled|access is denied/i.test(message) || code === "") {
      if (inWindow) return propagationRetry(`${tag}: Exchange-Scope noch nicht repliziert`);
      return { action: "fail", category: "blocked_scope", reason: `${tag}: Postfach außerhalb des freigegebenen Scopes`, alert: true };
    }
    if (inWindow) return propagationRetry(`${tag}: unbekannter 403-Code im Propagation-Fenster`);
    return { action: "fail", category: "blocked_scope", reason: tag, alert: true };
  }

  if (f.status === 404) {
    if (MAILBOX_NOT_READY_CODES.has(code) || /mailbox/i.test(message)) {
      if (inWindow) return propagationRetry(`${tag}: Postfach noch nicht bereitgestellt`);
      return { action: "fail", category: "config", reason: `${tag}: kein Exchange-Online-Postfach (Lizenz/On-Prem?)`, alert: true };
    }
    return { action: "fail", category: "invalid_request", reason: tag, alert: true };
  }

  return { action: "fail", category: "invalid_request", reason: tag, alert: true };
}

// ---------------------------------------------------------------------------------------------------
// Google (Ziel "account" mit provider google): Calendar API v3, Directory API, Token-Kette
// ---------------------------------------------------------------------------------------------------
export interface GoogleFailure extends GraphFailure {
  /** gesetzt, wenn die Token-Kette scheiterte (core/src/googleAuth.ts) – dann ist body leer */
  authStage?: "aws" | "sts" | "iam" | "oauth" | "config";
  /** OAuth-/Google-Fehlercode der Token-Kette, z. B. unauthorized_client */
  authCode?: string;
}

/** Nur feste Bezeichner übernehmen – Meldungen von Google gehen nie in Reason/Log */
const safeCode = (v: unknown): string => (typeof v === "string" && /^[A-Za-z_]{1,48}$/.test(v) ? v : "");

/** reason aus errors[0].reason bzw. details[].reason (ErrorInfo); nie die Meldung */
export function parseGoogleError(body: string): { reason: string; status: string } {
  try {
    const j = JSON.parse(body) as { error?: { errors?: Array<{ reason?: unknown }>; details?: Array<{ reason?: unknown }>; status?: unknown } };
    const e = j.error && typeof j.error === "object" ? j.error : {};
    const reason = safeCode(e.errors?.[0]?.reason) || safeCode(e.details?.find((d) => safeCode(d?.reason))?.reason);
    return { reason, status: safeCode(e.status) };
  } catch {
    return { reason: "", status: "" };
  }
}

const GOOGLE_RATE_REASONS = new Set(["rateLimitExceeded", "userRateLimitExceeded", "quotaExceeded", "dailyLimitExceeded", "RATE_LIMIT_EXCEEDED"]);
/** API im Google-Cloud-Projekt nicht aktiviert, DWD-Scope fehlt, Domänenrichtlinie verbietet den Zugriff */
const GOOGLE_CONFIG_REASONS = new Set(["accessNotConfigured", "SERVICE_DISABLED", "insufficientPermissions", "ACCESS_TOKEN_SCOPE_INSUFFICIENT", "domainPolicy"]);

/**
 * Wie classifyGraphError, nur mit Googles Fehlerformat:
 *   0 / 429 / 5xx                     transient (Backoff, Retry-After)
 *   401                               token (Cache verworfen, erneuter Versuch), wiederholt → config
 *   403 rateLimitExceeded / userRateLimitExceeded / quotaExceeded → transient mit Backoff
 *   403 accessNotConfigured / insufficientPermissions / domainPolicy … → config (Admin muss handeln)
 *   403 sonst (forbidden …) / 404     im Propagationsfenster Retry, danach blocked_scope
 *   400 / sonstige 4xx                invalid_request
 * Token-Kette: sts/iam/config 4xx → config; oauth unauthorized_client (DWD fehlt) → im Fenster Retry, sonst config;
 * oauth invalid_grant (Nutzer unbekannt/gesperrt) → im Fenster Retry, sonst blocked_scope.
 */
export function classifyGoogleError(f: GoogleFailure, ctx: ClassifyContext): ErrorDecision {
  const window = ctx.propagationWindowMs ?? DEFAULT_PROPAGATION_WINDOW_MS;
  const inWindow = ctx.grantedAt !== null && ctx.now.getTime() - ctx.grantedAt.getTime() < window;
  const propagationRetry = (reason: string): ErrorDecision => ({
    action: "retry", category: "scope_propagation",
    delayMs: backoffDelayMs(SCOPE_PROPAGATION, (ctx.attempts.scope_propagation ?? 0) + 1, ctx.random), reason,
  });
  // Netz, Drosselung, Serverfehler (und unten 401 der APIs) verhalten sich wie bei Graph (ohne Body: kein Graph-Code)
  const asGraph = (status: number, tag: string) => {
    const d = classifyGraphError({ status, body: "", retryAfter: f.retryAfter }, ctx);
    return { ...d, reason: `${tag} ${d.reason}` } as ErrorDecision;
  };
  if (f.status === 0 || f.status === 429 || f.status >= 500) return asGraph(f.status, f.authStage ? `google_${f.authStage}` : "google");

  // Token-Kette VOR dem 401-Zweig: Googles Token-Endpunkt meldet fehlende Delegation als 401 unauthorized_client
  if (f.authStage) {
    const code = safeCode(f.authCode);
    const tag = `google_${f.authStage} HTTP ${f.status}${code ? ` ${code}` : ""}`;
    if (f.authStage === "oauth" && code === "unauthorized_client") {
      if (inWindow) return propagationRetry(`${tag}: domänenweite Delegation noch nicht wirksam`);
      return { action: "fail", category: "config", reason: `${tag}: domänenweite Delegation (Client-ID/Scope) fehlt`, alert: true };
    }
    if (f.authStage === "oauth" && code === "invalid_grant") {
      if (inWindow) return propagationRetry(`${tag}: Google-Konto noch nicht bereit`);
      return { action: "fail", category: "blocked_scope", reason: `${tag}: Google-Konto unbekannt, gesperrt oder außerhalb der Domain`, alert: true };
    }
    return { action: "fail", category: "config", reason: `${tag}: Workload Identity / Dienstkonto prüfen`, alert: true };
  }

  if (f.status === 401) return asGraph(401, "google");
  const { reason } = parseGoogleError(f.body);
  const tag = `google HTTP ${f.status}${reason ? ` ${reason}` : ""}`;
  if (f.status === 403) {
    if (GOOGLE_RATE_REASONS.has(reason)) {
      // Drosselung über 403 (Calendar): wie 429 behandeln
      const d = classifyGraphError({ status: 429, body: "", retryAfter: f.retryAfter }, ctx);
      return { ...d, reason: tag } as ErrorDecision;
    }
    if (GOOGLE_CONFIG_REASONS.has(reason)) return { action: "fail", category: "config", reason: `${tag}: Google-Konfiguration prüfen`, alert: true };
    if (inWindow) return propagationRetry(`${tag}: Freigabe noch nicht wirksam`);
    return { action: "fail", category: "blocked_scope", reason: `${tag}: kein Zugriff auf den Google-Kalender`, alert: true };
  }
  if (f.status === 404) {
    if (inWindow) return propagationRetry(`${tag}: Google-Kalender noch nicht bereit`);
    return { action: "fail", category: "blocked_scope", reason: `${tag}: Google-Kalender nicht gefunden`, alert: true };
  }
  return { action: "fail", category: "invalid_request", reason: tag, alert: true };
}

// ---------------------------------------------------------------------------------------------------
// Anwendung der Entscheidung auf Queue + Pipeline
// ---------------------------------------------------------------------------------------------------
export interface RetryableJob<P> {
  id: string;
  tenantId: string;
  payload: P;
}

export interface HandshakePayload {
  pipelineId: string;
  userId: string;
  /** ISO-Zeitpunkt der Freigabe (SCIM-Provisionierung) – Anker des Propagation-Fensters */
  grantedAt: string | null;
  attempts: Partial<Record<"scope_propagation" | "transient" | "token", number>>;
}

export interface FailureSinks {
  /** Job mit run_at = now() + delayMs zurückstellen (DB-Uhr, kein App-Clock-Skew) */
  reschedule(jobId: string, delayMs: number, payload: HandshakePayload, lastError: string): Promise<boolean>;
  failJob(jobId: string, lastError: string): Promise<boolean>;
  /** Sichtbarer Status im Admin-Dashboard: pending_scope | blocked_scope | config_error */
  setPipelineStatus(tenantId: string, pipelineId: string, status: "pending_scope" | "blocked_scope" | "config_error" | "error", reason: string): Promise<void>;
  alert(event: { tenantId: string; pipelineId: string; category: FailureCategory; reason: string }): Promise<void>;
}

export async function handleHandshakeFailure(
  job: RetryableJob<HandshakePayload>,
  failure: GraphFailure,
  sinks: FailureSinks,
  now: Date = new Date(),
  random?: () => number,
): Promise<ErrorDecision> {
  const p = job.payload;
  const decision = classifyGraphError(failure, {
    now,
    grantedAt: p.grantedAt ? new Date(p.grantedAt) : null,
    attempts: p.attempts,
    random,
  });

  if (decision.action === "retry") {
    const payload: HandshakePayload = {
      ...p,
      attempts: { ...p.attempts, [decision.category]: (p.attempts[decision.category] ?? 0) + 1 },
    };
    await sinks.reschedule(job.id, decision.delayMs, payload, decision.reason);
    if (decision.category === "scope_propagation") {
      await sinks.setPipelineStatus(job.tenantId, p.pipelineId, "pending_scope", decision.reason);
    }
    return decision;
  }

  await sinks.failJob(job.id, decision.reason);
  const status = decision.category === "blocked_scope" ? "blocked_scope" : decision.category === "config" ? "config_error" : "error";
  await sinks.setPipelineStatus(job.tenantId, p.pipelineId, status, decision.reason);
  await sinks.alert({ tenantId: job.tenantId, pipelineId: p.pipelineId, category: decision.category, reason: decision.reason });
  return decision;
}
