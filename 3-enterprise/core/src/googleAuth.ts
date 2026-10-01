/**
 * Google-Zugriff OHNE Dienstkonto-Schlüssel: domänenweite Delegation (DWD) mit einem JWT, das die IAM Credentials
 * API signiert – authentifiziert über Workload Identity Federation (WIF) aus der AWS-Task-Rolle.
 *
 *   1. AWS:    sts:GetCallerIdentity-Request mit der ECS-Task-Rolle SIGNIEREN (SigV4), nicht absenden.
 *              Mitsigniert: x-goog-cloud-target-resource = WIF-Provider (audience) – der Request gilt nur dort.
 *   2. Google STS (sts.googleapis.com/v1/token): Token-Exchange → föderiertes Token (Scope cloud-platform).
 *              Google ruft mit dem signierten Request selbst AWS auf und prüft Konto/Rolle gegen den WIF-Provider.
 *   3. IAM Credentials (projects/-/serviceAccounts/{sa}:signJwt) mit dem föderierten Token: Google signiert die
 *              DWD-Assertion { iss: sa, sub: <Postfach>, scope, aud: oauth2 } mit dem von Google verwalteten
 *              Schlüssel des Dienstkontos. Der WIF-Principal braucht dafür roles/iam.serviceAccountTokenCreator
 *              auf genau diesem Dienstkonto. Es existiert nirgends ein heruntergeladener Schlüssel.
 *   4. OAuth (oauth2.googleapis.com/token, grant jwt-bearer) → Access Token im Namen von sub, nur für scope.
 *
 * Caches: föderiertes Token je audience; delegierte Tokens je (Dienstkonto, sub, scope) – ein Token für Person A
 * kommt nie für Person B aus dem Cache. Gleichzeitige Anfragen für denselben Schlüssel teilen sich einen Abruf.
 *
 * Sicherheitsgrenzen in Software (Google kann DWD nicht auf Nutzer begrenzen, Fact Sheet D4):
 *   * nur Dienstkonten aus der Konfiguration, nur die zwei Scopes calendar.events und admin.directory.user.readonly
 *   * sub nur syntaktisch gültige Postfächer; WELCHES Postfach, entscheidet ausschließlich die Allowlist
 *     (syncTargets.ts) – in API und Worker, nach der Prüfung "dieselbe Person"
 * Tokens, Assertions und Antworttexte werden nie geloggt und stehen in keiner Fehlermeldung.
 */
import { GoogleAuthError, RunAborted } from "./syncErrors.js";
import { signAwsRequest, type AwsCredentials, type SigV4Signer } from "./awsSigV4.js";
import { normalizeMailbox } from "./syncTargets.js";
import type { FetchLike } from "./types.js";

export const GOOGLE_STS_URL = "https://sts.googleapis.com/v1/token";
export const GOOGLE_OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_IAM_CREDENTIALS_BASE = "https://iamcredentials.googleapis.com/v1";
export const SCOPE_CALENDAR_EVENTS = "https://www.googleapis.com/auth/calendar.events";
export const SCOPE_DIRECTORY_USER_READONLY = "https://www.googleapis.com/auth/admin.directory.user.readonly";
const SCOPE_CLOUD_PLATFORM = "https://www.googleapis.com/auth/cloud-platform";
export const GOOGLE_DELEGATION_SCOPES: readonly string[] = [SCOPE_CALENDAR_EVENTS, SCOPE_DIRECTORY_USER_READONLY];

export const WIF_AUDIENCE = /^\/\/iam\.googleapis\.com\/projects\/\d{1,20}\/locations\/global\/workloadIdentityPools\/[a-z0-9-]{4,32}\/providers\/[a-z0-9-]{4,32}$/;
export const SERVICE_ACCOUNT_EMAIL = /^[a-z][a-z0-9-]{4,28}[a-z0-9]@[a-z][a-z0-9-]{4,28}[a-z0-9]\.iam\.gserviceaccount\.com$/;

/** Delegierte Google-Tokens (DWD) – Gegenstück zu GraphTokenSource */
export interface GoogleTokenSource {
  getDelegatedToken(serviceAccountEmail: string, subject: string, scope: string): Promise<string>;
  invalidateDelegatedToken(serviceAccountEmail: string, subject: string, scope: string): void;
}

