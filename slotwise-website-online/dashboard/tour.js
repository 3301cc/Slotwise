/* CalenSync Dashboard – Erklär-Tour ("für Einsteiger").
   Eigenständig: bringt eigenes CSS mit, keine Abhängigkeiten.
   Start: automatisch beim ersten Besuch, danach über den ?-Button (data-tour-start) oder window.CalenSyncTour.start(). */
(function () {
  "use strict";

  const KEY = "calensync.tour.v1";
  const PAD = 8;

  const STEPS = [
    {
      target: null,
      title: "Willkommen bei CalenSync",
      body: "CalenSync nimmt dir das Hin-und-Her bei Terminen ab. Leute buchen sich selbst eine freie Zeit, dein Kalender bleibt automatisch aktuell – und wer anruft, landet beim KI-Agenten.",
      action: "Die Tour dauert eine Minute. Du kannst sie jederzeit über das ? oben rechts neu starten.",
    },
    {
      target: "#kpi-grid",
      title: "Deine Zahlen auf einen Blick",
      body: "Wie viele Termine gebucht wurden, wie viel Zeit dir der Agent gespart hat und wie viele Anfragen zu echten Terminen wurden. Kein Tabellenkram – nur das, was zählt.",
    },
    {
      target: "#kalender",
      title: "Deine Woche",
      body: "Hier siehst du alles, was gebucht ist. Google oder Outlook sind verbunden – was dort belegt ist, kann niemand doppelt buchen. Lila gestrichelt = der Agent hat einen Termin vorgeschlagen, du musst noch zusagen.",
      action: "Klick auf einen Termin, dann siehst du die Details darunter.",
    },
    {
      target: "#feed",
      title: "Was dein KI-Agent gerade tut",
      body: "Jeder Anruf, jede Antwort, jede Buchung taucht hier auf – live und nachvollziehbar. Du weißt immer, was der Agent in deinem Namen gemacht hat.",
      action: "Offene Vorschläge kannst du direkt hier freigeben oder ablehnen.",
    },
    {
      target: "#ki-panel",
      title: "Den Agenten steuern",
      body: "Du entscheidest, wie viel er allein macht: erst Entwurf zeigen oder gleich buchen. Dazu ein Tageslimit und eine Anweisung in deinen Worten, z. B. „freitags nichts nach 14 Uhr“.",
      action: "Einstellen, Speichern – gilt sofort für Telefon, E-Mail und Buchungsseite.",
    },
    {
      target: "[data-new-booking]",
      title: "Selbst einen Termin anlegen",
      body: "Wenn jemand dich direkt anspricht, trägst du den Termin hier von Hand ein. Der Agent sieht ihn sofort und bucht nichts doppelt.",
      action: "Fertig. Viel Spaß mit CalenSync!",
    },
  ];

  const CSS = `
.cs-tour{position:fixed;inset:0;z-index:1000;font-family:inherit}
.cs-tour-mask{position:absolute;inset:0;width:100%;height:100%}
.cs-tour-ring{position:absolute;pointer-events:none;border-radius:14px;box-shadow:0 0 0 2px #4f46e5,0 0 0 6px rgba(79,70,229,.18);transition:top .3s,left .3s,width .3s,height .3s}
.cs-tour-card{position:absolute;width:min(360px,calc(100vw - 32px));border-radius:16px;border:1px solid #e2e8f0;background:#fff;padding:20px;box-shadow:0 25px 50px -12px rgba(15,23,42,.35);outline:none;transition:top .3s,left .3s}
.cs-tour-card.is-center{top:50%;left:50%;transform:translate(-50%,-50%)}
.cs-tour-top{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px}
.cs-tour-step{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#4f46e5}
.cs-tour-skip{background:none;border:0;padding:0;font:inherit;font-size:12px;color:#64748b;cursor:pointer}
.cs-tour-skip:hover{color:#0f172a}
.cs-tour-title{margin:0;font-size:17px;font-weight:700;color:#0f172a;line-height:1.3}
.cs-tour-body{margin:8px 0 0;font-size:14px;line-height:1.55;color:#475569}
.cs-tour-action{margin:12px 0 0;border-radius:10px;background:#eef2ff;padding:8px 12px;font-size:13px;line-height:1.5;color:#3730a3}
.cs-tour-missing{margin:8px 0 0;font-size:12px;color:#94a3b8}
.cs-tour-bottom{display:flex;align-items:center;justify-content:space-between;margin-top:16px;gap:12px}
.cs-tour-dots{display:flex;gap:6px}
.cs-tour-dots span{width:6px;height:6px;border-radius:999px;background:#cbd5e1}
.cs-tour-dots span.on{background:#4f46e5}
.cs-tour-btns{display:flex;gap:8px}
.cs-tour-btn{border:0;border-radius:10px;padding:7px 14px;font:inherit;font-size:14px;cursor:pointer}
.cs-tour-btn.ghost{background:transparent;color:#475569}
.cs-tour-btn.ghost:hover{background:#f1f5f9}
.cs-tour-btn.primary{background:#4f46e5;color:#fff;font-weight:600}
.cs-tour-btn.primary:hover{background:#4338ca}
.cs-tour-help{display:inline-grid;place-items:center;width:36px;height:36px;border-radius:999px;border:1px solid #e2e8f0;background:#fff;color:#475569;font-size:14px;font-weight:700;cursor:pointer}
.cs-tour-help:hover{border-color:#a5b4fc;color:#4f46e5}
@media (max-width:639px){
  .cs-tour-card,.cs-tour-card.is-center{top:auto!important;left:16px!important;right:16px;bottom:16px;width:auto;transform:none}
}`;

  let root = null, i = 0, rect = null, raf = 0;

  function style() {
    if (document.getElementById("cs-tour-style")) return;
    const s = document.createElement("style");
    s.id = "cs-tour-style";
    s.textContent = CSS;
    document.head.appendChild(s);
  }

  function findTarget(sel) {
    if (!sel) return null;
    // erstes sichtbares Element (z. B. "Neuer Termin" gibt es in Sidebar und Header)
    return Array.from(document.querySelectorAll(sel)).find((el) => el.getClientRects().length && el.offsetParent !== null) || null;
  }

  function measure() {
    const el = findTarget(STEPS[i].target);
    if (!el) { rect = null; return; }
    const r = el.getBoundingClientRect();
    rect = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  }

  function render() {
    const step = STEPS[i];
    const last = i === STEPS.length - 1;
    measure();

    const hole = rect ? `<rect x="${rect.left}" y="${rect.top}" width="${rect.width}" height="${rect.height}" rx="14" fill="black"/>` : "";
    root.innerHTML = `
      <svg class="cs-tour-mask" aria-hidden="true">
        <defs><mask id="cs-tour-m"><rect width="100%" height="100%" fill="white"/>${hole}</mask></defs>
        <rect width="100%" height="100%" fill="rgba(15,23,42,.6)" mask="url(#cs-tour-m)" data-tour-close/>
      </svg>
      ${rect ? `<div class="cs-tour-ring" style="top:${rect.top}px;left:${rect.left}px;width:${rect.width}px;height:${rect.height}px"></div>` : ""}
      <div class="cs-tour-card${rect ? "" : " is-center"}" tabindex="-1" role="dialog" aria-modal="true" aria-labelledby="cs-tour-title">
        <div class="cs-tour-top">
          <span class="cs-tour-step">Schritt ${i + 1} von ${STEPS.length}</span>
          <button type="button" class="cs-tour-skip" data-tour-close>Überspringen</button>
        </div>
        <h2 class="cs-tour-title" id="cs-tour-title">${esc(step.title)}</h2>
        <p class="cs-tour-body">${esc(step.body)}</p>
        ${step.action ? `<p class="cs-tour-action">${esc(step.action)}</p>` : ""}
        ${step.target && !rect ? `<p class="cs-tour-missing">(Dieser Bereich ist gerade nicht sichtbar.)</p>` : ""}
        <div class="cs-tour-bottom">
          <div class="cs-tour-dots" aria-hidden="true">${STEPS.map((_, n) => `<span class="${n === i ? "on" : ""}"></span>`).join("")}</div>
          <div class="cs-tour-btns">
            ${i > 0 ? `<button type="button" class="cs-tour-btn ghost" data-tour-prev>Zurück</button>` : ""}
            <button type="button" class="cs-tour-btn primary" data-tour-next>${last ? "Los geht's" : "Weiter"}</button>
          </div>
        </div>
      </div>`;

    const card = root.querySelector(".cs-tour-card");
    if (rect) {
      const vw = window.innerWidth, vh = window.innerHeight;
      const cw = Math.min(360, vw - 32), ch = card.offsetHeight || 220;
      let top, left;
      const below = rect.top + rect.height + 12, above = rect.top - ch - 12;
      const right = rect.left + rect.width + 12, leftOf = rect.left - cw - 12;
      if (below + ch <= vh - 16) { top = below; left = rect.left; }            // darunter
      else if (above >= 16) { top = above; left = rect.left; }                 // darüber
      else if (right + cw <= vw - 16) { top = Math.max(16, rect.top); left = right; }   // rechts daneben
      else if (leftOf >= 16) { top = Math.max(16, rect.top); left = leftOf; }  // links daneben
      else { top = vh - ch - 16; left = vw - cw - 16; }                         // Notlösung: unten rechts
      card.style.top = Math.min(Math.max(16, top), vh - ch - 16) + "px";
      card.style.left = Math.min(Math.max(16, left), vw - cw - 16) + "px";
    }
    card.focus({ preventScroll: true });
  }

  function go(n) {
    i = Math.max(0, Math.min(STEPS.length - 1, n));
    const el = findTarget(STEPS[i].target);
    if (el) {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      render();
      setTimeout(render, 380); // nach dem Scrollen neu messen
    } else {
      render();
    }
  }

  function onKey(e) {
    if (e.key === "Escape") return close();
    if (e.key === "ArrowRight" || e.key === "Enter") return i === STEPS.length - 1 ? close() : go(i + 1);
    if (e.key === "ArrowLeft") return go(i - 1);
  }
  function onMove() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(render);
  }

  function start() {
    if (root) return;
    style();
    root = document.createElement("div");
    root.className = "cs-tour";
    root.addEventListener("click", (e) => {
      if (e.target.closest("[data-tour-next]")) return i === STEPS.length - 1 ? close() : go(i + 1);
      if (e.target.closest("[data-tour-prev]")) return go(i - 1);
      if (e.target.closest("[data-tour-close]")) return close();
    });
    document.body.appendChild(root);
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    window.addEventListener("resize", onMove);
    go(0);
  }

  function close() {
    if (!root) return;
    window.removeEventListener("keydown", onKey);
    window.removeEventListener("resize", onMove);
    root.remove();
    root = null;
    document.body.style.overflow = "";
    try { localStorage.setItem(KEY, "done"); } catch (_) {}
  }

  function seen() {
    try { return !!localStorage.getItem(KEY); } catch (_) { return true; }
  }

  document.addEventListener("click", (e) => {
    if (e.target.closest("[data-tour-start]")) { e.preventDefault(); start(); }
  });

  window.CalenSyncTour = { start, close, reset: () => { try { localStorage.removeItem(KEY); } catch (_) {} } };

  style(); // Stil für den ?-Button sofort
  if (!seen()) window.addEventListener("load", () => setTimeout(start, 600));
})();
