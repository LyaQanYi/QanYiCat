/**
 * Tiny HS256 JWT helpers. We avoid pulling jsonwebtoken because the WebUI
 * backend is the only consumer and the spec we care about is the happy path.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

export interface JwtPayload {
  sub: string;
  exp: number;
  [k: string]: unknown;
}

export function signJwt(payload: JwtPayload, secret: string): string {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifyJwt(token: string, secret: string): JwtPayload | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  if (!header || !body || !sig) return null;
  const expected = b64url(createHmac('sha256', secret).update(`${header}.${body}`).digest());
  const provided = Buffer.from(sig);
  const exp = Buffer.from(expected);
  if (provided.length !== exp.length || !timingSafeEqual(provided, exp)) return null;
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as JwtPayload;
    if (payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}
