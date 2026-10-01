import { test } from "node:test";
import assert from "node:assert/strict";
import { createLogger, sanitize } from "../src/index.js";

const fixed = () => new Date("2026-10-01T10:00:00.000Z");
function capture(maxBuffered?: number) {
  const writes: string[] = [];
  const log = createLogger({ service: "test", tenantId: "acme", write: (c) => writes.push(c), now: fixed, maxBuffered, flushOnExit: false });
  const lines = () => writes.join("").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
  return { log, writes, lines };
}
const tick = () => new Promise((r) => setImmediate(r));

test("Logger: Secrets und PII werden geschwärzt – per Schlüssel und im Freitext", async () => {
  const { log, lines } = capture();
  log.info("req", {
    authorization: "Bearer abc.def.ghi", headers: { cookie: "s=1", "x-goog-channel-token": "tok", accept: "json" },
    clientState: "geheim", userName: "max@acme.example", nested: { password: "pw", ok: 1 },
    note: "Token eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiIxIn0.c2lnbmF0dXJl und Bearer abcdefghijkl1234 von max@acme.example",
  });
  await tick();
  const [l] = lines();
  const s = JSON.stringify(l);
  for (const leak of ["abc.def.ghi", "s=1", "tok\"", "geheim", "max@acme.example", "\"pw\"", "eyJhbGci", "abcdefghijkl1234"]) {
    assert.equal(s.includes(leak), false, `Leck: ${leak}`);
  }
  assert.match(String(l.note), /\[jwt\].*Bearer \[redacted\].*\[email\]/);
  assert.equal((l.headers as Record<string, unknown>).accept, "json");
  assert.deepEqual([l.level, l.service, l.tenant, l.t], ["info", "test", "acme", "2026-10-01T10:00:00.000Z"]);
});

test("Logger: Größe je Zeile begrenzt (String, Tiefe, Schlüssel, Arrays)", () => {
  const deep = { a: { b: { c: { d: { e: 1 } } } } };
  const out = sanitize({ s: "x".repeat(2000), deep, arr: Array.from({ length: 50 }, (_, i) => i),
    many: Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i])) }) as Record<string, unknown>;
  assert.ok(String(out.s).length < 600);
  assert.equal(JSON.stringify(out.deep).includes("[depth]"), true);
  assert.equal((out.arr as unknown[]).length, 21);
  assert.equal(Object.keys(out.many as object).length, 41);
  assert.deepEqual(sanitize(new Error("Bearer abcdefghijklmnop")), { name: "Error", message: "Bearer [redacted]" });
});

test("Logger: viele Zeilen in einem Tick → genau EIN write, nicht synchron im Aufrufer", async () => {
  const { log, writes, lines } = capture();
  for (let i = 0; i < 500; i++) log.info("x", { i });
  assert.equal(writes.length, 0, "kein synchroner write im heißen Pfad");
  await tick();
  assert.equal(writes.length, 1);
  assert.equal(lines().length, 500);
});

test("Logger: Puffer begrenzt, Überlauf wird gezählt statt Speicher zu fressen", async () => {
  const { log, lines } = capture(10);
  for (let i = 0; i < 25; i++) log.info("x", { i });
  await tick();
  const ls = lines();
  assert.equal(ls.length, 11);
  assert.deepEqual([ls[10].msg, ls[10].count], ["log_lines_dropped", 15]);
});

test("Logger: Sicherheitsereignis mit festen Feldern über child()", async () => {
  const { log, lines } = capture();
  log.child({ requestId: "r-1", ip: "203.0.113.9" }).security("api_auth_failed", { code: "token_expired", authorization: "Bearer x.y.z" });
  log.debug("unsichtbar");
  await tick();
  const ls = lines();
  assert.equal(ls.length, 1, "debug unter minLevel info");
  assert.deepEqual([ls[0].level, ls[0].event, ls[0].requestId, ls[0].code, ls[0].authorization], ["security", "api_auth_failed", "r-1", "token_expired", "[redacted]"]);
});
