import type { InstanceContext } from '@qanyicat/core';
import type { UnifiedEvent } from '@qanyicat/protocol';
import type { NetworkAdapter } from '../network/network-adapter';
import { ActionDispatcher } from '../dispatch/action-dispatcher';
import { OB12EventConverter, type OB12Event } from '../converters/ob12/event';
import { ob12ParamsToUnified } from '../converters/ob12/wire-params';
import type { ProtocolAdapter } from './ob11-adapter';

interface OB12Frame {
  /** OB12 uses `action`, optionally namespaced like `qq.send_message`. */
  action: string;
  params?: unknown;
  /** UUID-style echo per spec; falls back to OB11-style string if present. */
  echo?: string;
}

export class OneBot12Adapter implements ProtocolAdapter {
  readonly version = 'v12' as const;
  private dispatcher: ActionDispatcher | null = null;
  private ctx: InstanceContext | null = null;
  private transports: NetworkAdapter[] = [];
  private converter: OB12EventConverter | null = null;
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();

  async start(ctx: InstanceContext, transports: NetworkAdapter[]): Promise<void> {
    this.ctx = ctx;
    this.dispatcher = new ActionDispatcher(ctx);
    this.converter = new OB12EventConverter(ctx.uin);
    this.transports = transports;
    for (const t of transports) {
      await t.start({
        onAction: (raw, ack) => {
          void this.handleWireAction(raw, t).then((resp) => ack(resp));
        },
      });
    }
    this.emitLifecycleConnect();
    for (const t of transports) this.startHeartbeatFor(t);
  }

  async stop(): Promise<void> {
    for (const timer of this.heartbeatTimers.values()) clearInterval(timer);
    this.heartbeatTimers.clear();
    for (const t of this.transports) await t.stop();
    this.transports = [];
    this.dispatcher = null;
    this.ctx = null;
    this.converter = null;
  }

  onUnifiedEvent(event: UnifiedEvent): void {
    const wire = this.converter?.fromUnified(event);
    if (!wire) return;
    this.broadcast(wire);
  }

  async handleWireAction(raw: unknown, _transport: NetworkAdapter): Promise<unknown> {
    const frame = raw as OB12Frame;
    return this.invokeAction(frame.action, frame.params, frame.echo);
  }

  async invokeAction(action: string, params: unknown, echo?: string): Promise<unknown> {
    if (!this.dispatcher || !this.ctx) throw new Error('[OB12] adapter not started');
    // OB12 namespaces (`qq.send_message`) strip down to the bare action name
    // for our unified registry — same dispatch table as OB11.
    const bareAction = action.includes('.') ? action.split('.').pop()! : action;
    const ctx = this.ctx;
    const resolver = async (uin: string) => {
      const uid = await ctx.apis.user.uinToUid(uin);
      if (!uid) return null;
      try {
        const profile = await ctx.apis.user.getProfile(uid);
        return profile.nick ? { uid, nick: profile.nick } : { uid };
      } catch {
        return { uid };
      }
    };
    const unifiedParams = await ob12ParamsToUnified(bareAction, params, resolver);
    return this.dispatcher.invoke(bareAction, unifiedParams, echo);
  }

  private emitLifecycleConnect(): void {
    const event = this.converter?.fromUnified({ kind: 'meta', sub: 'lifecycle.connect' });
    if (event) this.broadcast(event);
  }

  private startHeartbeatFor(transport: NetworkAdapter): void {
    const interval = transport.options.heartInterval;
    if (interval <= 0) return;
    const timer = setInterval(() => {
      const event = this.converter?.buildHeartbeat(interval);
      if (event) transport.push(event);
    }, interval);
    this.heartbeatTimers.set(transport.id, timer);
  }

  private broadcast(event: OB12Event): void {
    const selfId = this.ctx?.uin;
    for (const t of this.transports) {
      // OB12 has no `message_sent` post_type, but the converter emits `type:
      // 'message'` for self-sent too (sender uin === selfId). Filter on uid/uin
      // equality when reportSelfMessage is off.
      if (
        !t.options.reportSelfMessage &&
        event.type === 'message' &&
        selfId !== undefined &&
        (event as { user_id?: string }).user_id === selfId
      ) {
        continue;
      }
      t.push(event);
    }
  }
}
