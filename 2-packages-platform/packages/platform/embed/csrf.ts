/**
 * STW-301 · CSRF-Schutz ohne Cookie (Double-Submit-Variante mit signiertem Token).
 * Der Server rendert ein Token in die Seite (data-csrf am Root), das Widget sendet
 * es als Header. Das Token ist HMAC(tenant|slotStart-Fenster|nonce) mit 15 min
 * Gültigkeit und an den Tenant gebunden; es identifiziert keinen Nutzer.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const TTL_MS = 15 * 60_000;

export function issueCsrfToken(secret: string, tenantId: string, now = Date.now()): string {
  const exp = now + TTL_MS;
  const nonce = randomBytes(8).toString('hex');
  const mac = createHmac('sha256', secret).update(`${tenantId}|${exp}|${nonce}`).digest('hex').slice(0, 32);
  return Buffer.from(`${exp}.${nonce}.${mac}`).toString('base64url');
}

export function verifyCsrfToken(secret: string, tenantId: string, token: string, now = Date.now()): boolean {
  try {
    const [exp, nonce, mac] = Buffer.from(token, 'base64url').toString().split('.');
    if (!exp || !nonce || !mac || Number(exp) < now) return false;
    const expected = createHmac('sha256', secret).update(`${tenantId}|${exp}|${nonce}`).digest('hex').slice(0, 32);
    return mac.length === expected.length && timingSafeEqual(Buffer.from(mac), Buffer.from(expected));
  } catch {
    return false;
  }
}

/** Express-/Fastify-kompatibler Guard für POST /api/bookings. */
export function csrfGuard(secret: string) {
  return (req: { headers: Record<string, string | string[] | undefined>; tenantId: string }, res: { status(n: number): { json(b: unknown): void } }, next: () => void) => {
    const token = String(req.headers['x-slotwise-csrf'] ?? '');
    if (!verifyCsrfToken(secret, req.tenantId, token)) return res.status(403).json({ error: 'CSRF_TOKEN_INVALID' });
    next();
  };
}
