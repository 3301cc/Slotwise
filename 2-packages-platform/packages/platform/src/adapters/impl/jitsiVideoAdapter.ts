/**
 * R1 · Option A · Referenz-Adapter Stufe 1: Jitsi Meet auf meet.slotwise.de.
 *
 * Räume werden nicht beim Server angelegt (Jitsi erzeugt sie beim ersten
 * Beitritt); der Adapter erzeugt einen nicht erratbaren Raumnamen und signiert
 * Beitrittslinks mit JWT (HS256, RFC 7519), wie es die Jitsi-Authentifizierung
 * (prosody mod_auth_token) erwartet. Moderator-Token für den Gastgeber,
 * Teilnehmer-Token für die buchende Person, beide zeitlich auf das Terminfenster
 * plus Karenz begrenzt. Eingehende Anrufe per Telefon gibt es im Eigenbetrieb
 * nicht (dialIn = null).
 *
 * credentials.secrets = { jwt_app_secret }
 * credentials.config  = { base_url (https://meet.slotwise.de), jwt_app_id, jwt_issuer }
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { catalogById } from '../catalog.js';
import type { AdapterMetadata } from '../metadata.js';
import type { MeetingInput, MeetingResult, VideoAdapter } from '../ports.js';
import type { AdapterCredentials } from '../registry.js';

const JOIN_GRACE_BEFORE_MS = 15 * 60_000;
const JOIN_GRACE_AFTER_MS = 60 * 60_000;

function b64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function signJwtHs256(payload: Record<string, unknown>, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwtHs256(token: string, secret: string): Record<string, unknown> | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const expected = b64url(createHmac('sha256', secret).update(`${parts[0]}.${parts[1]}`).digest());
  const a = Buffer.from(expected);
  const b = Buffer.from(parts[2]);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export class JitsiVideoAdapter implements VideoAdapter {
  readonly meta: AdapterMetadata & { category: 'video' };
  private readonly baseUrl: string;
  private readonly appId: string;
  private readonly issuer: string;
  private readonly secret: string;
  /** Terminfenster je Raum, damit updateMeeting neue Tokens mit korrekter Gültigkeit erzeugen kann. */
  private readonly rooms = new Map<string, { start: Date; end: Date; title: string }>();

  constructor(credentials: AdapterCredentials, private readonly now: () => Date = () => new Date()) {
    const meta = catalogById().get('jitsi');
    if (!meta || meta.category !== 'video') throw new Error('Katalogeintrag jitsi fehlt');
    this.meta = meta as AdapterMetadata & { category: 'video' };
    const base = credentials.config.base_url;
    if (!base || !/^https:\/\/[a-z0-9.-]+$/i.test(base)) throw new Error('Jitsi: config.base_url muss https://host sein (ohne Pfad)');
    this.baseUrl = base;
    this.appId = credentials.config.jwt_app_id;
    this.issuer = credentials.config.jwt_issuer ?? credentials.config.jwt_app_id;
    this.secret = credentials.secrets.jwt_app_secret;
    if (!this.appId || !this.secret) throw new Error('Jitsi: jwt_app_id und jwt_app_secret fehlen');
  }

  async healthCheck(): Promise<void> {
    if (this.secret.length < 32) throw new Error('Jitsi: jwt_app_secret muss mindestens 32 Zeichen lang sein');
  }

  async createMeeting(input: MeetingInput): Promise<MeetingResult> {
    const room = `sw-${input.bookingId.replace(/[^a-z0-9]/gi, '').slice(0, 12).toLowerCase()}-${randomBytes(9).toString('base64url')}`;
    this.rooms.set(room, { start: input.start, end: input.end, title: input.title });
    return {
      externalMeetingId: room,
      joinUrl: this.link(room, input, false),
      hostUrl: this.link(room, input, true),
      dialIn: null,
    };
  }

  async updateMeeting(externalMeetingId: string, patch: Pick<MeetingInput, 'start' | 'end' | 'title'>): Promise<void> {
    this.rooms.set(externalMeetingId, { start: patch.start, end: patch.end, title: patch.title });
  }

  async deleteMeeting(externalMeetingId: string): Promise<void> {
    // Räume existieren nur während der Nutzung; ohne gültiges Token ist der Beitritt nicht möglich.
    this.rooms.delete(externalMeetingId);
  }

  /** Erzeugt einen frischen Link (z. B. für Erinnerungs-Mails nach einer Verschiebung). */
  linkFor(externalMeetingId: string, input: MeetingInput, moderator: boolean): string {
    return this.link(externalMeetingId, input, moderator);
  }

  private link(room: string, input: MeetingInput, moderator: boolean): string {
    const window = this.rooms.get(room) ?? { start: input.start, end: input.end, title: input.title };
    const nbf = Math.floor((window.start.getTime() - JOIN_GRACE_BEFORE_MS) / 1000);
    const exp = Math.floor((window.end.getTime() + JOIN_GRACE_AFTER_MS) / 1000);
    const token = signJwtHs256(
      {
        aud: this.appId,
        iss: this.issuer,
        sub: new URL(this.baseUrl).host,
        room,
        nbf,
        exp,
        iat: Math.floor(this.now().getTime() / 1000),
        moderator,
        context: {
          user: {
            name: moderator ? input.hostName : input.attendeeName,
            email: moderator ? input.hostEmail : input.attendeeEmail,
            affiliation: moderator ? 'owner' : 'member',
          },
          features: { recording: false, livestreaming: false, transcription: false, 'outbound-call': false },
        },
      },
      this.secret,
    );
    const subject = encodeURIComponent(window.title);
    return `${this.baseUrl}/${room}?jwt=${token}#config.subject=%22${subject}%22&config.prejoinConfig.enabled=true`;
  }
}

export function jitsiFactory(now?: () => Date) {
  return (credentials: AdapterCredentials) => new JitsiVideoAdapter(credentials, now);
}
