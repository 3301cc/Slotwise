/**
 * Sync-Worker (pipeline.delta_sync) gegen einen Fake-Graph (fetch-Fake) und ein In-Memory-Repo.
 * Abgedeckt: Anlage/Änderung/Löschung, frei → löschen, abgesagt, @removed, 410-Reset, Paginierung, deltaLink erst
 * am Ende, Alive-Prüfung mitten im Lauf, Schleifenschutz, Absturz-Duplikate, Mandanten-Token je Ziel,
 * Allowlist im Worker, Buchungsseite, Fehlerklassifikation, Lease – und Kanarienvogel-Tests (keine Inhalte in
 * Repo, Queue, Log und – im busy-Modus – in keinem Request an das Ziel).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import {
  createLogger, eventToBlock, GRAPH_BASE, InMemoryDelayedJobQueue, KmsSignedGraphTokenProvider, mergeBusyIntervals,
  SOURCE_REF_PROPERTY_ID, sourceRef, SYNC_KIND, SyncWorker, transactionIdFor,
  accountSuggestions, parseTargetRequest, recheckStoredTarget, resolveSyncTarget, targetLabel,
  type FetchLike, type GraphEvent, type GraphTokenSource, type MapRow, type SyncAlert, type SyncAllowlist, type SyncContext,
  type SyncRepo, type SyncOptions,
  CLEANUP_KIND, TargetCleanupWorker, TeardownJobWorker, recheckTargetForCleanup,
  type CleanupAlert, type CleanupContext, type CleanupRepo,
} from "../src/index.js";

const HOME = "11111111-2222-3333-4444-555555555555";
const LINKED = "99999999-8888-7777-6666-555555555555";
const ALLOW: SyncAllowlist = {
  homeEntraTenantId: HOME,
  ownDomains: ["acme.example", "acme-alias.example"],
  linkedTenants: [{ entraTenantId: LINKED, label: "Acme Tochter GmbH", domains: ["tochter.example"] }],
  teamCalendars: [{ id: "vertrieb", mailbox: "vertrieb@acme.example", label: "Vertrieb" }],
  bookingEnabled: true,
};
const NOW = new Date("2026-10-01T08:00:00Z");

// ---------------------------------------------------------------------------------------------------
// In-Memory-Repo (gleiche Semantik wie PgSyncRepo)
// ---------------------------------------------------------------------------------------------------
interface PRow {
  tenantId: string; status: string; ownerUserId: string; mode: "busy" | "full"; busyLabel: string | null;
  target: SyncContext["target"]; deltaLink: string | null; deltaStartedAt: Date | null;
  lastSyncedAt: Date | null; lastSyncError: string | null; leaseOwner: string | null; leaseUntil: number; createdAt: Date;
  cleanupRequestedAt: Date | null; cleanupDoneAt: Date | null;
}
interface URow { id: string; externalId: string; userName: string; active: boolean }

class MemRepo implements SyncRepo, CleanupRepo {
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
      createdAt: new Date("2026-01-01T00:00:00Z"), cleanupRequestedAt: null, cleanupDoneAt: null, ...o,
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
      busyLabel: p.busyLabel, target: { ...p.target }, deltaLink: p.deltaLink, deltaStartedAt: p.deltaStartedAt, createdAt: p.createdAt };
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
  async upsertMapping(_t: string, id: string, row: MapRow) { if (this.pipelines.has(id)) this.m(id).set(row.sourceEventId, { ...row }); }
  async deleteMapping(id: string, s: string) { this.m(id).delete(s); }
  async saveSyncState(_t: string, id: string, s: { deltaLink: string | null; deltaStartedAt: Date | null; synced: boolean; errorCode?: string | null }) {
    const p = this.pipelines.get(id)!;
    p.deltaLink = s.deltaLink;
    p.deltaStartedAt = s.deltaStartedAt;
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
interface Req { method: string; url: string; headers: Record<string, string>; body: string | undefined }
type Injected = { match: (r: Req) => boolean; status: number; body?: unknown; times?: number; retryAfter?: string };

class FakeGraph {
  requests: Req[] = [];
  /** Seiten der nächsten Delta-Runde (Initial- oder deltaLink-Aufruf) */
  rounds: GraphEvent[][][] = [];
  roundNo = 0;
  targets = new Map<string, Map<string, Record<string, unknown>>>(); // mailbox → id → body
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

const tokens = (): GraphTokenSource & { calls: Array<string | null>; invalidated: Array<string | null> } => {
  const calls: Array<string | null> = [];
  const invalidated: Array<string | null> = [];
  return {
    calls, invalidated,
    getGraphToken: async (_t, entra) => { calls.push(entra); return `tok-${entra ?? "home"}`; },
    invalidateGraphToken: (_t, entra) => { invalidated.push(entra); },
  };
};

function setup(o: { pipeline?: Partial<PRow>; options?: Partial<SyncOptions>; log?: (e: Record<string, unknown>) => void } = {}) {
  const repo = new MemRepo();
  repo.users.set("u1", { id: "u1", externalId: "oid-1", userName: "Max.Muster@acme.example", active: true });
  repo.addPipeline("p1", o.pipeline);
  const graph = new FakeGraph();
  const queue = new InMemoryDelayedJobQueue(() => NOW.getTime(), () => 0.5);
  const tok = tokens();
  const alerts: SyncAlert[] = [];
  const worker = new SyncWorker({
    queue, repo, tokens: tok, fetchFn: graph.fetch, allowlist: ALLOW, workerId: "w1",
    alert: (a) => { alerts.push(a); }, log: o.log, now: () => NOW, random: () => 0.5, options: o.options,
  });
  const enqueue = (full = false, pipelineId = "p1") => queue.enqueue("acme", SYNC_KIND, { pipelineId, full }, { dedupeKey: `delta:${pipelineId}` });
  const runOnce = async (full = false) => {
    await enqueue(full);
    return worker.tick(10);
  };
  return { repo, graph, queue, tok, alerts, worker, enqueue, runOnce };
}

const ev = (id: string, o: Partial<GraphEvent> & { at?: string; until?: string } = {}): GraphEvent => {
  const { at = "2026-10-02T09:00:00.0000000", until = "2026-10-02T10:00:00.0000000", ...rest } = o;
  return { id, showAs: "busy", isAllDay: false, changeKey: `ck-${id}-1`, subject: "Geheim", start: { dateTime: at, timeZone: "UTC" },
    end: { dateTime: until, timeZone: "UTC" }, ...rest };
};
const TEAMBOX = "vertrieb@acme.example";

