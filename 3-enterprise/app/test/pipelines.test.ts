/**
 * Pipeline-Anlage (POST /api/v1/me/pipelines): Store-Logik mit Fake-Prisma, Eingabeprüfung und HTTP-Route.
 * Das Zusammenspiel mit echter Sperre und echtem Postgres prüft scripts/bench/pipeline_race.sh (pgbench).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, randomUUID, sign } from "node:crypto";
import { request } from "node:http";
import type { AddressInfo } from "node:net";
import { createCorsPolicy } from "../src/cors.js";
import { EntraTokenVerifier } from "../src/entraAuth.js";
import { createAppServer } from "../src/server.js";
import {
  PrismaPipelineStore, parseCreatePipelineBody, parseIdempotencyKey,
  type CreatePipelineInput, type CreatePipelineResult, type EndPipelineResult, type PipelineStore,
} from "../src/pipelineStore.js";
import { InMemoryDelayedJobQueue, type FetchLike } from "../../core/src/index.js";
import { MemoryScimStore } from "../../scim/src/memoryStore.js";
import { HashedTokenAuthenticator } from "../../scim/src/auth.js";
import type { PipelineRow, PrismaLike, PrismaTx, ScimUserRow } from "../../scim/src/prismaStore.js";
import { StoreBusyError } from "../../scim/src/types.js";
import type { SyncAllowlist } from "../../core/src/syncTargets.js";

// ---------------------------------------------------------------------------------------------------
// Fake-Prisma: protokolliert jeden Aufruf in Reihenfolge, hält Users/Pipelines/Jobs im Speicher
// ---------------------------------------------------------------------------------------------------
type Args = { where?: Record<string, unknown>; data?: Record<string, unknown>; select?: Record<string, unknown> };
interface FakeState {
  users: Array<Pick<ScimUserRow, "id" | "tenantId" | "externalId" | "active" | "createdAt" | "userName"> & { deletionRequestedAt: Date | null }>;
  pipelines: PipelineRow[];
  jobs: Array<{ kind: string; dedupeKey: string; payload: string }>;
  calls: string[];
  channels?: Array<Record<string, unknown>>;
  /** wird nach dem Lock einmal ausgeführt – simuliert eine SCIM-Deaktivierung zwischen Vorab-Lookup und Sperre */
  afterLock?: () => void;
  /** wirft beim n-ten $transaction einen Fehler */
  failTx?: (attempt: number) => unknown;
}

function matches(row: Record<string, unknown>, where: Record<string, unknown> = {}): boolean {
  return Object.entries(where).every(([k, v]) => {
    if (v !== null && typeof v === "object" && "not" in (v as object)) return row[k] !== (v as { not: unknown }).not;
    return (row[k] ?? null) === v;
  });
}

function fakePrisma(st: FakeState): PrismaLike {
  const notUsed = async (): Promise<never> => { throw new Error("nicht erwartet"); };
  const tx: PrismaTx = {
    scimUser: {
      findFirst: async (a: Args) => {
        st.calls.push(`user.findFirst:${a.where?.active === true ? "active" : "any"}`);
        const u = st.users.find((r) => matches(r as unknown as Record<string, unknown>, a.where));
        return (u ?? null) as unknown as ScimUserRow | null;
      },
      findMany: notUsed, count: notUsed, create: notUsed, updateMany: notUsed, deleteMany: notUsed,
    },
    pipeline: {
      findFirst: async (a: Args) => {
        st.calls.push("pipeline.findFirst");
        return st.pipelines.find((p) => matches(p as unknown as Record<string, unknown>, a.where)) ?? null;
      },
      count: async (a: Args) => {
        st.calls.push("pipeline.count");
        return st.pipelines.filter((p) => matches(p as unknown as Record<string, unknown>, a.where)).length;
      },
      create: async (a: Args) => {
        st.calls.push("pipeline.create");
        const row = a.data as unknown as PipelineRow;
        st.pipelines.push(row);
        return row;
      },
      updateMany: async (a: Args) => {
        st.calls.push("pipeline.updateMany");
        let count = 0;
        for (const p of st.pipelines) if (matches(p as unknown as Record<string, unknown>, a.where)) { Object.assign(p, a.data); count++; }
        return { count };
      },
    },
    providerToken: { deleteMany: notUsed },
    webhookChannel: { updateMany: async (a: Args) => {
      st.calls.push("channel.updateMany");
      let count = 0;
      for (const c of st.channels ?? []) if (matches(c, a.where)) { Object.assign(c, a.data); count++; }
      return { count };
    } },
    auditEvent: { findFirst: notUsed, create: notUsed },
    $executeRaw: async (q: TemplateStringsArray, ...v: unknown[]) => {
      const sql = q.join("?").replace(/\s+/g, " ").trim();
      if (sql.startsWith("SET LOCAL lock_timeout")) st.calls.push("lock_timeout");
      else if (sql.includes("pg_advisory_xact_lock")) {
        st.calls.push(`advisory_lock:${String(v[0])}/${String(v[1])}`);
        st.afterLock?.();
        st.afterLock = undefined;
      } else if (sql.startsWith("INSERT INTO job_queue")) {
        st.calls.push("job.insert");
        st.jobs.push({ kind: String(v[1]), dedupeKey: String(v[2]), payload: String(v[3]) });
      } else throw new Error(`unerwartetes SQL: ${sql}`);
      return 1;
    },
  };
  let txCount = 0;
  return {
    ...tx,
    $transaction: async (fn, opts) => {
      st.calls.push(`tx:${opts?.isolationLevel ?? "default"}`);
      const err = st.failTx?.(++txCount);
      if (err) throw err;
      // Rollback-Semantik: bei Fehler Zustand zurücksetzen
      const snap = { pipelines: [...st.pipelines], jobs: [...st.jobs] };
      try {
        return await fn(tx);
      } catch (e) {
        st.pipelines = snap.pipelines;
        st.jobs = snap.jobs;
        throw e;
      }
    },
  } as PrismaLike;
}

