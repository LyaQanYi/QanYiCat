import { describe, expect, it } from 'vitest';
import {
  createMemoryContext,
  type InstanceContext,
  type NTPeer,
  type NTSendMessageResult,
} from '@qanyicat/core';
import { getAction } from '../src/actions/registry';
// Side-effect import so the registry picks up the action handlers.
import '../src/actions/message-actions';

type ForwardMsg = { ntMsgId: string; senderShowName?: string };
type FabricatedItem = { senderShowName: string; elements: unknown[] };

function ctxWithMockMsg(overrides: Partial<{
  findByCompositeId: (id: string) => Promise<{ peer: NTPeer; ntMsgId: string } | null>;
  multiForward: (src: NTPeer, dst: NTPeer, msgs: ForwardMsg[]) => Promise<NTSendMessageResult>;
  multiForwardFabricated: (dst: NTPeer, items: FabricatedItem[]) => Promise<NTSendMessageResult>;
}>): InstanceContext {
  const ctx = createMemoryContext({ uin: '10000' });
  if (overrides.findByCompositeId) {
    (ctx.apis.msg as { findByCompositeId: unknown }).findByCompositeId = overrides.findByCompositeId;
  }
  if (overrides.multiForward) {
    (ctx.apis.msg as { multiForward: unknown }).multiForward = overrides.multiForward;
  }
  if (overrides.multiForwardFabricated) {
    (ctx.apis.msg as { multiForwardFabricated: unknown }).multiForwardFabricated = overrides.multiForwardFabricated;
  }
  return ctx;
}

describe('send_forward_message action', () => {
  it('resolves a single id reference and calls multiForward', async () => {
    const calls: Array<{ src: NTPeer; dst: NTPeer; msgs: ForwardMsg[] }> = [];
    const ctx = ctxWithMockMsg({
      findByCompositeId: async (id: string) =>
        ({ peer: { chatType: 'group', peerUid: 'g_1234', groupCode: '1234' }, ntMsgId: `nt-${id}` }),
      multiForward: async (src: NTPeer, dst: NTPeer, msgs: ForwardMsg[]) => {
        calls.push({ src, dst, msgs });
        return { msgId: 'fwd-1', msgSeq: '99', msgTime: '1700000000' };
      },
    });
    const handler = getAction('send_forward_message')!;
    const out = await handler(ctx, {
      peer: { type: 'group', id: '999' },
      nodes: [{ messageId: 'a' }, { messageId: 'b' }],
    });
    expect(out).toEqual({ messageId: 'fwd-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.src.peerUid).toBe('g_1234');
    expect(calls[0]!.dst).toEqual({ chatType: 'group', peerUid: '999', groupCode: '999' });
    expect(calls[0]!.msgs).toEqual([{ ntMsgId: 'nt-a' }, { ntMsgId: 'nt-b' }]);
  });

  it('throws when a node id is unknown to the index', async () => {
    const ctx = ctxWithMockMsg({ findByCompositeId: async () => null });
    const handler = getAction('send_forward_message')!;
    await expect(handler(ctx, {
      peer: { type: 'group', id: '1' },
      nodes: [{ messageId: 'missing' }],
    })).rejects.toThrow(/not found in in-memory index/);
  });

  it('throws when nodes resolve to different source peers', async () => {
    const ctx = ctxWithMockMsg({
      findByCompositeId: async (id: string) =>
        id === 'a'
          ? { peer: { chatType: 'group', peerUid: 'gA', groupCode: 'gA' }, ntMsgId: 'nt-a' }
          : { peer: { chatType: 'group', peerUid: 'gB', groupCode: 'gB' }, ntMsgId: 'nt-b' },
    });
    const handler = getAction('send_forward_message')!;
    await expect(handler(ctx, {
      peer: { type: 'group', id: '1' },
      nodes: [{ messageId: 'a' }, { messageId: 'b' }],
    })).rejects.toThrow(/all nodes must share one source peer/);
  });

  it('rejects empty nodes array', async () => {
    const ctx = ctxWithMockMsg({});
    const handler = getAction('send_forward_message')!;
    await expect(handler(ctx, {
      peer: { type: 'user', id: '1' }, nodes: [],
    })).rejects.toThrow(/nodes array must not be empty/);
  });

  it('routes all-custom nodes through multiForwardFabricated', async () => {
    const calls: Array<{ dst: NTPeer; items: FabricatedItem[] }> = [];
    const ctx = ctxWithMockMsg({
      multiForwardFabricated: async (dst: NTPeer, items: FabricatedItem[]) => {
        calls.push({ dst, items });
        return { msgId: 'fab-1', msgSeq: '42', msgTime: '1700000000' };
      },
    });
    const handler = getAction('send_forward_message')!;
    const out = await handler(ctx, {
      peer: { type: 'group', id: '999' },
      nodes: [
        { userId: '11', nickname: 'Alice', segments: [{ type: 'text', data: { text: 'hello' } }] },
        { userId: '22', nickname: 'Bob', segments: [{ type: 'text', data: { text: 'world' } }] },
      ],
    });
    expect(out).toEqual({ messageId: 'fab-1' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.dst).toEqual({ chatType: 'group', peerUid: '999', groupCode: '999' });
    expect(calls[0]!.items).toHaveLength(2);
    expect(calls[0]!.items[0]!.senderShowName).toBe('Alice');
    expect(calls[0]!.items[1]!.senderShowName).toBe('Bob');
    // text segment → NT element with elementType=1 and textElement.content='hello'
    const firstEls = calls[0]!.items[0]!.elements as Array<{ elementType: number; textElement?: { content: string } }>;
    expect(firstEls[0]!.elementType).toBe(1);
    expect(firstEls[0]!.textElement!.content).toBe('hello');
  });

  it('rejects mixed reference + custom nodes', async () => {
    const ctx = ctxWithMockMsg({});
    const handler = getAction('send_forward_message')!;
    await expect(handler(ctx, {
      peer: { type: 'group', id: '1' },
      nodes: [
        { messageId: 'a' },
        { userId: '22', nickname: 'Bob', segments: [{ type: 'text', data: { text: 'x' } }] },
      ],
    })).rejects.toThrow(/mixed reference \+ custom nodes not yet supported/);
  });
});