// ---------------------------------------------------------------------------------------------------
// Allowlist (rein funktional) – gemeinsam für API und Worker
// ---------------------------------------------------------------------------------------------------
test("Allowlist: account nur Same-Person in verknüpftem Mandanten bzw. eigener Alias-Domain, team/booking nur aus Config", () => {
  const owner = "Max.Muster@acme.example";
  const acc = (mailbox: string, entraTenantId: string | null = null) => resolveSyncTarget(ALLOW, owner, { kind: "account", mailbox, entraTenantId });
  assert.deepEqual(acc("max.muster@tochter.example", LINKED), { ok: true, target: { kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: LINKED, ref: null, label: "Acme Tochter GmbH" } });
  assert.deepEqual(acc("eva.chefin@tochter.example", LINKED), { ok: false, reason: "not_same_person" });
  assert.deepEqual(acc("max.muster@evil.example", LINKED), { ok: false, reason: "domain_not_allowed" });
  assert.deepEqual(acc("max.muster@tochter.example", "aaaaaaaa-0000-0000-0000-000000000000"), { ok: false, reason: "tenant_not_linked" });
  assert.deepEqual(acc("max.muster@tochter.example"), { ok: false, reason: "domain_not_allowed" }, "Tochter-Domain ohne Mandant = eigener Mandant");
  assert.deepEqual(acc("max.muster@acme-alias.example"), { ok: true, target: { kind: "account", mailbox: "max.muster@acme-alias.example", entraTenantId: null, ref: null, label: "acme-alias.example" } });
  assert.deepEqual(acc("max.muster@acme-alias.example", HOME), acc("max.muster@acme-alias.example"), "eigener Mandant explizit = ohne");
  assert.deepEqual(acc("max.muster@acme.example"), { ok: false, reason: "target_is_source" });
  assert.deepEqual(acc("ceo@acme-alias.example"), { ok: false, reason: "not_same_person" });
  assert.deepEqual(resolveSyncTarget({ ...ALLOW, ownDomains: [] }, owner, { kind: "account", mailbox: "max.muster@acme-alias.example", entraTenantId: null }), { ok: false, reason: "own_mailboxes_not_configured" });
  assert.deepEqual(resolveSyncTarget(ALLOW, null, { kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: LINKED }), { ok: false, reason: "owner_unknown" });
  assert.deepEqual(resolveSyncTarget(ALLOW, owner, { kind: "team", teamId: "einkauf" }), { ok: false, reason: "team_not_found" });
  assert.equal(resolveSyncTarget(ALLOW, owner, { kind: "team", teamId: "vertrieb" }).ok, true);
  assert.deepEqual(resolveSyncTarget({ ...ALLOW, bookingEnabled: false }, owner, { kind: "booking" }), { ok: false, reason: "booking_disabled" });
  // Worker-Zweitprüfung: geändertes Team-Postfach, fremdes Konto
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { kind: "team", mailbox: "alt@acme.example", entraTenantId: null, ref: "vertrieb" }), { ok: false, reason: "team_mailbox_changed" });
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { kind: "account", mailbox: "eva@tochter.example", entraTenantId: LINKED, ref: null }), { ok: false, reason: "not_same_person" });
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { kind: null, mailbox: null, entraTenantId: null, ref: null }), { ok: false, reason: "target_missing" });
  assert.deepEqual(accountSuggestions(ALLOW, owner), [
    { entraTenantId: null, label: "acme-alias.example", mailbox: "max.muster@acme-alias.example" },
    { entraTenantId: LINKED, label: "Acme Tochter GmbH", mailbox: "max.muster@tochter.example" },
  ]);
  assert.deepEqual(targetLabel(ALLOW, { kind: "team", mailbox: TEAMBOX, entraTenantId: null, ref: "vertrieb" }), { kind: "team", label: "Vertrieb" });
  // Syntax
  assert.deepEqual(parseTargetRequest({ kind: "team", teamId: "vertrieb", mailbox: "x@y.de" }), { ok: false, error: "unknown_field:target.mailbox" });
  assert.deepEqual(parseTargetRequest({ kind: "account", mailbox: "a@b" }), { ok: false, error: "target_mailbox_invalid" });
  assert.deepEqual(parseTargetRequest({ kind: "account", mailbox: '"a b"@b.de' }), { ok: false, error: "target_mailbox_invalid" });
  assert.deepEqual(parseTargetRequest({ kind: "account", mailbox: "a@b.de", entraTenantId: "x" }), { ok: false, error: "target_entra_tenant_id_invalid" });
  assert.deepEqual(parseTargetRequest({ kind: "google" }), { ok: false, error: "target_kind_invalid" });
  assert.deepEqual(parseTargetRequest({ kind: "constructor" }), { ok: false, error: "target_kind_invalid" });
  assert.deepEqual(parseTargetRequest([]), { ok: false, error: "target_invalid" });
});

