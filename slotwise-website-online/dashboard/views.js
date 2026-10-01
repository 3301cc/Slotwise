/* CalenSync Dashboard – Ansichten Kunden, Event-Typen, Berichte.
   Umschalten per Hash (#kunden, #event-typen, #berichte); alle anderen Hashes zeigen die Übersicht.
   Daten ausschließlich über SlotwiseAPI (dashboard-data.js). Kein Build nötig, CSS-Klassen kommen aus dashboard.css. */
(function () {
  "use strict";
  const API = window.SlotwiseAPI;
  const TZ = window.SLOTWISE_TZ;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const num = (v, d = 0) => Number(v).toLocaleString("de-DE", { maximumFractionDigits: d, minimumFractionDigits: d });
  const fmtDate = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, day: "2-digit", month: "2-digit", year: "numeric" });
  const fmtDT = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  const initials = (n) => n.split(/\s+/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const svg = (path, cls = "h-4 w-4") => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  const I = {
    plus: '<path d="M12 5v14M5 12h14"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 7 9 6 9-6"/>',
    phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2"/>',
    copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    pin: '<path d="M12 21s7-6.2 7-12a7 7 0 0 0-14 0c0 5.8 7 12 7 12z"/><circle cx="12" cy="9" r="2.5"/>',
    video: '<rect x="3" y="6" width="13" height="12" rx="2"/><path d="m16 10 5-3v10l-5-3"/>',
    bot: '<rect x="4" y="8" width="16" height="11" rx="3"/><path d="M12 4v4M9 13h.01M15 13h.01"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/><path d="m13 7 4 4"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
    cal: '<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>',
  };

  // ---------- gemeinsame Bausteine ----------
  const TAG = {
    new: { label: "Neu", cls: "border-sky-200 bg-sky-50 text-sky-800" },
    regular: { label: "Stammkunde", cls: "border-indigo-200 bg-indigo-50 text-indigo-800" },
    lead: { label: "Lead", cls: "border-amber-200 bg-amber-50 text-amber-900" },
  };
  const SOURCE = { phone: "Telefon (KI-Agent)", page: "Buchungsseite", mail: "E-Mail (KI-Agent)", manual: "Manuell" };
  const LOCATION = {
    meet: { label: "Google Meet", icon: I.video },
    teams: { label: "Microsoft Teams", icon: I.video },
    phone: { label: "Telefon", icon: I.phone },
    onsite: { label: "Vor Ort", icon: I.pin },
  };
  const COLOR = {
    indigo: { dot: "bg-indigo-600", bar: "bg-indigo-600", hex: "#4f46e5", label: "Indigo" },
    violet: { dot: "bg-violet-500", bar: "bg-violet-500", hex: "#8b5cf6", label: "Violett" },
    sky: { dot: "bg-sky-500", bar: "bg-sky-500", hex: "#0ea5e9", label: "Himmelblau" },
    emerald: { dot: "bg-emerald-500", bar: "bg-emerald-500", hex: "#10b981", label: "Grün" },
    amber: { dot: "bg-amber-500", bar: "bg-amber-500", hex: "#f59e0b", label: "Bernstein" },
    rose: { dot: "bg-rose-500", bar: "bg-rose-500", hex: "#f43f5e", label: "Rosé" },
  };
  const badge = (text, cls) => `<span class="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium ${cls}">${text}</span>`;
  const pageHead = (id, kicker, title, text, actions) => `
    <div class="mb-6 flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
      <div>
        <p class="text-sm text-slate-500">${kicker}</p>
        <h1 id="${id}" class="font-display text-2xl font-extrabold tracking-tight text-slate-900 sm:text-3xl">${title}</h1>
        <p class="mt-1 max-w-2xl text-sm text-slate-600">${text}</p>
      </div>
      <div class="flex flex-wrap gap-2">${actions}</div>
    </div>`;
  const statCard = (label, value, sub) => `
    <article class="card p-4">
      <p class="text-xs text-slate-500">${label}</p>
      <p class="tabular mt-1 font-display text-2xl font-extrabold tracking-tight text-slate-900">${value}</p>
      ${sub ? `<p class="mt-0.5 text-xs text-slate-500">${sub}</p>` : ""}
    </article>`;
  const demoNote = '<p class="mt-6 text-xs text-slate-500">Vorschau mit Beispieldaten. Änderungen bleiben nur in diesem Browser gespeichert.</p>';

  function toast(text) {
    let t = $("#cs-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "cs-toast";
      t.setAttribute("role", "status");
      t.className = "pointer-events-none fixed bottom-5 left-1/2 z-50 -translate-x-1/2 rounded-lg bg-slate-900 px-4 py-2 text-sm text-white opacity-0 shadow-lg transition-opacity";
      document.body.appendChild(t);
    }
    t.textContent = text;
    t.classList.remove("opacity-0");
    clearTimeout(toast.t);
    toast.t = setTimeout(() => t.classList.add("opacity-0"), 2200);
  }
  function download(name, rows) {
    const csv = rows.map((r) => r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(";")).join("\r\n");
    const a = document.createElement("a");
    a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
    a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  }

  // Tooltip für Diagramme: jedes Element mit data-tip
  const tip = document.createElement("div");
  tip.className = "pointer-events-none fixed z-50 hidden max-w-[220px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-700 shadow-lg";
  tip.setAttribute("role", "tooltip");
  document.body.appendChild(tip);
  function showTip(el, x, y) {
    tip.innerHTML = el.dataset.tip;
    tip.classList.remove("hidden");
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = `${Math.min(window.innerWidth - w - 8, Math.max(8, x - w / 2))}px`;
    tip.style.top = `${y - h - 12 < 8 ? y + 16 : y - h - 12}px`;
  }
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if (el) showTip(el, e.clientX, e.clientY); else tip.classList.add("hidden");
  });
  document.addEventListener("focusin", (e) => {
    const el = e.target.closest && e.target.closest("[data-tip]");
    if (el) { const r = el.getBoundingClientRect(); showTip(el, r.left + r.width / 2, r.top); }
  });
  document.addEventListener("focusout", () => tip.classList.add("hidden"));

  // Dialog (Event-Typ bearbeiten, Kontakt anlegen)
  const dlg = $("#cs-dialog");
  function openDialog(html, onSubmit) {
    dlg.innerHTML = html;
    const form = $("form", dlg);
    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      if (e.submitter && e.submitter.value === "cancel") return dlg.close();
      if (!(e.submitter && e.submitter.value === "delete") && !form.reportValidity()) return;
      const btn = $("[type=submit][value=save]", form); if (btn) btn.disabled = true;
      try { await onSubmit(form, e.submitter && e.submitter.value); dlg.close(); }
      catch (err) { if (btn) btn.disabled = false; if (!err.silent) { console.error(err); toast("Das hat nicht geklappt. Bitte noch einmal versuchen."); } }
    });
    dlg.showModal();
    const first = $("input:not([type=hidden]),select,textarea", dlg); if (first) first.focus();
  }
  dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  const dialogShell = (title, body, footer) => `
    <form method="dialog" class="flex max-h-[90vh] flex-col" novalidate>
      <div class="flex items-center justify-between border-b border-slate-100 px-5 py-4">
        <h2 id="cs-dialog-title" class="font-display text-lg font-bold text-slate-900">${title}</h2>
        <button type="submit" value="cancel" formnovalidate class="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900" aria-label="Schließen">${svg(I.x)}</button>
      </div>
      <div class="space-y-4 overflow-y-auto px-5 py-5">${body}</div>
      <div class="flex flex-wrap items-center justify-end gap-2 border-t border-slate-100 px-5 py-4">${footer}</div>
    </form>`;
  const field = (label, input, hint = "") => `<label class="block"><span class="mb-1.5 block text-sm font-medium text-slate-800">${label}</span>${input}${hint ? `<span class="mt-1 block text-xs text-slate-500">${hint}</span>` : ""}</label>`;
  const toggle = (name, checked, label, hint) => `
    <label class="flex cursor-pointer items-start gap-3">
      <input type="checkbox" name="${name}" class="peer sr-only" ${checked ? "checked" : ""} />
      <span class="cs-switch mt-0.5" aria-hidden="true"></span>
      <span><span class="block text-sm font-medium text-slate-800">${label}</span>${hint ? `<span class="block text-xs text-slate-500">${hint}</span>` : ""}</span>
    </label>`;

  // =====================================================================
  // Kunden
  // =====================================================================
  const K = { list: [], filter: "all", q: "", sort: "recent", selected: null, confirmDelete: false };
  const lastActivity = (c) => Math.max(c.lastAt ? +new Date(c.lastAt) : 0, c.nextAt ? +new Date(c.nextAt) : 0, +new Date(c.createdAt));

  function kundenFiltered() {
    const q = K.q.trim().toLowerCase();
    return K.list
      .filter((c) => K.filter === "all" || c.tag === K.filter)
      .filter((c) => !q || [c.name, c.email, c.company, c.phone].join(" ").toLowerCase().includes(q))
      .sort((a, b) => K.sort === "name" ? a.name.localeCompare(b.name, "de") : K.sort === "bookings" ? b.bookings - a.bookings : lastActivity(b) - lastActivity(a));
  }

  function renderKunden() {
    const root = $("#view-kunden");
    const n = (t) => K.list.filter((c) => c.tag === t).length;
    const recent = K.list.filter((c) => Date.now() - new Date(c.createdAt) < 30 * 86400000).length;
    root.innerHTML = pageHead("kunden-title", "Kunden", "Alle Kontakte an einem Ort",
      "Jeder, der bucht, anruft oder schreibt, landet automatisch hier. Mit Historie, Notizen und DSGVO-Löschung auf Knopfdruck.",
      `<button type="button" class="btn-ghost gap-2" data-k-export>${svg(I.download)}CSV-Export</button>
       <button type="button" class="btn-primary" data-k-new>${svg(I.plus)}Neuer Kontakt</button>`) + `
      <div class="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        ${statCard("Kontakte gesamt", num(K.list.length))}
        ${statCard("Neu in 30 Tagen", num(recent), "davon " + num(K.list.filter((c) => Date.now() - new Date(c.createdAt) < 30 * 86400000 && c.source !== "manual").length) + " über KI oder Buchungsseite")}
        ${statCard("Stammkunden", num(n("regular")))}
        ${statCard("Offene Leads", num(n("lead")), "noch ohne Termin")}
      </div>
      <div class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <div class="card min-w-0">
          <div class="flex flex-col gap-3 border-b border-slate-100 px-5 py-4 lg:flex-row lg:items-center lg:justify-between">
            <label class="relative block lg:w-72">
              <span class="sr-only">Kontakte durchsuchen</span>
              ${svg(I.search, "pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400")}
              <input type="search" id="k-search" class="field h-10 pl-9" placeholder="Name, Firma, E-Mail …" value="${esc(K.q)}" />
            </label>
            <div class="flex flex-wrap items-center gap-2">
              <div class="flex flex-wrap gap-1" role="group" aria-label="Filter">
                ${[["all", "Alle", K.list.length], ["new", "Neu", n("new")], ["regular", "Stammkunden", n("regular")], ["lead", "Leads", n("lead")]].map(([v, l, c]) =>
                  `<button type="button" class="chip ${K.filter === v ? "chip-active" : ""}" data-k-filter="${v}" aria-pressed="${K.filter === v}">${l} <span class="tabular text-slate-400">${c}</span></button>`).join("")}
              </div>
              <label class="flex items-center gap-2 text-xs text-slate-500">Sortieren
                <select id="k-sort" class="field h-9 w-auto py-1 pr-8 text-xs">
                  <option value="recent" ${K.sort === "recent" ? "selected" : ""}>Zuletzt aktiv</option>
                  <option value="name" ${K.sort === "name" ? "selected" : ""}>Name</option>
                  <option value="bookings" ${K.sort === "bookings" ? "selected" : ""}>Meiste Termine</option>
                </select>
              </label>
            </div>
          </div>
          <div class="hidden grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_70px] gap-4 border-b border-slate-100 px-5 py-2 text-[11px] font-medium uppercase tracking-wider text-slate-500 md:grid" aria-hidden="true">
            <span>Kontakt</span><span>Nächster / letzter Termin</span><span>Quelle</span><span class="text-right">Termine</span>
          </div>
          <ul id="k-list" class="divide-y divide-slate-100"></ul>
        </div>
        <aside id="k-detail" class="card xl:sticky xl:top-24 xl:self-start" aria-live="polite"></aside>
      </div>${demoNote}`;
    renderKundenList();
    renderKundenDetail();
  }

  function renderKundenList() {
    const rows = kundenFiltered();
    $("#k-list").innerHTML = rows.length ? rows.map((c) => {
      const when = c.nextAt ? `<span class="text-slate-900">${esc(fmtDT.format(new Date(c.nextAt)))}</span><span class="block truncate text-xs text-slate-500">${esc(c.nextTitle || "")}</span>`
        : c.lastAt ? `<span class="text-slate-600">zuletzt ${esc(fmtDate.format(new Date(c.lastAt)))}</span>` : '<span class="text-slate-400">noch kein Termin</span>';
      return `<li><button type="button" data-k-open="${esc(c.id)}" class="grid w-full grid-cols-1 gap-2 px-5 py-3 text-left text-sm transition-colors hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none md:grid-cols-[minmax(0,2fr)_minmax(0,1.3fr)_minmax(0,1.3fr)_70px] md:items-center md:gap-4 ${K.selected === c.id ? "bg-indigo-50/60" : ""}" aria-current="${K.selected === c.id}">
        <span class="flex min-w-0 items-center gap-3">
          <span class="grid h-9 w-9 flex-none place-items-center rounded-full bg-slate-100 text-xs font-semibold text-slate-600">${esc(initials(c.name))}</span>
          <span class="min-w-0"><span class="flex items-center gap-2"><span class="truncate font-medium text-slate-900">${esc(c.name)}</span>${badge(TAG[c.tag].label, TAG[c.tag].cls)}</span>
          <span class="block truncate text-xs text-slate-500">${esc(c.company || c.email)}</span></span>
        </span>
        <span class="min-w-0 pl-12 md:pl-0">${when}</span>
        <span class="hidden text-slate-600 md:block">${esc(SOURCE[c.source])}</span>
        <span class="tabular hidden text-right font-medium text-slate-900 md:block">${num(c.bookings)}</span>
      </button></li>`;
    }).join("") : `<li class="px-5 py-10 text-center text-sm text-slate-500">Keine Kontakte gefunden.${K.q || K.filter !== "all" ? ' <button type="button" class="font-medium text-indigo-700 hover:underline" data-k-reset>Filter zurücksetzen</button>' : ""}</li>`;
  }

  function renderKundenDetail() {
    const box = $("#k-detail");
    const c = K.list.find((x) => x.id === K.selected);
    if (!c) {
      box.innerHTML = `<div class="px-5 py-10 text-center">
        <span class="mx-auto grid h-11 w-11 place-items-center rounded-2xl border border-slate-200 bg-slate-50 text-slate-500">${svg(I.search, "h-5 w-5")}</span>
        <p class="mt-3 text-sm font-medium text-slate-900">Kontakt auswählen</p>
        <p class="mt-1 text-xs text-slate-500">Klick auf einen Eintrag, dann siehst du Termine, Notizen und Einwilligungen.</p></div>`;
      return;
    }
    const since = Math.max(1, Math.round((Date.now() - new Date(c.createdAt)) / 86400000));
    box.innerHTML = `
      <div class="flex items-start justify-between gap-3 border-b border-slate-100 px-5 py-4">
        <div class="flex min-w-0 items-center gap-3">
          <span class="grid h-11 w-11 flex-none place-items-center rounded-full bg-indigo-50 text-sm font-bold text-indigo-700">${esc(initials(c.name))}</span>
          <div class="min-w-0">
            <h2 class="truncate font-display text-base font-bold text-slate-900">${esc(c.name)}</h2>
            <p class="truncate text-xs text-slate-500">${esc(c.company || "–")}</p>
          </div>
        </div>
        <button type="button" class="grid h-8 w-8 flex-none place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900" data-k-close aria-label="Detailansicht schließen">${svg(I.x)}</button>
      </div>
      <div class="space-y-5 px-5 py-5 text-sm">
        <div class="flex flex-wrap gap-1.5">${badge(TAG[c.tag].label, TAG[c.tag].cls)}${badge(esc(SOURCE[c.source]), "border-slate-200 bg-slate-50 text-slate-700")}</div>
        <dl class="space-y-2">
          <div class="flex items-center gap-2 text-slate-700">${svg(I.mail, "h-4 w-4 flex-none text-slate-400")}<dt class="sr-only">E-Mail</dt><dd class="min-w-0 truncate"><a class="hover:text-indigo-700 hover:underline" href="mailto:${esc(c.email)}">${esc(c.email)}</a></dd></div>
          <div class="flex items-center gap-2 text-slate-700">${svg(I.phone, "h-4 w-4 flex-none text-slate-400")}<dt class="sr-only">Telefon</dt><dd>${c.phone ? `<a class="tabular hover:text-indigo-700 hover:underline" href="tel:${esc(c.phone.replace(/\s/g, ""))}">${esc(c.phone)}</a>` : '<span class="text-slate-400">keine Nummer</span>'}</dd></div>
        </dl>
        <div class="grid grid-cols-3 gap-2 text-center">
          <div class="rounded-xl bg-slate-50 px-2 py-2.5"><p class="tabular font-display text-lg font-bold text-slate-900">${num(c.bookings)}</p><p class="text-[11px] text-slate-500">Termine</p></div>
          <div class="rounded-xl bg-slate-50 px-2 py-2.5"><p class="tabular font-display text-lg font-bold text-slate-900">${num(c.noShows)}</p><p class="text-[11px] text-slate-500">No-Shows</p></div>
          <div class="rounded-xl bg-slate-50 px-2 py-2.5"><p class="tabular font-display text-lg font-bold text-slate-900">${since < 60 ? num(since) : num(Math.round(since / 30))}</p><p class="text-[11px] text-slate-500">${since < 60 ? "Tage" : "Monate"} Kunde</p></div>
        </div>
        <div>
          <p class="mb-1.5 text-xs font-medium uppercase tracking-wider text-slate-500">Nächster Termin</p>
          ${c.nextAt ? `<p class="flex items-center gap-2 text-slate-900">${svg(I.cal, "h-4 w-4 text-indigo-600")}${esc(fmtDT.format(new Date(c.nextAt)))} Uhr</p><p class="mt-0.5 pl-6 text-xs text-slate-500">${esc(c.nextTitle || "")}</p>` : '<p class="text-slate-500">Kein Termin geplant.</p>'}
        </div>
        <div>
          <label for="k-notes" class="mb-1.5 block text-xs font-medium uppercase tracking-wider text-slate-500">Notizen</label>
          <textarea id="k-notes" rows="3" maxlength="500" class="field" placeholder="Was der Agent über diesen Kontakt wissen sollte …">${esc(c.notes)}</textarea>
          <p class="mt-1 text-xs text-slate-500">Der KI-Agent berücksichtigt Notizen bei Anrufen und Antworten.</p>
        </div>
        <div class="rounded-xl border border-slate-200 px-3 py-2.5 text-xs text-slate-600">
          <p class="font-medium text-slate-800">Einwilligungen</p>
          <p class="mt-1">SMS-Erinnerungen: ${c.smsConsent ? '<span class="font-medium text-indigo-700">erteilt</span>' : '<span class="font-medium text-slate-700">nicht erteilt</span> · Erinnerung nur per Mail'}</p>
        </div>
        <div class="flex flex-wrap gap-2">
          <button type="button" class="btn-primary" data-k-save>Notiz speichern</button>
          <a href="#kalender" class="btn-ghost">Termin vorschlagen</a>
        </div>
        <div class="border-t border-slate-100 pt-4">
          ${K.confirmDelete
            ? `<p class="text-xs text-slate-700">Kontakt, Notizen und Buchungshistorie werden endgültig gelöscht (DSGVO Art. 17). Das lässt sich nicht rückgängig machen.</p>
               <div class="mt-2 flex gap-2"><button type="button" class="inline-flex h-9 items-center rounded-lg bg-red-600 px-3 text-sm font-medium text-white hover:bg-red-700" data-k-delete-confirm>Endgültig löschen</button><button type="button" class="btn-ghost h-9" data-k-delete-cancel>Abbrechen</button></div>`
            : `<button type="button" class="inline-flex items-center gap-1.5 text-xs font-medium text-red-700 hover:underline" data-k-delete>${svg(I.trash, "h-3.5 w-3.5")}Daten löschen (DSGVO)</button>`}
        </div>
      </div>`;
  }

  function newContactDialog() {
    openDialog(dialogShell("Neuer Kontakt", `
      ${field("Name", '<input name="name" required maxlength="80" class="field" autocomplete="off" />')}
      ${field("E-Mail", '<input name="email" type="email" required maxlength="120" class="field" autocomplete="off" />')}
      <div class="grid gap-4 sm:grid-cols-2">
        ${field("Telefon", '<input name="phone" type="tel" maxlength="30" class="field" autocomplete="off" />')}
        ${field("Firma", '<input name="company" maxlength="80" class="field" autocomplete="off" />')}
      </div>
      ${field("Status", `<select name="tag" class="field"><option value="new">Neu</option><option value="lead">Lead</option><option value="regular">Stammkunde</option></select>`)}
      ${toggle("smsConsent", false, "Einwilligung für SMS-Erinnerungen liegt vor", "Nur anhaken, wenn der Kontakt zugestimmt hat.")}
    `, '<button type="submit" value="cancel" formnovalidate class="btn-ghost">Abbrechen</button><button type="submit" value="save" class="btn-primary">Kontakt anlegen</button>'),
    async (f) => {
      const c = await API.saveContact({ name: f.name.value.trim(), email: f.email.value.trim(), phone: f.phone.value.trim(), company: f.company.value.trim(), tag: f.tag.value, smsConsent: f.smsConsent.checked });
      K.list = await API.getContacts(); K.selected = c.id; K.filter = "all"; K.q = "";
      renderKunden(); toast("Kontakt angelegt");
    });
  }

  async function initKunden() {
    K.list = await API.getContacts();
    renderKunden();
    const root = $("#view-kunden");
    root.addEventListener("input", (e) => {
      if (e.target.id === "k-search") { K.q = e.target.value; renderKundenList(); }
    });
    root.addEventListener("change", (e) => { if (e.target.id === "k-sort") { K.sort = e.target.value; renderKundenList(); } });
    root.addEventListener("click", async (e) => {
      const t = (s) => e.target.closest(s);
      if (t("[data-k-filter]")) { K.filter = t("[data-k-filter]").dataset.kFilter; return renderKunden(); }
      if (t("[data-k-reset]")) { K.filter = "all"; K.q = ""; return renderKunden(); }
      if (t("[data-k-open]")) {
        K.selected = t("[data-k-open]").dataset.kOpen; K.confirmDelete = false;
        renderKundenList(); renderKundenDetail();
        if (window.innerWidth < 1280) $("#k-detail").scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      if (t("[data-k-close]")) { K.selected = null; renderKundenList(); return renderKundenDetail(); }
      if (t("[data-k-new]")) return newContactDialog();
      if (t("[data-k-export]")) {
        download(`calensync-kontakte-${new Date().toISOString().slice(0, 10)}.csv`, [["Name", "E-Mail", "Telefon", "Firma", "Status", "Quelle", "Termine", "No-Shows", "Nächster Termin", "SMS-Einwilligung"],
          ...kundenFiltered().map((c) => [c.name, c.email, c.phone, c.company, TAG[c.tag].label, SOURCE[c.source], c.bookings, c.noShows, c.nextAt ? fmtDT.format(new Date(c.nextAt)) : "", c.smsConsent ? "ja" : "nein"])]);
        return toast("CSV wird heruntergeladen");
      }
      if (t("[data-k-save]")) {
        const c = K.list.find((x) => x.id === K.selected);
        c.notes = $("#k-notes").value.trim();
        await API.saveContact(c); return toast("Notiz gespeichert");
      }
      if (t("[data-k-delete]")) { K.confirmDelete = true; return renderKundenDetail(); }
      if (t("[data-k-delete-cancel]")) { K.confirmDelete = false; return renderKundenDetail(); }
      if (t("[data-k-delete-confirm]")) {
        await API.deleteContact(K.selected);
        K.list = await API.getContacts(); K.selected = null; K.confirmDelete = false;
        renderKunden(); return toast("Kontakt endgültig gelöscht");
      }
    });
  }

  // =====================================================================
  // Event-Typen
  // =====================================================================
  const E = { list: [] };
  const bookingUrl = (slug) => `calensync.de/jana-krueger/${slug}`;
  const slugify = (s) => s.toLowerCase().replace(/ä/g, "ae").replace(/ö/g, "oe").replace(/ü/g, "ue").replace(/ß/g, "ss").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

  function renderEventTypes() {
    const root = $("#view-event-typen");
    const active = E.list.filter((t) => t.active);
    root.innerHTML = pageHead("event-typen-title", "Event-Typen", "Was man bei dir buchen kann",
      "Jeder Event-Typ hat einen eigenen Buchungslink, eine Dauer und Regeln für Puffer und Vorlauf. Der KI-Agent bucht nur, was du für ihn freigibst.",
      `<button type="button" class="btn-primary" data-e-new>${svg(I.plus)}Neuer Event-Typ</button>`) + `
      <div class="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        ${statCard("Aktive Event-Typen", num(active.length), `von ${num(E.list.length)} angelegt`)}
        ${statCard("Für den KI-Agenten frei", num(active.filter((t) => t.aiBookable).length))}
        ${statCard("Buchungen (30 Tage)", num(E.list.reduce((s, t) => s + (t.bookings30d || 0), 0)))}
        ${statCard("Ø Dauer", active.length ? `${num(active.reduce((s, t) => s + t.duration, 0) / active.length)} Min` : "–")}
      </div>
      <div class="grid grid-cols-1 gap-4 md:grid-cols-2 2xl:grid-cols-3">
        ${E.list.map((t) => {
          const c = COLOR[t.color] || COLOR.indigo, loc = LOCATION[t.location] || LOCATION.meet;
          return `<article class="card relative flex flex-col overflow-hidden ${t.active ? "" : "opacity-70"}" aria-label="${esc(t.name)}">
            <span class="absolute inset-y-0 left-0 w-1.5 ${c.bar}" aria-hidden="true"></span>
            <div class="flex items-start justify-between gap-3 py-4 pl-6 pr-5">
              <div class="min-w-0">
                <h2 class="truncate font-display text-base font-bold text-slate-900">${esc(t.name)}</h2>
                <p class="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-slate-600">
                  <span class="inline-flex items-center gap-1">${svg(I.clock, "h-3.5 w-3.5 text-slate-400")}${num(t.duration)} Min</span>
                  <span class="inline-flex items-center gap-1">${svg(loc.icon, "h-3.5 w-3.5 text-slate-400")}${loc.label}</span>
                </p>
              </div>
              <label class="flex flex-none cursor-pointer items-center gap-2 text-xs text-slate-500" title="${t.active ? "Aktiv – buchbar" : "Pausiert – nicht buchbar"}">
                <span class="sr-only">${esc(t.name)} </span><span>${t.active ? "Aktiv" : "Pausiert"}</span>
                <input type="checkbox" class="peer sr-only" data-e-toggle="${esc(t.id)}" ${t.active ? "checked" : ""} />
                <span class="cs-switch" aria-hidden="true"></span>
              </label>
            </div>
            <p class="flex-1 pb-3 pl-6 pr-5 text-sm leading-relaxed text-slate-600">${esc(t.description || "Keine Beschreibung.")}</p>
            <div class="flex flex-wrap gap-1.5 pb-4 pl-6 pr-5">
              ${t.aiBookable ? badge(svg(I.bot, "h-3 w-3") + "KI darf buchen", "border-violet-200 bg-violet-50 text-violet-800") : badge("Nur manuell", "border-slate-200 bg-slate-50 text-slate-600")}
              ${badge(`Puffer ${num(t.bufferBefore)}/${num(t.bufferAfter)} Min`, "border-slate-200 bg-white text-slate-600")}
              ${badge(`Vorlauf ab ${t.minNoticeHours >= 24 ? num(t.minNoticeHours / 24) + " Tg" : num(t.minNoticeHours) + " Std"}`, "border-slate-200 bg-white text-slate-600")}
            </div>
            <div class="flex items-center gap-2 border-t border-slate-100 py-3 pl-6 pr-5">
              <code class="min-w-0 flex-1 truncate rounded-md bg-slate-50 px-2 py-1 text-xs text-slate-700">${esc(bookingUrl(t.slug))}</code>
              <button type="button" class="grid h-8 w-8 flex-none place-items-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900" data-e-copy="${esc(t.slug)}" aria-label="Link für ${esc(t.name)} kopieren" title="Link kopieren">${svg(I.copy)}</button>
              <button type="button" class="grid h-8 w-8 flex-none place-items-center rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 hover:text-slate-900" data-e-edit="${esc(t.id)}" aria-label="${esc(t.name)} bearbeiten" title="Bearbeiten">${svg(I.edit)}</button>
            </div>
            <p class="border-t border-slate-100 bg-slate-50/60 py-2 pl-6 pr-5 text-xs text-slate-500"><span class="tabular font-semibold text-slate-800">${num(t.bookings30d || 0)}</span> Buchungen in den letzten 30 Tagen</p>
          </article>`;
        }).join("")}
        <button type="button" data-e-new class="flex min-h-[220px] flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-slate-200 text-sm font-medium text-slate-500 transition-colors hover:border-indigo-300 hover:bg-indigo-50/40 hover:text-indigo-700">
          <span class="grid h-10 w-10 place-items-center rounded-full bg-white shadow-sm">${svg(I.plus, "h-5 w-5")}</span>Event-Typ hinzufügen
        </button>
      </div>${demoNote}`;
  }

  function eventDialog(t) {
    const isNew = !t;
    t = t || { name: "", slug: "", duration: 30, color: "emerald", location: "meet", bufferBefore: 0, bufferAfter: 10, minNoticeHours: 4, active: true, aiBookable: true, description: "" };
    const opt = (v, l, cur) => `<option value="${v}" ${String(cur) === String(v) ? "selected" : ""}>${l}</option>`;
    openDialog(dialogShell(isNew ? "Neuer Event-Typ" : "Event-Typ bearbeiten", `
      ${field("Name", `<input name="name" required maxlength="60" class="field" value="${esc(t.name)}" placeholder="z. B. Beratung" />`)}
      ${field("Buchungslink", `<div class="flex items-stretch overflow-hidden rounded-lg border border-slate-200 focus-within:border-indigo-600 focus-within:ring-2 focus-within:ring-indigo-600/30"><span class="flex items-center bg-slate-50 px-3 text-xs text-slate-500">calensync.de/jana-krueger/</span><input name="slug" required pattern="[a-z0-9\\-]+" maxlength="40" class="min-w-0 flex-1 border-0 px-2 py-2.5 text-sm focus:outline-none" value="${esc(t.slug)}" /></div>`, "Kleinbuchstaben, Ziffern und Bindestriche.")}
      <div class="grid gap-4 sm:grid-cols-2">
        ${field("Dauer", `<select name="duration" class="field">${[15, 20, 30, 45, 60, 90, 120].map((d) => opt(d, `${d} Minuten`, t.duration)).join("")}</select>`)}
        ${field("Ort", `<select name="location" class="field">${Object.entries(LOCATION).map(([k, v]) => opt(k, v.label, t.location)).join("")}</select>`)}
      </div>
      <fieldset><legend class="mb-1.5 text-sm font-medium text-slate-800">Farbe im Kalender</legend>
        <div class="flex flex-wrap gap-2">${Object.entries(COLOR).map(([k, v]) => `<label class="cursor-pointer" title="${v.label}"><input type="radio" name="color" value="${k}" class="peer sr-only" ${t.color === k ? "checked" : ""} /><span class="block h-8 w-8 rounded-full ${v.dot} ring-offset-2 peer-checked:ring-2 peer-checked:ring-slate-900 peer-focus-visible:ring-2 peer-focus-visible:ring-indigo-600"></span><span class="sr-only">${v.label}</span></label>`).join("")}</div>
      </fieldset>
      <div class="grid gap-4 sm:grid-cols-3">
        ${field("Puffer davor", `<select name="bufferBefore" class="field">${[0, 5, 10, 15, 30].map((d) => opt(d, `${d} Min`, t.bufferBefore)).join("")}</select>`)}
        ${field("Puffer danach", `<select name="bufferAfter" class="field">${[0, 5, 10, 15, 30].map((d) => opt(d, `${d} Min`, t.bufferAfter)).join("")}</select>`)}
        ${field("Mindestvorlauf", `<select name="minNoticeHours" class="field">${[[1, "1 Std"], [2, "2 Std"], [4, "4 Std"], [12, "12 Std"], [24, "1 Tag"], [48, "2 Tage"], [168, "1 Woche"]].map(([v, l]) => opt(v, l, t.minNoticeHours)).join("")}</select>`)}
      </div>
      ${field("Beschreibung", `<textarea name="description" rows="3" maxlength="300" class="field" placeholder="Steht auf der Buchungsseite.">${esc(t.description)}</textarea>`)}
      <div class="space-y-3 rounded-xl border border-slate-200 p-4">
        ${toggle("active", t.active, "Aktiv", "Auf der Buchungsseite sichtbar und buchbar.")}
        ${toggle("aiBookable", t.aiBookable, "KI-Agent darf diesen Typ buchen", "Am Telefon und per Mail – im Rahmen deiner Autonomie-Einstellung.")}
      </div>
    `, `${isNew ? "" : `<button type="submit" value="delete" formnovalidate class="mr-auto inline-flex items-center gap-1.5 text-sm font-medium text-red-700 hover:underline">${svg(I.trash, "h-4 w-4")}Löschen</button>`}
        <button type="submit" value="cancel" formnovalidate class="btn-ghost">Abbrechen</button>
        <button type="submit" value="save" class="btn-primary">${isNew ? "Anlegen" : "Speichern"}</button>`),
    async (f, action) => {
      if (action === "delete") {
        if (!window.confirm(`„${t.name}“ wirklich löschen? Bestehende Buchungen bleiben erhalten.`)) throw Object.assign(new Error("abgebrochen"), { silent: true });
        await API.deleteEventType(t.id); toast("Event-Typ gelöscht");
      } else {
        const slug = f.slug.value.trim();
        if (E.list.some((x) => x.slug === slug && x.id !== t.id)) { f.slug.setCustomValidity("Dieser Link ist schon vergeben."); f.slug.reportValidity(); f.slug.addEventListener("input", () => f.slug.setCustomValidity(""), { once: true }); throw Object.assign(new Error("Slug vergeben"), { silent: true }); }
        await API.saveEventType({ id: t.id, name: f.name.value.trim(), slug, duration: +f.duration.value, location: f.location.value, color: f.color.value, bufferBefore: +f.bufferBefore.value, bufferAfter: +f.bufferAfter.value, minNoticeHours: +f.minNoticeHours.value, description: f.description.value.trim(), active: f.active.checked, aiBookable: f.aiBookable.checked });
        toast(isNew ? "Event-Typ angelegt" : "Änderungen gespeichert");
      }
      E.list = await API.getEventTypes(); renderEventTypes(); refreshOverviewKpis();
    });
    const f = $("form", dlg);
    if (isNew) f.name.addEventListener("input", () => { if (!f.slug.dataset.touched) f.slug.value = slugify(f.name.value); });
    f.slug.addEventListener("input", () => { f.slug.dataset.touched = "1"; });
  }

  function refreshOverviewKpis() {
    // KPI „Aktive Event-Typen“ auf der Übersicht nachziehen
    const card = $$('#kpi-grid article').find((a) => a.getAttribute("aria-label") === "Aktive Event-Typen");
    if (!card) return;
    const active = E.list.filter((t) => t.active);
    const v = $("p.font-display", card); if (v) v.textContent = num(active.length);
    const s = $("p.mt-1", card); if (s) s.textContent = active.map((t) => t.name).join(" · ") || "keiner aktiv";
  }

  async function initEventTypes() {
    E.list = await API.getEventTypes();
    renderEventTypes();
    const root = $("#view-event-typen");
    root.addEventListener("click", async (e) => {
      const t = (s) => e.target.closest(s);
      if (t("[data-e-new]")) return eventDialog(null);
      if (t("[data-e-edit]")) return eventDialog(E.list.find((x) => x.id === t("[data-e-edit]").dataset.eEdit));
      if (t("[data-e-copy]")) {
        const url = "https://" + bookingUrl(t("[data-e-copy]").dataset.eCopy);
        try { await navigator.clipboard.writeText(url); toast("Link kopiert"); } catch { toast(url); }
      }
    });
    root.addEventListener("change", async (e) => {
      const id = e.target.dataset.eToggle; if (!id) return;
      const ev = E.list.find((x) => x.id === id);
      await API.saveEventType({ ...ev, active: e.target.checked });
      E.list = await API.getEventTypes(); renderEventTypes(); refreshOverviewKpis();
      toast(e.target.checked ? `„${ev.name}“ ist wieder buchbar` : `„${ev.name}“ pausiert`);
    });
  }

  // =====================================================================
  // Berichte
  // =====================================================================
  const R = { days: 30, data: null };
  const SERIES = { ai: { label: "Über den KI-Agenten", hex: "#4f46e5", cls: "bg-indigo-600" }, manual: { label: "Manuell / Buchungsseite ohne KI", hex: "#38bdf8", cls: "bg-sky-400" } };
  const HEAT = ["#f8fafc", "#e0e7ff", "#c7d2fe", "#a5b4fc", "#818cf8", "#6366f1", "#4f46e5", "#4338ca"]; // ein Farbton, hell → dunkel

  function delta(cur, prev, invert = false, unit = "%") {
    const d = unit === "%" ? ((cur - prev) / Math.max(1, prev)) * 100 : cur - prev;
    const good = invert ? d <= 0 : d >= 0;
    return `<span class="font-semibold ${good ? "text-indigo-700" : "text-red-700"}">${d >= 0 ? "+" : "−"}${num(Math.abs(d), unit === "%" ? 0 : 1)}${unit === "%" ? " %" : " Pkt."}</span>`;
  }

  function barChart(series, W = 640) {
    const H = 220, padL = 32, padB = 26, padT = 10;
    const max = Math.max(1, ...series.map((s) => s.ai + s.manual));
    const step = Math.pow(10, Math.floor(Math.log10(max))) * (max / Math.pow(10, Math.floor(Math.log10(max))) > 5 ? 2 : 1);
    const top = Math.ceil(max / step) * step;
    const y = (v) => padT + (H - padT - padB) * (1 - v / top);
    const slot = (W - padL) / series.length, bw = Math.min(36, slot * 0.5);
    const ticks = Array.from({ length: Math.floor(top / step) + 1 }, (_, i) => i * step);
    const r = 4;
    const bars = series.map((s, i) => {
      const x = padL + slot * i + (slot - bw) / 2;
      const yAi = y(s.ai), yTop = y(s.ai + s.manual), base = y(0);
      // KI unten (am Nullpunkt), manuell oben mit 2px Abstand; nur das oberste Segment bekommt runde Ecken
      const manualH = Math.max(0, yAi - yTop - 2);
      const roundTop = (x0, y0, w, h) => h <= 0 ? "" : `M${x0},${y0 + h}V${y0 + Math.min(r, h)}Q${x0},${y0} ${x0 + Math.min(r, h)},${y0}H${x0 + w - Math.min(r, h)}Q${x0 + w},${y0} ${x0 + w},${y0 + Math.min(r, h)}V${y0 + h}Z`;
      const aiPath = s.manual > 0 ? `M${x},${base}V${yAi}H${x + bw}V${base}Z` : roundTop(x, yAi, bw, base - yAi);
      const tipHtml = esc(`<p class="font-semibold text-slate-900">${s.label}</p><p class="mt-1 flex items-center gap-1.5"><span class="h-2 w-2 rounded-sm bg-indigo-600"></span>KI-Agent: <b class="tabular">${s.ai}</b></p><p class="flex items-center gap-1.5"><span class="h-2 w-2 rounded-sm bg-sky-400"></span>Manuell: <b class="tabular">${s.manual}</b></p><p class="mt-1 text-slate-500">Gesamt ${s.ai + s.manual}</p>`);
      return `<g>
        <path d="${aiPath}" fill="${SERIES.ai.hex}"/>
        ${manualH > 0 ? `<path d="${roundTop(x, yTop, bw, manualH)}" fill="${SERIES.manual.hex}"/>` : ""}
        <rect x="${padL + slot * i}" y="${padT}" width="${slot}" height="${H - padT - padB}" fill="transparent" data-tip="${tipHtml}" tabindex="0" aria-label="${esc(`${s.label}: ${s.ai} über KI, ${s.manual} manuell`)}" class="focus:outline-none"/>
        <text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" class="fill-slate-500" font-size="11">${esc(s.label)}</text>
      </g>`;
    }).join("");
    return `<svg viewBox="0 0 ${W} ${H}" class="h-auto w-full" role="img" aria-label="Buchungen pro Zeitraum, gestapelt nach KI-Agent und manuell">
      ${ticks.map((t) => `<line x1="${padL}" x2="${W}" y1="${y(t)}" y2="${y(t)}" stroke="#f1f5f9"/><text x="${padL - 8}" y="${y(t) + 4}" text-anchor="end" font-size="11" class="fill-slate-400">${t}</text>`).join("")}
      ${bars}
    </svg>`;
  }

  function renderBerichte() {
    const root = $("#view-berichte");
    const d = R.data;
    const t = d.totals;
    const chMax = Math.max(1, ...d.channels.map((c) => c.value));
    const typeSum = Math.max(1, d.byType.reduce((s, x) => s + x.value, 0));
    const heatMax = Math.max(1, ...d.heatmap.flat());
    const days = ["Mo", "Di", "Mi", "Do", "Fr"];
    root.innerHTML = pageHead("berichte-title", "Berichte", "Was CalenSync für dich bringt",
      "Buchungen, Kanäle und No-Shows im Zeitverlauf. Alle Auswertungen laufen in Frankfurt, ohne Tracking-Dienste.",
      `<div class="inline-flex rounded-lg border border-slate-200 bg-white p-0.5" role="group" aria-label="Zeitraum">
         ${[7, 30, 90].map((n) => `<button type="button" class="seg ${R.days === n ? "seg-active" : ""}" data-r-days="${n}" aria-pressed="${R.days === n}">${n} Tage</button>`).join("")}
       </div>
       <button type="button" class="btn-ghost gap-2" data-r-export>${svg(I.download)}CSV-Export</button>`) + `
      <div class="mb-6 grid grid-cols-2 gap-3 xl:grid-cols-4">
        ${statCard("Buchungen", num(t.bookings), `${delta(t.bookings, t.prevBookings)} ggü. Vorzeitraum`)}
        ${statCard("No-Show-Quote", `${num(t.noShowRate, 1)} %`, `${delta(t.noShowRate, t.prevNoShowRate, true, "pt")} seit SMS-Erinnerungen`)}
        ${statCard("Ø Vorlauf", `${num(t.leadTimeDays, 1)} Tage`, "zwischen Buchung und Termin")}
        ${statCard("Über den KI-Agenten", `${num(t.aiShare)} %`, "aller Buchungen")}
      </div>
      <div class="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section class="card min-w-0" aria-labelledby="r-chart-title">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h2 id="r-chart-title" class="font-display text-base font-bold text-slate-900">Buchungen ${R.days <= 7 ? "pro Tag" : "pro Woche"}</h2>
              <p class="text-xs text-slate-500">Letzte ${R.days} Tage</p>
            </div>
            <ul class="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600" aria-label="Legende">
              <li class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm ${SERIES.ai.cls}"></span>${SERIES.ai.label}</li>
              <li class="flex items-center gap-1.5"><span class="h-2.5 w-2.5 rounded-sm ${SERIES.manual.cls}"></span>${SERIES.manual.label}</li>
            </ul>
          </div>
          <div class="px-3 pb-2 pt-4 sm:px-5">${barChart(d.series, Math.round(Math.min(640, Math.max(300, root.clientWidth - 40))))}</div>
          <details class="border-t border-slate-100 px-5 py-3 text-xs text-slate-600">
            <summary class="cursor-pointer font-medium text-slate-700 hover:text-slate-900">Als Tabelle anzeigen</summary>
            <table class="mt-2 w-full text-left">
              <thead class="text-slate-500"><tr><th class="py-1 font-medium">Zeitraum</th><th class="py-1 text-right font-medium">KI-Agent</th><th class="py-1 text-right font-medium">Manuell</th><th class="py-1 text-right font-medium">Gesamt</th></tr></thead>
              <tbody class="tabular">${d.series.map((s) => `<tr class="border-t border-slate-100"><td class="py-1">${esc(s.label)}</td><td class="py-1 text-right">${s.ai}</td><td class="py-1 text-right">${s.manual}</td><td class="py-1 text-right font-medium text-slate-900">${s.ai + s.manual}</td></tr>`).join("")}</tbody>
            </table>
          </details>
        </section>

        <section class="card" aria-labelledby="r-channels-title">
          <div class="border-b border-slate-100 px-5 py-4">
            <h2 id="r-channels-title" class="font-display text-base font-bold text-slate-900">Woher die Buchungen kommen</h2>
            <p class="text-xs text-slate-500">Kanäle im Zeitraum</p>
          </div>
          <ul class="space-y-3.5 px-5 py-5">
            ${d.channels.map((c) => `<li data-tip="${esc(`<b>${c.label}</b><br>${c.value} Buchungen · ${num((c.value / Math.max(1, t.bookings)) * 100)} %`)}">
              <div class="mb-1 flex items-baseline justify-between gap-2 text-sm"><span class="text-slate-700">${esc(c.label)}</span><span class="tabular font-semibold text-slate-900">${num(c.value)}</span></div>
              <div class="h-2 rounded-full bg-slate-100" aria-hidden="true"><div class="h-full rounded-full bg-indigo-600" style="width:${(c.value / chMax) * 100}%"></div></div>
            </li>`).join("")}
          </ul>
        </section>

        <section class="card min-w-0" aria-labelledby="r-heat-title">
          <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-5 py-4">
            <div>
              <h2 id="r-heat-title" class="font-display text-base font-bold text-slate-900">Beliebteste Zeiten</h2>
              <p class="text-xs text-slate-500">Gebuchte Termine nach Wochentag und Uhrzeit</p>
            </div>
            <div class="flex items-center gap-1.5 text-[11px] text-slate-500" aria-hidden="true">weniger${HEAT.slice(1).map((h) => `<span class="h-3 w-3 rounded-sm" style="background:${h}"></span>`).join("")}mehr</div>
          </div>
          <div class="relative overflow-x-auto px-5 py-5">
            <table class="w-full min-w-[480px] border-separate text-[11px] text-slate-500" style="border-spacing:3px">
              <caption class="sr-only">Termine pro Wochentag und Stunde</caption>
              <thead><tr><th></th>${Array.from({ length: 10 }, (_, h) => `<th class="tabular pb-1 font-normal" scope="col">${String(8 + h).padStart(2, "0")}</th>`).join("")}</tr></thead>
              <tbody>${d.heatmap.map((row, di) => `<tr><th class="pr-2 text-left font-medium" scope="row">${days[di]}</th>${row.map((v, h) => {
                const lvl = v === 0 ? 0 : Math.min(HEAT.length - 1, 1 + Math.floor((v / heatMax) * (HEAT.length - 1.01)));
                return `<td class="h-7 rounded-md" style="background:${HEAT[lvl]}" tabindex="0" data-tip="${esc(`<b>${days[di]}, ${8 + h}–${9 + h} Uhr</b><br>${v} Termine`)}"><span class="sr-only">${v}</span></td>`;
              }).join("")}</tr>`).join("")}</tbody>
            </table>
          </div>
        </section>

        <section class="card" aria-labelledby="r-types-title">
          <div class="border-b border-slate-100 px-5 py-4">
            <h2 id="r-types-title" class="font-display text-base font-bold text-slate-900">Nach Event-Typ</h2>
            <p class="text-xs text-slate-500">Aktive Typen im Zeitraum</p>
          </div>
          ${d.byType.length ? `<div class="px-5 pt-5"><div class="flex h-3 gap-0.5 overflow-hidden rounded-full" aria-hidden="true">${d.byType.map((x) => `<span class="${(COLOR[x.color] || COLOR.indigo).bar}" style="width:${(x.value / typeSum) * 100}%"></span>`).join("")}</div></div>
          <ul class="space-y-2.5 px-5 py-5 text-sm">${d.byType.map((x) => `<li class="flex items-center justify-between gap-2"><span class="flex items-center gap-2 text-slate-700"><span class="h-2.5 w-2.5 rounded-sm ${(COLOR[x.color] || COLOR.indigo).dot}"></span>${esc(x.name)}</span><span class="tabular text-slate-900"><b>${num(x.value)}</b> <span class="text-slate-500">· ${num((x.value / typeSum) * 100)} %</span></span></li>`).join("")}</ul>`
            : '<p class="px-5 py-8 text-sm text-slate-500">Kein Event-Typ aktiv.</p>'}
        </section>
      </div>${demoNote}`;
  }

  async function loadBerichte() {
    R.data = await API.getReport(R.days);
    renderBerichte();
  }
  let resizeT;
  window.addEventListener("resize", () => { clearTimeout(resizeT); resizeT = setTimeout(() => { if (current === "berichte" && R.data) renderBerichte(); }, 200); });
  function initBerichte() {
    const root = $("#view-berichte");
    root.addEventListener("click", async (e) => {
      const b = e.target.closest("[data-r-days]");
      if (b) { R.days = +b.dataset.rDays; return loadBerichte(); }
      if (e.target.closest("[data-r-export]")) {
        const d = R.data;
        download(`calensync-bericht-${R.days}-tage.csv`, [["Zeitraum", "KI-Agent", "Manuell", "Gesamt"], ...d.series.map((s) => [s.label, s.ai, s.manual, s.ai + s.manual]), [], ["Kanal", "Buchungen"], ...d.channels.map((c) => [c.label, c.value]), [], ["Event-Typ", "Buchungen"], ...d.byType.map((x) => [x.name, x.value])]);
        toast("CSV wird heruntergeladen");
      }
    });
    return loadBerichte();
  }

  // =====================================================================
  // Router
  // =====================================================================
  const VIEWS = { kunden: { init: initKunden }, "event-typen": { init: initEventTypes }, berichte: { init: initBerichte } };
  const TITLES = { overview: "Dashboard", kunden: "Kunden", "event-typen": "Event-Typen", berichte: "Berichte" };
  let current = null;

  async function show(name, { scroll = true } = {}) {
    if (!VIEWS[name]) name = "overview";
    $$("[data-view]").forEach((el) => { el.hidden = el.dataset.view !== name; });
    if (name !== "overview") {
      $$("#side-nav .nav-item").forEach((l) => l.classList.toggle("nav-item-active", l.getAttribute("href") === `#${name}`));
      if (!VIEWS[name].ready) { VIEWS[name].ready = VIEWS[name].init(); }
      await VIEWS[name].ready;
      if (scroll && current !== name) window.scrollTo({ top: 0 });
    }
    $$("#mobile-nav .nav-pill").forEach((l) => {
      const h = l.getAttribute("href").slice(1);
      const on = name === "overview" ? h === "kpis" : h === name;
      l.classList.toggle("bg-indigo-50", on); l.classList.toggle("text-indigo-800", on);
    });
    document.title = `${TITLES[name]} – CalenSync`;
    current = name;
  }

  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (VIEWS[h]) return show(h);
    const wasHidden = current && current !== "overview";
    show("overview");
    if (wasHidden) {
      $$("#side-nav [data-overview-link]").forEach((l) => l.classList.toggle("nav-item-active", l.getAttribute("href") === `#${h || "kpis"}`));
      const el = h && document.getElementById(h);
      requestAnimationFrame(() => (el ? el.scrollIntoView({ block: "start" }) : window.scrollTo({ top: 0 })));
    }
  }
  window.addEventListener("hashchange", route);

  // Tour und „Neuer Termin“ arbeiten auf der Übersicht → vorher umschalten (Capture, läuft vor deren Handlern)
  document.addEventListener("click", (e) => {
    if (current === "overview") return;
    if (e.target.closest("[data-tour-start],[data-new-booking]")) {
      history.replaceState(null, "", location.pathname + location.search);
      show("overview", { scroll: false });
    }
  }, true);

  // Globale Suche → Kunden
  const search = $("#global-search");
  if (search) {
    search.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      K.q = search.value; K.filter = "all";
      if (location.hash === "#kunden" && VIEWS.kunden.ready) renderKunden(); else location.hash = "kunden";
    });
  }

  window.CalenSyncViews = { show };
  route();
})();
