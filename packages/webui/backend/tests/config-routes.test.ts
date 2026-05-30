import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, loadConfig, RingBufferTransport, createLogger, type QanYiCatConfig } from '@qanyicat/core';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebUI, type WebUIServerHandle } from '../src/server';
import type { ConfigMutationResultDto, SanitizedConfigDto } from '../../shared/dto';

/**
 * Integration tests for the v0.4p config-edit endpoints. Spins up the real
 * Hono server, logs in, and exercises:
 *   - GET   /api/config              (extended DTO with per-adapter knobs)
 *   - POST  /api/config/networks     (create)
 *   - PUT   /api/config/networks/:id (update)
 *   - DELETE /api/config/networks/:id (remove)
 *   - PUT   /api/config/onebot       (atomic patch)
 *   - POST  /api/config/export       (write to disk)
 *
 * Each mutation also triggers `onConfigUpdate` — assert that the hot-reload
 * hook fires.
 */
describe('WebUI config edit routes', () => {
  let cfgDir: string;
  let baseUrl: string;
  let handle: WebUIServerHandle;
  let token: string;
  let reloadInvocations: Array<QanYiCatConfig['onebot']>;

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-cfg-edit-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(
      cfgPath,
      JSON.stringify({
        qq: {},
        log: { level: 'info' },
        onebot: {
          enable11: true,
          accessToken: 'global-secret',
          networks: [
            { kind: 'ws-server', id: 'ws-existing', port: 5701, host: '127.0.0.1', protocol: 'v11' },
          ],
        },
        process: {},
        webui: { enable: true, port: 5099, password: 'sekrit', jwtSecret: 'jwt-test-secret' },
      })
    );
    const config = loadConfig({ path: cfgPath });
    const ringBuffer = new RingBufferTransport(50);
    const logger = createLogger({ label: 'test', ringBuffer });
    const ctx = createMemoryContext({ uin: '10000', logger });
    reloadInvocations = [];
    handle = await initWebUI({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'jwt-test-secret',
      webuiPassword: 'sekrit',
      ctx,
      config,
      logs: ringBuffer,
      startedAt: Date.now(),
      exportPath: join(cfgDir, 'exported.json'),
      onConfigUpdate: async (next) => { reloadInvocations.push(next); },
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
    const loginR = await fetch(`${baseUrl}/api/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sekrit' }),
    });
    token = ((await loginR.json()) as { token: string }).token;
  });

  afterEach(async () => {
    if (handle) await handle.close();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  async function get(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { headers: { Authorization: `Bearer ${token}` } });
  }
  async function post(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function put(path: string, body: unknown): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }
  async function del(path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
  }

  it('GET /config returns the extended DTO with networks + accessToken plaintext', async () => {
    const r = await get('/api/config');
    expect(r.status).toBe(200);
    const dto = (await r.json()) as SanitizedConfigDto;
    expect(dto.onebot.accessTokenSet).toBe(true);
    expect(dto.onebot.accessToken).toBe('global-secret');
    expect(dto.onebot.networks).toHaveLength(1);
    expect(dto.onebot.networks[0]).toMatchObject({ id: 'ws-existing', kind: 'ws-server', port: 5701 });
  });

  it('POST /config/networks adds a new entry and triggers reload', async () => {
    const r = await post('/api/config/networks', {
      kind: 'http-server', host: '127.0.0.1', port: 5800, protocol: 'v11',
      heartInterval: 60_000, reportSelfMessage: true,
    });
    expect(r.status).toBe(200);
    const result = (await r.json()) as ConfigMutationResultDto;
    expect(result.ok).toBe(true);
    expect(result.config.onebot.networks).toHaveLength(2);
    const added = result.config.onebot.networks.find((n) => n.kind === 'http-server');
    expect(added).toMatchObject({ port: 5800, heartInterval: 60_000, reportSelfMessage: true });
    expect(reloadInvocations).toHaveLength(1);
    expect(reloadInvocations[0]!.networks).toHaveLength(2);
  });

  it('POST /config/networks rejects duplicate ids with 409', async () => {
    const r = await post('/api/config/networks', {
      id: 'ws-existing', kind: 'ws-server', host: '127.0.0.1', port: 6000, protocol: 'v11',
    });
    expect(r.status).toBe(409);
    expect(reloadInvocations).toHaveLength(0);
  });

  it('POST /config/networks rejects invalid entry with 400', async () => {
    const r = await post('/api/config/networks', {
      kind: 'ws-server', host: '127.0.0.1', port: 999_999, protocol: 'v11',
    });
    expect(r.status).toBe(400);
  });

  it('PUT /config/networks/:id updates an entry in place', async () => {
    const r = await put('/api/config/networks/ws-existing', {
      id: 'ws-existing', kind: 'ws-server', host: '127.0.0.1', port: 6000, protocol: 'v11',
      heartInterval: 10_000, messagePostFormat: 'string',
    });
    expect(r.status).toBe(200);
    const result = (await r.json()) as ConfigMutationResultDto;
    const updated = result.config.onebot.networks[0]!;
    expect(updated.port).toBe(6000);
    expect(updated.heartInterval).toBe(10_000);
    expect(updated.messagePostFormat).toBe('string');
    expect(reloadInvocations).toHaveLength(1);
  });

  it('PUT /config/networks/:id returns 404 for an unknown id', async () => {
    const r = await put('/api/config/networks/does-not-exist', {
      id: 'does-not-exist', kind: 'ws-server', host: '127.0.0.1', port: 5701, protocol: 'v11',
    });
    expect(r.status).toBe(404);
  });

  it('DELETE /config/networks/:id removes the entry', async () => {
    const r = await del('/api/config/networks/ws-existing');
    expect(r.status).toBe(200);
    const result = (await r.json()) as ConfigMutationResultDto;
    expect(result.config.onebot.networks).toHaveLength(0);
    expect(reloadInvocations).toHaveLength(1);
  });

  it('PUT /config/onebot patches enable12 + accessToken without touching networks', async () => {
    const r = await put('/api/config/onebot', { enable12: true, accessToken: 'new-secret' });
    expect(r.status).toBe(200);
    const result = (await r.json()) as ConfigMutationResultDto;
    expect(result.config.onebot.enable12).toBe(true);
    expect(result.config.onebot.accessToken).toBe('new-secret');
    expect(result.config.onebot.networks).toHaveLength(1);
  });

  it('PUT /config/onebot accepts accessToken=null to clear it', async () => {
    const r = await put('/api/config/onebot', { accessToken: null });
    expect(r.status).toBe(200);
    const result = (await r.json()) as ConfigMutationResultDto;
    expect(result.config.onebot.accessToken).toBeNull();
    expect(result.config.onebot.accessTokenSet).toBe(false);
  });

  it('POST /config/export writes JSON to disk', async () => {
    const r = await post('/api/config/export', {});
    expect(r.status).toBe(200);
    const result = (await r.json()) as { path: string; bytes: number };
    const written = readFileSync(result.path, 'utf8');
    const parsed = JSON.parse(written) as QanYiCatConfig;
    expect(parsed.onebot.enable11).toBe(true);
    expect(parsed.onebot.networks).toHaveLength(1);
    expect(result.bytes).toBeGreaterThan(0);
  });

  it('reload error from onConfigUpdate surfaces as 500', async () => {
    await handle.close();
    const cfgPath = join(cfgDir, 'c2.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    const failHandle = await initWebUI({
      port: 0,
      host: '127.0.0.1',
      jwtSecret: 'jwt-test-secret',
      webuiPassword: 'sekrit',
      ctx: createMemoryContext({ uin: '10000' }),
      config: loadConfig({ path: cfgPath }),
      startedAt: Date.now(),
      onConfigUpdate: async () => { throw new Error('manager stop failed'); },
    });
    const url2 = `http://127.0.0.1:${failHandle.port}`;
    const loginR = await fetch(`${url2}/api/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'sekrit' }),
    });
    const tok = ((await loginR.json()) as { token: string }).token;
    const r = await fetch(`${url2}/api/config/onebot`, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${tok}`, 'content-type': 'application/json' },
      body: JSON.stringify({ enable11: false }),
    });
    expect(r.status).toBe(500);
    await failHandle.close();
  });
});
