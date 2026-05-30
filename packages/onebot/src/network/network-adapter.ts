import type { TransportRuntimeOptions } from '@qanyicat/core';

export type NetworkAdapterKind = 'ws-server' | 'ws-client' | 'http-server' | 'http-post';

export interface WireHandler {
  /** Called with each parsed action frame; `ack` returns the response payload. */
  onAction(raw: unknown, ack: (resp: unknown) => void): void;
}

export interface NetworkAdapter {
  readonly id: string;
  readonly kind: NetworkAdapterKind;
  /** Per-transport knobs the protocol adapter uses to gate / format pushes. */
  readonly options: TransportRuntimeOptions;
  start(handler: WireHandler): Promise<void>;
  push(event: unknown): void;
  stop(): Promise<void>;
}

/**
 * Resolves the common per-transport knobs from a `NetworkConfigEntry`. Each
 * adapter delegates here so the same defaults apply everywhere.
 */
export function resolveTransportOptions(
  raw: Partial<TransportRuntimeOptions> & { messagePostFormat?: unknown; reportSelfMessage?: unknown; heartInterval?: unknown; debug?: unknown }
): TransportRuntimeOptions {
  return {
    messagePostFormat: raw.messagePostFormat === 'string' ? 'string' : 'array',
    reportSelfMessage: raw.reportSelfMessage === true,
    heartInterval: typeof raw.heartInterval === 'number' && raw.heartInterval >= 0 ? raw.heartInterval : 30_000,
    debug: raw.debug === true,
  };
}
