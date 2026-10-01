"use strict";
/*
 * Amazon Bedrock – Converse API mit Tool-Use, ohne AWS-SDK (SigV4 von Hand, nur node:crypto + fetch).
 * Region eu-central-1 (Frankfurt) für EU-Verarbeitung.
 *
 * Schnittstelle (vom Orchestrator genutzt):
 *   model.converse({ system, messages, tools, maxTokens }) → { text, toolUses:[{id,name,input}], stopReason, raw }
 *   Nachrichten im Converse-Format: { role:"user"|"assistant", content:[ {text} | {toolUse:{toolUseId,name,input}} | {toolResult:{toolUseId,content:[{json}]}} ] }
 *
 * createModel(config) liefert je nach Konfiguration:
 *   - Bedrock (AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY gesetzt)
 *   - Fake-Modell (AGENT_MODEL=fake oder lokal ohne Schlüssel): deterministischer Dialog für Tests und lokale Demo
 */
const crypto = require("node:crypto");

// ---------- SigV4 ----------
const sha256 = (data) => crypto.createHash("sha256").update(data).digest("hex");
const hmac = (key, data) => crypto.createHmac("sha256", key).update(data).digest();

function signRequest({ method, url, headers, body, region, service, accessKeyId, secretAccessKey, sessionToken, now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const dateStamp = amzDate.slice(0, 8);
  const h = { ...headers, host: u.host, "x-amz-date": amzDate };
  if (sessionToken) h["x-amz-security-token"] = sessionToken;
  const signedNames = Object.keys(h).map((k) => k.toLowerCase()).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${String(h[Object.keys(h).find((x) => x.toLowerCase() === k)]).trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const payloadHash = sha256(body || "");
  const canonicalUri = u.pathname.split("/").map((p) => encodeURIComponent(encodeURIComponent(decodeURIComponent(p)))).join("/"); // Bedrock: modelId doppelt kodiert
  const canonicalRequest = [method, canonicalUri, u.searchParams.toString(), canonicalHeaders, signedHeaders, payloadHash].join("\n");
  const scope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonicalRequest)].join("\n");
  const kSigning = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, dateStamp), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", kSigning).update(stringToSign).digest("hex");
  h.Authorization = `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return h;
}

// ---------- Bedrock Converse ----------
function bedrockModel({ region, modelId, accessKeyId, secretAccessKey, sessionToken }, fetchImpl = fetch) {
  const endpoint = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodeURIComponent(modelId)}/converse`;
  return {
    kind: "bedrock",
    modelId,
    async converse({ system, messages, tools, maxTokens = 400, temperature = 0.2 }) {
      const body = JSON.stringify({
        system: [{ text: system }],
        messages,
        inferenceConfig: { maxTokens, temperature },
        ...(tools && tools.length ? { toolConfig: { tools } } : {}),
      });
      const headers = signRequest({
        method: "POST", url: endpoint, body, region, service: "bedrock", accessKeyId, secretAccessKey, sessionToken,
        headers: { "content-type": "application/json", accept: "application/json" },
      });
      const res = await fetchImpl(endpoint, { method: "POST", headers, body });
      const text = await res.text();
      if (!res.ok) throw new Error(`bedrock ${res.status}: ${text.slice(0, 300)}`);
      const json = JSON.parse(text);
      return normalize(json);
    },
  };
}

function normalize(json) {
  const content = (json.output && json.output.message && json.output.message.content) || [];
  return {
    text: content.filter((c) => c.text).map((c) => c.text).join(" ").trim(),
    toolUses: content.filter((c) => c.toolUse).map((c) => ({ id: c.toolUse.toolUseId, name: c.toolUse.name, input: c.toolUse.input || {} })),
    stopReason: json.stopReason,
    assistantMessage: json.output && json.output.message,
    usage: json.usage,
  };
}

// ---------- Fake-Modell (Tests, lokale Demo ohne AWS) ----------
/*
 * Führt den L0-Ablauf deterministisch: Zeitraum → find_availability → Kontaktdaten → send_otp → verify_otp → create_booking.
 * Liest den Gesprächsstand aus der Nachrichtenliste, braucht also keinen eigenen Zustand.
 */