export interface GoogleWorkloadIdentityOptions {
  /** //iam.googleapis.com/projects/<Nummer>/locations/global/workloadIdentityPools/<Pool>/providers/<Provider> */
  audience: string;
  /** AWS-Region des Tasks (regionaler STS-Endpunkt im signierten Request) */
  region: string;
  /** Dienstkonten, die benutzt werden dürfen (linkedGoogleWorkspaces[].serviceAccountEmail) */
  serviceAccounts: readonly string[];
  /** Credentials der ECS-Task-Rolle, z. B. kmsClient.config.credentials() */
  awsCredentials: () => Promise<AwsCredentials>;
  fetchFn: FetchLike;
  sign?: SigV4Signer;
  now?: () => number;
  timeoutMs?: number;
}

type Cached = { token: string; expiresAtMs: number };
const SKEW_MS = 120_000;
const OAUTH_CODE = /^[a-z_]{1,48}$/;

/** Fester OAuth-/Google-Code aus einer Fehlerantwort ({ error: "invalid_grant" } bzw. { error: { status } }) */
function errorCode(text: string): string {
  try {
    const j = JSON.parse(text) as { error?: unknown };
    if (typeof j.error === "string" && OAUTH_CODE.test(j.error)) return j.error;
    const st = (j.error as { status?: unknown } | undefined)?.status;
    return typeof st === "string" && /^[A-Z_]{1,48}$/.test(st) ? st.toLowerCase() : "";
  } catch {
    return "";
  }
}

export class WorkloadIdentityGoogleTokenProvider implements GoogleTokenSource {
  private federated: Cached | null = null;
  private federatedInflight: Promise<string> | null = null;
  private readonly cache = new Map<string, Cached>();
  private readonly inflight = new Map<string, Promise<string>>();
  private readonly sign: SigV4Signer;
  private readonly now: () => number;

  constructor(private readonly o: GoogleWorkloadIdentityOptions) {
    if (!WIF_AUDIENCE.test(o.audience)) throw new Error("googleWorkloadIdentity.audience: //iam.googleapis.com/projects/<n>/locations/global/workloadIdentityPools/<pool>/providers/<provider>");
    if (!/^[a-z]{2,6}(-[a-z]+)+-\d{1,2}$/.test(o.region)) throw new Error("AWS-Region ungültig");
    for (const sa of o.serviceAccounts) if (!SERVICE_ACCOUNT_EMAIL.test(sa)) throw new Error("Dienstkonto-Adresse ungültig");
    this.sign = o.sign ?? signAwsRequest;
    this.now = o.now ?? (() => Date.now());
  }

  private key(sa: string, subject: string, scope: string): string {
    return `${sa}\u0000${subject}\u0000${scope}`;
  }

  async getDelegatedToken(serviceAccountEmail: string, subject: string, scope: string): Promise<string> {
    const sa = serviceAccountEmail.toLowerCase();
    const sub = normalizeMailbox(subject);
    // Konfigurationsfehler (kein Provider-Aufruf): nie ein fremdes Dienstkonto, nie ein anderer Scope
    if (!this.o.serviceAccounts.includes(sa)) throw new GoogleAuthError("config", 400, "service_account_not_allowed");
    if (!GOOGLE_DELEGATION_SCOPES.includes(scope)) throw new GoogleAuthError("config", 400, "scope_not_allowed");
    if (!sub) throw new GoogleAuthError("config", 400, "subject_invalid");
    const k = this.key(sa, sub, scope);
    const hit = this.cache.get(k);
    if (hit && hit.expiresAtMs - SKEW_MS > this.now()) return hit.token;
    const running = this.inflight.get(k);
    if (running) return running;
    const p = this.fetchDelegated(sa, sub, scope).finally(() => this.inflight.delete(k));
    this.inflight.set(k, p);
    const token = await p;
    return token;
  }

  invalidateDelegatedToken(serviceAccountEmail: string, subject: string, scope: string): void {
    const sub = normalizeMailbox(subject);
    if (sub) this.cache.delete(this.key(serviceAccountEmail.toLowerCase(), sub, scope));
  }

