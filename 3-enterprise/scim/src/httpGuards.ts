/**
 * Transport-Guards für den SCIM-Endpunkt – framework-unabhängig, nur node:http-Typen.
 * Genutzt von scim/src/nodeHandler.ts (und damit von app/src/server.ts UND scim/src/expressRouter.ts):
 * eine Implementierung, ein Verhalten, eine Testsuite.
 *
 * Reihenfolge (billig → teuer, nichts wird gelesen, bevor die Kopfzeilen passen):
 *   1. Browser-Merkmale (Origin, Sec-Fetch-*)          → 403   SCIM ist reine Server-zu-Server-Schnittstelle
 *   2. Pfad-Tricks (.., //, %2e, %2f, %5c, \, NUL)     → 400
 *   3. Methode nicht in GET/POST/PUT/PATCH/DELETE      → 405 + Allow
 *   4. Body-Methoden: Content-Type scim+json/json, utf-8 → 415
 *   5. Content-Length ungültig / > Limit               → 400 / 413 (ohne den Body zu lesen)
 *   6. Body lesen mit hartem Limit, UTF-8 strikt, JSON-Objekt, keine __proto__/constructor/prototype-Schlüssel
 */
import { randomUUID } from "node:crypto";
import type { IncomingHttpHeaders, IncomingMessage } from "node:http";
import type { ScimResponse } from "./types.js";

export const SCIM_BODY_LIMIT = 256 * 1024;
export const SCIM_CONTENT_TYPE = "application/scim+json; charset=utf-8";
const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

/** Teilmenge von core/src/logger.ts → SecurityEventName (kein Import, damit scim ohne core baut) */
export type ScimSecurityEvent = "scim_browser_origin" | "bad_path" | "scim_auth_failed";

export const SCIM_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Strict-Transport-Security": "max-age=63072000; includeSubDomains",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Cache-Control": "no-store",
  "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
  "Cross-Origin-Resource-Policy": "same-origin",
});

const REQUEST_ID = /^[A-Za-z0-9._-]{1,100}$/;
/** Nur harmlose Request-IDs übernehmen – sonst eigene. Verhindert Log- und Header-Injection. */
export function safeRequestId(v: string | string[] | undefined): string {
  return typeof v === "string" && REQUEST_ID.test(v) ? v : randomUUID();
}

// /./ /../ am Ende oder mittendrin, doppelte Slashes, kodierte Punkte/Slashes/Backslashes, Backslash, NUL
const BAD_PATH = /(\/\.\.?(\/|$))|%2e|%2f|%5c|%00|\\|\/\/|\u0000/i;
export function isBadPath(path: string): boolean {
  return BAD_PATH.test(path);
}

export function scimError(status: number, detail: string, scimType?: string, extra: Record<string, string> = {}): ScimResponse {
  return {
    status,
    headers: { "Content-Type": SCIM_CONTENT_TYPE, ...extra },
    body: { schemas: [SCHEMA_ERROR], status: String(status), ...(scimType ? { scimType } : {}), detail },
  };
}

export interface GuardRejection {
  response: ScimResponse;
  event?: { name: ScimSecurityEvent; fields: Record<string, unknown> };
  /** Verbindung nach der Antwort schließen (Body wurde nicht gelesen) */
  closeConnection?: boolean;
}

const METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const BODY_METHODS = new Set(["POST", "PUT", "PATCH"]);
const MEDIA_TYPES = new Set(["application/scim+json", "application/json"]);

function one(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h;
}

