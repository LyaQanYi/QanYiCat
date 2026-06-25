import { useEffect, useState } from 'react';
import { I } from '../icons';
import { ACCENTS, useTheme, type Density, type Theme } from '../theme';
import type { InstanceStatusDto, SanitizedConfigDto } from '../../../shared/dto';

interface Props {
  status: InstanceStatusDto | null;
  config: SanitizedConfigDto | null;
  streamFrameCount: number;
  webuiStartedAt: number | null;
}

/**
 * 系统配置 — operator-facing controls that don't fit elsewhere.
 *
 * Today it's mostly the WebUI's own preferences (theme/density/accent) +
 * runtime stats. We don't push log-level changes into the bridge (would
 * require a new endpoint + state in bridge) — the level filter lives in
 * LogPage itself. Surfaces stats useful for "is everything OK" health
 * checks: uptime, observed stream-frame count, current config snapshot.
 */
export default function SettingsPage({ status, config, streamFrameCount, webuiStartedAt }: Props) {
  const { theme, setTheme, density, setDensity, accent, setAccent } = useTheme();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const webuiUptimeSec = webuiStartedAt ? Math.max(0, Math.floor((now - webuiStartedAt) / 1000)) : 0;

  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head">{I.settings} WebUI 偏好</div>

        <Row label="主题">
          <div className="seg">
            <button className={theme === 'light' ? 'on' : ''} onClick={() => setTheme('light')}>亮色</button>
            <button className={theme === 'dark'  ? 'on' : ''} onClick={() => setTheme('dark')}>暗色</button>
          </div>
        </Row>

        <Row label="密度">
          <div className="seg">
            {(['cozy', 'comfortable', 'spacious'] as const).map((d) => (
              <button key={d} className={density === d ? 'on' : ''} onClick={() => setDensity(d as Density)}>
                {densityLabel(d)}
              </button>
            ))}
          </div>
        </Row>

        <Row label="强调色">
          <div style={{ display: 'flex', gap: 8 }}>
            {ACCENTS.map((c) => (
              <button
                key={c}
                onClick={() => setAccent(c)}
                aria-label={`use accent ${c}`}
                style={{
                  width: 28, height: 28, borderRadius: '50%',
                  background: c,
                  border: accent === c
                    ? `3px solid color-mix(in oklab, ${c} 35%, var(--bg))`
                    : '1px solid var(--border)',
                  cursor: 'pointer', padding: 0,
                }}
              />
            ))}
          </div>
        </Row>

        <div style={{ color: 'var(--text-3)', fontSize: 12, marginTop: 14, lineHeight: 1.6 }}>
          这些设置仅影响当前浏览器（localStorage 保存）；多台设备之间不同步。
          主题、密度、强调色重启浏览器后保留。
        </div>
      </div>

      <div className="card">
        <div className="card-head">{I.monitor} 运行时状态</div>

        <Row label="QQ 在线"><span style={{ color: status?.online ? 'var(--ok)' : 'var(--text-3)' }}>{status?.online ? 'online' : 'offline'}</span></Row>
        <Row label="UIN"><span className="mono">{status?.uin ?? '—'}</span></Row>
        <Row label="QQ 版本"><span className="mono">{status?.qqVersion ?? '—'}</span></Row>
        <Row label="QQ 进程已运行">{status ? fmtDuration(status.uptimeSec) : '—'}</Row>
        <Row label="WebUI 已运行">{webuiStartedAt ? fmtDuration(webuiUptimeSec) : '—'}</Row>
        <Row label="已观察事件帧">{streamFrameCount}</Row>
        <Row label="OB11 启用"><span className="mono">{String(config?.onebot.enable11 ?? false)}</span></Row>
        <Row label="OB12 启用"><span className="mono">{String(config?.onebot.enable12 ?? false)}</span></Row>
        <Row label="网络通道">{config ? config.onebot.networks.length : '—'}</Row>
      </div>

      <div className="card" style={{ gridColumn: '1 / -1' }}>
        <div className="card-head">{I.info} passkey + 高级</div>
        <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7, margin: 0 }}>
          WebUI 密码 + JWT secret 默认写在项目目录的
          {' '}<code style={codeStyle}>qanyicat.webui.passkey.json</code> 里。
          想重置：关掉 QQ → 删除该文件 → 重启 quick-start.bat，bridge 会自动生成新的并写回。
        </p>
        <p style={{ color: 'var(--text-2)', fontSize: 13, lineHeight: 1.7, margin: '8px 0 0' }}>
          如要 force 用某个固定密码，设环境变量 <code style={codeStyle}>QANYICAT_WEBUI_PASSWORD=…</code>
          再启动，env 永远胜过文件且不会改写文件。要换文件路径：
          <code style={codeStyle}>QANYICAT_WEBUI_PASSKEY_PATH=…</code>。
        </p>
        <p style={{ color: 'var(--text-3)', fontSize: 12, lineHeight: 1.7, margin: '8px 0 0' }}>
          日志级别过滤在「运行日志」页设置（chip 多选），仅影响 WebUI 视图，不修改 bridge 实际日志级别。
        </p>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="info-row">
      <span className="info-key">{label}</span>
      <span className="info-val">{children}</span>
      <span />
    </div>
  );
}

function densityLabel(d: Density): string {
  if (d === 'cozy') return '紧凑';
  if (d === 'spacious') return '宽松';
  return '舒适';
}

function fmtDuration(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${sec % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

const codeStyle: React.CSSProperties = {
  background: 'var(--surface-2)',
  padding: '1px 6px',
  borderRadius: 4,
  fontFamily: 'var(--font-mono)',
  fontSize: 12,
};

// Satisfy unused-vars when Theme isn't otherwise referenced
export type _Theme = Theme;