// ---------------------------------------------------------------------------------------------------
// Abgleich
// ---------------------------------------------------------------------------------------------------
test("Sync: Erstabgleich legt nur belegt/abwesend an (frei/mit Vorbehalt nicht), ganztägig korrekt; zweite Runde ändert/löscht", async () => {
  const s = setup();
  s.graph.rounds.push([[
    ev("A"), ev("B", { showAs: "oof" }), ev("C", { showAs: "free" }), ev("D", { showAs: "tentative" }),
    ev("E", { isAllDay: true, at: "2026-10-05T00:00:00.0000000", until: "2026-10-07T00:00:00.0000000" }),
  ]]);
  const r1 = await s.runOnce(true);
  assert.equal(r1.synced, 1);
  const posts = s.graph.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 3);
  assert.ok(posts.every((p) => p.url === `${GRAPH_BASE}/users/${encodeURIComponent(TEAMBOX)}/events`));
  const allDay = JSON.parse(posts[2].body!);
  assert.deepEqual([allDay.isAllDay, allDay.start, allDay.end], [true, { dateTime: "2026-10-05T00:00:00", timeZone: "UTC" }, { dateTime: "2026-10-07T00:00:00", timeZone: "UTC" }]);
  const p = s.repo.pipelines.get("p1")!;
  assert.match(p.deltaLink ?? "", /deltatoken=t1/);
  assert.equal(p.deltaStartedAt?.toISOString(), NOW.toISOString());
  assert.equal(p.lastSyncError, null);
  assert.equal(s.repo.maps.get("p1")!.size, 3);
  assert.deepEqual(s.repo.maps.get("p1")!.get("E")!.startAt.toISOString(), "2026-10-05T00:00:00.000Z");
  // Delta-Request: Fenster, UTC, ImmutableId, Seitengröße
  const delta = s.graph.requests[0];
  assert.match(delta.url, /\/users\/oid-1\/calendarView\/delta\?startDateTime=2026-09-30T08%3A00%3A00\.000Z&endDateTime=2026-12-30T08%3A00%3A00\.000Z$/);
  assert.match(delta.headers.Prefer ?? "", /outlook\.timezone="UTC"/);
  assert.match(delta.headers.Prefer ?? "", /IdType="ImmutableId"/);
  assert.equal(delta.headers.Authorization, "Bearer tok-home");

  // Runde 2 (deltaLink): A geändert, A2 unverändert, B frei geworden, E abgesagt, F entfernt (unbekannt), G neu
  s.repo.maps.get("p1")!.set("A2", { sourceEventId: "A2", targetEventId: "T-99", changeKey: "ck-A2-1", startAt: new Date("2026-10-02T09:00:00Z"), endAt: new Date("2026-10-02T10:00:00Z") });
  s.graph.rounds.push([[
    ev("A", { changeKey: "ck-A-2", at: "2026-10-02T11:00:00.0000000", until: "2026-10-02T12:30:00.0000000" }),
    ev("A2"),
    ev("B", { showAs: "free", changeKey: "ck-B-2" }),
    ev("E", { isCancelled: true, changeKey: "ck-E-2" }),
    { id: "F", "@removed": { reason: "deleted" } },
    ev("G", { showAs: "oof" }),
  ]]);
  s.graph.requests = [];
  const r2 = await s.runOnce(false);
  assert.equal(r2.synced, 1);
  assert.match(s.graph.requests[0].url, /deltatoken=t1$/, "gespeicherter deltaLink wird benutzt");
  const w = s.graph.writes().map((r) => `${r.method} ${decodeURIComponent(r.url.split("/events")[1] ?? "")}`);
  assert.deepEqual(w, ["PATCH /T-1", "DELETE /T-2", "DELETE /T-3", "POST "]);
  const patched = s.graph.box(TEAMBOX).get("T-1")!;
  assert.deepEqual(patched.start, { dateTime: "2026-10-02T11:00:00", timeZone: "UTC" });
  assert.deepEqual([...s.repo.maps.get("p1")!.keys()].sort(), ["A", "A2", "G"]);
  assert.equal(s.repo.maps.get("p1")!.get("A")!.changeKey, "ck-A-2");
});

test("Sync: busy-Modus schickt nur Zeiten, showAs=busy und busyLabel; full-Modus Betreff + Ort, nie Text/Teilnehmer; privat bleibt busy", () => {
  const e = { ...ev("A", { showAs: "oof", subject: "Vorstand", location: { displayName: "Raum 1" } }), body: { content: "x" }, attendees: [{}] } as GraphEvent;
  const busy = eventToBlock(e, { mode: "busy", busyLabel: "Termin", includeTentative: false })!;
  assert.deepEqual(Object.keys(busy.body).sort(), ["end", "isAllDay", "isReminderOn", "showAs", "start", "subject"]);
  assert.deepEqual([busy.body.subject, busy.body.showAs], ["Termin", "busy"]);
  assert.equal(eventToBlock(e, { mode: "busy", busyLabel: null, includeTentative: false })!.body.subject, "Beschäftigt");
  const full = eventToBlock(e, { mode: "full", busyLabel: null, includeTentative: false })!;
  assert.deepEqual([full.body.subject, full.body.showAs, full.body.location], ["Vorstand", "oof", { displayName: "Raum 1" }]);
  assert.equal("body" in full.body || "attendees" in full.body, false);
  const priv = eventToBlock({ ...e, sensitivity: "private" }, { mode: "full", busyLabel: null, includeTentative: false })!;
  assert.deepEqual([priv.body.subject, priv.body.showAs, "location" in priv.body], ["Beschäftigt", "busy", false]);
  assert.equal(eventToBlock(ev("T", { showAs: "tentative" }), { mode: "busy", busyLabel: null, includeTentative: true })?.body.showAs, "busy");
  assert.equal(eventToBlock(ev("Z", { until: "2026-10-02T09:00:00.0000000" }), { mode: "busy", busyLabel: null, includeTentative: false }), null, "Null-Dauer");
  assert.equal(eventToBlock(ev("Y", { start: { dateTime: "2026-10-02T09:00:00", timeZone: "W. Europe Standard Time" } }), { mode: "busy", busyLabel: null, includeTentative: false }), null, "fremde Zeitzone abgelehnt");
});

test("Sync: Paginierung – deltaLink erst nach der letzten Seite; Fehler auf Seite 2 → Retry ohne Fortschritt, danach keine Duplikate", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B")], [ev("C")]]);
  s.graph.inject.push({ match: (r) => r.url.includes("delta-next") && r.url.includes("p=1"), status: 503, retryAfter: "7" });
  const r1 = await s.runOnce(true);
  assert.equal(r1.rescheduled, 1);
  const p = s.repo.pipelines.get("p1")!;
  assert.equal(p.deltaLink, null, "kein deltaLink nach halbem Seitensatz");
  assert.equal(p.lastSyncError, "transient");
  assert.equal(s.repo.maps.get("p1")!.size, 2, "Seite 1 ist angewandt");
  const job = [...s.queue.rows.values()][0];
  assert.equal(job.status, "queued");
  assert.deepEqual((job.payload as { attempts: unknown }).attempts, { transient: 1 });
  assert.ok(job.runAt.getTime() - NOW.getTime() >= 7_000, "Retry-After wird respektiert");
  assert.equal(job.lastError, "HTTP 503 X");

  // Wiederholung: gleiche Runde (frisches Delta), Seite 1 unverändert → kein zweiter POST
  s.graph.rounds.unshift([[ev("A"), ev("B")], [ev("C")]]);
  job.runAt = NOW;
  const r2 = await s.worker.tick(10);
  assert.equal(r2.synced, 1);
  assert.equal(s.graph.requests.filter((r) => r.method === "POST").length, 3, "A, B einmal + C");
  assert.equal(s.graph.box(TEAMBOX).size, 3);
  assert.match(s.repo.pipelines.get("p1")!.deltaLink ?? "", /deltatoken=t2/);
});

