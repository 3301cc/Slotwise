/**
 * Gemeinsame Test-Fakes für den Kalenderabgleich: In-Memory-SyncRepo (Semantik wie PgSyncRepo) und ein
 * Fake-Graph (Quell-Delta in Runden + Zielpostfächer). Benutzt von syncWorker.test.ts und googleTarget.test.ts.
 */
import type { CleanupContext, CleanupRepo, FetchLike, GraphEvent, GraphTokenSource, MapRow, SyncContext, SyncRepo } from "../src/index.js";
import { GRAPH_BASE } from "../src/index.js";

export const NOW = new Date("2026-10-01T08:00:00Z");

// ---------------------------------------------------------------------------------------------------
// In-Memory-Repo (gleiche Semantik wie PgSyncRepo)
// ---------------------------------------------------------------------------------------------------
export interface PRow {
  tenantId: string; status: string; ownerUserId: string; mode: "busy" | "full"; busyLabel: string | null;
  target: SyncContext["target"]; deltaLink: string | null; deltaStartedAt: Date | null;
  lastSyncedAt: Date | null; lastSyncError: string | null; leaseOwner: string | null; leaseUntil: number; createdAt: Date;
  cleanupRequestedAt: Date | null; cleanupDoneAt: Date | null;
  identityVerifiedAt: Date | null; identityAttribute: string | null; effectiveMode: "busy" | "full" | null;
}
export interface URow { id: string; externalId: string; userName: string; active: boolean }

export class MemRepo implements SyncRepo, CleanupRepo {
  pipelines = new Map<string, PRow>();
  users = new Map<string, URow>();
  maps = new Map<string, Map<string, MapRow>>();
  contextReads = 0;
  constructor(private readonly now: () => number = () => NOW.getTime()) {}

