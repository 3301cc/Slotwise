/**
 * Pipeline-Handshake: Graph-Subscription für ein Postfach anlegen.
 *
 * Läuft als Job "pipeline.handshake" in der Delay-Queue. Ein 403 direkt nach der SCIM-Provisionierung
 * stellt NUR diesen Job zurück (30 min, dann exponentiell) – alle anderen Jobs laufen weiter.
 * Jeder Job ist isoliert: ein Fehler (auch ein unerwarteter Throw) in einem Job beeinflusst die übrigen
 * Jobs desselben Ticks nicht.
 */
import { randomBytes } from "node:crypto";
import { handleHandshakeFailure, type FailureSinks, type GraphFailure, type HandshakePayload } from "./errorHandler.js";
import type { DelayedJobQueue, Job } from "./retryQueue.js";
import type { AppTokenProvider, FetchLike } from "./types.js";

export const HANDSHAKE_KIND = "pipeline.handshake";
const GRAPH = "https://graph.microsoft.com/v1.0";
/** Outlook-Events erlauben max. 10 080 min; wir bleiben deutlich darunter und verlängern per Renewal-Job. */
export const GRAPH_SUBSCRIPTION_LIFETIME_MS = 6 * 24 * 60 * 60_000;
const SUBSCRIPTION_LIFETIME_MS = GRAPH_SUBSCRIPTION_LIFETIME_MS;

export interface HandshakeTarget {
  status: "pending" | "pending_scope" | "active" | "paused" | "revoked" | "blocked_scope" | "config_error" | "error";
  ownerActive: boolean;
  /** Es gibt bereits einen Channel ohne stop_requested_at/stopped_at → Handshake ist erledigt */
  hasLiveChannel: boolean;
  /** Entra-Objekt-ID des Postfachinhabers (keine E-Mail-Adresse in Ressourcen-Pfaden/Logs) */
  entraObjectId: string;
}

export interface PipelineRepo {
  getHandshakeTarget(tenantId: string, pipelineId: string): Promise<HandshakeTarget | null>;
  /**
   * In EINER Transaktion: webhook_channels-Zeile anlegen + Pipeline auf active setzen.
   * Muss bei einem zweiten lebenden Channel derselben Pipeline werfen (partieller Unique-Index
   *   CREATE UNIQUE INDEX webhook_channels_one_live ON webhook_channels (pipeline_id)
   *     WHERE stop_requested_at IS NULL AND stopped_at IS NULL;)
   * Der Worker löscht dann das gerade angelegte zweite Abo wieder (Kompensation).
   */
  activateWithChannel(
    tenantId: string,
    pipelineId: string,
    ch: { userId: string; providerSubscriptionId: string; clientState: string; expiresAt: string },
  ): Promise<void>;
}

export interface HandshakeDeps {
  queue: DelayedJobQueue;
  pipelines: PipelineRepo;
  sinks: Pick<FailureSinks, "setPipelineStatus" | "alert">;
  tokens: AppTokenProvider;
  fetchFn: FetchLike;
  notificationUrl: string;
  lifecycleNotificationUrl: string;
  workerId: string;
  now?: () => Date;
  random?: () => number;
  newClientState?: () => string;
}

export interface TickResult {
  claimed: number;
  activated: number;
  rescheduled: number;
  failed: number;
  dropped: number;
}

export class HandshakeWorker {
  private stopping = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(private readonly d: HandshakeDeps) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  /** Neue Jobs nicht mehr annehmen (SIGTERM). Laufende dürfen fertig werden. */
  stop() {
    this.stopping = true;
  }

  async drained(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  async tick(limit = 10, leaseMs = 120_000): Promise<TickResult> {
    const r: TickResult = { claimed: 0, activated: 0, rescheduled: 0, failed: 0, dropped: 0 };
    if (this.stopping) return r;
    const jobs = await this.d.queue.claimDue(this.d.workerId, limit, leaseMs, [HANDSHAKE_KIND]);
    r.claimed = jobs.length;
    const run = Promise.allSettled(jobs.map((j) => this.process(j as Job<HandshakePayload>)));
    this.inflight.add(run);
    try {
      for (const s of await run) {
        if (s.status === "fulfilled") r[s.value] += 1;
        else r.failed += 1; // kann nur bei DB-Ausfall passieren; Lease läuft ab, Job kommt zurück
      }
    } finally {
      this.inflight.delete(run);
    }
    return r;
  }

  private async process(job: Job<HandshakePayload>): Promise<"activated" | "rescheduled" | "failed" | "dropped"> {
    const { queue, workerId } = this.d;
    const p = job.payload;
    const target = await this.d.pipelines.getHandshakeTarget(job.tenantId, p.pipelineId);

    // Offboarding hat Vorrang: ein revoked/inaktiver User wird nie durch einen alten Retry wiederbelebt.
    if (!target || !target.ownerActive || target.status === "revoked" || target.status === "paused") {
      await queue.complete(job.id, workerId);
      return "dropped";
    }
    // Doppelter Handshake (z. B. zweiter Job, während der erste lief): kein zweites Abo anlegen
    if (target.hasLiveChannel) {
      await queue.complete(job.id, workerId);
      return "dropped";
    }

    let failure: GraphFailure;
    try {
      const clientState = this.d.newClientState?.() ?? randomBytes(32).toString("base64url");
      const expiresAt = new Date(this.now().getTime() + SUBSCRIPTION_LIFETIME_MS).toISOString();
      const token = await this.d.tokens.getToken(job.tenantId, "microsoft");
      const res = await this.d.fetchFn(`${GRAPH}/subscriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          changeType: "created,updated,deleted",
          notificationUrl: this.d.notificationUrl,
          lifecycleNotificationUrl: this.d.lifecycleNotificationUrl,
          resource: `users/${target.entraObjectId}/events`,
          expirationDateTime: expiresAt,
          clientState,
        }),
      });
      const text = await res.text();
      if (res.status === 201) {
        const sub = JSON.parse(text) as { id: string; expirationDateTime?: string };
        try {
          await this.d.pipelines.activateWithChannel(job.tenantId, p.pipelineId, {
            userId: p.userId,
            providerSubscriptionId: sub.id,
            clientState,
            expiresAt: sub.expirationDateTime ?? expiresAt,
          });
        } catch (err) {
          // Kompensation: kein verwaistes Abo bei Microsoft, das wir nirgends gespeichert haben
          await this.d
            .fetchFn(`${GRAPH}/subscriptions/${encodeURIComponent(sub.id)}`, { method: "DELETE", headers: { Authorization: `Bearer ${token}` } })
            .catch(() => undefined);
          throw err;
        }
        await queue.complete(job.id, workerId);
        return "activated";
      }
      if (res.status === 401) this.d.tokens.invalidate(job.tenantId, "microsoft");
      failure = { status: res.status, body: text, retryAfter: res.headers.get("Retry-After") };
    } catch (err) {
      failure = { status: 0, body: err instanceof Error ? err.message : String(err), retryAfter: null };
    }

    const decision = await handleHandshakeFailure(
      job,
      failure,
      {
        reschedule: (id, delayMs, payload, lastError) => queue.reschedule(id, workerId, delayMs, payload, lastError),
        failJob: (id, lastError) => queue.fail(id, workerId, lastError),
        setPipelineStatus: this.d.sinks.setPipelineStatus,
        alert: this.d.sinks.alert,
      },
      this.now(),
      this.d.random,
    );
    return decision.action === "retry" ? "rescheduled" : "failed";
  }
}
