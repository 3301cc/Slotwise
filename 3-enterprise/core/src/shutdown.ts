/**
 * Graceful Shutdown für ECS-Rolling-Deployments.
 *
 * Ablauf bei einem Task-Stopp durch ECS:
 *   1. ECS meldet den Task am ALB ab; der ALB schickt keine NEUEN Requests mehr und wartet
 *      deregistration_delay (60 s) auf laufende Requests.
 *   2. Danach SIGTERM an den Container → dieser Handler:
 *        a) Worker nehmen keine neuen Jobs mehr an
 *        b) laufende Jobs dürfen fertig werden (Lease-basiert: was nicht fertig wird, holt ein anderer Task
 *           nach Lease-Ablauf – kein Jobverlust)
 *        c) HTTP-Server schließt, DB-Pool wird beendet
 *   3. Nach stopTimeout (120 s, ecs.tf) SIGKILL. Unser Budget liegt mit 100 s darunter.
 */
import type { Server } from "node:http";

export interface Drainable {
  stop(): void;
  drained(): Promise<void>;
}

export interface ShutdownDeps {
  server: Pick<Server, "close"> & { closeIdleConnections?: () => void };
  workers: Drainable[];
  closePool: () => Promise<void>;
  log: (msg: string) => void;
  budgetMs?: number;
  exit?: (code: number) => void;
}

export function installGracefulShutdown(d: ShutdownDeps): () => Promise<void> {
  let started = false;
  const budget = d.budgetMs ?? 100_000;
  const exit = d.exit ?? ((c: number) => process.exit(c));

  const shutdown = async () => {
    if (started) return;
    started = true;
    d.log(`SIGTERM: Drain gestartet (Budget ${budget} ms)`);
    const hardStop = setTimeout(() => {
      d.log("Drain-Budget überschritten – offene Jobs gehen per Lease-Ablauf an andere Tasks");
      exit(0);
    }, budget);
    hardStop.unref?.();

    for (const w of d.workers) w.stop();
    const serverClosed = new Promise<void>((resolve) => d.server.close(() => resolve()));
    d.server.closeIdleConnections?.();
    await Promise.allSettled([...d.workers.map((w) => w.drained()), serverClosed]);
    await d.closePool().catch(() => undefined);
    clearTimeout(hardStop);
    d.log("Drain abgeschlossen");
    exit(0);
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
  return shutdown;
}
