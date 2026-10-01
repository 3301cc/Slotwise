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
import {
  IDENTITY_ATTRIBUTES, isDomain, isGuid, normalizeMailbox, TEAM_ID,
  type IdentityAttribute, type LinkedGoogleWorkspace, type LinkedTenant, type SyncAllowlist, type TeamCalendar,
} from "../../core/src/syncTargets.js";
import { SERVICE_ACCOUNT_EMAIL, WIF_AUDIENCE } from "../../core/src/googleAuth.js";

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
  /**
   * Sync-Ziele (Admin-Allowlist, core/src/syncTargets.ts). Alles optional; fehlt es, ist das Ziel nicht wählbar.
   *   ownDomains     Domains für ein zweites Postfach derselben Person im EIGENEN Mandanten
   *   linkedTenants  verknüpfte Entra-Mandanten (App dort per Admin-Consent freigegeben) + deren Domains
   *   teamCalendars  Team-/Abteilungskalender: { id, mailbox, label }
   */
  ownDomains: string[];
  /** "dieselbe Person" im eigenen Mandanten: objectId (Default) | employeeId | onPremises… | localPart (Opt-in) */
  ownDomainsIdentityAttribute: IdentityAttribute;
  linkedTenants: LinkedTenant[];
  teamCalendars: TeamCalendar[];
  /** Statisches Bearer-Token der Buchungsseite für GET /api/v1/availability/busy; null = Buchungsseite aus */
  bookingApiToken: string | null;
  /** showAs=tentative als belegt übertragen (Default false) */
  syncTentative: boolean;
  /**
   * Google Workspaces als Ziel (account + provider google). Schreiben per domänenweiter Delegation, keyless:
   * JWT signiert die IAM Credentials API (signJwt), angemeldet per Workload Identity Federation aus AWS.
   */
  linkedGoogleWorkspaces: LinkedGoogleWorkspace[];
  /** Pflicht, sobald linkedGoogleWorkspaces nicht leer ist */
  googleWorkloadIdentity: { audience: string; serviceAccountEmail: string } | null;
}

/** Allowlist für API und Sync-Worker aus dem geprüften Secret */
export function syncAllowlistFrom(s: AppSecrets): SyncAllowlist {
  return {
    homeEntraTenantId: s.entraTenantId.toLowerCase(),
    ownDomains: s.ownDomains,
    ownDomainsIdentityAttribute: s.ownDomainsIdentityAttribute,
    linkedTenants: s.linkedTenants,
    teamCalendars: s.teamCalendars,
    bookingEnabled: s.bookingApiToken !== null,
    googleWorkspaces: s.linkedGoogleWorkspaces,
  };
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
  return {
    entraTenantId, graphClientId, graphCertSha256Hex: graphCertSha256Hex.toLowerCase(), scimTokenPepper, scimTokens,
    ...parseSyncTargets(o, entraTenantId),
  };
}

function domainList(v: unknown, where: string): string[] {
  if (!Array.isArray(v)) throw new ConfigError(`${where}: Liste von Domains erwartet`);
  const out = v.map((d: unknown, i: number) => {
    const dom = typeof d === "string" ? d.trim().toLowerCase() : "";
    if (!isDomain(dom)) throw new ConfigError(`${where}[${i}]: ungültige Domain`);
    return dom;
  });
  if (new Set(out).size !== out.length) throw new ConfigError(`${where}: doppelte Domain`);
  return out;
}

function label(v: unknown, where: string): string {
  // eslint-disable-next-line no-control-regex -- Steuerzeichen und spitze Klammern ausschließen (Anzeige im Dashboard)
  if (typeof v !== "string" || v.trim().length < 1 || v.trim().length > 64 || /[\u0000-\u001f\u007f<>]/.test(v)) {
    throw new ConfigError(`${where}: label 1–64 Zeichen ohne Steuerzeichen/<>`);
  }
  return v.trim();
}

