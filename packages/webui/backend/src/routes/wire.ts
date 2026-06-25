import type { Hono } from 'hono';
import type { WebUIServerOptions } from '../server.js';

/**
 * POST /api/wire/:action — invoke an OneBot action through the live in-process
 * dispatcher. Body is the action's params (JSON); querystring `protocol=v11`
 * (default) or `v12` picks which adapter to route through.
 *
 * Response shape mirrors the OneBot HTTP wire so the API-debug page can show
 * exactly what an external bot framework would see.
 */
export function mountWireRoutes(app: Hono, opts: WebUIServerOptions): void {
  app.post('/wire/:action', async (c) => {
    if (!opts.onActionInvoke) {
      return c.json({ status: 'failed', retcode: 503, message: 'wire invoke not available in this build' }, 503);
    }
    const action = c.req.param('action');
    const protocolRaw = c.req.query('protocol');
    const protocol: 'v11' | 'v12' = protocolRaw === 'v12' ? 'v12' : 'v11';
    let params: unknown = {};
    try {
      const text = await c.req.text();
      params = text.length > 0 ? JSON.parse(text) : {};
    } catch (e) {
      return c.json({ status: 'failed', retcode: 1400, message: `bad params JSON: ${(e as Error).message}` }, 400);
    }
    const startedAt = Date.now();
    try {
      const data = await opts.onActionInvoke(action, params, protocol);
      const elapsedMs = Date.now() - startedAt;
      return c.json({ ok: true, elapsedMs, response: data });
    } catch (e) {
      const elapsedMs = Date.now() - startedAt;
      return c.json({
        ok: false,
        elapsedMs,
        error: e instanceof Error ? e.message : String(e),
      }, 500);
    }
  });
}
