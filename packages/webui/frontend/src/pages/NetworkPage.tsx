import { useEffect, useMemo, useState } from 'react';
import { I } from '../icons';
import type { ApiClient } from '../api';
import type { NetworkAdapterDto, SanitizedConfigDto } from '../../../shared/dto';

interface Props {
  api: ApiClient;
  config: SanitizedConfigDto | null;
  onConfigChanged(next: SanitizedConfigDto): void;
}

/** All four backend adapter kinds, plus a fake SSE entry kept disabled because
 *  the backend doesn't ship that transport (the design includes it but the
 *  bridge would 400 on save). */
type Kind = NetworkAdapterDto['kind'];
const KIND_TABS: ReadonlyArray<{ id: 'all' | Kind; label: string }> = [
  { id: 'all',         label: '全部' },
  { id: 'http-server', label: 'HTTP 服务端' },
  { id: 'http-post',   label: 'HTTP 客户端' },
  { id: 'ws-server',   label: 'WS 服务端' },
  { id: 'ws-client',   label: 'WS 客户端' },
];

const KIND_LABEL: Record<Kind, string> = {
  'http-server': 'HTTP Server',
  'http-post':   'HTTP Client',
  'ws-server':   'Websocket Server',
  'ws-client':   'Websocket Client',
};

const MSG_FORMATS = [
  { value: 'array',  label: 'Array' },
  { value: 'string', label: 'String' },
] as const;

