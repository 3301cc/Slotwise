/**
 * Exponentielles Backoff mit Deckel und symmetrischem Jitter (±15 %).
 *
 * Warum Jitter: Am Monatsersten legt Entra z. B. 50 User im selben Provisionierungszyklus an. Alle
 * Handshakes scheitern gleichzeitig mit 403 (Exchange-Replikation). Ohne Jitter kämen alle 50 Retries
 * exakt gleichzeitig zurück, und jede weitere Runde bliebe synchron. Mit ±15 % verteilt sich schon die
 * erste Runde auf 25,5–34,5 min (9 min Breite statt 0); weil jede Runde neu würfelt, laufen die Jobs mit
 * jedem Versuch weiter auseinander (Random Walk), statt sich wieder zu sammeln.
 *
 * Warum kein "Full Jitter" (0 … d): Exchange braucht mindestens ~30 min. Ein Retry nach 2 min wäre nur
 * Last ohne Erfolgschance. Ein symmetrisches Band um den Nominalwert entzerrt, ohne sinnlos früh zu feuern.
 *
 * Rein funktional mit injizierbarem Zufall, damit Tests deterministisch bleiben.
 */

export interface BackoffPolicy {
  /** Nominale Verzögerung des ersten Retries (attempt = 1) */
  initialMs: number;
  factor: number;
  /** Deckel für den Nominalwert; mit Jitter kann das Ergebnis bis maxMs·(1 + jitterRatio) reichen */
  maxMs: number;
  /** Symmetrische Streuung: Ergebnis liegt in [d·(1 − r), d·(1 + r)) */
  jitterRatio: number;
}

export const DEFAULT_JITTER_RATIO = 0.15;

/** 403/404 direkt nach SCIM-Provisionierung: Exchange repliziert RBAC-Scopes in 30 min bis 2 h. */
export const SCOPE_PROPAGATION: BackoffPolicy = { initialMs: 30 * 60_000, factor: 2, maxMs: 4 * 60 * 60_000, jitterRatio: DEFAULT_JITTER_RATIO };

/** 429 / 5xx / Netzwerk: kurz anfangen, schnell hoch. */
export const TRANSIENT: BackoffPolicy = { initialMs: 15_000, factor: 2, maxMs: 30 * 60_000, jitterRatio: DEFAULT_JITTER_RATIO };

/** Stoppen von Webhook-Abos nach Offboarding. */
export const SUBSCRIPTION_STOP: BackoffPolicy = { initialMs: 30_000, factor: 3, maxMs: 60 * 60_000, jitterRatio: DEFAULT_JITTER_RATIO };

/** Nominalwert ohne Jitter: initialMs · factor^(attempt − 1), gedeckelt bei maxMs. */
export function nominalDelayMs(policy: BackoffPolicy, attempt: number): number {
  const n = Math.max(1, Math.floor(attempt));
  return Math.min(policy.initialMs * Math.pow(policy.factor, n - 1), policy.maxMs);
}

/**
 * Nominalwert mit symmetrischem Jitter.  random() ∈ [0, 1)  →  Faktor ∈ [1 − r, 1 + r).
 * random = 0.5 liefert exakt den Nominalwert.
 */
export function backoffDelayMs(policy: BackoffPolicy, attempt: number, random: () => number = Math.random): number {
  const nominal = nominalDelayMs(policy, attempt);
  const spread = policy.jitterRatio * (2 * random() - 1);
  return Math.max(0, Math.round(nominal * (1 + spread)));
}

/**
 * Retry-After vom Provider ist eine Untergrenze und darf nie unterschritten werden. Damit Clients mit
 * identischem Retry-After nicht wieder gleichzeitig anklopfen, streut der Wert nur NACH OBEN (0 … +r).
 */
export function respectRetryAfter(retryAfterMs: number, backoffMs: number, random: () => number = Math.random, ratio = DEFAULT_JITTER_RATIO): number {
  if (retryAfterMs <= 0) return backoffMs;
  return Math.max(Math.round(retryAfterMs * (1 + ratio * random())), backoffMs);
}
