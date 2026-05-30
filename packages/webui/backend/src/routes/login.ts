import { timingSafeEqual } from 'node:crypto';
import type { Hono } from 'hono';
import { signJwt } from '../auth/jwt.js';
import type { LoginRequestDto, LoginResponseDto } from '../../../shared/dto.js';

export interface LoginRoutesDeps {
  secret: string;
  password?: string;
}

/** Token lifetime: 12 hours. Re-issue on demand. */
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000;

export function mountLoginRoutes(app: Hono, deps: LoginRoutesDeps): void {
  app.post('/api/login', async (c) => {
    if (!deps.password) {
      return c.json({ ok: false, message: 'WebUI login disabled (no webuiPassword set)' }, 403);
    }
    let body: LoginRequestDto;
    try {
      body = (await c.req.json()) as LoginRequestDto;
    } catch {
      return c.json({ ok: false, message: 'invalid json body' }, 400);
    }
    if (typeof body.password !== 'string' || !constantTimeEqual(body.password, deps.password)) {
      return c.json({ ok: false, message: 'invalid password' }, 401);
    }
    const expiresAt = Date.now() + TOKEN_TTL_MS;
    const token = signJwt({ sub: 'webui', exp: Math.floor(expiresAt / 1000) }, deps.secret);
    const dto: LoginResponseDto = { token, expiresAt };
    return c.json(dto);
  });
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}
