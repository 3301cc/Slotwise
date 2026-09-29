/**
 * R1 · Option A · Pflicht-Metadaten für jeden Adapter.
 *
 * Jede Integration (Kalender, Video, Zahlung, CRM, Automatisierung, KI-Telefonie)
 * trägt dieselben Angaben, aus denen der EU-Modus filtert und der
 * SubprocessorService die Subprozessorenliste bzw. den AVV-Anhang erzeugt.
 *
 * Stufen (tier) – identisch mit config/plans.json und marketing-de.json:
 *   1 = Anbieter mit Sitz im EWR und Hosting ausschließlich im EWR
 *   2 = Anbieter außerhalb des EWR, Hosting für diese Integration ausschließlich im EWR
 *   3 = Hosting (auch) außerhalb des EWR
 *
 * Die Stufe wird nicht frei vergeben, sondern aus owner_country und
 * hosting_regions abgeleitet und beim Registrieren gegen den deklarierten
 * Wert geprüft (siehe assertMetadataValid).
 */

export type Tier = 1 | 2 | 3;

export type IntegrationCategory = 'calendar' | 'video' | 'payment' | 'crm' | 'automation' | 'messaging' | 'ai_telephony' | 'hosting';

/** Rechtsgrundlage für eine Übermittlung in ein Drittland (Kapitel V DSGVO). */
export type TransferMechanism =
  | 'none_required' // keine Drittlandübermittlung (Sitz und Hosting im EWR)
  | 'adequacy_decision' // Art. 45 DSGVO, z. B. Vereinigtes Königreich, Schweiz
  | 'eu_us_dpf' // Angemessenheitsbeschluss EU-US Data Privacy Framework (Art. 45), Zertifizierung des Anbieters
  | 'scc'; // Standardvertragsklauseln Art. 46 Abs. 2 lit. c DSGVO

export type DataCategory =
  | 'booker_name'
  | 'booker_email'
  | 'booker_phone'
  | 'appointment_times'
  | 'appointment_notes'
  | 'host_name'
  | 'host_email'
  | 'calendar_free_busy'
  | 'payment_amount'
  | 'payment_reference'
  | 'call_audio'
  | 'call_transcript'
  | 'ip_address';

export interface AdapterMetadata {
  /** Stabile ID, identisch mit config/plans.json → integrations[].id */
  readonly id: string;
  readonly category: IntegrationCategory;
  /** Anzeigename des Dienstes, z. B. "Google Kalender" */
  readonly vendor: string;
  /** Vertragspartner (juristische Person), wie er im AVV-Anhang erscheint */
  readonly legal_entity: string;
  /** ISO-3166-1 alpha-2 des Konzernsitzes (maßgeblich für Stufe 1 vs. 2) */
  readonly owner_country: string;
  /** ISO-3166-1 alpha-2 der Rechenzentrumsstandorte, die diese Integration nutzt */
  readonly hosting_regions: readonly string[];
  readonly tier: Tier;
  readonly transfer_mechanism: TransferMechanism;
  /** Zweck der Verarbeitung in der Sprache des AVV (Deutsch) */
  readonly purpose: string;
  readonly data_categories: readonly DataCategory[];
  /** Öffentliche Datenschutz- bzw. AVV-Seite des Anbieters */
  readonly documentation_url: string;
  /** Anbindung: nativ oder über eine Automationsplattform (dann zusätzlich deren Subprozessor) */
  readonly kind: 'native' | 'via-make' | 'via-zapier';
  /**
   * Wer den Dienst betreibt – entscheidet über die Rolle im AVV-Anhang:
   *  vendor   → Drittanbieter-SaaS, Empfänger auf Weisung des Kunden (Abschnitt B)
   *  slotwise → von Slotwise selbst betriebene Komponente, kein Unterauftragsverarbeiter
   *  customer → System des Kunden (z. B. eigener CalDAV-Server), kein Unterauftragsverarbeiter
   */
  readonly operated_by: 'vendor' | 'slotwise' | 'customer';
}

/** EWR: EU-27 plus Island, Liechtenstein, Norwegen. */
export const EEA_COUNTRIES: ReadonlySet<string> = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'FR', 'DE', 'GR', 'HU', 'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI', 'ES', 'SE',
  'IS', 'LI', 'NO',
]);

/** Länder mit Angemessenheitsbeschluss der EU-Kommission (Art. 45 DSGVO), Stand 09/2026. */
export const ADEQUACY_COUNTRIES: ReadonlySet<string> = new Set(['GB', 'CH', 'JP', 'KR', 'CA', 'NZ', 'AR', 'IL', 'UY', 'AD', 'FO', 'GG', 'IM', 'JE']);

export function isEea(country: string): boolean {
  return EEA_COUNTRIES.has(country);
}

/** Leitet die Stufe deterministisch aus Sitz und Hosting ab. */
export function deriveTier(ownerCountry: string, hostingRegions: readonly string[]): Tier {
  const allHostingEea = hostingRegions.length > 0 && hostingRegions.every(isEea);
  if (!allHostingEea) return 3;
  return isEea(ownerCountry) ? 1 : 2;
}

const ISO2 = /^[A-Z]{2}$/;
const CATEGORIES: readonly IntegrationCategory[] = ['calendar', 'video', 'payment', 'crm', 'automation', 'messaging', 'ai_telephony', 'hosting'];
const MECHANISMS: readonly TransferMechanism[] = ['none_required', 'adequacy_decision', 'eu_us_dpf', 'scc'];

