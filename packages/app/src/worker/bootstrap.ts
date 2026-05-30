import {
  CoreBootstrap,
  NTElementType,
  RingBufferTransport,
  createLogger,
  createMemoryContext,
  loadConfig,
  type InstanceContext,
  type NTPeer,
  type NTRawMessage,
} from '@qanyicat/core';
import { OneBotManager } from '@qanyicat/onebot';
import { registerAction, segmentsToNtElements, type UnifiedSegment } from '@qanyicat/protocol';
import { installSignalHandlers, registerShutdownHook } from '../master/shutdown';

/**
 * Worker entry. Loads config, constructs InstanceContext (real NT or memory
 * mode), starts OneBot adapters, and optionally boots the WebUI via dynamic
 * import gated on the `__BUILD_WEBUI__` compile-time flag.
 */
export async function runWorker(): Promise<void> {
  const configPath = process.env['QANYICAT_CONFIG_PATH'] ?? './qanyicat.config.json';
  const config = loadConfig({ path: configPath });
  // v0.4n-housekeeping-12: ring buffer capacity from config.log.ringBufferSize
  // (default 500). Env override matches the bridge's same-name var so a single
  // QANYICAT_RING_BUFFER_SIZE=N propagates to both worker and inject paths.
  const envSize = Number(process.env['QANYICAT_RING_BUFFER_SIZE']);
  const ringBufferSize =
    Number.isFinite(envSize) && envSize >= 50 && envSize <= 100_000
      ? Math.floor(envSize)
      : (config.log.ringBufferSize ?? 500);
  const ringBuffer = new RingBufferTransport(ringBufferSize);
  const logger = createLogger({ label: 'worker', ringBuffer });
  installSignalHandlers(logger);

  const memoryMode = process.env['QANYICAT_MEMORY_MODE'] === '1';
  let ctx: InstanceContext;
  if (memoryMode) {
    const uin = process.env['QANYICAT_MEMORY_UIN'] ?? '10000';
    logger.info(`starting in memory mode (uin=${uin}); no real QQ session will be created`);
    ctx = createMemoryContext({ uin, logger });
    registerMemoryDebugActions(ctx);
  } else {
    ctx = await new CoreBootstrap({ config, logger }).start();
  }
  registerShutdownHook(async () => {
    await ctx.dispose();
  });

  const onebot = new OneBotManager(ctx, config.onebot);
  await onebot.start();
  registerShutdownHook(async () => {
    await onebot.stop();
  });

  const startedAt = Date.now();

  if (__BUILD_WEBUI__ && config.webui?.enable) {
    const mod = await import('@qanyicat/webui-backend');
    const opts: Parameters<typeof mod.initWebUI>[0] = {
      port: config.webui.port,
      ctx,
      config,
      logs: ringBuffer,
      startedAt,
    };
    if (config.webui.jwtSecret !== undefined) opts.jwtSecret = config.webui.jwtSecret;
    if (config.webui.password !== undefined) opts.webuiPassword = config.webui.password;
    const ui = await mod.initWebUI(opts);
    registerShutdownHook(async () => {
      await ui.close();
    });
    logger.info(`WebUI listening on http://127.0.0.1:${config.webui.port}`);
  }

  process.send?.({ type: 'login-success', uin: ctx.uin });
  logger.info(`worker ready for uin=${ctx.uin}`);
}

interface DebugInjectParams {
  /** Sender UIN that the message will appear to come from. Must NOT be the bot's own. */
  fromUin: string;
  /** Optional nickname / group card to attach to the synthetic sender. */
  fromNickname?: string;
  /** Where the message lands. Mirrors UnifiedPeer. */
  peer: { type: 'user' | 'group'; id: string };
  segments: UnifiedSegment[];
}

/**
 * Memory-mode-only debug action: inject a fake incoming message that looks
 * like it came from another user. Lets demo bots like examples/echo-bot
 * actually exercise their reply path against the in-memory loopback.
 */
function registerMemoryDebugActions(ctx: InstanceContext): void {
  registerAction<DebugInjectParams, { messageId: string }>(
    '_debug_inject_message',
    async (_ctx, params) => {
      const ntPeer: NTPeer = {
        chatType: params.peer.type === 'group' ? 'group' : 'private',
        peerUid: params.peer.id,
        ...(params.peer.type === 'user' ? { peerUin: params.peer.id } : {}),
        ...(params.peer.type === 'group' ? { groupCode: params.peer.id } : {}),
      };
      const seq = String(Math.floor(Math.random() * 100_000));
      const random = String(Math.floor(Math.random() * 2 ** 31));
      const msgId = `inject-${seq}-${random}`;
      const elements = segmentsToNtElements(params.segments) as NTRawMessage['elements'];
      void NTElementType.TEXT; // keep the import alive even if no text segment is sent
      const raw: NTRawMessage = {
        msgId,
        msgSeq: seq,
        msgRandom: random,
        msgTime: String(Math.floor(Date.now() / 1000)),
        peer: ntPeer,
        senderUid: `u_${params.fromUin}`,
        senderUin: params.fromUin,
        ...(params.fromNickname !== undefined ? { sendNickName: params.fromNickname } : {}),
        elements,
      };
      ctx.events.emit('msg.recv', { peer: ntPeer, messages: [raw] });
      return { messageId: msgId };
    }
  );
  ctx.logger.info('memory mode: registered debug action `_debug_inject_message`');
}
