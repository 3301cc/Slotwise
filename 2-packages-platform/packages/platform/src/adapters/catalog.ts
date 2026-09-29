/**
 * R1 · Option A · Metadaten-Katalog aller Integrationen aus config/plans.json.
 *
 * Die Stufe jedes Eintrags wird beim Laden aus owner_country und
 * hosting_regions abgeleitet und gegen den Wert in plans.json geprüft
 * (Test adapters.test.ts). Ändert sich der Sitz oder das Hosting eines
 * Anbieters, ändert sich hier genau eine Zeile und plans.json muss folgen.
 *
 * Stand der Angaben: 29.09.2026. Vor Veröffentlichung der Subprozessorenliste
 * werden legal_entity und documentation_url gegen die aktuellen
 * Anbieterdokumente abgeglichen (Freigabe Datenschutz).
 */
import type { AdapterMetadata } from './metadata.js';

const CAL_DATA = ['booker_name', 'booker_email', 'appointment_times', 'appointment_notes', 'host_email', 'calendar_free_busy'] as const;
const VIDEO_DATA = ['booker_name', 'booker_email', 'appointment_times', 'host_name', 'host_email', 'ip_address'] as const;
const PAY_DATA = ['booker_email', 'payment_amount', 'payment_reference', 'ip_address'] as const;
const CRM_DATA = ['booker_name', 'booker_email', 'booker_phone', 'appointment_times', 'appointment_notes'] as const;
const AUTOMATION_DATA = ['booker_name', 'booker_email', 'booker_phone', 'appointment_times', 'appointment_notes', 'host_name'] as const;

