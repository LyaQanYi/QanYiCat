import type { Logger } from 'winston';
import type { InstanceContext } from './instance-context';
import type { NodeIQQNTWrapperSession, QQBasicInfo, SelfInfo } from '../wrapper/types';
import { createNTEventBus, type NTEventBus, type NTPeer, type NTRawMessage } from '../event/nt-event-bus';
import { NTElementType } from '../event/nt-element';
import type { NTApis } from '../apis';
import type { NTMsgApi, NTSendMessageParams, NTSendMessageResult } from '../apis/msg';
import type { NTUserApi, NTUserProfile } from '../apis/user';
import type { NTGroupApi, NTGroupInfo, NTGroupMember } from '../apis/group';
import type { NTFriendApi, NTFriendEntry } from '../apis/friend';
import type { NTFileApi } from '../apis/file';
import type { NTSystemApi } from '../apis/system';
import { createLogger } from '../logger';

export interface MemoryContextOptions {
  uin: string;
  nick?: string;
  logger?: Logger;
}

/**
 * In-memory `InstanceContext` for dev/test. Lets the wire layer (network
 * adapters + OB11/12 converters) run end-to-end without a real QQ client —
 * messages "sent" through the NT API are echoed back through the event bus
 * so connected bots see a self-consistent loopback.
 */
export function createMemoryContext(opts: MemoryContextOptions): InstanceContext {
  const logger = opts.logger ?? createLogger({ label: `memory:${opts.uin}` });
  const events = createNTEventBus();

  const selfInfo: SelfInfo = {
    uin: opts.uin,
    uid: `u_${opts.uin}`,
    nick: opts.nick ?? `bot-${opts.uin}`,
    online: true,
  };

  const basicInfo: QQBasicInfo = {
    execPath: '<memory>',
    qqVersion: '0.0.0-memory',
    qqVersionConfigPath: '<memory>',
    qqResourceDir: '<memory>',
  };

  const apis = buildMemoryApis(selfInfo, events);

  // Synthetic 'login.success' so the OB11 adapter emits lifecycle.connect.
  queueMicrotask(() => events.emit('login.success', { uin: selfInfo.uin, uid: selfInfo.uid }));

  return {
    uin: selfInfo.uin,
    selfInfo,
    basicInfo,
    session: makeStubSession(),
    logger,
    events,
    apis,
    async dispose() {
      selfInfo.online = false;
    },
  };
}

function buildMemoryApis(self: SelfInfo, events: NTEventBus): NTApis {
  let nextSeq = 1;

  const msg: NTMsgApi = {
    async send(params: NTSendMessageParams): Promise<NTSendMessageResult> {
      const seq = String(nextSeq++);
      const random = String(Math.floor(Math.random() * 2 ** 31));
      const msgId = `mem-${seq}-${random}`;
      const result: NTSendMessageResult = {
        msgId,
        msgSeq: seq,
        msgTime: String(Math.floor(Date.now() / 1000)),
      };
      // Echo as a message we "received" so OB clients see the round trip.
      const echo: NTRawMessage = {
        msgId,
        msgSeq: seq,
        msgRandom: random,
        msgTime: result.msgTime,
        peer: params.peer,
        senderUid: self.uid,
        senderUin: self.uin,
        sendNickName: self.nick,
        elements: params.elements as NTRawMessage['elements'],
      };
      queueMicrotask(() => events.emit('msg.recv', { peer: params.peer, messages: [echo] }));
      return result;
    },
    async recall(_peer: NTPeer, _msgIds: string[]): Promise<void> {},
    async findByCompositeId(_messageId: string) {
      return null;
    },
    async fetch(_peer: NTPeer, _msgId: string): Promise<NTRawMessage | null> {
      return null;
    },
    async fetchHistory(_peer: NTPeer, _count: number): Promise<NTRawMessage[]> {
      return [];
    },
    async multiForward(
      _src: NTPeer,
      _dst: NTPeer,
      _msgs: Array<{ ntMsgId: string; senderShowName?: string }>
    ): Promise<NTSendMessageResult> {
      const seq = String(nextSeq++);
      return { msgId: `mem-fwd-${seq}`, msgSeq: seq, msgTime: String(Math.floor(Date.now() / 1000)) };
    },
    async multiForwardFabricated(
      _dst: NTPeer,
      _items: Array<{ senderShowName: string; elements: unknown[] }>
    ): Promise<NTSendMessageResult> {
      const seq = String(nextSeq++);
      return { msgId: `mem-fwd-fab-${seq}`, msgSeq: seq, msgTime: String(Math.floor(Date.now() / 1000)) };
    },
    async getMediaUrl(_file: string): Promise<null> {
      return null;
    },
  };

  const user: NTUserApi = {
    async getProfile(uid: string): Promise<NTUserProfile> {
      return { uid, uin: uid.replace(/^u_/, ''), nick: `mem-user-${uid}` };
    },
    async getSelfInfo(): Promise<NTUserProfile> {
      return { uid: self.uid, uin: self.uin, nick: self.nick };
    },
    async uinToUid(uin: string): Promise<string | null> {
      return `u_${uin}`;
    },
    async uidToUin(uid: string): Promise<string | null> {
      return uid.replace(/^u_/, '');
    },
  };

  const group: NTGroupApi = {
    async list(): Promise<NTGroupInfo[]> {
      return [];
    },
    async info(groupCode: string): Promise<NTGroupInfo> {
      return {
        groupCode,
        groupName: `mem-group-${groupCode}`,
        memberCount: 0,
        maxMember: 0,
        owner: self.uid,
      };
    },
    async members(_groupCode: string): Promise<NTGroupMember[]> {
      return [];
    },
    async kick(): Promise<void> {},
    async mute(): Promise<void> {},
    async muteAll(): Promise<void> {},
    async setCard(): Promise<void> {},
    async setAdmin(): Promise<void> {},
    async handleJoinRequest(): Promise<void> {},
  };

  const friend: NTFriendApi = {
    async list(): Promise<NTFriendEntry[]> {
      return [];
    },
    async handleRequest(): Promise<void> {},
    async deleteFriend(): Promise<void> {},
    async sendRequest(): Promise<void> {},
    async sendRequestProbe(): Promise<import('../apis/friend').ProbeReport> {
      return { services: { buddyService: false, addBuddyService: false }, addBuddyMethods: [], attempts: [] };
    },
  };

  const file: NTFileApi = {
    async upload() {
      return { fileId: 'mem-file-0', fileName: 'memory.bin', size: 0 };
    },
    async download() {
      return { localPath: '<memory>' };
    },
  };

  const system: NTSystemApi = {
    async getOnlineStatus() {
      return self.online ? 'online' : 'offline';
    },
    async setOnlineStatus(status) {
      self.online = status === 'online';
    },
    async getKernelTime() {
      return Date.now();
    },
  };

  return { msg, user, group, friend, file, system };
}

function makeStubSession(): NodeIQQNTWrapperSession {
  const handler = {
    get: (_t: object, prop: string) => {
      if (prop === 'init') return (): number => 0;
      if (prop === 'startNT') return (): void => undefined;
      if (prop === 'destroy') return (): void => undefined;
      return () => undefined;
    },
  };
  return new Proxy({}, handler) as NodeIQQNTWrapperSession;
}

// Re-export for callers wiring up the memory mode loop.
export { NTElementType };
