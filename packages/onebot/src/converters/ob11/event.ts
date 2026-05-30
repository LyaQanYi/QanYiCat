import type { UnifiedEvent, UnifiedMessage, UnifiedSender } from '@qanyicat/protocol';
import { segmentsToOb11Array } from './message-array';
import { segmentsToCq } from './message-cq';

export interface OB11Event {
  time: number;
  self_id: number;
  post_type: 'message' | 'notice' | 'request' | 'meta_event' | 'message_sent';
  [k: string]: unknown;
}

export interface OB11Sender {
  user_id: number;
  nickname: string;
  card?: string;
  role?: 'owner' | 'admin' | 'member';
}

export interface OB11MessageEvent extends OB11Event {
  post_type: 'message' | 'message_sent';
  message_type: 'private' | 'group';
  sub_type: string;
  message_id: string;
  user_id: number;
  /** Defaults to array form; per-transport `messagePostFormat: 'string'` swaps in `raw_message`. */
  message: ReturnType<typeof segmentsToOb11Array> | string;
  raw_message: string;
  font: number;
  sender: OB11Sender;
  message_format: 'array' | 'string';
  group_id?: number;
}

export interface OB11HeartbeatEvent extends OB11Event {
  post_type: 'meta_event';
  meta_event_type: 'heartbeat';
  interval: number;
  status: { online: boolean; good: boolean };
}

export interface OB11LifecycleEvent extends OB11Event {
  post_type: 'meta_event';
  meta_event_type: 'lifecycle';
  sub_type: 'connect' | 'enable' | 'disable';
}

export class OB11EventConverter {
  constructor(private readonly selfUin: string) {}

  fromUnified(e: UnifiedEvent): OB11Event | null {
    switch (e.kind) {
      case 'message':
        return this.buildMessage(e.message);
      case 'meta':
        return this.buildMeta(e.sub);
      case 'notice':
        return this.buildNotice(e);
      case 'request':
        return this.buildRequest(e);
    }
  }

  private buildRequest(e: Extract<UnifiedEvent, { kind: 'request' }>): OB11Event | null {
    const now = Math.floor(Date.now() / 1000);
    const selfId = Number(this.selfUin);
    if (e.sub === 'friend.add') {
      return {
        time: now,
        self_id: selfId,
        post_type: 'request',
        request_type: 'friend',
        user_id: Number(e.userId) || 0,
        comment: e.comment,
        flag: e.flag,
      };
    }
    if (e.sub === 'group.join') {
      return {
        time: now,
        self_id: selfId,
        post_type: 'request',
        request_type: 'group',
        sub_type: 'add',
        group_id: Number(e.groupId) || 0,
        user_id: Number(e.userId) || 0,
        comment: e.comment,
        flag: e.flag,
      };
    }
    if (e.sub === 'group.invite') {
      return {
        time: now,
        self_id: selfId,
        post_type: 'request',
        request_type: 'group',
        sub_type: 'invite',
        group_id: Number(e.groupId) || 0,
        user_id: Number(e.userId) || 0,
        comment: '',
        flag: e.flag,
      };
    }
    return null;
  }

  private buildNotice(e: Extract<UnifiedEvent, { kind: 'notice' }>): OB11Event | null {
    const now = Math.floor(Date.now() / 1000);
    const selfId = Number(this.selfUin);
    if (e.sub === 'msg.recall') {
      const messageId = e.msgId;
      if (e.scene === 'group') {
        return {
          time: now,
          self_id: selfId,
          post_type: 'notice',
          notice_type: 'group_recall',
          group_id: Number(e.peerId) || 0,
          user_id: Number(e.peerId) || 0, // recall target uin not always known
          operator_id: e.operatorId ? Number(e.operatorId) || 0 : 0,
          message_id: messageId,
        };
      }
      return {
        time: now,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'friend_recall',
        user_id: Number(e.peerId) || 0,
        message_id: messageId,
      };
    }
    if (e.sub === 'group.member-join') {
      return {
        time: now,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_increase',
        sub_type: 'approve',
        group_id: Number(e.groupId) || 0,
        operator_id: e.operatorId ? Number(e.operatorId) || 0 : 0,
        user_id: Number(e.userId) || 0,
      };
    }
    if (e.sub === 'group.member-leave') {
      // OB11 spec sub_type:
      //   'leave'    — voluntary departure (operator == user, or no operator)
      //   'kick'     — admin kicked someone (operator != user)
      //   'kick_me'  — admin kicked the BOT itself (user == selfUin, operator != user)
      const userIdNum = Number(e.userId) || 0;
      const opIdNum = e.operatorId ? Number(e.operatorId) || 0 : userIdNum;
      const userIsSelf = String(e.userId) === this.selfUin;
      const operatorDiffers = !!e.operatorId && e.operatorId !== e.userId;
      const sub_type = operatorDiffers
        ? (userIsSelf ? 'kick_me' : 'kick')
        : 'leave';
      return {
        time: now,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_decrease',
        sub_type,
        group_id: Number(e.groupId) || 0,
        operator_id: opIdNum,
        user_id: userIdNum,
      };
    }
    if (e.sub === 'group.admin-change') {
      return {
        time: now,
        self_id: selfId,
        post_type: 'notice',
        notice_type: 'group_admin',
        sub_type: e.isAdmin ? 'set' : 'unset',
        group_id: Number(e.groupId) || 0,
        user_id: Number(e.userId) || 0,
      };
    }
    // group.mute and friend.add still pending — v0.4j-δ+.
    return null;
  }

  /** Used by the heartbeat scheduler — adapters need to send these on a timer. */
  buildHeartbeat(intervalMs: number, online: boolean): OB11HeartbeatEvent {
    return {
      time: Math.floor(Date.now() / 1000),
      self_id: Number(this.selfUin),
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      interval: intervalMs,
      status: { online, good: online },
    };
  }

  private buildMessage(m: UnifiedMessage): OB11MessageEvent {
    const segArr = segmentsToOb11Array(m.segments);
    const event: OB11MessageEvent = {
      time: Math.floor(m.timestamp / 1000),
      self_id: Number(m.selfId),
      post_type: m.sender.uin === m.selfId ? 'message_sent' : 'message',
      message_type: m.scene,
      sub_type: m.scene === 'group' ? 'normal' : 'friend',
      message_id: m.id,
      user_id: Number(m.sender.uin || 0),
      message: segArr,
      raw_message: segmentsToCq(m.segments),
      font: 0,
      sender: buildSender(m.sender),
      message_format: 'array',
    };
    if (m.scene === 'group' && m.peer.type === 'group') {
      event.group_id = Number(m.peer.id);
    }
    return event;
  }

  private buildMeta(sub: string): OB11LifecycleEvent | null {
    if (sub === 'lifecycle.connect') {
      return {
        time: Math.floor(Date.now() / 1000),
        self_id: Number(this.selfUin),
        post_type: 'meta_event',
        meta_event_type: 'lifecycle',
        sub_type: 'connect',
      };
    }
    return null;
  }
}

function buildSender(s: UnifiedSender): OB11Sender {
  const out: OB11Sender = {
    user_id: Number(s.uin || 0),
    nickname: s.nickname ?? '',
  };
  if (s.card !== undefined) out.card = s.card;
  if (s.role !== undefined) out.role = s.role;
  return out;
}
