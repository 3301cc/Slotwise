/**
 * R1 · Option A · Aktivierung von Integrationen je Tenant und Wechsel des EU-Modus.
 *
 * Reihenfolge bei activate(): Plan-Berechtigung (Entitlements) → EU-Modus
 * (Registry) → Persistenz. Bei setEuMode(): Konflikte werden vollständig
 * aufgelistet, damit die UI dem Kunden sagen kann, welche Verbindungen er
 * vorher trennen muss; kein stilles Deaktivieren.
 */
import type { PgLike } from '../booking/pgBookingRepository.js';
import type { Clock } from '../booking/types.js';
import type { Entitlements, TenantPlan } from '../entitlements/entitlements.js';
import type { AdapterMetadata, IntegrationCategory, Tier } from './metadata.js';
import { AdapterRegistry, EU_MODE_MAX_TIER, EuModeViolationError, type EuMode } from './registry.js';

export interface TenantIntegration {
  id: string;
  tenantId: string;
  integrationId: string;
  category: IntegrationCategory;
  status: 'active' | 'disconnected' | 'blocked_by_eu_mode';
  tierAtActivation: Tier;
  euModeAtActivation: EuMode;
  config: Record<string, string>;
  secretRef: string | null;
  activatedAt: Date;
  deactivatedAt: Date | null;
}

export interface TenantPrivacySettings {
  tenantId: string;
  euMode: EuMode;
  controllerName: string;
  controllerAddress: string;
  dpoEmail: string | null;
}

export interface TenantIntegrationRepository {
  listActive(tenantId: string): Promise<TenantIntegration[]>;
  insertActive(row: Omit<TenantIntegration, 'id' | 'activatedAt' | 'deactivatedAt' | 'status'> & { activatedBy: string | null }): Promise<TenantIntegration>;
  deactivate(tenantId: string, integrationId: string, by: string | null, reason: string, at: Date): Promise<TenantIntegration | null>;
  getPrivacySettings(tenantId: string): Promise<TenantPrivacySettings>;
  setEuMode(tenantId: string, mode: EuMode, by: string | null): Promise<TenantPrivacySettings>;
}

export class IntegrationNotAllowedByPlanError extends Error {
  readonly httpStatus = 402;
  constructor(public readonly integrationId: string, public readonly planId: string) {
    super(`Integration "${integrationId}" ist im Plan ${planId} nicht enthalten`);
  }
}

export class IntegrationAlreadyActiveError extends Error {
  readonly httpStatus = 409;
  constructor(public readonly integrationId: string) {
    super(`Integration "${integrationId}" ist bereits verbunden`);
  }
}

export class EuModeConflictError extends Error {
  readonly httpStatus = 409;
  constructor(public readonly targetMode: EuMode, public readonly conflicts: readonly { integrationId: string; vendor: string; tier: Tier }[]) {
    super(`EU-Modus ${targetMode} nicht möglich: ${conflicts.map((c) => `${c.vendor} (Stufe ${c.tier})`).join(', ')} zuerst trennen`);
  }
}

export interface ActivateInput {
  tenantId: string;
  integrationId: string;
  config?: Record<string, string>;
  secretRef?: string | null;
  actorUserId?: string | null;
}

export class TenantIntegrationService {
  constructor(
    private readonly registry: AdapterRegistry,
    private readonly entitlements: Entitlements,
    private readonly repo: TenantIntegrationRepository,
    private readonly loadPlan: (tenantId: string) => Promise<TenantPlan>,
    private readonly clock: Clock = { now: () => new Date() },
  ) {}

  /** Integrationen, die der Tenant im aktuellen Plan und EU-Modus verbinden darf, inklusive Aktivierungsstatus. */
  async catalogFor(tenantId: string): Promise<(AdapterMetadata & { active: boolean; allowedByPlan: boolean; allowedByEuMode: boolean })[]> {
    const [plan, settings, active] = await Promise.all([this.loadPlan(tenantId), this.repo.getPrivacySettings(tenantId), this.repo.listActive(tenantId)]);
    const byPlan = new Set(this.entitlements.integrationsFor({ ...plan, euMode: 'off' }).map((i) => i.id));
    const activeIds = new Set(active.map((a) => a.integrationId));
    return this.registry.all().map((m) => ({
      ...m,
      active: activeIds.has(m.id),
      allowedByPlan: byPlan.has(m.id),
      allowedByEuMode: m.tier <= EU_MODE_MAX_TIER[settings.euMode],
    }));
  }

