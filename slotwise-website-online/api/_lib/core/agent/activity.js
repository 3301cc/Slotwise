"use strict";
/*
 * Aktivitätslog des Agenten – das, was der Live-Feed im Dashboard zeigt.
 * Ein Eintrag pro Entscheidung: kind steuert die Farbe (booked=grün, proposed/buffer=indigo, conflict=rot, info=grau).
 * Liegt als Liste im Store (Redis: LPUSH/LTRIM, lokal: JSON-Datei), höchstens 200 Einträge.
 * Zusätzlich dient es als Audit-Senke des ToolRouters (technische Einträge, kind "audit", im Feed ausgeblendet).
 */
const crypto = require("node:crypto");

function createActivity(store, now = () => Date.now()) {
  const KEY = "agent:activity";
  return {
    async log(entry) {
      const e = { id: crypto.randomUUID(), at: new Date(now()).toISOString(), ...entry };
      await store.listPush(KEY, e, 200);
      return e;
    },
    /** Einträge, neueste zuerst; `since` (ISO) liefert nur neuere – fürs Polling. */
    async list({ limit = 30, since = null, includeAudit = false } = {}) {
      const all = await store.listRange(KEY, 200);
      return all.filter((e) => (includeAudit || e.kind !== "audit") && (!since || e.at > since)).slice(0, limit);
    },
    /** AuditLog-Schnittstelle des ToolRouters */
    audit: {
      write: async (entry) => { await store.listPush(KEY, { id: crypto.randomUUID(), kind: "audit", text: `${entry.action} → ${entry.outcome}${entry.reason ? ` (${entry.reason})` : ""}`, callSid: entry.callSid, at: entry.at }, 200); },
    },
  };
}

module.exports = { createActivity };