/** Sync-Ziele und Buchungsseite – optional, aber wenn angegeben, streng geprüft */
function parseSyncTargets(o: Record<string, unknown>, homeTenant: string) {
  const ownDomains = o.ownDomains === undefined ? [] : domainList(o.ownDomains, "APP_CONFIG.ownDomains");

  const linkedRaw = o.linkedTenants ?? [];
  if (!Array.isArray(linkedRaw)) throw new ConfigError("APP_CONFIG.linkedTenants: Liste erwartet");
  const linkedTenants: LinkedTenant[] = linkedRaw.map((t: unknown, i: number) => {
    const e = (t ?? {}) as Record<string, unknown>;
    const where = `APP_CONFIG.linkedTenants[${i}]`;
    if (typeof e.entraTenantId !== "string" || !isGuid(e.entraTenantId)) throw new ConfigError(`${where}.entraTenantId: GUID erwartet`);
    if (e.entraTenantId.toLowerCase() === homeTenant.toLowerCase()) throw new ConfigError(`${where}: eigener Mandant gehört in ownDomains`);
    const domains = domainList(e.domains, `${where}.domains`);
    if (domains.length === 0) throw new ConfigError(`${where}.domains: mindestens eine Domain`);
    const ia = identityAttribute(e.identityAttribute ?? "employeeId", `${where}.identityAttribute`);
    if (ia === "objectId") throw new ConfigError(`${where}.identityAttribute: objectId gilt nur im eigenen Mandanten`);
    return { entraTenantId: e.entraTenantId.toLowerCase(), label: label(e.label, `${where}.label`), domains, identityAttribute: ia };
  });
  if (new Set(linkedTenants.map((t) => t.entraTenantId)).size !== linkedTenants.length) throw new ConfigError("APP_CONFIG.linkedTenants: doppelter Mandant");

  const teamRaw = o.teamCalendars ?? [];
  if (!Array.isArray(teamRaw)) throw new ConfigError("APP_CONFIG.teamCalendars: Liste erwartet");
  const teamCalendars: TeamCalendar[] = teamRaw.map((t: unknown, i: number) => {
    const e = (t ?? {}) as Record<string, unknown>;
    const where = `APP_CONFIG.teamCalendars[${i}]`;
    if (typeof e.id !== "string" || !TEAM_ID.test(e.id)) throw new ConfigError(`${where}.id: [a-z0-9_-], 1–64 Zeichen`);
    const mailbox = typeof e.mailbox === "string" ? normalizeMailbox(e.mailbox) : null;
    if (!mailbox) throw new ConfigError(`${where}.mailbox: ungültige Adresse`);
    if (e.allowFullMode !== undefined && typeof e.allowFullMode !== "boolean") throw new ConfigError(`${where}.allowFullMode: true/false`);
    return { id: e.id, mailbox, label: label(e.label, `${where}.label`), allowFullMode: e.allowFullMode === true };
  });
  if (new Set(teamCalendars.map((t) => t.id)).size !== teamCalendars.length) throw new ConfigError("APP_CONFIG.teamCalendars: doppelte id");

  let bookingApiToken: string | null = null;
  if (o.bookingApiToken !== undefined && o.bookingApiToken !== null) {
    if (typeof o.bookingApiToken !== "string" || o.bookingApiToken.length < 32 || o.bookingApiToken.length > 512 || /\s/.test(o.bookingApiToken)) {
      throw new ConfigError("APP_CONFIG.bookingApiToken: 32–512 Zeichen ohne Leerraum");
    }
    bookingApiToken = o.bookingApiToken;
  }
  if (o.syncTentative !== undefined && typeof o.syncTentative !== "boolean") throw new ConfigError("APP_CONFIG.syncTentative: true/false");
  const ownDomainsIdentityAttribute = identityAttribute(o.ownDomainsIdentityAttribute ?? "objectId", "APP_CONFIG.ownDomainsIdentityAttribute");
  const google = parseGoogle(o, [...ownDomains, ...linkedTenants.flatMap((t) => t.domains)]);
  return { ownDomains, ownDomainsIdentityAttribute, linkedTenants, teamCalendars, bookingApiToken, syncTentative: o.syncTentative === true, ...google };
}

/**
 * Google-Ziele: googleWorkloadIdentity { audience, serviceAccountEmail } + linkedGoogleWorkspaces[] – streng:
 * Domains dürfen sich mit Microsoft-Domains nicht überschneiden (ein Postfach gehört genau einer Allowlist),
 * employeeId-Prüfung verlangt ein directoryAdminSubject, nur Dienstkonten *.iam.gserviceaccount.com.
 */