export const ADAPTER_CATALOG: readonly AdapterMetadata[] = [
  // ------------------------------------------------------------------ Kalender
  {
    id: 'google-calendar', category: 'calendar', vendor: 'Google Kalender',
    legal_entity: 'Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland (Konzern: Alphabet Inc., USA)',
    owner_country: 'US', hosting_regions: ['US', 'IE', 'NL', 'BE', 'FI', 'DE'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Frei/Belegt-Abgleich und Anlage des Termins im Google-Kalender des Gastgebers',
    data_categories: CAL_DATA, documentation_url: 'https://workspace.google.com/terms/dpa_terms.html', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'microsoft-365', category: 'calendar', vendor: 'Microsoft 365 / Outlook',
    legal_entity: 'Microsoft Ireland Operations Limited, One Microsoft Place, South County Business Park, Leopardstown, Dublin 18, Irland (Konzern: Microsoft Corporation, USA)',
    owner_country: 'US', hosting_regions: ['DE', 'NL', 'IE'], tier: 2, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Frei/Belegt-Abgleich und Anlage des Termins im Outlook-Kalender des Gastgebers (EU Data Boundary)',
    data_categories: CAL_DATA, documentation_url: 'https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'icloud-caldav', category: 'calendar', vendor: 'Apple iCloud (CalDAV)',
    legal_entity: 'Apple Distribution International Limited, Hollyhill Industrial Estate, Hollyhill, Cork, Irland (Konzern: Apple Inc., USA)',
    owner_country: 'US', hosting_regions: ['US', 'IE', 'DK'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Frei/Belegt-Abgleich und Anlage des Termins im iCloud-Kalender des Gastgebers über CalDAV',
    data_categories: CAL_DATA, documentation_url: 'https://www.apple.com/legal/privacy/de-ww/', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'caldav', category: 'calendar', vendor: 'CalDAV (Nextcloud, mailbox.org, Open-Xchange)',
    legal_entity: 'Betreiber des vom Kunden konfigurierten CalDAV-Servers (eigener Server des Kunden oder dessen Vertragspartner, z. B. Heinlein Hosting GmbH für mailbox.org)',
    owner_country: 'DE', hosting_regions: ['DE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Frei/Belegt-Abgleich und Anlage des Termins auf dem CalDAV-Server des Kunden',
    data_categories: CAL_DATA, documentation_url: 'https://datatracker.ietf.org/doc/html/rfc4791', kind: 'native', operated_by: 'customer',
  },
  // --------------------------------------------------------------------- Video
  {
    id: 'jitsi', category: 'video', vendor: 'Jitsi Meet (meet.slotwise.de)',
    legal_entity: 'Slotwise (eigener Betrieb auf Infrastruktur in Frankfurt am Main)',
    owner_country: 'DE', hosting_regions: ['DE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Bereitstellung eines Videoraums je Termin, Signalisierung und Medienrelay',
    data_categories: VIDEO_DATA, documentation_url: 'https://jitsi.org/security/', kind: 'native', operated_by: 'slotwise',
  },
  {
    id: 'google-meet', category: 'video', vendor: 'Google Meet',
    legal_entity: 'Google Ireland Limited, Gordon House, Barrow Street, Dublin 4, Irland (Konzern: Alphabet Inc., USA)',
    owner_country: 'US', hosting_regions: ['US', 'IE', 'NL', 'BE', 'FI', 'DE'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Erzeugung eines Google-Meet-Links im Kalendereintrag des Gastgebers',
    data_categories: VIDEO_DATA, documentation_url: 'https://workspace.google.com/terms/dpa_terms.html', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'microsoft-teams', category: 'video', vendor: 'Microsoft Teams',
    legal_entity: 'Microsoft Ireland Operations Limited, One Microsoft Place, South County Business Park, Leopardstown, Dublin 18, Irland (Konzern: Microsoft Corporation, USA)',
    owner_country: 'US', hosting_regions: ['DE', 'NL', 'IE'], tier: 2, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Erzeugung einer Teams-Besprechung über Microsoft Graph (EU Data Boundary)',
    data_categories: VIDEO_DATA, documentation_url: 'https://www.microsoft.com/licensing/docs/view/Microsoft-Products-and-Services-Data-Protection-Addendum-DPA', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'zoom', category: 'video', vendor: 'Zoom',
    legal_entity: 'Zoom Video Communications, Inc., 55 Almaden Blvd, San Jose, CA 95113, USA',
    owner_country: 'US', hosting_regions: ['US', 'DE', 'NL'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Erzeugung eines Zoom-Meetings je Termin über die Zoom-API',
    data_categories: VIDEO_DATA, documentation_url: 'https://explore.zoom.us/de/gdpr/', kind: 'native', operated_by: 'vendor',
  },
  // ------------------------------------------------------------------- Zahlung
  {
    id: 'mollie', category: 'payment', vendor: 'Mollie',
    legal_entity: 'Mollie B.V., Keizersgracht 126, 1015 CW Amsterdam, Niederlande',
    owner_country: 'NL', hosting_regions: ['NL', 'DE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Abwicklung von Vorkasse, Anzahlung und No-Show-Gebühr (SEPA, Karte, PayPal über Mollie)',
    data_categories: PAY_DATA, documentation_url: 'https://www.mollie.com/de/legal/data-processing-agreement', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'stripe', category: 'payment', vendor: 'Stripe',
    legal_entity: 'Stripe Payments Europe, Limited, 1 Grand Canal Street Lower, Grand Canal Dock, Dublin, Irland (Konzern: Stripe, Inc., USA)',
    owner_country: 'US', hosting_regions: ['US', 'IE'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Abwicklung von Vorkasse, Anzahlung und No-Show-Gebühr über Stripe Checkout',
    data_categories: PAY_DATA, documentation_url: 'https://stripe.com/de/legal/dpa', kind: 'native', operated_by: 'vendor',
  },
  // ----------------------------------------------------------- Automatisierung
  {
    id: 'make', category: 'automation', vendor: 'Make (EU-Zone)',
    legal_entity: 'Celonis SE, Theresienstraße 6, 80333 München, Deutschland (Betreiber von Make, Zone eu1.make.com)',
    owner_country: 'DE', hosting_regions: ['DE', 'IE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Weiterleitung von Buchungsereignissen an Szenarien des Kunden in der EU-Zone von Make',
    data_categories: AUTOMATION_DATA, documentation_url: 'https://www.make.com/en/privacy-notice', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'zapier', category: 'automation', vendor: 'Zapier',
    legal_entity: 'Zapier, Inc., 548 Market St #62411, San Francisco, CA 94104, USA',
    owner_country: 'US', hosting_regions: ['US'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Weiterleitung von Buchungsereignissen an Zaps des Kunden',
    data_categories: AUTOMATION_DATA, documentation_url: 'https://zapier.com/legal/data-processing-addendum', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'webhooks', category: 'automation', vendor: 'Webhooks / REST-API',
    legal_entity: 'Slotwise (eigener Betrieb); Empfänger ist der vom Kunden konfigurierte Endpunkt',
    owner_country: 'DE', hosting_regions: ['DE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Signierte Zustellung von Buchungsereignissen an vom Kunden benannte HTTPS-Endpunkte',
    data_categories: AUTOMATION_DATA, documentation_url: 'https://developer.slotwise.de/webhooks', kind: 'native', operated_by: 'slotwise',
  },
  // ----------------------------------------------------------------------- CRM
  {
    id: 'hubspot', category: 'crm', vendor: 'HubSpot (EU-Rechenzentrum)',
    legal_entity: 'HubSpot Ireland Limited, 1 Sir John Rogerson\'s Quay, Dublin 2, Irland (Konzern: HubSpot, Inc., USA)',
    owner_country: 'US', hosting_regions: ['DE'], tier: 2, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Anlage und Aktualisierung von Kontakten sowie Protokollierung von Terminen im HubSpot-Konto des Kunden (EU-Datenhosting Frankfurt)',
    data_categories: CRM_DATA, documentation_url: 'https://legal.hubspot.com/dpa', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'pipedrive', category: 'crm', vendor: 'Pipedrive (EU-Rechenzentrum)',
    legal_entity: 'Pipedrive OÜ, Mustamäe tee 3a, 10615 Tallinn, Estland (Konzern: Pipedrive, Inc., New York, USA)',
    owner_country: 'US', hosting_regions: ['DE', 'IE'], tier: 2, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Anlage und Aktualisierung von Personen sowie Aktivitäten im Pipedrive-Konto des Kunden (EU-Hosting)',
    data_categories: CRM_DATA, documentation_url: 'https://www.pipedrive.com/en/privacy', kind: 'native', operated_by: 'vendor',
  },
  {
    id: 'salesforce', category: 'crm', vendor: 'Salesforce',
    legal_entity: 'Salesforce, Inc., Salesforce Tower, 415 Mission Street, San Francisco, CA 94105, USA',
    owner_country: 'US', hosting_regions: ['US', 'DE', 'FR'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Anlage und Aktualisierung von Leads/Kontakten sowie Ereignissen in der Salesforce-Org des Kunden',
    data_categories: CRM_DATA, documentation_url: 'https://www.salesforce.com/company/legal/agreements/', kind: 'native', operated_by: 'vendor',
  },
  // ------------------------------------------------------- über Make angebunden
  {
    id: 'slack', category: 'messaging', vendor: 'Slack',
    legal_entity: 'Slack Technologies Limited, Salesforce Tower, 60 R801, North Dock, Dublin, Irland (Konzern: Salesforce, Inc., USA)',
    owner_country: 'US', hosting_regions: ['US'], tier: 3, transfer_mechanism: 'eu_us_dpf',
    purpose: 'Benachrichtigung des Teams über neue, verschobene und stornierte Termine in einem Slack-Kanal (über Make)',
    data_categories: ['booker_name', 'appointment_times', 'host_name'], documentation_url: 'https://slack.com/intl/de-de/trust/privacy/privacy-policy', kind: 'via-make', operated_by: 'vendor',
  },
  {
    id: 'weclapp', category: 'crm', vendor: 'weclapp',
    legal_entity: 'weclapp SE, Frauenbergstraße 31-33, 35039 Marburg, Deutschland',
    owner_country: 'DE', hosting_regions: ['DE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Übergabe von Kontakten und Terminen an das weclapp-Konto des Kunden (über Make)',
    data_categories: CRM_DATA, documentation_url: 'https://www.weclapp.com/de/datenschutz/', kind: 'via-make', operated_by: 'vendor',
  },
  {
    id: 'personio', category: 'crm', vendor: 'Personio',
    legal_entity: 'Personio SE & Co. KG, Seidlstraße 3, 80335 München, Deutschland',
    owner_country: 'DE', hosting_regions: ['DE', 'IE'], tier: 1, transfer_mechanism: 'none_required',
    purpose: 'Übergabe von Bewerbungsgesprächen an das Personio-Konto des Kunden (über Make)',
    data_categories: ['booker_name', 'booker_email', 'appointment_times', 'host_name'], documentation_url: 'https://www.personio.de/datenschutz/', kind: 'via-make', operated_by: 'vendor',
  },
];

export function catalogById(): ReadonlyMap<string, AdapterMetadata> {
  return new Map(ADAPTER_CATALOG.map((m) => [m.id, m]));
}