test("Sync: 410 syncStateNotFound → Zustand verwerfen, frisches Delta, nicht mehr vorhandene Zuordnungen löschen bzw. vergessen", async () => {
  const s = setup({ pipeline: { deltaLink: `${GRAPH_BASE}/users/src/calendarView/delta?$deltatoken=alt`, deltaStartedAt: NOW } });
  const rows = s.repo.maps.set("p1", new Map()).get("p1")!;
  s.graph.targets.set(TEAMBOX, new Map([["T-alt", {}], ["T-past", {}]]));
  rows.set("weg", { sourceEventId: "weg", targetEventId: "T-alt", changeKey: "x", startAt: new Date("2026-10-03T09:00:00Z"), endAt: new Date("2026-10-03T10:00:00Z") });
  rows.set("alt", { sourceEventId: "alt", targetEventId: "T-past", changeKey: "x", startAt: new Date("2026-09-01T09:00:00Z"), endAt: new Date("2026-09-01T10:00:00Z") });
  s.graph.inject.push({ match: (r) => r.url.includes("deltatoken=alt"), status: 410, body: { error: { code: "syncStateNotFound" } } });
  s.graph.rounds.push([[ev("A")]]);
  const r = await s.runOnce(false);
  assert.equal(r.synced, 1);
  assert.match(s.graph.requests[1].url, /calendarView\/delta\?startDateTime=/, "zweiter Aufruf ist ein frisches Delta");
  assert.deepEqual([...s.graph.box(TEAMBOX).keys()].sort(), ["T-1", "T-past"], "im Fenster gelöschter Termin weg, vergangener Zieltermin bleibt");
  assert.deepEqual([...rows.keys()], ["A"], "Zuordnung des vergangenen Termins vergessen");
  assert.match(s.repo.pipelines.get("p1")!.deltaLink ?? "", /deltatoken=t1/);

  // Zweites 410 im selben Lauf → kein Endlos-Reset, normale Fehlerbehandlung
  const s2 = setup({ pipeline: { deltaLink: `${GRAPH_BASE}/users/src/calendarView/delta?$deltatoken=alt`, deltaStartedAt: NOW } });
  s2.graph.inject.push({ match: (q) => q.url.includes("calendarView/delta"), status: 410, times: 5 });
  assert.equal((await s2.runOnce(false)).failed, 1);
  assert.equal(s2.repo.pipelines.get("p1")!.status, "error");
});

test("Sync: Fenster älter als 24 h → frisches Delta trotz gespeichertem deltaLink; fremder Link in der DB wird nie aufgerufen", async () => {
  const s = setup({ pipeline: { deltaLink: `${GRAPH_BASE}/users/src/calendarView/delta?$deltatoken=alt`, deltaStartedAt: new Date(NOW.getTime() - 25 * 3_600_000) } });
  s.graph.rounds.push([[ev("A")]]);
  await s.runOnce(false);
  assert.match(s.graph.requests[0].url, /startDateTime=/);
  const s2 = setup({ pipeline: { deltaLink: "https://evil.example/steal?x=1", deltaStartedAt: NOW } });
  s2.graph.rounds.push([[]]);
  await s2.runOnce(false);
  assert.ok(s2.graph.requests.every((r) => r.url.startsWith(GRAPH_BASE)));
});

test("Sync: Alive-Prüfung vor JEDEM Aufruf – Deaktivierung mitten im Lauf stoppt alle weiteren Schreibzugriffe", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B"), ev("C")]]);
  s.graph.onRequest = (r) => {
    if (r.method === "POST") s.repo.users.get("u1")!.active = false; // SCIM-Deaktivierung während des ersten POST
  };
  const r = await s.runOnce(true);
  assert.equal(r.stopped, 1);
  assert.equal(s.graph.requests.filter((q) => q.method === "POST").length, 1, "nur der eine laufende Aufruf");
  assert.equal(s.repo.pipelines.get("p1")!.deltaLink, null);
  assert.equal(s.repo.pipelines.get("p1")!.leaseOwner, null, "Lease freigegeben");
  // Kontext vor jedem Aufruf gelesen: Start + je Aufruf (Delta-GET, POST) + Prüfung vor dem 2. POST
  assert.ok(s.repo.contextReads >= 4);

  for (const [name, mut] of [
    ["revoked", (x: ReturnType<typeof setup>) => { x.repo.pipelines.get("p1")!.status = "revoked"; }],
    ["paused", (x: ReturnType<typeof setup>) => { x.repo.pipelines.get("p1")!.status = "paused"; }],
    ["Inhaber inaktiv", (x: ReturnType<typeof setup>) => { x.repo.users.get("u1")!.active = false; }],
    ["Pipeline weg", (x: ReturnType<typeof setup>) => { x.repo.pipelines.get("p1")!.tenantId = "other"; }],
  ] as const) {
    const x = setup();
    mut(x);
    x.graph.rounds.push([[ev("A")]]);
    const res = await x.runOnce(true);
    assert.equal(res.dropped, 1, name);
    assert.equal(x.graph.requests.length, 0, `${name}: kein einziger Provider-Aufruf`);
    assert.equal(x.tok.calls.length, 0, `${name}: nicht einmal ein Token`);
  }

  // Revoke nach dem Delta-GET, vor dem ersten Schreiben
  const y = setup();
  y.graph.rounds.push([[ev("A")]]);
  y.graph.onRequest = (q) => { if (q.method === "GET") y.repo.pipelines.get("p1")!.status = "revoked"; };
  assert.equal((await y.runOnce(true)).stopped, 1);
  assert.equal(y.graph.writes().length, 0);
});

test("Sync: Schleifenschutz – Zieltermine irgendeiner Pipeline und markierte Termine werden nie übertragen", async () => {
  const s = setup();
  s.repo.addPipeline("p-other", { target: { kind: "account", mailbox: "max.muster@acme-alias.example", entraTenantId: null, ref: null } });
  s.repo.maps.set("p-other", new Map([["Q", { sourceEventId: "Q", targetEventId: "LOOP-1", changeKey: "c", startAt: NOW, endAt: new Date(NOW.getTime() + 3_600_000) }]]));
  s.graph.rounds.push([[ev("LOOP-1"), ev("M", { transactionId: transactionIdFor("x", "y", "z") }), ev("A")]]);
  await s.runOnce(true);
  const posts = s.graph.requests.filter((r) => r.method === "POST");
  assert.equal(posts.length, 1);
  const body = JSON.parse(posts[0].body!);
  assert.equal(body.transactionId, transactionIdFor("p1", "A", "ck-A-1"));
  assert.match(body.transactionId, /^ca1e5c[0-9a-f]{2}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.deepEqual(body.singleValueExtendedProperties, [{ id: SOURCE_REF_PROPERTY_ID, value: sourceRef("p1", "A") }]);
  // eigener Zieltermin taucht in einer späteren Quelle auf (Ziel = Quelle eines anderen Postfachs)
  const own = s.repo.maps.get("p1")!.get("A")!.targetEventId!;
  s.graph.rounds.push([[ev(own)]]);
  await s.runOnce(false);
  assert.equal(s.graph.requests.filter((r) => r.method === "POST").length, 1);
});

test("Sync: Absturz zwischen POST und Speichern → nächster Lauf findet den Termin über die Markierung statt ihn doppelt anzulegen", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A")]]);
  // Absturz simulieren: zweites upsertMapping (nach dem POST) wirft
  const orig = s.repo.upsertMapping.bind(s.repo);
  let n = 0;
  s.repo.upsertMapping = async (t, p, row) => { if (++n === 2) throw new Error("connection terminated"); return orig(t, p, row); };
  assert.equal((await s.runOnce(true)).rescheduled, 1);
  assert.equal(s.repo.maps.get("p1")!.get("A")!.targetEventId, null, "Anlage begonnen, nicht bestätigt");
  assert.equal(s.graph.box(TEAMBOX).size, 1);
  s.repo.upsertMapping = orig;
  s.graph.rounds.push([[ev("A")]]);
  const job = [...s.queue.rows.values()][0];
  job.runAt = NOW;
  assert.equal((await s.worker.tick(10)).synced, 1);
  assert.equal(s.graph.box(TEAMBOX).size, 1, "kein Duplikat");
  const w = s.graph.requests.slice(-2).map((r) => r.method);
  assert.deepEqual(w, ["GET", "PATCH"], "Suche per Extended Property, dann PATCH");
  assert.equal(s.repo.maps.get("p1")!.get("A")!.targetEventId, "T-1");
});

