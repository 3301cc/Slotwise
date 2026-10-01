/**
 * Google Workspace als Sync-Ziel – gegen gefälschte Google-Endpunkte (STS, IAM signJwt, OAuth, Calendar v3,
 * Directory) und den Fake-Graph als Quelle. Der Token-Provider ist der ECHTE (WorkloadIdentityGoogleTokenProvider,
 * echte SigV4-Signatur), nur fetch und die AWS-Credentials sind gefälscht.
 *
 * Abgedeckt: Token-Kette + Caches (je Subjekt/Scope getrennt), SigV4-Testvektor, Anlage/Änderung/Löschung,
 * idempotente Anlage (409 → PATCH), busy/full-Nutzlast, Kanarienvogel (keine Inhalte in Repo/Queue/Log/Alarm, busy:
 * nicht einmal im Request), Allowlist (Domain, Workspace), dieselbe Person (Directory vs. Graph), Bereinigung inkl.
 * archivierter Zuordnungen, Fehlerklassifikation, Alive-Prüfung vor jedem Google-Aufruf.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import {
  accountSuggestions, classifyGoogleError, CLEANUP_KIND, createLogger, GoogleAuthError, googleEventIdFromRef,
  GOOGLE_CALENDAR_BASE, GOOGLE_DIRECTORY_BASE, GOOGLE_REF_PROPERTY, InMemoryDelayedJobQueue, parseTargetRequest, recheckStoredTarget,
  recheckTargetForCleanup, resolveSyncTarget, SCOPE_CALENDAR_EVENTS, SCOPE_DIRECTORY_USER_READONLY, signAwsRequest, sourceRef, SYNC_KIND,
  SyncWorker, TargetCleanupWorker, targetLabel, toGoogleEvent, WorkloadIdentityGoogleTokenProvider,
  type CleanupAlert, type FetchLike, type GraphEvent, type LinkedGoogleWorkspace, type SyncAlert, type SyncAllowlist,
} from "../src/index.js";
import { ev, FakeGraph, MemRepo, NOW, tokens as graphTokens, type PRow } from "./syncFakes.js";

const HOME = "11111111-2222-3333-4444-555555555555";
const SA = "calensync-dwd@calensync-acme.iam.gserviceaccount.com";
const AUDIENCE = "//iam.googleapis.com/projects/123456789012/locations/global/workloadIdentityPools/calensync-aws/providers/acme-prod";
const ADMIN = "calensync-directory@acme-g.example";
const BOX = "max.muster@acme-g.example";
const WS: LinkedGoogleWorkspace = { id: "acme-google", label: "Acme Google", domains: ["acme-g.example"], serviceAccountEmail: SA,
  identityAttribute: "employeeId", directoryAdminSubject: ADMIN };
const ALLOW: SyncAllowlist = { homeEntraTenantId: HOME, ownDomains: ["acme-alias.example"], linkedTenants: [], teamCalendars: [], bookingEnabled: false, googleWorkspaces: [WS] };
const GTARGET: PRow["target"] = { kind: "account", mailbox: BOX, entraTenantId: null, ref: null, provider: "google", workspaceId: WS.id };
const EVENTS = `${GOOGLE_CALENDAR_BASE}/calendars/primary/events`;
/** Calendar-Aufruf mit Methode m (nicht die Token-Kette, die auch POST benutzt) */
const cal = (m: string) => (r: { method: string; url: string }) => r.method === m && r.url.startsWith(EVENTS);

// ---------------------------------------------------------------------------------------------------
// Fake-Google: STS, IAM signJwt, OAuth (DWD), Calendar v3 (Primärkalender je Subjekt), Directory
// ---------------------------------------------------------------------------------------------------
interface GReq { method: string; url: string; headers: Record<string, string>; body: string | undefined }
type GInjected = { match: (r: GReq) => boolean; status: number; body?: unknown; times?: number; retryAfter?: string };
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString("base64url");

class FakeGoogle {
  requests: GReq[] = [];
  inject: GInjected[] = [];
  onRequest?: (r: GReq) => void;
  /** Dienstkonten, auf denen der WIF-Principal Token Creator ist */
  tokenCreatorOn = new Set([SA]);
  /** DWD: Client des Dienstkontos → freigegebene Scopes (Admin-Konsole des Workspace) */
  dwd = new Map<string, Set<string>>([[SA, new Set([SCOPE_CALENDAR_EVENTS, SCOPE_DIRECTORY_USER_READONLY])]]);
  /** Nutzer der Domain (Directory) */
  users = new Map<string, Record<string, unknown>>();
  admins = new Set([ADMIN]);
  calendars = new Map<string, Map<string, Record<string, unknown>>>();
  federated = new Set<string>();
  access = new Map<string, { sub: string; scope: string; sa: string }>();
  private n = 0;

