/*
 * CalenSync Marketing-Website · Ergänzungen zum ausgelieferten Bundle (assets/site.js)
 *
 * Wird mit esbuild kompiliert und von scripts/apply-patches.py hinter die KI-Agent-Seite gesetzt.
 * Ersetzt im Bundle: ur (Demo-Widget), dr (/anmelden), nr (Layout), $h (Datenschutzerklärung).
 * Nutzt swH/swF und die Sw*-Aliase aus KiAgentPage.jsx.
 *
 * Bundle-Bezeichner: Ue Card · P Button · re Badge · ge Section · H classNames · Ve Link
 *   an useLocation · lr Header · ar Footer · gh Outlet · Y Texte · ht Firmendaten · _p Firmendaten fehlen
 *   ca/du/Ch/uc/Rh/qh Daten des Demo-Widgets · Icons: bh ‹ · rt › · Eh Video · Fi Globus · Ah Uhr · $i Schloss · Ot Haken
 */

const SwLegalPage = fc, SwCard = Ue, SwButton = P, SwLink = Ve, SwHeader = lr, SwFooter = ar, SwOutlet = gh;
const SwChevronLeft = bh, SwVideo = Eh, SwGlobe = Fi, SwClock = Ah, SwLock = $i, SwCheck = Ot;

const SW_APP_LIVE = U.VITE_APP_LIVE === "1";
const SW_TZ = "Europe/Berlin";

// Gleiche Regel wie api/_lib/waitlist.js
const SW_EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,}$/;
function swValidEmail(v) {
  const e = String(v || "").trim();
  if (e.length > 254) return false;
  const local = e.split("@")[0] || "";
  if (local.length > 64 || local.startsWith(".") || local.endsWith(".") || local.includes("..")) return false;
  return SW_EMAIL_RE.test(e);
}

const SW_INPUT =
  "block w-full rounded-lg border bg-white px-3 py-2.5 text-sm text-slate-900 placeholder:text-slate-400 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-600 focus:ring-offset-1";
const swInputState = (bad) => (bad ? "border-red-400" : "border-slate-200 hover:border-slate-300");

function SwField({ id, label, error, hint, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block text-sm font-medium text-slate-800">{label}</label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs font-medium text-red-700">{error}</p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">{hint}</p>
      ) : null}
    </div>
  );
}

// =====================================================================
// Warteliste
// =====================================================================
const SW_WL_EVENT = "slotwise:waitlist";
function swOpenWaitlist(detail) {
  window.dispatchEvent(new CustomEvent(SW_WL_EVENT, { detail: detail || {} }));
}
function swSourceFromPath(p) {
  const s = (p || "/").split("/")[1] || "start";
  return ["preise", "ki-agent", "anmelden", "praxen"].includes(s) ? s : "start";
}

const SW_WL_ERRORS = {
  invalid_email: "Bitte gib eine gültige E-Mail-Adresse ein.",
  consent_required: "Bitte bestätige, dass wir dich per E-Mail informieren dürfen.",
  rate_limited: "Zu viele Versuche. Bitte versuch es in ein paar Minuten noch einmal.",
  default: "Das hat nicht geklappt. Bitte prüf deine Verbindung und versuch es noch einmal.",
};

const SW_WL_RETURN = {
  bestaetigt: { tone: "ok", title: "Du stehst auf der Warteliste.", text: "Danke für die Bestätigung. Wir melden uns, sobald CalenSync startet." },
  abgemeldet: { tone: "ok", title: "Du bist ausgetragen.", text: "Deine E-Mail-Adresse wurde von der Warteliste gelöscht." },
  abgelaufen: { tone: "warn", title: "Der Bestätigungslink ist abgelaufen.", text: "Trag dich einfach noch einmal ein, dann schicken wir dir einen neuen Link." },
  ungueltig: { tone: "warn", title: "Der Link ist ungültig.", text: "Bitte trag dich noch einmal ein." },
  fehler: { tone: "warn", title: "Das hat nicht geklappt.", text: "Bitte versuch es später noch einmal." },
};

function SwWaitlistForm({ source, initialEmail = "", onDone, autoFocus = false }) {
  const [email, setEmail] = (0, cn.useState)(initialEmail);
  const [consent, setConsent] = (0, cn.useState)(false);
  const [trap, setTrap] = (0, cn.useState)("");
  const [touched, setTouched] = (0, cn.useState)(false);
  const [status, setStatus] = (0, cn.useState)("idle"); // idle | sending | pending | maintenance | error
  const [error, setError] = (0, cn.useState)(null);
  const [devLink, setDevLink] = (0, cn.useState)(null);
  const emailBad = touched && !swValidEmail(email);
  const consentBad = touched && !consent;

  async function submit(ev) {
    ev.preventDefault();
    setTouched(true);
    setError(null);
    if (!swValidEmail(email) || !consent) return;
    setStatus("sending");
    try {
      const res = await fetch("/api/waitlist", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: email.trim(), consent, source, company: trap }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 202) {
        setStatus("pending");
        setDevLink(data.devConfirmUrl || null);
        onDone && onDone();
        return;
      }
      if (res.status === 503 || data.error === "not_configured") {
        setStatus("maintenance");
        return;
      }
      setStatus("error");
      setError(SW_WL_ERRORS[data.error] || SW_WL_ERRORS.default);
    } catch {
      setStatus("error");
      setError(SW_WL_ERRORS.default);
    }
  }

  if (status === "maintenance") {
    return (
      <div role="status" aria-live="polite" className="rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
        <p className="flex items-center gap-2 font-semibold">
          <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-50">Entwurfsmodus</span>
          Die Warteliste ist noch nicht freigeschaltet.
        </p>
        <p className="mt-2 text-amber-900">
          Diese Seite läuft gerade im sicheren Wartungs- und Entwurfsmodus: Der Versand von Bestätigungsmails ist noch nicht
          eingerichtet, deshalb nimmt das System bewusst keine Adressen an. Deine Eingabe wurde <span className="font-semibold">nicht</span> gespeichert.
        </p>
        <p className="mt-2 text-amber-900">
          Die Registrierung wird in Kürze freigeschaltet. Bis dahin erreichst du uns über die Kontaktangaben im{" "}
          <SwLink to="/impressum" className="font-medium underline underline-offset-2">Impressum</SwLink>.
        </p>
        <button type="button" onClick={() => setStatus("idle")}
          className="mt-3 text-xs font-medium text-amber-950 underline underline-offset-2">Noch einmal versuchen</button>
      </div>
    );
  }

  if (status === "pending") {
    return (
      <div role="status" className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-900">
        <p className="font-semibold">{source === "praxen" ? "Fast geschafft. Bitte sehen Sie in Ihr Postfach." : "Fast geschafft. Bitte schau in dein Postfach."}</p>
        <p className="mt-1 text-indigo-800">
          {source === "praxen"
            ? <>Wir haben Ihnen einen Bestätigungslink an <span className="font-medium">{email.trim()}</span> geschickt. Nach dem Klick ist Ihre Bewerbung bei uns. Der Link gilt 72 Stunden.</>
            : <>Wir haben dir einen Bestätigungslink an <span className="font-medium">{email.trim()}</span> geschickt. Erst nach dem Klick stehst du auf der Warteliste. Der Link gilt 72 Stunden.</>}
        </p>
        {devLink && (
          <p className="mt-3 break-all text-xs text-indigo-800">
            Lokaler Test ohne Mailversand: <a className="font-semibold underline" href={devLink}>Bestätigungslink öffnen</a>
          </p>
        )}
      </div>
    );
  }

  return (
    <form noValidate onSubmit={submit} className="space-y-4">
      <SwField id="wl-email" label="E-Mail-Adresse" error={emailBad ? SW_WL_ERRORS.invalid_email : null}>
        <input id="wl-email" type="email" inputMode="email" autoComplete="email" required autoFocus={autoFocus}
          value={email} onChange={(e) => setEmail(e.target.value)} placeholder="name@firma.de"
          aria-invalid={emailBad} aria-describedby={emailBad ? "wl-email-error" : undefined}
          className={`${SW_INPUT} ${swInputState(emailBad)}`} />
      </SwField>
      {/* Honigtopf für Bots – für Menschen unsichtbar */}
      <div aria-hidden="true" className="sw-hp">
        <label htmlFor="wl-company">Firma</label>
        <input id="wl-company" tabIndex={-1} autoComplete="off" value={trap} onChange={(e) => setTrap(e.target.value)} />
      </div>
      <div>
        <label className="flex items-start gap-2.5 text-sm leading-relaxed text-slate-600">
          <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)}
            aria-invalid={consentBad} aria-describedby={consentBad ? "wl-consent-error" : undefined}
            className="mt-1 h-4 w-4 flex-none rounded border-slate-300 accent-indigo-700" />
          <span>
            Ja, informiert mich per E-Mail, sobald CalenSync startet. Die Einwilligung kann ich jederzeit widerrufen.
            Details in der <SwLink to="/datenschutz" className="font-medium text-slate-900 underline underline-offset-2">Datenschutzerklärung</SwLink>.
          </span>
        </label>
        {consentBad && <p id="wl-consent-error" className="mt-1.5 text-xs font-medium text-red-700">{SW_WL_ERRORS.consent_required}</p>}
      </div>
      {error && <p role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">{error}</p>}
      <SwButton type="submit" variant="success" size="lg" className="w-full" disabled={status === "sending"}>
        {status === "sending" ? "Wird eingetragen …" : "Eintragen"}
      </SwButton>
    </form>
  );
}

