/**
 * Eingang für Microsoft-Graph-Change-Notifications.
 *
 * Harte Regeln:
 *   * Antwort in < 3 s (Graph drosselt langsame Endpunkte und verwirft bei sehr langsamen Notifications).
 *     Deshalb hier nur prüfen + Jobs einstellen, keine Graph-Aufrufe.
 *   * Feste Datenbanklast je Request, unabhängig von der Batchgröße: genau EIN Lookup (… = ANY($1)) und EIN
 *     mehrzeiliger INSERT (enqueueMany, nach Schlüssel sortiert). Vorher: 2 Roundtrips JE Notification.
 *   * Zeitbudget (Default 2,2 s, Reserve für Netz/TLS unter Graphs 3-s-Grenze): Ist die Datenbank zu langsam,
 *     antwortet der Eingang mit 503 (Alarm "webhook_enqueue_timeout"), statt Graph
 *     warten zu lassen. Graph stellt erneut zu; die dedupe_keys machen die Wiederholung folgenlos.
 *   * Notifications eines Channels mit stop_requested_at / stopped_at oder einer nicht aktiven Pipeline
 *     werden verworfen – NICHTS wird gelesen oder gespeichert (zweite Verteidigungslinie beim Offboarding).
 *   * clientState wird timing-sicher geprüft; Abweichung = Sicherheitsereignis, Notification verworfen.
 *   * Lifecycle-Events: subscriptionRemoved → Abo neu anlegen, missed → voller Delta-Resync,
 *     reauthorizationRequired → Renewal.
 */
import { createHash, timingSafeEqual } from "node:crypto";
import type { DelayedJobQueue, EnqueueItem } from "./retryQueue.js";
import { TEARDOWN_JOB_KIND } from "./teardownJob.js";
import type { WebhookChannel } from "./types.js";

export interface GuardChannel extends WebhookChannel {
  pipelineId: string;
  pipelineStatus: string;
}

export interface GuardRepo {
  /** Ein Roundtrip für alle IDs. Unbekannte IDs fehlen in der Map. */
  findBySubscriptionIds(providerSubscriptionIds: readonly string[]): Promise<Map<string, GuardChannel>>;
  markStoppedMany(channelIds: readonly string[], atIso: string, note: "subscription_removed"): Promise<void>;
}

export interface GuardDeps {
  repo: GuardRepo;
  queue: Pick<DelayedJobQueue, "enqueueMany">;
  securityEvent: (e: { kind: "client_state_mismatch"; tenantId: string; channelId: string }) => void;
  /**
   * Betriebsalarm (Log-Ebene "alert"): Zeitbudget überschritten oder DB-Fehler beim Lookup/Enqueue → 503.
   * Nur Zähler und feste Codes, nie Payload-Inhalte.
   */
  alert?: (e: { kind: "webhook_enqueue_timeout" | "webhook_enqueue_failed"; budgetMs: number; notifications: number; error?: string }) => void;
  now?: () => Date;
  /** Max. Zeit für Lookup + Enqueue, danach 503. Default 2 200 ms (DEFAULT_BUDGET_MS). */
  budgetMs?: number;
  /** Max. Notifications je Request; darüber 413. Default 1 000. */
  maxNotifications?: number;
}

export interface GraphWebhookRequest {
  query: Record<string, string | undefined>;
  body: unknown;
}

export type DropReason =
  | "no_subscription_id"
  | "unknown_subscription"
  | "client_state_mismatch"
  | "channel_stopped_or_revoked";

export interface GuardStats {
  accepted: number;
  dropped: number;
  /** Zähler je Grund – feste Form, keine wachsenden Arrays je Request */
  reasons: Record<DropReason, number>;
  jobsQueued: number;
  dbRoundtrips: number;
}

export interface GuardResponse {
  status: number;
  contentType?: string;
  body?: string;
  stats: GuardStats;
}

interface GraphNotification {
  subscriptionId?: unknown;
  clientState?: unknown;
  lifecycleEvent?: unknown;
}

const newStats = (): GuardStats => ({
  accepted: 0,
  dropped: 0,
  reasons: { no_subscription_id: 0, unknown_subscription: 0, client_state_mismatch: 0, channel_stopped_or_revoked: 0 },
  jobsQueued: 0,
  dbRoundtrips: 0,
});

function safeEqual(a: string, b: string): boolean {
  // gleiche Länge erzwingen, damit timingSafeEqual nicht wirft und die Länge nicht leakt
  return timingSafeEqual(createHash("sha256").update(a).digest(), createHash("sha256").update(b).digest());
}

class BudgetExceeded extends Error {}

/** Zeitbudget für Lookup + Enqueue: 2,2 s lassen ~0,8 s Reserve für Netz, TLS und ALB unter Graphs 3-s-Grenze. */
export const DEFAULT_BUDGET_MS = 2_200;

