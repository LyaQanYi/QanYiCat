import { describe, expect, it } from 'vitest';
import { ob12ParamsToUnified } from '../src/converters/ob12/wire-params';

describe('ob12ParamsToUnified', () => {
  it('send_message private with mention resolved via resolver', async () => {
    const resolver = async (uin: string) => (uin === '42' ? { uid: 'u_alice', nick: 'Alice' } : null);
    const out = await ob12ParamsToUnified(
      'send_message',
      {
        detail_type: 'private',
        user_id: '99',
        message: [
          { type: 'text', data: { text: 'hi ' } },
          { type: 'mention', data: { user_id: '42' } },
        ],
      },
      resolver
    );
    expect(out).toEqual({
      peer: { type: 'user', id: '99' },
      segments: [
        { type: 'text', data: { text: 'hi ' } },
        { type: 'at', data: { uid: 'u_alice', uin: '42', name: 'Alice' } },
      ],
    });
  });

  it('send_message group with mention_all', async () => {
    const out = await ob12ParamsToUnified('send_message', {
      detail_type: 'group',
      group_id: '12345',
      message: [{ type: 'mention_all', data: {} }],
    });
    expect(out).toEqual({
      peer: { type: 'group', id: '12345' },
      segments: [{ type: 'at', data: { uid: 'all' } }],
    });
  });

  it('mention with unresolved uin leaves the numeric uid in place', async () => {
    const resolver = async () => null;
    const out = await ob12ParamsToUnified('send_message', {
      detail_type: 'private',
      user_id: '7',
      message: [{ type: 'mention', data: { user_id: '777' } }],
    }, resolver) as { segments: unknown[] };
    expect(out.segments).toEqual([{ type: 'at', data: { uid: '777' } }]);
  });

  it('delete_message translates message_id → messageId', async () => {
    const out = await ob12ParamsToUnified('delete_message', { message_id: 'abc' });
    expect(out).toEqual({ messageId: 'abc' });
  });

  it('get_group_member_list translates group_id → groupId', async () => {
    const out = await ob12ParamsToUnified('get_group_member_list', { group_id: '42' });
    expect(out).toEqual({ groupId: '42' });
  });

  it('get_user_info honours target_uid extension', async () => {
    const out = await ob12ParamsToUnified('get_user_info', { target_uid: 'u_x', user_id: '111' });
    expect(out).toEqual({ userId: 'u_x' });
  });

  it('zero-arg actions translate to empty object', async () => {
    expect(await ob12ParamsToUnified('get_friend_list', null)).toEqual({});
    expect(await ob12ParamsToUnified('get_status', undefined)).toEqual({});
    expect(await ob12ParamsToUnified('get_version_info', {})).toEqual({});
  });

  it('unknown actions pass through unchanged', async () => {
    const params = { foo: 'bar' };
    const out = await ob12ParamsToUnified('qq.do_something_weird', params);
    expect(out).toBe(params);
  });
});
