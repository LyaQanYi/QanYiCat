import { promises as fsp } from 'node:fs';
import type { NTPeer, NTRawMessage } from '@qanyicat/core';

/**
 * Media-element lookup table. NT identifies media for download by
 * `(peer, msgId, elementId, elementType)`, but the OB11 wire only carries
 * `data.file` (an md5 / fileUuid identifier). This bounded index maps the
 * wire-side key back to the kernel-side context so `get_video` / `get_file`
 * etc. can fulfil the request from a single string identifier.
 *
 * Populated by the bridge's kernel listener for every observed PIC / VIDEO /
 * PTT / FILE element. Keyed on the most-stable identifier first (md5HexStr if
 * present, else fileUuid). FIFO-evicts when full.
 *
 * Optionally persists to disk (debounced) so a QQ relaunch via quick-start.bat
 * doesn't lose the in-memory accumulation — `get_video` / `get_file` for media
 * the bot has seen in earlier sessions still works without re-priming via
 * `get_*_msg_history`.
 */
export interface MediaIndexEntry {
  peer: NTPeer;
  msgId: string;
  elementId: string;
  /** NTElementType: 2=PIC, 3=FILE, 4=PTT, 5=VIDEO */
  elementType: number;
  fileName?: string;
  fileSize?: number;
  /**
   * v0.4n-β: local filesystem path where NT has cached the media bytes.
   * Populated by `onRichMediaDownloadComplete` non-thumbnail events (which
   * NT fires automatically on receive for video/pic/voice but NOT for file).
   * Also populated for bot-sent media via the stage*ForSend path.
   */
  localCachePath?: string;
}

export interface MediaIndexOptions {
  /** Maximum keys retained; FIFO-evicts when crossed. Default 10_000. */
  cap?: number;
  /**
   * If set, the index serializes to this absolute file path (debounced).
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
  /** One group per unique entry, listing every key that pointed at it. */
  entries: Array<{ keys: string[]; entry: MediaIndexEntry }>;
}

export class MediaIndex {
  private byKey = new Map<string, MediaIndexEntry>();
  private order: string[] = [];
  private readonly cap: number;
  private readonly persistPath: string | null;
  private readonly persistDebounceMs: number;
  private readonly log: (msg: string) => void;
  private writeTimer: NodeJS.Timeout | null = null;
  private writeInflight: Promise<void> | null = null;

  // Overload preserves the legacy `new MediaIndex(cap)` shape used by tests
  // pre-v0.4n-housekeeping-9.
  constructor(opts?: MediaIndexOptions);
  constructor(cap: number);
  constructor(arg?: number | MediaIndexOptions) {
    const opts: MediaIndexOptions = typeof arg === 'number' ? { cap: arg } : (arg ?? {});
    this.cap = opts.cap ?? 10_000;
    this.persistPath = opts.persistPath ?? null;
    this.persistDebounceMs = opts.persistDebounceMs ?? 5000;
    this.log = opts.log ?? (() => {});
  }

  /** Add the entry under every plausible key (md5, fileUuid) so lookup succeeds regardless of which one the wire client echoes back. */
  put(keys: string[], entry: MediaIndexEntry): void {
    const dedup = Array.from(new Set(keys.filter((k) => k && k.length > 0)));
    if (dedup.length === 0) return;
    let touched = false;
    for (const k of dedup) {
      if (this.byKey.has(k)) continue; // first-wins so the original (peer, msgId) sticks
      this.byKey.set(k, entry);
      this.order.push(k);
      touched = true;
    }
    while (this.order.length > this.cap) {
      const evict = this.order.shift();
      if (evict !== undefined) this.byKey.delete(evict);
      touched = true;
    }
    if (touched) this.scheduleWrite();
  }

  get(key: string): MediaIndexEntry | undefined {
    return this.byKey.get(key);
  }

