/**
 * NTApis implementation backed by a live wrapper.node session. v0.4e-γ scope:
 *   user    — getProfile, getSelfInfo, uinToUid, uidToUin (cache-backed)
 *   group   — list (listener-cached), info, members, kick, mute, muteAll,
 *             setCard, setAdmin
 *   friend  — list (handleRequest / deleteFriend stay notImpl)
 *   file    — notImpl (needs upload/download infra, v0.4h+)
 *   system  — getOnlineStatus, setOnlineStatus (notImpl), getKernelTime
 *   msg     — send (existing v0.4d-α), recall/fetch/fetchHistory notImpl
 *
 * Out of scope: nickname auto-resolve for `friend.list` entries — we leave
 * `nick: ''` rather than chain N profile-service IPCs; v0.4g will batch via
 * profileService.getCoreAndBaseInfo.
 */

import type {
  NTApis,
  NTGroupInfo,
  NTGroupMember,
  NTFriendEntry,
  NTPeer,
  NTUserProfile,
  NodeIQQNTWrapperSession,
  ProbeAttempt,
  ProbeReport,
  SelfInfo,
} from '@qanyicat/core';
import type { UidUinCache } from './uid-uin-cache';
import type { MsgIndex } from './msg-index';
import type { MediaIndex } from './media-index';
import type { DownloadWaiters } from './download-wait';
import type { SelfSendWaiter } from './self-send-wait';
import {
  stageImageForSend,
  stageFileForSend,
  stagePttForSend,
  stageVideoForSend,
  looksLikeMd5,
  type ImageUploadDeps,
} from './image-upload';
import { enumerateNativeServiceMethods } from './napi-introspect';

type Log = (line: string) => void;

interface SendMsgDep extends ImageUploadDeps {
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
  /** v0.4i-β-1: fetch up to N specific messages by their NT msgId. */
  getMsgsByMsgId?(
    peer: { chatType: number; peerUid: string; guildId: string },
    msgIds: string[]
  ): Promise<{ result: number; errMsg: string; msgList?: Array<Record<string, unknown>> }>;
  getMsgsIncludeSelf?(
    peer: { chatType: number; peerUid: string; guildId: string },
    ntMsgId: string,
    count: number,
    queryOrder: boolean
  ): Promise<{ result: number; errMsg: string; msgList?: Array<Record<string, unknown>> }>;
  getAioFirstViewLatestMsgs?(
    peer: { chatType: number; peerUid: string; guildId: string },
    num: number
  ): Promise<{ result: number; errMsg: string; msgList?: Array<Record<string, unknown>> }>;
  /** v0.4n-α: download a rich-media element by ids; completion via listener. */
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
  /** v0.4m-α: forward a chain of existing messages. */
  multiForwardMsgWithComment?(
    msgInfos: Array<{ msgId: string; senderShowName: string }>,
    srcContact: { chatType: number; peerUid: string; guildId: string },
    dstContact: { chatType: number; peerUid: string; guildId: string },
    commentElements: unknown[],
    extra: Map<unknown, unknown>
  ): Promise<{ result: number; errMsg: string; msgId?: string; msgSeq?: string; msgTime?: string }>;
}

/** Convert an NT raw msg payload (kernel-side shape) into the NTRawMessage we emit. */
function ntPayloadToRawMessage(m: Record<string, unknown>): import('@qanyicat/core').NTRawMessage {
  const chatTypeRaw = m.chatType as number;
  const peerUid = String(m.peerUid ?? '');
  const peerUinRaw = String(m.peerUin ?? '');
  const peer: NTPeer = chatTypeRaw === 2
    ? { chatType: 'group', peerUid, groupCode: peerUid }
    : { chatType: 'private', peerUid, ...(peerUinRaw && peerUinRaw !== '0' ? { peerUin: peerUinRaw } : {}) };
  const senderUin = String(m.senderUin ?? '');
  return {
    msgId: String(m.msgId ?? ''),
    msgSeq: String(m.msgSeq ?? ''),
    msgRandom: String(m.msgRandom ?? ''),
    msgTime: String(m.msgTime ?? ''),
    peer,
    senderUid: String(m.senderUid ?? ''),
    ...(senderUin && senderUin !== '0' ? { senderUin } : {}),
    ...(m.sendNickName !== undefined && m.sendNickName !== '' ? { sendNickName: String(m.sendNickName) } : {}),
    ...(m.sendMemberName !== undefined ? { sendMemberName: String(m.sendMemberName) } : {}),
    elements: (m.elements as import('@qanyicat/core').NTRawMessage['elements']) ?? [],
  };
}

/**
 * Walk `sendMsg` elements and stage any PIC element whose `md5HexStr` is a
 * local file path (not yet content-addressed). Replaces the element's
 * metadata in-place so the subsequent `msgService.sendMsg` call sees a
 * fully-prepared picElement.
 */
async function prepareImageElements(elements: unknown[], msgService: SendMsgDep, log: Log): Promise<void> {
  for (const el of elements as Array<Record<string, unknown>>) {
    if (!el || el.elementType !== 2) continue;
    const pic = el.picElement as Record<string, unknown> | undefined;
    if (!pic) continue;
    const raw = String(pic.md5HexStr ?? '');
    if (!raw || looksLikeMd5(raw)) continue; // already prepared
    try {
      const staged = await stageImageForSend(raw, msgService);
      pic.md5HexStr = staged.md5HexStr;
      pic.fileSize = staged.fileSize;
      pic.fileName = staged.fileName;
      pic.sourcePath = staged.sourcePath;
      pic.picWidth = staged.picWidth;
      pic.picHeight = staged.picHeight;
      pic.picType = staged.picType;
      log(`image staged: ${staged.fileName} ${staged.fileSize}B ${staged.picWidth}x${staged.picHeight} → ${staged.sourcePath}`);
    } catch (e) {
      throw new Error(`image upload failed for ${raw}: ${(e as Error).message}`);
    }
  }
}

/**
 * Walk send-msg elements and stage any FILE element whose `fileMd5` is a
 * local file path (not yet content-addressed). Mirror of prepareImageElements
 * for v0.4h-γ. Wire form: `{type:'file', data:{file:'<path|url|base64>', name?:'…'}}`.
 */
