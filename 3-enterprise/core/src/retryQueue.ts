/**
 * Delay-Queue für Handshake-, Sync- und Stop-Jobs.
 *
 * Warum Postgres statt SQS: SQS DelaySeconds endet bei 900 s (15 min). Ein 30-min-Initial-Delay mit
 * Backoff bis 4 h ginge nur über Re-Queue-Ketten oder EventBridge Scheduler. Aurora ist ohnehin da, die
 * Queue liegt damit im selben KMS-verschlüsselten, gesicherten Speicher wie die Pipelines und Jobs können
 * in DERSELBEN Transaktion wie die fachliche Änderung eingestellt werden (kein Dual-Write).
 * Alternative BullMQ: queue.add(name, data, { jobId: dedupeKey, delay: 30 * 60_000 }) – braucht Redis
 * (ElastiCache) als zusätzliche Datenhaltung mit eigenem Verschlüsselungs-/Backup-Nachweis.
 *
 * Semantik:
 *   * at-least-once; Jobs müssen idempotent sein
 *   * Claim per FOR UPDATE SKIP LOCKED + Lease (locked_until). Stirbt ein Task beim Deployment, holt sich
 *     ein anderer den Job nach Ablauf der Lease zurück → kein Jobverlust bei Rolling Deploys
 *   * run_at wird mit der DB-Uhr gerechnet (now() + delay), nie mit der App-Uhr
 *   * Jitter gegen synchrone Retry-Wellen (Massen-Onboarding am Monatsersten):
 *       - rescheduleWithBackoff(): nächster Versuch = Exponential-Backoff · (1 ± 15 %), siehe backoff.ts
 *       - enqueue({ spreadMs }): Erstversuche einer Welle gleichmäßig über spreadMs verteilen
 *       - claimDue(limit): begrenzt, wie viele Jobs ein Worker gleichzeitig bearbeitet
 *   * dedupe_key: höchstens ein WARTENDER Job je Schlüssel (z. B. "delta:<pipelineId>"). Ein laufender Job
 *     blockiert keinen neuen wartenden – sonst ginge eine Änderung verloren, die während eines laufenden
 *     Delta-Syncs eintrifft. Bursts schrumpfen so auf höchstens "1 läuft + 1 wartet".
 *
 * Schema (Migration):
 *   CREATE TABLE job_queue (
 *     id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 *     tenant_id    text        NOT NULL,
 *     kind         text        NOT NULL,
 *     dedupe_key   text,
 *     payload      jsonb       NOT NULL,
 *     run_at       timestamptz NOT NULL DEFAULT now(),
 *     attempts     int         NOT NULL DEFAULT 0,
 *     status       text        NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','running','done','failed')),
 *     locked_by    text,
 *     locked_until timestamptz,
 *     last_error   text,
 *     created_at   timestamptz NOT NULL DEFAULT now(),
 *     updated_at   timestamptz NOT NULL DEFAULT now()
 *   );
 *   CREATE UNIQUE INDEX job_queue_queued_dedupe ON job_queue (kind, dedupe_key) WHERE status = 'queued';
 *   CREATE INDEX job_queue_due   ON job_queue (run_at)       WHERE status = 'queued';
 *   CREATE INDEX job_queue_lease ON job_queue (locked_until) WHERE status = 'running';
 */

import { backoffDelayMs, type BackoffPolicy } from "./backoff.js";

export interface Job<P = unknown> {
  id: string;
  tenantId: string;
  kind: string;
  dedupeKey: string | null;
  payload: P;
  attempts: number;
  runAt: Date;
  lastError: string | null;
}

export interface EnqueueOptions {
  delayMs?: number;
  /** Zusätzliche Zufallsverzögerung, gleichverteilt in [0, spreadMs) – entzerrt Wellen beim Einstellen */
  spreadMs?: number;
  dedupeKey?: string;
}

/** Effektive Verzögerung beim Einstellen: delayMs + U[0, spreadMs) */
export function enqueueDelayMs(opts: EnqueueOptions, random: () => number = Math.random): number {
  const base = Math.max(0, opts.delayMs ?? 0);
  const spread = Math.max(0, opts.spreadMs ?? 0);
  return Math.round(base + spread * random());
}

/**
 * Job mit exponentiellem Backoff und ±15 % Jitter zurückstellen. attempt = job.attempts (vom Claim
 * hochgezählt). Liefert die gewählte Verzögerung (für Logs/Metriken).
 */
export async function rescheduleWithBackoff<P>(
  queue: DelayedJobQueue,
  job: Job<P>,
  workerId: string,
  policy: BackoffPolicy,
  lastError: string,
  opts: { payload?: P; attempt?: number; random?: () => number } = {},
): Promise<{ delayMs: number; rescheduled: boolean }> {
  const delayMs = backoffDelayMs(policy, opts.attempt ?? job.attempts, opts.random);
  const rescheduled = await queue.reschedule(job.id, workerId, delayMs, opts.payload ?? job.payload, lastError);
  return { delayMs, rescheduled };
}

