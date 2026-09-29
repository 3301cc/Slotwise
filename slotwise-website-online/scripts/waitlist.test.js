"use strict";
// node --test scripts/waitlist.test.js
const test = require("node:test");
const assert = require("node:assert");
const path = require("node:path");

delete process.env.VERCEL;
const LIB = path.join(__dirname, "..", "api", "_lib", "waitlist.js");
const W = require(LIB);

test("E-Mail-Validierung", () => {
  for (const ok of ["a@b.de", "Max.Mustermann@Firma-GmbH.de", " x+tag@sub.example.co.uk "]) assert.ok(W.normalizeEmail(ok), ok);
  for (const bad of ["", "a@", "@b.de", "a b@c.de", "a@b", "a..b@c.de", ".a@c.de", "a@-b.de", "a@b.c", `${"x".repeat(65)}@b.de`, 42, null]) {
    assert.strictEqual(W.normalizeEmail(bad), null, String(bad));
  }
  assert.strictEqual(W.normalizeEmail(" A@B.DE "), "a@b.de");
});

test("Signierte Tokens: gültig, manipuliert, abgelaufen, falscher Zweck", () => {
  const t = W.sign({ p: "confirm", e: "a@b.de", x: Date.now() + 60000 });
  assert.ok(W.verify(t, "confirm").ok);
  assert.strictEqual(W.verify(t + "x", "confirm").reason, "invalid");
  assert.strictEqual(W.verify(t, "unsub").reason, "invalid");
  const old = W.sign({ p: "confirm", e: "a@b.de", x: Date.now() - 1 });
  assert.strictEqual(W.verify(old, "confirm").reason, "expired");
  assert.strictEqual(W.verify("kaputt", "confirm").reason, "invalid");
});

test("Rate-Limit greift nach 5 Anfragen", async () => {
  const ip = `test-${Math.random()}`;
  const results = [];
  for (let i = 0; i < 6; i++) results.push(await W.rateLimited(ip));
  assert.deepStrictEqual(results, [false, false, false, false, false, true]);
});

test("Im Deployment ohne Konfiguration: nicht bereit", () => {
  process.env.VERCEL = "1";
  delete require.cache[LIB];
  const P = require(LIB);
  const r = P.readiness();
  assert.strictEqual(r.ready, false);
  assert.ok(r.missing.includes("WAITLIST_SECRET"));
  delete process.env.VERCEL;
  delete require.cache[LIB];
});

test("Handler: 503 im Deployment ohne Konfiguration", async () => {
  process.env.VERCEL = "1";
  delete require.cache[LIB];
  const handlerPath = path.join(__dirname, "..", "api", "waitlist", "index.js");
  delete require.cache[handlerPath];
  const handler = require(handlerPath);
  const res = { headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; } };
  await handler({ method: "POST", headers: {}, body: { email: "a@b.de", consent: true } }, res);
  assert.strictEqual(res.statusCode, 503);
  delete process.env.VERCEL;
  delete require.cache[LIB];
  delete require.cache[handlerPath];
});
