import { describe, expect, it, vi } from 'vitest';
import type { TransportRuntimeOptions } from '@qanyicat/core';
import { resolveTransportOptions, type NetworkAdapter } from '../src/network/network-adapter';
import { WsServerAdapter } from '../src/network/ws-server';
import { WsClientAdapter } from '../src/network/ws-client';
import { HttpServerAdapter } from '../src/network/http-server';
import { HttpPostAdapter } from '../src/network/http-post';
import { OneBot11Adapter } from '../src/adapters/ob11-adapter';
import { OneBot12Adapter } from '../src/adapters/ob12-adapter';
import { createMemoryContext } from '@qanyicat/core';

describe('resolveTransportOptions', () => {
  it('returns defaults for an empty entry', () => {
    expect(resolveTransportOptions({})).toEqual({
      messagePostFormat: 'array',
      reportSelfMessage: false,
      heartInterval: 30_000,
      debug: false,
    });
  });

  it('honors caller-supplied values', () => {
    expect(
      resolveTransportOptions({
        messagePostFormat: 'string',
        reportSelfMessage: true,
        heartInterval: 5000,
        debug: true,
      })
    ).toEqual({
      messagePostFormat: 'string',
      reportSelfMessage: true,
      heartInterval: 5000,
      debug: true,
    });
  });

  it('clamps negative heartInterval to default', () => {
    expect(resolveTransportOptions({ heartInterval: -100 }).heartInterval).toBe(30_000);
  });

  it('treats heartInterval=0 as "disabled" (preserved verbatim)', () => {
    expect(resolveTransportOptions({ heartInterval: 0 }).heartInterval).toBe(0);
  });

  it('rejects unknown messagePostFormat values, falling back to array', () => {
    expect(resolveTransportOptions({ messagePostFormat: 'cbor' as unknown as 'array' }).messagePostFormat).toBe('array');
  });
});

describe('Network adapter constructors expose options', () => {
  it.each([
    [
      'ws-server',
      () => new WsServerAdapter({ id: 'a', host: '127.0.0.1', port: 0, heartInterval: 1000, reportSelfMessage: true }),
    ],
    [
      'ws-client',
      () => new WsClientAdapter({ id: 'a', url: 'ws://x/', reconnectIntervalMs: 5000, messagePostFormat: 'string' }),
    ],
    [
      'http-server',
      () => new HttpServerAdapter({ id: 'a', host: '127.0.0.1', port: 0, debug: true }),
    ],
    [
      'http-post',
      () => new HttpPostAdapter({ id: 'a', url: 'http://x/', timeoutMs: 5000, heartInterval: 0 }),
    ],
  ])('%s carries resolved TransportRuntimeOptions', (_kind, factory) => {
    const adapter = factory();
    expect(adapter.options).toMatchObject({
      messagePostFormat: expect.any(String),
      reportSelfMessage: expect.any(Boolean),
      heartInterval: expect.any(Number),
      debug: expect.any(Boolean),
    });
  });
});

