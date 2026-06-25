import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveToLocalPath } from '../src/image-upload';

describe('resolveToLocalPath', () => {
  it('resolves a file:// URL back to the on-disk file', async () => {
    // pathToFileURL yields file:///C:/... on Windows and file:///home/... on
    // POSIX. The probe must reconstruct the original path on both — dropping the
    // leading slash unconditionally turned "/home/x" into the relative "home/x"
    // on Linux, which existsSync would never find.
    const dir = mkdtempSync(join(tmpdir(), 'qyc-resolve-'));
    const file = join(dir, 'pic.bin');
    writeFileSync(file, 'PNGDATA');
    try {
      const resolved = await resolveToLocalPath(pathToFileURL(file).href);
      // Compare by content, not string: on Windows the result uses forward
      // slashes while `file` uses backslashes — both point at the same file.
      expect(readFileSync(resolved, 'utf8')).toBe('PNGDATA');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('passes an already-local path through unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qyc-resolve-'));
    const file = join(dir, 'plain.bin');
    writeFileSync(file, 'X');
    try {
      expect(await resolveToLocalPath(file)).toBe(file);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
