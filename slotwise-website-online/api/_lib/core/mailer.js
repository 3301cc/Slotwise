"use strict";
/*
 * Mailversand. Schnittstelle: send({ to, subject, text, html }) → Promise<void>.
 * Mailjet (Sitz Paris) per REST. Für einen anderen Anbieter (Brevo, eigener SMTP über nodemailer)
 * reicht eine weitere Funktion mit derselben Signatur.
 */
function mailjetMailer({ apiKey, apiSecret, from, fromName }, fetchImpl = fetch) {
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString("base64");
  return {
    kind: "mailjet",
    async send({ to, subject, text, html }) {
      const res = await fetchImpl("https://api.mailjet.com/v3.1/send", {
        method: "POST",
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
        body: JSON.stringify({ Messages: [{ From: { Email: from, Name: fromName }, To: [{ Email: to }], Subject: subject, TextPart: text, HTMLPart: html }] }),
      });
      if (!res.ok) throw new Error(`mailjet: ${res.status} ${await res.text().catch(() => "")}`);
    },
  };
}

/** Lokal: schreibt die Mail ins Log statt sie zu senden. */
function consoleMailer(log = console.log) {
  return {
    kind: "console",
    async send({ to, subject, text }) { log(`[mail → ${to}] ${subject}\n${text}`); },
  };
}

function createMailer(config) {
  return config.mail ? mailjetMailer(config.mail) : null;
}

module.exports = { createMailer, mailjetMailer, consoleMailer };
