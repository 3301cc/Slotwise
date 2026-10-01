/**
 * Domänen- und SCIM-Typen für den CalenSync-SCIM-2.0-Endpunkt (RFC 7643 / RFC 7644).
 *
 * Datenminimierung: Gespeichert wird nur, was für Provisionierung, Zuordnung zu Pipelines und den
 * Audit-Nachweis nötig ist. Kein Telefon, keine Adresse, kein Foto, kein Manager.
 */

export const SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCHEMA_ENTERPRISE_USER = "urn:ietf:params:scim:schemas:extension:enterprise:2.0:User";
export const SCHEMA_LIST = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCHEMA_PATCH = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

export interface ScimEmail {
  value: string;
  type?: string;
  primary?: boolean;
}

export interface ScimName {
  givenName?: string;
  familyName?: string;
  formatted?: string;
}

/** Interner Datensatz – immer an genau einen Mandanten gebunden. */
export interface UserRecord {
  id: string; // von CalenSync vergeben (UUID), unveränderlich
  tenantId: string;
  userName: string; // UPN aus Entra / primäre E-Mail aus Okta
  userNameNormalized: string; // lower-case, für Eindeutigkeit je Mandant
  externalId: string | null; // Entra objectId / Okta id
  active: boolean;
  displayName: string | null;
  name: ScimName | null;
  emails: ScimEmail[];
  department: string | null;
  version: number; // für ETag (meta.version)
  createdAt: string;
  updatedAt: string;
  deprovisionedAt: string | null;
}

export type PipelineRevocationReason = "scim_deactivated" | "scim_deleted";

export interface RevocationResult {
  pipelinesRevoked: number;
  tokensDestroyed: number;
  subscriptionsQueuedForStop: number;
  /** Job "subscription.teardown" in derselben Transaktion eingestellt (false = gleicher Job wartet schon) */
  teardownJobQueued: boolean;
}

/** Job-Art und Payload für den asynchronen Provider-Teardown (abgearbeitet von @calensync/core). */
export const TEARDOWN_JOB_KIND = "subscription.teardown";

export interface TeardownJobPayload {
  userId: string;
  /** true = nach erfolgreichem Teardown den (bereits PII-freien) Tombstone endgültig löschen */
  purgeUser: boolean;
  requestedAt: string;
}

/** Dedupe-Schlüssel: Deaktivieren und Löschen sind getrennte Jobs, damit ein wartender Deaktivierungs-Job
 *  den Lösch-Job nicht verschluckt. */
export const teardownDedupeKey = (userId: string, purgeUser: boolean) => `${purgeUser ? "purge" : "teardown"}:${userId}`;


export interface AuditEvent {
  tenantId: string;
  requestId: string;
  actor: string; // z. B. "scim:entra-provisioning"
  action: string; // scim.user.create | scim.user.deactivate | …
  targetUserId: string | null;
  outcome: "success" | "failure";
  detail: Record<string, unknown>;
  at: string;
}

/** Persistenz-Schnittstelle. Jede Methode ist mandantengebunden – es gibt keine tenant-übergreifende Abfrage. */
export interface ScimStore {
  findById(tenantId: string, id: string): Promise<UserRecord | null>;
  findByUserName(tenantId: string, userNameNormalized: string): Promise<UserRecord | null>;
  findByExternalId(tenantId: string, externalId: string): Promise<UserRecord | null>;
  list(tenantId: string, offset: number, limit: number): Promise<{ total: number; items: UserRecord[] }>;
  insert(user: UserRecord): Promise<void>;
  /** Optimistic Locking: schlägt fehl (false), wenn sich version inzwischen geändert hat. */
  update(user: UserRecord, expectedVersion: number): Promise<boolean>;
  /**
   * Sync sofort und vollständig kappen – in EINER Transaktion:
   * Pipelines auf "revoked", verschlüsselte Provider-Tokens vernichten, Webhook-Abos auf stop_requested,
   * Job "subscription.teardown" (purgeUser=false) in job_queue. KEIN Provider-Aufruf im Request.
   * Idempotent: ein zweiter Aufruf liefert 0/0/0 und stellt höchstens einen wartenden Job ein.
   */
  revokeSyncForUser(tenantId: string, userId: string, reason: PipelineRevocationReason): Promise<RevocationResult>;
  /**
   * SCIM PATCH/PUT mit active=false – in EINER Transaktion unter der User-Sperre:
   * User-Datensatz schreiben (Optimistic Locking auf expectedVersion) + Kappung wie revokeSyncForUser.
   * Bei Versionskonflikt wird der User NICHT geschrieben, die Kappung aber trotzdem ausgeführt
   * (Kill-Switch geht vor; userWritten = false → SCIM antwortet 409, der IdP wiederholt idempotent).
   */
  deactivateAndRevoke(
    user: UserRecord,
    expectedVersion: number,
    reason: PipelineRevocationReason,
  ): Promise<{ revocation: RevocationResult; userWritten: boolean }>;
  /**
   * SCIM DELETE – in EINER Transaktion:
   *   Kappung wie revokeSyncForUser (reason "scim_deleted")
   *   + User wird zum Tombstone: active=false, deletion_requested_at gesetzt, ALLE personenbezogenen Felder
   *     geleert (userName → "deleted-<id>", externalId/Name/Mails/Abteilung → leer)
   *   + Job "subscription.teardown" mit purgeUser=true
   * Tombstones sind für alle find- und list-Methoden unsichtbar (GET → 404) und blockieren keine Neuanlage.
   * Liefert null, wenn der User nicht (mehr) sichtbar existiert.
   */
  markDeletedAndEnqueueTeardown(tenantId: string, userId: string, atIso: string): Promise<RevocationResult | null>;
  /** Endgültige Löschung NUR eines Tombstones (deletion_requested_at IS NOT NULL). Aktive User: false. */
  purgeDeletedUser(tenantId: string, userId: string): Promise<boolean>;
  appendAudit(event: AuditEvent): Promise<void>;
}

/** Mandanten-Authentisierung des SCIM-Clients (Entra/Okta). */
export interface TenantAuthenticator {
  /** Liefert die tenantId zum Bearer-Token oder null. Vergleich muss timing-sicher sein. */
  authenticate(bearerToken: string): Promise<string | null>;
}

export interface ScimRequest {
  method: string;
  /** Pfad relativ zum SCIM-Basis-Pfad, z. B. "/Users" oder "/Users/9f1c…" */
  path: string;
  query: Record<string, string | undefined>;
  headers: Record<string, string | undefined>;
  body: unknown;
  requestId: string;
}

export interface ScimResponse {
  status: number;
  headers: Record<string, string>;
  body?: unknown;
}

/**
 * Datenbank vorübergehend nicht in der Lage, die Transaktion abzuschließen (lock_timeout, Serialisierungs-
 * oder Deadlock-Abbruch nach allen Wiederholungen). SCIM antwortet 503 + Retry-After statt 500.
 */
export class StoreBusyError extends Error {
  constructor(readonly attempts: number, cause?: unknown) {
    super(`Datenbank ausgelastet (${attempts} Versuche)`, { cause });
    this.name = "StoreBusyError";
  }
}
