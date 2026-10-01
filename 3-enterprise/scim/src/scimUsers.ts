/**
 * SCIM 2.0 /Users – framework-unabhängiger Kern.
 *
 * Unterstützt:  GET /Users (Filter userName/externalId eq, Paging) · GET /Users/{id}
 *               POST /Users · PUT /Users/{id} · PATCH /Users/{id} · DELETE /Users/{id}
 *
 * Offboarding-Garantie: Jede Operation, nach der ein User NICHT aktiv ist (PATCH/PUT active=false oder DELETE),
 * kappt den Kalender-Sync in EINER kurzen DB-Transaktion (Read Committed, User-Sperre zuerst, feste
 * Sperrreihenfolge, lock_timeout 3 s – siehe prismaStore.ts), BEVOR die Antwort an den Identity Provider geht:
 *   Pipelines "revoked", Provider-Tokens vernichtet, Webhook-Abos stop_requested, Job "subscription.teardown"
 *   in job_queue. Im SCIM-Request gibt es KEINEN Aufruf bei Microsoft oder Google – die Antwortzeit hängt nur
 *   an der eigenen Datenbank. Den Provider-Teardown erledigt der Worker (@calensync/core TeardownJobWorker).
 *
 * DELETE /Users/{id}: User wird sofort zum PII-freien Tombstone (deaktiviert, Name/Mail/IDs geleert), für SCIM
 * unsichtbar (GET → 404) und erst nach erfolgreichem Provider-Teardown vom Worker endgültig gelöscht.
 * Antwort 204 No Content (RFC 7644 §3.6 schreibt für DELETE 204 vor).
 * Der Aufruf ist idempotent und läuft bei JEDEM Request mit Ergebnis active=false – auch wenn der User schon
 * inaktiv war. Damit heilt ein Retry des IdP einen vorher abgebrochenen Kappvorgang automatisch.
 *
 * Kompatibilität mit Microsoft Entra ID (ohne Feature-Flag aadOptscim062020):
 *   * "op": "Replace" (Großschreibung) · "value": "False" (String statt Boolean)
 *   * PATCH ohne path mit Objekt-Wert · emails[type eq "work"].value
 * Okta: "op": "replace" + "value": {"active": false}.
 */
import {
  SCHEMA_ENTERPRISE_USER,
  SCHEMA_ERROR,
  SCHEMA_LIST,
  SCHEMA_PATCH,
  SCHEMA_USER,
  type AuditEvent,
  type PipelineRevocationReason,
  type RevocationResult,
  type ScimEmail,
  type ScimRequest,
  type ScimResponse,
  type ScimStore,
  type TenantAuthenticator,
  StoreBusyError,
  type UserRecord,
} from "./types.js";

export interface ScimDeps {
  store: ScimStore;
  auth: TenantAuthenticator;
  /** Öffentliche Basis-URL des SCIM-Endpunkts, z. B. https://acme.calensync.de/scim/v2 */
  baseUrl: string;
  now?: () => Date;
  newId: () => string;
  /** Kennung des aufrufenden Systems im Audit-Log */
  actor?: string;
}

const CONTENT_TYPE = "application/scim+json; charset=utf-8";
const MAX_PAGE = 100;

// ---------------------------------------------------------------------------------------------------
// Fehler
// ---------------------------------------------------------------------------------------------------
class ScimError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
    readonly scimType?: string,
  ) {
    super(detail);
  }
}

function errorResponse(e: ScimError): ScimResponse {
  const body: Record<string, unknown> = { schemas: [SCHEMA_ERROR], status: String(e.status), detail: e.detail };
  if (e.scimType) body.scimType = e.scimType;
  const headers: Record<string, string> = { "Content-Type": CONTENT_TYPE };
  if (e.status === 401) headers["WWW-Authenticate"] = 'Bearer realm="calensync-scim"';
  return { status: e.status, headers, body };
}

// ---------------------------------------------------------------------------------------------------
// Hilfsfunktionen
// ---------------------------------------------------------------------------------------------------
function header(req: ScimRequest, name: string): string | undefined {
  const key = Object.keys(req.headers).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? req.headers[key] : undefined;
}

function normalizeUserName(v: string): string {
  return v.trim().toLowerCase();
}

