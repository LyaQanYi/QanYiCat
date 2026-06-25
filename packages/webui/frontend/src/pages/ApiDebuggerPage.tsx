import { useEffect, useState } from 'react';
import { I } from '../icons';
import type { ApiClient, WireInvokeResponseDto } from '../api';

interface Props {
  api: ApiClient;
}

interface HistoryEntry {
  id: number;
  ts: number;
  action: string;
  protocol: 'v11' | 'v12';
  params: string;
  echo: string;
  response: WireInvokeResponseDto;
}

/** Common OB11 actions surfaced in the action input's datalist. Hand-curated;
 *  the user can still type any other string and we'll pass it through. */
const COMMON_ACTIONS: ReadonlyArray<string> = [
  'get_status', 'get_login_info', 'get_version_info',
  'send_msg', 'send_private_msg', 'send_group_msg', 'send_forward_msg', 'send_private_forward_msg', 'send_group_forward_msg',
  'delete_msg', 'get_msg',
  'get_friend_list', 'get_group_list', 'get_group_member_list', 'get_group_member_info',
  'get_stranger_info',
  'set_group_kick', 'set_group_admin', 'set_group_card', 'set_group_ban', 'set_group_whole_ban',
  'set_friend_add_request', 'set_group_add_request',
  'get_friend_msg_history', 'get_group_msg_history',
  'get_image', 'get_record', 'get_video', 'get_file',
  'add_friend', 'send_friend_request',
];

/** Quick-fill params templates for popular actions. Picking a preset stamps
 *  this into the params textarea so users learn the shapes. */
const ACTION_PRESETS: Record<string, string> = {
  get_status: '{}',
  get_login_info: '{}',
  get_version_info: '{}',
  get_friend_list: '{}',
  get_group_list: '{}',
  send_private_msg: '{\n  "user_id": 10001,\n  "message": "hi from WebUI"\n}',
  send_group_msg: '{\n  "group_id": 100002,\n  "message": "hi"\n}',
  send_msg: '{\n  "message_type": "private",\n  "user_id": 10001,\n  "message": "hi"\n}',
  get_group_member_list: '{\n  "group_id": 100002\n}',
  get_group_member_info: '{\n  "group_id": 100002,\n  "user_id": 10001\n}',
  get_stranger_info: '{\n  "user_id": 10001\n}',
  set_group_kick: '{\n  "group_id": 100002,\n  "user_id": 10001,\n  "reject_add_request": false\n}',
  set_group_ban: '{\n  "group_id": 100002,\n  "user_id": 10001,\n  "duration": 60\n}',
  set_group_whole_ban: '{\n  "group_id": 100002,\n  "enable": false\n}',
  set_group_card: '{\n  "group_id": 100002,\n  "user_id": 10001,\n  "card": ""\n}',
  set_group_admin: '{\n  "group_id": 100002,\n  "user_id": 10001,\n  "enable": true\n}',
  set_friend_add_request: '{\n  "flag": "<paste from request event>",\n  "approve": true,\n  "remark": ""\n}',
  set_group_add_request: '{\n  "flag": "<paste from request event>",\n  "approve": true,\n  "reason": ""\n}',
  delete_msg: '{\n  "message_id": "<paste from message event>"\n}',
  get_msg: '{\n  "message_id": "<paste from message event>"\n}',
  get_friend_msg_history: '{\n  "user_id": 10001,\n  "count": 20\n}',
  get_group_msg_history: '{\n  "group_id": 100002,\n  "count": 20\n}',
  get_image: '{\n  "file": "<md5 or fileUuid>"\n}',
  get_video: '{\n  "file": "<md5 or fileUuid>"\n}',
  get_record: '{\n  "file": "<md5 or fileUuid>"\n}',
  get_file: '{\n  "file": "<md5 or fileUuid>"\n}',
};

const MAX_HISTORY = 10;
const STORAGE_KEY = 'qyc-api-debug-history';

function loadHistory(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as HistoryEntry[];
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_HISTORY);
  } catch { return []; }
}

function saveHistory(entries: HistoryEntry[]): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_HISTORY))); }
  catch { /* storage full / unavailable — silent */ }
}