test("Sync: account im verknüpften Mandanten – Lesen mit Heim-Token, Schreiben mit Token des verknüpften Mandanten; 401 erneuert nur dieses", async () => {
  const s = setup({ pipeline: { target: { kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: LINKED, ref: null } } });
  s.graph.rounds.push([[ev("A")]]);
  s.graph.inject.push({ match: (r) => r.method === "POST", status: 401 });
  await s.runOnce(true);
  const byMethod = s.graph.requests.map((r) => `${r.method}:${r.headers.Authorization}`);
  assert.deepEqual(byMethod, ["GET:Bearer tok-home", `POST:Bearer tok-${LINKED}`, `POST:Bearer tok-${LINKED}`]);
  assert.deepEqual(s.tok.invalidated, [LINKED]);
  assert.ok(s.graph.requests[1].url.startsWith(`${GRAPH_BASE}/users/${encodeURIComponent("max.muster@tochter.example")}/events`));
});

test("Token-Cache: verschiedene Entra-Mandanten teilen nie ein Token; aud/URL je Mandant; invalidate trifft nur einen", async () => {
  const urls: string[] = [];
  let n = 0;
  const fetchFn: FetchLike = async (url, init) => {
    urls.push(url);
    const assertion = new URLSearchParams(init.body).get("client_assertion")!;
    const claims = JSON.parse(Buffer.from(assertion.split(".")[1], "base64url").toString()) as { aud: string };
    assert.equal(claims.aud, url, "Assertion für genau diesen Token-Endpunkt");
    const tid = /login\.microsoftonline\.com\/([^/]+)\//.exec(url)![1];
    return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ access_token: `at-${tid}-${++n}`, expires_in: 3600 }) };
  };
  const p = new KmsSignedGraphTokenProvider(async () => ({ entraTenantId: HOME, clientId: "c1", certSha256Hex: "ab".repeat(32) }), async () => Buffer.from("sig"), fetchFn, () => NOW.getTime());
  const home = await p.getToken("acme", "microsoft");
  const linked = await p.getGraphToken("acme", LINKED);
  assert.notEqual(home, linked);
  assert.match(home, new RegExp(`^at-${HOME}-`));
  assert.match(linked, new RegExp(`^at-${LINKED}-`));
  assert.equal(await p.getGraphToken("acme", null), home, "Heim-Token aus dem Cache");
  assert.equal(await p.getGraphToken("acme", LINKED), linked, "Tochter-Token aus dem Cache");
  assert.equal(urls.length, 2);
  p.invalidateGraphToken("acme", LINKED);
  assert.equal(await p.getGraphToken("acme", null), home);
  assert.notEqual(await p.getGraphToken("acme", LINKED), linked);
  assert.equal(urls.length, 3);
  p.invalidate("acme");
  assert.notEqual(await p.getToken("acme", "microsoft"), home);
  await assert.rejects(p.getGraphToken("acme", "../evil"), /GUID/);
});

test("Sync: Worker prüft die Allowlist erneut – unzulässiges Ziel → config_error + Alarm, kein Provider-Aufruf", async () => {
  for (const target of [
    { kind: "account", mailbox: "eva.chefin@tochter.example", entraTenantId: LINKED, ref: null },
    { kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: "aaaaaaaa-0000-0000-0000-000000000000", ref: null },
    { kind: "team", mailbox: "ceo@acme.example", entraTenantId: null, ref: "vertrieb" },
    { kind: "team", mailbox: TEAMBOX, entraTenantId: null, ref: "geloescht" },
  ]) {
    const s = setup({ pipeline: { target } });
    s.graph.rounds.push([[ev("A")]]);
    const r = await s.runOnce(true);
    assert.equal(r.failed, 1, JSON.stringify(target));
    assert.equal(s.graph.requests.length, 0);
    const p = s.repo.pipelines.get("p1")!;
    assert.deepEqual([p.status, p.lastSyncError], ["config_error", "target_not_allowed"]);
    assert.equal(s.alerts[0]?.category, "target_not_allowed");
  }
  // Ziel ändert sich mitten im Lauf (z. B. per DB) → Abbruch vor dem nächsten Aufruf
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B")]]);
  s.graph.onRequest = (r) => { if (r.method === "POST") s.repo.pipelines.get("p1")!.target = { kind: "team", mailbox: "ceo@acme.example", entraTenantId: null, ref: "vertrieb" }; };
  assert.equal((await s.runOnce(true)).stopped, 1);
  assert.equal(s.graph.requests.filter((r) => r.method === "POST").length, 1);

  // Altbestand ohne Ziel
  const legacy = setup({ pipeline: { target: { kind: null, mailbox: null, entraTenantId: null, ref: null } } });
  assert.equal((await legacy.runOnce(true)).dropped, 1);
  assert.deepEqual([legacy.graph.requests.length, legacy.repo.pipelines.get("p1")!.lastSyncError], [0, "target_missing"]);
});

