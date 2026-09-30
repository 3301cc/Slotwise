"use strict";
// node --test scripts/waitlist.test.js   – testet die Geschäftslogik ohne Netz, Datei oder Umgebungsvariablen.
const test = require("node:test");
const assert = require("node:assert");
const { fromEnv, readiness } = require("../api/_lib/core/config");
const { normalizeEmail } = require("../api/_lib/core/email");
const { createTokens } = require("../api/_lib/core/tokens");
const { memoryStore } = require("../api/_lib/core/store");
const { createWaitlist } = require("../api/_lib/core/waitlist");
const { toInput, writeResult, apiHandler } = require("../api/_lib/http");

const SECRET = "x".repeat(40);
const quiet = { log() {}, error() {} };

function fakeMailer() {
  const sent = [];
  return { sent, kind: "fake", async send(m) { sent.push(m); } };
}
function prodConfig(over = {}) {
  return fromEnv({
    VERCEL: "1", WAITLIST_SECRET: SECRET, KV_REST_API_URL: "https://r.example", KV_REST_API_TOKEN: "t",
    MAILJET_API_KEY: "k", MAILJET_API_SECRET: "s", WAITLIST_FROM_EMAIL: "hallo@slotwise.app",
    SITE_URL: "https://slotwise.app", WAITLIST_ADMIN_TOKEN: "admin-secret", ...over,
  });
}
function wl(over = {}, deps = {}) {
  return createWaitlist(prodConfig(over), { store: memoryStore(), mailer: fakeMailer(), log: quiet, ...deps });
}

test("E-Mail-Validierung", () => {
  for (const ok of ["a@b.de", "Max.Mustermann@Firma-GmbH.de", " x+tag@sub.example.co.uk "]) assert.ok(normalizeEmail(ok), ok);
  for (const bad of ["", "a@", "@b.de", "a b@c.de", "a@b", "a..b@c.de", ".a@c.de", "a@-b.de", "a@b.c", `${"x".repeat(65)}@b.de`, 42, null]) {
    assert.strictEqual(normalizeEmail(bad), null, String(bad));
  }
  assert.strictEqual(normalizeEmail(" A@B.DE "), "a@b.de");
});

test("Tokens: gültig, manipuliert, abgelaufen, falscher Zweck", () => {
  const t = createTokens(SECRET);
  const tok = t.sign({ p: "confirm", e: "a@b.de", x: 2000 });
  assert.ok(t.verify(tok, "confirm", 1000).ok);
  assert.strictEqual(t.verify(tok, "confirm", 3000).reason, "expired");
  assert.strictEqual(t.verify(tok + "x", "confirm", 1000).reason, "invalid");
  assert.strictEqual(t.verify(tok, "unsub", 1000).reason, "invalid");
  assert.strictEqual(createTokens("anderes-geheimnis-".repeat(3)).verify(tok, "confirm", 1000).reason, "invalid");
});

test("Konfiguration: im Deployment ohne Variablen nicht bereit, lokal immer", () => {
  const r = readiness(fromEnv({ VERCEL: "1" }));
  assert.strictEqual(r.ready, false);
  assert.deepStrictEqual(r.missing, ["WAITLIST_SECRET", "KV_REST_API_URL/KV_REST_API_TOKEN", "MAILJET_API_KEY/MAILJET_API_SECRET/WAITLIST_FROM_EMAIL"]);
  assert.strictEqual(readiness(fromEnv({})).ready, true);
  assert.strictEqual(readiness(prodConfig()).ready, true);
  assert.strictEqual(readiness(fromEnv({ NODE_ENV: "production" })).ready, false, "auch ohne Vercel gilt production");
});

test("subscribe: 503 ohne Konfiguration, Eingabe nie gespeichert", async () => {
  const store = memoryStore();
  const w = createWaitlist(fromEnv({ VERCEL: "1" }), { store, mailer: null, log: quiet });
  const r = await w.subscribe({ body: { email: "a@b.de", consent: true }, ip: "1.1.1.1", baseUrl: "https://x" });
  assert.strictEqual(r.status, 503);
  assert.deepStrictEqual(r.body, { error: "not_configured" });
  assert.deepStrictEqual(await store.all(), {});
});

test("subscribe: Validierung, Honigtopf, Double-Opt-in, Rate-Limit", async () => {
  const mailer = fakeMailer();
  const w = wl({}, { mailer });
  const base = { ip: "2.2.2.2", baseUrl: "https://slotwise.app" };
  assert.strictEqual((await w.subscribe({ ...base, body: { email: "kaputt", consent: true } })).status, 422);
  assert.strictEqual((await w.subscribe({ ...base, body: { email: "a@b.de" } })).body.error, "consent_required");
  assert.strictEqual((await w.subscribe({ ...base, body: null })).status, 400);
  const bot = await w.subscribe({ ...base, body: { email: "bot@b.de", consent: true, company: "ACME" } });
  assert.strictEqual(bot.status, 202); assert.strictEqual(mailer.sent.length, 0, "Honigtopf verschickt nichts");

  const ok = await w.subscribe({ ...base, body: { email: " A@B.de ", consent: true, source: "preise" } });
  assert.strictEqual(ok.status, 202);
  assert.strictEqual(mailer.sent.length, 1);
  assert.strictEqual(mailer.sent[0].to, "a@b.de");
  assert.match(mailer.sent[0].text, /https:\/\/slotwise\.app\/api\/waitlist\/confirm\?t=/);
  assert.deepStrictEqual(await w.store.all(), {}, "vor Bestätigung nichts gespeichert");

  for (let i = 0; i < 4; i++) await w.subscribe({ ...base, body: { email: `n${i}@b.de`, consent: true } });
  assert.strictEqual(mailer.sent.length, 5, "fünf Anfragen je IP sind erlaubt");
  const limited = await w.subscribe({ ...base, body: { email: "n9@b.de", consent: true } });
  assert.strictEqual(limited.status, 429);
  assert.strictEqual(limited.headers["Retry-After"], "600");
});

