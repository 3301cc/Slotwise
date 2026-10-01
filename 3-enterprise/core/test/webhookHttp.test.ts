import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import type { AddressInfo } from "node:net";
import { createGraphWebhookListener, InMemoryDelayedJobQueue, type GuardChannel } from "../src/index.js";

const ch = {
  id: "c1", tenantId: "acme", userId: "u1", provider: "microsoft", providerSubscriptionId: "sub-1", providerResourceId: null,
  clientState: "cs-1", expiresAt: null, stopRequestedAt: null, stoppedAt: null, stopAttempts: 0, nextStopAttemptAt: null,
  lastStopError: null, pipelineId: "p1", pipelineStatus: "active",
} satisfies GuardChannel;

async function withServer(fn: (port: number, queue: InMemoryDelayedJobQueue) => Promise<void>) {
  const queue = new InMemoryDelayedJobQueue();
  const listener = createGraphWebhookListener(
    {
      queue,
      securityEvent: () => {},
      repo: {
        findBySubscriptionIds: async (ids) => new Map(ids.filter((i) => i === "sub-1").map((i) => [i, ch] as const)),
        markStoppedMany: async () => {},
      },
    },
    { maxBodyBytes: 4096 },
  );
  const srv = createServer((req, res) => void listener(req, res));
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  try {
    await fn((srv.address() as AddressInfo).port, queue);
  } finally {
    srv.close();
  }
}

function post(port: number, path: string, body: string, contentType = "application/json"): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ port, host: "127.0.0.1", method: "POST", path, headers: { "Content-Type": contentType, "Content-Length": Buffer.byteLength(body) } }, (res) => {
      let text = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

test("HTTP: Validierung, 202 mit Job, 415, 400, 413 bei zu großem Body", async () => {
  await withServer(async (port, queue) => {
    assert.deepEqual(await post(port, "/webhooks/graph?validationToken=a%20b%2Bc", ""), { status: 200, text: "a b+c" });
    const ok = await post(port, "/webhooks/graph", JSON.stringify({ value: [{ subscriptionId: "sub-1", clientState: "cs-1" }] }));
    assert.equal(ok.status, 202);
    assert.equal(queue.rows.size, 1);
    assert.equal((await post(port, "/webhooks/graph", "x", "text/plain")).status, 415);
    assert.equal((await post(port, "/webhooks/graph", "{kaputt")).status, 400);
    assert.equal((await post(port, "/webhooks/graph", JSON.stringify({ value: [], pad: "x".repeat(5000) }))).status, 413);
  });
});
