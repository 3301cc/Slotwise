/**
 * STW-201 · Serverseitige Durchsetzung. Das Modell schlägt Tool-Aufrufe vor,
 * der Router entscheidet. Drei Sperren, unabhängig vom Prompt:
 *  1. Allow-List: nur L0-Tools existieren. Unbekannte Namen => Absage + Audit.
 *  2. Intent-Gate: erkennt Änderungs-/Absage-/Auskunftswünsche im Nutzertext
 *     deterministisch und antwortet mit der Standard-Absage, ohne das Modell zu fragen.
 *  3. OTP-Bindung: create_booking nur mit gültigem otp_token, das an dieselbe
 *     Nummer und dieselbe Anruf-Session gebunden ist.
 */
import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { L0_TOOLS } from './tools.js';
import { REFUSAL_MODIFY_DE, REFUSAL_MODIFY_EN } from './systemPrompt.js';

export interface CallSession {
  callSid: string;
  tenantId: string;
  hostId: string;
  callerCli: string | null; // Rufnummer, nur informativ, nie Nachweis
  language: 'de' | 'en';
}

export interface ToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export type RouterDecision =
  | { kind: 'execute'; name: string; arguments: Record<string, unknown> }
  | { kind: 'refuse'; say: string; reason: string }
  | { kind: 'handover'; reason: string };

export interface OtpStore {
  put(key: string, value: { code: string; expiresAt: number; attempts: number }, ttlMs: number): Promise<void>;
  get(key: string): Promise<{ code: string; expiresAt: number; attempts: number } | null>;
  del(key: string): Promise<void>;
  incr(key: string, ttlMs: number): Promise<number>; // Rate-Limit-Zähler
}

export interface AuditLog {
  write(entry: { callSid: string; tenantId: string; action: string; outcome: 'executed' | 'refused' | 'handover'; reason?: string; at: string }): Promise<void>;
}

// Deterministisches Intent-Gate. Bewusst konservativ: lieber eine Absage zu viel als eine Änderung zu viel.
const MODIFY_PATTERNS: RegExp[] = [
  /\b(verschieb|umbuch|umleg|verleg|ändern|aendern|absag|stornier|cancel|reschedul|move|change)\w*/i,
  /\b(meinen|unseren|den|meine)\s+termin\s+(am|vom|für|fuer)\b/i,
  /\b(hab(e)?|hatte|gibt es)\s+(?:\w+\s+){0,4}?termin\b/i, // "Habe ich morgen einen Termin?"
  /\b(bestätig|bestaetig)\w*\s+(?:\w+\s+){0,3}?(meinen|unseren|den)\s+termin/i, // "bestätigen Sie mir den Termin"
  /\bwann\s+(ist|war)\s+(mein|unser)\s+termin/i,
  /\b(do i|does .* have|is there)\b.*\bappointment\b/i,
];

export function detectModifyIntent(utterance: string): boolean {
  return MODIFY_PATTERNS.some((re) => re.test(utterance));
}

const OTP_TTL_MS = 5 * 60_000;
const OTP_MAX_ATTEMPTS = 3;
const OTP_MAX_SENDS_PER_CALL = 3;

export class ToolRouter {
  private readonly allowed = new Set(L0_TOOLS.map((t) => t.name));

  constructor(private readonly deps: { otp: OtpStore; audit: AuditLog; hmacSecret: string; sendSms(to: string, text: string): Promise<void> }) {}