/** Entra sendet Booleans ohne Feature-Flag als String ("True"/"False"). */
function toBool(v: unknown, attr: string): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true") return true;
    if (s === "false") return false;
  }
  throw new ScimError(400, `Attribut ${attr} erwartet einen Boolean`, "invalidValue");
}

function toStringOrNull(v: unknown, attr: string): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") return v;
  throw new ScimError(400, `Attribut ${attr} erwartet einen String`, "invalidValue");
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseEmails(v: unknown): ScimEmail[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new ScimError(400, "emails muss ein Array sein", "invalidValue");
  return v.map((e, i) => {
    if (!isObject(e) || typeof e.value !== "string") {
      throw new ScimError(400, `emails[${i}].value fehlt`, "invalidValue");
    }
    const out: ScimEmail = { value: e.value };
    if (typeof e.type === "string") out.type = e.type;
    if (e.primary !== undefined) out.primary = toBool(e.primary, `emails[${i}].primary`);
    return out;
  });
}

function etag(u: UserRecord): string {
  return `W/"${u.version}"`;
}

function toScim(u: UserRecord, baseUrl: string): Record<string, unknown> {
  const out: Record<string, unknown> = {
    schemas: u.department !== null ? [SCHEMA_USER, SCHEMA_ENTERPRISE_USER] : [SCHEMA_USER],
    id: u.id,
    userName: u.userName,
    active: u.active,
    emails: u.emails,
    meta: {
      resourceType: "User",
      created: u.createdAt,
      lastModified: u.updatedAt,
      location: `${baseUrl}/Users/${u.id}`,
      version: etag(u),
    },
  };
  if (u.externalId !== null) out.externalId = u.externalId;
  if (u.displayName !== null) out.displayName = u.displayName;
  if (u.name !== null) out.name = u.name;
  if (u.department !== null) out[SCHEMA_ENTERPRISE_USER] = { department: u.department };
  return out;
}

function ok(status: number, body: unknown, extra: Record<string, string> = {}): ScimResponse {
  return { status, headers: { "Content-Type": CONTENT_TYPE, ...extra }, body };
}

// ---------------------------------------------------------------------------------------------------
// Filter (RFC 7644 §3.4.2.2) – bewusst nur die Ausdrücke, die Entra und Okta tatsächlich senden
// ---------------------------------------------------------------------------------------------------
type Filter = { attr: "userName" | "externalId"; value: string };

function parseFilter(raw: string | undefined): Filter | null {
  if (raw === undefined || raw.trim() === "") return null;
  const m = /^\s*(userName|externalId)\s+eq\s+"((?:[^"\\]|\\.)*)"\s*$/i.exec(raw);
  if (!m) throw new ScimError(400, `Filter nicht unterstützt: ${raw}`, "invalidFilter");
  const attr = m[1].toLowerCase() === "username" ? "userName" : "externalId";
  return { attr, value: m[2].replace(/\\(.)/g, "$1") };
}

// ---------------------------------------------------------------------------------------------------
// Audit + Sync-Kappung
// ---------------------------------------------------------------------------------------------------
async function audit(
  deps: ScimDeps,
  tenantId: string,
  req: ScimRequest,
  action: string,
  targetUserId: string | null,
  outcome: AuditEvent["outcome"],
  detail: Record<string, unknown>,
): Promise<void> {
  await deps.store.appendAudit({
    tenantId,
    requestId: req.requestId,
    actor: deps.actor ?? "scim:idp",
    action,
    targetUserId,
    outcome,
    detail,
    at: (deps.now?.() ?? new Date()).toISOString(),
  });
}


// ---------------------------------------------------------------------------------------------------
// Ressourcen-Aufbau aus POST/PUT-Body
// ---------------------------------------------------------------------------------------------------
interface UserInput {
  userName: string;
  externalId: string | null;
  active: boolean;
  displayName: string | null;
  name: UserRecord["name"];
  emails: ScimEmail[];
  department: string | null;
}

