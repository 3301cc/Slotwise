/**
 * R1 · Option A · AdapterRegistry mit EU-Modus-Durchsetzung.
 *
 * Die Registry kennt zwei Dinge getrennt voneinander:
 *   - Metadaten (Katalog): für jede Integration genau ein Eintrag, validiert.
 *   - Bindungen (Factories): Laufzeit-Implementierungen, die aus den
 *     Zugangsdaten eines Tenants einen Adapter bauen.
 *
 * `resolve()` ist der einzige Weg an einen Adapter. Er prüft den EU-Modus des
 * Tenants gegen die Stufe des Adapters und wirft EuModeViolationError, bevor
 * irgendein Netzwerkaufruf stattfindet. Damit ist der EU-Modus keine
 * UI-Filterung, sondern eine serverseitige Invariante.
 */
import { ADAPTER_CATALOG } from './catalog.js';
import { assertMetadataValid, type AdapterMetadata, type IntegrationCategory, type Tier } from './metadata.js';
import type { Adapter, AdapterFor } from './ports.js';

export type EuMode = 'off' | 'balanced' | 'strict';

export const EU_MODE_MAX_TIER: Record<EuMode, Tier> = { strict: 1, balanced: 2, off: 3 };

export const EU_MODE_LABELS_DE: Record<EuMode, string> = {
  strict: 'EU-Modus streng: nur Anbieter mit Sitz und Hosting im EWR (Stufe 1)',
  balanced: 'EU-Modus ausgewogen: Hosting im EWR, Anbieter auch außerhalb (Stufe 1–2)',
  off: 'EU-Modus aus: alle Integrationen (Stufe 1–3)',
};

export function isAllowedInEuMode(tier: Tier, mode: EuMode): boolean {
  return tier <= EU_MODE_MAX_TIER[mode];
}

/** Zugangsdaten kommen aus dem Secret-Store des Tenants; die Registry sieht nur die Struktur. */
export interface AdapterCredentials {
  tenantId: string;
  integrationId: string;
  /** z. B. OAuth-Refresh-Token, API-Key, CalDAV-Passwort; ausschließlich aus dem Vault */
  secrets: Record<string, string>;
  /** unkritische Konfiguration aus tenant_integrations.config (Server-URL, Kalender-ID, Kanal) */
  config: Record<string, string>;
}

export type AdapterFactory<A extends Adapter = Adapter> = (credentials: AdapterCredentials) => A;

export class UnknownAdapterError extends Error {
  constructor(public readonly adapterId: string) {
    super(`Unbekannte Integration "${adapterId}"`);
  }
}

export class AdapterNotBoundError extends Error {
  constructor(public readonly adapterId: string) {
    super(`Für "${adapterId}" ist keine Implementierung registriert`);
  }
}

export class AdapterCategoryMismatchError extends Error {
  constructor(public readonly adapterId: string, expected: IntegrationCategory, actual: IntegrationCategory) {
    super(`"${adapterId}" ist ${actual}, erwartet ${expected}`);
  }
}

export class EuModeViolationError extends Error {
  readonly httpStatus = 403;
  constructor(public readonly adapterId: string, public readonly tier: Tier, public readonly mode: EuMode) {
    super(`"${adapterId}" (Stufe ${tier}) ist im ${EU_MODE_LABELS_DE[mode]} nicht zulässig`);
  }
}

export interface TenantEuContext {
  tenantId: string;
  euMode: EuMode;
}

export class AdapterRegistry {
  private readonly meta = new Map<string, AdapterMetadata>();
  private readonly factories = new Map<string, AdapterFactory>();

  /** Standard: gesamter Katalog aus catalog.ts, jeder Eintrag validiert. */
  static withCatalog(catalog: readonly AdapterMetadata[] = ADAPTER_CATALOG): AdapterRegistry {
    const r = new AdapterRegistry();
    for (const m of catalog) r.registerMeta(m);
    return r;
  }

  registerMeta(m: AdapterMetadata): void {
    assertMetadataValid(m);
    if (this.meta.has(m.id)) throw new Error(`Integration "${m.id}" doppelt registriert`);
    this.meta.set(m.id, m);
  }

  bind<A extends Adapter>(id: string, factory: AdapterFactory<A>): void {
    const m = this.meta.get(id);
    if (!m) throw new UnknownAdapterError(id);
    this.factories.set(id, factory as AdapterFactory);
  }

  has(id: string): boolean {
    return this.meta.has(id);
  }

  isBound(id: string): boolean {
    return this.factories.has(id);
  }

  metadata(id: string): AdapterMetadata {
    const m = this.meta.get(id);
    if (!m) throw new UnknownAdapterError(id);
    return m;
  }

  all(): readonly AdapterMetadata[] {
    return [...this.meta.values()];
  }

  /** Katalog, gefiltert nach EU-Modus (und optional Kategorie) – für die UI-Auswahl. */
  allowedFor(mode: EuMode, category?: IntegrationCategory): readonly AdapterMetadata[] {
    return this.all().filter((m) => isAllowedInEuMode(m.tier, mode) && (category === undefined || m.category === category));
  }

  /** Prüft ohne Instanziierung, ob ein Tenant die Integration nutzen darf. */
  assertAllowed(tenant: TenantEuContext, id: string): AdapterMetadata {
    const m = this.metadata(id);
    if (!isAllowedInEuMode(m.tier, tenant.euMode)) throw new EuModeViolationError(id, m.tier, tenant.euMode);
    return m;
  }

  /**
   * Einziger Weg zu einer Adapter-Instanz. Reihenfolge der Prüfungen:
   * bekannt → Kategorie passt → EU-Modus erlaubt → Implementierung gebunden.
   */
  resolve<C extends IntegrationCategory>(tenant: TenantEuContext, id: string, category: C, credentials: AdapterCredentials): AdapterFor<C> {
    const m = this.metadata(id);
    if (m.category !== category) throw new AdapterCategoryMismatchError(id, category, m.category);
    this.assertAllowed(tenant, id);
    const factory = this.factories.get(id);
    if (!factory) throw new AdapterNotBoundError(id);
    if (credentials.tenantId !== tenant.tenantId || credentials.integrationId !== id) {
      throw new Error(`Zugangsdaten gehören nicht zu Tenant ${tenant.tenantId} / Integration ${id}`);
    }
    const adapter = factory(credentials);
    if (adapter.meta.id !== id) throw new Error(`Factory für "${id}" liefert Adapter mit meta.id "${adapter.meta.id}"`);
    return adapter as AdapterFor<C>;
  }
}
