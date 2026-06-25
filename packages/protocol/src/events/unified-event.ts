import type { UnifiedMessage } from '../message/unified-message';

export interface UnifiedMessageEvent {
  kind: 'message';
  message: UnifiedMessage;
}

export type UnifiedNoticeEvent =
  | { kind: 'notice'; sub: 'group.member-join'; groupId: string; userId: string; operatorId?: string }
  | { kind: 'notice'; sub: 'group.member-leave'; groupId: string; userId: string; operatorId?: string }
  | { kind: 'notice'; sub: 'group.admin-change'; groupId: string; userId: string; isAdmin: boolean }
  | { kind: 'notice'; sub: 'group.mute'; groupId: string; userId: string; durationSec: number; operatorId: string }
  | { kind: 'notice'; sub: 'friend.add'; userId: string }
  | { kind: 'notice'; sub: 'msg.recall'; scene: 'private' | 'group'; peerId: string; msgId: string; operatorId?: string };

export type UnifiedRequestEvent =
  | { kind: 'request'; sub: 'friend.add'; userId: string; comment: string; flag: string }
  | { kind: 'request'; sub: 'group.join'; groupId: string; userId: string; comment: string; flag: string }
  | { kind: 'request'; sub: 'group.invite'; groupId: string; userId: string; flag: string };

export type UnifiedMetaEvent =
  | { kind: 'meta'; sub: 'lifecycle.connect' }
  | { kind: 'meta'; sub: 'lifecycle.enable' }
  | { kind: 'meta'; sub: 'lifecycle.disable' }
  | { kind: 'meta'; sub: 'heartbeat'; interval: number };

export type UnifiedEvent =
  | UnifiedMessageEvent
  | UnifiedNoticeEvent
  | UnifiedRequestEvent
  | UnifiedMetaEvent;
