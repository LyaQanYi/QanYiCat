import { I } from '../icons';
import type { InstanceStatusDto } from '../../../shared/dto';

interface Props {
  status: InstanceStatusDto | null;
}

const FEATURES = [
  { id: 'perf',   icon: I.rocket, title: '高性能架构',
    desc: 'Node.js + 原生 Rust 注入器混合实现 · 资源占用低、响应迅速。',
    bg: 'color-mix(in oklab, oklch(64% 0.13 18) 18%, var(--surface-2))',
    fg: 'oklch(60% 0.14 18)' },
  { id: 'cross',  icon: I.globe,  title: '跨平台',
    desc: '注入路径在 Windows 已验证 · Linux/macOS 待移植。',
    bg: 'color-mix(in oklab, oklch(64% 0.13 150) 18%, var(--surface-2))',
    fg: 'oklch(56% 0.13 150)' },
  { id: 'onebot', icon: I.code,   title: 'OneBot 11 / 12',
    desc: '双协议栈完整实现，发送 + 接收 + 通知 + 请求全链路 wire-验证。',
    bg: 'color-mix(in oklab, oklch(64% 0.13 70) 18%, var(--surface-2))',
    fg: 'oklch(56% 0.13 70)' },
  { id: 'ext',    icon: I.puzzle, title: '可热重载',
    desc: 'WebUI 改 adapter 配置即生效 · 无需重启 QQ。',
    bg: 'color-mix(in oklab, oklch(64% 0.13 290) 18%, var(--surface-2))',
    fg: 'oklch(58% 0.14 290)' },
];

const RESOURCES = [
  { icon: I.github, label: 'GitHub',   href: 'https://github.com/LyaQanYi/QanYiCat' },
  { icon: I.doc,    label: 'OneBot 协议规范', href: 'https://onebot.dev/' },
  { icon: I.chat,   label: '社区频道', href: '#' },
];

const STACK = ['TypeScript', 'React 18', 'Vite', 'Node 22', 'Rust', 'OneBot 11/12', 'WebSocket', 'Hono', 'pnpm'];

/** 关于我们 — static page; hero pulls qqVersion off the live ctx. */
export default function AboutPage({ status }: Props) {
  return (
    <>
      <div className="about-hero">
        <div className="about-mark">Q</div>
        <div style={{ flex: 1 }}>
          <div className="about-title">关于 <em>QanYiCat</em></div>
          <div className="about-tagline">从零起步的 QQ NT OneBot 11/12 协议终端 · 为机器人开发者而生</div>
          <div className="about-meta">
            <span className="pill">WebUI · v0.2</span>
            <span className="pill accent">Core · v0.4p</span>
            {status?.qqVersion ? <span className="pill">QQ · {status.qqVersion}</span> : null}
          </div>
        </div>
      </div>

      <div className="about-grid">
        <div>
          <div className="about-card">
            <h3>{I.info} 项目简介</h3>
            <p>
              <strong>QanYiCat</strong> 通过原生 DLL 注入 QQ NT 的 Electron 主进程，
              在 V8 内启动 OneBot 协议终端，无需修改 QQ 安装文件、不触发签名校验。
            </p>
            <p>
              单二进制启动器 + 注入 hook · 协议层用 TypeScript · 可与 NoneBot / koishi / Kotori 等机器人框架开箱对接。
            </p>
          </div>

          <div className="feature-grid">
            {FEATURES.map((f) => (
              <div key={f.id} className="feature">
                <div
                  className="feature-icon"
                  style={{
                    ['--feat-bg' as string]: f.bg,
                    ['--feat-fg' as string]: f.fg,
                  } as React.CSSProperties}
                >
                  {f.icon}
                </div>
                <div>
                  <h4>{f.title}</h4>
                  <p>{f.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--gap-grid)' }}>
          <div className="about-card">
            <h3>{I.api} 相关资源</h3>
            <div className="res-list">
              {RESOURCES.map((r, i) => (
                <a key={i} className="res-row" href={r.href} target="_blank" rel="noreferrer">
                  <span className="res-ico">{r.icon}</span>
                  <span className="res-label">{r.label}</span>
                  <span className="res-jump">跳转 →</span>
                </a>
              ))}
            </div>
          </div>

          <div className="about-card">
            <h3>{I.chip} 技术栈</h3>
            <div className="stack-chips">
              {STACK.map((t) => <span key={t} className="chip-tech">{t}</span>)}
            </div>
          </div>
        </div>
      </div>
    </>
  );
}
