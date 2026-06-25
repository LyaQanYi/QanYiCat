import { useCallback, useEffect, useMemo, useState } from 'react';
import { I } from '../icons';
import type { ApiClient } from '../api';
import type { MediaEntryDto } from '../../../shared/dto';

interface Props {
  api: ApiClient;
}

type Kind = 'image' | 'video' | 'voice' | 'file';
const KIND_LABEL: Record<Kind, string> = {
  image: '图片', video: '视频', voice: '语音', file: '文件',
};

const FILTERS: ReadonlyArray<{ id: 'all' | Kind; label: string }> = [
  { id: 'all',   label: '全部' },
  { id: 'image', label: '图片' },
  { id: 'video', label: '视频' },
  { id: 'voice', label: '语音' },
  { id: 'file',  label: '文件' },
];

function kindOf(elementType: number): Kind {
  if (elementType === 2) return 'image';
  if (elementType === 3) return 'file';
  if (elementType === 4) return 'voice';
  if (elementType === 5) return 'video';
  return 'file';
}

function fmtSize(bytes?: number): string {
  if (!bytes || bytes <= 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

/**
 * 文件管理 — browse media the bridge has observed (PIC/VIDEO/PTT/FILE).
 *
 * Each row is one element. Cards show: kind icon, primary file name, size,
 * peer (group code or peer uin), local-cache hint (✓ when on disk; ✗ when
 * not yet downloaded), copy-key buttons.
 *
 * Real download links would need a `file://` proxy endpoint — for now we just
 * surface the path + give a "copy URL via get_media_url" button that round-
 * trips through the wire endpoint.
 */
export default function FilesPage({ api }: Props) {
  const [entries, setEntries] = useState<MediaEntryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [resolving, setResolving] = useState<string | null>(null);
  const [resolved, setResolved] = useState<Map<string, { url: string; ts: number }>>(new Map());

  const refresh = useCallback(async () => {
    setLoading(true);
    setErr(null);
    try {
      const r = await api.listMedia();
      setEntries(r.entries);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [api]);

  useEffect(() => { void refresh(); }, [refresh]);

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    return entries.filter((e) => kindOf(e.elementType) === filter);
  }, [entries, filter]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: entries.length, image: 0, video: 0, voice: 0, file: 0 };
    for (const e of entries) c[kindOf(e.elementType)] = (c[kindOf(e.elementType)] ?? 0) + 1;
    return c;
  }, [entries]);

  async function resolveUrl(entry: MediaEntryDto): Promise<void> {
    const key = entry.keys[0]!;
    setResolving(key);
    try {
      const action = entry.elementType === 5 ? 'get_video'
        : entry.elementType === 4 ? 'get_record'
        : entry.elementType === 3 ? 'get_file'
        : 'get_image';
      const r = await api.invokeWire(action, { file: key });
      if (!r.ok) throw new Error(r.error ?? 'wire call failed');
      const data = (r.response as { data?: { url?: string } } | undefined)?.data;
      const url = data?.url ?? '(no url in response)';
      setResolved((prev) => {
        const next = new Map(prev);
        next.set(key, { url, ts: Date.now() });
        return next;
      });
    } catch (e) {
      setResolved((prev) => {
        const next = new Map(prev);
        next.set(key, { url: `ERROR: ${e instanceof Error ? e.message : String(e)}`, ts: Date.now() });
        return next;
      });
    } finally {
      setResolving(null);
    }
  }

  function copyText(text: string): void {
    void navigator.clipboard.writeText(text).catch(() => {});
  }

  return (
    <>
      <div className="page-toolbar">
        <div className="tabs" style={{ marginBottom: 0, borderBottom: 'none' }}>
          {FILTERS.map((t) => (
            <button
              key={t.id}
              className={`tab ${filter === t.id ? 'active' : ''}`}
              onClick={() => setFilter(t.id)}
            >
              {t.label}
              <span className="tab-count">{counts[t.id] ?? 0}</span>
            </button>
          ))}
        </div>
        <div style={{ flex: 1 }} />
        <button className="btn ghost" onClick={refresh} disabled={loading}>{I.refresh} 刷新</button>
      </div>

      {err ? <div className="empty" style={{ color: 'var(--danger)' }}>{err}</div> : null}

      {!err && filtered.length === 0 ? (
        <div className="empty">
          {loading ? '加载中…' : entries.length === 0
            ? '尚无媒体记录 · 让 bot 收发一些图片/视频后回来'
            : '当前过滤器无匹配'}
        </div>
      ) : null}

      <div className="net-grid">
        {filtered.map((entry) => {
          const key = entry.keys[0]!;
          const kind = kindOf(entry.elementType);
          const r = resolved.get(key);
          return (
            <div key={key} className="net-card">
              <div className="net-head">
                <div className="net-title">
                  <KindIcon kind={kind} />
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                    {entry.fileName || '(no name)'}
                  </span>
                  <span className="net-kind">{KIND_LABEL[kind]}</span>
                </div>
                <span style={{
                  fontSize: 11, color: entry.localCachePath ? 'var(--ok)' : 'var(--text-3)',
                  fontFamily: 'var(--font-mono)',
                }}>
                  {entry.localCachePath ? '✓ cached' : '· remote'}
                </span>
              </div>

              <div className="net-fields">
                <div className="net-field">
                  <div className="k">大小</div>
                  <div className="v">{fmtSize(entry.fileSize)}</div>
                </div>
                <div className="net-field">
                  <div className="k">来源</div>
                  <div className="v" title={entry.peer.peerUid}>
                    {entry.peer.chatType === 'group'
                      ? `群 ${entry.peer.groupCode}`
                      : `私聊 ${entry.peer.peerUin ?? entry.peer.peerUid.slice(0, 12) + '…'}`}
                  </div>
                </div>
                <div className="net-field wide">
                  <div className="k">主键 (md5 / fileUuid)</div>
                  <div className="v" title={entry.keys.join(', ')}>{key}</div>
                </div>
                {entry.localCachePath ? (
                  <div className="net-field wide">
                    <div className="k">本地路径</div>
                    <div className="v" title={entry.localCachePath}>{entry.localCachePath}</div>
                  </div>
                ) : null}
                {r ? (
                  <div className="net-field wide" style={{ background: r.url.startsWith('ERROR:') ? 'color-mix(in oklab, var(--danger) 8%, var(--surface-2))' : undefined }}>
                    <div className="k">已解析 url</div>
                    <div className="v" title={r.url}>{r.url}</div>
                  </div>
                ) : null}
              </div>

              <div className="net-actions">
                <button className="btn ghost" onClick={() => copyText(key)} title="复制 md5/fileUuid">
                  {I.api} 复制 key
                </button>
                <button
                  className="btn ghost"
                  onClick={() => void resolveUrl(entry)}
                  disabled={resolving === key}
                  title="走 OneBot get_image/get_video/get_record/get_file"
                >
                  {I.download} {resolving === key ? '解析中…' : '获取 url'}
                </button>
                {entry.localCachePath ? (
                  <button className="btn ghost" onClick={() => copyText(entry.localCachePath!)} title="复制本地路径">
                    {I.folder} 复制路径
                  </button>
                ) : null}
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

function KindIcon({ kind }: { kind: Kind }) {
  // Reuse semantic colors from the design palette
  const color =
    kind === 'image' ? 'oklch(60% 0.14 230)' :
    kind === 'video' ? 'oklch(58% 0.14 290)' :
    kind === 'voice' ? 'oklch(56% 0.13 70)'  :
                       'oklch(56% 0.13 150)';
  const icon =
    kind === 'image' ? I.image :
    kind === 'video' ? I.video :
    kind === 'voice' ? I.voice :
                       I.file;
  return (
    <span style={{
      width: 22, height: 22, borderRadius: 6,
      background: `color-mix(in oklab, ${color} 18%, var(--surface-2))`,
      color, display: 'inline-grid', placeItems: 'center', flexShrink: 0,
    }}>
      <span style={{ width: 14, height: 14, display: 'grid', placeItems: 'center' }}>{icon}</span>
    </span>
  );
}