describe('OneBot11Adapter per-transport broadcast', () => {
  function makeTransport(opts: TransportRuntimeOptions): NetworkAdapter & { pushed: unknown[] } {
    const pushed: unknown[] = [];
    return {
      id: `t-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'ws-server',
      options: opts,
      async start() {},
      push(e) { pushed.push(e); },
      async stop() {},
      pushed,
    };
  }

  it('drops message_sent for transports with reportSelfMessage=false', async () => {
    const ctx = createMemoryContext({ uin: '10000' });
    const t1 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: false, heartInterval: 0, debug: false });
    const t2 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: true, heartInterval: 0, debug: false });
    const adapter = new OneBot11Adapter();
    await adapter.start(ctx, [t1, t2]);
    // Initial lifecycle.connect pushed to both (not a message event).
    expect(t1.pushed.length).toBe(1);
    expect(t2.pushed.length).toBe(1);
    adapter.onUnifiedEvent({
      kind: 'message',
      message: {
        id: 'm1', scene: 'private', selfId: '10000',
        sender: { uid: 'u_10000', uin: '10000', nickname: 'self' },
        peer: { type: 'user', id: '20000' },
        segments: [{ type: 'text', data: { text: 'hi' } }],
        timestamp: 0,
      },
    });
    // t1 (reportSelfMessage off) sees only the original lifecycle. t2 sees both.
    expect(t1.pushed.length).toBe(1);
    expect(t2.pushed.length).toBe(2);
    expect((t2.pushed[1] as { post_type: string }).post_type).toBe('message_sent');
    await adapter.stop();
  });

  it('converts to string message_format per transport without mutating the source', async () => {
    const ctx = createMemoryContext({ uin: '10000' });
    const t1 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: false, heartInterval: 0, debug: false });
    const t2 = makeTransport({ messagePostFormat: 'string', reportSelfMessage: false, heartInterval: 0, debug: false });
    const adapter = new OneBot11Adapter();
    await adapter.start(ctx, [t1, t2]);
    adapter.onUnifiedEvent({
      kind: 'message',
      message: {
        id: 'm1', scene: 'private', selfId: '10000',
        sender: { uid: 'u_20000', uin: '20000', nickname: 'peer' },
        peer: { type: 'user', id: '20000' },
        segments: [{ type: 'text', data: { text: 'hi' } }],
        timestamp: 0,
      },
    });
    const e1 = t1.pushed[1] as { message: unknown; message_format: string };
    const e2 = t2.pushed[1] as { message: unknown; message_format: string };
    expect(e1.message_format).toBe('array');
    expect(Array.isArray(e1.message)).toBe(true);
    expect(e2.message_format).toBe('string');
    expect(e2.message).toBe('hi');
    await adapter.stop();
  });

  it('schedules per-transport heartbeats — heartInterval=0 disables', async () => {
    vi.useFakeTimers();
    try {
      const ctx = createMemoryContext({ uin: '10000' });
      const t1 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: false, heartInterval: 100, debug: false });
      const t2 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: false, heartInterval: 0, debug: false });
      const adapter = new OneBot11Adapter();
      await adapter.start(ctx, [t1, t2]);
      const initial1 = t1.pushed.length;
      const initial2 = t2.pushed.length;
      vi.advanceTimersByTime(350);
      expect(t1.pushed.length).toBe(initial1 + 3);
      const hb = t1.pushed[t1.pushed.length - 1] as { meta_event_type: string; interval: number };
      expect(hb.meta_event_type).toBe('heartbeat');
      expect(hb.interval).toBe(100);
      expect(t2.pushed.length).toBe(initial2);
      await adapter.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('OneBot12Adapter per-transport broadcast', () => {
  function makeTransport(opts: TransportRuntimeOptions): NetworkAdapter & { pushed: unknown[] } {
    const pushed: unknown[] = [];
    return {
      id: `t-${Math.random().toString(36).slice(2, 7)}`,
      kind: 'ws-server',
      options: opts,
      async start() {},
      push(e) { pushed.push(e); },
      async stop() {},
      pushed,
    };
  }

  it('gates self-sent messages by user_id == selfId when reportSelfMessage off', async () => {
    const ctx = createMemoryContext({ uin: '10000' });
    const t1 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: false, heartInterval: 0, debug: false });
    const t2 = makeTransport({ messagePostFormat: 'array', reportSelfMessage: true, heartInterval: 0, debug: false });
    const adapter = new OneBot12Adapter();
    await adapter.start(ctx, [t1, t2]);
    adapter.onUnifiedEvent({
      kind: 'message',
      message: {
        id: 'm1', scene: 'private', selfId: '10000',
        sender: { uid: 'u_10000', uin: '10000' },
        peer: { type: 'user', id: '20000' },
        segments: [], timestamp: 0,
      },
    });
    // Both got the lifecycle connect; only t2 saw the self-sent message.
    const t1Msgs = (t1.pushed as Array<{ type?: string }>).filter((e) => e.type === 'message');
    const t2Msgs = (t2.pushed as Array<{ type?: string }>).filter((e) => e.type === 'message');
    expect(t1Msgs.length).toBe(0);
    expect(t2Msgs.length).toBe(1);
    await adapter.stop();
  });
});