const CREATED = new Date("2026-09-01T08:00:00Z");
const state = (over: Partial<FakeState> = {}): FakeState => ({
  users: [{ id: "u-1", tenantId: "acme", externalId: "oid-42", userName: "Max.Muster@acme.example", active: true, createdAt: CREATED, deletionRequestedAt: null }],
  pipelines: [], jobs: [], calls: [], ...over,
});
const input = (o: Partial<CreatePipelineInput> = {}): CreatePipelineInput => ({
  tenantId: "acme", entraObjectId: "oid-42", mode: "busy", busyLabel: "Termin", idempotencyKey: "key-0000000000000001",
  target: { kind: "team", teamId: "vertrieb" }, ...o,
});
const HOME = "11111111-2222-3333-4444-555555555555";
const LINKED = "99999999-8888-7777-6666-555555555555";
/** Admin-Allowlist wie aus APP_CONFIG */
const ALLOW: SyncAllowlist = {
  homeEntraTenantId: HOME,
  ownDomains: ["acme.example", "acme-alias.example"],
  linkedTenants: [{ entraTenantId: LINKED, label: "Acme Tochter GmbH", domains: ["tochter.example"] }],
  teamCalendars: [{ id: "vertrieb", mailbox: "vertrieb@acme.example", label: "Vertrieb" }],
  bookingEnabled: true,
};
let seq = 0;
const ids = () => `pl-${++seq}`;

// ---------------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------------
test("Store: Happy Path – Sperre vor jeder Prüfung, Pipeline + Handshake-Job in derselben Transaktion", async () => {
  const st = state();
  const r = await new PrismaPipelineStore(fakePrisma(st), 5, ids, ALLOW).createPipeline(input());
  assert.equal(r.kind, "created");
  assert.deepEqual(st.calls, [
    "user.findFirst:any",          // Vorab-Lookup nur für den Sperrschlüssel
    "tx:ReadCommitted",
    "lock_timeout",
    "advisory_lock:acme/u-1",      // dieselbe Sperre wie SCIM-Deaktivierung
    "user.findFirst:active",       // maßgebliche Prüfung NACH der Sperre
    "pipeline.findFirst",          // Idempotency-Key
    "pipeline.count",              // Limit
    "pipeline.create",
    "job.insert",
  ]);
  assert.equal(st.pipelines[0]?.status, "pending");
  assert.equal(st.jobs[0]?.kind, "pipeline.handshake");
  assert.equal(st.jobs[0]?.dedupeKey, `handshake:${st.pipelines[0]?.id}`);
  assert.deepEqual(JSON.parse(st.jobs[0]?.payload ?? "{}"), { pipelineId: st.pipelines[0]?.id, userId: "u-1", grantedAt: CREATED.toISOString(), attempts: {} });
});

test("Store: gleicher Idempotency-Key → Replay ohne zweite Pipeline; andere Nutzlast → Konflikt", async () => {
  const st = state();
  const store = new PrismaPipelineStore(fakePrisma(st), 5, ids, ALLOW);
  const a = await store.createPipeline(input());
  const b = await store.createPipeline(input());
  assert.equal(a.kind, "created");
  assert.equal(b.kind, "replayed");
  assert.equal(a.kind === "created" && b.kind === "replayed" && a.pipeline.id === b.pipeline.id, true);
  assert.equal((await store.createPipeline(input({ mode: "full", busyLabel: null }))).kind, "idempotency_conflict");
  assert.equal((await store.createPipeline(input({ busyLabel: "Anders" }))).kind, "idempotency_conflict");
  assert.equal(st.pipelines.length, 1);
  assert.equal(st.jobs.length, 1);
});

