/*
 * Slotwise Dashboard – Datenschicht.
 *
 * Alles, was das Dashboard anzeigt, kommt aus `SlotwiseAPI`. Heute liefern die Methoden Mock-Daten
 * (unten in MOCK), später ersetzt `SlotwiseAPI.http` sie durch echte Aufrufe – die Formen bleiben gleich.
 * Zeiten sind ISO-8601 in UTC; Anzeige rechnet nach Europe/Berlin um.
 *
 * Live-Modus: sobald ein Admin-Token hinterlegt ist (localStorage "slotwise.adminToken" = WAITLIST_ADMIN_TOKEN),
 * sprechen Feed, Kalender, Einstellungen und Freigaben mit der echten Agenten-API (api/_lib/core/agent/api.js):
 *   GET  /api/agent/activity?since=&limit=        → { items: Activity[] }   (Polling alle 10 s)
 *   GET  /api/agent/week?start=                   → { start, end, slots: Slot[] }
 *   GET  /api/agent/settings · PUT /api/agent/settings
 *   POST /api/agent/decision { id, action }       → Vorschlag freigeben/ablehnen
 *   GET  /api/waitlist/stats                      → { confirmed }          ← Zähler „Verifizierte Leads“
 *   GET  /api/google/status · POST /api/google/connect · POST /api/google/disconnect   ← Karte „Google Kalender“
 * Ohne Token: Beispieldaten (MOCK) – die Formen sind identisch.
 * Noch Mock (kein Endpunkt): Kunden, Event-Typen, Berichte
 * (Änderungen landen im localStorage dieses Browsers; geplante Endpunkte stehen bei getContacts() ff.).
 */
