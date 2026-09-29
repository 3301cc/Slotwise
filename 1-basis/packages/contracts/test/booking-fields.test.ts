import { describe, expect, it } from "vitest";
import { buildAnswersSchema, compactAnswers, parseBookingFields } from "../src/booking-fields";

const fields = parseBookingFields([
  { key: "company", label: "Firma", type: "text", required: true },
  { key: "employees", label: "Mitarbeiteranzahl", type: "select", required: true, options: [{ value: "1-9", label: "1–9" }, { value: "10-49", label: "10–49" }] },
  { key: "budget", label: "Budget", type: "number", required: false, min: 0 },
  { key: "topics", label: "Themen", type: "multiselect", required: false, options: [{ value: "phone", label: "Telefon" }, { value: "crm", label: "CRM" }] },
  { key: "newsletter", label: "Newsletter", type: "checkbox", required: false },
  { key: "name", label: "shadowing a base field is dropped", type: "text", required: true },
]);
const schema = buildAnswersSchema(fields);

describe("bookingFields → zod", () => {
  it("drops reserved keys and keeps the rest", () => {
    expect(fields.map((f) => f.key)).toEqual(["company", "employees", "budget", "topics", "newsletter"]);
  });

  it("accepts a complete answer set from the web form (strings, arrays, booleans)", () => {
    const r = schema.safeParse({ company: " Müller GmbH ", employees: "10-49", budget: "1500", topics: ["phone"], newsletter: "on" });
    expect(r.success).toBe(true);
    expect(compactAnswers(r.data as Record<string, unknown>)).toEqual({ company: "Müller GmbH", employees: "10-49", budget: 1500, topics: ["phone"], newsletter: true });
  });

  it("accepts blanks for optional fields and rejects missing required ones with field paths", () => {
    const ok = schema.safeParse({ company: "X", employees: "1-9", budget: "", topics: false, newsletter: false });
    expect(ok.success).toBe(true);
    expect(compactAnswers(ok.data as Record<string, unknown>)).toEqual({ company: "X", employees: "1-9", newsletter: false });

    const bad = schema.safeParse({ company: "", employees: "", budget: "abc" });
    expect(bad.success).toBe(false);
    const byKey = Object.fromEntries(bad.error!.issues.map((i) => [String(i.path[0]), i.message]));
    expect(byKey.company).toMatch(/erforderlich/);
    expect(byKey.employees).toMatch(/erforderlich/);
    expect(byKey.budget).toMatch(/Zahl/);
  });

  it("rejects values outside the options and unknown keys (strict)", () => {
    expect(schema.safeParse({ company: "X", employees: "999" }).success).toBe(false);
    expect(schema.safeParse({ company: "X", employees: "1-9", topics: ["nope"] }).success).toBe(false);
    expect(schema.safeParse({ company: "X", employees: "1-9", injected: "1" }).success).toBe(false);
  });

  it("a broken definition never breaks the page", () => {
    expect(parseBookingFields({ not: "an array" })).toEqual([]);
    expect(parseBookingFields([{ key: "BAD KEY", label: "x", type: "text" }])).toEqual([]);
    expect(parseBookingFields([{ key: "s", label: "x", type: "select" }])).toEqual([]); // select without options
  });
});
