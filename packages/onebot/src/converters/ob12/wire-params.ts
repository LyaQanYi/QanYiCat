/**
 * OB12 wire-params → unified-params translator (parallel to ob11/wire-params.ts).
 *
 * OneBot 12 uses snake_case keys with a flatter `detail_type` discriminator for
 * `send_message` — see https://12.onebot.dev. Our internal action handlers all
 * speak the unified shape; this is the shim between the wire and the registry.
 *
 * For at/mention segments the OB12 wire form carries `user_id` (numeric uin)
 * but the unified `at` segment uses `uid` (`u_...`). We resolve via the same
 * UinResolver the OB11 adapter uses; cache miss leaves the numeric value in
 * place which the bridge's send path can still try (degraded gracefully).
 */

import type { UnifiedSegment } from '@qanyicat/protocol';
import { ob12ToSegments, type OB12Segment } from './message';
import type { UinResolver } from '../ob11/cq-codes';

type Json = Record<string, unknown>;

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  return String(v);
}

async function normalizeOb12Message(msg: unknown, resolver?: UinResolver): Promise<UnifiedSegment[]> {
  if (!Array.isArray(msg)) return [];
  const segs = ob12ToSegments(msg as OB12Segment[]);
  for (const s of segs) {
    if (s.type !== 'at') continue;
    if (s.data.uid === 'all' || !s.data.uid) continue;
    if (!/^\d+$/.test(s.data.uid)) continue;
    const uin = s.data.uid;
    const resolved = resolver ? await resolver(uin) : null;
    if (resolved?.uid) {
      s.data.uid = resolved.uid;
      s.data.uin = uin;
      if (resolved.nick) s.data.name = resolved.nick;
    }
  }
  return segs;
}

async function translateSendMessage(params: Json, resolver?: UinResolver): Promise<Json> {
  const detailType = asString(params.detail_type);
  const peerType: 'user' | 'group' = detailType === 'group' ? 'group' : 'user';
  const peerId = peerType === 'group'
    ? asString(params.target_uid ?? params.group_id)
    : asString(params.target_uid ?? params.user_id);
  return {
    peer: { type: peerType, id: peerId },
    segments: await normalizeOb12Message(params.message, resolver),
  };
}

export async function ob12ParamsToUnified(action: string, rawParams: unknown, resolver?: UinResolver): Promise<unknown> {
  const params: Json = (rawParams && typeof rawParams === 'object')
    ? (rawParams as Json)
    : {};

  switch (action) {
    case 'send_message':
      return translateSendMessage(params, resolver);

    case 'delete_message':
      return { messageId: asString(params.message_id) };

    case 'get_message':
      return { messageId: asString(params.message_id) };

    case 'get_group_info':
      return { groupId: asString(params.group_id) };

    case 'get_group_member_list':
    case 'get_group_members':
      return { groupId: asString(params.group_id) };

    case 'get_user_info':
      return { userId: asString(params.target_uid ?? params.user_id) };

    case 'get_friend_list':
    case 'get_login_info':
    case 'get_status':
    case 'get_version_info':
    case 'get_self_info':
      return {};

    default:
      return rawParams;
  }
}
