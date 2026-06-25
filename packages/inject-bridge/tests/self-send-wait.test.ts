import { describe, expect, it } from 'vitest';
import { SelfSendWaiter } from '../src/self-send-wait';

describe('SelfSendWaiter', () => {
  it('resolves the first matching waiter and leaves others pending', async () => {
    const w = new SelfSendWaiter();
    const target = w.waitNext((i) => i.peerUid === 'u_target');
    const other = w.waitNext((i) => i.peerUid === 'u_other');
    w.notify({ msgId: 'ntid-1', peerUid: 'u_target', chatType: 1, msgSeq: '10', msgRandom: '99', msgTime: '1700' });
    const observed = await target;
    expect(observed.ntMsgId).toBe('ntid-1');
    expect(observed.peerUid).toBe('u_target');
    expect(w.pending).toBe(1);
    // Cleanly cancel the other waiter via timeout-based reject.
    other.catch(() => undefined);
  });

  it('rejects on timeout', async () => {
    const w = new SelfSendWaiter();
    await expect(w.waitNext(() => true, 50)).rejects.toThrow(/self-send wait timeout/);
    expect(w.pending).toBe(0);
  });

  it('ignores notifications with no msgId', () => {
    const w = new SelfSendWaiter();
    const p = w.waitNext(() => true);
    w.notify({ msgId: '', peerUid: 'u_x' });
    expect(w.pending).toBe(1);
    p.catch(() => undefined);
  });

  it('resolves the next matching event for multiple waiters on the same peer (LIFO splice)', async () => {
    const w = new SelfSendWaiter();
    const a = w.waitNext((i) => i.peerUid === 'u_self');
    const b = w.waitNext((i) => i.peerUid === 'u_self');
    w.notify({ msgId: 'ntid-A', peerUid: 'u_self', chatType: 1, msgSeq: '1', msgRandom: '1', msgTime: '1' });
    // Both predicates match, so both resolve from a single notify.
    const [ra, rb] = await Promise.all([a, b]);
    expect(ra.ntMsgId).toBe('ntid-A');
    expect(rb.ntMsgId).toBe('ntid-A');
    expect(w.pending).toBe(0);
  });
});