/** Ein Job für enqueueMany */
export interface EnqueueItem {
  tenantId: string;
  kind: string;
  payload: unknown;
  dedupeKey?: string;
  delayMs?: number;
}

export interface DelayedJobQueue {
  /**
   * Viele Jobs in EINER Anweisung. Doppelte (kind, dedupeKey) im Batch werden zusammengefasst (erster gewinnt).
   * Liefert die Zahl tatsächlich neu eingestellter Jobs.
   */
  enqueueMany(items: readonly EnqueueItem[], tx?: PgLike): Promise<number>;
  /** Liefert die Job-ID oder null, wenn bereits ein wartender Job mit gleichem dedupeKey existiert. */
  enqueue<P>(tenantId: string, kind: string, payload: P, opts?: EnqueueOptions, tx?: PgLike): Promise<string | null>;
  claimDue(workerId: string, limit: number, leaseMs: number, kinds?: string[]): Promise<Job[]>;
  complete(jobId: string, workerId: string): Promise<boolean>;
  reschedule<P>(jobId: string, workerId: string, delayMs: number, payload: P, lastError: string): Promise<boolean>;
  fail(jobId: string, workerId: string, lastError: string): Promise<boolean>;
}

/** Minimaler Ausschnitt von pg.Pool / pg.PoolClient */
export interface PgLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- kompatibel zu pg.QueryResultRow
  query<R extends Record<string, any> = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[]; rowCount: number | null }>;
}

type JobRow = {
  id: string;
  tenant_id: string;
  kind: string;
  dedupe_key: string | null;
  payload: unknown;
  attempts: number;
  run_at: Date;
  last_error: string | null;
};

const toJob = (r: JobRow): Job => ({
  id: r.id,
  tenantId: r.tenant_id,
  kind: r.kind,
  dedupeKey: r.dedupe_key,
  payload: r.payload,
  attempts: r.attempts,
  runAt: new Date(r.run_at),
  lastError: r.last_error,
});

export class PgDelayedJobQueue implements DelayedJobQueue {
  constructor(
    private readonly pool: PgLike,
    private readonly random: () => number = Math.random,
  ) {}

  async enqueue<P>(tenantId: string, kind: string, payload: P, opts: EnqueueOptions = {}, tx?: PgLike): Promise<string | null> {
    const db = tx ?? this.pool;
    const res = await db.query<{ id: string }>(
      `INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
       VALUES ($1, $2, $3, $4::jsonb, now() + ($5::bigint * interval '1 millisecond'))
       ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING
       RETURNING id`,
      [tenantId, kind, opts.dedupeKey ?? null, JSON.stringify(payload), enqueueDelayMs(opts, this.random)],
    );
    return res.rows[0]?.id ?? null;
  }

  /**
   * Mehrzeiliger Upsert. Die Zeilen werden nach (kind, dedupe_key) SORTIERT eingefügt: Zwei parallele Batches
   * mit überlappenden Schlüsseln warten dadurch immer in derselben Reihenfolge aufeinander. Unsortiert
   * erzeugten sie im Lasttest (64 Clients, 20 Notifications/Request) in 6,8 % der Requests Deadlocks.
   */
  async enqueueMany(items: readonly EnqueueItem[], tx?: PgLike): Promise<number> {
    if (items.length === 0) return 0;
    const n = items.length;
    const tenants = new Array<string>(n), kinds = new Array<string>(n), keys = new Array<string | null>(n);
    const payloads = new Array<string>(n), delays = new Array<number>(n);
    for (let i = 0; i < n; i++) {
      const it = items[i];
      tenants[i] = it.tenantId;
      kinds[i] = it.kind;
      keys[i] = it.dedupeKey ?? null;
      payloads[i] = JSON.stringify(it.payload);
      delays[i] = enqueueDelayMs(it, this.random);
    }
    const res = await (tx ?? this.pool).query(
      `INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
       SELECT DISTINCT ON (t.kind, COALESCE(t.dedupe_key, chr(1) || t.ord::text))
              t.tenant_id, t.kind, t.dedupe_key, t.payload, now() + (t.delay_ms * interval '1 millisecond')
         FROM unnest($1::text[], $2::text[], $3::text[], $4::jsonb[], $5::bigint[]) WITH ORDINALITY
              AS t(tenant_id, kind, dedupe_key, payload, delay_ms, ord)
        -- Jobs ohne dedupeKey bleiben einzeln (chr(1) || ord), sonst würde DISTINCT ON NULLs zusammenfassen
        ORDER BY t.kind, COALESCE(t.dedupe_key, chr(1) || t.ord::text), t.ord
       ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`,
      [tenants, kinds, keys, payloads, delays],
    );
    return res.rowCount ?? 0;
  }

