import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADAPTER_CATALOG, catalogById } from './catalog.js';
import { assertMetadataValid, deriveTier, type AdapterMetadata } from './metadata.js';
import { AdapterRegistry, AdapterNotBoundError, EuModeViolationError, EU_MODE_MAX_TIER } from './registry.js';
import { buildDefaultRegistry } from './index.js';
import { Entitlements, loadPlansConfig, type TenantPlan } from '../entitlements/entitlements.js';
import { EuModeConflictError, IntegrationNotAllowedByPlanError, MemoryTenantIntegrationRepository, TenantIntegrationService } from './tenantIntegrations.js';
import { MemorySubprocessorSnapshotRepository, SubprocessorService, diffExports, loadPlatformConfig, validatePlatformConfig } from './subprocessorService.js';
import { buildIcs, extractCalendarData, parseVEvents, CalDavCalendarAdapter, unfold } from './impl/caldavCalendarAdapter.js';
import { JitsiVideoAdapter, verifyJwtHs256 } from './impl/jitsiVideoAdapter.js';
import { MolliePaymentAdapter, centsToMollieValue, mollieValueToCents } from './impl/molliePaymentAdapter.js';
import { ProviderRateLimitError } from '../booking/errors.js';

const plans = loadPlansConfig();
const ent = new Entitlements(plans);

// ---------------------------------------------------------------------------
// Metadaten und Katalog
// ---------------------------------------------------------------------------

test('Stufe wird aus Sitz und Hosting abgeleitet', () => {
  assert.equal(deriveTier('DE', ['DE']), 1);
  assert.equal(deriveTier('NL', ['NL', 'IE']), 1);
  assert.equal(deriveTier('US', ['DE']), 2);
  assert.equal(deriveTier('US', ['DE', 'US']), 3);
  assert.equal(deriveTier('DE', ['US']), 3);
  assert.equal(deriveTier('DE', []), 3, 'ohne Hosting-Angabe keine Stufe 1');
});

test('Katalog: jeder Eintrag valide, Stufen identisch mit plans.json, alle plans.json-Integrationen vorhanden', () => {
  const byId = catalogById();
  for (const m of ADAPTER_CATALOG) assert.doesNotThrow(() => assertMetadataValid(m), m.id);
  for (const i of plans.integrations) {
    const m = byId.get(i.id);
    assert.ok(m, `Katalogeintrag für ${i.id} fehlt`);
    assert.equal(m.tier, i.tier, `${i.id}: Stufe im Katalog (${m.tier}) ≠ plans.json (${i.tier})`);
    assert.equal(m.kind, i.kind, `${i.id}: kind`);
  }
  assert.equal(ADAPTER_CATALOG.length, plans.integrations.length, 'Katalog und plans.json müssen dieselbe Menge beschreiben');
});

test('Inkonsistente Metadaten werden abgewiesen', () => {
  const base = catalogById().get('mollie')!;
  assert.throws(() => assertMetadataValid({ ...base, tier: 2 }), /folgt aber Stufe 1/);
  assert.throws(() => assertMetadataValid({ ...base, owner_country: 'US', tier: 2, transfer_mechanism: 'none_required' }), /Drittlandbezug erfordert/);
  assert.throws(() => assertMetadataValid({ ...base, transfer_mechanism: 'scc' }), /ohne Drittlandbezug/);
  assert.throws(() => assertMetadataValid({ ...base, hosting_regions: [] }), /hosting_regions/);
  assert.throws(() => assertMetadataValid({ ...base, owner_country: 'BR', hosting_regions: ['BR'], tier: 3, transfer_mechanism: 'adequacy_decision' }), /ohne Angemessenheitsbeschluss/);
  assert.throws(() => assertMetadataValid({ ...base, documentation_url: 'http://insecure' }), /https/);
});

// ---------------------------------------------------------------------------
// Registry und EU-Modus
// ---------------------------------------------------------------------------

