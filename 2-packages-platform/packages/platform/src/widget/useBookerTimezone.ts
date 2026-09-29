/**
 * STW-101 · Zeitzone des Buchenden im Widget.
 * Erkennung über Intl, Persistenz nur in sessionStorage (kein Cookie, kein
 * localStorage, siehe STW-301), Validierung gegen die IANA-Liste der Laufzeit.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { isValidTimezone } from '../time/tz.js';

export const TZ_STORAGE_KEY = 'slotwise.bookerTz';

export function detectTimezone(fallback: string): string {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    return isValidTimezone(tz) ? tz : fallback;
  } catch {
    return fallback;
  }
}

function readStored(): string | null {
  try {
    const v = window.sessionStorage.getItem(TZ_STORAGE_KEY);
    return isValidTimezone(v) ? v : null;
  } catch {
    return null; // privater Modus / blockierter Speicher: ohne Persistenz weiterarbeiten
  }
}

function writeStored(tz: string) {
  try {
    window.sessionStorage.setItem(TZ_STORAGE_KEY, tz);
  } catch {
    /* bewusst ignoriert */
  }
}

/** Liste der wählbaren Zonen: Laufzeitliste, wenn verfügbar, sonst kuratierte Kurzliste. */
export function listTimezones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (k: string) => string[] };
  if (typeof intl.supportedValuesOf === 'function') {
    try {
      return intl.supportedValuesOf('timeZone');
    } catch {
      /* fällt durch */
    }
  }
  return ['Europe/Berlin', 'Europe/Vienna', 'Europe/Zurich', 'Europe/London', 'Europe/Lisbon', 'Europe/Paris', 'Europe/Amsterdam', 'Europe/Madrid', 'Europe/Rome', 'Europe/Warsaw', 'Europe/Stockholm', 'Europe/Helsinki', 'Europe/Athens', 'Europe/Istanbul', 'America/New_York', 'America/Chicago', 'America/Los_Angeles', 'Asia/Dubai', 'Asia/Singapore', 'Asia/Tokyo', 'Australia/Sydney', 'UTC'];
}

export interface BookerTimezone {
  timezone: string;
  detected: boolean; // true = automatisch erkannt, false = manuell gewählt
  setTimezone(tz: string): void;
  options: string[];
}

export function useBookerTimezone(hostTimezone: string): BookerTimezone {
  const [state, setState] = useState<{ tz: string; detected: boolean }>(() => {
    if (typeof window === 'undefined') return { tz: hostTimezone, detected: false }; // SSR: Host-Zone, gekennzeichnet
    const stored = readStored();
    if (stored) return { tz: stored, detected: false };
    return { tz: detectTimezone(hostTimezone), detected: true };
  });

  useEffect(() => {
    if (!state.detected) writeStored(state.tz);
  }, [state]);

  const setTimezone = useCallback((tz: string) => {
    if (!isValidTimezone(tz)) return;
    setState({ tz, detected: false });
  }, []);

  const options = useMemo(listTimezones, []);
  return { timezone: state.tz, detected: state.detected, setTimezone, options };
}
