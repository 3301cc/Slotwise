/**
 * Prüfung von Entra-ID-Access-Tokens für die Dashboard-API – ohne eigenes JWT-Secret.
 *
 * Das Frontend holt sich per MSAL (Authorization Code + PKCE) ein Access Token für die API-App
 * (Scope z. B. api://calensync-acme/Sync.Read). Die API prüft:
 *   * Signatur RS256 gegen die öffentlichen Schlüssel des Kunden-Mandanten (JWKS, gecacht)
 *   * iss = Kunden-Mandant (v2: login.microsoftonline.com/<tid>/v2.0, v1: sts.windows.net/<tid>/)
 *   * tid = Kunden-Mandant (Gast-Tokens anderer Mandanten werden abgewiesen)
 *   * aud ∈ konfigurierte Audiences, exp/nbf mit 60 s Toleranz
 *   * scp enthält den geforderten Scope (delegiert, im Namen des Nutzers)
 * Es gibt kein symmetrisches Secret im Backend, das abfließen und zum Fälschen von Tokens dienen könnte.
 */
import { createPublicKey, verify, type KeyObject } from "node:crypto";
import type { FetchLike } from "../../core/src/types.js";

export interface EntraPrincipal {
  /** Objekt-ID des Nutzers in Entra = scim_users.external_id */
  oid: string;
  tid: string;
  scopes: readonly string[];
  name: string | null;
}

export interface EntraAuthOptions {
  tenantId: string;
  audiences: readonly string[];
  requiredScope: string;
  fetchFn: FetchLike;
  now?: () => number;
  clockSkewSeconds?: number;
  /** Mindestabstand zwischen zwei JWKS-Abrufen (Schutz gegen kid-Flooding). Default 5 min. */
  minRefreshMs?: number;
}

export class AuthError extends Error {
  constructor(readonly status: 401 | 403, readonly code: string) {
    super(code);
  }
}

interface JwtHeader { alg?: unknown; kid?: unknown; typ?: unknown }
interface RsaJwk { kty?: string; n?: string; e?: string; kid?: string; use?: string }
interface JwtClaims {
  iss?: unknown; aud?: unknown; exp?: unknown; nbf?: unknown; tid?: unknown; oid?: unknown; scp?: unknown; name?: unknown;
}

const b64urlJson = <T>(part: string): T => JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;

export class EntraTokenVerifier {
  private keys = new Map<string, KeyObject>();
  private lastFetch = 0;
  private inflight: Promise<void> | null = null;

  constructor(private readonly o: EntraAuthOptions) {}

  private now(): number {
    return this.o.now?.() ?? Date.now();
  }

  private async refreshKeys(force: boolean): Promise<void> {
    if (!force && this.keys.size > 0) return;
    if (this.now() - this.lastFetch < (this.o.minRefreshMs ?? 5 * 60_000) && this.keys.size > 0) return;
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      const url = `https://login.microsoftonline.com/${encodeURIComponent(this.o.tenantId)}/discovery/v2.0/keys`;
      const res = await this.o.fetchFn(url, { method: "GET", headers: { Accept: "application/json" } });
      if (res.status !== 200) throw new AuthError(401, "jwks_unavailable");
      const body = JSON.parse(await res.text()) as { keys?: RsaJwk[] };
      const next = new Map<string, KeyObject>();
      for (const k of body.keys ?? []) {
        if (k.kty !== "RSA" || !k.kid || !k.n || !k.e || (k.use !== undefined && k.use !== "sig")) continue;
        next.set(k.kid, createPublicKey({ key: { kty: "RSA", n: k.n, e: k.e }, format: "jwk" }));
      }
      this.keys = next;
      this.lastFetch = this.now();
    })().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  /** Liest "Authorization: Bearer …" und liefert den geprüften Nutzer oder wirft AuthError. */
  /** requiredScope überschreibt den Standard-Scope (z. B. Sync.Write für schreibende Routen) */
  async verifyAuthorizationHeader(header: string | undefined, requiredScope?: string): Promise<EntraPrincipal> {
    const m = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(header ?? "");
    if (!m) throw new AuthError(401, "missing_bearer_token");
    return this.verify(m[1], requiredScope);
  }

  async verify(token: string, requiredScope: string = this.o.requiredScope): Promise<EntraPrincipal> {
    if (token.length > 16_384) throw new AuthError(401, "token_too_large");
    const [h, p, s] = token.split(".");
    let header: JwtHeader, claims: JwtClaims;
    try {
      header = b64urlJson<JwtHeader>(h);
      claims = b64urlJson<JwtClaims>(p);
    } catch {
      throw new AuthError(401, "malformed_token");
    }
    if (header.alg !== "RS256" || typeof header.kid !== "string") throw new AuthError(401, "unsupported_alg");

    await this.refreshKeys(false);
    let key = this.keys.get(header.kid);
    if (!key) {
      await this.refreshKeys(true); // Schlüsselrotation bei Microsoft
      key = this.keys.get(header.kid);
    }
    if (!key) throw new AuthError(401, "unknown_key");
    if (!verify("RSA-SHA256", Buffer.from(`${h}.${p}`), key, Buffer.from(s, "base64url"))) throw new AuthError(401, "bad_signature");

    const nowSec = Math.floor(this.now() / 1000);
    const skew = this.o.clockSkewSeconds ?? 60;
    if (typeof claims.exp !== "number" || claims.exp + skew < nowSec) throw new AuthError(401, "token_expired");
    if (typeof claims.nbf === "number" && claims.nbf - skew > nowSec) throw new AuthError(401, "token_not_yet_valid");

    const tid = this.o.tenantId.toLowerCase();
    if (typeof claims.tid !== "string" || claims.tid.toLowerCase() !== tid) throw new AuthError(401, "wrong_tenant");
    const iss = typeof claims.iss === "string" ? claims.iss.toLowerCase() : "";
    if (iss !== `https://login.microsoftonline.com/${tid}/v2.0` && iss !== `https://sts.windows.net/${tid}/`) throw new AuthError(401, "wrong_issuer");
    if (typeof claims.aud !== "string" || !this.o.audiences.includes(claims.aud)) throw new AuthError(401, "wrong_audience");
    if (typeof claims.oid !== "string" || claims.oid === "") throw new AuthError(401, "missing_oid");

    const scopes = typeof claims.scp === "string" ? claims.scp.split(" ").filter(Boolean) : [];
    if (!scopes.includes(requiredScope)) throw new AuthError(403, "insufficient_scope");
    return { oid: claims.oid, tid, scopes, name: typeof claims.name === "string" ? claims.name : null };
  }
}