function fakeModel() {
  const lastUser = (messages) => { for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === "user") return messages[i]; return null; };
  const textOf = (m) => (m && m.content.filter((c) => c.text).map((c) => c.text).join(" ")) || "";
  const toolResultOf = (m, name) => {
    if (!m) return null;
    const r = m.content.find((c) => c.toolResult);
    if (!r) return null;
    const json = r.toolResult.content && r.toolResult.content[0] && r.toolResult.content[0].json;
    return json && (!name || json.tool === name) ? json : null;
  };
  const seen = (messages, tool) => messages.some((m) => m.role === "assistant" && m.content.some((c) => c.toolUse && c.toolUse.name === tool));
  const tu = (name, input) => ({ id: `fake-${name}-${Date.now()}`, name, input });
  const out = (text, toolUses = []) => ({
    text, toolUses, stopReason: toolUses.length ? "tool_use" : "end_turn",
    assistantMessage: { role: "assistant", content: [...(text ? [{ text }] : []), ...toolUses.map((t) => ({ toolUse: { toolUseId: t.id, name: t.name, input: t.input } }))] },
  });

  return {
    kind: "fake",
    modelId: "fake",
    async converse({ messages, system, tools = [] }) {
      const last = lastUser(messages);
      const res = toolResultOf(last);
      const all = messages.filter((m) => m.role === "user").map(textOf).join(" \n ");
      const email = (all.match(/[\w.+-]+@[\w-]+\.[\w.]+/) || [])[0];
      const phone = (all.match(/\+?[0-9][0-9 ]{7,}/) || [""])[0].replace(/\s+/g, "").replace(/^0049/, "+49").replace(/^0/, "+49");
      const code = (textOf(last).match(/\b\d{6}\b/) || [])[0];
      const wantsHuman = /mensch|mitarbeiter|kolleg|human|person/i.test(textOf(last));
      if (wantsHuman) return out("Einen Moment, ich verbinde Sie.", [tu("handover_to_human", { reason: "requested" })]);

      if (res && res.tool === "find_availability") {
        const s = res.slots || [];
        if (!s.length) return out("An dem Tag ist leider nichts frei. Passt Ihnen der nächste Werktag?");
        const say = s.slice(0, 3).map((x) => x.label).join(", ");
        return out(`Frei wären: ${say}. Welcher passt? Und dann brauche ich Ihren Namen, Ihre E-Mail und Ihre Mobilnummer.`);
      }
      if (res && res.tool === "send_otp") return out("Ich habe Ihnen einen Code per SMS geschickt. Wie lautet er?");
      if (res && res.tool === "verify_otp" && res.otp_token) {
        const slot = (messages.flatMap((m) => m.content).find((c) => c.toolResult && c.toolResult.content[0].json.tool === "find_availability") || {}).toolResult;
        const first = slot && slot.content[0].json.slots[0];
        const name = (all.match(/(?:ich heiße|mein name ist|name:?)\s+([A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+)?)/i) || [])[1] || "Anrufer";
        return out("", [tu("create_booking", { start: first ? first.start : new Date().toISOString(), duration_minutes: 30, name, email: email || "unbekannt@example.com", phone_e164: phone, otp_token: res.otp_token })]);
      }
      if (res && res.tool === "verify_otp") return out("Der Code stimmt leider nicht. Bitte noch einmal.");
      if (res && res.tool === "create_booking") return out(res.say || "Ihr Termin ist eingetragen. Auf Wiederhören!");
      if (res && res.tool === "send_booking_link_sms") return out("Der Link ist unterwegs. Auf Wiederhören!");
      if (res && res.tool === "create_task") return out(res.say || "Ich habe Ihren Wunsch aufgenommen.");

      const patientStatus = /noch nie|neu(e|er)? patient|erstes mal|nicht in behandlung|war noch nicht/i.test(all) ? "new" : "existing";
      // Praxismodus, zweite Notfall-Stufe: simuliert ein Modell, das einen unklaren Notfall erkennt
      if (/Praxismodus/.test(system || "") && /fühlt sich (ganz )?komisch an|irgendwas stimmt nicht/i.test(textOf(last))) return out("", [tu("handover_to_human", { reason: "possible_emergency" })]);
      // Praxismodus: Buchung ohne OTP, sobald Slot, Name, Geburtsdatum und Nummer da sind
      const praxisBooking = tools.some((t) => t.toolSpec && t.toolSpec.name === "create_booking" && t.toolSpec.inputSchema.json.required.includes("date_of_birth"));
      if (praxisBooking && seen(messages, "find_availability") && !seen(messages, "create_booking") && phone) {
        const nm = (all.match(/(?:ich heiße|mein name ist|name:?)\s+([A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+)?)/i) || [])[1];
        const d = (all.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/) || []);
        const slotRes = (messages.flatMap((m) => m.content).find((c) => c.toolResult && c.toolResult.content[0].json.tool === "find_availability") || {}).toolResult;
        const first = slotRes && slotRes.content[0].json.slots[0];
        if (nm && d[3] && first) return out("", [tu("create_booking", { start: first.start, duration_minutes: 30, name: nm, date_of_birth: `${d[3]}-${d[2].padStart(2, "0")}-${d[1].padStart(2, "0")}`, phone_e164: phone, appointment_type: "Kontrolle", patient_status: patientStatus })]);
      }

      // Praxismodus: Rezept-/Überweisungs-/Rückruf-/Änderungswunsch → Aufgabe, sobald Name und Nummer genannt sind
      const canTask = tools.some((t) => t.toolSpec && t.toolSpec.name === "create_task");
      const taskType = /rezept/i.test(all) ? "prescription" : /überweisung|ueberweisung/i.test(all) ? "referral" : /termin.{0,40}(nicht einsehen|ändern)|bestehende termine/i.test(messages.filter((m) => m.role === "assistant").map(textOf).join(" ")) ? "change_request" : /rückruf|rueckruf/i.test(all) ? "callback" : null;
      if (canTask && taskType && phone && !seen(messages, "create_task")) {
        const name = (all.match(/(?:ich heiße|mein name ist|name:?)\s+([A-ZÄÖÜ][\wäöüß-]+(?:\s+[A-ZÄÖÜ][\wäöüß-]+)?)/i) || [])[1];
        const dob = (all.match(/\b(\d{1,2})\.(\d{1,2})\.(\d{4})\b/) || []);
        if (name) return out("", [tu("create_task", { type: taskType, name, phone_e164: phone, ...(dob[3] ? { date_of_birth: `${dob[3]}-${dob[2].padStart(2, "0")}-${dob[1].padStart(2, "0")}` } : {}), note: taskType === "prescription" ? "Folgerezept" : "", patient_status: patientStatus })]);
      }
      if (canTask && taskType && !seen(messages, "create_task")) return out("Gern. Wie ist Ihr Name, Ihr Geburtsdatum und Ihre Rückrufnummer?");

      if (code && phone && seen(messages, "send_otp")) return out("", [tu("verify_otp", { phone_e164: phone, code })]);
      if (email && phone && seen(messages, "find_availability") && !seen(messages, "send_otp")) return out("", [tu("send_otp", { phone_e164: phone })]);
      if (!seen(messages, "find_availability") && /termin|morgen|montag|dienstag|mittwoch|donnerstag|freitag|uhr|woche|frei/i.test(all)) {
        const from = new Date(); const to = new Date(from.getTime() + 7 * 86400000);
        return out("", [tu("find_availability", { from: from.toISOString(), to: to.toISOString(), duration_minutes: 30 })]);
      }
      return out(/de/.test(system) ? "Gern. Für wann hätten Sie den Termin gern?" : "Sure. When would you like the appointment?");
    },
  };
}

function createModel(config, fetchImpl) {
  if (config.agent.model === "fake") return fakeModel();
  if (config.agent.aws) return bedrockModel({ region: config.agent.aws.region, modelId: config.agent.modelId, ...config.agent.aws }, fetchImpl);
  if (!config.deployed) return fakeModel();
  return null; // im Deployment ohne Schlüssel: Agent nicht bereit
}

module.exports = { createModel, bedrockModel, fakeModel, signRequest, normalize };
