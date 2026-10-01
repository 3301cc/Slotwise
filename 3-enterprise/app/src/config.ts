/**
 * Produktionskonfiguration – einzige Stelle, die process.env liest.
 *
 * Zwei Quellen, strikt getrennt:
 *   1. Umgebungsvariablen aus der ECS-Task-Definition (Terraform): NICHT geheim (Hosts, Origins, Audience …)
 *   2. APP_CONFIG: JSON aus AWS Secrets Manager, von ECS beim Start injiziert: GEHEIM (Pepper, Token-Hashes …)
 * Fehlt etwas oder ist es unsicher, startet der Task nicht (fail fast) – lieber kein Deployment als ein
 * Deployment mit offener CORS-Policy oder Platzhalter-Secrets.
 */
import type { TokenEntry } from "../../scim/src/auth.js";

export interface AppConfig {
  port: number;
  /** interne Mandanten-ID (scim_users.tenant_id), z. B. "acme" */
  tenantId: string;
  publicBaseUrl: string;
  corsAllowedOrigins: readonly string[];
  api: {
    /** akzeptierte aud-Werte: Application ID URI und/oder Client-ID der API-App */
    audiences: readonly string[];
    requiredScope: string;
    /** Scope für schreibende Routen (Pipeline anlegen) */
    writeScope: string;
  };
  db: { host: string; port: number; database: string; user: string; region: string; poolMax: number };
  secrets: AppSecrets;
}

export interface AppSecrets {
  /** Entra-Mandant des Kunden (tid) – pinnt Dashboard-Tokens UND Graph-App-Tokens */
  entraTenantId: string;
  /** App-Registrierung für Graph (Client Credentials mit Zertifikat in KMS) */
  graphClientId: string;
  graphCertSha256Hex: string;
  scimTokenPepper: string;
  scimTokens: TokenEntry[];
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ConfigError extends Error {}

function need(env: NodeJS.ProcessEnv, k: string): string {
  const v = env[k];
  if (v === undefined || v.trim() === "") throw new ConfigError(`Umgebungsvariable ${k} fehlt`);
  return v.trim();
}

function int(env: NodeJS.ProcessEnv, k: string, def: number, min: number, max: number): number {
  const raw = env[k];
  const n = raw === undefined || raw === "" ? def : Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`${k} muss eine Ganzzahl zwischen ${min} und ${max} sein`);
  return n;
}

/** Exakte Origins, nur https, keine Wildcards, kein Pfad. "http://localhost:<port>" nur außerhalb von production. */
export function parseOrigins(raw: string, production: boolean): string[] {
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.length === 0) throw new ConfigError("CORS_ALLOWED_ORIGINS ist leer");
  for (const o of list) {
    if (o.includes("*")) throw new ConfigError(`CORS: Wildcard nicht erlaubt (${o})`);
    let u: URL;
    try {
      u = new URL(o);
    } catch {
      throw new ConfigError(`CORS: ungültige Origin ${o}`);
    }
    const isLocalDev = !production && u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1");
    if (u.protocol !== "https:" && !isLocalDev) throw new ConfigError(`CORS: nur https-Origins (${o})`);
    if (u.origin !== o) throw new ConfigError(`CORS: Origin ohne Pfad und ohne Slash am Ende angeben (${o} → ${u.origin})`);
  }
  return list;
}

function parseSecrets(raw: string): AppSecrets {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    throw new ConfigError("APP_CONFIG ist kein gültiges JSON");
  }
  if (typeof j !== "object" || j === null) throw new ConfigError("APP_CONFIG muss ein Objekt sein");
  const o = j as Record<string, unknown>;
  const str = (k: string): string => {
    const v = o[k];
    if (typeof v !== "string" || v === "") throw new ConfigError(`APP_CONFIG.${k} fehlt`);
    return v;
  };
  const entraTenantId = str("entraTenantId");
  const graphClientId = str("graphClientId");
  if (!GUID.test(entraTenantId) || !GUID.test(graphClientId)) throw new ConfigError("APP_CONFIG: entraTenantId/graphClientId müssen GUIDs sein");
  const graphCertSha256Hex = str("graphCertSha256Hex");
  if (!/^[0-9a-f]{64}$/i.test(graphCertSha256Hex)) throw new ConfigError("APP_CONFIG.graphCertSha256Hex: 64 Hex-Zeichen");
  const scimTokenPepper = str("scimTokenPepper");
  if (scimTokenPepper.length < 32) throw new ConfigError("APP_CONFIG.scimTokenPepper: mindestens 32 Zeichen");
  const tokens = o.scimTokens;
  if (!Array.isArray(tokens) || tokens.length === 0) throw new ConfigError("APP_CONFIG.scimTokens: mindestens ein Eintrag");
  const scimTokens: TokenEntry[] = tokens.map((t: unknown, i: number) => {
    const e = t as Record<string, unknown>;
    if (typeof e?.tenantId !== "string" || typeof e.sha256Hex !== "string" || !/^[0-9a-f]{64}$/i.test(e.sha256Hex) ||
        typeof e.expiresAt !== "string" || Number.isNaN(Date.parse(e.expiresAt))) {
      throw new ConfigError(`APP_CONFIG.scimTokens[${i}] unvollständig (tenantId, sha256Hex, expiresAt)`);
    }
    return { tenantId: e.tenantId, sha256Hex: e.sha256Hex.toLowerCase(), expiresAt: e.expiresAt };
  });
  return { entraTenantId, graphClientId, graphCertSha256Hex: graphCertSha256Hex.toLowerCase(), scimTokenPepper, scimTokens };
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const production = env.NODE_ENV === "production";
  if (env.DB_PASSWORD || env.PGPASSWORD) throw new ConfigError("Statisches DB-Passwort gesetzt – vorgesehen ist nur IAM-Auth");
  if (env.DB_IAM_AUTH !== "true") throw new ConfigError("DB_IAM_AUTH muss 'true' sein");

  const publicBaseUrl = need(env, "PUBLIC_BASE_URL");
  if (!publicBaseUrl.startsWith("https://") || publicBaseUrl.endsWith("/")) throw new ConfigError("PUBLIC_BASE_URL: https://host ohne Slash am Ende");

  const audiences = need(env, "API_AUDIENCE").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    port: int(env, "PORT", 8080, 1, 65535),
    tenantId: need(env, "TENANT_ID"),
    publicBaseUrl,
    corsAllowedOrigins: parseOrigins(need(env, "CORS_ALLOWED_ORIGINS"), production),
    api: { audiences, requiredScope: env.API_REQUIRED_SCOPE?.trim() || "Sync.Read", writeScope: env.API_WRITE_SCOPE?.trim() || "Sync.Write" },
    db: {
      host: need(env, "DB_HOST"),
      port: int(env, "DB_PORT", 5432, 1, 65535),
      database: need(env, "DB_NAME"),
      user: need(env, "DB_USER"),
      region: need(env, "AWS_REGION"),
      poolMax: int(env, "DB_POOL_MAX", 20, 1, 20),
    },
    secrets: parseSecrets(need(env, "APP_CONFIG")),
  };
}
