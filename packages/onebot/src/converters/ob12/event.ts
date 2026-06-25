import { randomUUID } from 'node:crypto';
import type { UnifiedEvent, UnifiedMessage, UnifiedSender } from '@qanyicat/protocol';
import { segmentsToOb12, type OB12Segment } from './message';

export interface OB12Self {
  platform: 'qq';
  user_id: string;
}

export interface OB12Event {
  id: string;
  /** Seconds with millisecond precision (float). */
  time: number;
  type: 'message' | 'notice' | 'request' | 'meta';
  detail_type: string;
  self: OB12Self;
  [k: string]: unknown;
}

export interface OB12MessageEvent extends OB12Event {
  type: 'message';
  /** 'private' | 'group' | 'channel' (we emit private/group). */
  detail_type: 'private' | 'group';
  message_id: string;
  message: OB12Segment[];
  alt_message: string;
  user_id: string;
  group_id?: string;
}

export interface OB12HeartbeatEvent extends OB12Event {
  type: 'meta';
  detail_type: 'heartbeat';
  interval: number;
}

export interface OB12ConnectEvent extends OB12Event {
  type: 'meta';
  detail_type: 'connect';
  version: { impl: 'qanyicat'; version: string; onebot_version: '12' };
}

export class OB12EventConverter {
  constructor(private readonly selfUin: string) {}

  fromUnified(e: UnifiedEvent): OB12Event | null {
    switch (e.kind) {
      case 'message':
        return this.buildMessage(e.message);
      case 'meta':
        if (e.sub === 'lifecycle.connect') return this.buildConnect();
        return null;
      case 'notice':
        return this.buildNotice(e);
      case 'request':
        return this.buildRequest(e);
    }
  }

  private buildRequest(e: Extract<UnifiedEvent, { kind: 'request' }>): OB12Event | null {
    if (e.sub === 'friend.add') {
      return {
        id: randomUUID(),
        time: Date.now() / 1000,
        type: 'request',
        detail_type: 'new_friend',
        self: this.self(),
        user_id: e.userId,
        comment: e.comment,
        flag: e.flag,
      } as OB12Event;
    }
    if (e.sub === 'group.join' || e.sub === 'group.invite') {
      return {
        id: randomUUID(),
        time: Date.now() / 1000,
        type: 'request',
        detail_type: e.sub === 'group.join' ? 'group_join_request' : 'group_invite',
        self: this.self(),
        user_id: e.userId,
        group_id: e.groupId,
        comment: 'comment' in e ? e.comment : '',
        flag: e.flag,
      } as OB12Event;
    }
    return null;
  }

  private buildNotice(e: Extract<UnifiedEvent, { kind: 'notice' }>): OB12Event | null {
    if (e.sub === 'msg.recall') {
      const detailType = e.scene === 'group' ? 'group_message_delete' : 'private_message_delete';
      const event: OB12Event & { message_id: string; user_id: string; group_id?: string; operator_id?: string } = {
        id: randomUUID(),
        time: Date.now() / 1000,
        type: 'notice',
        detail_type: detailType,
        self: this.self(),
        message_id: e.msgId,
        user_id: e.peerId,
      };
      if (e.scene === 'group') event.group_id = e.peerId;
      if (e.operatorId) event.operator_id = e.operatorId;
      return event;
    }
    if (e.sub === 'group.member-join') {
      return {
        id: randomUUID(),
        time: Date.now() / 1000,
        type: 'notice',
        detail_type: 'group_member_increase',
        self: this.self(),
        sub_type: 'join',
        group_id: e.groupId,
        user_id: e.userId,
        ...(e.operatorId ? { operator_id: e.operatorId } : {}),
      } as OB12Event;
    }
    if (e.sub === 'group.member-leave') {
      return {
        id: randomUUID(),
        time: Date.now() / 1000,
        type: 'notice',
        detail_type: 'group_member_decrease',
        self: this.self(),
        sub_type: e.operatorId && e.operatorId !== e.userId ? 'kick' : 'leave',
        group_id: e.groupId,
        user_id: e.userId,
        ...(e.operatorId ? { operator_id: e.operatorId } : {}),
      } as OB12Event;
    }
    if (e.sub === 'group.admin-change') {
      return {
        id: randomUUID(),
        time: Date.now() / 1000,
        type: 'notice',
        detail_type: e.isAdmin ? 'group_admin_set' : 'group_admin_unset',
        self: this.self(),
        group_id: e.groupId,
        user_id: e.userId,
      } as OB12Event;
    }
    return null;
  }

  buildHeartbeat(intervalMs: number): OB12HeartbeatEvent {
    return {
      id: randomUUID(),
      time: Date.now() / 1000,
      type: 'meta',
      detail_type: 'heartbeat',
      self: this.self(),
      interval: intervalMs,
    };
  }

  private buildConnect(): OB12ConnectEvent {
    return {
      id: randomUUID(),
      time: Date.now() / 1000,
      type: 'meta',
      detail_type: 'connect',
      self: this.self(),
      version: { impl: 'qanyicat', version: '0.0.1', onebot_version: '12' },
    };
  }

  private buildMessage(m: UnifiedMessage): OB12MessageEvent {
    const segs = segmentsToOb12(m.segments);
    const event: OB12MessageEvent = {
      id: randomUUID(),
      time: m.timestamp / 1000,
      type: 'message',
      detail_type: m.scene,
      self: this.self(),
      message_id: m.id,
      message: segs,
      alt_message: altMessage(m.segments, m.sender),
      user_id: m.sender.uin || m.sender.uid,
    };
    if (m.scene === 'group' && m.peer.type === 'group') {
      event.group_id = m.peer.id;
    }
    return event;
  }

  private self(): OB12Self {
    return { platform: 'qq', user_id: this.selfUin };
  }
}

/** Plain-text fallback used by clients that don't render segments. */
function altMessage(segments: UnifiedMessage['segments'], _sender: UnifiedSender): string {
  let out = '';
  for (const s of segments) {
    if (s.type === 'text') out += s.data.text;
    else if (s.type === 'at') out += `@${s.data.uid}`;
    else if (s.type === 'face') out += `[face:${s.data.id}]`;
    else if (s.type === 'image') out += '[image]';
    else if (s.type === 'reply') out += `[reply:${s.data.id}]`;
    else out += `[${s.type}]`;
  }
  return out;
}
