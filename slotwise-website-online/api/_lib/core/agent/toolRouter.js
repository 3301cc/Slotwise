"use strict";
/*
 * Serverseitige Durchsetzung. Das Modell schlägt Tool-Aufrufe vor, der Router entscheidet.
 * Portiert aus 2-packages-platform/packages/platform/src/agent/toolRouter.ts (STW-201). Drei Sperren, unabhängig vom Prompt:
 *  1. Allow-List: nur L0-Tools existieren. Unbekannte Namen => Absage + Audit.
 *  2. Intent-Gate: erkennt Änderungs-/Absage-/Auskunftswünsche im Nutzertext deterministisch und antwortet
 *     mit der Standard-Absage, ohne das Modell zu fragen.
 *  3. OTP-Bindung: create_booking nur mit gültigem otp_token, das an dieselbe Nummer und dieselbe Anruf-Session gebunden ist.
 */
const { createHmac, randomBytes, randomInt, timingSafeEqual } = require("node:crypto");
const { L0_TOOLS } = require("./tools");
const { REFUSAL_MODIFY_DE, REFUSAL_MODIFY_EN } = require("./systemPrompt");
const { PRAXIS_TOOLS, EMERGENCY_DE, MEDICAL_REFUSAL_DE, MODIFY_PRAXIS_DE, detectEmergency, detectMedicalQuestion } = require("./praxis");

// Deterministisches Intent-Gate. Bewusst konservativ: lieber eine Absage zu viel als eine Änderung zu viel.
const MODIFY_PATTERNS = [
  /\b(verschieb|umbuch|umleg|verleg|ändern|aendern|absag|stornier|cancel|reschedul|move|change)\w*/i,
  /\b(meinen|unseren|den|meine)\s+termin\s+(am|vom|für|fuer)\b/i,
  /\b(hab(e)?|hatte|gibt es)\s+(?:\w+\s+){0,4}?termin\b/i,
  /\b(bestätig|bestaetig)\w*\s+(?:\w+\s+){0,3}?(meinen|unseren|den)\s+termin/i,
  /\bwann\s+(ist|war)\s+(mein|unser)\s+termin/i,
  /\b(do i|does .* have|is there)\b.*\bappointment\b/i,
];
function detectModifyIntent(utterance) {
  return MODIFY_PATTERNS.some((re) => re.test(utterance));
}

const OTP_TTL_MS = 5 * 60000;
const OTP_MAX_ATTEMPTS = 3;
const OTP_MAX_SENDS_PER_CALL = 3;

/**
 * deps: { otp: { put(key, val, ttlMs), get(key), del(key), incr(key, ttlMs) }, audit: { write(entry) }, hmacSecret, sendSms(to, text), now? }
 * session: { callSid, tenantId, hostId, callerCli, language }
 */
class ToolRouter {
  constructor(deps) {
    this.deps = deps;
    this.now = deps.now || (() => Date.now());
    this.allowed = new Set(L0_TOOLS.map((t) => t.name));
    this.praxisOnly = new Set(PRAXIS_TOOLS.map((t) => t.name)); // nur wenn session.industry === "praxis"
  }

