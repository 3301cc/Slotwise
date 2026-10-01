/**
 * Ein HTTP-Server für alle öffentlichen Pfade des Mandanten-Backends (node:http, kein Framework):
 *
 *   GET  /healthz               ALB-Healthcheck. 503 sobald der Task drainiert (SIGTERM).
 *   POST /webhooks/graph        Microsoft-Graph-Notifications (Validierung + Batch-Annahme)
 *   POST /webhooks/google       Google-Calendar-Push (nur Header, Token + Resource-ID + Replay-Schutz)
 *   *    /scim/v2/Users…        SCIM 2.0 für Entra/Okta (Bearer-Token), KEIN CORS, Browser-Origin → 403
 *   *    /api/v1/…              Dashboard-API für das Frontend: strikte CORS-Allowlist + Entra-Token
 *        GET  /api/v1/me/sync-status   (Scope Sync.Read)
 *        GET  /api/v1/me/sync-targets  (Scope Sync.Read) wählbare Ziele laut Admin-Allowlist
 *        POST /api/v1/me/pipelines     (Scope Sync.Write, Idempotency-Key Pflicht, Body { mode, busyLabel?, target })
 *        DELETE /api/v1/me/pipelines/{id} (Scope Sync.Write) eigene Pipeline beenden → 202 bzw. 200 (schon beendet)
 *        GET  /api/v1/availability/busy?from&to   Buchungsseite, statisches Bearer-Token (kein Entra), ≤ 62 Tage
 *
 * Fehlercodes der API ({ error, … }):
 *   400 idempotency_key_required · invalid_json · body_must_be_object · unknown_field:<f> · mode_must_be_busy_or_full
 *       busyLabel_* · target_invalid · target_kind_invalid · unknown_field:target.<f> · target_mailbox_invalid
 *       target_entra_tenant_id_invalid · target_team_id_invalid · invalid_range · bad_path
 *   401 missing_bearer_token · token_expired · … (Entra) · invalid_token (Busy-API)
 *   403 insufficient_scope · origin_not_allowed
 *   404 not_found · user_not_provisioned · pipeline_not_found · booking_api_disabled
 *   409 pipeline_limit_reached
 *   413 payload_too_large   415 unsupported_media_type
 *   422 idempotency_key_reused · target_required · target_not_allowed (+ reason: tenant_not_linked | domain_not_allowed |
 *       not_same_person | target_is_source | own_mailboxes_not_configured | team_not_found | booking_disabled | owner_unknown)
 *       · range_too_large
 *   503 temporarily_unavailable (+ Retry-After)
 *
 * Pfade werden vor dem Routing geprüft: kodierte Punkte/Slashes oder ../ führen zu 400 – damit kann niemand
 * über /webhooks/../api an der WAF-Regel für /webhooks/ vorbei auf die API zugreifen.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { GuardDeps } from "../../core/src/webhookGuard.js";
import { createGraphWebhookListener, type WebhookHttpOptions } from "../../core/src/webhookHttp.js";
import { createGoogleWebhookListener, type GoogleGuardDeps, type GoogleWebhookHttpOptions } from "../../core/src/googleWebhook.js";
import type { ScimDeps } from "../../scim/src/scimUsers.js";
import { isBadPath, readBodyLimited, safeRequestId } from "../../scim/src/httpGuards.js";
import { createScimNodeHandler } from "../../scim/src/nodeHandler.js";
import { applyCors, type CorsPolicy } from "./cors.js";
import { AuthError, type EntraTokenVerifier } from "./entraAuth.js";
import type { StatusRepo } from "./statusApi.js";
import { parseCreatePipelineBody, parseIdempotencyKey, type PipelineStore } from "./pipelineStore.js";
import { syncTargetsFor, type OwnerLookup } from "./statusApi.js";
import { createBookingTokenCheck, parseBusyRange } from "./availabilityApi.js";
import type { SyncAllowlist } from "../../core/src/syncTargets.js";
import { mergeBusyIntervals, type BusyRepo } from "../../core/src/pgSyncRepo.js";
import type { Logger, SecurityEventName } from "../../core/src/logger.js";

export interface AppServerDeps {
  tenantId: string;
  webhook: GuardDeps;
  webhookOptions?: WebhookHttpOptions;
  googleWebhook: GoogleGuardDeps;
  googleWebhookOptions?: GoogleWebhookHttpOptions;
  scim: ScimDeps;
  /** Zeitbudget je SCIM-Request (Default 10 s → danach 503 + Retry-After) */
  scimTimeoutMs?: number;
  cors: CorsPolicy;
  auth: Pick<EntraTokenVerifier, "verifyAuthorizationHeader">;
  status: StatusRepo;
  pipelines: PipelineStore;
  /** Scope für schreibende Routen, Default Sync.Write */
  writeScope?: string;
  /** GET /api/v1/me/sync-targets; fehlt es → 404 */
  syncTargets?: { allowlist: SyncAllowlist; owners: OwnerLookup };
  /** GET /api/v1/availability/busy; token null oder fehlt → 404 booking_api_disabled */
  booking?: { token: string | null; repo: BusyRepo };
  log: (entry: Record<string, unknown>) => void;
  /** Sicherheits-Ereignisse (bad_path, CORS, Auth-Fehler, SCIM-Browserzugriff) – strukturiert, ohne Secrets */
  security?: Pick<Logger, "security">;
}

