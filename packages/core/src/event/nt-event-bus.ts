import type { NTElement } from './nt-element';

/**
 * Union of all events emitted by the NT runtime, after listeners pre-normalize
 * raw native callbacks. OneBot adapters never subscribe here directly — the
 * `protocol` package consumes this bus and produces UnifiedEvent.
 */
export interface NTKernelEvents {
  'msg.recv': { peer: NTPeer; messages: NTRawMessage[] };
  'msg.send-result': { msgId: string; success: boolean };
  'msg.recall': { peer: NTPeer; msgId: string; operatorUid?: string };
  'group.member-change': { groupCode: string; uid: string; uin?: string; kind: 'join' | 'leave' | 'kick'; operatorUid?: string; operatorUin?: string };
  'group.admin-change': { groupCode: string; uid: string; uin?: string; isAdmin: boolean };
  /** v0.4j-γ: NT group notification — admin-approve join, invite, etc.
   *  `flag` is NT's notify seq; `type` is the GroupNotifyMsgType enum value
   *  needed for `operateSysNotify` ; `doubt` distinguishes the suspicious-track. */
  'group.request': { groupCode: string; uid: string; uin?: string; comment: string; flag: string; isInvite: boolean; type: number; doubt: boolean };
  /** v0.4j-β-1 / o: incoming friend-add request.
   *  `reqTime` + `doubt` are needed by `buddyService.approvalFriendRequest` /
   *  `approvalDoubtBuddyReq` when the bot accepts or rejects. */
  'friend.request': { uid: string; comment: string; uin?: string; reqTime: string; doubt: boolean };
  'login.success': { uin: string; uid: string };
  'login.failed': { reason: string };
  'self.profile-change': { nick: string };
}

export type NTChatType = 'private' | 'group' | 'temp';

export interface NTPeer {
  chatType: NTChatType;
  peerUid: string;
  peerUin?: string;
  peerName?: string;
  groupCode?: string;
}

export interface NTRawMessage {
  msgId: string;
  msgSeq: string;
  msgRandom: string;
  msgTime: string;
  peer: NTPeer;
  senderUid: string;
  senderUin?: string;
  sendNickName?: string;
  sendMemberName?: string;
  /** Group role of the sender, when available (group messages only). */
  senderRole?: 'owner' | 'admin' | 'member';
  elements: NTElement[];
}

export interface Disposable {
  dispose(): void;
}

export interface NTEventBus {
  on<K extends keyof NTKernelEvents>(event: K, handler: (payload: NTKernelEvents[K]) => void): Disposable;
  off<K extends keyof NTKernelEvents>(event: K, handler: (payload: NTKernelEvents[K]) => void): void;
  emit<K extends keyof NTKernelEvents>(event: K, payload: NTKernelEvents[K]): void;
}

export function createNTEventBus(): NTEventBus {
  const map = new Map<keyof NTKernelEvents, Set<(p: never) => void>>();
  return {
    on(event, handler) {
      let set = map.get(event);
      if (!set) {
        set = new Set();
        map.set(event, set);
      }
      set.add(handler as (p: never) => void);
      return {
        dispose: () => {
          map.get(event)?.delete(handler as (p: never) => void);
        },
      };
    },
    off(event, handler) {
      map.get(event)?.delete(handler as (p: never) => void);
    },
    emit(event, payload) {
      const set = map.get(event);
      if (!set) return;
      for (const fn of set) (fn as (p: NTKernelEvents[typeof event]) => void)(payload);
    },
  };
}