test("Store: Limit greift exakt, revoked zählt nicht mit", async () => {
  const st = state({
    pipelines: [
      ...Array.from({ length: 2 }, (_, n) => ({ id: `a${n}`, tenantId: "acme", ownerUserId: "u-1", status: "active", mode: "busy", busyLabel: null, idempotencyKey: null })),
      { id: "r1", tenantId: "acme", ownerUserId: "u-1", status: "revoked", mode: "busy", busyLabel: null, idempotencyKey: null },
    ],
  });
  const store = new PrismaPipelineStore(fakePrisma(st), 3, ids, ALLOW);
  assert.equal((await store.createPipeline(input({ idempotencyKey: "key-0000000000000003" }))).kind, "created");
  assert.deepEqual(await store.createPipeline(input({ idempotencyKey: "key-0000000000000004" })), { kind: "limit_reached", limit: 3 });
  assert.equal(st.jobs.length, 1);
});

test("Store: unbekannt, gelöscht, deaktiviert – und Deaktivierung zwischen Vorab-Lookup und Sperre", async () => {
  const unknown = state();
  assert.equal((await new PrismaPipelineStore(fakePrisma(unknown), 5, ids, ALLOW).createPipeline(input({ entraObjectId: "oid-fremd" }))).kind, "user_not_provisioned");
  assert.deepEqual(unknown.calls, ["user.findFirst:any"], "keine Transaktion für Unbekannte");

  const tomb = state();
  tomb.users[0]!.deletionRequestedAt = new Date();
  assert.equal((await new PrismaPipelineStore(fakePrisma(tomb), 5, ids, ALLOW).createPipeline(input())).kind, "user_not_provisioned");

  const inactive = state();
  inactive.users[0]!.active = false;
  assert.equal((await new PrismaPipelineStore(fakePrisma(inactive), 5, ids, ALLOW).createPipeline(input())).kind, "user_not_provisioned");
  assert.equal(inactive.pipelines.length, 0);

  // Race: Vorab-Lookup sieht den User aktiv, SCIM deaktiviert ihn, bevor wir die Sperre bekommen
  const race = state();
  race.afterLock = () => { race.users[0]!.active = false; };
  assert.equal((await new PrismaPipelineStore(fakePrisma(race), 5, ids, ALLOW).createPipeline(input())).kind, "user_not_provisioned");
  assert.deepEqual([race.pipelines.length, race.jobs.length], [0, 0]);
});

test("Store: Lock-Timeout wird wiederholt, danach StoreBusyError; fremde Fehler sofort durchgereicht", async () => {
  const lockTimeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "P2010", meta: { code: "55P03" } });
  const once = state({ failTx: (n) => (n === 1 ? lockTimeout : undefined) });
  assert.equal((await new PrismaPipelineStore(fakePrisma(once), 5, ids, ALLOW).createPipeline(input())).kind, "created");
  assert.equal(once.calls.filter((c) => c.startsWith("tx:")).length, 2);

  const always = state({ failTx: () => lockTimeout });
  await assert.rejects(new PrismaPipelineStore(fakePrisma(always), 5, ids, ALLOW).createPipeline(input()), StoreBusyError);
  assert.equal(always.calls.filter((c) => c.startsWith("tx:")).length, 3);

  const other = state({ failTx: () => new Error("connection refused") });
  await assert.rejects(new PrismaPipelineStore(fakePrisma(other), 5, ids, ALLOW).createPipeline(input()), /connection refused/);
  assert.equal(other.calls.filter((c) => c.startsWith("tx:")).length, 1);
});

// ---------------------------------------------------------------------------------------------------
// Eingabeprüfung
// ---------------------------------------------------------------------------------------------------
test("Body: gültige Eingaben werden normalisiert", () => {
  const target = { kind: "booking" } as const;
  assert.deepEqual(parseCreatePipelineBody({ mode: "busy", target }), { ok: true, mode: "busy", busyLabel: null, target });
  assert.deepEqual(parseCreatePipelineBody({ target, mode: "busy", busyLabel: "  Außer Haus  " }), { ok: true, mode: "busy", busyLabel: "Außer Haus", target });
  assert.deepEqual(parseCreatePipelineBody({ target, mode: "busy", busyLabel: "Gespräch" }), { ok: true, mode: "busy", busyLabel: "Gespräch", target }, "NFC");
  assert.deepEqual(parseCreatePipelineBody({ target, mode: "full", busyLabel: null }), { ok: true, mode: "full", busyLabel: null, target });
  assert.deepEqual(parseCreatePipelineBody({ mode: "busy", target: { kind: "account", mailbox: " Max.Muster@Tochter.Example ", entraTenantId: LINKED.toUpperCase() } }),
    { ok: true, mode: "busy", busyLabel: null, target: { kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: LINKED } });
  assert.deepEqual(parseCreatePipelineBody({ mode: "busy", target: { kind: "team", teamId: "vertrieb" } }),
    { ok: true, mode: "busy", busyLabel: null, target: { kind: "team", teamId: "vertrieb" } });
});