function parseUserBody(body: unknown): UserInput {
  if (!isObject(body)) throw new ScimError(400, "Body muss ein JSON-Objekt sein", "invalidSyntax");
  const schemas = body.schemas;
  if (!Array.isArray(schemas) || !schemas.includes(SCHEMA_USER)) {
    throw new ScimError(400, `schemas muss ${SCHEMA_USER} enthalten`, "invalidSyntax");
  }
  if (typeof body.userName !== "string" || body.userName.trim() === "") {
    throw new ScimError(400, "userName ist Pflicht", "invalidValue");
  }
  let name: UserRecord["name"] = null;
  if (isObject(body.name)) {
    name = {};
    if (typeof body.name.givenName === "string") name.givenName = body.name.givenName;
    if (typeof body.name.familyName === "string") name.familyName = body.name.familyName;
    if (typeof body.name.formatted === "string") name.formatted = body.name.formatted;
  }
  const ent = body[SCHEMA_ENTERPRISE_USER];
  return {
    userName: body.userName.trim(),
    externalId: toStringOrNull(body.externalId, "externalId"),
    active: body.active === undefined ? true : toBool(body.active, "active"),
    displayName: toStringOrNull(body.displayName, "displayName"),
    name,
    emails: parseEmails(body.emails),
    department: isObject(ent) ? toStringOrNull(ent.department, "department") : null,
  };
}

// ---------------------------------------------------------------------------------------------------
// PATCH-Operationen
// ---------------------------------------------------------------------------------------------------
const ENT_PREFIX = `${SCHEMA_ENTERPRISE_USER}:`.toLowerCase();

/** Wendet einen Wert auf einen Pfad an. Liefert false, wenn der Pfad bewusst nicht gespeichert wird. */
function applyPath(u: UserRecord, rawPath: string, op: "add" | "replace" | "remove", value: unknown): boolean {
  const path = rawPath.trim();
  const p = path.toLowerCase();
  const val = op === "remove" ? null : value;

  if (p === "active") {
    if (op === "remove") throw new ScimError(400, "active kann nicht entfernt werden", "mutability");
    u.active = toBool(val, "active");
    return true;
  }
  if (p === "username") {
    if (op === "remove" || typeof val !== "string" || val.trim() === "") {
      throw new ScimError(400, "userName darf nicht leer sein", "invalidValue");
    }
    u.userName = val.trim();
    u.userNameNormalized = normalizeUserName(val);
    return true;
  }
  if (p === "externalid") {
    u.externalId = toStringOrNull(val, "externalId");
    return true;
  }
  if (p === "displayname") {
    u.displayName = toStringOrNull(val, "displayName");
    return true;
  }
  if (p === "name") {
    if (val === null) {
      u.name = null;
      return true;
    }
    if (!isObject(val)) throw new ScimError(400, "name muss ein Objekt sein", "invalidValue");
    u.name = { ...(u.name ?? {}) };
    for (const k of ["givenName", "familyName", "formatted"] as const) {
      if (typeof val[k] === "string") u.name[k] = val[k] as string;
    }
    return true;
  }
  const nameSub = /^name\.(givenname|familyname|formatted)$/.exec(p);
  if (nameSub) {
    const key = ({ givenname: "givenName", familyname: "familyName", formatted: "formatted" } as const)[
      nameSub[1] as "givenname" | "familyname" | "formatted"
    ];
    u.name = { ...(u.name ?? {}) };
    if (val === null) delete u.name[key];
    else u.name[key] = toStringOrNull(val, path) ?? undefined;
    return true;
  }
  if (p === "emails") {
    u.emails = op === "remove" ? [] : parseEmails(val);
    return true;
  }
  // emails[type eq "work"].value  (Entra)
  const emailFilter = /^emails\[\s*type\s+eq\s+"([^"]*)"\s*\](?:\.value)?$/i.exec(path);
  if (emailFilter) {
    const type = emailFilter[1];
    const rest = u.emails.filter((e) => (e.type ?? "").toLowerCase() !== type.toLowerCase());
    if (op === "remove") {
      u.emails = rest;
    } else {
      const v = isObject(val) ? val.value : val;
      if (typeof v !== "string") throw new ScimError(400, `${path} erwartet einen String`, "invalidValue");
      u.emails = [...rest, { value: v, type, primary: rest.length === 0 }];
    }
    return true;
  }
  if (p === `${ENT_PREFIX}department`) {
    u.department = toStringOrNull(val, "department");
    return true;
  }
  // Alles andere (phoneNumbers, addresses, manager, title, …) wird bewusst NICHT gespeichert.
  return false;
}

