import WebSocket from 'ws';
import type { SdkEvent } from '../types/index.js';

export interface WsClientOptions {
  url: string;
  token?: string;
}

export interface WsClient {
  send(frame: unknown): void;
  onEvent(handler: (event: SdkEvent) => void): void;
  onResponse(handler: (resp: unknown) => void): void;
  close(): void;
}

export function createWebSocketClient(opts: WsClientOptions): WsClient {
  const headers: Record<string, string> = {};
  if (opts.token) headers['Authorization'] = `Bearer ${opts.token}`;
  const ws = new WebSocket(opts.url, { headers });

  let onEvent: ((e: SdkEvent) => void) | null = null;
  let onResp: ((r: unknown) => void) | null = null;

  ws.on('message', (data: WebSocket.RawData) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(data.toString()) as Record<string, unknown>;
    } catch {
      return;
    }
    if ('echo' in parsed || ('retcode' in parsed && !('post_type' in parsed))) {
      onResp?.(parsed);
      return;
    }
    const event = toSdkEvent(parsed);
    if (event) onEvent?.(event);
  });

  return {
    send(frame) {
      ws.send(JSON.stringify(frame));
    },
    onEvent(h) {
      onEvent = h;
    },
    onResponse(h) {
      onResp = h;
    },
    close() {
      ws.close();
    },
  };
}

/** Map an OB11 wire event to the SDK's unified-kind shape. */
function toSdkEvent(frame: Record<string, unknown>): SdkEvent | null {
  const postType = frame['post_type'];
  switch (postType) {
    case 'message':
    case 'message_sent':
      return {
        kind: 'message',
        message: {
          id: String(frame['message_id'] ?? ''),
          scene: frame['message_type'] === 'group' ? 'group' : 'private',
          selfId: String(frame['self_id'] ?? ''),
          sender: extractSender(frame),
          peer:
            frame['message_type'] === 'group'
              ? { type: 'group', id: String(frame['group_id'] ?? '') }
              : { type: 'user', id: String((frame['sender'] as { user_id?: number })?.user_id ?? '') },
          segments: (frame['message'] as never) ?? [],
          timestamp: Number(frame['time'] ?? 0) * 1000,
        },
      };
    case 'meta_event':
      return { kind: 'meta', sub: String(frame['meta_event_type'] ?? 'unknown'), ...frame };
    case 'notice':
      return { kind: 'notice', sub: String(frame['notice_type'] ?? 'unknown'), ...frame };
    case 'request':
      return { kind: 'request', sub: String(frame['request_type'] ?? 'unknown'), ...frame };
    default:
      return null;
  }
}

function extractSender(frame: Record<string, unknown>): SdkEvent extends { kind: 'message'; message: { sender: infer S } } ? S : never {
  const s = (frame['sender'] ?? {}) as Record<string, unknown>;
  return {
    uid: String(s['user_id'] ?? ''),
    uin: String(s['user_id'] ?? ''),
    nickname: typeof s['nickname'] === 'string' ? s['nickname'] : '',
    ...(typeof s['card'] === 'string' ? { card: s['card'] } : {}),
    ...(typeof s['role'] === 'string' ? { role: s['role'] as 'owner' | 'admin' | 'member' } : {}),
  } as SdkEvent extends { kind: 'message'; message: { sender: infer S } } ? S : never;
}