export default function NetworkPage({ api, config, onConfigChanged }: Props) {
  const [filter, setFilter] = useState<'all' | Kind>('all');
  const [editing, setEditing] = useState<NetworkAdapterDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const networks = config?.onebot.networks ?? [];
  const counts: Record<string, number> = useMemo(() => {
    const c: Record<string, number> = { all: networks.length };
    for (const t of KIND_TABS) if (t.id !== 'all') c[t.id] = networks.filter((n) => n.kind === t.id).length;
    return c;
  }, [networks]);

  const filtered = filter === 'all' ? networks : networks.filter((n) => n.kind === filter);

  async function run<T>(fn: () => Promise<T>, after: (v: T) => void): Promise<void> {
    setBusy(true);
    setErr(null);
    try { after(await fn()); }
    catch (e) { setErr(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }

  const remove = (id: string) => {
    if (!confirm(`删除 ${id}？`)) return;
    void run(() => api.deleteNetwork(id), (r) => onConfigChanged(r.config));
  };
  const startCreate = () => {
    setEditing(blankEntry(filter === 'all' ? 'ws-client' : filter));
  };
  const startEdit = (entry: NetworkAdapterDto) => setEditing({ ...entry });
  const save = async (draft: NetworkAdapterDto, isNew: boolean): Promise<void> => {
    await run(
      () => isNew ? api.createNetwork(draft) : api.updateNetwork(draft.id, draft),
      (r) => { onConfigChanged(r.config); setEditing(null); }
    );
  };

  return (
    <>
      <div className="page-toolbar">
        <button className="btn primary" onClick={startCreate} disabled={busy}>{I.plus} 新建</button>
        <button className="btn ghost" title="刷新" style={{ width: 38, padding: 0, justifyContent: 'center' }}
                onClick={() => void api.config().then((c) => onConfigChanged(c)).catch((e) => setErr((e as Error).message))}>
          {I.refresh}
        </button>
        {err ? <span style={{ color: 'var(--danger)', fontSize: 12, marginLeft: 8 }}>{err}</span> : null}
      </div>

      <div className="tabs">
        {KIND_TABS.map((t) => (
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

      <div className="net-grid">
        {filtered.length === 0 ? (
          <div className="empty">该分类下暂无配置 · 点击「新建」开始</div>
        ) : (
          filtered.map((entry) => (
            <NetCard
              key={entry.id}
              entry={entry}
              onEdit={() => startEdit(entry)}
              onDelete={() => remove(entry.id)}
            />
          ))
        )}
      </div>

      {editing && (
        <NetEditModal
          draft={editing}
          isNew={!networks.some((n) => n.id === editing.id)}
          busy={busy}
          onClose={() => setEditing(null)}
          onSave={(next, isNew) => { void save(next, isNew); }}
        />
      )}
    </>
  );
}

function NetCard({
  entry,
  onEdit,
  onDelete,
}: {
  entry: NetworkAdapterDto;
  onEdit(): void;
  onDelete(): void;
}) {
  const isUrlBased = entry.kind === 'ws-client' || entry.kind === 'http-post';
  // `on` is informational only — every persisted entry is live; we render
  // the switch as a visual cue + edit-shortcut. Toggling routes through the
  // edit modal so adapter restart is intentional.
  const on = true;
  return (
    <div className="net-card" data-on={on}>
      <div className="net-head">
        <div className="net-title">
          {entry.id}
          <span className="net-kind">{KIND_LABEL[entry.kind]} · {entry.protocol}</span>
        </div>
        <button className="switch" data-on={on} onClick={onEdit} title="编辑以更改启用状态" />
      </div>
      <div className="net-fields">
        {isUrlBased ? (
          <div className="net-field wide">
            <div className="k">URL</div>
            <div className="v" title={entry.url ?? ''}>{entry.url ?? '—'}</div>
          </div>
        ) : (
          <>
            <div className="net-field">
              <div className="k">主机</div>
              <div className="v">{entry.host ?? '—'}</div>
            </div>
            <div className="net-field">
              <div className="k">端口</div>
              <div className="v">{entry.port ?? '—'}</div>
            </div>
            {entry.heartInterval != null && (
              <div className="net-field">
                <div className="k">心跳</div>
                <div className="v">{entry.heartInterval}<span style={{ color: 'var(--text-3)', marginLeft: 2 }}>ms</span></div>
              </div>
            )}
          </>
        )}
      </div>
      <div className="net-actions">
        <button className="btn ghost" onClick={onEdit}>{I.edit} 编辑</button>
        <button className="btn ghost danger" onClick={onDelete}>{I.trash} 删除</button>
      </div>
    </div>
  );
}

function blankEntry(kind: Kind): NetworkAdapterDto {
  const base = {
    id: '',
    kind,
    protocol: 'v11' as const,
    messagePostFormat: 'array' as const,
    reportSelfMessage: false,
    heartInterval: 30000,
    debug: false,
  };
  if (kind === 'ws-server' || kind === 'http-server') {
    return { ...base, host: '127.0.0.1', port: 5710 };
  }
  return { ...base, url: kind === 'ws-client' ? 'ws://127.0.0.1:8080/ws' : 'http://127.0.0.1:8080/onebot', reconnectIntervalMs: 5000, timeoutMs: 5000 };
}

function NetEditModal({
  draft: initial,
  isNew,
  busy,
  onClose,
  onSave,
}: {
  draft: NetworkAdapterDto;
  isNew: boolean;
  busy: boolean;
  onClose(): void;
  onSave(next: NetworkAdapterDto, isNew: boolean): void;
}) {
  const [draft, setDraft] = useState<NetworkAdapterDto>(initial);
  const set = <K extends keyof NetworkAdapterDto>(k: K, v: NetworkAdapterDto[K]): void =>
    setDraft((d) => ({ ...d, [k]: v }));

  // Lock body scroll + ESC closes
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { document.body.style.overflow = prev; window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  const isClient = draft.kind === 'ws-client' || draft.kind === 'http-post';
  const isWs = draft.kind === 'ws-client' || draft.kind === 'ws-server';

  return (
    <div className="modal-scrim" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="modal-head">
          <div className="modal-title">{KIND_LABEL[draft.kind]}</div>
          <button className="modal-close" onClick={onClose} aria-label="关闭">{I.close}</button>
        </div>

        <div className="modal-body">
          <div className="form-row toggle">
            <div className="text">
              <div className="label">上报自身消息</div>
              <div className="desc">是否上报 Bot 自身消息（reportSelfMessage）</div>
            </div>
            <button className="switch" data-on={draft.reportSelfMessage ?? false}
                    onClick={() => set('reportSelfMessage', !(draft.reportSelfMessage ?? false))} />
          </div>
          <div className="form-row toggle">
            <div className="text">
              <div className="label">开启 Debug</div>
              <div className="desc">debug=true 时 adapter 走 verbose 路径</div>
            </div>
            <button className="switch" data-on={draft.debug ?? false}
                    onClick={() => set('debug', !(draft.debug ?? false))} />
          </div>

          <div className="form-row full">
            <div className="label">ID<span className="required">*</span></div>
            <input className="form-input" value={draft.id} disabled={!isNew}
                   placeholder={isNew ? '留空将自动生成' : ''}
                   onChange={(e) => set('id', e.target.value)} />
          </div>

          <div className="form-row select full">
            <div className="label">类型<span className="required">*</span></div>
            <select className="form-input" value={draft.kind} disabled={!isNew}
                    onChange={(e) => set('kind', e.target.value as Kind)}>
              <option value="ws-client">Websocket 客户端</option>
              <option value="ws-server">Websocket 服务端</option>
              <option value="http-post">HTTP 客户端 (post)</option>
              <option value="http-server">HTTP 服务端</option>
            </select>
          </div>

          <div className="form-row select">
            <div className="label">协议</div>
            <select className="form-input" value={draft.protocol}
                    onChange={(e) => set('protocol', e.target.value as 'v11' | 'v12')}>
              <option value="v11">OneBot 11</option>
              <option value="v12">OneBot 12</option>
            </select>
          </div>

          {isClient ? (
            <div className="form-row full">
              <div className="label">URL<span className="required">*</span></div>
              <input className="form-input" value={draft.url ?? ''}
                     onChange={(e) => set('url', e.target.value)}
                     placeholder={draft.kind === 'ws-client' ? 'ws://localhost:6199/ws' : 'http://hook.local/qq'} />
            </div>
          ) : (
            <>
              <div className="form-row">
                <div className="label">主机<span className="required">*</span></div>
                <input className="form-input" value={draft.host ?? ''}
                       onChange={(e) => set('host', e.target.value)} placeholder="127.0.0.1" />
              </div>
              <div className="form-row">
                <div className="label">端口<span className="required">*</span></div>
                <input className="form-input" type="number" value={draft.port ?? 0}
                       onChange={(e) => set('port', Number(e.target.value))} />
              </div>
            </>
          )}

          {isWs && (
            <div className="form-row select">
              <div className="label">消息格式</div>
              <select className="form-input" value={draft.messagePostFormat ?? 'array'}
                      onChange={(e) => set('messagePostFormat', e.target.value as 'array' | 'string')}>
                {MSG_FORMATS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
          )}

          {draft.kind !== 'http-post' ? (
            <div className="form-row full">
              <div className="label">Access Token</div>
              <input className="form-input" value={draft.accessToken ?? ''}
                     placeholder="留空表示无鉴权"
                     onChange={(e) => set('accessToken', e.target.value || undefined)} />
            </div>
          ) : (
            <div className="form-row full">
              <div className="label">HMAC Secret</div>
              <input className="form-input" value={draft.secret ?? ''}
                     placeholder="留空表示不签名"
                     onChange={(e) => set('secret', e.target.value || undefined)} />
            </div>
          )}

          <div className="form-row">
            <div className="label">心跳间隔 (ms)</div>
            <input className="form-input" type="number" value={draft.heartInterval ?? 30000}
                   onChange={(e) => set('heartInterval', Number(e.target.value))} />
          </div>

          {draft.kind === 'ws-client' ? (
            <div className="form-row">
              <div className="label">重连间隔 (ms)<span className="required">*</span></div>
              <input className="form-input" type="number" value={draft.reconnectIntervalMs ?? 5000}
                     onChange={(e) => set('reconnectIntervalMs', Number(e.target.value))} />
            </div>
          ) : draft.kind === 'http-post' ? (
            <div className="form-row">
              <div className="label">超时 (ms)<span className="required">*</span></div>
              <input className="form-input" type="number" value={draft.timeoutMs ?? 5000}
                     onChange={(e) => set('timeoutMs', Number(e.target.value))} />
            </div>
          ) : null}
        </div>

        <div className="modal-foot">
          <button className="text-btn" onClick={onClose}>关闭</button>
          <button className="btn primary" disabled={busy} onClick={() => onSave(draft, isNew)}>
            {busy ? '保存中…' : '保存'}
          </button>
        </div>
      </div>
    </div>
  );
}
