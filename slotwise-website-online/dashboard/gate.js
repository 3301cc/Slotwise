/* CalenSync Dashboard – Zugang zur Demo-Vorschau.
   Vor dem ersten Öffnen: E-Mail eintragen (Warteliste, Double-Opt-in über /api/waitlist) oder Konto anlegen.
   Danach merkt sich der Browser den Zugang (localStorage). Mit Admin-Token (Live-Modus) entfällt die Abfrage.
   Hinweis: Das ist eine Lead-Abfrage, keine Zugriffssperre – die Vorschau enthält nur Beispieldaten. */
(function () {
  "use strict";
  const KEY = "calensync.demo.access";
  const env = window.SLOTWISE_ENV || {};
  const appLive = env.VITE_APP_LIVE === "1";
  const appUrl = (env.VITE_APP_URL || "").replace(/\/$/, "");
  const signupUrl = appLive && appUrl ? `${appUrl}/login?plan=trial` : "/anmelden";
  // Ist die Microsoft-365-Anbindung eingerichtet (enterprise.js), meldet „Anmelden“ direkt per Microsoft an
  const entra = Boolean(env.CALENSYNC_API && env.ENTRA_TENANT_ID && env.ENTRA_SPA_CLIENT_ID && env.CALENSYNC_API_SCOPE);
  const loginUrl = entra ? "/auth/callback?login=1" : appLive && appUrl ? `${appUrl}/login` : "/anmelden";
  const ERR = {
    invalid_email: "Das sieht nicht nach einer gültigen E-Mail-Adresse aus.",
    consent_required: "Bitte bestätige, dass wir dich per E-Mail informieren dürfen.",
    rate_limited: "Zu viele Versuche. Bitte warte kurz und probier es dann noch einmal.",
    network: "Keine Verbindung. Bitte prüf dein Internet und versuch es noch einmal.",
  };

  const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const set = (k, v) => { try { localStorage.setItem(k, v); } catch { /* privat/blockiert */ } };
  const unlocked = () => Boolean(get(KEY) || get("slotwise.adminToken"));

  const Gate = { get open() { return unlocked(); } };
  window.CalenSyncGate = Gate;
  if (unlocked()) return;

  const app = document.getElementById("app");
  if (app) { app.inert = true; app.setAttribute("aria-hidden", "true"); }
  document.documentElement.style.overflow = "hidden";

  const box = document.createElement("div");
  box.className = "fixed inset-0 z-[60] overflow-y-auto bg-slate-900/40 backdrop-blur-sm";
  box.innerHTML = `
    <div class="flex min-h-full items-center justify-center p-4">
      <div class="w-full max-w-md rounded-2xl border border-slate-200 bg-white shadow-ambient" role="dialog" aria-modal="true" aria-labelledby="gate-title" aria-describedby="gate-text">
        <div class="px-6 pb-2 pt-6 sm:px-8 sm:pt-8">
          <a href="/" class="inline-flex items-center gap-2" aria-label="CalenSync Startseite">
            <svg width="26" height="26" viewBox="0 0 64 64" aria-hidden="true"><path d="M30 17H40a7 7 0 0 1 7 7V34" fill="none" stroke="#4f46e5" stroke-width="4" stroke-linecap="round"/><path d="M34 47H24a7 7 0 0 1-7-7V30" fill="none" stroke="#a5b4fc" stroke-width="4" stroke-linecap="round"/><rect x="4" y="4" width="26" height="26" rx="8" fill="#a5b4fc"/><rect x="34" y="34" width="26" height="26" rx="8" fill="#4f46e5"/><rect x="10" y="14" width="14" height="6" rx="3" fill="#4f46e5"/><rect x="40" y="44" width="14" height="6" rx="3" fill="#fff"/></svg>
            <span class="font-display text-base font-bold tracking-tight text-slate-900">calensync</span>
          </a>
          <h1 id="gate-title" class="mt-5 font-display text-2xl font-extrabold tracking-tight text-slate-900">Dashboard-Vorschau ansehen</h1>
          <p id="gate-text" class="mt-2 text-sm leading-relaxed text-slate-600">Trag deine E-Mail ein und die Vorschau geht sofort auf. Du bekommst eine Mail zum Bestätigen und erfährst als Erstes, wenn CalenSync startet.</p>
        </div>
        <form id="gate-form" class="space-y-4 px-6 pt-4 sm:px-8" novalidate>
          <label class="block">
            <span class="mb-1.5 block text-sm font-medium text-slate-800">E-Mail</span>
            <input id="gate-email" name="email" type="email" required autocomplete="email" inputmode="email" class="field h-11" placeholder="name@firma.de" />
          </label>
          <label class="absolute -left-[9999px] h-px w-px overflow-hidden" aria-hidden="true">Firma<input name="company" tabindex="-1" autocomplete="off" /></label>
          <label class="flex cursor-pointer items-start gap-2.5 text-xs leading-relaxed text-slate-600">
            <input id="gate-consent" name="consent" type="checkbox" class="mt-0.5 h-4 w-4 flex-none rounded border-slate-300 accent-indigo-600" />
            <span>Ja, informiert mich per E-Mail, sobald CalenSync startet. Die Einwilligung kann ich jederzeit widerrufen. Details in der <a href="/datenschutz" class="font-medium text-slate-900 underline underline-offset-2">Datenschutzerklärung</a>.</span>
          </label>
          <p id="gate-error" class="hidden rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-medium text-red-800" role="alert"></p>
          <button type="submit" id="gate-submit" class="btn-primary h-11 w-full">Vorschau öffnen</button>
        </form>
        <div class="px-6 pb-6 pt-5 sm:px-8 sm:pb-8">
          <div class="flex items-center gap-3 text-xs text-slate-400" aria-hidden="true"><span class="h-px flex-1 bg-slate-200"></span>oder<span class="h-px flex-1 bg-slate-200"></span></div>
          <a href="${signupUrl}" class="btn-ghost mt-4 h-11 w-full">Konto anlegen</a>
          <p class="mt-4 flex flex-wrap justify-between gap-2 text-xs text-slate-500">
            <span>Schon ein Konto? <a href="${loginUrl}" class="font-medium text-indigo-700 hover:underline">Anmelden</a></span>
            <a href="/" class="hover:text-slate-900">Zurück zur Website</a>
          </p>
        </div>
      </div>
    </div>`;
  document.body.appendChild(box);

  const form = box.querySelector("#gate-form");
  const email = box.querySelector("#gate-email");
  const consent = box.querySelector("#gate-consent");
  const err = box.querySelector("#gate-error");
  const btn = box.querySelector("#gate-submit");
  setTimeout(() => email.focus(), 50);

  function showError(code) {
    err.textContent = ERR[code] || "Das hat nicht geklappt. Bitte versuch es noch einmal.";
    err.classList.remove("hidden");
    if (code === "invalid_email") email.focus();
  }

  function unlock(note) {
    set(KEY, JSON.stringify({ at: new Date().toISOString() }));
    box.remove();
    if (app) { app.inert = false; app.removeAttribute("aria-hidden"); }
    document.documentElement.style.overflow = "";
    if (note) {
      const t = document.createElement("div");
      t.setAttribute("role", "status");
      t.className = "fixed bottom-5 left-1/2 z-50 w-[min(420px,calc(100vw-32px))] -translate-x-1/2 rounded-xl bg-slate-900 px-4 py-3 text-sm text-white shadow-lg";
      t.textContent = note;
      document.body.appendChild(t);
      setTimeout(() => t.remove(), 6000);
    }
    window.dispatchEvent(new CustomEvent("calensync:unlocked"));
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.classList.add("hidden");
    const value = email.value.trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value)) return showError("invalid_email");
    if (!consent.checked) return showError("consent_required");
    btn.disabled = true; btn.textContent = "Einen Moment …";
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: value, consent: true, source: "dashboard", company: form.company.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) return unlock(`Fast geschafft: Wir haben dir einen Bestätigungslink an ${value} geschickt.`);
      if (res.status >= 500 || res.status === 404) {
        // Serverseitiges Problem (nicht eingerichtet, Konfiguration fehlt, Mailversand gestört): Vorschau trotzdem öffnen, Besucher nicht aussperren.
        console.warn("[gate] Warteliste nicht erreichbar:", res.status, data.error || "");
        return unlock();
      }
      showError(data.error);
    } catch {
      showError("network");
    }
    btn.disabled = false; btn.textContent = "Vorschau öffnen";
  });
})();
