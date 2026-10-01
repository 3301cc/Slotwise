/*
 * CalenSync · /praxen  –  Seite für Arzt- und Zahnarztpraxen.
 * Wird von build.py hinter KiAgentPage.jsx und SitePatches.jsx eingesetzt und als Route "praxen" registriert.
 * Nutzt swH/swF, SwIcon und die Sw*-Aliase aus KiAgentPage.jsx/SitePatches.jsx.
 * Ansprache: „Sie“ (Praxen erwarten das), Rest der Website bleibt beim „du“.
 * Keine erfundenen Zahlen, keine Zusagen zu Funktionen, die es noch nicht gibt (PVS-Anbindung = „in Vorbereitung“).
 */

const SW_PX_CARD = "rounded-2xl border border-slate-100 bg-white shadow-[0_4px_6px_-1px_rgba(15,23,42,0.05),0_2px_4px_-2px_rgba(15,23,42,0.05)]";
const swPilot = () => swOpenWaitlist({ source: "praxen" });

const SW_PX_ICONS = {
  phone: ["M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"],
  ear: ["M8 9a4 4 0 1 1 8 0c0 2.5-2 3-2 5.5a2.5 2.5 0 0 1-5 0", "M12 9.5a1 1 0 0 1 1 1"],
  calendar: ["M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v12a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 18.5z", "M4 10h16", "M8 3v4", "M16 3v4"],
  message: ["M4 5h16v11H8l-4 4z", "M8 9.5h8", "M8 12.5h5"],
  task: ["M9 5h10", "M9 12h10", "M9 19h10", "M4.5 5l1 1 2-2", "M4.5 12l1 1 2-2", "M4.5 19l1 1 2-2"],
  shield: ["M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z", "M9 12l2 2 4-4"],
  server: ["M4 5h16v6H4z", "M4 13h16v6H4z", "M8 8h.01", "M8 16h.01"],
  lock: ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3"],
  bot: ["M5 9h14v10H5z", "M12 5v4", "M9 14h.01", "M15 14h.01"],
  alert: ["M12 4l9 16H3z", "M12 10v4", "M12 17h.01"],
  tooth: ["M7 3c-2 0-3.5 1.6-3.5 4 0 3 1.5 4 2 7 .4 2.6.8 7 2.5 7s1.6-4.5 4-4.5 2.3 4.5 4 4.5 2.1-4.4 2.5-7c.5-3 2-4 2-7 0-2.4-1.5-4-3.5-4-2 0-3 1-5 1S9 3 7 3z"],
  steth: ["M6 3v6a4 4 0 0 0 8 0V3", "M10 13v2a5 5 0 0 0 10 0v-2", "M20 11.5a1.5 1.5 0 1 0 0 .01"],
  hospital: ["M4 21V7l8-4 8 4v14", "M9 21v-5h6v5", "M12 8v4", "M10 10h4"],
};
const SwPxIcon = ({ name, size = 22, className }) => <SwIcon d={SW_PX_ICONS[name]} size={size} className={className} />;

const SW_PX_CALL = [
  { who: "ki", text: "Praxis Dr. Berger, guten Morgen. Sie sprechen mit dem digitalen Assistenten der Praxis. Bei einem Notfall wählen Sie bitte die 112. Was kann ich für Sie tun?" },
  { who: "kunde", text: "Ich brauche ein Folgerezept für mein Blutdruckmittel." },
  { who: "ki", text: "Das gebe ich gern an das Praxisteam weiter. Nennen Sie mir bitte Ihren Namen und Ihr Geburtsdatum." },
  { who: "sys", text: "Aufgabe angelegt · Folgerezept" },
  { who: "kunde", text: "Und ich bräuchte noch einen Termin zur Kontrolle." },
  { who: "ki", text: "Am Donnerstag um 8:30 Uhr ist ein Termin frei. Ich merke ihn vor, die Praxis meldet sich zur Bestätigung." },
  { who: "sys", text: "Termin vorgemerkt · Freigabe durch das Team" },
];

const SW_PX_PAINS = [
  { icon: "phone", title: "Telefonspitze am Morgen", text: "Zwischen 8 und 10 Uhr ist die Leitung oft durchgehend besetzt. Wer nicht durchkommt, ruft später erneut an oder wendet sich an eine andere Praxis." },
  { icon: "task", title: "Telefondienst neben dem Empfang", text: "Folgerezepte, Überweisungen und Terminverschiebungen kosten Zeit. Jedes Telefonat fehlt bei der Patientenaufnahme und bei den Menschen im Wartezimmer." },
  { icon: "calendar", title: "Terminausfälle", text: "Wer absagen möchte und nicht durchkommt, erscheint oft einfach nicht. Über den Assistenten erreicht die Absage Ihr Team sofort, und der Termin lässt sich neu vergeben." },
];

