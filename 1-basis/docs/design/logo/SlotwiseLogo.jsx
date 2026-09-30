import React from "react";

/**
 * Slotwise logo (Richtung 2a – Kalenderblatt mit gebuchtem Slot + KI-Live-Punkt)
 * <SlotwiseLogo />                      Mark + Wortmarke
 * <SlotwiseLogo variant="mark" />       nur Symbol
 * <SlotwiseLogo theme="dark" size={40} />
 * <SlotwiseLogo claim="Terminbuchung mit KI-Agent" />
 */
const THEMES = {
  light: { bg: "#059669", pin: "#1e293b", bar: "#ffffff", slot: "#ffffff", dot: "#059669", live: "#10b981", ring: "#f8fafc", ink: "#1e293b", muted: "#64748b" },
  dark:  { bg: "#10b981", pin: "#f8fafc", bar: "#020617", slot: "#020617", dot: "#10b981", live: "#34d399", ring: "#020617", ink: "#f8fafc", muted: "#94a3b8" },
};

export function SlotwiseMark({ size = 32, theme = "light", live = true, className = "", title = "Slotwise" }) {
  const c = THEMES[theme] ?? THEMES.light;
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role="img" aria-label={title}>
      <rect y="4" width="60" height="60" rx="16" fill={c.bg} />
      <rect x="16" y="0" width="6" height="14" rx="3" fill={c.pin} />
      <rect x="38" y="0" width="6" height="14" rx="3" fill={c.pin} />
      <rect x="12" y="22" width="36" height="6" rx="3" fill={c.bar} opacity="0.45" />
      <rect x="12" y="34" width="36" height="16" rx="5" fill={c.slot} />
      <circle cx="20" cy="42" r="3.5" fill={c.dot} />
      {live && <circle cx="56" cy="12" r="7" fill={c.live} stroke={c.ring} strokeWidth="4" />}
    </svg>
  );
}

export default function SlotwiseLogo({ size = 32, theme = "light", variant = "full", live = true, claim, className = "" }) {
  const c = THEMES[theme] ?? THEMES.light;
  if (variant === "mark") return <SlotwiseMark size={size} theme={theme} live={live} className={className} />;
  return (
    <span className={`inline-flex items-center ${className}`} style={{ gap: size * 0.3 }}>
      <SlotwiseMark size={size} theme={theme} live={live} />
      <span className="flex flex-col" style={{ gap: size * 0.1 }}>
        <span style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontWeight: 800, fontSize: size * 0.7, letterSpacing: "-0.045em", lineHeight: 1, color: c.ink }}>slotwise</span>
        {claim && <span style={{ fontFamily: "'Plus Jakarta Sans', system-ui, sans-serif", fontWeight: 600, fontSize: Math.max(11, size * 0.22), color: c.muted }}>{claim}</span>}
      </span>
    </span>
  );
}