function applyPatch(u: UserRecord, body: unknown): { ignoredPaths: string[] } {
  if (!isObject(body)) throw new ScimError(400, "Body muss ein JSON-Objekt sein", "invalidSyntax");
  if (!Array.isArray(body.schemas) || !body.schemas.includes(SCHEMA_PATCH)) {
    throw new ScimError(400, `schemas muss ${SCHEMA_PATCH} enthalten`, "invalidSyntax");
  }
  const ops = body.Operations ?? body.operations;
  if (!Array.isArray(ops) || ops.length === 0) {
    throw new ScimError(400, "Operations fehlt oder ist leer", "invalidSyntax");
  }
  const ignored: string[] = [];
  for (const raw of ops) {
    if (!isObject(raw) || typeof raw.op !== "string") throw new ScimError(400, "Ungültige Operation", "invalidSyntax");
    const op = raw.op.toLowerCase();
    if (op !== "add" && op !== "replace" && op !== "remove") {
      throw new ScimError(400, `op nicht unterstützt: ${raw.op}`, "invalidSyntax");
    }
    if (typeof raw.path === "string" && raw.path.trim() !== "") {
      if (!applyPath(u, raw.path, op, raw.value)) ignored.push(raw.path);
      continue;
    }
    // Ohne path: value ist ein Objekt mit Attributen (Okta; Entra bei manchen Attributen)
    if (op === "remove") throw new ScimError(400, "remove braucht einen path", "noTarget");
    if (!isObject(raw.value)) throw new ScimError(400, "value muss ein Objekt sein, wenn path fehlt", "invalidValue");
    for (const [k, v] of Object.entries(raw.value)) {
      if (k.toLowerCase() === SCHEMA_ENTERPRISE_USER.toLowerCase() && isObject(v)) {
        for (const [ek, evv] of Object.entries(v)) {
          if (!applyPath(u, `${SCHEMA_ENTERPRISE_USER}:${ek}`, op, evv)) ignored.push(`${SCHEMA_ENTERPRISE_USER}:${ek}`);
        }
        continue;
      }
      if (!applyPath(u, k, op, v)) ignored.push(k);
    }
  }
  return { ignoredPaths: ignored };
}

// ---------------------------------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------------------------------
async function requireUser(deps: ScimDeps, tenantId: string, id: string): Promise<UserRecord> {
  const u = await deps.store.findById(tenantId, id);
  // 404 auch für IDs anderer Mandanten – keine Existenz-Bestätigung über Mandantengrenzen
  if (!u) throw new ScimError(404, `User ${id} nicht gefunden`);
  return u;
}

function checkIfMatch(req: ScimRequest, u: UserRecord): void {
  const im = header(req, "If-Match");
  if (im !== undefined && im !== "*" && im !== etag(u)) {
    throw new ScimError(412, "Version veraltet (If-Match)", "invalidVers");
  }
}

async function ensureUniqueUserName(deps: ScimDeps, tenantId: string, normalized: string, selfId: string | null) {
  const other = await deps.store.findByUserName(tenantId, normalized);
  if (other && other.id !== selfId) throw new ScimError(409, "userName existiert bereits", "uniqueness");
}

async function persist(deps: ScimDeps, u: UserRecord, expectedVersion: number): Promise<void> {
  if (!(await deps.store.update(u, expectedVersion))) {
    throw new ScimError(409, "Gleichzeitige Änderung – bitte wiederholen", "invalidVers");
  }
}

async function listUsers(deps: ScimDeps, tenantId: string, req: ScimRequest): Promise<ScimResponse> {
  const filter = parseFilter(req.query.filter);
  const startIndex = Math.max(1, Number.parseInt(req.query.startIndex ?? "1", 10) || 1);
  const count = Math.min(MAX_PAGE, Math.max(0, Number.parseInt(req.query.count ?? String(MAX_PAGE), 10) || 0));

  let total: number;
  let items: UserRecord[];
  if (filter) {
    const hit =
      filter.attr === "userName"
        ? await deps.store.findByUserName(tenantId, normalizeUserName(filter.value))
        : await deps.store.findByExternalId(tenantId, filter.value);
    items = hit && startIndex === 1 && count > 0 ? [hit] : [];
    total = hit ? 1 : 0;
  } else {
    const page = await deps.store.list(tenantId, startIndex - 1, count);
    total = page.total;
    items = page.items;
  }
  return ok(200, {
    schemas: [SCHEMA_LIST],
    totalResults: total,
    startIndex,
    itemsPerPage: items.length,
    Resources: items.map((u) => toScim(u, deps.baseUrl)),
  });
}