const SW_PX_STEPS = [
  { icon: "ear", title: "Annehmen", text: "Der Assistent nimmt den Anruf an, wenn alle Leitungen belegt sind. Er sagt zu Beginn, dass eine KI spricht, und nennt die 112 für Notfälle." },
  { icon: "message", title: "Anliegen klären", text: "Termin, Absage, Folgerezept oder Überweisung: Er fragt nach, bis das Anliegen eindeutig ist, und erfasst Name, Geburtsdatum und Rückrufnummer." },
  { icon: "calendar", title: "Aufnehmen", text: "In der Startphase nimmt er nur Anliegen auf und bucht nichts. Später kann er auch Termine vormerken, die Ihr Team freigibt." },
  { icon: "task", title: "Übergeben", text: "Jedes Anliegen erscheint als Aufgabe in Ihrer Praxisübersicht. Über die Taste 0 erreicht der Anrufer jederzeit Ihr Team." },
];

const SW_PX_NEVER = [
  "keine Ersteinschätzung von Beschwerden, keine Diagnose, keine Einstufung der Dringlichkeit",
  "keine Auskunft zu Befunden, Laborwerten oder Medikation",
  "bei Hinweisen auf einen Notfall sofort der Verweis auf die 112 und den ärztlichen Bereitschaftsdienst 116 117",
  "keine Abfrage von E-Mail-Adresse oder Bestätigungscode, Name, Geburtsdatum und Rückrufnummer genügen",
  "Weiterleitung an Ihr Team jederzeit auf Wunsch oder über die Taste 0",
];

const SW_PX_SPECIALTIES = [
  {
    icon: "steth",
    title: "Für Arztpraxen",
    text: "Allgemeinmedizin, Innere Medizin, Kinder- und Jugendmedizin sowie Facharztpraxen.",
    items: ["Akute Beschwerden: Rückrufbitte statt Selbstbuchung", "Vorsorgeuntersuchungen und Check-up", "Impftermine", "Folgerezepte und Überweisungen als Aufgabe fürs Team", "Befundbesprechung: nur Terminvergabe, keine Auskunft am Telefon"],
  },
  {
    icon: "tooth",
    title: "Für Zahnarztpraxen",
    text: "Einzel- und Gemeinschaftspraxen, auch mit eigenem Prophylaxe-Team.",
    items: ["Prophylaxe und PZR (professionelle Zahnreinigung) mit Recall-Liste", "Kontrolluntersuchungen", "Schmerzpatienten: Rückrufbitte mit Vorrang", "Beratung zu Zahnersatz und Implantaten", "Individualprophylaxe für Kinder"],
  },
];

const SW_PX_TRUST = [
  { icon: "server", title: "Hosting in Frankfurt am Main", text: "Anwendung, Datenbank und KI-Verarbeitung laufen in Frankfurt. Den Telefonie-Anbieter und seinen Standort nennen wir Ihnen vor Vertragsschluss." },
  { icon: "lock", title: "AV-Vertrag mit Schweigepflicht", text: "Auftragsverarbeitung nach Art. 28 DSGVO. Alle Beteiligten sind auf die Verschwiegenheit nach § 203 StGB verpflichtet." },
  { icon: "shield", title: "Nur das Nötigste", text: "Keine Befunde, keine Diagnosen, keine Tonaufnahmen. Aufgaben werden nach 30 Tagen automatisch gelöscht." },
  { icon: "bot", title: "Als KI erkennbar", text: "Anrufer hören gleich zu Beginn, dass sie mit einem digitalen Assistenten sprechen, und können jederzeit einen Menschen verlangen." },
];

const SW_PX_PLAN = [
  "Bis zu 3 Behandlerkalender pro Standort",
  "Telefonassistent mit 400 Minuten pro Monat",
  "500 SMS pro Monat",
  "Vorlagen für Arzt- und Zahnarztpraxen, Recall-Liste",
  "Folgerezept- und Überweisungswünsche als Aufgaben",
  "AV-Vertrag mit Verpflichtung nach § 203 StGB",
];

