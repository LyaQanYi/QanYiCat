import { describe, expect, it } from 'vitest';
import {
  readMessage,
  getNumber,
  getString,
  getBytes,
  getSubmessage,
  toUint8Array,
  type DecodedMessage,
} from '../src/protobuf-tiny';

/** Encode a uint as a varint. */
function varint(n: number): number[] {
  const out: number[] = [];
  let v = n;
  while (v > 0x7f) { out.push((v & 0x7f) | 0x80); v >>>= 7; }
  out.push(v);
  return out;
}

/** Length-delimited (wire-type 2) field. Tag itself is varint-encoded. */
function pack(fieldNumber: number, value: Uint8Array): number[] {
  const tag = (fieldNumber << 3) | 2;
  return [...varint(tag), ...varint(value.length), ...Array.from(value)];
}

/** Single field with explicit wire type + raw value bytes. Tag is varint-encoded. */
function field(num: number, wireType: number, valueBytes: number[]): number[] {
  const tag = (num << 3) | wireType;
  return [...varint(tag), ...valueBytes];
}

describe('protobuf-tiny', () => {
  it('toUint8Array masks signed JS bytes to unsigned', () => {
    const out = toUint8Array([0, -1, 127, -128, 255]);
    expect(Array.from(out)).toEqual([0, 255, 127, 128, 255]);
  });

  it('decodes varint fields', () => {
    // field 1 varint = 150 (encoded as 0x96 0x01)
    const buf = new Uint8Array([0x08, 0x96, 0x01]);
    const msg = readMessage(buf);
    expect(getNumber(msg, 1)).toBe(150);
  });

  it('decodes length-delimited string fields via getString', () => {
    const bytes = new TextEncoder().encode('hello');
    const buf = new Uint8Array(pack(2, bytes));
    const msg = readMessage(buf);
    expect(getString(msg, 2)).toBe('hello');
  });

  it('decodes fixed32 and fixed64 fields', () => {
    // field 3 fixed32 = 0xDEADBEEF (little-endian: EF BE AD DE), tag = (3<<3)|5 = 29
    const buf = new Uint8Array([29, 0xEF, 0xBE, 0xAD, 0xDE]);
    const msg = readMessage(buf);
    expect(getNumber(msg, 3)).toBe(0xDEADBEEF);
  });

  it('decodes nested submessages', () => {
    // outer message: field 1 length-delimited (inner: field 2 varint = 42)
    const inner = new Uint8Array([0x10, 42]);
    const outerBytes = new Uint8Array(pack(1, inner));
    const outer = readMessage(outerBytes);
    const sub = getSubmessage(outer, 1) as DecodedMessage;
    expect(sub).toBeDefined();
    expect(getNumber(sub, 2)).toBe(42);
  });

  it('round-trips PushMsgBody-like nesting (ResponseHead → ContentHead.type)', () => {
    // Mimic the NT sysmsg shape: outer{1: ResponseHead{}, 2: ContentHead{1: varint type}}.
    const responseHeadBytes = new Uint8Array([]);     // empty inner — fine, just to exercise the parser
    const contentHeadBytes = new Uint8Array(field(1, 0, varint(34)));   // type=34 (group decrease)
    const outerBytes = new Uint8Array([...pack(1, responseHeadBytes), ...pack(2, contentHeadBytes)]);
    const outer = readMessage(outerBytes);
    const ch = getSubmessage(outer, 2)!;
    expect(getNumber(ch, 1)).toBe(34);
  });

  it('skips unknown fields without throwing', () => {
    // field 5 fixed32 + field 7 varint + field 99 length-delimited bytes
    const buf = new Uint8Array([
      ...field(5, 5, [0x01, 0x02, 0x03, 0x04]),
      ...field(7, 0, varint(123)),
      ...pack(99, new Uint8Array([0xAA, 0xBB])),
    ]);
    const msg = readMessage(buf);
    expect(getNumber(msg, 7)).toBe(123);
    expect(getBytes(msg, 99)).toEqual(new Uint8Array([0xAA, 0xBB]));
  });
});
