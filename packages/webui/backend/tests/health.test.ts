import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, loadConfig } from '@qanyicat/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebUI, type WebUIServerHandle } from '../src/server';
import type { HealthResponseDto } from '../../shared/dto';

describe('WebUI /api/health (public)', () => {
  let cfgDir: string;
  let handle: WebUIServerHandle;
  let baseUrl: string;

  async function bootWithCtx(uin: string, online: boolean): Promise<void> {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-health-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    const ctx = createMemoryContext({ uin });
    (ctx.selfInfo as { online: boolean }).online = online;
    handle = await initWebUI({
      port: 0, host: '127.0.0.1',
      jwtSecret: 'health-jwt', webuiPassword: 'sekrit',
      ctx,
      config: loadConfig({ path: cfgPath }),
      startedAt: Date.now() - 5_000,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  }

  afterEach(async () => {
    if (handle) await handle.close();
    rmSync(cfgDir, { recursive: true, force: true });
  });

  it('returns 200 + status=ok when the ctx is online', async () => {
    await bootWithCtx('10000', true);
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.status).toBe(200);
    const body = (await r.json()) as HealthResponseDto;
    expect(body.status).toBe('ok');
    expect(body.uin).toBe('10000');
    expect(body.online).toBe(true);
    expect(body.uptimeSec).toBeGreaterThanOrEqual(5);
  });

  it('returns 503 + status=degraded when uin is set but online=false', async () => {
    await bootWithCtx('10000', false);
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.status).toBe(503);
    const body = (await r.json()) as HealthResponseDto;
    expect(body.status).toBe('degraded');
    expect(body.online).toBe(false);
  });

  it('returns 503 + status=starting when uin is unset', async () => {
    await bootWithCtx('0', true);
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.status).toBe(503);
    const body = (await r.json()) as HealthResponseDto;
    expect(body.status).toBe('starting');
  });

  it('does NOT leak network config or tokens', async () => {
    await bootWithCtx('10000', true);
    const r = await fetch(`${baseUrl}/api/health`);
    const text = await r.text();
    expect(text).not.toMatch(/password|token|secret|jwt/i);
    expect(text).not.toMatch(/network|http-server|ws-server/);
  });

  it('does NOT require a JWT (works without Authorization header)', async () => {
    await bootWithCtx('10000', true);
    const r = await fetch(`${baseUrl}/api/health`);
    expect(r.status).toBe(200);
  });

  it('other /api/* routes still require a JWT (sanity)', async () => {
    await bootWithCtx('10000', true);
    const r = await fetch(`${baseUrl}/api/instance`);
    expect(r.status).toBe(401);
  });
});