const SW_PX_FAQ = [
  { q: "Was kann CalenSync heute und was ist geplant?", a: "Heute nimmt der Assistent Anrufe an, erfasst Rückrufbitten, Folgerezept-, Überweisungs- und Absagewünsche als Aufgabe, merkt auf Wunsch Termine zur Freigabe vor und verweist bei Notfällen auf die 112. In Vorbereitung sind SMS-Erinnerungen, ein automatischer Recall, Schnittstellen zu Praxisverwaltungssystemen (PVS) und Benutzerkonten für das Praxisteam. Die Reihenfolge stimmen wir mit den Pilotpraxen ab." },
  { q: "Funktioniert das mit unserer Praxissoftware?", a: "Derzeit arbeitet CalenSync mit einem eigenen Kalender sowie mit Google- und Microsoft-Kalendern. Schnittstellen zu gängigen PVS sind in Vorbereitung. Welche zuerst kommt, legen wir gemeinsam mit den Pilotpraxen fest." },
  { q: "Wir nutzen bereits eine Online-Terminbuchung. Geht beides parallel?", a: "Ja. Viele Praxen setzen den Assistenten zunächst nur in den Telefonspitzen ein. Welche Terminarten er vormerken darf, legen Sie selbst fest." },
  { q: "Was passiert bei einem Notfall?", a: "Der Assistent schätzt keine Beschwerden ein. Schon die Begrüßung nennt die 112, und über die Taste 0 erreicht man sofort das Team. Erkennt er Hinweise auf einen Notfall oder ist er sich unsicher, verweist er auf die 112 beziehungsweise den ärztlichen Bereitschaftsdienst 116 117 und gibt den Anruf weiter. Eine Notrufleitung ersetzt das nicht. Deshalb prüfen wir das Verhalten mit jeder Pilotpraxis anhand echter Anrufe." },
  { q: "Können Patienten mit einem Menschen sprechen?", a: "Jederzeit. Auf Wunsch leitet der Assistent weiter oder nimmt eine Rückrufbitte auf, die als Aufgabe in der Praxisübersicht erscheint." },
  { q: "Wo werden die Daten verarbeitet?", a: "Anwendung, Datenbank und KI-Verarbeitung laufen in Frankfurt am Main. Vorab erhalten Sie den AV-Vertrag nach Art. 28 DSGVO mit Verpflichtung nach § 203 StGB und die vollständige Liste der Unterauftragsverarbeiter, einschließlich Telefonie-Anbieter und Standort." },
  { q: "Was kostet CalenSync nach der Pilotphase?", a: "Der Praxis-Tarif kostet 89 € pro Standort und Monat bei jährlicher Zahlung. Pilotpraxen zahlen im ersten Jahr nach der Pilotphase die Hälfte. Zum Ende der Pilotphase können Sie kostenfrei kündigen." },
];

