/**
 * @qanyicat/inject-bridge — boot the OneBot 11 manager from inside QQ.exe.
 *
 * Loaded by tools/qq-loader/index.cjs via dynamic `import()` once the
 * live wrapper session + msgService + selfUid are available. Builds an
 * InstanceContext-shaped object backed by the real NT runtime and starts
 * OneBotManager with a default `http-server` transport on 127.0.0.1:5700.
 *
 * v0.4d-α scope: msg.recv forwarding + send_message action. Other NTApis
 * throw `not implemented` — group queries, file upload, profile fetch are
 * v0.4e+ work.
 */

// Side-effect import: registers all action handlers (send_message, etc.).
import '@qanyicat/protocol';

import { OneBotManager } from '@qanyicat/onebot';
import {
  createNTEventBus,
  RingBufferTransport,
  type InstanceContext,
  type NTPeer,
  type NTRawMessage,
  type QanYiCatConfig,
} from '@qanyicat/core';
import type { NodeIQQNTWrapperSession } from '@qanyicat/core';
import { UidUinCache, type ProfileServiceFacade, type UixConvertServiceFacade } from './uid-uin-cache';
import { buildNTApis, GroupListCache } from './apis-impl';
import { MsgIndex } from './msg-index';
import { MediaIndex } from './media-index';
import { DownloadWaiters } from './download-wait';
import { SelfSendWaiter } from './self-send-wait';
import { enumerateNativeServiceMethods } from './napi-introspect';
import { decodeSysMsg } from './sysmsg-decode';

export interface BootDeps {
  /** wrapper.node exports (`globalThis.__qanyicatWrapperExports`). */
  wrapper: unknown;
  /** Live session from `wrapper.NodeIQQNTWrapperSession.getNTWrapperSession('nt_1')`. */
  session: NodeIQQNTWrapperSession;
  /** session.getMsgService() — passed directly so we don't have to call it again. */
  msgService: {
    addKernelMsgListener(listener: unknown): string;
    removeKernelMsgListener(handle: string): void;
    sendMsg(
      msgId: '0',
      peer: { chatType: number; peerUid: string; guildId: string },
      elements: unknown[],
      extra: Map<unknown, unknown>
    ): Promise<{ result: number; errMsg: string; msgId?: string; msgSeq?: string; msgTime?: string }>;
    recallMsg?(
      peer: { chatType: number; peerUid: string; guildId: string },
      msgIds: string[]
    ): Promise<{ result: number; errMsg: string }>;
    /** v0.4i-β-1: fetch specific messages by NT msgId. */
    getMsgsByMsgId?(
      peer: { chatType: number; peerUid: string; guildId: string },
      msgIds: string[]
    ): Promise<{ result: number; errMsg: string; msgList?: Array<Record<string, unknown>> }>;
    /** v0.4i-β-2: history paginated by ntMsgId anchor (NapCat uses this for `get_*_msg_history` with message_seq). */
    getMsgsIncludeSelf?(
      peer: { chatType: number; peerUid: string; guildId: string },
      ntMsgId: string,
      count: number,
      queryOrder: boolean
    ): Promise<{ result: number; errMsg: string; msgList?: Array<Record<string, unknown>> }>;
    /** v0.4i-β-2: latest N messages — `getMsgsBySeqAndCount` with seq='0' returns empty; this is the right API for "no anchor". */
    getAioFirstViewLatestMsgs?(
      peer: { chatType: number; peerUid: string; guildId: string },
      num: number
    ): Promise<{ result: number; errMsg: string; msgList?: Array<Record<string, unknown>> }>;
    /** v0.4h-α: returns the NT-cache path where the source file should be copied for sendMsg. */
    getRichMediaFilePathForGuild(args: {
      md5HexStr: string;
      fileName: string;
      elementType: number;
      elementSubType: number;
      thumbSize: number;
      needCreate: boolean;
      downloadType: number;
      file_uuid: string;
    }): string;
    /**
     * v0.4m-α: build a multi-forward message from `msgInfos` in `srcContact`
     * delivered to `dstContact`. Mirrors NapCat's `apis/msg.ts::multiForwardMsg`
     * call shape. NT processes asynchronously — the result usually arrives via
     * the listener as an arkElement with `app: 'com.tencent.multimsg'`. The
     * direct return value may not carry msgId on this kernel version.
     */
    multiForwardMsgWithComment?(
      msgInfos: Array<{ msgId: string; senderShowName: string }>,
      srcContact: { chatType: number; peerUid: string; guildId: string },
      dstContact: { chatType: number; peerUid: string; guildId: string },
      commentElements: unknown[],
      extra: Map<unknown, unknown>
    ): Promise<{ result: number; errMsg: string; msgId?: string; msgSeq?: string; msgTime?: string }>;
    /**
     * v0.4n-α: download a rich-media element (pic/video/file/voice). Returns
     * an empty/no-msgId Promise; the actual completion arrives via the kernel
     * listener `onRichMediaDownloadComplete` keyed on (msgId, msgElementId).
     */
    downloadRichMedia?(args: {
      fileModelId: string;
      downSourceType: number;
      downloadSourceType: number;
      triggerType: number;
      msgId: string;
      chatType: number;
      peerUid: string;
      elementId: string;
      thumbSize: number;
      downloadType: number;
      filePath: string;
    }): Promise<{ result: number; errMsg: string }>;
  };
  /** v0.4n-α: optional NodeIKernelRichMediaService for video URL lookup. */
  richMediaService?: {
    getVideoPlayUrlV2?(
      peer: { chatType: number; peerUid: string; guildId: string },
      msgId: string,
      elementId: string,
      videoCodecFormat: number,
      exParams: { downSourceType: number; triggerType: number }
    ): Promise<{
      result?: number;
      errMsg?: string;
      urlResult?: { domainUrl?: string; backUrl?: Array<{ url?: string }> };
    }>;
    /**
     * v0.4n-γ: download an inline (private-chat) file by elementId. Completion
     * fires via `onRichMediaDownloadComplete` with `commonFileInfo.fileModelId`
     * matching the modelId we passed.
     */
    downloadFileForModelId?(
      peer: { chatType: number; peerUid: string; guildId: string },
      modelIds: string[],
      unknown: string
    ): Promise<{ result?: number; errMsg?: string }>;
  };
  selfUin: string;
  selfUid: string;
  qqVersion?: string;
  /** Override default OneBot config (one http-server on 127.0.0.1:5700, v11). */
  onebotConfig?: QanYiCatConfig['onebot'];
  /** Diagnostic log sink; defaults to console.log with `[bridge]` prefix. */
  log?: (line: string) => void;
}

export interface BootResult {
  ctx: InstanceContext;
  manager: OneBotManager;
  /** Stops the manager and removes our kernel listener handle. */
  dispose: () => Promise<void>;
}