  fetch: FetchLike = async (url, init) => {
    const r: GReq = { method: init.method, url, headers: init.headers, body: init.body };
    this.requests.push(r);
    this.onRequest?.(r);
    const inj = this.inject.find((i) => i.match(r) && (i.times ?? 1) > 0);
    if (inj) {
      inj.times = (inj.times ?? 1) - 1;
      return this.res(inj.status, inj.body ?? { error: { code: inj.status, message: "injected", errors: [{ reason: "backendError" }] } }, inj.retryAfter);
    }
    if (url === "https://sts.googleapis.com/v1/token") {
      const f = new URLSearchParams(init.body);
      assert.equal(f.get("grant_type"), "urn:ietf:params:oauth:grant-type:token-exchange");
      assert.equal(f.get("subject_token_type"), "urn:ietf:params:aws:token-type:aws4_request");
      if (f.get("audience") !== AUDIENCE) return this.res(400, { error: "invalid_target" });
      const st = JSON.parse(decodeURIComponent(f.get("subject_token") ?? "")) as { url: string; method: string; headers: Array<{ key: string; value: string }> };
      const h = Object.fromEntries(st.headers.map((x) => [x.key, x.value]));
      // Google gibt den signierten Request an AWS weiter: muss GetCallerIdentity sein und an den Provider gebunden
      if (!/^https:\/\/sts\.[a-z0-9-]+\.amazonaws\.com\?Action=GetCallerIdentity&Version=2011-06-15$/.test(st.url) || st.method !== "POST"
          || h["x-goog-cloud-target-resource"] !== AUDIENCE || !/^AWS4-HMAC-SHA256 Credential=AKIDTEST\//.test(h.Authorization ?? "")
          || !/SignedHeaders=host;x-amz-date;x-amz-security-token;x-goog-cloud-target-resource,/.test(h.Authorization ?? "")) return this.res(400, { error: "invalid_grant" });
      const tok = `fed-${++this.n}`;
      this.federated.add(tok);
      return this.res(200, { access_token: tok, issued_token_type: "urn:ietf:params:oauth:token-type:access_token", token_type: "Bearer", expires_in: 3600 });
    }
    const sj = /^https:\/\/iamcredentials\.googleapis\.com\/v1\/projects\/-\/serviceAccounts\/([^/]+):signJwt$/.exec(url);
    if (sj) {
      const sa = decodeURIComponent(sj[1]);
      if (!this.federated.has((init.headers.Authorization ?? "").replace(/^Bearer /, ""))) return this.res(401, { error: { status: "UNAUTHENTICATED" } });
      if (!this.tokenCreatorOn.has(sa)) return this.res(403, { error: { code: 403, status: "PERMISSION_DENIED", message: "iam.serviceAccounts.signJwt" } });
      const payload = JSON.parse((JSON.parse(init.body ?? "{}") as { payload: string }).payload) as Record<string, unknown>;
      return this.res(200, { keyId: "k1", signedJwt: `${b64({ alg: "RS256", typ: "JWT" })}.${b64(payload)}.sig-${Buffer.from(sa).toString("base64url")}` });
    }
    if (url === "https://oauth2.googleapis.com/token") {
      const f = new URLSearchParams(init.body);
      assert.equal(f.get("grant_type"), "urn:ietf:params:oauth:grant-type:jwt-bearer");
      const [, p, sig] = (f.get("assertion") ?? "").split(".");
      const c = JSON.parse(Buffer.from(p, "base64url").toString()) as { iss: string; sub: string; scope: string; aud: string };
      if (sig !== `sig-${Buffer.from(c.iss).toString("base64url")}` || c.aud !== "https://oauth2.googleapis.com/token") return this.res(400, { error: "invalid_grant" });
      if (!this.dwd.get(c.iss)?.has(c.scope)) return this.res(401, { error: "unauthorized_client", error_description: "Client is unauthorized" });
      const u = this.users.get(c.sub);
      if (!u || u.suspended === true) return this.res(400, { error: "invalid_grant", error_description: "Invalid email or User ID" });
      const tok = `ya29.${++this.n}`;
      this.access.set(tok, { sub: c.sub, scope: c.scope, sa: c.iss });
      return this.res(200, { access_token: tok, token_type: "Bearer", expires_in: 3599 });
    }
    const who = this.access.get((init.headers.Authorization ?? "").replace(/^Bearer /, ""));
    if (!who) return this.res(401, { error: { code: 401, status: "UNAUTHENTICATED", errors: [{ reason: "authError" }] } });
    if (url.startsWith(`${GOOGLE_DIRECTORY_BASE}/users/`)) {
      if (who.scope !== SCOPE_DIRECTORY_USER_READONLY || !this.admins.has(who.sub)) return this.res(403, { error: { code: 403, errors: [{ reason: "forbidden" }] } });
      const key = decodeURIComponent(new URL(url).pathname.split("/").pop() ?? "");
      const u = [...this.users.values()].find((x) => x.primaryEmail === key || (x.aliases as string[] | undefined)?.includes(key));
      return u ? this.res(200, { primaryEmail: u.primaryEmail, suspended: u.suspended ?? false, externalIds: u.externalIds }) : this.res(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
    }
    if (!url.startsWith(EVENTS)) return this.res(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
    if (who.scope !== SCOPE_CALENDAR_EVENTS) return this.res(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }] } });
    if (!this.calendars.has(who.sub)) this.calendars.set(who.sub, new Map());
    const cal = this.calendars.get(who.sub)!;
    const u = new URL(url);
    const id = u.pathname.length > new URL(EVENTS).pathname.length ? decodeURIComponent(u.pathname.split("/").pop()!) : null;
    if (init.method === "POST" && !id) {
      const body = JSON.parse(init.body ?? "{}") as Record<string, unknown>;
      if (typeof body.id !== "string" || !/^[a-v0-9]{5,1024}$/.test(body.id)) return this.res(400, { error: { code: 400, errors: [{ reason: "invalid" }] } });
      if (cal.has(body.id)) return this.res(409, { error: { code: 409, errors: [{ reason: "duplicate" }], message: "The requested identifier already exists." } });
      cal.set(body.id, { ...body, status: "confirmed" });
      return this.res(200, cal.get(body.id));
    }
    if (!id) return this.res(405, {});
    const e = cal.get(id);
    if (init.method === "PATCH") {
      if (!e) return this.res(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
      const next = { ...e, ...(JSON.parse(init.body ?? "{}") as Record<string, unknown>) };
      cal.set(id, next);
      return this.res(200, next);
    }
    if (init.method === "DELETE") {
      if (!e) return this.res(404, { error: { code: 404, errors: [{ reason: "notFound" }] } });
      if (e.status === "cancelled") return this.res(410, { error: { code: 410, errors: [{ reason: "deleted" }] } });
      e.status = "cancelled";
      return this.res(204, null);
    }
    return this.res(405, {});
  };

  private res(status: number, body: unknown, retryAfter?: string) {
    const text = body === null ? "" : JSON.stringify(body);
    return { status, headers: { get: (n: string) => (n.toLowerCase() === "retry-after" ? retryAfter ?? null : null) }, text: async () => text };
  }
  live(sub: string) { return [...(this.calendars.get(sub) ?? new Map()).entries()].filter(([, e]) => e.status !== "cancelled"); }
  writes() { return this.requests.filter((r) => r.url.startsWith(EVENTS) && r.method !== "GET"); }
  /** Anfragen an Calendar/Directory (nicht die Token-Kette) */
  api() { return this.requests.filter((r) => r.url.startsWith(GOOGLE_CALENDAR_BASE) || r.url.startsWith(GOOGLE_DIRECTORY_BASE)); }
}

const AWS = { accessKeyId: "AKIDTEST", secretAccessKey: "secret/test+key", sessionToken: "session-token" };

function provider(google: FakeGoogle, clock = { t: NOW.getTime() }, aws = async () => AWS) {
  return new WorkloadIdentityGoogleTokenProvider({ audience: AUDIENCE, region: "eu-central-1", serviceAccounts: [SA], awsCredentials: aws,
    fetchFn: (u, i) => google.fetch(u, i), now: () => clock.t });
}

function setup(o: { pipeline?: Partial<PRow>; allowlist?: SyncAllowlist; log?: (e: Record<string, unknown>) => void; noGoogle?: boolean } = {}) {
  const repo = new MemRepo(() => NOW.getTime());
  repo.users.set("u1", { id: "u1", externalId: "oid-1", userName: "Max.Muster@acme.example", active: true });
  repo.addPipeline("p1", { target: { ...GTARGET }, ...o.pipeline });
  const graph = new FakeGraph();
  graph.users.set("oid-1", { id: "oid-1", employeeId: "E-1" });
  const google = new FakeGoogle();
  google.users.set(BOX, { primaryEmail: BOX, externalIds: [{ type: "organization", value: "E-1" }, { type: "custom", customType: "x", value: "E-9" }] });
  google.users.set(ADMIN, { primaryEmail: ADMIN, externalIds: [] });
  const fetchFn: FetchLike = (u, i) => (u.startsWith("https://graph.microsoft.com/") ? graph.fetch(u, i) : google.fetch(u, i));
  const queue = new InMemoryDelayedJobQueue(() => NOW.getTime(), () => 0.5);
  const gTokens = provider(google);
  const alerts: SyncAlert[] = [];
  const allowlist = o.allowlist ?? ALLOW;
  const worker = new SyncWorker({ queue, repo, tokens: graphTokens(), googleTokens: o.noGoogle ? undefined : gTokens, fetchFn, allowlist,
    workerId: "w1", alert: (a) => { alerts.push(a); }, log: o.log, now: () => NOW, random: () => 0.5 });
  const cleanupAlerts: CleanupAlert[] = [];
  const cleaner = new TargetCleanupWorker({ queue, repo, tokens: graphTokens(), googleTokens: o.noGoogle ? undefined : gTokens, fetchFn, allowlist,
    workerId: "w1", alert: (a) => { cleanupAlerts.push(a); }, now: () => NOW, random: () => 0.5 });
  const runOnce = async (full = false, pipelineId = "p1") => {
    await queue.enqueue("acme", SYNC_KIND, { pipelineId, full }, { dedupeKey: `delta:${pipelineId}` });
    return worker.tick(10);
  };
  const cleanup = async (pipelineId = "p1") => {
    await queue.enqueue("acme", CLEANUP_KIND, { pipelineId }, { dedupeKey: `cleanup:${pipelineId}` });
    return cleaner.tick(10);
  };
  const due = () => { for (const j of queue.rows.values()) j.runAt = NOW; };
  return { repo, graph, google, queue, gTokens, alerts, cleanupAlerts, worker, cleaner, runOnce, cleanup, due };
}