  /**
   * v0.4n-β: walk an NT raw message and index every media element.
   * Mirrors the inline logic in the kernel listener so callers like
   * `fetchHistory` and `fetch` can also populate the index without re-implementing.
   * `extractLocalPath` returns the bot-sent stage path if present (filePath /
   * sourcePath fields populated by stage*ForSend during send).
   */
  indexFromRaw(raw: NTRawMessage): void {
    if (!raw || !Array.isArray(raw.elements)) return;
    for (const el of raw.elements as Array<Record<string, unknown>>) {
      if (!el || typeof el !== 'object') continue;
      const elementId = String(el.elementId ?? '');
      if (!elementId || !raw.msgId) continue;
      const etype = Number(el.elementType ?? 0);
      let keys: string[] = [];
      let fileName: string | undefined;
      let fileSize: number | undefined;
      let localCachePath: string | undefined;
      const e = el as Record<string, Record<string, unknown> | undefined>;
      if (etype === 2 && e.picElement) {
        keys = [String(e.picElement.md5HexStr ?? ''), String(e.picElement.fileUuid ?? '')];
        fileName = String(e.picElement.fileName ?? '') || undefined;
        fileSize = Number(e.picElement.fileSize ?? 0) || undefined;
        const sp = String(e.picElement.sourcePath ?? '');
        if (sp) localCachePath = sp;
      } else if (etype === 3 && e.fileElement) {
        keys = [String(e.fileElement.fileMd5 ?? ''), String(e.fileElement.fileUuid ?? '')];
        fileName = String(e.fileElement.fileName ?? '') || undefined;
        fileSize = Number(e.fileElement.fileSize ?? 0) || undefined;
        const fp = String(e.fileElement.filePath ?? '');
        if (fp) localCachePath = fp;
      } else if (etype === 4 && e.pttElement) {
        keys = [String(e.pttElement.md5HexStr ?? ''), String(e.pttElement.fileUuid ?? '')];
        fileName = String(e.pttElement.fileName ?? '') || undefined;
        fileSize = Number(e.pttElement.fileSize ?? 0) || undefined;
        const fp = String(e.pttElement.filePath ?? '');
        if (fp) localCachePath = fp;
      } else if (etype === 5 && e.videoElement) {
        keys = [String(e.videoElement.videoMd5 ?? ''), String(e.videoElement.fileUuid ?? '')];
        fileName = String(e.videoElement.fileName ?? '') || undefined;
        fileSize = Number(e.videoElement.fileSize ?? 0) || undefined;
        const fp = String(e.videoElement.filePath ?? '');
        if (fp) localCachePath = fp;
      }
      if (keys.length > 0) {
        this.put(keys, {
          peer: raw.peer, msgId: raw.msgId, elementId, elementType: etype,
          ...(fileName ? { fileName } : {}),
          ...(fileSize ? { fileSize } : {}),
          ...(localCachePath ? { localCachePath } : {}),
        });
      }
    }
  }

  /**
   * v0.4n-β: stash the local cache path NT auto-wrote on receive/send.
   * Walks every key pointing at the same (msgId, elementId) entry — multiple
   * keys (md5, fileUuid) may share one entry. Returns true if a match was found.
   */
  setLocalCachePath(msgId: string, elementId: string, localCachePath: string): boolean {
    if (!msgId || !elementId || !localCachePath) return false;
    let touched = false;
    for (const entry of this.byKey.values()) {
      if (entry.msgId === msgId && entry.elementId === elementId) {
        entry.localCachePath = localCachePath;
        touched = true;
      }
    }
    if (touched) this.scheduleWrite();
    return touched;
  }

  get size(): number {
    return this.byKey.size;
  }

