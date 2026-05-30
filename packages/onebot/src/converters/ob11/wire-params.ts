/**
 * OB11 wire-params → unified-params translator.
 *
 * `ob11ToUnified` maps action *names*; this module maps action *parameter*
 * shapes. Without it, an OB11 client posting `{user_id: 12345, message: "hi"}`
 * to `/send_msg` would reach the `send_message` handler which expects
 * `{peer: {type, id}, segments: [...]}` and fail.
 *
 * Out of scope for v0.4d-γ:
 *   • CQ-code string parsing (`[CQ:at,qq=...]`) — accept array form for now
 *   • uin → uid resolution for `user_id` numerics — pending v0.4e mapping cache.
 *     Until that lands, real `user_id`-routed sends will fail at the bridge.
 *     The QanYiCat-specific `target_uid` extension field takes precedence so
 *     internal tools can keep sending while uin↔uid is being built.
 */

import type { UnifiedSegment, UnifiedForwardNode } from '@qanyicat/protocol';
import { parseCqString, type UinResolver } from './cq-codes';

type Json = Record<string, unknown>;

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

async function normalizeMessageField(msg: unknown, resolver?: UinResolver): Promise<UnifiedSegment[]> {
  if (typeof msg === 'string') {
    if (msg.length === 0) return [];
    if (msg.includes('[CQ:')) return parseCqString(msg, resolver);
    return [{ type: 'text', data: { text: msg } }];
  }
  if (Array.isArray(msg)) {
    // OB11 array form has the same {type, data} shape as UnifiedSegment.
    return msg.filter((seg) => seg && typeof seg === 'object') as UnifiedSegment[];
  }
  return [];
}

/**
 * OB11 forward shape:
 *   `messages: [{type:"node", data:{id: "<msg_id>"}}]`               — id reference
 *   `messages: [{type:"node", data:{user_id, nickname, content}}]`    — custom node (v0.4m-β)
 *
 * `content` may be a CQ string or a UnifiedSegment-shaped array.
 */
async function translateForwardNodes(messages: unknown, resolver?: UinResolver): Promise<UnifiedForwardNode[]> {
  if (!Array.isArray(messages)) return [];
  const out: UnifiedForwardNode[] = [];
  for (const entry of messages) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Json;
    // Allow callers to pass the raw `{id: "..."}` or `{messageId: "..."}` for convenience.
    const data = (e.data && typeof e.data === 'object' ? e.data : e) as Json;
    const refId = data.id ?? data.message_id ?? data.messageId;
    if (refId !== undefined && refId !== null && refId !== '') {
      out.push({ messageId: String(refId) });
      continue;
    }
    const userId = data.user_id ?? data.uin ?? data.userId;
    const nickname = data.nickname ?? data.name;
    const content = data.content ?? data.message;
    if (userId !== undefined && nickname !== undefined && content !== undefined) {
      out.push({
        userId: asString(userId),
        nickname: asString(nickname),
        segments: await normalizeMessageField(content, resolver),
        ...(data.time !== undefined ? { time: Number(data.time) } : {}),
      });
      continue;
    }
    // Silently drop unrecognized node shapes — strict mode would block real bots.
  }
  return out;
}

async function translateSendMsg(action: string, params: Json, resolver?: UinResolver): Promise<Json> {
  const messageType = action === 'send_private_msg'
    ? 'private'
    : action === 'send_group_msg'
      ? 'group'
      : (params.message_type === 'group' || params.group_id ? 'group' : 'private');

  const peerType: 'user' | 'group' = messageType === 'group' ? 'group' : 'user';
  // target_uid is QanYiCat's pre-v0.4e extension; falls back to OB11 native user_id / group_id.
  const peerId = peerType === 'group'
    ? asString(params.target_uid ?? params.group_id)
    : asString(params.target_uid ?? params.user_id);

  return {
    peer: { type: peerType, id: peerId },
    segments: await normalizeMessageField(params.message, resolver),
  };
}

