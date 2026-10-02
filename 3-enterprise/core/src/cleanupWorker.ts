/**
 * Bereinigung des Zielkalenders nach Widerruf (Job "pipeline.target_cleanup", Payload { pipelineId }).
 *
 * Eingestellt im SELBEN Commit wie die Kappung (Outbox, wie "subscription.teardown"):
 *   * SCIM-Deaktivierung / -DELETE        scim/src/prismaStore.ts revokeInTx
 *   * Nutzer beendet die Pipeline          DELETE /api/v1/me/pipelines/{id} (app/src/pipelineStore.ts endPipeline)
 *
 * Pro Job:
 *   1. Pipeline lesen: Bereinigung angefordert und noch offen? Sonst nichts tun.
 *   2. Sync-Lease nehmen (ein noch laufender Sync stoppt am nächsten Checkpoint; was er bis dahin angelegt hat,
 *      steht in sync_event_map und wird hier mit gelöscht).
 *   3. booking / ohne Ziel: nur Zuordnungen löschen.
 *      account / team: Ziel erneut gegen die Allowlist (ohne Same-Person-Prüfung, siehe recheckTargetForCleanup),
 *      dann jeden von CalenSync angelegten Zieltermin löschen (DELETE /users/{mailbox}/events/{id}; 404 = schon
 *      weg). Begonnene, unbestätigte Anlagen werden über die Extended Property gefunden. Fortschritt wird je Termin
 *      gespeichert (Zuordnung gelöscht) – ein Abbruch setzt beim nächsten Lauf fort.
 *      Google-Ziele (target_provider google): DELETE calendars/primary/events/{id} im impersonierten Postfach
 *      (404/410 = schon weg); unbestätigte Anlagen haben ihre deterministische ID. Auch archivierte Zuordnungen.
 *      Trägt ein Termin nicht unsere Markierung, wird er übersprungen (Alarm), nie gelöscht. Ist das Google-Konto
 *      gelöscht (Token-Tausch invalid_grant UND Directory 404), gelten die Termine als weg → erledigt.
 *   4. Erledigt: restliche Zuordnungen weg, Zielpostfach + Delta-Link genullt, cleanup_done_at gesetzt.
 *
 * Bewusst KEINE "Inhaber aktiv"-Prüfung (die verhindert Schreiben; hier wird nur gelöscht). Vor jedem Aufruf wird
 * aber geprüft, dass die Bereinigung noch offen, die Pipeline nicht aktiv und das Ziel unverändert ist.
 * Es gibt nur DELETE- (und zum Wiederfinden GET-) Aufrufe, nie POST/PATCH.
 *
 * Fehler: classifyGraphError + Backoff; endgültig → Alarm, Job failed, Zuordnungen bleiben für die manuelle
 * Nacharbeit. Ein SCIM-gelöschter Nutzer wird erst nach erledigter Bereinigung endgültig gelöscht, spätestens
 * nach 8 Tagen (Notbremse im TeardownJobWorker; danach kaskadieren Pipeline und Zuordnungen).
 */
import { classifyGraphError, type GraphFailure } from "./errorHandler.js";
import type { GraphTokenSource } from "./appToken.js";
import type { GoogleTokenSource } from "./googleAuth.js";
import { createGoogleCaller, GoogleCalendarWriter, googleAccountDeleted } from "./googleCalendar.js";
import { ForeignEventError, GoogleAuthError } from "./syncErrors.js";
import type { DelayedJobQueue, Job } from "./retryQueue.js";
import { googleWorkspaceFor, recheckTargetForCleanup, type StoredTarget, type SyncAllowlist } from "./syncTargets.js";
import { classifyProviderError, createGraphCaller, GraphCalendarWriter, GraphCallError, RunAborted, sourceRef, type SyncRepo, type TargetWriter } from "./syncWorker.js";
import type { FetchLike } from "./types.js";

export const CLEANUP_KIND = "pipeline.target_cleanup";

export interface CleanupPayload {
  pipelineId: string;
  attempts?: Partial<Record<"scope_propagation" | "transient" | "token", number>>;
}

