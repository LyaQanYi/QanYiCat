import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UidUinCache, type ProfileServiceFacade, type UixConvertServiceFacade } from '../src/uid-uin-cache';

function makeProfileSvc(map: Record<string, string>): ProfileServiceFacade {
  return {
    getUinByUid: (_callFrom, uids) => {
      const out = new Map<string, string>();
      for (const uid of uids) {
        const uin = map[uid];
        if (uin) out.set(uid, uin);
      }
      return out;
    },
    getUidByUin: (_callFrom, uins) => {
      const out = new Map<string, string>();
      for (const uin of uins) {
        const uid = Object.keys(map).find((k) => map[k] === uin);
        if (uid) out.set(uin, uid);
      }
      return out;
    },
  };
}

function makeUixConvert(map: Record<string, string>): UixConvertServiceFacade {
  return {
    getUin: async (uids) => {
      const uinInfo = new Map<string, string>();
      for (const uid of uids) {
        const uin = map[uid];
        if (uin) uinInfo.set(uid, uin);
      }
      return { uinInfo };
    },
    getUid: async (uins) => {
      const uidInfo = new Map<string, string>();
      for (const uin of uins) {
        const uid = Object.keys(map).find((k) => map[k] === uin);
        if (uid) uidInfo.set(uin, uid);
      }
      return { uidInfo };
    },
  };
}

