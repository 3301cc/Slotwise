/**
 * Writes apps/voice/app/contracts.json — JSON Schema for every internal API
 * payload — so the Python worker validates against the same contract.
 * Run: pnpm --filter @slotwise/contracts export:jsonschema
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { voiceContract } from "../src/voice";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../../../apps/voice/app/contracts.json");

const schemas: Record<string, { request: unknown; response: unknown }> = {};
for (const [name, pair] of Object.entries(voiceContract)) {
  schemas[name] = {
    request: z.toJSONSchema(pair.request),
    response: z.toJSONSchema(pair.response),
  };
}

mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `${JSON.stringify({ $comment: "generated — do not edit", ...schemas }, null, 2)}\n`);
console.log(`wrote ${out}`);