async function prepareFileElements(elements: unknown[], msgService: SendMsgDep, log: Log): Promise<void> {
  for (const el of elements as Array<Record<string, unknown>>) {
    if (!el || el.elementType !== 3) continue;
    const file = el.fileElement as Record<string, unknown> | undefined;
    if (!file) continue;
    const raw = String(file.fileMd5 ?? '');
    if (!raw || looksLikeMd5(raw)) continue;
    const displayName = file.fileName ? String(file.fileName) : undefined;
    // segmentsToNtElements sets fileName to `seg.data.name ?? seg.data.file`,
    // so when name= isn't supplied the fileName ends up as the raw path. Drop
    // that fallback when it equals the raw input so the on-disk basename wins.
    const cleanedDisplayName = displayName === raw ? undefined : displayName;
    try {
      const staged = await stageFileForSend(raw, cleanedDisplayName, msgService);
      file.fileMd5 = staged.fileMd5;
      file.fileSize = staged.fileSize;
      file.fileName = staged.fileName;
      file.filePath = staged.filePath;
      log(`file staged: ${staged.fileName} ${staged.fileSize}B → ${staged.filePath}`);
    } catch (e) {
      throw new Error(`file upload failed for ${raw}: ${(e as Error).message}`);
    }
  }
}

/**
 * v0.4h-δ: walk send-msg elements and stage any PTT element whose md5HexStr
 * looks like a path (not yet content-addressed). Populates the full
 * pttElement shape so NT accepts the send.
 *
 * Wire form: `{type:'voice', data:{file:'<path|url|base64>', duration?: number}}`.
 * Caveat: NT documents SILK as the on-wire format. We accept arbitrary audio
 * but log non-SILK inputs loudly — the recipient's client may or may not be
 * able to play them. Real silk encoding is v0.4h-ε.
 */
async function prepareVoiceElements(elements: unknown[], msgService: SendMsgDep, log: Log): Promise<void> {
  // Hardcoded waveform — 15 bins of "looks like a voice clip" data.
  // Used purely for the visual waveform on the recipient client.
  const defaultWaveAmplitudes = [0, 18, 9, 23, 16, 17, 16, 15, 44, 17, 24, 20, 14, 15, 17];
  for (const el of elements as Array<Record<string, unknown>>) {
    if (!el || el.elementType !== 4) continue;
    const ptt = el.pttElement as Record<string, unknown> | undefined;
    if (!ptt) continue;
    const raw = String(ptt.md5HexStr ?? '');
    if (!raw || looksLikeMd5(raw)) continue;
    const overrideDuration = typeof ptt.duration === 'number' ? ptt.duration : undefined;
    try {
      const staged = await stagePttForSend(raw, overrideDuration, msgService);
      ptt.md5HexStr = staged.md5HexStr;
      ptt.fileSize = staged.fileSize;
      ptt.fileName = staged.fileName;
      ptt.filePath = staged.filePath;
      ptt.duration = staged.duration;
      ptt.formatType = 1;
      ptt.voiceType = 1;
      ptt.voiceChangeType = 0;
      ptt.canConvert2Text = true;
      ptt.waveAmplitudes = defaultWaveAmplitudes;
      ptt.fileSubId = '';
      ptt.playState = 1;
      ptt.autoConvertText = 0;
      ptt.storeID = 0;
      ptt.otherBusinessInfo = { aiVoiceType: 0 };
      log(`voice staged: ${staged.fileName} ${staged.fileSize}B route=${staged.route} dur=${staged.duration}s → ${staged.filePath}`);
    } catch (e) {
      throw new Error(`voice upload failed for ${raw}: ${(e as Error).message}`);
    }
  }
}

/**
 * v0.4h-δ: walk send-msg elements and stage any VIDEO element whose
 * `videoMd5` looks like a path. Probes MP4 dimensions / duration from the
 * file's moov boxes (best-effort) and stages a placeholder thumbnail (NT
 * requires SOMETHING under the matching Thumb directory; ffmpeg-derived
 * real thumbs are deferred).
 *
 * Wire form: `{type:'video', data:{file:'<path|url|base64>'}}`.
 */
async function prepareVideoElements(elements: unknown[], msgService: SendMsgDep, log: Log): Promise<void> {
  for (const el of elements as Array<Record<string, unknown>>) {
    if (!el || el.elementType !== 5) continue;
    const video = el.videoElement as Record<string, unknown> | undefined;
    if (!video) continue;
    const raw = String(video.videoMd5 ?? '');
    if (!raw || looksLikeMd5(raw)) continue;
    try {
      const staged = await stageVideoForSend(raw, msgService);
      video.videoMd5 = staged.videoMd5;
      video.fileSize = staged.fileSize;
      video.fileName = staged.fileName;
      video.filePath = staged.filePath;
      video.thumbMd5 = staged.thumbMd5;
      video.thumbSize = staged.thumbSize;
      video.thumbWidth = staged.thumbWidth;
      video.thumbHeight = staged.thumbHeight;
      video.thumbPath = staged.thumbPath;
      video.fileTime = staged.fileTime;
      log(`video staged: ${staged.fileName} ${staged.fileSize}B ${staged.thumbWidth}x${staged.thumbHeight} dur=${staged.fileTime}s → ${staged.filePath}`);
    } catch (e) {
      throw new Error(`video upload failed for ${raw}: ${(e as Error).message}`);
    }
  }
}

function ntChatTypeOf(peer: NTPeer): number {
  return peer.chatType === 'group' ? 2 : 1;
}

// ─── Group listener: maintains an in-memory snapshot of the group list ──────

interface RawGroup {
  groupCode: string;
  groupName: string;
  memberCount: number;
  maxMember: number;
  memberRole: number; // 4=owner, 3=admin, 2=member (from observed NT data)
}

export class GroupListCache {
  private byCode = new Map<string, NTGroupInfo>();
  private firstUpdate: Promise<void>;
  private resolveFirstUpdate: (() => void) | null = null;

  constructor() {
    this.firstUpdate = new Promise((res) => { this.resolveFirstUpdate = res; });
  }

  /** Returns a listener object satisfying wrapper.node's duck-typed contract. */
  buildListener(log: Log) {
    return {
      onGroupListUpdate: (_updateType: unknown, groupList: unknown) => {
        if (!Array.isArray(groupList)) return;
        for (const g of groupList as RawGroup[]) {
          if (!g || !g.groupCode) continue;
          this.byCode.set(g.groupCode, {
            groupCode: g.groupCode,
            groupName: g.groupName ?? '',
            memberCount: g.memberCount ?? 0,
            maxMember: g.maxMember ?? 0,
            owner: '', // NT's group payload doesn't carry owner uid directly here
          });
        }
        log(`group-list update: ${groupList.length} entries, cache size=${this.byCode.size}`);
        if (this.resolveFirstUpdate) {
          this.resolveFirstUpdate();
          this.resolveFirstUpdate = null;
        }
      },
    };
  }