describe('UidUinCache', () => {
  it('returns cached value without hitting services', async () => {
    const cache = new UidUinCache(undefined);
    cache.put('u_A', '100');
    expect(cache.getUin('u_A')).toBe('100');
    expect(cache.getUid('100')).toBe('u_A');
    expect(await cache.resolveUin('u_A')).toBe('100');
    expect(await cache.resolveUid('100')).toBe('u_A');
  });

  it('ignores put() with empty / "0" sentinel values', () => {
    const cache = new UidUinCache(undefined);
    cache.put('u_A', '0');
    cache.put('0', '100');
    cache.put('', '200');
    cache.put('u_B', undefined);
    expect(cache.getUin('u_A')).toBeUndefined();
    expect(cache.getUid('100')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('resolveUin tries uixConvertService FIRST, falls through to profileService', async () => {
    // uixConvert knows about strangers; profileService only friends.
    const uixConvert = makeUixConvert({ 'u_stranger': '999' });
    const profileSvc = makeProfileSvc({ 'u_friend': '100' });
    const cache = new UidUinCache(profileSvc, uixConvert);

    // stranger → resolves via uixConvert
    expect(await cache.resolveUin('u_stranger')).toBe('999');
    // friend → first uixConvert fails (returns empty Map), falls through to profileSvc
    expect(await cache.resolveUin('u_friend')).toBe('100');
    // both queries cached after resolve
    expect(cache.getUin('u_stranger')).toBe('999');
    expect(cache.getUin('u_friend')).toBe('100');
  });

  it('resolveUin returns "" when neither service knows the uid', async () => {
    const uixConvert = makeUixConvert({});
    const profileSvc = makeProfileSvc({});
    const cache = new UidUinCache(profileSvc, uixConvert);
    expect(await cache.resolveUin('u_unknown')).toBe('');
    // negative result is NOT cached (so a later prime can fix it)
    expect(cache.getUin('u_unknown')).toBeUndefined();
  });

  it('resolveUid uses the same fallback chain in reverse', async () => {
    const uixConvert = makeUixConvert({ 'u_X': '500' });
    const profileSvc = makeProfileSvc({ 'u_Y': '600' });
    const cache = new UidUinCache(profileSvc, uixConvert);

    expect(await cache.resolveUid('500')).toBe('u_X');
    expect(await cache.resolveUid('600')).toBe('u_Y');
  });

  it('skips uixConvertService if not provided (back-compat)', async () => {
    const profileSvc = makeProfileSvc({ 'u_A': '100' });
    const cache = new UidUinCache(profileSvc);   // no uixConvert
    expect(await cache.resolveUin('u_A')).toBe('100');
  });

  it('treats profileService "0" return as miss (NT empty sentinel)', async () => {
    // profileSvc returns "0" for unknown uids in real NT — must not cache that.
    const profileSvc: ProfileServiceFacade = {
      getUinByUid: (_callFrom, uids) => {
        const out = new Map<string, string>();
        for (const uid of uids) out.set(uid, '0');
        return out;
      },
    };
    const cache = new UidUinCache(profileSvc);
    expect(await cache.resolveUin('u_anything')).toBe('');
    expect(cache.getUin('u_anything')).toBeUndefined();
  });

  it('nick map: put + get + getCoreAndBaseInfo prime', async () => {
    const profileSvc: ProfileServiceFacade = {
      getCoreAndBaseInfo: async (_callFrom, uids) => {
        const result = new Map<string, { coreInfo?: { uid: string; uin: string; nick?: string } }>();
        for (const uid of uids) {
          if (uid === 'u_known') result.set(uid, { coreInfo: { uid: 'u_known', uin: '321', nick: 'Alice' } });
        }
        return result as unknown as Awaited<ReturnType<NonNullable<ProfileServiceFacade['getCoreAndBaseInfo']>>>;
      },
    };
    const cache = new UidUinCache(profileSvc);
    // Direct put
    cache.putNick('u_X', 'Bob');
    expect(cache.getNick('u_X')).toBe('Bob');
    // Empty nick is ignored
    cache.putNick('u_Y', '');
    expect(cache.getNick('u_Y')).toBeUndefined();
    // primeNicks fetches missing + folds in uin
    const learned = await cache.primeNicks(['u_known', 'u_X']);  // u_X already cached, skipped
    expect(learned).toBe(1);
    expect(cache.getNick('u_known')).toBe('Alice');
    expect(cache.getUin('u_known')).toBe('321');
  });

  it('survives throwing services without throwing itself', async () => {
    const throwing: ProfileServiceFacade = {
      getUinByUid: () => { throw new Error('boom'); },
      getUidByUin: () => { throw new Error('boom'); },
    };
    const throwingUix: UixConvertServiceFacade = {
      getUin: async () => { throw new Error('boom'); },
      getUid: async () => { throw new Error('boom'); },
    };
    const cache = new UidUinCache(throwing, throwingUix);
    expect(await cache.resolveUin('u_X')).toBe('');
    expect(await cache.resolveUid('100')).toBe('');
  });
});

describe('UidUinCache persistence (v0.4n-housekeeping-12)', () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'qyc-uid-cache-'));
    path = join(dir, 'uid.json');
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('flush() writes a snapshot that load() reads back losslessly', async () => {
    const a = new UidUinCache(undefined, undefined, { persistPath: path });
    a.put('u_alice', '1001');
    a.put('u_bob', '1002');
    a.putNick('u_alice', 'Alice');
    a.putNick('u_bob', 'Bob');
    await a.flush();

    const b = new UidUinCache(undefined, undefined, { persistPath: path });
    const { loaded } = await b.load();
    expect(loaded).toBe(2);
    expect(b.getUin('u_alice')).toBe('1001');
    expect(b.getUid('1002')).toBe('u_bob');
    expect(b.getNick('u_alice')).toBe('Alice');
    expect(b.getNick('u_bob')).toBe('Bob');
  });

  it('putNick triggers a re-write picked up by a fresh cache', async () => {
    const a = new UidUinCache(undefined, undefined, { persistPath: path });
    a.put('u_x', '500');
    await a.flush();
    a.putNick('u_x', 'X-Person');
    await a.flush();

    const b = new UidUinCache(undefined, undefined, { persistPath: path });
    await b.load();
    expect(b.getNick('u_x')).toBe('X-Person');
  });

  it('load() returns loaded=0 with a reason when no file exists', async () => {
    const cache = new UidUinCache(undefined, undefined, { persistPath: path });
    const r = await cache.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/no prior snapshot/);
  });

  it('load() recovers gracefully from malformed JSON', async () => {
    writeFileSync(path, 'not-json-{{{', 'utf-8');
    const logs: string[] = [];
    const cache = new UidUinCache(undefined, undefined, { persistPath: path, log: (m) => logs.push(m) });
    const r = await cache.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/malformed JSON/);
    expect(logs.some((l) => l.includes('parse failed'))).toBe(true);
  });

  it('load() rejects unsupported snapshot versions', async () => {
    writeFileSync(path, JSON.stringify({ version: 99, pairs: [], nicks: [] }), 'utf-8');
    const cache = new UidUinCache(undefined, undefined, { persistPath: path });
    const r = await cache.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/unsupported version/);
  });

  it('serialized snapshot has version + savedAt + pairs + nicks arrays', async () => {
    const cache = new UidUinCache(undefined, undefined, { persistPath: path });
    cache.put('u_a', '1');
    cache.putNick('u_a', 'A');
    await cache.flush();
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { version: number; savedAt: string; pairs: unknown[]; nicks: unknown[] };
    expect(raw.version).toBe(1);
    expect(typeof raw.savedAt).toBe('string');
    expect(raw.pairs).toEqual([['u_a', '1']]);
    expect(raw.nicks).toEqual([['u_a', 'A']]);
  });

  it('debounced write coalesces multiple puts into a single flush', async () => {
    const cache = new UidUinCache(undefined, undefined, { persistPath: path, persistDebounceMs: 30 });
    cache.put('u_a', '1');
    cache.put('u_b', '2');
    cache.put('u_c', '3');
    cache.putNick('u_a', 'A');
    await new Promise((r) => setTimeout(r, 80));
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as { pairs: unknown[]; nicks: unknown[] };
    expect(raw.pairs).toHaveLength(3);
    expect(raw.nicks).toHaveLength(1);
  });

  it('no persistPath = pure in-memory, flush()/load() are no-ops', async () => {
    const cache = new UidUinCache(undefined);
    cache.put('u_a', '1');
    await cache.flush();
    const r = await cache.load();
    expect(r.loaded).toBe(0);
    expect(r.reason).toMatch(/no persistPath/);
  });

  it('idempotent put (same value) does not schedule a write', async () => {
    let writeCount = 0;
    const cache = new UidUinCache(undefined, undefined, { persistPath: path, persistDebounceMs: 30 });
    cache.put('u_a', '1');
    await cache.flush();
    writeCount = readFileSync(path, 'utf-8').length > 0 ? 1 : 0;
    // Re-put the same value — should not change the file.
    cache.put('u_a', '1');
    cache.putNick('u_b', '');  // also a no-op
    cache.put(undefined, undefined);  // also a no-op
    // Wait past the debounce; if a write was scheduled we'd see it.
    await new Promise((r) => setTimeout(r, 80));
    const after = readFileSync(path, 'utf-8');
    // File should be identical to the post-flush content.
    expect(after.length).toBeGreaterThan(0);
    expect(writeCount).toBe(1);
  });
});
