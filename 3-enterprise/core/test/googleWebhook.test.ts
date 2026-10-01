import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGoogleWebhookListener,
  handleGoogleNotification,
  parseGoogleHeaders,
  InMemoryDelayedJobQueue,
  type GoogleChannel,
  type GoogleGuardDeps,
  type GoogleJob,
  type GoogleSecurityEvent,
} from "../src/index.js";

const NOW = Date.parse("2026-10-01T10:00:00Z");
const TOKEN = "tok_" + "a".repeat(39); // 43 Zeichen wie base64url(32 Bytes)

function channel(over: Partial<GoogleChannel> = {}): GoogleChannel {
  return {
    id: "c1", tenantId: "acme", userId: "u1", provider: "google", providerSubscriptionId: "chan-1",
    providerResourceId: "res-1", clientState: TOKEN, expiresAt: "2026-10-08T00:00:00Z",
    stopRequestedAt: null, stoppedAt: null, stopAttempts: 0, nextStopAttemptAt: null, lastStopError: null,
    pipelineId: "p1", pipelineStatus: "active", lastMessageNumber: null, ...over,
  };
}

/** Mock des Repos mit derselben Semantik wie das SQL (nur vorwärts, nur nicht gestoppt) */
function deps(ch: GoogleChannel | null, opts: { slowMs?: number; fail?: boolean } = {}) {
  const events: GoogleSecurityEvent[] = [];
  const jobs: Array<{ tenantId: string; job: GoogleJob | null; msg: number }> = [];
  const queue = new InMemoryDelayedJobQueue(() => NOW);
  const state = { ch };
  const d: GoogleGuardDeps = {
    queue,
    now: () => NOW,
    budgetMs: 100,
    securityEvent: (e) => events.push(e),
    repo: {
      findGoogleChannel: async (id) => {
        if (opts.fail) throw new Error("connection terminated");
        if (opts.slowMs) await new Promise((r) => setTimeout(r, opts.slowMs));
        return state.ch && state.ch.providerSubscriptionId === id ? { ...state.ch } : null;
      },
      acceptGoogleNotification: async (id, msg, tenantId, job) => {
        const c = state.ch;
        if (!c || c.id !== id || c.stoppedAt || c.stopRequestedAt || (c.lastMessageNumber !== null && msg <= c.lastMessageNumber)) return { fresh: false, queued: false };
        c.lastMessageNumber = msg;
        jobs.push({ tenantId, job, msg });
        return { fresh: true, queued: job !== null };
      },
    },
  };
  return { d, events, jobs, queue, state };
}

const hdr = (over: Record<string, string | undefined> = {}) => ({
  "x-goog-channel-id": "chan-1", "x-goog-channel-token": TOKEN, "x-goog-resource-id": "res-1",
  "x-goog-resource-state": "exists", "x-goog-message-number": "7", ...over,
});
const ctx = { requestId: "r1", sourceIp: "203.0.113.9" };
const parsed = (over: Record<string, string | undefined> = {}) => {
  const p = parseGoogleHeaders(hdr(over));
  assert.ok(p, "Header sollten gültig sein");
  return p;
};

// ---------------------------------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------------------------------
test("Google: exists → 200, Delta-Sync-Job, Message-Number fortgeschrieben", async () => {
  const { d, jobs, events, state } = deps(channel());
  const r = await handleGoogleNotification(parsed(), ctx, d);
  assert.deepEqual([r.status, r.outcome, r.jobQueued], [200, "accepted", true]);
  assert.deepEqual(jobs[0].job, { kind: "pipeline.delta_sync", dedupeKey: "delta:p1", payload: { pipelineId: "p1", full: false } });
  assert.equal(state.ch?.lastMessageNumber, 7);
  assert.equal(events.length, 0);
});

test("Google: sync (Channel-Bestätigung) → 200 ohne Job; not_exists → voller Resync", async () => {
  const a = deps(channel());
  const r1 = await handleGoogleNotification(parsed({ "x-goog-resource-state": "sync", "x-goog-message-number": "1" }), ctx, a.d);
  assert.deepEqual([r1.status, r1.outcome, r1.jobQueued, a.jobs[0].job], [200, "accepted", false, null]);
  const b = deps(channel());
  await handleGoogleNotification(parsed({ "x-goog-resource-state": "not_exists" }), ctx, b.d);
  assert.deepEqual(b.jobs[0].job?.payload, { pipelineId: "p1", full: true });
});

// ---------------------------------------------------------------------------------------------------
// Manipulierte Eingaben
// ---------------------------------------------------------------------------------------------------
test("Google: Header-Validierung lehnt Manipulation ab", () => {
  const bad: Array<Record<string, string | undefined>> = [
    { "x-goog-channel-id": undefined },
    { "x-goog-channel-id": "../../etc/passwd" },
    { "x-goog-channel-id": "x".repeat(65) },
    { "x-goog-channel-id": "chan-1'; DROP TABLE job_queue;--" },
    { "x-goog-channel-token": undefined },
    { "x-goog-channel-token": "kurz" },
    { "x-goog-channel-token": "a".repeat(257) },
    { "x-goog-channel-token": TOKEN + " \r\nX-Evil: 1" },
    { "x-goog-resource-id": "res 1" },
    { "x-goog-resource-state": "deleted" },
    { "x-goog-message-number": "0" },
    { "x-goog-message-number": "-5" },
    { "x-goog-message-number": "1e9" },
    { "x-goog-message-number": "99999999999999999999" },
    { "x-goog-channel-expiration": "kein Datum" },
  ];
  for (const b of bad) assert.equal(parseGoogleHeaders(hdr(b)), null, JSON.stringify(b));
  // doppelt gesendeter Header (Node liefert dann ein Array) → ungültig
  assert.equal(parseGoogleHeaders({ ...hdr(), "x-goog-channel-id": ["chan-1", "chan-2"] }), null);
  assert.ok(parseGoogleHeaders(hdr({ "x-goog-channel-expiration": "Tue, 06 Oct 2026 10:00:00 GMT" })));
});

