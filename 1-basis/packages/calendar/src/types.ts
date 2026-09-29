/**
 * Provider-agnostic calendar contract. apps/web's sync service only talks to this.
 * Data minimisation: `BusyEvent` carries no title, attendees or description of
 * foreign events — only what the availability engine needs.
 */

export type ProviderKind = "GOOGLE" | "MICROSOFT" | "CRONOFY";

/** Supplied by the host app: returns a valid access token, refreshing if needed. */
export interface TokenProvider {
  getAccessToken(): Promise<string>;
}

export interface ConnectionRef {
  id: string; // CalendarConnection.id
  provider: ProviderKind;
  externalCalendarId: string;
  tokens: TokenProvider;
}

export interface CalendarInfo {
  id: string;
  name: string;
  primary: boolean;
  canWrite: boolean;
  timezone?: string;
}

export interface BusyEvent {
  externalId: string;
  start: Date;
  end: Date;
  isAllDay: boolean;
  transparency: "BUSY" | "FREE";
  /** Our booking id when the event was created by Slotwise (from extended properties). */
  slotwiseBookingId?: string | null;
}

export interface ChangeSet {
  upserts: BusyEvent[];
  deletedExternalIds: string[];
  /** Opaque cursor to persist for the next incremental call. */
  cursor: string;
  /** True when the provider forced a full window fetch (first sync or expired cursor). */
  full: boolean;
}

export interface EventDraft {
  title: string; // "Demo call · Lena Hoffmann"
  description?: string;
  start: Date;
  end: Date;
  slotwiseBookingId: string;
  attendeeEmail?: string | null; // optional invite; MVP sends confirmations itself
  location?: string;
}

export interface Subscription {
  subscriptionId: string;
  /** Provider-specific extra handle (Google: resourceId). */
  resourceId?: string;
  expiresAt: Date;
}

export interface CalendarProvider {
  readonly kind: ProviderKind;
  listCalendars(conn: ConnectionRef): Promise<CalendarInfo[]>;
  /**
   * Incremental fetch. Pass the persisted cursor; on the first call (or after
   * the provider invalidates the cursor) the adapter fetches `window` in full.
   */
  fetchChanges(conn: ConnectionRef, cursor: string | null, window: { from: Date; to: Date }): Promise<ChangeSet>;
  createEvent(conn: ConnectionRef, draft: EventDraft): Promise<{ externalId: string }>;
  updateEvent(conn: ConnectionRef, externalId: string, patch: Partial<Pick<EventDraft, "start" | "end" | "title">>): Promise<void>;
  deleteEvent(conn: ConnectionRef, externalId: string): Promise<void>;
  subscribe(conn: ConnectionRef, callbackUrl: string, secret: string): Promise<Subscription>;
  unsubscribe(conn: ConnectionRef, sub: Subscription): Promise<void>;
  /** Idempotency: the event we created for this booking, if any (by extended property). */
  findEventByBookingId(conn: ConnectionRef, slotwiseBookingId: string): Promise<{ externalId: string } | null>;
}

/**
 * Provider HTTP failure. `retryable` drives the outbox: 429/5xx/408 → retry with
 * backoff (honouring `retryAfterMs`); 400/401/403/404/409/410 → do not retry.
 * 401/403 additionally signal that the user must re-authorise.
 */
export class CalendarApiError extends Error {
  readonly retryable: boolean;
  readonly reauth: boolean;
  constructor(
    public readonly provider: ProviderKind,
    public readonly status: number,
    message: string,
    public readonly retryAfterMs: number | null = null,
  ) {
    super(`${provider} ${status}: ${message}`);
    this.name = "CalendarApiError";
    this.retryable = status >= 500 || status === 429 || status === 408;
    this.reauth = status === 401 || (status === 403 && /invalid_grant|insufficient|unauthorized|token/i.test(message));
  }
}

/** The stored refresh token no longer works — the owner must reconnect. Never retried. */
export class ReauthRequiredError extends Error {
  constructor(
    public readonly provider: ProviderKind,
    public readonly accountId: string,
    detail: string,
  ) {
    super(`${provider}: re-authorisation required for account ${accountId} (${detail})`);
    this.name = "ReauthRequiredError";
  }
}

/** Network-level failure (DNS, reset, timeout) — always retryable. */
export class CalendarNetworkError extends Error {
  constructor(
    public readonly provider: ProviderKind,
    cause: unknown,
  ) {
    super(`${provider}: network error — ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "CalendarNetworkError";
  }
}

/** Thrown when the incremental cursor is no longer valid → caller resets and re-syncs. */
export class CursorExpiredError extends Error {
  constructor(public readonly provider: ProviderKind) {
    super(`${provider}: sync cursor expired`);
    this.name = "CursorExpiredError";
  }
}

const FETCH_TIMEOUT_MS = 15_000;

export async function providerFetch<T>(
  provider: ProviderKind,
  tokens: TokenProvider,
  url: string,
  init: RequestInit = {},
): Promise<T> {
  const token = await tokens.getAccessToken();
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch (cause) {
    throw new CalendarNetworkError(provider, cause);
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!res.ok) {
    if (res.status === 410) throw new CursorExpiredError(provider);
    throw new CalendarApiError(provider, res.status, text.slice(0, 300), parseRetryAfter(res.headers.get("retry-after")));
  }
  try {
    return (text ? JSON.parse(text) : undefined) as T;
  } catch {
    throw new CalendarApiError(provider, 502, `non-JSON body: ${text.slice(0, 80)}`);
  }
}

function parseRetryAfter(value: string | null): number | null {
  if (!value) return null;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.min(secs, 3600) * 1000;
  const at = Date.parse(value);
  return Number.isNaN(at) ? null : Math.max(0, Math.min(at - Date.now(), 3_600_000));
}
