"use strict";
/*
 * Praxismodus des KI-Agenten (Arzt- und Zahnarztpraxen). Aktiv, wenn im Dashboard industry = "praxis" gesetzt ist.
 *
 * Grundsatz: Der Agent organisiert, er beurteilt nichts Medizinisches. Die sicherheitsrelevanten Regeln laufen
 * deterministisch VOR dem Modell (wie das L0-Intent-Gate) – der Prompt allein wäre keine Grenze:
 *   1. Notfall-Gate:   Notfall-Stichworte → sofort Hinweis auf 112 / 116 117, Übergabe an das Team, Gespräch endet.
 *   2. Medizin-Gate:   Fragen nach Einschätzung, Dosis, Befund → feste Absage, Termin oder Rückruf angeboten.
 *   3. Änderungswunsch: bestehende Termine bleiben gesperrt (L0), aber der Wunsch wird als Aufgabe fürs Team aufgenommen.
 * Zusätzliches Tool nur im Praxismodus: create_task (Rezept, Überweisung, Rückruf, Terminänderung) – ohne Zugriff auf
 * bestehende Termine oder Patientendaten. Aufgaben enthalten nur, was das Team zum Zurückrufen braucht, und laufen nach
 * 30 Tagen ab (Datensparsamkeit, Art. 5 DSGVO).
 */
const crypto = require("node:crypto");

const EMERGENCY_DE =
  "Wenn es sich um einen Notfall handelt, legen Sie bitte auf und rufen Sie sofort die 112 an. " +
  "Bei dringenden Beschwerden außerhalb der Sprechzeiten hilft der ärztliche Bereitschaftsdienst unter 116 117. " +
  "Ich gebe Ihren Anruf jetzt an das Praxisteam weiter.";

const MEDICAL_REFUSAL_DE =
  "Medizinische Fragen kann ich leider nicht beantworten. Das bespricht die Ärztin oder der Arzt persönlich mit Ihnen. " +
  "Wenn Sie gerade starke oder plötzliche Beschwerden haben, legen Sie bitte auf und rufen Sie die 112 an, außerhalb der Sprechzeiten den Bereitschaftsdienst unter 116 117. " +
  "Sonst kann eine Rückrufbitte für das Praxisteam aufnehmen oder Ihnen bei einem Termin helfen. Was möchten Sie?";

const MODIFY_PRAXIS_DE =
  "Bestehende Termine kann ich am Telefon nicht einsehen oder ändern. " +
  "Ich gebe Ihren Wunsch aber an das Praxisteam weiter, es meldet sich bei Ihnen. Nennen Sie mir bitte Ihren Namen und eine Rückrufnummer.";

const NEW_CLOSED_DE =
  "Die Praxis nimmt derzeit leider keine neuen Patientinnen und Patienten auf. " +
  "Wenn Sie gesetzlich versichert sind, hilft Ihnen die Terminservicestelle unter 116 117 bei der Suche nach einem Termin.";

const NEW_NO_RX_DE =
  "Folgerezepte und Überweisungen kann die Praxis nur für Patienten ausstellen, die bereits bei ihr in Behandlung sind. " +
  "Gern nehme ich eine Rückrufbitte auf, dann meldet sich das Praxisteam wegen eines ersten Termins.";

const DISCLOSURE_PRAXIS_DE =
  "Guten Tag, Sie sprechen mit dem digitalen Assistenten von {{company}}. Das Gespräch wird zur Terminvereinbarung verarbeitet. " +
  "Bei einem Notfall rufen Sie bitte die 112 an. Mit der Taste 0 erreichen Sie das Praxisteam. Wie kann ich Ihnen helfen?";

