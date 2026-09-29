/**
 * STW-301 · Automatisierter Datenschutz-Nachweis für das Embed.
 *
 * Aufruf:
 *   EMBED_URL=https://termine.nordlicht.de/jana?embed=1 \
 *   ALLOWED_HOSTS=termine.nordlicht.de \
 *   npx playwright test -c audit/playwright.config.ts
 *
 * Der Test schlägt fehl, sobald
 *   - irgendein Cookie gesetzt wird (Set-Cookie oder document.cookie),
 *   - eine Netzwerkanfrage einen Host außerhalb ALLOWED_HOSTS erreicht,
 *   - localStorage benutzt wird oder sessionStorage andere Keys als die erlaubten enthält,
 *   - die Sicherheitsheader fehlen,
 *   - die Buchung mit blockierten Drittanbieter-Cookies oder im privaten Modus nicht funktioniert.
 * Der HTML-Report unter audit/report/ ist der veröffentlichte Nachweis.
 */
import { expect, test, type Page, type Request } from '@playwright/test';

const EMBED_URL = process.env.EMBED_URL ?? 'http://localhost:3000/jana?embed=1';
const ALLOWED_HOSTS = (process.env.ALLOWED_HOSTS ?? new URL(EMBED_URL).host).split(',').map((h) => h.trim());
const ALLOWED_SESSION_KEYS = ['slotwise.bookerTz', 'slotwise.draft'];

function collectRequests(page: Page) {
  const external: string[] = [];
  const all: string[] = [];
  page.on('request', (req: Request) => {
    const url = new URL(req.url());
    all.push(url.href);
    if (url.protocol === 'data:' || url.protocol === 'blob:' || url.protocol === 'about:') return;
    if (!ALLOWED_HOSTS.includes(url.host)) external.push(url.href);
  });
  return { external, all };
}

test.describe('Cookie-freies Embed', () => {
  test('setzt keine Cookies, lädt nichts von fremden Hosts, nutzt keinen persistenten Speicher', async ({ page, context }) => {
    const { external, all } = collectRequests(page);
    const setCookieHeaders: string[] = [];
    page.on('response', async (res) => {
      const h = res.headers()['set-cookie'];
      if (h) setCookieHeaders.push(`${res.url()} => ${h}`);
    });

    const response = await page.goto(EMBED_URL, { waitUntil: 'networkidle' });
    expect(response?.ok(), 'Embed-Seite antwortet mit 2xx').toBeTruthy();

    // Sicherheitsheader
    const headers = response!.headers();
    expect(headers['content-security-policy'], 'CSP vorhanden').toContain("default-src 'self'");
    expect(headers['content-security-policy']).toContain('frame-ancestors');
    expect(headers['referrer-policy']).toBe('no-referrer');
    expect(headers['x-content-type-options']).toBe('nosniff');
    expect(headers['cache-control']).toContain('no-store');

    // Interaktion, die den vollständigen Buchungspfad auslöst (Slot wählen, bestätigen)
    await page.getByRole('gridcell', { name: /Oktober|November|Dezember|Januar|Februar|März|April|Mai|Juni|Juli|August|September/ }).first().click();
    const slot = page.getByRole('button', { name: /^\d{2}:\d{2}/ }).first();
    await slot.click();
    await page.waitForTimeout(500);

    // 1. Cookies
    expect(setCookieHeaders, 'Kein Set-Cookie-Header').toEqual([]);
    expect(await context.cookies(), 'Kein Cookie im Kontext').toEqual([]);
    expect(await page.evaluate(() => document.cookie), 'document.cookie leer').toBe('');

    // 2. Netzwerk
    expect(all.length, 'Requests wurden beobachtet').toBeGreaterThan(0);
    expect(external, 'Keine Anfragen außerhalb der Kundendomain').toEqual([]);

    // 3. Speicher
    const storage = await page.evaluate(() => ({
      local: Object.keys(localStorage),
      session: Object.keys(sessionStorage),
      idb: typeof indexedDB !== 'undefined',
    }));
    expect(storage.local, 'localStorage unbenutzt').toEqual([]);
    for (const key of storage.session) expect(ALLOWED_SESSION_KEYS, `sessionStorage-Key erlaubt: ${key}`).toContain(key);

    // 4. Keine Third-Party-Skripte im DOM (auch nicht per CSP geblockte Tags)
    const scriptSrcs = await page.$$eval('script[src]', (els) => els.map((e) => (e as HTMLScriptElement).src));
    for (const src of scriptSrcs) expect(ALLOWED_HOSTS, `Script-Host erlaubt: ${src}`).toContain(new URL(src).host);
    const linkHrefs = await page.$$eval('link[href]', (els) => els.map((e) => (e as HTMLLinkElement).href));
    for (const href of linkHrefs) expect(ALLOWED_HOSTS, `Stylesheet-/Font-Host erlaubt: ${href}`).toContain(new URL(href).host);
  });

  test('Buchung funktioniert im Iframe mit blockierten Drittanbieter-Cookies', async ({ browser }) => {
    // Chromium-Projekt in playwright.config.ts startet mit --block-third-party-cookies.
    const context = await browser.newContext({ storageState: undefined });
    const page = await context.newPage();
    const parentOrigin = 'https://www.example-kunde.de';
    // Einbettende Seite simulieren: Iframe auf die Embed-URL, wie im host-snippet.
    await page.setContent(`<!doctype html><html><body>
      <iframe id="f" src="${EMBED_URL}&parent=${encodeURIComponent(parentOrigin)}" style="width:900px;height:800px;border:0"></iframe>
    </body></html>`, { waitUntil: 'domcontentloaded' });
    const frame = page.frameLocator('#f');
    await expect(frame.getByRole('grid')).toBeVisible({ timeout: 15_000 });
    await frame.getByRole('button', { name: /^\d{2}:\d{2}/ }).first().click();
    await expect(frame.getByRole('button', { name: /Termin bestätigen/ })).toBeVisible();
    expect(await context.cookies()).toEqual([]);
    await context.close();
  });

  test('Privater Modus: sessionStorage blockiert, Widget bleibt benutzbar', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(window, 'sessionStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
      Object.defineProperty(window, 'localStorage', { get() { throw new DOMException('blocked', 'SecurityError'); } });
    });
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(EMBED_URL, { waitUntil: 'networkidle' });
    await expect(page.getByRole('grid')).toBeVisible();
    expect(errors, 'Keine unbehandelten Fehler ohne Storage').toEqual([]);
  });
});
