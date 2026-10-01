/**
 * Lasttest-Server für den Webhook-Eingang (nur CI / lokal, NICHT Produktion – dort IAM-Pool aus dbAuth.ts).
 * Startet den echten Produktionspfad createGraphWebhookListener mit echtem pg-Pool und einem Worker,
 * der die Queue nebenher leert. Beim Beenden (SIGTERM) schreibt er Spitzen-RSS und Pool-Kennzahlen.
 *
 *   DATABASE_URL=postgres://qa:qa@localhost:5432/webhookbench PORT=8099 node dist/bench/webhook-ingress/server.js
 */
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import pg from "pg";
import { createGraphWebhookListener, PgChannelRepo, PgDelayedJobQueue, type GuardStats } from "../../src/index.js";

const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL fehlt");
const pool = new pg.Pool({ connectionString: url, max: Number(process.env.POOL_MAX ?? 20) });
pool.on("error", (e) => console.error("pg-Pool", e.message));

const repo = new PgChannelRepo(pool);
const queue = new PgDelayedJobQueue(pool);
const counts = { requests: 0, s202: 0, s503: 0, other: 0, notificationsAccepted: 0, dbRoundtrips: 0 };
const onResult = (status: number, _ms: number, stats: GuardStats | null) => {
  counts.requests += 1;
  if (status === 202) counts.s202 += 1;
  else if (status === 503) counts.s503 += 1;
  else counts.other += 1;
  if (stats) {
    counts.notificationsAccepted += stats.accepted;
    counts.dbRoundtrips += stats.dbRoundtrips;
  }
};
const listener = createGraphWebhookListener({ repo, queue, securityEvent: () => {} }, { onResult });
const server = createServer({ keepAliveTimeout: 65_000 }, (req, res) => void listener(req, res));
server.listen(Number(process.env.PORT ?? 8099), () => console.log("ready"));

let stop = false;
const worker = (async () => {
  while (!stop) {
    const jobs = await queue.claimDue("ci-worker", 50, 60_000, ["pipeline.delta_sync", "subscription.teardown"]);
    for (const j of jobs) await queue.complete(j.id, "ci-worker");
    if (jobs.length === 0) await new Promise((r) => setTimeout(r, 20));
  }
})();

process.on("SIGTERM", () => {
  stop = true;
  const hwm = /VmHWM:\s+(\d+)/.exec(readFileSync("/proc/self/status", "utf8"))?.[1] ?? "?";
  const roundtripsPerRequest = counts.s202 > 0 ? (counts.dbRoundtrips / counts.s202).toFixed(2) : "n/a";
  console.log(JSON.stringify({ ...counts, roundtripsPerRequest, maxRssKb: Number(hwm) }));
  server.close();
  void worker.finally(() => pool.end().then(() => process.exit(0)));
});
