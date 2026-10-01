/**
 * Transport-Härtung SCIM: Guards (Unit) + createScimNodeHandler über echtes node:http (Integration).
 * Derselbe Handler steckt in app/src/server.ts und scim/src/expressRouter.ts.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, request, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { HashedTokenAuthenticator, hashToken } from "../src/auth.js";
import {
  SCIM_BODY_LIMIT, checkPreBody, isBadPath, parseJsonBody, parseQuery, safeRequestId, withDeadline, type ScimSecurityEvent,
} from "../src/httpGuards.js";
import { MemoryScimStore } from "../src/memoryStore.js";
import { createScimNodeHandler, type ScimHttpOptions } from "../src/nodeHandler.js";
import type { ScimDeps } from "../src/scimUsers.js";
import { SCHEMA_USER, type TenantAuthenticator } from "../src/types.js";

const JSON_CT = { "content-type": "application/scim+json" };

// ---------------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------------
describe("checkPreBody", () => {
  it("lässt saubere Server-zu-Server-Requests durch", () => {
    assert.equal(checkPreBody("GET", "/Users", {}), null);
    assert.equal(checkPreBody("POST", "/Users", { "content-type": "application/scim+json; charset=utf-8", "content-length": "120" }), null);
    assert.equal(checkPreBody("PATCH", "/Users/abc", { "content-type": "APPLICATION/JSON; charset=\"UTF-8\"" }), null);
  });

  it("blockiert jeden Browser-Request: Origin (auch \"null\"), Sec-Fetch-Site, Sec-Fetch-Mode", () => {
    for (const h of [{ origin: "https://evil.example" }, { origin: "null" }, { origin: "" }, { "sec-fetch-site": "cross-site" }, { "sec-fetch-mode": "navigate" }]) {
      const r = checkPreBody("GET", "/Users", h);
      assert.equal(r?.response.status, 403, JSON.stringify(h));
      assert.equal(r?.event?.name, "scim_browser_origin");
    }
  });

  it("weist Pfad-Tricks ab (Traversal, kodierte Zeichen, Backslash, NUL, doppelte Slashes)", () => {
    for (const p of ["/Users/../admin", "/Users/..", "/./Users", "/Users/%2e%2e/x", "/Users%2Fabc", "/Users/%5c..", "/Users\\abc", "//Users", "/Users/a%00", "/Users/a\u0000"]) {
      assert.equal(isBadPath(p), true, p);
      const r = checkPreBody("GET", p, {});
      assert.equal(r?.response.status, 400, p);
      assert.equal(r?.event?.name, "bad_path", p);
    }
    for (const p of ["/Users", "/Users/9f1c-77", "/Users/a.b"]) assert.equal(isBadPath(p), false, p);
  });

  it("405 für fremde Methoden mit Allow-Header", () => {
    for (const m of ["TRACE", "OPTIONS", "CONNECT", "PROPFIND"]) {
      const r = checkPreBody(m, "/Users", {});
      assert.equal(r?.response.status, 405, m);
      assert.match(r?.response.headers.Allow ?? "", /PATCH/);
    }
  });

  it("415 bei falschem Content-Type oder Zeichensatz, 400/413 bei Content-Length", () => {
    const ct: Array<Record<string, string>> = [{}, { "content-type": "text/plain" }, { "content-type": "application/x-www-form-urlencoded" },
      { "content-type": "multipart/form-data; boundary=x" }, { "content-type": "application/json; charset=latin1" }, { "content-type": "application/jsonp" }];
    for (const h of ct) assert.equal(checkPreBody("POST", "/Users", h)?.response.status, 415, JSON.stringify(h));
    assert.equal(checkPreBody("POST", "/Users", { ...JSON_CT, "content-length": "12a" })?.response.status, 400);
    assert.equal(checkPreBody("POST", "/Users", { ...JSON_CT, "content-length": "-1" })?.response.status, 400);
    assert.equal(checkPreBody("POST", "/Users", { ...JSON_CT, "content-length": String(SCIM_BODY_LIMIT + 1) })?.response.status, 413);
    assert.equal(checkPreBody("POST", "/Users", { ...JSON_CT, "content-length": "99999999999999999999" })?.response.status, 400);
  });
});

describe("parseJsonBody / parseQuery / safeRequestId", () => {
  it("akzeptiert Objekte, leerer Body = undefined", () => {
    assert.deepEqual(parseJsonBody(Buffer.from('{"a":1}')), { ok: true, value: { a: 1 } });
    assert.deepEqual(parseJsonBody(Buffer.alloc(0)), { ok: true, value: undefined });
  });

  it("weist kaputte und manipulierte Bodies ab", () => {
    const bad: Array<[string, Buffer]> = [
      ["kein UTF-8", Buffer.from([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x7d])],
      ["kaputtes JSON", Buffer.from('{"userName":')],
      ["Array", Buffer.from("[1,2]")],
      ["String", Buffer.from('"x"')],
      ["null", Buffer.from("null")],
      ["__proto__ oben", Buffer.from('{"__proto__":{"isAdmin":true}}')],
      ["__proto__ verschachtelt", Buffer.from('{"name":{"__proto__":{"x":1}}}')],
      ["constructor.prototype", Buffer.from('{"constructor":{"prototype":{"x":1}}}')],
      ["extreme Verschachtelung", Buffer.from("[".repeat(200_000) + "]".repeat(200_000))],
    ];
    for (const [name, buf] of bad) {
      const r = parseJsonBody(buf);
      assert.equal(r.ok, false, name);
      if (!r.ok) assert.equal(r.response.status, 400, name);
    }
    assert.equal(({} as Record<string, unknown>).isAdmin, undefined, "kein Prototype-Pollution");
  });

  it("Query: doppelte Parameter und Parameterflut → 400", () => {
    assert.deepEqual(parseQuery('filter=userName%20eq%20"a"&count=10'), { ok: true, query: Object.assign(Object.create(null), { filter: 'userName eq "a"', count: "10" }) });
    assert.equal(parseQuery("filter=a&filter=b").ok, false);
    assert.equal(parseQuery(Array.from({ length: 21 }, (_, i) => `p${i}=1`).join("&")).ok, false);
    const proto = parseQuery("__proto__=x&constructor=y");
    assert.equal(proto.ok && Object.getPrototypeOf(proto.query), null, "Query-Objekt ohne Prototyp");
  });

  it("Request-ID: nur [A-Za-z0-9._-]{1,100}, sonst neue UUID", () => {
    assert.equal(safeRequestId("abc-123_x.y"), "abc-123_x.y");
    for (const v of ["a\r\nX-Evil: 1", "<script>", "x".repeat(101), "", ["a", "b"], undefined]) {
      assert.match(safeRequestId(v), /^[0-9a-f-]{36}$/, String(v));
    }
  });

  it("withDeadline: hängende Arbeit → 503 + Retry-After, schnelle Arbeit unverändert", async () => {
    const t0 = Date.now();
    const slow = await withDeadline(new Promise(() => {}), 40, "rid-1");
    assert.equal(slow.timedOut, true);
    assert.equal(slow.res.status, 503);
    assert.equal(slow.res.headers["Retry-After"], "5");
    assert.ok(Date.now() - t0 < 1000);
    const fast = await withDeadline(Promise.resolve({ status: 204, headers: {} }), 1000, "rid-2");
    assert.deepEqual(fast, { res: { status: 204, headers: {} }, timedOut: false });
  });
});

// ---------------------------------------------------------------------------------------------------
// Integration über node:http
// ---------------------------------------------------------------------------------------------------
const PEPPER = "p".repeat(40);
const TOKEN = "scim-" + "t".repeat(40);
const EXPIRED = "scim-" + "e".repeat(40);

interface Harness {
  port: number;
  events: Array<{ event: ScimSecurityEvent } & Record<string, unknown>>;
  logs: Array<Record<string, unknown>>;
  expired: string[];
  store: MemoryScimStore;
  close(): void;
}

async function harness(over: { auth?: TenantAuthenticator; opts?: ScimHttpOptions; preRead?: boolean } = {}): Promise<Harness> {
  const events: Harness["events"] = [];
  const logs: Harness["logs"] = [];
  const expired: string[] = [];
  const store = new MemoryScimStore();
  const deps: ScimDeps = {
    store,
    baseUrl: "https://acme.calensync.de/scim/v2",
    newId: randomUUID,
    auth: over.auth ?? new HashedTokenAuthenticator(PEPPER, async () => [
      { tenantId: "acme", sha256Hex: hashToken(PEPPER, TOKEN), expiresAt: "2099-01-01T00:00:00Z" },
      { tenantId: "acme", sha256Hex: hashToken(PEPPER, EXPIRED), expiresAt: "2020-01-01T00:00:00Z" },
    ], undefined, { expiredTokenUsed: (t) => expired.push(t) }),
  };
  const handle = createScimNodeHandler(deps, {
    security: { security: (event, f) => events.push({ event, ...(f ?? {}) }) },
    log: (e) => logs.push(e),
    ...over.opts,
  });
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    const path = (req.url ?? "/").split("?")[0] ?? "/";
    const go = () => void handle(req, res, path.slice("/scim/v2".length) || "/");
    if (over.preRead) { req.resume(); req.on("end", go); } else go();   // simuliert express.json() VOR dem Router
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { port: (server.address() as AddressInfo).port, events, logs, expired, store, close: () => server.close() };
}

function call(port: number, method: string, path: string, headers: Record<string, string> = {}, body?: string | Buffer[]) {
  return new Promise<{ status: number; headers: Record<string, string | string[] | undefined>; json: Record<string, unknown> | null }>((resolve, reject) => {
    const h = { ...headers };
    if (typeof body === "string" && h["content-length"] === undefined) h["content-length"] = String(Buffer.byteLength(body));
    const r = request({ host: "127.0.0.1", port, method, path, headers: h }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, json: t ? (JSON.parse(t) as Record<string, unknown>) : null }));
    });
    r.on("error", reject);
    if (Array.isArray(body)) { for (const c of body) r.write(c); r.end(); } // chunked, ohne Content-Length
    else r.end(body);
  });
}

const auth = (t = TOKEN) => ({ authorization: `Bearer ${t}` });
const newUser = (n = "max@acme.example") => JSON.stringify({ schemas: [SCHEMA_USER], userName: n, externalId: `oid-${n}`, active: true });

describe("createScimNodeHandler über HTTP", () => {
  it("Happy Path: anlegen und filtern, SCIM-Content-Type, Sicherheitsheader, sichere Request-ID", async () => {
    const h = await harness();
    try {
      const c = await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT, "x-request-id": "entra-req-1" }, newUser());
      assert.equal(c.status, 201);
      assert.match(String(c.headers["content-type"]), /application\/scim\+json/);
      assert.equal(c.headers["x-request-id"], "entra-req-1");
      for (const k of ["strict-transport-security", "x-content-type-options", "content-security-policy", "cache-control"]) assert.ok(c.headers[k], k);
      assert.equal(c.headers["cache-control"], "no-store");
      const l = await call(h.port, "GET", `/scim/v2/Users?filter=${encodeURIComponent('userName eq "max@acme.example"')}`, { ...auth(), "x-request-id": "<b>x</b>" });
      assert.equal(l.status, 200);
      assert.equal(l.json?.totalResults, 1);
      assert.match(String(l.headers["x-request-id"]), /^[0-9a-f-]{36}$/, "unsichere ID ersetzt");
      assert.equal(h.events.length, 0);
    } finally { h.close(); }
  });

  it("falsches und abgelaufenes Token → 401 + Sicherheitsereignis ohne Token; abgelaufenes zusätzlich Hook", async () => {
    const h = await harness();
    try {
      const a = await call(h.port, "GET", "/scim/v2/Users", auth("scim-" + "x".repeat(40)));
      assert.equal(a.status, 401);
      assert.match(String(a.headers["www-authenticate"]), /Bearer/);
      const b = await call(h.port, "GET", "/scim/v2/Users", auth(EXPIRED));
      assert.equal(b.status, 401);
      assert.equal((await call(h.port, "GET", "/scim/v2/Users")).status, 401);
      assert.deepEqual(h.events.map((e) => [e.event, e.hasBearer]), [["scim_auth_failed", true], ["scim_auth_failed", true], ["scim_auth_failed", false]]);
      assert.deepEqual(h.expired, ["acme"], "Hook nur für das korrekte, aber abgelaufene Token");
      assert.equal(JSON.stringify(h.events).includes("eeeeeeee"), false, "Token nie im Ereignis");
    } finally { h.close(); }
  });

  it("Browser-Origin → 403 noch VOR Auth und Body; Pfad-Trick → 400; beides als Sicherheitsereignis", async () => {
    const h = await harness();
    try {
      const o = await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT, origin: "https://evil.example" }, newUser());
      assert.equal(o.status, 403);
      assert.equal(o.headers["access-control-allow-origin"], undefined);
      assert.equal(h.store.users.size, 0, "nichts angelegt");
      assert.equal((await call(h.port, "GET", "/scim/v2/Users/%2e%2e/%2e%2e/etc", auth())).status, 400);
      assert.equal((await call(h.port, "GET", "/scim/v2/Users/..%5c..%5cadmin", auth())).status, 400);
      assert.deepEqual(h.events.map((e) => e.event), ["scim_browser_origin", "bad_path", "bad_path"]);
    } finally { h.close(); }
  });

  it("Malicious Payloads: 415, kaputtes JSON, __proto__, Array, doppelter filter", async () => {
    const h = await harness();
    try {
      assert.equal((await call(h.port, "POST", "/scim/v2/Users", { ...auth(), "content-type": "text/plain" }, newUser())).status, 415);
      const cases: Array<[string, string]> = [["{\"userName\":", "invalidSyntax"], ['{"__proto__":{"active":true},"userName":"x"}', "invalidSyntax"], ["[]", "invalidSyntax"]];
      for (const [body, scimType] of cases) {
        const r = await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT }, body);
        assert.equal(r.status, 400, body);
        assert.equal(r.json?.scimType, scimType, body);
      }
      assert.equal((await call(h.port, "GET", "/scim/v2/Users?filter=a&filter=b", auth())).status, 400);
      assert.equal(h.store.users.size, 0);
    } finally { h.close(); }
  });

  it("413: per Content-Length sofort, per Chunked-Stream beim Lesen – Server bleibt erreichbar", async () => {
    const h = await harness({ opts: { bodyLimit: 1024 } });
    try {
      const big = JSON.stringify({ userName: "x".repeat(2000) });
      assert.equal((await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT }, big)).status, 413);
      const chunks = Array.from({ length: 6 }, () => Buffer.from("x".repeat(400)));
      assert.equal((await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT }, chunks)).status, 413);
      assert.equal((await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT }, newUser())).status, 201);
    } finally { h.close(); }
  });

  it("Timeout: hängende Auth/DB → 503 + Retry-After nach Budget, Warn-Log", async () => {
    const h = await harness({ auth: { authenticate: () => new Promise<string | null>(() => {}) }, opts: { timeoutMs: 80 } });
    try {
      const t0 = Date.now();
      const r = await call(h.port, "GET", "/scim/v2/Users", auth());
      assert.equal(r.status, 503);
      assert.equal(r.headers["retry-after"], "5");
      assert.ok(Date.now() - t0 < 2000);
      assert.equal(h.logs.at(-1)?.msg, "scim_timeout");
    } finally { h.close(); }
  });

  it("Fehlkonfiguration: Body schon von einem Parser davor gelesen → 500 + Log, nichts angelegt", async () => {
    const h = await harness({ preRead: true });
    try {
      const r = await call(h.port, "POST", "/scim/v2/Users", { ...auth(), ...JSON_CT }, newUser());
      assert.equal(r.status, 500);
      assert.equal(h.logs.at(-1)?.msg, "scim_router_misconfigured");
      assert.equal(h.store.users.size, 0);
    } finally { h.close(); }
  });
});