test("Body: manipulierte Eingaben werden abgewiesen", () => {
  const bad: Array<[string, unknown, RegExp]> = [
    ["null", null, /body_must_be_object/],
    ["Array", [{ mode: "busy" }], /body_must_be_object/],
    ["String", "busy", /body_must_be_object/],
    ["__proto__", JSON.parse('{"mode":"busy","__proto__":{"admin":true}}'), /unknown_field:__proto__/],
    ["constructor", { mode: "busy", constructor: { prototype: {} } }, /unknown_field:constructor/],
    ["fremdes Feld", { mode: "busy", ownerUserId: "u-2" }, /unknown_field:ownerUserId/],
    ["status setzen", { mode: "busy", status: "active" }, /unknown_field:status/],
    ["mode fehlt", {}, /mode_must_be/],
    ["mode falsch", { mode: "BUSY" }, /mode_must_be/],
    ["mode Objekt", { mode: { $ne: null } }, /mode_must_be/],
    ["Label Zahl", { mode: "busy", busyLabel: 42 }, /busyLabel_must_be_string/],
    ["Label leer", { mode: "busy", busyLabel: "   " }, /busyLabel_length/],
    ["Label zu lang", { mode: "busy", busyLabel: "x".repeat(65) }, /busyLabel_length/],
    ["Steuerzeichen", { mode: "busy", busyLabel: "a\u0000b" }, /invalid_characters/],
    ["Zeilenumbruch", { mode: "busy", busyLabel: "a\nb" }, /invalid_characters/],
    ["Bidi-Override", { mode: "busy", busyLabel: "Rechnung‮fdp.exe" }, /invalid_characters/],
    ["Zero-Width", { mode: "busy", busyLabel: "a​b" }, /invalid_characters/],
    ["HTML", { mode: "busy", busyLabel: "<img src=x onerror=alert(1)>" }, /invalid_characters/],
    ["full + Label", { mode: "full", busyLabel: "x" }, /busyLabel_only_for_busy/],
  ];
  for (const [name, body, err] of bad) {
    const r = parseCreatePipelineBody(body);
    assert.equal(r.ok, false, name);
    if (!r.ok) assert.match(r.error, err, name);
  }
  assert.equal(parseCreatePipelineBody({ mode: "busy", ["k".repeat(500)]: 1 }).ok === false
    && (parseCreatePipelineBody({ mode: "busy", ["k".repeat(500)]: 1 }) as { error: string }).error.length <= 46, true, "Feldname gekürzt");
});

test("Idempotency-Key: nur 16–64 Zeichen [A-Za-z0-9_-], keine Arrays", () => {
  const uuid = randomUUID();
  assert.equal(parseIdempotencyKey(uuid), uuid);
  assert.equal(parseIdempotencyKey("a".repeat(16)), "a".repeat(16));
  assert.equal(parseIdempotencyKey("A_b-".repeat(16)), "A_b-".repeat(16));
  for (const v of [undefined, "", "kurz", "x".repeat(65), "key with space 000", "key;DROP TABLE x--", "ключ-0000000000000", ["key-0000000000000001", "key-0000000000000002"]]) {
    assert.equal(parseIdempotencyKey(v), null, String(v));
  }
});

// ---------------------------------------------------------------------------------------------------
// HTTP-Route
// ---------------------------------------------------------------------------------------------------
const TID = "11111111-2222-3333-4444-555555555555";
const AUD = "api://calensync-acme";
const ORIGIN = "https://app.calensync.de";
const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwks: FetchLike = async () => ({ status: 200, headers: { get: () => null },
  text: async () => JSON.stringify({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "k", use: "sig" }] }) });
const nowSec = Math.floor(Date.now() / 1000);
const tok = (c: Record<string, unknown> = {}) => {
  const h = Buffer.from(JSON.stringify({ alg: "RS256", kid: "k" })).toString("base64url");
  const p = Buffer.from(JSON.stringify({ iss: `https://login.microsoftonline.com/${TID}/v2.0`, aud: AUD, tid: TID, oid: "oid-42",
    scp: "Sync.Read Sync.Write", iat: nowSec, nbf: nowSec - 5, exp: nowSec + 600, ...c })).toString("base64url");
  return `${h}.${p}.${sign("RSA-SHA256", Buffer.from(`${h}.${p}`), privateKey).toString("base64url")}`;
};

