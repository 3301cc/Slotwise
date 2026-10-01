/**
 * HTTP-Adapter für den Graph-Webhook auf node:http – ohne Framework-Overhead im heißesten Pfad.
 *
 *   POST /webhooks/graph?validationToken=…   → 200 text/plain (Validierung)
 *   POST /webhooks/graph  {value:[…]}         → 202 | 400 | 413 | 415 | 503
 *
 * Speicher: Der Body wird als Stream gelesen und hart begrenzt (Default 1 MiB). Wird die Grenze überschritten,
 * bricht der Adapter sofort mit 413 ab, ohne den Rest zu puffern. Am Ende genau ein Buffer.concat + JSON.parse.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleGraphWebhook, type GuardDeps, type GuardStats } from "./webhookGuard.js";

export interface WebhookHttpOptions {
  maxBodyBytes?: number;
  /** Metrik-Hook, z. B. Prometheus/CloudWatch EMF */
  onResult?: (status: number, durationMs: number, stats: GuardStats | null) => void;
}

function finish(res: ServerResponse, status: number, contentType?: string, body?: string): void {
  if (res.headersSent) return;
  if (body !== undefined) {
    res.writeHead(status, { "Content-Type": contentType ?? "text/plain", "Content-Length": Buffer.byteLength(body) });
    res.end(body);
  } else {
    res.writeHead(status, { "Content-Length": 0 });
    res.end();
  }
}

/** Liest den Body mit Größenlimit. null = Limit überschritten (Verbindung wird nicht weiter gelesen). */
function readBody(req: IncomingMessage, limit: number): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers["content-length"] ?? "0");
    if (declared > limit) {
      req.resume(); // Rest verwerfen, nicht puffern
      resolve(null);
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let done = false;
    req.on("data", (c: Buffer) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        chunks.length = 0;
        req.resume();
        resolve(null);
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => {
      if (!done) {
        done = true;
        resolve(chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, size));
      }
    });
    req.on("error", (e) => {
      if (!done) {
        done = true;
        reject(e);
      }
    });
  });
}

export function createGraphWebhookListener(deps: GuardDeps, opts: WebhookHttpOptions = {}) {
  const limit = opts.maxBodyBytes ?? 1024 * 1024;
  return async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const t0 = performance.now();
    let stats: GuardStats | null = null;
    let status = 500;
    try {
      if (req.method !== "POST") {
        status = 405;
        return finish(res, status);
      }
      const q = req.url ? req.url.indexOf("?") : -1;
      const query: Record<string, string | undefined> = {};
      if (q >= 0) {
        const params = new URLSearchParams(req.url!.slice(q + 1));
        const vt = params.get("validationToken");
        if (vt !== null) query.validationToken = vt;
      }
      if (query.validationToken) {
        // Validierung: Body ignorieren, Token sofort zurück
        req.resume();
        const r = await handleGraphWebhook({ query, body: null }, deps);
        status = r.status;
        return finish(res, r.status, r.contentType, r.body);
      }
      const ct = req.headers["content-type"] ?? "";
      if (!ct.startsWith("application/json")) {
        req.resume();
        status = 415;
        return finish(res, status);
      }
      const buf = await readBody(req, limit);
      if (buf === null) {
        status = 413;
        return finish(res, status);
      }
      let body: unknown;
      try {
        body = JSON.parse(buf.toString("utf8"));
      } catch {
        status = 400;
        return finish(res, status);
      }
      const r = await handleGraphWebhook({ query, body }, deps);
      stats = r.stats;
      status = r.status;
      return finish(res, r.status, r.contentType, r.body);
    } catch {
      status = 503; // nichts quittiert → Graph stellt erneut zu
      return finish(res, status);
    } finally {
      opts.onResult?.(status, performance.now() - t0, stats);
    }
  };
}