export default function ApiDebuggerPage({ api }: Props) {
  const [action, setAction] = useState('get_status');
  const [protocol, setProtocol] = useState<'v11' | 'v12'>('v11');
  const [params, setParams] = useState<string>(ACTION_PRESETS['get_status'] ?? '{}');
  const [echo, setEcho] = useState<string>('');
  const [paramsErr, setParamsErr] = useState<string | null>(null);
  const [response, setResponse] = useState<WireInvokeResponseDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>(() => loadHistory());
  const idRef = useState({ n: Date.now() })[0];

  // Persist history every time it changes
  useEffect(() => { saveHistory(history); }, [history]);

  function pickAction(next: string): void {
    setAction(next);
    if (ACTION_PRESETS[next] !== undefined) setParams(ACTION_PRESETS[next]!);
  }

  async function send(): Promise<void> {
    setBusy(true);
    setParamsErr(null);
    setResponse(null);
    let parsed: unknown;
    try {
      parsed = params.trim().length === 0 ? {} : JSON.parse(params);
    } catch (e) {
      setParamsErr((e as Error).message);
      setBusy(false);
      return;
    }
    // OB11 spec: echo lives in the frame, not in params. But our invokeAction
    // signature passes echo via the wire-params adapter, which doesn't carry
    // it for the in-process path. So we merge echo into params for visibility
    // (handlers ignore unknown fields). Wire is OK either way.
    if (echo) (parsed as Record<string, unknown>).echo = echo;
    let r: WireInvokeResponseDto;
    try {
      r = await api.invokeWire(action, parsed, protocol);
    } catch (e) {
      r = { ok: false, elapsedMs: 0, error: e instanceof Error ? e.message : String(e) };
    }
    setResponse(r);
    setBusy(false);
    setHistory((prev) => {
      const entry: HistoryEntry = {
        id: ++idRef.n,
        ts: Date.now(),
        action,
        protocol,
        params,
        echo,
        response: r,
      };
      const next = [entry, ...prev];
      return next.length > MAX_HISTORY ? next.slice(0, MAX_HISTORY) : next;
    });
  }

  function recall(h: HistoryEntry): void {
    setAction(h.action);
    setProtocol(h.protocol);
    setParams(h.params);
    setEcho(h.echo);
    setResponse(h.response);
    setParamsErr(null);
  }

  function copyAsCurl(): void {
    // Generate a curl that hits the OneBot HTTP port directly (port 5700 by
    // default; users editing this will know if they moved it). Keeps the
    // hands-on shape OneBot bot frameworks expect.
    const port = protocol === 'v11' ? 5700 : 5720;
    const body = (() => {
      try { return JSON.stringify(JSON.parse(params || '{}')); }
      catch { return params; }
    })();
    const escaped = body.replace(/'/g, "'\\''");
    const cmd = `curl -X POST 'http://127.0.0.1:${port}/${action}' -H 'content-type: application/json' --data '${escaped}'`;
    void navigator.clipboard.writeText(cmd).catch(() => {});
  }

  function clearHistory(): void {
    setHistory([]);
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* no-op */ }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: '260px 1fr', gap: 14, alignItems: 'start' }}>
      <div className="card" style={{ padding: 16, maxHeight: 'calc(100vh - 200px)', overflowY: 'auto' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
          <div style={{ color: 'var(--text-2)', fontSize: 13, textTransform: 'uppercase', letterSpacing: '0.06em', fontWeight: 500 }}>
            历史 ({history.length})
          </div>
          {history.length > 0 ? (
            <button onClick={clearHistory} className="text-btn" style={{ fontSize: 11, padding: '2px 6px' }}>清空</button>
          ) : null}
        </div>
        {history.length === 0 ? (
          <div style={{ color: 'var(--text-3)', fontSize: 12, padding: '12px 0', textAlign: 'center' }}>
            尚未发送任何请求
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            {history.map((h) => (
              <button
                key={h.id}
                onClick={() => recall(h)}
                style={historyRowStyle(h.response.ok)}
                title={`${h.action} · ${h.response.elapsedMs}ms`}
              >
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 12, color: 'var(--text)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {h.action}
                  </span>
                  <span style={{ fontSize: 10, color: h.response.ok ? 'var(--ok)' : 'var(--danger)' }}>
                    {h.response.elapsedMs}ms
                  </span>
                </div>
                <div style={{ fontSize: 10, color: 'var(--text-3)', marginTop: 2 }}>
                  {h.protocol} · {fmtRelative(h.ts)}
                </div>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
        <div>
          <div className="card-head" style={{ marginBottom: 10 }}>{I.api} OneBot Action</div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 120px 130px', gap: 10 }}>
            <div className="form-row">
              <div className="label">Action<span className="required">*</span></div>
              <input
                className="form-input"
                list="common-actions"
                value={action}
                onChange={(e) => pickAction(e.target.value)}
                placeholder="get_status"
                disabled={busy}
              />
              <datalist id="common-actions">
                {COMMON_ACTIONS.map((a) => <option key={a} value={a} />)}
              </datalist>
            </div>
            <div className="form-row select">
              <div className="label">协议</div>
              <select
                className="form-input"
                value={protocol}
                onChange={(e) => setProtocol(e.target.value as 'v11' | 'v12')}
                disabled={busy}
              >
                <option value="v11">OneBot 11</option>
                <option value="v12">OneBot 12</option>
              </select>
            </div>
            <div className="form-row">
              <div className="label">echo</div>
              <input
                className="form-input"
                value={echo}
                onChange={(e) => setEcho(e.target.value)}
                placeholder="optional"
                disabled={busy}
              />
            </div>
          </div>
        </div>

        <div>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
            <span style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500 }}>Params (JSON)</span>
            {paramsErr ? (
              <span style={{ fontSize: 11, color: 'var(--danger)', fontFamily: 'var(--font-mono)' }}>{paramsErr}</span>
            ) : null}
          </div>
          <textarea
            value={params}
            onChange={(e) => setParams(e.target.value)}
            disabled={busy}
            spellCheck={false}
            style={paramsTextareaStyle}
            placeholder={'{ }'}
          />
        </div>

        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <button className="btn primary" onClick={send} disabled={busy || action.trim().length === 0}>
            {busy ? '发送中…' : '发送'}
          </button>
          <button className="btn ghost" onClick={() => { setParams(ACTION_PRESETS[action] ?? '{}'); setParamsErr(null); }} disabled={busy}>
            重置 params
          </button>
          <button className="btn ghost" onClick={() => setResponse(null)} disabled={busy || !response}>
            清除响应
          </button>
          <button className="btn ghost" onClick={copyAsCurl} disabled={busy} title="拷贝当前请求为 curl 命令">
            复制 curl
          </button>
          <div style={{ flex: 1 }} />
          {response ? (
            <span style={{
              alignSelf: 'center',
              fontSize: 12,
              fontFamily: 'var(--font-mono)',
              color: response.ok ? 'var(--ok)' : 'var(--danger)',
            }}>
              {response.ok ? '✓' : '✗'} {response.elapsedMs}ms
            </span>
          ) : null}
        </div>

        <div>
          <div style={{ fontSize: 13, color: 'var(--text-2)', fontWeight: 500, marginBottom: 6 }}>Response</div>
          <pre style={responsePreStyle}>
            {response
              ? response.ok
                ? JSON.stringify(response.response, null, 2)
                : `// HTTP error\n${response.error ?? '(no body)'}`
              : '// 点击「发送」执行 action'}
          </pre>
        </div>
      </div>
    </div>
  );
}

function fmtRelative(ts: number): string {
  const s = Math.floor((Date.now() - ts) / 1000);
  if (s < 1) return '刚刚';
  if (s < 60) return `${s}s 前`;
  if (s < 3600) return `${Math.floor(s / 60)}m 前`;
  return `${Math.floor(s / 3600)}h 前`;
}

function historyRowStyle(ok: boolean): React.CSSProperties {
  return {
    width: '100%',
    textAlign: 'left',
    border: `1px solid ${ok ? 'var(--border)' : 'color-mix(in oklab, var(--danger) 30%, var(--border))'}`,
    background: ok ? 'var(--surface-2)' : 'color-mix(in oklab, var(--danger) 6%, var(--surface-2))',
    borderRadius: 8,
    padding: '6px 8px',
    cursor: 'pointer',
    fontFamily: 'inherit',
  };
}

const paramsTextareaStyle: React.CSSProperties = {
  width: '100%',
  minHeight: 160,
  border: '1px solid var(--border)',
  borderRadius: 10,
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontFamily: 'var(--font-mono)',
  fontSize: 13,
  padding: '10px 12px',
  outline: 'none',
  resize: 'vertical',
  boxSizing: 'border-box',
};

const responsePreStyle: React.CSSProperties = {
  margin: 0,
  fontFamily: 'var(--font-mono)',
  fontSize: 12.5,
  background: 'var(--bg)',
  border: '1px solid var(--border)',
  borderRadius: 10,
  padding: 14,
  color: 'var(--text)',
  minHeight: 140,
  maxHeight: 360,
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};
