import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WsServerAdapter } from '../src/network/ws-server';

// v0.4n-housekeeping-13: locks the bufferedAmount-watch observer added in
// housekeeping-12. We stub a WebSocket-shaped object and shove it into the
// adapter's `clients` set so we can drive `bufferedAmount` without standing
// up a real socket. Spy on console.warn to assert the rate-limited warn.

interface StubWs {
  readyState: number;
  OPEN: number;
  bufferedAmount: number;
  sent: string[];
  send(data: string): void;
}

function makeStubClient(): StubWs {
  const ws: StubWs = {
    readyState: 1, // WebSocket.OPEN
    OPEN: 1,
    bufferedAmount: 0,
    sent: [],
    send(data) {
      this.sent.push(data);
    },
  };
  return ws;
}

function injectClient(adapter: WsServerAdapter, ws: StubWs): void {
  // `clients` is a private Set<WebSocket>; we cast for test access.
  (adapter as unknown as { clients: Set<unknown> }).clients.add(ws);
}

describe('WsServerAdapter backpressure observer', () => {
  let adapter: WsServerAdapter;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    adapter = new WsServerAdapter({ id: 'test', host: '127.0.0.1', port: 0 });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    vi.useRealTimers();
  });

  it('does not warn when bufferedAmount is below threshold', () => {
    const ws = makeStubClient();
    injectClient(adapter, ws);
    ws.bufferedAmount = 500_000; // half a MB, below 1 MB threshold

    adapter.push({ kind: 'noisy' });
    adapter.push({ kind: 'noisier' });

    expect(warnSpy).not.toHaveBeenCalled();
    expect(ws.sent).toHaveLength(2);
  });

  it('warns once when bufferedAmount crosses the 1 MB threshold', () => {
    const ws = makeStubClient();
    injectClient(adapter, ws);
    ws.bufferedAmount = 2_000_000;

    adapter.push({ kind: 'msg' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const [msg] = warnSpy.mock.calls[0]!;
    expect(String(msg)).toMatch(/ws-server test/);
    expect(String(msg)).toMatch(/backpressure/);
    expect(String(msg)).toMatch(/2000000/);
  });

  it('rate-limits subsequent warns within the 30s window (per client)', () => {
    const ws = makeStubClient();
    injectClient(adapter, ws);
    ws.bufferedAmount = 5_000_000;

    adapter.push({ kind: 'a' });
    adapter.push({ kind: 'b' });
    adapter.push({ kind: 'c' });

    // First push warns; next two should be suppressed.
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('warns again after the 30s rate-limit window elapses', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-24T00:00:00Z'));

    const ws = makeStubClient();
    injectClient(adapter, ws);
    ws.bufferedAmount = 5_000_000;

    adapter.push({ kind: 'a' });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 25s later — still inside the window, no new warn.
    vi.setSystemTime(new Date('2026-05-24T00:00:25Z'));
    adapter.push({ kind: 'b' });
    expect(warnSpy).toHaveBeenCalledTimes(1);

    // 35s later — outside the window, another warn fires.
    vi.setSystemTime(new Date('2026-05-24T00:00:35Z'));
    adapter.push({ kind: 'c' });
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('tracks each client independently (one slow + one fast = one warn)', () => {
    const slow = makeStubClient();
    const fast = makeStubClient();
    injectClient(adapter, slow);
    injectClient(adapter, fast);

    slow.bufferedAmount = 5_000_000;
    fast.bufferedAmount = 100_000;

    adapter.push({ kind: 'broadcast' });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(slow.sent).toHaveLength(1);
    expect(fast.sent).toHaveLength(1);
  });

  it('skips clients whose readyState is not OPEN', () => {
    const closed = makeStubClient();
    closed.readyState = 3; // CLOSED
    closed.bufferedAmount = 5_000_000;
    injectClient(adapter, closed);

    adapter.push({ kind: 'msg' });

    expect(closed.sent).toHaveLength(0);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
