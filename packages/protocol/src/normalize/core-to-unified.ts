import type { InstanceContext, NTKernelEvents, NTRawMessage } from '@qanyicat/core';
import type { UnifiedMessage } from '../message/unified-message';
import type { UnifiedEvent } from '../events/unified-event';
import { ntElementsToSegments } from './segment-converter';

export class CoreToUnified {
  /** Map an NT raw message to the protocol-neutral form. */
  static message(raw: NTRawMessage, ctx: InstanceContext): UnifiedMessage {
    const scene: 'private' | 'group' = raw.peer.chatType === 'group' ? 'group' : 'private';
    return {
      id: CoreToUnified.deriveMessageId(raw, ctx.uin),
      scene,
      selfId: ctx.uin,
      sender: {
        uid: raw.senderUid,
        uin: raw.senderUin ?? '',
        ...(raw.sendNickName !== undefined ? { nickname: raw.sendNickName } : {}),
        ...(raw.sendMemberName !== undefined ? { card: raw.sendMemberName } : {}),
        ...(raw.senderRole !== undefined ? { role: raw.senderRole } : {}),
      },
      peer:
        scene === 'group'
          ? { type: 'group', id: raw.peer.groupCode ?? raw.peer.peerUid }
          : { type: 'user', id: raw.peer.peerUin ?? raw.peer.peerUid },
      segments: ntElementsToSegments(raw.elements),
      timestamp: Number(raw.msgTime) * 1000,
      raw,
    };
  }

  /** Project an NT kernel event onto a UnifiedEvent (1-to-many in general). */
  static event<K extends keyof NTKernelEvents>(
    kind: K,
    payload: NTKernelEvents[K],
    ctx: InstanceContext
  ): UnifiedEvent[] {
    switch (kind) {
      case 'msg.recv': {
        const p = payload as NTKernelEvents['msg.recv'];
        return p.messages.map((m) => ({
          kind: 'message' as const,
          message: CoreToUnified.message(m, ctx),
        }));
      }
      case 'msg.recall': {
        const p = payload as NTKernelEvents['msg.recall'];
        const isGroup = p.peer.chatType === 'group';
        // Prefer numeric ids on the wire: groupCode for groups, peerUin for
        // private (uid is the fallback only when uin↔uid hasn't been resolved).
        const peerId = isGroup
          ? (p.peer.groupCode ?? p.peer.peerUid)
          : (p.peer.peerUin ?? p.peer.peerUid);
        return [
          {
            kind: 'notice',
            sub: 'msg.recall',
            scene: isGroup ? 'group' : 'private',
            peerId,
            msgId: p.msgId,
            ...(p.operatorUid !== undefined ? { operatorId: p.operatorUid } : {}),
          },
        ];
      }
      case 'group.member-change': {
        const p = payload as NTKernelEvents['group.member-change'];
        // Prefer the resolved numeric uin for operatorId so OB11's wire
        // `Number(operatorId)` yields a real id, not NaN→0.
        const operatorId = p.operatorUin || p.operatorUid;
        return [
          {
            kind: 'notice',
            sub: p.kind === 'join' ? 'group.member-join' : 'group.member-leave',
            groupId: p.groupCode,
            userId: p.uin || p.uid,
            ...(operatorId ? { operatorId } : {}),
          },
        ];
      }
      case 'group.admin-change': {
        const p = payload as NTKernelEvents['group.admin-change'];
        return [
          {
            kind: 'notice',
            sub: 'group.admin-change',
            groupId: p.groupCode,
            userId: p.uin || p.uid,
            isAdmin: p.isAdmin,
          },
        ];
      }
      case 'group.request': {
        const p = payload as NTKernelEvents['group.request'];
        // v0.4o: encode the full state the kernel needs for operateSysNotify
        // into a single flag — wire callers just echo it back to accept/reject.
        // Layout: `${seq}|${type}|${groupCode}|${doubt?1:0}`
        const flag = `${p.flag}|${p.type}|${p.groupCode}|${p.doubt ? 1 : 0}`;
        if (p.isInvite) {
          return [
            {
              kind: 'request',
              sub: 'group.invite',
              groupId: p.groupCode,
              userId: p.uin || p.uid,
              flag,
            },
          ];
        }
        return [
          {
            kind: 'request',
            sub: 'group.join',
            groupId: p.groupCode,
            userId: p.uin || p.uid,
            comment: p.comment,
            flag,
          },
        ];
      }
      case 'friend.request': {
        const p = payload as NTKernelEvents['friend.request'];
        // v0.4o: encode uid + reqTime + doubt so accept/reject can call NT
        // without a separate stateful index. Layout: `${uid}|${reqTime}|${doubt?1:0}`.
        const flag = `${p.uid}|${p.reqTime}|${p.doubt ? 1 : 0}`;
        return [
          {
            kind: 'request',
            sub: 'friend.add',
            userId: p.uin || p.uid,    // prefer numeric uin for OB11 wire compat
            comment: p.comment,
            flag,
          },
        ];
      }
      case 'login.success':
        return [{ kind: 'meta', sub: 'lifecycle.connect' }];
      default:
        return [];
    }
  }

  /**
   * Stable hash combining session + msgSeq + msgRandom so the same logical
   * message gets the same internal id across listener fan-out.
   */
  private static deriveMessageId(raw: NTRawMessage, selfUin: string): string {
    return `${selfUin}:${raw.peer.chatType}:${raw.msgSeq}:${raw.msgRandom}`;
  }
}
