/**
 * R1 · Option A · Referenz-Adapter Stufe 1: Mollie (API v2) über fetch.
 *
 * Verwendet für Vorkasse, Anzahlung und die No-Show-Gebühr aus Option C.
 * Webhooks von Mollie enthalten nur die Zahlungs-ID; der Adapter lädt den
 * Status immer beim Anbieter nach und vertraut dem Body nicht.
 *
 * credentials.secrets = { api_key }          (live_… oder test_…, aus dem Vault)
 * credentials.config  = { profile_id? }
 */
import { ProviderRateLimitError, ProviderUnavailableError } from '../../booking/errors.js';
import { catalogById } from '../catalog.js';
import type { AdapterMetadata } from '../metadata.js';
import type { CheckoutInput, CheckoutResult, PaymentAdapter, PaymentEvent, PaymentStatus } from '../ports.js';
import type { AdapterCredentials } from '../registry.js';
import type { FetchLike } from './caldavCalendarAdapter.js';

const API = 'https://api.mollie.com/v2';
const PROVIDER = 'mollie';

interface MolliePayment {
  id: string;
  status: 'open' | 'canceled' | 'pending' | 'authorized' | 'expired' | 'failed' | 'paid';
  amount: { currency: string; value: string };
  amountRefunded?: { currency: string; value: string };
  description: string;
  metadata: { bookingId?: string } | null;
  expiresAt?: string;
  _links: { checkout?: { href: string } };
}

export function centsToMollieValue(cents: number): string {
  if (!Number.isInteger(cents) || cents < 0) throw new Error(`Betrag muss ganzzahlige Cent sein: ${cents}`);
  return `${Math.floor(cents / 100)}.${String(cents % 100).padStart(2, '0')}`;
}

export function mollieValueToCents(value: string): number {
  const m = /^(\d+)\.(\d{2})$/.exec(value);
  if (!m) throw new Error(`Ungültiger Mollie-Betrag: ${value}`);
  return Number(m[1]) * 100 + Number(m[2]);
}

function mapStatus(p: MolliePayment): PaymentStatus {
  if (p.amountRefunded && mollieValueToCents(p.amountRefunded.value) > 0) return 'refunded';
  switch (p.status) {
    case 'paid': return 'paid';
    case 'authorized': return 'pending';
    case 'pending': return 'pending';
    case 'open': return 'open';
    case 'canceled': return 'canceled';
    case 'expired': return 'expired';
    case 'failed': return 'failed';
  }
}

export class MolliePaymentAdapter implements PaymentAdapter {
  readonly meta: AdapterMetadata & { category: 'payment' };
  private readonly apiKey: string;

  constructor(credentials: AdapterCredentials, private readonly fetchImpl: FetchLike = (u, i) => fetch(u, i)) {
    const meta = catalogById().get('mollie');
    if (!meta || meta.category !== 'payment') throw new Error('Katalogeintrag mollie fehlt');
    this.meta = meta as AdapterMetadata & { category: 'payment' };
    const key = credentials.secrets.api_key;
    if (!key || !/^(live|test)_[A-Za-z0-9]{20,}$/.test(key)) throw new Error('Mollie: api_key fehlt oder hat ein ungültiges Format');
    this.apiKey = key;
  }

  async healthCheck(): Promise<void> {
    const res = await this.request('GET', '/methods?limit=1');
    if (res.status !== 200) throw new Error(`Mollie: /methods antwortete ${res.status}`);
  }

  async createCheckout(input: CheckoutInput): Promise<CheckoutResult> {
    if (!/^https:\/\//.test(input.redirectUrl) || !/^https:\/\//.test(input.webhookUrl)) throw new Error('Mollie: redirectUrl und webhookUrl müssen https sein');
    const res = await this.request('POST', '/payments', {
      amount: { currency: input.currency, value: centsToMollieValue(input.amountCents) },
      description: input.description.slice(0, 255),
      redirectUrl: input.redirectUrl,
      webhookUrl: input.webhookUrl,
      locale: input.locale,
      metadata: { bookingId: input.bookingId },
      billingEmail: input.customerEmail,
    });
    if (res.status !== 201) throw new ProviderUnavailableError(PROVIDER, res.status);
    const p = JSON.parse(await res.text()) as MolliePayment;
    const checkout = p._links.checkout?.href;
    if (!checkout) throw new Error('Mollie: Antwort ohne Checkout-Link');
    return { paymentId: p.id, checkoutUrl: checkout, expiresAt: p.expiresAt ? new Date(p.expiresAt) : new Date(Date.now() + 15 * 60_000) };
  }

  async getPayment(paymentId: string): Promise<PaymentEvent> {
    if (!/^tr_[A-Za-z0-9]+$/.test(paymentId)) throw new Error(`Mollie: ungültige Zahlungs-ID ${paymentId}`);
    const res = await this.request('GET', `/payments/${paymentId}`);
    if (res.status !== 200) throw new ProviderUnavailableError(PROVIDER, res.status);
    const p = JSON.parse(await res.text()) as MolliePayment;
    return {
      paymentId: p.id,
      bookingId: p.metadata?.bookingId ?? '',
      status: mapStatus(p),
      amountCents: mollieValueToCents(p.amount.value),
      currency: p.amount.currency,
      providerReference: p.id,
    };
  }

  async refund(paymentId: string, amountCents: number, reason: string): Promise<{ refundId: string }> {
    const res = await this.request('POST', `/payments/${paymentId}/refunds`, { amount: { currency: 'EUR', value: centsToMollieValue(amountCents) }, description: reason.slice(0, 140) });
    if (res.status !== 201) throw new ProviderUnavailableError(PROVIDER, res.status);
    const r = JSON.parse(await res.text()) as { id: string };
    return { refundId: r.id };
  }

  /** Body: application/x-www-form-urlencoded "id=tr_…". Der Status wird stets nachgeladen. */
  async handleWebhook(rawBody: string, _headers: Record<string, string | undefined> = {}): Promise<PaymentEvent> {
    const params = new URLSearchParams(rawBody);
    const id = params.get('id');
    if (!id) throw new Error('Mollie-Webhook ohne id');
    return this.getPayment(id);
  }

  private async request(method: 'GET' | 'POST', path: string, body?: unknown) {
    let res: Awaited<ReturnType<FetchLike>>;
    try {
      res = await this.fetchImpl(`${API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'User-Agent': 'Slotwise/1.0' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ProviderUnavailableError(PROVIDER, undefined);
    }
    if (res.status === 429) {
      const ra = res.headers.get('retry-after');
      throw new ProviderRateLimitError(PROVIDER, ra ? Number(ra) * 1000 : undefined);
    }
    if (res.status >= 500) throw new ProviderUnavailableError(PROVIDER, res.status);
    if (res.status === 401 || res.status === 403) throw new Error(`Mollie: Zugriff verweigert (${res.status})`);
    return res;
  }
}

export function mollieFactory(fetchImpl?: FetchLike) {
  return (credentials: AdapterCredentials) => new MolliePaymentAdapter(credentials, fetchImpl);
}
