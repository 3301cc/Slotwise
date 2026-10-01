/**
 * Strukturiertes JSON-Logging mit Sicherheits-Ereignissen – eine Zeile je Ereignis auf stdout
 * (ECS awslogs → CloudWatch; Metric-Filter in terraform/monitoring.tf).
 *
 * Garantien:
 *   * Kein Secret/PII im Log: Schlüssel wie authorization, token, password, clientState, email, userName …
 *     werden geschwärzt; zusätzlich werden JWTs und Bearer-Tokens in beliebigen Strings erkannt und ersetzt.
 *   * Begrenzte Größe je Zeile: Strings ≤ 512 Zeichen, Tiefe ≤ 4, ≤ 40 Schlüssel je Objekt, Arrays ≤ 20.
 *   * Event-Loop wird nicht blockiert: Zeilen werden gesammelt und einmal pro Event-Loop-Durchlauf
 *     (setImmediate) in EINEM write geschrieben. stdout auf eine Pipe ist in Node unter Linux synchron –
 *     viele kleine Writes unter Last würden sonst den Loop bremsen.
 *   * Begrenzter Speicher: höchstens maxBuffered Zeilen im Puffer; Überlauf wird gezählt und als eigene
 *     Zeile gemeldet statt den Prozess aufzublähen.
 */

export type LogLevel = "debug" | "info" | "warn" | "error" | "security" | "alert";

export type SecurityEventName =
  | "webhook_rejected"
  | "client_state_mismatch"
  | "scim_auth_failed"
  | "scim_browser_origin"
  | "api_auth_failed"
  | "api_insufficient_scope"
  | "cors_origin_rejected"
  | "bad_path";

export type LogFields = Record<string, unknown>;

export interface Logger {
  debug(msg: string, f?: LogFields): void;
  info(msg: string, f?: LogFields): void;
  warn(msg: string, f?: LogFields): void;
  error(msg: string, f?: LogFields): void;
  /** Alarmwürdig, aber kein Angriff (z. B. blocked_scope, Teardown-Frist) */
  alert(msg: string, f?: LogFields): void;
  /** Sicherheitsereignis: abgewiesene Anfrage, fehlgeschlagene Authentisierung … */
  security(event: SecurityEventName, f?: LogFields): void;
  /** Kind-Logger mit festen Feldern (z. B. requestId) */
  child(fixed: LogFields): Logger;
  /** Puffer sofort schreiben (Shutdown) */
  flush(): void;
}

export interface LoggerOptions {
  service: string;
  tenantId?: string;
  minLevel?: LogLevel;
  write?: (chunk: string) => void;
  now?: () => Date;
  maxBuffered?: number;
  /** Rest beim Prozessende synchron schreiben (Default true; in Tests aus) */
  flushOnExit?: boolean;
}

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40, security: 45, alert: 50 };

const SENSITIVE_KEY = /^(authorization|cookie|set-cookie|password|passwd|secret|token|access_?token|refresh_?token|id_?token|client_?secret|client_?state|x-goog-channel-token|pepper|api_?key|private_?key|signature|email|emails|mail|user_?name|username|display_?name|given_?name|family_?name|name|phone|phone_?numbers|address)$/i;
const JWT = /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\b/g;
const BEARER = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

const MAX_STR = 512;
const MAX_DEPTH = 4;
const MAX_KEYS = 40;
const MAX_ARRAY = 20;

function scrubString(s: string): string {
  let out = s.length > MAX_STR ? `${s.slice(0, MAX_STR)}…[+${s.length - MAX_STR}]` : s;
  if (out.includes("eyJ")) out = out.replace(JWT, "[jwt]");
  if (/bearer|basic/i.test(out)) out = out.replace(BEARER, "$1 [redacted]");
  if (out.includes("@")) out = out.replace(EMAIL, "[email]");
  return out;
}

/** Rekursive, begrenzte Bereinigung. Gibt nur JSON-sichere Werte zurück. */
export function sanitize(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value ?? null;
  switch (typeof value) {
    case "string":
      return scrubString(value);
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "boolean":
      return value;
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return `[${typeof value}]`;
  }
  if (value instanceof Error) return { name: value.name, message: scrubString(value.message) };
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();
  if (depth >= MAX_DEPTH) return "[depth]";
  if (Array.isArray(value)) {
    const out = value.slice(0, MAX_ARRAY).map((v) => sanitize(v, depth + 1));
    if (value.length > MAX_ARRAY) out.push(`[+${value.length - MAX_ARRAY}]`);
    return out;
  }
  const out: Record<string, unknown> = {};
  let n = 0;
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (n++ >= MAX_KEYS) {
      out["…"] = "[keys truncated]";
      break;
    }
    out[k] = SENSITIVE_KEY.test(k) ? "[redacted]" : sanitize(v, depth + 1);
  }
  return out;
}

export function createLogger(o: LoggerOptions): Logger {
  const write = o.write ?? ((c: string) => void process.stdout.write(c));
  const now = o.now ?? (() => new Date());
  const min = ORDER[o.minLevel ?? "info"];
  const maxBuffered = o.maxBuffered ?? 2_000;
  let buffer: string[] = [];
  let dropped = 0;
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    if (dropped > 0) {
      buffer.push(JSON.stringify({ t: now().toISOString(), level: "warn", service: o.service, msg: "log_lines_dropped", count: dropped }));
      dropped = 0;
    }
    if (buffer.length === 0) return;
    const chunk = buffer.join("\n") + "\n";
    buffer = [];
    try {
      write(chunk);
    } catch {
      // Logging darf die Anwendung nie zum Absturz bringen
    }
  };

  const emit = (level: LogLevel, base: LogFields, msg: string, f?: LogFields) => {
    if (ORDER[level] < min) return;
    if (buffer.length >= maxBuffered) {
      dropped++;
      return;
    }
    const entry = sanitize({ ...base, ...(f ?? {}) }) as Record<string, unknown>;
    buffer.push(JSON.stringify({ t: now().toISOString(), level, service: o.service, ...(o.tenantId ? { tenant: o.tenantId } : {}), msg, ...entry }));
    if (!scheduled) {
      scheduled = true;
      setImmediate(flush);
    }
  };

  const make = (base: LogFields): Logger => ({
    debug: (m, f) => emit("debug", base, m, f),
    info: (m, f) => emit("info", base, m, f),
    warn: (m, f) => emit("warn", base, m, f),
    error: (m, f) => emit("error", base, m, f),
    alert: (m, f) => emit("alert", base, m, f),
    security: (event, f) => emit("security", base, event, { event, ...(f ?? {}) }),
    child: (fixed) => make({ ...base, ...fixed }),
    flush,
  });

  const root = make({});
  if (o.flushOnExit ?? true) process.once("exit", flush);
  return root;
}
