export class SlotLockedError extends Error {
  readonly code = 'SLOT_LOCKED' as const;
  readonly httpStatus = 409;
  constructor(public readonly alternatives: Date[] = []) {
    super('Slot wird gerade von einer anderen Buchung gehalten.');
  }
}

export class SlotTakenError extends Error {
  readonly code = 'SLOT_TAKEN' as const;
  readonly httpStatus = 409;
  constructor(public readonly alternatives: Date[] = []) {
    super('Slot ist inzwischen belegt.');
  }
}

export class SlotOutsideAvailabilityError extends Error {
  readonly code = 'SLOT_OUTSIDE_AVAILABILITY' as const;
  readonly httpStatus = 422;
  constructor() {
    super('Slot liegt außerhalb der Verfügbarkeit des Hosts.');
  }
}

/** Externer Kalender-Provider hat gedrosselt (HTTP 429) oder ist vorübergehend nicht erreichbar (5xx). */
export class ProviderRateLimitError extends Error {
  readonly code = 'PROVIDER_RATE_LIMIT' as const;
  constructor(public readonly provider: string, public readonly retryAfterMs?: number) {
    super(`${provider} hat die Anfrage gedrosselt.`);
  }
}

export class ProviderUnavailableError extends Error {
  readonly code = 'PROVIDER_UNAVAILABLE' as const;
  constructor(public readonly provider: string, public readonly status?: number) {
    super(`${provider} ist vorübergehend nicht erreichbar (${status ?? 'n/a'}).`);
  }
}

/** Zugangsdaten ungültig (401/403, invalid_grant, Token widerrufen): Wiederholen ist zwecklos, der Host muss neu verbinden. */
export class ProviderAuthError extends Error {
  readonly code = 'PROVIDER_AUTH' as const;
  constructor(public readonly provider: string, public readonly status?: number, public readonly detail?: string) {
    super(`${provider}: Zugriff verweigert (${status ?? 'invalid_grant'})${detail ? ` – ${detail}` : ''}.`);
  }
}

/** Objekt beim Provider nicht (mehr) vorhanden (404): für DELETE ein Erfolg, für CONFIRM/UPDATE ein Dead-Letter. */
export class ProviderNotFoundError extends Error {
  readonly code = 'PROVIDER_NOT_FOUND' as const;
  constructor(public readonly provider: string, public readonly externalId: string) {
    super(`${provider}: Objekt ${externalId} nicht gefunden.`);
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof ProviderRateLimitError || err instanceof ProviderUnavailableError;
}