test('Registry: resolve() setzt den EU-Modus vor jedem Netzwerkaufruf durch', () => {
  const reg = buildDefaultRegistry();
  const creds = { tenantId: 't1', integrationId: 'mollie', secrets: { api_key: 'test_abcdefghijklmnopqrstuvwxyz' }, config: {} };
  const mollie = reg.resolve({ tenantId: 't1', euMode: 'strict' }, 'mollie', 'payment', creds);
  assert.equal(mollie.meta.tier, 1);

  assert.throws(
    () => reg.resolve({ tenantId: 't1', euMode: 'strict' }, 'google-calendar', 'calendar', { ...creds, integrationId: 'google-calendar' }),
    (e: unknown) => e instanceof EuModeViolationError && e.tier === 3 && e.mode === 'strict',
  );
  assert.throws(
    () => reg.resolve({ tenantId: 't1', euMode: 'balanced' }, 'zoom', 'video', { ...creds, integrationId: 'zoom' }),
    (e: unknown) => e instanceof EuModeViolationError,
  );
  // balanced erlaubt Stufe 2, aber ohne Bindung gibt es keine Instanz:
  assert.throws(
    () => reg.resolve({ tenantId: 't1', euMode: 'balanced' }, 'microsoft-365', 'calendar', { ...creds, integrationId: 'microsoft-365' }),
    (e: unknown) => e instanceof AdapterNotBoundError,
  );
  // Kategorie muss passen:
  assert.throws(() => reg.resolve({ tenantId: 't1', euMode: 'off' }, 'mollie', 'video', creds), /erwartet video/);
  // Fremde Zugangsdaten werden nicht akzeptiert:
  assert.throws(() => reg.resolve({ tenantId: 't2', euMode: 'off' }, 'mollie', 'payment', creds), /gehören nicht zu Tenant/);
});

test('Registry: allowedFor() liefert je Modus genau die zulässigen Stufen', () => {
  const reg = AdapterRegistry.withCatalog();
  for (const mode of ['strict', 'balanced', 'off'] as const) {
    const list = reg.allowedFor(mode);
    assert.ok(list.length > 0);
    assert.ok(list.every((m) => m.tier <= EU_MODE_MAX_TIER[mode]), mode);
  }
  assert.ok(reg.allowedFor('strict', 'calendar').every((m) => m.id === 'caldav'));
  assert.ok(reg.allowedFor('strict', 'payment').some((m) => m.id === 'mollie') && !reg.allowedFor('strict', 'payment').some((m) => m.id === 'stripe'));
});

function tenantSetup(planId: TenantPlan['planId'] = 'business') {
  const reg = buildDefaultRegistry();
  const repo = new MemoryTenantIntegrationRepository();
  const plan: TenantPlan = { planId, seats: 3, guestHosts: 0, euMode: 'balanced' };
  const svc = new TenantIntegrationService(reg, ent, repo, async () => plan, { now: () => new Date('2026-10-01T09:00:00Z') });
  return { reg, repo, svc, plan };
}

test('TenantIntegrationService: Plan, EU-Modus und Make-Abhängigkeit', async () => {
  const { svc, repo } = tenantSetup('business');
  await repo.setEuMode('t1', 'balanced');

  await svc.activate({ tenantId: 't1', integrationId: 'hubspot' });
  await svc.activate({ tenantId: 't1', integrationId: 'microsoft-365' });
  await assert.rejects(svc.activate({ tenantId: 't1', integrationId: 'google-calendar' }), (e: unknown) => e instanceof EuModeViolationError);
  await assert.rejects(svc.activate({ tenantId: 't1', integrationId: 'hubspot' }), /bereits verbunden/);
  await assert.rejects(svc.activate({ tenantId: 't1', integrationId: 'weclapp' }), /zuerst Make verbinden/);
  await svc.activate({ tenantId: 't1', integrationId: 'make' });
  await svc.activate({ tenantId: 't1', integrationId: 'weclapp' });

  // Wechsel auf strict scheitert mit vollständiger Konfliktliste
  await assert.rejects(svc.setEuMode('t1', 'strict', null), (e: unknown) => {
    assert.ok(e instanceof EuModeConflictError);
    assert.deepEqual(e.conflicts.map((c) => c.integrationId).sort(), ['hubspot', 'microsoft-365']);
    return true;
  });
  await svc.deactivate('t1', 'hubspot', null);
  await svc.deactivate('t1', 'microsoft-365', null);
  const s = await svc.setEuMode('t1', 'strict', null);
  assert.equal(s.euMode, 'strict');

  // Make trennen trennt weclapp mit
  await svc.deactivate('t1', 'make', null);
  const active = (await repo.listActive('t1')).map((a) => a.integrationId);
  assert.deepEqual(active, []);

  const catalog = await svc.catalogFor('t1');
  const gcal = catalog.find((c) => c.id === 'google-calendar')!;
  assert.equal(gcal.allowedByPlan, true);
  assert.equal(gcal.allowedByEuMode, false);
});

