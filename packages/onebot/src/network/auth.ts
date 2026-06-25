import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Constant-time access-token comparison. Used by every network adapter that
 * accepts inbound traffic. Bearer header takes precedence; `?access_token=`
 * query is a fallback for browser clients.
 */
export function checkAccessToken(provided: string | undefined, expected: string | undefined): boolean {
  if (!expected) return true;
  if (!provided) return false;
  // HMAC both tokens under a fresh per-call key, then compare the fixed-size
  // digests. Hashing first keeps the comparison length-independent, so we never
  // short-circuit on a length mismatch — that early return would leak the
  // configured token's length through a timing oracle. The random key prevents
  // an attacker from precomputing either digest.
  const key = randomBytes(32);
  const a = createHmac('sha256', key).update(provided).digest();
  const b = createHmac('sha256', key).update(expected).digest();
  return timingSafeEqual(a, b);
}

export function extractBearerToken(authHeader: string | undefined): string | undefined {
  if (!authHeader) return undefined;
  const m = /^Bearer\s+(.+)$/i.exec(authHeader);
  return m?.[1];
}
