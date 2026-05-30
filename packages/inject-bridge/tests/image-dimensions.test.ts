import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { probeImageDimensions } from '../src/image-upload';

/**
 * v0.4h-polish coverage: header-only dimension probes for the formats QQ
 * actually accepts. We synthesize minimal valid headers byte-for-byte so the
 * tests don't depend on real image fixtures (the probe only reads the first
 * 64 bytes — full bodies aren't required).
 */
describe('probeImageDimensions', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'qyc-dim-')); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  async function write(name: string, bytes: Buffer | Uint8Array): Promise<string> {
    const p = join(dir, name);
    await fs.writeFile(p, bytes);
    return p;
  }

  it('PNG: parses uint32-BE width/height at offsets 16/20', async () => {
    const buf = Buffer.alloc(64);
    buf[0] = 0x89; buf[1] = 0x50; buf[2] = 0x4e; buf[3] = 0x47;
    buf[4] = 0x0d; buf[5] = 0x0a; buf[6] = 0x1a; buf[7] = 0x0a;
    buf.writeUInt32BE(800, 16);
    buf.writeUInt32BE(600, 20);
    const p = await write('a.png', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 800, h: 600 });
  });

  it('GIF89a: parses uint16-LE width/height at offsets 6/8', async () => {
    const buf = Buffer.alloc(64);
    buf.write('GIF89a', 0, 'ascii');
    buf.writeUInt16LE(320, 6);
    buf.writeUInt16LE(240, 8);
    const p = await write('a.gif', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 320, h: 240 });
  });

  it('GIF87a is recognized too', async () => {
    const buf = Buffer.alloc(64);
    buf.write('GIF87a', 0, 'ascii');
    buf.writeUInt16LE(100, 6);
    buf.writeUInt16LE(50, 8);
    const p = await write('a.gif', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 100, h: 50 });
  });

  it('BMP: parses int32-LE width @18, abs(int32-LE) height @22', async () => {
    const buf = Buffer.alloc(64);
    buf[0] = 0x42; buf[1] = 0x4d; // 'BM'
    buf.writeInt32LE(1920, 18);
    buf.writeInt32LE(-1080, 22); // negative means top-down — abs'd
    const p = await write('a.bmp', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 1920, h: 1080 });
  });

  it('WebP VP8X (extended): 24-bit LE canvas dims at 24/27, +1', async () => {
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8X', 12, 'ascii');
    // canvas 640x480 → store 639 and 479
    buf[24] = 639 & 0xff; buf[25] = (639 >> 8) & 0xff; buf[26] = 0;
    buf[27] = 479 & 0xff; buf[28] = (479 >> 8) & 0xff; buf[29] = 0;
    const p = await write('a.webp', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 640, h: 480 });
  });

  it('WebP VP8L (lossless): packed 14-bit width-1 / 14-bit height-1', async () => {
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8L', 12, 'ascii');
    buf[20] = 0x2f;
    // pack 199 (w-1=199 → w=200) into low 14, 99 (h-1=99 → h=100) into next 14
    const packed = (99 << 14) | 199;
    buf.writeUInt32LE(packed, 21);
    const p = await write('a.webp', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 200, h: 100 });
  });

  it('WebP VP8 (lossy): start-code 9D 01 2A then 14-bit LE dims', async () => {
    const buf = Buffer.alloc(64);
    buf.write('RIFF', 0, 'ascii');
    buf.write('WEBP', 8, 'ascii');
    buf.write('VP8 ', 12, 'ascii');
    buf[23] = 0x9d; buf[24] = 0x01; buf[25] = 0x2a;
    buf.writeUInt16LE(1024, 26);
    buf.writeUInt16LE(768, 28);
    const p = await write('a.webp', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 1024, h: 768 });
  });

  it('JPEG: walks segments to SOFn and reads dims', async () => {
    // Minimal valid JPEG framing. Per spec the 2-byte length field INCLUDES
    // its own two bytes, so APP0 with length=4 has a 2-byte payload after it.
    // Probe advances offset by `2 (marker) + length`; SOF0 must therefore land
    // at the offset the prober expects.
    const chunks: number[] = [];
    chunks.push(0xff, 0xd8);                    // SOI                        [0-1]
    chunks.push(0xff, 0xe0, 0x00, 0x04);        // APP0 marker + length=4     [2-5]
    chunks.push(0x00, 0x00);                    // APP0 body (2 bytes)        [6-7]
    chunks.push(0xff, 0xc0, 0x00, 0x11);        // SOF0 marker + length=17    [8-11]
    chunks.push(0x08);                          // precision = 8              [12]
    chunks.push(0x01, 0x68);                    // height = 0x0168 = 360      [13-14]
    chunks.push(0x02, 0x80);                    // width  = 0x0280 = 640      [15-16]
    // pad rest of SOF0 body for well-formedness (15 body bytes total - 5 used)
    for (let i = 0; i < 17 - 2 - 5; i++) chunks.push(0);
    const buf = Buffer.from(chunks);
    const p = await write('a.jpg', buf);
    expect(await probeImageDimensions(p)).toEqual({ w: 640, h: 360 });
  });

  it('unrecognized format returns {0,0} instead of throwing', async () => {
    const p = await write('a.bin', Buffer.from([0x00, 0x01, 0x02, 0x03]));
    expect(await probeImageDimensions(p)).toEqual({ w: 0, h: 0 });
  });
});
