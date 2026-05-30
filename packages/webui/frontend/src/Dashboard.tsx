import { useCallback, useEffect, useState } from 'react';
import type { ApiClient } from './api';
import type { InstanceStatusDto, SanitizedConfigDto } from '../../shared/dto';
import { I } from './icons';
import { useTheme } from './theme';
import { useStream, type StreamFrame } from './useStream';
import BasicInfoPage from './pages/BasicInfoPage';
import NetworkPage from './pages/NetworkPage';
import LogPage from './pages/LogPage';
import AboutPage from './pages/AboutPage';
import RealtimeDebugPage from './pages/RealtimeDebugPage';
import ApiDebuggerPage from './pages/ApiDebuggerPage';
import SettingsPage from './pages/SettingsPage';
import FilesPage from './pages/FilesPage';
import PlaceholderPage from './pages/PlaceholderPage';

interface Props {
  api: ApiClient;
  onLogout(): void;
}

type TabId =
  | 'dashboard' | 'network' | 'log' | 'api' | 'debug'
  | 'files' | 'terminal' | 'settings' | 'about';

interface NavEntry {
  id: TabId;
  label: string;
  icon: React.ReactNode;
}

const NAV: NavEntry[] = [
  { id: 'dashboard', label: '基础信息', icon: I.dashboard },
  { id: 'network',   label: '网络配置', icon: I.network },
  { id: 'log',       label: '运行日志', icon: I.log },
  { id: 'api',       label: '接口调试', icon: I.api },
  { id: 'debug',     label: '实时调试', icon: I.debug },
  { id: 'files',     label: '文件管理', icon: I.folder },
  { id: 'terminal',  label: '系统终端', icon: I.terminal },
  { id: 'settings',  label: '系统配置', icon: I.settings },
  { id: 'about',     label: '关于我们', icon: I.info },
];

const STREAM_BUFFER_CAP = 500;

/**
 * Top-level app shell — sidebar + topbar + page router. Owns the shared
 * `status`/`config` reads (slow poll for invariants) and the stream-frame
 * buffer (drained by LogPage and stream pill).
 */
export default function Dashboard({ api, onLogout }: Props) {
  const { theme, setTheme } = useTheme();
  const [tab, setTab] = useState<TabId>('dashboard');
  const [collapsed, setCollapsed] = useState(false);
  const [status, setStatus] = useState<InstanceStatusDto | null>(null);
  const [config, setConfig] = useState<SanitizedConfigDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [webuiStartedAt] = useState<number>(() => Date.now());

  const [streamFrames, setStreamFrames] = useState<StreamFrame[]>([]);
  const handleFrame = useCallback((frame: StreamFrame) => {
    setStreamFrames((prev) => {
      const next = [...prev, frame];
      return next.length > STREAM_BUFFER_CAP ? next.slice(next.length - STREAM_BUFFER_CAP) : next;
    });
  }, []);
  const streamState = useStream({ token: api.token, onFrame: handleFrame });

  // Initial load + slow refresh of static-ish data. Live events come via WS.
  useEffect(() => {
    let cancelled = false;
    async function refresh(): Promise<void> {
      try {
        const [s, c] = await Promise.all([api.instance(), api.config()]);
        if (cancelled) return;
        setStatus(s);
        setConfig(c);
        setErr(null);
      } catch (e: unknown) {
        if (!cancelled) setErr(e instanceof Error ? e.message : String(e));
      }
    }
    void refresh();
    const t = setInterval(refresh, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, [api]);

  const manualRefresh = useCallback(() => {
    void Promise.all([api.instance(), api.config()])
      .then(([s, c]) => { setStatus(s); setConfig(c); setErr(null); })
      .catch((e) => setErr((e as Error).message));
  }, [api]);

  const currentNav = NAV.find((n) => n.id === tab) ?? NAV[0]!;
  const networkCountBadge = config ? String(config.onebot.networks.length) : undefined;

  return (
    <div className="app" data-collapsed={collapsed}>
      <aside className="side">
        <div className="brand">
          <span className="brand-mark">Q</span>
          <span className="brand-name">QanYiCat</span>
        </div>
        <nav className="nav">
          {NAV.map((item) => (
            <button
              key={item.id}
              className={`nav-item ${tab === item.id ? 'active' : ''}`}
              onClick={() => setTab(item.id)}
              title={collapsed ? item.label : undefined}
            >
              <span className="nav-icon">{item.icon}</span>
              <span className="nav-label">{item.label}</span>
              {item.id === 'network' && networkCountBadge ? (
                <span className="nav-badge">{networkCountBadge}</span>
              ) : null}
            </button>
          ))}
        </nav>
        <div className="side-foot">
          <button className="nav-item" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>
            <span className="nav-icon">{theme === 'dark' ? I.sun : I.moon}</span>
            <span className="nav-label">{theme === 'dark' ? '浅色模式' : '深色模式'}</span>
          </button>
          <button className="nav-item" onClick={onLogout}>
            <span className="nav-icon">{I.logout}</span>
            <span className="nav-label">退出登录</span>
          </button>
        </div>
      </aside>

      <main className="main">
        <div className="topbar">
          <button className="icon-btn" onClick={() => setCollapsed((c) => !c)} title="折叠侧栏">{I.menu}</button>
          <div className="crumb">
            <span>QanYiCat</span>
            <span className="sep">/</span>
            <span className="here">{currentNav.label}</span>
          </div>
          <div className="topbar-spacer" />
          <span className="pill" title={`stream: ${streamState}`}>
            <span className={`dot ${streamState === 'open' ? '' : streamState === 'connecting' ? 'amber' : 'gray'}`} />
            {streamLabel(streamState, status)}
          </span>
          <button className="icon-btn" title="刷新" onClick={manualRefresh}>{I.refresh}</button>
        </div>

        {err ? (
          <div style={{ background: 'color-mix(in oklab, var(--danger) 12%, var(--surface))', color: 'var(--danger)', padding: '8px 14px', borderRadius: 10, marginBottom: 14, fontSize: 13 }}>{err}</div>
        ) : null}

        {tab === 'dashboard' && <BasicInfoPage status={status} config={config} onRefresh={manualRefresh} />}
        {tab === 'network'   && <NetworkPage api={api} config={config} onConfigChanged={setConfig} />}
        {tab === 'log'       && <LogPage api={api} streamFrames={streamFrames} liveOpen={streamState === 'open'} />}
        {tab === 'about'     && <AboutPage status={status} />}
        {tab === 'api'       && <ApiDebuggerPage api={api} />}
        {tab === 'debug'     && <RealtimeDebugPage streamFrames={streamFrames} liveOpen={streamState === 'open'} />}
        {tab === 'files'     && <FilesPage api={api} />}
        {tab === 'terminal'  && <PlaceholderPage label="系统终端" hint="bridge 进程内 REPL · 安全考虑暂不实现" />}
        {tab === 'settings'  && <SettingsPage status={status} config={config} streamFrameCount={streamFrames.length} webuiStartedAt={webuiStartedAt} />}
      </main>
    </div>
  );
}

function streamLabel(state: 'connecting' | 'open' | 'closed', status: InstanceStatusDto | null): string {
  if (state === 'open') {
    if (!status) return 'live';
    const mins = Math.floor(status.uptimeSec / 60);
    const hours = Math.floor(mins / 60);
    return `在线 · ${hours > 0 ? `${hours}h ${mins % 60}m` : `${mins}m`}`;
  }
  if (state === 'connecting') return '连接中';
  return '离线';
}
