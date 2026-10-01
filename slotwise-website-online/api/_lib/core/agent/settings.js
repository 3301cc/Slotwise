"use strict";
/*
 * Einstellungen aus dem Dashboard-Panel „KI-Assistent steuern“. Liegen im Store (agent:settings) und fließen
 * bei jedem Modellaufruf als dynamischer Block in den System-Prompt (systemPrompt.js) – Änderungen gelten sofort.
 */
const DEFAULTS = { autonomy: "draft", maxPerDay: 4, instructions: "", industry: "business" };
const KEY = "agent:settings";

function sanitize(input) {
  const s = { ...DEFAULTS };
  if (input && typeof input === "object") {
    if (input.autonomy === "auto" || input.autonomy === "draft") s.autonomy = input.autonomy;
    const n = Number(input.maxPerDay);
    if (Number.isInteger(n) && n >= 1 && n <= 12) s.maxPerDay = n;
    if (typeof input.instructions === "string") s.instructions = input.instructions.trim().slice(0, 600);
    if (input.industry === "praxis" || input.industry === "business") s.industry = input.industry; // Praxismodus: siehe praxis.js
  }
  return s;
}

function createSettings(store, now = () => Date.now()) {
  return {
    async get() { return (await store.getJson(KEY)) || { ...DEFAULTS, updatedAt: null }; },
    async save(input) {
      // Teil-Updates erlaubt: fehlende Felder behalten ihren bisherigen Wert (z. B. industry beim Speichern des KI-Panels)
      const cur = (await store.getJson(KEY)) || {};
      const next = { ...sanitize({ ...cur, ...(input && typeof input === "object" ? input : {}) }), updatedAt: new Date(now()).toISOString() };
      await store.setJson(KEY, next);
      return next;
    },
    sanitize,
  };
}

module.exports = { createSettings, sanitize, DEFAULTS };
