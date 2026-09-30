"use strict";
/*
 * Einstellungen aus dem Dashboard-Panel „KI-Assistent steuern“. Liegen im Store (agent:settings) und fließen
 * bei jedem Modellaufruf als dynamischer Block in den System-Prompt (systemPrompt.js) – Änderungen gelten sofort.
 */
const DEFAULTS = { autonomy: "draft", maxPerDay: 4, instructions: "" };
const KEY = "agent:settings";

function sanitize(input) {
  const s = { ...DEFAULTS };
  if (input && typeof input === "object") {
    if (input.autonomy === "auto" || input.autonomy === "draft") s.autonomy = input.autonomy;
    const n = Number(input.maxPerDay);
    if (Number.isInteger(n) && n >= 1 && n <= 12) s.maxPerDay = n;
    if (typeof input.instructions === "string") s.instructions = input.instructions.trim().slice(0, 600);
  }
  return s;
}

function createSettings(store, now = () => Date.now()) {
  return {
    async get() { return (await store.getJson(KEY)) || { ...DEFAULTS, updatedAt: null }; },
    async save(input) {
      const next = { ...sanitize(input), updatedAt: new Date(now()).toISOString() };
      await store.setJson(KEY, next);
      return next;
    },
    sanitize,
  };
}

module.exports = { createSettings, sanitize, DEFAULTS };