/** Nur harmlose Request-IDs übernehmen – sonst eigene (gemeinsame Implementierung mit SCIM). */
export { safeRequestId };

function clientIp(req: IncomingMessage): string | null {
  const xff = req.headers["x-forwarded-for"];
  const first = typeof xff === "string" ? xff.split(",")[0]?.trim() : undefined;
  const ip = first || req.socket.remoteAddress || null;
  return ip && ip.length <= 45 ? ip : null;
}

export interface AppServer {
  server: Server;
  /** Ab jetzt meldet /healthz 503, der ALB nimmt den Task aus der Rotation */
  startDraining(): void;
}

const API_BODY_LIMIT = 4 * 1024;
type SecFn = (event: SecurityEventName, f?: Record<string, unknown>) => void;

function securityHeaders(res: ServerResponse): void {
  res.setHeader("Strict-Transport-Security", "max-age=63072000; includeSubDomains");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cache-Control", "no-store");
}

function json(res: ServerResponse, status: number, body: unknown, extra: Record<string, string> = {}): void {
  const s = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(s), ...extra });
  res.end(s);
}

/** Body mit hartem Limit; null = zu groß (Client bekommt die 413 noch, Rest wird verworfen) */
async function readLimited(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  const r = await readBodyLimited(req, limit);
  return r.ok ? r.body : null;
}

