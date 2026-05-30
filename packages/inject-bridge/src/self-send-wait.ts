/**
 * v0.4m-β: bridge `msgService.sendMsg` into a Promise that resolves with the
 * resulting NT msgId. NT's sync return from `sendMsg` sometimes doesn't
 * carry `msgId` directly — the authoritative source is the next
 * `onAddSendMsg` event. This waiter lets the multi-forward-fabricated path
 * pre-register a predicate, fire `sendMsg`, then await the matching event.
 *
 * The bridge listener calls `notify(msg)` for every observed self-send;
 * predicates that match fire and resolve. Unmatched events are dropped (they
 * belong to ordinary wire-driven sends, not anything we're awaiting).
 */
export interface SelfSendInfo {
  peerUid: string;
  chatType: number;
  ntMsgId: string;
  msgSeq: string;
  msgRandom: string;
  msgTime: string;
}

interface Waiter {
  predicate: (info: SelfSendInfo) => boolean;
  resolve: (info: SelfSendInfo) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SelfSendWaiter {
  private waiters: Waiter[] = [];

  /** Called by the bridge listener for every self-originated message. */
  notify(m: Record<string, unknown>): void {
    if (this.waiters.length === 0) return;
    const ntMsgId = String(m.msgId ?? '');
    if (!ntMsgId) return;
    const info: SelfSendInfo = {
      peerUid: String(m.peerUid ?? ''),
      chatType: Number(m.chatType ?? 0),
      ntMsgId,
      msgSeq: String(m.msgSeq ?? ''),
      msgRandom: String(m.msgRandom ?? ''),
      msgTime: String(m.msgTime ?? ''),
    };
    for (let i = this.waiters.length - 1; i >= 0; i--) {
      const w = this.waiters[i];
      if (!w) continue;
      if (w.predicate(info)) {
        clearTimeout(w.timer);
        this.waiters.splice(i, 1);
        w.resolve(info);
      }
    }
  }

  /**
   * Register a predicate; resolves with the next matching self-send event.
   * Always plant BEFORE the corresponding sendMsg call to avoid the race
   * where the event fires before the predicate is registered.
   */
  waitNext(predicate: (info: SelfSendInfo) => boolean, timeoutMs = 8000): Promise<SelfSendInfo> {
    return new Promise<SelfSendInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        const idx = this.waiters.findIndex((w) => w.timer === timer);
        if (idx >= 0) this.waiters.splice(idx, 1);
        reject(new Error(`self-send wait timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      this.waiters.push({ predicate, resolve, reject, timer });
    });
  }

  get pending(): number {
    return this.waiters.length;
  }
}
