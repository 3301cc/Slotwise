/**
 * Verlängerung der Graph-Abos (Job "channel.renew").
 *
 * Ohne Verlängerung läuft jedes Abo nach GRAPH_SUBSCRIPTION_LIFETIME_MS (6 Tage) ab, und der Sync steht still,
 * ohne dass es jemand merkt. Zwei Quellen stellen den Job ein (gleicher dedupeKey "renew:<channelId>"):
 *   1. RenewalScheduler: alle 10 min EIN INSERT … SELECT für Abos, die in < 24 h ablaufen (gestreut über 30 min)
 *   2. Webhook-Eingang: Lifecycle-Event reauthorizationRequired (PATCH mit neuer Ablaufzeit autorisiert neu)
 *
 * Ergebnis je Job:
 *   200          → expires_at fortschreiben
 *   404          → Abo bei Microsoft weg: Channel als gestoppt markieren + Handshake-Job (Neuanlage), ein Statement
 *   401          → Token verwerfen, sofort ein zweiter Versuch
 *   429/5xx/Netz → Backoff (Retry-After wird nie unterschritten), max. 8 Versuche
 *   403          → App hat keinen Zugriff mehr (RBAC-Scope entfernt?): Backoff, max. 4 Versuche, dann Alarm
 *   sonst 4xx    → Alarm, Verlängerung für 6 h pausieren (der Scheduler stellt den Job sonst alle 10 min neu ein)
 *
 * Offboarding hat Vorrang: Gestoppte Channels, nicht aktive Pipelines und deaktivierte User werden nie
 * verlängert – das Abo läuft dann von selbst aus bzw. der Teardown löscht es.
 */
import { backoffDelayMs, respectRetryAfter, SCOPE_PROPAGATION, TRANSIENT } from "./backoff.js";
import { GRAPH_SUBSCRIPTION_LIFETIME_MS } from "./handshakeWorker.js";
import type { DelayedJobQueue, Job } from "./retryQueue.js";
import type { AppTokenProvider, FetchLike } from "./types.js";

export const RENEW_KIND = "channel.renew";
const GRAPH = "https://graph.microsoft.com/v1.0";

export interface RenewPayload {
  channelId: string;
}

export interface RenewTarget {
  channelId: string;
  tenantId: string;
  userId: string;
  provider: "microsoft" | "google";
  providerSubscriptionId: string;
  expiresAt: string | null;
  /** weder stop_requested_at noch stopped_at gesetzt */
  live: boolean;
  pipelineId: string;
  pipelineStatus: string;
  ownerActive: boolean;
  /** Provisionierungszeitpunkt – Anker für das 403-Propagationsfenster eines Neuanlage-Handshakes */
  ownerCreatedAt: string | null;
}

export interface RenewalRepo {
  getRenewTarget(tenantId: string, channelId: string): Promise<RenewTarget | null>;
  /** Nur lebende Channels; false = inzwischen gestoppt (Offboarding lief parallel) */
  extendExpiry(channelId: string, expiresAtIso: string): Promise<boolean>;
  /** Channel stoppen + Handshake-Job einstellen in EINER Anweisung */
  markGoneAndRecreate(channelId: string, note: string, handshakePayload: Record<string, unknown>): Promise<{ marked: boolean; queued: boolean }>;
  /** Verlängerung für einen Channel bis zu einem Zeitpunkt aussetzen (nach endgültigem Fehler) */
  pauseRenewal(channelId: string, untilIso: string, error: string): Promise<void>;
  /** Fällige Verlängerungen einstellen; liefert die Zahl neu eingestellter Jobs */
  scheduleDueRenewals(horizonMs: number, spreadMs: number, limit: number): Promise<number>;
}

export type RenewOutcome = "renewed" | "recreated" | "dropped" | "rescheduled" | "failed";

export interface RenewalAlert {
  kind: "renewal_failed";
  tenantId: string;
  channelId: string;
  pipelineId: string;
  status: number;
  reason: string;
}

export interface RenewalDeps {
  queue: Pick<DelayedJobQueue, "claimDue" | "complete" | "reschedule" | "fail">;
  repo: RenewalRepo;
  tokens: AppTokenProvider;
  fetchFn: FetchLike;
  workerId: string;
  alert: (a: RenewalAlert) => Promise<void> | void;
  now?: () => Date;
  random?: () => number;
  lifetimeMs?: number;
  /** Zeitbudget je Graph-Aufruf */
  requestTimeoutMs?: number;
}

const MAX_TRANSIENT_ATTEMPTS = 8;
const MAX_FORBIDDEN_ATTEMPTS = 4;
const PAUSE_AFTER_FAILURE_MS = 6 * 60 * 60_000;

function retryAfterMs(v: string | null, nowMs: number): number {
  if (!v) return 0;
  const s = Number(v);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const at = Date.parse(v);
  return Number.isNaN(at) ? 0 : Math.max(0, at - nowMs);
}

