import type { Hono } from 'hono';
import type { WebUIServerOptions } from '../server.js';
import type { MediaListResponseDto } from '../../../shared/dto.js';

/**
 * GET /api/media — returns the bridge's MediaIndex snapshot for the
 * 文件管理 page. Empty list when `onListMedia` isn't wired (memory-context
 * smoke / pre-bridge boot).
 */
export function mountMediaRoutes(app: Hono, opts: WebUIServerOptions): void {
  app.get('/media', async (c) => {
    if (!opts.onListMedia) {
      const empty: MediaListResponseDto = { entries: [] };
      return c.json(empty);
    }
    const entries = await opts.onListMedia();
    const dto: MediaListResponseDto = { entries };
    return c.json(dto);
  });
}
