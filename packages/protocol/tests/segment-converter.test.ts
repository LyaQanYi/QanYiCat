import { describe, expect, it } from 'vitest';
import { NTElementType, type NTElement } from '@qanyicat/core';
import { ntElementsToSegments, segmentsToNtElements } from '../src/normalize/segment-converter';
import type { UnifiedSegment } from '../src/message/segments';

describe('ntElementsToSegments', () => {
  it('extracts plain text content', () => {
    const elements: NTElement[] = [
      { elementType: NTElementType.TEXT, textElement: { content: 'hello world' } },
    ];
    expect(ntElementsToSegments(elements)).toEqual([
      { type: 'text', data: { text: 'hello world' } },
    ]);
  });

  it('treats atType=1 as an @-user segment', () => {
    const elements: NTElement[] = [
      {
        elementType: NTElementType.TEXT,
        textElement: { content: '', atType: 1, atUid: 'u_42', atNtUid: '42' },
      },
    ];
    expect(ntElementsToSegments(elements)).toEqual([
      { type: 'at', data: { uid: 'u_42', uin: '42' } },
    ]);
  });

  it('treats atType=2 as @all', () => {
    const elements: NTElement[] = [
      { elementType: NTElementType.TEXT, textElement: { content: '', atType: 2 } },
    ];
    expect(ntElementsToSegments(elements)[0]).toEqual({ type: 'at', data: { uid: 'all' } });
  });

  it('maps picture elements with md5 and url', () => {
    const elements: NTElement[] = [
      {
        elementType: NTElementType.PIC,
        picElement: { md5HexStr: 'abc123', originImageUrl: 'https://x/y' },
      },
    ];
    expect(ntElementsToSegments(elements)).toEqual([
      { type: 'image', data: { file: 'abc123', url: 'https://x/y' } },
    ]);
  });

  it('skips empty text elements that are not at-mentions', () => {
    const elements: NTElement[] = [
      { elementType: NTElementType.TEXT, textElement: { content: '' } },
    ];
    expect(ntElementsToSegments(elements)).toEqual([]);
  });

  it('maps reply elements using replayMsgId then replayMsgSeq', () => {
    const a: NTElement[] = [
      {
        elementType: NTElementType.REPLY,
        replyElement: { replayMsgSeq: '99', replayMsgId: 'msg-99' },
      },
    ];
    expect(ntElementsToSegments(a)[0]).toEqual({ type: 'reply', data: { id: 'msg-99' } });

    const b: NTElement[] = [
      { elementType: NTElementType.REPLY, replyElement: { replayMsgSeq: '99', replayMsgId: '' } },
    ];
    expect(ntElementsToSegments(b)[0]).toEqual({ type: 'reply', data: { id: '99' } });
  });

  it('ark element with com.tencent.multimsg becomes forward segment', () => {
    const bytesData = JSON.stringify({
      app: 'com.tencent.multimsg',
      meta: { detail: { resid: 'r_abc123', source: '群聊的聊天记录' } },
    });
    const a: NTElement[] = [{ elementType: NTElementType.ARK, arkElement: { bytesData } }];
    expect(ntElementsToSegments(a)).toEqual([{ type: 'forward', data: { id: 'r_abc123' } }]);
  });

  it('ark element with other app falls back to json segment', () => {
    const bytesData = JSON.stringify({ app: 'com.tencent.miniapp', meta: {} });
    const a: NTElement[] = [{ elementType: NTElementType.ARK, arkElement: { bytesData } }];
    expect(ntElementsToSegments(a)).toEqual([{ type: 'json', data: { data: bytesData } }]);
  });

  it('ark element with non-JSON bytesData falls back to json segment', () => {
    const a: NTElement[] = [{ elementType: NTElementType.ARK, arkElement: { bytesData: 'not-json' } }];
    expect(ntElementsToSegments(a)).toEqual([{ type: 'json', data: { data: 'not-json' } }]);
  });

  it('ark element with empty bytesData is dropped', () => {
    const a: NTElement[] = [{ elementType: NTElementType.ARK, arkElement: { bytesData: '' } }];
    expect(ntElementsToSegments(a)).toEqual([]);
  });
});

describe('segmentsToNtElements (inverse)', () => {
  it('round-trips plain text', () => {
    const segments: UnifiedSegment[] = [{ type: 'text', data: { text: 'hi' } }];
    const elements = segmentsToNtElements(segments);
    expect(ntElementsToSegments(elements)).toEqual(segments);
  });

  it('round-trips at-user', () => {
    const segments: UnifiedSegment[] = [{ type: 'at', data: { uid: 'u_7', uin: '7' } }];
    expect(ntElementsToSegments(segmentsToNtElements(segments))).toEqual(segments);
  });

  it('round-trips at-all', () => {
    const segments: UnifiedSegment[] = [{ type: 'at', data: { uid: 'all' } }];
    expect(ntElementsToSegments(segmentsToNtElements(segments))).toEqual(segments);
  });

  it('round-trips face id', () => {
    const segments: UnifiedSegment[] = [{ type: 'face', data: { id: 178 } }];
    expect(ntElementsToSegments(segmentsToNtElements(segments))).toEqual(segments);
  });
});
