import { describe, expect, it } from 'vitest';
import { cqToSegments, segmentsToCq } from '../src/converters/ob11/message-cq';
import type { UnifiedSegment } from '@qanyicat/protocol';

describe('CQ-code encode', () => {
  it('escapes text reserved characters', () => {
    const segs: UnifiedSegment[] = [{ type: 'text', data: { text: 'a [b] & c' } }];
    expect(segmentsToCq(segs)).toBe('a &#91;b&#93; &amp; c');
  });

  it('emits non-text segments with params', () => {
    const segs: UnifiedSegment[] = [
      { type: 'at', data: { uid: '42' } },
      { type: 'text', data: { text: ' hi' } },
    ];
    expect(segmentsToCq(segs)).toBe('[CQ:at,uid=42] hi');
  });
});

describe('CQ-code decode', () => {
  it('round-trips at + text', () => {
    const original: UnifiedSegment[] = [
      { type: 'at', data: { uid: '42' } },
      { type: 'text', data: { text: ' hello' } },
    ];
    const back = cqToSegments(segmentsToCq(original));
    expect(back).toEqual([
      { type: 'at', data: { uid: '42' } },
      { type: 'text', data: { text: ' hello' } },
    ]);
  });

  it('decodes face with id', () => {
    expect(cqToSegments('[CQ:face,id=178]')).toEqual([{ type: 'face', data: { id: 178 } }]);
  });

  it('decodes image with optional url', () => {
    const decoded = cqToSegments('[CQ:image,file=abc.jpg,url=https://x/y]');
    expect(decoded).toEqual([
      { type: 'image', data: { file: 'abc.jpg', url: 'https://x/y' } },
    ]);
  });

  it('unescapes &amp; &#91; &#93; &#44; in text and params', () => {
    expect(cqToSegments('a &amp; b &#91;c&#93;')).toEqual([
      { type: 'text', data: { text: 'a & b [c]' } },
    ]);
  });

  it('treats unknown CQ types as literal text fallback', () => {
    expect(cqToSegments('[CQ:unknown_thing,x=1]')).toEqual([
      { type: 'text', data: { text: '[CQ:unknown_thing]' } },
    ]);
  });
});
