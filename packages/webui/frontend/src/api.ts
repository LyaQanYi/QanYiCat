import type {
  ConfigMutationResultDto,
  CreateNetworkAdapterDto,
  ExportConfigResponseDto,
  InstanceStatusDto,
  LogsResponseDto,
  LoginResponseDto,
  MediaListResponseDto,
  NetworkAdapterDto,
  SanitizedConfigDto,
  UpdateOneBotConfigDto,
} from '../../shared/dto';

const TOKEN_KEY = 'qanyicat.token';
const EXPIRES_KEY = 'qanyicat.expiresAt';

export interface ApiClient {
  token: string | null;
  login(password: string): Promise<LoginResponseDto>;
  logout(): void;
  instance(): Promise<InstanceStatusDto>;
  config(): Promise<SanitizedConfigDto>;
  logs(since?: number): Promise<LogsResponseDto>;
  updateOneBot(patch: UpdateOneBotConfigDto): Promise<ConfigMutationResultDto>;
  createNetwork(entry: CreateNetworkAdapterDto): Promise<ConfigMutationResultDto>;
  updateNetwork(id: string, entry: NetworkAdapterDto): Promise<ConfigMutationResultDto>;
  deleteNetwork(id: string): Promise<ConfigMutationResultDto>;
  exportConfig(): Promise<ExportConfigResponseDto>;
  invokeWire(action: string, params: unknown, protocol?: 'v11' | 'v12'): Promise<WireInvokeResponseDto>;
  listMedia(): Promise<MediaListResponseDto>;
}

export interface WireInvokeResponseDto {
  ok: boolean;
  elapsedMs: number;
  response?: unknown;
  error?: string;
}

export function loadToken(): { token: string | null; expiresAt: number } {
  return {
    token: localStorage.getItem(TOKEN_KEY),
    expiresAt: Number(localStorage.getItem(EXPIRES_KEY) ?? '0'),
  };
}

export function createApiClient(): ApiClient {
  const stored = loadToken();
  let token = isExpired(stored.expiresAt) ? null : stored.token;

  async function request<T>(path: string, init?: RequestInit): Promise<T> {
    if (!token) throw new Error('not logged in');
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (init?.body && !(init.headers && (init.headers as Record<string, string>)['content-type'])) {
      headers['content-type'] = 'application/json';
    }
    const res = await fetch(path, { ...init, headers: { ...headers, ...(init?.headers ?? {}) } });
    if (res.status === 401) {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      throw new Error('session expired');
    }
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; detail?: string };
      throw new Error(`HTTP ${res.status}${body.error ? `: ${body.error}` : ''}${body.detail ? ` (${body.detail})` : ''}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    get token(): string | null {
      return token;
    },
    async login(password: string) {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `login failed: ${res.status}`);
      }
      const dto = (await res.json()) as LoginResponseDto;
      token = dto.token;
      localStorage.setItem(TOKEN_KEY, dto.token);
      localStorage.setItem(EXPIRES_KEY, String(dto.expiresAt));
      return dto;
    },
    logout() {
      token = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(EXPIRES_KEY);
    },
    instance() {
      return request<InstanceStatusDto>('/api/instance');
    },
    config() {
      return request<SanitizedConfigDto>('/api/config');
    },
    logs(since?: number) {
      const qs = since ? `?since=${since}` : '';
      return request<LogsResponseDto>(`/api/logs${qs}`);
    },
    updateOneBot(patch) {
      return request<ConfigMutationResultDto>('/api/config/onebot', {
        method: 'PUT',
        body: JSON.stringify(patch),
      });
    },
    createNetwork(entry) {
      return request<ConfigMutationResultDto>('/api/config/networks', {
        method: 'POST',
        body: JSON.stringify(entry),
      });
    },
    updateNetwork(id, entry) {
      return request<ConfigMutationResultDto>(`/api/config/networks/${encodeURIComponent(id)}`, {
        method: 'PUT',
        body: JSON.stringify(entry),
      });
    },
    deleteNetwork(id) {
      return request<ConfigMutationResultDto>(`/api/config/networks/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    exportConfig() {
      return request<ExportConfigResponseDto>('/api/config/export', {
        method: 'POST',
        body: '{}',
      });
    },
    listMedia() {
      return request<MediaListResponseDto>('/api/media');
    },
    async invokeWire(action, params, protocol) {
      const qs = protocol ? `?protocol=${protocol}` : '';
      // Don't use `request` here — the backend returns the response shape on
      // both 200 and 500 (with `ok: false` + `error`), and `request` would
      // throw the latter as a network error.
      if (!token) throw new Error('not logged in');
      const res = await fetch(`/api/wire/${encodeURIComponent(action)}${qs}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        body: JSON.stringify(params ?? {}),
      });
      if (res.status === 401) {
        token = null;
        localStorage.removeItem(TOKEN_KEY);
        throw new Error('session expired');
      }
      if (res.status === 503) {
        return { ok: false, elapsedMs: 0, error: 'wire invoke not available' } satisfies WireInvokeResponseDto;
      }
      return (await res.json()) as WireInvokeResponseDto;
    },
  };
}

function isExpired(expiresAt: number): boolean {
  return !expiresAt || expiresAt < Date.now();
}
