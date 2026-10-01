/**
 * SCIM über node:http – gemeinsamer Kern für app/src/server.ts und scim/src/expressRouter.ts.
 *
 *   const scim = createScimNodeHandler(deps, { security, log });
 *   await scim(req, res, "/Users");          // Pfad relativ zu /scim/v2
 *
 * Ablauf: checkPreBody → Body lesen (Limit) → JSON prüfen → Query prüfen → handleScim mit Zeitbudget →
 * Antwort mit Sicherheitsheadern. 401 erzeugt ein Sicherheitsereignis (Token wird nie geloggt).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import {
  SCIM_BODY_LIMIT, SCIM_SECURITY_HEADERS, checkPreBody, parseJsonBody, parseQuery, readBodyLimited, safeRequestId, scimError,
  withDeadline, type ScimSecurityEvent,
} from "./httpGuards.js";
import { handleScim, type ScimDeps } from "./scimUsers.js";
import type { ScimResponse } from "./types.js";

export interface ScimHttpOptions {
  security?: { security(event: ScimSecurityEvent, fields?: Record<string, unknown>): void };
  log?: (entry: Record<string, unknown>) => void;
  /** Gesamtbudget je Request für den SCIM-Kern (DB). Default 10 s – Entra wartet bis zu 30 s. */
  timeoutMs?: number;
  bodyLimit?: number;
}

type SecuritySink = NonNullable<ScimHttpOptions["security"]>;
/** security je Aufruf überschreibt opts.security (z. B. mit Client-IP angereichert) */
export type ScimNodeHandler = (req: IncomingMessage, res: ServerResponse, relativePath: string, security?: SecuritySink) => Promise<void>;

const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);

function send(res: ServerResponse, out: ScimResponse, requestId: string, close = false): void {
  if (res.headersSent) return;
  const body = out.body === undefined ? "" : JSON.stringify(out.body);
  res.statusCode = out.status;
  for (const [k, v] of Object.entries(SCIM_SECURITY_HEADERS)) res.setHeader(k, v);
  for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
  res.removeHeader("X-Powered-By");
  res.setHeader("X-Request-Id", requestId);
  res.setHeader("Content-Length", Buffer.byteLength(body));
  if (close) res.setHeader("Connection", "close");
  res.end(body);
}

export function createScimNodeHandler(deps: ScimDeps, o: ScimHttpOptions = {}): ScimNodeHandler {
  const limit = o.bodyLimit ?? SCIM_BODY_LIMIT;
  const timeoutMs = o.timeoutMs ?? 10_000;
  const log = o.log ?? (() => {});

  return async (req, res, relativePath, securityOverride) => {
    const sec = securityOverride ?? o.security;
    const requestId = safeRequestId(req.headers["x-request-id"] ?? req.headers["client-request-id"]);
    const method = (req.method ?? "GET").toUpperCase();
    // Express setzt req.url relativ zum Mount-Punkt; originalUrl ist die unveränderte Anfrage-URL
    const rawUrl = (req as IncomingMessage & { originalUrl?: string }).originalUrl ?? req.url ?? "/";
    const qi = rawUrl.indexOf("?");
    const fields = { requestId, method, path: relativePath.slice(0, 200) };

    // Pfad-Prüfung auf der ROHEN URL (vor jeder Dekodierung durch Router/Framework)
    const rejected = checkPreBody(method, qi >= 0 ? rawUrl.slice(0, qi) : rawUrl, req.headers, limit) ?? checkPreBody(method, relativePath, req.headers, limit);
    if (rejected) {
      if (rejected.event) sec?.security(rejected.event.name, { ...fields, ...rejected.event.fields });
      req.resume();
      return send(res, rejected.response, requestId, rejected.closeConnection);
    }

    let body: Record<string, unknown> | undefined;
    if (BODY_METHODS.has(method)) {
      if (req.readableEnded) {
        // Ein Body-Parser vor dem Router hat den Stream schon gelesen → Limits wären umgangen. Fail closed.
        log({ level: "error", msg: "scim_router_misconfigured", detail: "Body-Parser vor dem SCIM-Router registriert", requestId });
        return send(res, scimError(500, `Fehlkonfiguration (requestId ${requestId})`), requestId);
      }
      const read = await readBodyLimited(req, limit);
      if (!read.ok) {
        if (read.reason === "aborted") return void res.destroy();
        return send(res, scimError(413, `Body größer als ${limit} Bytes`), requestId, true);
      }
      const parsed = parseJsonBody(read.body);
      if (!parsed.ok) return send(res, parsed.response, requestId);
      body = parsed.value;
    } else {
      req.resume(); // GET/DELETE: eventuellen Body verwerfen, nicht puffern
    }

    const q = parseQuery(qi >= 0 ? rawUrl.slice(qi + 1) : "");
    if (!q.ok) return send(res, q.response, requestId);

    const headers: Record<string, string | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) headers[k] = Array.isArray(v) ? v.join(",") : v;

    try {
      const { res: out, timedOut } = await withDeadline(
        handleScim({ method, path: relativePath || "/", query: q.query, headers, body, requestId }, deps),
        timeoutMs,
        requestId,
      );
      if (timedOut) log({ level: "warn", msg: "scim_timeout", requestId, method, timeoutMs });
      if (out.status === 401) sec?.security("scim_auth_failed", { ...fields, hasBearer: /^Bearer\s/i.test(headers.authorization ?? "") });
      send(res, out, requestId);
    } catch (err) {
      // handleScim fängt selbst alles ab; das hier ist nur das letzte Netz (z. B. Fehler beim Serialisieren)
      log({ level: "error", msg: "scim_unhandled", requestId, error: err instanceof Error ? err.name : "unknown" });
      send(res, scimError(500, `Interner Fehler (requestId ${requestId})`), requestId);
    }
  };
}
