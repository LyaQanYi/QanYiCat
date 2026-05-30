import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createMemoryContext,
  loadConfig,
  type InstanceContext,
  type QanYiCatConfig,
} from '@qanyicat/core';
import { OneBotManager } from '@qanyicat/onebot';
import { initWebUI, type WebUIServerHandle } from '@qanyicat/webui-backend';

// End-to-end shape test for the bridge's wiring of the WebUI's /api/wire route
// to a real OneBotManager. Existing wire.test.ts stubs onActionInvoke; this
// test substitutes the actual manager + memory-context so any regression in
// wire-params translation, dispatcher routing, or event-bus echo propagates to
// a failing test instead of a live-smoke surprise.

describe('webui /api/wire ↔ OneBotManager ↔ memory-context (end-to-end)', () => {
  let ctx: InstanceContext;
  let mgr: OneBotManager;
  let handle: WebUIServerHandle;
  let baseUrl: string;
  let token: string;
  let cfgDir: string;

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-wire-int-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        qq: {},
        log: { level: 'info' },
        onebot: { enable11: true, enable12: true, networks: [] },
        process: {},
        webui: { enable: true, port: 5099, password: 'sekrit' },
      })
    );

    ctx = createMemoryContext({ uin: '10000', nick: 'integration-bot' });
    const obCfg: QanYiCatConfig['onebot'] = {
      enable11: true,
      enable12: true,
      networks: [],
    };
    mgr = new OneBotManager(ctx, obCfg);
    await mgr.start();

    handle = await initWebUI({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'int-jwt',
      webuiPassword: 'sekrit',
      ctx,
      config: loadConfig({ path: cfgPath }),
      startedAt: Date.now(),
      onActionInvoke: (action, params, protocol) =>
        mgr.invokeAction(action, params, protocol ?? 'v11'),
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;

    const r = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sekrit' }),
    });
    token = ((await r.json()) as { token: string }).token;
  });

  afterEach(async () => {
    if (handle) await handle.close();
    if (mgr) await mgr.stop();
    if (ctx) await ctx.dispose();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  async function postWire(action: string, body: unknown, qs = ''): Promise<{
    ok: boolean;
    elapsedMs: number;
    response?: { status: string; retcode: number; data: unknown; message?: string };
    error?: string;
  }> {
    const r = await fetch(`${baseUrl}/api/wire/${action}${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return (await r.json()) as ReturnType<typeof postWire> extends Promise<infer T> ? T : never;
  }

  it('OB11 get_login_info returns real ctx-derived user_id + nickname', async () => {
    const body = await postWire('get_login_info', {});
    expect(body.ok).toBe(true);
    expect(body.response?.status).toBe('ok');
    expect(body.response?.retcode).toBe(0);
    expect(body.response?.data).toEqual({ user_id: 10000, nickname: 'integration-bot' });
  });

  it('OB11 get_status mirrors ctx.selfInfo.online', async () => {
    const body = await postWire('get_status', {});
    expect(body.response?.data).toEqual({ online: true, good: true });
  });

  it('OB11 send_msg → memory-context echoes via msg.recv on the event bus', async () => {
    const echo = new Promise<{
      messages: Array<{ senderUid: string; senderUin: string; elements: Array<{ textElement?: { content: string } }> }>;
    }>((resolve) => ctx.events.on('msg.recv', resolve));

    const body = await postWire('send_msg', { user_id: 20000, message: 'hi via webui' });
    expect(body.response?.status).toBe('ok');

    const received = await echo;
    expect(received.messages).toHaveLength(1);
    expect(received.messages[0]!.senderUin).toBe('10000');
    expect(received.messages[0]!.elements[0]?.textElement?.content).toBe('hi via webui');
  });

  it('OB11 unknown action surfaces as ok:true wrapping failed-1404 (matches spec)', async () => {
    const body = await postWire('foo_bar_unknown', {});
    expect(body.ok).toBe(true);
    expect(body.response?.status).toBe('failed');
    expect(body.response?.retcode).toBe(1404);
    expect(body.response?.message ?? '').toMatch(/unknown action/);
  });

  it('?protocol=v12 routes through the OB12 adapter', async () => {
    const body = await postWire('get_status', {}, '?protocol=v12');
    expect(body.response?.status).toBe('ok');
    expect(body.response?.data).toEqual({ online: true, good: true });
  });

  it('targeting v12 when adapter disabled surfaces as ok:false with the manager error', async () => {
    // Stop+restart manager with enable12=false to prove the error reaches the
    // wire route's catch arm.
    await mgr.stop();
    mgr = new OneBotManager(ctx, { enable11: true, enable12: false, networks: [] });
    await mgr.start();

    const r = await fetch(`${baseUrl}/api/wire/get_status?protocol=v12`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(500);
    const body = (await r.json()) as { ok: boolean; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toMatch(/v12.*not enabled/);
  });
});
