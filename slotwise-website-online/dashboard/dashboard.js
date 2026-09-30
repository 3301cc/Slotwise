/* CalenSync Dashboard – Darstellung. Daten kommen ausschließlich aus SlotwiseAPI (dashboard-data.js). */
(function () {
  "use strict";
  const API = window.SlotwiseAPI;
  const TZ = window.SLOTWISE_TZ;
  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const fmtTime = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, hour: "2-digit", minute: "2-digit" });
  const fmtDay = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
  const fmtLong = new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "long", day: "numeric", month: "long", year: "numeric" });

  function relTime(iso) {
    const m = Math.round((Date.now() - new Date(iso)) / 60000);
    if (m < 1) return "gerade eben";
    if (m < 60) return `vor ${m} Min`;
    const h = Math.round(m / 60);
    if (h < 24) return `vor ${h} Std`;
    return `vor ${Math.round(h / 24)} Tg`;
  }

  // ---------- Icons ----------
  const ICONS = {
    trend: '<path d="M3 17l6-6 4 4 8-8"/><path d="M14 7h7v7"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    layers: '<path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5"/>',
    shield: '<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
  };
  const icon = (name, cls = "h-5 w-5") =>
    `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  const TONE = {
    emerald: "border-indigo-100 bg-indigo-50 text-indigo-700",
    indigo: "border-violet-100 bg-violet-50 text-violet-700",
    slate: "border-slate-200 bg-slate-50 text-slate-700",
  };

  // ---------- 1 · KPIs ----------
  function fmtValue(m) {
    if (m.unit === "percent") return `${m.value.toLocaleString("de-DE", { maximumFractionDigits: 1 })} %`;
    if (m.unit === "hours") return `${m.value.toLocaleString("de-DE", { maximumFractionDigits: 1 })} Std`;
    return m.value.toLocaleString("de-DE");
  }
  function renderMetrics(list) {
    $("#kpi-grid").innerHTML = list.map((m) => `
      <article class="card p-5" aria-label="${esc(m.label)}">
        <div class="flex items-start justify-between gap-3">
          <p class="text-sm text-slate-500">${esc(m.label)}</p>
          <span class="grid h-9 w-9 flex-none place-items-center rounded-xl border ${TONE[m.tone]}">${icon(m.icon)}</span>
        </div>
        <p class="tabular mt-3 font-display text-3xl font-extrabold tracking-tight text-slate-900">${fmtValue(m)}</p>
        <p class="mt-1 text-xs text-slate-500">
          ${m.delta != null ? `<span class="font-semibold ${m.delta >= 0 ? "text-indigo-700" : "text-red-700"}">${m.delta >= 0 ? "+" : ""}${m.delta.toLocaleString("de-DE")}${m.unit === "percent" ? " Pkt." : m.unit === "hours" ? " Std" : ""}</span> ` : ""}${esc(m.deltaLabel || "")}
        </p>
      </article>`).join("");
  }

  // ---------- 2 · Aktivität ----------
  const KIND = {
    proposed: { dot: "bg-violet-500", ring: "ring-violet-100", label: "Vorschlag" },
    booked: { dot: "bg-indigo-500", ring: "ring-indigo-100", label: "Gebucht" },
    buffer: { dot: "bg-violet-500", ring: "ring-violet-100", label: "Puffer" },
    conflict: { dot: "bg-red-500", ring: "ring-red-100", label: "Konflikt verhindert" },
    info: { dot: "bg-slate-400", ring: "ring-slate-100", label: "Info" },
  };
  function activityItem(a, fresh = false) {
    const k = KIND[a.kind] || KIND.info;
    const li = document.createElement("li");
    li.className = `flex gap-3 px-5 py-3.5 ${fresh ? "feed-enter" : ""}`;
    li.dataset.id = a.id;
    li.innerHTML = `
      <span class="mt-1.5 h-2.5 w-2.5 flex-none rounded-full ${k.dot} ring-4 ${k.ring}" aria-hidden="true"></span>
      <div class="min-w-0 flex-1">
        <p class="text-sm leading-relaxed text-slate-800">${esc(a.text)}</p>
        <p class="mt-1 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
          <span class="font-medium text-slate-500">${k.label}</span><span aria-hidden="true">·</span>
          <time datetime="${esc(a.at)}" title="${esc(new Date(a.at).toLocaleString("de-DE", { timeZone: TZ }))}">${relTime(a.at)}</time>
          ${a.ref ? `<span aria-hidden="true">·</span><button type="button" class="link-slot underline-offset-2 hover:underline hover:text-slate-900" data-ref="${esc(a.ref.type)}:${esc(a.ref.id)}">Im Kalender zeigen</button>` : ""}
        </p>
      </div>`;
    return li;
  }
  function renderActivity(list) {
    const ol = $("#activity-list");
    ol.innerHTML = "";
    list.forEach((a) => ol.appendChild(activityItem(a)));
  }

  // ---------- 3 · Wochenkalender ----------
  const DAY_START = 8, DAY_END = 18, PX_PER_HOUR = 48;
  const KIND_SLOT = {
    booked: "bg-indigo-600 text-white border-indigo-700",
    proposed: "bg-violet-50 text-violet-900 border-dashed border-violet-400",
    blocked: "bg-slate-100 text-slate-600 border-slate-300",
  };
  const SOURCE = { manual: "manuell", ai: "KI-Agent", google: "Google Kalender", icloud: "iCloud", microsoft: "Microsoft 365" };
  let weekData = null;

  function berlinParts(iso) {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-GB", { timeZone: TZ, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" }).formatToParts(new Date(iso)).map((x) => [x.type, x.value]));
    return { day: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].indexOf(p.weekday), min: Number(p.hour) * 60 + Number(p.minute) };
  }
  function renderWeek(data) {
    weekData = data;
    const start = new Date(data.start);
    const days = Array.from({ length: 5 }, (_, i) => { const d = new Date(start); d.setDate(d.getDate() + i); return d; });
    const end = new Date(days[4]);
    $("#cal-range").textContent = `${fmtDay.format(days[0])} – ${fmtDay.format(end)} · Zeiten in ${TZ}`;
    const todayIdx = berlinParts(new Date().toISOString()).day;
    const hours = Array.from({ length: DAY_END - DAY_START + 1 }, (_, i) => DAY_START + i);
    const height = (DAY_END - DAY_START) * PX_PER_HOUR;
    const nowMin = berlinParts(new Date().toISOString()).min;

    const cols = days.map((d, i) => {
      const slots = data.slots.filter((s) => berlinParts(s.start).day === i);
      const blocks = slots.map((s) => {
        const a = berlinParts(s.start).min, b = berlinParts(s.end).min;
        const top = ((a - DAY_START * 60) / 60) * PX_PER_HOUR, h = Math.max(14, ((b - a) / 60) * PX_PER_HOUR - 2);
        const label = `${s.title}${s.with ? ` mit ${s.with}` : ""}, ${fmtTime.format(new Date(s.start))}–${fmtTime.format(new Date(s.end))}, ${KINDLABEL[s.kind]}`;
        return `<button type="button" data-slot="${esc(s.id)}" aria-label="${esc(label)}"
          class="slot absolute left-1 right-1 overflow-hidden rounded-md border px-1.5 text-left text-[11px] leading-tight ${KIND_SLOT[s.kind]}"
          style="top:${top}px;height:${h}px">
          <span class="block truncate font-semibold">${esc(s.title)}</span>${h >= 28 ? `<span class="block truncate opacity-80">${esc(s.with || SOURCE[s.source] || "")}</span>` : ""}
        </button>`;
      }).join("");
      const nowLine = i === todayIdx && nowMin >= DAY_START * 60 && nowMin <= DAY_END * 60
        ? `<div class="pointer-events-none absolute left-0 right-0 z-10 border-t-2 border-red-500" style="top:${((nowMin - DAY_START * 60) / 60) * PX_PER_HOUR}px" aria-hidden="true"><span class="absolute -left-1 -top-[5px] h-2 w-2 rounded-full bg-red-500"></span></div>` : "";
      return `<div class="relative border-l border-slate-100" style="height:${height}px" role="gridcell" aria-label="${esc(fmtDay.format(d))}">${hours.slice(0, -1).map((_, k) => `<div class="absolute left-0 right-0 border-t border-slate-100" style="top:${k * PX_PER_HOUR}px" aria-hidden="true"></div>`).join("")}${nowLine}${blocks}</div>`;
    }).join("");

    $("#week-grid").innerHTML = `
      <div class="grid grid-cols-[52px_repeat(5,minmax(0,1fr))] border-b border-slate-100 text-center text-xs" role="row">
        <div></div>${days.map((d, i) => `<div class="py-2 ${i === todayIdx ? "text-slate-900" : "text-slate-500"}" role="columnheader">
          <span class="block font-medium">${esc(new Intl.DateTimeFormat("de-DE", { timeZone: TZ, weekday: "short" }).format(d))}</span>
          <span class="tabular inline-grid h-6 w-6 place-items-center rounded-full ${i === todayIdx ? "bg-indigo-600 font-bold text-white" : ""}">${d.getDate()}</span></div>`).join("")}
      </div>
      <div class="grid grid-cols-[52px_repeat(5,minmax(0,1fr))]" role="grid" aria-label="Wochenkalender">
        <div class="relative" style="height:${height}px" aria-hidden="true">${hours.map((h, k) => `<span class="tabular absolute right-2 -translate-y-1/2 text-[11px] text-slate-500" style="top:${k * PX_PER_HOUR}px">${String(h).padStart(2, "0")}:00</span>`).join("")}</div>
        ${cols}
      </div>`;
  }
  const KINDLABEL = { booked: "gebucht", proposed: "KI-Vorschlag, wartet auf Freigabe", blocked: "blockiert" };

  function showSlot(id) {
    const s = weekData && weekData.slots.find((x) => x.id === id);
    const box = $("#slot-detail");
    if (!s) { box.classList.add("hidden"); return; }
    document.querySelectorAll(".slot").forEach((el) => el.classList.toggle("ring-2", el.dataset.slot === id));
    box.classList.remove("hidden");
    box.innerHTML = `
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p class="font-semibold text-slate-900">${esc(s.title)}${s.with ? ` <span class="font-normal text-slate-500">mit ${esc(s.with)}</span>` : ""}</p>
          <p class="tabular mt-0.5 text-slate-700">${esc(fmtLong.format(new Date(s.start)))}, ${fmtTime.format(new Date(s.start))}–${fmtTime.format(new Date(s.end))} Uhr</p>
          <p class="mt-0.5 text-xs text-slate-500">${KINDLABEL[s.kind]} · Quelle: ${SOURCE[s.source] || "–"}</p>
        </div>
        ${s.kind === "proposed" ? `<div class="flex gap-2">
          <button type="button" class="btn-primary" data-approve="${esc(s.id)}">Freigeben</button>
          <button type="button" class="btn-ghost" data-reject="${esc(s.id)}">Ablehnen</button></div>` : `<button type="button" class="btn-ghost" data-close>Schließen</button>`}
      </div>`;
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }

  // ---------- 4 · KI-Einstellungen ----------
  function fillSettings(s) {
    const f = $("#agent-form");
    f.autonomy.value = s.autonomy;
    f.maxPerDay.value = s.maxPerDay;
    f.instructions.value = s.instructions || "";
    syncRange(); syncCount();
  }
  function syncRange() { $("#maxPerDayValue").textContent = $("#maxPerDay").value; }
  function syncCount() { $("#instructionsCount").textContent = `${$("#instructions").value.length} / 600`; }
  function readSettings() {
    const f = $("#agent-form");
    return { autonomy: f.autonomy.value, maxPerDay: Number(f.maxPerDay.value), instructions: f.instructions.value.trim() };
  }

  // ---------- Verdrahtung ----------
  async function init() {
    $("#greeting-date").textContent = fmtLong.format(new Date());
    const status = await API.status();
    const mode = $("#mode-note");
    if (API.live) {
      mode.innerHTML = `<span class="rounded bg-indigo-800 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-indigo-50">Live</span>Feed, Kalender und Einstellungen kommen vom Agenten${status && status.model ? ` (Modell: ${esc(status.model)})` : ""}.`;
      mode.className = "inline-flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900";
    } else if (status && !status.ready) {
      mode.innerHTML = `<span class="rounded bg-amber-900 px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wider text-amber-50">Demo</span>Agent noch nicht eingerichtet (fehlt: ${esc(status.missing.join(", "))}). Beispieldaten.`;
    }
    const [metrics, activity, week, settings] = await Promise.all([API.getMetrics(), API.getActivity(), API.getWeek(), API.getSettings()]);
    renderMetrics(metrics); renderActivity(activity); renderWeek(week); fillSettings(settings);

    API.subscribeActivity((a) => {
      const ol = $("#activity-list");
      ol.prepend(activityItem(a, true));
      while (ol.children.length > 8) ol.lastElementChild.remove();
    });

    document.addEventListener("click", (e) => {
      const slot = e.target.closest("[data-slot]"); if (slot) return showSlot(slot.dataset.slot);
      const link = e.target.closest(".link-slot");
      if (link) {
        const [type, id] = link.dataset.ref.split(":");
        const target = type === "slot" ? id : (weekData.slots.find((s) => s.kind === "proposed") || {}).id;
        if (target) { $("#kalender").scrollIntoView({ behavior: "smooth", block: "start" }); showSlot(target); }
        return;
      }
      if (e.target.closest("[data-close]")) return $("#slot-detail").classList.add("hidden");
      const ok = e.target.closest("[data-approve]"), no = e.target.closest("[data-reject]");
      if (ok || no) {
        const id = (ok || no).dataset.approve || (ok || no).dataset.reject;
        const s = weekData.slots.find((x) => x.id === id);
        API.decide(id, ok ? "approve" : "reject").then(() => {
          if (ok) s.kind = "booked"; else weekData.slots = weekData.slots.filter((x) => x.id !== id);
          renderWeek(weekData); $("#slot-detail").classList.add("hidden");
          if (!API.live) $("#activity-list").prepend(activityItem({ id: `u${Date.now()}`, kind: ok ? "booked" : "info", at: new Date().toISOString(),
            text: ok ? `Du hast den Vorschlag „${s.title}${s.with ? ` mit ${s.with}` : ""}“ freigegeben – Bestätigung geht raus` : `Vorschlag „${s.title}“ abgelehnt – der Agent bietet eine Alternative an` }, true));
        }).catch(() => { $("#slot-detail").insertAdjacentHTML("beforeend", '<p class="mt-2 text-xs text-red-700">Das hat nicht geklappt. Bitte noch einmal versuchen.</p>'); });
      }
    });

    $("#maxPerDay").addEventListener("input", syncRange);
    $("#instructions").addEventListener("input", syncCount);
    $("#agent-form").addEventListener("submit", async (e) => {
      e.preventDefault();
      const btn = $("#save-btn"), st = $("#save-status");
      btn.disabled = true; st.textContent = "Wird gespeichert …";
      try {
        const saved = await API.saveSettings(readSettings());
        st.textContent = `Gespeichert, ${fmtTime.format(new Date(saved.updatedAt))} Uhr`;
      } catch { st.textContent = "Speichern fehlgeschlagen. Bitte noch einmal versuchen."; }
      btn.disabled = false;
    });

    // Seitenleiste: aktiven Bereich beim Scrollen markieren
    const navLinks = [...document.querySelectorAll("#side-nav .nav-item[href^='#']")];
    const io = new IntersectionObserver((entries) => {
      entries.filter((e) => e.isIntersecting).forEach((e) => navLinks.forEach((l) => l.classList.toggle("nav-item-active", l.getAttribute("href") === `#${e.target.id}`)));
    }, { rootMargin: "-40% 0px -55% 0px" });
    ["kpis", "kalender", "feed", "ki-panel"].forEach((id) => { const el = document.getElementById(id); if (el) io.observe(el); });
    document.querySelectorAll("[data-new-booking]").forEach((b) => b.addEventListener("click", () => {
      $("#kalender").scrollIntoView({ behavior: "smooth", block: "start" });
      const first = weekData.slots.find((s) => s.kind === "proposed"); if (first) showSlot(first.id);
    }));

    setInterval(() => document.querySelectorAll("#activity-list time").forEach((t) => { t.textContent = relTime(t.getAttribute("datetime")); }), 60000);
  }
  init().catch((err) => { console.error(err); $("#main").insertAdjacentHTML("afterbegin", '<p class="mb-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800">Daten konnten nicht geladen werden.</p>'); });
})();
