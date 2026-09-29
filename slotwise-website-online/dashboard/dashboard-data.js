/*
 * Slotwise Dashboard – Datenschicht.
 *
 * Alles, was das Dashboard anzeigt, kommt aus `SlotwiseAPI`. Heute liefern die Methoden Mock-Daten
 * (unten in MOCK), später ersetzt `SlotwiseAPI.http` sie durch echte Aufrufe – die Formen bleiben gleich.
 * Zeiten sind ISO-8601 in UTC; Anzeige rechnet nach Europe/Berlin um.
 *
 * Endpunkte (geplant, apps/web → api/):
 *   GET  /api/dashboard/metrics                   → Metrics
 *   GET  /api/dashboard/activity?limit=20         → Activity[]
 *   GET  /api/dashboard/week?start=YYYY-MM-DD     → { days: Day[], slots: Slot[] }
 *   GET  /api/agent/settings                      → AgentSettings
 *   PUT  /api/agent/settings                      → AgentSettings
 *   GET  /api/waitlist/stats  (Bearer)            → { confirmed: number }   ← Zähler „Verifizierte Leads“
 */
(function (global) {
  "use strict";

  const TZ = "Europe/Berlin";
  const now = new Date();
  const minutesAgo = (m) => new Date(now.getTime() - m * 60000).toISOString();

  /** @typedef {{ id:string, label:string, value:number, unit:"percent"|"hours"|"count", delta?:number, deltaLabel?:string, icon:"trend"|"clock"|"layers"|"shield", tone:"emerald"|"indigo"|"slate" }} Metric */
  /** @typedef {{ id:string, kind:"proposed"|"buffer"|"conflict"|"booked"|"info", text:string, at:string, ref?:{type:"booking"|"contact"|"slot", id:string} }} Activity */
  /** @typedef {{ id:string, start:string, end:string, kind:"booked"|"blocked"|"proposed", title:string, with?:string, source?:"manual"|"ai"|"google"|"icloud"|"microsoft" }} Slot */
  /** @typedef {{ autonomy:"auto"|"draft", maxPerDay:number, instructions:string, updatedAt:string }} AgentSettings */

  // Montag der aktuellen Woche (Berlin) als Datum ohne Zeit
  function mondayOf(d) {
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short" }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    const wd = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(get("weekday"));
    const base = new Date(`${get("year")}-${get("month")}-${get("day")}T00:00:00`);
    base.setDate(base.getDate() - wd);
    return base; // lokale Mitternacht des Montags (Anzeigekalender, nicht UTC-genau – für Mock ausreichend)
  }
  const monday = mondayOf(now);
  const at = (dayOffset, h, m = 0) => { const d = new Date(monday); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.toISOString(); };

  const MOCK = {
    /** @type {Metric[]} */
    metrics: [
      { id: "conversion", label: "Buchungs-Conversion", value: 14.2, unit: "percent", delta: 3.1, deltaLabel: "seit KI-Agent aktiv", icon: "trend", tone: "emerald" },
      { id: "timeSaved", label: "KI-gesparte Zeit", value: 4.5, unit: "hours", delta: 0.8, deltaLabel: "diese Woche", icon: "clock", tone: "indigo" },
      { id: "eventTypes", label: "Aktive Event-Typen", value: 3, unit: "count", deltaLabel: "Erstgespräch · Strategie · Demo", icon: "layers", tone: "slate" },
      { id: "verifiedLeads", label: "Verifizierte Leads", value: 27, unit: "count", delta: 5, deltaLabel: "Warteliste, Double-Opt-in", icon: "shield", tone: "emerald" },
    ],
    /** @type {Activity[]} */
    activity: [
      { id: "a1", kind: "proposed", text: "Terminanfrage von max@firma.de per Mail analysiert und Slot vorgeschlagen: Do. 10:00", at: minutesAgo(5), ref: { type: "slot", id: "s7" } },
      { id: "a2", kind: "booked", text: "Erstgespräch mit Jonas Weber telefonisch gebucht, SMS-Bestätigung versendet", at: minutesAgo(48), ref: { type: "booking", id: "b3" } },
      { id: "a3", kind: "buffer", text: "Pufferzeit (15 Min) nach dem Strategie-Gespräch mit Anna Schmidt blockiert", at: minutesAgo(120) },
      { id: "a4", kind: "conflict", text: "Doppelbuchung verhindert: Kalender-Konflikt mit privatem iCloud-Termin erkannt, Alternative angeboten", at: minutesAgo(240) },
      { id: "a5", kind: "info", text: "Erinnerung an Lea Hoffmann (Demo, morgen 14:00) per SMS verschickt", at: minutesAgo(360) },
      { id: "a6", kind: "proposed", text: "Verschiebungswunsch von kontakt@nordlicht.de erkannt – Entwurf wartet auf deine Freigabe", at: minutesAgo(1500), ref: { type: "booking", id: "b1" } },
    ],
    /** @type {Slot[]} */
    slots: [
      { id: "s1", start: at(0, 9, 0), end: at(0, 9, 30), kind: "booked", title: "Erstgespräch", with: "Lena Krüger", source: "manual" },
      { id: "s2", start: at(0, 12, 0), end: at(0, 13, 0), kind: "blocked", title: "Mittag", source: "google" },
      { id: "s3", start: at(1, 10, 0), end: at(1, 11, 0), kind: "booked", title: "Strategie-Session", with: "Anna Schmidt", source: "ai" },
      { id: "s4", start: at(1, 11, 0), end: at(1, 11, 15), kind: "blocked", title: "Puffer (KI)", source: "ai" },
      { id: "s5", start: at(1, 15, 0), end: at(1, 16, 30), kind: "blocked", title: "Privat (iCloud)", source: "icloud" },
      { id: "s6", start: at(2, 14, 0), end: at(2, 14, 30), kind: "booked", title: "Demo-Termin", with: "Lea Hoffmann", source: "ai" },
      { id: "s7", start: at(3, 10, 0), end: at(3, 10, 30), kind: "proposed", title: "Erstgespräch", with: "max@firma.de", source: "ai" },
      { id: "s8", start: at(3, 13, 0), end: at(3, 14, 0), kind: "blocked", title: "Teammeeting", source: "microsoft" },
      { id: "s9", start: at(4, 9, 30), end: at(4, 10, 30), kind: "proposed", title: "Strategie-Session", with: "kontakt@nordlicht.de", source: "ai" },
      { id: "s10", start: at(4, 11, 0), end: at(4, 11, 30), kind: "booked", title: "Erstgespräch", with: "Jonas Weber", source: "ai" },
    ],
    /** @type {AgentSettings} */
    settings: {
      autonomy: "draft",
      maxPerDay: 4,
      instructions: "Sei besonders höflich und biete freitags keine Termine nach 14 Uhr an.",
      updatedAt: minutesAgo(3000),
    },
  };

  const delay = (v, ms = 120) => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
  const SETTINGS_KEY = "slotwise.dashboard.agentSettings";

  const SlotwiseAPI = {
    /** Auf `true` setzen (oder `baseUrl` angeben), sobald die echten Endpunkte stehen. */
    live: false,
    baseUrl: "",
    adminToken() { try { return localStorage.getItem("slotwise.adminToken") || ""; } catch { return ""; } },
    async http(path, init) {
      const res = await fetch(this.baseUrl + path, { credentials: "include", ...init });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    },

    async getMetrics() {
      if (this.live) return this.http("/api/dashboard/metrics");
      const m = await delay(MOCK.metrics);
      // Zähler „Verifizierte Leads“ aus der Warteliste: GET /api/waitlist/stats braucht den Admin-Token.
      // Bis die App eine Anmeldung hat: Token einmalig im Browser hinterlegen →
      //   localStorage.setItem("slotwise.adminToken", "<WAITLIST_ADMIN_TOKEN>")
      const token = this.adminToken();
      if (token) {
        try {
          const s = await fetch("/api/waitlist/stats", { headers: { Authorization: `Bearer ${token}` } });
          if (s.ok) { const { confirmed } = await s.json(); const k = m.find((x) => x.id === "verifiedLeads"); if (k && Number.isFinite(confirmed)) { k.value = confirmed; k.deltaLabel = "bestätigte Einträge, live"; delete k.delta; } }
        } catch { /* Mock bleibt */ }
      }
      return m;
    },
    async getActivity(limit = 20) {
      if (this.live) return this.http(`/api/dashboard/activity?limit=${limit}`);
      return delay(MOCK.activity.slice(0, limit));
    },
    async getWeek(startISO) {
      if (this.live) return this.http(`/api/dashboard/week?start=${encodeURIComponent(startISO)}`);
      return delay({ start: monday.toISOString(), slots: MOCK.slots });
    },
    async getSettings() {
      if (this.live) return this.http("/api/agent/settings");
      try { const saved = localStorage.getItem(SETTINGS_KEY); if (saved) return JSON.parse(saved); } catch { /* privat/blockiert */ }
      return delay(MOCK.settings);
    },
    async saveSettings(settings) {
      const next = { ...settings, updatedAt: new Date().toISOString() };
      if (this.live) return this.http("/api/agent/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(next) });
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignorieren */ }
      return delay(next, 250);
    },
    /** Demo: neue Aktivität nachschieben (Live-Gefühl). Echte Version: Server-Sent Events auf /api/dashboard/activity/stream */
    subscribeActivity(onEvent) {
      const extra = [
        { kind: "proposed", text: "Neue Anfrage über die Buchungsseite: Erstgespräch, Wunsch Di. 10:00 – Slot geprüft, frei", ref: { type: "slot", id: "s3" } },
        { kind: "info", text: "Kalender-Sync mit Google abgeschlossen, 2 neue Belegungen übernommen" },
        { kind: "buffer", text: "Pufferzeit (15 Min) vor dem Demo-Termin mit Lea Hoffmann blockiert" },
      ];
      let i = 0;
      const t = setInterval(() => {
        if (i >= extra.length) return clearInterval(t);
        onEvent({ id: `live${i}`, at: new Date().toISOString(), ...extra[i++] });
      }, 9000);
      return () => clearInterval(t);
    },
  };

  global.SlotwiseAPI = SlotwiseAPI;
  global.SLOTWISE_TZ = TZ;
})(window);
