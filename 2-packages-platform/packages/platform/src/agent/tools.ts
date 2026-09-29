/**
 * STW-201 · Tool-Definitionen (Function Calling, OpenAI-/Anthropic-kompatibles JSON-Schema).
 * In R0 sind ausschließlich die L0-Tools registriert. Tools für L2 (read/reschedule/cancel)
 * existieren im Code nicht, damit ein Prompt-Injection-Angriff nichts aufrufen kann.
 */

export type TrustLevel = 'L0';

export interface ToolDefinition {
  name: string;
  description: string;
  minTrust: TrustLevel;
  parameters: Record<string, unknown>; // JSON-Schema
}

export const L0_TOOLS: ToolDefinition[] = [
  {
    name: 'find_availability',
    description: 'Freie Slots des Hosts in einem Zeitraum. Liefert höchstens 6 Vorschläge als ISO-8601 mit Offset.',
    minTrust: 'L0',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['from', 'to', 'duration_minutes'],
      properties: {
        from: { type: 'string', format: 'date-time', description: 'Beginn des Suchfensters (ISO-8601)' },
        to: { type: 'string', format: 'date-time', description: 'Ende des Suchfensters (ISO-8601), maximal 14 Tage nach from' },
        duration_minutes: { type: 'integer', enum: [15, 30, 45, 60] },
      },
    },
  },
  {
    name: 'send_otp',
    description: 'Sendet einen 6-stelligen Bestätigungscode per SMS an die vom Anrufer genannte Mobilnummer (E.164).',
    minTrust: 'L0',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['phone_e164'],
      properties: { phone_e164: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' } },
    },
  },
  {
    name: 'verify_otp',
    description: 'Prüft den vom Anrufer genannten Code. Liefert otp_token bei Erfolg.',
    minTrust: 'L0',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['phone_e164', 'code'],
      properties: {
        phone_e164: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' },
        code: { type: 'string', pattern: '^[0-9]{6}$' },
      },
    },
  },
  {
    name: 'create_booking',
    description: 'Legt einen NEUEN Termin an. Nur nach erfolgreichem verify_otp aufrufen (otp_token erforderlich).',
    minTrust: 'L0',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['start', 'duration_minutes', 'name', 'email', 'phone_e164', 'otp_token'],
      properties: {
        start: { type: 'string', format: 'date-time' },
        duration_minutes: { type: 'integer', enum: [15, 30, 45, 60] },
        name: { type: 'string', minLength: 2, maxLength: 120 },
        email: { type: 'string', format: 'email', maxLength: 254 },
        phone_e164: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' },
        notes: { type: 'string', maxLength: 500 },
        otp_token: { type: 'string', minLength: 32, maxLength: 64 },
      },
    },
  },
  {
    name: 'send_booking_link_sms',
    description: 'Schickt den öffentlichen Link zur Buchungsseite per SMS an die anrufende oder genannte Nummer. Enthält keine personenbezogenen Daten.',
    minTrust: 'L0',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['phone_e164'],
      properties: { phone_e164: { type: 'string', pattern: '^\\+[1-9][0-9]{6,14}$' } },
    },
  },
  {
    name: 'handover_to_human',
    description: 'Übergibt das Gespräch an einen Menschen oder bietet Rückruf an, wenn niemand erreichbar ist.',
    minTrust: 'L0',
    parameters: {
      type: 'object',
      additionalProperties: false,
      required: ['reason'],
      properties: { reason: { type: 'string', enum: ['requested', 'out_of_scope', 'modify_existing', 'verification_failed', 'unclear'] } },
    },
  },
];

/** Für OpenAI-kompatible APIs: { type: 'function', function: {...} } */
export function toOpenAiTools(defs: ToolDefinition[] = L0_TOOLS) {
  return defs.map((d) => ({ type: 'function' as const, function: { name: d.name, description: d.description, parameters: d.parameters, strict: true } }));
}

/** Für Anthropic Messages API: { name, description, input_schema } */
export function toAnthropicTools(defs: ToolDefinition[] = L0_TOOLS) {
  return defs.map((d) => ({ name: d.name, description: d.description, input_schema: d.parameters }));
}