function parseGoogle(o: Record<string, unknown>, microsoftDomains: readonly string[]) {
  let googleWorkloadIdentity: AppSecrets["googleWorkloadIdentity"] = null;
  if (o.googleWorkloadIdentity !== undefined && o.googleWorkloadIdentity !== null) {
    const w = o.googleWorkloadIdentity as Record<string, unknown>;
    const where = "APP_CONFIG.googleWorkloadIdentity";
    if (typeof w !== "object" || Array.isArray(w)) throw new ConfigError(`${where}: Objekt erwartet`);
    if (typeof w.audience !== "string" || !WIF_AUDIENCE.test(w.audience)) {
      throw new ConfigError(`${where}.audience: //iam.googleapis.com/projects/<Nummer>/locations/global/workloadIdentityPools/<Pool>/providers/<Provider>`);
    }
    const sa = typeof w.serviceAccountEmail === "string" ? w.serviceAccountEmail.trim().toLowerCase() : "";
    if (!SERVICE_ACCOUNT_EMAIL.test(sa)) throw new ConfigError(`${where}.serviceAccountEmail: <name>@<projekt>.iam.gserviceaccount.com`);
    googleWorkloadIdentity = { audience: w.audience, serviceAccountEmail: sa };
  }
  const raw = o.linkedGoogleWorkspaces ?? [];
  if (!Array.isArray(raw)) throw new ConfigError("APP_CONFIG.linkedGoogleWorkspaces: Liste erwartet");
  if (raw.length > 0 && !googleWorkloadIdentity) throw new ConfigError("APP_CONFIG.googleWorkloadIdentity fehlt (Pflicht für linkedGoogleWorkspaces)");
  const seen = new Set(microsoftDomains);
  const linkedGoogleWorkspaces: LinkedGoogleWorkspace[] = raw.map((t: unknown, i: number) => {
    const e = (t ?? {}) as Record<string, unknown>;
    const where = `APP_CONFIG.linkedGoogleWorkspaces[${i}]`;
    if (typeof e.id !== "string" || !TEAM_ID.test(e.id)) throw new ConfigError(`${where}.id: [a-z0-9_-], 1–64 Zeichen`);
    const domains = domainList(e.domains, `${where}.domains`);
    if (domains.length === 0) throw new ConfigError(`${where}.domains: mindestens eine Domain`);
    for (const d of domains) {
      if (seen.has(d)) throw new ConfigError(`${where}.domains: ${d} steht schon in einer anderen Allowlist`);
      seen.add(d);
    }
    const sa = e.serviceAccountEmail === undefined ? googleWorkloadIdentity!.serviceAccountEmail
      : typeof e.serviceAccountEmail === "string" ? e.serviceAccountEmail.trim().toLowerCase() : "";
    if (!SERVICE_ACCOUNT_EMAIL.test(sa)) throw new ConfigError(`${where}.serviceAccountEmail: <name>@<projekt>.iam.gserviceaccount.com`);
    const ia = e.identityAttribute ?? "employeeId";
    if (ia !== "employeeId" && ia !== "localPart") throw new ConfigError(`${where}.identityAttribute: employeeId | localPart`);
    let directoryAdminSubject: string | null = null;
    if (e.directoryAdminSubject !== undefined && e.directoryAdminSubject !== null) {
      directoryAdminSubject = typeof e.directoryAdminSubject === "string" ? normalizeMailbox(e.directoryAdminSubject) : null;
      if (!directoryAdminSubject) throw new ConfigError(`${where}.directoryAdminSubject: ungültige Adresse`);
    }
    if (ia === "employeeId" && !directoryAdminSubject) {
      throw new ConfigError(`${where}.directoryAdminSubject: Pflicht für identityAttribute employeeId (Nutzer mit Admin-Rolle "Nutzer: Lesen")`);
    }
    return { id: e.id, label: label(e.label, `${where}.label`), domains, serviceAccountEmail: sa, identityAttribute: ia, directoryAdminSubject };
  });
  if (new Set(linkedGoogleWorkspaces.map((w) => w.id)).size !== linkedGoogleWorkspaces.length) throw new ConfigError("APP_CONFIG.linkedGoogleWorkspaces: doppelte id");
  return { linkedGoogleWorkspaces, googleWorkloadIdentity };
}

function identityAttribute(v: unknown, where: string): IdentityAttribute {
  if (typeof v !== "string" || !(IDENTITY_ATTRIBUTES as readonly string[]).includes(v)) {
    throw new ConfigError(`${where}: ${IDENTITY_ATTRIBUTES.join(" | ")}`);
  }
  return v as IdentityAttribute;
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