test('TenantIntegrationService: Starter darf kein HubSpot, strict braucht das Feature', async () => {
  const { svc } = tenantSetup('starter');
  await assert.rejects(svc.activate({ tenantId: 't1', integrationId: 'hubspot' }), (e: unknown) => e instanceof IntegrationNotAllowedByPlanError);
  await assert.rejects(svc.setEuMode('t1', 'strict', null), /euModeStrict/);
});

// ---------------------------------------------------------------------------
// SubprocessorService
// ---------------------------------------------------------------------------

test('platform-subprocessors.json ist valide und enthält Hosting', () => {
  const cfg = loadPlatformConfig();
  assert.ok(cfg.entries.some((e) => e.scope === 'platform' && e.category === 'hosting'));
  assert.ok(cfg.entries.every((e) => e.tier === 1), 'Plattform-Subprozessoren sind Stufe 1 (Marketing-Aussage "Plattform vollständig in der EU")');
  const broken = structuredClone(cfg);
  broken.entries = broken.entries.filter((e) => e.category !== 'hosting');
  assert.throws(() => validatePlatformConfig(broken), /Hosting-Eintrag/);
});

async function subprocessorSetup(enabled: string[] = []) {
  const { reg, repo, svc, plan } = tenantSetup('business');
  const snapshots = new MemorySubprocessorSnapshotRepository();
  let t = 0;
  const service = new SubprocessorService({
    registry: reg,
    integrations: repo,
    entitlements: ent,
    loadPlan: async () => plan,
    enabledFeatures: async () => new Set(enabled as never[]),
    snapshots,
    clock: { now: () => new Date(Date.UTC(2026, 9, 1, 9, 0, t++)) },
  });
  return { reg, repo, svc, service, snapshots };
}

test('Subprozessorenliste: Plattform immer, Funktionen nur bei Nutzung, Integrationen nach Rolle', async () => {
  const { svc, service, repo } = await subprocessorSetup(['aiAgent']);
  await repo.setEuMode('t1', 'balanced');
  await svc.activate({ tenantId: 't1', integrationId: 'hubspot' });
  await svc.activate({ tenantId: 't1', integrationId: 'jitsi' });
  await svc.activate({ tenantId: 't1', integrationId: 'caldav', config: { timezone: 'Europe/Berlin' } });

  const exp = await service.build('t1');
  const subIds = exp.subprocessors.map((s) => s.id);
  assert.ok(subIds.includes('hosting-primary') && subIds.includes('transactional-email'));
  assert.ok(subIds.includes('ai-telephony-carrier') && subIds.includes('ai-speech-llm'), 'KI-Agent aktiviert → KI-Subprozessoren');
  assert.ok(!subIds.includes('sms-gateway'), 'SMS nicht aktiviert → kein SMS-Gateway');
  assert.deepEqual(exp.customer_instructed_recipients.map((r) => r.id), ['hubspot']);
  assert.deepEqual(exp.platform_components.map((r) => r.id), ['jitsi']);
  assert.ok(!JSON.stringify(exp).includes('"caldav"'), 'eigener CalDAV-Server des Kunden erscheint nicht');
  assert.equal(exp.version_hash.length, 64);
  assert.equal(exp.eu_mode, 'balanced');
});

test('Subprozessorenliste: Snapshot, Hash-Stabilität und Änderungsmitteilung', async () => {
  const { svc, service, snapshots, repo } = await subprocessorSetup([]);
  await repo.setEuMode('t1', 'balanced');
  const first = await service.publish('t1');
  assert.equal(first.changed, true);
  assert.equal(first.diff.added.length, first.current.subprocessors.length);

  const again = await service.publish('t1');
  assert.equal(again.changed, false, 'gleicher Inhalt, anderer Zeitstempel → gleicher Hash');
  assert.equal(snapshots.saved.length, 1);

  await svc.activate({ tenantId: 't1', integrationId: 'make' });
  await svc.activate({ tenantId: 't1', integrationId: 'personio' });
  const third = await service.publish('t1');
  assert.equal(third.changed, true);
  assert.deepEqual(third.diff.added.map((a) => a.id).sort(), ['make', 'personio']);
  const notice = service.renderChangeNoticeText(third.diff, third.current);
  assert.match(notice, /\+ Make \(EU-Zone\)/);
  assert.match(notice, /\+ Personio/);

  await svc.deactivate('t1', 'make', null);
  const fourth = await service.publish('t1');
  assert.deepEqual(fourth.diff.removed.map((a) => a.id).sort(), ['make', 'personio']);
  assert.equal(diffExports(fourth.current, fourth.current).unchanged, fourth.current.subprocessors.length);
});