test("Sync: Buchungsseite – nur Lesen der Quelle, Zuordnung mit Zeiten, keine Schreibzugriffe; Busy-Intervalle verschmelzen", async () => {
  const s = setup({ pipeline: { target: { kind: "booking", mailbox: null, entraTenantId: null, ref: null } } });
  s.graph.rounds.push([[ev("A"), ev("B", { at: "2026-10-02T09:30:00.0000000", until: "2026-10-02T11:00:00.0000000" }), ev("C", { showAs: "free" })]]);
  await s.runOnce(true);
  assert.equal(s.graph.writes().length, 0);
  assert.deepEqual([...s.repo.maps.get("p1")!.values()].map((r) => [r.sourceEventId, r.targetEventId]), [["A", null], ["B", null]]);
  s.graph.rounds.push([[ev("A", { showAs: "free", changeKey: "ck-A-2" })]]);
  await s.runOnce(false);
  assert.deepEqual([...s.repo.maps.get("p1")!.keys()], ["B"]);
  assert.equal(s.graph.writes().length, 0);

  const d = (h: number, m = 0) => new Date(Date.UTC(2026, 9, 2, h, m));
  assert.deepEqual(mergeBusyIntervals([
    { start: d(9), end: d(10) }, { start: d(9, 30), end: d(11) }, { start: d(11), end: d(12) }, // überlappend + angrenzend
    { start: d(14), end: d(15) }, { start: d(7), end: d(8, 30) },                                 // getrennt, Beginn vor from
    { start: d(16), end: d(16) },                                                                 // Null-Dauer
  ], d(8), d(14, 30)).map((b) => [b.start.toISOString().slice(11, 16), b.end.toISOString().slice(11, 16)]),
  [["08:00", "08:30"], ["09:00", "12:00"], ["14:00", "14:30"]]);
});

test("Sync: Fehler – 403 nach dem Fenster → blocked_scope + Alarm; Consent fehlt → config_error; 429 → Backoff; 400 für einen Termin → übersprungen", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A")]]);
  s.graph.inject.push({ match: (r) => r.method === "POST", status: 403, body: { error: { code: "ErrorAccessDenied", message: "Access is denied" } } });
  assert.equal((await s.runOnce(true)).failed, 1);
  assert.deepEqual([s.repo.pipelines.get("p1")!.status, s.repo.pipelines.get("p1")!.lastSyncError], ["blocked_scope", "blocked_scope"]);
  assert.equal(s.alerts[0]?.category, "blocked_scope");
  assert.equal([...s.queue.rows.values()][0].status, "failed");

  const c = setup();
  c.graph.rounds.push([[ev("A")]]);
  c.graph.inject.push({ match: (r) => r.method === "GET", status: 403, body: { error: { code: "Authorization_RequestDenied" } } });
  await c.runOnce(true);
  assert.equal(c.repo.pipelines.get("p1")!.status, "config_error");

  // 403 innerhalb von 8 h nach Anlage der Pipeline (neuer RBAC-Scope) → Retry, Pipeline bleibt aktiv
  const fresh = setup({ pipeline: { createdAt: new Date(NOW.getTime() - 3_600_000) } });
  fresh.graph.rounds.push([[ev("A")]]);
  fresh.graph.inject.push({ match: (r) => r.method === "POST", status: 403, body: { error: { code: "ErrorAccessDenied" } } });
  assert.equal((await fresh.runOnce(true)).rescheduled, 1);
  assert.deepEqual([fresh.repo.pipelines.get("p1")!.status, fresh.repo.pipelines.get("p1")!.lastSyncError], ["active", "scope_propagation"]);

  const t = setup();
  t.graph.rounds.push([[ev("A")]]);
  t.graph.inject.push({ match: (r) => r.method === "GET", status: 429, retryAfter: "120" });
  assert.equal((await t.runOnce(true)).rescheduled, 1);
  const job = [...t.queue.rows.values()][0];
  assert.ok(job.runAt.getTime() - NOW.getTime() >= 120_000);
  assert.equal(t.repo.pipelines.get("p1")!.status, "active");

  const b = setup();
  b.graph.rounds.push([[ev("A"), ev("B")]]);
  b.graph.inject.push({ match: (r) => r.method === "POST", status: 400, body: { error: { code: "ErrorInvalidRequest" } } });
  assert.equal((await b.runOnce(true)).synced, 1);
  assert.equal(b.graph.box(TEAMBOX).size, 1);
  assert.equal(b.repo.pipelines.get("p1")!.lastSyncError, "event_rejected");
  assert.ok(b.repo.pipelines.get("p1")!.deltaLink);

  // Netzwerkfehler: nur der Fehlername, nie die Meldung
  const net = setup();
  net.graph.rounds.push([[ev("A")]]);
  net.graph.fetch = async () => { throw new TypeError("fetch failed https://graph.microsoft.com/v1.0/users/oid-1/…"); };
  const w = new SyncWorker({ queue: net.queue, repo: net.repo, tokens: net.tok, fetchFn: (u, i) => net.graph.fetch(u, i), allowlist: ALLOW, workerId: "w1", alert: () => {}, now: () => NOW, random: () => 0.5 });
  await net.enqueue(true);
  assert.equal((await w.tick(10)).rescheduled, 1);
  assert.equal([...net.queue.rows.values()][0].lastError, "HTTP 0");
});

test("Sync: SIGTERM mitten im Lauf → kein weiterer Aufruf, Job sofort wieder eingestellt, Lease frei", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B")]]);
  s.graph.onRequest = (r) => { if (r.method === "POST") s.worker.stop(); };
  assert.equal((await s.runOnce(true)).rescheduled, 1);
  assert.equal(s.graph.requests.filter((r) => r.method === "POST").length, 1);
  const job = [...s.queue.rows.values()][0];
  assert.deepEqual([job.status, job.runAt.getTime() - NOW.getTime(), job.lastError], ["queued", 5_000, "worker_shutdown"]);
  assert.equal(s.repo.pipelines.get("p1")!.leaseOwner, null);
  assert.equal(s.repo.pipelines.get("p1")!.lastSyncError, null, "kein Fehler sichtbar");
});

test("Sync: höchstens ein Lauf je Pipeline – zweiter Job wartet auf die Lease", async () => {
  const s = setup();
  s.repo.pipelines.get("p1")!.leaseOwner = "anderer-job";
  s.repo.pipelines.get("p1")!.leaseUntil = NOW.getTime() + 60_000;
  s.graph.rounds.push([[ev("A")]]);
  assert.equal((await s.runOnce(true)).busy, 1);
  assert.equal(s.graph.requests.length, 0);
  const job = [...s.queue.rows.values()][0];
  assert.deepEqual([job.status, job.runAt.getTime() - NOW.getTime(), (job.payload as { full: boolean }).full], ["queued", 30_000, true]);
});

