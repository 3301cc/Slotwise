/**
 * Ein HTTP-Server für alle öffentlichen Pfade des Mandanten-Backends (node:http, kein Framework):
 *
 *   GET  /healthz               ALB-Healthcheck. 503 sobald der Task drainiert (SIGTERM).
 *   POST /webhooks/graph        Microsoft-Graph-Notifications (Validierung + Batch-Annahme)
 *   POST /webhooks/google       Google-Calendar-Push (nur Header, Token + Resource-ID + Replay-Schutz)
 *   *    /scim/v2/Users…        SCIM 2.0 für Entra/Okta (Bearer-Token), KEIN CORS, Browser-Origin → 403
 *   *    /api/v1/…              Dashboard-API für das Frontend: strikte CORS-Allowlist + Entra-Token
 *        GET  /api/v1/me/sync-status   (Scope Sync.Read)
 *        POST /api/v1/me/pipelines     (Scope Sync.Write, Idempotency-Key Pflicht)
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
        if (!input.ok) return json(res, 400, { error: input.error });
        const r = await d.pipelines.createPipeline({ tenantId: d.tenantId, entraObjectId: who.oid, mode: input.mode,
          busyLabel: input.busyLabel, idempotencyKey: key });
        switch (r.kind) {
          case "created": return json(res, 201, r.pipeline, { Location: `/api/v1/me/pipelines/${r.pipeline.id}` });
          case "replayed": return json(res, 200, r.pipeline, { "Idempotent-Replayed": "true" });
          case "user_not_provisioned": return json(res, 404, { error: "user_not_provisioned" });
          case "idempotency_conflict": return json(res, 422, { error: "idempotency_key_reused" });
          case "limit_reached": return json(res, 409, { error: "pipeline_limit_reached", limit: r.limit });
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