  addPipeline(id: string, o: Partial<PRow> = {}) {
    this.pipelines.set(id, {
      tenantId: "acme", status: "active", ownerUserId: "u1", mode: "busy", busyLabel: "Termin",
      target: { kind: "team", mailbox: "vertrieb@acme.example", entraTenantId: null, ref: "vertrieb" },
      deltaLink: null, deltaStartedAt: null, lastSyncedAt: null, lastSyncError: null, leaseOwner: null, leaseUntil: 0,
      createdAt: new Date("2026-01-01T00:00:00Z"), cleanupRequestedAt: null, cleanupDoneAt: null,
      identityVerifiedAt: null, identityAttribute: null, effectiveMode: null, ...o,
    });
  }
  /** wie revokeInTx / endPipeline */
  revoke(id: string) {
    const p = this.pipelines.get(id)!;
    p.status = "revoked";
    p.cleanupRequestedAt = new Date(this.now());
  }
  async getCleanupContext(tenantId: string, id: string): Promise<CleanupContext | null> {
    const p = this.pipelines.get(id);
    if (!p || p.tenantId !== tenantId) return null;
    return { status: p.status, target: { ...p.target }, cleanupRequestedAt: p.cleanupRequestedAt, cleanupDoneAt: p.cleanupDoneAt };
  }
  async completeCleanup(_t: string, id: string) {
    const p = this.pipelines.get(id)!;
    if (!p.cleanupRequestedAt || p.cleanupDoneAt) return;
    p.cleanupDoneAt = new Date(this.now());
    p.target = { ...p.target, mailbox: null };
    p.deltaLink = null;
    this.maps.delete(id);
  }
  async getSyncContext(tenantId: string, pipelineId: string): Promise<SyncContext | null> {
    this.contextReads++;
    const p = this.pipelines.get(pipelineId);
    if (!p || p.tenantId !== tenantId) return null;
    const u = this.users.get(p.ownerUserId);
    if (!u) return null;
    return { status: p.status, ownerActive: u.active, ownerEntraObjectId: u.externalId, ownerUserName: u.userName, mode: p.mode,
      busyLabel: p.busyLabel, target: { ...p.target }, deltaLink: p.deltaLink, deltaStartedAt: p.deltaStartedAt, createdAt: p.createdAt,
      identityVerifiedAt: p.identityVerifiedAt, identityAttribute: p.identityAttribute, effectiveMode: p.effectiveMode };
  }
  async acquireSyncLease(_t: string, id: string, owner: string, ms: number) {
    const p = this.pipelines.get(id)!;
    if (p.leaseOwner && p.leaseOwner !== owner && p.leaseUntil > this.now()) return false;
    p.leaseOwner = owner;
    p.leaseUntil = this.now() + ms;
    return true;
  }
  async releaseSyncLease(_t: string, id: string, owner: string) {
    const p = this.pipelines.get(id)!;
    if (p.leaseOwner === owner) { p.leaseOwner = null; p.leaseUntil = 0; }
  }
  private m(id: string) {
    if (!this.maps.has(id)) this.maps.set(id, new Map());
    return this.maps.get(id)!;
  }
  async getMappings(id: string, ids: readonly string[]) {
    const out = new Map<string, MapRow>();
    for (const s of ids) { const r = this.m(id).get(s); if (r) out.set(s, { ...r }); }
    return out;
  }
  async listMappings(id: string) { return [...this.m(id).values()].map((r) => ({ ...r })); }
  async findCalensyncTargetIds(tenantId: string, ids: readonly string[]) {
    const out = new Set<string>();
    for (const [pid, rows] of this.maps) {
      if (this.pipelines.get(pid)?.tenantId !== tenantId) continue;
      for (const r of rows.values()) if (r.targetEventId && ids.includes(r.targetEventId)) out.add(r.targetEventId);
    }
    return out;
  }
  async upsertMapping(_t: string, id: string, row: MapRow) { if (this.pipelines.has(id)) this.m(id).set(row.sourceEventId, { ...row, archived: false }); }
  async deleteMapping(id: string, s: string) { this.m(id).delete(s); }
  async archiveMapping(id: string, s: string) { const r = this.m(id).get(s); if (r) r.archived = true; }
  async markIdentityVerified(_t: string, id: string, attribute: string) {
    const p = this.pipelines.get(id)!;
    p.identityVerifiedAt = new Date(this.now());
    p.identityAttribute = attribute;
  }
  async saveSyncState(_t: string, id: string, s: { deltaLink: string | null; deltaStartedAt: Date | null; synced: boolean; errorCode?: string | null; effectiveMode?: "busy" | "full" }) {
    const p = this.pipelines.get(id)!;
    p.deltaLink = s.deltaLink;
    p.deltaStartedAt = s.deltaStartedAt;
    if (s.effectiveMode) p.effectiveMode = s.effectiveMode;
    if (s.synced) { p.lastSyncedAt = new Date(this.now()); p.lastSyncError = s.errorCode ?? null; }
  }
  async setSyncError(_t: string, id: string, code: string | null) { this.pipelines.get(id)!.lastSyncError = code; }
  async setPipelineStatus(_t: string, id: string, status: "blocked_scope" | "config_error" | "error") {
    const p = this.pipelines.get(id)!;
    if (p.status !== "revoked") p.status = status;
  }
}

// ---------------------------------------------------------------------------------------------------
// Fake-Graph: Quell-Delta in Runden + Zielpostfächer
// ---------------------------------------------------------------------------------------------------
export interface Req { method: string; url: string; headers: Record<string, string>; body: string | undefined }
export type Injected = { match: (r: Req) => boolean; status: number; body?: unknown; times?: number; retryAfter?: string };

export class FakeGraph {
  requests: Req[] = [];
  /** Seiten der nächsten Delta-Runde (Initial- oder deltaLink-Aufruf) */
  rounds: GraphEvent[][][] = [];
  roundNo = 0;
  targets = new Map<string, Map<string, Record<string, unknown>>>(); // mailbox → id → body
  /** GET /users/{oid|upn}: Identitätsprüfung (Schlüssel klein) */
  users = new Map<string, Record<string, unknown>>();
  inject: Injected[] = [];
  onRequest?: (r: Req) => void;
  private seq = 0;
  private pages = new Map<string, GraphEvent[][]>();

