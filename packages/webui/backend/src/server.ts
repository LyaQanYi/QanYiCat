import type { Server } from 'node:http';
import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { InstanceContext, QanYiCatConfig, RingBufferLogTransport } from '@qanyicat/core';
import type { MediaEntryDto } from '../../shared/dto.js';

/** Shape the bridge produces; identical to the wire DTO. */
export type MediaEntryRecord = MediaEntryDto;
import { mountConfigRoutes } from './routes/config.js';
import { mountInstanceRoutes } from './routes/instance.js';
import { mountLogRoutes } from './routes/logs.js';
import { mountLoginRoutes } from './routes/login.js';
import { mountWireRoutes } from './routes/wire.js';
import { mountMediaRoutes } from './routes/media.js';
import { mountHealthRoutes } from './routes/health.js';
import { requireJwt } from './auth/middleware.js';
import { mountStatic } from './static.js';
import { attachStreamServer, type StreamServerHandle } from './stream.js';

export interface WebUIServerOptions {
  port: number;
  host?: string;
  jwtSecret?: string;
  /** Required for /api/login; if absent, login is disabled and the dashboard is unreachable. */
  webuiPassword?: string;
  ctx: InstanceContext;
  config: QanYiCatConfig;
  logs?: RingBufferLogTransport;
  /** ms-since-epoch when the worker first came online. */
  startedAt: number;
  /** Absolute path to the frontend `dist/` directory. Auto-detected if omitted. */
  staticRoot?: string;
  /**
   * Called when the WebUI mutates `config.onebot` (network add/remove/edit,
   * enable toggle, accessToken change). Implementations should stop the
   * current OneBotManager and rebuild it from `next`. Errors propagate to the
   * HTTP client as 500.
   */
  onConfigUpdate?: (next: QanYiCatConfig['onebot']) => Promise<void>;
  /**
   * Called by `POST /api/wire/:action` to invoke an OneBot action through the
   * in-process dispatcher (same path the HTTP/WS adapters use). The bridge
   * wires this to `OneBotManager.invokeAction`. When absent, the endpoint
   * returns 503.
   */
  onActionInvoke?: (action: string, params: unknown, protocol?: 'v11' | 'v12') => Promise<unknown>;
  /**
   * Called by `GET /api/media` to list every observed media element (image /
   * video / voice / file) for the 文件管理 page. Bridge wires this to
   * `MediaIndex.list()`. When absent, the endpoint returns an empty list.
   */
  onListMedia?: () => Promise<MediaEntryRecord[]>;
  /**
   * Default destination for POST /api/config/export. Falls back to CWD
   * `qanyicat.config.json` when not set.
   */
  exportPath?: string;
}

export interface WebUIServerHandle {
  /** Actual bound port (useful when the caller passed `port: 0`). */
  readonly port: number;
  close(): Promise<void>;
}

/**
 * Boot the WebUI HTTP/WS backend. Dynamically imported from app/worker so a
 * `BUILD_WEBUI=0` build can tree-shake every dependency in this file away.
 *
 * Route layout:
 *   POST /api/login          — public; exchanges password for a JWT
 *   GET  /api/instance       — protected; current uin / nick / uptime
 *   GET  /api/config         — protected; sanitized config snapshot
 *   GET  /api/logs?since=ms  — protected; ring-buffer tail
 */
export async function initWebUI(opts: WebUIServerOptions): Promise<WebUIServerHandle> {
  const secret = opts.jwtSecret ?? randomSecret();
  const app = new Hono();

  mountLoginRoutes(app, {
    secret,
    ...(opts.webuiPassword !== undefined ? { password: opts.webuiPassword } : {}),
  });

  // /api/health is mounted JWT-free so external monitors can probe. Sits on
  // the top-level Hono BEFORE the requireJwt-guarded `/api/*` namespace.
  const publicApi = new Hono();
  mountHealthRoutes(publicApi, opts);
  app.route('/api', publicApi);

  const api = new Hono();
  api.use('*', requireJwt(secret));
  mountConfigRoutes(api, opts);
  mountInstanceRoutes(api, opts);
  mountLogRoutes(api, opts);
  mountWireRoutes(api, opts);
  mountMediaRoutes(api, opts);
  app.route('/api', api);

  // Static SPA mount happens AFTER /api so Hono's route matching consults the
  // API namespace first. The catch-all only fires for unmatched paths.
  const staticOpts: { staticRoot?: string } = {};
  if (opts.staticRoot !== undefined) staticOpts.staticRoot = opts.staticRoot;
  mountStatic(app, staticOpts);

  const server: ServerType = await new Promise((resolve) => {
    const s = serve(
      {
        fetch: app.fetch,
        port: opts.port,
        hostname: opts.host ?? '127.0.0.1',
      },
      () => resolve(s)
    );
  });
  const addr = server.address();
  const port =
    addr && typeof addr === 'object' && 'port' in addr ? (addr as { port: number }).port : opts.port;

  // The underlying http.Server is what we attach the WS upgrade handler to.
  // @hono/node-server returns a ServerType that IS a Node http.Server at
  // runtime; the type erases that detail so we cast at the boundary.
  const stream: StreamServerHandle = attachStreamServer(server as unknown as Server, secret, opts);

  return {
    port,
    async close() {
      await stream.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function randomSecret(): string {
  return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
}
