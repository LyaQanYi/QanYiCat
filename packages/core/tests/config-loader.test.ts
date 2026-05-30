import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../src/config/loader';

describe('loadConfig', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qyc-cfg-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env['QANYICAT_LOG_LEVEL'];
    delete process.env['QANYICAT_QQ_EXEC_PATH'];
  });

  it('applies defaults for missing fields', () => {
    const path = join(dir, 'c.json');
    writeFileSync(
      path,
      JSON.stringify({ qq: {}, log: { level: 'info' }, onebot: { networks: [] }, process: {} })
    );
    const cfg = loadConfig({ path });
    expect(cfg.onebot.enable11).toBe(true);
    expect(cfg.process.multi).toBe(true);
  });

  it('honors QANYICAT_LOG_LEVEL env override', () => {
    const path = join(dir, 'c.json');
    writeFileSync(
      path,
      JSON.stringify({ qq: {}, log: { level: 'info' }, onebot: { networks: [] }, process: {} })
    );
    process.env['QANYICAT_LOG_LEVEL'] = 'debug';
    expect(loadConfig({ path }).log.level).toBe('debug');
  });

  it('throws when required fields are missing', () => {
    const path = join(dir, 'c.json');
    writeFileSync(path, JSON.stringify({ log: {} }));
    expect(() => loadConfig({ path })).toThrow(/schema validation/);
  });

  it('tolerates a missing file by returning the defaulted shape', () => {
    expect(() => loadConfig({ path: join(dir, 'does-not-exist.json') })).toThrow(/schema validation/);
  });

  it('accepts log.ringBufferSize within bounds (v0.4n-housekeeping-12)', () => {
    const path = join(dir, 'c.json');
    writeFileSync(
      path,
      JSON.stringify({ qq: {}, log: { level: 'info', ringBufferSize: 2000 }, onebot: { networks: [] }, process: {} })
    );
    expect(loadConfig({ path }).log.ringBufferSize).toBe(2000);
  });

  it('rejects log.ringBufferSize below the floor', () => {
    const path = join(dir, 'c.json');
    writeFileSync(
      path,
      JSON.stringify({ qq: {}, log: { level: 'info', ringBufferSize: 10 }, onebot: { networks: [] }, process: {} })
    );
    expect(() => loadConfig({ path })).toThrow(/schema validation/);
  });

  it('omitting log.ringBufferSize falls back to the schema default (500)', () => {
    const path = join(dir, 'c.json');
    writeFileSync(
      path,
      JSON.stringify({ qq: {}, log: { level: 'info' }, onebot: { networks: [] }, process: {} })
    );
    // Typebox's Type.Integer({default:500}) wrapped in Type.Optional still
    // applies the default at load time — confirmed empirically. So callers
    // CAN rely on it being a number, no `?? 500` needed.
    expect(loadConfig({ path }).log.ringBufferSize).toBe(500);
  });
});
