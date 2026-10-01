/** Gemeinsame Typen des CalenSync-Core (Provider-Zugriff, Teardown, Retry). */

export type Provider = "microsoft" | "google";

/** Ein Webhook-Abo beim Provider (Graph-Subscription bzw. Google-Watch-Channel). */
export interface WebhookChannel {
  id: string; // interne ID
  tenantId: string;
  userId: string;
  provider: Provider;
  /** Graph: subscription.id · Google: channel.id */
  providerSubscriptionId: string;
  /** nur Google: resourceId aus der watch-Antwort, für channels.stop nötig */
  providerResourceId: string | null;
  /** Graph: clientState, den Graph in jeder Notification mitschickt */
  clientState: string | null;
  /** Ablauf beim Provider. Danach ist das Abo ohnehin tot; Stop-Retries enden dort. */
  expiresAt: string | null;
  stopRequestedAt: string | null;
  stoppedAt: string | null;
  stopAttempts: number;
  nextStopAttemptAt: string | null;
  lastStopError: string | null;
}

/** Ergebnis eines einzelnen Provider-Aufrufs, unabhängig von HTTP-Details. */
export type ProviderOutcome =
  | { kind: "stopped"; status: number }
  | { kind: "already_gone"; status: number }
  | { kind: "retry"; status: number; retryAfterMs: number | null; reason: string }
  | { kind: "permanent"; status: number; reason: string };

/** Liefert ein App-Token (Client Credentials) für den Mandanten – nie ein Nutzertoken. */
export interface AppTokenProvider {
  getToken(tenantId: string, provider: Provider, impersonateUser?: string): Promise<string>;
  /** Cache verwerfen, z. B. nach 401 */
  invalidate(tenantId: string, provider: Provider, impersonateUser?: string): void;
}

export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}) => Promise<{ status: number; headers: { get(name: string): string | null }; text(): Promise<string> }>;
