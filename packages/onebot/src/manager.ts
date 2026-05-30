import type {
  InstanceContext,
  NetworkConfigEntry,
  ProtocolVersion,
  QanYiCatConfig,
} from '@qanyicat/core';
import { CoreToUnified } from '@qanyicat/protocol';
import type { NetworkAdapter } from './network/network-adapter';
import { WsServerAdapter } from './network/ws-server';
import { WsClientAdapter } from './network/ws-client';
import { HttpServerAdapter } from './network/http-server';
import { HttpPostAdapter } from './network/http-post';
import { OneBot11Adapter, type ProtocolAdapter } from './adapters/ob11-adapter';
import { OneBot12Adapter } from './adapters/ob12-adapter';

/** NT event kinds that flow into the OneBot adapters via CoreToUnified.event. */
const FORWARDED_EVENT_KINDS = [
  'msg.recv',
  'msg.recall',
  'group.member-change',
  'group.admin-change',
  'group.request',
  'friend.request',
  'login.success',
] as const;

/**
 * Wires NT event bus → protocol normalization → enabled OB adapters →
 * configured network channels. Each network entry carries a `protocol` tag
 * (v11 / v12) so the same port never gets bound by two adapters — the manager
 * routes each transport to exactly one adapter.
 */
export class OneBotManager {
  private readonly perVersion = new Map<ProtocolVersion, { adapter: ProtocolAdapter; transports: NetworkAdapter[] }>();
  private subscriptions: Array<{ dispose(): void }> = [];

  constructor(
    private readonly ctx: InstanceContext,
    private readonly cfg: QanYiCatConfig['onebot']
  ) {}

  async start(): Promise<void> {
    const byVersion = new Map<ProtocolVersion, NetworkAdapter[]>();
    for (const entry of this.cfg.networks) {
      const version: ProtocolVersion = entry.protocol ?? 'v11';
      let list = byVersion.get(version);
      if (!list) {
        list = [];
        byVersion.set(version, list);
      }
      list.push(buildNetwork(entry));
    }
    if (this.cfg.enable11) {
      const transports = byVersion.get('v11') ?? [];
      const adapter = new OneBot11Adapter();
      await adapter.start(this.ctx, transports);
      this.perVersion.set('v11', { adapter, transports });
      this.ctx.logger.info(`OB11 started with ${transports.length} transport(s)`);
    }
    if (this.cfg.enable12) {
      const transports = byVersion.get('v12') ?? [];
      const adapter = new OneBot12Adapter();
      await adapter.start(this.ctx, transports);
      this.perVersion.set('v12', { adapter, transports });
      this.ctx.logger.info(`OB12 started with ${transports.length} transport(s)`);
    }

    for (const kind of FORWARDED_EVENT_KINDS) {
      const sub = this.ctx.events.on(kind, (payload) => {
        const events = CoreToUnified.event(kind, payload, this.ctx);
        for (const e of events) {
          for (const slot of this.perVersion.values()) slot.adapter.onUnifiedEvent(e);
        }
      });
      this.subscriptions.push(sub);
    }
  }

  async stop(): Promise<void> {
    for (const sub of this.subscriptions) sub.dispose();
    this.subscriptions = [];
    for (const slot of this.perVersion.values()) await slot.adapter.stop();
    this.perVersion.clear();
  }

  /**
   * Invoke an action through the in-process pipeline (wire-params adapter →
   * dispatcher) without going through HTTP/WS. Used by the WebUI "接口调试"
   * page so the operator can poke the live wire without juggling tokens or
   * port numbers. Defaults to OB11; pass `version` to target OB12 explicitly.
   */
  async invokeAction(
    action: string,
    params: unknown,
    version: ProtocolVersion = 'v11'
  ): Promise<unknown> {
    const slot = this.perVersion.get(version);
    if (!slot) throw new Error(`OneBot ${version} adapter is not enabled`);
    return slot.adapter.invokeAction(action, params);
  }
}

function buildNetwork(entry: NetworkConfigEntry): NetworkAdapter {
  switch (entry.kind) {
    case 'ws-server':
      return new WsServerAdapter(entry);
    case 'ws-client':
      return new WsClientAdapter(entry);
    case 'http-server':
      return new HttpServerAdapter(entry);
    case 'http-post':
      return new HttpPostAdapter(entry);
    default: {
      const exhaustive: never = entry;
      throw new Error(`unknown network kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}
