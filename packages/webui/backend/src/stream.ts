import type { Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import type { WebUIServerOptions } from './server.js';
import { verifyJwt } from './auth/jwt.js';

/**
 * Push channel for the dashboard.
 *
 * Wire protocol (JSON per frame, ws message = one frame):
 *   {type:'hello', startedAt, totalSeenLogs}
 *   {type:'event', kind, data}    — every forwarded NT event
 *   {type:'log', line}            — every new RingBufferLogLine
 *
 * Auth: caller MUST supply `?token=<jwt>` in the upgrade URL. We can't read
 * Authorization headers from a browser WebSocket constructor, so the token
 * goes via querystring (a browser WebSocket can't set request headers).
 */
export const STREAM_PATH = '/api/stream';

/** Same event kinds the OneBotManager forwards to wire clients. */
export const STREAM_EVENT_KINDS = [
  'msg.recv',
  'msg.recall',
  'group.member-change',
  'group.admin-change',
  'group.request',
  'friend.request',
  'login.success',
] as const;

type StreamEventKind = (typeof STREAM_EVENT_KINDS)[number];

export interface StreamServerHandle {
  /** Close all client sockets and stop accepting new ones. */
  close(): Promise<void>;
  /** Currently-connected sockets (for tests). */
  readonly clientCount: number;
}

export function attachStreamServer(
  server: Server,
  jwtSecret: string,
  opts: WebUIServerOptions
): StreamServerHandle {
  const wss = new WebSocketServer({ noServer: true });
  const clients = new Set<WebSocket>();
  const subscriptions: Array<{ dispose(): void }> = [];

  // Subscribe once to the event bus; fan out to every connected client.
  for (const kind of STREAM_EVENT_KINDS) {
    const sub = opts.ctx.events.on(kind, (payload: unknown) => {
      broadcast({ type: 'event', kind, data: payload });
    });
    subscriptions.push(sub);
  }

  // Poll the ring buffer for new lines. Polling at 500ms keeps load trivial
  // for chatty bots while still feeling instant to a watching operator.
  let lastSeen = opts.logs?.totalSeen() ?? 0;
  let lastTimestamp = Date.now();
  const pollTimer = opts.logs
    ? setInterval(() => {
        const current = opts.logs!.totalSeen();
        if (current === lastSeen) return;
        const newLines = opts.logs!.since(lastTimestamp);
        if (newLines.length > 0) {
          lastTimestamp = newLines[newLines.length - 1]!.timestamp;
          for (const line of newLines) broadcast({ type: 'log', line });
        }
        lastSeen = current;
      }, 500)
    : null;

  server.on('upgrade', (req, socket, head) => {
    if (!req.url) {
      socket.destroy();
      return;
    }
    const url = new URL(req.url, 'http://x');
    if (url.pathname !== STREAM_PATH) return; // let other upgrade handlers (if any) try
    const token = url.searchParams.get('token') ?? '';
    if (!token || !verifyJwt(token, jwtSecret)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws));
  });

  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
    ws.on('error', () => clients.delete(ws));
    safeSend(ws, {
      type: 'hello',
      startedAt: opts.startedAt,
      totalSeenLogs: opts.logs?.totalSeen() ?? 0,
    });
  });

  function broadcast(frame: { type: string; [k: string]: unknown }): void {
    const json = JSON.stringify(frame);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(json);
    }
  }

  function safeSend(ws: WebSocket, frame: object): void {
    try { ws.send(JSON.stringify(frame)); }
    catch { /* socket gone */ }
  }

  return {
    get clientCount() { return clients.size; },
    async close() {
      if (pollTimer) clearInterval(pollTimer);
      for (const sub of subscriptions) sub.dispose();
      for (const ws of clients) {
        try { ws.close(1001, 'shutdown'); } catch { /* already gone */ }
      }
      clients.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
    },
  };
}

export type { StreamEventKind };