test('AVV-Anhang: eigenständiges HTML ohne externe Ressourcen, alle Abschnitte, Escaping', async () => {
  const { svc, service, repo } = await subprocessorSetup(['smsWorkflows']);
  await repo.setEuMode('t1', 'balanced');
  await svc.activate({ tenantId: 't1', integrationId: 'microsoft-365' });
  const exp = await service.build('t1');
  const html = service.renderAvvAnnexHtml(exp, { controllerName: 'Müller & Söhne <GmbH>', controllerAddress: 'Kö 1, Düsseldorf' });
  assert.ok(html.startsWith('<!DOCTYPE html>'));
  assert.ok(!/src="http|href="http|@import|url\(/.test(html), 'keine externen Ressourcen');
  assert.match(html, /A\. Unterauftragsverarbeiter/);
  assert.match(html, /B\. Vom Verantwortlichen verbundene Drittdienste/);
  assert.match(html, /C\. Vom Auftragsverarbeiter selbst betriebene Komponenten/);
  assert.match(html, /Microsoft 365 \/ Outlook/);
  assert.match(html, /seven\.io/);
  assert.match(html, /Müller &amp; Söhne &lt;GmbH&gt;/);
  assert.match(html, /EU-US Data Privacy Framework/);
  assert.match(html, /Vereinigte Staaten/);
  assert.match(html, /@page/);
});

// ---------------------------------------------------------------------------
// Referenz-Adapter
// ---------------------------------------------------------------------------

test('CalDAV: iCalendar parsen (TZID, UTC, ganztägig, DURATION, TRANSPARENT, CANCELLED, gefaltete Zeilen)', () => {
  const ics = [
    'BEGIN:VCALENDAR', 'VERSION:2.0',
    'BEGIN:VEVENT', 'UID:a', 'DTSTART;TZID=Europe/Berlin:20261025T013000', 'DTEND;TZID=Europe/Berlin:20261025T033000', 'SUMMARY:Über DST-Wechsel', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:b', 'DTSTART:20261008T080000Z', 'DURATION:PT45M', 'SUMMARY:Sehr langer Titel, der auf mehrere Zeilen', ' gefaltet wurde', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:c', 'DTSTART;VALUE=DATE:20261009', 'DTEND;VALUE=DATE:20261010', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:d', 'DTSTART:20261008T100000Z', 'DTEND:20261008T110000Z', 'TRANSP:TRANSPARENT', 'END:VEVENT',
    'BEGIN:VEVENT', 'UID:e', 'DTSTART:20261008T120000Z', 'DTEND:20261008T130000Z', 'STATUS:CANCELLED', 'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
  const ev = parseVEvents(ics, 'Europe/Berlin');
  assert.equal(ev.length, 5);
  const a = ev.find((e) => e.uid === 'a')!;
  // 25.10.2026 01:30 MESZ = 24.10. 23:30Z; 03:30 MEZ = 02:30Z → 3 h Wanduhr-Differenz von 2 h über den Wechsel
  assert.equal(a.start.toISOString(), '2026-10-24T23:30:00.000Z');
  assert.equal(a.end.toISOString(), '2026-10-25T02:30:00.000Z');
  const b = ev.find((e) => e.uid === 'b')!;
  assert.equal(b.end.getTime() - b.start.getTime(), 45 * 60_000);
  const c = ev.find((e) => e.uid === 'c')!;
  assert.equal(c.allDay, true);
  assert.equal(c.start.toISOString(), '2026-10-08T22:00:00.000Z');
  assert.equal(ev.find((e) => e.uid === 'd')!.transparent, true);
  assert.equal(ev.find((e) => e.uid === 'e')!.cancelled, true);
  assert.equal(unfold('A:1\r\n b\r\nC:2').join('|'), 'A:1b|C:2');
});

test('CalDAV: getFreeBusy über REPORT, 429 → ProviderRateLimitError, createEvent PUT mit If-None-Match', async () => {
  const calls: { url: string; method: string; headers: Record<string, string>; body?: string }[] = [];
  let status = 207;
  const multistatus = `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav"><d:response><d:propstat><d:prop><cal:calendar-data>BEGIN:VCALENDAR&#13;
BEGIN:VEVENT&#13;
UID:x1&#13;
DTSTART:20261008T080000Z&#13;
DTEND:20261008T090000Z&#13;
END:VEVENT&#13;
END:VCALENDAR</cal:calendar-data></d:prop></d:propstat></d:response></d:multistatus>`;
  const fetchImpl = async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, ...init });
    const s = status;
    return { status: s, headers: { get: (n: string) => (n === 'retry-after' && s === 429 ? '7' : null) }, text: async () => (s === 207 ? multistatus : '') };
  };
  const adapter = new CalDavCalendarAdapter(
    { tenantId: 't1', integrationId: 'caldav', secrets: { username: 'jana', password: 'app-pw' }, config: { timezone: 'Europe/Berlin' } },
    fetchImpl,
  );
  const conn = { id: 'c1', hostId: 'h1', provider: 'caldav' as const, externalId: 'https://cloud.example.de/remote.php/dav/calendars/jana/personal/', isPrimary: true, isBlocking: true };
  const busy = await adapter.getFreeBusy([conn], new Date('2026-10-08T00:00:00Z'), new Date('2026-10-09T00:00:00Z'));
  assert.deepEqual(busy.map((b) => b.externalEventId), ['x1']);
  assert.equal(calls[0].method, 'REPORT');
  assert.match(calls[0].headers.Authorization, /^Basic /);
  assert.match(calls[0].body!, /<c:expand start="20261008T000000Z"/);

  status = 201;
  const created = await adapter.createEvent(conn, { start: new Date('2026-10-08T10:00:00Z'), end: new Date('2026-10-08T10:30:00Z'), title: 'Beratung; Müller', description: 'Zeile 1\nZeile 2', attendeeEmail: 'k@example.de', status: 'tentative' });
  assert.match(created.externalEventId, /@slotwise\.de$/);
  const put = calls[calls.length - 1];
  assert.equal(put.method, 'PUT');
  assert.equal(put.headers['If-None-Match'], '*');
  assert.match(put.body!, /STATUS:TENTATIVE/);
  assert.match(put.body!, /SUMMARY:Beratung\\; Müller/);
  assert.match(put.body!, /DESCRIPTION:Zeile 1\\nZeile 2/);
  assert.ok(put.url.endsWith(`${encodeURIComponent(created.externalEventId)}.ics`));

  status = 429;
  await assert.rejects(adapter.getFreeBusy([conn], new Date(), new Date(Date.now() + 3600_000)), (e: unknown) => e instanceof ProviderRateLimitError && e.retryAfterMs === 7000);

  const ics = buildIcs({ uid: 'u', start: new Date('2026-10-08T10:00:00Z'), end: new Date('2026-10-08T10:30:00Z'), title: 'x'.repeat(120), description: '', attendeeEmail: '', status: 'confirmed', sequence: 1, dtstamp: new Date('2026-10-01T00:00:00Z') });
  assert.ok(ics.split('\r\n').every((l) => Buffer.byteLength(l, 'utf8') <= 75), 'Zeilen gefaltet auf 75 Oktette');
  assert.deepEqual(extractCalendarData('<x><C:calendar-data>&lt;a&gt;</C:calendar-data></x>'), ['<a>']);
});