  /** Wird pro Nutzeräußerung VOR dem Modellaufruf ausgeführt. */
  async gateUtterance(session: CallSession, utterance: string): Promise<RouterDecision | null> {
    if (detectModifyIntent(utterance)) {
      await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: 'intent:modify_existing', outcome: 'refused', reason: 'L0 freeze', at: new Date().toISOString() });
      return { kind: 'refuse', say: session.language === 'de' ? REFUSAL_MODIFY_DE : REFUSAL_MODIFY_EN, reason: 'modify_intent' };
    }
    return null;
  }

  /** Wird für jeden vom Modell vorgeschlagenen Tool-Aufruf ausgeführt. */
  async route(session: CallSession, call: ToolCall): Promise<RouterDecision> {
    if (!this.allowed.has(call.name)) {
      await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: `tool:${call.name}`, outcome: 'refused', reason: 'not in L0 allow-list', at: new Date().toISOString() });
      return { kind: 'refuse', say: session.language === 'de' ? REFUSAL_MODIFY_DE : REFUSAL_MODIFY_EN, reason: 'tool_not_allowed' };
    }
    if (call.name === 'send_otp') return this.sendOtp(session, String(call.arguments.phone_e164));
    if (call.name === 'verify_otp') return this.verifyOtp(session, String(call.arguments.phone_e164), String(call.arguments.code));
    if (call.name === 'create_booking') {
      const ok = this.checkOtpToken(session, String(call.arguments.phone_e164), String(call.arguments.otp_token));
      if (!ok) {
        await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: 'tool:create_booking', outcome: 'refused', reason: 'otp_token invalid', at: new Date().toISOString() });
        return { kind: 'refuse', say: session.language === 'de' ? 'Der Bestätigungscode fehlt oder ist abgelaufen. Ich schicke Ihnen einen neuen.' : 'The confirmation code is missing or expired. I will send a new one.', reason: 'otp_missing' };
      }
    }
    if (call.name === 'handover_to_human') return { kind: 'handover', reason: String(call.arguments.reason) };
    await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: `tool:${call.name}`, outcome: 'executed', at: new Date().toISOString() });
    return { kind: 'execute', name: call.name, arguments: call.arguments };
  }

  // ── OTP ───────────────────────────────────────────────────────────────────

  private otpKey(session: CallSession, phone: string) {
    return `otp:${session.tenantId}:${session.callSid}:${phone}`;
  }

  private async sendOtp(session: CallSession, phone: string): Promise<RouterDecision> {
    const sends = await this.deps.otp.incr(`otp:sends:${session.callSid}`, 30 * 60_000);
    if (sends > OTP_MAX_SENDS_PER_CALL) return { kind: 'handover', reason: 'verification_failed' };
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    await this.deps.otp.put(this.otpKey(session, phone), { code, expiresAt: Date.now() + OTP_TTL_MS, attempts: 0 }, OTP_TTL_MS);
    await this.deps.sendSms(phone, `Ihr Slotwise-Bestätigungscode: ${code}. Gültig 5 Minuten. Nicht weitergeben.`);
    await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: 'otp:sent', outcome: 'executed', at: new Date().toISOString() });
    return { kind: 'execute', name: 'send_otp', arguments: { phone_e164: phone, sent: true } };
  }

  private async verifyOtp(session: CallSession, phone: string, code: string): Promise<RouterDecision> {
    const key = this.otpKey(session, phone);
    const rec = await this.deps.otp.get(key);
    if (!rec || rec.expiresAt < Date.now()) return { kind: 'refuse', say: session.language === 'de' ? 'Der Code ist abgelaufen.' : 'The code has expired.', reason: 'otp_expired' };
    if (rec.attempts >= OTP_MAX_ATTEMPTS) {
      await this.deps.otp.del(key);
      return { kind: 'handover', reason: 'verification_failed' };
    }
    const a = Buffer.from(rec.code);
    const b = Buffer.from(code.padEnd(6, ' ').slice(0, 6));
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      await this.deps.otp.put(key, { ...rec, attempts: rec.attempts + 1 }, Math.max(1, rec.expiresAt - Date.now()));
      return { kind: 'refuse', say: session.language === 'de' ? 'Der Code stimmt nicht. Bitte noch einmal.' : 'That code is not correct. Please try again.', reason: 'otp_wrong' };
    }
    await this.deps.otp.del(key);
    const token = this.mintOtpToken(session, phone);
    await this.deps.audit.write({ callSid: session.callSid, tenantId: session.tenantId, action: 'otp:verified', outcome: 'executed', at: new Date().toISOString() });
    return { kind: 'execute', name: 'verify_otp', arguments: { phone_e164: phone, otp_token: token } };
  }

  /** Token = HMAC(callSid|phone|exp). Bindet den Nachweis an Anruf und Nummer; 10 Minuten gültig. */
  private mintOtpToken(session: CallSession, phone: string): string {
    const exp = Date.now() + 10 * 60_000;
    const nonce = randomBytes(8).toString('hex');
    const payload = `${session.callSid}|${phone}|${exp}|${nonce}`;
    const mac = createHmac('sha256', this.deps.hmacSecret).update(payload).digest('hex').slice(0, 32);
    return Buffer.from(`${exp}.${nonce}.${mac}`).toString('base64url');
  }

  private checkOtpToken(session: CallSession, phone: string, token: string): boolean {
    try {
      const [exp, nonce, mac] = Buffer.from(token, 'base64url').toString().split('.');
      if (Number(exp) < Date.now()) return false;
      const expected = createHmac('sha256', this.deps.hmacSecret).update(`${session.callSid}|${phone}|${exp}|${nonce}`).digest('hex').slice(0, 32);
      return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
    } catch {
      return false;
    }
  }
}