export class AdapterMetadataError extends Error {
  constructor(public readonly adapterId: string, message: string) {
    super(`Adapter "${adapterId}": ${message}`);
  }
}

/**
 * Prüft Vollständigkeit und innere Konsistenz. Wirft, damit ein Adapter mit
 * falscher Stufe niemals in die Registry gelangt.
 */
export function assertMetadataValid(m: AdapterMetadata): void {
  const fail = (msg: string): never => {
    throw new AdapterMetadataError(m.id ?? '(ohne id)', msg);
  };
  if (!m.id || !/^[a-z0-9-]+$/.test(m.id)) fail('id muss aus [a-z0-9-] bestehen');
  if (!CATEGORIES.includes(m.category)) fail(`category ${String(m.category)} unbekannt`);
  if (!m.vendor?.trim()) fail('vendor fehlt');
  if (!m.legal_entity?.trim()) fail('legal_entity fehlt');
  if (!ISO2.test(m.owner_country)) fail('owner_country muss ISO-3166-1 alpha-2 sein');
  if (!Array.isArray(m.hosting_regions) || m.hosting_regions.length === 0) fail('hosting_regions darf nicht leer sein');
  for (const r of m.hosting_regions) if (!ISO2.test(r)) fail(`hosting_region ${r} ungültig`);
  if (![1, 2, 3].includes(m.tier)) fail('tier muss 1, 2 oder 3 sein');
  const derived = deriveTier(m.owner_country, m.hosting_regions);
  if (derived !== m.tier) fail(`tier ${m.tier} deklariert, aus Sitz ${m.owner_country} und Hosting [${m.hosting_regions.join(',')}] folgt aber Stufe ${derived}`);
  if (!MECHANISMS.includes(m.transfer_mechanism)) fail('transfer_mechanism unbekannt');
  // Rechtsgrundlage muss zur Übermittlung passen:
  const thirdCountryInvolved = !isEea(m.owner_country) || m.hosting_regions.some((r) => !isEea(r));
  if (!thirdCountryInvolved && m.transfer_mechanism !== 'none_required') fail('ohne Drittlandbezug ist transfer_mechanism none_required');
  if (thirdCountryInvolved && m.transfer_mechanism === 'none_required') fail('Drittlandbezug erfordert adequacy_decision, eu_us_dpf oder scc');
  if (m.transfer_mechanism === 'eu_us_dpf' && m.owner_country !== 'US' && !m.hosting_regions.includes('US')) fail('eu_us_dpf nur bei US-Bezug');
  if (m.transfer_mechanism === 'adequacy_decision') {
    const nonEea = [m.owner_country, ...m.hosting_regions].filter((c) => !isEea(c));
    if (!nonEea.every((c) => ADEQUACY_COUNTRIES.has(c))) fail(`adequacy_decision, aber ${nonEea.join(',')} ohne Angemessenheitsbeschluss`);
  }
  if (!m.purpose?.trim()) fail('purpose fehlt');
  if (!Array.isArray(m.data_categories) || m.data_categories.length === 0) fail('data_categories darf nicht leer sein');
  if (!/^https:\/\//.test(m.documentation_url)) fail('documentation_url muss https sein');
  if (!['native', 'via-make', 'via-zapier'].includes(m.kind)) fail('kind unbekannt');
  if (!['vendor', 'slotwise', 'customer'].includes(m.operated_by)) fail('operated_by unbekannt');
  if (m.operated_by === 'slotwise' && (m.owner_country !== 'DE' || m.tier !== 1)) fail('von Slotwise betriebene Komponenten sind DE / Stufe 1');
}

export const DATA_CATEGORY_LABELS_DE: Record<DataCategory, string> = {
  booker_name: 'Name der buchenden Person',
  booker_email: 'E-Mail-Adresse der buchenden Person',
  booker_phone: 'Telefonnummer der buchenden Person',
  appointment_times: 'Datum, Uhrzeit und Dauer des Termins',
  appointment_notes: 'Freitext-Anmerkungen zur Buchung',
  host_name: 'Name des Gastgebers',
  host_email: 'E-Mail-Adresse des Gastgebers',
  calendar_free_busy: 'Frei/Belegt-Zeiten des Kalenders (ohne Inhalte)',
  payment_amount: 'Zahlungsbetrag und Währung',
  payment_reference: 'Zahlungsreferenz und Zahlungsstatus',
  call_audio: 'Sprachaufzeichnung während des Anrufs (flüchtig)',
  call_transcript: 'Transkript des Anrufs (30 Tage)',
  ip_address: 'IP-Adresse (technisch bedingt, Transport)',
};

export const TRANSFER_MECHANISM_LABELS_DE: Record<TransferMechanism, string> = {
  none_required: 'Keine Drittlandübermittlung',
  adequacy_decision: 'Angemessenheitsbeschluss der EU-Kommission (Art. 45 DSGVO)',
  eu_us_dpf: 'EU-US Data Privacy Framework (Art. 45 DSGVO), Anbieter zertifiziert',
  scc: 'Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO) mit Transfer Impact Assessment',
};

export const TIER_LABELS_DE: Record<Tier, string> = {
  1: 'Stufe 1 – Sitz und Hosting im EWR',
  2: 'Stufe 2 – Anbieter außerhalb des EWR, Hosting im EWR',
  3: 'Stufe 3 – Hosting außerhalb des EWR',
};
