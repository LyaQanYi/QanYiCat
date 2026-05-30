import type { Hono } from 'hono';
import type { WebUIServerOptions } from '../server.js';
import type { LogsResponseDto } from '../../../shared/dto.js';

export function mountLogRoutes(app: Hono, opts: WebUIServerOptions): void {
  app.get('/logs', (c) => {
    if (!opts.logs) {
      const dto: LogsResponseDto = { lines: [], totalSeen: 0 };
      return c.json(dto);
    }
    const sinceParam = c.req.query('since');
    const sinceMs = sinceParam ? Number(sinceParam) : 0;
    const lines = Number.isFinite(sinceMs) && sinceMs > 0 ? opts.logs.since(sinceMs) : opts.logs.snapshot();
    const dto: LogsResponseDto = { lines, totalSeen: opts.logs.totalSeen() };
    return c.json(dto);
  });
}