async function createUser(deps: ScimDeps, tenantId: string, req: ScimRequest): Promise<ScimResponse> {
  const input = parseUserBody(req.body);
  const normalized = normalizeUserName(input.userName);
  await ensureUniqueUserName(deps, tenantId, normalized, null);

  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  const user: UserRecord = {
    id: deps.newId(),
    tenantId,
    userNameNormalized: normalized,
    ...input,
    version: 1,
    createdAt: nowIso,
    updatedAt: nowIso,
    deprovisionedAt: input.active ? null : nowIso,
  };
  await deps.store.insert(user);
  await audit(deps, tenantId, req, "scim.user.create", user.id, "success", {
    userName: user.userName,
    externalId: user.externalId,
    active: user.active,
  });
  const body = toScim(user, deps.baseUrl);
  return ok(201, body, { Location: `${deps.baseUrl}/Users/${user.id}`, ETag: etag(user) });
}

async function finishWrite(
  deps: ScimDeps,
  tenantId: string,
  req: ScimRequest,
  before: UserRecord,
  after: UserRecord,
  action: string,
  extra: Record<string, unknown>,
): Promise<ScimResponse> {
  const nowIso = (deps.now?.() ?? new Date()).toISOString();
  if (after.userNameNormalized !== before.userNameNormalized) {
    await ensureUniqueUserName(deps, tenantId, after.userNameNormalized, after.id);
  }

  after.version = before.version + 1;
  after.updatedAt = nowIso;

  let revocation: RevocationResult | null = null;
  if (!after.active) {
    // Deaktivierung: User-Status UND Kappung in EINER Transaktion unter der User-Sperre. Kein Zeitfenster,
    // in dem ein gerade gesperrter User über einen parallelen Pfad neue Tokens oder Pipelines bekommt.
    // Läuft bei JEDEM Ergebnis active=false (idempotent) – ein IdP-Retry heilt einen früheren Abbruch.
    after.deprovisionedAt = before.active ? nowIso : before.deprovisionedAt ?? nowIso;
    const r = await deps.store.deactivateAndRevoke(after, before.version, "scim_deactivated");
    revocation = r.revocation;
    await audit(deps, tenantId, req, "scim.user.sync_revoked", after.id, "success", { reason: "scim_deactivated", ...revocation });
    // Versionskonflikt: Sync ist trotzdem gekappt (Kill-Switch geht vor), nur der Datensatz nicht geschrieben
    if (!r.userWritten) throw new ScimError(409, "Gleichzeitige Änderung – bitte wiederholen", "invalidVers");
  } else {
    if (!before.active) {
      // Reaktivierung: Pipelines bleiben "revoked", bis Admin/Nutzer sie bewusst neu freigibt.
      after.deprovisionedAt = null;
    }
    await persist(deps, after, before.version);
  }

  const deactivated = before.active && !after.active;
  const reactivated = !before.active && after.active;
  await audit(
    deps,
    tenantId,
    req,
    deactivated ? "scim.user.deactivate" : reactivated ? "scim.user.reactivate" : action,
    after.id,
    "success",
    { ...extra, active: after.active, revocation },
  );
  return ok(200, toScim(after, deps.baseUrl), { ETag: etag(after) });
}

async function replaceUser(deps: ScimDeps, tenantId: string, id: string, req: ScimRequest): Promise<ScimResponse> {
  const before = await requireUser(deps, tenantId, id);
  checkIfMatch(req, before);
  const input = parseUserBody(req.body);
  const after: UserRecord = {
    ...before,
    ...input,
    userNameNormalized: normalizeUserName(input.userName),
  };
  return finishWrite(deps, tenantId, req, before, after, "scim.user.replace", {});
}

