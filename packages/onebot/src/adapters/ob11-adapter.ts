import type { InstanceContext } from '@qanyicat/core';
import type { UnifiedEvent } from '@qanyicat/protocol';
import type { NetworkAdapter } from '../network/network-adapter';
import { ActionDispatcher } from '../dispatch/action-dispatcher';
import { ob11ToUnified } from '../dispatch/action-routing';
import { OB11EventConverter, type OB11Event, type OB11MessageEvent } from '../converters/ob11/event';
import { ob11ParamsToUnified } from '../converters/ob11/wire-params';

export interface ProtocolAdapter {
  readonly version: 'v11' | 'v12';
  start(ctx: InstanceContext, transports: NetworkAdapter[]): Promise<void>;
  stop(): Promise<void>;
  onUnifiedEvent(event: UnifiedEvent): void;
  handleWireAction(raw: unknown, transport: NetworkAdapter): Promise<unknown>;
  /**
   * Same code path as `handleWireAction` but without a transport — used by
   * the WebUI's "接口调试" page to send actions through the real wire-params
   * translator + dispatcher pipeline without needing a TCP roundtrip.
   */
  invokeAction(action: string, params: unknown, echo?: string): Promise<unknown>;
}

interface OB11Frame {
  action: string;
  params?: unknown;
  echo?: string;
}

export class OneBot11Adapter implements ProtocolAdapter {
  readonly version = 'v11' as const;
  private dispatcher: ActionDispatcher | null = null;
  private ctx: InstanceContext | null = null;
  private transports: NetworkAdapter[] = [];
  private converter: OB11EventConverter | null = null;
  private heartbeatTimers = new Map<string, NodeJS.Timeout>();

  async start(ctx: InstanceContext, transports: NetworkAdapter[]): Promise<void> {
    this.ctx = ctx;
    this.dispatcher = new ActionDispatcher(ctx);
    this.converter = new OB11EventConverter(ctx.uin);
    this.transports = transports;
    for (const t of transports) {
      await t.start({
        onAction: (raw, ack) => {
          void this.handleWireAction(raw, t).then((resp) => ack(resp));
        },
      });
    }
    this.emitLifecycleConnect();
    for (const t of transports) this.startHeartbeatFor(t, ctx);
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
    const frame = raw as OB11Frame;
    return this.invokeAction(frame.action, frame.params, frame.echo);
  }

  async invokeAction(action: string, params: unknown, echo?: string): Promise<unknown> {
    if (!this.dispatcher || !this.ctx) throw new Error('[OB11] adapter not started');
    const unifiedName = ob11ToUnified(action);
    const ctx = this.ctx;
    const resolver = async (uin: string) => {
      const uid = await ctx.apis.user.uinToUid(uin);
      if (!uid) return null;
      // Best-effort nickname for `@<nick>` rendering. ctx.apis.user.getProfile
      // returns `{uid, uin, nick}` — nick may be '' if not cached.
      try {
        const profile = await ctx.apis.user.getProfile(uid);
        return profile.nick ? { uid, nick: profile.nick } : { uid };
      } catch {
        return { uid };
      }
    };
    const unifiedParams = await ob11ParamsToUnified(action, params, resolver);
    return this.dispatcher.invoke(unifiedName, unifiedParams, echo);
  }

  private emitLifecycleConnect(): void {
    const event = this.converter?.fromUnified({ kind: 'meta', sub: 'lifecycle.connect' });
    if (event) this.broadcast(event);
  }

  private startHeartbeatFor(transport: NetworkAdapter, ctx: InstanceContext): void {
    const interval = transport.options.heartInterval;
    if (interval <= 0) return;
    const timer = setInterval(() => {
      const event = this.converter?.buildHeartbeat(interval, ctx.selfInfo.online);
      if (event) transport.push(event);
    }, interval);
    this.heartbeatTimers.set(transport.id, timer);
  }

  private broadcast(event: OB11Event): void {
    for (const t of this.transports) {
      const tailored = tailorForTransport(event, t.options);
      if (!tailored) continue;
      t.push(tailored);
    }
  }
}

/**
 * Apply per-transport knobs to a wire-ready event. Returns `null` when the
 * event is gated (e.g. `message_sent` with `reportSelfMessage: false`).
 *
 * For OB11 `message_sent` / `message`, also converts `message_format: 'array'`
 * → `'string'` (with `message` becoming the CQ-coded `raw_message`) when the
 * transport opted into string format.
 */
function tailorForTransport(
  event: OB11Event,
  options: { messagePostFormat: 'array' | 'string'; reportSelfMessage: boolean }
): OB11Event | null {
  const isMessageLike = event.post_type === 'message' || event.post_type === 'message_sent';
  if (event.post_type === 'message_sent' && !options.reportSelfMessage) return null;
  if (isMessageLike && options.messagePostFormat === 'string') {
    const msg = event as OB11MessageEvent;
    return {
      ...event,
      message: msg.raw_message,
      message_format: 'string',
    } as OB11Event;
  }
  return event;
}