async function withApi(store: PipelineStore, fn: (port: number, sec: Array<Record<string, unknown>>) => Promise<void>) {
  const sec: Array<Record<string, unknown>> = [];
  const app = createAppServer({
    tenantId: "acme",
    webhook: { queue: new InMemoryDelayedJobQueue(), securityEvent: () => {}, repo: { findBySubscriptionIds: async () => new Map(), markStoppedMany: async () => {} } },
    googleWebhook: { queue: new InMemoryDelayedJobQueue(), securityEvent: () => {}, repo: { findGoogleChannel: async () => null, acceptGoogleNotification: async () => ({ fresh: false, queued: false }) } },
    scim: { store: new MemoryScimStore(), baseUrl: "x", newId: randomUUID, auth: new HashedTokenAuthenticator("p".repeat(40), async () => []) },
    cors: createCorsPolicy([ORIGIN]),
    auth: new EntraTokenVerifier({ tenantId: TID, audiences: [AUD], requiredScope: "Sync.Read", fetchFn: jwks }),
    status: { getSyncStatus: async () => null },
    pipelines: store,
    writeScope: "Sync.Write",
    log: () => {},
    security: { security: (event, f) => sec.push({ event, ...(f ?? {}) }) },
  });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  try {
    await fn((app.server.address() as AddressInfo).port, sec);
  } finally {
    app.server.close();
  }
}