// ---------------------------------------------------------------------------------------------------
// Kanarienvogel: Termininhalte dürfen nirgends landen
// ---------------------------------------------------------------------------------------------------
for (const mode of ["busy", "full"] as const) {
  test(`Kanarienvogel (${mode}): Betreff/Text/Ort/Teilnehmer nie in Repo, Queue, Log, Alarm; ${mode === "busy" ? "nie im Request an das Ziel" : "Text/Teilnehmer nie im Request"}`, async () => {
    const c = `KANARIE-${randomBytes(6).toString("hex")}`;
    const lines: string[] = [];
    const logger = createLogger({ service: "test", write: (x) => lines.push(x), flushOnExit: false, minLevel: "debug" });
    const log = (e: Record<string, unknown>) => { const { level, msg, ...rest } = e; (level === "warn" ? logger.warn : level === "error" ? logger.error : logger.info)(String(msg), rest); };
    const s = setup({ pipeline: { mode, busyLabel: mode === "busy" ? "Termin" : null }, log });
    const rich = (id: string, o: Partial<GraphEvent> & { at?: string; until?: string } = {}) => ({
      ...ev(id, o), subject: `${c}-subject`, location: { displayName: `${c}-location`, address: { street: `${c}-street` } },
      body: { contentType: "html", content: `<p>${c}-body</p>` }, bodyPreview: `${c}-preview`,
      attendees: [{ emailAddress: { address: `${c}@attendee.example`, name: `${c}-attendee` } }],
      organizer: { emailAddress: { address: `${c}-org@x.example`, name: `${c}-org` } }, onlineMeeting: { joinUrl: `https://x/${c}` },
    } as GraphEvent);
    s.graph.rounds.push([[rich("A"), rich("B", { showAs: "oof" })], [rich("C")]]);
    await s.runOnce(true);
    // zweite Runde: Änderung (PATCH), frei (DELETE), 400 für einen Termin, 503 am Ende → Fehlerpfade mit Graph-Body
    s.graph.rounds.push([[rich("A", { changeKey: "ck-A-2", at: "2026-10-02T09:15:00.0000000" }), rich("B", { showAs: "free", changeKey: "x" }), rich("D")]]);
    s.graph.inject.push({ match: (r) => r.method === "POST", status: 400, body: { error: { code: "ErrorInvalidRequest", message: `${c}-graph-echo` } } });
    await s.runOnce(false);
    s.graph.rounds.push([[rich("E")]]);
    s.graph.inject.push({ match: (r) => r.method === "POST", status: 403, body: { error: { code: "ErrorAccessDenied", message: `${c}-graph-echo` } } });
    await s.runOnce(true);
    logger.flush();

    const writes = s.graph.writes();
    assert.ok(writes.some((w) => w.method === "POST") && writes.some((w) => w.method === "PATCH") && writes.some((w) => w.method === "DELETE"));
    const sent = writes.map((w) => w.body ?? "").join("\n");
    if (mode === "busy") assert.equal(sent.includes(c), false, "busy: kein Inhalt im Request an das Ziel");
    else {
      assert.ok(sent.includes(`${c}-subject`) && sent.includes(`${c}-location`), "full: Betreff + Ort werden übertragen");
      for (const banned of ["-body", "-preview", "@attendee", "-attendee", "-org", "-street", "x/"]) assert.equal(sent.includes(`${c}${banned}`), false, `full: nie ${banned}`);
    }
    const repoDump = JSON.stringify({ p: [...s.repo.pipelines.values()], m: [...s.repo.maps.values()].map((m) => [...m.values()]) });
    const queueDump = JSON.stringify([...s.queue.rows.values()]);
    assert.equal(repoDump.includes(c), false, "Repo");
    assert.equal(queueDump.includes(c), false, "Queue (Payload, last_error)");
    assert.equal(JSON.stringify(s.alerts).includes(c), false, "Alarm");
    assert.ok(lines.length > 0);
    assert.equal(lines.join("").includes(c), false, "Log");
    assert.equal(lines.join("").includes("Geheim"), false);
  });
}

test("sourceRef ist nicht umkehrbar und hängt an Pipeline + Quelltermin", () => {
  assert.equal(sourceRef("p1", "A"), createHash("sha256").update("p1\u0000A").digest("hex").slice(0, 40));
  assert.notEqual(sourceRef("p1", "A"), sourceRef("p2", "A"));
  assert.notEqual(transactionIdFor("p1", "A", "1"), transactionIdFor("p1", "A", "2"));
});

// ---------------------------------------------------------------------------------------------------
// Bereinigung des Zielkalenders nach Widerruf (pipeline.target_cleanup)
// ---------------------------------------------------------------------------------------------------
function withCleanup(s: ReturnType<typeof setup>, allowlist: SyncAllowlist = ALLOW) {
  const alerts: CleanupAlert[] = [];
  const worker = new TargetCleanupWorker({
    queue: s.queue, repo: s.repo, tokens: s.tok, fetchFn: (u, i) => s.graph.fetch(u, i), allowlist, workerId: "w1",
    alert: (a) => { alerts.push(a); }, now: () => NOW, random: () => 0.5,
  });
  const run = async (pipelineId = "p1") => {
    await s.queue.enqueue("acme", CLEANUP_KIND, { pipelineId }, { dedupeKey: `cleanup:${pipelineId}` });
    return worker.tick(10);
  };
  return { worker, alerts, run };
}

test("Bereinigung: Widerruf → jeder von CalenSync angelegte Zieltermin wird gelöscht (auch unbestätigte Anlage), danach nur noch Löschen", async () => {
  const box = "max.muster@tochter.example";
  const s = setup({ pipeline: { target: { kind: "account", mailbox: box, entraTenantId: LINKED, ref: null } } });
  s.graph.rounds.push([[ev("A"), ev("B"), ev("C", { isAllDay: true, at: "2026-10-05T00:00:00.0000000", until: "2026-10-06T00:00:00.0000000" })]]);
  await s.runOnce(true);
  assert.equal(s.graph.box(box).size, 3);
  // unbestätigte Anlage (Absturz nach POST): Termin existiert, Zuordnung ohne target_event_id
  s.graph.box(box).set("T-orphan", { singleValueExtendedProperties: [{ id: SOURCE_REF_PROPERTY_ID, value: sourceRef("p1", "D") }] });
  s.repo.maps.get("p1")!.set("D", { sourceEventId: "D", targetEventId: null, changeKey: null, startAt: NOW, endAt: NOW });
  // eigener Termin des Nutzers im Zielpostfach bleibt unberührt
  s.graph.box(box).set("USER-OWN", { subject: "privat" });

  s.repo.revoke("p1");
  s.repo.users.get("u1")!.active = false; // SCIM-Deaktivierung: Inhaber inaktiv blockiert das LÖSCHEN nicht
  const mark = s.graph.requests.length;
  assert.equal((await s.runOnce(false)).dropped, 1, "ein später eintreffender Sync-Job tut nichts");
  const c = withCleanup(s);
  assert.equal((await c.run()).cleaned, 1);
  assert.deepEqual([...s.graph.box(box).keys()], ["USER-OWN"]);
  const after = s.graph.requests.slice(mark);
  assert.equal(after.filter((q) => q.method === "DELETE").length, 4);
  assert.ok(after.every((q) => q.method === "DELETE" || (q.method === "GET" && q.url.includes("$filter="))), after.map((q) => q.method).join(","));
  assert.ok(after.every((q) => q.headers.Authorization === `Bearer tok-${LINKED}`), "Token des verknüpften Mandanten");
  const p = s.repo.pipelines.get("p1")!;
  assert.ok(p.cleanupDoneAt);
  assert.equal(p.target.mailbox, null, "Zielpostfach nach der Bereinigung genullt");
  assert.equal(s.repo.maps.has("p1"), false);
  const n = s.graph.requests.length;
  assert.equal((await c.run()).dropped, 1, "schon erledigt");
  assert.equal(s.graph.requests.length, n);
});