/**
 * Translate OB11 wire params into the shape the unified action handler in
 * `@qanyicat/protocol` expects. Unknown actions pass through unchanged so
 * future spec coverage is additive — never breaks existing callers.
 *
 * `resolver` is needed for CQ-code `at` segments where the wire form uses
 * `qq=<uin>` but the unified shape needs `{uid}`. Omit for non-send actions
 * or when the caller can guarantee no CQ codes; `at` mentions degrade to
 * literal `@<num>` text in that case.
 */
export async function ob11ParamsToUnified(action: string, rawParams: unknown, resolver?: UinResolver): Promise<unknown> {
  const params: Json = (rawParams && typeof rawParams === 'object')
    ? (rawParams as Json)
    : {};

  switch (action) {
    case 'send_msg':
    case 'send_private_msg':
    case 'send_group_msg':
      return translateSendMsg(action, params, resolver);

    case 'send_forward_msg':
    case 'send_group_forward_msg':
    case 'send_private_forward_msg': {
      const peerType: 'user' | 'group' = action === 'send_group_forward_msg'
        ? 'group'
        : action === 'send_private_forward_msg'
          ? 'user'
          : (params.group_id ? 'group' : 'user');
      const peerId = peerType === 'group'
        ? asString(params.target_uid ?? params.group_id)
        : asString(params.target_uid ?? params.user_id);
      return {
        peer: { type: peerType, id: peerId },
        nodes: await translateForwardNodes(params.messages, resolver),
      };
    }

    case 'delete_msg':
      return { messageId: asString(params.message_id) };

    case 'get_msg':
      return { messageId: asString(params.message_id) };

    case 'get_group_info':
      return { groupId: asString(params.group_id) };

    case 'get_group_member_list':
      return { groupId: asString(params.group_id) };

    case 'set_group_ban':
      return {
        groupId: asString(params.group_id),
        userId: asString(params.target_uid ?? params.user_id),
        durationSeconds: Number(params.duration ?? 0),
      };

    case 'set_group_kick':
      return {
        groupId: asString(params.group_id),
        userId: asString(params.target_uid ?? params.user_id),
        rejectAddRequest: Boolean(params.reject_add_request),
      };

    case 'get_stranger_info':
      return { userId: asString(params.target_uid ?? params.user_id) };

    case 'get_friend_list':
      return {};

    case 'get_group_msg_history':
    case 'get_friend_msg_history': {
      const isGroup = action === 'get_group_msg_history';
      return {
        peer: {
          type: isGroup ? 'group' : 'user',
          id: asString(isGroup ? params.group_id : (params.target_uid ?? params.user_id)),
        },
        count: Number(params.count ?? 20),
        ...(params.message_seq ? { anchorMessageId: asString(params.message_seq) } : {}),
      };
    }

    case 'add_friend':
    case 'send_friend_request':
    case 'send_friend_request_probe':   // v0.4k experimental probe
      return {
        userId: asString(params.target_uid ?? params.user_id),
        comment: asString(params.comment ?? params.message ?? ''),
      };

    case 'set_friend_add_request':
      // OB11 spec: `approve` may arrive as bool OR string "true"/"false".
      return {
        flag: asString(params.flag),
        approve: params.approve === false || params.approve === 'false' ? false : true,
        ...(params.remark !== undefined ? { remark: asString(params.remark) } : {}),
      };

    case 'get_image':
    case 'get_record':
    case 'get_video':
    case 'get_file':
      return { file: asString(params.file) };

    case 'set_group_add_request':
      // OB11 spec also has `sub_type` (add|invite) and `type` — we don't need
      // them because the flag carries the NT seq+type+groupCode tuple.
      return {
        flag: asString(params.flag),
        approve: params.approve === false || params.approve === 'false' ? false : true,
        ...(params.reason !== undefined ? { reason: asString(params.reason) } : {}),
      };

    default:
      return rawParams;
  }
}