(function (global) {
  "use strict";

  const TZ = "Europe/Berlin";
  const now = new Date();
  const minutesAgo = (m) => new Date(now.getTime() - m * 60000).toISOString();
  const daysAgo = (d) => new Date(now.getTime() - d * 86400000).toISOString();

  /** @typedef {{ id:string, label:string, value:number, unit:"percent"|"hours"|"count", delta?:number, deltaLabel?:string, icon:"trend"|"clock"|"layers"|"shield", tone:"emerald"|"indigo"|"slate" }} Metric */
  /** @typedef {{ id:string, kind:"proposed"|"buffer"|"conflict"|"booked"|"info", text:string, at:string, ref?:{type:"booking"|"contact"|"slot", id:string} }} Activity */
  /** @typedef {{ id:string, start:string, end:string, kind:"booked"|"blocked"|"proposed", title:string, with?:string, source?:"manual"|"ai"|"google"|"icloud"|"microsoft" }} Slot */
  /** @typedef {{ autonomy:"auto"|"draft", maxPerDay:number, instructions:string, updatedAt:string }} AgentSettings */
  /** @typedef {{ id:string, name:string, email:string, phone:string, company:string, tag:"new"|"regular"|"lead", source:"phone"|"page"|"mail"|"manual", bookings:number, noShows:number, lastAt:string|null, nextAt:string|null, nextTitle:string|null, smsConsent:boolean, notes:string, createdAt:string }} Contact */
  /** @typedef {{ id:string, name:string, slug:string, duration:number, color:"indigo"|"violet"|"sky"|"amber"|"emerald"|"rose", location:"meet"|"teams"|"phone"|"onsite", bufferBefore:number, bufferAfter:number, minNoticeHours:number, active:boolean, aiBookable:boolean, description:string, bookings30d:number }} EventType */
  /** @typedef {{ days:number, totals:{ bookings:number, prevBookings:number, noShowRate:number, prevNoShowRate:number, leadTimeDays:number, aiShare:number }, series:{ label:string, ai:number, manual:number }[], channels:{ id:string, label:string, value:number }[], byType:{ name:string, color:string, value:number }[], heatmap:number[][] }} Report */

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
    /** @type {Contact[]} */
    contacts: [
      { id: "c1", name: "Lena Krüger", email: "lena.krueger@kanzlei-krueger.de", phone: "+49 211 5550 1201", company: "Kanzlei Krüger", tag: "regular", source: "manual", bookings: 7, noShows: 0, lastAt: at(0, 9, 0), nextAt: null, nextTitle: null, smsConsent: true, notes: "Bevorzugt Termine am Vormittag.", createdAt: daysAgo(210) },
      { id: "c2", name: "Anna Schmidt", email: "anna.schmidt@schmidt-design.de", phone: "+49 211 5550 1877", company: "Schmidt Design", tag: "regular", source: "phone", bookings: 5, noShows: 0, lastAt: at(1, 10, 0), nextAt: null, nextTitle: null, smsConsent: true, notes: "Strategie-Sessions immer mit 15 Min Puffer danach.", createdAt: daysAgo(150) },
      { id: "c3", name: "Lea Hoffmann", email: "lea@hoffmann-it.de", phone: "+49 172 5550 334", company: "Hoffmann IT", tag: "new", source: "page", bookings: 1, noShows: 0, lastAt: null, nextAt: at(2, 14, 0), nextTitle: "Demo-Termin", smsConsent: true, notes: "", createdAt: daysAgo(6) },
      { id: "c4", name: "Jonas Weber", email: "j.weber@weber-bau.de", phone: "+49 211 5550 9020", company: "Weber Bau GmbH", tag: "new", source: "phone", bookings: 1, noShows: 0, lastAt: null, nextAt: at(4, 11, 0), nextTitle: "Erstgespräch", smsConsent: true, notes: "Hat über den KI-Agenten am Telefon gebucht.", createdAt: daysAgo(1) },
      { id: "c5", name: "Max Berger", email: "max@firma.de", phone: "", company: "Berger & Partner", tag: "lead", source: "mail", bookings: 0, noShows: 0, lastAt: null, nextAt: at(3, 10, 0), nextTitle: "Erstgespräch (Vorschlag)", smsConsent: false, notes: "Anfrage per Mail, Slot-Vorschlag wartet auf Freigabe.", createdAt: daysAgo(0) },
      { id: "c6", name: "Tobias Lange", email: "kontakt@nordlicht.de", phone: "+49 211 5550 4410", company: "Nordlicht GmbH", tag: "regular", source: "page", bookings: 4, noShows: 1, lastAt: daysAgo(12), nextAt: at(4, 9, 30), nextTitle: "Strategie-Session (Verschiebung)", smsConsent: true, notes: "Möchte den Freitagstermin verschieben.", createdAt: daysAgo(95) },
      { id: "c7", name: "Sophie Wagner", email: "s.wagner@praxis-wagner.de", phone: "+49 176 5550 812", company: "Praxis Wagner", tag: "regular", source: "phone", bookings: 9, noShows: 0, lastAt: daysAgo(3), nextAt: null, nextTitle: null, smsConsent: true, notes: "", createdAt: daysAgo(320) },
      { id: "c8", name: "Mehmet Yılmaz", email: "mehmet@yilmaz-logistik.de", phone: "+49 211 5550 7788", company: "Yılmaz Logistik", tag: "lead", source: "page", bookings: 0, noShows: 0, lastAt: null, nextAt: null, nextTitle: null, smsConsent: false, notes: "Hat die Buchungsseite zweimal geöffnet, noch nicht gebucht.", createdAt: daysAgo(2) },
      { id: "c9", name: "Clara Neumann", email: "clara.neumann@studio-neumann.de", phone: "+49 160 5550 290", company: "Studio Neumann", tag: "regular", source: "manual", bookings: 3, noShows: 1, lastAt: daysAgo(20), nextAt: null, nextTitle: null, smsConsent: false, notes: "Erinnerung lieber per Mail statt SMS.", createdAt: daysAgo(180) },
      { id: "c10", name: "Felix Becker", email: "felix@becker-immo.de", phone: "+49 211 5550 3301", company: "Becker Immobilien", tag: "new", source: "phone", bookings: 1, noShows: 0, lastAt: daysAgo(4), nextAt: null, nextTitle: null, smsConsent: true, notes: "", createdAt: daysAgo(9) },
      { id: "c11", name: "Miriam Hartmann", email: "m.hartmann@hartmann-steuer.de", phone: "+49 211 5550 6612", company: "Hartmann Steuerberatung", tag: "regular", source: "page", bookings: 6, noShows: 0, lastAt: daysAgo(8), nextAt: null, nextTitle: null, smsConsent: true, notes: "Quartalsgespräch, immer im ersten Monat des Quartals.", createdAt: daysAgo(400) },
      { id: "c12", name: "David Schulz", email: "david.schulz@schulz-events.de", phone: "", company: "Schulz Events", tag: "lead", source: "mail", bookings: 0, noShows: 0, lastAt: null, nextAt: null, nextTitle: null, smsConsent: false, notes: "", createdAt: daysAgo(5) },
    ],
    /** @type {EventType[]} */
    eventTypes: [
      { id: "e1", name: "Erstgespräch", slug: "erstgespraech", duration: 30, color: "indigo", location: "meet", bufferBefore: 0, bufferAfter: 10, minNoticeHours: 4, active: true, aiBookable: true, description: "Kennenlernen und Bedarf klären. Kostenlos und unverbindlich.", bookings30d: 18 },
      { id: "e2", name: "Strategie-Session", slug: "strategie", duration: 60, color: "violet", location: "meet", bufferBefore: 0, bufferAfter: 15, minNoticeHours: 24, active: true, aiBookable: true, description: "Tiefer Einstieg in dein Projekt. Mit Vorbereitung und Protokoll.", bookings30d: 9 },
      { id: "e3", name: "Demo-Termin", slug: "demo", duration: 30, color: "sky", location: "teams", bufferBefore: 5, bufferAfter: 5, minNoticeHours: 2, active: true, aiBookable: true, description: "Live-Vorführung des Produkts mit Fragen am Ende.", bookings30d: 11 },
      { id: "e4", name: "Vor-Ort-Termin", slug: "vor-ort", duration: 90, color: "amber", location: "onsite", bufferBefore: 30, bufferAfter: 30, minNoticeHours: 48, active: false, aiBookable: false, description: "Termin bei dir vor Ort in Düsseldorf und Umgebung.", bookings30d: 0 },
    ],
    /** @type {AgentSettings} */
    settings: {
      autonomy: "draft",
      maxPerDay: 4,
      instructions: "Sei besonders höflich und biete freitags keine Termine nach 14 Uhr an.",
      praxisBooking: "off",
      newPatients: "callback",
      updatedAt: minutesAgo(3000),
    },
  };

  // ---------- Praxismodus (Arzt- und Zahnarztpraxen) ----------
  // Gleiche Formen wie oben, andere Inhalte. Umschalten über die KI-Einstellungen (industry: "praxis").
  const PRAXIS = {
    metrics: [
      { id: "calls", label: "Anrufe vom Agenten angenommen", value: 46, unit: "count", delta: 9, deltaLabel: "heute, davon 31 erledigt", icon: "trend", tone: "emerald" },
      { id: "timeSaved", label: "Entlastung der Anmeldung", value: 3.5, unit: "hours", delta: 0.6, deltaLabel: "heute", icon: "clock", tone: "indigo" },
      { id: "eventTypes", label: "Aktive Terminarten", value: 5, unit: "count", deltaLabel: "", icon: "layers", tone: "slate" },
      { id: "openTasks", label: "Offene Aufgaben fürs Team", value: 0, unit: "count", deltaLabel: "Rezepte, Überweisungen, Rückrufe", icon: "shield", tone: "emerald" },
    ],
    activity: [
      { id: "p1", kind: "task", text: "Rezeptwunsch von Peter Kühn aufgenommen – Aufgabe für das Praxisteam, Rückruf an +49…78", at: minutesAgo(4) },
      { id: "p2", kind: "booked", text: "Kontrolltermin mit Maria Lindner telefonisch gebucht, SMS-Bestätigung versendet", at: minutesAgo(11), ref: { type: "slot", id: "q3" } },
      { id: "p3", kind: "conflict", text: "Notfall-Stichwort erkannt – Anrufer auf 112 / 116 117 verwiesen und an das Praxisteam übergeben", at: minutesAgo(38) },
      { id: "p4", kind: "info", text: "Medizinische Frage nicht beantwortet – Termin oder Rückruf angeboten", at: minutesAgo(52) },
      { id: "p5", kind: "task", text: "Terminänderung von Anna Schmidt aufgenommen – Aufgabe für das Praxisteam", at: minutesAgo(70) },
      { id: "p6", kind: "proposed", text: "Prophylaxe-Recall: Termin für Jonas Weber vorgeschlagen, wartet auf Freigabe", at: minutesAgo(130), ref: { type: "slot", id: "q7" } },
    ],
    slots: [
      { id: "q1", start: at(0, 8, 0), end: at(0, 8, 30), kind: "booked", title: "Akutsprechstunde", with: "Freigegebener Slot", source: "manual" },
      { id: "q2", start: at(0, 9, 0), end: at(0, 10, 0), kind: "booked", title: "Prophylaxe / PZR", with: "Lena Krüger", source: "ai" },
      { id: "q3", start: at(1, 8, 30), end: at(1, 9, 0), kind: "booked", title: "Kontrolle", with: "Maria Lindner", source: "ai" },
      { id: "q4", start: at(1, 12, 0), end: at(1, 14, 0), kind: "blocked", title: "Mittagspause", source: "manual" },
      { id: "q5", start: at(2, 10, 0), end: at(2, 10, 30), kind: "booked", title: "Vorsorge / Check-up", with: "Peter Kühn", source: "manual" },
      { id: "q6", start: at(2, 15, 0), end: at(2, 16, 30), kind: "blocked", title: "Teambesprechung", source: "google" },
      { id: "q7", start: at(3, 9, 0), end: at(3, 10, 0), kind: "proposed", title: "Prophylaxe / PZR", with: "Jonas Weber", source: "ai" },
      { id: "q8", start: at(3, 11, 0), end: at(3, 11, 15), kind: "booked", title: "Impftermin", with: "Sophie Wagner", source: "ai" },
      { id: "q9", start: at(4, 8, 0), end: at(4, 8, 30), kind: "booked", title: "Akutsprechstunde", with: "Freigegebener Slot", source: "manual" },
      { id: "q10", start: at(4, 10, 0), end: at(4, 10, 30), kind: "proposed", title: "Kontrolle", with: "Felix Becker", source: "ai" },
    ],
    contacts: [
      { id: "k1", name: "Peter Kühn", email: "p.kuehn@web.de", phone: "+49 211 5550 1178", company: "", tag: "regular", source: "phone", bookings: 14, noShows: 0, lastAt: daysAgo(40), nextAt: at(2, 10, 0), nextTitle: "Vorsorge / Check-up", smsConsent: true, notes: "Hört schlecht – lieber Rückruf statt SMS.", createdAt: daysAgo(1900), recallDue: null },
      { id: "k2", name: "Maria Lindner", email: "maria.lindner@gmx.de", phone: "+49 172 5550 221", company: "", tag: "regular", source: "phone", bookings: 6, noShows: 0, lastAt: daysAgo(180), nextAt: at(1, 8, 30), nextTitle: "Kontrolle", smsConsent: true, notes: "", createdAt: daysAgo(900), recallDue: null },
      { id: "k3", name: "Jonas Weber", email: "j.weber@weber-bau.de", phone: "+49 211 5550 9020", company: "", tag: "regular", source: "page", bookings: 4, noShows: 1, lastAt: daysAgo(190), nextAt: at(3, 9, 0), nextTitle: "Prophylaxe / PZR (Vorschlag)", smsConsent: true, notes: "", createdAt: daysAgo(700), recallDue: daysAgo(10) },
      { id: "k4", name: "Lena Krüger", email: "lena.krueger@t-online.de", phone: "+49 211 5550 1201", company: "", tag: "regular", source: "manual", bookings: 9, noShows: 0, lastAt: daysAgo(2), nextAt: null, nextTitle: null, smsConsent: true, notes: "", createdAt: daysAgo(1200), recallDue: null },
      { id: "k5", name: "Anna Schmidt", email: "anna.schmidt@mail.de", phone: "+49 211 5550 1877", company: "", tag: "regular", source: "phone", bookings: 5, noShows: 0, lastAt: daysAgo(200), nextAt: null, nextTitle: null, smsConsent: true, notes: "Möchte Termin am Montag absagen (Aufgabe offen).", createdAt: daysAgo(800), recallDue: daysAgo(20) },
      { id: "k6", name: "Sophie Wagner", email: "s.wagner@posteo.de", phone: "+49 176 5550 812", company: "", tag: "new", source: "page", bookings: 1, noShows: 0, lastAt: null, nextAt: at(3, 11, 0), nextTitle: "Impftermin", smsConsent: true, notes: "", createdAt: daysAgo(6), recallDue: null },
      { id: "k7", name: "Felix Becker", email: "felix.becker@web.de", phone: "+49 211 5550 3301", company: "", tag: "new", source: "phone", bookings: 1, noShows: 0, lastAt: null, nextAt: at(4, 10, 0), nextTitle: "Kontrolle (Vorschlag)", smsConsent: false, notes: "", createdAt: daysAgo(3), recallDue: null },
      { id: "k8", name: "Mehmet Yılmaz", email: "m.yilmaz@gmail.com", phone: "+49 211 5550 7788", company: "", tag: "regular", source: "phone", bookings: 7, noShows: 0, lastAt: daysAgo(170), nextAt: null, nextTitle: null, smsConsent: true, notes: "", createdAt: daysAgo(1500), recallDue: daysAgo(-5) },
      { id: "k9", name: "Clara Neumann", email: "clara.neumann@icloud.com", phone: "+49 160 5550 290", company: "", tag: "regular", source: "manual", bookings: 3, noShows: 1, lastAt: daysAgo(210), nextAt: null, nextTitle: null, smsConsent: false, notes: "Erinnerung per Mail.", createdAt: daysAgo(600), recallDue: daysAgo(30) },
      { id: "k10", name: "Ilse Brandt", email: "", phone: "+49 211 5550 4402", company: "", tag: "lead", source: "phone", bookings: 0, noShows: 0, lastAt: null, nextAt: null, nextTitle: null, smsConsent: false, notes: "Neupatientin, Rückruf erbeten.", createdAt: daysAgo(0), recallDue: null },
    ],
    eventTypes: [
      { id: "t1", name: "Akutsprechstunde", slug: "akut", duration: 15, color: "rose", location: "onsite", bufferBefore: 0, bufferAfter: 0, minNoticeHours: 1, active: true, aiBookable: false, description: "Nur in freigegebene Zeitfenster. Der Agent bucht nicht selbst, sondern bietet Rückruf an.", bookings30d: 64 },
      { id: "t2", name: "Kontrolle", slug: "kontrolle", duration: 30, color: "indigo", location: "onsite", bufferBefore: 0, bufferAfter: 5, minNoticeHours: 4, active: true, aiBookable: true, description: "Regelmäßige Kontrolle bei Bestandspatienten.", bookings30d: 48 },
      { id: "t3", name: "Prophylaxe / PZR", slug: "prophylaxe", duration: 60, color: "sky", location: "onsite", bufferBefore: 0, bufferAfter: 10, minNoticeHours: 24, active: true, aiBookable: true, description: "Professionelle Zahnreinigung. Recall alle 6 Monate.", bookings30d: 37 },
      { id: "t4", name: "Vorsorge / Check-up", slug: "vorsorge", duration: 30, color: "emerald", location: "onsite", bufferBefore: 0, bufferAfter: 5, minNoticeHours: 24, active: true, aiBookable: true, description: "Gesundheits-Check-up und Vorsorgeuntersuchungen.", bookings30d: 22 },
      { id: "t5", name: "Impftermin", slug: "impfung", duration: 15, color: "violet", location: "onsite", bufferBefore: 0, bufferAfter: 0, minNoticeHours: 2, active: true, aiBookable: true, description: "Grippe-, Auffrischungs- und Reiseimpfungen.", bookings30d: 29 },
      { id: "t6", name: "Beratung Zahnersatz", slug: "zahnersatz", duration: 45, color: "amber", location: "onsite", bufferBefore: 0, bufferAfter: 15, minNoticeHours: 48, active: false, aiBookable: false, description: "Beratung zu Kronen, Brücken und Implantaten.", bookings30d: 0 },
    ],
    tasks: [
      { id: "a1", at: minutesAgo(4), type: "prescription", label: "Rezeptwunsch", name: "Peter Kühn", patientStatus: "existing", dateOfBirth: "1958-07-03", phone: "+49 211 5550 1178", note: "Folgerezept Blutdruckmittel", channel: "phone", done: false },
      { id: "a2", at: minutesAgo(70), type: "change_request", label: "Terminänderung", name: "Anna Schmidt", patientStatus: "existing", dateOfBirth: "1981-02-14", phone: "+49 211 5550 1877", note: "Montag absagen", channel: "phone", done: false },
      { id: "a3", at: minutesAgo(95), type: "referral", label: "Überweisungswunsch", name: "Maria Lindner", patientStatus: "existing", dateOfBirth: "1967-11-30", phone: "+49 172 5550 221", note: "Überweisung Orthopädie", channel: "phone", done: false },
      { id: "a4", at: minutesAgo(140), type: "callback", label: "Rückrufwunsch", name: "Ilse Brandt", patientStatus: "new", dateOfBirth: null, phone: "+49 211 5550 4402", note: "Neupatientin, möchte aufgenommen werden", channel: "phone", done: false },
    ],
  };

  const delay = (v, ms = 120) => new Promise((r) => setTimeout(() => r(structuredClone(v)), ms));
  const SETTINGS_KEY = "slotwise.dashboard.agentSettings";
  const CONTACTS_BASE = "slotwise.dashboard.contacts";
  const EVENTS_BASE = "slotwise.dashboard.eventTypes";
  const TASKS_KEY = "slotwise.dashboard.tasks.praxis";
  function isoWeek(d) {
    const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
    const day = t.getUTCDay() || 7;
    t.setUTCDate(t.getUTCDate() + 4 - day);
    return Math.ceil(((t - Date.UTC(t.getUTCFullYear(), 0, 1)) / 86400000 + 1) / 7);
  }

  const SlotwiseAPI = {
    baseUrl: "",
    adminToken() { try { return localStorage.getItem("slotwise.adminToken") || ""; } catch { return ""; } },
    /** Live, sobald ein Admin-Token hinterlegt ist. */
    get live() { return Boolean(this.adminToken()); },
    async http(path, init = {}) {
      const res = await fetch(this.baseUrl + path, { ...init, headers: { Authorization: `Bearer ${this.adminToken()}`, ...(init.headers || {}) } });
      if (!res.ok) throw new Error(`${path}: ${res.status}`);
      return res.json();
    },
    /** Bereitschaft der Agenten-API (ohne Token abrufbar, ohne Werte). */
    async status() { try { return await fetch(this.baseUrl + "/api/agent/status").then((r) => (r.ok ? r.json() : null)); } catch { return null; } },

    // ---------- Modus: "business" (Unternehmen) oder "praxis" (Arzt-/Zahnarztpraxis) ----------
    _mode: null,
    /** Synchron: Demo liest die gespeicherten Einstellungen, Live den zuletzt geladenen Stand. */
    get mode() {
      if (this._mode) return this._mode;
      if (!this.live) { try { const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "{}"); if (s.industry === "praxis") return "praxis"; } catch { /* */ } }
      return "business";
    },
    get praxis() { return this.mode === "praxis"; },
    async ensureMode() { if (this.live && !this._mode) { try { await this.getSettings(); } catch { /* bleibt business */ } } return this.mode; },
    _set(name) { return this.praxis ? PRAXIS[name] : MOCK[name]; },
    _key(base) { return this.praxis ? `${base}.praxis` : base; },

    async getMetrics() {
      await this.ensureMode();
      const m = await delay(this._set("metrics"));
      if (this.praxis) { const ot = m.find((x) => x.id === "openTasks"); if (ot) ot.value = (await this.getTasks()).length; }
      const active = this._local(this._key(EVENTS_BASE), this._set("eventTypes")).filter((t) => t.active);
      const et = m.find((x) => x.id === "eventTypes");
      if (et) { et.value = active.length; et.deltaLabel = active.map((t) => t.name).join(" · ") || "keiner aktiv"; }
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
      if (this.live) return (await this.http(`/api/agent/activity?limit=${limit}`)).items;
      await this.ensureMode();
      return delay(this._set("activity").slice(0, limit));
    },
    async getWeek(startISO) {
      if (this.live) return this.http(`/api/agent/week${startISO ? `?start=${encodeURIComponent(startISO)}` : ""}`);
      await this.ensureMode();
      return delay({ start: monday.toISOString(), slots: this._set("slots") });
    },
    async getSettings() {
      if (this.live) { const s = await this.http("/api/agent/settings"); this._mode = s.industry === "praxis" ? "praxis" : "business"; return s; }
      try { const saved = localStorage.getItem(SETTINGS_KEY); if (saved) return JSON.parse(saved); } catch { /* privat/blockiert */ }
      return delay(MOCK.settings);
    },
    async saveSettings(settings) {
      const next = { ...settings, updatedAt: new Date().toISOString() };
      if (this.live) { const s = await this.http("/api/agent/settings", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(settings) }); this._mode = s.industry === "praxis" ? "praxis" : "business"; return s; }
      try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(next)); } catch { /* ignorieren */ }
      return delay(next, 250);
    },
    // ---------- Kunden, Event-Typen, Berichte ----------
    // Noch ohne Endpunkt: Demo-Daten, Änderungen bleiben nur in diesem Browser (localStorage).
    // Geplante Endpunkte (gleiche Formen): GET/POST /api/contacts · DELETE /api/contacts/:id (DSGVO, Art. 17)
    //   GET/PUT /api/event-types · GET /api/reports?days=
    _local(key, fallback) { try { const v = localStorage.getItem(key); if (v) return JSON.parse(v); } catch { /* privat/blockiert */ } return structuredClone(fallback); },
    _store(key, v) { try { localStorage.setItem(key, JSON.stringify(v)); } catch { /* ignorieren */ } },

    /** @returns {Promise<Contact[]>} */
    async getContacts() {
      await this.ensureMode(); return delay(this._local(this._key(CONTACTS_BASE), this._set("contacts"))); },
    /** Neuer Kontakt (Demo: lokal). */
    async saveContact(c) {
      const list = this._local(this._key(CONTACTS_BASE), this._set("contacts"));
      const next = { id: c.id || `c${Date.now()}`, tag: "new", source: "manual", bookings: 0, noShows: 0, lastAt: null, nextAt: null, nextTitle: null, smsConsent: false, notes: "", phone: "", company: "", createdAt: new Date().toISOString(), ...c };
      const i = list.findIndex((x) => x.id === next.id);
      if (i >= 0) list[i] = next; else list.unshift(next);
      this._store(this._key(CONTACTS_BASE), list);
      return delay(next, 150);
    },
    /** Kontakt samt Buchungshistorie endgültig löschen (DSGVO Art. 17). Demo: lokal. */
    async deleteContact(id) {
      this._store(this._key(CONTACTS_BASE), this._local(this._key(CONTACTS_BASE), this._set("contacts")).filter((x) => x.id !== id));
      return delay({ ok: true }, 150);
    },

    /** @returns {Promise<EventType[]>} */
    async getEventTypes() {
      await this.ensureMode(); return delay(this._local(this._key(EVENTS_BASE), this._set("eventTypes"))); },
    async saveEventType(e) {
      const list = this._local(this._key(EVENTS_BASE), this._set("eventTypes"));
      const next = { id: e.id || `e${Date.now()}`, bookings30d: 0, ...e };
      const i = list.findIndex((x) => x.id === next.id);
      if (i >= 0) list[i] = { ...list[i], ...next }; else list.push(next);
      this._store(this._key(EVENTS_BASE), list);
      return delay(next, 150);
    },
    async deleteEventType(id) {
      this._store(this._key(EVENTS_BASE), this._local(this._key(EVENTS_BASE), this._set("eventTypes")).filter((x) => x.id !== id));
      return delay({ ok: true }, 120);
    },

    /** Auswertung für die letzten `days` Tage (7, 30, 90). Demo: deterministisch erzeugt. @returns {Promise<Report>} */
    async getReport(days = 30) {
      let seed = days * 7919;
      const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
      const buckets = days <= 7 ? 7 : days <= 30 ? 30 / 7 | 0 : 13;
      const per = days / buckets;
      const series = Array.from({ length: buckets }, (_, k) => {
        const d = new Date(now.getTime() - (buckets - 1 - k) * per * 86400000);
        const label = days <= 7 ? new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short" }).format(d) : `KW ${isoWeek(d)}`;
        const base = per * (1.1 + k / buckets);
        return { label, ai: Math.round(base * (0.55 + rnd() * 0.25)), manual: Math.round(base * (0.25 + rnd() * 0.2)) };
      });
      const bookings = series.reduce((s, x) => s + x.ai + x.manual, 0);
      const ai = series.reduce((s, x) => s + x.ai, 0);
      const types = this._local(this._key(EVENTS_BASE), this._set("eventTypes")).filter((t) => t.active);
      const weights = [0.46, 0.24, 0.3, 0.1];
      const wsum = types.reduce((s, _, i) => s + (weights[i] || 0.1), 0);
      const heatmap = Array.from({ length: 5 }, (_, d) => Array.from({ length: 10 }, (_, h) => {
        const peak = (h === 2 || h === 3 ? 1 : h === 6 || h === 7 ? 0.8 : 0.35) * (d === 4 ? 0.6 : 1);
        return Math.round((days / 30) * 6 * peak * (0.6 + rnd() * 0.6));
      }));
      return delay({
        days,
        totals: { bookings, prevBookings: Math.round(bookings * 0.82), noShowRate: 2.4 + rnd(), prevNoShowRate: 7.8 + rnd(), leadTimeDays: 3.1 + rnd() * 1.5, aiShare: Math.round((ai / Math.max(1, bookings)) * 100) },
        series,
        channels: [
          { id: "phone", label: "Telefon (KI-Agent)", value: Math.round(bookings * 0.41) },
          { id: "page", label: "Buchungsseite", value: Math.round(bookings * 0.34) },
          { id: "mail", label: "E-Mail (KI-Agent)", value: Math.round(bookings * 0.15) },
          { id: "manual", label: "Manuell eingetragen", value: Math.round(bookings * 0.1) },
        ],
        byType: types.map((t, i) => ({ name: t.name, color: t.color, value: Math.round((bookings * (weights[i] || 0.1)) / wsum) })),
        heatmap,
      }, 160);
    },

    // ---------- Praxismodus: Aufgaben fürs Team ----------
    // Live: GET /api/agent/tasks · POST /api/agent/tasks { id }  (eine Funktion, Vercel-Hobby: max. 12)   (api/_lib/core/agent/api.js)
    async getTasks() {
      if (this.live) return (await this.http("/api/agent/tasks")).items;
      return delay(this._local(TASKS_KEY, PRAXIS.tasks).filter((t) => !t.done));
    },
    async taskDone(id) {
      if (this.live) return this.http("/api/agent/tasks", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id }) });
      this._store(TASKS_KEY, this._local(TASKS_KEY, PRAXIS.tasks).map((t) => (t.id === id ? { ...t, done: true } : t)));
      return delay({ ok: true }, 100);
    },

    // ---------- Google Kalender verbinden (nur live; api/_lib/core/google.js) ----------
    //   GET  /api/google/status     → { enabled, connected, email?, connectedAt?, lastError?, writeEvents? }
    //                                 503 { enabled: false } = auf dem Server nicht eingerichtet
    //   POST /api/google/connect    → { url }  (Weiterleitung zu Google; setzt ein kurzlebiges HttpOnly-Cookie für den Rücksprung)
    //   POST /api/google/disconnect → { ok, revoked }
    async googleStatus() {
      if (!this.live) return { demo: true, enabled: false, connected: false };
      const res = await fetch(this.baseUrl + "/api/google/status", { headers: { Authorization: `Bearer ${this.adminToken()}` }, cache: "no-store" });
      if (res.status === 503) return { enabled: false, connected: false };
      if (!res.ok) throw new Error(`/api/google/status: ${res.status}`);
      return res.json();
    },
    async googleConnect() {
      return this.http("/api/google/connect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    },
    async googleDisconnect() {
      return this.http("/api/google/disconnect", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    },

    /** Vorschlag freigeben/ablehnen. Live: Server; Demo: nur lokal. */
    async decide(id, action) {
      if (this.live) return this.http("/api/agent/decision", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ id, action }) });
      return delay({ ok: true, local: true }, 100);
    },
    /**
     * Neue Aktivität: live per Polling (alle 10 s, nur Einträge seit dem letzten Stand – Serverless-tauglich,
     * kein offener Socket). Demo: drei Beispieleinträge nachschieben.
     */
    subscribeActivity(onEvent) {
      if (this.live) {
        let since = new Date().toISOString();
        const tick = async () => {
          try {
            const { items, serverTime } = await this.http(`/api/agent/activity?since=${encodeURIComponent(since)}&limit=20`);
            items.slice().reverse().forEach(onEvent);
            since = serverTime || since;
          } catch { /* nächster Versuch beim nächsten Tick */ }
        };
        const t = setInterval(tick, 10000);
        return () => clearInterval(t);
      }
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

  // Einstieg von /praxen: /dashboard/?modus=praxis öffnet die Demo direkt im Praxismodus (nur Demo, live zählt der Server)
  try {
    const m = new URLSearchParams(location.search).get("modus");
    if ((m === "praxis" || m === "unternehmen") && !SlotwiseAPI.live) {
      const cur = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null") || { ...MOCK.settings };
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...cur, industry: m === "praxis" ? "praxis" : "business" }));
      history.replaceState(null, "", location.pathname + location.hash);
    }
  } catch { /* privat/blockiert */ }

  global.SlotwiseAPI = SlotwiseAPI;
  global.SLOTWISE_TZ = TZ;
})(window);