  async activate(input: ActivateInput): Promise<TenantIntegration> {
    const [plan, settings, active] = await Promise.all([this.loadPlan(input.tenantId), this.repo.getPrivacySettings(input.tenantId), this.repo.listActive(input.tenantId)]);
    const meta = this.registry.metadata(input.integrationId);

    const allowedByPlan = this.entitlements.integrationsFor({ ...plan, euMode: 'off' }).some((i) => i.id === meta.id);
    if (!allowedByPlan) throw new IntegrationNotAllowedByPlanError(meta.id, plan.planId);

    this.registry.assertAllowed({ tenantId: input.tenantId, euMode: settings.euMode }, meta.id);

    if (active.some((a) => a.integrationId === meta.id)) throw new IntegrationAlreadyActiveError(meta.id);

    // Über Make angebundene Dienste setzen eine aktive Make-Verbindung voraus.
    if (meta.kind === 'via-make' && !active.some((a) => a.integrationId === 'make')) {
      throw new Error(`"${meta.vendor}" wird über Make angebunden; bitte zuerst Make verbinden`);
    }

    return this.repo.insertActive({
      tenantId: input.tenantId,
      integrationId: meta.id,
      category: meta.category,
      tierAtActivation: meta.tier,
      euModeAtActivation: settings.euMode,
      config: input.config ?? {},
      secretRef: input.secretRef ?? null,
      activatedBy: input.actorUserId ?? null,
    });
  }

  async deactivate(tenantId: string, integrationId: string, actorUserId: string | null, reason = 'vom Kunden getrennt'): Promise<TenantIntegration | null> {
    const active = await this.repo.listActive(tenantId);
    // Make trennen trennt alle darüber angebundenen Dienste mit – sie funktionieren ohne Make nicht.
    if (integrationId === 'make') {
      for (const a of active) {
        if (a.integrationId !== 'make' && this.registry.metadata(a.integrationId).kind === 'via-make') {
          await this.repo.deactivate(tenantId, a.integrationId, actorUserId, 'Make-Verbindung getrennt', this.clock.now());
        }
      }
    }
    return this.repo.deactivate(tenantId, integrationId, actorUserId, reason, this.clock.now());
  }

  /** Liefert die aktiven Integrationen, die im Zielmodus nicht mehr zulässig wären. */
  async conflictsFor(tenantId: string, targetMode: EuMode): Promise<{ integrationId: string; vendor: string; tier: Tier }[]> {
    const active = await this.repo.listActive(tenantId);
    return active
      .map((a) => this.registry.metadata(a.integrationId))
      .filter((m) => m.tier > EU_MODE_MAX_TIER[targetMode])
      .map((m) => ({ integrationId: m.id, vendor: m.vendor, tier: m.tier }));
  }

  async setEuMode(tenantId: string, mode: EuMode, actorUserId: string | null): Promise<TenantPrivacySettings> {
    const plan = await this.loadPlan(tenantId);
    if (mode === 'strict') this.entitlements.assertFeature(plan, 'euModeStrict');
    const conflicts = await this.conflictsFor(tenantId, mode);
    if (conflicts.length > 0) throw new EuModeConflictError(mode, conflicts);
    return this.repo.setEuMode(tenantId, mode, actorUserId);
  }

  /** Für Aufrufer, die einen Adapter brauchen: EU-Kontext des Tenants. */
  async euContext(tenantId: string): Promise<{ tenantId: string; euMode: EuMode }> {
    const s = await this.repo.getPrivacySettings(tenantId);
    return { tenantId, euMode: s.euMode };
  }
}

// ---------------------------------------------------------------------------
// PostgreSQL-Implementierung
// ---------------------------------------------------------------------------

const COLS = `id, tenant_id, integration_id, category, status, tier_at_activation, eu_mode_at_activation, config, secret_ref, activated_at, deactivated_at`;

function rowToIntegration(r: Record<string, unknown>): TenantIntegration {
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    integrationId: r.integration_id as string,
    category: r.category as IntegrationCategory,
    status: r.status as TenantIntegration['status'],
    tierAtActivation: Number(r.tier_at_activation) as Tier,
    euModeAtActivation: r.eu_mode_at_activation as EuMode,
    config: (r.config as Record<string, string>) ?? {},
    secretRef: (r.secret_ref as string | null) ?? null,
    activatedAt: new Date(r.activated_at as string),
    deactivatedAt: r.deactivated_at ? new Date(r.deactivated_at as string) : null,
  };
}

export class PgTenantIntegrationRepository implements TenantIntegrationRepository {
  constructor(private readonly db: PgLike) {}

  async listActive(tenantId: string): Promise<TenantIntegration[]> {
    const { rows } = await this.db.query(`SELECT ${COLS} FROM tenant_integrations WHERE tenant_id = $1 AND status = 'active' ORDER BY activated_at`, [tenantId]);
    return rows.map(rowToIntegration);
  }