// ---------------------------------------------------------------------------------------------------
// Token-Kette
// ---------------------------------------------------------------------------------------------------
test("SigV4: AWS-Testvektor (IAM ListUsers aus der AWS-Dokumentation)", () => {
  const h = signAwsRequest({
    method: "GET", url: "https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08", region: "us-east-1", service: "iam",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=utf-8" },
    credentials: { accessKeyId: "AKIDEXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY" }, now: new Date("2015-08-30T12:36:00Z"),
  });
  assert.equal(h.authorization, "AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/iam/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7");
});

test("Token-Kette: AWS-signierter GetCallerIdentity → Google STS → signJwt (sub = Postfach, nur Scope) → OAuth; kein Schlüssel, kein Secret im Request", async () => {
  const google = new FakeGoogle();
  google.users.set(BOX, { primaryEmail: BOX });
  const p = provider(google);
  const t = await p.getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS);
  assert.match(t, /^ya29\./);
  assert.deepEqual(google.requests.map((r) => r.url.split("?")[0]), [
    "https://sts.googleapis.com/v1/token",
    `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${encodeURIComponent(SA)}:signJwt`,
    "https://oauth2.googleapis.com/token",
  ]);
  const sts = new URLSearchParams(google.requests[0].body);
  assert.deepEqual([sts.get("audience"), sts.get("scope"), sts.get("requested_token_type")],
    [AUDIENCE, "https://www.googleapis.com/auth/cloud-platform", "urn:ietf:params:oauth:token-type:access_token"]);
  const st = JSON.parse(decodeURIComponent(sts.get("subject_token")!)) as { headers: Array<{ key: string; value: string }> };
  assert.deepEqual(st.headers.map((x) => x.key).sort(), ["Authorization", "host", "x-amz-date", "x-amz-security-token", "x-goog-cloud-target-resource"]);
  // Signatur nachrechnen: derselbe Request mit denselben Credentials und derselben Zeit ergibt dieselbe Signatur
  const hdr = Object.fromEntries(st.headers.map((x) => [x.key, x.value]));
  const again = signAwsRequest({ method: "POST", url: "https://sts.eu-central-1.amazonaws.com?Action=GetCallerIdentity&Version=2011-06-15", region: "eu-central-1",
    service: "sts", headers: { "x-goog-cloud-target-resource": AUDIENCE }, credentials: AWS, now: NOW });
  assert.equal(hdr.Authorization, again.authorization);
  assert.match(hdr.Authorization, /Credential=AKIDTEST\/20261001\/eu-central-1\/sts\/aws4_request/);
  assert.equal(google.requests.map((r) => r.body ?? "").join("").includes(AWS.secretAccessKey), false, "AWS-Secret verlässt den Prozess nie");
  assert.equal(google.requests[1].headers.Authorization, "Bearer fed-1");
  const claims = JSON.parse((JSON.parse(google.requests[1].body!) as { payload: string }).payload) as Record<string, unknown>;
  assert.deepEqual({ ...claims, iat: 0, exp: (claims.exp as number) - (claims.iat as number) },
    { iss: SA, sub: BOX, scope: SCOPE_CALENDAR_EVENTS, aud: "https://oauth2.googleapis.com/token", iat: 0, exp: 3600 });

  // Cache: gleiches (Dienstkonto, Subjekt, Scope) → kein Aufruf
  assert.equal(await p.getDelegatedToken(SA, "MAX.Muster@acme-g.example", SCOPE_CALENDAR_EVENTS), t);
  assert.equal(google.requests.length, 3);
  // gleichzeitige Anfragen teilen sich einen Abruf
  google.users.set("eva@acme-g.example", { primaryEmail: "eva@acme-g.example" });
  const [a, b] = await Promise.all([p.getDelegatedToken(SA, "eva@acme-g.example", SCOPE_CALENDAR_EVENTS), p.getDelegatedToken(SA, "eva@acme-g.example", SCOPE_CALENDAR_EVENTS)]);
  assert.equal(a, b);
  assert.equal(google.requests.length, 5, "föderiertes Token wiederverwendet: nur signJwt + OAuth");
  assert.notEqual(a, t, "anderes Subjekt = anderes Token");

  // Konfigurationsgrenzen ohne jeden Aufruf
  const n = google.requests.length;
  for (const [sa, sub, scope, code] of [
    ["fremd-konto@evil-projekt.iam.gserviceaccount.com", BOX, SCOPE_CALENDAR_EVENTS, "service_account_not_allowed"],
    [SA, BOX, "https://www.googleapis.com/auth/calendar", "scope_not_allowed"],
    [SA, "kein postfach", SCOPE_CALENDAR_EVENTS, "subject_invalid"],
  ] as const) {
    await assert.rejects(p.getDelegatedToken(sa, sub, scope), (e: unknown) => e instanceof GoogleAuthError && e.stage === "config" && e.code === code);
  }
  assert.equal(google.requests.length, n);
});

test("Token-Cache: je (Dienstkonto, Subjekt, Scope) getrennt; invalidate trifft genau einen Eintrag; Ablauf und 401 bei signJwt erneuern", async () => {
  const google = new FakeGoogle();
  for (const u of [BOX, "eva@acme-g.example", ADMIN]) google.users.set(u, { primaryEmail: u });
  const clock = { t: NOW.getTime() };
  const p = provider(google, clock);
  const max = await p.getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS);
  const eva = await p.getDelegatedToken(SA, "eva@acme-g.example", SCOPE_CALENDAR_EVENTS);
  const dir = await p.getDelegatedToken(SA, ADMIN, SCOPE_DIRECTORY_USER_READONLY);
  assert.equal(new Set([max, eva, dir]).size, 3);
  assert.deepEqual([google.access.get(max)!.sub, google.access.get(eva)!.sub, google.access.get(dir)!.scope], [BOX, "eva@acme-g.example", SCOPE_DIRECTORY_USER_READONLY]);
  p.invalidateDelegatedToken(SA, "eva@acme-g.example", SCOPE_CALENDAR_EVENTS);
  assert.equal(await p.getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS), max, "Max unberührt");
  const eva2 = await p.getDelegatedToken(SA, "eva@acme-g.example", SCOPE_CALENDAR_EVENTS);
  assert.notEqual(eva2, eva);
  assert.equal(google.access.get(eva2)!.sub, "eva@acme-g.example");
  // abgelaufen (1 h, 2 min Vorlauf) → neu; föderiertes Token ebenfalls abgelaufen → neuer Tausch
  clock.t += 3_500_000;
  const before = google.requests.filter((r) => r.url.includes("sts.googleapis")).length;
  assert.notEqual(await p.getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS), max);
  assert.equal(google.requests.filter((r) => r.url.includes("sts.googleapis")).length, before + 1);
  // föderiertes Token serverseitig widerrufen → signJwt 401 → genau ein neuer Tausch
  google.federated.clear();
  p.invalidateDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS);
  assert.match(await p.getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS), /^ya29\./);
  // Fehler der Kette: nur Stufe + Code, nie Text oder Token
  const g2 = new FakeGoogle();
  g2.users.set(BOX, { primaryEmail: BOX });
  g2.tokenCreatorOn.clear();
  await assert.rejects(provider(g2).getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS),
    (e: unknown) => e instanceof GoogleAuthError && e.stage === "iam" && e.status === 403 && e.code === "permission_denied" && !e.message.includes("signJwt"));
  const g3 = new FakeGoogle();
  g3.users.set(BOX, { primaryEmail: BOX });
  g3.dwd.clear();
  await assert.rejects(provider(g3).getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS),
    (e: unknown) => e instanceof GoogleAuthError && e.stage === "oauth" && e.status === 401 && e.code === "unauthorized_client");
  await assert.rejects(provider(new FakeGoogle(), undefined, async () => { throw new Error("no creds"); }).getDelegatedToken(SA, BOX, SCOPE_CALENDAR_EVENTS),
    (e: unknown) => e instanceof GoogleAuthError && e.stage === "aws" && e.status === 0);
});

