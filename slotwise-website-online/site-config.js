/*
 * Slotwise – Laufzeit-Konfiguration der Website (ohne Neubau änderbar).
 * Leere Firmenangaben → Entwurfs-Banner oben auf jeder Seite + noindex.
 * Sobald alle VITE_COMPANY_*-Felder gefüllt sind, verschwinden Banner und noindex automatisch.
 */
window.SLOTWISE_ENV = {
  // "1", sobald app.slotwise.app erreichbar ist: App-Links führen dann wieder zur App statt zur Warteliste.
  VITE_APP_LIVE: "0",
  VITE_APP_URL: "https://app.slotwise.app",
  VITE_DEMO_PHONE: "",          // z. B. "+49 211 1234567" → „Demo anrufen“-Button auf /ki-agent

  VITE_COMPANY_NAME: "",        // z. B. "Slotwise GmbH"
  VITE_COMPANY_STREET: "",
  VITE_COMPANY_CITY: "",        // z. B. "40213 Düsseldorf"
  VITE_COMPANY_EMAIL: "",
  VITE_COMPANY_PHONE: "",
  VITE_COMPANY_REPRESENTATIVE: "",
  VITE_COMPANY_REGISTER: "",    // z. B. "Amtsgericht Düsseldorf, HRB 12345"
  VITE_COMPANY_VAT_ID: "",
  VITE_COMPANY_DPO: "",         // optional

  // CalenSync Enterprise (Backend in 3-enterprise/): Microsoft-365-Anbindung im Dashboard.
  // Alle fünf Werte sind öffentlich (kein Secret). Leer = Anbindung aus, das Dashboard bleibt wie bisher.
  // Redirect-URI in der Entra-SPA-App: https://<diese-domain>/auth/callback
  // Diese Domain muss im Backend in cors_allowed_origins stehen (tfvars), kein "*".
  CALENSYNC_API: "",              // z. B. "https://acme.calensync.de"
  ENTRA_TENANT_ID: "",            // Verzeichnis-ID (GUID) des Kunden-Tenants
  ENTRA_SPA_CLIENT_ID: "",        // Anwendungs-ID der SPA-App fürs Dashboard
  CALENSYNC_API_SCOPE: "",        // z. B. "api://calensync-acme/Sync.Read"
  CALENSYNC_API_WRITE_SCOPE: "",  // z. B. "api://calensync-acme/Sync.Write"
};