test("confirm → gespeichert; doppelt idempotent; unsubscribe löscht; export als CSV", async () => {
  const mailer = fakeMailer();
  const w = wl({ WAITLIST_NOTIFY_EMAIL: "team@slotwise.app" }, { mailer, now: () => 1_700_000_000_000 });
  await w.subscribe({ ip: "3.3.3.3", baseUrl: "https://slotwise.app", body: { email: "c@d.de", consent: true, source: "demo" } });
  const t = new URL(mailer.sent[0].text.match(/https:\S+/)[0]).searchParams.get("t");

  const r1 = await w.confirm({ query: { t }, baseUrl: "https://slotwise.app" });
  assert.strictEqual(r1.status, 303); assert.strictEqual(r1.redirect, "/?warteliste=bestaetigt");
  const all = await w.store.all();
  assert.deepStrictEqual(Object.keys(all), ["c@d.de"]);
  assert.strictEqual(all["c@d.de"].source, "demo");
  assert.strictEqual(mailer.sent.length, 2, "Benachrichtigung an Team");
  assert.strictEqual(mailer.sent[1].to, "team@slotwise.app");

  await w.confirm({ query: { t }, baseUrl: "https://slotwise.app" });
  assert.strictEqual(mailer.sent.length, 2, "zweite Bestätigung löst nichts erneut aus");

  const again = await w.subscribe({ ip: "3.3.3.3", baseUrl: "https://slotwise.app", body: { email: "c@d.de", consent: true } });
  assert.strictEqual(again.status, 202); assert.strictEqual(mailer.sent.length, 2, "bereits bestätigt → keine Mail");

  assert.strictEqual((await w.confirm({ query: { t: "kaputt" } })).redirect, "/?warteliste=ungueltig");
  assert.strictEqual((await w.confirm({ query: { t }, baseUrl: "x" }, )).status, 303);
  const expired = createWaitlist(prodConfig(), { store: memoryStore(), mailer, log: quiet, now: () => 1_700_000_000_000 + 73 * 3600 * 1000 });
  assert.strictEqual((await expired.confirm({ query: { t } })).redirect, "/?warteliste=abgelaufen");

  const stats = await w.stats({ headers: { authorization: "Bearer admin-secret" } });
  assert.deepStrictEqual(stats.body, { confirmed: 1 });
  assert.strictEqual((await w.stats({ headers: {} })).status, 401);
  const csv = await w.exportCsv({ headers: { authorization: "Bearer admin-secret" } });
  assert.strictEqual(csv.status, 200);
  assert.strictEqual(csv.body, 'email,source,confirmed_at\n"c@d.de","demo","2023-11-14T22:13:20.000Z"\n');
  assert.strictEqual((await w.exportCsv({ headers: {} })).status, 401);
  assert.strictEqual((await w.exportCsv({ headers: { authorization: "Bearer falsch" } })).status, 401);

  const u = new URL(w.unsubscribeUrl("https://slotwise.app", "c@d.de")).searchParams.get("t");
  assert.strictEqual((await w.unsubscribe({ query: { t: u } })).redirect, "/?warteliste=abgemeldet");
  assert.deepStrictEqual(await w.store.all(), {});
});

test("Adapter: Vercel-Objekt (body/query geparst) und node:http-Stream ergeben dieselbe Eingabe", async () => {
  const cfg = prodConfig({ SITE_URL: "" });
  const vercelReq = { method: "POST", url: "/api/waitlist?x=1", headers: { host: "slotwise.app", "x-forwarded-proto": "https", "x-forwarded-for": "9.9.9.9, 10.0.0.1" }, body: { email: "a@b.de" }, query: { x: "1" } };
  const { Readable } = require("node:stream");
  const nodeReq = Object.assign(Readable.from([Buffer.from('{"email":"a@b.de"}')]), { method: "POST", url: "/api/waitlist?x=1", headers: vercelReq.headers, socket: { remoteAddress: "127.0.0.1" } });
  const a = await toInput(vercelReq, cfg), b = await toInput(nodeReq, cfg);
  assert.deepStrictEqual(a, b);
  assert.strictEqual(a.baseUrl, "https://slotwise.app");
  assert.strictEqual(a.ip, "9.9.9.9");
  const tooBig = Object.assign(Readable.from([Buffer.alloc(20_000, 65)]), { method: "POST", url: "/", headers: {} });
  assert.strictEqual((await toInput(tooBig, cfg)).body, null);
});

test("Adapter: writeResult + Routing (405 bei falscher Methode, 404/next bei unbekannt)", async () => {
  const res = () => ({ headers: {}, setHeader(k, v) { this.headers[k] = v; }, end(b) { this.body = b; this.ended = true; } });
  const r = res();
  writeResult(r, { status: 303, redirect: "/?warteliste=bestaetigt" });
  assert.strictEqual(r.statusCode, 303); assert.strictEqual(r.headers.Location, "/?warteliste=bestaetigt");
  const r2 = res();
  await apiHandler({ method: "GET", url: "/api/waitlist", headers: {} }, r2);
  assert.strictEqual(r2.statusCode, 405); assert.strictEqual(r2.headers.Allow, "POST");
  let nextCalled = false;
  await apiHandler({ method: "GET", url: "/api/nix", headers: {} }, res(), () => { nextCalled = true; });
  assert.ok(nextCalled, "Express-Style next() bei unbekannter Route");
});