// ---------------------------------------------------------------------------------------------------
// Allowlist, Vorschläge, Anzeige (rein funktional)
// ---------------------------------------------------------------------------------------------------
test("Allowlist Google: nur verknüpfter Workspace + dessen Domains; kein Mischen mit Entra; Vorschläge und Label", () => {
  const owner = "Max.Muster@acme.example";
  const g = (mailbox: string, workspaceId: string | null = WS.id, entraTenantId: string | null = null) =>
    resolveSyncTarget(ALLOW, owner, { kind: "account", provider: "google", workspaceId, mailbox, entraTenantId });
  assert.deepEqual(g(BOX), { ok: true, target: { kind: "account", provider: "google", workspaceId: WS.id, mailbox: BOX, entraTenantId: null, ref: null, label: "Google: Acme Google", identityAttribute: "employeeId" } });
  assert.deepEqual(g("max.muster@acme-alias.example"), { ok: false, reason: "domain_not_allowed" }, "Microsoft-Domain ist kein Google-Ziel");
  assert.deepEqual(g(BOX, "anderer-ws"), { ok: false, reason: "workspace_not_linked" });
  assert.deepEqual(g(BOX, null), { ok: false, reason: "workspace_not_linked" });
  assert.deepEqual(g(BOX, WS.id, HOME), { ok: false, reason: "workspace_not_linked" });
  assert.deepEqual(resolveSyncTarget(ALLOW, owner, { kind: "account", mailbox: BOX, entraTenantId: null }), { ok: false, reason: "domain_not_allowed" }, "ohne provider = Microsoft");
  assert.deepEqual(resolveSyncTarget({ ...ALLOW, googleWorkspaces: undefined }, owner, { kind: "account", provider: "google", workspaceId: WS.id, mailbox: BOX, entraTenantId: null }), { ok: false, reason: "workspace_not_linked" });
  const lp: SyncAllowlist = { ...ALLOW, googleWorkspaces: [{ ...WS, identityAttribute: "localPart" }] };
  assert.deepEqual(resolveSyncTarget(lp, owner, { kind: "account", provider: "google", workspaceId: WS.id, mailbox: "chef@acme-g.example", entraTenantId: null }), { ok: false, reason: "not_same_person" });
  // Worker-Zweitprüfung
  assert.equal(recheckStoredTarget(ALLOW, owner, GTARGET).ok, true);
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { ...GTARGET, workspaceId: "weg" }), { ok: false, reason: "workspace_not_linked" });
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { ...GTARGET, entraTenantId: HOME }), { ok: false, reason: "workspace_not_linked" });
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { ...GTARGET, provider: "yahoo" }), { ok: false, reason: "target_missing" });
  assert.deepEqual(recheckStoredTarget(ALLOW, owner, { ...GTARGET, provider: "microsoft", mailbox: "max.muster@acme-alias.example" }), { ok: false, reason: "target_missing" }, "Microsoft mit Workspace-ID");
  assert.deepEqual(recheckTargetForCleanup(ALLOW, GTARGET), { ok: true });
  assert.deepEqual(recheckTargetForCleanup({ ...ALLOW, googleWorkspaces: [] }, GTARGET), { ok: false, reason: "workspace_not_linked" });
  assert.deepEqual(recheckTargetForCleanup({ ...ALLOW, googleWorkspaces: [{ ...WS, domains: ["andere.example"] }] }, GTARGET), { ok: false, reason: "domain_not_allowed" });
  // Vorschläge + Anzeige
  assert.deepEqual(accountSuggestions(ALLOW, owner), [
    { entraTenantId: null, label: "acme-alias.example", mailbox: "max.muster@acme-alias.example", verified: false },
    { provider: "google", workspaceId: WS.id, label: "Acme Google", mailbox: BOX, verified: false },
  ]);
  assert.deepEqual(targetLabel(ALLOW, GTARGET), { kind: "account", label: "Google: Acme Google", provider: "google" });
  assert.deepEqual(targetLabel({ ...ALLOW, googleWorkspaces: [] }, GTARGET), { kind: "account", label: "Google", provider: "google" });
  // Syntax
  assert.deepEqual(parseTargetRequest({ kind: "account", provider: "google", workspaceId: WS.id, mailbox: "Max.Muster@ACME-G.example" }),
    { ok: true, target: { kind: "account", provider: "google", workspaceId: WS.id, mailbox: BOX, entraTenantId: null } });
  assert.deepEqual(parseTargetRequest({ kind: "account", mailbox: BOX, provider: "microsoft" }), { ok: true, target: { kind: "account", mailbox: BOX, entraTenantId: null } });
  for (const [v, err] of [
    [{ kind: "account", provider: "google", mailbox: BOX }, "target_workspace_id_invalid"],
    [{ kind: "account", provider: "google", workspaceId: "Acme Google", mailbox: BOX }, "target_workspace_id_invalid"],
    [{ kind: "account", provider: "google", workspaceId: WS.id, mailbox: BOX, entraTenantId: HOME }, "target_entra_tenant_id_invalid"],
    [{ kind: "account", provider: "microsoft", workspaceId: WS.id, mailbox: BOX }, "target_workspace_id_invalid"],
    [{ kind: "account", provider: "yahoo", mailbox: BOX }, "target_provider_invalid"],
    [{ kind: "account", provider: "google", workspaceId: WS.id, mailbox: BOX, calendarId: "primary" }, "unknown_field:target.calendarId"],
    [{ kind: "team", teamId: "x", provider: "google" }, "unknown_field:target.provider"],
  ] as const) assert.deepEqual(parseTargetRequest(v), { ok: false, error: err }, JSON.stringify(v));
});