/** Prüft alles, was ohne Body entscheidbar ist. null = weiter. */
export function checkPreBody(method: string, path: string, headers: IncomingHttpHeaders, bodyLimit = SCIM_BODY_LIMIT): GuardRejection | null {
  // 1. Browser: Origin (auch "null") oder Fetch-Metadaten. Entra/Okta senden keins davon.
  const origin = one(headers.origin);
  const fetchSite = one(headers["sec-fetch-site"]);
  const fetchMode = one(headers["sec-fetch-mode"]);
  if (origin !== undefined || fetchSite !== undefined || fetchMode !== undefined) {
    return {
      response: scimError(403, "Browser-Zugriff auf SCIM ist nicht erlaubt"),
      event: { name: "scim_browser_origin", fields: { origin: (origin ?? "").slice(0, 200), fetchSite: fetchSite?.slice(0, 20) ?? null } },
      closeConnection: true,
    };
  }
  // 2. Pfad
  if (isBadPath(path)) {
    return { response: scimError(400, "Ungültiger Pfad", "invalidPath"), event: { name: "bad_path", fields: {} }, closeConnection: true };
  }
  // 3. Methode
  const m = method.toUpperCase();
  if (!METHODS.has(m)) {
    return { response: scimError(405, "Methode nicht erlaubt", undefined, { Allow: [...METHODS].join(", ") }), closeConnection: true };
  }
  // 4./5. Body-Methoden
  if (BODY_METHODS.has(m)) {
    const ct = one(headers["content-type"]) ?? "";
    const [type = "", ...params] = ct.split(";").map((s) => s.trim().toLowerCase());
    const charset = params.find((p) => p.startsWith("charset="))?.slice(8).replace(/"/g, "");
    if (!MEDIA_TYPES.has(type) || (charset !== undefined && charset !== "utf-8")) {
      return { response: scimError(415, "Content-Type muss application/scim+json oder application/json (UTF-8) sein"), closeConnection: true };
    }
  }
  const cl = one(headers["content-length"]);
  if (cl !== undefined) {
    if (!/^\d{1,15}$/.test(cl)) return { response: scimError(400, "Ungültige Content-Length", "invalidSyntax"), closeConnection: true };
    if (Number(cl) > bodyLimit) return { response: scimError(413, `Body größer als ${bodyLimit} Bytes`), closeConnection: true };
  }
  return null;
}

export type BodyReadResult = { ok: true; body: Buffer } | { ok: false; reason: "too_large" | "aborted" };

/**
 * Liest den Body mit hartem Limit. Wird das Limit überschritten, wird der Rest bis maxDrain verworfen
 * (damit der Client die 413 noch lesen kann) und danach die Verbindung getrennt. Puffert nie mehr als limit.
 */
export function readBodyLimited(req: IncomingMessage, limit: number, maxDrain = limit * 4): Promise<BodyReadResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    const finish = (r: BodyReadResult) => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onErr);
      req.off("aborted", onErr);
      resolve(r);
    };
    const onData = (c: Buffer) => {
      size += c.length;
      if (size > limit) {
        over = true;
        chunks.length = 0;
        if (size > maxDrain) {
          finish({ ok: false, reason: "too_large" });
          req.destroy();
        }
        return;
      }
      chunks.push(c);
    };
    const onEnd = () => finish(over ? { ok: false, reason: "too_large" } : { ok: true, body: Buffer.concat(chunks, size) });
    const onErr = () => finish({ ok: false, reason: "aborted" });
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onErr);
    req.on("aborted", onErr);
  });
}

const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

export type JsonBody = { ok: true; value: Record<string, unknown> | undefined } | { ok: false; response: ScimResponse };

/** Leerer Body → undefined. Sonst: striktes UTF-8, gültiges JSON, Objekt auf oberster Ebene, keine Prototyp-Schlüssel. */
export function parseJsonBody(buf: Buffer): JsonBody {
  if (buf.length === 0) return { ok: true, value: undefined };
  let text: string;
  try {
    text = UTF8.decode(buf);
  } catch {
    return { ok: false, response: scimError(400, "Body ist kein gültiges UTF-8", "invalidSyntax") };
  }
  let forbidden: string | null = null;
  let value: unknown;
  try {
    value = JSON.parse(text, function (this: unknown, key: string, v: unknown) {
      if (FORBIDDEN_KEYS.has(key)) forbidden = key;
      return v;
    });
  } catch {
    return { ok: false, response: scimError(400, "Ungültiges JSON", "invalidSyntax") };
  }
  if (forbidden !== null) return { ok: false, response: scimError(400, `Unzulässiger Schlüssel ${forbidden}`, "invalidSyntax") };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, response: scimError(400, "Body muss ein JSON-Objekt sein", "invalidSyntax") };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

export type QueryResult = { ok: true; query: Record<string, string> } | { ok: false; response: ScimResponse };

/** Query in flache Strings; doppelte Parameter (filter=a&filter=b) sind mehrdeutig → 400. */
export function parseQuery(search: string): QueryResult {
  const q: Record<string, string> = Object.create(null) as Record<string, string>;
  const params = new URLSearchParams(search);
  let n = 0;
  for (const [k, v] of params) {
    if (++n > 20) return { ok: false, response: scimError(400, "Zu viele Query-Parameter", "invalidValue") };
    if (k in q) return { ok: false, response: scimError(400, `Query-Parameter ${k.slice(0, 32)} doppelt`, "invalidValue") };
    q[k] = v;
  }
  return { ok: true, query: q };
}

/**
 * Begrenzt die Laufzeit. Bei Ablauf 503 + Retry-After: der IdP wiederholt, alle SCIM-Operationen sind
 * idempotent (PUT/PATCH/DELETE) bzw. per externalId/userName dedupliziert (POST → 409 beim Retry).
 */
export async function withDeadline(work: Promise<ScimResponse>, ms: number, requestId: string): Promise<{ res: ScimResponse; timedOut: boolean }> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<{ res: ScimResponse; timedOut: boolean }>((resolve) => {
    // bewusst KEIN unref(): die Frist muss auch feuern, wenn sonst nichts den Event-Loop hält
    timer = setTimeout(() => resolve({ res: scimError(503, `Zeitüberschreitung (requestId ${requestId})`, undefined, { "Retry-After": "5" }), timedOut: true }), ms);
  });
  try {
    return await Promise.race([work.then((res) => ({ res, timedOut: false })), timeout]);
  } finally {
    clearTimeout(timer);
  }
}
