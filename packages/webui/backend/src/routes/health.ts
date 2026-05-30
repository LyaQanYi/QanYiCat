import type { Hono } from 'hono';
import type { WebUIServerOptions } from '../server.js';
import type { HealthResponseDto } from '../../../shared/dto.js';

/**
 * GET /api/health — JWT-FREE, intentionally light.
 *
 * Mounted OUTSIDE the `requireJwt` middleware so docker / k8s / external
 * monitors can probe without auth. Body is minimal: identity (uin), liveness
 * (online), uptime, build info. Never returns network config, passwords, or
 * any value the operator would treat as a secret.
 *
 * Status semantics:
 *   - `ok`        — uin set + ctx.selfInfo.online === true
 *   - `degraded`  — uin set, but selfInfo.online === false
 *   - `starting`  — uin unset (bridge hasn't completed login yet)
 */
export function mountHealthRoutes(app: Hono, opts: WebUIServerOptions): void {
  app.get('/health', (c) => {
    const uin = opts.ctx.uin;
    const online = opts.ctx.selfInfo?.online ?? false;
    const status: HealthResponseDto['status'] =
      !uin || uin === '' || uin === '0' ? 'starting'
        : online ? 'ok'
          : 'degraded';
    const body: HealthResponseDto = {
      status,
      uin: uin ?? '',
      online,
      uptimeSec: Math.max(0, Math.floor((Date.now() - opts.startedAt) / 1000)),
      qqVersion: opts.ctx.basicInfo?.qqVersion ?? '',
      startedAt: opts.startedAt,
    };
    // 503 when not OK so monitors flip red. JSON body still returned for
    // diagnostic value.
    const httpStatus = status === 'ok' ? 200 : 503;
    return c.json(body, httpStatus);
  });
}