test("Event-ID: base32hex des sourceRef (32 Zeichen [0-9a-v]), deterministisch je Pipeline + Quelltermin", () => {
  const id = googleEventIdFromRef(sourceRef("p1", "A"))!;
  assert.match(id, /^[0-9a-v]{32}$/);
  assert.equal(googleEventIdFromRef(sourceRef("p1", "A")), id);
  assert.notEqual(googleEventIdFromRef(sourceRef("p2", "A")), id);
  assert.equal(googleEventIdFromRef("xyz"), null);
  assert.equal(googleEventIdFromRef("0".repeat(40)), "0".repeat(32));
  assert.equal(googleEventIdFromRef("f".repeat(40)), "v".repeat(32));
});

// ---------------------------------------------------------------------------------------------------
// Abgleich
// ---------------------------------------------------------------------------------------------------
test("Sync Google busy: Prüfung dieselbe Person (Directory als Admin-Subjekt), dann Anlage im Primärkalender des Ziels – nur Zeit, Label, opaque", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A", { location: { displayName: "Raum 1" } }), ev("B", { showAs: "oof" }), ev("C", { showAs: "free" }),
    ev("E", { isAllDay: true, at: "2026-10-05T00:00:00.0000000", until: "2026-10-07T00:00:00.0000000" })]]);
  const r = await s.runOnce(true);
  assert.equal(r.synced, 1, JSON.stringify(s.alerts));
  const api = s.google.api();
  // 1. Directory mit dem Admin-Subjekt (nur Lesen), Primäradresse + Mitarbeiter-ID
  assert.match(api[0].url, new RegExp(`^${GOOGLE_DIRECTORY_BASE}/users/${encodeURIComponent(BOX)}\\?projection=basic&viewType=admin_view&fields=primaryEmail,suspended,externalIds$`));
  assert.deepEqual(s.google.access.get(api[0].headers.Authorization.slice(7)), { sub: ADMIN, scope: SCOPE_DIRECTORY_USER_READONLY, sa: SA });
  const p = s.repo.pipelines.get("p1")!;
  assert.deepEqual([p.identityAttribute, p.identityVerifiedAt?.toISOString()], ["employeeId", NOW.toISOString()]);
  // 2. Schreiben: Subjekt = Zielpostfach, Scope calendar.events, primary
  const posts = s.google.writes().filter((w) => w.method === "POST");
  assert.equal(posts.length, 3);
  for (const w of posts) {
    assert.equal(w.url, `${EVENTS}?sendUpdates=none`);
    assert.deepEqual(s.google.access.get(w.headers.Authorization.slice(7)), { sub: BOX, scope: SCOPE_CALENDAR_EVENTS, sa: SA });
  }
  const a = JSON.parse(posts[0].body!);
  assert.deepEqual(Object.keys(a).sort(), ["end", "extendedProperties", "id", "reminders", "start", "summary", "transparency"]);
  assert.deepEqual([a.id, a.summary, a.transparency, a.start, a.end, a.reminders, a.extendedProperties],
    [googleEventIdFromRef(sourceRef("p1", "A")), "Termin", "opaque", { dateTime: "2026-10-02T09:00:00Z", timeZone: "UTC" }, { dateTime: "2026-10-02T10:00:00Z", timeZone: "UTC" },
      { useDefault: false, overrides: [] }, { private: { [GOOGLE_REF_PROPERTY]: sourceRef("p1", "A") } }]);
  const allDay = JSON.parse(posts[2].body!);
  assert.deepEqual([allDay.start, allDay.end], [{ date: "2026-10-05" }, { date: "2026-10-07" }]);
  assert.equal(s.google.live(BOX).length, 3);
  assert.equal(s.repo.maps.get("p1")!.get("A")!.targetEventId, a.id);

  // Runde 2: A geändert (PATCH), B frei (DELETE), E abgesagt (DELETE), G neu
  s.graph.rounds.push([[ev("A", { changeKey: "ck-A-2", at: "2026-10-02T11:00:00.0000000", until: "2026-10-02T12:00:00.0000000" }),
    ev("B", { showAs: "free", changeKey: "x" }), ev("E", { isCancelled: true, changeKey: "y" }), ev("G")]]);
  s.google.requests = [];
  assert.equal((await s.runOnce(false)).synced, 1);
  assert.deepEqual(s.google.api().map((w) => `${w.method} ${w.url.slice(EVENTS.length).split("?")[0] || "/"}`),
    [`PATCH /${a.id}`, `DELETE /${googleEventIdFromRef(sourceRef("p1", "B"))}`, `DELETE /${googleEventIdFromRef(sourceRef("p1", "E"))}`, "POST /"],
    "Identität nicht erneut geprüft (< 24 h), Token aus dem Cache");
  assert.equal(s.google.requests.filter((r) => !r.url.startsWith(GOOGLE_CALENDAR_BASE)).length, 0, "kein neuer Token-Abruf");
  assert.deepEqual(s.google.calendars.get(BOX)!.get(a.id)!.start, { dateTime: "2026-10-02T11:00:00Z", timeZone: "UTC" });
  assert.equal(s.google.live(BOX).length, 2);
});

test("Sync Google full: Betreff + Ort, nie Text/Teilnehmer; private Termine wie busy; Wechsel full → busy leert den Ort", async () => {
  const s = setup({ pipeline: { mode: "full", busyLabel: null } });
  s.graph.rounds.push([[{ ...ev("A", { subject: "Vorstand", location: { displayName: "Raum 1" } }), body: { content: "geheim" }, attendees: [{}] } as GraphEvent,
    ev("P", { subject: "Arzt", sensitivity: "private", location: { displayName: "Praxis" } })]]);
  await s.runOnce(true);
  const [a, priv] = s.google.writes().map((w) => JSON.parse(w.body!));
  assert.deepEqual([a.summary, a.location, a.transparency, "description" in a, "attendees" in a], ["Vorstand", "Raum 1", "opaque", false, false]);
  assert.deepEqual([priv.summary, "location" in priv], ["Beschäftigt", false]);
  assert.deepEqual(toGoogleEvent({ subject: "x", showAs: "busy", location: { displayName: "" } }), { summary: "x", transparency: "opaque", location: "" });
  // Modus auf busy: alles einmal inhaltsfrei neu (Ort geleert)
  const p = s.repo.pipelines.get("p1")!;
  p.mode = "busy"; p.busyLabel = "Termin";
  s.google.requests = [];
  s.graph.rounds.push([[ev("A", { subject: "Vorstand" }), ev("P")]]);
  await s.runOnce(false);
  const ev0 = s.google.calendars.get(BOX)!.get(googleEventIdFromRef(sourceRef("p1", "A"))!)!;
  assert.deepEqual([ev0.summary, ev0.location], ["Termin", ""]);
});

