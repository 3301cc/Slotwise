"use strict";
/*
 * Kalender des Hosts – Verfügbarkeit, Buchungen, Vorschläge, Blocker.
 *
 * Im Store liegen drei Listen: cal:bookings (fest), cal:proposals (KI-Vorschlag, offen), cal:blocked (belegt).
 * Externe Kalender (Google, Microsoft 365, CalDAV) schreiben ihre Belegungen als Blocker in cal:blocked –
 * ein Sync-Adapter ruft dafür `calendar.setBlocked(list)` auf (die Adapter aus 2-packages-platform/…/adapters
 * liefern genau dieses Format: { start, end, title?, source }). Solange kein Adapter läuft, ist die Liste leer.
 *
 * Alle Zeiten ISO-8601 in UTC. Arbeitszeiten werden in der Zeitzone des Hosts ausgewertet.
 */
const SLOT_MINUTES = 30;

function berlinParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

function createCalendar(store, opts = {}) {
  const tz = opts.timezone || "Europe/Berlin";
  const hours = opts.workingHours || { start: 9 * 60, end: 17 * 60, days: [0, 1, 2, 3, 4] }; // Mo–Fr 09–17
  const now = opts.now || (() => Date.now());
  const list = (k) => store.listRange(k, 500);

  async function busyIntervals() {
    const [b, p, x] = await Promise.all([list("cal:bookings"), list("cal:proposals"), list("cal:blocked")]);
    return [...b, ...p, ...x].map((s) => ({ ...s, s: Date.parse(s.start), e: Date.parse(s.end) }));
  }

  return {
    timezone: tz,

    /** Freie Slots im Fenster, höchstens `limit`. Berücksichtigt Arbeitszeit, Blocker, Buchungen, offene Vorschläge und das Tageslimit. */
    async findAvailability({ from, to, durationMinutes = 30, limit = 6, maxPerDay = Infinity }) {
      const start = Math.max(Date.parse(from), now() + 60 * 60000); // frühestens in 1 Stunde
      const end = Math.min(Date.parse(to), start + 14 * 86400000);
      const busy = await busyIntervals();
      const perDay = {};
      for (const b of busy) if (b.kind === "booked" || b.kind === "proposed") { const d = berlinParts(b.start, tz).day; perDay[d] = (perDay[d] || 0) + 1; }
      const out = [];
      const step = SLOT_MINUTES * 60000;
      for (let t = Math.ceil(start / step) * step; t + durationMinutes * 60000 <= end && out.length < limit; t += step) {
        const p = berlinParts(new Date(t).toISOString(), tz);
        if (!hours.days.includes(p.weekday)) continue;
        if (p.minutes < hours.start || p.minutes + durationMinutes > hours.end) continue;
        if ((perDay[p.day] || 0) >= maxPerDay) continue;
        const tEnd = t + durationMinutes * 60000;
        if (busy.some((b) => overlaps(t, tEnd, b.s, b.e))) continue;
        out.push({ start: new Date(t).toISOString(), end: new Date(tEnd).toISOString(), label: formatForSpeech(t, tz) });
      }
      return out;
    },

    /** Ist der Slot frei? Liefert bei Konflikt den Verursacher. */
    async conflictFor(start, end) {
      const s = Date.parse(start), e = Date.parse(end);
      const busy = await busyIntervals();
      return busy.find((b) => overlaps(s, e, b.s, b.e)) || null;
    },
    async countOnDay(startIso) {
      const d = berlinParts(startIso, tz).day;
      const [b, p] = await Promise.all([list("cal:bookings"), list("cal:proposals")]);
      return [...b, ...p].filter((x) => berlinParts(x.start, tz).day === d).length;
    },

    async addBooking(slot) { await store.listPush("cal:bookings", { ...slot, kind: "booked" }, 500); },
    async addProposal(slot) { await store.listPush("cal:proposals", { ...slot, kind: "proposed" }, 500); },
    async setBlocked(blocks) { await store.listReplace("cal:blocked", blocks.map((b) => ({ ...b, kind: "blocked" }))); },
    async addBlocked(block) { await store.listPush("cal:blocked", { ...block, kind: "blocked" }, 500); },

    /** Vorschlag freigeben (→ Buchung) oder ablehnen (→ entfernt). */
    async decide(id, action) {
      const proposals = await list("cal:proposals");
      const p = proposals.find((x) => x.id === id);
      if (!p) return null;
      await store.listReplace("cal:proposals", proposals.filter((x) => x.id !== id));
      if (action === "approve") await store.listPush("cal:bookings", { ...p, kind: "booked", approvedAt: new Date(now()).toISOString() }, 500);
      return p;
    },

    /** Alles im Fenster, für die Wochenansicht. */
    async week(fromIso, toIso) {
      const s = Date.parse(fromIso), e = Date.parse(toIso);
      const all = await busyIntervals();
      return all.filter((b) => overlaps(s, e, b.s, b.e)).map(({ s: _s, e: _e, ...rest }) => rest).sort((a, b) => a.start.localeCompare(b.start));
    },
  };
}

function formatForSpeech(ms, tz) {
  return new Intl.DateTimeFormat("de-DE", { timeZone: tz, weekday: "long", day: "numeric", month: "long", hour: "numeric", minute: "2-digit" }).format(new Date(ms)).replace(",", ",") + " Uhr";
}

module.exports = { createCalendar, formatForSpeech };
