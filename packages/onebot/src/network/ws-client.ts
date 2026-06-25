import WebSocket from 'ws';
import type { TransportRuntimeOptions } from '@qanyicat/core';
import { resolveTransportOptions, type NetworkAdapter, type WireHandler } from './network-adapter';

export interface WsClientOptions {
  id: string;
  url: string;
  accessToken?: string;
  reconnectIntervalMs: number;
  messagePostFormat?: 'array' | 'string';
  reportSelfMessage?: boolean;
  heartInterval?: number;
  debug?: boolean;
}

/**
 * Reverse-WS adapter. Connects out to a remote endpoint, surfaces inbound
 * action frames to the handler, and reconnects on disconnect with a fixed
 * delay (no exponential backoff — OneBot deployments typically want quick
 * recovery and the remote is usually on the LAN).
 */
export class WsClientAdapter implements NetworkAdapter {
  readonly id: string;
  readonly kind = 'ws-client' as const;
  readonly options: TransportRuntimeOptions;

  private ws: WebSocket | null = null;
  private handler: WireHandler | null = null;
  private stopped = false;
  private reconnectTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opts: WsClientOptions) {
    this.id = opts.id;
    this.options = resolveTransportOptions(opts);
  }

  async start(handler: WireHandler): Promise<void> {
    this.handler = handler;
    this.stopped = false;
    this.connect();
  }

  push(event: unknown): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(event));
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const ws = this.ws;
    this.ws = null;
    if (ws) ws.close(1001, 'shutdown');
  }

  private connect(): void {
    const headers: Record<string, string> = {};
    if (this.opts.accessToken) headers['Authorization'] = `Bearer ${this.opts.accessToken}`;
    const ws = new WebSocket(this.opts.url, { headers });
    this.ws = ws;

    ws.on('message', (data) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        return;
      }
      this.handler?.onAction(parsed, (resp) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(resp));
      });
    });

    const scheduleReconnect = (): void => {
      if (this.stopped) return;
      this.reconnectTimer = setTimeout(() => this.connect(), this.opts.reconnectIntervalMs);
    };
    ws.on('close', scheduleReconnect);
    ws.on('error', () => {
      // 'close' will fire after 'error'; let it drive reconnection.
    });
  }
}
