/**
 * Per-key async mutex. Serialises critical sections that share a key (here: a
 * host's calendar) inside one Node process. Used by MemoryRepo so the
 * in-memory repo gives the same atomicity guarantee Postgres gives the Prisma
 * repo (advisory lock + exclusion constraint) — tests and the mock server
 * therefore exercise the real contract, not a weaker one.
 */
export class KeyedMutex {
  private readonly tails = new Map<string, Promise<void>>();

  /** Runs `fn` after every previously scheduled section for `key` has finished. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.tails.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => mine);
    this.tails.set(key, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.tails.get(key) === tail) this.tails.delete(key);
    }
  }

  /** True while some section for `key` is running or queued. */
  isBusy(key: string): boolean {
    return this.tails.has(key);
  }
}