test('Jitsi: Raum nicht erratbar, Tokens an Terminfenster gebunden, Moderator nur für Host', async () => {
  const secret = 's'.repeat(48);
  const adapter = new JitsiVideoAdapter(
    { tenantId: 't1', integrationId: 'jitsi', secrets: { jwt_app_secret: secret }, config: { base_url: 'https://meet.slotwise.de', jwt_app_id: 'slotwise' } },
    () => new Date('2026-10-01T09:00:00Z'),
  );
  await adapter.healthCheck();
  const m = await adapter.createMeeting({ bookingId: 'bk_123', title: 'Beratung', start: new Date('2026-10-08T10:00:00Z'), end: new Date('2026-10-08T10:30:00Z'), hostName: 'Jana', hostEmail: 'jana@example.de', attendeeName: 'Kai', attendeeEmail: 'kai@example.de' });
  assert.match(m.externalMeetingId, /^sw-bk123-[A-Za-z0-9_-]{12}$/);
  assert.equal(m.dialIn, null);
  const jwtOf = (u: string) => new URL(u).searchParams.get('jwt')!;
  const guest = verifyJwtHs256(jwtOf(m.joinUrl), secret)!;
  const host = verifyJwtHs256(jwtOf(m.hostUrl), secret)!;
  assert.equal(guest.moderator, false);
  assert.equal(host.moderator, true);
  assert.equal(guest.room, m.externalMeetingId);
  assert.equal(guest.nbf, Math.floor(new Date('2026-10-08T09:45:00Z').getTime() / 1000));
  assert.equal(guest.exp, Math.floor(new Date('2026-10-08T11:30:00Z').getTime() / 1000));
  assert.equal(verifyJwtHs256(jwtOf(m.joinUrl), 'wrong'.repeat(10)), null);
  assert.throws(() => new JitsiVideoAdapter({ tenantId: 't1', integrationId: 'jitsi', secrets: { jwt_app_secret: secret }, config: { base_url: 'https://meet.slotwise.de/path', jwt_app_id: 'x' } }), /base_url/);
});

