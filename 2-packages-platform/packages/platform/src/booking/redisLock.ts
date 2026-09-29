import { randomUUID } from 'node:crypto';
import type { SlotLocker } from './types.js';

/** Minimale Redis-Schnittstelle (ioredis-kompatibel), damit der Lock ohne Paket-Typen testbar bleibt. */
export interface RedisLike {
  set(key: string, value: string, mode: 'PX', ttl: number, flag: 'NX'): Promise<'OK' | null>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
}

const RELEASE_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
else
  return 0
end`;

export class RedisSlotLocker implements SlotLocker {
  constructor(private readonly redis: RedisLike) {}

  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const token = randomUUID();
    const res = await this.redis.set(key, token, 'PX', ttlMs, 'NX');
    return res === 'OK' ? token : null;
  }

  async release(key: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LUA, 1, key, token);
  }
}

/** Lock-Schlüssel: pro Host und Slotbeginn. Überlappende, aber nicht identische Starts fängt der Postgres-Constraint. */
export function slotLockKey(hostId: string, startUtc: Date): string {
  return `lock:slot:${hostId}:${startUtc.toISOString()}`;
}

/** In-Memory-Locker für Tests. Gleiche Semantik wie Redis SET NX PX. */
export class MemorySlotLocker implements SlotLocker {
  private readonly locks = new Map<string, { token: string; expires: number }>();
  constructor(private readonly clock: () => number = () => Date.now()) {}
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const cur = this.locks.get(key);
    if (cur && cur.expires > this.clock()) return null;
    const token = randomUUID();
    this.locks.set(key, { token, expires: this.clock() + ttlMs });
    return token;
  }
  async release(key: string, token: string): Promise<void> {
    const cur = this.locks.get(key);
    if (cur && cur.token === token) this.locks.delete(key);
  }
}
