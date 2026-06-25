import { describe, expect, it } from 'vitest';
import { OB11EventConverter } from '../src/converters/ob11/event';
import type { UnifiedEvent } from '@qanyicat/protocol';

describe('OB11EventConverter', () => {
  const conv = new OB11EventConverter('10000');

  it('builds a private message event with array message_format and CQ raw_message', () => {
    const event: UnifiedEvent = {
      kind: 'message',
      message: {
        id: 'mid',
        scene: 'private',
        selfId: '10000',
        sender: { uid: 'u_20000', uin: '20000', nickname: 'peer' },
        peer: { type: 'user', id: '20000' },
        segments: [{ type: 'text', data: { text: 'hi' } }],
        timestamp: 1_700_000_000_000,
      },
    };
    const ob11 = conv.fromUnified(event) as Record<string, unknown> | null;
    expect(ob11).not.toBeNull();
    expect(ob11).toMatchObject({
      post_type: 'message',
      message_type: 'private',
      sub_type: 'friend',
      message_id: 'mid',
      user_id: 20000,
      raw_message: 'hi',
      message_format: 'array',
      self_id: 10000,
      time: 1_700_000_000,
    });
  });

  it('marks self-sent messages with post_type=message_sent', () => {
    const event: UnifiedEvent = {
      kind: 'message',
      message: {
        id: 'mid', scene: 'private', selfId: '10000',
        sender: { uid: 'u_10000', uin: '10000' },
        peer: { type: 'user', id: '20000' },
        segments: [], timestamp: 0,
      },
    };
    const ob11 = conv.fromUnified(event) as Record<string, unknown>;
    expect(ob11.post_type).toBe('message_sent');
  });

  it('attaches group_id only for group messages', () => {
    const groupEvent: UnifiedEvent = {
      kind: 'message',
      message: {
        id: 'mid', scene: 'group', selfId: '10000',
        sender: { uid: 'u_99', uin: '99' },
        peer: { type: 'group', id: '1234' },
        segments: [], timestamp: 0,
      },
    };
    const ob11 = conv.fromUnified(groupEvent) as Record<string, unknown>;
    expect(ob11.message_type).toBe('group');
    expect(ob11.group_id).toBe(1234);
  });

  it('emits heartbeat with status and interval', () => {
    const hb = conv.buildHeartbeat(30_000, true);
    expect(hb).toMatchObject({
      post_type: 'meta_event',
      meta_event_type: 'heartbeat',
      interval: 30_000,
      status: { online: true, good: true },
      self_id: 10000,
    });
  });

  it('emits lifecycle.connect when given meta event', () => {
    const out = conv.fromUnified({ kind: 'meta', sub: 'lifecycle.connect' }) as Record<string, unknown>;
    expect(out).toMatchObject({
      post_type: 'meta_event',
      meta_event_type: 'lifecycle',
      sub_type: 'connect',
    });
  });

  it('emits notice/group_increase for member-join', () => {
    const out = conv.fromUnified({
      kind: 'notice',
      sub: 'group.member-join',
      groupId: '1234',
      userId: '20000',
    } as UnifiedEvent) as Record<string, unknown>;
    expect(out).toMatchObject({
      post_type: 'notice',
      notice_type: 'group_increase',
      sub_type: 'approve',
      group_id: 1234,
      user_id: 20000,
      operator_id: 0,
    });
  });

  it('emits notice/group_decrease with leave / kick / kick_me discriminator', () => {
    const leaveOut = conv.fromUnified({
      kind: 'notice', sub: 'group.member-leave', groupId: '1234', userId: '20000',
    } as UnifiedEvent) as Record<string, unknown>;
    expect(leaveOut).toMatchObject({ notice_type: 'group_decrease', sub_type: 'leave' });
    const kickOut = conv.fromUnified({
      kind: 'notice', sub: 'group.member-leave', groupId: '1234', userId: '20000', operatorId: '99',
    } as UnifiedEvent) as Record<string, unknown>;
    expect(kickOut).toMatchObject({ notice_type: 'group_decrease', sub_type: 'kick', operator_id: 99 });
    // kick_me — bot itself (selfUin='10000') was kicked by another admin.
    const kickMeOut = conv.fromUnified({
      kind: 'notice', sub: 'group.member-leave', groupId: '1234', userId: '10000', operatorId: '20000',
    } as UnifiedEvent) as Record<string, unknown>;
    expect(kickMeOut).toMatchObject({ notice_type: 'group_decrease', sub_type: 'kick_me', user_id: 10000, operator_id: 20000 });
  });

  it('emits notice/group_admin with set vs unset discriminator', () => {
    const setOut = conv.fromUnified({
      kind: 'notice', sub: 'group.admin-change', groupId: '1234', userId: '20000', isAdmin: true,
    } as UnifiedEvent) as Record<string, unknown>;
    expect(setOut).toMatchObject({ notice_type: 'group_admin', sub_type: 'set' });
    const unsetOut = conv.fromUnified({
      kind: 'notice', sub: 'group.admin-change', groupId: '1234', userId: '20000', isAdmin: false,
    } as UnifiedEvent) as Record<string, unknown>;
    expect(unsetOut).toMatchObject({ notice_type: 'group_admin', sub_type: 'unset' });
  });

  it('returns null for unsupported notice subs (group.mute, friend.add)', () => {
    const out = conv.fromUnified({
      kind: 'notice', sub: 'group.mute',
      groupId: 'g', userId: 'u', durationSec: 0, operatorId: 'o',
    } as UnifiedEvent);
    expect(out).toBeNull();
  });
});
