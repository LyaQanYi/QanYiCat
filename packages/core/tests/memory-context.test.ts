import { describe, expect, it } from 'vitest';
import { createMemoryContext, NTElementType } from '../src';

describe('createMemoryContext', () => {
  it('exposes the configured uin and nick', async () => {
    const ctx = createMemoryContext({ uin: '12345', nick: 'tester' });
    expect(ctx.uin).toBe('12345');
    expect(ctx.selfInfo).toMatchObject({ uin: '12345', uid: 'u_12345', nick: 'tester', online: true });
    await ctx.dispose();
  });

  it('emits a login.success event on the bus right after creation', async () => {
    const ctx = createMemoryContext({ uin: '10000' });
    const seen = await new Promise<{ uin: string; uid: string }>((resolve) => {
      ctx.events.on('login.success', resolve);
    });
    expect(seen).toEqual({ uin: '10000', uid: 'u_10000' });
    await ctx.dispose();
  });

  it('echoes a send via apis.msg.send back as msg.recv', async () => {
    const ctx = createMemoryContext({ uin: '10000' });
    const received = new Promise<{ peer: unknown; messages: unknown[] }>((resolve) => {
      ctx.events.on('msg.recv', resolve);
    });

    await ctx.apis.msg.send({
      peer: { chatType: 'private', peerUid: 'u_2', peerUin: '2' },
      elements: [{ elementType: NTElementType.TEXT, textElement: { content: 'echo me' } }],
    });

    const payload = await received;
    expect(payload.messages).toHaveLength(1);
    const [first] = payload.messages as Array<{ senderUid: string; elements: unknown[] }>;
    expect(first.senderUid).toBe('u_10000');
    expect(first.elements).toEqual([
      { elementType: NTElementType.TEXT, textElement: { content: 'echo me' } },
    ]);

    await ctx.dispose();
  });

  it('reports offline after dispose', async () => {
    const ctx = createMemoryContext({ uin: '1' });
    await ctx.dispose();
    expect(ctx.selfInfo.online).toBe(false);
  });
});
