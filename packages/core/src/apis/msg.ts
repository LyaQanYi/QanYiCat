import type { NTPeer, NTRawMessage } from '../event/nt-event-bus';

export interface NTSendMessageParams {
  peer: NTPeer;
  elements: unknown[];
}

export interface NTSendMessageResult {
  msgId: string;
  msgSeq: string;
  msgTime: string;
}

export interface NTMsgApi {
  send(params: NTSendMessageParams): Promise<NTSendMessageResult>;
  recall(peer: NTPeer, msgIds: string[]): Promise<void>;
  /**
   * Resolve a wire-form composite message id (as emitted on OB11 events) to
   * the NT-side `(peer, ntMsgId)` tuple. Returns `null` if the id was never
   * seen by this process or has been evicted from the in-memory index.
   */
  findByCompositeId(messageId: string): Promise<{ peer: NTPeer; ntMsgId: string } | null>;
  fetch(peer: NTPeer, msgId: string): Promise<NTRawMessage | null>;
  fetchHistory(peer: NTPeer, count: number, anchorMsgId?: string): Promise<NTRawMessage[]>;
  /**
   * v0.4m-α / v0.4m-β: build a multi-forward chain. All entries in `msgs`
   * must belong to `srcPeer`. Each entry's `senderShowName` overrides the
   * per-msg name rendered on the forward card; if omitted the bridge falls
   * back to the bot's own nickname.
   *
   * Returns the destination-side multi-forward msg id (the resId is on the
   * resulting ark element's `meta.detail.resid`).
   */
  multiForward(
    srcPeer: NTPeer,
    dstPeer: NTPeer,
    msgs: Array<{ ntMsgId: string; senderShowName?: string }>
  ): Promise<NTSendMessageResult>;
  /**
   * v0.4m-β: forward fabricated messages — each item supplies its own
   * `senderShowName` and `elements` (already translated from segments). The
   * bridge sends each item to `self <-> self` private chat to materialize an
   * NT msgId, then forwards the resulting chain from selfPrivate → `dstPeer`
   * via the same `multiForwardMsgWithComment` primitive. Side-effect:
   * pollutes the bot's self-chat history.
   */
  multiForwardFabricated(
    dstPeer: NTPeer,
    items: Array<{ senderShowName: string; elements: unknown[] }>
  ): Promise<NTSendMessageResult>;
  /**
   * v0.4n-α: look up a downloadable URL for a previously-observed media
   * element by its wire-side identifier (`md5HexStr` for images/voice/video,
   * `fileUuid` for files). Returns `null` if the key is unknown — the wire
   * client should treat that as "expired from in-memory index, can't fetch".
   * Implementations may need to wrap NT's listener-style downloads.
   */
  getMediaUrl(file: string): Promise<{ file: string; url: string } | null>;
}
