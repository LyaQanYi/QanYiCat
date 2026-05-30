import { describe, expect, it } from 'vitest';
import { isRecallUpdate } from '../src/index';

/**
 * v0.4j-α-fix regression: NT also fires msgType=5 for non-recall
 * delivery-state updates (notably the 6-14s post-multi-forward kernel echo).
 * Without the subMsgType=4 gate we used to emit phantom group_recall notices.
 */
describe('isRecallUpdate', () => {
  it('treats msgType=5 + subMsgType=4 as a recall', () => {
    expect(isRecallUpdate({ msgType: 5, subMsgType: 4, msgId: 'x' })).toBe(true);
  });

  it('rejects msgType=5 with other subMsgTypes (post-multi-forward echo etc.)', () => {
    expect(isRecallUpdate({ msgType: 5, subMsgType: 1, msgId: 'x' })).toBe(false);
    expect(isRecallUpdate({ msgType: 5, subMsgType: 7, msgId: 'x' })).toBe(false);
    expect(isRecallUpdate({ msgType: 5, msgId: 'x' })).toBe(false);
  });

  it('rejects unrelated msgTypes regardless of subMsgType', () => {
    expect(isRecallUpdate({ msgType: 2, subMsgType: 4 })).toBe(false);
    expect(isRecallUpdate({ msgType: 11, subMsgType: 7 })).toBe(false);
  });

  it('rejects malformed entries without throwing', () => {
    expect(isRecallUpdate({})).toBe(false);
    expect(isRecallUpdate({ msgType: '5' as unknown as number, subMsgType: 4 })).toBe(false);
  });
});