  async list(triggerRefresh: () => Promise<void>, timeoutMs = 3000): Promise<NTGroupInfo[]> {
    if (this.byCode.size === 0) {
      // Trigger a refresh and wait for the listener to fire — with a timeout
      // so callers never hang on an empty account.
      const refresh = triggerRefresh().catch(() => undefined);
      const wait = new Promise<void>((res) => { setTimeout(res, timeoutMs); });
      await Promise.race([this.firstUpdate, wait, refresh]);
    }
    return Array.from(this.byCode.values());
  }

  info(groupCode: string): NTGroupInfo | undefined {
    return this.byCode.get(groupCode);
  }

  upsert(entry: NTGroupInfo): void {
    this.byCode.set(entry.groupCode, entry);
  }
}

// ─── NTApi factory ──────────────────────────────────────────────────────────

export interface RichMediaServiceDep {
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
  downloadFileForModelId?(
    peer: { chatType: number; peerUid: string; guildId: string },
    modelIds: string[],
    unknown: string
  ): Promise<{ result?: number; errMsg?: string }>;
}

export function buildNTApis(
  session: NodeIQQNTWrapperSession,
  msgService: SendMsgDep,
  cache: UidUinCache,
  selfInfo: SelfInfo,
  groupCache: GroupListCache,
  msgIndex: MsgIndex,
  mediaIndex: MediaIndex,
  richMediaService: RichMediaServiceDep | undefined,
  downloadWaiters: DownloadWaiters,
  selfSendWaiter: SelfSendWaiter,
  log: Log
): NTApis {
  const s = session as unknown as Record<string, () => Record<string, (...a: unknown[]) => unknown>>;
  const groupSvc = s.getGroupService?.();
  const buddySvc = s.getBuddyService?.();

  const notImpl = (fn: string) => async () => { throw new Error(`[bridge] ${fn} not implemented yet`); };

  const send: NTApis['msg']['send'] = async ({ peer, elements }) => {
    const ntChatType = peer.chatType === 'group' ? 2 : 1;
    let peerUid = String(peer.peerUid);
    if (ntChatType === 1 && /^\d+$/.test(peerUid)) {
      const resolved = await cache.resolveUid(peerUid);
      if (!resolved) throw new Error(`uin "${peerUid}" not resolvable to uid yet`);
      peerUid = resolved;
    }
    // v0.4h-α/β: stage any local-path image segments into NT's cache before send.
    await prepareImageElements(elements as unknown[], msgService, log);
    // v0.4h-γ: same for file segments.
    await prepareFileElements(elements as unknown[], msgService, log);
    // v0.4h-δ: same for voice / video segments.
    await prepareVoiceElements(elements as unknown[], msgService, log);
    await prepareVideoElements(elements as unknown[], msgService, log);
    const result = await msgService.sendMsg('0', { chatType: ntChatType, peerUid, guildId: '' }, elements as unknown[], new Map());
    if (!result || result.result !== 0) throw new Error(`sendMsg failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
    return { msgId: result.msgId ?? '', msgSeq: result.msgSeq ?? '', msgTime: result.msgTime ?? '' };
  };

  const user: NTApis['user'] = {
    getProfile: async (uid: string): Promise<NTUserProfile> => {
      const uin = await cache.resolveUin(uid);
      let nick = cache.getNick(uid) ?? '';
      if (!nick) {
        // On miss, try a one-off fetch for this single uid.
        await cache.primeNicks([uid]).catch(() => undefined);
        nick = cache.getNick(uid) ?? '';
      }
      return { uid, uin, nick };
    },
    getSelfInfo: async () => ({ uid: selfInfo.uid, uin: selfInfo.uin, nick: selfInfo.nick ?? '' }),
    uinToUid: async (uin: string) => (await cache.resolveUid(uin)) || null,
    uidToUin: async (uid: string) => (await cache.resolveUin(uid)) || null,
  };

  const group: NTGroupApiLike = {
    list: async () => {
      if (!groupSvc) return [];
      return groupCache.list(async () => {
        // Trigger a fetch — NT pushes the result through the listener.
        try { await (groupSvc.getGroupList as (force: boolean) => Promise<unknown>)(true); }
        catch (e) { log(`group.list trigger threw: ${(e as Error).message}`); }
      });
    },

    info: async (groupCode: string) => {
      const cached = groupCache.info(groupCode);
      if (!cached) throw new Error(`group ${groupCode} not in cache; call list() first`);
      if (cached.owner) return cached;
      // Derive owner uid from the member list (role=owner). Best-effort; if
      // members fetch fails we just return the cached entry with empty owner.
      try {
        const members = await group.members(groupCode);
        const owner = members.find((m) => m.role === 'owner');
        if (owner) {
          const withOwner = { ...cached, owner: owner.uid };
          groupCache.upsert(withOwner);
          return withOwner;
        }
      } catch {
        // ignore
      }
      return cached;
    },

    members: async (groupCode: string) => {
      if (!groupSvc) return [];
      const result = await (groupSvc.getAllMemberList as (gc: string, force: boolean) => Promise<{
        result?: { infos?: Map<string, { uid: string; uin: string; nick: string; cardName?: string; role: number }> };
      }>)(groupCode, false);
      const infos = result?.result?.infos;
      if (!infos) return [];
      const out: NTGroupMember[] = [];
      // infos may be a Map OR a plain {[uid]: GroupMember} object — handle both.
      type Member = { uid: string; uin: string; nick: string; cardName?: string; role: number };
      const infosUnknown = infos as unknown;
      const iter: Iterable<[string, Member]> =
        typeof (infosUnknown as { entries?: unknown }).entries === 'function'
          ? (infosUnknown as Map<string, Member>).entries()
          : Object.entries(infosUnknown as Record<string, Member>);
      for (const [, m] of iter) {
        cache.put(m.uid, m.uin);
        if (m.nick) cache.putNick(m.uid, m.nick);
        out.push({
          uid: m.uid,
          uin: m.uin,
          nick: m.nick ?? '',
          ...(m.cardName ? { card: m.cardName } : {}),
          role: m.role === 4 ? 'owner' : m.role === 3 ? 'admin' : 'member',
        });
      }
      return out;
    },

    kick: async (groupCode, uid, reject) => {
      if (!groupSvc?.kickMember) throw new Error('kickMember not available');
      await (groupSvc.kickMember as (gc: string, uids: string[], refuse: boolean, reason: string) => Promise<void>)(
        groupCode, [uid], reject, ''
      );
    },

    mute: async (groupCode, uid, durationSec) => {
      if (!groupSvc?.setMemberShutUp) throw new Error('setMemberShutUp not available');
      await (groupSvc.setMemberShutUp as (gc: string, list: { uid: string; timeStamp: number }[]) => Promise<unknown>)(
        groupCode, [{ uid, timeStamp: durationSec }]
      );
    },

    muteAll: async (groupCode, enable) => {
      if (!groupSvc?.setGroupShutUp) throw new Error('setGroupShutUp not available');
      await (groupSvc.setGroupShutUp as (gc: string, enable: boolean) => Promise<unknown>)(groupCode, enable);
    },

    setCard: async (groupCode, uid, card) => {
      if (!groupSvc?.modifyMemberCardName) throw new Error('modifyMemberCardName not available');
      (groupSvc.modifyMemberCardName as (gc: string, uid: string, card: string) => void)(groupCode, uid, card);
    },

    setAdmin: async (groupCode, uid, isAdmin) => {
      if (!groupSvc?.modifyMemberRole) throw new Error('modifyMemberRole not available');
      // NTGroupMemberRole: 3 = admin, 2 = member (from observed NT usage)
      (groupSvc.modifyMemberRole as (gc: string, uid: string, role: number) => void)(groupCode, uid, isAdmin ? 3 : 2);
    },

    /**
     * v0.4o: accept / reject incoming group join (or self-invite) request.
     * `flag` encoded by CoreToUnified: `${seq}|${type}|${groupCode}|${doubt?1:0}`
     * NT's `operateSysNotify(doubt, {operateType, targetMsg: {seq, type, groupCode, postscript}})`
     * — operateType 1=AGREE, 2=REFUSE per NTGroupRequestOperateTypes.
     */
    handleJoinRequest: async (flag: string, accept: boolean, reason?: string) => {
      if (!groupSvc?.operateSysNotify) throw new Error('groupService.operateSysNotify not available');
      const [seq, typeStr, gc, doubtRaw] = flag.split('|');
      if (!seq || !typeStr || !gc) throw new Error(`group.handleJoinRequest: malformed flag "${flag}"`);
      const doubt = doubtRaw === '1';
      log(`group.handleJoinRequest gc=${gc} seq=${seq} type=${typeStr} doubt=${doubt} accept=${accept}`);
      await (groupSvc.operateSysNotify as (
        doubt: boolean,
        arg: { operateType: number; targetMsg: { seq: string; type: number; groupCode: string; postscript: string } }
      ) => Promise<unknown>)(doubt, {
        operateType: accept ? 1 : 2,
        targetMsg: {
          seq,
          type: Number(typeStr),
          groupCode: gc,
          // Note: passing empty `''` may make NT silently drop the op;
          // default to a single space so the kernel always has a postscript.
          postscript: reason ?? ' ',
        },
      });
    },
  };

  const buddySvcAny = buddySvc as unknown as {
    reqToAddFriends?(...args: unknown[]): void | Promise<unknown>;
    approvalFriendRequest?(arg: { friendUid: string; reqTime: string; accept: boolean }): Promise<unknown>;
    approvalDoubtBuddyReq?(uid: string, str1: string, str2: string): unknown;
    setBuddyRemark?(arg: { friendUid: string; remark: string }): Promise<unknown>;
  } | undefined;
  const sessionAny = session as unknown as Record<string, () => unknown>;
  const addBuddySvc = (sessionAny.getAddBuddyService?.() ?? sessionAny.getNodeIKernelAddBuddyService?.()) as unknown as {
    addBuddy?(...args: unknown[]): unknown;
    requestInfoByAccount?(...args: unknown[]): unknown;
    queryUinSafetyFlag?(...args: unknown[]): unknown;
    getAddBuddyRequestTag?(...args: unknown[]): unknown;
  } | undefined;

  /**
   * v0.4k probe: try every plausible call signature in order, capturing each
   * outcome so the smoke test can show which one actually reaches the target.
   * Returns the FULL transcript — the wire client decides whether to retry.
   */
  async function runSendRequestProbe(peer: { uid?: string; uin?: string }, comment?: string): Promise<ProbeReport> {
    let uid = peer.uid ?? '';
    if (!uid && peer.uin) uid = (await cache.resolveUid(peer.uin)) || '';
    const uin = peer.uin ?? (uid ? (await cache.resolveUin(uid)) ?? '' : '');
    const msg = comment ?? '';
    const attempts: ProbeAttempt[] = [];

    const safeStr = (v: unknown): string => {
      try { return typeof v === 'string' ? v : JSON.stringify(v); }
      catch { return String(v); }
    };
    const safeResult = (v: unknown): unknown => {
      try { JSON.stringify(v); return v; } catch { return safeStr(v); }
    };
    async function tryCall(label: string, fn: () => unknown): Promise<void> {
      try {
        const result = await Promise.resolve(fn());
        attempts.push({ call: label, outcome: 'ok', detail: safeStr(result).slice(0, 240), result: safeResult(result) });
      } catch (e) {
        attempts.push({ call: label, outcome: 'throw', detail: (e as Error).message.slice(0, 240) });
      }
    }

    // ── buddyService.reqToAddFriends — argc==1, single object ──────────────
    // Yesterday's smoke proved: passing {friendUid:'', ...} returns result:255
    // (NT silently rejects). Try variants with friendUin (uin-routed) and
    // multi-step (requestInfoByAccount may materialize the uid in NT's cache
    // for a follow-up reqToAddFriends to succeed).
    if (buddySvcAny?.reqToAddFriends) {
      // 1a. Existing shape with empty friendUid → expect result:255
      await tryCall(
        'buddyService.reqToAddFriends({friendUid,reqMsg,sourceId:3001})',
        () => buddySvcAny.reqToAddFriends!({ friendUid: uid, reqMsg: msg, sourceId: 3001 })
      );
      // 1b. Uin-routed (in case NT accepts a friendUin field)
      if (uin) {
        await tryCall(
          'buddyService.reqToAddFriends({friendUin,reqMsg,sourceId:3001})',
          () => buddySvcAny.reqToAddFriends!({ friendUin: uin, reqMsg: msg, sourceId: 3001 })
        );
        await tryCall(
          'buddyService.reqToAddFriends({uin,reqMsg,sourceId:3001})',
          () => buddySvcAny.reqToAddFriends!({ uin, reqMsg: msg, sourceId: 3001 })
        );
      }
    } else {
      attempts.push({ call: 'buddyService.reqToAddFriends', outcome: 'throw', detail: 'method not available on this kernel' });
    }

    // ── addBuddyService — argc==3 confirmed via boot probe ──────────────────
    if (addBuddySvc) {
      if (uin) {
        // Diagnostic preflight — known to succeed, capture rsp for follow-up.
        await tryCall(
          "addBuddyService.queryUinSafetyFlag('FriendsServiceImpl', {uin}, {})",
          () => addBuddySvc.queryUinSafetyFlag!('FriendsServiceImpl', { uin }, {})
        );
        await tryCall(
          "addBuddyService.requestInfoByAccount('FriendsServiceImpl', {uin}, {})",
          () => addBuddySvc.requestInfoByAccount!('FriendsServiceImpl', { uin }, {})
        );
      }
      // Probe v3: "Cannot convert undefined or null to object" suggests NT
      // destructures a required NESTED field from arg2. Other addBuddyService
      // methods consistently wrap user identity as `{targetInfo: {uid, uin,
      // phoneNum, openid}}` — mirror that shape.
      if (uin) {
        const targetInfo = { uid: null, uin, phoneNum: null, openid: null };
        await tryCall(
          "addBuddyService.addBuddy('FriendsServiceImpl', {targetInfo, reqMsg, sourceId:3001}, {})",
          () => addBuddySvc.addBuddy!('FriendsServiceImpl', { targetInfo, reqMsg: msg, sourceId: 3001 }, {})
        );
        await tryCall(
          "addBuddyService.addBuddy('FriendsServiceImpl', {targetInfo, reqMsg, sourceId:3001, friendRemark:''}, {})",
          () => addBuddySvc.addBuddy!('FriendsServiceImpl', { targetInfo, reqMsg: msg, sourceId: 3001, friendRemark: '' }, {})
        );
        // NT may want the exact `req` block requestInfoByAccount yields, i.e.
        // {uid:null, uin, phoneNum:null, openid:null} at the TOP level of arg2,
        // not under targetInfo.
        await tryCall(
          "addBuddyService.addBuddy('FriendsServiceImpl', {uid:null,uin,phoneNum:null,openid:null,reqMsg,sourceId:3001}, {})",
          () => addBuddySvc.addBuddy!('FriendsServiceImpl', { uid: null, uin, phoneNum: null, openid: null, reqMsg: msg, sourceId: 3001 }, {})
        );
        // arg3 with explicit context (mirror requestInfoByAccount's req.context shape)
        await tryCall(
          "addBuddyService.addBuddy('FriendsServiceImpl', {targetInfo, reqMsg, sourceId:3001}, {callFrom:'FriendsServiceImpl'})",
          () => addBuddySvc.addBuddy!('FriendsServiceImpl', { targetInfo, reqMsg: msg, sourceId: 3001 }, { callFrom: 'FriendsServiceImpl' })
        );
        // Multi-step: requestInfoByAccount FIRST → then addBuddy with targetInfo.
        await tryCall(
          "multistep: requestInfoByAccount → addBuddy('FriendsServiceImpl', {targetInfo, reqMsg, sourceId:3001}, {})",
          async () => {
            await Promise.resolve(addBuddySvc.requestInfoByAccount!('FriendsServiceImpl', { uin }, {}));
            return addBuddySvc.addBuddy!('FriendsServiceImpl', { targetInfo, reqMsg: msg, sourceId: 3001 }, {});
          }
        );
        // Exhaustive: getAddBuddyRequestTag → addBuddy with the rsp tag/cookie.
        // We don't know the shape yet, but capture the tag so user can see it.
        await tryCall(
          "addBuddyService.getAddBuddyRequestTag('FriendsServiceImpl', {uin}, {})",
          () => addBuddySvc.getAddBuddyRequestTag!('FriendsServiceImpl', { uin }, {})
        );
      }
      // Old uid-based shape for comparison
      if (uid) {
        await tryCall(
          "addBuddyService.addBuddy('FriendsServiceImpl', {friendUid,reqMsg,sourceId:3001}, {})",
          () => addBuddySvc.addBuddy!('FriendsServiceImpl', { friendUid: uid, reqMsg: msg, sourceId: 3001 }, {})
        );
      }
      // 0-arg argc reminder (kept for completeness)
      await tryCall(
        'addBuddyService.addBuddy() — argc probe',
        () => addBuddySvc.addBuddy!()
      );
    } else {
      attempts.push({ call: 'addBuddyService', outcome: 'throw', detail: 'session.getAddBuddyService() returned undefined' });
    }

    return {
      services: { buddyService: !!buddySvcAny, addBuddyService: !!addBuddySvc },
      // v0.4k fix (fact #72): addBuddyService methods are prototype-bound, not
      // own properties; Object.keys returns []. Walk the prototype chain instead.
      addBuddyMethods: addBuddySvc ? enumerateNativeServiceMethods(addBuddySvc as object) : [],
      attempts,
    };
  }

  const friend: NTFriendApiLike = {
    sendRequest: async (peer, comment) => {
      // v0.4k: the WORKING path is `addBuddyService.addBuddy('FriendsServiceImpl',
      //   {targetInfo: {uid:null, uin, phoneNum:null, openid:null}, reqMsg, sourceId:3001},
      //   {})`. Verified live: outer `result:0` + NT-server processes the request.
      // `buddyService.reqToAddFriends` consistently returns `{result:255}` for
      // any shape we tried — kept here as a fallback only.
      const uin = peer.uin ?? (peer.uid ? (await cache.resolveUin(peer.uid)) ?? '' : '');
      if (!uin) throw new Error('sendRequest: need a uin (uid → uin lookup also failed)');
      const reqMsg = comment ?? '';

      if (addBuddySvc?.addBuddy) {
        const targetInfo = { uid: null, uin, phoneNum: null, openid: null };
        log(`friend.sendRequest via addBuddy uin=${uin} comment="${reqMsg.slice(0, 40)}"`);
        const raw = await Promise.resolve(
          addBuddySvc.addBuddy('FriendsServiceImpl', { targetInfo, reqMsg, sourceId: 3001 }, {})
        ) as {
          result?: number;
          errMsg?: string;
          rsp?: { result?: number; errorCode?: number; errorString?: string };
        } | undefined;
        if (!raw || raw.result !== 0) {
          throw new Error(`addBuddy outer failed: result=${raw?.result} errMsg=${raw?.errMsg ?? ''}`);
        }
        // NT signals server-side rejection via rsp.errorCode/errorString.
        // rsp.result==1 with errorCode==0 has been seen on risk-controlled
        // accounts where NT accepts the call but won't deliver — surface that
        // distinctly via warn log; caller still gets `void` success.
        const rsp = raw.rsp;
        if (rsp?.errorCode && rsp.errorCode !== 0) {
          throw new Error(`addBuddy rsp errorCode=${rsp.errorCode} errorString=${rsp.errorString ?? ''}`);
        }
        if (rsp && rsp.result !== 0) {
          log(`WARN addBuddy accepted but rsp.result=${rsp.result} (often = account risk-controlled / target may not receive)`);
        }
        return;
      }

      // Fallback — buddyService.reqToAddFriends (known to return result:255 on
      // all observed shapes, but keep for kernels where addBuddyService is absent).
      if (!buddySvcAny?.reqToAddFriends) throw new Error('neither addBuddyService.addBuddy nor buddyService.reqToAddFriends available');
      let uid = peer.uid ?? '';
      if (!uid && peer.uin) uid = (await cache.resolveUid(peer.uin)) || '';
      if (!uid) throw new Error('sendRequest fallback: cannot resolve peer to a uid');
      const result = await Promise.resolve(
        buddySvcAny.reqToAddFriends({ friendUid: uid, reqMsg, sourceId: 3001 })
      ) as { result?: number; errMsg?: string } | undefined;
      if (!result || result.result !== 0) {
        throw new Error(`reqToAddFriends failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
      }
    },
    sendRequestProbe: runSendRequestProbe,
    list: async () => {
      if (!buddySvc?.getBuddyListV2) return [];
      const result = await (buddySvc.getBuddyListV2 as (cb: string, isRefresh: boolean, t: number) => Promise<{
        data?: Array<{ categroyName?: string; buddyUids: string[] }>;
      }>)('0', false, 0);
      // Make sure every uid has a nick cached before we synthesize the result.
      // primeNicks failure was previously swallowed silently — the bot would
      // get a friend list with empty nicks and no clue why. Log so it's at
      // least visible in the loader log; we still proceed so callers get
      // partial data rather than a hard fail.
      const allUids = (result?.data ?? []).flatMap((c) => c.buddyUids ?? []);
      await cache.primeNicks(allUids).catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        log(`WARN friend.list primeNicks failed (${allUids.length} uids); nicks may be empty: ${msg}`);
      });

      const out: NTFriendEntry[] = [];
      for (const cat of result?.data ?? []) {
        for (const uid of cat.buddyUids ?? []) {
          const uin = await cache.resolveUin(uid);
          out.push({
            uid,
            uin: uin || '',
            nick: cache.getNick(uid) ?? '',
            ...(cat.categroyName ? { category: cat.categroyName } : {}),
          });
        }
      }
      return out;
    },
    /**
     * v0.4o: accept / reject incoming friend request.
     * `flag` encoded by CoreToUnified: `${uid}|${reqTime}|${doubt?1:0}`
     */
    handleRequest: async (flag: string, accept: boolean, remark?: string) => {
      const [uid, reqTime, doubtRaw] = flag.split('|');
      if (!uid) throw new Error(`friend.handleRequest: malformed flag "${flag}"`);
      const doubt = doubtRaw === '1';
      if (doubt) {
        if (!buddySvcAny?.approvalDoubtBuddyReq) throw new Error('buddyService.approvalDoubtBuddyReq not available');
        if (!accept) log(`WARN friend.handleRequest: NT 9.9's approvalDoubtBuddyReq has no reject path; ignoring accept=false`);
        await Promise.resolve(buddySvcAny.approvalDoubtBuddyReq(uid, '', ''));
      } else {
        if (!buddySvcAny?.approvalFriendRequest) throw new Error('buddyService.approvalFriendRequest not available');
        log(`friend.handleRequest uid=${uid} reqTime=${reqTime} accept=${accept}`);
        await buddySvcAny.approvalFriendRequest({ friendUid: uid, reqTime: reqTime ?? '', accept });
      }
      // Best-effort remark on accept; ignore if the method is missing.
      if (accept && remark && buddySvcAny?.setBuddyRemark) {
        try { await buddySvcAny.setBuddyRemark({ friendUid: uid, remark }); }
        catch (e) { log(`friend.handleRequest setBuddyRemark threw: ${(e as Error).message}`); }
      }
    },
    deleteFriend: notImpl('friend.deleteFriend') as NTApis['friend']['deleteFriend'],
  };

  const system: NTApis['system'] = {
    getOnlineStatus: async () => (selfInfo.online ? 'online' : 'offline'),
    setOnlineStatus: notImpl('system.setOnlineStatus') as NTApis['system']['setOnlineStatus'],
    getKernelTime: async () => Date.now(),
  };

  const fileStub = new Proxy({} as Record<string, unknown>, {
    get(_t, prop: string) { return notImpl(`file.${prop}`); },
  });

  const recall: NTApis['msg']['recall'] = async (peer, msgIds) => {
    if (!msgService.recallMsg) throw new Error('msgService.recallMsg not available on this kernel');
    const ntPeer = { chatType: ntChatTypeOf(peer), peerUid: String(peer.peerUid), guildId: '' };
    const result = await msgService.recallMsg(ntPeer, msgIds);
    if (!result || result.result !== 0) {
      throw new Error(`recallMsg failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
    }
  };

  const findByCompositeId: NTApis['msg']['findByCompositeId'] = async (messageId) => {
    return msgIndex.get(messageId) ?? null;
  };

  const fetch: NTApis['msg']['fetch'] = async (peer, msgId) => {
    if (!msgService.getMsgsByMsgId) throw new Error('msgService.getMsgsByMsgId not available on this kernel');
    const ntPeer = { chatType: ntChatTypeOf(peer), peerUid: String(peer.peerUid), guildId: '' };
    const result = await msgService.getMsgsByMsgId(ntPeer, [msgId]);
    if (!result || result.result !== 0) {
      throw new Error(`getMsgsByMsgId failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
    }
    const first = result.msgList && result.msgList[0];
    if (!first) return null;
    const raw = ntPayloadToRawMessage(first);
    mediaIndex.indexFromRaw(raw);
    return raw;
  };

  const fetchHistory: NTApis['msg']['fetchHistory'] = async (peer, count, anchorMsgId) => {
    const ntChatType = ntChatTypeOf(peer);
    let peerUid = String(peer.peerUid);
    if (ntChatType === 1 && /^\d+$/.test(peerUid)) {
      const resolved = await cache.resolveUid(peerUid);
      if (!resolved) throw new Error(`uin "${peerUid}" not resolvable to uid yet`);
      peerUid = resolved;
    }
    const ntPeer = { chatType: ntChatType, peerUid, guildId: '' };

    // Two NT APIs — `getMsgsIncludeSelf` for anchored pagination,
    // `getAioFirstViewLatestMsgs` for "latest N without anchor". Confirmed
    // empirically: `getMsgsBySeqAndCount` does NOT yield "latest" for seq='0'.
    let result: { result: number; errMsg: string; msgList?: Array<Record<string, unknown>> } | undefined;
    if (anchorMsgId) {
      // Resolve the composite to its NT msgId (the API takes ntMsgId, not seq).
      const resolved = msgIndex.get(anchorMsgId);
      const ntMsgId = resolved ? resolved.ntMsgId : anchorMsgId;
      if (!msgService.getMsgsIncludeSelf) throw new Error('msgService.getMsgsIncludeSelf not available on this kernel');
      result = await msgService.getMsgsIncludeSelf(ntPeer, ntMsgId, count, /*queryOrder=*/ true);
    } else {
      if (!msgService.getAioFirstViewLatestMsgs) throw new Error('msgService.getAioFirstViewLatestMsgs not available on this kernel');
      result = await msgService.getAioFirstViewLatestMsgs(ntPeer, count);
    }
    if (!result || result.result !== 0) {
      throw new Error(`history fetch failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
    }
    const raws = (result.msgList ?? []).map(ntPayloadToRawMessage);
    for (const r of raws) mediaIndex.indexFromRaw(r);
    return raws;
  };

  /**
   * Resolve a destination peer's `peerUid` field — for private chats with a
   * numeric uin in `peerUid`, translates to the opaque NT uid via cache.
   */
  const resolveDstPeerUid = async (dstPeer: NTPeer): Promise<{ chatType: number; peerUid: string; guildId: string }> => {
    const dstChatType = ntChatTypeOf(dstPeer);
    let dstPeerUid = String(dstPeer.peerUid);
    if (dstChatType === 1 && /^\d+$/.test(dstPeerUid)) {
      const resolved = await cache.resolveUid(dstPeerUid);
      if (!resolved) throw new Error(`dst uin "${dstPeerUid}" not resolvable to uid yet`);
      dstPeerUid = resolved;
    }
    return { chatType: dstChatType, peerUid: dstPeerUid, guildId: '' };
  };

  const multiForward: NTApis['msg']['multiForward'] = async (srcPeer, dstPeer, msgs) => {
    if (!msgService.multiForwardMsgWithComment) {
      throw new Error('msgService.multiForwardMsgWithComment not available on this kernel');
    }
    if (msgs.length === 0) {
      throw new Error('multiForward: msgs must not be empty');
    }
    const defaultShowName = selfInfo.nick || selfInfo.uin || '';
    const msgInfos = msgs.map((m) => ({
      msgId: m.ntMsgId,
      senderShowName: m.senderShowName ?? defaultShowName,
    }));
    const ntSrcPeer = { chatType: ntChatTypeOf(srcPeer), peerUid: String(srcPeer.peerUid), guildId: '' };
    const ntDstPeer = await resolveDstPeerUid(dstPeer);
    log(`msg.multiForward src=${ntSrcPeer.peerUid} dst=${ntDstPeer.peerUid} count=${msgs.length}`);
    const result = await msgService.multiForwardMsgWithComment(msgInfos, ntSrcPeer, ntDstPeer, [], new Map());
    if (!result || result.result !== 0) {
      throw new Error(`multiForwardMsgWithComment failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
    }
    // NT may not populate msgId on the synchronous return; the actual sent
    // ark element arrives via onAddSendMsg. Wire callers correlate via the
    // subsequent `message_sent` event (sender.uin === selfId, peer === dst).
    return { msgId: result.msgId ?? '', msgSeq: result.msgSeq ?? '', msgTime: result.msgTime ?? '' };
  };

  /**
   * v0.4m-β: send one fabricated message to self-private chat, return the
   * resulting NT msgId. Plants a SelfSendWaiter predicate BEFORE the sendMsg
   * call to avoid the race where `onAddSendMsg` fires before we await.
   */
  const sendOneToSelf = async (elements: unknown[]): Promise<string> => {
    const selfPeer = { chatType: 1, peerUid: selfInfo.uid, guildId: '' };
    // v0.4h+: stage any local-path media so fabricated forward chains can
    // include images / files / voice / video just like a normal send.
    await prepareImageElements(elements, msgService, log);
    await prepareFileElements(elements, msgService, log);
    await prepareVoiceElements(elements, msgService, log);
    await prepareVideoElements(elements, msgService, log);
    const waitP = selfSendWaiter.waitNext(
      (info) => info.chatType === 1 && info.peerUid === selfInfo.uid,
      10_000
    );
    const sendResult = await msgService.sendMsg('0', selfPeer, elements, new Map());
    if (!sendResult || sendResult.result !== 0) {
      // If sendMsg failed we won't get a listener event — abandon the waiter
      // by awaiting it briefly and swallowing the timeout. Easier than
      // cancelling.
      waitP.catch(() => undefined);
      throw new Error(`send-to-self failed: result=${sendResult?.result} errMsg=${sendResult?.errMsg ?? ''}`);
    }
    // Prefer the sync result if NT filled it (saves a roundtrip).
    if (sendResult.msgId) {
      waitP.catch(() => undefined);
      return sendResult.msgId;
    }
    const observed = await waitP;
    return observed.ntMsgId;
  };

  const multiForwardFabricated: NTApis['msg']['multiForwardFabricated'] = async (dstPeer, items) => {
    if (!msgService.multiForwardMsgWithComment) {
      throw new Error('msgService.multiForwardMsgWithComment not available on this kernel');
    }
    if (items.length === 0) {
      throw new Error('multiForwardFabricated: items must not be empty');
    }
    log(`msg.multiForwardFabricated dst=${String(dstPeer.peerUid)} count=${items.length}`);
    const msgInfos: Array<{ msgId: string; senderShowName: string }> = [];
    for (const item of items) {
      const ntMsgId = await sendOneToSelf(item.elements);
      msgInfos.push({ msgId: ntMsgId, senderShowName: item.senderShowName });
    }
    const ntSrcPeer = { chatType: 1, peerUid: selfInfo.uid, guildId: '' };
    const ntDstPeer = await resolveDstPeerUid(dstPeer);
    const result = await msgService.multiForwardMsgWithComment(msgInfos, ntSrcPeer, ntDstPeer, [], new Map());
    if (!result || result.result !== 0) {
      throw new Error(`multiForwardMsgWithComment(fabricated) failed: result=${result?.result} errMsg=${result?.errMsg ?? ''}`);
    }
    return { msgId: result.msgId ?? '', msgSeq: result.msgSeq ?? '', msgTime: result.msgTime ?? '' };
  };

  const toFileUrl = (localPath: string): string => {
    const normalized = localPath.replace(/\\/g, '/');
    return normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
  };

  const getMediaUrl: NTApis['msg']['getMediaUrl'] = async (file) => {
    const entry = mediaIndex.get(file);
    if (!entry) {
      log(`getMediaUrl: "${file}" not found in media index (evicted or never observed)`);
      return null;
    }
    // v0.4n-β: prefer NT's auto-cached local path — set by the listener when
    // NT writes the bytes to `nt_data/{Video,Pic,Ptt}/...Ori/<md5>.<ext>` on
    // receive. Sidesteps the `getVideoPlayUrlV2` rate-limit + the FILE
    // download-no-disk-write issue.
    if (entry.localCachePath) {
      log(`getMediaUrl cache-hit type=${entry.elementType} file=${file.slice(0, 16)}… → ${entry.localCachePath.slice(0, 80)}`);
      return { file, url: toFileUrl(entry.localCachePath) };
    }
    const ntPeer = { chatType: ntChatTypeOf(entry.peer), peerUid: String(entry.peer.peerUid), guildId: '' };
    if (entry.elementType === 5) {
      // VIDEO via NodeIKernelRichMediaService.getVideoPlayUrlV2.
      //
      // v0.4n-polish: `triggerType: 1` asks NT to also kick
      // off a background re-download — that's what trips the "后台频控，禁止
      // 自动下载！" rate limit (errCode 170013002) when called multiple times
      // on the same md5. `triggerType: 0` returns the URL passively (no
      // background download), which avoids the rate-limit hit for the
      // common "I just want the URL" case. Local-cache path remains the
      // preferred fast path (v0.4n-β); this is the fallback when the bridge
      // didn't observe the auto-cache event.
      if (!richMediaService?.getVideoPlayUrlV2) throw new Error('richMediaService.getVideoPlayUrlV2 not available');
      const rsp = await richMediaService.getVideoPlayUrlV2(ntPeer, entry.msgId, entry.elementId, 0, {
        downSourceType: 1, triggerType: 0,
      });
      if (!rsp || (rsp.result !== undefined && rsp.result !== 0)) {
        throw new Error(`getVideoPlayUrlV2 failed: result=${rsp?.result} errMsg=${rsp?.errMsg ?? ''}`);
      }
      const url = rsp.urlResult?.domainUrl ?? rsp.urlResult?.backUrl?.[0]?.url ?? '';
      if (!url) throw new Error('getVideoPlayUrlV2 returned no url');
      log(`getMediaUrl video file=${file.slice(0, 16)}… → ${url.slice(0, 80)}…`);
      return { file, url };
    }
    if (entry.elementType === 3 || entry.elementType === 4) {
      // FILE or PTT: NT 9.9 leaves md5 empty on incoming and there's no
      // direct "give me a URL" call. For PRIVATE-chat inline files we use
      // `msgService.downloadRichMedia`. The
      // `richMediaService.downloadFileForModelId` path is for GROUP-FILE-PANEL
      // files whose modelId is server-issued — passing our elementId fails
      // with `file_model_info_vec empty`. So we always go through msgService
      // here and pass an explicit target path under os.tmpdir(): some NT
      // versions silently no-op when filePath is empty.
      if (!msgService.downloadRichMedia) throw new Error('msgService.downloadRichMedia not available');
      const os = await import('node:os');
      const path = await import('node:path');
      const fileName = entry.fileName ? entry.fileName.replace(/[\\/:*?"<>|]/g, '_') : 'file.bin';
      const targetPath = path.join(os.tmpdir(), `qanyicat-dl-${entry.elementId.slice(-12)}-${Date.now()}-${fileName}`);
      log(`getMediaUrl ${entry.elementType === 4 ? 'voice' : 'file'} via downloadRichMedia elem=${entry.elementId} target=${targetPath}`);
      const waitPromise = downloadWaiters.wait(entry.msgId, entry.elementId);
      const rsp = await msgService.downloadRichMedia({
        fileModelId: '0', downSourceType: 0, downloadSourceType: 0, triggerType: 1,
        msgId: entry.msgId, chatType: ntPeer.chatType, peerUid: ntPeer.peerUid,
        elementId: entry.elementId, thumbSize: 0, downloadType: 1, filePath: targetPath,
      });
      if (rsp && rsp.result !== undefined && rsp.result !== 0) {
        throw new Error(`downloadRichMedia kick-off failed: result=${rsp.result} errMsg=${rsp.errMsg ?? ''}`);
      }
      const localPath = await waitPromise;
      mediaIndex.setLocalCachePath(entry.msgId, entry.elementId, localPath);
      const url = toFileUrl(localPath);
      log(`getMediaUrl ${entry.elementType === 4 ? 'voice' : 'file'} file=${file.slice(0, 16)}… → ${url.slice(0, 100)}`);
      return { file, url };
    }
    if (entry.elementType === 2) {
      // PIC: prefer the URL NT delivered on the original element (we don't
      // re-fetch from the index since rkey-bearing URLs change over time).
      // The wire client gets a best-effort legacy URL pattern.
      const url = `https://gchat.qpic.cn/gchatpic_new/0/0-0-${file.toUpperCase()}/0`;
      log(`getMediaUrl image file=${file.slice(0, 16)}… → legacy URL (rkey-less, may 404)`);
      return { file, url };
    }
    throw new Error(`getMediaUrl: elementType ${entry.elementType} not yet supported`);
  };

  return {
    msg: {
      send,
      recall,
      findByCompositeId,
      fetch,
      fetchHistory,
      multiForward,
      multiForwardFabricated,
      getMediaUrl,
    },
    user,
    group: group as unknown as NTApis['group'],
    friend: friend as unknown as NTApis['friend'],
    file: fileStub as unknown as NTApis['file'],
    system,
  };
}

// Local interface shims so we don't fight a deeply-typed unknown call surface.
type NTGroupApiLike = {
  list(): Promise<NTGroupInfo[]>;
  info(groupCode: string): Promise<NTGroupInfo>;
  members(groupCode: string): Promise<NTGroupMember[]>;
  kick(groupCode: string, uid: string, rejectAddRequest: boolean): Promise<void>;
  mute(groupCode: string, uid: string, durationSec: number): Promise<void>;
  muteAll(groupCode: string, enable: boolean): Promise<void>;
  setCard(groupCode: string, uid: string, card: string): Promise<void>;
  setAdmin(groupCode: string, uid: string, isAdmin: boolean): Promise<void>;
  handleJoinRequest: NonNullable<NTApis['group']['handleJoinRequest']>;
};

type NTFriendApiLike = {
  list(): Promise<NTFriendEntry[]>;
  handleRequest: NTApis['friend']['handleRequest'];
  deleteFriend: NTApis['friend']['deleteFriend'];
  sendRequest: NTApis['friend']['sendRequest'];
  sendRequestProbe: NonNullable<NTApis['friend']['sendRequestProbe']>;
};
