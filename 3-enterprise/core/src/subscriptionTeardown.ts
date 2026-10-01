/**
 * Aktiver Teardown der Webhook-Abos beim Provider. Läuft AUSSCHLIESSLICH im Hintergrund-Worker
 * (teardownJob.ts), nie im SCIM-Request.
 *
 * Ablauf:
 *   SCIM (1 Transaktion)  revokeSyncForUser / markDeletedAndEnqueueTeardown
 *                         → Pipelines revoked, Tokens vernichtet, Channels stop_requested, Job in job_queue
 *   Worker                terminateForUser() → Graph DELETE /v1.0/subscriptions/{id} bzw. Google channels.stop,
 *                         parallel mit Zeitbudget; 204/404 = erledigt, Rest mit Backoff erneut
 *   Worker (purge)        erst wenn kein Abo mehr offen ist: Tombstone des Users endgültig löschen
 *
 * webhook_channels.user_id hängt bewusst NICHT per FK-Cascade an scim_users: die Zeile muss die Löschung
 * des Users überleben, bis das Abo nachweislich beendet ist.
 *
 * Zweite Verteidigungslinie: webhookGuard.ts verwirft jede Notification eines Channels mit
 * stop_requested_at – selbst wenn Microsoft bis zum Ablauf weiter zustellt, wird nichts gelesen oder gespeichert.
 */
import { SUBSCRIPTION_STOP, backoffDelayMs, respectRetryAfter } from "./backoff.js";
import { stopProviderSubscription } from "./providerApi.js";
import type { AppTokenProvider, FetchLike, ProviderOutcome, WebhookChannel } from "./types.js";

export interface ChannelRepo {
  /** Alle Channels des Users mit stopped_at IS NULL (unabhängig von stop_requested_at). */
  listOpenForUser(tenantId: string, userId: string): Promise<WebhookChannel[]>;
  /** stop_requested_at gesetzt, stopped_at NULL, next_stop_attempt_at fällig. In Postgres: FOR UPDATE SKIP LOCKED. */
  claimDueStops(nowIso: string, limit: number): Promise<WebhookChannel[]>;
  /** Setzt auch stop_requested_at, falls noch NULL. */
  markStopped(channelId: string, atIso: string, note: "stopped" | "already_gone" | "expired"): Promise<void>;
  recordStopFailure(channelId: string, f: { attempts: number; nextAttemptAtIso: string | null; error: string }): Promise<void>;
}

export type ChannelStopStatus = "stopped" | "already_gone" | "expired" | "retry_scheduled" | "failed";

export interface TeardownResult {
  channels: number;
  stopped: number;
  alreadyGone: number;
  retryScheduled: number;
  failed: number;
  timedOut: boolean;
  details: Array<{ channelId: string; provider: string; status: ChannelStopStatus; reason?: string }>;
}

export interface TeardownDeps {
  channels: ChannelRepo;
  tokens: AppTokenProvider;
  fetchFn: FetchLike;
  now?: () => Date;
  random?: () => number;
}

const EMPTY: TeardownResult = { channels: 0, stopped: 0, alreadyGone: 0, retryScheduled: 0, failed: 0, timedOut: false, details: [] };