export interface CleanupContext {
  status: string;
  target: StoredTarget;
  cleanupRequestedAt: Date | null;
  cleanupDoneAt: Date | null;
}

export interface CleanupRepo extends Pick<SyncRepo, "acquireSyncLease" | "releaseSyncLease" | "listMappings" | "deleteMapping" | "setSyncError"> {
  getCleanupContext(tenantId: string, pipelineId: string): Promise<CleanupContext | null>;
  /** Nur wenn noch offen: restliche Zuordnungen löschen, Zielpostfach + Delta-Link nullen, cleanup_done_at = now() */
  completeCleanup(tenantId: string, pipelineId: string): Promise<void>;
}

export interface CleanupAlert {
  kind: "target_cleanup_failed";
  tenantId: string;
  pipelineId: string;
  category: string;
  reason: string;
}

export interface CleanupDeps {
  queue: Pick<DelayedJobQueue, "claimDue" | "complete" | "reschedule" | "fail">;
  repo: CleanupRepo;
  tokens: GraphTokenSource;
  /** für Google-Ziele (DWD, keyless) */
  googleTokens?: GoogleTokenSource;
  fetchFn: FetchLike;
  allowlist: SyncAllowlist;
  workerId: string;
  alert: (a: CleanupAlert) => Promise<void> | void;
  log?: (entry: Record<string, unknown>) => void;
  now?: () => Date;
  random?: () => number;
  /** Default: Lease 10 min, Budget 8 min, Timeout je Aufruf 20 s */
  leaseMs?: number;
  runBudgetMs?: number;
  requestTimeoutMs?: number;
}

export type CleanupOutcome = "cleaned" | "dropped" | "busy" | "rescheduled" | "failed";

class CleanupStopped extends RunAborted {}
class BudgetExceeded extends RunAborted {}
class ShuttingDown extends RunAborted {}

const STOPPABLE = new Set(["revoked", "paused"]);
const sameTarget = (a: StoredTarget, b: StoredTarget) =>
  a.kind === b.kind && (a.mailbox ?? null) === (b.mailbox ?? null) && (a.entraTenantId ?? null) === (b.entraTenantId ?? null) && (a.ref ?? null) === (b.ref ?? null)
  && (a.provider ?? "microsoft") === (b.provider ?? "microsoft") && (a.workspaceId ?? null) === (b.workspaceId ?? null);

export class TargetCleanupWorker {
  private stopping = false;
  private inflight = new Set<Promise<unknown>>();

  constructor(private readonly d: CleanupDeps) {}

  private now(): Date {
    return this.d.now?.() ?? new Date();
  }

  stop(): void {
    this.stopping = true;
  }

  async drained(): Promise<void> {
    await Promise.allSettled([...this.inflight]);
  }

  async tick(limit = 5, leaseMs = this.d.leaseMs ?? 10 * 60_000): Promise<Record<CleanupOutcome, number> & { claimed: number }> {
    const r = { claimed: 0, cleaned: 0, dropped: 0, busy: 0, rescheduled: 0, failed: 0 };
    if (this.stopping) return r;
    const jobs = await this.d.queue.claimDue(this.d.workerId, limit, leaseMs, [CLEANUP_KIND]);
    r.claimed = jobs.length;
    const run = Promise.allSettled(jobs.map((j) => this.process(j as Job<CleanupPayload>)));
    this.inflight.add(run);
    try {
      for (const s of await run) r[s.status === "fulfilled" ? s.value : "failed"] += 1;
    } finally {
      this.inflight.delete(run);
    }
    return r;
  }

  private async reschedule(job: Job<CleanupPayload>, delayMs: number, payload: CleanupPayload, reason: string): Promise<void> {
    try {
      await this.d.queue.reschedule(job.id, this.d.workerId, delayMs, payload, reason);
    } catch {
      await this.d.queue.complete(job.id, this.d.workerId); // ein wartender Job derselben Pipeline übernimmt
    }
  }