export async function bootInsideQQ(deps: BootDeps): Promise<BootResult> {
  const rawLog = deps.log ?? ((line: string) => console.log(`[bridge] ${line}`));
  // Parallel ring buffer: every log line the bridge produces is mirrored here
  // so the WebUI /api/stream + /api/logs endpoints can serve them without the
  // bridge having to plug in a full winston pipeline. The transport's `.log`
  // method ingests the same record shape winston would feed it.
  //
  // v0.4n-housekeeping-12: capacity tunable via env (default 500). Out-of-range
  // values silently clamp; non-numeric falls back to default.
  const envSize = Number(process.env.QANYICAT_RING_BUFFER_SIZE);
  const ringBufferSize =
    Number.isFinite(envSize) && envSize >= 50 && envSize <= 100_000 ? Math.floor(envSize) : 500;
  const ringBuffer = new RingBufferTransport(ringBufferSize);
  const log = (line: string): void => {
    rawLog(line);
    const { level, message } = parseLogLine(line);
    ringBuffer.log({ level, message, label: 'bridge', timestamp: new Date().toISOString() }, () => undefined);
  };
  const logger = makeLoggerShim(log);
  const events = createNTEventBus();

  // uid↔uin cache — backs NTApis.user.uinToUid/uidToUin and the bridge's send
  // path. Seeded from self + populated live from every msg observation; cold
  // start primed from buddy list once.
  const sessionAny = deps.session as unknown as Record<string, () => unknown>;
  const profileSvc = (sessionAny.getProfileService?.()) as ProfileServiceFacade | undefined;
  // v0.4j-γ-rest: NapCat's `getUinByUidV2` fallback chain starts with the
  // dedicated converter service — it's the only path that works for non-friend
  // uids (strangers applying to join a group, ex-members, etc.).
  const uixConvert = (sessionAny.getUixConvertService?.()) as UixConvertServiceFacade | undefined;
  // v0.4n-housekeeping-12: opt-in persistence via QANYICAT_UID_UIN_CACHE_PATH.
  // Survives QQ relaunch so friend/group resolutions don't have to re-prime
  // from scratch every boot. Without the env var, behaves as before
  // (in-memory only). quick-start.bat sets the path to a project-dir json.
  const uidUinCachePath = process.env.QANYICAT_UID_UIN_CACHE_PATH;
  const hasUidPath = !!(uidUinCachePath && uidUinCachePath.trim() !== '');
  const cache = new UidUinCache(profileSvc, uixConvert, {
    ...(hasUidPath ? { persistPath: uidUinCachePath as string } : {}),
    log,
  });
  if (hasUidPath) {
    const { loaded, reason } = await cache.load();
    log(`uidUinCache.load: ${loaded} pairs${reason ? ` (${reason})` : ''}`);
  }
  cache.put(deps.selfUid, deps.selfUin);

  // Boot prime (best-effort, doesn't block startup).
  primeFromBuddyList(deps.session, cache, log).catch((e) => {
    log(`buddy-list prime threw: ${(e as Error).message}`);
  });

  // v0.4j-γ + δ: shared dedup Set for group notice events. Both the typed
  // group listener (`onMemberInfoChange` / `onGroupNotifiesUpdated`) and the
  // sysmsg-protobuf decoder in buildKernelListener fire for many of the same
  // events (e.g. self-promoted-to-admin hits SET_ADMIN notify AND sysmsg
  // type:44 within a few ms). Sharing the dedup set across both paths keeps
  // wire-side OB11 notices single-fire.
  const noticeDedup = new Set<string>();

  // Group list cache — populated by NodeIKernelGroupListener.onGroupListUpdate
  // events. NT pushes one shortly after session.init plus on each refresh.
  const groupCache = new GroupListCache();
  attachGroupListener(deps.session, groupCache, events, cache, noticeDedup, log);

  // v0.4j-β-1: friend-request events. The buddy listener fires whenever a new
  // request comes in OR an existing one's state changes; we filter for
  // un-decided + unread requests and emit one core event per.
  attachBuddyListener(deps.session, events, cache, log);

  // v0.4k diagnostic: enumerate addBuddyService methods + probe argc on
  // `addBuddy()`. The kernel's `assertion (argc == N) failed` error message
  // tells us the required argument count — invaluable for reverse-engineering.
  diagnoseAddBuddyService(deps.session, log);

  // Composite-message-id → (peer, ntMsgId) lookup for follow-up actions like
  // recall_message. Populated by the kernel listener below.
  const msgIndex = new MsgIndex();

  // v0.4n-α: media (md5 / fileUuid) → (peer, msgId, elementId, elementType)
  // lookup so OB11 actions like get_video can resolve a wire-side `file`
  // identifier back to the NT kernel call shape.
  //
  // v0.4n-housekeeping-9: opt-in file persistence via QANYICAT_MEDIA_INDEX_PATH
  // env var (quick-start.bat sets it to <project>/qanyicat.media-index.json).
  // Survives QQ relaunch so get_video / get_file work without re-priming via
  // get_*_msg_history. Without the env var, behaves as before (in-memory only).
  const mediaIndexPath = process.env.QANYICAT_MEDIA_INDEX_PATH;
  const hasMediaPath = !!(mediaIndexPath && mediaIndexPath.trim() !== '');
  const mediaIndex = new MediaIndex({
    ...(hasMediaPath ? { persistPath: mediaIndexPath as string } : {}),
    log,
  });
  if (hasMediaPath) {
    const { loaded, reason } = await mediaIndex.load();
    log(`mediaIndex.load: ${loaded} entries${reason ? ` (${reason})` : ''}`);
  }

  // v0.4n-α: NT's downloadRichMedia is fire-and-listener-completes; the
  // download-wait registry bridges that into per-(msgId, elementId) promises.
  const downloadWaiters = new DownloadWaiters();

  // v0.4m-β: outbound self-send → ntMsgId correlation. The
  // multiForwardFabricated path sends each fake node to selfPrivate, then
  // awaits the matching onAddSendMsg event to get the kernel's msgId.
  const selfSendWaiter = new SelfSendWaiter();

  // v0.4n-α: resolve richMediaService once at boot — same NodeIKernelRichMediaService
  // singleton NapCat uses for getVideoPlayUrlV2 etc.
  const sessAny = deps.session as unknown as Record<string, () => unknown>;
  const richMediaService = deps.richMediaService
    ?? ((sessAny.getRichMediaService?.()) as BootDeps['richMediaService'] | undefined);
  if (richMediaService) log('richMediaService resolved'); else log('richMediaService unavailable — get_video will throw');

  const selfInfo = { uin: deps.selfUin, uid: deps.selfUid, nick: '', online: true };
  const apis = buildNTApis(deps.session, deps.msgService, cache, selfInfo, groupCache, msgIndex, mediaIndex, richMediaService, downloadWaiters, selfSendWaiter, log);
  const ctx: InstanceContext = {
    uin: deps.selfUin,
    selfInfo,
    basicInfo: {
      execPath: process.execPath,
      qqVersion: deps.qqVersion ?? '',
      qqVersionConfigPath: '',
      qqResourceDir: '',
    },
    session: deps.session,
    logger,
    events,
    apis,
    dispose: async () => { /* set below */ },
  };

  const handle = deps.msgService.addKernelMsgListener(buildKernelListener(events, deps.selfUid, deps.selfUin, cache, msgIndex, mediaIndex, downloadWaiters, selfSendWaiter, noticeDedup, log));
  log(`addKernelMsgListener(bridge) → ${handle}`);

  const onebotConfig: QanYiCatConfig['onebot'] = deps.onebotConfig ?? {
    enable11: true,
    enable12: true,
    networks: [
      { kind: 'http-server', id: 'main-http',    host: '127.0.0.1', port: 5700, protocol: 'v11' },
      { kind: 'ws-server',   id: 'main-ws',      host: '127.0.0.1', port: 5710, protocol: 'v11' },
      { kind: 'http-server', id: 'main-http-12', host: '127.0.0.1', port: 5720, protocol: 'v12' },
    ],
  };
  // `currentManager` is the live OneBotManager. Swapped atomically by
  // `applyOneBotConfig` when the WebUI mutates network config.
  let currentManager = new OneBotManager(ctx, onebotConfig);
  await currentManager.start();
  log(`OneBotManager started (transports=${onebotConfig.networks.length}, OB11=${onebotConfig.enable11}, OB12=${onebotConfig.enable12})`);

  // In-memory mutable config the WebUI hands back when the operator edits a
  // network entry. Bridge stops the current manager and starts a fresh one;
  // existing kernel listeners + caches keep running across the swap because
  // they're owned by the bridge, not the manager.
  const liveConfig: QanYiCatConfig['onebot'] = { ...onebotConfig };
  const applyOneBotConfig = async (next: QanYiCatConfig['onebot']): Promise<void> => {
    log(`OneBotManager reload: networks=${next.networks.length} OB11=${next.enable11} OB12=${next.enable12}`);
    try { await currentManager.stop(); }
    catch (e) { log(`OneBotManager.stop threw during reload: ${(e as Error).message}`); }
    Object.assign(liveConfig, next);
    currentManager = new OneBotManager(ctx, next);
    await currentManager.start();
    log('OneBotManager reload complete');
  };

  // Optional WebUI boot — gated on env vars so the bridge stays lean for users
  // who only want the OneBot wire. Triggered by 快速启动.bat / similar.
  let webuiHandle: { close(): Promise<void>; port: number } | null = null;
  if (process.env['QANYICAT_WEBUI_ENABLE'] === '1') {
    try {
      const port = Number(process.env['QANYICAT_WEBUI_PORT'] ?? '5800');
      const { resolveWebUIPasskey } = await import('./webui-passkey');
      const passkey = resolveWebUIPasskey();
      log(`WebUI passkey resolved from ${passkey.source} (path=${passkey.path})`);
      const webui = await import('@qanyicat/webui-backend');
      const sanitizedConfig = {
        qq: {},
        log: { level: 'info' as const, toFile: false },
        onebot: liveConfig,
        webui: { enable: true, port },
        process: { multi: false, restartOnCrash: false },
      } as unknown as QanYiCatConfig;
      const initOpts: Parameters<typeof webui.initWebUI>[0] = {
        port,
        host: '127.0.0.1',
        ctx,
        config: sanitizedConfig,
        startedAt: Date.now(),
        webuiPassword: passkey.password,
        jwtSecret: passkey.jwtSecret,
        onConfigUpdate: applyOneBotConfig,
        onActionInvoke: (action, params, protocol) => currentManager.invokeAction(action, params, protocol ?? 'v11'),
        onListMedia: async () => mediaIndex.list().map((entry) => {
          // The WebUI DTO only knows private/group; collapse the rare NT
          // `temp` chat (private-via-group bridge) to `private` for display.
          const wireChat: 'private' | 'group' = entry.peer.chatType === 'group' ? 'group' : 'private';
          const peerUinRaw = entry.peer.chatType === 'private' ? entry.peer.peerUin : undefined;
          const groupCodeRaw = entry.peer.chatType === 'group' ? entry.peer.groupCode : undefined;
          return {
            keys: entry.keys,
            elementType: entry.elementType,
            ...(entry.fileName !== undefined ? { fileName: entry.fileName } : {}),
            ...(entry.fileSize !== undefined ? { fileSize: entry.fileSize } : {}),
            ...(entry.localCachePath !== undefined ? { localCachePath: entry.localCachePath } : {}),
            peer: {
              chatType: wireChat,
              peerUid: entry.peer.peerUid,
              ...(groupCodeRaw ? { groupCode: groupCodeRaw } : {}),
              ...(peerUinRaw ? { peerUin: peerUinRaw } : {}),
            },
            msgId: entry.msgId,
            elementId: entry.elementId,
          };
        }),
        logs: ringBuffer,
      };
      const exportPath = process.env['QANYICAT_CONFIG_EXPORT_PATH'];
      if (exportPath) initOpts.exportPath = exportPath;
      webuiHandle = await webui.initWebUI(initOpts);
      const hint = passkey.source === 'generated'
        ? `auto-generated, persisted to ${passkey.path}`
        : passkey.source === 'file'
          ? `loaded from ${passkey.path}`
          : 'from QANYICAT_WEBUI_PASSWORD env';
      log(`WebUI listening on http://127.0.0.1:${webuiHandle.port} (password: ${hint})`);
    } catch (e) {
      log(`WebUI boot threw — continuing without it: ${(e as Error).stack ?? (e as Error).message}`);
    }
  }

  const dispose = async () => {
    if (webuiHandle) {
      try { await webuiHandle.close(); } catch (e) { log(`webui.close threw: ${(e as Error).message}`); }
    }
    try { await currentManager.stop(); } catch (e) { log(`manager.stop threw: ${(e as Error).message}`); }
    try { deps.msgService.removeKernelMsgListener(handle); } catch (e) { log(`removeKernelMsgListener threw: ${(e as Error).message}`); }
  };
  (ctx as { dispose: () => Promise<void> }).dispose = dispose;

  return { ctx, manager: currentManager, dispose };
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap the dedup set to keep it bounded over long sessions. Evicts ~1000 oldest
 * keys (FIFO) when size crosses 5000.
 */
function trimDedup(set: Set<string>): void {
  if (set.size <= 5000) return;
  const it = set.values();
  for (let i = 0; i < 1000; i++) set.delete(it.next().value as string);
}

/**
 * Whether an `onMsgInfoListUpdate` entry represents a real recall confirmation.
 *
 * v0.4j-α-fix: msgType=5 alone is NOT specific enough — NT also fires
 * msgType=5 with other subMsgTypes for non-recall delivery-state updates
 * (notably the 6-14s post-multi-forward kernel echo, which used to surface
 * as a phantom `notice/group_recall` to wire clients). Gate on subMsgType=4
 * (the actual recall sub-kind per NT 9.9 observation).
 */
export function isRecallUpdate(m: Record<string, unknown>): boolean {
  return m.msgType === 5 && m.subMsgType === 4;
}

function buildKernelListener(
  events: ReturnType<typeof createNTEventBus>,
  selfUid: string,
  selfUin: string,
  cache: UidUinCache,
  msgIndex: MsgIndex,
  mediaIndex: MediaIndex,
  downloadWaiters: DownloadWaiters,
  selfSendWaiter: SelfSendWaiter,
  noticeDedup: Set<string>,
  log: (line: string) => void
) {
  // Both onRecvMsg (incoming) and onAddSendMsg (self-originated) flow through
  // the same builder so OB11 can emit `message` vs `message_sent` (v0.4f-α)
  // based on `sender.uin === selfId` downstream in CoreToUnified.message.
  const buildAndEmit = (m: Record<string, unknown>, allowSelfSent: boolean) => {
    if (!m) return;
    cache.put(String(m.senderUid ?? ''), String(m.senderUin ?? ''));
    if (m.chatType === 1) {
      cache.put(String(m.peerUid ?? ''), String(m.peerUin ?? ''));
    }

    if (!allowSelfSent && m.sendType === 1) return;
    if (!allowSelfSent && m.senderUid === selfUid) return;
    const chatTypeRaw = m.chatType as number;
    const peerUid = String(m.peerUid ?? '');
    const peerUinRaw = String(m.peerUin ?? '');
    const senderUid = String(m.senderUid ?? '');
    const senderUinFromMsg = String(m.senderUin ?? '');
    const senderUin = senderUinFromMsg && senderUinFromMsg !== '0'
      ? senderUinFromMsg
      : (cache.getUin(senderUid) ?? '');
    const peer: NTPeer =
      chatTypeRaw === 2
        ? { chatType: 'group', peerUid, groupCode: peerUid }
        : { chatType: 'private', peerUid, ...(peerUinRaw && peerUinRaw !== '0' ? { peerUin: peerUinRaw } : {}) };
    const sendNickNameRaw = m.sendNickName !== undefined && m.sendNickName !== ''
      ? String(m.sendNickName)
      : (cache.getNick(senderUid) ?? '');
    const raw: NTRawMessage = {
      msgId: String(m.msgId ?? ''),
      msgSeq: String(m.msgSeq ?? ''),
      msgRandom: String(m.msgRandom ?? ''),
      msgTime: String(m.msgTime ?? ''),
      peer,
      senderUid,
      ...(senderUin ? { senderUin } : {}),
      ...(sendNickNameRaw ? { sendNickName: sendNickNameRaw } : {}),
      ...(m.sendMemberName !== undefined ? { sendMemberName: String(m.sendMemberName) } : {}),
      elements: (m.elements as NTRawMessage['elements']) ?? [],
    };
    // Populate the msg-index so recall_message can resolve the wire id later.
    // Composite-id shape MUST match CoreToUnified.deriveMessageId exactly.
    const compositeId = `${selfUin}:${peer.chatType}:${raw.msgSeq}:${raw.msgRandom}`;
    msgIndex.put(compositeId, peer, raw.msgId);
    // v0.4n-α/β: index any media elements (md5/fileUuid → peer/msgId/elementId
    // + bot-sent localCachePath if present).
    mediaIndex.indexFromRaw(raw);
    events.emit('msg.recv', { peer, messages: [raw] });
  };

  // v0.4m-polish: outbound multi-forward sends. NT fires onAddSendMsg
  // immediately with an ark element whose `meta.detail.resid` is empty, then
  // fires onMsgInfoListUpdate ~300-500ms later with the populated resid (the
  // server has assigned the resource). Suppress the early emit and forward
  // the finalized payload instead — wire clients get one message_sent event
  // with a usable forward.id. Fallback timer guarantees we still emit if the
  // update never arrives.
  const forwardAwaitingFinalize = new Map<string, { timer: ReturnType<typeof setTimeout>; original: Record<string, unknown> }>();
  const isMultiForwardSend = (m: Record<string, unknown>): boolean =>
    m.msgType === 11 && m.subMsgType === 7;

  // Recall detection: NT signals a recall by re-emitting the affected msg via
  // onMsgInfoListUpdate with msgType=5 / subMsgType=4. Track which ids we've
  // already announced as recalled so we don't double-emit (the kernel often
  // fires the update twice within a few ms).
  const announcedRecalls = new Set<string>();
  const checkForRecalls = (msgs: unknown) => {
    if (!Array.isArray(msgs)) return;
    for (const m of msgs as Array<Record<string, unknown>>) {
      if (!m || !isRecallUpdate(m)) continue;
      const ntMsgId = String(m.msgId ?? '');
      if (!ntMsgId || announcedRecalls.has(ntMsgId)) continue;
      announcedRecalls.add(ntMsgId);
      const chatTypeRaw = m.chatType as number;
      const peerUid = String(m.peerUid ?? '');
      // Resolve peerUin for OB11 user_id field (caches were populated by the
      // original send/recv before this point — boot prime + msg observation).
      const peerUin = chatTypeRaw === 1
        ? (cache.getUin(peerUid) ?? '')
        : peerUid; // for groups the peerUid IS the numeric groupCode
      const peer: NTPeer = chatTypeRaw === 2
        ? { chatType: 'group', peerUid, groupCode: peerUid }
        : { chatType: 'private', peerUid, ...(peerUin ? { peerUin } : {}) };
      // Prefer the ORIGINAL composite (so wire clients can correlate with
      // their previously-stored message_id). Fall back to a freshly-rebuilt
      // composite using the update's msgSeq if the original is gone (evicted).
      const composite = msgIndex.findCompositeByNtMsgId(ntMsgId)
        ?? `${selfUin}:${peer.chatType}:${String(m.msgSeq ?? '')}:${String(m.msgRandom ?? '')}`;
      const operatorUid = String(m.senderUid ?? '');
      events.emit('msg.recall', {
        peer,
        msgId: composite,
        ...(operatorUid ? { operatorUid } : {}),
      });
    }
  };

  return {
    onRecvMsg(msgs: unknown) {
      if (!Array.isArray(msgs)) return;
      try { for (const m of msgs as Array<Record<string, unknown>>) buildAndEmit(m, false); }
      catch (e) { log(`onRecvMsg translator threw: ${(e as Error).message}`); }
    },
    /**
     * Self-originated messages — fires once per send (the wire client's own
     * outgoing reply, or a manual QQ-UI send by the user). Emit as `msg.recv`
     * with `allowSelfSent=true` so CoreToUnified.message preserves selfUin in
     * sender.uin and OB11EventConverter renders `post_type: 'message_sent'`.
     */
    onAddSendMsg(m: unknown) {
      if (!m || typeof m !== 'object') return;
      try {
        const msg = m as Record<string, unknown>;
        // v0.4m-β: notify pending self-send waiters BEFORE emit, so the
        // fabrication path can resolve its Promise even when the emit
        // pipeline is busy. No-op when no waiters are pending.
        selfSendWaiter.notify(msg);
        if (isMultiForwardSend(msg)) {
          // Defer — the populated ark (with resid) arrives via onMsgInfoListUpdate.
          const msgId = String(msg.msgId ?? '');
          if (!msgId) { buildAndEmit(msg, true); return; }
          const timer = setTimeout(() => {
            forwardAwaitingFinalize.delete(msgId);
            log(`forward ${msgId}: finalize timeout, emitting original (empty resid)`);
            try { buildAndEmit(msg, true); } catch (e) { log(`forward fallback emit threw: ${(e as Error).message}`); }
          }, 2000);
          forwardAwaitingFinalize.set(msgId, { timer, original: msg });
          return;
        }
        buildAndEmit(msg, true);
      } catch (e) { log(`onAddSendMsg translator threw: ${(e as Error).message}`); }
    },
    /**
     * Recalls + delivery-status changes for messages whose lifecycle is still
     * tracked by the kernel. We handle:
     *   - msgType=5 subMsgType=4: recall confirmation
     *   - msgType=11 subMsgType=7: multi-forward send finalization (v0.4m-polish)
     */
    onMsgInfoListUpdate(msgs: unknown) {
      try {
        checkForRecalls(msgs);
        if (!Array.isArray(msgs)) return;
        for (const m of msgs as Array<Record<string, unknown>>) {
          if (!m || !isMultiForwardSend(m)) continue;
          const msgId = String(m.msgId ?? '');
          const pending = msgId ? forwardAwaitingFinalize.get(msgId) : undefined;
          if (!pending) continue; // not one we initiated, or already finalized
          clearTimeout(pending.timer);
          forwardAwaitingFinalize.delete(msgId);
          try { buildAndEmit(m, true); }
          catch (e) { log(`forward finalize emit threw: ${(e as Error).message}`); }
        }
      } catch (e) { log(`onMsgInfoListUpdate translator threw: ${(e as Error).message}`); }
    },
    /**
     * v0.4n-γ: progress updates. NT 9.9.30 sometimes never fires the final
     * Complete event for inline-file downloads — when the final progress
     * event reports progress == totalSize, treat that as completion.
     */
    onRichMediaProgerssUpdate(info: unknown) {
      if (!info || typeof info !== 'object') return;
      try { downloadWaiters.signalProgress(info as import('./download-wait').DownloadProgressInfo); }
      catch (e) { log(`onRichMediaProgerssUpdate threw: ${(e as Error).message}`); }
    },
    /**
     * v0.4n-α: NT signals media download completion here. The download-wait
     * registry resolves any explicit-download Promise.
     *
     * v0.4n-β: NT also fires this on RECEIVE for video/pic/voice auto-cache —
     * filePath then points to NT's local cache (`Video/2026-05/Ori/<md5>.mp4` etc).
     * Capture that path into the media index so `get_video` etc. can return a
     * `file://` URL without an extra server roundtrip. Thumbnail events
     * (filePath under a `Thumb` segment) carry the thumbnail path, not the
     * real media — skip those for cache-path tracking.
     */
    onRichMediaDownloadComplete(info: unknown) {
      if (!info || typeof info !== 'object') return;
      try {
        const i = info as Record<string, unknown> & import('./download-wait').DownloadCompleteInfo;
        downloadWaiters.signal(i);
        const filePath = String(i.filePath ?? '');
        if (filePath && !/[\\/]Thumb[\\/]/.test(filePath)) {
          const msgId = String(i.msgId ?? '');
          const elementId = String(i.msgElementId ?? '');
          if (msgId && elementId && mediaIndex.setLocalCachePath(msgId, elementId, filePath)) {
            log(`auto-cache captured: msgId=${msgId} elem=${elementId} → ${filePath.slice(0, 100)}`);
          }
        }
      } catch (e) { log(`onRichMediaDownloadComplete threw: ${(e as Error).message}`); }
    },
    /**
     * v0.4j-δ: decode NT's raw protobuf system messages. NT delivers
     * "happens-to-self" events here (self-kicked, group-disbanded) that don't
     * surface via the typed group listeners. The decoder also catches
     * other-member changes, but the typed listener has already emitted those
     * — shared `noticeDedup` Set keeps wire-side single-fire.
     */
    onRecvSysMsg(bytes: unknown) {
      if (!Array.isArray(bytes) && !(bytes instanceof Uint8Array)) return;
      try {
        const decoded = decodeSysMsg(bytes as number[] | Uint8Array);
        if (!decoded) return;
        if (decoded.kind === 'group.member-change') {
          // Unified shape only has join|leave|kick. kick_me / disband collapse.
          const unifiedKind: 'join' | 'leave' | 'kick' =
            decoded.sub === 'join' ? 'join'
            : decoded.sub === 'disband' ? 'leave'
            : decoded.sub === 'leave' ? 'leave'
            : 'kick';
          const key = `${decoded.groupCode}:${decoded.memberUid}:${unifiedKind}`;
          if (noticeDedup.has(key)) return;
          noticeDedup.add(key); trimDedup(noticeDedup);
          const uin = cache.getUin(decoded.memberUid) ?? '';
          const operatorUin = decoded.operatorUid ? (cache.getUin(decoded.operatorUid) ?? '') : '';
          log(`sysmsg group.member-change gc=${decoded.groupCode} uid=${decoded.memberUid} sub=${decoded.sub} op=${decoded.operatorUid ?? '?'}→uin=${operatorUin || '?'} (type=${decoded.sourceType})`);
          events.emit('group.member-change', {
            groupCode: decoded.groupCode,
            uid: decoded.memberUid,
            ...(uin ? { uin } : {}),
            kind: unifiedKind,
            ...(decoded.operatorUid ? { operatorUid: decoded.operatorUid } : {}),
            ...(operatorUin ? { operatorUin } : {}),
          });
        } else if (decoded.kind === 'group.admin-change') {
          const key = `${decoded.groupCode}:${decoded.adminUid}:admin:${decoded.isAdmin ? 3 : 2}`;
          if (noticeDedup.has(key)) return;
          noticeDedup.add(key); trimDedup(noticeDedup);
          const uin = cache.getUin(decoded.adminUid) ?? '';
          log(`sysmsg group.admin-change gc=${decoded.groupCode} uid=${decoded.adminUid} isAdmin=${decoded.isAdmin}`);
          events.emit('group.admin-change', {
            groupCode: decoded.groupCode,
            uid: decoded.adminUid,
            ...(uin ? { uin } : {}),
            isAdmin: decoded.isAdmin,
          });
        } else if (decoded.kind === 'unknown') {
          // v0.4j-δ debug: NT 9.9 may use different contentHead.type values
          // than NapCat's older (33/34/44). Log so we can grow the map.
          log(`sysmsg unknown contentType=${decoded.contentType}${decoded.subType !== undefined ? ` subType=${decoded.subType}` : ''}`);
        }
      } catch (e) {
        log(`onRecvSysMsg decode threw: ${(e as Error).message}`);
      }
    },
  };
}

async function primeFromBuddyList(
  session: NodeIQQNTWrapperSession,
  cache: UidUinCache,
  log: (line: string) => void
): Promise<void> {
  const sessionAny = session as unknown as Record<string, () => Record<string, (...args: unknown[]) => unknown>>;
  const buddySvc = sessionAny.getBuddyService?.();
  const profileSvc = sessionAny.getProfileService?.() as unknown as ProfileServiceFacade | undefined;
  if (!buddySvc || !profileSvc?.getUinByUid) return;

  // BuddyListReqType.KNOMAL = 0
  const listResult = await (buddySvc.getBuddyListV2 as (callFrom: string, isPullRefresh: boolean, reqType: number) => Promise<{ data: Array<{ buddyUids: string[] }> }>)(
    '0', true, 0
  ).catch(() => null);
  if (!listResult?.data) return;

  const allUids: string[] = [];
  for (const cat of listResult.data) {
    for (const uid of cat.buddyUids ?? []) allUids.push(uid);
  }
  if (allUids.length === 0) return;

  // Batch to avoid huge sync calls. 50 at a time.
  let learned = 0;
  for (let i = 0; i < allUids.length; i += 50) {
    const batch = allUids.slice(i, i + 50);
    try {
      const m = profileSvc.getUinByUid!('FriendsServiceImpl', batch);
      if (m && typeof (m as Map<string, string>).forEach === 'function') {
        (m as Map<string, string>).forEach((uin, uid) => {
          if (uin && uin !== '0') {
            cache.put(uid, uin);
            learned++;
          }
        });
      }
    } catch {
      // best effort
    }
  }
  log(`uid↔uin prime: ${allUids.length} buddies, ${learned} uin pairs learned, cache size=${cache.size}`);

  // Phase 2 (v0.4g): batch-fetch nicknames so friend.list / user.getProfile /
  // CQ at-resolver all return real `@<nick>` strings out of the box.
  const nickLearned = await cache.primeNicks(allUids);
  log(`nick prime: ${nickLearned} nicks learned for ${allUids.length} uids`);
}

function attachBuddyListener(
  session: NodeIQQNTWrapperSession,
  events: ReturnType<typeof createNTEventBus>,
  cache: UidUinCache,
  log: (line: string) => void
): void {
  const s = session as unknown as Record<string, () => Record<string, (...a: unknown[]) => unknown>>;
  const buddySvc = s.getBuddyService?.();
  if (!buddySvc?.addKernelBuddyListener) {
    log('buddy listener: buddyService has no addKernelBuddyListener — friend.request events disabled');
    return;
  }
  const announced = new Set<string>();
  async function emitFromBuddyReqs(reqs: Array<Record<string, unknown>> | undefined, source: string) {
    if (!Array.isArray(reqs)) return;
    const doubt = source === 'onDoubtBuddyReqChange';
    for (const r of reqs) {
      if (!r) continue;
      // Only filter out requests WE initiated (outgoing). Incoming requests
      // come in many states (`isDecide`/`isUnread` flicker as the kernel
      // syncs across devices) so dedup by uid+reqTime is the reliable gate.
      if (r.isInitiator === true) continue;
      const uid = String(r.friendUid ?? r.uid ?? '');
      if (!uid) continue;
      const reqTime = String(r.reqTime ?? '');
      const key = `${uid}:${reqTime}`;
      if (announced.has(key)) continue;
      announced.add(key);
      // Best-effort uin resolution: hit cache first, fall back to profileService.
      const uin = (await cache.resolveUin(uid)) || '';
      // NT pads `msg` on doubt-track FriendRequest with U+0000 bytes when the
      // requester didn't provide a comment — strip them so wire clients don't
      // get JSON-escaped null runs.
      const comment = String(r.extWords ?? r.msg ?? '').replace(/ +/g, '').trim();
      log(`friend.request from ${source} uid=${uid} uin=${uin || '?'} reqTime=${reqTime} doubt=${doubt} comment="${comment.slice(0, 40)}"`);
      events.emit('friend.request', {
        uid,
        comment,
        reqTime,
        doubt,
        ...(uin ? { uin } : {}),
      });
    }
  }

  // Diagnostic catch-all: log every buddy listener method NT fires so we can
  // identify which one carries the actual request payload on this kernel.
  const diagMethods = [
    'onBuddyListChangedV2', 'onAddBuddyNeedVerify', 'onAddMeSettingChanged',
    'onAvatarUrlUpdated', 'onBlockChanged', 'onBuddyDetailInfoChange',
    'onBuddyInfoChange', 'onBuddyListChange', 'onBuddyRemarkUpdated',
    'onBuddyReqUnreadCntChange', 'onCheckBuddySettingResult',
    'onDelBatchBuddyInfos', 'onDoubtBuddyReqUnreadNumChange',
    'onNickUpdated', 'onSmartInfos', 'onSpacePermissionInfos',
  ];
  const listener: Record<string, (a: unknown) => void> = {};
  for (const m of diagMethods) {
    listener[m] = (arg: unknown) => {
      try {
        const peek = JSON.stringify(arg).slice(0, 160);
        log(`buddy.${m} ← ${peek}`);
      } catch {
        log(`buddy.${m} ← <unserializable>`);
      }
    };
  }
  listener.onBuddyReqChange = (arg: unknown) => {
    const notify = arg as { buddyReqs?: Array<Record<string, unknown>> } | null;
    log(`buddy.onBuddyReqChange ← unreadNums=${(notify as { unreadNums?: number })?.unreadNums} reqs=${notify?.buddyReqs?.length ?? 0}`);
    emitFromBuddyReqs(notify?.buddyReqs, 'onBuddyReqChange').catch(() => undefined);
  };
  listener.onDoubtBuddyReqChange = (arg: unknown) => {
    const notify = arg as { doubtList?: Array<Record<string, unknown>> } | null;
    log(`buddy.onDoubtBuddyReqChange ← list=${notify?.doubtList?.length ?? 0}`);
    emitFromBuddyReqs(notify?.doubtList, 'onDoubtBuddyReqChange').catch(() => undefined);
  };
  try {
    const handle = (buddySvc.addKernelBuddyListener as (l: unknown) => number | string)(listener);
    log(`addKernelBuddyListener(bridge) → ${handle}`);
  } catch (e) {
    log(`addKernelBuddyListener threw: ${(e as Error).message}`);
  }
}

function diagnoseAddBuddyService(
  session: NodeIQQNTWrapperSession,
  log: (line: string) => void
): void {
  const sessionAny = session as unknown as Record<string, () => unknown>;
  // NT's getter may go by either of these names depending on the kernel build.
  const svc = (sessionAny.getAddBuddyService?.() ?? sessionAny.getNodeIKernelAddBuddyService?.()) as
    Record<string, (...a: unknown[]) => unknown> | undefined;
  if (!svc) {
    log('addBuddyService: NOT exposed on this session (tried getAddBuddyService / getNodeIKernelAddBuddyService)');
    return;
  }
  const methods = enumerateNativeServiceMethods(svc);
  log(`addBuddyService methods (${methods.length}): ${methods.join(', ')}`);

  // Argc probe — fact #12 says NT throws `assertion (argc == N) failed` on
  // wrong arg count. But fact #72: we MUST keep the `this` binding — call via
  // `svc[m]()` (dot/bracket access calls preserve `this`), NOT
  // `const fn = svc[m]; fn()` (extracts → loses `this` → `Illegal invocation`).
  const probeTargets = ['addBuddy', 'requestInfoByAccount', 'queryUinSafetyFlag'];
  for (const m of probeTargets) {
    if (typeof svc[m] !== 'function') continue;
    try {
      svc[m]!();
      log(`addBuddyService.${m}() — no throw on 0-arg call (unexpected)`);
    } catch (e) {
      log(`addBuddyService.${m}() argc-probe: ${(e as Error).message.slice(0, 200)}`);
    }
  }
}

function attachGroupListener(
  session: NodeIQQNTWrapperSession,
  groupCache: GroupListCache,
  events: ReturnType<typeof createNTEventBus>,
  cache: UidUinCache,
  noticeDedup: Set<string>,
  log: (line: string) => void
): void {
  const s = session as unknown as Record<string, () => Record<string, (...a: unknown[]) => unknown>>;
  const groupSvc = s.getGroupService?.();
  if (!groupSvc?.addKernelGroupListener) {
    log('group listener: groupService has no addKernelGroupListener — group.list cache will start empty');
    return;
  }

  // Per-group member state cache. Each entry maps uid → role (number; 4=owner,
  // 3=admin, 2=member per NapCat). Used to diff join/leave/admin-change.
  // We only treat single-page (`!hasPrev && !hasNext`) member list updates as
  // authoritative for diff — paginated refreshes would false-positive leaves.
  const memberStates = new Map<string, Map<string, number>>();

  function dedup(key: string): boolean {
    if (noticeDedup.has(key)) return true;
    noticeDedup.add(key);
    // Light cap on the dedup set so it doesn't grow unbounded over weeks.
    if (noticeDedup.size > 5000) {
      const it = noticeDedup.values();
      for (let i = 0; i < 1000; i++) noticeDedup.delete(it.next().value as string);
    }
    return false;
  }

  // ─── onMemberListChange — full or paginated member list refresh ───────────
  // Payload: { sceneId, ids, infos: Map<uid, member>, hasPrev, hasNext, ... }
  // We only diff vs cache when both flags are false (single-page full list).
  // For pages, we just opportunistically learn role/nick into the cache.
  function handleMemberListChange(arg: unknown) {
    const a = arg as {
      sceneId?: string;
      ids?: string[];
      infos?: Map<string, { uid: string; uin: string; nick: string; cardName?: string; role: number }> | Record<string, unknown>;
      hasPrev?: boolean;
      hasNext?: boolean;
      groupCode?: string;
    } | null;
    if (!a || !a.infos) return;
    // Derive groupCode: NT puts it on the payload OR in `sceneId` as `"<gc>_..."`
    const groupCode = a.groupCode
      ?? (a.sceneId && /^\d+/.test(a.sceneId) ? a.sceneId.split('_')[0] : '')
      ?? '';
    if (!groupCode) {
      log(`group.onMemberListChange: no groupCode in payload (sceneId=${a.sceneId}) — skipping diff`);
      return;
    }
    // Materialize the infos as a uid→member map.
    const newMembers = new Map<string, { uid: string; uin: string; role: number; nick: string }>();
    const infosUnknown = a.infos as unknown;
    const isMapLike = typeof (infosUnknown as { entries?: unknown }).entries === 'function';
    const iter: Iterable<[string, { uid: string; uin: string; nick: string; cardName?: string; role: number }]> =
      isMapLike
        ? (infosUnknown as Map<string, { uid: string; uin: string; nick: string; cardName?: string; role: number }>).entries()
        : Object.entries(infosUnknown as Record<string, { uid: string; uin: string; nick: string; cardName?: string; role: number }>);
    for (const [, m] of iter) {
      if (!m || !m.uid) continue;
      newMembers.set(m.uid, { uid: m.uid, uin: m.uin, role: m.role, nick: m.nick ?? '' });
      // Always learn uid↔uin + nick (cross-fill — same trick as group.members).
      if (m.uin) cache.put(m.uid, m.uin);
      if (m.nick) cache.putNick(m.uid, m.nick);
    }

    const isFullPage = !a.hasPrev && !a.hasNext;
    const prevState = memberStates.get(groupCode);

    if (!isFullPage) {
      // Just merge into cached state — no diff (page boundaries would cause
      // false leaves). Bootstrap a partial cache so we have something for the
      // next full page.
      if (!prevState) memberStates.set(groupCode, new Map());
      const state = memberStates.get(groupCode)!;
      for (const [uid, info] of newMembers) state.set(uid, info.role);
      log(`group.onMemberListChange gc=${groupCode} page=${newMembers.size} hasPrev=${a.hasPrev} hasNext=${a.hasNext} (merge-only)`);
      return;
    }

    if (!prevState) {
      // First fully-observed snapshot — record state but don't emit (we don't
      // know which side is "before" the bootstrap).
      const fresh = new Map<string, number>();
      for (const [uid, info] of newMembers) fresh.set(uid, info.role);
      memberStates.set(groupCode, fresh);
      log(`group.onMemberListChange gc=${groupCode} bootstrap with ${newMembers.size} members`);
      return;
    }

    // v0.4j-δ: don't diff for join/leave. NT's `onMemberListChange` payload
    // is NOT guaranteed to be the full canonical list — admin/member view
    // filters cause spurious +0/-N deltas. NapCat-style: trust `onRecvSysMsg`
    // (protobuf) for join/leave events, use this listener only to refresh the
    // cached role state so `onMemberInfoChange` admin-flip detection still works.
    const fresh = new Map<string, number>();
    for (const [uid, info] of newMembers) fresh.set(uid, info.role);
    memberStates.set(groupCode, fresh);
    log(`group.onMemberListChange gc=${groupCode} refresh: ${newMembers.size} members (sysmsg handles join/leave)`);
  }

  // ─── onMemberInfoChange — specific members had their info updated ─────────
  // Payload: (groupCode, dataSource, members: Map<uid, member>). NT fires this
  // for nick/card/role changes etc. We only emit admin-change here.
  function handleMemberInfoChange(groupCode: unknown, _dataSource: unknown, members: unknown) {
    const gc = String(groupCode ?? '');
    if (!gc || !members) return;
    const state = memberStates.get(gc);
    const isMapLike = typeof (members as { entries?: unknown }).entries === 'function';
    const iter: Iterable<[string, { uid: string; uin: string; nick: string; role: number }]> =
      isMapLike
        ? (members as Map<string, { uid: string; uin: string; nick: string; role: number }>).entries()
        : Object.entries(members as Record<string, { uid: string; uin: string; nick: string; role: number }>);
    let flips = 0;
    for (const [, m] of iter) {
      if (!m || !m.uid) continue;
      if (m.uin) cache.put(m.uid, m.uin);
      if (m.nick) cache.putNick(m.uid, m.nick);
      if (!state) continue;
      const before = state.get(m.uid);
      if (before !== undefined && before !== m.role && ((before === 3 && m.role === 2) || (before === 2 && m.role === 3))) {
        state.set(m.uid, m.role);
        if (dedup(`${gc}:${m.uid}:admin:${m.role}`)) continue;
        flips++;
        events.emit('group.admin-change', {
          groupCode: gc, uid: m.uid, ...(m.uin ? { uin: m.uin } : {}), isAdmin: m.role === 3,
        });
      } else if (before === undefined && state) {
        state.set(m.uid, m.role);
      }
    }
    if (flips > 0) log(`group.onMemberInfoChange gc=${gc} admin-flips=${flips}`);
  }

  // ─── onGroupNotifiesUpdated — admin + join-request notifications ──────────
  // Categories from NapCat's GroupNotifyMsgType enum:
  //   1  INVITED_BY_MEMBER                  → request/group.invite (someone invited US)
  //   5  INVITED_NEED_ADMINI_STRATOR_PASS   → request/group.join (member invited an outsider)
  //   7  REQUEST_JOIN_NEED_ADMINI_STRATOR_PASS → request/group.join (outsider applies directly)
  //   8  SET_ADMIN                           → group.admin-change isAdmin=true
  //   12 CANCEL_ADMIN_NOTIFY_CANCELED        → group.admin-change isAdmin=false (recipient was demoted)
  //   13 CANCEL_ADMIN_NOTIFY_ADMIN           → group.admin-change isAdmin=false (other admin notified)
  // Status check: only KUNHANDLE (=1) requests are real; the others are state echoes.
  async function handleGroupNotifiesUpdated(doubtFlag: unknown, notifies: unknown) {
    const doubt = doubtFlag === true;
    if (!Array.isArray(notifies)) return;
    for (const n of notifies as Array<Record<string, unknown>>) {
      if (!n) continue;
      const type = Number(n.type ?? 0);
      const status = Number(n.status ?? 0);
      const group = n.group as { groupCode?: string } | undefined;
      const user1 = n.user1 as { uid?: string } | undefined;
      const user2 = n.user2 as { uid?: string } | undefined;
      const groupCode = String(group?.groupCode ?? '');
      const flag = String(n.seq ?? '');
      const comment = String(n.postscript ?? '');
      if (!groupCode) continue;

      // Admin set/unset — emit regardless of KUNHANDLE (these are state echoes).
      if (type === 8 || type === 12 || type === 13) {
        const subjectUid = String(user1?.uid ?? '');
        if (!subjectUid) continue;
        const uin = (await cache.resolveUin(subjectUid)) || '';
        const isAdmin = type === 8;
        // v0.4j-δ: dedup key matches onMemberInfoChange + sysmsg paths so all
        // three sources for an admin change collapse to one wire notice.
        if (dedup(`${groupCode}:${subjectUid}:admin:${isAdmin ? 3 : 2}`)) continue;
        log(`group.notify SET_ADMIN(${type}) gc=${groupCode} uid=${subjectUid} → isAdmin=${isAdmin}`);
        events.emit('group.admin-change', {
          groupCode, uid: subjectUid, ...(uin ? { uin } : {}), isAdmin,
        });
        continue;
      }

      // Only KUNHANDLE = pending requests need wire delivery.
      if (status !== 1) continue;

      if (type === 7 || type === 5) {
        // Someone wants to join the group (direct or member-invited).
        const requesterUid = String(user1?.uid ?? '');
        if (!requesterUid) continue;
        const uin = (await cache.resolveUin(requesterUid)) || '';
        if (dedup(`${groupCode}:${requesterUid}:join:${flag}`)) continue;
        log(`group.notify REQUEST_JOIN(${type}) gc=${groupCode} uid=${requesterUid} flag=${flag} doubt=${doubt}`);
        events.emit('group.request', {
          groupCode, uid: requesterUid, ...(uin ? { uin } : {}),
          comment, flag, isInvite: false, type, doubt,
        });
      } else if (type === 1) {
        // Someone invited us to a group.
        const inviterUid = String(user2?.uid ?? '');
        if (!inviterUid) continue;
        const uin = (await cache.resolveUin(inviterUid)) || '';
        if (dedup(`${groupCode}:${inviterUid}:invite:${flag}`)) continue;
        log(`group.notify INVITED_BY_MEMBER gc=${groupCode} inviter=${inviterUid} flag=${flag} doubt=${doubt}`);
        events.emit('group.request', {
          groupCode, uid: inviterUid, ...(uin ? { uin } : {}),
          comment, flag, isInvite: true, type, doubt,
        });
      }
    }
  }

  const listener: Record<string, (...a: unknown[]) => void> = {
    ...groupCache.buildListener(log),
    onMemberListChange: (arg: unknown) => {
      try { handleMemberListChange(arg); }
      catch (e) { log(`group.onMemberListChange threw: ${(e as Error).message}`); }
    },
    onMemberInfoChange: (groupCode: unknown, dataSource: unknown, members: unknown) => {
      try { handleMemberInfoChange(groupCode, dataSource, members); }
      catch (e) { log(`group.onMemberInfoChange threw: ${(e as Error).message}`); }
    },
    onGroupNotifiesUpdated: (doubt: unknown, notifies: unknown) => {
      handleGroupNotifiesUpdated(doubt, notifies).catch((e) => log(`group.onGroupNotifiesUpdated threw: ${(e as Error).message}`));
    },
    onGroupSingleScreenNotifies: (doubt: unknown, _seq: unknown, notifies: unknown) => {
      handleGroupNotifiesUpdated(doubt, notifies).catch((e) => log(`group.onGroupSingleScreenNotifies threw: ${(e as Error).message}`));
    },
  };

  try {
    const handle = (groupSvc.addKernelGroupListener as (l: unknown) => number | string)(listener);
    log(`addKernelGroupListener(bridge) → ${handle}`);
  } catch (e) {
    log(`addKernelGroupListener threw: ${(e as Error).message}`);
  }
}

/**
 * Extract a level + message from the shim's pre-formatted "[level] body" line.
 * Used to populate winston-shaped records into the WebUI ring buffer. Defaults
 * to `info` when the line has no recognizable level prefix.
 */
function parseLogLine(line: string): { level: 'debug' | 'info' | 'warn' | 'error'; message: string } {
  const m = /^\[(debug|info|warn|error|verbose|silly|log)\]\s+(.*)$/s.exec(line);
  if (!m) return { level: 'info', message: line };
  const raw = m[1]!;
  const level: 'debug' | 'info' | 'warn' | 'error' =
    raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error' ? raw : 'info';
  return { level, message: m[2]! };
}

function makeLoggerShim(log: (line: string) => void): InstanceContext['logger'] {
  const at = (level: string) => (msg: unknown, ...rest: unknown[]) => {
    const head = typeof msg === 'string' ? msg : JSON.stringify(msg);
    const tail = rest.length > 0
      ? ' ' + rest.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join(' ')
      : '';
    log(`[${level}] ${head}${tail}`);
  };
  const shim = {
    info: at('info'),
    warn: at('warn'),
    error: at('error'),
    debug: at('debug'),
    verbose: at('verbose'),
    silly: at('silly'),
    log: at('log'),
    child: () => shim,
  };
  return shim as unknown as InstanceContext['logger'];
}
