/** DTO contract shared between WebUI frontend and backend over HTTP/WS. */
export interface InstanceStatusDto {
  uin: string;
  online: boolean;
  selfNick: string;
  qqVersion: string;
  uptimeSec: number;
  startedAt: number;
}

/**
 * Full editable adapter entry. Mirrors `NetworkConfigEntry` from
 * `@qanyicat/core` but flat (no Typebox tagged-union — frontend just discriminates
 * on `kind`). Fields are sent + accepted plaintext; the WebUI is JWT-protected
 * and intended for the logged-in operator's own dashboard.
 */
export interface NetworkAdapterDto {
  id: string;
  kind: 'ws-server' | 'ws-client' | 'http-server' | 'http-post';
  protocol: 'v11' | 'v12';
  host?: string;
  port?: number;
  path?: string;
  url?: string;
  accessToken?: string;
  secret?: string;
  reconnectIntervalMs?: number;
  timeoutMs?: number;
  // Per-adapter knobs (v0.4p).
  messagePostFormat?: 'array' | 'string';
  reportSelfMessage?: boolean;
  heartInterval?: number;
  debug?: boolean;
}

export interface SanitizedConfigDto {
  log: { level: 'debug' | 'info' | 'warn' | 'error'; toFile: boolean };
  onebot: {
    enable11: boolean;
    enable12: boolean;
    /** Booleans only — never the actual token value. (kept for backwards compat) */
    accessTokenSet: boolean;
    /** Global access token in plaintext; null when unset. */
    accessToken: string | null;
    networks: NetworkAdapterDto[];
  };
  webui: { enable: boolean; port: number };
}

/** Body for PUT /api/config/onebot (atomic replace of the onebot block). */
export interface UpdateOneBotConfigDto {
  enable11?: boolean;
  enable12?: boolean;
  accessToken?: string | null;
  networks?: NetworkAdapterDto[];
}

/** Body for POST /api/config/networks. `id` may be omitted (auto-generated). */
export interface CreateNetworkAdapterDto extends Omit<NetworkAdapterDto, 'id'> {
  id?: string;
}

/** Response for POST /api/config/export. */
export interface ExportConfigResponseDto {
  path: string;
  bytes: number;
}

/** Generic mutation response. */
export interface ConfigMutationResultDto {
  ok: true;
  config: SanitizedConfigDto;
}

/**
 * GET /api/health — public endpoint (no JWT). Suitable for docker
 * healthcheck / external monitor pings. Returns only operational signals,
 * never tokens or network config.
 */
export interface HealthResponseDto {
  status: 'ok' | 'starting' | 'degraded';
  uin: string;
  online: boolean;
  uptimeSec: number;
  qqVersion: string;
  startedAt: number;
}

export interface MediaEntryDto {
  /** Wire identifiers — first one is the primary; copy any of them. */
  keys: string[];
  /** 2=PIC, 3=FILE, 4=PTT (voice), 5=VIDEO. */
  elementType: number;
  fileName?: string;
  fileSize?: number;
  /** NT-local path the bridge can serve from. Absent when not yet downloaded. */
  localCachePath?: string;
  peer: {
    chatType: 'private' | 'group';
    peerUid: string;
    /** Numeric group code for group chats; absent for private. */
    groupCode?: string;
    /** Numeric uin for private peers when the cache knows it. */
    peerUin?: string;
  };
  msgId: string;
  elementId: string;
}

export interface MediaListResponseDto {
  entries: MediaEntryDto[];
}

export interface LogLineDto {
  level: 'debug' | 'info' | 'warn' | 'error';
  timestamp: number;
  label: string;
  message: string;
}

export interface LogsResponseDto {
  lines: LogLineDto[];
  /** Server-side monotonic counter for "have I seen everything?" checks. */
  totalSeen: number;
}

export interface LoginRequestDto {
  password: string;
}

export interface LoginResponseDto {
  token: string;
  expiresAt: number;
}
