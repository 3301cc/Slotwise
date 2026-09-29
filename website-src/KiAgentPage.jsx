/*
 * Slotwise · /ki-agent
 * Quelle für die Seite „KI-Agent“. Wird mit esbuild in assets/site.js eingesetzt
 * (ersetzt dort die Funktion fr). Verwendete Bundle-Bezeichner:
 *   w  = react/jsx-runtime, cn = React
 *   ge = Section, Ue = Card, P = Button, re = Badge, dt = SectionHeading, vu = LiveFeed
 *   nn = PhoneIcon, Ot = CheckIcon, rt = ArrowIcon, Ve = Router-Link
 *   Y  = Marketing-Texte, K = Pläne, sc = Platzhalter-Ersetzung, zp = Anruf-Schritte
 *   ot = Registrierung, _t = Demo-Buchung, Pi = Demo-Telefonnummer (VITE_DEMO_PHONE)
 */


// ---------- JSX-Laufzeit + Aliase auf Bundle-Komponenten ----------
function swH(type, props, ...kids) {
  const { key, ...p } = props || {};
  if (kids.length === 1) p.children = kids[0];
  else if (kids.length > 1) p.children = kids;
  return kids.length > 1 ? (0, w.jsxs)(type, p, key) : (0, w.jsx)(type, p, key);
}
const swF = w.Fragment;
const SwSection = ge, SwBadge = re, SwHeading = dt, SwLiveFeed = vu, SwPhone = nn, SwArrow = rt;

// ---------- Design-Tokens ----------
const SW_SECTION = "bg-slate-50";
const SW_CARD =
  "rounded-2xl border border-slate-100 bg-white shadow-[0_4px_6px_-1px_rgba(15,23,42,0.05),0_2px_4px_-2px_rgba(15,23,42,0.05)]";

// Echte Aufnahme eines Demo-Anrufs, sobald vorhanden (z. B. "/assets/demo-call.mp3").
// Solange null, läuft der nachgestellte Ablauf ohne Ton.
const SW_AUDIO_SRC = null;

const SW_DURATION = 27;
const SW_SCRIPT = [
  { t: 0, who: "ki", text: "Guten Tag, Sie sprechen mit dem digitalen Assistenten von Nordlicht Consulting. Wie kann ich helfen?" },
  { t: 5.5, who: "kunde", text: "Ich brauche morgen einen Termin um 14 Uhr." },
  { t: 9, who: "ki", text: "Sekunde, ich prüfe den Kalender …" },
  { t: 11.5, who: "sys", text: "Kalender geprüft · 14:00 Uhr frei" },
  { t: 12.5, who: "ki", text: "14:00 Uhr ist frei. Auf welchen Namen darf ich reservieren?" },
  { t: 16.5, who: "kunde", text: "Auf Meyer, bitte." },
  { t: 19, who: "ki", text: "Slot um 14:00 Uhr erfolgreich für Sie reserviert! Die Bestätigung kommt gleich per SMS." },
  { t: 24, who: "sys", text: "Termin angelegt · SMS versendet" },
];
const SW_BARS = Array.from({ length: 56 }, (_, i) =>
  Math.round(22 + 70 * Math.abs(Math.sin(i * 1.7) * Math.cos(i * 0.43))),
);

function swFmt(s) {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
}

// ---------- Icons (linear, 1.5px) ----------
function SwIcon({ d, size = 22, className }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}>
      {d.map((p, i) => <path key={i} d={p} />)}
    </svg>
  );
}
const SW_ICON_SERVER = ["M4 4h16v6H4z", "M4 14h16v6H4z", "M8 7h.01", "M8 17h.01", "M12 7h4", "M12 17h4"];
const SW_ICON_SHIELD = ["M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z", "M9 12l2 2 4-4"];
const SW_ICON_LOCK = ["M6 11h12v9H6z", "M8.5 11V8a3.5 3.5 0 0 1 7 0v3", "M12 15v2"];
const SW_ICON_PLAY = ["M8 5.5v13l10-6.5z"];
const SW_ICON_PAUSE = ["M8 5v14", "M16 5v14"];
const SW_ICON_REPLAY = ["M3 12a9 9 0 1 0 3-6.7", "M3 4v5h5"];

