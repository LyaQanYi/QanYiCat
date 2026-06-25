import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveWebUIPasskey } from '../src/webui-passkey';

describe('resolveWebUIPasskey', () => {
  let cwd: string;

  beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), 'qyc-passkey-')); });
  afterEach(() => { rmSync(cwd, { recursive: true, force: true }); });

  it('uses both env vars when fully set, and does NOT write a file', () => {
    const env = { QANYICAT_WEBUI_PASSWORD: 'env-pw', QANYICAT_WEBUI_JWT_SECRET: 'env-jwt' };
    const r = resolveWebUIPasskey(env, cwd);
    expect(r.source).toBe('env');
    expect(r.password).toBe('env-pw');
    expect(r.jwtSecret).toBe('env-jwt');
    expect(existsSync(r.path)).toBe(false); // env path never persists
  });

  it('reads an existing passkey file when env vars are absent', () => {
    const path = join(cwd, 'qanyicat.webui.passkey.json');
    writeFileSync(path, JSON.stringify({ password: 'file-pw', jwtSecret: 'file-jwt' }));
    const r = resolveWebUIPasskey({}, cwd);
    expect(r.source).toBe('file');
    expect(r.password).toBe('file-pw');
    expect(r.jwtSecret).toBe('file-jwt');
    expect(r.path).toBe(path);
  });

  it('generates + persists random values on first boot', () => {
    const r = resolveWebUIPasskey({}, cwd);
    expect(r.source).toBe('generated');
    expect(r.password.length).toBe(32); // 16 bytes hex
    expect(r.jwtSecret.length).toBe(64); // 32 bytes hex
    expect(existsSync(r.path)).toBe(true);
    const persisted = JSON.parse(readFileSync(r.path, 'utf8'));
    expect(persisted.password).toBe(r.password);
    expect(persisted.jwtSecret).toBe(r.jwtSecret);
  });

  it('regenerated values survive a second resolve from the same dir', () => {
    const first = resolveWebUIPasskey({}, cwd);
    const second = resolveWebUIPasskey({}, cwd);
    expect(second.source).toBe('file');
    expect(second.password).toBe(first.password);
    expect(second.jwtSecret).toBe(first.jwtSecret);
  });

  it('env-supplied password overrides file value but not jwtSecret', () => {
    const path = join(cwd, 'qanyicat.webui.passkey.json');
    writeFileSync(path, JSON.stringify({ password: 'file-pw', jwtSecret: 'file-jwt' }));
    const r = resolveWebUIPasskey({ QANYICAT_WEBUI_PASSWORD: 'env-pw' }, cwd);
    expect(r.password).toBe('env-pw');
    expect(r.jwtSecret).toBe('file-jwt');
    expect(r.source).toBe('env');
  });

  it('QANYICAT_WEBUI_PASSKEY_PATH overrides the default location', () => {
    const custom = join(cwd, 'subdir', 'pk.json');
    const r = resolveWebUIPasskey({ QANYICAT_WEBUI_PASSKEY_PATH: custom }, cwd);
    expect(r.path).toBe(custom);
    expect(existsSync(custom)).toBe(true);
  });

  it('treats a malformed file as missing and regenerates', () => {
    const path = join(cwd, 'qanyicat.webui.passkey.json');
    writeFileSync(path, 'not-json-{{{');
    const r = resolveWebUIPasskey({}, cwd);
    expect(r.source).toBe('generated');
    // file is now overwritten with valid JSON
    const persisted = JSON.parse(readFileSync(path, 'utf8'));
    expect(persisted.password).toBe(r.password);
  });

  it('treats a file with empty password as missing', () => {
    const path = join(cwd, 'qanyicat.webui.passkey.json');
    writeFileSync(path, JSON.stringify({ password: '', jwtSecret: 'x' }));
    const r = resolveWebUIPasskey({}, cwd);
    expect(r.source).toBe('generated');
  });
});
