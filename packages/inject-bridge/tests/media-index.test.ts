import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MediaIndex } from '../src/media-index';
import type { NTPeer } from '@qanyicat/core';

const peer: NTPeer = { chatType: 'private', peerUid: 'u_x' };

describe('MediaIndex.list', () => {
  it('returns the dedup\'d most-recent-first view used by /api/media', () => {
    const idx = new MediaIndex();
    idx.put(['md5-a', 'uuid-a'], { peer, msgId: 'm1', elementId: 'e1', elementType: 5, fileName: 'a.mp4' });
    idx.put(['md5-b'],            { peer, msgId: 'm2', elementId: 'e2', elementType: 2, fileName: 'b.jpg' });
    const list = idx.list();
    expect(list).toHaveLength(2);
    // newest-first
    expect(list[0]!.fileName).toBe('b.jpg');
    expect(list[1]!.fileName).toBe('a.mp4');
    // each row carries every key it was inserted under
    expect(list[1]!.keys.sort()).toEqual(['md5-a', 'uuid-a']);
    expect(list[0]!.keys).toEqual(['md5-b']);
  });

  it('collapses multiple key entries pointing at the same (msgId,elementId)', () => {
    const idx = new MediaIndex();
    idx.put(['md5-1', 'uuid-1', 'extra-1'], {
      peer, msgId: 'one', elementId: 'el', elementType: 3, fileName: 'doc.pdf',
    });
    const list = idx.list();
    expect(list).toHaveLength(1);
    expect(list[0]!.keys).toHaveLength(3);
    expect(list[0]!.fileName).toBe('doc.pdf');
  });

  it('honors the FIFO cap', () => {
    const idx = new MediaIndex(2);
    idx.put(['a'], { peer, msgId: 'm1', elementId: 'e1', elementType: 2 });
    idx.put(['b'], { peer, msgId: 'm2', elementId: 'e2', elementType: 2 });
    idx.put(['c'], { peer, msgId: 'm3', elementId: 'e3', elementType: 2 });
    const list = idx.list();
    expect(list.map((e) => e.msgId).sort()).toEqual(['m2', 'm3']); // 'a' was evicted
  });
});

describe('MediaIndex persistence (v0.4n-housekeeping-9)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qyc-media-idx-'));
    path = join(dir, 'mi.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flush() writes a snapshot that load() reads back losslessly', async () => {
    const a = new MediaIndex({ persistPath: path });
    a.put(['md5-a', 'uuid-a'], { peer, msgId: 'm1', elementId: 'e1', elementType: 5, fileName: 'a.mp4', fileSize: 12345 });
    a.put(['md5-b'], { peer, msgId: 'm2', elementId: 'e2', elementType: 2, localCachePath: 'D:/cached/b.jpg' });
    await a.flush();

    const b = new MediaIndex({ persistPath: path });
    const { loaded } = await b.load();
    expect(loaded).toBe(2);

    // Both keys for entry 'm1' resolve to the same entry.
    expect(b.get('md5-a')?.msgId).toBe('m1');
    expect(b.get('uuid-a')?.msgId).toBe('m1');
    expect(b.get('md5-a')?.fileSize).toBe(12345);
    // localCachePath round-trips.
    expect(b.get('md5-b')?.localCachePath).toBe('D:/cached/b.jpg');

    // List view preserves dedup and ordering (newest first).
    const list = b.list();
    expect(list.map((e) => e.msgId)).toEqual(['m2', 'm1']);
    expect(list[1]!.keys.sort()).toEqual(['md5-a', 'uuid-a']);
  });

  it('setLocalCachePath triggers a re-write that load() picks up', async () => {
    const a = new MediaIndex({ persistPath: path });
    a.put(['md5-x'], { peer, msgId: 'mx', elementId: 'ex', elementType: 3, fileName: 'doc.pdf' });
    await a.flush();
    a.setLocalCachePath('mx', 'ex', 'D:/cache/doc.pdf');
    await a.flush();

    const b = new MediaIndex({ persistPath: path });
    await b.load();
    expect(b.get('md5-x')?.localCachePath).toBe('D:/cache/doc.pdf');
  });

  it('load() returns loaded=0 with a reason when no file exists', async () => {
    const idx = new MediaIndex({ persistPath: path });
    const r = await idx.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/no prior snapshot/);
  });

  it('load() recovers gracefully from malformed JSON', async () => {
    writeFileSync(path, 'not-json-{{{', 'utf-8');
    const logs: string[] = [];
    const idx = new MediaIndex({ persistPath: path, log: (m) => logs.push(m) });
    const r = await idx.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/malformed JSON/);
    expect(logs.some((l) => l.includes('parse failed'))).toBe(true);
  });

  it('load() rejects unsupported snapshot versions', async () => {
    writeFileSync(path, JSON.stringify({ version: 999, entries: [] }), 'utf-8');
    const idx = new MediaIndex({ persistPath: path });
    const r = await idx.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/unsupported version/);
  });

  it('serialized snapshot has a stable shape (version + savedAt + entries)', async () => {
    const idx = new MediaIndex({ persistPath: path });
    idx.put(['k1'], { peer, msgId: 'mm', elementId: 'ee', elementType: 4 });
    await idx.flush();
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; savedAt: string; entries: unknown[] };
    expect(raw.version).toBe(1);
    expect(typeof raw.savedAt).toBe('string');
    expect(Array.isArray(raw.entries)).toBe(true);
    expect(raw.entries).toHaveLength(1);
  });

  it('debounced write coalesces multiple puts into a single flush', async () => {
    // Use a tiny debounce so the test isn't slow.
    const idx = new MediaIndex({ persistPath: path, persistDebounceMs: 30 });
    idx.put(['k1'], { peer, msgId: 'm1', elementId: 'e1', elementType: 2 });
    idx.put(['k2'], { peer, msgId: 'm2', elementId: 'e2', elementType: 2 });
    idx.put(['k3'], { peer, msgId: 'm3', elementId: 'e3', elementType: 2 });
    // wait past the debounce window
    await new Promise((r) => setTimeout(r, 80));
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { entries: Array<{ keys: string[] }> };
    expect(raw.entries).toHaveLength(3);
    expect(raw.entries.map((g) => g.keys[0]!).sort()).toEqual(['k1', 'k2', 'k3']);
  });

  it('no persistPath = pure in-memory, flush()/load() are no-ops', async () => {
    const idx = new MediaIndex();
    idx.put(['k'], { peer, msgId: 'm', elementId: 'e', elementType: 2 });
    await idx.flush();
    const r = await idx.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/no persistPath/);
  });
});
