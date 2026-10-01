/**
 * Beenden von Webhook-Abos beim Provider.
 *
 *   Microsoft Graph:  DELETE https://graph.microsoft.com/v1.0/subscriptions/{id}        → 204
 *   Google Calendar:  POST   https://www.googleapis.com/calendar/v3/channels/stop       → 204
 *                     Body {"id": <channelId>, "resourceId": <resourceId>}
 *
 * Beide Aufrufe laufen mit APP-Credentials (Client Credentials bzw. Workload Identity + Impersonation),
 * NICHT mit Nutzertokens. Der Kill-Switch hat Nutzertokens bereits vernichtet; das Abo lässt sich trotzdem
 * beenden.
 */
import type { AppTokenProvider, FetchLike, ProviderOutcome, WebhookChannel } from "./types.js";

const GRAPH = "https://graph.microsoft.com/v1.0";
const GOOGLE_STOP = "https://www.googleapis.com/calendar/v3/channels/stop";

function parseRetryAfter(v: string | null, nowMs: number): number | null {
  if (!v) return null;
  const secs = Number(v);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? null : Math.max(0, at - nowMs);
}

function classify(status: number, retryAfter: string | null, body: string, nowMs: number): ProviderOutcome {
  if (status === 204 || status === 200) return { kind: "stopped", status };
  if (status === 404) return { kind: "already_gone", status }; // abgelaufen oder bereits gelöscht → Ziel erreicht
  if (status === 429 || status >= 500) {
    return { kind: "retry", status, retryAfterMs: parseRetryAfter(retryAfter, nowMs), reason: `HTTP ${status}` };
  }
  if (status === 401) return { kind: "retry", status, retryAfterMs: 0, reason: "Token abgelaufen" };
  if (status === 403) {
    // z. B. Scope-Änderung noch nicht repliziert. Retry mit Backoff; endgültig erlischt das Abo durch Ablauf,
    // da es nicht mehr verlängert wird.
    return { kind: "retry", status, retryAfterMs: null, reason: `HTTP 403 ${body.slice(0, 120)}` };
  }
  return { kind: "permanent", status, reason: `HTTP ${status} ${body.slice(0, 120)}` };
}

export async function stopProviderSubscription(
  channel: WebhookChannel,
  tokens: AppTokenProvider,
  fetchFn: FetchLike,
  signal?: AbortSignal,
  nowMs: number = Date.now(),
): Promise<ProviderOutcome> {
  const attempt = async (): Promise<ProviderOutcome> => {
    if (channel.provider === "microsoft") {
      const token = await tokens.getToken(channel.tenantId, "microsoft");
      const res = await fetchFn(`${GRAPH}/subscriptions/${encodeURIComponent(channel.providerSubscriptionId)}`, {
        method: "DELETE",
        headers: { Authorization: `Bearer ${token}` },
        signal,
      });
      return classify(res.status, res.headers.get("Retry-After"), await res.text(), nowMs);
    }
    if (!channel.providerResourceId) {
      return { kind: "permanent", status: 0, reason: "Google-Channel ohne resourceId – kann nicht gestoppt werden" };
    }
    const token = await tokens.getToken(channel.tenantId, "google", channel.userId);
    const res = await fetchFn(GOOGLE_STOP, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ id: channel.providerSubscriptionId, resourceId: channel.providerResourceId }),
      signal,
    });
    return classify(res.status, res.headers.get("Retry-After"), await res.text(), nowMs);
  };

  const first = await attempt();
  if (first.kind === "retry" && first.status === 401) {
    // Ein einziger sofortiger Wiederholungsversuch mit frischem Token
    tokens.invalidate(channel.tenantId, channel.provider, channel.provider === "google" ? channel.userId : undefined);
    return attempt();
  }
  return first;
}