  /** Wird pro Nutzeräußerung VOR dem Modellaufruf ausgeführt. */
  async gateUtterance(session, utterance) {
    const at = new Date(this.now()).toISOString();
    if (session.industry === "praxis") {
      // Reihenfolge: Notfall vor allem anderen
      if (detectEmergency(utterance)) {
        await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "intent:emergency", outcome: "handover", reason: "praxis emergency gate", at });
        return { kind: "emergency", say: EMERGENCY_DE, reason: "emergency" };
      }
      if (detectMedicalQuestion(utterance)) {
        await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "intent:medical", outcome: "refused", reason: "praxis medical gate", at });
        return { kind: "refuse", say: MEDICAL_REFUSAL_DE, reason: "medical_question" };
      }
      if (detectModifyIntent(utterance)) {
        await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "intent:modify_existing", outcome: "refused", reason: "L0 freeze, Aufgabe angeboten", at });
        return { kind: "refuse", say: MODIFY_PRAXIS_DE, reason: "modify_intent_task" };
      }
      return null;
    }
    if (detectModifyIntent(utterance)) {
      await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "intent:modify_existing", outcome: "refused", reason: "L0 freeze", at: new Date(this.now()).toISOString() });
      return { kind: "refuse", say: session.language === "de" ? REFUSAL_MODIFY_DE : REFUSAL_MODIFY_EN, reason: "modify_intent" };
    }
    return null;
  }

  /** Wird für jeden vom Modell vorgeschlagenen Tool-Aufruf ausgeführt. */
  async route(session, call) {
    const at = new Date(this.now()).toISOString();
    const praxisTool = this.praxisOnly.has(call.name) && session.industry === "praxis";
    // Pro Gespräch angebotene Tools (Modus): alles andere wird abgelehnt, auch wenn es sonst erlaubt wäre
    const offered = !session.toolNames || session.toolNames.includes(call.name);
    if ((!this.allowed.has(call.name) && !praxisTool) || !offered) {
      await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: `tool:${call.name}`, outcome: "refused", reason: "not in L0 allow-list", at });
      return { kind: "refuse", say: session.language === "de" ? REFUSAL_MODIFY_DE : REFUSAL_MODIFY_EN, reason: "tool_not_allowed" };
    }
    if (call.name === "send_otp") return this.sendOtp(session, String(call.arguments.phone_e164));
    if (call.name === "verify_otp") return this.verifyOtp(session, String(call.arguments.phone_e164), String(call.arguments.code));
    if (call.name === "create_booking" && session.industry !== "praxis") { // Praxismodus: nur Vorschläge, daher ohne OTP (siehe praxis.js)
      const ok = this.checkOtpToken(session, String(call.arguments.phone_e164), String(call.arguments.otp_token));
      if (!ok) {
        await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "tool:create_booking", outcome: "refused", reason: "otp_token invalid", at });
        return { kind: "refuse", say: session.language === "de" ? "Der Bestätigungscode fehlt oder ist abgelaufen. Ich schicke Ihnen einen neuen." : "The confirmation code is missing or expired. I will send a new one.", reason: "otp_missing" };
      }
    }
    if (call.name === "handover_to_human") return { kind: "handover", reason: String(call.arguments.reason) };
    await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: `tool:${call.name}`, outcome: "executed", at });
    return { kind: "execute", name: call.name, arguments: call.arguments };
  }

  otpKey(session, phone) { return `otp:${session.tenantId}:${session.callSid}:${phone}`; }

  async sendOtp(session, phone) {
    const sends = await this.deps.otp.incr(`otp:sends:${session.callSid}`, 30 * 60000);
    if (sends > OTP_MAX_SENDS_PER_CALL) return { kind: "handover", reason: "verification_failed" };
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    await this.deps.otp.put(this.otpKey(session, phone), { code, expiresAt: this.now() + OTP_TTL_MS, attempts: 0 }, OTP_TTL_MS);
    await this.deps.sendSms(phone, `Ihr CalenSync-Bestätigungscode: ${code}. Gültig 5 Minuten. Nicht weitergeben.`);
    await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "otp:sent", outcome: "executed", at: new Date(this.now()).toISOString() });
    return { kind: "execute", name: "send_otp", arguments: { phone_e164: phone, sent: true } };
  }

  async verifyOtp(session, phone, code) {
    const key = this.otpKey(session, phone);
    const rec = await this.deps.otp.get(key);
    if (!rec || rec.expiresAt < this.now()) return { kind: "refuse", say: session.language === "de" ? "Der Code ist abgelaufen." : "The code has expired.", reason: "otp_expired" };
    if (rec.attempts >= OTP_MAX_ATTEMPTS) { await this.deps.otp.del(key); return { kind: "handover", reason: "verification_failed" }; }
    const a = Buffer.from(rec.code), b = Buffer.from(code.padEnd(6, " ").slice(0, 6));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.deps.otp.put(key, { ...rec, attempts: rec.attempts + 1 }, Math.max(1, rec.expiresAt - this.now()));
      return { kind: "refuse", say: session.language === "de" ? "Der Code stimmt nicht. Bitte noch einmal." : "That code is not correct. Please try again.", reason: "otp_wrong" };
    }
    await this.deps.otp.del(key);
    const token = this.mintOtpToken(session, phone);
    await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: "otp:verified", outcome: "executed", at: new Date(this.now()).toISOString() });
    return { kind: "execute", name: "verify_otp", arguments: { phone_e164: phone, otp_token: token } };
  }

  /** Token = HMAC(callSid|phone|exp). Bindet den Nachweis an Anruf und Nummer; 10 Minuten gültig. */
  mintOtpToken(session, phone) {
    const exp = this.now() + 10 * 60000;
    const nonce = randomBytes(8).toString("hex");
    const mac = createHmac("sha256", this.deps.hmacSecret).update(`${session.callSid}|${phone}|${exp}|${nonce}`).digest("hex").slice(0, 32);
    return Buffer.from(`${exp}.${nonce}.${mac}`).toString("base64url");
  }

  checkOtpToken(session, phone, token) {
    try {
      const [exp, nonce, mac] = Buffer.from(token, "base64url").toString().split(".");
      if (Number(exp) < this.now()) return false;
      const expected = createHmac("sha256", this.deps.hmacSecret).update(`${session.callSid}|${phone}|${exp}|${nonce}`).digest("hex").slice(0, 32);
      return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
    } catch { return false; }
  }
}

/** OTP-Speicher auf Basis des generischen Stores (getJson/setJson/delKey/incrWithTtl). */
function otpStoreFrom(store) {
  return {
    put: (k, v, ttlMs) => store.setJson(k, v, Math.ceil(ttlMs / 1000)),
    get: (k) => store.getJson(k),
    del: (k) => store.delKey(k),
    incr: (k, ttlMs) => store.incrWithTtl(k, Math.ceil(ttlMs / 1000)),
  };
}

module.exports = { ToolRouter, detectModifyIntent, otpStoreFrom };
