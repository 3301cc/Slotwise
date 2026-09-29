/**
 * R1 · Option A · Adapter-Ports.
 *
 * Jeder Adapter trägt `meta` (AdapterMetadata) und wird ausschließlich über die
 * AdapterRegistry aufgelöst, die den EU-Modus des Tenants durchsetzt. Die
 * Kalender-Schnittstelle ist der bestehende CalendarProvider-Port aus R0,
 * damit BookingService und verifyPendingJob unverändert bleiben.
 */
import type { CalendarProvider } from '../booking/types.js';
import type { AdapterMetadata } from './metadata.js';

export interface Adapter {
  readonly meta: AdapterMetadata;
  /** Verbindungstest mit den hinterlegten Zugangsdaten; wirft bei Fehlkonfiguration. */
  healthCheck(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Kalender
// ---------------------------------------------------------------------------

export interface CalendarAdapter extends Adapter, CalendarProvider {
  readonly meta: AdapterMetadata & { category: 'calendar' };
}

// ---------------------------------------------------------------------------
// Video
// ---------------------------------------------------------------------------

export interface MeetingInput {
  bookingId: string;
  title: string;
  start: Date;
  end: Date;
  hostName: string;
  hostEmail: string;
  attendeeName: string;
  attendeeEmail: string;
}

export interface MeetingResult {
  externalMeetingId: string;
  joinUrl: string;
  /** Moderator-Link, falls der Dienst einen getrennten Link liefert; sonst identisch mit joinUrl. */
  hostUrl: string;
  /** Wählt sich ein Teilnehmer per Telefon ein, sonst leer. */
  dialIn: { number: string; pin: string } | null;
}

export interface VideoAdapter extends Adapter {
  readonly meta: AdapterMetadata & { category: 'video' };
  createMeeting(input: MeetingInput): Promise<MeetingResult>;
  updateMeeting(externalMeetingId: string, patch: Pick<MeetingInput, 'start' | 'end' | 'title'>): Promise<void>;
  deleteMeeting(externalMeetingId: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Zahlung
// ---------------------------------------------------------------------------

export interface CheckoutInput {
  bookingId: string;
  amountCents: number;
  currency: 'EUR';
  description: string;
  /** Rücksprung nach Zahlung (Slotwise-Seite, kein Fremd-Host). */
  redirectUrl: string;
  /** Slotwise-Webhook-Endpunkt, den der Anbieter aufruft. */
  webhookUrl: string;
  customerEmail: string;
  locale: 'de_DE' | 'en_US';
}

export interface CheckoutResult {
  paymentId: string;
  checkoutUrl: string;
  expiresAt: Date;
}

export type PaymentStatus = 'open' | 'pending' | 'paid' | 'failed' | 'canceled' | 'expired' | 'refunded';

export interface PaymentEvent {
  paymentId: string;
  bookingId: string;
  status: PaymentStatus;
  amountCents: number;
  currency: string;
  /** Vom Anbieter vergebene Referenz für Buchhaltung und Storno */
  providerReference: string;
}

export interface PaymentAdapter extends Adapter {
  readonly meta: AdapterMetadata & { category: 'payment' };
  createCheckout(input: CheckoutInput): Promise<CheckoutResult>;
  getPayment(paymentId: string): Promise<PaymentEvent>;
  refund(paymentId: string, amountCents: number, reason: string): Promise<{ refundId: string }>;
  /**
   * Verarbeitet einen eingehenden Webhook. Implementierungen dürfen dem Body
   * nicht vertrauen, sondern müssen den Zahlungsstatus beim Anbieter nachladen
   * oder eine Signatur prüfen.
   */
  handleWebhook(rawBody: string, headers: Record<string, string | undefined>): Promise<PaymentEvent>;
}

// ---------------------------------------------------------------------------
// CRM
// ---------------------------------------------------------------------------

export interface CrmContact {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string;
  company?: string;
}

export interface CrmAdapter extends Adapter {
  readonly meta: AdapterMetadata & { category: 'crm' };
  upsertContact(contact: CrmContact): Promise<{ externalContactId: string }>;
  logMeeting(externalContactId: string, meeting: { bookingId: string; title: string; start: Date; end: Date; outcome: 'scheduled' | 'completed' | 'cancelled' | 'no_show' }): Promise<{ externalActivityId: string }>;
}

// ---------------------------------------------------------------------------
// Automatisierung (Make, Zapier) und generische Webhooks
// ---------------------------------------------------------------------------

export type OutboundEventName = 'booking.created' | 'booking.confirmed' | 'booking.rescheduled' | 'booking.cancelled' | 'booking.no_show' | 'booking.completed';

export interface OutboundEvent {
  id: string;
  name: OutboundEventName;
  occurredAt: Date;
  tenantId: string;
  payload: Record<string, unknown>;
}

export interface AutomationAdapter extends Adapter {
  readonly meta: AdapterMetadata & { category: 'automation' };
  deliver(event: OutboundEvent): Promise<{ accepted: boolean; statusCode: number }>;
}

export type AnyAdapter = CalendarAdapter | VideoAdapter | PaymentAdapter | CrmAdapter | AutomationAdapter;

export type AdapterFor<C extends AdapterMetadata['category']> =
  C extends 'calendar' ? CalendarAdapter :
  C extends 'video' ? VideoAdapter :
  C extends 'payment' ? PaymentAdapter :
  C extends 'crm' ? CrmAdapter :
  C extends 'automation' ? AutomationAdapter :
  Adapter;