export function createAppServer(d: AppServerDeps): AppServer {
  let draining = false;
  const bookingAuth = d.booking?.token ? createBookingTokenCheck(d.booking.token) : null;
  const webhook = createGraphWebhookListener(d.webhook, d.webhookOptions);
  const googleWebhook = createGoogleWebhookListener(d.googleWebhook, {
    ...d.googleWebhookOptions,
    requestId: (req) => String(req.headers["x-request-id"] ?? ""),
  });

  // SCIM: gemeinsamer Handler mit scim/src/expressRouter.ts (Origin/Sec-Fetch → 403, 415, 413, Zeitbudget …)
  const scimHandler = createScimNodeHandler(d.scim, { log: (e) => d.log(e), timeoutMs: d.scimTimeoutMs });
  const scim = (req: IncomingMessage, res: ServerResponse, path: string, sec: SecFn) =>
    scimHandler(req, res, path.slice("/scim/v2".length) || "/", { security: (event, f) => sec(event, f) });

  const api = async (req: IncomingMessage, res: ServerResponse, path: string, sec: SecFn) => {
    const cors = applyCors(req, res, d.cors);
    if (cors === "rejected") sec("cors_origin_rejected", { origin: String(req.headers.origin ?? "").slice(0, 200) });
    if (cors === "preflight-done" || cors === "rejected") return;
    if (req.method === "OPTIONS") {
      res.writeHead(204, { "Content-Length": "0" });
      res.end();
      return;
    }
    try {
      if (path === "/api/v1/me/sync-status" && req.method === "GET") {
        const who = await d.auth.verifyAuthorizationHeader(req.headers.authorization);
        const status = await d.status.getSyncStatus(d.tenantId, who.oid);
        if (!status) return json(res, 404, { error: "user_not_provisioned" });
        return json(res, 200, status);
      }
      if (path === "/api/v1/me/sync-targets" && req.method === "GET") {
        const who = await d.auth.verifyAuthorizationHeader(req.headers.authorization);
        if (!d.syncTargets) return json(res, 404, { error: "not_found" });
        const userName = await d.syncTargets.owners.getActiveUserName(d.tenantId, who.oid);
        if (userName === null) return json(res, 404, { error: "user_not_provisioned" });
        return json(res, 200, syncTargetsFor(d.syncTargets.allowlist, userName));
      }
      if (path === "/api/v1/availability/busy" && req.method === "GET") {
        if (!bookingAuth || !d.booking) return json(res, 404, { error: "booking_api_disabled" });
        const a = bookingAuth(req.headers.authorization);
        if (a !== "ok") {
          sec("api_auth_failed", { code: a === "missing" ? "booking_token_missing" : "booking_token_invalid" });
          return json(res, 401, { error: "invalid_token" }, { "WWW-Authenticate": 'Bearer error="invalid_token"' });
        }
        const range = parseBusyRange(req.url ?? "");
        if (!range.ok) return json(res, range.error === "range_too_large" ? 422 : 400, { error: range.error });
        const rows = await d.booking.repo.busyIntervals(d.tenantId, range.from, range.to);
        const busy = mergeBusyIntervals(rows, range.from, range.to).map((b) => ({ start: b.start.toISOString(), end: b.end.toISOString() }));
        return json(res, 200, { busy });
      }
      if (path === "/api/v1/me/pipelines" && req.method === "POST") {
        // Erst authentisieren, dann Body lesen: Unangemeldete bekommen keine Parser-Arbeit
        const who = await d.auth.verifyAuthorizationHeader(req.headers.authorization, d.writeScope ?? "Sync.Write");
        const key = parseIdempotencyKey(req.headers["idempotency-key"]);
        if (!key) {
          req.resume();
          return json(res, 400, { error: "idempotency_key_required" });
        }
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) {
          req.resume();
          return json(res, 415, { error: "unsupported_media_type" });
        }
        const buf = await readLimited(req, API_BODY_LIMIT);
        if (buf === null) return json(res, 413, { error: "payload_too_large" });
        let raw: unknown;
        try {
          raw = JSON.parse(buf.toString("utf8"));
        } catch {
          return json(res, 400, { error: "invalid_json" });
        }
        const input = parseCreatePipelineBody(raw);
        if (!input.ok) return json(res, input.status ?? 400, { error: input.error });
        const r = await d.pipelines.createPipeline({ tenantId: d.tenantId, entraObjectId: who.oid, mode: input.mode,
          busyLabel: input.busyLabel, idempotencyKey: key, target: input.target });
        switch (r.kind) {
          case "created": return json(res, 201, r.pipeline, { Location: `/api/v1/me/pipelines/${r.pipeline.id}` });
          case "replayed": return json(res, 200, r.pipeline, { "Idempotent-Replayed": "true" });
          case "user_not_provisioned": return json(res, 404, { error: "user_not_provisioned" });
          case "idempotency_conflict": return json(res, 422, { error: "idempotency_key_reused" });
          case "limit_reached": return json(res, 409, { error: "pipeline_limit_reached", limit: r.limit });
          case "target_not_allowed": return json(res, 422, { error: "target_not_allowed", reason: r.reason });
        }
      }
      const end = /^\/api\/v1\/me\/pipelines\/([^/]+)$/.exec(path);
      if (end && req.method === "DELETE") {
        const who = await d.auth.verifyAuthorizationHeader(req.headers.authorization, d.writeScope ?? "Sync.Write");
        req.resume();
        if (!d.pipelines.endPipeline) return json(res, 404, { error: "not_found" });
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(end[1])) return json(res, 404, { error: "pipeline_not_found" });
        const r = await d.pipelines.endPipeline({ tenantId: d.tenantId, entraObjectId: who.oid, pipelineId: end[1] });
        switch (r.kind) {
          case "ended": return json(res, 202, r.pipeline);
          case "already_ended": return json(res, 200, r.pipeline);
          case "user_not_provisioned": return json(res, 404, { error: "user_not_provisioned" });
          case "not_found": return json(res, 404, { error: "pipeline_not_found" });
        }
      }
      return json(res, 404, { error: "not_found" });
    } catch (err) {
      if (err instanceof AuthError) {
        sec(err.status === 401 ? "api_auth_failed" : "api_insufficient_scope", { code: err.code });
        const hdr = err.status === 401 ? `Bearer error="invalid_token", error_description="${err.code}"` : `Bearer error="insufficient_scope"`;
        return json(res, err.status, { error: err.code }, { "WWW-Authenticate": hdr });
      }
      throw err;
    }
  };

  // keepAlive > ALB-Idle-Timeout (60 s): sonst schließt Node Verbindungen, die der ALB noch nutzt → sporadische 502
  const server = createServer({ keepAliveTimeout: 65_000, headersTimeout: 20_000, requestTimeout: 30_000 }, (req, res) => {
    const requestId = safeRequestId(req.headers["x-request-id"]);
    req.headers["x-request-id"] = requestId; // gleiche ID für Adapter, Sicherheits-Log und Antwort-Header
    res.setHeader("X-Request-Id", requestId);
    securityHeaders(res);
    const raw = req.url ?? "/";
    const qi = raw.indexOf("?");
    const path = qi >= 0 ? raw.slice(0, qi) : raw;

    const ip = clientIp(req);
    const sec: SecFn = (event, f) =>
      d.security?.security(event, { requestId, ip, method: req.method, path: path.slice(0, 200), ...(f ?? {}) });

    const done = (p: Promise<void> | void) =>
      Promise.resolve(p).catch((err: unknown) => {
        d.log({ level: "error", requestId, path, msg: err instanceof Error ? err.message : String(err) });
        if (!res.headersSent) json(res, 503, { error: "temporarily_unavailable", requestId }, { "Retry-After": "5" });
        else res.destroy();
      });

    if (isBadPath(path)) {
      sec("bad_path");
      req.resume();
      return void done(json(res, 400, { error: "bad_path" }));
    }
    if (path === "/healthz") return void done(draining ? json(res, 503, { status: "draining" }) : json(res, 200, { status: "ok" }));
    if (path === "/webhooks/graph") return void done(webhook(req, res));
    if (path === "/webhooks/google") return void done(googleWebhook(req, res));
    if (path === "/scim/v2" || path.startsWith("/scim/v2/")) return void done(scim(req, res, path, sec));
    if (path.startsWith("/api/")) return void done(api(req, res, path, sec));
    return void done(json(res, 404, { error: "not_found" }));
  });

  return {
    server,
    startDraining: () => {
      draining = true;
    },
  };
}
