/**
 * End-to-end demo of the voice ⇄ calendar contract.
 *
 *   pnpm demo:call                       mock mode — no telephony, no Next.js, no Postgres
 *   DEMO_BASE_URL=http://localhost:3000 pnpm demo:call
 *                                        live mode — same flow against the running app (seeded DB)
 *
 * Mock mode starts a tiny HTTP server that guards requests exactly like
 * production (lib/hmac.ts: middleware-equivalent signature check, body hash,
 * nonce replay) and serves the same internal API over the in-memory repo.
 * The client side is what apps/voice does during a call.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { BODY_HASH_HEADER, signRequest, verifyBody, verifySignature } from "../apps/web/src/lib/hmac";
import { DEMO_CALLER, DEMO_NUMBER, MemoryRepo, VoiceServiceError, VoiceToolService, demoSeed, maskPhone } from "../packages/core/src/index";

const SECRET = process.env.INTERNAL_SHARED_SECRET ?? "demo-secret-demo-secret-demo-secret-0000";
const LIVE = process.env.DEMO_BASE_URL;
const NOW = new Date("2026-09-29T07:41:00Z"); // 09:41 Europe/Berlin — same moment as the mockup

// ── mock server: the internal voice API over the in-memory repo ───────────────
const repo = new MemoryRepo(demoSeed());
const svc = new VoiceToolService(repo, { now: () => NOW });

async function route(method: string, path: string, body: unknown, query: URLSearchParams): Promise<[number, unknown]> {
  const b = (body ?? {}) as Record<string, never>;
  if (method === "POST" && path === "/api/internal/voice/session") return [201, await svc.startSession(b)];
  if (method === "POST" && path === "/api/internal/voice/availability") return [200, await svc.checkAvailability(b)];
  if (method === "POST" && path === "/api/internal/voice/bookings") {
    const r = await svc.bookAppointment(b);
    return [r.alreadyExisted ? 200 : 201, r];
  }
  if (method === "GET" && path === "/api/internal/voice/bookings") {
    return [200, await svc.findBookings({ interactionId: query.get("interactionId") ?? "", ...(query.get("phone") ? { phone: query.get("phone")! } : {}) })];
  }
  const patch = path.match(/^\/api\/internal\/voice\/bookings\/([^/]+)$/);
  if (method === "PATCH" && patch) {
    const p = b as { action: string; interactionId: string; startsAt?: string; reason?: string };
    return [
      200,
      p.action === "reschedule"
        ? await svc.rescheduleBooking({ interactionId: p.interactionId, bookingId: patch[1]!, startsAt: p.startsAt! })
        : await svc.cancelBooking({ interactionId: p.interactionId, bookingId: patch[1]!, ...(p.reason ? { reason: p.reason } : {}) }),
    ];
  }
  const end = path.match(/^\/api\/internal\/voice\/session\/([^/]+)\/end$/);
  if (method === "POST" && end) return [200, await svc.endSession(end[1]!, b)];
  return [404, { error: { code: "NOT_FOUND", message: path } }];
}

const seenNonces = new Set<string>();
const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  // Same guard as production: signature (middleware) → body hash + nonce (internalRoute)
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(data));
  };
  const sig = await verifySignature(SECRET, { authorization: req.headers.authorization ?? null, bodySha256: (req.headers[BODY_HASH_HEADER] as string) ?? null }, method, url.pathname);
  if (!sig.ok) return send(401, { error: { code: "UNAUTHORIZED", message: `Signature rejected: ${sig.reason}` } });
  if (!(await verifyBody(raw, sig.bodySha256))) return send(401, { error: { code: "UNAUTHORIZED", message: "Signature rejected: body hash mismatch" } });
  if (seenNonces.has(sig.nonce)) return send(401, { error: { code: "UNAUTHORIZED", message: "Signature rejected: replay" } });
  seenNonces.add(sig.nonce);
  try {
    const [status, data] = await route(method, url.pathname, raw ? JSON.parse(raw) : undefined, url.searchParams);
    send(status, data);
  } catch (e) {
    if (e instanceof VoiceServiceError) return send(e.status, { error: { code: e.code, message: e.message } });
    send(500, { error: { code: "INTERNAL", message: String(e) } });
  }
});

// ── client: what apps/voice does during a call ────────────────────────────────
async function call<T>(base: string, method: string, path: string, body?: unknown): Promise<T> {
  const raw = body ? JSON.stringify(body) : "";
  const headers = await signRequest(SECRET, method, path.split("?")[0]!, raw);
  const res = await fetch(base + path, {
    method,
    headers: { ...headers, "content-type": "application/json" },
    body: raw || undefined,
  });
  const data = (await res.json()) as T & { error?: { code: string; message: string } };
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${data.error?.code}: ${data.error?.message}`);
  return data;
}

const log = (who: "caller" | "assistant" | "tool", text: string) => {
  const tag = { caller: "  Caller   ", assistant: "  Assistant", tool: "  ⚙ tool   " }[who];
  console.log(`${tag} │ ${text}`);
};

async function main() {
  let base = LIVE ?? "";
  if (!LIVE) {
    await new Promise<void>((r) => server.listen(0, r));
    const { port } = server.address() as { port: number };
    base = `http://127.0.0.1:${port}`;
  }
  console.log(`\n${LIVE ? "live" : "mock"} internal API on ${base}  (HMAC-SHA256 with INTERNAL_SHARED_SECRET)\n`);

  // Unauthenticated probe first: must be rejected before any handler runs.
  const probe = await fetch(`${base}/api/internal/voice/session`, { method: "POST", body: "{}", headers: { "content-type": "application/json" } });
  log("tool", `unauthenticated POST /session → ${probe.status} ${(await probe.json().catch(() => ({}))).error?.message ?? ""}`);
  if (probe.status !== 401) throw new Error("guard failure: expected 401 for unsigned request");

  console.log(`☎  Incoming call ${maskPhone(DEMO_CALLER)} → ${DEMO_NUMBER}\n`);

  type Session = { interactionId: string; agent: { greeting: string }; eventTypes: Array<{ slug: string; title: string }>; org: { name: string } };
  const s = await call<Session>(base, "POST", "/api/internal/voice/session", { callSid: "CA_demo_live", from: DEMO_CALLER, to: DEMO_NUMBER });
  log("tool", `session → ${s.interactionId} · event types: ${s.eventTypes.map((e) => e.slug).join(", ")}`);
  log("assistant", s.agent.greeting);
  log("caller", "Ich hätte gern diese Woche noch eine Demo, am liebsten vormittags.");

  type Avail = { slots: Array<{ start: string; spoken: string }> };
  const a = await call<Avail>(base, "POST", "/api/internal/voice/availability", {
    interactionId: s.interactionId,
    eventTypeSlug: "demo-call",
    from: "2026-09-29",
    to: "2026-10-02",
    preferred: "morning",
    max: 2,
  });
  log("tool", `check_availability → ${a.slots.map((x) => x.spoken).join(" | ")}`);
  log("assistant", `Ich habe ${a.slots[0]!.spoken} Uhr oder ${a.slots[1]!.spoken} Uhr frei. Was passt Ihnen?`);
  log("caller", "Der erste Termin passt. Mein Name ist Lena Hoffmann.");
  log("assistant", "Gern. Zwei kurze Fragen noch: Für welche Firma rufen Sie an, und wie viele Mitarbeitende haben Sie?");
  log("caller", "Müller GmbH, wir sind etwa zwanzig Leute.");

  type Booked = { id: string; spoken: string; hostUserId: string; alreadyExisted: boolean };
  const b = await call<Booked>(base, "POST", "/api/internal/voice/bookings", {
    interactionId: s.interactionId,
    eventTypeSlug: "demo-call",
    startsAt: a.slots[0]!.start,
    attendee: { name: "Lena Hoffmann", note: "Demo diese Woche, vormittags" },
    answers: { company: "Müller GmbH", employees: "10-49" }, // required questions of the event type
  });
  log("tool", `book_appointment → ${b.id} (${b.spoken}) · routed to ${b.hostUserId} (round-robin: Jana / Mehdi / Lena)`);
  log("assistant", `Gebucht: Demo call am ${b.spoken} Uhr mit ${s.org.name}. Sie bekommen gleich eine SMS-Bestätigung. Auf Wiederhören!`);

  // The same slot again in the same call → idempotent, no double booking.
  const again = await call<Booked>(base, "POST", "/api/internal/voice/bookings", {
    interactionId: s.interactionId,
    eventTypeSlug: "demo-call",
    startsAt: a.slots[0]!.start,
    attendee: { name: "Lena Hoffmann" },
    answers: { company: "Müller GmbH", employees: "10-49" },
  });
  log("tool", `book_appointment (retry) → alreadyExisted=${again.alreadyExisted}`);

  // Two more callers want the same slot: round-robin hands them to the other free team members …
  const other = await call<Session>(base, "POST", "/api/internal/voice/session", { callSid: "CA_other", from: "+49 40 3311 6464", to: DEMO_NUMBER });
  const third = await call<Session>(base, "POST", "/api/internal/voice/session", { callSid: "CA_third", from: "+49 89 2153 0707", to: DEMO_NUMBER });
  for (const [sess, name] of [[other, "Someone Else"], [third, "Third Caller"]] as const) {
    await call<Booked>(base, "POST", "/api/internal/voice/bookings", {
      interactionId: sess.interactionId,
      eventTypeSlug: "demo-call",
      startsAt: a.slots[0]!.start,
      attendee: { name },
      answers: { company: "Beispiel AG", employees: "1-9" },
    })
      .then((r) => log("tool", `${name}, same slot → routed to ${r.hostUserId}`))
      .catch((e: Error) => log("tool", `${name}, same slot → ${e.message.split("→")[1]?.trim()}`));
  }
  // … and when the pool is exhausted, the next one gets SLOT_TAKEN.
  const fourth = await call<Session>(base, "POST", "/api/internal/voice/session", { callSid: "CA_fourth", from: "+49 221 555 0101", to: DEMO_NUMBER });
  await call(base, "POST", "/api/internal/voice/bookings", {
    interactionId: fourth.interactionId,
    eventTypeSlug: "demo-call",
    startsAt: a.slots[0]!.start,
    attendee: { name: "Fourth Caller" },
    answers: { company: "Beispiel AG", employees: "1-9" },
  }).catch((e: Error) => log("tool", `fourth caller, same slot → ${e.message.split("→")[1]?.trim()}`));

  await call(base, "POST", `/api/internal/voice/session/${s.interactionId}/end`, {
    outcome: "BOOKED",
    durationSec: 112,
    summary: `Caller requested a demo this week. Booked ${b.spoken} with Jana. Confirmation sent via SMS.`,
    language: "de",
    transcript: [{ role: "user", text: "…" }], // dropped: agent.storeTranscripts = false
  });

  if (LIVE) {
    console.log("\nlive run complete — open the dashboard to see the feed card.\n");
    return;
  }
  const i = (await repo.getInteraction(s.interactionId))!;
  console.log("\n┌─ Live AI Agent Feed ──────────────────────────────────────────────");
  console.log(`│ Inbound call · ${maskPhone(i.fromNumber)}                       ${NOW.toISOString().slice(11, 16)} UTC`);
  console.log(`│ Status: ${i.outcome}   ${Math.floor((i.durationSec ?? 0) / 60)}m ${(i.durationSec ?? 0) % 60}s`);
  console.log(`│ ${i.summary}`);
  console.log(`│ transcript stored: ${i.transcript ? "yes" : "no"} · tool calls audited: ${i.toolCalls.map((t) => `${t.tool}${t.ok ? "" : "✗"}`).join(", ")}`);
  console.log("└───────────────────────────────────────────────────────────────────\n");

  if (!LIVE) server.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
