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
 *
 * Optional: Belegungen aus CalenSync Enterprise (Microsoft 365, Ziel „Buchungsseite“).
 *   ENTERPRISE_BUSY_URL / ENTERPRISE_BUSY_TOKEN (bzw. je Mandant in TENANTS_JSON) → opts.busySource = { url, token }
 *   GET <url>?from=<iso>&to=<iso>, Authorization: Bearer <token> → { busy: [{ start, end }] } (max. 62 Tage, ohne Personenbezug)
 *   Abruf mit 3 s Timeout; Ergebnis je Zeitfenster ~60 s im Prozess zwischengespeichert.
 *
 *   Ausfallverhalten (bewusst unterschiedlich):
 *   - findAvailability: FAIL-OPEN. Ist CalenSync nicht erreichbar, werden Slots nur nach lokalem Kalender angeboten.
 *     Eine Liste ohne Vorschläge wäre für Anrufende schlechter, und kein angebotener Slot wird ungeprüft gebucht:
 *   - conflictFor (letzte Prüfung vor Buchung/Vorschlag): FAIL-CLOSED. Lässt sich der Slot nicht frisch gegen
 *     CalenSync prüfen, gilt er als belegt (kind "unverified") – der Agent bucht nicht, sondern bietet Rückruf bzw.
 *     Buchungslink an. Lieber ein verpasster Termin als eine Doppelbuchung im Outlook-Kalender.
 */
const crypto = require("node:crypto");

const SLOT_MINUTES = 30;
const BUSY_TIMEOUT_MS = 3000;
const BUSY_CACHE_MS = 60_000;
const BUSY_MAX_DAYS = 62;
const BUSY_MAX_ITEMS = 5000;
const DAY_MS = 86400000;

function berlinParts(iso, tz) {
  const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: tz, weekday: "short", year: "numeric", month: "2-digit", day: "2-digit", hour: "numeric", minute: "numeric", hourCycle: "h23" })
    .formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
  return { weekday: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), day: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
const overlaps = (aS, aE, bS, bE) => aS < bE && bS < aE;

/**
 * { url, token } aus Rohwerten (Umgebung bzw. TENANTS_JSON) – nur https (lokal auch http://localhost), Token Pflicht.
 * Ungültig → null mit Fehlermeldung im Log (Token wird nie geloggt).
 */
function parseBusySource(url, token, log = console) {
  const u = String(url || "").trim(), t = String(token || "").trim();
  if (!u && !t) return null;
  let parsed = null;
  try { parsed = new URL(u); } catch { /* unten gemeldet */ }
  const okUrl = parsed && !parsed.username && !parsed.password && (parsed.protocol === "https:" || (parsed.protocol === "http:" && /^(localhost|127\.0\.0\.1)$/.test(parsed.hostname)));
  if (!okUrl || !t) { log.error(`[calendar] ENTERPRISE_BUSY_URL/-TOKEN ungültig oder unvollständig – CalenSync-Belegungen werden nicht abgefragt`); return null; }
  return { url: parsed.toString(), token: t };
}

// Prozessweiter Zwischenspeicher (Vercel: je Function-Container). Schlüssel: URL + Token-Hash + Fenster.
const busyCache = new Map();
function cacheSet(key, value) {
  busyCache.set(key, value);
  if (busyCache.size > 200) busyCache.delete(busyCache.keys().next().value); // ältester Eintrag zuerst
}

