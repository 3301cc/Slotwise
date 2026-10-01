/**
 * App-Token für Microsoft Graph per Client-Credentials-Flow mit zertifikatsbasierter Client-Assertion.
 *
 * Der private Schlüssel liegt als asymmetrischer KMS-Schlüssel (alias/<tenant>-signing, RSA_2048) in AWS und
 * verlässt KMS nie. Diese Klasse baut das JWT, lässt nur den Hash von KMS signieren und tauscht es beim
 * Entra-Token-Endpunkt gegen ein Access Token. Kein Client-Secret existiert.
 *
 * Verdrahtung mit dem AWS SDK (außerhalb dieses Moduls, damit es ohne SDK testbar bleibt):
 *   const kms = new KMSClient({ region: "eu-central-1" });
 *   const sign = async (digest: Buffer) => Buffer.from((await kms.send(new SignCommand({
 *     KeyId: process.env.SIGNING_KMS_KEY_ARN, Message: digest, MessageType: "DIGEST",
 *     SigningAlgorithm: "RSASSA_PKCS1_V1_5_SHA_256" }))).Signature!);
 */
import { createHash, randomUUID } from "node:crypto";
import type { AppTokenProvider, FetchLike, Provider } from "./types.js";

export interface EntraAppConfig {
  /** Entra-Mandanten-ID des KUNDEN (tid) */
  entraTenantId: string;
  clientId: string;
  /** SHA-256-Fingerprint des hinterlegten Zertifikats (DER), hex – für den Header x5t#S256 */
  certSha256Hex: string;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

/**
 * Graph-Token für einen bestimmten Entra-Mandanten. Der Sync schreibt ggf. in ein Postfach eines verknüpften
 * Mandanten (Mutter/Tochter): dieselbe Multi-Tenant-App, dort per Admin-Consent freigegeben, dieselbe
 * KMS-signierte Assertion – nur der Token-Endpunkt (und damit aud) ist der des verknüpften Mandanten.
 * entraTenantId = null → Heim-Mandant des CalenSync-Mandanten.
 */
export interface GraphTokenSource {
  getGraphToken(tenantId: string, entraTenantId: string | null): Promise<string>;
  invalidateGraphToken(tenantId: string, entraTenantId: string | null): void;
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class KmsSignedGraphTokenProvider implements AppTokenProvider, GraphTokenSource {
  /**
   * Schlüssel = (Entra-Mandant, Client-ID) – NICHT die CalenSync-Mandanten-ID: ein Token für Mandant A darf nie
   * für einen Aufruf in Mandant B aus dem Cache kommen (Graph würde ihn ablehnen oder – schlimmer – im falschen
   * Mandanten ausführen).
   */
  private cache = new Map<string, { token: string; expiresAtMs: number }>();
  /** zuletzt benutzter Cache-Schlüssel je (CalenSync-Mandant, Ziel) – für das synchrone invalidate() */
  private lastKey = new Map<string, string>();

  constructor(
    private readonly configFor: (tenantId: string) => Promise<EntraAppConfig>,
    /** signiert einen SHA-256-Digest mit RSASSA-PKCS1-v1_5 (KMS) */
    private readonly signDigest: (digest: Buffer) => Promise<Buffer>,
    private readonly fetchFn: FetchLike,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getToken(tenantId: string, provider: Provider): Promise<string> {
    if (provider !== "microsoft") throw new Error("KmsSignedGraphTokenProvider liefert nur Microsoft-Tokens");
    return this.getGraphToken(tenantId, null);
  }

  async getGraphToken(tenantId: string, entraTenantId: string | null): Promise<string> {
    if (entraTenantId !== null && !GUID.test(entraTenantId)) throw new Error("entraTenantId muss eine GUID sein");
    const base = await this.configFor(tenantId);
    const cfg: EntraAppConfig = entraTenantId === null ? base : { ...base, entraTenantId };
    const key = `${cfg.entraTenantId.toLowerCase()}|${cfg.clientId.toLowerCase()}`;
    this.lastKey.set(`${tenantId}\u0000${entraTenantId ?? ""}`, key);
    const hit = this.cache.get(key);
    if (hit && hit.expiresAtMs - 120_000 > this.now()) return hit.token;

    const tokenUrl = `https://login.microsoftonline.com/${encodeURIComponent(cfg.entraTenantId)}/oauth2/v2.0/token`;
    const nowSec = Math.floor(this.now() / 1000);
    const header = { alg: "RS256", typ: "JWT", "x5t#S256": Buffer.from(cfg.certSha256Hex, "hex").toString("base64url") };
    const claims = { aud: tokenUrl, iss: cfg.clientId, sub: cfg.clientId, jti: randomUUID(), nbf: nowSec, iat: nowSec, exp: nowSec + 300 };
    const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
    const signature = await this.signDigest(createHash("sha256").update(signingInput).digest());
    const assertion = `${signingInput}.${b64url(signature)}`;

    const body = new URLSearchParams({
      client_id: cfg.clientId,
      scope: "https://graph.microsoft.com/.default",
      grant_type: "client_credentials",
      client_assertion_type: "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
      client_assertion: assertion,
    }).toString();
    const res = await this.fetchFn(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    });
    const text = await res.text();
    if (res.status !== 200) throw new Error(`Entra-Token-Endpunkt ${res.status}: ${text.slice(0, 200)}`);
    const json = JSON.parse(text) as { access_token: string; expires_in: number };
    this.cache.set(key, { token: json.access_token, expiresAtMs: this.now() + json.expires_in * 1000 });
    return json.access_token;
  }

  invalidate(tenantId: string): void {
    this.invalidateGraphToken(tenantId, null);
  }

  invalidateGraphToken(tenantId: string, entraTenantId: string | null): void {
    const key = this.lastKey.get(`${tenantId}\u0000${entraTenantId ?? ""}`);
    if (key) this.cache.delete(key);
  }
}
