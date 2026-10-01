/**
 * Express-Adapter gegen echtes Express 5 (npm ci installiert es). Ist express nicht installiert,
 * werden die Tests übersprungen – die Logik selbst prüft test/httpGuards.test.ts über node:http.
 *
 * Requests bewusst über node:http statt global fetch: fetch (undici) sendet immer "sec-fetch-mode: cors",
 * und genau das weist der SCIM-Browser-Guard (src/httpGuards.ts) zu Recht mit 403 ab. Außerdem normalisiert
 * fetch Pfade wie /Users/%2e%2e/x, bevor sie den Server erreichen; node:http schickt sie unverändert.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { HashedTokenAuthenticator, hashToken } from "../src/auth.js";
import { MemoryScimStore } from "../src/memoryStore.js";
import { SCHEMA_USER } from "../src/types.js";

const express = await import("express").then((m) => m.default).catch(() => null);
const PEPPER = "p".repeat(40);
const TOKEN = "scim-" + "t".repeat(40);

async function start(withGlobalJsonParser = false): Promise<{ port: number; server: Server; events: string[] }> {
  if (!express) throw new Error("express fehlt");
  const { scimRouter } = await import("../src/expressRouter.js");
  const events: string[] = [];
  const app = express();
  app.disable("x-powered-by");
  if (withGlobalJsonParser) app.use(express.json());
  app.use("/scim/v2", scimRouter({
    store: new MemoryScimStore(), baseUrl: "https://acme.calensync.de/scim/v2", newId: randomUUID,
    auth: new HashedTokenAuthenticator(PEPPER, async () => [{ tenantId: "acme", sha256Hex: hashToken(PEPPER, TOKEN), expiresAt: "2099-01-01T00:00:00Z" }]),
  }, { security: { security: (e) => events.push(e) } }));
  const server = await new Promise<Server>((r) => { const s = app.listen(0, "127.0.0.1", () => r(s)); });
  return { port: (server.address() as AddressInfo).port, server, events };
}

/** Server-zu-Server-Request wie ein IdP (Entra/Okta): keine Origin-/Sec-Fetch-Header, Pfad unverändert */
function call(port: number, method: string, path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const r = request({ host: "127.0.0.1", port, method, path: `/scim/v2${path}`, headers }, (res) => {
      let t = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (t += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text: t }));
    });
    r.on("error", reject);
    r.end(body);
  });
}

const hdr = { authorization: `Bearer ${TOKEN}`, "content-type": "application/scim+json" };
const body = JSON.stringify({ schemas: [SCHEMA_USER], userName: "max@acme.example", externalId: "oid-1", active: true });

describe("scimRouter (Express)", { skip: express === null ? "express nicht installiert" : false }, () => {
  it("anlegen, lesen, Origin 403, Pfad-Trick 400, 401 – gleiche Ergebnisse wie node:http", async () => {
    const s = await start();
    try {
      const c = await call(s.port, "POST", "/Users", hdr, body);
      assert.equal(c.status, 201);
      const id = (JSON.parse(c.text) as { id: string }).id;
      assert.equal((await call(s.port, "GET", `/Users/${id}`, hdr)).status, 200);
      assert.equal((await call(s.port, "GET", "/Users", { ...hdr, origin: "https://evil.example" })).status, 403);
      assert.equal((await call(s.port, "GET", "/Users/%2e%2e/x", hdr)).status, 400);
      assert.equal((await call(s.port, "GET", "/Users", { authorization: "Bearer falsch-falsch-falsch-falsch-falsch-00" })).status, 401);
      assert.deepEqual(s.events, ["scim_browser_origin", "bad_path", "scim_auth_failed"]);
    } finally { s.server.close(); }
  });

  it("globaler express.json() davor → 500 statt umgangener Limits", async () => {
    const s = await start(true);
    try {
      assert.equal((await call(s.port, "POST", "/Users", { ...hdr, "content-type": "application/json" }, body)).status, 500);
    } finally { s.server.close(); }
  });
});