test("Google: falsches Token, fremde Resource-ID, unbekannter Channel → einheitlich 200 + Sicherheitsereignis, kein Job", async () => {
  for (const [over, reason] of [
    [{ "x-goog-channel-token": "tok_" + "b".repeat(39) }, "token_mismatch"],
    [{ "x-goog-resource-id": "res-2" }, "resource_mismatch"],
    [{ "x-goog-channel-id": "chan-unbekannt" }, "unknown_channel"],
  ] as const) {
    const { d, jobs, events, state } = deps(channel());
    const r = await handleGoogleNotification(parsed(over), ctx, d);
    assert.deepEqual([r.status, r.outcome, r.reason], [200, "dropped", reason]);
    assert.equal(jobs.length, 0);
    assert.equal(state.ch?.lastMessageNumber, null, "Message-Number darf ohne gültiges Token nicht wandern");
    assert.equal(events[0]?.reason, reason);
    const logged = JSON.stringify(events);
    assert.equal(logged.includes(TOKEN), false, "Token nie im Log");
    assert.equal(logged.includes("chan-1"), false, "Channel-ID nur gehasht im Log");
  }
});

test("Google: Replay und veraltete Zustellung werden verworfen", async () => {
  const { d, jobs } = deps(channel({ lastMessageNumber: 10 }));
  for (const n of ["10", "3"]) {
    const r = await handleGoogleNotification(parsed({ "x-goog-message-number": n }), ctx, d);
    assert.equal(r.reason, "replay_or_stale");
  }
  assert.equal((await handleGoogleNotification(parsed({ "x-goog-message-number": "11" }), ctx, d)).outcome, "accepted");
  assert.equal(jobs.length, 1);
});

// ---------------------------------------------------------------------------------------------------
// Abgelaufen / gestoppt
// ---------------------------------------------------------------------------------------------------
test("Google: abgelaufener Channel (DB oder Header) → verworfen, kein Job", async () => {
  const a = deps(channel({ expiresAt: "2026-09-30T00:00:00Z" }));
  assert.equal((await handleGoogleNotification(parsed(), ctx, a.d)).reason, "channel_expired");
  const b = deps(channel());
  assert.equal((await handleGoogleNotification(parsed({ "x-goog-channel-expiration": "Wed, 30 Sep 2026 23:59:59 GMT" }), ctx, b.d)).reason, "channel_expired");
  assert.equal(a.jobs.length + b.jobs.length, 0);
});

test("Google: Offboarding (stop_requested / revoked) → nichts verarbeiten, Teardown-Job sicherstellen", async () => {
  const { d, jobs, queue } = deps(channel({ stopRequestedAt: "2026-10-01T09:00:00Z", pipelineStatus: "revoked" }));
  const r = await handleGoogleNotification(parsed(), ctx, d);
  assert.equal(r.reason, "channel_stopped_or_revoked");
  assert.equal(jobs.length, 0);
  assert.deepEqual([...queue.rows.values()].map((j) => [j.kind, j.dedupeKey]), [["subscription.teardown", "teardown:u1"]]);
});

// ---------------------------------------------------------------------------------------------------
// Timeout / Fehler
// ---------------------------------------------------------------------------------------------------
test("Google: DB langsamer als Budget → 503 (Google wiederholt), DB-Fehler → 503", async () => {
  const slow = deps(channel(), { slowMs: 400 });
  const t0 = Date.now();
  assert.equal((await handleGoogleNotification(parsed(), ctx, slow.d)).status, 503);
  assert.ok(Date.now() - t0 < 300);
  assert.equal((await handleGoogleNotification(parsed(), ctx, deps(channel(), { fail: true }).d)).status, 503);
});

// ---------------------------------------------------------------------------------------------------
// HTTP-Adapter
// ---------------------------------------------------------------------------------------------------
function call(port: number, method: string, headers: Record<string, string>, body?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path: "/webhooks/google",
      headers: { ...headers, ...(body !== undefined ? { "Content-Length": String(Buffer.byteLength(body)) } : {}) } }, (res) => {
      res.resume();
      res.on("end", () => resolve(res.statusCode ?? 0));
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("Google HTTP: 200, 405, 403 (Origin), 400, 413 – und Ablehnungen im Sicherheits-Log", async () => {
  const { d, events } = deps(channel());
  const srv = createServer((req, res) => void createGoogleWebhookListener(d)(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const port = (srv.address() as AddressInfo).port;
  try {
    assert.equal(await call(port, "POST", hdr()), 200);
    assert.equal(await call(port, "GET", hdr()), 405);
    assert.equal(await call(port, "POST", { ...hdr({ "x-goog-message-number": "8" }), Origin: "https://evil.example" }), 403);
    assert.equal(await call(port, "POST", hdr({ "x-goog-resource-state": "hacked" })), 400);
    assert.equal(await call(port, "POST", hdr({ "x-goog-message-number": "9" }), "x".repeat(2048)), 413);
    assert.deepEqual(events.map((e) => e.reason), ["method_not_allowed", "origin_header", "malformed_headers", "body_too_large"]);
  } finally {
    srv.close();
  }
});