// Bewusst breit: lieber einmal zu oft auf die 112 verweisen als einmal zu wenig.
// Grenze: Spracherkennung läuft auf Deutsch; andere Sprachen kommen oft verstümmelt an. Darum zusätzlich ein paar
// englische und türkische Schlüsselwörter, die Twilio meist korrekt transkribiert, und die Modellprüfung als zweite Stufe.
const EMERGENCY_PATTERNS = [
  /\bnotfall\b/i,
  /\b(brust|herz)\w*\s*(schmerz|stech|druck|enge)/i,
  /\b(schmerz\w*|druck|stechen|stiche|enge\w*|engegefühl)\b.{0,25}\b(in der|auf der|an der|in die) brust\b/i,
  /\b(herzrasen|herz rast|herz rast\w*|herz schlägt (ganz )?(wild|unregelmäßig))\b/i,
  /\b(verwirrt|taub|gelähmt|schwach|schwindel\w*|kopfschmerz\w*)\b.{0,30}\b(plötzlich|ploetzlich)\b/i,
  /\b(atemnot|luftnot|atme (ganz )?schwer|kann (kaum|schlecht|nicht) (mehr )?atmen|bekomm\w* (kaum |keine )?luft|keine luft|krieg\w* (kaum |keine )?luft|kann nicht (mehr )?atmen|ersticke|erstickt)/i,
  /\b(bewusstlos|ohnmächtig|ohnmaechtig|kollabiert|zusammengebrochen|krampfanfall|krampft|nicht ansprechbar|reagiert nicht)/i,
  /\b(schlaganfall|herzinfarkt|lähmung|laehmung|gelähmt|gelaehmt|sprachstörung|kann nicht (mehr )?(richtig )?sprechen|gesicht hängt|hängender mundwinkel)/i,
  /\b(sehe doppelt|doppelt sehen|doppelbilder|plötzlich (nichts|schlecht|verschwommen) (mehr )?sehen|plötzlich blind)/i,
  /\b(plötzlich|ploetzlich)\b.{0,30}\b(verwirrt|taub|schwach|schwindel|kopfschmerz)/i,
  /\b(blutet stark|starke blutung|hört nicht auf zu bluten|viel blut|voller blut|blutet (sehr|immer noch|weiter)|blut erbrochen|blut gehustet)/i,
  /\b(kind|baby|säugling|saeugling|tochter|sohn)\b.{0,40}\b(fieber|grad)\b.{0,15}\b(39|40|41|42)/i,
  /\b(40|41|42) ?grad\b/i,
  /\b(kind|baby|säugling|saeugling|tochter|sohn)\b.{0,40}\b(39|40|41|42)([,.]\d)? ?(grad)? ?fieber/i,
  /\b(suizid|selbstmord|umbringen|nicht mehr leben|(will|möchte|moechte) (nur noch )?sterben|(will|möchte|moechte) tot sein|mir etwas antun|mir was antun|ich kann nicht mehr)/i,
  /\b(vergiftung|vergiftet|überdosis|ueberdosis|tabletten geschluckt|allergisch\w* schock|anaphyla|zunge schwillt|hals schwillt zu)/i,
  /\b(unfall|gestürzt|gestuerzt|hingefallen).{0,30}\b(kopf|bewusst|blut)/i,
  // Englisch / Türkisch (Grundschutz)
  /\b(emergency|chest (pain|hurts)|heart attack|can'?t breathe|cannot breathe|unconscious|stroke|bleeding)\b/i,
  /\b(acil|nefes alamıyorum|nefes alamiyorum|kalbim|bayıldı|bayildi|kanıyor|kaniyor)\b/i,
];
// Verneinte Notfälle („kein Notfall“, „nicht dringend“) lösen nicht aus – andere Stichworte im selben Satz schon.
const NEGATED = /\b(kein(en)?|nicht (um )?(einen )?|ist nicht)\s*(notfall|dringend)\b/gi;

const MEDICAL_PATTERNS = [
  /\bist (das|es) (gefährlich|gefaehrlich|schlimm|normal|ansteckend)\b/i,
  /\bsoll(te)? ich\b.{0,40}\b(nehmen|absetzen|einnehmen|kühlen|kuehlen|warten|ins krankenhaus)\b/i,
  /\b(welche|wie viel|wieviel)\w*\b.{0,20}\b(dosis|tabletten|milligramm|mg)\b/i,
  /\b(was bedeutet|was heißt|was heisst)\b.{0,30}\b(befund|wert|ergebnis|diagnose)\b/i,
  /\b(laborwert|blutwert|befund|röntgenbild|roentgenbild|mrt)\w*\b.{0,30}\b(sagen|erklären|erklaeren|vorlesen|durchgeben)\b/i,
  /\bhabe ich\b.{0,30}\b(krankheit|infektion|entzündung|entzuendung|krebs|corona)\b/i,
  /\b(welches|was für ein) (medikament|mittel|antibiotikum)\b/i,
  /\bdarf ich\b.{0,40}\b(nehmen|essen|trinken|sport|arbeiten)\b/i,
  /\bkann ich (mit|trotz)\b.{0,30}\b(ibuprofen|paracetamol|aspirin|tablette|medikament|fieber)\b/i,
];

// \b in JavaScript-Regexen kennt nur ASCII-Buchstaben, an Ü/ä/ı greift es nicht. Darum Unicode-Wortgrenzen.
const UB = "(?:(?<![\\p{L}\\p{N}_])(?=[\\p{L}\\p{N}_])|(?<=[\\p{L}\\p{N}_])(?![\\p{L}\\p{N}_]))";
const unicodeBounds = (re) => new RegExp(re.source.replace(/\\b/g, UB), re.flags.includes("u") ? re.flags : re.flags + "u");
EMERGENCY_PATTERNS.splice(0, EMERGENCY_PATTERNS.length, ...EMERGENCY_PATTERNS.map(unicodeBounds));
MEDICAL_PATTERNS.splice(0, MEDICAL_PATTERNS.length, ...MEDICAL_PATTERNS.map(unicodeBounds));

function detectEmergency(u) {
  const text = String(u || "").replace(NEGATED, " ");
  return EMERGENCY_PATTERNS.some((re) => re.test(text));
}
const detectMedicalQuestion = (u) => MEDICAL_PATTERNS.some((re) => re.test(String(u || "")));

const TASK_TYPES = { prescription: "Rezeptwunsch", referral: "Überweisungswunsch", callback: "Rückrufwunsch", change_request: "Terminänderung", other: "Anliegen" };

const PRAXIS_TOOLS = [
  {
    name: "create_task",
    description:
      "Nur Praxismodus. Legt eine Aufgabe für das Praxisteam an: Rezept- oder Überweisungswunsch, Rückrufwunsch oder Wunsch, " +
      "einen bestehenden Termin zu ändern/abzusagen. Das Team prüft und meldet sich. Keine Diagnosen, Symptome oder Befunde in die Notiz schreiben.",
    minTrust: "L0",
    parameters: {
      type: "object", additionalProperties: false, required: ["type", "name", "phone_e164", "patient_status"],
      properties: {
        type: { type: "string", enum: Object.keys(TASK_TYPES) },
        name: { type: "string", minLength: 2, maxLength: 120 },
        date_of_birth: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Geburtsdatum (YYYY-MM-DD) zur Zuordnung in der Praxis" },
        phone_e164: { type: "string", pattern: "^\\+[1-9][0-9]{6,14}$" },
        note: { type: "string", maxLength: 300, description: "Kurz und sachlich, z. B. Name des Medikaments für ein Folgerezept. Keine Symptome." },
        patient_status: { type: "string", enum: ["existing", "new"], description: "Bestandspatient (schon in Behandlung) oder Neupatient" },
      },
    },
  },
];

// Buchung im Praxismodus: ohne SMS-Code und ohne E-Mail (für ältere Patienten am Festnetz zu umständlich).
// Ausgleich: Das Ergebnis ist IMMER nur ein Vorschlag, den das Praxisteam freigibt – unabhängig von der Autonomie-Einstellung.
const PRAXIS_BOOKING_TOOL = {
  name: "create_booking",
  description: "Praxismodus: merkt einen NEUEN Termin als Vorschlag vor. Das Praxisteam prüft und bestätigt per SMS oder Rückruf. Name, Geburtsdatum und Rückrufnummer vorher einmal wiederholen.",
  minTrust: "L0",
  parameters: {
    type: "object", additionalProperties: false,
    required: ["start", "duration_minutes", "name", "date_of_birth", "phone_e164", "appointment_type", "patient_status"],
    properties: {
      start: { type: "string", format: "date-time" },
      duration_minutes: { type: "integer", enum: [15, 30, 45, 60] },
      name: { type: "string", minLength: 2, maxLength: 120 },
      date_of_birth: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
      phone_e164: { type: "string", pattern: "^\\+[1-9][0-9]{6,14}$" },
      appointment_type: { type: "string", maxLength: 60, description: "Terminart, z. B. Kontrolle, Prophylaxe, Vorsorge. Keine Symptome." },
        patient_status: { type: "string", enum: ["existing", "new"], description: "Bestandspatient (schon in Behandlung) oder Neupatient" },
    },
  },
};

const PRAXIS_PROMPT_BASE = `
## Praxismodus (Arzt- oder Zahnarztpraxis)
- Sprich die Anrufer mit "Sie" an. Du bist der Assistent der Praxis, nicht der Arzt.
- Du beurteilst nichts Medizinisches: keine Einschätzung von Beschwerden, keine Dringlichkeit, keine Auskunft zu Befunden, Werten oder Medikamenten.
  Bei solchen Fragen antworte wörtlich (die Absage enthält bewusst den Notruf-Hinweis): "${MEDICAL_REFUSAL_DE}"
- Notfall-Stichworte (z. B. Brustschmerz, Atemnot, Bewusstlosigkeit, starke Blutung): antworte wörtlich "${EMERGENCY_DE}" und rufe handover_to_human mit reason "possible_emergency" auf.
- WICHTIG: Wenn du auch nur unsicher bist, ob es ein Notfall sein könnte (plötzliche starke Beschwerden, Verwirrtheit, ein Kind mit hohem Fieber, Gedanken, sich etwas anzutun, eine Sprache, die du nicht sicher verstehst), handle genauso: Notfalltext sagen und handover_to_human mit reason "possible_emergency". Lieber einmal zu oft.
- Rezept-, Überweisungs- und Rückrufwünsche sowie Wünsche, einen bestehenden Termin zu ändern oder abzusagen:
  Name, Geburtsdatum und Rückrufnummer erfragen, einmal wiederholen, dann create_task aufrufen.
  Sage, dass das Praxisteam den Wunsch prüft und sich meldet. Versprich nie, dass ein Rezept ausgestellt wird.
- In die Notizen gehören keine Symptome oder Diagnosen, nur das Nötigste (z. B. Medikamentenname beim Folgerezept).
- Du fragst nie nach E-Mail-Adresse oder Bestätigungscodes.
- Frage früh im Gespräch, sobald klar ist, dass es nicht um einen Notfall geht: "Waren Sie schon einmal bei uns in Behandlung?" und gib das Ergebnis als patient_status weiter.
- Folgerezepte und Überweisungen gibt es nur für Bestandspatienten. Bei Neupatienten erkläre freundlich, dass dafür zuerst ein Termin in der Praxis nötig ist, und biete Termin oder Rückrufbitte an.`.trim();

const NEW_PATIENTS_PROMPT = {
  accept: "- Neupatienten: Die Praxis nimmt neue Patienten auf. Plane für sie die Terminart \"Erstvorstellung\" ein (eher 30 als 15 Minuten).",
  callback: "- Neupatienten: Die Praxis entscheidet selbst über die Aufnahme. Buche für Neupatienten keine Termine, sondern nimm eine Rückrufbitte auf (create_task, type \"callback\", Notiz \"Neupatient, Aufnahme anfragen\").",
  closed: "- Neupatienten: Die Praxis nimmt derzeit keine neuen Patienten auf (Aufnahmestopp). Sage das freundlich. Gesetzlich Versicherte können sich für einen Termin an die Terminservicestelle unter 116 117 wenden. Lege für Neupatienten weder Termine noch Aufgaben an.",
};

const PRAXIS_PROMPT_BOOKING = `
- Neue Termine: Terminart und Wunschzeitraum erfragen, mit find_availability höchstens drei Vorschläge nennen, dann Name, Geburtsdatum und Rückrufnummer erfragen und wiederholen, dann create_booking.
  Sage danach: Der Termin ist vorgemerkt, die Praxis meldet sich zur Bestätigung. Nenne ihn nie als fest.
- Termine für akute Beschwerden buchst du nicht selbst, sondern nimmst einen Rückrufwunsch auf (create_task, type "callback").`.trim();

const PRAXIS_PROMPT_CALLBACK_ONLY = `
- Rückruf-Modus: Du buchst KEINE Termine. Für jeden Terminwunsch nimmst du einen Rückrufwunsch auf (create_task, type "callback") mit gewünschter Terminart und Wunschzeitraum in der Notiz.
  Sage: Das Praxisteam ruft zurück und vereinbart den Termin mit Ihnen.`.trim();

/** Praxis-Block für den System-Prompt, je nach Buchungsmodus. */
function praxisPrompt(praxisBooking = "proposal", newPatients = "callback") {
  return `${PRAXIS_PROMPT_BASE}\n${NEW_PATIENTS_PROMPT[newPatients] || NEW_PATIENTS_PROMPT.callback}\n${praxisBooking === "off" ? PRAXIS_PROMPT_CALLBACK_ONLY : PRAXIS_PROMPT_BOOKING}`;
}
const PRAXIS_PROMPT = praxisPrompt("proposal");

/**
 * Tools je Modus.
 *  business:          L0 unverändert (OTP-Pflicht für Buchungen).
 *  praxis/proposal:   find_availability, create_booking (Praxis-Variante ohne OTP, nur Vorschlag), create_task, Link-SMS, Übergabe.
 *  praxis/off:        nur create_task, Link-SMS, Übergabe – keine Kalenderwerkzeuge (Rückruf-Modus zum Einstieg).
 */
function toolsFor(baseTools, industry, praxisBooking = "proposal") {
  if (industry !== "praxis") return baseTools;
  const drop = new Set(["send_otp", "verify_otp", "create_booking", ...(praxisBooking === "off" ? ["find_availability"] : [])]);
  const keep = baseTools.filter((t) => !drop.has(t.name));
  return [...keep, ...(praxisBooking === "off" ? [] : [PRAXIS_BOOKING_TOOL]), ...PRAXIS_TOOLS];
}

/** Aufgaben fürs Praxisteam. Liste im Store, neueste zuerst, höchstens 200, Ablauf nach 30 Tagen. */
const TASK_TTL_MS = 30 * 86400000;
function createTasks(store, now = () => Date.now()) {
  const KEY = "agent:tasks";
  const DONE = "agent:tasks:done";
  const fresh = (t) => now() - Date.parse(t.at) < TASK_TTL_MS;
  return {
    async add(input) {
      const t = {
        id: crypto.randomUUID(), at: new Date(now()).toISOString(),
        type: TASK_TYPES[input.type] ? input.type : "other",
        name: String(input.name || "").slice(0, 120),
        dateOfBirth: /^\d{4}-\d{2}-\d{2}$/.test(input.date_of_birth || "") ? input.date_of_birth : null,
        phone: String(input.phone_e164 || ""),
        note: String(input.note || "").slice(0, 300),
        patientStatus: input.patient_status === "new" ? "new" : input.patient_status === "existing" ? "existing" : null,
        channel: input.channel || "phone",
      };
      await store.listPush(KEY, t, 200);
      return t;
    },
    async list({ includeDone = false } = {}) {
      const done = new Set((await store.getJson(DONE)) || []);
      return (await store.listRange(KEY, 200)).filter(fresh).map((t) => ({ ...t, label: TASK_TYPES[t.type] || "Anliegen", done: done.has(t.id) })).filter((t) => includeDone || !t.done);
    },
    async markDone(id) {
      const all = await store.listRange(KEY, 200);
      if (!all.some((t) => t.id === id)) return false;
      const done = new Set((await store.getJson(DONE)) || []);
      done.add(id);
      await store.setJson(DONE, [...done].slice(-400), Math.ceil(TASK_TTL_MS / 1000));
      return true;
    },
  };
}

module.exports = {
  EMERGENCY_DE, MEDICAL_REFUSAL_DE, NEW_CLOSED_DE, NEW_NO_RX_DE, MODIFY_PRAXIS_DE, DISCLOSURE_PRAXIS_DE, PRAXIS_PROMPT, PRAXIS_TOOLS, PRAXIS_BOOKING_TOOL, TASK_TYPES, praxisPrompt,
  detectEmergency, detectMedicalQuestion, toolsFor, createTasks,
};
