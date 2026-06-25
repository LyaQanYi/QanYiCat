import { useEffect, useState } from 'react';
import { I } from '../icons';
import type { InstanceStatusDto, SanitizedConfigDto } from '../../../shared/dto';

interface Props {
  status: InstanceStatusDto | null;
  config: SanitizedConfigDto | null;
  onRefresh(): void;
}

/**
 * 基础信息 — the "dashboard home" tab.
 *
 * Wires:
 * - User card ← /api/instance (uin, nick, online, qqVersion)
 * - System info rows ← /api/instance + hard-coded build identity for WebUI
 * - CPU / Mem gauges ← local animated mock (no metrics API yet — matches the
 *   design intent; status.md noted this is out of scope for v0.4p)
 * - 5 stat tiles ← /api/config networks counted by kind
 */
export default function BasicInfoPage({ status, config, onRefresh }: Props) {
  const [cpu, setCpu] = useState(16);
  const [mem, setMem] = useState(57);

  useEffect(() => {
    const t = setInterval(() => {
      setCpu((v) => Math.max(8, Math.min(42, v + (Math.random() * 6 - 3))) | 0);
      setMem((v) => Math.max(45, Math.min(74, v + (Math.random() * 4 - 2))) | 0);
    }, 2400);
    return () => clearInterval(t);
  }, []);

  const networks = config?.onebot.networks ?? [];
  const count = (kind: string): number => networks.filter((n) => n.kind === kind).length;
  const totalNet = networks.length;

  const uin = status?.uin ?? '—';
  const nick = status?.selfNick || 'QanYiCat';
  const qqVersion = status?.qqVersion ?? '—';
  const online = status?.online ?? false;
  const avatarChar = nick && nick.length > 0 ? nick[0]! : 'Q';

  return (
    <>
      <div className="grid grid-2 grid-row">
        <div className="card">
          <div className="user-card">
            <div className={`avatar ${online ? '' : 'offline'}`}>{avatarChar}</div>
            <div style={{ flex: 1 }}>
              <div className="user-name">{nick}</div>
              <div className="user-id">{uin} · QQ Bot</div>
              <span className="user-tag">{online ? '在线' : '离线'}</span>
            </div>
            <button className="icon-btn" title="刷新" onClick={onRefresh}>{I.refresh}</button>
          </div>
          <div style={{ marginTop: 22 }}>
            <div className="card-head" style={{ marginBottom: 10 }}>{I.info} 系统信息</div>
            <div className="info-row">
              <span className="info-key">{I.github} QanYiCat 版本</span>
              <span className="info-val">0.4.p</span>
              <span className="badge-new">NEW</span>
            </div>
            <div className="info-row">
              <span className="info-key">QQ 版本</span>
              <span className="info-val">{qqVersion}</span>
              <span className="info-extra">{online ? 'live' : 'memory'}</span>
            </div>
            <div className="info-row">
              <span className="info-key">WebUI 版本</span>
              <span className="info-val">v0.2</span>
              <span className="info-extra">react18</span>
            </div>
            <div className="info-row">
              <span className="info-key">{I.monitor} 平台</span>
              <span className="info-val">{platformLabel()}</span>
              <span className="info-extra">{userAgentTail()}</span>
            </div>
          </div>
        </div>

        <div className="card">
          <div className="card-head">{I.cpu} CPU</div>
          <div className="gauge-row">
            <div>
              <div className="stat-row"><span className="k">主线程</span><span className="v">{(cpu * 0.003).toFixed(2)}<small>%</small></span></div>
              <div className="stat-row"><span className="k">系统负载</span><span className="v">{cpu}<small>%</small></span></div>
              <div className="stat-row"><span className="k">来源</span><span className="v">browser <small>mock</small></span></div>
            </div>
            <Gauge value={cpu} label="占用" />
          </div>
          <div className="card-head" style={{ marginTop: 24 }}>{I.memory} 内存</div>
          <div className="gauge-row">
            <div>
              <div className="stat-row"><span className="k">使用</span><span className="v">{mem}<small>%</small></span></div>
              <div className="stat-row"><span className="k">来源</span><span className="v">browser <small>mock</small></span></div>
              <div className="stat-row"><span className="k">真实 metrics</span><span className="v">v0.4q <small>TODO</small></span></div>
            </div>
            <Gauge value={mem} label="占用" />
          </div>
        </div>
      </div>

      <div className="grid grid-5 grid-row">
        <Tile n={String(totalNet)} label="网络配置" />
        <Tile n={String(count('http-server'))} label="HTTP 服务端" />
        <Tile n={String(count('http-post'))} label="HTTP 客户端" />
        <Tile n={String(count('ws-server'))} label="WS 服务端" />
        <Tile n={String(count('ws-client'))} label="WS 客户端" />
      </div>
    </>
  );
}

function Gauge({ value, label }: { value: number; label: string }) {
  const r = 48;
  const c = 2 * Math.PI * r;
  const offset = c * (1 - value / 100);
  return (
    <div className="gauge">
      <svg viewBox="0 0 120 120">
        <circle className="track" cx="60" cy="60" r={r} />
        <circle className="bar" cx="60" cy="60" r={r} strokeDasharray={c} strokeDashoffset={offset} />
      </svg>
      <div className="gauge-num">
        <div>
          <div className="v">{value}<span style={{ fontSize: 12, color: 'var(--text-3)', marginLeft: 2 }}>%</span></div>
          <div className="l">{label}</div>
        </div>
      </div>
    </div>
  );
}

function Tile({ n, label }: { n: string; label: string }) {
  return (
    <div className="card compact tile">
      <div className="n">{n}</div>
      <div className="l">{label}</div>
    </div>
  );
}

function platformLabel(): string {
  if (typeof navigator === 'undefined') return '—';
  const p = navigator.platform || '';
  if (/win/i.test(p)) return 'win32 · x64';
  if (/mac/i.test(p)) return 'darwin · x64';
  if (/linux/i.test(p)) return 'linux';
  return p || '—';
}

function userAgentTail(): string {
  if (typeof navigator === 'undefined') return '';
  const m = /Chrome\/([\d.]+)/.exec(navigator.userAgent);
  return m ? `chrome ${m[1]!.split('.')[0]}` : 'browser';
}
