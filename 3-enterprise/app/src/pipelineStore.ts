/**
 * Pipeline anlegen (Dashboard: „Kalender verbinden“) – race-frei gegen gleichzeitiges Offboarding.
 *
 * Ablauf in EINER Transaktion (Read Committed) nach dem Sperrprotokoll aus scim/src/prismaStore.ts:
 *   1. lockUserForWrite()             pg_advisory_xact_lock(tenant, user) – dieselbe Sperre wie SCIM-Deaktivierung
 *   2. User lesen                     erst NACH der Sperre → frischer Snapshot: aktiv und nicht gelöscht?
 *   3. Idempotency-Key prüfen         gleicher Key + gleiche Nutzlast → vorhandene Pipeline zurück;
 *                                     gleicher Key + andere Nutzlast → idempotency_conflict (422)
 *   4. Limit prüfen                   max. aktive (nicht revoked) Pipelines je User – exakt, weil serialisiert
 *   5. Pipeline anlegen (pending)     + Job "pipeline.handshake" in job_queue – derselbe Commit (Outbox)
 *
 * Weil SCIM-Deaktivierung und -Löschung dieselbe Sperre zuerst nehmen, gibt es nur zwei Reihenfolgen:
 *   Deaktivierung zuerst → Schritt 2 sieht active = false → 404, keine Pipeline
 *   Anlage zuerst        → Deaktivierung sieht die neue Pipeline und setzt sie auf revoked
 * Ein gesperrter User kann so nie eine aktive Pipeline behalten (im pgbench-Test geprüft).
 */
import { randomUUID } from "node:crypto";
import { lockUserForWrite, withTxRetry, type PipelineRow, type PrismaLike } from "../../scim/src/prismaStore.js";

export type PipelineMode = "busy" | "full";

export interface CreatePipelineInput {
  tenantId: string;
  /** Entra-Objekt-ID aus dem geprüften Token (scim_users.external_id) */
  entraObjectId: string;
  mode: PipelineMode;
  busyLabel: string | null;
  idempotencyKey: string;
}

export type CreatePipelineResult =
  | { kind: "created" | "replayed"; pipeline: { id: string; status: string; mode: PipelineMode; busyLabel: string | null } }
  | { kind: "user_not_provisioned" }
  | { kind: "idempotency_conflict" }
  | { kind: "limit_reached"; limit: number };

export interface PipelineStore {
  createPipeline(input: CreatePipelineInput): Promise<CreatePipelineResult>;
}

const toDto = (p: PipelineRow) => ({ id: p.id, status: p.status, mode: (p.mode === "full" ? "full" : "busy") as PipelineMode, busyLabel: p.busyLabel });

export class PrismaPipelineStore implements PipelineStore {
  constructor(
    private readonly db: PrismaLike,
    private readonly maxActivePipelines = 5,
    private readonly newId: () => string = randomUUID,
  ) {}

  async createPipeline(i: CreatePipelineInput): Promise<CreatePipelineResult> {
    // User-ID vorab ohne Sperre auflösen (nur für den Sperrschlüssel); maßgeblich ist die Prüfung NACH der Sperre
    const pre = await this.db.scimUser.findFirst({
      where: { tenantId: i.tenantId, externalId: i.entraObjectId, deletionRequestedAt: null },
      select: { id: true },
    });
    if (!pre) return { kind: "user_not_provisioned" };
    const userId = pre.id;

    return withTxRetry(this.db, async (tx) => {
      await lockUserForWrite(tx, i.tenantId, userId);

      const user = await tx.scimUser.findFirst({
        where: { tenantId: i.tenantId, id: userId, active: true, deletionRequestedAt: null },
        select: { id: true, createdAt: true },
      });
      if (!user) return { kind: "user_not_provisioned" } as const;

      const existing = await tx.pipeline.findFirst({
        where: { tenantId: i.tenantId, ownerUserId: userId, idempotencyKey: i.idempotencyKey },
      });
      if (existing) {
        // Gleicher Key mit anderer Nutzlast ist ein Client-Fehler – nie still die alte Pipeline zurückgeben
        const same = existing.mode === i.mode && (existing.busyLabel ?? null) === i.busyLabel;
        return same ? ({ kind: "replayed", pipeline: toDto(existing) } as const) : ({ kind: "idempotency_conflict" } as const);
      }

      const active = await tx.pipeline.count({ where: { tenantId: i.tenantId, ownerUserId: userId, status: { not: "revoked" } } });
      if (active >= this.maxActivePipelines) return { kind: "limit_reached", limit: this.maxActivePipelines } as const;

      const created = await tx.pipeline.create({
        data: {
          id: this.newId(),
          tenantId: i.tenantId,
          ownerUserId: userId,
          status: "pending",
          mode: i.mode,
          busyLabel: i.busyLabel,
          idempotencyKey: i.idempotencyKey,
        },
      });

      // Handshake-Job im selben Commit; grantedAt = Provisionierung (Anker für das 403-Propagationsfenster)
      const payload = JSON.stringify({
        pipelineId: created.id,
        userId,
        grantedAt: user.createdAt instanceof Date ? user.createdAt.toISOString() : null,
        attempts: {},
      });
      await tx.$executeRaw`
        INSERT INTO job_queue (tenant_id, kind, dedupe_key, payload, run_at)
        VALUES (${i.tenantId}, ${"pipeline.handshake"}, ${`handshake:${created.id}`}, ${payload}::jsonb, now())
        ON CONFLICT (kind, dedupe_key) WHERE status = 'queued' DO NOTHING`;

      return { kind: "created", pipeline: toDto(created) } as const;
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// Eingabeprüfung für POST /api/v1/me/pipelines (strikt: unbekannte Felder → Fehler)
// ---------------------------------------------------------------------------------------------------
const IDEMPOTENCY_KEY = /^[A-Za-z0-9_-]{16,64}$/;
// eslint-disable-next-line no-control-regex -- Steuerzeichen und Bidi-Overrides gezielt ausschließen
const LABEL_FORBIDDEN = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩<>]/;

export type BodyCheck = { ok: true; mode: PipelineMode; busyLabel: string | null } | { ok: false; error: string };

export function parseIdempotencyKey(v: string | string[] | undefined): string | null {
  return typeof v === "string" && IDEMPOTENCY_KEY.test(v) ? v : null;
}

export function parseCreatePipelineBody(body: unknown): BodyCheck {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return { ok: false, error: "body_must_be_object" };
  const keys = Object.keys(body);
  for (const k of keys) if (k !== "mode" && k !== "busyLabel") return { ok: false, error: `unknown_field:${k.slice(0, 32)}` };
  const o = body as { mode?: unknown; busyLabel?: unknown };
  if (o.mode !== "busy" && o.mode !== "full") return { ok: false, error: "mode_must_be_busy_or_full" };
  let busyLabel: string | null = null;
  if (o.busyLabel !== undefined && o.busyLabel !== null) {
    if (typeof o.busyLabel !== "string") return { ok: false, error: "busyLabel_must_be_string" };
    const label = o.busyLabel.normalize("NFC").trim();
    if (label.length < 1 || label.length > 64) return { ok: false, error: "busyLabel_length_1_64" };
    if (LABEL_FORBIDDEN.test(label)) return { ok: false, error: "busyLabel_invalid_characters" };
    busyLabel = label;
  }
  if (o.mode === "full" && busyLabel !== null) return { ok: false, error: "busyLabel_only_for_busy" };
  return { ok: true, mode: o.mode, busyLabel };
}
