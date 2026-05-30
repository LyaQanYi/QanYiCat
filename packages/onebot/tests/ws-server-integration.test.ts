import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import type { AddressInfo } from 'node:net';
import { createMemoryContext } from '@qanyicat/core';
import { _resetActionRegistry, registerAction } from '@qanyicat/protocol';
import { WsServerAdapter } from '../src/network/ws-server';
import { ActionDispatcher } from '../src/dispatch/action-dispatcher';

/**
 * End-to-end: real WebSocket client → WsServerAdapter → ActionDispatcher →
 * registered action → response back on the wire. Covers auth, frame
 * routing, and ack plumbing without involving OB11/12 wire formats.
 */
describe('WsServerAdapter integration', () => {
  let adapter: WsServerAdapter;

  beforeEach(() => {
    _resetActionRegistry();
    registerAction('ping', async () => ({ pong: true }));
  });

  afterEach(async () => {
    if (adapter) await adapter.stop();
  });

  it('routes an inbound action to the dispatcher and echoes the response', async () => {
    const ctx = createMemoryContext({ uin: '10000' });
    const dispatcher = new ActionDispatcher(ctx);
    adapter = new WsServerAdapter({ id: 't1', host: '127.0.0.1', port: 0, protocol: 'v11' });
    await adapter.start({
      onAction: (raw, ack) => {
        const frame = raw as { action: string; params?: unknown; echo?: string };
        void dispatcher.invoke(frame.action, frame.params, frame.echo).then(ack);
      },
    });

    const port = currentPort(adapter);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.on('open', () => r()));

    const resp = await new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
      ws.send(JSON.stringify({ action: 'ping', params: {}, echo: 'e1' }));
    });

    expect(resp).toEqual({ status: 'ok', retcode: 0, data: { pong: true }, echo: 'e1' });
    ws.close();
  });

  it('rejects ws upgrade when access token is missing', async () => {
    adapter = new WsServerAdapter({
      id: 't2', host: '127.0.0.1', port: 0, accessToken: 'sekrit', protocol: 'v11',
    });
    await adapter.start({ onAction: () => undefined });

    const port = currentPort(adapter);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const err = await new Promise<Error>((resolve) => {
      ws.on('error', resolve);
      ws.on('open', () => resolve(new Error('unexpectedly opened')));
    });
    expect(err.message).toMatch(/401/);
  });

  it('accepts ws upgrade when access token matches', async () => {
    adapter = new WsServerAdapter({
      id: 't3', host: '127.0.0.1', port: 0, accessToken: 'sekrit', protocol: 'v11',
    });
    await adapter.start({ onAction: () => undefined });
    const port = currentPort(adapter);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: 'Bearer sekrit' } });
    await new Promise<void>((r, j) => {
      ws.on('open', () => r());
      ws.on('error', j);
    });
    ws.close();
  });

  it('broadcasts pushed events to all connected clients', async () => {
    adapter = new WsServerAdapter({ id: 't4', host: '127.0.0.1', port: 0, protocol: 'v11' });
    await adapter.start({ onAction: () => undefined });
    const port = currentPort(adapter);

    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((r) => ws.on('open', () => r()));

    const received = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (data) => resolve(JSON.parse(data.toString())));
    });
    adapter.push({ hello: 'world' });
    expect(await received).toEqual({ hello: 'world' });
    ws.close();
  });
});

/** Reach into ws-server internals via the http server to discover the port
 * after binding to port 0. Avoids hard-coding ports in tests. */
function currentPort(adapter: WsServerAdapter): number {
  const http = (adapter as unknown as { http: { address(): AddressInfo | null } | null }).http;
  const addr = http?.address();
  if (!addr) throw new Error('adapter not listening');
  return addr.port;
}
