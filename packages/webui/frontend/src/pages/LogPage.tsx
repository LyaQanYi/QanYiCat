import { useEffect, useMemo, useRef, useState } from 'react';
import { I } from '../icons';
import type { ApiClient } from '../api';
import type { LogLineDto } from '../../../shared/dto';
import type { StreamFrame } from '../useStream';

interface Props {
  api: ApiClient;
  streamFrames: StreamFrame[];
  liveOpen: boolean;
}

type Level = 'debug' | 'info' | 'warn' | 'error' | 'fatal';

const LOG_LEVELS: ReadonlyArray<{ id: Level; label: string }> = [
  { id: 'debug', label: 'Debug' },
  { id: 'info',  label: 'Info'  },
  { id: 'warn',  label: 'Warn'  },
  { id: 'error', label: 'Error' },
  { id: 'fatal', label: 'Fatal' },
];

const MAX_BUFFER = 200;

interface DisplayLine {
  id: number;
  ts: Date;
  lv: Level;
  src: string;
  msg: string;
}

/**
 * 运行日志 — terminal-style viewer.
 *
 * Modes:
 * - 实时日志 — buffer fed by parent's WS stream frames (useStream in App).
 *   Pauseable; cleared on demand; capped at 200 lines.
 * - 历史日志 — one-shot fetch from /api/logs (snapshot of the bridge's ring
 *   buffer at click time).
 */
export default function LogPage({ api, streamFrames, liveOpen }: Props) {
  const [mode, setMode] = useState<'live' | 'history'>('live');
  const [levels, setLevels] = useState<Set<Level>>(() => new Set<Level>(['info', 'warn', 'error', 'fatal']));
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [lines, setLines] = useState<DisplayLine[]>([]);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const streamRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(0);
  const lastFrameRef = useRef(0);

  // Live mode: drain new frames into buffer (unless paused).
  useEffect(() => {
    if (mode !== 'live' || paused) return;
    if (streamFrames.length === lastFrameRef.current) return;
    const fresh = streamFrames.slice(lastFrameRef.current);
    lastFrameRef.current = streamFrames.length;
    const newLines: DisplayLine[] = [];
    for (const frame of fresh) {
      if (frame.type === 'log') {
        newLines.push(toDisplayLine(frame.line, ++idRef.current));
      } else if (frame.type === 'event') {
        newLines.push({
          id: ++idRef.current,
          ts: new Date(),
          lv: 'info',
          src: 'event',
          msg: `[${frame.kind}] ${truncateJson(frame.data)}`,
        });
      }
    }
    if (newLines.length > 0) {
      setLines((prev) => {
        const next = [...prev, ...newLines];
        return next.length > MAX_BUFFER ? next.slice(next.length - MAX_BUFFER) : next;
      });
    }
  }, [streamFrames, mode, paused]);

  // History mode: pull snapshot once on mode-enter.
  useEffect(() => {
    if (mode !== 'history') return;
    setHistoryError(null);
    void api.logs().then((r) => {
      const mapped = r.lines.map((l) => toDisplayLine(l, ++idRef.current));
      setLines(mapped.slice(-MAX_BUFFER));
    }).catch((e) => setHistoryError(e instanceof Error ? e.message : String(e)));
  }, [mode, api]);

  useEffect(() => {
    if (!autoScroll || !streamRef.current) return;
    streamRef.current.scrollTop = streamRef.current.scrollHeight;
  }, [lines, autoScroll]);

  const filtered = useMemo(() => lines.filter((l) => levels.has(l.lv)), [lines, levels]);
  const toggleLevel = (id: Level): void => setLevels((s) => {
    const n = new Set(s);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n;
  });

  const download = (): void => {
    const body = filtered.map((l) => `${fmtTime(l.ts)} ${l.lv.toUpperCase()} [${l.src}] ${l.msg}`).join('\n');
    const blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `qanyicat-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="page-toolbar" style={{ justifyContent: 'center', marginBottom: 14 }}>
        <div className="seg">
          <button className={mode === 'live' ? 'on' : ''} onClick={() => setMode('live')}>实时日志</button>
          <button className={mode === 'history' ? 'on' : ''} onClick={() => setMode('history')}>历史日志</button>
        </div>
      </div>

      <div className="log-toolbar">
        <span className="lbl">日志级别</span>
        {LOG_LEVELS.map((lv) => (
          <button
            key={lv.id}
            className="chip"
            data-level={lv.id}
            data-on={levels.has(lv.id)}
            onClick={() => toggleLevel(lv.id)}
          >
            <span className="dot" />
            {lv.label}
          </button>
        ))}
        <div className="grow" />
        <button className="btn ghost" onClick={() => setPaused((p) => !p)} disabled={mode !== 'live'}>
          {paused ? I.play : I.pause} {paused ? '继续' : '暂停'}
        </button>
        <button className="btn ghost" onClick={() => setLines([])}>{I.clear} 清空</button>
        <button className="btn primary" onClick={download}>{I.download} 下载日志</button>
      </div>

      <div className="log-viewer">
        <div className="log-viewer-head">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span style={{
              width: 6, height: 6, borderRadius: '50%',
              background: (mode === 'history' || paused || !liveOpen) ? 'var(--text-3)' : 'var(--ok)',
            }} />
            {mode === 'live' ? (paused ? '已暂停' : liveOpen ? '实时流' : '等待连接…') : '历史快照'}
          </span>
          {historyError ? <span style={{ color: 'var(--danger)' }}>{historyError}</span> : null}
          <div className="grow" />
          <span>{filtered.length} / {lines.length} 行</span>
        </div>
        <div className="log-stream" ref={streamRef}>
          {filtered.length === 0 ? (
            <div style={{ color: 'var(--text-3)', padding: 24, textAlign: 'center' }}>
              {mode === 'live' ? '尚无日志 · 等待 bridge 输出' : '历史缓冲为空'}
            </div>
          ) : filtered.map((l) => (
            <div key={l.id} className="log-line" data-level={l.lv}>
              <span className="ts">{fmtTime(l.ts)}</span>
              <span className="lv">{l.lv.toUpperCase()}</span>
              <span className="meta">[{l.src}]</span>
              <span className="msg">{renderMessage(l.msg)}</span>
            </div>
          ))}
        </div>
        <div className="log-foot">
          <label className="auto-scroll">
            <input type="checkbox" checked={autoScroll} onChange={(e) => setAutoScroll(e.target.checked)} />
            自动滚动
          </label>
          <div className="grow" />
          <span>最大缓存 {MAX_BUFFER} 行</span>
        </div>
      </div>
    </>
  );
}

function toDisplayLine(line: LogLineDto, id: number): DisplayLine {
  return {
    id,
    ts: new Date(line.timestamp),
    lv: line.level,
    src: line.label || 'log',
    msg: line.message,
  };
}

function fmtTime(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function truncateJson(value: unknown): string {
  try {
    const s = JSON.stringify(value);
    return s.length > 240 ? `${s.slice(0, 240)}…` : s;
  } catch {
    return String(value);
  }
}

function renderMessage(msg: string): React.ReactNode[] {
  const parts = msg.split(/(\[[^\]]+\])/g);
  return parts.map((p, i) =>
    /^\[[^\]]+\]$/.test(p)
      ? <span key={i} className="tag">{p}</span>
      : <span key={i}>{p}</span>
  );
}
