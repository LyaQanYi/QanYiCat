import { Hono } from 'hono';
import { serve, type ServerType } from '@hono/node-server';
import type { TransportRuntimeOptions } from '@qanyicat/core';
import { checkAccessToken, extractBearerToken } from './auth';
import { resolveTransportOptions, type NetworkAdapter, type WireHandler } from './network-adapter';

export interface HttpServerOptions {
  id: string;
  host: string;
  port: number;
  accessToken?: string;
  messagePostFormat?: 'array' | 'string';
  reportSelfMessage?: boolean;
  heartInterval?: number;
  debug?: boolean;
}

export class HttpServerAdapter implements NetworkAdapter {
  readonly id: string;
  readonly kind = 'http-server' as const;
  readonly options: TransportRuntimeOptions;
  private server: ServerType | null = null;

  constructor(private readonly opts: HttpServerOptions) {
    this.id = opts.id;
    this.options = resolveTransportOptions(opts);
  }

  async start(handler: WireHandler): Promise<void> {
    const app = new Hono();

    app.use('*', async (c, next) => {
      if (!this.opts.accessToken) return next();
      const fromHeader = extractBearerToken(c.req.header('authorization'));
      const fromQuery = c.req.query('access_token');
      if (
        (fromHeader && checkAccessToken(fromHeader, this.opts.accessToken)) ||
        checkAccessToken(fromQuery, this.opts.accessToken)
      ) {
        return next();
      }
      return c.json({ status: 'failed', retcode: 401, message: 'unauthorized' }, 401);
    });

    app.post('/:action', async (c) => {
      const action = c.req.param('action');
      let params: unknown;
      try {
        params = await c.req.json();
      } catch {
        params = {};
      }
      const frame = { action, params };
      const resp = await new Promise<unknown>((resolve) => {
        handler.onAction(frame, (r) => resolve(r));
      });
      return c.json(resp as Record<string, unknown>);
    });

    this.server = serve({
      fetch: app.fetch,
      hostname: this.opts.host,
      port: this.opts.port,
    });
  }

  push(_event: unknown): void {
    // HTTP server only responds; events go out via http-post / ws-server.
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