function SwWaitlistDialog() {
  const ref = (0, cn.useRef)(null);
  const loc = an();
  const [open, setOpen] = (0, cn.useState)(false);
  const [ctx, setCtx] = (0, cn.useState)({ source: "start", email: "", demo: false });
  const [notice, setNotice] = (0, cn.useState)(null);
  const [round, setRound] = (0, cn.useState)(0);

  const show = (0, cn.useCallback)((detail) => {
    setCtx({
      source: detail.source || swSourceFromPath(window.location.pathname),
      email: detail.email || "",
      demo: Boolean(detail.demo),
    });
    setRound((r) => r + 1);
    setOpen(true);
  }, []);

  // Öffnen über #warteliste / #warteliste-demo (alle App-Links) oder per Event
  (0, cn.useEffect)(() => {
    function fromHash() {
      const h = window.location.hash;
      if (h === "#warteliste" || h === "#warteliste-demo") {
        show({ demo: h === "#warteliste-demo", source: h === "#warteliste-demo" ? "demo" : undefined });
        history.replaceState(null, "", window.location.pathname + window.location.search);
      }
    }
    const onEvent = (e) => show(e.detail || {});
    fromHash();
    window.addEventListener("hashchange", fromHash);
    window.addEventListener(SW_WL_EVENT, onEvent);
    return () => { window.removeEventListener("hashchange", fromHash); window.removeEventListener(SW_WL_EVENT, onEvent); };
  }, [show]);

  // Rückkehr aus dem Bestätigungslink: ?warteliste=bestaetigt usw.
  (0, cn.useEffect)(() => {
    const params = new URLSearchParams(loc.search);
    const key = params.get("warteliste");
    if (key && SW_WL_RETURN[key]) {
      setNotice(SW_WL_RETURN[key]);
      params.delete("warteliste");
      const q = params.toString();
      history.replaceState(null, "", loc.pathname + (q ? `?${q}` : ""));
    }
  }, [loc.search, loc.pathname]);

  (0, cn.useEffect)(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      d.querySelector("#wl-email")?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <>
      <dialog ref={ref} onClose={() => setOpen(false)} aria-labelledby="wl-title"
        onClick={(e) => { if (e.target === ref.current) setOpen(false); }}
        className="sw-dialog w-[calc(100%-2rem)] max-w-md rounded-2xl border border-slate-100 bg-white p-0 text-slate-900 shadow-ambient">
        {open && (
          <div className="p-6 sm:p-7">
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-indigo-700">{ctx.source === "praxen" ? "Pilotprogramm für Praxen" : "Early Access"}</p>
                <h2 id="wl-title" className="mt-1 font-display text-xl font-bold text-slate-900">
                  {ctx.source === "praxen" ? "Als Pilotpraxis bewerben" : ctx.demo ? "Echte Demo: Warteliste" : "CalenSync startet bald"}
                </h2>
              </div>
              <button type="button" onClick={() => setOpen(false)} aria-label="Schließen"
                className="grid h-9 w-9 flex-none place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" /></svg>
              </button>
            </div>
            <p className="mt-2 text-sm leading-relaxed text-slate-600">
              {ctx.source === "praxen"
                ? "Tragen Sie die E-Mail-Adresse Ihrer Praxis ein. Wir melden uns innerhalb von zwei Werktagen und vereinbaren ein kurzes Kennenlernen. Es gibt 10 Plätze, die ersten 3 Monate sind kostenlos."
                : ctx.demo
                ? "Die Live-Buchungsseite und Demo-Termine öffnen mit dem Start. Trag dich ein, dann bekommst du als Erste:r einen Termin."
                : "Die App ist noch nicht freigeschaltet. Trag dich ein, und wir schreiben dir, sobald du dein Konto anlegen kannst."}
            </p>
            <div className="mt-5">
              <SwWaitlistForm key={round} source={ctx.source} initialEmail={ctx.email} />
            </div>
          </div>
        )}
      </dialog>

      {notice && (
        <div role="status" aria-live="polite" className="fixed inset-x-4 bottom-4 z-[70] mx-auto max-w-md">
          <div className={`flex items-start gap-3 rounded-xl border bg-white p-4 shadow-ambient ${notice.tone === "ok" ? "border-indigo-200" : "border-amber-200"}`}>
            <span className={`mt-0.5 h-2.5 w-2.5 flex-none rounded-full ${notice.tone === "ok" ? "bg-indigo-600" : "bg-amber-500"}`} aria-hidden="true" />
            <div className="min-w-0 flex-1 text-sm">
              <p className="font-semibold text-slate-900">{notice.title}</p>
              <p className="mt-0.5 text-slate-600">{notice.text}</p>
            </div>
            <button type="button" onClick={() => setNotice(null)} className="text-sm font-medium text-slate-500 hover:text-slate-900">OK</button>
          </div>
        </div>
      )}
    </>
  );
}

// =====================================================================
// Layout mit Entwurfs-Hinweis
// =====================================================================
function SwDraftBanner() {
  (0, cn.useEffect)(() => {
    // Solange Pflichtangaben fehlen, nicht indexieren lassen.
    let m = document.querySelector('meta[name="robots"]');
    if (!m) { m = document.createElement("meta"); m.name = "robots"; document.head.appendChild(m); }
    m.content = "noindex, nofollow";
  }, []);
  return (
    <div role="note" className="border-b border-amber-300 bg-amber-100 text-amber-950">
      <div className="mx-auto flex max-w-[1200px] flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2 text-[13px] sm:px-6">
        <span className="rounded bg-amber-950 px-1.5 py-0.5 text-[11px] font-bold uppercase tracking-wider text-amber-50">Entwurf</span>
        <span>Vorschauversion vor dem Start: Anbieterangaben in Impressum und Datenschutzerklärung werden vor dem Livegang ergänzt.</span>
        <SwLink to="/impressum" className="font-semibold underline underline-offset-2">Impressum</SwLink>
      </div>
    </div>
  );
}