/** Belegungen aus CalenSync. Wirft bei jedem Fehler (Timeout, HTTP-Status, kaputte Antwort) – Aufrufer entscheidet. */
function createBusyFetcher(src, { fetchFn, now }) {
  const tokenHash = crypto.createHash("sha256").update(src.token).digest("hex").slice(0, 16);
  return async function fetchBusy(fromMs, toMs, { fresh = false } = {}) {
    // Fenster auf volle UTC-Tage erweitern: weniger verschiedene Schlüssel, bessere Trefferquote
    const from = Math.floor(fromMs / DAY_MS) * DAY_MS;
    const to = Math.min(Math.max(Math.ceil(toMs / DAY_MS) * DAY_MS, from + DAY_MS), from + BUSY_MAX_DAYS * DAY_MS);
    const key = `${src.url}|${tokenHash}|${from}|${to}`;
    const hit = busyCache.get(key);
    if (!fresh && hit && now() - hit.at < BUSY_CACHE_MS) return hit.list;
    const u = new URL(src.url);
    u.searchParams.set("from", new Date(from).toISOString());
    u.searchParams.set("to", new Date(to).toISOString());
    // 3 s für Antwort UND Body; eigener Timer statt AbortSignal.timeout(), damit er sicher läuft und aufgeräumt wird
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(new Error(`Timeout nach ${BUSY_TIMEOUT_MS} ms`)), BUSY_TIMEOUT_MS);
    let body;
    try {
      const res = await fetchFn(u.toString(), { method: "GET", headers: { Authorization: `Bearer ${src.token}`, Accept: "application/json" }, signal: ctrl.signal, redirect: "error" });
      if (!res.ok) throw new Error(`CalenSync busy: HTTP ${res.status}`);
      body = await res.json();
    } finally {
      clearTimeout(timer);
    }
    if (!body || !Array.isArray(body.busy)) throw new Error("CalenSync busy: Antwort ohne busy[]");
    const list = [];
    for (const b of body.busy.slice(0, BUSY_MAX_ITEMS)) {
      const s = Date.parse(b && b.start), e = Date.parse(b && b.end);
      if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) continue; // unbrauchbare Einträge überspringen
      list.push({ start: new Date(s).toISOString(), end: new Date(e).toISOString(), title: "Belegt", source: "microsoft", kind: "blocked", s, e });
    }
    cacheSet(key, { at: now(), list });
    return list;
  };
}

function createCalendar(store, opts = {}) {
  const tz = opts.timezone || "Europe/Berlin";
  const hours = opts.workingHours || { start: 9 * 60, end: 17 * 60, days: [0, 1, 2, 3, 4] }; // Mo–Fr 09–17
  const now = opts.now || (() => Date.now());
  const log = opts.log || console;
  const list = (k) => store.listRange(k, 500);
  const fetchBusy = opts.busySource ? createBusyFetcher(opts.busySource, { fetchFn: opts.fetch || globalThis.fetch, now }) : null;

  async function busyIntervals() {
    const [b, p, x] = await Promise.all([list("cal:bookings"), list("cal:proposals"), list("cal:blocked")]);
    return [...b, ...p, ...x].map((s) => ({ ...s, s: Date.parse(s.start), e: Date.parse(s.end) }));
  }
  /** Fail-open (siehe oben): bei Fehler leere Liste, damit trotzdem Slots angeboten werden. */
  async function remoteBusyOpen(fromMs, toMs) {
    if (!fetchBusy) return [];
    try { return await fetchBusy(fromMs, toMs); } catch (err) {
      log.error(`[calendar] CalenSync-Belegungen nicht abrufbar, Slots nur nach lokalem Kalender: ${err.message}`);
      return [];
    }
  }

  return {
    timezone: tz,

    /** Freie Slots im Fenster, höchstens `limit`. Berücksichtigt Arbeitszeit, Blocker, Buchungen, offene Vorschläge und das Tageslimit. */
    async findAvailability({ from, to, durationMinutes = 30, limit = 6, maxPerDay = Infinity }) {
      const start = Math.max(Date.parse(from), now() + 60 * 60000); // frühestens in 1 Stunde
      const end = Math.min(Date.parse(to), start + 14 * 86400000);
      const busy = [...(await busyIntervals()), ...(end > start ? await remoteBusyOpen(start, end) : [])];
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

    /**
     * Ist der Slot frei? Liefert bei Konflikt den Verursacher. Fail-closed (siehe oben): Ist CalenSync eingerichtet,
     * aber nicht frisch abfragbar, kommt { kind: "unverified", unverified: true } zurück – der Slot gilt als belegt.
     */
    async conflictFor(start, end) {
      const s = Date.parse(start), e = Date.parse(end);
      const local = (await busyIntervals()).find((b) => overlaps(s, e, b.s, b.e));
      if (local || !fetchBusy) return local || null;
      try {
        const remote = await fetchBusy(s, e, { fresh: true }); // letzte Prüfung immer ohne Zwischenspeicher
        return remote.find((b) => overlaps(s, e, b.s, b.e)) || null;
      } catch (err) {
        log.error(`[calendar] CalenSync-Prüfung fehlgeschlagen, Slot gilt als belegt: ${err.message}`);
        return { start, end, title: "Kalender nicht prüfbar", source: "microsoft", kind: "unverified", unverified: true };
      }
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

module.exports = { createCalendar, formatForSpeech, parseBusySource, _busyCache: busyCache };
