import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, loadConfig, RingBufferTransport, createLogger } from '@qanyicat/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebUI, type WebUIServerHandle } from '../src/server';

/**
 * Spins up the real WebUI Hono server on an ephemeral port and exercises the
 * public + protected routes via fetch. Catches regressions in route mounting,
 * JWT middleware, and DTO shape.
 */
describe('WebUI routes', () => {
  let cfgDir: string;
  let baseUrl: string;
  let handle: WebUIServerHandle;

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-webui-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        qq: {},
        log: { level: 'info' },
        onebot: {
          enable11: true,
          networks: [{ kind: 'ws-server', id: 'ws-1', port: 5701 }],
        },
        process: {},
        webui: { enable: true, port: 5099, password: 'sekrit', jwtSecret: 'jwt-test-secret' },
      })
    );
    const config = loadConfig({ path: cfgPath });
    const ringBuffer = new RingBufferTransport(50);
    const logger = createLogger({ label: 'test', ringBuffer });
    logger.info('hello from log buffer');
    const ctx = createMemoryContext({ uin: '10000', logger });

    handle = await initWebUI({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'jwt-test-secret',
      webuiPassword: 'sekrit',
      ctx,
      config,
      logs: ringBuffer,
      startedAt: Date.now() - 5_000,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    if (handle) await handle.close();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('rejects /api/instance without a token', async () => {
    const r = await fetch(`${baseUrl}/api/instance`);
    expect(r.status).toBe(401);
  });

  it('rejects /api/login with the wrong password', async () => {
    const r = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'wrong' }),
    });
    expect(r.status).toBe(401);
  });

  it('round-trips: login → token → /api/instance, /api/config, /api/logs', async () => {
    const login = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sekrit' }),
    });
    expect(login.status).toBe(200);
    const { token } = (await login.json()) as { token: string };
    expect(token).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);

    const instance = await fetchAuth(`${baseUrl}/api/instance`, token);
    expect(instance).toMatchObject({ uin: '10000', online: true, qqVersion: '0.0.0-memory' });
    expect((instance as { uptimeSec: number }).uptimeSec).toBeGreaterThanOrEqual(5);

    const config = await fetchAuth(`${baseUrl}/api/config`, token);
    expect(config).toMatchObject({
      log: { level: 'info' },
      onebot: { enable11: true, enable12: false, accessTokenSet: false },
    });

    const logs = (await fetchAuth(`${baseUrl}/api/logs`, token)) as {
      lines: Array<{ message: string }>;
    };
    expect(logs.lines.some((l) => l.message === 'hello from log buffer')).toBe(true);
  });
});

async function fetchAuth(url: string, token: string): Promise<unknown> {
  const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}