function nr() {
  return (
    <div className="flex min-h-screen flex-col bg-slate-50 text-slate-900">
      <a href="#main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[60] focus:rounded-lg focus:bg-white focus:px-3 focus:py-2 focus:text-sm focus:shadow-card-hover">Zum Inhalt springen</a>
      {_p && <SwDraftBanner />}
      <SwHeader />
      <main id="main" className="flex flex-1 flex-col"><SwOutlet /></main>
      <SwFooter />
      <SwWaitlistDialog />
    </div>
  );
}

// =====================================================================
// /anmelden
// =====================================================================
function SwProviderIcon({ kind }) {
  return kind === "google" ? (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#4285F4" d="M22.6 12.3c0-.8-.1-1.5-.2-2.3H12v4.3h5.9a5 5 0 0 1-2.2 3.3v2.8h3.6c2.1-1.9 3.3-4.8 3.3-8.1z" />
      <path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.8c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.9A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.8 14.1a6.6 6.6 0 0 1 0-4.2V7H2.1a11 11 0 0 0 0 10l3.7-2.9z" />
      <path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7l3.7 2.9C6.7 7.3 9.1 5.4 12 5.4z" />
    </svg>
  ) : (
    <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
      <path fill="#F25022" d="M2 2h9.5v9.5H2z" /><path fill="#7FBA00" d="M12.5 2H22v9.5h-9.5z" />
      <path fill="#00A4EF" d="M2 12.5h9.5V22H2z" /><path fill="#FFB900" d="M12.5 12.5H22V22h-9.5z" />
    </svg>
  );
}

function dr() {
  const { search } = an();
  const [email, setEmail] = (0, cn.useState)("");
  const [password, setPassword] = (0, cn.useState)("");
  const [touched, setTouched] = (0, cn.useState)(false);
  const [notice, setNotice] = (0, cn.useState)(null);
  const emailBad = touched && !swValidEmail(email);
  const pwBad = touched && password.length < 8;

  const appLogin = (provider) => ou(`/login${search ? `${search}&` : "?"}provider=${provider}`);

  function preLaunch(via) {
    setNotice(via);
  }

  function submit(ev) {
    ev.preventDefault();
    setTouched(true);
    if (!swValidEmail(email) || password.length < 8) return;
    if (SW_APP_LIVE) { window.location.assign(appLogin("email")); return; }
    preLaunch("email");
  }

  return (
    <SwSection spacing="loose">
      <SwCard padding="lg" className="mx-auto w-full max-w-md">
        <p className="text-sm text-slate-500">CalenSync App</p>
        <h1 className="mt-1 font-display text-2xl font-bold text-slate-900">Anmelden</h1>

        <div className="mt-6 grid gap-2.5">
          {[["google", "Mit Google anmelden"], ["microsoft", "Mit Microsoft anmelden"]].map(([k, label]) =>
            SW_APP_LIVE ? (
              <SwButton key={k} as="a" href={appLogin(k)} variant="secondary" size="lg" className="w-full"><SwProviderIcon kind={k} />{label}</SwButton>
            ) : (
              <SwButton key={k} variant="secondary" size="lg" className="w-full" onClick={() => preLaunch(k)}><SwProviderIcon kind={k} />{label}</SwButton>
            ),
          )}
        </div>

        <div className="my-6 flex items-center gap-3 text-xs text-slate-400">
          <span className="h-px flex-1 bg-slate-200" />oder mit E-Mail<span className="h-px flex-1 bg-slate-200" />
        </div>

        <form noValidate onSubmit={submit} className="space-y-4">
          <SwField id="login-email" label="E-Mail-Adresse" error={emailBad ? "Bitte gib eine gültige E-Mail-Adresse ein." : null}>
            <input id="login-email" type="email" autoComplete="username" inputMode="email" value={email}
              onChange={(e) => setEmail(e.target.value)} aria-invalid={emailBad}
              aria-describedby={emailBad ? "login-email-error" : undefined}
              className={`${SW_INPUT} ${swInputState(emailBad)}`} />
          </SwField>
          <SwField id="login-password" label="Passwort" error={pwBad ? "Das Passwort hat mindestens 8 Zeichen." : null}>
            <input id="login-password" type="password" autoComplete="current-password" value={password}
              onChange={(e) => setPassword(e.target.value)} aria-invalid={pwBad}
              aria-describedby={pwBad ? "login-password-error" : undefined}
              className={`${SW_INPUT} ${swInputState(pwBad)}`} />
          </SwField>
          <SwButton type="submit" size="lg" className="w-full">Anmelden</SwButton>
        </form>

        {notice && (
          <div role="status" className="mt-5 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
            <p className="font-semibold">Die CalenSync-App ist noch nicht freigeschaltet.</p>
            <p className="mt-1 text-amber-900">
              Konten werden zum Start eröffnet{notice === "email" ? "" : `, dann auch mit ${notice === "google" ? "Google" : "Microsoft"}`}.
              Trag dich in die Warteliste ein, und wir melden uns, sobald du loslegen kannst.
            </p>
            <SwButton variant="success" size="md" className="mt-3 w-full"
              onClick={() => swOpenWaitlist({ source: "login", email: swValidEmail(email) ? email.trim() : "" })}>
              Auf die Warteliste
            </SwButton>
          </div>
        )}

        <p className="mt-6 text-center text-sm text-slate-500">
          Noch kein Konto?{" "}
          <a href={ot} className="font-medium text-slate-900 underline-offset-2 hover:underline">Kostenlos starten</a>
        </p>
      </SwCard>
    </SwSection>
  );
}

// =====================================================================
// Demo-Buchungswidget
// =====================================================================
const SW_MONTHS = ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"];

function swBerlinNow() {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: SW_TZ, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(new Date()).map((p) => [p.type, Number(p.value)]),
  );
  return { y: parts.year, m: parts.month - 1, d: parts.day, min: parts.hour * 60 + parts.minute };
}
const swKey = (y, m, d) => y * 10000 + m * 100 + d;
const swDaysIn = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
const swWeekday = (y, m, d) => (new Date(Date.UTC(y, m, d)).getUTCDay() + 6) % 7; // Mo = 0
const swMinutes = (hhmm) => { const [h, mm] = hhmm.split(":").map(Number); return h * 60 + mm; };
// Beispielbelegung, stabil pro Datum
const swBusy = (y, m, d, i) => (d * 7 + m * 3 + i * 5) % 11 === 0 || (d + i) % 9 === 0;

function swSlotState(y, m, d, i, now) {
  if (swBusy(y, m, d, i)) return "busy";
  if (swKey(y, m, d) === swKey(now.y, now.m, now.d) && swMinutes(du[i]) < now.min + 60) return "past";
  return "free";
}
function swDayOpen(y, m, d, now) {
  if (swWeekday(y, m, d) >= 5) return false;
  const k = swKey(y, m, d), today = swKey(now.y, now.m, now.d);
  if (k < today) return false;
  return du.some((_, i) => swSlotState(y, m, d, i, now) === "free");
}
function swFirstOpenDay(now) {
  let y = now.y, m = now.m;
  for (let step = 0; step < 3; step++) {
    for (let d = 1; d <= swDaysIn(y, m); d++) if (swDayOpen(y, m, d, now)) return { y, m, d };
    m += 1; if (m > 11) { m = 0; y += 1; }
  }
  return { y: now.y, m: now.m, d: now.d };
}

