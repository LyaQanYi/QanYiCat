import type { InstanceContext } from '@qanyicat/core';
import { registerAction } from './registry';

registerAction<{ groupId: string }, unknown>(
  'get_group_info',
  async (ctx: InstanceContext, params: { groupId: string }): Promise<unknown> => {
    return ctx.apis.group.info(params.groupId);
  }
);

registerAction<{ groupId: string }, unknown[]>(
  'get_group_members',
  async (ctx: InstanceContext, params: { groupId: string }): Promise<unknown[]> => {
    return ctx.apis.group.members(params.groupId);
  }
);

registerAction<Record<string, never>, unknown[]>(
  'get_group_list',
  async (ctx: InstanceContext): Promise<unknown[]> => {
    return ctx.apis.group.list();
  }
);

registerAction<{ groupId: string; userId: string; durationSec: number }, void>(
  'set_group_mute',
  async (ctx: InstanceContext, params): Promise<void> => {
    const uid = await resolveUid(ctx, params.userId);
    return ctx.apis.group.mute(params.groupId, uid, params.durationSec);
  }
);

registerAction<{ groupId: string; userId: string; rejectAddRequest: boolean }, void>(
  'set_group_kick',
  async (ctx: InstanceContext, params): Promise<void> => {
    const uid = await resolveUid(ctx, params.userId);
    return ctx.apis.group.kick(params.groupId, uid, params.rejectAddRequest);
  }
);

/** Convert a wire `user_id` (uid `u_...` OR numeric uin) into a real uid. */
async function resolveUid(ctx: InstanceContext, userId: string): Promise<string> {
  if (userId.startsWith('u_')) return userId;
  if (/^\d+$/.test(userId)) {
    const resolved = await ctx.apis.user.uinToUid(userId);
    if (resolved) return resolved;
  }
  return userId;
}
