/**
 * Minimal protobuf wire-format reader.
 *
 * QQ NT's `onRecvSysMsg` listener delivers raw protobuf bytes (signed JS int
 * arrays) carrying system events — group member changes, admin promotions,
 * the bot being kicked, etc. Rather than pull in a codegen-driven protobuf
 * library with a 200KB+ runtime, we use just enough to walk a few hand-known
 * schemas (PushMsgBody, GroupChange, GroupAdmin) defined in `sysmsg-decode.ts`.
 *
 * Wire format reference:
 *   tag = (fieldNumber << 3) | wireType
 *   wireType: 0=VARINT, 1=FIXED64, 2=LENGTH-DELIMITED, 5=FIXED32
 *   varint = little-endian 7-bit groups, high bit set = more bytes follow
 */

export type FieldValue =
  | { kind: 'varint'; value: bigint }
  | { kind: 'fixed64'; value: bigint }
  | { kind: 'fixed32'; value: number }
  | { kind: 'bytes'; value: Uint8Array };

export type DecodedMessage = Map<number, FieldValue[]>;

/** Coerce NT's signed JS byte array (-128..127) to an unsigned Uint8Array. */
export function toUint8Array(input: number[] | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const out = new Uint8Array(input.length);
  for (let i = 0; i < input.length; i++) out[i] = input[i]! & 0xff;
  return out;
}

class Reader {
  constructor(public buf: Uint8Array, public offset = 0) {}
  done(): boolean { return this.offset >= this.buf.length; }
  readVarint(): bigint {
    let result = 0n;
    let shift = 0n;
    while (!this.done()) {
      const byte = this.buf[this.offset++]!;
      result |= BigInt(byte & 0x7f) << shift;
      if ((byte & 0x80) === 0) return result;
      shift += 7n;
      if (shift > 64n) throw new Error('varint too long');
    }
    throw new Error('truncated varint');
  }
  readFixed32(): number {
    if (this.offset + 4 > this.buf.length) throw new Error('truncated fixed32');
    const v = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 4).getUint32(0, true);
    this.offset += 4;
    return v;
  }
  readFixed64(): bigint {
    if (this.offset + 8 > this.buf.length) throw new Error('truncated fixed64');
    const dv = new DataView(this.buf.buffer, this.buf.byteOffset + this.offset, 8);
    const lo = BigInt(dv.getUint32(0, true));
    const hi = BigInt(dv.getUint32(4, true));
    this.offset += 8;
    return (hi << 32n) | lo;
  }
  readBytes(): Uint8Array {
    const len = Number(this.readVarint());
    if (len < 0 || this.offset + len > this.buf.length) throw new Error('truncated bytes');
    const out = this.buf.subarray(this.offset, this.offset + len);
    this.offset += len;
    return out;
  }
}

/** Parse a single protobuf message into a `Map<fieldNumber, values[]>`. */
export function readMessage(buf: Uint8Array): DecodedMessage {
  const reader = new Reader(buf);
  const out: DecodedMessage = new Map();
  while (!reader.done()) {
    const tag = Number(reader.readVarint());
    const fieldNumber = tag >>> 3;
    const wireType = tag & 0x7;
    let value: FieldValue;
    switch (wireType) {
      case 0: value = { kind: 'varint', value: reader.readVarint() }; break;
      case 1: value = { kind: 'fixed64', value: reader.readFixed64() }; break;
      case 2: value = { kind: 'bytes', value: reader.readBytes() }; break;
      case 5: value = { kind: 'fixed32', value: reader.readFixed32() }; break;
      default: throw new Error(`unsupported wireType ${wireType} at offset ${reader.offset}`);
    }
    let list = out.get(fieldNumber);
    if (!list) { list = []; out.set(fieldNumber, list); }
    list.push(value);
  }
  return out;
}

// ─── typed field accessors ──────────────────────────────────────────────────

export function getField(msg: DecodedMessage, num: number): FieldValue | undefined {
  return msg.get(num)?.[0];
}

export function getNumber(msg: DecodedMessage, num: number): number | undefined {
  const f = getField(msg, num);
  if (!f) return undefined;
  if (f.kind === 'varint') return Number(f.value);
  if (f.kind === 'fixed32') return f.value;
  if (f.kind === 'fixed64') return Number(f.value);
  return undefined;
}

export function getBigInt(msg: DecodedMessage, num: number): bigint | undefined {
  const f = getField(msg, num);
  if (!f) return undefined;
  if (f.kind === 'varint' || f.kind === 'fixed64') return f.value;
  if (f.kind === 'fixed32') return BigInt(f.value);
  return undefined;
}

export function getString(msg: DecodedMessage, num: number): string | undefined {
  const f = getField(msg, num);
  if (!f || f.kind !== 'bytes') return undefined;
  return new TextDecoder('utf-8', { fatal: false }).decode(f.value);
}

export function getBytes(msg: DecodedMessage, num: number): Uint8Array | undefined {
  const f = getField(msg, num);
  if (!f || f.kind !== 'bytes') return undefined;
  return f.value;
}

export function getSubmessage(msg: DecodedMessage, num: number): DecodedMessage | undefined {
  const b = getBytes(msg, num);
  if (!b) return undefined;
  try { return readMessage(b); } catch { return undefined; }
}

export function getBool(msg: DecodedMessage, num: number): boolean | undefined {
  const n = getNumber(msg, num);
  return n === undefined ? undefined : n !== 0;
}
