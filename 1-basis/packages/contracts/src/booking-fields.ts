/**
 * Custom booking questions per event type — stored as JSON in
 * `EventType.bookingFields`, rendered dynamically by the booking form, validated
 * with the SAME zod schema on the client (react-hook-form) and in the server
 * action / voice service. One definition, one validator.
 *
 * Example (seed, "Demo call"):
 *   [{ key: "company",   label: "Firma",              type: "text",   required: true },
 *    { key: "employees", label: "Mitarbeiteranzahl",  type: "select", required: true,
 *      options: [{ value: "1-9", label: "1–9" }, { value: "10-49", label: "10–49" }, …] },
 *    { key: "budget",    label: "Budget (€/Monat)",   type: "select", required: false, options: [...] }]
 */

import { z } from "zod";

export const bookingFieldTypes = ["text", "textarea", "email", "phone", "number", "select", "multiselect", "checkbox"] as const;
export type BookingFieldType = (typeof bookingFieldTypes)[number];

const option = z.object({ value: z.string().min(1).max(80), label: z.string().min(1).max(120) });

export const bookingField = z
  .object({
    key: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, "key: a-z, 0-9, _ (2–32 chars)"),
    label: z.string().min(1).max(120),
    type: z.enum(bookingFieldTypes),
    required: z.boolean().default(false),
    placeholder: z.string().max(120).optional(),
    helpText: z.string().max(300).optional(),
    options: z.array(option).min(1).max(50).optional(), // select / multiselect
    min: z.number().optional(), // number
    max: z.number().optional(),
    maxLength: z.number().int().min(1).max(2000).optional(), // text / textarea
  })
  .superRefine((f, ctx) => {
    if ((f.type === "select" || f.type === "multiselect") && !f.options?.length) {
      ctx.addIssue({ code: "custom", path: ["options"], message: `${f.type} needs options` });
    }
  });
export type BookingField = z.infer<typeof bookingField>;

export const bookingFields = z.array(bookingField).max(20).superRefine((fields, ctx) => {
  const seen = new Set<string>();
  for (const f of fields) {
    if (seen.has(f.key)) ctx.addIssue({ code: "custom", message: `duplicate key "${f.key}"` });
    seen.add(f.key);
  }
});
export type BookingFields = z.infer<typeof bookingFields>;

const RESERVED_KEYS = new Set(["name", "email", "phone", "note", "consent", "startsAt", "orgSlug", "eventTypeSlug", "viewerTz", "answers"]);

/** Parse the JSON column defensively: a broken definition must never break the booking page. */
export function parseBookingFields(raw: unknown): BookingFields {
  if (raw == null) return [];
  const r = bookingFields.safeParse(raw);
  return r.success ? r.data.filter((f) => !RESERVED_KEYS.has(f.key)) : [];
}

/**
 * Builds the zod object schema for the answers. Optional fields accept
 * undefined / "" / [] (form inputs post empty values). Errors carry the field
 * key as path so both react-hook-form and the server action can map them.
 * Messages are German — the public booking page is German-first (MVP).
 */
export function buildAnswersSchema(fields: BookingFields) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const f of fields) shape[f.key] = fieldSchema(f);
  return z.object(shape).strict();
}
export type AnswersSchema = ReturnType<typeof buildAnswersSchema>;
export type Answers = Record<string, string | number | boolean | string[] | undefined>;

const empty = (v: unknown) => v === "" || v === null || v === undefined;
/** Empty form values become `undefined` so `.optional()` accepts them. */
const blankToUndefined = (schema: z.ZodTypeAny) => z.preprocess((v) => (empty(v) ? undefined : v), schema);

