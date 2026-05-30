import { createServer, type IncomingMessage, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { TransportRuntimeOptions } from '@qanyicat/core';
import { checkAccessToken, extractBearerToken } from './auth';
import { resolveTransportOptions, type NetworkAdapter, type WireHandler } from './network-adapter';

export interface WsServerOptions {
  id: string;
  host: string;
  port: number;
  path?: string;
  accessToken?: string;
  messagePostFormat?: 'array' | 'string';
  reportSelfMessage?: boolean;
  heartInterval?: number;
  debug?: boolean;
}

export class WsServerAdapter implements NetworkAdapter {
  readonly id: string;
  readonly kind = 'ws-server' as const;
  readonly options: TransportRuntimeOptions;

  private http: Server | null = null;
  private wss: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();
  private handler: WireHandler | null = null;
  /**
   * v0.4n-housekeeping-12: bufferedAmount warn rate-limit per client. NT can
   * burst dozens of msg.recv events into a chatty group within ms; a slow
   * consumer fills the WS write buffer and eventually OOMs the process. We
   * emit a warn when bufferedAmount crosses 1 MB so operators see the
   * backpressure before it bites. Throttled at 30s per client.
   */
  private readonly lastBackpressureWarn = new WeakMap<WebSocket, number>();
  private static readonly BACKPRESSURE_BYTES = 1_000_000;
  private static readonly BACKPRESSURE_WARN_INTERVAL_MS = 30_000;

  constructor(private readonly opts: WsServerOptions) {
    this.id = opts.id;
    this.options = resolveTransportOptions(opts);
  }

  async start(handler: WireHandler): Promise<void> {
    this.handler = handler;
    const http = createServer();
    const wss = new WebSocketServer({ noServer: true });

    http.on('upgrade', (req, socket, head) => {
      if (!this.isAuthorized(req)) {
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
      if (this.opts.path && new URL(req.url ?? '/', 'http://x').pathname !== this.opts.path) {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    });

    wss.on('connection', (ws) => {
      this.clients.add(ws);
      ws.on('close', () => this.clients.delete(ws));
      ws.on('error', () => this.clients.delete(ws));
      ws.on('message', (data) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(data.toString());
        } catch {
          return;
        }
        this.handler?.onAction(parsed, (resp) => {
          if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(resp));
        });
      });
    });

    this.http = http;
    this.wss = wss;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error): void => {
        http.off('listening', onListening);
        reject(err);
      };
      const onListening = (): void => {
        http.off('error', onError);
        resolve();
      };
      http.once('error', onError);
      http.once('listening', onListening);
      http.listen(this.opts.port, this.opts.host);
    });
  }

  push(event: unknown): void {
    const data = JSON.stringify(event);
    for (const ws of this.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(data);
      this.checkBackpressure(ws);
    }
  }

  /** One-line emitter so we don't spam logs when a slow client fills its WS buffer. */
  private checkBackpressure(ws: WebSocket): void {
    const buffered = ws.bufferedAmount;
    if (buffered < WsServerAdapter.BACKPRESSURE_BYTES) return;
    const now = Date.now();
    const lastWarn = this.lastBackpressureWarn.get(ws) ?? 0;
    if (now - lastWarn < WsServerAdapter.BACKPRESSURE_WARN_INTERVAL_MS) return;
    this.lastBackpressureWarn.set(ws, now);
    // No injected logger yet — go through console.warn so it lands in the
    // bridge's stderr capture. Cheap; only fires when a real problem exists.
    console.warn(
      `[ws-server ${this.id}] client backpressure: bufferedAmount=${buffered} bytes — wire bot likely too slow consuming msg events`
    );
  }

  async stop(): Promise<void> {
    for (const ws of this.clients) {
      try {
        ws.close(1001, 'shutdown');
      } catch {
        // socket already gone; nothing to do
      }
    }
    this.clients.clear();
    const wss = this.wss;
    const http = this.http;
    this.wss = null;
    this.http = null;
    this.handler = null;
    if (wss) await new Promise<void>((resolve) => wss.close(() => resolve()));
    if (http) await new Promise<void>((resolve) => http.close(() => resolve()));
  }

  private isAuthorized(req: IncomingMessage): boolean {
    if (!this.opts.accessToken) return true;
    const fromHeader = extractBearerToken(req.headers['authorization']);
    if (fromHeader && checkAccessToken(fromHeader, this.opts.accessToken)) return true;
    const url = new URL(req.url ?? '/', 'http://x');
    const fromQuery = url.searchParams.get('access_token') ?? undefined;
    return checkAccessToken(fromQuery, this.opts.accessToken);
  }
}
