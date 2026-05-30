/**
 * In-memory bidirectional cache for QQ NT's two ID schemes:
 *   uid = `u_...` (server-internal opaque string)
 *   uin = numeric string (the legacy QQ number)
 *
 * Populated by:
 *   • Boot-time prime — buddyService.getBuddyListV2 + profileService.getUinByUid
 *   • Live observation — every onRecvMsg carries senderUid + senderUin (and
 *     peerUid + peerUin) when NT has resolved them; we fold these in for free.
 *   • Resolve-on-demand — profileService.get{Uid,Uin}By{Uin,Uid} when called via
 *     resolveUid/resolveUin (async, costs one IPC).
 *
 * Not threadsafe — but Node single-threaded so the only concern is concurrent
 * resolve calls double-fetching the same id; harmless.
 *
 * v0.4n-housekeeping-12 (F. perf): opt-in JSON file persistence so a QQ
 * relaunch via quick-start.bat doesn't lose the friend/group uid↔uin map.
 * Same shape as MediaIndex persistence (housekeeping-9). Without a configured
 * persistPath the cache behaves exactly as before (in-memory only).
 */

import { promises as fsp } from 'node:fs';

export interface ProfileServiceFacade {
  getUidByUin?(callFrom: string, uins: string[]): Map<string, string>;
  getUinByUid?(callFrom: string, uids: string[]): Map<string, string>;
  getCoreAndBaseInfo?(callFrom: string, uids: string[]): Promise<Map<string, {
    uid?: string;
    uin?: string;
    coreInfo?: { uid: string; uin: string; nick?: string; remark?: string };
  }>>;
}

/**
 * `NodeIKernelUixConvertService` — NT's dedicated uid↔uin converter. The
 * resolve chain tries this FIRST because it covers non-friends (the
 * `profileService.FriendsServiceImpl` path returns '0' / empty when the
 * target isn't a buddy).
 */
export interface UixConvertServiceFacade {
  getUin?(uids: string[]): Promise<{ uinInfo: Map<string, string> }>;
  getUid?(uins: string[]): Promise<{ uidInfo: Map<string, string> }>;
}

export interface UidUinCacheOptions {
  /**
   * If set, the cache serializes (debounced) to this absolute file path.
   * Call `load()` once after construction to rehydrate from a previous run.
   * Persistence is best-effort — write errors are logged, not thrown.
   */
  persistPath?: string;
  /** Debounce window before flushing pending writes. Default 5000 ms. */
  persistDebounceMs?: number;
  /** Optional logger for write/load diagnostics. */
  log?: (msg: string) => void;
}

interface PersistedShape {
  version: 1;
  savedAt: string;
  pairs: Array<[string, string]>; // [uid, uin] tuples
  nicks: Array<[string, string]>; // [uid, nick] tuples
}

export class UidUinCache {
  private uidToUinMap = new Map<string, string>();
  private uinToUidMap = new Map<string, string>();
  private uidToNickMap = new Map<string, string>();
  private readonly persistPath: string | null;
  private readonly persistDebounceMs: number;
  private readonly log: (msg: string) => void;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeInflight: Promise<void> | null = null;

  constructor(
    private readonly profileService: ProfileServiceFacade | undefined,
    private readonly uixConvert?: UixConvertServiceFacade,
    opts?: UidUinCacheOptions
  ) {
    this.persistPath = opts?.persistPath ?? null;
    this.persistDebounceMs = opts?.persistDebounceMs ?? 5000;
    this.log = opts?.log ?? (() => {});
  }

  /** Record a uid↔uin pair if both are non-empty and uin != '0' (NT's sentinel). */
  put(uid: string | undefined, uin: string | undefined): void {
    if (!uid || !uin || uin === '0' || uid === '0') return;
    const before = this.uidToUinMap.get(uid);
    this.uidToUinMap.set(uid, uin);
    this.uinToUidMap.set(uin, uid);
    if (before !== uin) this.scheduleWrite();
  }

  /** Record a uid → nick mapping. Empty/null nicks are ignored. */
  putNick(uid: string | undefined, nick: string | undefined): void {
    if (!uid || !nick) return;
    const before = this.uidToNickMap.get(uid);
    this.uidToNickMap.set(uid, nick);
    if (before !== nick) this.scheduleWrite();
  }

  getNick(uid: string): string | undefined {
    return this.uidToNickMap.get(uid);
  }

  /** Batch fetch nicks for uids missing from the cache. No-op if no profileService. */
  async primeNicks(uids: string[]): Promise<number> {
    const fresh = uids.filter((u) => u && !this.uidToNickMap.has(u));
    if (fresh.length === 0 || !this.profileService?.getCoreAndBaseInfo) return 0;
    let learned = 0;
    // Batch of 100 to stay well under any internal limit.
    for (let i = 0; i < fresh.length; i += 100) {
      const batch = fresh.slice(i, i + 100);
      try {
        const result = await this.profileService.getCoreAndBaseInfo('nodeStore', batch);
        if (result && typeof result.forEach === 'function') {
          result.forEach((info, uid) => {
            const nick = info?.coreInfo?.nick;
            const uin = info?.coreInfo?.uin ?? info?.uin;
            if (nick) {
              this.uidToNickMap.set(uid, nick);
              learned++;
            }
            if (uin && uin !== '0') this.put(uid, uin);
          });
        }
      } catch {
        // best effort
      }
    }
    return learned;
  }

