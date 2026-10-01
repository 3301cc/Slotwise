/**
 * Worker für Job "subscription.teardown" – eingestellt vom SCIM-Endpunkt in derselben Transaktion wie die
 * Kappung (scim/src/prismaStore.ts). Der SCIM-Request selbst ruft Microsoft/Google nie auf.
 *
 * Pro Job:
 *   1. alle offenen Abos des Users beim Provider beenden (Budget 15 s, parallel)
 *   2. noch offene Abos?  → Job mit Backoff (±15 % Jitter) zurückstellen
 *      keine mehr offen?  → bei purgeUser: Tombstone endgültig löschen, Audit, Job abschließen
 *   3. Notbremse: Nach maxWaitMs (Default 8 Tage) wird trotzdem gelöscht und alarmiert. Graph-Abos auf
 *      Outlook-Events leben höchstens 10 080 min (< 7 Tage) und werden nicht mehr verlängert – danach ist
 *      sicher nichts mehr aktiv. Der Webhook-Guard verwirft bis dahin jede Notification.
 *
 * Fehler in einem Job (auch Throws) betreffen nur diesen Job; der Lease läuft ab, ein anderer Worker
 * übernimmt. Kein Head-of-Line-Blocking.
 */
import { SUBSCRIPTION_STOP } from "./backoff.js";
import { rescheduleWithBackoff, type DelayedJobQueue, type Job } from "./retryQueue.js";
import type { ChannelRepo, SubscriptionTeardown } from "./subscriptionTeardown.js";
import { isPermanentStopFailure } from "./subscriptionTeardown.js";

export const TEARDOWN_JOB_KIND = "subscription.teardown";

/** Muss scim/src/types.ts TeardownJobPayload entsprechen */
export interface TeardownJobPayload {
  userId: string;
  purgeUser: boolean;
  requestedAt: string;
}

export interface UserPurger {
  /** Löscht NUR Tombstones (deletion_requested_at IS NOT NULL). Liefert false, wenn keiner (mehr) da ist. */
  purgeDeletedUser(tenantId: string, userId: string): Promise<boolean>;
}

export interface TeardownAuditEvent {
  tenantId: string;
  jobId: string;
  userId: string;
  action: "scim.user.subscriptions_terminated" | "scim.user.purged";
  outcome: "success" | "failure";
  detail: Record<string, unknown>;
}

export interface TeardownJobDeps {
  queue: DelayedJobQueue;
  teardown: Pick<SubscriptionTeardown, "terminateForUser">;
  channels: Pick<ChannelRepo, "listOpenForUser">;
  users: UserPurger;
  audit: (e: TeardownAuditEvent) => Promise<void>;
  alert: (e: { tenantId: string; userId: string; kind: "teardown_deadline" | "teardown_permanent_failure"; detail: string }) => Promise<void>;
  workerId: string;
  now?: () => Date;
  random?: () => number;
  /** Default 8 Tage */
  maxWaitMs?: number;
  /** Zeitbudget je Job-Lauf für die Provider-Aufrufe, Default 15 s (deutlich unter der Lease von 120 s) */
  perRunBudgetMs?: number;
}

export type TeardownJobOutcome = "completed" | "purged" | "rescheduled" | "deadline_purged" | "failed";

export class TeardownJobWorker {
  private stopping = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(private readonly d: TeardownJobDeps) {}

  private now() {
    return this.d.now?.() ?? new Date();
  }

  stop() {
    this.stopping = true;
  }

  async drained(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  async tick(limit = 10, leaseMs = 120_000): Promise<Record<TeardownJobOutcome, number> & { claimed: number }> {
    const r = { claimed: 0, completed: 0, purged: 0, rescheduled: 0, deadline_purged: 0, failed: 0 };
    if (this.stopping) return r;
    const jobs = await this.d.queue.claimDue(this.d.workerId, limit, leaseMs, [TEARDOWN_JOB_KIND]);
    r.claimed = jobs.length;
    const run = Promise.allSettled(jobs.map((j) => this.process(j as Job<TeardownJobPayload>)));
    this.inflight.add(run);
    try {
      for (const s of await run) r[s.status === "fulfilled" ? s.value : "failed"] += 1;
    } finally {
      this.inflight.delete(run);
    }
    return r;
  }

  private async process(job: Job<TeardownJobPayload>): Promise<TeardownJobOutcome> {
    const { queue, workerId } = this.d;
    const { userId, purgeUser, requestedAt } = job.payload;
    const tenantId = job.tenantId;

    const result = await this.d.teardown.terminateForUser(tenantId, userId, this.d.perRunBudgetMs ?? 15_000);
    const open = await this.d.channels.listOpenForUser(tenantId, userId);
    const pending = open.filter((c) => !isPermanentStopFailure(c));
    const permanent = open.length - pending.length;
    const summary = {
      channels: result.channels, stopped: result.stopped, alreadyGone: result.alreadyGone,
      retryScheduled: result.retryScheduled, failed: result.failed, timedOut: result.timedOut,
      stillOpen: pending.length, permanentFailures: permanent, attempt: job.attempts,
    };

    if (pending.length === 0) {
      await this.d.audit({ tenantId, jobId: job.id, userId, action: "scim.user.subscriptions_terminated", outcome: permanent === 0 ? "success" : "failure", detail: summary });
      if (permanent > 0) {
        await this.d.alert({ tenantId, userId, kind: "teardown_permanent_failure", detail: `${permanent} Abo(s) nicht beendbar – erlöschen mit Ablauf beim Provider` });
      }
      if (purgeUser) {
        const purged = await this.d.users.purgeDeletedUser(tenantId, userId);
        await this.d.audit({ tenantId, jobId: job.id, userId, action: "scim.user.purged", outcome: "success", detail: { purged } });
      }
      await queue.complete(job.id, workerId);
      return purgeUser ? "purged" : "completed";
    }

    const waitedMs = this.now().getTime() - Date.parse(requestedAt);
    if (waitedMs > (this.d.maxWaitMs ?? 8 * 24 * 60 * 60_000)) {
      await this.d.alert({ tenantId, userId, kind: "teardown_deadline", detail: `${pending.length} Abo(s) nach ${Math.round(waitedMs / 3_600_000)} h noch offen` });
      await this.d.audit({ tenantId, jobId: job.id, userId, action: "scim.user.subscriptions_terminated", outcome: "failure", detail: { ...summary, deadline: true } });
      if (purgeUser) {
        const purged = await this.d.users.purgeDeletedUser(tenantId, userId);
        await this.d.audit({ tenantId, jobId: job.id, userId, action: "scim.user.purged", outcome: "success", detail: { purged, deadline: true } });
      }
      await queue.complete(job.id, workerId);
      return "deadline_purged";
    }

    // Nächster Versuch: 30 s · 3^(n−1), max. 60 min, jeweils ±15 % Jitter
    const reasons = [...new Set(result.details.filter((x) => x.reason).map((x) => x.reason))].slice(0, 3).join("; ");
    await rescheduleWithBackoff(queue, job, workerId, SUBSCRIPTION_STOP, `${pending.length} Abo(s) offen${reasons ? `: ${reasons}` : ""}`, {
      random: this.d.random,
    });
    return "rescheduled";
  }
}
