import type { MiddlewareHandler } from 'hono';
import { verifyJwt } from './jwt.js';

/** Hono middleware: 401 unless `Authorization: Bearer <jwt>` validates. */
export function requireJwt(secret: string): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header('authorization');
    const token = header && /^Bearer\s+(.+)$/i.exec(header)?.[1];
    if (!token) return c.json({ ok: false, message: 'missing bearer token' }, 401);
    const payload = verifyJwt(token, secret);
    if (!payload) return c.json({ ok: false, message: 'invalid token' }, 401);
    c.set('jwt', payload);
    return next();
  };
}