  /** Synchronous cache lookup; undefined on miss. */
  getUin(uid: string): string | undefined {
    return this.uidToUinMap.get(uid);
  }

  getUid(uin: string): string | undefined {
    return this.uinToUidMap.get(uin);
  }

  /**
   * uid → uin with fallback chain:
   *   1. in-memory cache
   *   2. uixConvertService.getUin([uid])     — works for NON-friends too
   *   3. profileService.getUinByUid('FriendsServiceImpl', [uid])  — friends only
   * Returns '' on full miss. Result is cached for follow-up lookups.
   */
  async resolveUin(uid: string): Promise<string> {
    const cached = this.uidToUinMap.get(uid);
    if (cached) return cached;
    // 1. uixConvertService — covers strangers / group members we're not friends with.
    if (this.uixConvert?.getUin) {
      try {
        const r = await this.uixConvert.getUin([uid]);
        const uin = r?.uinInfo?.get(uid);
        if (uin && uin !== '0') {
          this.put(uid, uin);
          return uin;
        }
      } catch { /* fallthrough */ }
    }
    // 2. profileService — friends.
    if (this.profileService?.getUinByUid) {
      try {
        const m = this.profileService.getUinByUid('FriendsServiceImpl', [uid]);
        const uin = m?.get(uid);
        if (uin && uin !== '0') {
          this.put(uid, uin);
          return uin;
        }
      } catch { /* fallthrough */ }
    }
    return '';
  }

  /**
   * uin → uid with the same fallback chain in reverse.
   */
  async resolveUid(uin: string): Promise<string> {
    const cached = this.uinToUidMap.get(uin);
    if (cached) return cached;
    if (this.uixConvert?.getUid) {
      try {
        const r = await this.uixConvert.getUid([uin]);
        const uid = r?.uidInfo?.get(uin);
        if (uid) {
          this.put(uid, uin);
          return uid;
        }
      } catch { /* fallthrough */ }
    }
    if (this.profileService?.getUidByUin) {
      try {
        const m = this.profileService.getUidByUin('FriendsServiceImpl', [uin]);
        const uid = m?.get(uin);
        if (uid) {
          this.put(uid, uin);
          return uid;
        }
      } catch { /* fallthrough */ }
    }
    return '';
  }

  get size(): number {
    return this.uidToUinMap.size;
  }

  /**
   * v0.4n-housekeeping-12 (F): read the persisted snapshot from `persistPath`
   * (if configured) and re-populate the cache. Best-effort — missing file /
   * bad JSON / wrong shape silently start empty (logged via `log`). Caller
   * awaits before the bridge starts attaching kernel listeners so subsequent
   * `put()`s win over older entries during prime.
   */
  async load(): Promise<{ loaded: number; reason?: string }> {
    if (!this.persistPath) return { loaded: 0, reason: 'no persistPath configured' };
    let raw: string;
    try {
      raw = await fsp.readFile(this.persistPath, 'utf-8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') return { loaded: 0, reason: 'no prior snapshot' };
      this.log(`UidUinCache.load read failed: ${err.message}`);
      return { loaded: 0, reason: `read error: ${err.message}` };
    }
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(raw) as PersistedShape;
    } catch (e) {
      this.log(`UidUinCache.load parse failed: ${(e as Error).message}`);
      return { loaded: 0, reason: 'malformed JSON' };
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.pairs) || !Array.isArray(parsed.nicks)) {
      this.log(`UidUinCache.load: unsupported snapshot shape (version=${parsed?.version})`);
      return { loaded: 0, reason: 'unsupported version' };
    }
    let loaded = 0;
    for (const [uid, uin] of parsed.pairs) {
      if (typeof uid === 'string' && typeof uin === 'string') {
        this.put(uid, uin);
        loaded++;
      }
    }
    for (const [uid, nick] of parsed.nicks) {
      if (typeof uid === 'string' && typeof nick === 'string') {
        this.putNick(uid, nick);
      }
    }
    this.log(`UidUinCache.load: ${loaded} uid↔uin pairs + ${parsed.nicks.length} nicks from ${this.persistPath}`);
    return { loaded };
  }

  /** Force-write any pending snapshot synchronously (for tests / shutdown). */
  async flush(): Promise<void> {
    if (this.writeTimer) {
      clearTimeout(this.writeTimer);
      this.writeTimer = null;
    }
    if (!this.persistPath) return;
    if (this.writeInflight) await this.writeInflight.catch(() => undefined);
    this.writeInflight = this.writeNow();
    await this.writeInflight;
    this.writeInflight = null;
  }

  private scheduleWrite(): void {
    if (!this.persistPath) return;
    if (this.writeTimer) clearTimeout(this.writeTimer);
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      void this.writeNow().catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        this.log(`UidUinCache write failed: ${msg}`);
      });
    }, this.persistDebounceMs);
    if (this.writeTimer && typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
  }

  private async writeNow(): Promise<void> {
    if (!this.persistPath) return;
    const snapshot: PersistedShape = {
      version: 1,
      savedAt: new Date().toISOString(),
      pairs: Array.from(this.uidToUinMap.entries()),
      nicks: Array.from(this.uidToNickMap.entries()),
    };
    await fsp.writeFile(this.persistPath, JSON.stringify(snapshot), 'utf-8');
  }
}
