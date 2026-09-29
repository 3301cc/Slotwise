/**
 * Doppeltes Zeitlabel: primär in der Zone des Buchenden, sekundär in der
 * Host-Zone, sobald die Offsets abweichen. Erkennt Tagesverschiebung.
 */
import { formatHHMM, getOffsetMinutes, isoDateIn, zoneAbbreviation } from '../time/tz.js';

export interface SlotLabel {
  primary: string; // "10:00–10:30 Uhr"
  primaryZone: string; // "MESZ"
  secondary: string | null; // "09:00–09:30 Uhr in Europe/Berlin (Host)"
  dayShift: -1 | 0 | 1; // Slot liegt in der Zone des Buchenden am Vortag/Folgetag der Host-Zone
  isoDateBooker: string; // Kalendertag in der Zone des Buchenden, für die Gruppierung im Raster
}

export function slotLabel(startUtc: Date, endUtc: Date, bookerTz: string, hostTz: string, locale = 'de-DE'): SlotLabel {
  const primary = `${formatHHMM(startUtc, bookerTz)}–${formatHHMM(endUtc, bookerTz)} Uhr`;
  const primaryZone = zoneAbbreviation(startUtc, bookerTz, locale);
  const sameOffset = getOffsetMinutes(bookerTz, startUtc) === getOffsetMinutes(hostTz, startUtc);
  const secondary = sameOffset ? null : `${formatHHMM(startUtc, hostTz)}–${formatHHMM(endUtc, hostTz)} Uhr in ${hostTz} (Host)`;

  const dBooker = isoDateIn(startUtc, bookerTz);
  const dHost = isoDateIn(startUtc, hostTz);
  const dayShift: -1 | 0 | 1 = dBooker === dHost ? 0 : dBooker < dHost ? -1 : 1;

  return { primary, primaryZone, secondary, dayShift, isoDateBooker: dBooker };
}

/** Anzeige-Hinweis unter der Zonenauswahl, z. B. "Zeiten in Europe/London (BST, UTC+01:00)". */
export function zoneCaption(tz: string, at: Date, locale = 'de-DE'): string {
  const off = getOffsetMinutes(tz, at);
  const sign = off >= 0 ? '+' : '−';
  const abs = Math.abs(off);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `Zeiten in ${tz} (${zoneAbbreviation(at, tz, locale)}, UTC${sign}${hh}:${mm})`;
}
