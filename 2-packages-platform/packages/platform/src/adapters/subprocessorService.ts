/**
 * R1 · Option A · SubprocessorService.
 *
 * Erzeugt aus (1) den Plattform-Subprozessoren (config/platform-subprocessors.json),
 * (2) den vom Tenant tatsächlich genutzten Funktionen (SMS, KI-Agent) und
 * (3) den vom Tenant aktivierten Integrationen (tenant_integrations) die
 * Subprozessorenliste als JSON und als AVV-Anhang (HTML, druck-/PDF-fähig,
 * ohne externe Ressourcen).
 *
 * Rechtliche Einordnung, die sich im Aufbau des Anhangs spiegelt:
 *   A  Unterauftragsverarbeiter von Slotwise (Art. 28 Abs. 2 und 4 DSGVO):
 *      Plattform-Betrieb und funktionsgebundene Dienste, die Slotwise beauftragt.
 *   B  Vom Kunden verbundene Drittdienste: Slotwise übermittelt auf dokumentierte
 *      Weisung des Kunden (Art. 28 Abs. 3 lit. a) an Dienste, mit denen der Kunde
 *      selbst einen Vertrag hat (z. B. sein Google-Workspace-Konto). Sie werden
 *      transparent gelistet, sind aber keine Unterauftragsverarbeiter von Slotwise.
 *   C  Komponenten im Eigenbetrieb von Slotwise (Jitsi, Webhooks): keine Dritten.
 *
 * Jede Liste erhält einen Versions-Hash; die Differenz zweier Stände ist die
 * Änderungsmitteilung nach Art. 28 Abs. 2 Satz 2 DSGVO.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import type { PgLike } from '../booking/pgBookingRepository.js';
import type { Clock } from '../booking/types.js';
import type { Entitlements, FeatureKey, TenantPlan } from '../entitlements/entitlements.js';
import {
  assertMetadataValid,
  DATA_CATEGORY_LABELS_DE,
  TIER_LABELS_DE,
  TRANSFER_MECHANISM_LABELS_DE,
  type AdapterMetadata,
  type DataCategory,
  type Tier,
  type TransferMechanism,
} from './metadata.js';
import type { AdapterRegistry, EuMode } from './registry.js';
import { EU_MODE_LABELS_DE } from './registry.js';
import type { TenantIntegrationRepository, TenantPrivacySettings } from './tenantIntegrations.js';

// ---------------------------------------------------------------------------
// Plattform-Konfiguration
// ---------------------------------------------------------------------------

export type PlatformScope = 'platform' | `feature:${FeatureKey}`;

export interface PlatformSubprocessor {
  id: string;
  scope: PlatformScope;
  category: 'hosting' | 'messaging' | 'ai_telephony';
  vendor: string;
  legal_entity: string;
  owner_country: string;
  hosting_regions: string[];
  tier: Tier;
  transfer_mechanism: TransferMechanism;
  purpose: string;
  data_categories: DataCategory[];
  documentation_url: string;
  certifications: string[];
}

export interface PlatformSubprocessorConfig {
  version: string;
  processor: { name: string; legal_entity: string; address: string; dpo_email: string };
  entries: PlatformSubprocessor[];
}

export function validatePlatformConfig(raw: unknown): PlatformSubprocessorConfig {
  if (typeof raw !== 'object' || raw === null) throw new Error('platform-subprocessors.json: kein Objekt');
  const c = raw as PlatformSubprocessorConfig;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(c.version)) throw new Error('platform-subprocessors.json: version muss YYYY-MM-DD sein');
  for (const k of ['name', 'legal_entity', 'address', 'dpo_email'] as const) {
    if (!c.processor?.[k]?.trim()) throw new Error(`platform-subprocessors.json: processor.${k} fehlt`);
  }
  if (!Array.isArray(c.entries) || c.entries.length === 0) throw new Error('platform-subprocessors.json: entries leer');
  const ids = new Set<string>();
  for (const e of c.entries) {
    if (ids.has(e.id)) throw new Error(`platform-subprocessors.json: id ${e.id} doppelt`);
    ids.add(e.id);
    if (!(e.scope === 'platform' || /^feature:[a-zA-Z0-9]+$/.test(e.scope))) throw new Error(`platform-subprocessors.json: scope ${e.scope} ungültig`);
    if (!['hosting', 'messaging', 'ai_telephony'].includes(e.category)) throw new Error(`platform-subprocessors.json: category ${e.category} ungültig`);
    if (!Array.isArray(e.certifications)) throw new Error(`platform-subprocessors.json: ${e.id}.certifications`);
    // Dieselben Regeln wie für Adapter (Stufe aus Sitz und Hosting, Rechtsgrundlage passend):
    assertMetadataValid({
      id: e.id, category: e.category, vendor: e.vendor, legal_entity: e.legal_entity,
      owner_country: e.owner_country, hosting_regions: e.hosting_regions, tier: e.tier, transfer_mechanism: e.transfer_mechanism,
      purpose: e.purpose, data_categories: e.data_categories, documentation_url: e.documentation_url, kind: 'native', operated_by: 'vendor',
    });
  }
  if (!c.entries.some((e) => e.scope === 'platform' && e.category === 'hosting')) throw new Error('platform-subprocessors.json: Hosting-Eintrag mit scope platform fehlt');
  return c;
}

export function loadPlatformConfig(path = new URL('../../config/platform-subprocessors.json', import.meta.url)): PlatformSubprocessorConfig {
  return validatePlatformConfig(JSON.parse(readFileSync(path, 'utf8')));
}

// ---------------------------------------------------------------------------
// Export-Struktur
// ---------------------------------------------------------------------------

export type SubprocessorRole = 'subprocessor' | 'customer_instructed_recipient' | 'platform_component';

export interface SubprocessorEntry {
  id: string;
  role: SubprocessorRole;
  /** Warum der Eintrag in der Liste steht: Plattform, genutzte Funktion oder aktivierte Integration */
  basis: 'platform' | `feature:${string}` | `integration:${string}`;
  vendor: string;
  legal_entity: string;
  owner_country: string;
  hosting_regions: string[];
  tier: Tier;
  transfer_mechanism: TransferMechanism;
  purpose: string;
  data_categories: DataCategory[];
  documentation_url: string;
  certifications: string[];
  /** Nur bei Integrationen: Zeitpunkt der Aktivierung durch den Kunden */
  activated_at: string | null;
}

