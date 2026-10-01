import { createHash, timingSafeEqual } from "node:crypto";
import type { TenantAuthenticator } from "./types.js";

/**
 * Bearer-Token-Authentisierung für den SCIM-Client des Kunden (Entra "Secret Token" bzw. Okta "API Token").
 *
 * Gespeichert wird nur SHA-256(pepper || token). Der Pepper liegt in Secrets Manager (app-config), der Hash in
 * der Datenbank. Der Vergleich läuft timing-sicher über ALLE Einträge, damit die Antwortzeit nicht verrät,
 * ob/wo ein Präfix passt. Token-Rotation: neuen Hash hinzufügen, IdP umstellen, alten Hash entfernen.
 */
export interface TokenEntry {
  tenantId: string;
  sha256Hex: string;
  /** ISO-Datum; abgelaufene Tokens werden abgelehnt (Rotation erzwingen, z. B. 180 Tage) */
  expiresAt: string;
}

export function hashToken(pepper: string, token: string): string {
  return createHash("sha256").update(pepper).update("\u0000").update(token).digest("hex");
}

export interface AuthenticatorHooks {
  /**
   * Ein korrektes, aber abgelaufenes Token wurde benutzt. Der IdP bekommt weiter 401 – das Ereignis ist
   * für den Betrieb: ohne gültiges Token stoppt das Offboarding, gesperrte Nutzer behielten den Sync.
   */
  expiredTokenUsed?(tenantId: string): void;
}

export class HashedTokenAuthenticator implements TenantAuthenticator {
  constructor(
    private readonly pepper: string,
    private readonly entries: () => Promise<TokenEntry[]>,
    private readonly now: () => Date = () => new Date(),
    private readonly hooks: AuthenticatorHooks = {},
  ) {
    if (pepper.length < 32) throw new Error("SCIM-Pepper muss mindestens 32 Zeichen haben");
  }

  async authenticate(bearerToken: string): Promise<string | null> {
    if (bearerToken.length < 32 || bearerToken.length > 512) return null;
    const candidate = Buffer.from(hashToken(this.pepper, bearerToken), "hex");
    let match: string | null = null;
    let expired: string | null = null;
    const nowMs = this.now().getTime();
    for (const e of await this.entries()) {
      const stored = Buffer.from(e.sha256Hex, "hex");
      const equal = stored.length === candidate.length && timingSafeEqual(stored, candidate);
      // kein frühes return: konstante Arbeit über alle Einträge. Ungültiges expiresAt → NaN → abgelehnt.
      const valid = Date.parse(e.expiresAt) > nowMs;
      if (equal && valid && match === null) match = e.tenantId;
      if (equal && !valid) expired = e.tenantId;
    }
    if (match === null && expired !== null) this.hooks.expiredTokenUsed?.(expired);
    return match;
  }
}
