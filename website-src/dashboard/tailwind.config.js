/** Tailwind-Konfiguration für das Dashboard – Tokens wie auf der Website (Inter, Plus Jakarta Sans, Indigo). */
module.exports = {
  content: ["../../slotwise-website-online/dashboard/index.html", "../../slotwise-website-online/dashboard/dashboard.js", "../../slotwise-website-online/dashboard/views.js"],
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Plus Jakarta Sans", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(15,23,42,.03), 0 1px 3px rgba(15,23,42,.04)",
        ambient: "0 1px 2px rgba(15,23,42,.03), 0 24px 48px -24px rgba(15,23,42,.14)",
      },
      keyframes: {
        "pulse-ring": { "0%": { boxShadow: "0 0 0 0 rgba(99,102,241,.45)" }, "100%": { boxShadow: "0 0 0 6px rgba(99,102,241,0)" } },
        "feed-in": { from: { opacity: 0, transform: "translateY(-6px)" }, to: { opacity: 1, transform: "none" } },
      },
      animation: { "pulse-ring": "pulse-ring 2s ease-out infinite", "feed-in": "feed-in .4s ease-out" },
    },
  },
  plugins: [],
};
