import { describe, expect, it } from 'vitest';
import { decodeSysMsg } from '../src/sysmsg-decode';

/** Encode a uint as a protobuf varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return out;
}

/** Length-delimited field (wire type 2). */
function lenField(num: number, value: number[]): number[] {
  const tag = (num << 3) | 2;
  return [tag, ...varint(value.length), ...value];
}

/** Varint field (wire type 0). */
function varField(num: number, n: number): number[] {
  const tag = (num << 3) | 0;
  return [tag, ...varint(n)];
}

/**
 * Build a PushMsgBody-shape protobuf for the sysmsg decoder.
 * shape: { 1: responseHead (empty), 2: contentHead {type}, 3: messageBody {2: msgContent} }
 */
function buildPushMsg(contentType: number, msgContent: number[]): number[] {
  const responseHead: number[] = [];
  const contentHead = varField(1, contentType);
  const messageBody = lenField(2, msgContent);   // field 2 = msgContent (bytes)
  return [
    ...lenField(1, responseHead),
    ...lenField(2, contentHead),
    ...lenField(3, messageBody),
  ];
}

describe('sysmsg-decode', () => {
  it('returns null for empty / malformed input', () => {
    expect(decodeSysMsg([])).toBe(null);
    expect(decodeSysMsg([0xff, 0xff, 0xff])).toBe(null);
  });

  it('decodes type 33 (group member increase) as join', () => {
    // GroupChange { 1: groupUin=100001, 3: memberUid='u_X', 6: increaseType=6 }
    const groupChange = [
      ...varField(1, 100001),
      ...lenField(3, Array.from(new TextEncoder().encode('u_X'))),
      ...varField(6, 6),
    ];
    const decoded = decodeSysMsg(buildPushMsg(33, groupChange));
    expect(decoded).toMatchObject({
      kind: 'group.member-change',
      groupCode: '100001',
      memberUid: 'u_X',
      sub: 'join',
      sourceType: 6,
    });
  });

  it('decodes type 34 (group member decrease) with decreaseType discriminator', () => {
    const cases: Array<[number, string]> = [
      [130, 'leave'],
      [131, 'kick'],
      [3,   'kick_me'],
      [129, 'disband'],
    ];
    for (const [decreaseType, expectedSub] of cases) {
      const groupChange = [
        ...varField(1, 100),
        ...lenField(3, Array.from(new TextEncoder().encode('u_Y'))),
        ...varField(4, decreaseType),
      ];
      const decoded = decodeSysMsg(buildPushMsg(34, groupChange));
      expect(decoded).toMatchObject({
        kind: 'group.member-change',
        groupCode: '100',
        memberUid: 'u_Y',
        sub: expectedSub,
        sourceType: decreaseType,
      });
    }
  });

  it('extracts operatorUid from protobuf-shaped operatorInfo (0x0a prefix)', () => {
    // GroupChangeInfo {1: GroupChangeOperator {1: operatorUid='u_OP'}}
    const operatorBytes = lenField(1, Array.from(new TextEncoder().encode('u_OP')));
    const groupChangeInfo = lenField(1, operatorBytes);
    const groupChange = [
      ...varField(1, 100),
      ...lenField(3, Array.from(new TextEncoder().encode('u_Y'))),
      ...varField(4, 131),
      ...lenField(5, groupChangeInfo),
    ];
    const decoded = decodeSysMsg(buildPushMsg(34, groupChange));
    expect(decoded).toMatchObject({ sub: 'kick', operatorUid: 'u_OP' });
  });

  it('extracts operatorUid from bare-ASCII operatorInfo (no 0x0a prefix)', () => {
    // operatorInfo is raw ASCII bytes — NT uses this form when uid fits cleanly.
    const operatorAscii = Array.from(new TextEncoder().encode('u_ABCDEF'));
    const groupChange = [
      ...varField(1, 100),
      ...lenField(3, Array.from(new TextEncoder().encode('u_Y'))),
      ...varField(4, 131),
      ...lenField(5, operatorAscii),
    ];
    const decoded = decodeSysMsg(buildPushMsg(34, groupChange));
    expect(decoded).toMatchObject({ sub: 'kick', operatorUid: 'u_ABCDEF' });
  });

  it('decodes type 44 (group admin change) — promote', () => {
    // GroupAdmin {1: groupUin, 4: body {2: extraEnable {1: adminUid}}}
    const extraEnable = lenField(1, Array.from(new TextEncoder().encode('u_NEWADMIN')));
    const body = lenField(2, extraEnable);
    const groupAdmin = [
      ...varField(1, 555),
      ...lenField(4, body),
    ];
    const decoded = decodeSysMsg(buildPushMsg(44, groupAdmin));
    expect(decoded).toMatchObject({
      kind: 'group.admin-change',
      groupCode: '555',
      adminUid: 'u_NEWADMIN',
      isAdmin: true,
    });
  });

  it('decodes type 44 — demote (extraDisable)', () => {
    const extraDisable = lenField(1, Array.from(new TextEncoder().encode('u_DEMOTED')));
    const body = lenField(1, extraDisable);  // field 1 inside body = extraDisable
    const groupAdmin = [
      ...varField(1, 555),
      ...lenField(4, body),
    ];
    const decoded = decodeSysMsg(buildPushMsg(44, groupAdmin));
    expect(decoded).toMatchObject({
      kind: 'group.admin-change',
      groupCode: '555',
      adminUid: 'u_DEMOTED',
      isAdmin: false,
    });
  });

  it('returns unknown for non-handled contentType', () => {
    const decoded = decodeSysMsg(buildPushMsg(732, [...varField(1, 1), ...varField(2, 16)]));
    expect(decoded).toMatchObject({ kind: 'unknown', contentType: 732 });
  });

  it('accepts signed-byte arrays (NT delivery shape) via toUint8Array', () => {
    // Same payload as the basic type-34 test, but with a few bytes flipped to
    // negative-signed (>127 unsigned) to mimic NT's JS array delivery.
    const groupChange = [
      ...varField(1, 200),
      ...lenField(3, Array.from(new TextEncoder().encode('u_Z'))),
      ...varField(4, 131),
    ];
    const pushBytes = buildPushMsg(34, groupChange);
    // Force any byte > 127 to signed representation:
    const signed = pushBytes.map((b) => (b > 127 ? b - 256 : b));
    const decoded = decodeSysMsg(signed);
    expect(decoded).toMatchObject({ sub: 'kick', groupCode: '200' });
  });
});