test("Idempotent: Absturz nach dem Einfügen → nächster Lauf PATCHt dieselbe ID; gelöschte ID neu belegt → 409 → PATCH mit status confirmed", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A")]]);
  const orig = s.repo.upsertMapping.bind(s.repo);
  let n = 0;
  s.repo.upsertMapping = async (t, p, row) => { if (++n === 2) throw new Error("connection terminated"); return orig(t, p, row); };
  assert.equal((await s.runOnce(true)).rescheduled, 1);
  assert.equal(s.repo.maps.get("p1")!.get("A")!.targetEventId, null, "Anlage begonnen, nicht bestätigt");
  s.repo.upsertMapping = orig;
  s.graph.rounds.push([[ev("A")]]);
  s.due();
  s.google.requests = [];
  assert.equal((await s.worker.tick(10)).synced, 1);
  const id = googleEventIdFromRef(sourceRef("p1", "A"))!;
  assert.deepEqual(s.google.writes().map((w) => w.method), ["PATCH"], "kein zweites Einfügen");
  assert.equal(s.google.live(BOX).length, 1);
  assert.equal(s.repo.maps.get("p1")!.get("A")!.targetEventId, id);

  // Quelle: belegt → frei (Ziel gelöscht = cancelled) → wieder belegt: dieselbe ID, Google meldet 409
  s.graph.rounds.push([[ev("A", { showAs: "free", changeKey: "2" })]]);
  await s.runOnce(false);
  assert.equal(s.google.live(BOX).length, 0);
  s.graph.rounds.push([[ev("A", { changeKey: "3" })]]);
  s.google.requests = [];
  await s.runOnce(false);
  assert.deepEqual(s.google.writes().map((w) => w.method), ["POST", "PATCH"]);
  assert.equal(JSON.parse(s.google.writes()[1].body!).status, "confirmed");
  assert.equal(s.google.live(BOX).length, 1, "wiederhergestellt, kein Duplikat");

  // Im Ziel vom Nutzer gelöscht (cancelled) → PATCH sieht cancelled → wie 404: neu anlegen (POST 409 → PATCH)
  s.google.calendars.get(BOX)!.get(id)!.status = "cancelled";
  s.graph.rounds.push([[ev("A", { changeKey: "4", at: "2026-10-02T09:30:00.0000000" })]]);
  s.google.requests = [];
  await s.runOnce(false);
  assert.deepEqual(s.google.writes().map((w) => w.method), ["PATCH", "POST", "PATCH"]);
  assert.equal(s.google.live(BOX).length, 1);
});

test("Alive-Prüfung vor JEDEM Google-Aufruf: Deaktivierung während der Anlage stoppt; widerrufen → nicht einmal ein Token", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B"), ev("C")]]);
  s.google.onRequest = (r) => { if (r.method === "POST" && r.url.startsWith(EVENTS)) s.repo.users.get("u1")!.active = false; };
  assert.equal((await s.runOnce(true)).stopped, 1);
  assert.equal(s.google.writes().length, 1, "nur der eine laufende Aufruf");

  const x = setup();
  x.repo.pipelines.get("p1")!.status = "revoked";
  x.graph.rounds.push([[ev("A")]]);
  assert.equal((await x.runOnce(true)).dropped, 1);
  assert.equal(x.google.requests.length, 0, "keine Token-Kette, kein Google-Aufruf");
  // Pipeline wird während der Identitätsprüfung widerrufen → kein Schreiben
  const y = setup();
  y.graph.rounds.push([[ev("A")]]);
  y.google.onRequest = (r) => { if (r.url.startsWith(GOOGLE_DIRECTORY_BASE)) y.repo.pipelines.get("p1")!.status = "revoked"; };
  assert.equal((await y.runOnce(true)).stopped, 1);
  assert.equal(y.google.writes().length, 0);
});

test("Allowlist im Worker: Workspace entfernt, Domain nicht mehr erlaubt, Google nicht konfiguriert → config_error + Alarm, kein Google-Aufruf", async () => {
  for (const [name, allowlist, noGoogle, reason] of [
    ["Workspace entfernt", { ...ALLOW, googleWorkspaces: [] }, false, "target_not_allowed:workspace_not_linked"],
    ["Domain entfernt", { ...ALLOW, googleWorkspaces: [{ ...WS, domains: ["neu.example"] }] }, false, "target_not_allowed:domain_not_allowed"],
    ["kein Token-Provider", ALLOW, true, "google_not_configured"],
  ] as const) {
    const s = setup({ allowlist, noGoogle });
    s.graph.rounds.push([[ev("A")]]);
    assert.equal((await s.runOnce(true)).failed, 1, name);
    assert.equal(s.google.requests.length, 0, name);
    assert.equal(s.graph.requests.length, 0, `${name}: nicht einmal die Quelle gelesen`);
    assert.equal(s.repo.pipelines.get("p1")!.status, "config_error", name);
    assert.deepEqual(s.alerts.map((a) => a.reason), [reason], name);
  }
  // gespeicherte, falsche Workspace-ID (z. B. manipuliert) → abgelehnt
  const w = setup({ pipeline: { target: { ...GTARGET, workspaceId: "fremd" } } });
  assert.equal((await w.runOnce(true)).failed, 1);
  assert.equal(w.google.requests.length, 0);
});

test("Dieselbe Person (Google): andere Mitarbeiter-ID, fehlend, mehrdeutig, Alias, gesperrt, kein Admin-Subjekt → nie schreiben; Directory 503 → später", async () => {
  const cases: Array<[string, (s: ReturnType<typeof setup>) => void, string]> = [
    ["andere Person", (s) => { s.google.users.get(BOX)!.externalIds = [{ type: "organization", value: "E-2" }]; }, "different_person"],
    ["ID fehlt", (s) => { s.google.users.get(BOX)!.externalIds = [{ type: "custom", value: "E-1" }]; }, "attribute_missing"],
    ["ID mehrdeutig", (s) => { s.google.users.get(BOX)!.externalIds = [{ type: "organization", value: "E-1" }, { type: "organization", value: "E-7" }]; }, "attribute_missing"],
    ["Inhaber ohne employeeId", (s) => { s.graph.users.set("oid-1", { id: "oid-1", employeeId: null }); }, "attribute_missing"],
    ["Alias statt Primäradresse", (s) => { s.google.users.set(BOX, { primaryEmail: "m.muster@acme-g.example", aliases: [BOX], externalIds: [{ type: "organization", value: "E-1" }] }); }, "target_not_found"],
    ["gesperrt", (s) => { s.google.users.get(BOX)!.suspended = true; }, "target_not_found"],
    ["unbekannt", (s) => { s.google.users.delete(BOX); }, "target_not_found"],
    ["Admin-Subjekt ohne Admin-Rolle", (s) => { s.google.admins.clear(); }, "forbidden"],
  ];
  for (const [name, mut, why] of cases) {
    const s = setup();
    mut(s);
    s.graph.rounds.push([[ev("A")]]);
    assert.equal((await s.runOnce(true)).failed, 1, name);
    assert.equal(s.google.writes().length, 0, `${name}: kein Schreiben`);
    assert.deepEqual([s.repo.pipelines.get("p1")!.status, s.repo.pipelines.get("p1")!.lastSyncError], ["config_error", "identity_unverified"], name);
    assert.deepEqual(s.alerts.map((a) => a.reason), [`identity_unverified:${why}`], name);
    assert.equal(JSON.stringify(s.alerts).includes("E-1"), false, `${name}: Merkmal nie im Alarm`);
  }
  const noAdmin = setup({ allowlist: { ...ALLOW, googleWorkspaces: [{ ...WS, directoryAdminSubject: null }] } });
  noAdmin.graph.rounds.push([[ev("A")]]);
  assert.equal((await noAdmin.runOnce(true)).failed, 1);
  assert.equal(noAdmin.google.requests.length, 0, "ohne Directory-Subjekt nicht einmal ein Token");
  const down = setup();
  down.google.inject.push({ match: (r) => r.url.startsWith(GOOGLE_DIRECTORY_BASE), status: 503, retryAfter: "9" });
  down.graph.rounds.push([[ev("A")]]);
  assert.equal((await down.runOnce(true)).rescheduled, 1);
  assert.equal(down.google.writes().length, 0);
  assert.equal(down.repo.pipelines.get("p1")!.lastSyncError, "transient");
  // Opt-in localPart: keine Directory-Abfrage
  const lp = setup({ allowlist: { ...ALLOW, googleWorkspaces: [{ ...WS, identityAttribute: "localPart", directoryAdminSubject: null }] } });
  lp.graph.rounds.push([[ev("A")]]);
  assert.equal((await lp.runOnce(true)).synced, 1);
  assert.equal(lp.google.requests.some((r) => r.url.startsWith(GOOGLE_DIRECTORY_BASE)), false);
});

