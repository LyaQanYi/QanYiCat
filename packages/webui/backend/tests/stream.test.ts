import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { createMemoryContext, createLogger, loadConfig, RingBufferTransport } from '@qanyicat/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebUI, type WebUIServerHandle } from '../src/server';

/**
 * Live-stream WebSocket: JWT auth on upgrade, fans out NT events + log lines.
 * Tests boot the real server, login over HTTP, then open ws://.../api/stream?token=…
 */
describe('WebUI /api/stream', () => {
  let cfgDir: string;
  let baseUrl: string;
  let handle: WebUIServerHandle;
  let token: string;
  let ringBuffer: RingBufferTransport;
  let ctx: ReturnType<typeof createMemoryContext>;

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-stream-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    ringBuffer = new RingBufferTransport(50);
    const logger = createLogger({ label: 'test', ringBuffer });
    ctx = createMemoryContext({ uin: '10000', logger });
    handle = await initWebUI({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'stream-test-secret',
      webuiPassword: 'sekrit',
      ctx,
      config: loadConfig({ path: cfgPath }),
      logs: ringBuffer,
      startedAt: Date.now(),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const r = await fetch(`${baseUrl}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sekrit' }),
    });
    token = ((await r.json()) as { token: string }).token;
  });

  afterEach(async () => {
    if (handle) await handle.close();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  function connect(qs: string): Promise<{ ws: WebSocket; messages: unknown[] }> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/stream${qs}`);
      const messages: unknown[] = [];
      ws.on('open', () => resolve({ ws, messages }));
      ws.on('error', reject);
      ws.on('message', (data) => messages.push(JSON.parse(data.toString())));
    });
  }

  it('rejects upgrade without a token', async () => {
    const err = await new Promise<Error>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/stream`);
      ws.on('error', resolve);
      ws.on('open', () => resolve(new Error('unexpectedly opened')));
    });
    expect(err.message).toMatch(/401/);
  });

  it('rejects upgrade with a bogus token', async () => {
    const err = await new Promise<Error>((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${handle.port}/api/stream?token=garbage`);
      ws.on('error', resolve);
      ws.on('open', () => resolve(new Error('unexpectedly opened')));
    });
    expect(err.message).toMatch(/401/);
  });

  it('sends a hello frame on connect', async () => {
    const { ws, messages } = await connect(`?token=${token}`);
    await new Promise((r) => setTimeout(r, 50));
    expect(messages[0]).toMatchObject({ type: 'hello' });
    ws.close();
  });

  it('fans out an emitted NT event to connected clients', async () => {
    const { ws, messages } = await connect(`?token=${token}`);
    await new Promise((r) => setTimeout(r, 30));
    ctx.events.emit('friend.request', { uid: 'u_test', comment: 'hi', reqTime: '0', doubt: false });
    await new Promise((r) => setTimeout(r, 30));
    const evt = (messages as Array<{ type: string }>).find((m) => m.type === 'event');
    expect(evt).toMatchObject({ type: 'event', kind: 'friend.request' });
    ws.close();
  });

  it('streams new log lines as they hit the ring buffer', async () => {
    const { ws, messages } = await connect(`?token=${token}`);
    await new Promise((r) => setTimeout(r, 30));
    ringBuffer.log(
      { level: 'info', message: 'streamed-line', label: 'test', timestamp: new Date().toISOString() },
      () => undefined
    );
    await new Promise((r) => setTimeout(r, 700));
    const logFrame = (messages as Array<{ type: string; line?: { message: string } }>).find(
      (m) => m.type === 'log' && m.line?.message === 'streamed-line'
    );
    expect(logFrame).toBeTruthy();
    ws.close();
  });
});
