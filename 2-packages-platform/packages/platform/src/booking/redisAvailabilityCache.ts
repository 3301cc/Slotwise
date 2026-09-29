import type { BusyBlock } from '../availability/slotEngine.js';
import type { AvailabilityCache } from './types.js';

export interface RedisKv {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode: 'PX', ttl: number): Promise<unknown>;
  del(...keys: string[]): Promise<unknown>;
  keys(pattern: string): Promise<string[]>;
}

interface Entry {
  storedAt: number;
  busy: { s: string; e: string; id: string | null }[];
}

/**
 * Free/Busy-Cache pro Kalenderverbindung und Zeitfenster.
 * Invalidierung durch Push-Benachrichtigungen (Google watch, Graph change
 * notifications, CalDAV-Polling) über invalidate(connectionId).
 */
export class RedisAvailabilityCache implements AvailabilityCache {
  constructor(private readonly redis: RedisKv, private readonly now: () => number = () => Date.now()) {}

  private key(connectionId: string, from: Date, to: Date) {
    return `fb:${connectionId}:${from.toISOString()}:${to.toISOString()}`;
  }

  async get(connectionId: string, from: Date, to: Date) {
    const raw = await this.redis.get(this.key(connectionId, from, to));
    if (!raw) return null;
    const e = JSON.parse(raw) as Entry;
    return {
      ageMs: this.now() - e.storedAt,
      busy: e.busy.map<BusyBlock>((b) => ({ start: new Date(b.s), end: new Date(b.e), externalEventId: b.id })),
    };
  }

  async set(connectionId: string, from: Date, to: Date, busy: BusyBlock[], ttlMs: number) {
    const e: Entry = { storedAt: this.now(), busy: busy.map((b) => ({ s: b.start.toISOString(), e: b.end.toISOString(), id: b.externalEventId })) };
    await this.redis.set(this.key(connectionId, from, to), JSON.stringify(e), 'PX', ttlMs);
  }

  /** Wird vom Webhook-Endpunkt der Kalender-Provider aufgerufen. KEYS ist hier akzeptabel, weil pro Verbindung nur wenige Fenster existieren; produktiv über SCAN. */
  async invalidate(connectionId: string) {
    const keys = await this.redis.keys(`fb:${connectionId}:*`);
    if (keys.length) await this.redis.del(...keys);
  }
}
