import { useEffect, useRef, useState } from 'react';
import type { LogLineDto } from '../../shared/dto';

export type StreamConnectionState = 'connecting' | 'open' | 'closed';

export interface StreamHelloFrame {
  type: 'hello';
  startedAt: number;
  totalSeenLogs: number;
}

export interface StreamEventFrame {
  type: 'event';
  kind: string;
  data: unknown;
}

export interface StreamLogFrame {
  type: 'log';
  line: LogLineDto;
}

export type StreamFrame = StreamHelloFrame | StreamEventFrame | StreamLogFrame;

export interface UseStreamOptions {
  token: string | null;
  onFrame(frame: StreamFrame): void;
}

/**
 * WS connection to /api/stream with token-on-querystring auth + auto-reconnect.
 * Returns the live connection state for the dashboard's "live" indicator.
 *
 * Reconnect backs off exponentially capped at 30s. Token changes (re-login)
 * trigger a fresh socket; component unmount closes cleanly.
 */
export function useStream(opts: UseStreamOptions): StreamConnectionState {
  const [state, setState] = useState<StreamConnectionState>('closed');
  const onFrameRef = useRef(opts.onFrame);
  onFrameRef.current = opts.onFrame;

  useEffect(() => {
    if (!opts.token) {
      setState('closed');
      return;
    }
    let ws: WebSocket | null = null;
    let cancelled = false;
    let backoff = 500;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const connect = (): void => {
      if (cancelled) return;
      setState('connecting');
      const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${proto}//${location.host}/api/stream?token=${encodeURIComponent(opts.token!)}`;
      const sock = new WebSocket(url);
      ws = sock;
      sock.addEventListener('open', () => {
        backoff = 500;
        setState('open');
      });
      sock.addEventListener('message', (ev) => {
        try { onFrameRef.current(JSON.parse(ev.data as string) as StreamFrame); }
        catch { /* malformed frame — ignore */ }
      });
      const reconnect = (): void => {
        if (cancelled) return;
        setState('closed');
        retryTimer = setTimeout(connect, backoff);
        backoff = Math.min(backoff * 2, 30_000);
      };
      sock.addEventListener('close', reconnect);
      sock.addEventListener('error', () => sock.close());
    };

    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      if (ws) ws.close();
    };
  }, [opts.token]);

  return state;
}
