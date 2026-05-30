import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { QQBasicInfoProbe } from '../src/wrapper/qq-probe';

/**
 * The probe is path-driven, so the easiest way to exercise it is to build a
 * fake QQ install tree in a temp directory and point it at that.
 */
describe('QQBasicInfoProbe.probe', () => {
  let root: string;
  let originalPath: string | undefined;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'qyc-qq-'));
    originalPath = process.env['QANYICAT_WRAPPER_PATH'];
    delete process.env['QANYICAT_WRAPPER_PATH'];
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
    if (originalPath !== undefined) process.env['QANYICAT_WRAPPER_PATH'] = originalPath;
  });

  it('reads curVersion from versions/config.json (quick-update path)', () => {
    const execPath = join(root, 'QQ.exe');
    writeFileSync(execPath, '');
    mkdirSync(join(root, 'versions'), { recursive: true });
    writeFileSync(join(root, 'versions', 'config.json'), JSON.stringify({ curVersion: '9.9.99-0' }));
    const verDir = join(root, 'versions', '9.9.99-0');
    mkdirSync(verDir, { recursive: true });
    writeFileSync(join(verDir, 'wrapper.node'), '');

    const info = QQBasicInfoProbe.probe({ execPath });
    expect(info.qqVersion).toBe('9.9.99-0');
    expect(info.fromQuickUpdateConfig).toBe(true);
    expect(info.wrapperPath).toBe(join(verDir, 'wrapper.node'));
  });

  it('falls back to scanning versions/* when config.json is absent', () => {
    const execPath = join(root, 'QQ.exe');
    writeFileSync(execPath, '');
    const v1 = join(root, 'versions', '9.9.1-1');
    const v2 = join(root, 'versions', '9.9.10-5');
    mkdirSync(v1, { recursive: true });
    mkdirSync(v2, { recursive: true });
    writeFileSync(join(v2, 'wrapper.node'), '');

    const info = QQBasicInfoProbe.probe({ execPath });
    expect(info.qqVersion).toBe('9.9.10-5');
    expect(info.fromQuickUpdateConfig).toBe(false);
  });

  it('falls through to nested resources/app fallback when primary wrapper is missing', () => {
    const execPath = join(root, 'QQ.exe');
    writeFileSync(execPath, '');
    const verRoot = join(root, 'versions', '9.9.1-0');
    const nested = join(verRoot, 'resources', 'app');
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(nested, 'wrapper.node'), '');

    const info = QQBasicInfoProbe.probe({ execPath, qqVersion: '9.9.1-0' });
    expect(info.wrapperPath).toBe(join(nested, 'wrapper.node'));
  });

  it('honors QANYICAT_WRAPPER_PATH and short-circuits the rest of the probe', () => {
    const wrapper = join(root, 'forced-wrapper.node');
    writeFileSync(wrapper, '');
    process.env['QANYICAT_WRAPPER_PATH'] = wrapper;
    const info = QQBasicInfoProbe.probe();
    expect(info.wrapperPath).toBe(wrapper);
    expect(info.execPath).toBe('<override>');
  });

  it('throws when wrapper.node cannot be found', () => {
    const execPath = join(root, 'QQ.exe');
    writeFileSync(execPath, '');
    mkdirSync(join(root, 'versions', '9.9.1-0'), { recursive: true });
    // no wrapper.node anywhere
    expect(() => QQBasicInfoProbe.probe({ execPath, qqVersion: '9.9.1-0' })).toThrow(
      /wrapper\.node not found/
    );
  });
});