test("Cache-Isolation im Betrieb: zwei Inhaber, zwei Google-Postfächer – jeder Schreibzugriff trägt das Token SEINES Subjekts", async () => {
  const s = setup();
  s.repo.users.set("u2", { id: "u2", externalId: "oid-2", userName: "eva@acme.example", active: true });
  s.repo.addPipeline("p2", { ownerUserId: "u2", target: { ...GTARGET, mailbox: "eva@acme-g.example" } });
  s.graph.users.set("oid-2", { id: "oid-2", employeeId: "E-2" });
  s.google.users.set("eva@acme-g.example", { primaryEmail: "eva@acme-g.example", externalIds: [{ type: "organization", value: "E-2" }] });
  s.graph.rounds.push([[ev("A")]], [[ev("B")]]);
  await s.runOnce(true, "p1");
  await s.runOnce(true, "p2");
  const subs = s.google.writes().map((w) => s.google.access.get(w.headers.Authorization.slice(7))!.sub);
  assert.deepEqual(subs, [BOX, "eva@acme-g.example"]);
  assert.deepEqual([s.google.live(BOX).length, s.google.live("eva@acme-g.example").length], [1, 1]);
  // 401 auf Evas Kalender → nur Evas Token verworfen, Max' Token bleibt im Cache
  const maxTok = s.google.writes()[0].headers.Authorization;
  s.google.inject.push({ match: (r) => cal("PATCH")(r) && s.google.access.get(r.headers.Authorization.slice(7))?.sub === "eva@acme-g.example", status: 401 });
  s.graph.rounds.push([[ev("B", { changeKey: "x", at: "2026-10-02T09:30:00.0000000" })]], [[ev("A", { changeKey: "y", at: "2026-10-02T09:30:00.0000000" })]]);
  s.google.requests = [];
  await s.runOnce(false, "p2");
  await s.runOnce(false, "p1");
  const patches = s.google.writes();
  assert.equal(patches.length, 3, "Eva: 401 + Wiederholung, Max: einmal");
  assert.notEqual(patches[1].headers.Authorization, patches[0].headers.Authorization, "Eva bekommt ein neues Token");
  assert.equal(patches[2].headers.Authorization, maxTok, "Max' Token unverändert aus dem Cache");
});

test("Fehler Google im Worker: 403 rateLimitExceeded → Backoff; 403 forbidden → blocked_scope; DWD fehlt → config (im Fenster: Retry); 404 → blocked_scope; 400 je Termin → übersprungen", async () => {
  const rate = setup();
  rate.graph.rounds.push([[ev("A")]]);
  rate.google.inject.push({ match: cal("POST"), status: 403, body: { error: { code: 403, errors: [{ domain: "usageLimits", reason: "rateLimitExceeded" }] } }, retryAfter: "20" });
  assert.equal((await rate.runOnce(true)).rescheduled, 1);
  const job = [...rate.queue.rows.values()][0];
  assert.deepEqual([rate.repo.pipelines.get("p1")!.lastSyncError, (job.payload as { attempts: unknown }).attempts], ["transient", { transient: 1 }]);
  assert.ok(job.runAt.getTime() - NOW.getTime() >= 20_000);
  assert.equal(job.lastError, "google HTTP 403 rateLimitExceeded");

  const forb = setup();
  forb.graph.rounds.push([[ev("A")]]);
  forb.google.inject.push({ match: cal("POST"), status: 403, body: { error: { code: 403, errors: [{ reason: "forbidden" }] } } });
  assert.equal((await forb.runOnce(true)).failed, 1);
  assert.deepEqual([forb.repo.pipelines.get("p1")!.status, forb.alerts[0].category], ["blocked_scope", "blocked_scope"]);

  const dwd = setup();
  dwd.google.dwd.set(SA, new Set([SCOPE_DIRECTORY_USER_READONLY])); // calendar.events fehlt in der Admin-Konsole
  dwd.graph.rounds.push([[ev("A")]]);
  assert.equal((await dwd.runOnce(true)).failed, 1);
  assert.deepEqual([dwd.repo.pipelines.get("p1")!.status, dwd.alerts[0].category], ["config_error", "config"]);
  assert.match(dwd.alerts[0].reason, /^google_oauth HTTP 401 unauthorized_client/);
  const fresh = setup({ pipeline: { createdAt: new Date(NOW.getTime() - 3_600_000) } });
  fresh.google.dwd.set(SA, new Set([SCOPE_DIRECTORY_USER_READONLY]));
  fresh.graph.rounds.push([[ev("A")]]);
  assert.equal((await fresh.runOnce(true)).rescheduled, 1, "frisch angelegt: DWD braucht ggf. noch Zeit");
  assert.equal(fresh.repo.pipelines.get("p1")!.lastSyncError, "scope_propagation");

  const nf = setup();
  nf.graph.rounds.push([[ev("A")]]);
  nf.google.inject.push({ match: cal("POST"), status: 404, body: { error: { code: 404, errors: [{ reason: "notFound" }] } } });
  assert.equal((await nf.runOnce(true)).failed, 1);
  assert.equal(nf.repo.pipelines.get("p1")!.status, "blocked_scope");

  const bad = setup();
  bad.graph.rounds.push([[ev("A"), ev("B")]]);
  bad.google.inject.push({ match: cal("POST"), status: 400, body: { error: { code: 400, errors: [{ reason: "invalid" }] } } });
  assert.equal((await bad.runOnce(true)).synced, 1);
  assert.deepEqual([bad.repo.pipelines.get("p1")!.lastSyncError, [...bad.repo.maps.get("p1")!.keys()]], ["event_rejected", ["B"]]);

  // reine Klassifikation
  const ctx = { now: NOW, grantedAt: null, attempts: {} };
  const c = (status: number, body: unknown, extra: object = {}) => classifyGoogleError({ status, body: body === "" ? "" : JSON.stringify(body), retryAfter: null, ...extra }, ctx);
  assert.deepEqual([c(401, "").action, c(401, "").category], ["retry", "token"]);
  assert.equal(c(403, { error: { errors: [{ reason: "userRateLimitExceeded" }] } }).category, "transient");
  assert.equal(c(403, { error: { errors: [{ reason: "accessNotConfigured" }] } }).category, "config");
  assert.equal(c(403, { error: { details: [{ reason: "SERVICE_DISABLED" }] } }).category, "config");
  assert.equal(c(403, { error: { errors: [{ reason: "domainPolicy" }] } }).category, "config");
  assert.equal(c(403, { error: { errors: [{ reason: "forbidden" }] } }).category, "blocked_scope");
  assert.equal(c(404, "").category, "blocked_scope");
  assert.equal(c(429, "").category, "transient");
  assert.equal(c(503, "").category, "transient");
  assert.equal(c(400, { error: { errors: [{ reason: "invalid" }] } }).category, "invalid_request");
  assert.equal(c(400, "", { authStage: "oauth", authCode: "invalid_grant" }).category, "blocked_scope");
  assert.equal(c(403, "", { authStage: "iam", authCode: "permission_denied" }).category, "config");
  assert.equal(c(400, "", { authStage: "sts", authCode: "invalid_grant" }).category, "config");
  assert.equal(c(0, "", { authStage: "aws" }).category, "transient");
  assert.equal(c(403, { error: { errors: [{ reason: "<script>Inhalt" }], message: "KANARIE" } }).reason.includes("KANARIE"), false);
});

