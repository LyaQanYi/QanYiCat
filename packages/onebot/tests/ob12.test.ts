import { describe, expect, it } from 'vitest';
import { OB12EventConverter } from '../src/converters/ob12/event';
import { ob12ToSegments, segmentsToOb12 } from '../src/converters/ob12/message';
import type { UnifiedEvent, UnifiedSegment } from '@qanyicat/protocol';

describe('OB12 segment converter', () => {
  it('renames keys per OB12 spec', () => {
    const segs: UnifiedSegment[] = [
      { type: 'text', data: { text: 'hello' } },
      { type: 'at', data: { uid: '42' } },
      { type: 'image', data: { file: 'abc.jpg', url: 'https://x' } },
      { type: 'reply', data: { id: 'mid-9' } },
    ];
    expect(segmentsToOb12(segs)).toEqual([
      { type: 'text', data: { text: 'hello' } },
      { type: 'mention', data: { user_id: '42' } },
      { type: 'image', data: { file_id: 'abc.jpg', url: 'https://x' } },
      { type: 'reply', data: { message_id: 'mid-9' } },
    ]);
  });

  it('inverse round-trip preserves the data', () => {
    const segs: UnifiedSegment[] = [
      { type: 'text', data: { text: 'x' } },
      { type: 'at', data: { uid: 'all' } },
      { type: 'image', data: { file: 'f1' } },
      { type: 'reply', data: { id: 'r1' } },
      { type: 'face', data: { id: 7 } },
    ];
    const wire = segmentsToOb12(segs);
    // mention_all is the inverse for at/all on the inbound side
    wire[1] = { type: 'mention_all', data: {} };
    expect(ob12ToSegments(wire)).toEqual(segs);
  });
});

describe('OB12EventConverter', () => {
  const conv = new OB12EventConverter('10000');

  it('builds a private message event with detail_type and alt_message', () => {
    const event: UnifiedEvent = {
      kind: 'message',
      message: {
        id: 'mid',
        scene: 'private',
        selfId: '10000',
        sender: { uid: 'u_2', uin: '2', nickname: 'p' },
        peer: { type: 'user', id: '2' },
        segments: [{ type: 'text', data: { text: 'hi' } }],
        timestamp: 1_700_000_000_000,
      },
    };
    const out = conv.fromUnified(event) as Record<string, unknown>;
    expect(out).toMatchObject({
      type: 'message',
      detail_type: 'private',
      message_id: 'mid',
      user_id: '2',
      alt_message: 'hi',
      self: { platform: 'qq', user_id: '10000' },
    });
    expect(out.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('emits group_id for group messages', () => {
    const out = conv.fromUnified({
      kind: 'message',
      message: {
        id: 'm', scene: 'group', selfId: '10000',
        sender: { uid: 'u', uin: '1' },
        peer: { type: 'group', id: 'g7' },
        segments: [], timestamp: 0,
      },
    } as UnifiedEvent) as Record<string, unknown>;
    expect(out.detail_type).toBe('group');
    expect(out.group_id).toBe('g7');
  });

  it('builds heartbeat with detail_type=heartbeat', () => {
    const hb = conv.buildHeartbeat(15_000);
    expect(hb).toMatchObject({
      type: 'meta',
      detail_type: 'heartbeat',
      interval: 15_000,
      self: { platform: 'qq', user_id: '10000' },
    });
  });

  it('emits lifecycle connect with version block', () => {
    const out = conv.fromUnified({ kind: 'meta', sub: 'lifecycle.connect' }) as Record<string, unknown>;
    expect(out).toMatchObject({
      type: 'meta',
      detail_type: 'connect',
      version: { impl: 'qanyicat', onebot_version: '12' },
    });
  });
});
