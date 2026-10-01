/**
 * Verhaltenstests für den SCIM-Kern (node:test, ohne Netzwerk).
 *   npm test   → tsc && node --test dist/test
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { beforeEach, describe, it } from "node:test";
import { HashedTokenAuthenticator, hashToken, type TokenEntry } from "../src/auth.js";
import { MemoryScimStore } from "../src/memoryStore.js";
import { handleScim, type ScimDeps } from "../src/scimUsers.js";
import { SCHEMA_ENTERPRISE_USER, SCHEMA_PATCH, SCHEMA_USER, StoreBusyError, type ScimResponse } from "../src/types.js";

const PEPPER = "p".repeat(40);
const TOKEN_A = "tok-acme-" + "a".repeat(40);
const TOKEN_B = "tok-other-" + "b".repeat(40);
const BASE = "https://acme.calensync.de/scim/v2";

let store: MemoryScimStore;
let deps: ScimDeps;

function call(token: string | null, method: string, path: string, body?: unknown, extra: Record<string, string> = {}, query: Record<string, string> = {}) {
  const headers: Record<string, string> = { ...extra };
  if (token) headers.Authorization = `Bearer ${token}`;
  return handleScim({ method, path, query, headers, body, requestId: randomUUID() }, deps);
}

function json(res: ScimResponse): Record<string, any> {
  return res.body as Record<string, any>;
}

async function provision(token = TOKEN_A, userName = "Max.Mustermann@acme.example") {
  const res = await call(token, "POST", "/Users", {
    schemas: [SCHEMA_USER, SCHEMA_ENTERPRISE_USER],
    userName,
    externalId: "entra-oid-" + userName,
    active: true,
    displayName: "Max Mustermann",
    name: { givenName: "Max", familyName: "Mustermann" },
    emails: [{ value: userName, type: "work", primary: true }],
    phoneNumbers: [{ value: "+49 211 000000", type: "work" }], // wird bewusst nicht gespeichert
    [SCHEMA_ENTERPRISE_USER]: { department: "Vertrieb", manager: { value: "x" } },
  });
  assert.equal(res.status, 201);
  return json(res).id as string;
}

function giveSyncState(tenantId: string, userId: string) {
  store.pipelines.push(
    { id: randomUUID(), tenantId, ownerUserId: userId, status: "active", revokedReason: null },
    { id: randomUUID(), tenantId, ownerUserId: userId, status: "paused", revokedReason: null },
  );
  store.tokens.push({ tenantId, userId, provider: "microsoft" });
  store.subscriptions.push({ tenantId, userId, state: "active" });
}

beforeEach(() => {
  store = new MemoryScimStore();
  const entries: TokenEntry[] = [
    { tenantId: "acme", sha256Hex: hashToken(PEPPER, TOKEN_A), expiresAt: "2099-01-01T00:00:00Z" },
    { tenantId: "other", sha256Hex: hashToken(PEPPER, TOKEN_B), expiresAt: "2099-01-01T00:00:00Z" },
  ];
  deps = {
    store,
    auth: new HashedTokenAuthenticator(PEPPER, async () => entries),
    baseUrl: BASE,
    newId: randomUUID,
    actor: "scim:entra-provisioning",
  };
});

describe("Authentisierung und Mandantentrennung", () => {
  it("lehnt fehlendes oder falsches Token mit 401 ab", async () => {
    assert.equal((await call(null, "GET", "/Users")).status, 401);
    const res = await call("x".repeat(48), "GET", "/Users");
    assert.equal(res.status, 401);
    assert.match(res.headers["WWW-Authenticate"], /Bearer/);
  });

  it("Mandant B sieht und ändert keine User von Mandant A (404, keine Kappung)", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    assert.equal((await call(TOKEN_B, "GET", `/Users/${id}`)).status, 404);
    const patch = await call(TOKEN_B, "PATCH", `/Users/${id}`, {
      schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    assert.equal(patch.status, 404);
    assert.equal(store.revokeCalls, 0);
    assert.ok(store.pipelines.every((p) => p.status !== "revoked"));
    const list = json(await call(TOKEN_B, "GET", "/Users", undefined, {}, { filter: 'userName eq "max.mustermann@acme.example"' }));
    assert.equal(list.totalResults, 0);
  });
});

describe("Provisionierung (POST/GET)", () => {
  it("legt User an, speichert nur minimale Attribute, liefert Location + ETag", async () => {
    const res = await call(TOKEN_A, "POST", "/Users", {
      schemas: [SCHEMA_USER], userName: "Erika@acme.example", emails: [{ value: "erika@acme.example", type: "work" }],
      phoneNumbers: [{ value: "+49 1" }], addresses: [{ streetAddress: "x" }],
    });
    assert.equal(res.status, 201);
    const body = json(res);
    assert.equal(res.headers.Location, `${BASE}/Users/${body.id}`);
    assert.equal(res.headers.ETag, 'W/"1"');
    assert.equal(body.active, true);
    assert.equal(body.phoneNumbers, undefined);
    assert.equal(body.addresses, undefined);
    assert.equal(res.headers["Content-Type"], "application/scim+json; charset=utf-8");
  });

  it("verhindert doppelte userNames (case-insensitiv) mit 409 uniqueness", async () => {
    await provision();
    const dup = await call(TOKEN_A, "POST", "/Users", { schemas: [SCHEMA_USER], userName: "MAX.MUSTERMANN@acme.example" });
    assert.equal(dup.status, 409);
    assert.equal(json(dup).scimType, "uniqueness");
  });

  it("findet per Filter userName eq (Entra-Abgleich) und lehnt unbekannte Filter ab", async () => {
    await provision();
    const hit = json(await call(TOKEN_A, "GET", "/Users", undefined, {}, { filter: 'userName eq "max.mustermann@ACME.example"' }));
    assert.equal(hit.totalResults, 1);
    assert.equal(hit.Resources[0][SCHEMA_ENTERPRISE_USER].department, "Vertrieb");
    const bad = await call(TOKEN_A, "GET", "/Users", undefined, {}, { filter: 'title co "x"' });
    assert.equal(bad.status, 400);
    assert.equal(json(bad).scimType, "invalidFilter");
  });
});

describe("Offboarding: Sync wird sofort gekappt", () => {
  it("Entra-PATCH {op: Replace, path: active, value: 'False'} kappt Pipelines, Tokens und Abos", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const res = await call(TOKEN_A, "PATCH", `/Users/${id}`, {
      schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }],
    });
    assert.equal(res.status, 200);
    assert.equal(json(res).active, false);
    assert.ok(store.pipelines.every((p) => p.status === "revoked" && p.revokedReason === "scim_deactivated"));
    assert.equal(store.tokens.length, 0);
    assert.ok(store.subscriptions.every((s) => s.state === "stop_requested"));
    const revoked = store.auditLog.find((e) => e.action === "scim.user.sync_revoked");
    assert.deepEqual(
      { p: revoked?.detail.pipelinesRevoked, t: revoked?.detail.tokensDestroyed, s: revoked?.detail.subscriptionsQueuedForStop },
      { p: 2, t: 1, s: 1 },
    );
    assert.ok(store.auditLog.some((e) => e.action === "scim.user.deactivate" && e.targetUserId === id));
  });

  it("Okta-PATCH ohne path {value: {active: false}} kappt ebenfalls", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const res = await call(TOKEN_A, "PATCH", `/Users/${id}`, {
      schemas: [SCHEMA_PATCH], Operations: [{ op: "replace", value: { active: false } }],
    });
    assert.equal(res.status, 200);
    assert.ok(store.pipelines.every((p) => p.status === "revoked"));
  });

  it("wiederholte Deaktivierung ist idempotent und kappt trotzdem erneut (heilt abgebrochene Läufe)", async () => {
    const id = await provision();
    const body = { schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] };
    await call(TOKEN_A, "PATCH", `/Users/${id}`, body);
    giveSyncState("acme", id); // simuliert Reste aus einem abgebrochenen ersten Lauf
    const second = await call(TOKEN_A, "PATCH", `/Users/${id}`, body);
    assert.equal(second.status, 200);
    assert.equal(store.revokeCalls, 2);
    assert.ok(store.pipelines.every((p) => p.status === "revoked"));
    assert.equal(store.tokens.length, 0);
  });

  it("Reaktivierung macht den User aktiv, lässt Pipelines aber gesperrt", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    await call(TOKEN_A, "PATCH", `/Users/${id}`, { schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] });
    const re = await call(TOKEN_A, "PATCH", `/Users/${id}`, { schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "True" }] });
    assert.equal(json(re).active, true);
    assert.ok(store.pipelines.every((p) => p.status === "revoked"));
    assert.ok(store.auditLog.some((e) => e.action === "scim.user.reactivate"));
  });

  it("PUT mit active=false kappt ebenfalls", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const res = await call(TOKEN_A, "PUT", `/Users/${id}`, { schemas: [SCHEMA_USER], userName: "max.mustermann@acme.example", active: false });
    assert.equal(res.status, 200);
    assert.ok(store.pipelines.every((p) => p.status === "revoked"));
  });

  it("DELETE kappt den Sync, löscht den Datensatz und liefert 204", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const res = await call(TOKEN_A, "DELETE", `/Users/${id}`);
    assert.equal(res.status, 204);
    assert.ok(store.pipelines.every((p) => p.status === "revoked" && p.revokedReason === "scim_deleted"));
    assert.equal((await call(TOKEN_A, "GET", `/Users/${id}`)).status, 404);
    const audit = store.auditLog.find((e) => e.action === "scim.user.delete");
    assert.equal(audit?.targetUserId, id);
    assert.equal(JSON.stringify(audit).includes("mustermann"), false, "Audit nach Löschung ohne Klarnamen/Mail");
  });
});

describe("PATCH-Details (Entra-Kompatibilität)", () => {
  it("emails[type eq \"work\"].value wird ersetzt, unbekannte Pfade ignoriert und protokolliert", async () => {
    const id = await provision();
    const res = await call(TOKEN_A, "PATCH", `/Users/${id}`, {
      schemas: [SCHEMA_PATCH],
      Operations: [
        { op: "Replace", path: 'emails[type eq "work"].value', value: "max.neu@acme.example" },
        { op: "Add", path: "title", value: "Teamlead" },
        { op: "Replace", path: `${SCHEMA_ENTERPRISE_USER}:department`, value: "Einkauf" },
      ],
    });
    assert.equal(res.status, 200);
    const body = json(res);
    assert.equal(body.emails[0].value, "max.neu@acme.example");
    assert.equal(body.title, undefined);
    assert.equal(body[SCHEMA_ENTERPRISE_USER].department, "Einkauf");
    const ev = store.auditLog.find((e) => e.action === "scim.user.patch");
    assert.deepEqual(ev?.detail.ignoredPaths, ["title"]);
  });

  it("If-Match mit veralteter Version → 412, nichts geändert", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const res = await call(TOKEN_A, "PATCH", `/Users/${id}`,
      { schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: false }] },
      { "If-Match": 'W/"999"' });
    assert.equal(res.status, 412);
    assert.equal(store.revokeCalls, 0);
  });

  it("ungültige op → 400 invalidSyntax, Ablehnung landet im Audit-Log", async () => {
    const id = await provision();
    const res = await call(TOKEN_A, "PATCH", `/Users/${id}`, { schemas: [SCHEMA_PATCH], Operations: [{ op: "move", path: "active" }] });
    assert.equal(res.status, 400);
    assert.equal(json(res).scimType, "invalidSyntax");
    assert.ok(store.auditLog.some((e) => e.action === "scim.request.rejected" && e.outcome === "failure"));
  });
});

describe("Offboarding entkoppelt: kein Provider-Aufruf im SCIM-Request", () => {
  it("DELETE: 204 sofort, PII-freier Tombstone, Teardown-Job mit purgeUser=true in derselben Operation", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const res = await call(TOKEN_A, "DELETE", `/Users/${id}`);
    assert.equal(res.status, 204);

    // Kappung ist sofort wirksam
    assert.ok(store.pipelines.every((p) => p.status === "revoked"));
    assert.equal(store.tokens.length, 0);
    assert.ok(store.subscriptions.every((s) => s.state === "stop_requested"));

    // Job für den Worker – nicht im Request ausgeführt
    assert.deepEqual(store.jobs.map((j) => [j.kind, j.dedupeKey, j.payload.purgeUser, j.status]), [
      ["subscription.teardown", `purge:${id}`, true, "queued"],
    ]);

    // Tombstone: Datensatz existiert bis zum Purge, aber ohne personenbezogene Daten und für SCIM unsichtbar
    const raw = store.users.get(`acme::${id}`)!;
    assert.equal(JSON.stringify(raw).toLowerCase().includes("mustermann"), false, "keine PII im Tombstone");
    assert.deepEqual([raw.active, raw.externalId, raw.emails.length], [false, null, 0]);
    assert.equal((await call(TOKEN_A, "GET", `/Users/${id}`)).status, 404);
    assert.equal(json(await call(TOKEN_A, "GET", "/Users")).totalResults, 0);
  });

  it("DELETE ein zweites Mal → 404 (RFC 7644), kein zweiter Purge-Job", async () => {
    const id = await provision();
    assert.equal((await call(TOKEN_A, "DELETE", `/Users/${id}`)).status, 204);
    assert.equal((await call(TOKEN_A, "DELETE", `/Users/${id}`)).status, 404);
    assert.equal(store.jobs.filter((j) => j.dedupeKey === `purge:${id}`).length, 1);
  });

  it("Tombstone blockiert keine Neuanlage mit gleichem userName/externalId", async () => {
    const id = await provision();
    await call(TOKEN_A, "DELETE", `/Users/${id}`);
    const again = await provision();
    assert.notEqual(again, id);
  });

  it("PATCH active=false: Teardown-Job ohne Purge; Wiederholung stellt keinen zweiten wartenden Job ein", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const patch = { schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] };
    assert.equal((await call(TOKEN_A, "PATCH", `/Users/${id}`, patch)).status, 200);
    assert.equal((await call(TOKEN_A, "PATCH", `/Users/${id}`, patch)).status, 200);
    assert.deepEqual(store.jobs.map((j) => [j.dedupeKey, j.payload.purgeUser]), [[`teardown:${id}`, false]]);
    assert.ok(await store.findById("acme", id), "deaktivierter User bleibt sichtbar");
  });

  it("purgeDeletedUser löscht nur Tombstones, nie aktive oder deaktivierte User", async () => {
    const active = await provision(TOKEN_A, "a@acme.example");
    const deleted = await provision(TOKEN_A, "b@acme.example");
    await call(TOKEN_A, "DELETE", `/Users/${deleted}`);
    assert.equal(await store.purgeDeletedUser("acme", active), false);
    assert.equal(await store.purgeDeletedUser("acme", deleted), true);
    assert.equal(store.users.has(`acme::${deleted}`), false);
    assert.ok(await store.findById("acme", active));
  });

  it("Mandantentrennung: Mandant B kann User von A nicht löschen", async () => {
    const id = await provision();
    assert.equal((await call(TOKEN_B, "DELETE", `/Users/${id}`)).status, 404);
    assert.equal(store.jobs.length, 0);
  });
});

describe("Last und Nebenläufigkeit", () => {
  it("Datenbank ausgelastet (StoreBusyError) → 503 mit Retry-After statt 500, nichts halb geschrieben", async () => {
    const id = await provision();
    store.markDeletedAndEnqueueTeardown = async () => { throw new StoreBusyError(3); };
    const res = await call(TOKEN_A, "DELETE", `/Users/${id}`);
    assert.equal(res.status, 503);
    assert.equal(res.headers["Retry-After"], "5");
    assert.ok(await store.findById("acme", id), "User unverändert");
  });

  it("PATCH active=false bei Versionskonflikt: Sync trotzdem gekappt, Antwort 409, IdP-Retry gelingt", async () => {
    const id = await provision();
    giveSyncState("acme", id);
    const u = store.users.get(`acme::${id}`)!;
    const origFind = store.findById.bind(store);
    let first = true;
    store.findById = async (t: string, i: string) => {
      const r = await origFind(t, i);
      if (r && first) { first = false; u.version += 1; } // parallele Änderung zwischen Lesen und Schreiben
      return r;
    };
    const patch = { schemas: [SCHEMA_PATCH], Operations: [{ op: "Replace", path: "active", value: "False" }] };
    const r1 = await call(TOKEN_A, "PATCH", `/Users/${id}`, patch);
    assert.equal(r1.status, 409);
    assert.equal(store.tokens.length, 0, "Kill-Switch hat trotzdem gegriffen");
    assert.ok(store.pipelines.every((p) => p.status === "revoked"));
    const r2 = await call(TOKEN_A, "PATCH", `/Users/${id}`, patch);
    assert.equal(r2.status, 200);
    assert.equal(json(r2).active, false);
  });
});