  async insertActive(row: Omit<TenantIntegration, 'id' | 'activatedAt' | 'deactivatedAt' | 'status'> & { activatedBy: string | null }): Promise<TenantIntegration> {
    try {
      const { rows } = await this.db.query(
        `INSERT INTO tenant_integrations (tenant_id, integration_id, category, status, tier_at_activation, eu_mode_at_activation, config, secret_ref, activated_by)
         VALUES ($1, $2, $3, 'active', $4, $5, $6::jsonb, $7, $8) RETURNING ${COLS}`,
        [row.tenantId, row.integrationId, row.category, row.tierAtActivation, row.euModeAtActivation, JSON.stringify(row.config), row.secretRef, row.activatedBy],
      );
      return rowToIntegration(rows[0]);
    } catch (err) {
      const code = typeof err === 'object' && err ? (err as { code?: string }).code : undefined;
      if (code === '23505') throw new IntegrationAlreadyActiveError(row.integrationId);
      if (code === '23514') throw new EuModeViolationError(row.integrationId, row.tierAtActivation, row.euModeAtActivation);
      throw err;
    }
  }

  async deactivate(tenantId: string, integrationId: string, by: string | null, reason: string, at: Date): Promise<TenantIntegration | null> {
    const { rows } = await this.db.query(
      `UPDATE tenant_integrations SET status = 'disconnected', deactivated_at = $4, deactivated_by = $3, deactivation_reason = $5
        WHERE tenant_id = $1 AND integration_id = $2 AND status = 'active' RETURNING ${COLS}`,
      [tenantId, integrationId, by, at, reason],
    );
    return rows[0] ? rowToIntegration(rows[0]) : null;
  }

  async getPrivacySettings(tenantId: string): Promise<TenantPrivacySettings> {
    const { rows } = await this.db.query(`SELECT tenant_id, eu_mode, controller_name, controller_address, dpo_email FROM tenant_privacy_settings WHERE tenant_id = $1`, [tenantId]);
    const r = rows[0];
    if (!r) return { tenantId, euMode: 'balanced', controllerName: '', controllerAddress: '', dpoEmail: null };
    return { tenantId, euMode: r.eu_mode as EuMode, controllerName: String(r.controller_name ?? ''), controllerAddress: String(r.controller_address ?? ''), dpoEmail: (r.dpo_email as string | null) ?? null };
  }

  async setEuMode(tenantId: string, mode: EuMode, by: string | null): Promise<TenantPrivacySettings> {
    await this.db.query(
      `INSERT INTO tenant_privacy_settings (tenant_id, eu_mode, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id) DO UPDATE SET eu_mode = EXCLUDED.eu_mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, mode, by],
    );
    return this.getPrivacySettings(tenantId);
  }
}

/** In-Memory-Variante für Tests und lokale Entwicklung. */
export class MemoryTenantIntegrationRepository implements TenantIntegrationRepository {
  readonly rows: TenantIntegration[] = [];
  readonly settings = new Map<string, TenantPrivacySettings>();
  private seq = 0;

  async listActive(tenantId: string): Promise<TenantIntegration[]> {
    return this.rows.filter((r) => r.tenantId === tenantId && r.status === 'active');
  }

  async insertActive(row: Omit<TenantIntegration, 'id' | 'activatedAt' | 'deactivatedAt' | 'status'> & { activatedBy: string | null }): Promise<TenantIntegration> {
    if (this.rows.some((r) => r.tenantId === row.tenantId && r.integrationId === row.integrationId && r.status === 'active')) throw new IntegrationAlreadyActiveError(row.integrationId);
    const rec: TenantIntegration = { ...row, id: `ti_${++this.seq}`, status: 'active', activatedAt: new Date(), deactivatedAt: null };
    this.rows.push(rec);
    return rec;
  }

  async deactivate(tenantId: string, integrationId: string, _by: string | null, _reason: string, at: Date): Promise<TenantIntegration | null> {
    const r = this.rows.find((x) => x.tenantId === tenantId && x.integrationId === integrationId && x.status === 'active');
    if (!r) return null;
    r.status = 'disconnected';
    r.deactivatedAt = at;
    return r;
  }

  async getPrivacySettings(tenantId: string): Promise<TenantPrivacySettings> {
    return this.settings.get(tenantId) ?? { tenantId, euMode: 'balanced', controllerName: '', controllerAddress: '', dpoEmail: null };
  }

  async setEuMode(tenantId: string, mode: EuMode): Promise<TenantPrivacySettings> {
    const s = { ...(await this.getPrivacySettings(tenantId)), euMode: mode };
    this.settings.set(tenantId, s);
    return s;
  }
}