function post(port: number, headers: Record<string, string>, body?: string, method = "POST") {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, unknown> }>((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path: "/api/v1/me/pipelines",
      headers: { Origin: ORIGIN, ...headers, ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: t ? (JSON.parse(t) as Record<string, unknown>) : {} }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

/** Mock-Store, der Aufrufe mitschreibt und eine vorgegebene Antwort liefert */
function mockStore(result: CreatePipelineResult | Error) {
  const calls: CreatePipelineInput[] = [];
  const store: PipelineStore = { createPipeline: async (i) => { calls.push(i); if (result instanceof Error) throw result; return result; } };
  return { store, calls };
}
const KEY = "0b7c1d1e-6a43-4c7e-9d2b-2f2a0d6f9c11";
const ok = (extra: Record<string, string> = {}) => ({ Authorization: `Bearer ${tok()}`, "Idempotency-Key": KEY, "Content-Type": "application/json", ...extra });
const PIPE = { id: "pl-9", status: "pending", mode: "busy" as const, busyLabel: "Termin" };
const TEAM = { kind: "team", teamId: "vertrieb" } as const;

test("Route: 201 mit Location, 200-Replay mit Header – Store bekommt oid aus dem Token, nie aus dem Body", async () => {
  const created = mockStore({ kind: "created", pipeline: PIPE });
  await withApi(created.store, async (port) => {
    const r = await post(port, ok(), JSON.stringify({ mode: "busy", busyLabel: "Termin", target: TEAM }));
    assert.equal(r.status, 201);
    assert.equal(r.headers.location, "/api/v1/me/pipelines/pl-9");
    assert.equal(r.headers["access-control-allow-origin"], ORIGIN);
    assert.match(String(r.headers["access-control-expose-headers"]), /location/i);
    assert.deepEqual(r.json, PIPE);
    assert.deepEqual(created.calls, [{ tenantId: "acme", entraObjectId: "oid-42", mode: "busy", busyLabel: "Termin", idempotencyKey: KEY, target: TEAM }]);
  });
  const replay = mockStore({ kind: "replayed", pipeline: PIPE });
  await withApi(replay.store, async (port) => {
    const r = await post(port, ok(), JSON.stringify({ mode: "busy", busyLabel: "Termin", target: TEAM }));
    assert.equal(r.status, 200);
    assert.equal(r.headers["idempotent-replayed"], "true");
  });
});

test("Route: Store-Ergebnisse → 404, 409, 422; DB überlastet → 503 mit Retry-After", async () => {
  const cases: Array<[CreatePipelineResult | Error, number, string]> = [
    [{ kind: "user_not_provisioned" }, 404, "user_not_provisioned"],
    [{ kind: "limit_reached", limit: 5 }, 409, "pipeline_limit_reached"],
    [{ kind: "idempotency_conflict" }, 422, "idempotency_key_reused"],
    [new StoreBusyError(3, new Error("lock timeout")), 503, "temporarily_unavailable"],
  ];
  for (const [result, status, error] of cases) {
    await withApi(mockStore(result).store, async (port) => {
      const r = await post(port, ok(), JSON.stringify({ mode: "full", target: TEAM }));
      assert.equal(r.status, status, error);
      assert.equal(r.json.error, error);
      if (status === 409) assert.equal(r.json.limit, 5);
      if (status === 503) assert.equal(r.headers["retry-after"], "5");
    });
  }
});

test("Route: Token abgelaufen → 401, nur Sync.Read → 403 – Store wird nie aufgerufen, kein Token im Sicherheits-Log", async () => {
  const m = mockStore({ kind: "created", pipeline: PIPE });
  await withApi(m.store, async (port, sec) => {
    // 60 s Uhren-Toleranz (entraAuth.clockSkewSeconds): 120 s abgelaufen muss sicher scheitern
    const expired = tok({ exp: nowSec - 120 });
    const a = await post(port, ok({ Authorization: `Bearer ${expired}` }), JSON.stringify({ mode: "busy" }));
    assert.equal(a.status, 401);
    assert.match(String(a.headers["www-authenticate"]), /token_expired/);
    assert.match(String(a.headers["www-authenticate"]), /invalid_token/);
    const b = await post(port, ok({ Authorization: `Bearer ${tok({ scp: "Sync.Read" })}` }), JSON.stringify({ mode: "busy" }));
    assert.equal(b.status, 403);
    assert.match(String(b.headers["www-authenticate"]), /insufficient_scope/);
    assert.equal((await post(port, ok({ Authorization: "" }), JSON.stringify({ mode: "busy" }))).status, 401);
    assert.equal(m.calls.length, 0);
    assert.deepEqual(sec.map((e) => e.event), ["api_auth_failed", "api_insufficient_scope", "api_auth_failed"]);
    assert.equal(JSON.stringify(sec).includes(expired.slice(0, 40)), false);
  });
});

test("Route: fehlender/ungültiger Key 400, falscher Content-Type 415, > 4 KiB 413, kaputtes JSON 400, Malicious Body 400", async () => {
  const m = mockStore({ kind: "created", pipeline: PIPE });
  await withApi(m.store, async (port) => {
    const body = JSON.stringify({ mode: "busy" });
    const h = ok();
    const { "Idempotency-Key": _k, ...noKey } = h;
    void _k;
    assert.equal((await post(port, noKey, body)).json.error, "idempotency_key_required");
    assert.equal((await post(port, ok({ "Idempotency-Key": "x' OR 1=1 --" }), body)).status, 400);
    assert.equal((await post(port, ok({ "Content-Type": "text/plain" }), body)).status, 415);
    assert.equal((await post(port, ok({ "Content-Type": "application/x-www-form-urlencoded" }), "mode=busy")).status, 415);
    assert.equal((await post(port, ok(), JSON.stringify({ mode: "busy", busyLabel: "x".repeat(5000) }))).status, 413);
    assert.equal((await post(port, ok(), "{\"mode\":")).json.error, "invalid_json");
    assert.equal((await post(port, ok(), '{"mode":"busy","__proto__":{"isAdmin":true}}')).json.error, "unknown_field:__proto__");
    assert.equal((await post(port, ok(), JSON.stringify({ mode: "busy", busyLabel: "‮exe" }))).json.error, "busyLabel_invalid_characters");
    assert.equal(m.calls.length, 0, "keine ungültige Anfrage erreicht den Store");
  });
});

test("Route: CORS – Preflight erlaubt Idempotency-Key nur für die Frontend-Domain", async () => {
  await withApi(mockStore({ kind: "created", pipeline: PIPE }).store, async (port, sec) => {
    const pre = await post(port, { "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type, idempotency-key" }, undefined, "OPTIONS");
    assert.equal(pre.status, 204);
    assert.match(String(pre.headers["access-control-allow-headers"]), /idempotency-key/i);
    assert.equal(pre.headers["access-control-allow-origin"], ORIGIN);
    const evil = await post(port, { Origin: "https://evil.example", "Access-Control-Request-Method": "POST" }, undefined, "OPTIONS");
    assert.equal(evil.headers["access-control-allow-origin"], undefined);
    assert.equal(evil.status, 403);
    assert.equal(sec.at(-1)?.event, "cors_origin_rejected");
  });
});

// ---------------------------------------------------------------------------------------------------
// Ziel (target): Allowlist nach der Sperre, Ziel gespeichert, Replay vergleicht das Ziel
// ---------------------------------------------------------------------------------------------------
test("Store: Ziel wird NACH Sperre + Nutzerprüfung gegen die Allowlist geprüft; Team-Postfach kommt aus der Config", async () => {
  const st = state();
  const r = await new PrismaPipelineStore(fakePrisma(st), 5, ids, ALLOW).createPipeline(input());
  assert.equal(r.kind, "created");
  assert.deepEqual(r.kind === "created" && r.pipeline.target, { kind: "team", label: "Vertrieb" });
  const row = st.pipelines[0] as unknown as Record<string, unknown>;
  assert.deepEqual([row.targetKind, row.targetMailbox, row.targetEntraTenantId, row.targetRef], ["team", "vertrieb@acme.example", null, "vertrieb"]);

  const linked = state();
  const acc = await new PrismaPipelineStore(fakePrisma(linked), 5, ids, ALLOW).createPipeline(input({
    target: { kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: LINKED } }));
  assert.deepEqual(acc.kind === "created" && acc.pipeline.target, { kind: "account", label: "Acme Tochter GmbH" });
  const lrow = linked.pipelines[0] as unknown as Record<string, unknown>;
  assert.deepEqual([lrow.targetKind, lrow.targetMailbox, lrow.targetEntraTenantId, lrow.targetRef], ["account", "max.muster@tochter.example", LINKED, null]);
});

test("Store: fremdes oder nicht freigegebenes Ziel → target_not_allowed, keine Pipeline, kein Job", async () => {
  const cases: Array<[CreatePipelineInput["target"], string, SyncAllowlist?]> = [
    [{ kind: "account", mailbox: "eva.chefin@tochter.example", entraTenantId: LINKED }, "not_same_person"],
    [{ kind: "account", mailbox: "max.muster@evil.example", entraTenantId: LINKED }, "domain_not_allowed"],
    [{ kind: "account", mailbox: "max.muster@tochter.example", entraTenantId: "aaaaaaaa-0000-0000-0000-000000000000" }, "tenant_not_linked"],
    [{ kind: "account", mailbox: "max.muster@acme.example", entraTenantId: null }, "target_is_source"],
    [{ kind: "account", mailbox: "irgendwer@gmail.com", entraTenantId: null }, "domain_not_allowed"],
    [{ kind: "account", mailbox: "max.muster@acme-alias.example", entraTenantId: null }, "own_mailboxes_not_configured", { ...ALLOW, ownDomains: [] }],
    [{ kind: "team", teamId: "geschaeftsfuehrung" }, "team_not_found"],
    [{ kind: "booking" }, "booking_disabled", { ...ALLOW, bookingEnabled: false }],
  ];
  for (const [target, reason, allow] of cases) {
    const st = state();
    const r = await new PrismaPipelineStore(fakePrisma(st), 5, ids, allow ?? ALLOW).createPipeline(input({ target }));
    assert.deepEqual(r, { kind: "target_not_allowed", reason }, JSON.stringify(target));
    assert.deepEqual([st.pipelines.length, st.jobs.length], [0, 0]);
    assert.deepEqual(st.calls.slice(0, 5), ["user.findFirst:any", "tx:ReadCommitted", "lock_timeout", "advisory_lock:acme/u-1", "user.findFirst:active"], "Prüfung erst nach der Sperre");
  }
  // ohne Allowlist (Default) ist gar nichts wählbar
  const none = state();
  assert.equal((await new PrismaPipelineStore(fakePrisma(none), 5, ids).createPipeline(input())).kind, "target_not_allowed");
});

test("Store: gleicher Key mit anderem Ziel → Konflikt; gleiches Ziel → Replay", async () => {
  const st = state();
  const store = new PrismaPipelineStore(fakePrisma(st), 5, ids, ALLOW);
  assert.equal((await store.createPipeline(input())).kind, "created");
  assert.equal((await store.createPipeline(input())).kind, "replayed");
  assert.equal((await store.createPipeline(input({ target: { kind: "booking" } }))).kind, "idempotency_conflict");
  assert.equal(st.pipelines.length, 1);
});

test("Route: target fehlt → 422 target_required, kaputtes target → 400, nicht erlaubt → 422 mit reason", async () => {
  const m = mockStore({ kind: "target_not_allowed", reason: "not_same_person" });
  await withApi(m.store, async (port) => {
    const missing = await post(port, ok(), JSON.stringify({ mode: "busy", busyLabel: "Termin" }));
    assert.deepEqual([missing.status, missing.json.error], [422, "target_required"]);
    for (const [target, error] of [
      ["team", "target_invalid"], [{ kind: "google" }, "target_kind_invalid"], [{ kind: "team" }, "target_team_id_invalid"],
      [{ kind: "team", teamId: "vertrieb", mailbox: "ceo@acme.example" }, "unknown_field:target.mailbox"],
      [{ kind: "account", mailbox: "x" }, "target_mailbox_invalid"], [{ kind: "account", mailbox: "a@b.de", entraTenantId: "nope" }, "target_entra_tenant_id_invalid"],
    ] as const) {
      const r = await post(port, ok(), JSON.stringify({ mode: "busy", target }));
      assert.deepEqual([r.status, r.json.error], [400, error], JSON.stringify(target));
    }
    assert.equal(m.calls.length, 0);
    const na = await post(port, ok(), JSON.stringify({ mode: "busy", target: { kind: "account", mailbox: "eva@tochter.example", entraTenantId: LINKED } }));
    assert.deepEqual([na.status, na.json], [422, { error: "target_not_allowed", reason: "not_same_person" }]);
    assert.deepEqual(m.calls[0]?.target, { kind: "account", mailbox: "eva@tochter.example", entraTenantId: LINKED });
  });
});

// ---------------------------------------------------------------------------------------------------
// Pipeline beenden: DELETE /api/v1/me/pipelines/{id}
// ---------------------------------------------------------------------------------------------------
test("Store: endPipeline – Sperre zuerst, nur eigene Pipeline, revoked + Bereinigung + Abo-Stopp + Jobs in EINER Transaktion", async () => {
  const st = state({
    pipelines: [
      { id: "mine", tenantId: "acme", ownerUserId: "u-1", status: "active", mode: "busy", busyLabel: null, idempotencyKey: null },
      { id: "other", tenantId: "acme", ownerUserId: "u-2", status: "active", mode: "busy", busyLabel: null, idempotencyKey: null },
    ],
    channels: [
      { tenantId: "acme", pipelineId: "mine", stopRequestedAt: null, stoppedAt: null },
      { tenantId: "acme", pipelineId: "zweite-eigene", stopRequestedAt: null, stoppedAt: null },
    ],
  });
  const store = new PrismaPipelineStore(fakePrisma(st), 5, ids, ALLOW);
  const r = await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-42", pipelineId: "mine" });
  assert.deepEqual(r, { kind: "ended", pipeline: { id: "mine", status: "revoked", cleanup: "pending" } });
  assert.deepEqual(st.calls, ["user.findFirst:any", "tx:ReadCommitted", "lock_timeout", "advisory_lock:acme/u-1", "user.findFirst:active",
    "pipeline.findFirst", "pipeline.updateMany", "channel.updateMany", "job.insert", "job.insert"]);
  const mine = st.pipelines[0] as unknown as Record<string, unknown>;
  assert.deepEqual([mine.status, mine.revokedReason, mine.cleanupRequestedAt instanceof Date], ["revoked", "user_ended", true]);
  assert.ok(st.channels![0].stopRequestedAt instanceof Date);
  assert.equal(st.channels![1].stopRequestedAt, null, "Abos anderer Pipelines bleiben");
  assert.deepEqual(st.jobs.map((j) => [j.kind, j.dedupeKey]), [["subscription.teardown", "teardown:u-1"], ["pipeline.target_cleanup", "cleanup:mine"]]);
  assert.deepEqual(JSON.parse(st.jobs[1].payload), { pipelineId: "mine" });

  const again = await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-42", pipelineId: "mine" });
  assert.deepEqual(again, { kind: "already_ended", pipeline: { id: "mine", status: "revoked", cleanup: "pending" } });
  assert.equal(st.jobs.length, 2);
  assert.deepEqual(await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-42", pipelineId: "other" }), { kind: "not_found" }, "fremde Pipeline");
  assert.equal(st.pipelines[1].status, "active");
  assert.deepEqual(await store.endPipeline({ tenantId: "acme", entraObjectId: "oid-x", pipelineId: "mine" }), { kind: "user_not_provisioned" });
});

test("Route: DELETE /me/pipelines/{id} → 202/200/404, nur mit Sync.Write, CORS erlaubt DELETE", async () => {
  const calls: unknown[] = [];
  const answers: EndPipelineResult[] = [
    { kind: "ended", pipeline: { id: "pl-1", status: "revoked", cleanup: "pending" } },
    { kind: "already_ended", pipeline: { id: "pl-1", status: "revoked", cleanup: "done" } },
    { kind: "not_found" },
    { kind: "user_not_provisioned" },
  ];
  const store: PipelineStore = { createPipeline: async () => ({ kind: "user_not_provisioned" }), endPipeline: async (i) => { calls.push(i); return answers.shift()!; } };
  await withApi(store, async (port) => {
    const del = (id: string, h: Record<string, string> = { Authorization: `Bearer ${tok()}` }) =>
      new Promise<{ status: number; json: Record<string, unknown> }>((resolve, reject) => {
        const r = request({ host: "127.0.0.1", port, method: "DELETE", path: `/api/v1/me/pipelines/${id}`, headers: { Origin: ORIGIN, ...h } }, (res) => {
          let t = "";
          res.on("data", (c) => (t += c));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, json: t ? JSON.parse(t) : {} }));
        });
        r.on("error", reject);
        r.end();
      });
    const a = await del("pl-1");
    assert.deepEqual([a.status, a.json], [202, { id: "pl-1", status: "revoked", cleanup: "pending" }]);
    assert.deepEqual(calls[0], { tenantId: "acme", entraObjectId: "oid-42", pipelineId: "pl-1" });
    assert.deepEqual([(await del("pl-1")).status], [200]);
    assert.deepEqual(Object.values(await del("pl-2")), [404, { error: "pipeline_not_found" }]);
    assert.deepEqual(Object.values(await del("pl-3")), [404, { error: "user_not_provisioned" }]);
    assert.equal((await del("x".repeat(65))).json.error, "pipeline_not_found");
    assert.equal((await del("pl-1", { Authorization: `Bearer ${tok({ scp: "Sync.Read" })}` })).status, 403);
    assert.equal((await del("pl-1", {})).status, 401);
    assert.equal(calls.length, 4, "ungültige ID / fehlender Scope erreichen den Store nicht");
    const pre = await post(port, { "Access-Control-Request-Method": "DELETE", "Access-Control-Request-Headers": "authorization" }, undefined, "OPTIONS");
    assert.equal(pre.status, 204);
    assert.match(String(pre.headers["access-control-allow-methods"]), /DELETE/);
  });
});