function ur({ className }) {
  const now = (0, cn.useMemo)(swBerlinNow, []);
  const first = (0, cn.useMemo)(() => swFirstOpenDay(now), [now]);
  const [view, setView] = (0, cn.useState)({ y: first.y, m: first.m });
  const [day, setDay] = (0, cn.useState)(first);
  const [duration, setDuration] = (0, cn.useState)(30);
  const [slot, setSlot] = (0, cn.useState)(null);
  const [step, setStep] = (0, cn.useState)("pick"); // pick | details | done
  const [name, setName] = (0, cn.useState)("");
  const [email, setEmail] = (0, cn.useState)("");
  const [touched, setTouched] = (0, cn.useState)(false);
  const nameRef = (0, cn.useRef)(null);
  const viewerTz = (0, cn.useMemo)(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return SW_TZ; } }, []);

  const monthOffset = (view.y - now.y) * 12 + (view.m - now.m);
  const canPrev = monthOffset > 0, canNext = monthOffset < 2;
  const days = swDaysIn(view.y, view.m);
  const lead = swWeekday(view.y, view.m, 1);
  const dayLabel = uc[swWeekday(day.y, day.m, day.d)];

  function shiftMonth(delta) {
    let m = view.m + delta, y = view.y;
    if (m < 0) { m = 11; y -= 1; } if (m > 11) { m = 0; y += 1; }
    setView({ y, m });
  }
  function pickDay(d) {
    setDay({ y: view.y, m: view.m, d });
    setSlot(null); // neuer Tag → Slot zwingend neu wählen
    setStep("pick");
    setTouched(false);
  }
  function pickSlot(i) {
    setSlot(i);
    setStep("details");
    setTouched(false);
    requestAnimationFrame(() => nameRef.current?.focus({ preventScroll: true }));
  }
  function reset() {
    setSlot(null); setStep("pick"); setName(""); setEmail(""); setTouched(false);
  }

  const nameBad = touched && name.trim().length < 2;
  const emailBad = touched && !swValidEmail(email);
  function book(ev) {
    ev.preventDefault();
    setTouched(true);
    if (name.trim().length < 2 || !swValidEmail(email)) return;
    setStep("done");
  }

  const start = slot !== null ? du[slot] : null;
  const end = start ? qh(start, duration) : null;
  const dateText = `${dayLabel} ${day.d}. ${SW_MONTHS[day.m]} ${day.y}`;

  return (
    <SwCard elevated className={H("overflow-hidden", className)} aria-label="Buchungsseite (Demo)">
      <div className="flex items-start justify-between gap-4 border-b border-slate-100 px-5 py-4 sm:px-6">
        <div className="flex min-w-0 items-center gap-3">
          <span className="grid h-10 w-10 flex-none place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">{ca.initials}</span>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-sm text-slate-500">{ca.name} · {ca.company}</p>
            <p className="truncate font-display text-base font-bold text-slate-900">{ca.eventTitle}</p>
          </div>
        </div>
        <SwBadge tone="neutral">Demo</SwBadge>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[1.4fr_1fr]">
        {/* Kalender */}
        <div className="min-w-0 border-b border-slate-100 p-5 sm:p-6 md:border-b-0 md:border-r">
          <div className="mb-4 flex items-center justify-between">
            <p className="text-sm font-semibold text-slate-900" aria-live="polite">
              {SW_MONTHS[view.m]} <span className="font-normal text-slate-500">{view.y}</span>
            </p>
            <div className="flex gap-1">
              <button type="button" aria-label="Vorheriger Monat" disabled={!canPrev} onClick={() => shiftMonth(-1)}
                className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
                <SwChevronLeft size={14} />
              </button>
              <button type="button" aria-label="Nächster Monat" disabled={!canNext} onClick={() => shiftMonth(1)}
                className="grid h-8 w-8 place-items-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900 disabled:cursor-not-allowed disabled:opacity-30 disabled:hover:bg-transparent">
                <SwArrow size={14} />
              </button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1.5 text-center text-[11px] font-medium uppercase tracking-wide text-slate-400" aria-hidden="true">
            {Rh.map((w) => <span key={w}>{w}</span>)}
          </div>
          <div className="mt-2 grid grid-cols-7 gap-1.5" role="grid" aria-label={`${SW_MONTHS[view.m]} ${view.y}`}>
            {Array.from({ length: lead }, (_, i) => <span key={`pad-${i}`} aria-hidden="true" />)}
            {Array.from({ length: days }, (_, i) => i + 1).map((d) => {
              const open = swDayOpen(view.y, view.m, d, now);
              const selected = day.y === view.y && day.m === view.m && day.d === d;
              const isToday = swKey(view.y, view.m, d) === swKey(now.y, now.m, now.d);
              return (
                <button key={`${view.y}-${view.m}-${d}`} type="button" role="gridcell" disabled={!open}
                  aria-selected={selected} aria-current={isToday ? "date" : undefined}
                  aria-label={`${uc[swWeekday(view.y, view.m, d)]} ${d}. ${SW_MONTHS[view.m]}${open ? "" : ", nicht verfügbar"}`}
                  onClick={() => pickDay(d)}
                  className={H(
                    "sw-press tabular aspect-square rounded-lg text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1",
                    selected && "bg-indigo-700 font-bold text-white shadow-sm",
                    !selected && !open && "cursor-not-allowed font-medium text-slate-300",
                    !selected && open && "bg-slate-50 font-medium text-slate-900 hover:bg-indigo-50 hover:text-indigo-800",
                    isToday && !selected && "ring-1 ring-inset ring-slate-300",
                  )}>
                  {d}
                </button>
              );
            })}
          </div>
          <div className="mt-5 flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-slate-500">
            <span className="flex items-center gap-1.5"><SwVideo size={14} /> {ca.location}</span>
            <span className="flex items-center gap-1.5"><SwGlobe size={14} /> Zeiten in {SW_TZ}</span>
          </div>
          {viewerTz && viewerTz !== SW_TZ && (
            <p className="mt-2 text-xs text-amber-800">Hinweis: Deine Zeitzone ist {viewerTz}. Alle Uhrzeiten gelten für {SW_TZ}.</p>
          )}
        </div>

        {/* Slots, Formular, Bestätigung */}
        <div className="min-w-0 p-5 sm:p-6">
          <div className="mb-3 flex items-center justify-between gap-3">
            <p className="text-sm font-semibold text-slate-900">
              <span className="text-slate-500">{dayLabel}</span> {String(day.d).padStart(2, "0")}.{String(day.m + 1).padStart(2, "0")}.
            </p>
            <div className="flex items-center gap-1 text-slate-500">
              <SwClock size={14} />
              <div className="flex gap-0.5 rounded-md bg-slate-100 p-0.5" role="group" aria-label="Terminlänge in Minuten">
                {Ch.map((m) => (
                  <button key={m} type="button" aria-pressed={duration === m} disabled={step === "done"}
                    onClick={() => setDuration(m)}
                    className={H("tabular rounded px-2 py-0.5 text-[11px] font-medium",
                      duration === m ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:bg-white/70 hover:text-slate-900")}>
                    {m}
                  </button>
                ))}
              </div>
            </div>
          </div>

          {step !== "done" && (
            <ul className="grid grid-cols-2 gap-2 md:grid-cols-1">
              {du.map((t, i) => {
                const st = swSlotState(day.y, day.m, day.d, i, now);
                const active = slot === i;
                return (
                  <li key={`${day.y}-${day.m}-${day.d}-${t}`}>
                    <button type="button" disabled={st !== "free"} aria-pressed={active} onClick={() => pickSlot(i)}
                      className={H(
                        "sw-press group tabular flex w-full items-center justify-between rounded-lg border px-3 py-2 text-[13px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-1",
                        st !== "free" && "cursor-not-allowed border-dashed border-slate-200 text-slate-400",
                        st === "busy" && "line-through",
                        st === "free" && !active && "border-slate-200 bg-white text-slate-900 hover:border-indigo-300 hover:bg-indigo-50",
                        active && "border-indigo-700 bg-indigo-700 text-white shadow-sm",
                      )}>
                      <span>{t}</span>
                      <span className={H("text-[11px]", active ? "text-indigo-50" : st === "free" ? "text-slate-500" : "no-underline")}>
                        {st === "busy" ? "belegt" : st === "past" ? "vorbei" : qh(t, duration)}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}

          {step === "pick" && (
            <p className="mt-4 text-xs text-slate-500">Wähle eine Uhrzeit, dann fragen wir Name und E-Mail ab.</p>
          )}

          {step === "details" && start && (
            <form noValidate onSubmit={book} className="mt-4 space-y-3 border-t border-slate-100 pt-4" aria-label="Vorschau der Buchung mit Testdaten" aria-describedby="demo-preview-note">
              <p className="text-xs text-slate-600">
                <span className="font-semibold text-slate-900">{dateText}</span>, {start}–{end} Uhr
              </p>
              <div id="demo-preview-note" role="note"
                className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs leading-relaxed text-amber-950">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" className="mt-0.5 flex-none">
                  <circle cx="12" cy="12" r="9" /><path d="M12 8h.01M11 12h1v4h1" />
                </svg>
                <span>
                  <span className="font-semibold">Interaktive Vorschau.</span> Bitte gib nur Testdaten ein. Es findet keine Speicherung oder Verarbeitung statt.
                </span>
              </div>
              <SwField id="demo-name" label="Name (Testdaten)" error={nameBad ? "Bitte gib einen Namen ein, z. B. „Test Person“." : null}>
                <input ref={nameRef} id="demo-name" autoComplete="off" placeholder="z. B. Test Person" value={name}
                  onChange={(e) => setName(e.target.value)} aria-invalid={nameBad} required
                  aria-describedby={nameBad ? "demo-name-error demo-preview-note" : "demo-preview-note"}
                  className={`${SW_INPUT} ${swInputState(nameBad)}`} />
              </SwField>
              <SwField id="demo-email" label="E-Mail (Testdaten)" error={emailBad ? "Bitte gib eine gültige Adresse ein, z. B. test@firma.de." : null}>
                <input id="demo-email" type="email" inputMode="email" autoComplete="off" placeholder="z. B. test@firma.de" value={email}
                  onChange={(e) => setEmail(e.target.value)} aria-invalid={emailBad} required
                  aria-describedby={emailBad ? "demo-email-error demo-preview-note" : "demo-preview-note"}
                  className={`${SW_INPUT} ${swInputState(emailBad)}`} />
              </SwField>
              <button type="submit"
                className="sw-press flex w-full flex-col items-center justify-center gap-0.5 rounded-lg bg-indigo-700 px-4 py-2.5 text-center text-sm font-semibold leading-snug text-white shadow-sm hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2">
                <span>Termin verbindlich buchen (Vorschau)</span>
                <span className="tabular text-xs font-medium text-indigo-50">{start}–{end} Uhr</span>
              </button>
              <button type="button" onClick={() => { setSlot(null); setStep("pick"); }}
                className="w-full text-center text-xs font-medium text-slate-500 hover:text-slate-900">
                Andere Uhrzeit wählen
              </button>
            </form>
          )}

          {step === "done" && start && (
            <div role="status" className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-sm text-indigo-950">
              <p className="flex items-center gap-2 font-semibold"><SwCheck size={16} className="text-indigo-700" />Termin gebucht</p>
              <p className="tabular mt-1.5 text-indigo-900">{dateText}<br />{start}–{end} Uhr · {ca.location}</p>
              <p className="mt-1.5 text-indigo-900">für {name.trim()} ({email.trim()})</p>
              <p className="mt-3 border-t border-indigo-200 pt-3 text-xs text-indigo-900">
                So sieht die Bestätigung in CalenSync aus. In dieser Demo wird keine E-Mail verschickt und nichts gespeichert.
              </p>
              <div className="mt-3 flex flex-col gap-2">
                <a href={_t} className="rounded-lg bg-indigo-700 px-3 py-2 text-center text-sm font-semibold text-white hover:bg-indigo-800">
                  {SW_APP_LIVE ? "Echten Demo-Termin buchen" : "Für den Start vormerken"}
                </a>
                <button type="button" onClick={reset} className="text-xs font-medium text-indigo-900 underline underline-offset-2">Neue Demo-Buchung</button>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-slate-100 bg-slate-50/80 px-5 py-3 text-xs text-slate-500 sm:px-6">
        <span className="flex items-center gap-2"><SwLock size={13} className="text-indigo-700" />Plattform in Deutschland betrieben · Rechenzentrum Frankfurt am Main</span>
        <a href={_t} className="font-medium text-slate-700 underline-offset-2 hover:underline">{SW_APP_LIVE ? "Live-Buchungsseite" : "Warteliste"}</a>
      </div>
    </SwCard>
  );
}

// =====================================================================
// Datenschutzerklärung
// =====================================================================
function SwPrivacySection({ title, children }) {
  return (<section><Ie>{title}</Ie><div className="mt-2 space-y-2">{children}</div></section>);
}

function $h() {
  const e = Y.privacy;
  return (
    <SwLegalPage eyebrow={e.eyebrow} title="Datenschutzerklärung" intro={e.intro} draft>
      <section>
        <Ie>Verantwortlicher</Ie>
        <div className="mt-2"><Wh /></div>
        {ht.dpo && <p className="mt-2">Datenschutzbeauftragte/r: {ht.dpo}</p>}
      </section>

      <SwPrivacySection title="Hosting dieser Website (Vercel)">
        <p>
          Diese Website und ihre Formular-Schnittstellen werden bei der Vercel Inc., 440 N Barranca Ave #4133, Covina, CA 91723, USA
          bereitgestellt. Ausgeliefert und ausgeführt wird sie über die Vercel-Region Frankfurt am Main (fra1); Vercel betreibt dafür ein
          weltweites Content-Delivery-Netz.
        </p>
        <p>
          Beim Aufruf verarbeitet Vercel technisch notwendige Verbindungsdaten: IP-Adresse, Datum und Uhrzeit, aufgerufene Adresse,
          übertragene Datenmenge, Referrer sowie Browser- und Betriebssystemangaben. Zweck ist die sichere und stabile Auslieferung der
          Seite, einschließlich der Abwehr von Angriffen. Rechtsgrundlage ist Art. 6 Abs. 1 lit. f DSGVO; unser berechtigtes Interesse
          liegt in einem zuverlässigen und sicheren Webauftritt. Die Daten werden nach den Aufbewahrungsfristen von Vercel gelöscht und
          nicht mit anderen Daten zusammengeführt.
        </p>
        <p>
          Weil Vercel ein US-Unternehmen ist, kann ein Zugriff aus den USA nicht ausgeschlossen werden. Vercel ist unter dem
          EU-U.S. Data Privacy Framework zertifiziert; die Übermittlung stützt sich damit auf den Angemessenheitsbeschluss der
          EU-Kommission (Art. 45 DSGVO). Mit Vercel besteht ein Vertrag zur Auftragsverarbeitung nach Art. 28 DSGVO, ergänzend gelten
          die EU-Standardvertragsklauseln.
        </p>
        <p>
          Die Aussage oben, dass CalenSync keine personenbezogenen Daten in Drittländer übermittelt, bezieht sich auf die
          CalenSync-Plattform mit den Buchungsdaten. Für diese Website gilt dieser Abschnitt.
        </p>
        <p>
          Cookies, Tracking- oder Analysedienste setzen wir auf dieser Website nicht ein. Schriften werden von unserem eigenen Server geladen.
          Was das Dashboard im Speicher deines Browsers ablegt, steht in den Abschnitten zur Dashboard-Vorschau und zur Anmeldung mit Microsoft.
        </p>
      </SwPrivacySection>

      <SwPrivacySection title="Warteliste">
        <p>
          Wenn du dich in die Warteliste einträgst, verarbeiten wir deine E-Mail-Adresse und die Seite, von der aus du dich eingetragen
          hast, um dich über den Start von CalenSync zu informieren. Rechtsgrundlage ist deine Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO.
        </p>
        <p>
          Wir nutzen das Double-Opt-in-Verfahren: Du erhältst eine E-Mail mit einem Bestätigungslink, der 72 Stunden gilt. Solange du nicht
          bestätigst, speichern wir deine Adresse nicht. Nach der Bestätigung speichern wir Adresse, Quelle und Zeitpunkt der Bestätigung als
          Nachweis der Einwilligung. Zur Missbrauchsabwehr wird ein Hashwert deiner IP-Adresse für zehn Minuten zwischengespeichert.
        </p>
        <p>
          Die Bestätigungsmail versenden wir über Mailjet SAS, 4 rue Jules Lefebvre, 75009 Paris, Frankreich. Die Einträge liegen in einer
          Redis-Datenbank der Upstash, Inc. (USA) in der Region Frankfurt am Main; für einen möglichen Zugriff aus den USA gelten die
          EU-Standardvertragsklauseln (Art. 46 Abs. 2 lit. c DSGVO). Mit beiden Anbietern bestehen Verträge zur Auftragsverarbeitung.
        </p>
        <p>
          Du kannst deine Einwilligung jederzeit widerrufen: über den Austragen-Link in jeder E-Mail von uns oder per Nachricht an {ht.email}.
          Wir löschen deine Daten nach dem Widerruf, spätestens wenn die Warteliste nach dem Start von CalenSync aufgelöst wird.
        </p>
      </SwPrivacySection>

      <SwPrivacySection title="Zugang zur Dashboard-Vorschau">
        <p>
          Bevor sich die Dashboard-Vorschau zum ersten Mal öffnet, fragen wir nach deiner E-Mail-Adresse und deiner Einwilligung, dich über
          den Start von CalenSync zu informieren. Die Eintragung läuft über die Warteliste mit Double-Opt-in; es gilt der Abschnitt
          „Warteliste“. Als Quelle speichern wir „dashboard“. Rechtsgrundlage ist deine Einwilligung nach Art. 6 Abs. 1 lit. a DSGVO, die du
          jederzeit widerrufen kannst.
        </p>
        <p>
          Die Vorschau öffnet sich sofort nach dem Absenden, auch bevor du die Adresse bestätigt hast. Ist die Warteliste vorübergehend nicht
          erreichbar, öffnet sie sich trotzdem; deine Adresse wird dann nicht gespeichert. Die Vorschau zeigt nur Beispieldaten.
        </p>
        <p>
          Damit die Abfrage nicht bei jedem Besuch erscheint, legt dein Browser im lokalen Speicher (localStorage) einen Vermerk mit dem
          Zeitpunkt der Freischaltung ab; deine E-Mail-Adresse steht darin nicht. Ebenfalls nur in deinem Browser speichert die Vorschau
          Änderungen an den Beispieldaten und ob du die Einführungstour gesehen hast. Diese Einträge werden nicht an uns übertragen. Sie sind
          für die von dir gewünschte Funktion unbedingt erforderlich (§ 25 Abs. 2 Nr. 2 TDDDG). Du kannst sie jederzeit löschen, indem du die
          Websitedaten in deinem Browser entfernst.
        </p>
      </SwPrivacySection>

      <SwPrivacySection title="Anmeldung mit Microsoft im Dashboard (optional)">
        <p>
          Unternehmen, die CalenSync Enterprise in ihrer eigenen Umgebung einsetzen, können das Dashboard mit Microsoft Entra ID verbinden.
          Nur dann erscheint die Schaltfläche „Mit Microsoft anmelden“. Die Anmeldung ist freiwillig; die Vorschau funktioniert auch ohne sie.
        </p>
        <p>
          Wenn du dich anmeldest, leitet dich dein Browser zur Anmeldeseite von Microsoft weiter (Redirect-Verfahren) und danach zurück zu
          dieser Website. Dein Passwort gibst du nur bei Microsoft ein, wir erhalten es nicht. Microsoft übermittelt deinem Browser dein
          Benutzerkonto mit Anzeigename und Anmeldename (User Principal Name, meist deine geschäftliche E-Mail-Adresse) sowie Zugriffstoken.
          Zweck ist allein der Zugriff auf die CalenSync-Enterprise-Schnittstelle deines Unternehmens, etwa um den Status des
          Kalenderabgleichs anzuzeigen oder ihn einzurichten.
        </p>
        <p>
          Konto und Token liegen nur im Sitzungsspeicher (sessionStorage) deines Browsers und werden gelöscht, wenn du dich abmeldest oder den
          Tab schließt. Der Browser sendet die Token direkt an die CalenSync-Enterprise-Schnittstelle deines Unternehmens, nicht an die Server
          dieser Website. Nach einer erfolgreichen Anmeldung merkt sich der Browser im lokalen Speicher, dass die Vorschau freigeschaltet ist
          (siehe vorheriger Abschnitt). Die Anmeldebibliothek von Microsoft (MSAL) liefern wir von unserem eigenen Server aus; sie wird nicht
          von einem fremden Content-Delivery-Netz geladen und nur, wenn die Anmeldung eingerichtet ist.
        </p>
        <p>
          Für die Anmeldung selbst ist Microsoft eigenständig verantwortlich; Anbieter ist für Nutzer im EWR die Microsoft Ireland Operations
          Limited, One Microsoft Place, South County Business Park, Leopardstown, Dublin 18, Irland. Es gelten die Datenschutzbestimmungen von
          Microsoft und die Vereinbarungen deines Unternehmens mit Microsoft. Eine Übermittlung an die Microsoft Corporation in den USA ist
          möglich; Microsoft ist unter dem EU-U.S. Data Privacy Framework zertifiziert (Art. 45 DSGVO).
        </p>
        <p>
          Für die Daten in der CalenSync-Enterprise-Umgebung ist das Unternehmen verantwortlich, das sie einsetzt, in der Regel dein
          Arbeitgeber. Betreiben wir die Umgebung für das Unternehmen, handeln wir als Auftragsverarbeiter nach Art. 28 DSGVO. Rechtsgrundlage
          für die Anmeldung ist Art. 6 Abs. 1 lit. f DSGVO; das berechtigte Interesse liegt in einer sicheren Anmeldung mit dem bestehenden
          Geschäftskonto, ohne eigenes Passwort und nur für berechtigte Personen des Unternehmens.
        </p>
      </SwPrivacySection>

      <section>
        <Ie>Verarbeitung auf der CalenSync-Plattform</Ie>
        <ul className="mt-2 list-disc space-y-2 pl-5">
          {e.checklist.map((t) => (<li key={t.title}><span className="font-semibold text-slate-900">{t.title}</span> {t.text}</li>))}
        </ul>
        <p className="mt-3">{e.datacenter}</p>
      </section>
      <section>
        <Ie>{e.thirdParty.title}</Ie>
        <p className="mt-2">{e.thirdParty.text}</p>
        <p className="mt-2">{e.thirdParty.euMode}</p>
      </section>
      <SwPrivacySection title="KI-Telefonagent">
        <p>{sc(Y.aiAgent.transparency)}</p>
        <p>
          Verantwortlich für die Daten aus einem Anruf ist das Unternehmen oder die Praxis, die du anrufst; wir verarbeiten sie als
          Auftragsverarbeiter nach Art. 28 DSGVO. Verarbeitet werden deine Rufnummer und die angerufene Nummer, das Gesagte als Text, über die
          Telefontastatur eingegebene Ziffern (etwa der SMS-Bestätigungscode) sowie die Angaben für den Termin: Name, E-Mail-Adresse,
          Mobilnummer und Wunschtermin. Bei Arztpraxen kommen Geburtsdatum, die Angabe, ob du schon Patientin oder Patient bist, und die Art
          deines Anliegens hinzu (etwa Rezept, Überweisung oder Rückruf); diese Angaben können Gesundheitsdaten nach Art. 9 DSGVO sein.
          Medizinische Fragen beantwortet der Agent nicht.
        </p>
        <p>
          <span className="font-semibold text-slate-900">Telefonie und SMS.</span> Anrufe nimmt die Twilio Inc. (USA) entgegen. Twilio wandelt
          das Gesagte in Text um, liest die Antworten des Agenten mit einer synthetischen Stimme vor und versendet SMS mit dem
          Bestätigungscode, dem Buchungslink oder der Terminbestätigung. Wir lassen Gespräche nicht aufzeichnen. Twilio speichert
          Verbindungsdaten wie Rufnummern, Zeitpunkt und Dauer nach den eigenen Aufbewahrungsfristen. Für die Übermittlung in die USA gilt
          [Grundlage der Übermittlung, z. B. EU-U.S. Data Privacy Framework oder EU-Standardvertragsklauseln – vor dem Livegang eintragen].
        </p>
        <p>
          <span className="font-semibold text-slate-900">Sprachmodell.</span> Den Gesprächstext verarbeitet ein Sprachmodell über Amazon Bedrock
          der Amazon Web Services EMEA SARL, 38 Avenue John F. Kennedy, L-1855 Luxemburg, in der Standardeinstellung in der AWS-Region
          Frankfurt am Main über ein EU-Inferenzprofil; dabei kann AWS Anfragen auf Rechenzentren in anderen EU-Regionen verteilen. Nach
          Angaben von AWS werden die Eingaben weder an den Hersteller des Modells weitergegeben noch zum Training verwendet. Das Modell
          schlägt nur Schritte vor; was tatsächlich ausgeführt wird, prüft unser Server nach festen Regeln.
        </p>
        <p>
          <span className="font-semibold text-slate-900">Abgleich mit belegten Zeiten.</span> Setzt das Unternehmen CalenSync Enterprise ein,
          fragt der Agent vor dem Vorschlagen und vor dem Eintragen eines Termins dort ab, welche Zeiten belegt sind. Dabei sendet er nur den
          gesuchten Zeitraum und erhält nur Beginn und Ende belegter Zeiten zurück, ohne Titel, Teilnehmende oder andere personenbezogene
          Daten. Daten von Anrufenden werden bei dieser Abfrage nicht übermittelt.
        </p>
        <p>
          <span className="font-semibold text-slate-900">Speicherdauer.</span> Der Gesprächsverlauf wird für höchstens eine Stunde
          zwischengespeichert, ein SMS-Bestätigungscode ist fünf Minuten gültig. Aufgaben für das Team werden 30 Tage nach ihrem Eingang
          gelöscht, Termine und Terminvorschläge (im Praxismodus einschließlich Geburtsdatum) 90 Tage nach Terminende und Einträge im
          Protokoll des Dashboards nach 90 Tagen. Unabhängig davon bleiben jeweils nur die neuesten Einträge erhalten (Termine 500, Aufgaben
          und Protokoll je 200). Gespeichert wird in der Redis-Datenbank in der Region Frankfurt am Main (siehe Abschnitt „Warteliste“).
        </p>
      </SwPrivacySection>
      <section>
        <Ie>Buchungsdaten von Terminen</Ie>
        <p className="mt-2">
          Wer über eine CalenSync-Buchungsseite oder per Telefon einen Termin bucht, gibt Name, E-Mail-Adresse und/oder Telefonnummer sowie die
          vom jeweiligen Unternehmen hinterlegten Fragen an. Verantwortlich für diese Daten ist das Unternehmen, bei dem der Termin gebucht wird;
          CalenSync verarbeitet sie als Auftragsverarbeiter nach Art. 28 DSGVO. Kontaktdaten aus Buchungen werden nach 90 Tagen pseudonymisiert,
          Gesprächszusammenfassungen des Telefonagenten nach der vom Unternehmen gewählten Frist (Standard 30 Tage) gelöscht. Das Demo-Widget
          auf dieser Website sendet und speichert keine Eingaben.
        </p>
      </section>
      <section>
        <Ie>Ihre Rechte</Ie>
        <p className="mt-2">
          Auskunft, Berichtigung, Löschung, Einschränkung der Verarbeitung, Datenübertragbarkeit und Widerspruch nach Art. 15–21 DSGVO,
          Widerruf einer Einwilligung nach Art. 7 Abs. 3 DSGVO sowie Beschwerde bei einer Aufsichtsbehörde. Anfragen an {ht.email}.
        </p>
      </section>
    </SwLegalPage>
  );
}

// =====================================================================
// Startseite: Dashboard-Sektion (kompakte Nachbildung von /dashboard)
// =====================================================================
const SW_DASH_KPIS = [
  { label: "Buchungs-Conversion", value: "14,2 %", delta: "+3,1 Pkt.", note: "seit KI-Agent aktiv" },
  { label: "KI-gesparte Zeit", value: "4,5 Std", delta: "+0,8 Std", note: "diese Woche" },
  { label: "Aktive Event-Typen", value: "3", delta: "", note: "Erstgespräch · Strategie · Demo" },
  { label: "Verifizierte Leads", value: "27", delta: "+5", note: "Warteliste, Double-Opt-in" },
];
const SW_DASH_DAYS = ["Mo", "Di", "Mi", "Do", "Fr"];
const SW_DASH_HOURS = ["09:00", "10:00", "11:00", "12:00", "13:00", "14:00"];
// [Tag 0–4, Startzeile 0–5 (09:00 = 0), Dauer in Zeilen, Titel, Art]
const SW_DASH_EVENTS = [
  [0, 1, 1, "Erstgespräch", "booked"],
  [1, 2, 1.5, "Strategie-Session", "booked"],
  [2, 0, 1, "Demo-Termin", "booked"],
  [3, 2, 1, "Erstgespräch", "ai"],
  [4, 1, 1, "Strategie-Session", "ai"],
  [4, 3.5, 1, "Puffer (KI)", "blocked"],
];
const SW_DASH_POINTS = [
  { title: "Wochenkalender mit KI-Vorschlägen", text: "Gebuchte Termine, offene Vorschläge des Agenten und Puffer auf einen Blick — in deiner Zeitzone." },
  { title: "Freigaben per Klick", text: "Der Agent bereitet Antwort und Slot vor, du gibst frei. Oder er bucht selbstständig innerhalb deiner Regeln." },
  { title: "Live-Feed und Kennzahlen", text: "Jeder Anruf, jede Buchung, jede Absage — protokolliert, mit Conversion und gesparter Zeit." },
];

function SwDashEvent({ ev }) {
  const [day, start, len, title, kind] = ev;
  const tone = kind === "booked"
    ? "bg-indigo-600 text-white"
    : kind === "ai"
      ? "border border-dashed border-violet-400 bg-violet-50 text-violet-800"
      : "border border-slate-300 bg-slate-100 text-slate-500";
  return (
    <div className={`sw-dash-ev absolute rounded-md px-1.5 py-1 text-[10px] font-medium leading-tight ${tone}`}
      style={{ left: `calc(${(day / 5) * 100}% + 2px)`, width: "calc(20% - 4px)", top: `calc(${(start / 6) * 100}% + 2px)`, height: `calc(${(len / 6) * 100}% - 4px)` }}>
      <span className="block truncate">{title}</span>
    </div>
  );
}

function SwDashboardMock() {
  return (
    <div className="sw-dash overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-card-hover" aria-hidden="true">
      {/* Kopfzeile */}
      <div className="flex h-11 items-center gap-2 border-b border-slate-100 bg-slate-50 px-4">
        <span className="h-2.5 w-2.5 rounded-full bg-slate-300" /><span className="h-2.5 w-2.5 rounded-full bg-slate-300" /><span className="h-2.5 w-2.5 rounded-full bg-slate-300" />
        <span className="ml-3 hidden rounded-md bg-white px-2 py-0.5 text-[11px] text-slate-500 sm:inline">app.calensync.de/dashboard</span>
        <span className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" />KI-Agent online
        </span>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-[150px_1fr]">
        {/* Seitenleiste */}
        <aside className="hidden border-r border-slate-100 bg-white px-3 py-4 md:block">
          <div className="flex items-center gap-2 px-1">
            <svg width="20" height="20" viewBox="0 0 64 64" aria-hidden="true"><path d="M30 17H40a7 7 0 0 1 7 7V34" fill="none" stroke="#4f46e5" strokeWidth="4" strokeLinecap="round" /><path d="M34 47H24a7 7 0 0 1-7-7V30" fill="none" stroke="#a5b4fc" strokeWidth="4" strokeLinecap="round" /><rect x="4" y="4" width="26" height="26" rx="8" fill="#a5b4fc" /><rect x="34" y="34" width="26" height="26" rx="8" fill="#4f46e5" /><rect x="10" y="14" width="14" height="6" rx="3" fill="#4f46e5" /><rect x="40" y="44" width="14" height="6" rx="3" fill="#fff" /></svg>
            <span className="font-display text-sm font-bold text-slate-900">calensync</span>
          </div>
          <div className="mt-4 rounded-lg bg-indigo-600 px-3 py-1.5 text-center text-[11px] font-medium text-white">+ Neuer Termin</div>
          <ul className="mt-4 space-y-1 text-[11px] font-medium text-slate-600">
            <li className="rounded-md bg-indigo-50 px-2 py-1.5 text-indigo-800">Dashboard</li>
            <li className="px-2 py-1.5">Buchungen</li>
            <li className="px-2 py-1.5">KI-Agent</li>
            <li className="px-2 py-1.5 text-slate-400">Kunden</li>
            <li className="px-2 py-1.5 text-slate-400">Berichte</li>
            <li className="px-2 py-1.5">Einstellungen</li>
          </ul>
        </aside>
        {/* Inhalt */}
        <div className="bg-slate-50 p-4 sm:p-5">
          <p className="text-[11px] text-slate-500">Mittwoch, 30. September</p>
          <p className="font-display text-base font-bold tracking-tight text-slate-900 sm:text-lg">Hallo Jana, dein Agent hat übernommen.</p>
          <div className="mt-3 grid grid-cols-2 gap-2 lg:grid-cols-4">
            {SW_DASH_KPIS.map((k) => (
              <div key={k.label} className="rounded-xl border border-slate-100 bg-white p-3">
                <p className="truncate text-[11px] text-slate-500">{k.label}</p>
                <p className="mt-1 font-display text-lg font-bold text-slate-900">{k.value}</p>
                <p className="mt-0.5 truncate text-[10px] text-slate-500">{k.delta && <span className="font-semibold text-indigo-700">{k.delta} </span>}{k.note}</p>
              </div>
            ))}
          </div>
          <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[1.6fr_1fr]">
            {/* Wochenkalender */}
            <div className="rounded-xl border border-slate-100 bg-white p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold text-slate-900">Diese Woche</p>
                <div className="flex gap-3 text-[10px] text-slate-500">
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-indigo-600" />Gebucht</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm border border-dashed border-violet-400 bg-violet-50" />KI-Vorschlag</span>
                  <span className="inline-flex items-center gap-1"><span className="h-2 w-2 rounded-sm bg-slate-200" />Blockiert</span>
                </div>
              </div>
              <div className="mt-2 grid grid-cols-[32px_1fr]">
                <div />
                <div className="grid grid-cols-5 text-center text-[10px] font-medium text-slate-500">
                  {SW_DASH_DAYS.map((d, i) => <span key={d} className={i === 2 ? "text-indigo-700" : ""}>{d}</span>)}
                </div>
                <div className="grid text-[9px] text-slate-400" style={{ gridTemplateRows: "repeat(6, 26px)" }}>
                  {SW_DASH_HOURS.map((h) => <span key={h} className="-mt-1.5">{h}</span>)}
                </div>
                <div className="relative sw-dash-grid" style={{ height: 156 }}>
                  {SW_DASH_EVENTS.map((ev, i) => <SwDashEvent key={i} ev={ev} />)}
                </div>
              </div>
            </div>
            {/* KI-Panel */}
            <div className="rounded-xl border border-slate-100 bg-white p-3">
              <p className="text-xs font-semibold text-slate-900">KI-Assistent steuern</p>
              <p className="mt-0.5 text-[10px] text-slate-500">Du entscheidest, wie viel der Agent allein macht.</p>
              <div className="mt-2 rounded-lg border border-indigo-600 bg-indigo-50 px-3 py-2">
                <p className="text-[11px] font-semibold text-slate-900">Erst Entwurf zur Freigabe vorlegen</p>
                <p className="text-[10px] text-slate-600">Antwort und Slot vorbereiten, du gibst frei.</p>
              </div>
              <div className="mt-1.5 rounded-lg border border-slate-200 px-3 py-2">
                <p className="text-[11px] font-semibold text-slate-900">Automatisch antworten und buchen</p>
                <p className="text-[10px] text-slate-600">Innerhalb deiner Regeln, du wirst informiert.</p>
              </div>
              <div className="mt-3 flex items-center justify-between text-[11px] font-medium text-slate-900">
                <span>Maximale Termine pro Tag</span><span className="rounded bg-slate-100 px-1.5">4</span>
              </div>
              <div className="relative mt-2 h-1.5 rounded-full bg-slate-200">
                <div className="h-full w-1/3 rounded-full bg-indigo-600" />
                <span className="absolute -top-1 left-1/3 h-3.5 w-3.5 -translate-x-1/2 rounded-full border-2 border-white bg-indigo-600 shadow" />
              </div>
              <div className="mt-3 flex gap-2">
                <span className="flex-1 rounded-lg bg-indigo-600 py-1.5 text-center text-[11px] font-medium text-white">Freigeben</span>
                <span className="flex-1 rounded-lg border border-slate-200 py-1.5 text-center text-[11px] font-medium text-slate-700">Ablehnen</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function SwDashboardSection() {
  return (
    <SwSection tone="white" aria-labelledby="dash-title">
      <SwHeading
        eyebrow={<SwBadge tone="neutral">Dashboard</SwBadge>}
        title={<span id="dash-title">Dein Cockpit: Termine, KI-Agent und Freigaben auf einen Blick.</span>}
        description="Das Dashboard zeigt, was dein Agent übernommen hat, welche Vorschläge auf Freigabe warten und wie sich Buchungen entwickeln — ohne Tabellen-Chaos."
        actions={
          <div className="flex flex-wrap gap-2">
            <SwButton as="a" href="/dashboard/?modus=unternehmen" variant="secondary">Vorschau für Unternehmen<SwArrow size={16} /></SwButton>
            <SwButton as="a" href="/dashboard/?modus=praxis" variant="secondary">Vorschau für Praxen<SwArrow size={16} /></SwButton>
          </div>
        }
      />
      <div className="mt-10"><SwDashboardMock /></div>
      <ul className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
        {SW_DASH_POINTS.map((p) => (
          <li key={p.title} className="flex gap-3">
            <span className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-200"><SwCheck size={11} /></span>
            <p className="text-sm leading-relaxed text-slate-600"><span className="font-semibold text-slate-900">{p.title}. </span>{p.text}</p>
          </li>
        ))}
      </ul>
    </SwSection>
  );
}
