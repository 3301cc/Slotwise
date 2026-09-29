"use strict";
// Pragmatisch statt RFC-vollständig: ein @, keine Leerzeichen, Domain mit Punkt und TLD ≥ 2.
// Dieselbe Regel läuft im Browser (website-src/SitePatches.jsx, swValidEmail).
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;

function normalizeEmail(raw) {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254) return null;
  const [local] = email.split("@");
  if (!local || local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return EMAIL_RE.test(email) ? email : null;
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

module.exports = { normalizeEmail, escapeHtml };
