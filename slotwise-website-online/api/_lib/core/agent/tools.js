"use strict";
/*
 * Tool-Definitionen des Telefonagenten (L0-Freeze).
 * Portiert aus 2-packages-platform/packages/platform/src/agent/tools.ts (STW-201) – inhaltlich unverändert:
 * Es existieren ausschließlich L0-Tools. Tools zum Lesen, Verschieben oder Absagen bestehender Termine gibt es im
 * Code nicht, damit ein Prompt-Injection-Angriff nichts aufrufen kann.
 */
const E164 = "^\\+[1-9][0-9]{6,14}$";

const L0_TOOLS = [
  {
    name: "find_availability",
    description: "Freie Slots des Hosts in einem Zeitraum. Liefert höchstens 6 Vorschläge als ISO-8601 mit Offset.",
    minTrust: "L0",
    parameters: {
      type: "object", additionalProperties: false, required: ["from", "to", "duration_minutes"],
      properties: {
        from: { type: "string", format: "date-time", description: "Beginn des Suchfensters (ISO-8601)" },
        to: { type: "string", format: "date-time", description: "Ende des Suchfensters (ISO-8601), maximal 14 Tage nach from" },
        duration_minutes: { type: "integer", enum: [15, 30, 45, 60] },
      },
    },
  },
  {
    name: "send_otp",
    description: "Sendet einen 6-stelligen Bestätigungscode per SMS an die vom Anrufer genannte Mobilnummer (E.164).",
    minTrust: "L0",
    parameters: { type: "object", additionalProperties: false, required: ["phone_e164"], properties: { phone_e164: { type: "string", pattern: E164 } } },
  },
  {
    name: "verify_otp",
    description: "Prüft den vom Anrufer genannten Code. Liefert otp_token bei Erfolg.",
    minTrust: "L0",
    parameters: {
      type: "object", additionalProperties: false, required: ["phone_e164", "code"],
      properties: { phone_e164: { type: "string", pattern: E164 }, code: { type: "string", pattern: "^[0-9]{6}$" } },
    },
  },
  {
    name: "create_booking",
    description: "Legt einen NEUEN Termin an. Nur nach erfolgreichem verify_otp aufrufen (otp_token erforderlich).",
    minTrust: "L0",
    parameters: {
      type: "object", additionalProperties: false,
      required: ["start", "duration_minutes", "name", "email", "phone_e164", "otp_token"],
      properties: {
        start: { type: "string", format: "date-time" },
        duration_minutes: { type: "integer", enum: [15, 30, 45, 60] },
        name: { type: "string", minLength: 2, maxLength: 120 },
        email: { type: "string", format: "email", maxLength: 254 },
        phone_e164: { type: "string", pattern: E164 },
        notes: { type: "string", maxLength: 500 },
        otp_token: { type: "string", minLength: 32, maxLength: 64 },
      },
    },
  },
  {
    name: "send_booking_link_sms",
    description: "Schickt den öffentlichen Link zur Buchungsseite per SMS an die anrufende oder genannte Nummer. Enthält keine personenbezogenen Daten.",
    minTrust: "L0",
    parameters: { type: "object", additionalProperties: false, required: ["phone_e164"], properties: { phone_e164: { type: "string", pattern: E164 } } },
  },
  {
    name: "handover_to_human",
    description: "Übergibt das Gespräch an einen Menschen oder bietet Rückruf an, wenn niemand erreichbar ist.",
    minTrust: "L0",
    parameters: {
      type: "object", additionalProperties: false, required: ["reason"],
      properties: { reason: { type: "string", enum: ["requested", "out_of_scope", "modify_existing", "verification_failed", "unclear", "possible_emergency"] } },
    },
  },
];

/** Für die Bedrock Converse API: { toolSpec: { name, description, inputSchema: { json } } } */
function toBedrockTools(defs = L0_TOOLS) {
  return defs.map((d) => ({ toolSpec: { name: d.name, description: d.description, inputSchema: { json: d.parameters } } }));
}
/** Für Anthropic Messages API */
function toAnthropicTools(defs = L0_TOOLS) {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}

module.exports = { L0_TOOLS, toBedrockTools, toAnthropicTools };
