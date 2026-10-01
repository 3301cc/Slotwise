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
  "Außerhalb der Sprechzeiten erreichen Sie den ärztlichen Bereitschaftsdienst unter 116 117. " +
  "Ich gebe Ihren Anruf jetzt an das Praxisteam weiter.";

const MEDICAL_REFUSAL_DE =
  "Medizinische Fragen kann ich nicht beantworten, das klärt die Praxis persönlich mit Ihnen. " +
  "Ich kann Ihnen einen Termin geben oder einen Rückrufwunsch für das Praxisteam aufnehmen. Was ist Ihnen lieber?";

const MODIFY_PRAXIS_DE =
  "Bestehende Termine kann ich am Telefon nicht einsehen oder ändern. " +
  "Ich nehme Ihren Wunsch aber für das Praxisteam auf, es meldet sich bei Ihnen. Wie ist Ihr Name und unter welcher Nummer erreichen wir Sie?";

const DISCLOSURE_PRAXIS_DE =
  "Guten Tag, Sie sprechen mit dem digitalen Assistenten der Praxis {{company}}. Das Gespräch wird zur Terminvereinbarung verarbeitet. " +
  "Bei einem Notfall rufen Sie bitte die 112 an. Wie kann ich Ihnen helfen?";

// Bewusst breit: lieber einmal zu oft auf die 112 verweisen als einmal zu wenig.
const EMERGENCY_PATTERNS = [
  /\bnotfall\b/i,
  /\b(brust|herz)\w*\s*(schmerz|stech|druck|enge)/i,
  /\b(atemnot|keine luft|krieg\w* (kaum |keine )?luft|kann nicht (mehr )?atmen|ersticke)/i,
  /\b(bewusstlos|ohnmächtig|ohnmaechtig|kollabiert|zusammengebrochen|krampfanfall|krampft)/i,
  /\b(schlaganfall|herzinfarkt|lähmung|laehmung|gelähmt|gelaehmt|sprachstörung|gesicht hängt)/i,
  /\b(blutet stark|starke blutung|hört nicht auf zu bluten|viel blut)/i,
  /\b(suizid|selbstmord|umbringen|nicht mehr leben|mir etwas antun)/i,
  /\b(vergiftung|vergiftet|überdosis|ueberdosis|allergischer schock|anaphyla)/i,
  /\b(unfall|gestürzt|gestuerzt).{0,30}\b(kopf|bewusst|blut)/i,
];
const MEDICAL_PATTERNS = [
  /\bist (das|es) (gefährlich|gefaehrlich|schlimm|normal|ansteckend)\b/i,
  /\bsoll(te)? ich\b.{0,40}\b(nehmen|absetzen|einnehmen|kühlen|kuehlen|warten|ins krankenhaus)\b/i,
  /\b(welche|wie viel|wieviel)\w*\b.{0,20}\b(dosis|tabletten|milligramm|mg)\b/i,
  /\b(was bedeutet|was heißt|was heisst)\b.{0,30}\b(befund|wert|ergebnis|diagnose)\b/i,
  /\b(laborwert|blutwert|befund|röntgenbild|roentgenbild|mrt)\w*\b.{0,30}\b(sagen|erklären|erklaeren|vorlesen|durchgeben)\b/i,
  /\bhabe ich\b.{0,30}\b(krankheit|infektion|entzündung|entzuendung|krebs|corona)\b/i,
  /\b(welches|was für ein) (medikament|mittel|antibiotikum)\b/i,
];

const detectEmergency = (u) => EMERGENCY_PATTERNS.some((re) => re.test(String(u || "")));
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
      type: "object", additionalProperties: false, required: ["type", "name", "phone_e164"],
      properties: {
        type: { type: "string", enum: Object.keys(TASK_TYPES) },
        name: { type: "string", minLength: 2, maxLength: 120 },
        date_of_birth: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "Geburtsdatum (YYYY-MM-DD) zur Zuordnung in der Praxis" },
        phone_e164: { type: "string", pattern: "^\\+[1-9][0-9]{6,14}$" },
        note: { type: "string", maxLength: 300, description: "Kurz und sachlich, z. B. Name des Medikaments für ein Folgerezept. Keine Symptome." },
      },
    },
  },
];

const PRAXIS_PROMPT = `
## Praxismodus (Arzt- oder Zahnarztpraxis)
- Sprich die Anrufer mit "Sie" an. Du bist der Assistent der Praxis, nicht der Arzt.
- Du beurteilst nichts Medizinisches: keine Einschätzung von Beschwerden, keine Dringlichkeit, keine Auskunft zu Befunden, Werten oder Medikamenten.
  Bei solchen Fragen antworte wörtlich: "${MEDICAL_REFUSAL_DE}"
- Notfall-Stichworte (z. B. Brustschmerz, Atemnot, Bewusstlosigkeit, starke Blutung): antworte wörtlich "${EMERGENCY_DE}" und rufe handover_to_human auf.
- Rezept-, Überweisungs- und Rückrufwünsche sowie Wünsche, einen bestehenden Termin zu ändern oder abzusagen:
  Name, Geburtsdatum und Rückrufnummer erfragen, einmal wiederholen, dann create_task aufrufen.
  Sage, dass das Praxisteam den Wunsch prüft und sich meldet. Versprich nie, dass ein Rezept ausgestellt wird.
- In die Notiz von create_task gehören keine Symptome oder Diagnosen, nur das Nötigste (z. B. Medikamentenname beim Folgerezept).
- Neue Termine buchst du wie gewohnt. Termine für akute Beschwerden nur in Zeitfenster, die die Praxis dafür freigegeben hat.
`.trim();

function toolsFor(baseTools, industry) {
  return industry === "praxis" ? [...baseTools, ...PRAXIS_TOOLS] : baseTools;
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
  EMERGENCY_DE, MEDICAL_REFUSAL_DE, MODIFY_PRAXIS_DE, DISCLOSURE_PRAXIS_DE, PRAXIS_PROMPT, PRAXIS_TOOLS, TASK_TYPES,
  detectEmergency, detectMedicalQuestion, toolsFor, createTasks,
};
