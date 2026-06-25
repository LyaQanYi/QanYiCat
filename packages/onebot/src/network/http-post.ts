import { createHmac } from 'node:crypto';
import type { TransportRuntimeOptions } from '@qanyicat/core';
import { resolveTransportOptions, type NetworkAdapter, type WireHandler } from './network-adapter';

export interface HttpPostOptions {
  id: string;
  url: string;
  secret?: string;
  timeoutMs: number;
  messagePostFormat?: 'array' | 'string';
  reportSelfMessage?: boolean;
  heartInterval?: number;
  debug?: boolean;
}

/**
 * Push-only adapter: fire-and-forget POST per event. Failed pushes are logged
 * but never retried — the upstream consumer is expected to be idempotent (or
 * to reconcile via a separate ws/http transport).
 */
export class HttpPostAdapter implements NetworkAdapter {
  readonly id: string;
  readonly kind = 'http-post' as const;
  readonly options: TransportRuntimeOptions;
  private active = false;

  constructor(private readonly opts: HttpPostOptions) {
    this.id = opts.id;
    this.options = resolveTransportOptions(opts);
  }

  async start(_handler: WireHandler): Promise<void> {
    this.active = true;
  }

  push(event: unknown): void {
    if (!this.active) return;
    const body = JSON.stringify(event);
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (this.opts.secret) {
      const sig = createHmac('sha1', this.opts.secret).update(body).digest('hex');
      headers['x-signature'] = `sha1=${sig}`;
    }
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), this.opts.timeoutMs);
    void fetch(this.opts.url, { method: 'POST', headers, body, signal: ctl.signal })
      .catch(() => {
        // intentionally swallowed — see class doc
      })
      .finally(() => clearTimeout(timer));
  }

  async stop(): Promise<void> {
    this.active = false;
  }
}
