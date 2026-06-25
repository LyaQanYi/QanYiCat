import type { InstanceContext } from '@qanyicat/core';
import { segmentsToNtElements } from '../normalize/segment-converter';
import type { UnifiedSegment, UnifiedForwardNode } from '../message/segments';
import type { UnifiedPeer } from '../message/unified-message';
import { CoreToUnified } from '../normalize/core-to-unified';
import { registerAction } from './registry';

export interface SendMessageParams {
  peer: UnifiedPeer;
  segments: UnifiedSegment[];
}

export interface SendMessageResult {
  messageId: string;
}

registerAction<SendMessageParams, SendMessageResult>(
  'send_message',
  async (ctx: InstanceContext, params: SendMessageParams): Promise<SendMessageResult> => {
    const elements = segmentsToNtElements(params.segments);
    const result = await ctx.apis.msg.send({
      peer: {
        chatType: params.peer.type === 'group' ? 'group' : 'private',
        peerUid: params.peer.id,
        ...(params.peer.type === 'user' ? { peerUin: params.peer.id } : {}),
        ...(params.peer.type === 'group' ? { groupCode: params.peer.id } : {}),
      },
      elements,
    });
    return { messageId: result.msgId };
  }
);

registerAction<{ messageId: string }, void>(
  'recall_message',
  async (ctx: InstanceContext, params: { messageId: string }): Promise<void> => {
    const resolved = await ctx.apis.msg.findByCompositeId(params.messageId);
    if (!resolved) {
      throw new Error(`message_id "${params.messageId}" not found in in-memory index (evicted or never observed by this process)`);
    }
    await ctx.apis.msg.recall(resolved.peer, [resolved.ntMsgId]);
  }
);

export interface GetHistoryMessagesParams {
  peer: UnifiedPeer;
  count: number;
  anchorMessageId?: string;
}

registerAction<GetHistoryMessagesParams, { messages: unknown[] }>(
  'get_history_messages',
  async (ctx: InstanceContext, params: GetHistoryMessagesParams): Promise<{ messages: unknown[] }> => {
    const ntPeer = {
      chatType: params.peer.type === 'group' ? 'group' as const : 'private' as const,
      peerUid: params.peer.id,
    };
    const raws = await ctx.apis.msg.fetchHistory(ntPeer, params.count, params.anchorMessageId);
    return { messages: raws.map((r) => CoreToUnified.message(r, ctx)) };
  }
);

registerAction<{ messageId: string }, unknown>(
  'get_message',
  async (ctx: InstanceContext, params: { messageId: string }): Promise<unknown> => {
    const resolved = await ctx.apis.msg.findByCompositeId(params.messageId);
    if (!resolved) {
      throw new Error(`message_id "${params.messageId}" not in in-memory index`);
    }
    const raw = await ctx.apis.msg.fetch(resolved.peer, resolved.ntMsgId);
    if (!raw) return null;
    return CoreToUnified.message(raw, ctx);
  }
);

/**
 * v0.4n-α: resolve a media segment's `file` identifier (md5 / fileUuid) to a
 * downloadable URL. Backed by an in-memory media index populated when the
 * message was observed; cold-start or evicted ids return `null`.
 */
registerAction<{ file: string }, { file: string; url: string } | null>(
  'get_media_url',
  async (ctx: InstanceContext, params: { file: string }): Promise<{ file: string; url: string } | null> => {
    if (!params.file) throw new Error('get_media_url: missing file');
    return ctx.apis.msg.getMediaUrl(params.file);
  }
);

export interface SendForwardMessageParams {
  peer: UnifiedPeer;
  nodes: UnifiedForwardNode[];
}

export interface SendForwardMessageResult {
  messageId: string;
}

/**
 * v0.4m-α / v0.4m-β: build a multi-forward chain.
 *
 * Reference nodes (`{messageId}`) — must all resolve to the same source peer
 * (NT's `multiForwardMsgWithComment` groups by srcContact). Looked up via the
 * in-memory msgIndex; cold-start callers must observe the source msgs first.
 *
 * Custom nodes (`{userId, nickname, segments, time?}`) — fabricated content.
 * Each segment chain is translated to NT elements and sent to the bot's own
 * self-private chat to materialize an NT msgId; the chain is then forwarded
 * from selfPrivate → dstPeer with each node's `nickname` as the per-msg
 * `senderShowName` on the resulting card. Side-effect: the fabricated msgs
 * appear in the bot's self-chat history. The `userId` field is currently
 * informational only — NT renders the card from `senderShowName`.
 *
 * Mixed reference + custom nodes are NOT supported in v0.4m-β-1 (would
 * require re-uploading the referenced msgs as fabricated, doable but adds
 * latency — defer to v0.4m-β-2 if needed).
 */
registerAction<SendForwardMessageParams, SendForwardMessageResult>(
  'send_forward_message',
  async (ctx: InstanceContext, params: SendForwardMessageParams): Promise<SendForwardMessageResult> => {
    if (!params.nodes || params.nodes.length === 0) {
      throw new Error('send_forward_message: nodes array must not be empty');
    }
    let hasRef = false;
    let hasCustom = false;
    for (const n of params.nodes) {
      if ('messageId' in n) hasRef = true;
      else hasCustom = true;
    }
    if (hasRef && hasCustom) {
      throw new Error('send_forward_message: mixed reference + custom nodes not yet supported; use all-ref OR all-custom');
    }

    const dstPeer: import('@qanyicat/core').NTPeer = params.peer.type === 'group'
      ? { chatType: 'group', peerUid: params.peer.id, groupCode: params.peer.id }
      : { chatType: 'private', peerUid: params.peer.id, peerUin: params.peer.id };

    if (hasCustom) {
      const items: Array<{ senderShowName: string; elements: unknown[] }> = [];
      for (const n of params.nodes) {
        if ('messageId' in n) continue; // exhaustiveness guarded above
        const elements = segmentsToNtElements(n.segments);
        items.push({ senderShowName: n.nickname, elements });
      }
      const result = await ctx.apis.msg.multiForwardFabricated(dstPeer, items);
      return { messageId: result.msgId };
    }

    // Reference-only path (v0.4m-α).
    let srcPeer: import('@qanyicat/core').NTPeer | null = null;
    const refMsgs: Array<{ ntMsgId: string }> = [];
    for (const n of params.nodes) {
      if (!('messageId' in n)) continue;
      const resolved = await ctx.apis.msg.findByCompositeId(n.messageId);
      if (!resolved) {
        throw new Error(`send_forward_message: message_id "${n.messageId}" not found in in-memory index (evicted or never observed)`);
      }
      if (srcPeer === null) {
        srcPeer = resolved.peer;
      } else if (resolved.peer.peerUid !== srcPeer.peerUid || resolved.peer.chatType !== srcPeer.chatType) {
        throw new Error(`send_forward_message: all nodes must share one source peer; got ${srcPeer.peerUid} and ${resolved.peer.peerUid}`);
      }
      refMsgs.push({ ntMsgId: resolved.ntMsgId });
    }
    if (!srcPeer) throw new Error('send_forward_message: failed to derive source peer');
    const result = await ctx.apis.msg.multiForward(srcPeer, dstPeer, refMsgs);
    return { messageId: result.msgId };
  }
);