// ---------------------------------------------------------------------------------------------------
// Kanarienvogel
// ---------------------------------------------------------------------------------------------------
for (const mode of ["busy", "full"] as const) {
  test(`Kanarienvogel Google (${mode}): Inhalte nie in Repo, Queue, Log, Alarm; ${mode === "busy" ? "nie in einem Request an Google" : "nur Betreff + Ort an Google"}`, async () => {
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
    s.graph.rounds.push([[rich("A", { changeKey: "ck-A-2", at: "2026-10-02T09:15:00.0000000" }), rich("B", { showAs: "free", changeKey: "x" }), rich("D")]]);
    s.google.inject.push({ match: cal("POST"), status: 400, body: { error: { code: 400, message: `${c}-google-echo`, errors: [{ reason: "invalid", message: `${c}-google-echo` }] } } });
    await s.runOnce(false);
    s.graph.rounds.push([[rich("E")]]);
    s.google.inject.push({ match: cal("POST"), status: 403, body: { error: { code: 403, message: `${c}-google-echo`, errors: [{ reason: "forbidden", message: `${c}-google-echo` }] } } });
    await s.runOnce(true);
    s.repo.revoke("p1");
    s.google.inject.push({ match: cal("DELETE"), status: 503, body: { error: { message: `${c}-google-echo` } } });
    await s.cleanup();
    logger.flush();

    const writes = s.google.writes();
    assert.ok(["POST", "PATCH", "DELETE"].every((m) => writes.some((w) => w.method === m)));
    const sent = s.google.requests.map((w) => `${w.url}\n${w.body ?? ""}`).join("\n");
    if (mode === "busy") assert.equal(sent.includes(c), false, "busy: kein Inhalt in irgendeinem Request an Google");
    else {
      assert.ok(sent.includes(`${c}-subject`) && sent.includes(`${c}-location`));
      for (const banned of ["-body", "-preview", "@attendee", "-attendee", "-org", "-street", "x/"]) assert.equal(sent.includes(`${c}${banned}`), false, `full: nie ${banned}`);
    }
    const repoDump = JSON.stringify({ p: [...s.repo.pipelines.values()], m: [...s.repo.maps.values()].map((m) => [...m.values()]) });
    assert.equal(repoDump.includes(c), false, "Repo");
    assert.equal(JSON.stringify([...s.queue.rows.values()]).includes(c), false, "Queue (Payload, last_error)");
    assert.equal(JSON.stringify([s.alerts, s.cleanupAlerts]).includes(c), false, "Alarm");
    assert.ok(lines.length > 0);
    assert.equal(lines.join("").includes(c), false, "Log");
    assert.equal(lines.join("").includes("ya29."), false, "kein Token im Log");
    assert.equal(lines.join("").includes("E-1"), false, "keine Mitarbeiter-ID im Log");
  });
}

// ---------------------------------------------------------------------------------------------------
// Bereinigung
// ---------------------------------------------------------------------------------------------------
test("Bereinigung Google: löscht jeden angelegten Termin inkl. archivierter und unbestätigter (deterministische ID); 404/410 = erledigt; nur DELETE", async () => {
  const s = setup();
  s.graph.rounds.push([[ev("A"), ev("B"), ev("C")]]);
  await s.runOnce(true);
  assert.equal(s.google.live(BOX).length, 3);
  const rows = s.repo.maps.get("p1")!;
  rows.get("A")!.archived = true; // aus dem Fenster gefallen – Zieltermin steht noch
  rows.set("U", { sourceEventId: "U", targetEventId: null, changeKey: null, startAt: NOW, endAt: NOW }); // Anlage begonnen
  s.google.calendars.get(BOX)!.set(googleEventIdFromRef(sourceRef("p1", "U"))!, { status: "confirmed" }); // … und bei Google angekommen
  s.google.calendars.get(BOX)!.get(googleEventIdFromRef(sourceRef("p1", "C"))!)!.status = "cancelled"; // vom Nutzer gelöscht → 410
  rows.set("V", { sourceEventId: "V", targetEventId: null, changeKey: null, startAt: NOW, endAt: NOW }); // nie angekommen → 404
  s.repo.revoke("p1");
  s.repo.users.get("u1")!.active = false; // Bereinigung braucht keinen aktiven Inhaber
  s.google.requests = [];
  assert.equal((await s.cleanup()).cleaned, 1, JSON.stringify(s.cleanupAlerts));
  assert.equal(s.google.live(BOX).length, 0, "nichts mehr von CalenSync im Google-Kalender");
  const api = s.google.api();
  assert.ok(api.every((r) => r.method === "DELETE"), "nur DELETE");
  assert.equal(api.length, 5);
  assert.ok(api.every((r) => s.google.access.get(r.headers.Authorization.slice(7))!.sub === BOX));
  const p = s.repo.pipelines.get("p1")!;
  assert.deepEqual([p.cleanupDoneAt?.toISOString(), p.target.mailbox, p.target.provider, s.repo.maps.has("p1")], [NOW.toISOString(), null, "google", false]);

  // Workspace aus der Config entfernt → kein Aufruf, Alarm, Zuordnungen bleiben
  const t = setup();
  t.graph.rounds.push([[ev("A")]]);
  await t.runOnce(true);
  t.repo.revoke("p1");
  const gone = new TargetCleanupWorker({ queue: t.queue, repo: t.repo, tokens: graphTokens(), googleTokens: t.gTokens, fetchFn: (u, i) => t.google.fetch(u, i),
    allowlist: { ...ALLOW, googleWorkspaces: [] }, workerId: "w1", alert: (a) => { t.cleanupAlerts.push(a); }, now: () => NOW });
  t.google.requests = [];
  await t.queue.enqueue("acme", CLEANUP_KIND, { pipelineId: "p1" }, { dedupeKey: "cleanup:p1" });
  assert.equal((await gone.tick(10)).failed, 1);
  assert.equal(t.google.requests.length, 0);
  assert.equal(t.cleanupAlerts[0].reason, "cleanup_target_not_allowed:workspace_not_linked");
  assert.equal(t.repo.maps.get("p1")!.size, 1);

  // 503 → Backoff mit gespeichertem Fortschritt
  const u = setup();
  u.graph.rounds.push([[ev("A"), ev("B")]]);
  await u.runOnce(true);
  u.repo.revoke("p1");
  let n = 0;
  u.google.inject.push({ match: (r) => cal("DELETE")(r) && ++n === 2, status: 503 });
  assert.equal((await u.cleanup()).rescheduled, 1);
  assert.equal(u.repo.maps.get("p1")!.size, 1, "erster Termin gelöscht und vergessen");
  assert.equal(u.repo.pipelines.get("p1")!.lastSyncError, "cleanup_transient");
  u.due();
  assert.equal((await u.cleaner.tick(10)).cleaned, 1);
  assert.equal(u.google.live(BOX).length, 0);
});