test("Bereinigung: Buchungsseite → nur Zuordnungen weg, kein Provider-Aufruf; 404 beim Löschen = erledigt", async () => {
  const b = setup({ pipeline: { target: { kind: "booking", mailbox: null, entraTenantId: null, ref: null } } });
  b.graph.rounds.push([[ev("A"), ev("B")]]);
  await b.runOnce(true);
  b.repo.revoke("p1");
  const n = b.graph.requests.length;
  assert.equal((await withCleanup(b).run()).cleaned, 1);
  assert.equal(b.graph.requests.length, n);
  assert.equal(b.repo.maps.has("p1"), false);

  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B")]]);
  await s.runOnce(true);
  s.graph.box(TEAMBOX).delete("T-1"); // im Ziel schon von Hand gelöscht → 404
  s.repo.revoke("p1");
  assert.equal((await withCleanup(s).run()).cleaned, 1);
  assert.equal(s.graph.box(TEAMBOX).size, 0);
  assert.ok(s.repo.pipelines.get("p1")!.cleanupDoneAt);
});

test("Bereinigung: nach SCIM-DELETE (userName geschwärzt) möglich, Allowlist gilt; Fehler → Backoff mit Fortschritt bzw. Alarm, Rest bleibt", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B"), ev("C")]]);
  await s.runOnce(true);
  s.repo.revoke("p1");
  s.repo.users.set("u1", { id: "u1", externalId: "", userName: "deleted-u1", active: false });

  const denied = withCleanup(s, { ...ALLOW, teamCalendars: [] });
  const n = s.graph.requests.length;
  assert.equal((await denied.run()).failed, 1);
  assert.equal(s.graph.requests.length, n, "kein Aufruf auf ein nicht (mehr) freigegebenes Ziel");
  assert.deepEqual([denied.alerts[0]?.kind, denied.alerts[0]?.category], ["target_cleanup_failed", "target_not_allowed"]);
  assert.equal(s.repo.maps.get("p1")!.size, 3);
  assert.equal(s.repo.pipelines.get("p1")!.lastSyncError, "cleanup_target_not_allowed");
  assert.deepEqual(recheckTargetForCleanup(ALLOW, { kind: "account", mailbox: "x@evil.example", entraTenantId: LINKED, ref: null }), { ok: false, reason: "domain_not_allowed" });

  const c = withCleanup(s);
  let deletes = 0;
  s.graph.inject.push({ match: (r) => r.method === "DELETE" && ++deletes === 2, status: 503 });
  assert.equal((await c.run()).rescheduled, 1);
  assert.equal(s.repo.maps.get("p1")!.size, 2, "erster Termin gelöscht, Fortschritt gespeichert");
  assert.equal(s.repo.pipelines.get("p1")!.lastSyncError, "cleanup_transient");
  s.graph.inject.push({ match: (r) => r.method === "DELETE", status: 403, body: { error: { code: "ErrorAccessDenied" } } });
  const job = [...s.queue.rows.values()].find((j) => j.kind === CLEANUP_KIND && j.status === "queued")!;
  job.runAt = NOW;
  assert.equal((await c.worker.tick(10)).failed, 1);
  assert.equal(c.alerts[0]?.category, "blocked_scope");
  const p = s.repo.pipelines.get("p1")!;
  assert.deepEqual([s.repo.maps.get("p1")!.size, p.lastSyncError, p.cleanupDoneAt], [2, "cleanup_failed", null]);
  assert.ok(p.target.mailbox, "Zielpostfach bleibt, solange die Bereinigung offen ist");
});

test("Bereinigung: wartet auf einen laufenden Sync (Lease); aktive oder nicht angeforderte Pipeline wird nie bereinigt", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A")]]);
  await s.runOnce(true);
  assert.equal((await withCleanup(s).run()).dropped, 1, "aktiv, keine Anforderung");
  assert.equal(s.graph.box(TEAMBOX).size, 1);
  s.repo.revoke("p1");
  s.repo.pipelines.get("p1")!.leaseOwner = "sync-job";
  s.repo.pipelines.get("p1")!.leaseUntil = NOW.getTime() + 60_000;
  assert.equal((await withCleanup(s).run()).busy, 1);
  assert.equal(s.graph.box(TEAMBOX).size, 1);
});

test("Purge nach SCIM-DELETE wartet auf offene Bereinigungen; Notbremse nach 8 Tagen löscht trotzdem + Alarm", async () => {
  const mk = (requestedAt: Date, pending: number) => {
    const queue = new InMemoryDelayedJobQueue(() => NOW.getTime(), () => 0.5);
    const purged: string[] = [];
    const alerts: string[] = [];
    const w = new TeardownJobWorker({
      queue, workerId: "w1", now: () => NOW, random: () => 0.5,
      teardown: { terminateForUser: async () => ({ channels: 0, stopped: 0, alreadyGone: 0, retryScheduled: 0, failed: 0, timedOut: false, details: [] }) },
      channels: { listOpenForUser: async () => [] },
      users: { purgeDeletedUser: async (_t, u) => { purged.push(u); return true; } },
      audit: async () => {},
      alert: async (e) => { alerts.push(e.kind); },
      cleanups: { pendingCleanupsForUser: async () => pending },
    });
    const go = async () => {
      await queue.enqueue("acme", "subscription.teardown", { userId: "u1", purgeUser: true, requestedAt: requestedAt.toISOString() });
      return w.tick(10);
    };
    return { queue, purged, alerts, go };
  };
  const waiting = mk(new Date(NOW.getTime() - 24 * 3_600_000), 2);
  assert.equal((await waiting.go()).rescheduled, 1);
  assert.deepEqual(waiting.purged, []);
  assert.match(String([...waiting.queue.rows.values()][0].lastError), /2 Zielkalender-Bereinigung/);
  const done = mk(new Date(NOW.getTime() - 24 * 3_600_000), 0);
  assert.equal((await done.go()).purged, 1);
  const brake = mk(new Date(NOW.getTime() - 9 * 24 * 3_600_000), 1);
  assert.equal((await brake.go()).purged, 1);
  assert.deepEqual([brake.purged, brake.alerts], [["u1"], ["cleanup_deadline"]]);
});
