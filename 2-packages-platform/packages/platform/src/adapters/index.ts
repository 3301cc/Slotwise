/**
 * R1 · Option A · Zusammenbau: Katalog + gebundene Implementierungen.
 *
 * Gebunden sind die Stufe-1-Referenzadapter (CalDAV, Jitsi, Mollie). Weitere
 * Implementierungen (Google, Microsoft Graph, Zoom, Stripe, HubSpot, …) werden
 * mit `registry.bind(id, factory)` ergänzt; ohne Bindung liefert `resolve()`
 * AdapterNotBoundError und die UI zeigt den Eintrag als "in Vorbereitung".
 */
import { caldavFactory } from './impl/caldavCalendarAdapter.js';
import { jitsiFactory } from './impl/jitsiVideoAdapter.js';
import { mollieFactory } from './impl/molliePaymentAdapter.js';
import { AdapterRegistry } from './registry.js';

export function buildDefaultRegistry(): AdapterRegistry {
  const registry = AdapterRegistry.withCatalog();
  registry.bind('caldav', caldavFactory());
  registry.bind('jitsi', jitsiFactory());
  registry.bind('mollie', mollieFactory());
  return registry;
}

export * from './metadata.js';
export * from './ports.js';
export * from './registry.js';
export * from './catalog.js';
export * from './tenantIntegrations.js';
export * from './subprocessorService.js';
export * from './impl/caldavCalendarAdapter.js';
export * from './impl/jitsiVideoAdapter.js';
export * from './impl/molliePaymentAdapter.js';
