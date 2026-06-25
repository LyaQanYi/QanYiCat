import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, loadConfig } from '@qanyicat/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebUI, type WebUIServerHandle } from '../src/server';

describe('WebUI /api/wire/:action', () => {
  let cfgDir: string;
  let baseUrl: string;
  let handle: WebUIServerHandle;
  let token: string;
  let invocations: Array<{ action: string; params: unknown; protocol: 'v11' | 'v12' | undefined }>;
  let invokerReply: unknown = { ok: 'stubbed' };
  let invokerError: Error | null = null;

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-wire-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    invocations = [];
    invokerError = null;
    invokerReply = { stubbed: true };
    handle = await initWebUI({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'wire-jwt',
      webuiPassword: 'sekrit',
      ctx: createMemoryContext({ uin: '10000' }),
      config: loadConfig({ path: cfgPath }),
      startedAt: Date.now(),
      onActionInvoke: async (action, params, protocol) => {
        invocations.push({ action, params, protocol });
        if (invokerError) throw invokerError;
        return invokerReply;
      },
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

  async function postWire(action: string, body: unknown, qs = ''): Promise<Response> {
    return fetch(`${baseUrl}/api/wire/${action}${qs}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('forwards the action + params to onActionInvoke and returns its result', async () => {
    invokerReply = { status: 'ok', retcode: 0, data: { online: true } };
    const r = await postWire('get_status', {});
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; elapsedMs: number; response: unknown };
    expect(body.ok).toBe(true);
    expect(typeof body.elapsedMs).toBe('number');
    expect(body.response).toEqual(invokerReply);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]!.action).toBe('get_status');
    expect(invocations[0]!.protocol).toBe('v11');
  });

  it('passes through arbitrary JSON params', async () => {
    invokerReply = { status: 'ok', retcode: 0, data: null };
    await postWire('send_msg', { user_id: 12345, message: 'hi' });
    expect(invocations[0]!.params).toEqual({ user_id: 12345, message: 'hi' });
  });

  it('honors ?protocol=v12 querystring', async () => {
    await postWire('send_message', {}, '?protocol=v12');
    expect(invocations[0]!.protocol).toBe('v12');
  });

  it('returns 500 with elapsedMs + error message when the invoker throws', async () => {
    invokerError = new Error('NT call failed');
    const r = await postWire('send_msg', {});
    expect(r.status).toBe(500);
    const body = (await r.json()) as { ok: boolean; elapsedMs: number; error: string };
    expect(body.ok).toBe(false);
    expect(body.error).toBe('NT call failed');
    expect(typeof body.elapsedMs).toBe('number');
  });

  it('returns 400 on malformed JSON body', async () => {
    const r = await fetch(`${baseUrl}/api/wire/get_status`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: 'not-json-{{{',
    });
    expect(r.status).toBe(400);
    expect(invocations).toHaveLength(0);
  });

  it('returns 503 when onActionInvoke is not configured', async () => {
    await handle.close();
    const cfgPath = join(cfgDir, 'c2.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    const noinv = await initWebUI({
      port: 0, host: '127.0.0.1',
      jwtSecret: 'wire-jwt', webuiPassword: 'sekrit',
      ctx: createMemoryContext({ uin: '10000' }),
      config: loadConfig({ path: cfgPath }),
      startedAt: Date.now(),
    });
    const url2 = `http://127.0.0.1:${noinv.port}`;
    const loginR = await fetch(`${url2}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sekrit' }),
    });
    const tok = ((await loginR.json()) as { token: string }).token;
    const r = await fetch(`${url2}/api/wire/get_status`, {
      method: 'POST', headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(r.status).toBe(503);
    await noinv.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const r = await fetch(`${baseUrl}/api/wire/get_status`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(r.status).toBe(401);
  });
});
