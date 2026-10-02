"use strict";
/*
 * Aufbewahrungsfristen des KI-Agenten (Datensparsamkeit, Art. 5 Abs. 1 lit. c/e DSGVO).
 *
 *   Aufgaben fürs Praxisteam (Name, Geburtsdatum, Rückrufnummer)   30 Tage nach Eingang       → gelöscht
 *   Termine, Vorschläge, Blocker (inkl. Geburtsdatum im Praxismodus) 90 Tage nach Terminende  → gelöscht
 *   Aktivitätsprotokoll (Live-Feed, Audit-Einträge)                  90 Tage                    → gelöscht
 *
 * Fristen per AGENT_RETENTION_*_DAYS änderbar (core/config.js). Zusätzlich gelten die rollierenden Obergrenzen der
 * Listen (500 bzw. 200 Einträge). Gelöscht wird gezielt per listRemove, damit parallel neu angelegte Einträge
 * erhalten bleiben. Der Lauf ist gedrosselt (höchstens alle 6 h je Mandant) und wird bei normaler Nutzung angestoßen.
 */
const DAY_MS = 86400000;
const SWEEP_EVERY_MS = 6 * 3600000;
const MARK = "agent:retention:last";
const DEFAULTS = { tasksDays: 30, calendarDays: 90, activityDays: 90 };

function createRetention(store, now = () => Date.now(), opts = {}) {
  const d = { ...DEFAULTS };
  for (const k of Object.keys(DEFAULTS)) if (Number.isFinite(opts[k]) && opts[k] >= 1) d[k] = Math.floor(opts[k]);

  async function prune(key, max, isExpired) {
    const all = await store.listRange(key, max);
    const expired = all.filter(isExpired);
    if (!expired.length) return 0;
    return store.listRemove(key, expired);
  }

  return {
    days: d,
    /** Abgelaufene Einträge löschen. force=true ignoriert die Drosselung (Tests, manueller Lauf). */
    async sweep({ force = false } = {}) {
      const t = now();
      if (!force) {
        const last = await store.getJson(MARK);
        if (typeof last === "number" && t - last < SWEEP_EVERY_MS) return null;
      }
      await store.setJson(MARK, t, 7 * 86400);
      const older = (iso, days) => { const ms = Date.parse(iso); return !Number.isFinite(ms) || ms < t - days * DAY_MS; };
      const res = {
        tasks: await prune("agent:tasks", 200, (x) => older(x && x.at, d.tasksDays)),
        activity: await prune("agent:activity", 200, (x) => older(x && x.at, d.activityDays)),
        bookings: 0, proposals: 0, blocked: 0,
      };
      // Ohne Zeitangabe nie löschen (z. B. manuell gepflegte Blocker ohne Ende) – nur Einträge mit klarem Ende
      const calExpired = (x) => x && (x.end || x.start) && older(x.end || x.start, d.calendarDays);
      res.bookings = await prune("cal:bookings", 500, calExpired);
      res.proposals = await prune("cal:proposals", 500, calExpired);
      res.blocked = await prune("cal:blocked", 500, calExpired);
      return res;
    },
  };
}

module.exports = { createRetention, RETENTION_DEFAULTS: DEFAULTS };