  private async post(stage: "sts" | "iam" | "oauth", url: string, headers: Record<string, string>, body: string): Promise<Record<string, unknown>> {
    let res;
    try {
      res = await this.o.fetchFn(url, { method: "POST", headers, body, signal: AbortSignal.timeout(this.o.timeoutMs ?? 10_000) });
    } catch (err) {
      if (err instanceof RunAborted) throw err;
      // Netz/Timeout: Status 0 = transient; die Meldung (enthält ggf. die URL) wird verworfen
      throw new GoogleAuthError(stage, 0, "");
    }
    const text = await res.text();
    if (res.status !== 200) throw new GoogleAuthError(stage, res.status, errorCode(text), res.headers.get("Retry-After"));
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new GoogleAuthError(stage, 502, "");
    }
  }

  /** Schritte 1–2: föderiertes Token aus der AWS-Identität */
  private async federatedToken(): Promise<string> {
    if (this.federated && this.federated.expiresAtMs - SKEW_MS > this.now()) return this.federated.token;
    if (this.federatedInflight) return this.federatedInflight;
    const run = (async () => {
      let creds: AwsCredentials;
      try {
        creds = await this.o.awsCredentials();
      } catch {
        throw new GoogleAuthError("aws", 0, "");
      }
      // Form wie in Googles Client-Bibliotheken (regionaler Endpunkt, kein Slash vor "?")
      const url = `https://sts.${this.o.region}.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15`;
      const signed = this.sign({
        method: "POST", url, region: this.o.region, service: "sts", credentials: creds, now: new Date(this.now()),
        headers: { "x-goog-cloud-target-resource": this.o.audience },
      });
      // Format laut Google "AWS external account": URL-kodiertes JSON { url, method, headers: [{ key, value }] }
      const subjectToken = encodeURIComponent(JSON.stringify({
        url, method: "POST", headers: Object.entries(signed).map(([key, value]) => ({ key: key === "authorization" ? "Authorization" : key, value })),
      }));
      const j = await this.post("sts", GOOGLE_STS_URL, { "Content-Type": "application/x-www-form-urlencoded" }, new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
        audience: this.o.audience,
        scope: SCOPE_CLOUD_PLATFORM,
        requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
        subject_token_type: "urn:ietf:params:aws:token-type:aws4_request",
        subject_token: subjectToken,
      }).toString());
      if (typeof j.access_token !== "string" || j.access_token === "") throw new GoogleAuthError("sts", 502, "");
      const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
      this.federated = { token: j.access_token, expiresAtMs: this.now() + ttl * 1000 };
      return j.access_token;
    })().finally(() => { this.federatedInflight = null; });
    this.federatedInflight = run;
    return run;
  }

  /** Schritte 3–4: DWD-Assertion von IAM signieren lassen, gegen ein Access Token für sub tauschen */
  private async fetchDelegated(sa: string, sub: string, scope: string): Promise<string> {
    const nowSec = Math.floor(this.now() / 1000);
    const payload = JSON.stringify({ iss: sa, sub, scope, aud: GOOGLE_OAUTH_TOKEN_URL, iat: nowSec, exp: nowSec + 3600 });
    const signUrl = `${GOOGLE_IAM_CREDENTIALS_BASE}/projects/-/serviceAccounts/${encodeURIComponent(sa)}:signJwt`;
    const signOnce = async () => this.post("iam", signUrl,
      { Authorization: `Bearer ${await this.federatedToken()}`, "Content-Type": "application/json" }, JSON.stringify({ payload }));
    let signed: Record<string, unknown>;
    try {
      signed = await signOnce();
    } catch (err) {
      // föderiertes Token abgelaufen/widerrufen → einmal neu tauschen
      if (!(err instanceof GoogleAuthError && err.stage === "iam" && err.status === 401)) throw err;
      this.federated = null;
      signed = await signOnce();
    }
    if (typeof signed.signedJwt !== "string" || signed.signedJwt.split(".").length !== 3) throw new GoogleAuthError("iam", 502, "");
    const j = await this.post("oauth", GOOGLE_OAUTH_TOKEN_URL, { "Content-Type": "application/x-www-form-urlencoded" }, new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: signed.signedJwt,
    }).toString());
    if (typeof j.access_token !== "string" || j.access_token === "") throw new GoogleAuthError("oauth", 502, "");
    const ttl = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : 3600;
    this.cache.set(this.key(sa, sub, scope), { token: j.access_token, expiresAtMs: this.now() + ttl * 1000 });
    return j.access_token;
  }
}