export interface SubprocessorExport {
  schema: 'slotwise.subprocessors/1';
  generated_at: string;
  config_version: string;
  tenant_id: string;
  eu_mode: EuMode;
  processor: PlatformSubprocessorConfig['processor'];
  controller: { name: string; address: string; dpo_email: string | null };
  /** SHA-256 über die kanonisch serialisierten Einträge (ohne generated_at) */
  version_hash: string;
  subprocessors: SubprocessorEntry[];
  customer_instructed_recipients: SubprocessorEntry[];
  platform_components: SubprocessorEntry[];
}

export interface SubprocessorSnapshotRepository {
  latest(tenantId: string): Promise<{ versionHash: string; payload: SubprocessorExport; generatedAt: Date } | null>;
  save(tenantId: string, versionHash: string, payload: SubprocessorExport): Promise<void>;
}

export interface SubprocessorDiff {
  added: SubprocessorEntry[];
  removed: SubprocessorEntry[];
  changed: { before: SubprocessorEntry; after: SubprocessorEntry }[];
  unchanged: number;
}

const ENTRY_HASH_FIELDS: (keyof SubprocessorEntry)[] = [
  'id', 'role', 'basis', 'vendor', 'legal_entity', 'owner_country', 'hosting_regions', 'tier', 'transfer_mechanism', 'purpose', 'data_categories', 'documentation_url', 'certifications',
];

function canonical(entry: SubprocessorEntry): string {
  const o: Record<string, unknown> = {};
  for (const k of ENTRY_HASH_FIELDS) o[k] = entry[k];
  return JSON.stringify(o);
}

export function versionHashOf(entries: SubprocessorEntry[]): string {
  const sorted = [...entries].sort((a, b) => a.id.localeCompare(b.id)).map(canonical).join('\n');
  return createHash('sha256').update(sorted).digest('hex');
}