  /**
   * v0.4n-housekeeping-3: dedup'd snapshot for the WebUI 文件管理 page.
   * Each underlying entry may be inserted under several keys (md5 + fileUuid);
   * we collapse by `(msgId, elementId)` and return one row per real element,
   * with `keys` listing every accepted lookup string so the UI can show + copy
   * them. Newest-first by insertion order.
   */
  list(): Array<MediaIndexEntry & { keys: string[] }> {
    const byEntry = new Map<string, { entry: MediaIndexEntry; keys: string[] }>();
    // Walk insertion order so the FIFO trim is reflected, then reverse below.
    for (let i = 0; i < this.order.length; i++) {
      const key = this.order[i]!;
      const entry = this.byKey.get(key);
      if (!entry) continue;
      const rowKey = `${entry.msgId}::${entry.elementId}`;
      const slot = byEntry.get(rowKey);
      if (slot) {
        if (!slot.keys.includes(key)) slot.keys.push(key);
      } else {
        byEntry.set(rowKey, { entry, keys: [key] });
      }
    }
    return Array.from(byEntry.values())
      .map(({ entry, keys }) => ({ ...entry, keys }))
      .reverse();
  }

  /**
   * v0.4n-housekeeping-9: read the persisted snapshot from `persistPath` (if
   * configured) and re-populate the index. Best-effort — missing file / bad
   * JSON / wrong shape silently start empty (logged). Caller awaits before
   * the kernel listener attaches so subsequent `put()`s win the FIFO race
   * over old entries that just got loaded.
   */
  async load(): Promise<{ loaded: number; reason?: string }> {
    if (!this.persistPath) return { loaded: 0, reason: 'no persistPath configured' };
    let raw: string;
    try {
      raw = await fsp.readFile(this.persistPath, 'utf-8');
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'ENOENT') {
        return { loaded: 0, reason: 'no prior snapshot' };
      }
      this.log(`MediaIndex.load read failed: ${err.message}`);
      return { loaded: 0, reason: `read error: ${err.message}` };
    }
    let parsed: PersistedShape;
    try {
      parsed = JSON.parse(raw) as PersistedShape;
    } catch (e) {
      this.log(`MediaIndex.load parse failed: ${(e as Error).message}`);
      return { loaded: 0, reason: 'malformed JSON' };
    }
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      this.log(`MediaIndex.load: unsupported snapshot shape (version=${parsed?.version})`);
      return { loaded: 0, reason: 'unsupported version' };
    }
    let loaded = 0;
    for (const g of parsed.entries) {
      if (!g || !Array.isArray(g.keys) || !g.entry || !g.entry.msgId || !g.entry.elementId) continue;
      this.put(g.keys, g.entry);
      loaded++;
    }
    this.log(`MediaIndex.load: ${loaded} entries from ${this.persistPath}`);
    return { loaded };
  }

  /**
   * Force-write any pending snapshot synchronously (for tests). In normal use
   * the debounced timer takes care of writes — call this explicitly only if
   * you need a guaranteed flush (e.g. before process exit, which the bridge
   * doesn't currently arrange).
   */
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
        this.log(`MediaIndex write failed: ${msg}`);
      });
    }, this.persistDebounceMs);
    // setTimeout's handle keeps the event loop alive — fine inside QQ (where
    // the process runs forever) but harmful in vitest. unref() lets vitest exit.
    if (this.writeTimer && typeof this.writeTimer.unref === 'function') this.writeTimer.unref();
  }

  private async writeNow(): Promise<void> {
    if (!this.persistPath) return;
    const snapshot = this.snapshotForPersist();
    const json = JSON.stringify(snapshot);
    await fsp.writeFile(this.persistPath, json, 'utf-8');
  }

  private snapshotForPersist(): PersistedShape {
    const seen = new Map<MediaIndexEntry, string[]>();
    const groups: PersistedShape['entries'] = [];
    for (const k of this.order) {
      const e = this.byKey.get(k);
      if (!e) continue;
      const keys = seen.get(e);
      if (keys) {
        keys.push(k);
      } else {
        const fresh = [k];
        seen.set(e, fresh);
        groups.push({ keys: fresh, entry: e });
      }
    }
    return { version: 1, savedAt: new Date().toISOString(), entries: groups };
  }
}
