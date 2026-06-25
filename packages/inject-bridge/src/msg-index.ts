import type { NTPeer } from '@qanyicat/core';

/**
 * Composite-message-id → NT-side lookup table for actions that take the
 * wire-form `message_id` and need to resolve back to `(peer, ntMsgId)` for the
 * NT kernel call (e.g. `msgService.recallMsg(peer, [ntMsgId])`).
 *
 * The composite shape matches `CoreToUnified.deriveMessageId`:
 *   `${selfUin}:${chatType}:${msgSeq}:${msgRandom}`
 * Populated by the bridge's kernel listener on every observed message
 * (incoming and self-sent) so any message visible in OB11/OB12 events can be
 * the target of a follow-up action. Bounded by a FIFO cap so long-lived
 * sessions don't leak.
 */
export class MsgIndex {
  private byId = new Map<string, { peer: NTPeer; ntMsgId: string }>();
  private order: string[] = [];

  constructor(private readonly cap: number = 10_000) {}

  put(compositeId: string, peer: NTPeer, ntMsgId: string): void {
    if (!compositeId || !ntMsgId) return;
    if (this.byId.has(compositeId)) return;
    this.byId.set(compositeId, { peer, ntMsgId });
    this.order.push(compositeId);
    while (this.order.length > this.cap) {
      const evict = this.order.shift();
      if (evict !== undefined) this.byId.delete(evict);
    }
  }

  get(compositeId: string): { peer: NTPeer; ntMsgId: string } | undefined {
    return this.byId.get(compositeId);
  }

  /**
   * Reverse lookup: find the composite id for a given NT msgId.
   * Used by the recall path because NT re-emits the message with a different
   * msgSeq on recall, so we need to find the original composite that the wire
   * client already knows about. O(N) over the bounded index — fine in practice.
   */
  findCompositeByNtMsgId(ntMsgId: string): string | undefined {
    for (const [composite, entry] of this.byId) {
      if (entry.ntMsgId === ntMsgId) return composite;
    }
    return undefined;
  }

  get size(): number {
    return this.byId.size;
  }
}