export function diffExports(prev: SubprocessorExport | null, next: SubprocessorExport): SubprocessorDiff {
  const flat = (e: SubprocessorExport | null) => (e ? [...e.subprocessors, ...e.customer_instructed_recipients, ...e.platform_components] : []);
  const before = new Map(flat(prev).map((e) => [e.id, e]));
  const after = new Map(flat(next).map((e) => [e.id, e]));
  const diff: SubprocessorDiff = { added: [], removed: [], changed: [], unchanged: 0 };
  for (const [id, a] of after) {
    const b = before.get(id);
    if (!b) diff.added.push(a);
    else if (canonical(a) !== canonical(b)) diff.changed.push({ before: b, after: a });
    else diff.unchanged++;
  }
  for (const [id, b] of before) if (!after.has(id)) diff.removed.push(b);
  return diff;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export interface SubprocessorServiceDeps {
  registry: AdapterRegistry;
  integrations: TenantIntegrationRepository;
  entitlements: Entitlements;
  loadPlan(tenantId: string): Promise<TenantPlan>;
  /** Funktionen, die der Tenant tatsächlich eingeschaltet hat (nicht nur im Plan enthalten). */
  enabledFeatures(tenantId: string): Promise<ReadonlySet<FeatureKey>>;
  snapshots: SubprocessorSnapshotRepository;
  clock: Clock;
  platform?: PlatformSubprocessorConfig;
}

export class SubprocessorService {
  private readonly platform: PlatformSubprocessorConfig;

  constructor(private readonly d: SubprocessorServiceDeps) {
    this.platform = d.platform ?? loadPlatformConfig();
  }

  async build(tenantId: string): Promise<SubprocessorExport> {
    const [plan, settings, active, enabled] = await Promise.all([
      this.d.loadPlan(tenantId),
      this.d.integrations.getPrivacySettings(tenantId),
      this.d.integrations.listActive(tenantId),
      this.d.enabledFeatures(tenantId),
    ]);

    const subprocessors: SubprocessorEntry[] = [];
    for (const e of this.platform.entries) {
      if (e.scope === 'platform') {
        subprocessors.push(this.fromPlatform(e, 'platform'));
        continue;
      }
      const feature = e.scope.slice('feature:'.length) as FeatureKey;
      // Nur, wenn der Plan die Funktion enthält UND der Tenant sie nutzt.
      if (this.d.entitlements.can(plan, feature) && enabled.has(feature)) subprocessors.push(this.fromPlatform(e, e.scope));
    }

    const recipients: SubprocessorEntry[] = [];
    const components: SubprocessorEntry[] = [];
    for (const a of active) {
      const m = this.d.registry.metadata(a.integrationId);
      const entry = this.fromAdapter(m, a.activatedAt);
      if (m.operated_by === 'slotwise') components.push(entry);
      else if (m.operated_by === 'vendor') recipients.push(entry);
      // operated_by === 'customer' (eigener CalDAV-Server): System des Kunden, kein Empfänger im Sinne der Liste.
    }

    // Über Make angebundene Dienste implizieren Make selbst als Empfänger.
    if (recipients.some((r) => this.d.registry.metadata(r.id).kind === 'via-make') && !recipients.some((r) => r.id === 'make')) {
      const make = active.find((a) => a.integrationId === 'make');
      recipients.push(this.fromAdapter(this.d.registry.metadata('make'), make?.activatedAt ?? null));
    }

    const byVendor = (x: SubprocessorEntry, y: SubprocessorEntry) => x.vendor.localeCompare(y.vendor, 'de');
    subprocessors.sort(byVendor);
    recipients.sort(byVendor);
    components.sort(byVendor);

    const all = [...subprocessors, ...recipients, ...components];
    return {
      schema: 'slotwise.subprocessors/1',
      generated_at: this.d.clock.now().toISOString(),
      config_version: this.platform.version,
      tenant_id: tenantId,
      eu_mode: settings.euMode,
      processor: this.platform.processor,
      controller: { name: settings.controllerName, address: settings.controllerAddress, dpo_email: settings.dpoEmail },
      version_hash: versionHashOf(all),
      subprocessors,
      customer_instructed_recipients: recipients,
      platform_components: components,
    };
  }

  /** Erzeugt den aktuellen Stand, speichert ihn bei Änderung und liefert die Differenz zum letzten Snapshot. */
  async publish(tenantId: string): Promise<{ current: SubprocessorExport; changed: boolean; diff: SubprocessorDiff }> {
    const current = await this.build(tenantId);
    const prev = await this.d.snapshots.latest(tenantId);
    const changed = prev?.versionHash !== current.version_hash;
    const diff = diffExports(prev?.payload ?? null, current);
    if (changed) await this.d.snapshots.save(tenantId, current.version_hash, current);
    return { current, changed, diff };
  }

  toJson(exp: SubprocessorExport): string {
    return JSON.stringify(exp, null, 2);
  }

  /** AVV-Anhang als eigenständiges HTML (Inline-CSS, keine externen Ressourcen, @page für PDF-Druck). */
  renderAvvAnnexHtml(exp: SubprocessorExport, settings?: Pick<TenantPrivacySettings, 'controllerName' | 'controllerAddress'>): string {
    const controllerName = settings?.controllerName || exp.controller.name || 'Verantwortlicher gemäß Hauptvertrag';
    const controllerAddress = settings?.controllerAddress || exp.controller.address || '';
    const stand = new Date(exp.generated_at).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', timeZone: 'Europe/Berlin' });

    const row = (n: number, e: SubprocessorEntry) => `
      <tr>
        <td class="n">${n}</td>
        <td><strong>${esc(e.vendor)}</strong><br><span class="muted">${esc(e.legal_entity)}</span></td>
        <td>${esc(countryLabel(e.owner_country))}</td>
        <td>${e.hosting_regions.map(countryLabel).map(esc).join(', ')}<br><span class="muted">${esc(TIER_LABELS_DE[e.tier])}</span></td>
        <td>${esc(e.purpose)}</td>
        <td>${e.data_categories.map((c) => esc(DATA_CATEGORY_LABELS_DE[c])).join('; ')}</td>
        <td>${esc(TRANSFER_MECHANISM_LABELS_DE[e.transfer_mechanism])}${e.certifications.length ? `<br><span class="muted">Zertifizierungen: ${e.certifications.map(esc).join(', ')}</span>` : ''}${e.activated_at ? `<br><span class="muted">Verbunden am ${esc(new Date(e.activated_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' }))}</span>` : ''}</td>
      </tr>`;

    const table = (entries: SubprocessorEntry[], emptyText: string) =>
      entries.length === 0
        ? `<p class="empty">${esc(emptyText)}</p>`
        : `<table>
        <thead><tr><th>Nr.</th><th>Unternehmen</th><th>Sitz</th><th>Verarbeitungsort</th><th>Zweck der Verarbeitung</th><th>Datenkategorien</th><th>Drittlandübermittlung / Garantien</th></tr></thead>
        <tbody>${entries.map((e, i) => row(i + 1, e)).join('')}</tbody>
      </table>`;

    return `<!DOCTYPE html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Anlage Unterauftragsverarbeiter · ${esc(controllerName)} · Stand ${esc(stand)}</title>
<style>
  @page { size: A4 landscape; margin: 14mm; }
  :root { color-scheme: light; }
  html, body { margin: 0; padding: 0; background: #fff; color: #111827; font: 10.5pt/1.45 "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
  main { max-width: 1120px; margin: 0 auto; padding: 24px 16px; }
  h1 { font-size: 18pt; margin: 0 0 4px; }
  h2 { font-size: 13pt; margin: 28px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e5e7eb; }
  .meta { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px 24px; margin: 16px 0 8px; font-size: 10pt; }
  .meta div span { display: block; color: #6b7280; font-size: 9pt; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; font-size: 9pt; page-break-inside: auto; }
  th, td { border: 1px solid #d1d5db; padding: 6px 7px; vertical-align: top; text-align: left; }
  th { background: #f3f4f6; font-weight: 600; }
  td.n { width: 28px; text-align: right; }
  tr { page-break-inside: avoid; }
  .muted { color: #6b7280; font-size: 8.5pt; }
  .empty { color: #6b7280; font-style: italic; }
  .note { font-size: 9.5pt; color: #374151; margin: 8px 0; }
  .hash { font-family: ui-monospace, "SFMono-Regular", Menlo, monospace; font-size: 8.5pt; word-break: break-all; }
  footer { margin-top: 32px; font-size: 8.5pt; color: #6b7280; }
</style>
</head>
<body>
<main>
  <h1>Anlage: Genehmigte Unterauftragsverarbeiter und verbundene Dienste</h1>
  <p class="note">Anlage zum Vertrag über die Auftragsverarbeitung nach Art. 28 DSGVO. Erzeugt aus der Konfiguration des Kundenkontos; Stand ${esc(stand)}.</p>
  <div class="meta">
    <div><span>Verantwortlicher (Art. 4 Nr. 7 DSGVO)</span>${esc(controllerName)}${controllerAddress ? `<br>${esc(controllerAddress)}` : ''}</div>
    <div><span>Auftragsverarbeiter (Art. 4 Nr. 8 DSGVO)</span>${esc(exp.processor.legal_entity)}<br>${esc(exp.processor.address)}<br>Datenschutz: ${esc(exp.processor.dpo_email)}</div>
    <div><span>EU-Modus des Kontos</span>${esc(EU_MODE_LABELS_DE[exp.eu_mode])}</div>
    <div><span>Version dieser Anlage</span><span class="hash">${esc(exp.version_hash)}</span>Konfigurationsstand ${esc(exp.config_version)}</div>
  </div>

  <h2>A. Unterauftragsverarbeiter des Auftragsverarbeiters (Art. 28 Abs. 2 und 4 DSGVO)</h2>
  <p class="note">Der Verantwortliche genehmigt die Beauftragung der folgenden weiteren Auftragsverarbeiter. Der Auftragsverarbeiter hat mit jedem von ihnen einen Vertrag geschlossen, der dieselben Datenschutzpflichten auferlegt wie der Hauptvertrag.</p>
  ${table(exp.subprocessors, 'Keine Einträge.')}

  <h2>B. Vom Verantwortlichen verbundene Drittdienste (Übermittlung auf dokumentierte Weisung, Art. 28 Abs. 3 lit. a DSGVO)</h2>
  <p class="note">Die folgenden Dienste hat der Verantwortliche in seinem Konto selbst verbunden. Der Auftragsverarbeiter übermittelt an sie ausschließlich die für die Verbindung erforderlichen Daten und nur auf Grundlage dieser Verbindung. Vertragspartner des jeweiligen Dienstes ist der Verantwortliche; die Dienste sind keine Unterauftragsverarbeiter des Auftragsverarbeiters. Der Verantwortliche kann jede Verbindung jederzeit im Konto trennen.</p>
  ${table(exp.customer_instructed_recipients, 'Keine Drittdienste verbunden.')}

  <h2>C. Vom Auftragsverarbeiter selbst betriebene Komponenten</h2>
  <p class="note">Komponenten, die der Auftragsverarbeiter auf der unter A genannten Infrastruktur selbst betreibt. Es sind keine weiteren Dritten beteiligt.</p>
  ${table(exp.platform_components, 'Keine zusätzlichen Komponenten aktiviert.')}

  <h2>D. Änderungen</h2>
  <p class="note">Der Auftragsverarbeiter informiert den Verantwortlichen über jede beabsichtigte Änderung in Abschnitt A (Hinzufügen oder Ersetzen eines Unterauftragsverarbeiters) in Textform an die im Konto hinterlegte Datenschutz-Kontaktadresse. Der Verantwortliche kann innerhalb der im Hauptvertrag vereinbarten Frist widersprechen. Änderungen in Abschnitt B nimmt der Verantwortliche selbst vor; sie werden mit Zeitstempel protokolliert. Jede Fassung dieser Anlage ist über den Versions-Hash eindeutig bestimmt und im Konto abrufbar.</p>

  <footer>Erzeugt durch ${esc(exp.processor.name)} am ${esc(new Date(exp.generated_at).toLocaleString('de-DE', { timeZone: 'Europe/Berlin' }))} Uhr (Europe/Berlin) für Konto ${esc(exp.tenant_id)}. Schema ${esc(exp.schema)}.</footer>
</main>
</body>
</html>`;
  }

  /** Klartext für die Änderungsmitteilung per E-Mail (Art. 28 Abs. 2 Satz 2 DSGVO). */
  renderChangeNoticeText(diff: SubprocessorDiff, exp: SubprocessorExport): string {
    const lines: string[] = [];
    lines.push(`Änderung der Unterauftragsverarbeiter und verbundenen Dienste – Version ${exp.version_hash.slice(0, 12)}`);
    lines.push('');
    if (diff.added.length) {
      lines.push('Neu:');
      for (const e of diff.added) lines.push(`  + ${e.vendor} (${roleLabel(e.role)}, ${TIER_LABELS_DE[e.tier]}) – ${e.purpose}`);
    }
    if (diff.removed.length) {
      lines.push('Entfernt:');
      for (const e of diff.removed) lines.push(`  - ${e.vendor} (${roleLabel(e.role)})`);
    }
    if (diff.changed.length) {
      lines.push('Geändert:');
      for (const c of diff.changed) lines.push(`  ~ ${c.after.vendor}: ${describeChange(c.before, c.after)}`);
    }
    if (!diff.added.length && !diff.removed.length && !diff.changed.length) lines.push('Keine inhaltlichen Änderungen.');
    lines.push('');
    lines.push(`Die vollständige Anlage ist im Konto unter Datenschutz → Subprozessoren abrufbar (Stand ${new Date(exp.generated_at).toLocaleDateString('de-DE', { timeZone: 'Europe/Berlin' })}).`);
    return lines.join('\n');
  }

  private fromPlatform(e: PlatformSubprocessor, basis: SubprocessorEntry['basis']): SubprocessorEntry {
    return {
      id: e.id, role: 'subprocessor', basis, vendor: e.vendor, legal_entity: e.legal_entity, owner_country: e.owner_country,
      hosting_regions: [...e.hosting_regions], tier: e.tier, transfer_mechanism: e.transfer_mechanism, purpose: e.purpose,
      data_categories: [...e.data_categories], documentation_url: e.documentation_url, certifications: [...e.certifications], activated_at: null,
    };
  }

  private fromAdapter(m: AdapterMetadata, activatedAt: Date | null): SubprocessorEntry {
    return {
      id: m.id, role: m.operated_by === 'slotwise' ? 'platform_component' : 'customer_instructed_recipient', basis: `integration:${m.id}`,
      vendor: m.vendor, legal_entity: m.legal_entity, owner_country: m.owner_country, hosting_regions: [...m.hosting_regions], tier: m.tier,
      transfer_mechanism: m.transfer_mechanism, purpose: m.purpose, data_categories: [...m.data_categories], documentation_url: m.documentation_url,
      certifications: [], activated_at: activatedAt ? activatedAt.toISOString() : null,
    };
  }
}

// ---------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

const COUNTRY_NAMES_DE = new Intl.DisplayNames(['de'], { type: 'region' });

export function countryLabel(iso2: string): string {
  return COUNTRY_NAMES_DE.of(iso2) ?? iso2;
}

function roleLabel(r: SubprocessorRole): string {
  return r === 'subprocessor' ? 'Unterauftragsverarbeiter' : r === 'customer_instructed_recipient' ? 'vom Kunden verbundener Dienst' : 'Komponente im Eigenbetrieb';
}

function describeChange(b: SubprocessorEntry, a: SubprocessorEntry): string {
  const parts: string[] = [];
  if (b.legal_entity !== a.legal_entity) parts.push('Vertragspartner');
  if (b.owner_country !== a.owner_country) parts.push('Sitz');
  if (b.hosting_regions.join() !== a.hosting_regions.join()) parts.push('Verarbeitungsort');
  if (b.tier !== a.tier) parts.push(`Stufe ${b.tier} → ${a.tier}`);
  if (b.transfer_mechanism !== a.transfer_mechanism) parts.push('Rechtsgrundlage der Übermittlung');
  if (b.purpose !== a.purpose) parts.push('Zweck');
  if (b.data_categories.join() !== a.data_categories.join()) parts.push('Datenkategorien');
  if (b.role !== a.role || b.basis !== a.basis) parts.push('Rolle');
  return parts.length ? parts.join(', ') : 'Dokumentation';
}

// ---------------------------------------------------------------------------
// Snapshot-Repositories
// ---------------------------------------------------------------------------


export class PgSubprocessorSnapshotRepository implements SubprocessorSnapshotRepository {
  constructor(private readonly db: PgLike) {}

  async latest(tenantId: string): Promise<{ versionHash: string; payload: SubprocessorExport; generatedAt: Date } | null> {
    const { rows } = await this.db.query(
      `SELECT version_hash, payload, generated_at FROM subprocessor_snapshots WHERE tenant_id = $1 ORDER BY generated_at DESC, id DESC LIMIT 1`,
      [tenantId],
    );
    const r = rows[0];
    if (!r) return null;
    return { versionHash: String(r.version_hash), payload: r.payload as SubprocessorExport, generatedAt: new Date(r.generated_at as string) };
  }

  async save(tenantId: string, versionHash: string, payload: SubprocessorExport): Promise<void> {
    await this.db.query(
      `INSERT INTO subprocessor_snapshots (tenant_id, version_hash, payload) VALUES ($1, $2, $3::jsonb)
       ON CONFLICT (tenant_id, version_hash) DO NOTHING`,
      [tenantId, versionHash, JSON.stringify(payload)],
    );
  }
}

export class MemorySubprocessorSnapshotRepository implements SubprocessorSnapshotRepository {
  readonly saved: { tenantId: string; versionHash: string; payload: SubprocessorExport; generatedAt: Date }[] = [];

  async latest(tenantId: string) {
    const mine = this.saved.filter((s) => s.tenantId === tenantId);
    return mine.length ? mine[mine.length - 1] : null;
  }

  async save(tenantId: string, versionHash: string, payload: SubprocessorExport): Promise<void> {
    this.saved.push({ tenantId, versionHash, payload, generatedAt: new Date(payload.generated_at) });
  }
}