  async claimDue(workerId: string, limit: number, leaseMs: number, kinds?: string[]): Promise<Job[]> {
    const res = await this.pool.query<JobRow>(
      `WITH due AS (
         SELECT id FROM job_queue
          WHERE ((status = 'queued' AND run_at <= now())
              OR (status = 'running' AND locked_until < now()))      -- Lease abgelaufen (Task gestorben)
            AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
          ORDER BY run_at
          LIMIT $1
          FOR UPDATE SKIP LOCKED
       )
       UPDATE job_queue j
          SET status = 'running', locked_by = $2,
              locked_until = now() + ($3::bigint * interval '1 millisecond'),
              attempts = j.attempts + 1, updated_at = now()
         FROM due
        WHERE j.id = due.id
       RETURNING j.id, j.tenant_id, j.kind, j.dedupe_key, j.payload, j.attempts, j.run_at, j.last_error`,
      [limit, workerId, leaseMs, kinds ?? null],
    );
    return res.rows.map(toJob);
  }

  async complete(jobId: string, workerId: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE job_queue SET status = 'done', locked_by = NULL, locked_until = NULL, updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [jobId, workerId],
    );
    return res.rowCount === 1;
  }

  async reschedule<P>(jobId: string, workerId: string, delayMs: number, payload: P, lastError: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE job_queue
          SET status = 'queued', locked_by = NULL, locked_until = NULL,
              run_at = now() + ($3::bigint * interval '1 millisecond'),
              payload = $4::jsonb, last_error = left($5, 1000), updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [jobId, workerId, Math.max(0, Math.round(delayMs)), JSON.stringify(payload), lastError],
    );
    return res.rowCount === 1;
  }

  async fail(jobId: string, workerId: string, lastError: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE job_queue SET status = 'failed', locked_by = NULL, locked_until = NULL,
              last_error = left($3, 1000), updated_at = now()
        WHERE id = $1 AND status = 'running' AND locked_by = $2`,
      [jobId, workerId, lastError],
    );
    return res.rowCount === 1;
  }
}

/** In-Memory-Variante für Tests und lokale Entwicklung. Gleiche Semantik, injizierbare Uhr. */
export class InMemoryDelayedJobQueue implements DelayedJobQueue {
  readonly rows = new Map<string, Job & { status: "queued" | "running" | "done" | "failed"; lockedBy: string | null; lockedUntil: number }>();
  private seq = 0;
  constructor(
    private readonly now: () => number = () => Date.now(),
    private readonly random: () => number = Math.random,
  ) {}

  async enqueue<P>(tenantId: string, kind: string, payload: P, opts: EnqueueOptions = {}): Promise<string | null> {
    if (opts.dedupeKey) {
      for (const r of this.rows.values()) {
        if (r.kind === kind && r.dedupeKey === opts.dedupeKey && r.status === "queued") return null;
      }
    }
    const id = `job-${++this.seq}`;
    this.rows.set(id, {
      id, tenantId, kind, dedupeKey: opts.dedupeKey ?? null, payload: structuredClone(payload), attempts: 0,
      runAt: new Date(this.now() + enqueueDelayMs(opts, this.random)), lastError: null, status: "queued", lockedBy: null, lockedUntil: 0,
    });
    return id;
  }

  async enqueueMany(items: readonly EnqueueItem[]): Promise<number> {
    let n = 0;
    for (const it of items) if ((await this.enqueue(it.tenantId, it.kind, it.payload, it)) !== null) n++;
    return n;
  }

  async claimDue(workerId: string, limit: number, leaseMs: number, kinds?: string[]): Promise<Job[]> {
    const t = this.now();
    const due = [...this.rows.values()]
      .filter((r) => (r.status === "queued" && r.runAt.getTime() <= t) || (r.status === "running" && r.lockedUntil < t))
      .filter((r) => !kinds || kinds.includes(r.kind))
      .sort((a, b) => a.runAt.getTime() - b.runAt.getTime())
      .slice(0, limit);
    for (const r of due) {
      r.status = "running";
      r.lockedBy = workerId;
      r.lockedUntil = t + leaseMs;
      r.attempts += 1;
    }
    return due.map(({ status: _s, lockedBy: _l, lockedUntil: _u, ...j }) => ({ ...j, payload: structuredClone(j.payload) }));
  }

  private owned(jobId: string, workerId: string) {
    const r = this.rows.get(jobId);
    return r && r.status === "running" && r.lockedBy === workerId ? r : null;
  }

  async complete(jobId: string, workerId: string) {
    const r = this.owned(jobId, workerId);
    if (!r) return false;
    r.status = "done";
    r.lockedBy = null;
    return true;
  }

  async reschedule<P>(jobId: string, workerId: string, delayMs: number, payload: P, lastError: string) {
    const r = this.owned(jobId, workerId);
    if (!r) return false;
    Object.assign(r, { status: "queued", lockedBy: null, lockedUntil: 0, runAt: new Date(this.now() + delayMs), payload: structuredClone(payload), lastError });
    return true;
  }

  async fail(jobId: string, workerId: string, lastError: string) {
    const r = this.owned(jobId, workerId);
    if (!r) return false;
    Object.assign(r, { status: "failed", lockedBy: null, lastError });
    return true;
  }
}