function fieldSchema(f: BookingField): z.ZodTypeAny {
  const required = `${f.label} ist erforderlich`;

  switch (f.type) {
    case "text":
    case "textarea": {
      const max = f.maxLength ?? (f.type === "textarea" ? 2000 : 200);
      return f.required
        ? z.string({ message: required }).trim().min(1, required).max(max, `${f.label}: höchstens ${max} Zeichen`)
        : blankToUndefined(z.string().trim().max(max, `${f.label}: höchstens ${max} Zeichen`).optional());
    }
    case "email": {
      const s = z.string({ message: required }).trim().email(`${f.label}: ungültige E-Mail`).max(200);
      return f.required ? s.min(1, required) : blankToUndefined(s.optional());
    }
    case "phone": {
      const s = z.string({ message: required }).trim().regex(/^\+?[0-9 ()/-]{6,20}$/, `${f.label}: ungültige Telefonnummer`);
      return f.required ? s : blankToUndefined(s.optional());
    }
    case "number": {
      let n = z.coerce.number({ message: f.required ? required : `${f.label}: bitte eine Zahl eingeben` });
      if (f.min != null) n = n.min(f.min, `${f.label}: mindestens ${f.min}`);
      if (f.max != null) n = n.max(f.max, `${f.label}: höchstens ${f.max}`);
      // blank → undefined BEFORE coercion (Number("") would be 0)
      return blankToUndefined(f.required ? n : n.optional());
    }
    case "select": {
      const values = (f.options ?? []).map((o) => o.value) as [string, ...string[]];
      const e = z.enum(values, { message: f.required ? required : `${f.label}: bitte eine Option wählen` });
      return f.required ? blankToUndefined(e) : blankToUndefined(e.optional());
    }
    case "multiselect": {
      const values = (f.options ?? []).map((o) => o.value) as [string, ...string[]];
      let a = z.array(z.enum(values, { message: `${f.label}: ungültige Option` })).max(values.length);
      if (f.required) a = a.min(1, required);
      // react-hook-form yields `false` for an unchecked group, FormData yields a single string
      return z.preprocess((v) => (v === false || empty(v) ? [] : typeof v === "string" ? [v] : v), a);
    }
    case "checkbox": {
      const b = z.preprocess((v) => v === true || v === "true" || v === "on", z.boolean());
      return f.required ? b.refine((v) => v === true, required) : b;
    }
  }
}

// ── answer-based routing rules (EventTypeHost.match) ────────────────────────

/**
 * Segment rule of a pool member: takes bookings whose answer to `field` is one
 * of `values`. Rules on one member are AND-ed, values OR-ed. Matching lives in
 * `@slotwise/core` (`rankCandidates`); this is only the JSON-column shape.
 *   [{ field: "employees", values: ["50-249", "250+"] }]   // "User B takes enterprises"
 */
export const routingMatch = z
  .array(
    z.object({
      field: z.string().regex(/^[a-z][a-z0-9_]{1,31}$/, "field: a bookingFields key"),
      values: z.array(z.string().min(1).max(80)).min(1).max(50),
    }),
  )
  .max(10);
export type RoutingMatch = z.infer<typeof routingMatch>;

/** Parse the JSON column defensively: a broken rule set means "catch-all", never a crash. */
export function parseRoutingMatch(raw: unknown): RoutingMatch | null {
  if (raw == null) return null;
  const r = routingMatch.safeParse(raw);
  return r.success && r.data.length ? r.data : null;
}

/**
 * Cross-check a rule set against the event type's fields (dashboard save-time):
 * every `field` must be a select/multiselect question and every value one of
 * its options. Returns the problems (empty = valid).
 */
export function checkRoutingMatch(match: RoutingMatch, fields: BookingFields): string[] {
  const problems: string[] = [];
  for (const rule of match) {
    const f = fields.find((x) => x.key === rule.field);
    if (!f) {
      problems.push(`unknown field "${rule.field}"`);
      continue;
    }
    if (f.type !== "select" && f.type !== "multiselect") {
      problems.push(`"${rule.field}" is ${f.type}; routing rules need select/multiselect`);
      continue;
    }
    const allowed = new Set((f.options ?? []).map((o) => o.value));
    for (const v of rule.values) if (!allowed.has(v)) problems.push(`"${rule.field}": unknown option "${v}"`);
  }
  return problems;
}

/** Normalises answers for storage: drops empty optional values, keeps only defined keys. */
export function compactAnswers(answers: Record<string, unknown>): Answers {
  const out: Answers = {};
  for (const [k, v] of Object.entries(answers)) {
    if (v === undefined || v === "" || (Array.isArray(v) && v.length === 0)) continue;
    out[k] = v as Answers[string];
  }
  return out;
}
