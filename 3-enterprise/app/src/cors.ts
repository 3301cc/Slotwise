/**
 * Strikte CORS-Policy für die Dashboard-API (/api/*). NICHT für /scim und /webhooks – dort gibt es keine
 * Browser-Aufrufer, und eine Origin wird als Fehlbedienung bzw. Angriff abgewiesen.
 *
 *   * exakter Origin-Vergleich gegen eine feste Liste (kein Regex, kein Suffix-Match, kein "*")
 *   * keine Cookies: Auth läuft über Bearer-Tokens (Entra) → Access-Control-Allow-Credentials wird nie gesetzt,
 *     CSRF entfällt als Angriffsklasse
 *   * Vary: Origin immer, damit Caches/CDNs keine Antwort für Origin A an Origin B ausliefern
 *   * Preflight-Ergebnis 10 min cachen (Access-Control-Max-Age) – spart einen Roundtrip pro Aufruf
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface CorsPolicy {
  origins: ReadonlySet<string>;
  methods: readonly string[];
  /** in Kleinbuchstaben */
  headers: readonly string[];
  exposeHeaders: readonly string[];
  maxAgeSeconds: number;
}

export function createCorsPolicy(origins: readonly string[]): CorsPolicy {
  for (const o of origins) if (o === "*" || o.includes("*")) throw new Error("CORS-Wildcard ist nicht erlaubt");
  return {
    origins: new Set(origins),
    methods: ["GET", "POST", "DELETE", "OPTIONS"],
    headers: ["authorization", "content-type", "x-request-id", "idempotency-key"],
    exposeHeaders: ["x-request-id", "retry-after", "location", "idempotent-replayed"],
    maxAgeSeconds: 600,
  };
}

export type CorsOutcome = "no-origin" | "allowed" | "preflight-done" | "rejected";

/**
 * Setzt die CORS-Header bzw. beantwortet den Preflight. Bei "preflight-done" und "rejected" ist die Antwort
 * bereits geschrieben; der Aufrufer macht nichts mehr.
 */
export function applyCors(req: IncomingMessage, res: ServerResponse, p: CorsPolicy): CorsOutcome {
  res.setHeader("Vary", "Origin");
  const origin = req.headers.origin;
  const isPreflight = req.method === "OPTIONS" && req.headers["access-control-request-method"] !== undefined;

  if (origin === undefined) {
    if (isPreflight) return reject(res, 403);
    return "no-origin"; // Server-zu-Server oder curl: CORS nicht anwendbar, Auth entscheidet
  }
  if (!p.origins.has(origin)) return reject(res, 403);

  res.setHeader("Access-Control-Allow-Origin", origin);
  if (!isPreflight) {
    res.setHeader("Access-Control-Expose-Headers", p.exposeHeaders.join(", "));
    return "allowed";
  }

  const method = String(req.headers["access-control-request-method"]).toUpperCase();
  if (!p.methods.includes(method)) return reject(res, 403);
  const requested = String(req.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((h) => h.trim().toLowerCase())
    .filter(Boolean);
  if (requested.some((h) => !p.headers.includes(h))) return reject(res, 403);

  res.writeHead(204, {
    "Access-Control-Allow-Methods": p.methods.join(", "),
    "Access-Control-Allow-Headers": p.headers.join(", "),
    "Access-Control-Max-Age": String(p.maxAgeSeconds),
    "Content-Length": "0",
  });
  res.end();
  return "preflight-done";
}

function reject(res: ServerResponse, status: number): CorsOutcome {
  // Keine ACAO-Header → der Browser gibt die Antwort nicht an das Skript weiter
  res.removeHeader("Access-Control-Allow-Origin");
  res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify({ error: "origin_not_allowed" }));
  return "rejected";
}