async function patchUser(deps: ScimDeps, tenantId: string, id: string, req: ScimRequest): Promise<ScimResponse> {
  const before = await requireUser(deps, tenantId, id);
  checkIfMatch(req, before);
  const after: UserRecord = {
    ...before,
    emails: before.emails.map((e) => ({ ...e })),
    name: before.name ? { ...before.name } : null,
  };
  const { ignoredPaths } = applyPatch(after, req.body);
  return finishWrite(deps, tenantId, req, before, after, "scim.user.patch", { ignoredPaths });
}

async function deleteUser(deps: ScimDeps, tenantId: string, id: string, req: ScimRequest): Promise<ScimResponse> {
  const before = await requireUser(deps, tenantId, id);
  checkIfMatch(req, before);
  const nowIso = (deps.now?.() ?? new Date()).toISOString();

  // EINE Transaktion: Kappung + PII-freier Tombstone + Job "subscription.teardown" (purgeUser=true).
  // Kein Provider-Aufruf im Request – Microsoft kann die Antwort an Entra weder verzögern noch scheitern lassen.
  const revocation = await deps.store.markDeletedAndEnqueueTeardown(tenantId, id, nowIso);
  if (!revocation) throw new ScimError(404, `User ${id} nicht gefunden`); // parallel gelöscht

  // Audit enthält nur die interne ID – Name und Mail sind bereits entfernt.
  await audit(deps, tenantId, req, "scim.user.delete", id, "success", {
    ...revocation,
    teardown: "queued",
    purgeAfterTeardown: true,
  });
  return { status: 204, headers: {} };
}

// ---------------------------------------------------------------------------------------------------
// Einstieg
// ---------------------------------------------------------------------------------------------------
export async function handleScim(req: ScimRequest, deps: ScimDeps): Promise<ScimResponse> {
  let tenantId: string | null = null;
  try {
    const authz = header(req, "Authorization") ?? "";
    const m = /^Bearer\s+(\S+)$/i.exec(authz);
    tenantId = m ? await deps.auth.authenticate(m[1]) : null;
    if (!tenantId) throw new ScimError(401, "Authentifizierung erforderlich");

    const path = req.path.replace(/\/+$/, "") || "/";
    const method = req.method.toUpperCase();

    if (path === "/Users") {
      if (method === "GET") return await listUsers(deps, tenantId, req);
      if (method === "POST") return await createUser(deps, tenantId, req);
      throw new ScimError(405, `${method} auf /Users nicht erlaubt`);
    }

    const m2 = /^\/Users\/([A-Za-z0-9-]{1,64})$/.exec(path);
    if (m2) {
      const id = m2[1];
      if (method === "GET") {
        const u = await requireUser(deps, tenantId, id);
        return ok(200, toScim(u, deps.baseUrl), { ETag: etag(u) });
      }
      if (method === "PUT") return await replaceUser(deps, tenantId, id, req);
      if (method === "PATCH") return await patchUser(deps, tenantId, id, req);
      if (method === "DELETE") return await deleteUser(deps, tenantId, id, req);
      throw new ScimError(405, `${method} auf /Users/{id} nicht erlaubt`);
    }

    throw new ScimError(404, `Ressource ${path} nicht unterstützt`);
  } catch (err) {
    if (err instanceof ScimError) {
      if (tenantId && err.status !== 404) {
        await audit(deps, tenantId, req, "scim.request.rejected", null, "failure", {
          status: err.status,
          scimType: err.scimType ?? null,
          detail: err.detail,
          method: req.method,
          path: req.path,
        }).catch(() => undefined);
      }
      return errorResponse(err);
    }
    if (err instanceof StoreBusyError) {
      // Sperre/Timeout nach allen Wiederholungen: nichts committed. 503 + Retry-After statt 500 –
      // der IdP wiederholt, alle Operationen sind idempotent.
      const res = errorResponse(new ScimError(503, `Vorübergehend ausgelastet (requestId ${req.requestId})`));
      res.headers["Retry-After"] = "5";
      return res;
    }
    // Unerwarteter Fehler: keine Interna nach außen. IdP wiederholt den Request; Kappung ist idempotent.
    return errorResponse(new ScimError(500, `Interner Fehler (requestId ${req.requestId})`));
  }
}