  fetch: FetchLike = async (url, init) => {
    const r: Req = { method: init.method, url, headers: init.headers, body: init.body };
    this.requests.push(r);
    this.onRequest?.(r);
    const inj = this.inject.find((i) => i.match(r) && (i.times ?? 1) > 0);
    if (inj) {
      inj.times = (inj.times ?? 1) - 1;
      return this.res(inj.status, inj.body ?? { error: { code: "X", message: "injected" } }, inj.retryAfter);
    }
    const u = new URL(url);
    if (!url.startsWith(GRAPH_BASE)) return this.res(500, {});
    // Quelle: Delta
    if (u.pathname.endsWith("/calendarView/delta") || u.pathname.endsWith("/delta-next")) {
      let key = u.searchParams.get("round");
      let page = Number(u.searchParams.get("p") ?? "0");
      if (!key) {
        const pages = this.rounds.shift() ?? [[]];
        key = String(++this.roundNo);
        this.pages.set(key, pages);
        page = 0;
      }
      const pages = this.pages.get(key)!;
      const last = page >= pages.length - 1;
      return this.res(200, {
        value: pages[page] ?? [],
        ...(last ? { "@odata.deltaLink": `${GRAPH_BASE}/users/src/calendarView/delta?$deltatoken=t${key}` }
                 : { "@odata.nextLink": `${GRAPH_BASE}/users/src/delta-next?round=${key}&p=${page + 1}` }),
      });
    }
    const um = /^\/v1\.0\/users\/([^/]+)$/.exec(u.pathname);
    if (um && init.method === "GET") {
      const user = this.users.get(decodeURIComponent(um[1]).toLowerCase());
      return user ? this.res(200, user) : this.res(404, { error: { code: "Request_ResourceNotFound" } });
    }
    // Ziel: /users/{mailbox}/events[/{id}]
    const m = /^\/v1\.0\/users\/([^/]+)\/events(?:\/([^/]+))?$/.exec(u.pathname);
    if (!m) return this.res(404, { error: { code: "ResourceNotFound" } });
    const mailbox = decodeURIComponent(m[1]);
    const id = m[2] ? decodeURIComponent(m[2]) : null;
    if (!this.targets.has(mailbox)) this.targets.set(mailbox, new Map());
    const box = this.targets.get(mailbox)!;
    if (init.method === "POST" && !id) {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      // Graph-Idempotenz über transactionId
      for (const [eid, b] of box) if (b.transactionId === body.transactionId) return this.res(201, { id: eid });
      const nid = `T-${++this.seq}`;
      box.set(nid, body);
      return this.res(201, { id: nid });
    }
    if (init.method === "GET" && !id) {
      const f = u.searchParams.get("$filter") ?? "";
      const ref = /ep\/value eq '([0-9a-f]+)'/.exec(f)?.[1];
      const hit = [...box].find(([, b]) => (b.singleValueExtendedProperties as Array<{ value: string }> | undefined)?.[0]?.value === ref);
      return this.res(200, { value: hit ? [{ id: hit[0] }] : [] });
    }
    if (id && !box.has(id)) return this.res(404, { error: { code: "ErrorItemNotFound" } });
    if (init.method === "PATCH" && id) {
      box.set(id, { ...box.get(id)!, ...(JSON.parse(init.body ?? "{}") as Record<string, unknown>) });
      return this.res(200, { id });
    }
    if (init.method === "DELETE" && id) {
      box.delete(id);
      return this.res(204, null);
    }
    return this.res(405, {});
  };

  private res(status: number, body: unknown, retryAfter?: string) {
    const text = body === null ? "" : JSON.stringify(body);
    return { status, headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter ?? null : null) }, text: async () => text };
  }
  writes() { return this.requests.filter((r) => r.method !== "GET"); }
  box(mailbox: string) { return this.targets.get(mailbox) ?? new Map<string, Record<string, unknown>>(); }
}

export const tokens = (): GraphTokenSource & { calls: Array<string | null>; invalidated: Array<string | null> } => {
  const calls: Array<string | null> = [];
  const invalidated: Array<string | null> = [];
  return {
    calls, invalidated,
    getGraphToken: async (_t, entra) => { calls.push(entra); return `tok-${entra ?? "home"}`; },
    invalidateGraphToken: (_t, entra) => { invalidated.push(entra); },
  };
};


export const ev = (id: string, o: Partial<GraphEvent> & { at?: string; until?: string } = {}): GraphEvent => {
  const { at = "2026-10-02T09:00:00.0000000", until = "2026-10-02T10:00:00.0000000", ...rest } = o;
  return { id, showAs: "busy", isAllDay: false, changeKey: `ck-${id}-1`, subject: "Geheim", start: { dateTime: at, timeZone: "UTC" },
    end: { dateTime: until, timeZone: "UTC" }, ...rest };
};
