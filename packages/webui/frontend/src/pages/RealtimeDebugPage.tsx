import { useEffect, useMemo, useRef, useState } from 'react';
import { I } from '../icons';
import type { StreamFrame } from '../useStream';

interface Props {
  streamFrames: StreamFrame[];
  liveOpen: boolean;
}

interface EventRecord {
  id: number;
  ts: number;
  kind: string;
  data: unknown;
}

const KNOWN_KINDS = [
  'msg.recv',
  'msg.recall',
  'group.member-change',
  'group.admin-change',
  'group.request',
  'friend.request',
  'login.success',
] as const;

const MAX_BUFFER = 300;

/**
 * 实时调试 — raw NT event firehose, complement to the prettified LogPage.
 *
 * - Drains `streamFrames` like LogPage but keeps only `event` frames (logs go
 *   to the dedicated page).
 * - Per-kind chip filter, pause/clear, NDJSON download.
 * - Each row collapses to one summary line + expand-on-click full JSON.
 */
export default function RealtimeDebugPage({ streamFrames, liveOpen }: Props) {
  const [paused, setPaused] = useState(false);
  const [events, setEvents] = useState<EventRecord[]>([]);
  const [enabledKinds, setEnabledKinds] = useState<Set<string>>(() => new Set(KNOWN_KINDS));
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const idRef = useRef(0);
  const lastFrameRef = useRef(0);

  useEffect(() => {
    if (paused) return;
    if (streamFrames.length === lastFrameRef.current) return;
    const fresh = streamFrames.slice(lastFrameRef.current);
    lastFrameRef.current = streamFrames.length;
    const newEvents: EventRecord[] = [];
    for (const frame of fresh) {
      if (frame.type !== 'event') continue;
      newEvents.push({ id: ++idRef.current, ts: Date.now(), kind: frame.kind, data: frame.data });
    }
    if (newEvents.length === 0) return;
    setEvents((prev) => {
      const next = [...prev, ...newEvents];
      return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
    });
  }, [streamFrames, paused]);

  // Roll up "kinds we've seen this session" so the filter shows surprises
  // (any kind that didn't make KNOWN_KINDS still surfaces).
  const seenKinds = useMemo(() => {
    const s = new Set<string>(KNOWN_KINDS);
    for (const e of events) s.add(e.kind);
    return Array.from(s).sort();
  }, [events]);

  const filtered = useMemo(
    () => events.filter((e) => enabledKinds.has(e.kind)),
    [events, enabledKinds]
  );

  function toggleKind(kind: string): void {
    setEnabledKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind); else next.add(kind);
      return next;
    });
  }
  function toggleExpand(id: number): void {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  function downloadNdjson(): void {
    const body = filtered
      .map((e) => JSON.stringify({ ts: e.ts, kind: e.kind, data: e.data }))
      .join('\n');
    const blob = new Blob([body], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qanyicat-events-${new Date().toISOString().replace(/[:.]/g, '-')}.ndjson`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  return (
    <>
      <div className="log-toolbar">
        <span className="lbl">事件 kind</span>
        {seenKinds.map((kind) => (
          <button
            key={kind}
            className="chip"
            data-on={enabledKinds.has(kind)}
            onClick={() => toggleKind(kind)}
            title={kind}
          >
            <span className="dot" />
            {kind}
          </button>
        ))}
        <div className="grow" />
        <button className="btn ghost" onClick={() => setPaused((p) => !p)}>
          {paused ? I.play : I.pause} {paused ? '继续' : '暂停'}
        </button>
        <button className="btn ghost" onClick={() => { setEvents([]); setExpanded(new Set()); }}>
          {I.clear} 清空
        </button>
        <button className="btn primary" onClick={downloadNdjson}>{I.download} 下载 NDJSON</button>
      </div>

      <div className="log-viewer">
        <div className="log-viewer-head">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: (paused || !liveOpen) ? 'var(--text-3)' : 'var(--ok)',
            }} />
            {paused ? '已暂停' : liveOpen ? '实时流' : '等待连接…'}
          </span>
          <div className="grow" />
          <span>{filtered.length} / {events.length} 事件</span>
        </div>
        <div className="log-stream">
          {filtered.length === 0 ? (
            <div style={{ color: 'var(--text-3)', padding: 24, textAlign: 'center' }}>
              {events.length === 0 ? '尚无事件 · 让 bot 收一条消息或触发一个 notice 试试' : '当前过滤器无匹配'}
            </div>
          ) : (
            filtered.map((e) => (
              <EventRow
                key={e.id}
                rec={e}
                expanded={expanded.has(e.id)}
                onToggle={() => toggleExpand(e.id)}
              />
            ))
          )}
        </div>
        <div className="log-foot">
          <span>最大缓存 {MAX_BUFFER} 条</span>
          <div className="grow" />
          <span>点击行展开/收起完整 JSON</span>
        </div>
      </div>
    </>
  );
}

function EventRow({ rec, expanded, onToggle }: { rec: EventRecord; expanded: boolean; onToggle(): void }) {
  return (
    <div style={{ borderBottom: '1px solid var(--border)' }}>
      <div
        onClick={onToggle}
        style={{ display: 'flex', gap: 12, padding: '4px 0', cursor: 'pointer', alignItems: 'center' }}
        title="点击展开"
      >
        <span style={{ color: 'var(--text-3)', flexShrink: 0 }}>{fmtTime(rec.ts)}</span>
        <span style={{ color: 'var(--accent)', fontWeight: 600, flexShrink: 0, minWidth: 160 }}>{rec.kind}</span>
        <span style={{ color: 'var(--text-2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {summarize(rec.data)}
        </span>
        <span style={{ color: 'var(--text-3)', flexShrink: 0, marginLeft: 'auto' }}>{expanded ? '▾' : '▸'}</span>
      </div>
      {expanded ? (
        <pre style={{
          margin: '4px 0 8px 28px', padding: '8px 12px',
          background: 'var(--surface-2)', border: '1px solid var(--border)', borderRadius: 6,
          fontSize: 11.5, overflowX: 'auto', color: 'var(--text)',
        }}>{JSON.stringify(rec.data, null, 2)}</pre>
      ) : null}
    </div>
  );
}

function fmtTime(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function summarize(data: unknown): string {
  if (data === null || data === undefined) return '';
  if (typeof data !== 'object') return String(data);
  try {
    const s = JSON.stringify(data);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(data);
  }
}
