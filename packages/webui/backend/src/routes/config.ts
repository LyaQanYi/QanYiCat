import type { Hono } from 'hono';
import { writeFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';
import type { NetworkConfigEntry, QanYiCatConfig } from '@qanyicat/core';
import type { WebUIServerOptions } from '../server.js';
import type {
  ConfigMutationResultDto,
  CreateNetworkAdapterDto,
  ExportConfigResponseDto,
  NetworkAdapterDto,
  SanitizedConfigDto,
  UpdateOneBotConfigDto,
} from '../../../shared/dto.js';

export function mountConfigRoutes(app: Hono, opts: WebUIServerOptions): void {
  app.get('/config', (c) => c.json(toSanitizedDto(opts.config)));

  app.put('/config/onebot', async (c) => {
    let body: UpdateOneBotConfigDto;
    try {
      body = (await c.req.json()) as UpdateOneBotConfigDto;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const next = mergeOneBotConfig(opts.config.onebot, body);
    const validation = validateOneBot(next);
    if (validation) return c.json({ error: 'validation_failed', detail: validation }, 400);
    return applyAndRespond(c, opts, next);
  });

  app.post('/config/networks', async (c) => {
    let body: CreateNetworkAdapterDto;
    try {
      body = (await c.req.json()) as CreateNetworkAdapterDto;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const id = body.id ?? generateNetworkId(body.kind, opts.config.onebot.networks);
    if (opts.config.onebot.networks.some((n) => n.id === id)) {
      return c.json({ error: 'duplicate_id', id }, 409);
    }
    const entry = dtoToEntry({ ...body, id });
    const validation = validateEntry(entry);
    if (validation) return c.json({ error: 'validation_failed', detail: validation }, 400);
    const next: QanYiCatConfig['onebot'] = {
      ...opts.config.onebot,
      networks: [...opts.config.onebot.networks, entry],
    };
    return applyAndRespond(c, opts, next);
  });

  app.put('/config/networks/:id', async (c) => {
    const id = c.req.param('id');
    let body: NetworkAdapterDto;
    try {
      body = (await c.req.json()) as NetworkAdapterDto;
    } catch {
      return c.json({ error: 'invalid_json' }, 400);
    }
    const idx = opts.config.onebot.networks.findIndex((n) => n.id === id);
    if (idx === -1) return c.json({ error: 'not_found', id }, 404);
    const entry = dtoToEntry({ ...body, id });
    const validation = validateEntry(entry);
    if (validation) return c.json({ error: 'validation_failed', detail: validation }, 400);
    const networks = [...opts.config.onebot.networks];
    networks[idx] = entry;
    return applyAndRespond(c, opts, { ...opts.config.onebot, networks });
  });

  app.delete('/config/networks/:id', async (c) => {
    const id = c.req.param('id');
    const idx = opts.config.onebot.networks.findIndex((n) => n.id === id);
    if (idx === -1) return c.json({ error: 'not_found', id }, 404);
    const networks = opts.config.onebot.networks.filter((n) => n.id !== id);
    return applyAndRespond(c, opts, { ...opts.config.onebot, networks });
  });

  app.post('/config/export', (c) => {
    const target = resolvePath(opts.exportPath ?? 'qanyicat.config.json');
    const json = JSON.stringify(opts.config, null, 2);
    try {
      writeFileSync(target, json, 'utf8');
    } catch (e) {
      return c.json({ error: 'write_failed', detail: (e as Error).message }, 500);
    }
    const resp: ExportConfigResponseDto = { path: target, bytes: Buffer.byteLength(json, 'utf8') };
    return c.json(resp);
  });
}

function mergeOneBotConfig(
  current: QanYiCatConfig['onebot'],
  patch: UpdateOneBotConfigDto
): QanYiCatConfig['onebot'] {
  const merged: QanYiCatConfig['onebot'] = {
    enable11: patch.enable11 ?? current.enable11,
    enable12: patch.enable12 ?? current.enable12,
    networks: patch.networks
      ? patch.networks.map((dto) => dtoToEntry(dto))
      : current.networks,
  };
  if (patch.accessToken === null) {
    // explicit clear
  } else if (typeof patch.accessToken === 'string') {
    merged.accessToken = patch.accessToken;
  } else if (typeof current.accessToken === 'string') {
    merged.accessToken = current.accessToken;
  }
  return merged;
}

/**
 * Translate the flat WebUI DTO into a discriminated union NetworkConfigEntry.
 * Drops fields irrelevant to each kind so the Typebox validator at the bridge
 * boundary doesn't complain.
 */
function dtoToEntry(dto: NetworkAdapterDto): NetworkConfigEntry {
  const common = {
    id: dto.id,
    protocol: dto.protocol,
    ...(dto.accessToken !== undefined ? { accessToken: dto.accessToken } : {}),
    ...(dto.messagePostFormat !== undefined ? { messagePostFormat: dto.messagePostFormat } : {}),
    ...(dto.reportSelfMessage !== undefined ? { reportSelfMessage: dto.reportSelfMessage } : {}),
    ...(dto.heartInterval !== undefined ? { heartInterval: dto.heartInterval } : {}),
    ...(dto.debug !== undefined ? { debug: dto.debug } : {}),
  };
  switch (dto.kind) {
    case 'ws-server':
      return {
        kind: 'ws-server',
        ...common,
        host: dto.host ?? '127.0.0.1',
        port: dto.port ?? 0,
        ...(dto.path !== undefined ? { path: dto.path } : {}),
      } as NetworkConfigEntry;
    case 'ws-client':
      return {
        kind: 'ws-client',
        ...common,
        url: dto.url ?? '',
        reconnectIntervalMs: dto.reconnectIntervalMs ?? 5000,
      } as NetworkConfigEntry;
    case 'http-server':
      return {
        kind: 'http-server',
        ...common,
        host: dto.host ?? '127.0.0.1',
        port: dto.port ?? 0,
      } as NetworkConfigEntry;
    case 'http-post':
      // http-post doesn't have accessToken in the schema; it uses `secret` for HMAC.
      return {
        kind: 'http-post',
        id: dto.id,
        protocol: dto.protocol,
        url: dto.url ?? '',
        timeoutMs: dto.timeoutMs ?? 5000,
        ...(dto.secret !== undefined ? { secret: dto.secret } : {}),
        ...(dto.messagePostFormat !== undefined ? { messagePostFormat: dto.messagePostFormat } : {}),
        ...(dto.reportSelfMessage !== undefined ? { reportSelfMessage: dto.reportSelfMessage } : {}),
        ...(dto.heartInterval !== undefined ? { heartInterval: dto.heartInterval } : {}),
        ...(dto.debug !== undefined ? { debug: dto.debug } : {}),
      } as NetworkConfigEntry;
  }
}

function entryToDto(entry: NetworkConfigEntry): NetworkAdapterDto {
  const base: NetworkAdapterDto = {
    id: entry.id,
    kind: entry.kind,
    protocol: entry.protocol,
  };
  if ('host' in entry) base.host = entry.host;
  if ('port' in entry) base.port = entry.port;
  if ('path' in entry && entry.path !== undefined) base.path = entry.path;
  if ('url' in entry) base.url = entry.url;
  if ('accessToken' in entry && entry.accessToken !== undefined) base.accessToken = entry.accessToken;
  if ('secret' in entry && entry.secret !== undefined) base.secret = entry.secret;
  if ('reconnectIntervalMs' in entry) base.reconnectIntervalMs = entry.reconnectIntervalMs;
  if ('timeoutMs' in entry) base.timeoutMs = entry.timeoutMs;
  if ('messagePostFormat' in entry && entry.messagePostFormat !== undefined) base.messagePostFormat = entry.messagePostFormat;
  if ('reportSelfMessage' in entry && entry.reportSelfMessage !== undefined) base.reportSelfMessage = entry.reportSelfMessage;
  if ('heartInterval' in entry && entry.heartInterval !== undefined) base.heartInterval = entry.heartInterval;
  if ('debug' in entry && entry.debug !== undefined) base.debug = entry.debug;
  return base;
}

function toSanitizedDto(cfg: QanYiCatConfig): SanitizedConfigDto {
  return {
    log: { level: cfg.log.level, toFile: cfg.log.toFile },
    onebot: {
      enable11: cfg.onebot.enable11,
      enable12: cfg.onebot.enable12,
      accessTokenSet: typeof cfg.onebot.accessToken === 'string' && cfg.onebot.accessToken.length > 0,
      accessToken: typeof cfg.onebot.accessToken === 'string' ? cfg.onebot.accessToken : null,
      networks: cfg.onebot.networks.map((n) => entryToDto(n)),
    },
    webui: { enable: cfg.webui?.enable ?? false, port: cfg.webui?.port ?? 0 },
  };
}

function validateEntry(entry: NetworkConfigEntry): string | null {
  if (!entry.id || typeof entry.id !== 'string') return 'id required';
  if (!['v11', 'v12'].includes(entry.protocol)) return 'protocol must be v11 or v12';
  switch (entry.kind) {
    case 'ws-server':
    case 'http-server':
      if (typeof entry.port !== 'number' || entry.port < 1 || entry.port > 65535) return 'port out of range';
      if (typeof entry.host !== 'string' || !entry.host) return 'host required';
      return null;
    case 'ws-client':
    case 'http-post':
      if (!entry.url || typeof entry.url !== 'string') return 'url required';
      return null;
  }
}

function validateOneBot(next: QanYiCatConfig['onebot']): string | null {
  if (typeof next.enable11 !== 'boolean') return 'enable11 must be boolean';
  if (typeof next.enable12 !== 'boolean') return 'enable12 must be boolean';
  for (const entry of next.networks) {
    const err = validateEntry(entry);
    if (err) return `network ${entry.id ?? '<no-id>'}: ${err}`;
  }
  const ids = new Set<string>();
  for (const entry of next.networks) {
    if (ids.has(entry.id)) return `duplicate id ${entry.id}`;
    ids.add(entry.id);
  }
  return null;
}

function generateNetworkId(kind: string, existing: ReadonlyArray<{ id: string }>): string {
  for (let i = 1; ; i++) {
    const candidate = `${kind}-${i}`;
    if (!existing.some((n) => n.id === candidate)) return candidate;
  }
}

async function applyAndRespond(
  c: import('hono').Context,
  opts: WebUIServerOptions,
  nextOnebot: QanYiCatConfig['onebot']
): Promise<Response> {
  // Mutate in place so other route handlers (which captured `opts.config`)
  // see the new state immediately. The bridge keeps the same object too.
  opts.config.onebot = nextOnebot;
  if (opts.onConfigUpdate) {
    try {
      await opts.onConfigUpdate(nextOnebot);
    } catch (e) {
      return c.json({ error: 'reload_failed', detail: (e as Error).message }, 500);
    }
  }
  const resp: ConfigMutationResultDto = { ok: true, config: toSanitizedDto(opts.config) };
  return c.json(resp);
}
