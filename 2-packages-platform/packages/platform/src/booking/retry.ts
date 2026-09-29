import { ProviderRateLimitError, isRetryable } from './errors.js';

export interface RetryOptions {
  attempts: number; // Gesamtzahl der Versuche inkl. erstem
  baseMs: number;
  factor: number;
  maxMs: number;
  jitter: boolean;
  sleep?: (ms: number) => Promise<void>;
}

export const defaultRetry: RetryOptions = { attempts: 3, baseMs: 400, factor: 2, maxMs: 4000, jitter: true };

/**
 * Exponentielles Backoff mit Jitter, nur für ProviderRateLimitError und
 * ProviderUnavailableError. Respektiert Retry-After, falls der Provider es liefert.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = defaultRetry): Promise<T> {
  const sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  let lastErr: unknown;
  for (let attempt = 1; attempt <= opts.attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err) || attempt === opts.attempts) break;
      let delay = Math.min(opts.maxMs, opts.baseMs * Math.pow(opts.factor, attempt - 1));
      if (err instanceof ProviderRateLimitError && err.retryAfterMs) delay = Math.min(opts.maxMs, err.retryAfterMs);
      if (opts.jitter) delay = Math.round(delay * (0.5 + Math.random()));
      await sleep(delay);
    }
  }
  throw lastErr;
}