  private async process(job: Job<CleanupPayload>): Promise<CleanupOutcome> {
    const { queue, workerId, repo } = this.d;
    const tenantId = job.tenantId;
    const pipelineId = typeof job.payload?.pipelineId === "string" ? job.payload.pipelineId : "";
    const payload: CleanupPayload = { pipelineId, attempts: job.payload?.attempts ?? {} };
    const ctx = pipelineId ? await repo.getCleanupContext(tenantId, pipelineId) : null;
    // nichts angefordert, schon erledigt, Pipeline weg (Notbremse hat gelöscht) oder (fälschlich) noch aktiv
    if (!ctx || !ctx.cleanupRequestedAt || ctx.cleanupDoneAt || !STOPPABLE.has(ctx.status)) {
      await queue.complete(job.id, workerId);
      return "dropped";
    }
    if (!(await repo.acquireSyncLease(tenantId, pipelineId, job.id, this.d.leaseMs ?? 10 * 60_000))) {
      await this.reschedule(job, 30_000, payload, "sync_lease_busy");
      return "busy";
    }

    let deleted = 0;
    let googleCall: ReturnType<typeof createGoogleCaller> | null = null;
    const workspace = googleWorkspaceFor(this.d.allowlist, ctx.target);
    try {
      if (ctx.target.kind !== "account" && ctx.target.kind !== "team") {
        // Buchungsseite / Altbestand: es gibt nichts beim Provider, nur Zuordnungen
        await repo.completeCleanup(tenantId, pipelineId);
        await queue.complete(job.id, workerId);
        this.d.log?.({ level: "info", msg: "target_cleanup_done", pipelineId, target: ctx.target.kind, deleted });
        return "cleaned";
      }
      const allowed = recheckTargetForCleanup(this.d.allowlist, ctx.target);
      if (allowed.ok && ctx.target.provider === "google" && (!workspace || !this.d.googleTokens)) {
        const reason = "cleanup_google_not_configured";
        await queue.fail(job.id, workerId, reason);
        await repo.setSyncError(tenantId, pipelineId, "cleanup_failed");
        await this.d.alert({ kind: "target_cleanup_failed", tenantId, pipelineId, category: "config", reason });
        return "failed";
      }
      if (!allowed.ok) {
        const reason = `cleanup_target_not_allowed:${allowed.reason}`;
        await queue.fail(job.id, workerId, reason);
        await repo.setSyncError(tenantId, pipelineId, "cleanup_target_not_allowed");
        await this.d.alert({ kind: "target_cleanup_failed", tenantId, pipelineId, category: "target_not_allowed", reason });
        return "failed";
      }

      const checkpoint = async () => {
        if (this.stopping) throw new ShuttingDown();
        const c = await repo.getCleanupContext(tenantId, pipelineId);
        if (!c || !c.cleanupRequestedAt || c.cleanupDoneAt || !STOPPABLE.has(c.status) || !sameTarget(c.target, ctx.target)) {
          throw new CleanupStopped();
        }
      };
      const timeout = this.d.requestTimeoutMs ?? 20_000;
      // Nur DELETE (und bei Graph das Wiederfinden per GET) – nie POST/PATCH
      if (workspace) googleCall = createGoogleCaller(this.d.googleTokens as GoogleTokenSource, this.d.fetchFn, workspace.serviceAccountEmail, timeout, checkpoint);
      const writer: TargetWriter = googleCall
        ? new GoogleCalendarWriter(googleCall, ctx.target.mailbox ?? "")
        : new GraphCalendarWriter(createGraphCaller(this.d.tokens, this.d.fetchFn, tenantId, timeout, checkpoint), ctx.target.mailbox ?? "", ctx.target.entraTenantId);
      const deadline = this.now().getTime() + (this.d.runBudgetMs ?? 8 * 60_000);

      for (const row of await repo.listMappings(pipelineId)) {
        if (this.now().getTime() > deadline) throw new BudgetExceeded();
        const id = row.targetEventId ?? (await writer.findByRef(sourceRef(pipelineId, row.sourceEventId)));
        try {
          if (id) await writer.delete(id); // 404 = schon weg
        } catch (err) {
          if (!(err instanceof ForeignEventError)) throw err;
          // fremder Termin unter dieser ID: nie löschen, Zuordnung vergessen, Admin informieren
          await this.d.alert({ kind: "target_cleanup_failed", tenantId, pipelineId, category: "foreign_event", reason: "cleanup_foreign_event" });
        }
        await repo.deleteMapping(pipelineId, row.sourceEventId);
        deleted += 1;
      }
      await repo.completeCleanup(tenantId, pipelineId);
      await queue.complete(job.id, workerId);
      this.d.log?.({ level: "info", msg: "target_cleanup_done", pipelineId, target: ctx.target.kind, provider: ctx.target.provider ?? "microsoft", deleted });
      return "cleaned";
    } catch (err) {
      if (err instanceof CleanupStopped) {
        await queue.complete(job.id, workerId);
        return "dropped";
      }
      // Google-Konto gelöscht: Token-Tausch meldet invalid_grant; nur wenn die Directory das Konto NICHT mehr kennt (404),
      // gibt es den Kalender samt unseren Terminen nicht mehr → erledigt. Gesperrt/vorhanden → normale Fehlerbehandlung.
      if (err instanceof GoogleAuthError && err.stage === "oauth" && err.code === "invalid_grant" && googleCall && workspace) {
        let gone = false;
        try {
          gone = await googleAccountDeleted(googleCall, ctx.target.mailbox ?? "", workspace.directoryAdminSubject ?? null);
        } catch (e) {
          if (e instanceof CleanupStopped) {
            await queue.complete(job.id, workerId);
            return "dropped";
          }
          if (e instanceof ShuttingDown) {
            await this.reschedule(job, 5_000, payload, "worker_shutdown");
            return "rescheduled";
          }
        }
        if (gone) {
          await repo.completeCleanup(tenantId, pipelineId);
          await queue.complete(job.id, workerId);
          this.d.log?.({ level: "info", msg: "target_cleanup_done", pipelineId, target: ctx.target.kind, provider: "google", deleted, reason: "google_account_deleted" });
          return "cleaned";
        }
      }
      if (err instanceof ShuttingDown || err instanceof BudgetExceeded) {
        // Fortschritt ist gespeichert (Zuordnungen je Termin gelöscht) → bald fortsetzen, kein Fehlversuch
        await this.reschedule(job, err instanceof ShuttingDown ? 5_000 : 1_000, payload, err instanceof ShuttingDown ? "worker_shutdown" : "cleanup_continue");
        return "rescheduled";
      }
      const failure: GraphFailure = err instanceof GraphCallError
        ? { status: err.status, body: err.body, retryAfter: err.retryAfter }
        : { status: 0, body: err instanceof Error ? err.name : "error", retryAfter: null };
      const cctx = { now: this.now(), grantedAt: null, attempts: payload.attempts ?? {}, random: this.d.random };
      const decision = err instanceof GraphCallError ? classifyProviderError(err, cctx) : classifyGraphError(failure, cctx);
      this.d.log?.({ level: decision.action === "retry" ? "warn" : "error", msg: "target_cleanup_failed", pipelineId,
        status: failure.status, category: decision.category, action: decision.action, deleted });
      if (decision.action === "retry") {
        const attempts = { ...(payload.attempts ?? {}), [decision.category]: ((payload.attempts ?? {})[decision.category] ?? 0) + 1 };
        await this.reschedule(job, decision.delayMs, { ...payload, attempts }, decision.reason);
        await repo.setSyncError(tenantId, pipelineId, `cleanup_${decision.category}`);
        return "rescheduled";
      }
      // Endgültig: Zuordnungen bleiben stehen (manuelle Nacharbeit), Alarm
      await queue.fail(job.id, workerId, decision.reason);
      await repo.setSyncError(tenantId, pipelineId, "cleanup_failed");
      await this.d.alert({ kind: "target_cleanup_failed", tenantId, pipelineId, category: decision.category, reason: decision.reason });
      return "failed";
    } finally {
      await repo.releaseSyncLease(tenantId, pipelineId, job.id).catch(() => undefined);
    }
  }
}
