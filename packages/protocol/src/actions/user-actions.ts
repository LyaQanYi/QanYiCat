import type { InstanceContext } from '@qanyicat/core';
import { registerAction } from './registry';

registerAction<{ userId: string }, unknown>(
  'get_user_info',
  async (ctx: InstanceContext, params: { userId: string }): Promise<unknown> => {
    const uid = await resolveUid(ctx, params.userId);
    return ctx.apis.user.getProfile(uid);
  }
);

/** Convert a wire `user_id` (uid `u_...` OR numeric uin) into a real uid. */
async function resolveUid(ctx: InstanceContext, userId: string): Promise<string> {
  if (userId.startsWith('u_')) return userId;
  if (/^\d+$/.test(userId)) {
    const resolved = await ctx.apis.user.uinToUid(userId);
    if (resolved) return resolved;
  }
  return userId; // best effort; downstream will fail with a clear NT error
}

registerAction<Record<string, never>, unknown[]>(
  'get_friend_list',
  async (ctx: InstanceContext): Promise<unknown[]> => {
    return ctx.apis.friend.list();
  }
);

interface SendFriendRequestParams {
  userId: string;
  comment?: string;
}

interface HandleFriendAddRequestParams {
  flag: string;
  approve: boolean;
  remark?: string;
}

registerAction<HandleFriendAddRequestParams, { handled: boolean }>(
  'set_friend_add_request',
  async (ctx: InstanceContext, params: HandleFriendAddRequestParams): Promise<{ handled: boolean }> => {
    if (!params.flag) throw new Error('set_friend_add_request: flag required');
    await ctx.apis.friend.handleRequest(params.flag, params.approve, params.remark);
    return { handled: true };
  }
);

interface HandleGroupAddRequestParams {
  flag: string;
  approve: boolean;
  reason?: string;
}

registerAction<HandleGroupAddRequestParams, { handled: boolean }>(
  'set_group_add_request',
  async (ctx: InstanceContext, params: HandleGroupAddRequestParams): Promise<{ handled: boolean }> => {
    if (!params.flag) throw new Error('set_group_add_request: flag required');
    if (!ctx.apis.group.handleJoinRequest) {
      throw new Error('group.handleJoinRequest not available on this context');
    }
    await ctx.apis.group.handleJoinRequest(params.flag, params.approve, params.reason);
    return { handled: true };
  }
);

registerAction<SendFriendRequestParams, { sent: boolean }>(
  'send_friend_request',
  async (ctx: InstanceContext, params: SendFriendRequestParams): Promise<{ sent: boolean }> => {
    // The wire userId can be a uid (`u_...`) or a numeric uin. Send both forms
    // — bridge picks the best one (it prefers uin for NT's reqToAddFriends API).
    const peer = params.userId.startsWith('u_')
      ? { uid: params.userId }
      : { uin: params.userId };
    await ctx.apis.friend.sendRequest(peer, params.comment ?? '');
    return { sent: true };
  }
);

/**
 * v0.4k experimental: probe every plausible NT call shape for sending a
 * friend request and return the full transcript. Each invocation issues ~12
 * native NT calls (most fail loudly by design) — definitely not suitable for
 * production wire surface. Registration gated behind the env var
 * `QANYICAT_DEBUG_PROBE=1`; without it the action is absent and POSTing to
 * `/send_friend_request_probe` returns the usual unknown-action error.
 *
 * v0.4k done its job (shape found, `friend.sendRequest` switched to addBuddy)
 * — this action survives only to help debug future kernel-version skews.
 */
if (typeof process !== 'undefined' && process.env?.QANYICAT_DEBUG_PROBE === '1') {
  registerAction<SendFriendRequestParams, unknown>(
    'send_friend_request_probe',
    async (ctx: InstanceContext, params: SendFriendRequestParams): Promise<unknown> => {
      const peer = params.userId.startsWith('u_')
        ? { uid: params.userId }
        : { uin: params.userId };
      if (!ctx.apis.friend.sendRequestProbe) {
        throw new Error('friend.sendRequestProbe not available on this context');
      }
      return ctx.apis.friend.sendRequestProbe(peer, params.comment ?? '');
    }
  );
}

registerAction<Record<string, never>, unknown>(
  'get_login_info',
  async (ctx: InstanceContext): Promise<unknown> => {
    return {
      user_id: Number(ctx.uin),
      nickname: ctx.selfInfo.nick,
    };
  }
);

registerAction<Record<string, never>, unknown>(
  'get_status',
  async (ctx: InstanceContext): Promise<unknown> => {
    return {
      online: ctx.selfInfo.online,
      good: ctx.selfInfo.online,
    };
  }
);

registerAction<Record<string, never>, unknown>(
  'get_version_info',
  async (ctx: InstanceContext): Promise<unknown> => {
    return {
      app_name: 'qanyicat',
      app_version: '0.0.1',
      protocol_version: 'v11',
      qq_version: ctx.basicInfo.qqVersion,
    };
  }
);