export class RenewalWorker {
  private stopping = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(private readonly d: RenewalDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  stop(): void {
    this.stopping = true;
  }

  async drained(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  async tick(limit = 10, leaseMs = 120_000): Promise<Record<RenewOutcome, number> & { claimed: number }> {
    const r = { claimed: 0, renewed: 0, recreated: 0, dropped: 0, rescheduled: 0, failed: 0 };
    if (this.stopping) return r;
    const jobs = await this.d.queue.claimDue(this.d.workerId, limit, leaseMs, [RENEW_KIND]);
    r.claimed = jobs.length;
    const run = Promise.allSettled(jobs.map((j) => this.process(j as Job<RenewPayload>)));
    this.inflight.add(run);
    try {
      for (const s of await run) {
        if (s.status === "fulfilled") r[s.value] += 1;
        else r.failed += 1; // DB-Ausfall: Lease läuft ab, Job kommt zurück
      }
    } finally {
      this.inflight.delete(run);
    }
    return r;
  }

  private async patch(t: RenewTarget, expiresAt: string): Promise<{ status: number; retryAfter: string | null; body: string }> {
    const call = async () => {
      const token = await this.d.tokens.getToken(t.tenantId, "microsoft");
      const res = await this.d.fetchFn(`${GRAPH}/subscriptions/${encodeURIComponent(t.providerSubscriptionId)}`, {
        method: "PATCH",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ expirationDateTime: expiresAt }),
        signal: AbortSignal.timeout(this.d.requestTimeoutMs ?? 15_000),
      });
      return { status: res.status, retryAfter: res.headers.get("Retry-After"), body: (await res.text()).slice(0, 2_000) };
    };
    const first = await call();
    if (first.status !== 401) return first;
    this.d.tokens.invalidate(t.tenantId, "microsoft");
    return call();
  }

  private async process(job: Job<RenewPayload>): Promise<RenewOutcome> {
    const { queue, workerId, repo } = this.d;
    const channelId = typeof job.payload?.channelId === "string" ? job.payload.channelId : "";
    const t = channelId ? await repo.getRenewTarget(job.tenantId, channelId) : null;

    // Offboarding/Stop hat Vorrang; Google-Channels werden nicht verlängert, sondern neu angelegt (watch)
    if (!t || !t.live || t.provider !== "microsoft" || t.pipelineStatus !== "active" || !t.ownerActive) {
      await queue.complete(job.id, workerId);
      return "dropped";
    }

    const nowMs = this.now().getTime();
    const expiresAt = new Date(nowMs + (this.d.lifetimeMs ?? GRAPH_SUBSCRIPTION_LIFETIME_MS)).toISOString();
    let res: { status: number; retryAfter: string | null; body: string };
    try {
      res = await this.patch(t, expiresAt);
    } catch (err) {
      res = { status: 0, retryAfter: null, body: err instanceof Error ? err.name : "network_error" };
    }

    if (res.status === 200) {
      let confirmed = expiresAt;
      try {
        const parsed = JSON.parse(res.body) as { expirationDateTime?: unknown };
        if (typeof parsed.expirationDateTime === "string" && !Number.isNaN(Date.parse(parsed.expirationDateTime))) confirmed = parsed.expirationDateTime;
      } catch {
        // Body egal – Graph hat 200 gesagt, unsere Zeit ist konservativ
      }
      await repo.extendExpiry(t.channelId, confirmed);
      await queue.complete(job.id, workerId);
      return "renewed";
    }

    if (res.status === 404) {
      // Abgelaufen oder von Microsoft entfernt: neu anlegen. Ein Handshake-Job pro Pipeline (dedupe).
      await repo.markGoneAndRecreate(t.channelId, "renew_404_subscription_gone", {
        pipelineId: t.pipelineId, userId: t.userId, grantedAt: t.ownerCreatedAt, attempts: {},
      });
      await queue.complete(job.id, workerId);
      return "recreated";
    }

    const transient = res.status === 0 || res.status === 429 || res.status >= 500 || res.status === 401;
    const forbidden = res.status === 403;
    const reason = `HTTP ${res.status} ${res.body.slice(0, 200)}`;
    const random = this.d.random ?? Math.random;

    if (transient && job.attempts < MAX_TRANSIENT_ATTEMPTS) {
      const delay = respectRetryAfter(retryAfterMs(res.retryAfter, nowMs), backoffDelayMs(TRANSIENT, job.attempts, random), random);
      await queue.reschedule(job.id, workerId, delay, job.payload, reason);
      return "rescheduled";
    }
    if (forbidden && job.attempts < MAX_FORBIDDEN_ATTEMPTS) {
      await queue.reschedule(job.id, workerId, backoffDelayMs(SCOPE_PROPAGATION, job.attempts, random), job.payload, reason);
      return "rescheduled";
    }

    // Endgültig: Alarm, Job als failed, Verlängerung pausieren. Läuft das Abo aus, schickt Graph
    // subscriptionRemoved → Neuanlage über den Handshake (mit dessen eigener 403-Behandlung).
    await this.d.alert({ kind: "renewal_failed", tenantId: t.tenantId, channelId: t.channelId, pipelineId: t.pipelineId, status: res.status, reason });
    await repo.pauseRenewal(t.channelId, new Date(nowMs + PAUSE_AFTER_FAILURE_MS).toISOString(), reason);
    await queue.fail(job.id, workerId, reason);
    return "failed";
  }
}

/** Stellt fällige Verlängerungen ein – ein Statement je Lauf, unabhängig von der Zahl der Abos. */
export class RenewalScheduler {
  constructor(
    private readonly repo: Pick<RenewalRepo, "scheduleDueRenewals">,
    private readonly o: { horizonMs?: number; spreadMs?: number; limit?: number } = {},
  ) {}

  tick(): Promise<number> {
    return this.repo.scheduleDueRenewals(this.o.horizonMs ?? 24 * 60 * 60_000, this.o.spreadMs ?? 30 * 60_000, this.o.limit ?? 1_000);
  }
}

