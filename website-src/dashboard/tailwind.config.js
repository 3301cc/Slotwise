/** Tailwind-Konfiguration für das Dashboard – Tokens wie auf der Website (Inter, Plus Jakarta Sans, Emerald). */
module.exports = {
  content: ["../../slotwise-website-online/dashboard/index.html", "../../slotwise-website-online/dashboard/dashboard.js"],
  darkMode: "class",
  theme: {
    extend: {
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "sans-serif"],
        display: ["Plus Jakarta Sans", "Inter", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(2,6,23,.4), 0 1px 3px rgba(2,6,23,.5)",
        ambient: "0 1px 2px rgba(2,6,23,.4), 0 24px 48px -24px rgba(2,6,23,.8)",
      },
      keyframes: {
        "pulse-ring": { "0%": { boxShadow: "0 0 0 0 rgba(52,211,153,.5)" }, "100%": { boxShadow: "0 0 0 6px rgba(52,211,153,0)" } },
        "feed-in": { from: { opacity: 0, transform: "translateY(-6px)" }, to: { opacity: 1, transform: "none" } },
      },
      animation: { "pulse-ring": "pulse-ring 2s ease-out infinite", "feed-in": "feed-in .4s ease-out" },
    },
  },
  plugins: [],
};