export async function handleGraphWebhook(req: GraphWebhookRequest, d: GuardDeps): Promise<GuardResponse> {
  const stats = newStats();

  // Validierung beim Anlegen/Verlängern: Token unverändert als text/plain zurückgeben (≤ 10 s)
  const vt = req.query.validationToken;
  if (typeof vt === "string" && vt.length > 0) return { status: 200, contentType: "text/plain", body: vt, stats };

  const value = (req.body as { value?: unknown } | null)?.value;
  if (!Array.isArray(value)) return { status: 400, stats };
  if (value.length > (d.maxNotifications ?? 1_000)) return { status: 413, stats };

  const work = processBatch(value as GraphNotification[], d, stats);
  const budgetMs = d.budgetMs ?? DEFAULT_BUDGET_MS;
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new BudgetExceeded()), budgetMs);
      }),
    ]);
  } catch (err) {
    if (err instanceof BudgetExceeded) {
      // Die DB-Arbeit läuft im Hintergrund weiter (oder scheitert); Graph stellt erneut zu, dedupe_key fängt Doppel.
      work.catch(() => undefined);
      safeAlert(d, { kind: "webhook_enqueue_timeout", budgetMs, notifications: value.length });
      return { status: 503, stats };
    }
    // DB-Fehler: Graph soll erneut zustellen, nichts wurde quittiert. Nur Fehlername/-code, keine Nachricht mit Daten.
    safeAlert(d, { kind: "webhook_enqueue_failed", budgetMs, notifications: value.length, error: errorCode(err) });
    return { status: 503, stats };
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { status: 202, stats };
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object") {
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code)) return code;
    const name = (err as { name?: unknown }).name;
    if (typeof name === "string" && /^[A-Za-z0-9_]{1,40}$/.test(name)) return name;
  }
  return "unknown";
}

// Ein Fehler im Alarm-Hook darf die Antwort an Graph nie verändern
function safeAlert(d: GuardDeps, e: Parameters<NonNullable<GuardDeps["alert"]>>[0]): void {
  try { d.alert?.(e); } catch { /* ignoriert */ }
}

async function processBatch(items: readonly GraphNotification[], d: GuardDeps, stats: GuardStats): Promise<void> {
  // 1) Eindeutige Subscription-IDs sammeln → EIN Lookup
  const ids = new Set<string>();
  for (const raw of items) if (typeof raw?.subscriptionId === "string") ids.add(raw.subscriptionId);
  const channels = ids.size > 0 ? await d.repo.findBySubscriptionIds([...ids]) : new Map<string, GuardChannel>();
  if (ids.size > 0) stats.dbRoundtrips += 1;

  // 2) Jede Notification bewerten; Jobs je (kind, dedupeKey) zusammenfassen
  const jobs = new Map<string, EnqueueItem>();
  const removed: string[] = [];
  const nowIso = (d.now?.() ?? new Date()).toISOString();
  const put = (item: EnqueueItem & { dedupeKey: string }) => {
    const k = `${item.kind}\u0000${item.dedupeKey}`;
    const prev = jobs.get(k);
    // Ein voller Resync (missed) schlägt einen inkrementellen Delta-Sync derselben Pipeline
    if (!prev || (item.kind === "pipeline.delta_sync" && (item.payload as { full: boolean }).full)) jobs.set(k, item);
  };
  const drop = (reason: DropReason) => {
    stats.dropped += 1;
    stats.reasons[reason] += 1;
  };

  for (const raw of items) {
    if (typeof raw?.subscriptionId !== "string") {
      drop("no_subscription_id");
      continue;
    }
    const ch = channels.get(raw.subscriptionId);
    if (!ch) {
      drop("unknown_subscription"); // verwaist oder fremd – läuft beim Provider von selbst ab
      continue;
    }
    if (!ch.clientState || typeof raw.clientState !== "string" || !safeEqual(raw.clientState, ch.clientState)) {
      d.securityEvent({ kind: "client_state_mismatch", tenantId: ch.tenantId, channelId: ch.id });
      drop("client_state_mismatch");
      continue;
    }
    const lifecycle = typeof raw.lifecycleEvent === "string" ? raw.lifecycleEvent : null;

    if (ch.stopRequestedAt || ch.stoppedAt || ch.pipelineStatus !== "active") {
      drop("channel_stopped_or_revoked");
      if (!ch.stoppedAt && lifecycle !== "subscriptionRemoved") {
        put({ tenantId: ch.tenantId, kind: TEARDOWN_JOB_KIND, dedupeKey: `teardown:${ch.userId}`,
          payload: { userId: ch.userId, purgeUser: false, requestedAt: nowIso } });
      }
      continue;
    }

    if (lifecycle === "subscriptionRemoved") {
      removed.push(ch.id);
      put({ tenantId: ch.tenantId, kind: "pipeline.handshake", dedupeKey: `handshake:${ch.pipelineId}`,
        payload: { pipelineId: ch.pipelineId, userId: ch.userId, grantedAt: null, attempts: {} } });
    } else if (lifecycle === "missed") {
      put({ tenantId: ch.tenantId, kind: "pipeline.delta_sync", dedupeKey: `delta:${ch.pipelineId}`, payload: { pipelineId: ch.pipelineId, full: true } });
    } else if (lifecycle === "reauthorizationRequired") {
      put({ tenantId: ch.tenantId, kind: "channel.renew", dedupeKey: `renew:${ch.id}`, payload: { channelId: ch.id } });
    } else {
      put({ tenantId: ch.tenantId, kind: "pipeline.delta_sync", dedupeKey: `delta:${ch.pipelineId}`, payload: { pipelineId: ch.pipelineId, full: false } });
    }
    stats.accepted += 1;
  }

  // 3) EIN mehrzeiliger INSERT für alle Jobs – VOR dem Stop-Update: scheitert danach etwas, stellt Graph
  //    erneut zu, und der Handshake-Job ist schon da (sonst würde der Retry als "gestoppt" verworfen).
  if (jobs.size > 0) {
    stats.jobsQueued = await d.queue.enqueueMany([...jobs.values()]);
    stats.dbRoundtrips += 1;
  }
  // 4) Selten: subscriptionRemoved → ein UPDATE für alle betroffenen Channels
  if (removed.length > 0) {
    await d.repo.markStoppedMany(removed, nowIso, "subscription_removed");
    stats.dbRoundtrips += 1;
  }
}