// ---------- Audio-Demo ----------
function SwAudioDemo() {
  const [time, setTime] = (0, cn.useState)(0);
  const [playing, setPlaying] = (0, cn.useState)(false);
  const audioRef = (0, cn.useRef)(null);
  const logRef = (0, cn.useRef)(null);
  const done = time >= SW_DURATION;

  (0, cn.useEffect)(() => {
    if (!playing || SW_AUDIO_SRC) return;
    let last = performance.now();
    let raf = requestAnimationFrame(function tick(now) {
      const dt = (now - last) / 1000;
      last = now;
      setTime((t) => {
        const n = t + dt;
        if (n >= SW_DURATION) { setPlaying(false); return SW_DURATION; }
        return n;
      });
      raf = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  const visible = SW_SCRIPT.filter((m) => m.t <= time);
  (0, cn.useEffect)(() => {
    const el = logRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [visible.length]);

  const speaking = playing ? [...visible].reverse().find((m) => m.who !== "sys") : null;
  const progress = Math.min(1, time / SW_DURATION);

  function toggle() {
    if (done) { setTime(0); setPlaying(true); audioRef.current?.play?.(); return; }
    if (playing) { setPlaying(false); audioRef.current?.pause?.(); }
    else { setPlaying(true); if (audioRef.current) { audioRef.current.currentTime = time; audioRef.current.play(); } }
  }

  return (
    <div className={`${SW_CARD} overflow-hidden`}>
      <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div className="min-w-0">
          <p className="text-xs font-medium uppercase tracking-wider text-emerald-700">Hörprobe</p>
          <h2 className="mt-0.5 font-display text-base font-bold text-slate-900">Slotwise Live-Demo anhören</h2>
        </div>
        <span className="inline-flex flex-none items-center gap-1.5 rounded-full border border-slate-200 bg-slate-50 px-2.5 py-0.5 text-xs font-medium text-slate-600">
          <span className={`h-1.5 w-1.5 rounded-full ${playing ? "bg-emerald-500 animate-pulse" : "bg-slate-300"}`} aria-hidden="true" />
          {playing ? "Anruf läuft" : done ? "Beendet" : "Bereit"}
        </span>
      </div>

      <div className="flex items-center gap-4 px-5 pt-5">
        <button type="button" onClick={toggle}
          aria-label={playing ? "Demo pausieren" : done ? "Demo erneut abspielen" : "Demo abspielen"}
          className="grid h-12 w-12 flex-none place-items-center rounded-full bg-emerald-600 text-white shadow-sm transition-colors hover:bg-emerald-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">
          <SwIcon d={playing ? SW_ICON_PAUSE : done ? SW_ICON_REPLAY : SW_ICON_PLAY} size={20}
            className={playing || done ? "" : "translate-x-[1px]"} />
        </button>
        <div className="min-w-0 flex-1">
          <div className="flex h-12 items-center gap-[2px] sm:gap-[3px]" aria-hidden="true">
            {SW_BARS.map((h, i) => {
              const past = i / SW_BARS.length <= progress;
              const color = !past ? "bg-slate-200"
                : speaking?.who === "kunde" ? "bg-slate-500" : "bg-emerald-500";
              return (
                <span key={i}
                  className={`sw-bar w-full rounded-full ${color} ${playing ? "sw-bar-live" : ""}`}
                  style={{ height: `${h}%`, animationDelay: `${(i % 9) * 90}ms` }} />
              );
            })}
          </div>
          <div className="mt-1.5 flex justify-between text-xs tabular-nums text-slate-500">
            <span>{swFmt(time)}</span>
            <span>{speaking ? (speaking.who === "ki" ? "KI-Agent spricht" : "Anrufer spricht") : "Terminbuchung per Telefon"}</span>
            <span>{swFmt(SW_DURATION)}</span>
          </div>
        </div>
      </div>

      <ol ref={logRef} aria-live="polite" className="mt-4 h-64 space-y-2.5 overflow-y-auto border-t border-slate-100 bg-slate-50 px-5 py-4">
        {visible.length === 0 && (
          <li className="grid h-full place-items-center text-center text-sm text-slate-500">
            Auf Play drücken: ein Anrufer bucht einen Termin, der KI-Agent prüft live den Kalender.
          </li>
        )}
        {visible.map((m) =>
          m.who === "sys" ? (
            <li key={m.t} className="flex justify-center">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-medium text-emerald-800">
                <SwIcon d={["M5 12l4 4 10-10"]} size={12} />{m.text}
              </span>
            </li>
          ) : (
            <li key={m.t} className={`flex ${m.who === "ki" ? "justify-start" : "justify-end"}`}>
              <div className={`max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed ${m.who === "ki"
                ? "rounded-tl-md border border-slate-100 bg-white text-slate-800"
                : "rounded-tr-md bg-slate-900 text-white"}`}>
                <span className={`block text-[11px] font-semibold uppercase tracking-wider ${m.who === "ki" ? "text-emerald-700" : "text-slate-300"}`}>
                  {m.who === "ki" ? "KI-Agent" : "Kunde"}
                </span>
                {m.text}
              </div>
            </li>
          ),
        )}
      </ol>
      <p className="border-t border-slate-100 px-5 py-3 text-xs text-slate-500">
        {SW_AUDIO_SRC ? "Aufnahme eines Demo-Anrufs." : "Nachgestellter Gesprächsablauf mit Beispieldaten."}
        {Pi && <> Selbst testen: <a className="font-medium text-slate-900 underline-offset-2 hover:underline" href={`tel:${Pi}`}>{Pi}</a></>}
      </p>
      {SW_AUDIO_SRC && (
        <audio ref={audioRef} src={SW_AUDIO_SRC} preload="none"
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onEnded={() => { setPlaying(false); setTime(SW_DURATION); }} />
      )}
    </div>
  );
}

// ---------- Trust-Grid ----------
const SW_TRUST = [
  { icon: SW_ICON_SERVER, title: "Serverstandort Frankfurt (Main)",
    text: "Buchungsdaten, Gesprächszusammenfassungen und Transkripte liegen in Rechenzentren in Frankfurt am Main." },
  { icon: SW_ICON_SHIELD, title: "DSGVO-konform, Verarbeitung in der EU",
    text: "AV-Vertrag nach Art. 28 DSGVO inklusive. Anrufer werden zu Beginn informiert, dass sie mit einem digitalen Assistenten sprechen." },
  { icon: SW_ICON_LOCK, title: "Verschlüsselt übertragen, nicht gespeichert",
    text: "Das Gesprächsaudio wird verschlüsselt übertragen und nicht aufgezeichnet. Transkripte werden nach 30 Tagen gelöscht." },
];

function SwTrustGrid() {
  return (
    <ul className="grid gap-4 md:grid-cols-3" aria-label="Datenschutz und Sicherheit">
      {SW_TRUST.map((b) => (
        <li key={b.title} className={`${SW_CARD} p-6`}>
          <span className="grid h-11 w-11 place-items-center rounded-xl border border-emerald-100 bg-emerald-50 text-emerald-700">
            <SwIcon d={b.icon} />
          </span>
          <h3 className="mt-4 font-semibold text-slate-900">{b.title}</h3>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">{b.text}</p>
        </li>
      ))}
    </ul>
  );
}

// ---------- Seite ----------
function fr() {
  const e = Y.aiAgent, t = K.plans.business;
  return (
    <>
      <SwSection className={SW_SECTION}>
        <div className="grid gap-10 lg:grid-cols-[1fr_1.05fr] lg:items-center">
          <div className="max-w-2xl">
            <SwBadge tone="emerald" dot>{e.eyebrow}</SwBadge>
            <h1 className="mt-4 font-display text-4xl font-extrabold tracking-tight text-slate-900 sm:text-5xl">{e.headline}</h1>
            <p className="mt-4 text-lg leading-relaxed text-slate-600">{Y.hero.proof[1].text}</p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <P as="a" href={ot} variant="success" size="lg" className="focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-600 focus-visible:ring-offset-2">
                Kostenlos starten<SwArrow size={14} />
              </P>
              {Pi ? (
                <P as="a" href={`tel:${Pi}`} variant="secondary" size="lg"><SwPhone size={16} />Demo anrufen · {Pi}</P>
              ) : (
                <P as="a" href={_t} variant="secondary" size="lg">Demo-Termin buchen</P>
              )}
            </div>
            <p className="mt-4 text-sm text-slate-500">{gu.microcopy}</p>
          </div>
          <SwAudioDemo />
        </div>
      </SwSection>

      <SwSection className={`${SW_SECTION} border-t border-slate-100`} spacing="tight" aria-label="Vertrauen und Sicherheit">
        <SwTrustGrid />
      </SwSection>

      <SwSection className={`${SW_SECTION} border-t border-slate-100`}>
        <SwHeading eyebrow={<SwBadge tone="neutral">So läuft ein Anruf</SwBadge>} title="Vom Klingeln bis zur Bestätigung." />
        <ol className="mt-8 grid gap-4 md:grid-cols-2 xl:grid-cols-5">
          {zp.map((l) => (
            <li key={l.step} className={`${SW_CARD} p-5`}>
              <span className="grid h-8 w-8 place-items-center rounded-full bg-slate-900 text-sm font-bold text-white">{l.step}</span>
              <h3 className="mt-4 font-semibold text-slate-900">{l.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-600">{l.text}</p>
            </li>
          ))}
        </ol>
      </SwSection>

      <SwSection className={`${SW_SECTION} border-t border-slate-100`}>
        <div className="grid gap-4 lg:grid-cols-2">
          <div className={`${SW_CARD} p-6 sm:p-8`}>
            <h2 className="font-display text-xl font-bold text-slate-900">Transparenz</h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{sc(e.transparency)}</p>
          </div>
          <div className={`${SW_CARD} p-6 sm:p-8`}>
            <h2 className="font-display text-xl font-bold text-slate-900">Preis</h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-600">{e.pricing}</p>
            <ul className="mt-4 space-y-2 text-sm text-slate-700">
              <li className="flex gap-2"><Ot size={14} className="mt-1 flex-none text-emerald-600" />
                <span>Im {t.name}-Plan enthalten: {t.limits.aiMinutesInIncluded} Minuten eingehend, {t.limits.aiMinutesOutIncluded} ausgehend pro Monat</span></li>
              <li className="flex gap-2"><Ot size={14} className="mt-1 flex-none text-emerald-600" />
                <span>In Starter und Professional als Add-on buchbar (Minutenpakete auf der{" "}
                <Ve to="/preise" className="font-medium underline-offset-2 hover:underline">Preisseite</Ve>)</span></li>
            </ul>
            <P as="a" href={ot} variant="success" size="md" className="mt-6">Kostenlos starten<SwArrow size={14} /></P>
          </div>
        </div>
      </SwSection>

      <SwLiveFeed />
    </>
  );
}