test('Mollie: Checkout anlegen, Webhook lädt Status nach, Beträge exakt', async () => {
  const calls: { url: string; method: string; body?: string }[] = [];
  const fetchImpl = async (url: string, init: { method: string; body?: string }) => {
    calls.push({ url, method: init.method, body: init.body });
    if (init.method === 'POST' && url.endsWith('/payments')) {
      return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'tr_abc123', status: 'open', amount: { currency: 'EUR', value: '25.00' }, description: 'x', metadata: { bookingId: 'bk_1' }, expiresAt: '2026-10-01T09:15:00+00:00', _links: { checkout: { href: 'https://www.mollie.com/checkout/select-method/abc123' } } }) };
    }
    if (init.method === 'GET' && url.endsWith('/payments/tr_abc123')) {
      return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ id: 'tr_abc123', status: 'paid', amount: { currency: 'EUR', value: '25.00' }, description: 'x', metadata: { bookingId: 'bk_1' }, _links: {} }) };
    }
    if (init.method === 'POST' && url.endsWith('/refunds')) {
      return { status: 201, headers: { get: () => null }, text: async () => JSON.stringify({ id: 're_xyz' }) };
    }
    return { status: 404, headers: { get: () => null }, text: async () => '' };
  };
  const adapter = new MolliePaymentAdapter({ tenantId: 't1', integrationId: 'mollie', secrets: { api_key: 'test_abcdefghijklmnopqrstuvwxyz' }, config: {} }, fetchImpl);
  const co = await adapter.createCheckout({ bookingId: 'bk_1', amountCents: 2500, currency: 'EUR', description: 'Anzahlung Beratung', redirectUrl: 'https://app.slotwise.de/b/bk_1', webhookUrl: 'https://api.slotwise.de/webhooks/mollie', customerEmail: 'kai@example.de', locale: 'de_DE' });
  assert.equal(co.paymentId, 'tr_abc123');
  assert.match(calls[0].body!, /"value":"25\.00"/);
  const ev = await adapter.handleWebhook('id=tr_abc123', {});
  assert.equal(ev.status, 'paid');
  assert.equal(ev.amountCents, 2500);
  assert.equal(ev.bookingId, 'bk_1');
  const r = await adapter.refund('tr_abc123', 1000, 'Kulanz');
  assert.equal(r.refundId, 're_xyz');
  assert.equal(centsToMollieValue(5), '0.05');
  assert.equal(centsToMollieValue(123456), '1234.56');
  assert.equal(mollieValueToCents('0.99'), 99);
  await assert.rejects(adapter.handleWebhook('id=DROP TABLE', {}), /ungültige Zahlungs-ID/);
  assert.throws(() => new MolliePaymentAdapter({ tenantId: 't1', integrationId: 'mollie', secrets: { api_key: 'nope' }, config: {} }), /api_key/);
});

test('Metadaten-Typ ist vollständig serialisierbar (JSON-Export der Subprozessorenliste)', () => {
  const m: AdapterMetadata = catalogById().get('hubspot')!;
  const round = JSON.parse(JSON.stringify(m)) as AdapterMetadata;
  assert.deepEqual(round, m);
});
