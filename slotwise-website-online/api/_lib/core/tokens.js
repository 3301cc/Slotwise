"use strict";
// Signierte, ablaufende Links (HMAC-SHA256). Kein Zustand nötig – nur das Geheimnis.
const crypto = require("node:crypto");
const { normalizeEmail } = require("./email");

function createTokens(secret) {
  if (!secret) throw new Error("tokens: secret fehlt");
  const b64u = (buf) => Buffer.from(buf).toString("base64url");
  const mac = (body) => crypto.createHmac("sha256", secret).update(body).digest("base64url");

  return {
    sign(payload) {
      const body = b64u(JSON.stringify(payload));
      return `${body}.${mac(body)}`;
    },
    verify(token, purpose, now = Date.now()) {
      if (typeof token !== "string" || token.length > 1024 || !token.includes(".")) return { ok: false, reason: "invalid" };
      const [body, given] = token.split(".");
      const a = Buffer.from(given || ""), b = Buffer.from(mac(body));
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { ok: false, reason: "invalid" };
      let data;
      try { data = JSON.parse(Buffer.from(body, "base64url").toString("utf8")); } catch { return { ok: false, reason: "invalid" }; }
      if (data.p !== purpose || !normalizeEmail(data.e)) return { ok: false, reason: "invalid" };
      if (data.x && now > data.x) return { ok: false, reason: "expired" };
      return { ok: true, data };
    },
  };
}

module.exports = { createTokens };