function SwPxCallCard() {
  return (
    <div className={`${SW_PX_CARD} overflow-hidden`}>
      <div className="flex items-center justify-between border-b border-slate-100 px-5 py-3.5">
        <div className="flex items-center gap-2.5">
          <span className="grid h-9 w-9 place-items-center rounded-full bg-indigo-50 text-indigo-700"><SwPxIcon name="phone" size={18} /></span>
          <div>
            <p className="text-sm font-semibold text-slate-900">Eingehender Anruf</p>
            <p className="text-xs text-slate-500">Praxis Dr. Berger · 8:12 Uhr</p>
          </div>
        </div>
        <span className="inline-flex items-center gap-1.5 rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-0.5 text-xs font-medium text-indigo-700">
          <span className="h-1.5 w-1.5 rounded-full bg-indigo-500" aria-hidden="true" />KI-Assistent
        </span>
      </div>
      <ol className="space-y-2.5 px-5 py-4 text-sm" aria-label="Beispiel eines Anrufs">
        {SW_PX_CALL.map((m, i) => (
          <li key={i} className={m.who === "kunde" ? "flex justify-end" : m.who === "sys" ? "flex justify-center" : "flex"}>
            {m.who === "sys" ? (
              <span className="rounded-full bg-slate-100 px-3 py-1 text-xs font-medium text-slate-600">{m.text}</span>
            ) : (
              <span className={`max-w-[85%] rounded-2xl px-3.5 py-2 leading-relaxed ${m.who === "kunde" ? "bg-slate-900 text-white" : "bg-indigo-50 text-slate-800"}`}>
                <span className="sr-only">{m.who === "kunde" ? "Patient: " : "KI-Assistent: "}</span>{m.text}
              </span>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}

function SwPxCheckItem({ children }) {
  return (
    <li className="flex gap-2.5">
      <span className="mt-0.5 grid h-5 w-5 flex-none place-items-center rounded-full bg-indigo-50 text-indigo-600 ring-1 ring-inset ring-indigo-200"><SwCheck size={11} /></span>
      <span className="text-sm leading-relaxed text-slate-700">{children}</span>
    </li>
  );
}

function SwPraxenPage() {
  (0, cn.useEffect)(() => {
    const prev = document.title;
    document.title = "CalenSync für Arzt- und Zahnarztpraxen – KI-Telefonassistent aus Deutschland";
    return () => { document.title = prev; };
  }, []);

  return (
    <>
      {/* Hero */}
      <SwSection tone="wash" spacing="loose" aria-labelledby="px-title">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <SwBadge tone="neutral">Für Arzt- und Zahnarztpraxen</SwBadge>
            <h1 id="px-title" className="mt-4 font-display text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">
              Telefonassistenz für die Anmeldung Ihrer Praxis
            </h1>
            <p className="mt-5 max-w-xl text-lg leading-relaxed text-slate-600">
              CalenSync nimmt Anrufe an, wenn Ihre Medizinischen Fachangestellten am Empfang gebraucht werden. Der Assistent erfasst
              Folgerezept- und Überweisungswünsche, Absagen und Rückrufbitten und legt sie Ihrem Team als Aufgabe vor. Ärztliche Entscheidungen trifft er nicht.
            </p>
            <ul className="mt-6 space-y-2.5">
              <SwPxCheckItem><span className="font-semibold text-slate-900">Hosting in Frankfurt am Main.</span> AV-Vertrag mit Verpflichtung auf die Schweigepflicht nach § 203 StGB.</SwPxCheckItem>
              <SwPxCheckItem><span className="font-semibold text-slate-900">Organisation, keine Medizin.</span> Keine Ersteinschätzung von Beschwerden, bei Notfallhinweisen Verweis auf die 112.</SwPxCheckItem>
              <SwPxCheckItem><span className="font-semibold text-slate-900">Gemeinsam eingerichtet.</span> Sprechzeiten, Terminarten und Ansagetext legen wir mit Ihrem Praxisteam fest.</SwPxCheckItem>
            </ul>
            <div className="mt-8 flex flex-wrap gap-3">
              <SwButton variant="success" size="lg" onClick={swPilot}>Als Pilotpraxis bewerben<SwArrow size={16} /></SwButton>
              <SwButton as="a" href="/dashboard/?modus=praxis" size="lg" variant="secondary">Dashboard-Vorschau ansehen</SwButton>
            </div>
            <p className="mt-3 text-sm text-slate-500">10 Plätze für Pilotpraxen · 3 Monate kostenlos · danach 50 % im ersten Jahr</p>
          </div>
          <SwPxCallCard />
        </div>
      </SwSection>

      {/* Probleme */}
      <SwSection tone="white" aria-labelledby="px-pain-title">
        <SwHeading
          eyebrow={<SwBadge tone="neutral">Der Praxisalltag</SwBadge>}
          title={<span id="px-pain-title">Was die Anmeldung jeden Tag bindet</span>}
          description="CalenSync ersetzt keine Medizinische Fachangestellte. Der Assistent übernimmt die Anrufe, die sich täglich wiederholen."
        />
        <ul className="mt-10 grid gap-6 md:grid-cols-3">
          {SW_PX_PAINS.map((p) => (
            <li key={p.title} className={`${SW_PX_CARD} p-6`}>
              <span className="grid h-11 w-11 place-items-center rounded-xl border border-indigo-100 bg-indigo-50 text-indigo-700"><SwPxIcon name={p.icon} /></span>
              <h3 className="mt-4 font-display text-lg font-bold text-slate-900">{p.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{p.text}</p>
            </li>
          ))}
        </ul>
      </SwSection>

      {/* Ablauf + Grenzen */}
      <SwSection aria-labelledby="px-flow-title">
        <SwHeading
          eyebrow={<SwBadge tone="neutral">So läuft ein Anruf</SwBadge>}
          title={<span id="px-flow-title">Vom ersten Klingeln bis zur Aufgabe für Ihr Team</span>}
        />
        <ol className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {SW_PX_STEPS.map((s, i) => (
            <li key={s.title} className={`${SW_PX_CARD} p-6`}>
              <div className="flex items-center justify-between">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-slate-900 text-white"><SwPxIcon name={s.icon} size={20} /></span>
                <span className="font-display text-sm font-bold text-slate-300">0{i + 1}</span>
              </div>
              <h3 className="mt-4 font-display text-base font-bold text-slate-900">{s.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{s.text}</p>
            </li>
          ))}
        </ol>
        <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50 p-6 sm:p-7">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 flex-none place-items-center rounded-xl bg-white text-amber-700 ring-1 ring-inset ring-amber-200"><SwPxIcon name="alert" size={20} /></span>
            <div>
              <h3 className="font-display text-base font-bold text-slate-900">Was der Assistent nicht tut</h3>
              <ul className="mt-3 grid gap-2 text-sm leading-relaxed text-amber-950 sm:grid-cols-2">
                {SW_PX_NEVER.map((t) => <li key={t} className="flex gap-2"><span aria-hidden="true">–</span><span>{t}</span></li>)}
              </ul>
            </div>
          </div>
        </div>
      </SwSection>

      {/* Fachrichtungen */}
      <SwSection tone="white" aria-labelledby="px-spec-title">
        <SwHeading
          eyebrow={<SwBadge tone="neutral">Vorlagen</SwBadge>}
          title={<span id="px-spec-title">Vorlagen für Ihre Fachrichtung</span>}
          description="Terminarten mit Dauer, Pufferzeiten und Recall-Intervallen (Wiedereinbestellung) sind vorbelegt. Sie ergänzen nur noch Ihre Sprechzeiten."
        />
        <div className="mt-10 grid gap-6 md:grid-cols-2">
          {SW_PX_SPECIALTIES.map((s) => (
            <article key={s.title} className={`${SW_PX_CARD} p-6 sm:p-8`}>
              <div className="flex items-center gap-3">
                <span className="grid h-11 w-11 place-items-center rounded-xl border border-indigo-100 bg-indigo-50 text-indigo-700"><SwPxIcon name={s.icon} /></span>
                <div>
                  <h3 className="font-display text-lg font-bold text-slate-900">{s.title}</h3>
                  <p className="text-sm text-slate-500">{s.text}</p>
                </div>
              </div>
              <ul className="mt-6 space-y-2.5">{s.items.map((t) => <SwPxCheckItem key={t}>{t}</SwPxCheckItem>)}</ul>
            </article>
          ))}
        </div>
      </SwSection>

      {/* Datenschutz */}
      <SwSection aria-labelledby="px-trust-title">
        <SwHeading
          eyebrow={<SwBadge tone="neutral">Datenschutz und Schweigepflicht</SwBadge>}
          title={<span id="px-trust-title">Patientendaten unter Schweigepflicht</span>}
          description="Gesundheitsdaten gehören nach Art. 9 DSGVO zu den besonders geschützten Daten. CalenSync verarbeitet deshalb nur, was für die Terminorganisation nötig ist."
        />
        <ul className="mt-10 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {SW_PX_TRUST.map((t) => (
            <li key={t.title} className={`${SW_PX_CARD} p-6`}>
              <span className="grid h-10 w-10 place-items-center rounded-xl border border-indigo-100 bg-indigo-50 text-indigo-700"><SwPxIcon name={t.icon} size={20} /></span>
              <h3 className="mt-4 font-display text-base font-bold text-slate-900">{t.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{t.text}</p>
            </li>
          ))}
        </ul>
      </SwSection>

      {/* Preise */}
      <SwSection tone="white" aria-labelledby="px-price-title" id="praxis-preise">
        <SwHeading
          align="center"
          eyebrow={<SwBadge tone="neutral">Preise für Praxen</SwBadge>}
          title={<span id="px-price-title">Ein Preis pro Standort, keine Abrechnung pro Anruf</span>}
          description="Unternehmen buchen weiterhin die regulären Pläne. Für Praxen gibt es einen eigenen Tarif mit mehr Telefonminuten und Funktionen für die Praxisorganisation."
        />
        <div className="mx-auto mt-10 grid max-w-5xl gap-6 lg:grid-cols-[1.15fr_1fr]">
          <article className={`${SW_PX_CARD} relative p-7 sm:p-8 ring-2 ring-indigo-600`}>
            <span className="absolute -top-3 left-7 rounded-full bg-indigo-600 px-3 py-1 text-xs font-semibold text-white">Pilotphase: 10 Plätze</span>
            <h3 className="font-display text-xl font-bold text-slate-900">Praxis</h3>
            <p className="mt-1 text-sm text-slate-500">Für Arzt- und Zahnarztpraxen mit einem Standort</p>
            <p className="mt-5 flex items-baseline gap-2">
              <span className="font-display text-4xl font-extrabold tracking-tight text-slate-900">89 €</span>
              <span className="text-sm text-slate-500">pro Standort / Monat, jährlich · 109 € monatlich</span>
            </p>
            <ul className="mt-6 space-y-2.5">{SW_PX_PLAN.map((t) => <SwPxCheckItem key={t}>{t}</SwPxCheckItem>)}</ul>
            <div className="mt-6 rounded-xl bg-indigo-50 p-4 text-sm text-indigo-950">
              <p className="font-semibold">Angebot für Pilotpraxen</p>
              <p className="mt-1 text-indigo-900">3 Monate kostenlos, danach im ersten Jahr zum halben Preis. Wir beginnen im Rückruf-Modus. Das Vormerken von Terminen schalten Sie frei, sobald Sie so weit sind. Im Gegenzug wünschen wir uns ehrliche Rückmeldungen und ein kurzes Gespräch nach vier Wochen. Zum Ende der Pilotphase können Sie kostenfrei kündigen.</p>
            </div>
            <SwButton variant="success" size="lg" className="mt-6 w-full" onClick={swPilot}>Als Pilotpraxis bewerben</SwButton>
          </article>
          <div className="grid gap-6">
            <article className={`${SW_PX_CARD} p-7`}>
              <h3 className="font-display text-lg font-bold text-slate-900">Weitere Standorte und MVZ</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">Zusätzliche Standorte und Behandlerkalender zu festen Preisen, mit gemeinsamer Auswertung über alle Standorte.</p>
              <SwButton variant="secondary" className="mt-5" onClick={swPilot}>Angebot anfragen</SwButton>
            </article>
            <article className={`${SW_PX_CARD} p-7`}>
              <div className="flex items-center gap-3">
                <span className="grid h-10 w-10 place-items-center rounded-xl border border-slate-200 bg-slate-50 text-slate-700"><SwPxIcon name="hospital" size={20} /></span>
                <h3 className="font-display text-lg font-bold text-slate-900">Kliniken und Ambulanzen</h3>
              </div>
              <p className="mt-3 text-sm leading-relaxed text-slate-600">Terminvergabe für Ambulanzen und Spezialsprechstunden mit eigener Instanz, individuellem Vertrag und Anbindung an Ihre Klinik-IT. Auf Anfrage.</p>
              <SwButton variant="secondary" className="mt-5" onClick={swPilot}>Kontakt aufnehmen</SwButton>
            </article>
          </div>
        </div>
      </SwSection>

      {/* FAQ */}
      <SwSection aria-labelledby="px-faq-title">
        <SwHeading eyebrow={<SwBadge tone="neutral">Häufige Fragen</SwBadge>} title={<span id="px-faq-title">Häufige Fragen aus Praxen</span>} />
        <div className="mt-8 divide-y divide-slate-200 rounded-2xl border border-slate-200 bg-white">
          {SW_PX_FAQ.map((f) => (
            <details key={f.q} className="group px-5 py-4 sm:px-6">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-4 font-medium text-slate-900">
                {f.q}
                <span className="grid h-7 w-7 flex-none place-items-center rounded-full border border-slate-200 text-slate-500 transition-transform group-open:rotate-45" aria-hidden="true">+</span>
              </summary>
              <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-600">{f.a}</p>
            </details>
          ))}
        </div>
      </SwSection>

      {/* Abschluss */}
      <SwSection tone="white" spacing="tight">
        <div className="rounded-3xl bg-slate-900 px-6 py-12 text-center sm:px-12">
          <h2 className="font-display text-2xl font-bold tracking-tight text-white sm:text-3xl">Mehr Zeit für die Patienten in Ihrer Praxis</h2>
          <p className="mx-auto mt-3 max-w-xl text-slate-300">Bewerben Sie sich als Pilotpraxis. Wir melden uns innerhalb von zwei Werktagen und vereinbaren ein kurzes Kennenlernen.</p>
          <div className="mt-7 flex flex-wrap justify-center gap-3">
            <SwButton variant="success" size="lg" onClick={swPilot}>Als Pilotpraxis bewerben<SwArrow size={16} /></SwButton>
            <SwButton as="a" href="/ki-agent" size="lg" variant="secondary">Beispielanruf anhören</SwButton>
          </div>
        </div>
      </SwSection>
    </>
  );
}
