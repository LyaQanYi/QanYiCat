import { describe, expect, it } from 'vitest';
import { ob11ParamsToUnified } from '../src/converters/ob11/wire-params';

describe('ob11ParamsToUnified — request handling actions', () => {
  it('set_friend_add_request: forwards flag + approve + optional remark', async () => {
    const out = await ob11ParamsToUnified('set_friend_add_request', {
      flag: 'u_X|1700000000|0',
      approve: true,
      remark: 'Alice',
    });
    expect(out).toEqual({ flag: 'u_X|1700000000|0', approve: true, remark: 'Alice' });
  });

  it('set_friend_add_request: defaults approve=true when missing', async () => {
    const out = await ob11ParamsToUnified('set_friend_add_request', { flag: 'u_X|0|0' });
    expect(out).toMatchObject({ flag: 'u_X|0|0', approve: true });
  });

  it('set_friend_add_request: accepts string "false" as boolean', async () => {
    const out = await ob11ParamsToUnified('set_friend_add_request', {
      flag: 'u_X|0|0', approve: 'false',
    });
    expect(out).toMatchObject({ approve: false });
  });

  it('set_group_add_request: forwards flag + approve + optional reason', async () => {
    const out = await ob11ParamsToUnified('set_group_add_request', {
      flag: '17000000000|7|1234|0',
      approve: false,
      reason: 'sorry',
    });
    expect(out).toEqual({
      flag: '17000000000|7|1234|0', approve: false, reason: 'sorry',
    });
  });

  it('set_group_add_request: omits remark/reason when not provided', async () => {
    const out = await ob11ParamsToUnified('set_group_add_request', {
      flag: '17000000000|7|1234|0', approve: true,
    });
    expect(out).toEqual({ flag: '17000000000|7|1234|0', approve: true });
  });
});

describe('ob11ParamsToUnified — v0.4m-α forward send', () => {
  it('send_group_forward_msg: id-reference nodes → unified peer + nodes', async () => {
    const out = await ob11ParamsToUnified('send_group_forward_msg', {
      group_id: '100001',
      messages: [
        { type: 'node', data: { id: '10001:group:181:794068576' } },
        { type: 'node', data: { id: '10001:group:182:794068577' } },
      ],
    });
    expect(out).toEqual({
      peer: { type: 'group', id: '100001' },
      nodes: [
        { messageId: '10001:group:181:794068576' },
        { messageId: '10001:group:182:794068577' },
      ],
    });
  });

  it('send_private_forward_msg: user_id + node ids', async () => {
    const out = await ob11ParamsToUnified('send_private_forward_msg', {
      user_id: '10000',
      messages: [{ type: 'node', data: { id: 'mem-1' } }],
    });
    expect(out).toEqual({
      peer: { type: 'user', id: '10000' },
      nodes: [{ messageId: 'mem-1' }],
    });
  });

  it('send_forward_msg: discriminates group/private via group_id presence', async () => {
    const groupOut = await ob11ParamsToUnified('send_forward_msg', {
      group_id: '111', messages: [{ type: 'node', data: { id: 'a' } }],
    });
    expect(groupOut).toMatchObject({ peer: { type: 'group', id: '111' } });
    const privOut = await ob11ParamsToUnified('send_forward_msg', {
      user_id: '222', messages: [{ type: 'node', data: { id: 'b' } }],
    });
    expect(privOut).toMatchObject({ peer: { type: 'user', id: '222' } });
  });

  it('send_group_forward_msg: target_uid extension wins over group_id', async () => {
    const out = await ob11ParamsToUnified('send_group_forward_msg', {
      group_id: 'fallback', target_uid: '100001',
      messages: [{ type: 'node', data: { id: 'x' } }],
    });
    expect(out).toMatchObject({ peer: { type: 'group', id: '100001' } });
  });

  it('forward node: passes through bare `{messageId: "..."}` shape', async () => {
    const out = await ob11ParamsToUnified('send_group_forward_msg', {
      group_id: '1', messages: [{ messageId: 'compat' }],
    });
    expect(out).toMatchObject({ nodes: [{ messageId: 'compat' }] });
  });

  it('get_image/record/video/file: forwards { file }', async () => {
    for (const action of ['get_image', 'get_record', 'get_video', 'get_file']) {
      const out = await ob11ParamsToUnified(action, { file: 'abc123' });
      expect(out).toEqual({ file: 'abc123' });
    }
  });

  it('forward node: custom-content shape carries user_id + nickname + parsed segments', async () => {
    const out = await ob11ParamsToUnified('send_group_forward_msg', {
      group_id: '1',
      messages: [{
        type: 'node',
        data: { user_id: '12345', nickname: 'Alice', content: 'hello' },
      }],
    }) as { nodes: Array<{ userId?: string; nickname?: string; segments?: unknown[] }> };
    expect(out.nodes[0]).toEqual({
      userId: '12345', nickname: 'Alice',
      segments: [{ type: 'text', data: { text: 'hello' } }],
    });
  });
});
