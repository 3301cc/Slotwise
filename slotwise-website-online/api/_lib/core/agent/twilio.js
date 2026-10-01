"use strict";
/*
 * Twilio ohne SDK: Webhook-Signatur, TwiML, SMS.
 *
 * Voice-Ablauf (rundenbasiert, damit er auf Vercel-Funktionen UND dem Standalone-Server läuft):
 *   Twilio → POST /api/agent/voice-webhook (CallSid, From, SpeechResult …)
 *   Antwort: TwiML mit <Say> (Text-to-Speech, Amazon-Polly-Stimme über Twilio) und
 *   <Gather input="speech dtmf"> (Speech-to-Text und Telefontastatur). Jede Nutzeräußerung ist ein neuer Webhook-Aufruf.
 *   Ein dauerhaft offener Media-Stream (WebSocket) ist damit nicht nötig.
 */
const crypto = require("node:crypto");

/** Signaturprüfung nach Twilio-Doku: Base64(HMAC-SHA1(authToken, url + sortierte(key+value))) */
function validSignature({ authToken, url, params, signature }) {
  if (!authToken || !signature) return false;
  const data = url + Object.keys(params || {}).sort().map((k) => k + params[k]).join("");
  const expected = crypto.createHmac("sha1", authToken).update(data).digest("base64");
  const a = Buffer.from(expected), b = Buffer.from(String(signature));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]);

/*
 * Tastatur (DTMF) im <Gather>:
 *   keypad "single" (Praxismodus): eine Taste genügt – "0" verbindet sofort mit dem Praxisteam.
 *   keypad "code"   (Unternehmensmodus): bis zu 6 Ziffern für den SMS-Code. Twilio schickt ab, sobald 6 Ziffern
 *                   getippt sind, nach "#" oder nach 5 Sekunden ohne weitere Taste. Nur eine einzelne "0"
 *                   (danach nichts mehr) bedeutet "zum Team"; ein Code wie "012345" geht als Code an den Agenten.
 */
const KEYPAD = {
  single: 'numDigits="1"',
  code: 'numDigits="6" finishOnKey="#" timeout="5"',
};

/** TwiML-Bausteine. voice: Polly-Stimmen, z. B. "Polly.Vicki-Neural" (de-DE), "Polly.Joanna-Neural" (en-US). */
function twiml({ say, gather, hangup, dial, language = "de-DE", voice = "Polly.Vicki-Neural", actionUrl, keypad = "single" }) {
  const parts = [];
  const sayXml = (t) => `<Say language="${language}" voice="${voice}">${esc(t)}</Say>`;
  if (gather) {
    parts.push(`<Gather input="speech dtmf" ${KEYPAD[keypad] || KEYPAD.single} language="${language}" speechTimeout="auto" actionOnEmptyResult="true" action="${esc(actionUrl)}" method="POST">`);
    if (say) parts.push(sayXml(say));
    parts.push("</Gather>");
    parts.push(sayXml(language.startsWith("de") ? "Ich habe Sie leider nicht verstanden. Auf Wiederhören." : "Sorry, I did not catch that. Goodbye."));
  } else if (say) {
    parts.push(sayXml(say));
  }
  if (dial) parts.push(`<Dial>${esc(dial)}</Dial>`);
  if (hangup) parts.push("<Hangup/>");
  return `<?xml version="1.0" encoding="UTF-8"?><Response>${parts.join("")}</Response>`;
}

/** Getippte Ziffern als Nutzeräußerung für den Agenten (z. B. der SMS-Code). Nur Ziffern, * und # werden übernommen. */
function keypadUtterance(digits) {
  const d = String(digits || "").replace(/[^0-9*#]/g, "").slice(0, 32);
  return d ? `Tastatureingabe: ${d}` : "";
}

/** SMS über die REST-API (Basic Auth). */
function smsSender({ accountSid, authToken, from }, fetchImpl = fetch) {
  return async function sendSms(to, body) {
    const res = await fetchImpl(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
      method: "POST",
      headers: { Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ To: to, From: from, Body: body }).toString(),
    });
    if (!res.ok) throw new Error(`twilio sms ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
  };
}

/** Lokal / Tests: SMS ins Log statt versenden. */
function consoleSms(log = console.log) {
  return async (to, body) => { log(`[sms → ${to}] ${body}`); };
}

module.exports = { validSignature, twiml, keypadUtterance, smsSender, consoleSms };
