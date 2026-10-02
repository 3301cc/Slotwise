/**
 * Webhook-Eingang /webhooks/graph über echtes node:http (Listener aus webhookHttp.ts + Guard aus webhookGuard.ts):
 * Handshake, Annahme, unbefugte Payloads, Größenlimit (Stream), Pfadschutz, Zeitbudget und Alarm.
 *
 * Unbefugte Notifications (falscher/fehlender clientState, unbekannte Subscription) werden mit 202 quittiert und
 * VERWORFEN – bewusst kein 403: Graph wertet jede Nicht-2xx-Antwort als Fehlzustellung und stellt bis zu 4 h erneut zu,
 * und ein unterschiedlicher Status wäre ein Orakel zum Erraten des clientState. Geprüft wird deshalb, dass nichts
 * eingestellt und ein Sicherheitsereignis gemeldet wird. 404 kommt für unbekannte Pfade aus dem App-Server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createGraphWebhookListener,
  DEFAULT_BUDGET_MS,
  InMemoryDelayedJobQueue,
  isBadWebhookPath,
  type GuardChannel,
  type GuardDeps,
  type GuardRepo,
} from "../src/index.js";

const CS = "cs-geheim-0123456789";
const channel: GuardChannel = {
  id: "c1", tenantId: "acme", userId: "u1", provider: "microsoft", providerSubscriptionId: "sub-1", providerResourceId: null,
  clientState: CS, expiresAt: null, stopRequestedAt: null, stoppedAt: null, stopAttempts: 0, nextStopAttemptAt: null,
  lastStopError: null, pipelineId: "p1", pipelineStatus: "active",
};

interface Harness {
  port: number;
  queue: InMemoryDelayedJobQueue;
  security: unknown[];
  alerts: { kind: string; budgetMs: number; notifications: number; error?: string }[];
  pathEvents: string[];
  results: number[];
}

const knownRepo: GuardRepo = {
  findBySubscriptionIds: async (ids) => new Map(ids.filter((i) => i === "sub-1").map((i) => [i, channel] as const)),
  markStoppedMany: async () => {},
};

async function withServer(fn: (h: Harness) => Promise<void>, over: Partial<GuardDeps> = {}) {
  const h: Harness = { port: 0, queue: new InMemoryDelayedJobQueue(), security: [], alerts: [], pathEvents: [], results: [] };
  const listener = createGraphWebhookListener(
    {
      repo: knownRepo,
      queue: h.queue,
      securityEvent: (e) => h.security.push(e),
      alert: (e) => h.alerts.push(e),
      ...over,
    },
    { onSecurity: (e) => h.pathEvents.push(e), onResult: (s) => h.results.push(s) }, // Standardlimit 1 MiB
  );
  const srv = createServer((req, res) => void listener(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  h.port = (srv.address() as AddressInfo).port;
  try {
    await fn(h);
  } finally {
    await new Promise<void>((r) => srv.close(() => r()));
  }
}

interface Res { status: number; text: string; contentType: string | undefined }

function send(port: number, opts: { method?: string; path?: string; body?: string | Buffer; contentType?: string; chunked?: boolean }): Promise<Res> {
  return new Promise((resolve, reject) => {
    const body = opts.body ?? "";
    const headers: Record<string, string | number> = { "Content-Type": opts.contentType ?? "application/json" };
    if (!opts.chunked) headers["Content-Length"] = Buffer.byteLength(body);
    const r = request({ port, host: "127.0.0.1", method: opts.method ?? "POST", path: opts.path ?? "/webhooks/graph", headers }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text, contentType: res.headers["content-type"] }));
    });
    // Der Server darf früh antworten (413) und die Verbindung schließen – Schreibfehler sind dann erwartet
    r.on("error", (e: NodeJS.ErrnoException) => (e.code === "EPIPE" || e.code === "ECONNRESET" ? undefined : reject(e)));
    if (opts.chunked && Buffer.isBuffer(body)) {
      // in 64-KiB-Stücken senden, ohne Content-Length (Transfer-Encoding: chunked)
      for (let i = 0; i < body.length; i += 65_536) r.write(body.subarray(i, i + 65_536));
      r.end();
    } else {
      r.end(body);
    }
  });
}

const note = (o: Record<string, unknown> = {}) => JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState: CS, changeType: "updated", ...o }] });

// ---------------------------------------------------------------------------------------------------
// Handshake
// ---------------------------------------------------------------------------------------------------
test("Handshake: validationToken wird unverändert als text/plain mit 200 gespiegelt, Body ignoriert, nichts eingestellt", async () => {
  await withServer(async (h) => {
    const r = await send(h.port, { path: "/webhooks/graph?validationToken=Validation%3A%20Testing%20client%20application%20reachability", body: "kein json", contentType: "text/plain" });
    assert.equal(r.status, 200);
    assert.match(r.contentType ?? "", /^text\/plain/);
    assert.equal(r.text, "Validation: Testing client application reachability");
    assert.equal(h.queue.rows.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Happy Path
// ---------------------------------------------------------------------------------------------------
test("Happy Path: gültige Notification → 202, genau ein delta_sync-Job, leere Antwort", async () => {
  await withServer(async (h) => {
    const r = await send(h.port, { body: note() });
    assert.equal(r.status, 202);
    assert.equal(r.text, "");
    const jobs = [...h.queue.rows.values()];
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].kind, "pipeline.delta_sync");
    assert.deepEqual(jobs[0].payload, { pipelineId: "p1", full: false });
    assert.equal(h.security.length, 0);
  });
});

test("Happy Path: 200 Notifications derselben Subscription → ein Job (Dedupe), feste DB-Last", async () => {
  await withServer(async (h) => {
    const value = Array.from({ length: 200 }, () => ({ subscriptionId: "sub-1", clientState: CS, changeType: "updated" }));
    const r = await send(h.port, { body: JSON.stringify({ value }) });
    assert.equal(r.status, 202);
    assert.equal(h.queue.rows.size, 1);
  });
});

// ---------------------------------------------------------------------------------------------------
// Unbefugte Payloads
// ---------------------------------------------------------------------------------------------------
test("Unbefugt: falscher clientState → 202 ohne Inhalt, nichts eingestellt, Sicherheitsereignis", async () => {
  await withServer(async (h) => {
    const r = await send(h.port, { body: note({ clientState: "geraten" }) });
    assert.equal(r.status, 202);
    assert.equal(r.text, "");
    assert.equal(h.queue.rows.size, 0);
    assert.deepEqual(h.security, [{ kind: "client_state_mismatch", tenantId: "acme", channelId: "c1" }]);
  });
});

test("Unbefugt: fehlender clientState und clientState mit anderer Länge werden gleich behandelt", async () => {
  await withServer(async (h) => {
    for (const cs of [undefined, "", "x", CS + "-länger", CS.toUpperCase()]) {
      const r = await send(h.port, { body: note({ clientState: cs }) });
      assert.equal(r.status, 202, String(cs));
    }
    assert.equal(h.queue.rows.size, 0);
    assert.equal(h.security.length, 5);
  });
});

test("Unbefugt: unbekannte Subscription → 202 (kein Orakel), nichts eingestellt, kein Sicherheitsereignis", async () => {
  await withServer(async (h) => {
    const r = await send(h.port, { body: note({ subscriptionId: "fremd-123" }) });
    assert.equal(r.status, 202);
    assert.equal(h.queue.rows.size, 0);
    assert.equal(h.security.length, 0);
  });
});

test("Unbefugt: Batch aus gültig und gefälscht → nur der gültige Eintrag wird eingestellt", async () => {
  await withServer(async (h) => {
    const value = [{ subscriptionId: "sub-1", clientState: "falsch" }, { subscriptionId: "sub-1", clientState: CS }];
    const r = await send(h.port, { body: JSON.stringify({ value }) });
    assert.equal(r.status, 202);
    assert.equal(h.queue.rows.size, 1);
    assert.equal(h.security.length, 1);
  });
});

// ---------------------------------------------------------------------------------------------------
// Größe, Format, Methode
// ---------------------------------------------------------------------------------------------------
test("413: Content-Length über 1 MiB wird ohne Lesen des Bodys abgewiesen", async () => {
  await withServer(async (h) => {
    const big = Buffer.alloc(1024 * 1024 + 1, 0x20);
    const r = await send(h.port, { body: big });
    assert.equal(r.status, 413);
    assert.equal(h.queue.rows.size, 0);
  });
});

test("413: chunked Stream ohne Content-Length bricht beim Überschreiten von 1 MiB ab", async () => {
  await withServer(async (h) => {
    const big = Buffer.alloc(2 * 1024 * 1024, 0x20);
    const r = await send(h.port, { body: big, chunked: true });
    assert.equal(r.status, 413);
    assert.equal(h.queue.rows.size, 0);
  });
});

test("Genau 1 MiB ist erlaubt (Grenze inklusiv)", async () => {
  await withServer(async (h) => {
    const json = note();
    const pad = 1024 * 1024 - Buffer.byteLength(json);
    const body = json.slice(0, -1) + " ".repeat(pad) + "}";
    assert.equal(Buffer.byteLength(body), 1024 * 1024);
    const r = await send(h.port, { body });
    assert.equal(r.status, 202);
  });
});

test("400/415/405/413: kaputtes JSON, fehlendes value-Array, falscher Content-Type, GET, zu viele Notifications", async () => {
  await withServer(async (h) => {
    assert.equal((await send(h.port, { body: "{kaputt" })).status, 400);
    assert.equal((await send(h.port, { body: JSON.stringify({ value: "kein array" }) })).status, 400);
    assert.equal((await send(h.port, { body: note(), contentType: "text/plain" })).status, 415);
    assert.equal((await send(h.port, { method: "GET" })).status, 405);
    const many = JSON.stringify({ value: Array.from({ length: 1001 }, () => ({ subscriptionId: "sub-1", clientState: CS })) });
    assert.equal((await send(h.port, { body: many })).status, 413);
    assert.equal(h.queue.rows.size, 0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Pfadschutz
// ---------------------------------------------------------------------------------------------------
test("400: Path-Traversal und doppelte Slashes werden vor jeder Verarbeitung abgewiesen, Sicherheitsereignis", async () => {
  await withServer(async (h) => {
    for (const path of ["/webhooks/../api/v1/me/sync-status", "//webhooks/graph", "/webhooks//graph", "/webhooks/%2e%2e/api", "/webhooks/graph/..", "/webhooks/graph%2f..%2fapi"]) {
      const r = await send(h.port, { path, body: note() });
      assert.equal(r.status, 400, path);
    }
    assert.equal(h.pathEvents.length, 6);
    assert.equal(h.queue.rows.size, 0);
  });
});

test("Pfadschutz prüft nur den Pfad: '//' im Query (z. B. im validationToken) ist erlaubt", async () => {
  assert.equal(isBadWebhookPath("/webhooks/graph?validationToken=a//b/../c"), false);
  assert.equal(isBadWebhookPath("/webhooks/graph"), false);
  assert.equal(isBadWebhookPath("/webhooks/./graph"), true);
  await withServer(async (h) => {
    const r = await send(h.port, { path: "/webhooks/graph?validationToken=a%2F%2Fb", body: "" });
    assert.equal(r.status, 200);
    assert.equal(r.text, "a//b");
  });
});

// ---------------------------------------------------------------------------------------------------
// Zeitbudget und Alarm
// ---------------------------------------------------------------------------------------------------
const slowRepo = (ms: number): GuardRepo => ({
  findBySubscriptionIds: () => new Promise((r) => setTimeout(() => r(new Map([["sub-1", channel]])), ms)),
  markStoppedMany: async () => {},
});

test("Zeitbudget: Standard ist 2,2 s; langsame DB → 503 nach ~2,2 s und Alarm webhook_enqueue_timeout", async () => {
  assert.equal(DEFAULT_BUDGET_MS, 2_200);
  await withServer(async (h) => {
    const t0 = performance.now();
    const r = await send(h.port, { body: note() });
    const ms = performance.now() - t0;
    assert.equal(r.status, 503);
    assert.ok(ms >= 2_150 && ms < 2_700, `Antwort nach ${Math.round(ms)} ms`);
    assert.deepEqual(h.alerts, [{ kind: "webhook_enqueue_timeout", budgetMs: 2_200, notifications: 1 }]);
  }, { repo: slowRepo(3_000) });
});

test("Zeitbudget: konfigurierbar (budgetMs), schnelle DB bleibt darunter → 202 ohne Alarm", async () => {
  await withServer(async (h) => {
    assert.equal((await send(h.port, { body: note() })).status, 202);
    assert.equal(h.alerts.length, 0);
  }, { repo: slowRepo(20), budgetMs: 500 });
  await withServer(async (h) => {
    assert.equal((await send(h.port, { body: note() })).status, 503);
    assert.equal(h.alerts[0].kind, "webhook_enqueue_timeout");
  }, { repo: slowRepo(400), budgetMs: 50 });
});

test("DB-Fehler beim Enqueue → 503 und Alarm webhook_enqueue_failed nur mit Fehlercode, ohne Meldungstext", async () => {
  const failingQueue = { enqueueMany: async () => { throw Object.assign(new Error("connection to 10.0.1.5 refused for user calensync_app"), { code: "ECONNREFUSED" }); } };
  await withServer(async (h) => {
    const r = await send(h.port, { body: note() });
    assert.equal(r.status, 503);
    assert.deepEqual(h.alerts, [{ kind: "webhook_enqueue_failed", budgetMs: 2_200, notifications: 1, error: "ECONNREFUSED" }]);
    assert.ok(!JSON.stringify(h.alerts).includes("10.0.1.5"));
  }, { queue: failingQueue });
});

test("Ein Fehler im Alarm-Hook ändert die Antwort an Graph nicht", async () => {
  await withServer(async (h) => {
    assert.equal((await send(h.port, { body: note() })).status, 503);
  }, { repo: slowRepo(400), budgetMs: 50, alert: () => { throw new Error("Logger kaputt"); } });
});
