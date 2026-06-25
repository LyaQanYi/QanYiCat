import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMemoryContext, loadConfig } from '@qanyicat/core';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initWebUI, type WebUIServerHandle, type MediaEntryRecord } from '../src/server';
import type { MediaListResponseDto } from '../../shared/dto';

describe('WebUI /api/media', () => {
  let cfgDir: string;
  let baseUrl: string;
  let handle: WebUIServerHandle;
  let token: string;
  let fakeMedia: MediaEntryRecord[];

  beforeEach(async () => {
    cfgDir = mkdtempSync(join(tmpdir(), 'qyc-media-'));
    const cfgPath = join(cfgDir, 'c.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    fakeMedia = [];
    handle = await initWebUI({
      port: 0, host: '127.0.0.1',
      jwtSecret: 'media-jwt', webuiPassword: 'sekrit',
      ctx: createMemoryContext({ uin: '10000' }),
      config: loadConfig({ path: cfgPath }),
      startedAt: Date.now(),
      onListMedia: async () => fakeMedia,
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

  it('returns an empty list when bridge hasn’t indexed anything', async () => {
    const r = await fetch(`${baseUrl}/api/media`, { headers: { Authorization: `Bearer ${token}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MediaListResponseDto;
    expect(body).toEqual({ entries: [] });
  });

  it('returns whatever onListMedia produces', async () => {
    fakeMedia = [
      {
        keys: ['md5abc', 'fileUuid-1'],
        elementType: 5,
        fileName: 'clip.mp4',
        fileSize: 1234567,
        localCachePath: 'C:\\nt_data\\Video\\2026-05\\Ori\\md5abc.mp4',
        peer: { chatType: 'private', peerUid: 'u_test', peerUin: '10001' },
        msgId: 'msg-1',
        elementId: 'el-1',
      },
      {
        keys: ['md5def'],
        elementType: 2,
        fileName: 'image.jpg',
        fileSize: 64000,
        peer: { chatType: 'group', peerUid: '100002', groupCode: '100002' },
        msgId: 'msg-2',
        elementId: 'el-2',
      },
    ];
    const r = await fetch(`${baseUrl}/api/media`, { headers: { Authorization: `Bearer ${token}` } });
    const body = (await r.json()) as MediaListResponseDto;
    expect(body.entries).toHaveLength(2);
    expect(body.entries[0]!.fileName).toBe('clip.mp4');
    expect(body.entries[0]!.peer).toEqual({ chatType: 'private', peerUid: 'u_test', peerUin: '10001' });
    expect(body.entries[1]!.peer.groupCode).toBe('100002');
  });

  it('returns an empty list when onListMedia is not wired', async () => {
    await handle.close();
    const cfgPath = join(cfgDir, 'c2.json');
    writeFileSync(cfgPath, JSON.stringify({
      qq: {}, log: { level: 'info' },
      onebot: { enable11: true, networks: [] },
      process: {}, webui: { enable: true, port: 5099, password: 'sekrit' },
    }));
    const noinv = await initWebUI({
      port: 0, host: '127.0.0.1',
      jwtSecret: 'media-jwt', webuiPassword: 'sekrit',
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
    const r = await fetch(`${url2}/api/media`, { headers: { Authorization: `Bearer ${tok}` } });
    expect(r.status).toBe(200);
    const body = (await r.json()) as MediaListResponseDto;
    expect(body.entries).toEqual([]);
    await noinv.close();
  });

  it('rejects unauthenticated requests with 401', async () => {
    const r = await fetch(`${baseUrl}/api/media`);
    expect(r.status).toBe(401);
  });
});
