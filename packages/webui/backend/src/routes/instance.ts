import type { Hono } from 'hono';
import type { WebUIServerOptions } from '../server.js';
import type { InstanceStatusDto } from '../../../shared/dto.js';

export function mountInstanceRoutes(app: Hono, opts: WebUIServerOptions): void {
  app.get('/instance', (c) => {
    const dto: InstanceStatusDto = {
      uin: opts.ctx.uin,
      online: opts.ctx.selfInfo.online,
      selfNick: opts.ctx.selfInfo.nick,
      qqVersion: opts.ctx.basicInfo.qqVersion,
      startedAt: opts.startedAt,
      uptimeSec: Math.max(0, Math.floor((Date.now() - opts.startedAt) / 1000)),
    };
    return c.json(dto);
  });
}
