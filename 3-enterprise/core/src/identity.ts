/**
 * "Dieselbe Person" für account-Ziele per Microsoft Graph prüfen – bei der Anlage (API) und im Sync-Worker
 * (vor dem ersten Schreiben und danach spätestens alle 24 h).
 *
 *   objectId                         nur eigener Mandant: GET /users/{zielpostfach}?$select=id muss genau die
 *                                    Entra-Objekt-ID des Inhabers liefern (Alias/Proxy-Adresse desselben Objekts)
 *   employeeId | onPremisesImmutableId | onPremisesSecurityIdentifier
 *                                    GET /users/{inhaber-oid}?$select=id,<attr> (Heim-Token) und
 *                                    GET /users/{zielpostfach}?$select=id,<attr> (Token des Zielmandanten);
 *                                    beide Werte nicht leer und exakt gleich
 *   localPart                        keine Graph-Prüfung (ausdrückliches Opt-in, siehe syncTargets.ts)
 *
 * Werte werden weder gespeichert noch geloggt; gespeichert wird nur Zeitpunkt + Merkmal der Prüfung.
 * Lesen von Nutzerattributen braucht die Anwendungsberechtigung User.Read.All (bzw. User.ReadBasic.All für
 * objectId) im jeweiligen Mandanten.
 */
import type { GraphCaller } from "./syncWorker.js";
import { GRAPH_BASE, RunAborted } from "./syncWorker.js";
import type { IdentityAttribute } from "./syncTargets.js";

export type IdentityVerdict =
  | { kind: "verified"; attribute: IdentityAttribute }
  /** andere Person, Merkmal leer oder Zielpostfach unbekannt */
  | { kind: "rejected"; why: "different_person" | "attribute_missing" | "target_not_found" | "forbidden" }
  /** vorübergehend nicht prüfbar (429/5xx/Netz) – nicht erlauben, später erneut */
  | { kind: "unavailable"; status: number; body: string; retryAfter: string | null };

export interface IdentitySubject {
  /** scim_users.external_id = Entra-Objekt-ID des Inhabers im Heim-Mandanten */
  ownerObjectId: string;
  /** Zielpostfach und dessen Mandant (null = Heim-Mandant) */
  mailbox: string;
  entraTenantId: string | null;
  attribute: IdentityAttribute;
  /** google: Zielpostfach in einem verknüpften Google Workspace (Prüfung über verifyGoogleIdentity) */
  provider?: "microsoft" | "google";
  workspaceId?: string | null;
}

const transient = (status: number) => status === 0 || status === 429 || status >= 500;

async function readUser(call: GraphCaller, idOrUpn: string, attr: string | null, entraTenantId: string | null) {
  const select = attr ? `id,${attr}` : "id";
  try {
    const r = await call("GET", `${GRAPH_BASE}/users/${encodeURIComponent(idOrUpn)}?$select=${select}`, undefined, entraTenantId);
    if (r.status !== 200) return { status: r.status, body: r.text, retryAfter: r.retryAfter, user: null };
    return { status: 200, body: "", retryAfter: null, user: JSON.parse(r.text) as Record<string, unknown> };
  } catch (err) {
    // Abbruch durch den Checkpoint (Pipeline beendet) muss durchgereicht werden
    if (err instanceof RunAborted) throw err;
    return { status: 0, body: err instanceof Error ? err.name : "error", retryAfter: null, user: null };
  }
}

export async function verifyIdentity(call: GraphCaller, s: IdentitySubject): Promise<IdentityVerdict> {
  if (s.attribute === "localPart") return { kind: "verified", attribute: "localPart" };
  const attr = s.attribute === "objectId" ? null : s.attribute;
  // objectId über Mandantengrenzen ist bedeutungslos (andere Objekte) → Konfigurationsfehler, nie "verified"
  if (s.attribute === "objectId" && s.entraTenantId !== null) return { kind: "rejected", why: "attribute_missing" };

  const target = await readUser(call, s.mailbox, attr, s.entraTenantId);
  if (target.status !== 200) {
    if (transient(target.status)) return { kind: "unavailable", status: target.status, body: target.body, retryAfter: target.retryAfter };
    return { kind: "rejected", why: target.status === 404 ? "target_not_found" : "forbidden" };
  }
  if (s.attribute === "objectId") {
    const id = target.user?.id;
    // GUIDs sind per Definition nicht case-sensitiv; Graph liefert sie klein
    return typeof id === "string" && id !== "" && id.toLowerCase() === s.ownerObjectId.toLowerCase()
      ? { kind: "verified", attribute: "objectId" }
      : { kind: "rejected", why: "different_person" };
  }
  const owner = await readUser(call, s.ownerObjectId, attr, null);
  if (owner.status !== 200) {
    if (transient(owner.status)) return { kind: "unavailable", status: owner.status, body: owner.body, retryAfter: owner.retryAfter };
    return { kind: "rejected", why: "forbidden" };
  }
  const a = owner.user?.[attr as string];
  const b = target.user?.[attr as string];
  if (typeof a !== "string" || typeof b !== "string" || a.trim() === "" || b.trim() === "") return { kind: "rejected", why: "attribute_missing" };
  return a === b ? { kind: "verified", attribute: s.attribute } : { kind: "rejected", why: "different_person" };
}