export class SubscriptionTeardown {
  constructor(private readonly deps: TeardownDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /** Alle offenen Abos eines Users beenden. Wirft nie; Channels mit endgültigem Fehler werden übersprungen. */
  async terminateForUser(tenantId: string, userId: string, budgetMs = 15_000): Promise<TeardownResult> {
    let open: WebhookChannel[];
    try {
      open = await this.deps.channels.listOpenForUser(tenantId, userId);
    } catch (err) {
      return { ...EMPTY, failed: 1, details: [{ channelId: "-", provider: "-", status: "failed", reason: `listOpenForUser: ${msg(err)}` }] };
    }
    const actionable = open.filter((c) => !isPermanentStopFailure(c));
    if (actionable.length === 0) return { ...EMPTY, details: [] };
    return this.stopAll(actionable, budgetMs);
  }

  /** Worker-Teil: fällige Retries abarbeiten. Liefert die Anzahl bearbeiteter Channels. */
  async runDueStops(limit = 50, perCallBudgetMs = 10_000): Promise<TeardownResult> {
    const due = await this.deps.channels.claimDueStops(this.now().toISOString(), limit);
    if (due.length === 0) return { ...EMPTY, details: [] };
    return this.stopAll(due, perCallBudgetMs);
  }

  private async stopAll(channels: WebhookChannel[], budgetMs: number): Promise<TeardownResult> {
    const ac = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      ac.abort(new Error(`Teardown-Budget ${budgetMs} ms überschritten`));
    }, budgetMs);
    try {
      const details = await Promise.all(channels.map((c) => this.stopOne(c, ac.signal)));
      const count = (s: ChannelStopStatus) => details.filter((d) => d.status === s).length;
      return {
        channels: channels.length,
        stopped: count("stopped") + count("expired"),
        alreadyGone: count("already_gone"),
        retryScheduled: count("retry_scheduled"),
        failed: count("failed"),
        timedOut,
        details,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async stopOne(c: WebhookChannel, signal: AbortSignal): Promise<TeardownResult["details"][number]> {
    const base = { channelId: c.id, provider: c.provider };
    const now = this.now();
    try {
      if (c.expiresAt && Date.parse(c.expiresAt) <= now.getTime()) {
        await this.deps.channels.markStopped(c.id, now.toISOString(), "expired");
        return { ...base, status: "expired" };
      }

      let outcome: ProviderOutcome;
      try {
        outcome = await stopProviderSubscription(c, this.deps.tokens, this.deps.fetchFn, signal, now.getTime());
      } catch (err) {
        // Timeout, DNS, TLS, Token-Endpunkt nicht erreichbar … → später erneut
        outcome = { kind: "retry", status: 0, retryAfterMs: null, reason: signal.aborted ? "Timeout im Teardown-Budget" : msg(err) };
      }

      switch (outcome.kind) {
        case "stopped":
        case "already_gone":
          await this.deps.channels.markStopped(c.id, this.now().toISOString(), outcome.kind);
          return { ...base, status: outcome.kind };
        case "retry": {
          const attempts = c.stopAttempts + 1;
          const delay = respectRetryAfter(outcome.retryAfterMs ?? 0, backoffDelayMs(SUBSCRIPTION_STOP, attempts, this.deps.random), this.deps.random);
          let next = new Date(this.now().getTime() + delay);
          // Nicht über den Ablauf hinaus planen: danach genügt ein letzter Lauf, der "expired" setzt.
          if (c.expiresAt && next.getTime() > Date.parse(c.expiresAt)) next = new Date(Date.parse(c.expiresAt) + 1_000);
          await this.deps.channels.recordStopFailure(c.id, { attempts, nextAttemptAtIso: next.toISOString(), error: outcome.reason });
          return { ...base, status: "retry_scheduled", reason: outcome.reason };
        }
        case "permanent":
          // Kein Retry sinnvoll (z. B. 400). Notifications werden trotzdem vom Webhook-Guard verworfen,
          // das Abo erlischt mit expiresAt. Alarm über lastStopError + Metrik.
          await this.deps.channels.recordStopFailure(c.id, { attempts: c.stopAttempts + 1, nextAttemptAtIso: null, error: outcome.reason });
          return { ...base, status: "failed", reason: outcome.reason };
      }
    } catch (err) {
      // DB-Fehler beim Protokollieren: Channel bleibt stop_requested, der Worker greift ihn erneut auf.
      return { ...base, status: "failed", reason: `Persistenz: ${msg(err)}` };
    }
  }
}

/** Endgültig gescheitert (z. B. HTTP 400): kein weiterer Versuch geplant. Erlischt mit expiresAt beim Provider. */
export function isPermanentStopFailure(c: WebhookChannel): boolean {
  return c.stoppedAt === null && c.stopAttempts > 0 && c.nextStopAttemptAt === null;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
