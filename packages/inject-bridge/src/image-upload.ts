/**
 * v0.4h-α: stage a local image file for NT's `sendMsg` PIC element.
 *
 * The send flow (reverse-engineered from NT's behavior):
 *   1. md5/sha + file-size + dimensions of the source file
 *   2. `msgService.getRichMediaFilePathForGuild({md5, fileName, elementType, …})`
 *      returns an NT-managed cache path (where NT expects the file to live).
 *   3. Copy the source bytes to that path.
 *   4. Fill the PIC element's `md5HexStr / fileSize / sourcePath / picWidth /
 *      picHeight / fileName` before calling `msgService.sendMsg`.
 *   5. NT handles the actual server upload inside `sendMsg`.
 *
 * Scope of this module: local file path only. URL/base64 image inputs are
 * deferred — wire form `[{type:'image', data:{file:'<local-path>'}}]` only.
 */

import { createHash, randomBytes } from 'node:crypto';
import { promises as fs, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import { encodeAudioToSilk } from './silk-encode';

interface MediaPathArgs {
  md5HexStr: string;
  fileName: string;
  elementType: number;
  elementSubType: number;
  thumbSize: number;
  needCreate: boolean;
  downloadType: number;
  file_uuid: string;
}

export interface ImageUploadDeps {
  getRichMediaFilePathForGuild(args: MediaPathArgs): string;
}

export interface StagedImage {
  md5HexStr: string;
  fileSize: string;
  fileName: string;
  sourcePath: string;
  picWidth: number;
  picHeight: number;
}

/** Strip a `file://` prefix and decode the URL, so callers can pass either form. */
function normalizePath(input: string): string {
  if (input.startsWith('file:///')) {
    try { return decodeURIComponent(new URL(input).pathname.replace(/^\//, '')); }
    catch { /* fallthrough */ }
  }
  return input;
}

/**
 * Accept wire-form image inputs and turn them into a readable local file:
 *   • already-existing absolute / relative path     → returned as-is
 *   • `file:///...` URI                              → unencoded
 *   • `http://` / `https://`                         → fetched to a temp file
 *   • `base64://` or `data:image/...;base64,...`     → decoded to a temp file
 *   • bare long base64 string                        → decoded to a temp file
 *
 * Temp files are deliberately left in `os.tmpdir()`; they're small, NT keeps
 * its own cached copy under `Tencent Files/.../Pic`, and OS cleanup will get
 * to them eventually.
 */
export async function resolveToLocalPath(input: string): Promise<string> {
  const direct = normalizePath(input);
  if (existsSync(direct)) return direct;

  if (/^https?:\/\//i.test(input)) {
    const res = await fetch(input);
    if (!res.ok) throw new Error(`http ${res.status} fetching image`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length === 0) throw new Error('image URL returned empty body');
    return writeTemp(buf);
  }

  // Recognize base64 inputs: `base64://...`, `data:image/...;base64,...`, or
  // a bare-string of plausible base64 (length > 100, base64 alphabet only).
  let b64: string | null = null;
  if (input.startsWith('base64://')) b64 = input.slice('base64://'.length);
  else if (input.startsWith('data:')) {
    const comma = input.indexOf(',');
    if (comma > 0) b64 = input.slice(comma + 1);
  } else if (input.length > 100 && /^[A-Za-z0-9+/=\s]+$/.test(input)) {
    b64 = input;
  }
  if (b64 !== null) {
    const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
    if (buf.length === 0) throw new Error('image base64 decoded to empty buffer');
    return writeTemp(buf);
  }

  throw new Error(`unrecognized image input (not a path / URL / base64): ${input.slice(0, 80)}…`);
}

async function writeTemp(buf: Buffer): Promise<string> {
  const tmp = join(tmpdir(), `qanyicat-img-${randomBytes(8).toString('hex')}`);
  await fs.writeFile(tmp, buf);
  return tmp;
}

/**
 * Best-effort dimension probe for PNG, JPEG, GIF, BMP, and WebP (VP8/VP8L/VP8X
 * sub-formats). Returns `{w:0, h:0}` on unrecognized formats — NT accepts that,
 * but downstream renderers may show "loading" longer.
 *
 * Exported only for unit tests; production code should go through
 * `stageImageForSend` which calls this internally.
 */
export async function probeImageDimensions(filePath: string): Promise<{ w: number; h: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const buf = Buffer.alloc(64);
    await handle.read(buf, 0, 64, 0);

    // PNG: 89 50 4E 47 0D 0A 1A 0A, then 4-byte length, "IHDR", w/h uint32-BE
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG: FF D8 ... walk segments until SOFn (FF C0..CF, except DHT/JPG/DAC)
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      return await probeJpegDimensions(filePath);
    }
    // GIF87a / GIF89a: width @6 height @8 as uint16-LE
    if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38
        && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61) {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // BMP: 42 4D ... BITMAPINFOHEADER places width @18 (int32-LE), height @22
    if (buf[0] === 0x42 && buf[1] === 0x4D) {
      const w = buf.readInt32LE(18);
      const h = Math.abs(buf.readInt32LE(22));  // negative = top-down
      return { w, h };
    }
    // WebP (RIFF...WEBP) — three sub-formats, all dimensions fit in 64-byte head.
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
        && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) {
      // VP8X (extended): 'VP8X' @12, canvas w/h are 24-bit LE @24 and @27 (each minus 1)
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x58) {
        const w = (buf[24]! | (buf[25]! << 8) | (buf[26]! << 16)) + 1;
        const h = (buf[27]! | (buf[28]! << 8) | (buf[29]! << 16)) + 1;
        return { w, h };
      }
      // VP8L (lossless): 'VP8L' @12, signature 0x2F @20, then 14-bit w-1 + 14-bit h-1
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x4C
          && buf[20] === 0x2F) {
        const packed =
          buf[21]! | (buf[22]! << 8) | (buf[23]! << 16) | (buf[24]! << 24);
        const w = ((packed & 0x3fff) + 1) >>> 0;
        const h = (((packed >> 14) & 0x3fff) + 1) >>> 0;
        return { w, h };
      }
      // VP8 (lossy): 'VP8 ' @12, start code 9D 01 2A @23..25, w/h as 16-bit LE
      // at @26 and @28 (lower 14 bits each is the dimension).
      if (buf[12] === 0x56 && buf[13] === 0x50 && buf[14] === 0x38 && buf[15] === 0x20
          && buf[23] === 0x9D && buf[24] === 0x01 && buf[25] === 0x2A) {
        const w = buf.readUInt16LE(26) & 0x3fff;
        const h = buf.readUInt16LE(28) & 0x3fff;
        return { w, h };
      }
    }
    // TIFF (II/MM): full IFD walk is heavier — defer until needed.

    return { w: 0, h: 0 };
  } finally {
    await handle.close();
  }
}

async function probeJpegDimensions(filePath: string): Promise<{ w: number; h: number }> {
  const handle = await fs.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    let offset = 2; // skip SOI
    const seg = Buffer.alloc(4);
    while (offset < stat.size) {
      await handle.read(seg, 0, 4, offset);
      if (seg[0] !== 0xff) return { w: 0, h: 0 };
      const marker = seg[1];
      const length = seg.readUInt16BE(2);
      // SOFn markers: C0..CF except DA (SOS)
      if (marker !== undefined && marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const dim = Buffer.alloc(5);
        await handle.read(dim, 0, 5, offset + 4);
        return { h: dim.readUInt16BE(1), w: dim.readUInt16BE(3) };
      }
      offset += 2 + length;
    }
    return { w: 0, h: 0 };
  } finally {
    await handle.close();
  }
}

/**
 * Detect picType for the PIC element (1 = png, 1000 = jpg, 2000 = gif —
 * observed NT numbering, may be incomplete). Falls back to 1000 (jpg) which is
 * the most permissive in our testing.
 */
function detectPicType(filePath: string): number {
  const lower = filePath.toLowerCase();
  if (lower.endsWith('.png')) return 1001;
  if (lower.endsWith('.gif')) return 2000;
  if (lower.endsWith('.webp')) return 1002;
  return 1000;
}

export async function stageImageForSend(
  rawPath: string,
  msgService: ImageUploadDeps
): Promise<StagedImage & { picType: number }> {
  let step = 'resolveToLocalPath';
  let filePath = '';
  try {
    filePath = await resolveToLocalPath(rawPath);
    step = 'existsSync';
    if (!existsSync(filePath)) throw new Error(`image not found: ${filePath}`);
    step = 'statSync';
    const fileSize = statSync(filePath).size;
    if (fileSize === 0) throw new Error(`image file is empty: ${filePath}`);

    step = 'readFile';
    const fileBuf = await fs.readFile(filePath);
    const md5HexStr = createHash('md5').update(fileBuf).digest('hex');
    const fileName = basename(filePath);
    step = 'probeImageDimensions';
    const { w, h } = await probeImageDimensions(filePath);

    step = 'getRichMediaFilePathForGuild';
    const mediaPath = msgService.getRichMediaFilePathForGuild({
      md5HexStr,
      fileName,
      elementType: 2,
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    if (!mediaPath || typeof mediaPath !== 'string') {
      throw new Error(`getRichMediaFilePathForGuild returned: ${typeof mediaPath}=${JSON.stringify(mediaPath)}`);
    }
    step = `copyFile→${mediaPath}`;
    await fs.copyFile(filePath, mediaPath);

    return {
      md5HexStr,
      fileSize: String(fileSize),
      fileName,
      sourcePath: mediaPath,
      picWidth: w,
      picHeight: h,
      picType: detectPicType(filePath),
    };
  } catch (e) {
    throw new Error(`[stageImage:${step}] ${(e as Error).message}`);
  }
}

/** Heuristic: a 32-char lowercase hex is already a content-addressed md5. */
export function looksLikeMd5(s: string): boolean {
  return /^[a-f0-9]{32}$/i.test(s);
}

// ─── v0.4h-γ: file-segment staging ──────────────────────────────────────────

export interface StagedFile {
  fileMd5: string;
  fileSize: string;
  fileName: string;
  filePath: string;
}

/**
 * Stage a local-or-resolvable file for NT's `sendMsg` FILE element.
 * Same dance as `stageImageForSend` but with `elementType: 3` and a different
 * element shape (no md5HexStr, no dimensions). The wire form's `name` field
 * (if provided) overrides the on-disk filename.
 */
export async function stageFileForSend(
  rawPath: string,
  displayName: string | undefined,
  msgService: ImageUploadDeps
): Promise<StagedFile> {
  let step = 'resolveToLocalPath';
  let filePath = '';
  try {
    filePath = await resolveToLocalPath(rawPath);
    step = 'existsSync';
    if (!existsSync(filePath)) throw new Error(`file not found: ${filePath}`);
    step = 'statSync';
    const fileSize = statSync(filePath).size;
    if (fileSize === 0) throw new Error(`file is empty: ${filePath}`);

    step = 'readFile';
    const buf = await fs.readFile(filePath);
    const fileMd5 = createHash('md5').update(buf).digest('hex');
    const fileName = displayName || basename(filePath);

    step = 'getRichMediaFilePathForGuild';
    const mediaPath = msgService.getRichMediaFilePathForGuild({
      md5HexStr: fileMd5,
      fileName,
      elementType: 3,     // NTElementType.FILE
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    if (!mediaPath || typeof mediaPath !== 'string') {
      throw new Error(`getRichMediaFilePathForGuild returned: ${typeof mediaPath}=${JSON.stringify(mediaPath)}`);
    }
    step = `copyFile→${mediaPath}`;
    await fs.copyFile(filePath, mediaPath);

    return { fileMd5, fileSize: String(fileSize), fileName, filePath: mediaPath };
  } catch (e) {
    throw new Error(`[stageFile:${step}] ${(e as Error).message}`);
  }
}

// ─── v0.4h-δ: voice (PTT) staging ───────────────────────────────────────────

export interface StagedPtt {
  md5HexStr: string;
  fileSize: string;
  fileName: string;
  filePath: string;
  duration: number;
  /** Pipeline route taken: 'passthrough-silk', 'wav-direct', or 'ffmpeg-pcm'. */
  route: string;
}

/**
 * Stage a voice file for `sendMsg`'s PTT element.
 *
 * v0.4h-ε: pre-encode to SILK via silk-wasm (+ ffmpeg-static for non-WAV
 * input). NT 9.9's pttElement is rendered silently if the source bytes aren't
 * valid silk, so we always run the encode pipeline; already-SILK input shortcuts
 * through `passthrough-silk`.
 *
 * Wire form: `{type: 'voice', data: {file: '<path|url|base64>', duration?: number}}`.
 * If `duration` is supplied by the caller, it overrides silk-wasm's measure.
 */
export async function stagePttForSend(
  rawPath: string,
  overrideDuration: number | undefined,
  msgService: ImageUploadDeps
): Promise<StagedPtt> {
  let step = 'resolveToLocalPath';
  let sourcePath = '';
  let tempSilkPath = '';
  try {
    sourcePath = await resolveToLocalPath(rawPath);
    step = 'existsSync';
    if (!existsSync(sourcePath)) throw new Error(`audio not found: ${sourcePath}`);
    step = 'statSync';
    if (statSync(sourcePath).size === 0) throw new Error(`audio file is empty: ${sourcePath}`);

    step = 'encodeAudioToSilk';
    const silk = await encodeAudioToSilk(sourcePath);
    // Write the silk bytes to a temp file so NT's content-addressed cache can
    // copy from a real path. For passthrough we could reuse `sourcePath`, but
    // mixing routes complicates cleanup — always go through a temp file.
    tempSilkPath = join(tmpdir(), `qanyicat-silk-${randomBytes(8).toString('hex')}.silk`);
    await fs.writeFile(tempSilkPath, silk.silkBuf);

    const md5HexStr = createHash('md5').update(silk.silkBuf).digest('hex');
    const fileName = basename(sourcePath).replace(/\.[^.]+$/, '') + '.silk';
    const duration = overrideDuration && overrideDuration > 0
      ? Math.floor(overrideDuration)
      : silk.durationSec;

    step = 'getRichMediaFilePathForGuild';
    const mediaPath = msgService.getRichMediaFilePathForGuild({
      md5HexStr,
      fileName,
      elementType: 4,     // NTElementType.PTT
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    if (!mediaPath || typeof mediaPath !== 'string') {
      throw new Error(`getRichMediaFilePathForGuild returned: ${typeof mediaPath}=${JSON.stringify(mediaPath)}`);
    }
    step = `copyFile→${mediaPath}`;
    await fs.copyFile(tempSilkPath, mediaPath);

    return {
      md5HexStr,
      fileSize: String(silk.silkBuf.length),
      fileName,
      filePath: mediaPath,
      duration,
      route: silk.route,
    };
  } catch (e) {
    throw new Error(`[stagePtt:${step}] ${(e as Error).message}`);
  } finally {
    // Best-effort cleanup of the temp silk; NT has its own cached copy now.
    if (tempSilkPath) fs.unlink(tempSilkPath).catch(() => undefined);
  }
}

// ─── v0.4h-δ: video staging ─────────────────────────────────────────────────

export interface StagedVideo {
  videoMd5: string;
  fileSize: string;
  fileName: string;
  filePath: string;
  /** Map of [angle, thumbPath]. NT expects `Map([[0, thumbPath]])`. */
  thumbPath: Map<number, string>;
  thumbMd5: string;
  thumbSize: number;
  thumbWidth: number;
  thumbHeight: number;
  /** Video duration in seconds (best-effort from mvhd box; 0 on probe failure). */
  fileTime: number;
}

/** 1×1 fully-transparent PNG, used when ffmpeg thumbnail extraction fails. */
const FALLBACK_THUMB_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64'
);

/**
 * v0.4h-ζ: extract a single video frame to PNG bytes via ffmpeg-static.
 *
 * Seeks to ~1/3 into the video (or 0.5s for very short clips) to avoid black
 * first frames. Returns the fallback 1×1 PNG on any failure — NT accepts both
 * and the recipient client can regenerate a real preview on playback.
 */
function extractVideoThumbnail(inputPath: string, durationSec: number): Promise<Buffer> {
  return new Promise((resolve) => {
    if (!ffmpegPath) { resolve(FALLBACK_THUMB_PNG); return; }
    const seekSec = Math.max(0.5, Math.min(10, Math.floor(durationSec / 3)));
    const seek = seekSec.toFixed(2);
    const proc = spawn(
      ffmpegPath,
      [
        '-ss', seek,            // seek BEFORE -i for fast keyframe-aligned jump
        '-i', inputPath,
        '-vframes', '1',
        '-vcodec', 'png',
        '-f', 'image2pipe',
        '-loglevel', 'error',
        '-',
      ],
      { windowsHide: true }
    );
    const out: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => out.push(c));
    // Silently swallow stderr — fallback handles failure.
    proc.stderr.on('data', () => undefined);
    proc.on('error', () => resolve(FALLBACK_THUMB_PNG));
    proc.on('close', (code) => {
      const buf = Buffer.concat(out);
      // PNG magic: 89 50 4E 47 0D 0A 1A 0A.
      if (code === 0 && buf.length > 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) {
        resolve(buf);
      } else {
        resolve(FALLBACK_THUMB_PNG);
      }
    });
  });
}

interface Mp4Info {
  duration: number;
  width: number;
  height: number;
}

/**
 * Walk MP4 box hierarchy to find `mvhd` (duration) and the first video-track
 * `tkhd` (display dimensions). Best-effort: a `0x0` / `0s` return is harmless,
 * NT and the recipient client both render the video regardless.
 */
async function probeMp4Info(filePath: string): Promise<Mp4Info> {
  const fail: Mp4Info = { duration: 0, width: 0, height: 0 };
  try {
    const handle = await fs.open(filePath, 'r');
    try {
      const stat = await handle.stat();
      const out: Mp4Info = { duration: 0, width: 0, height: 0 };
      const head = Buffer.alloc(8);

      // Top-level walker — find `moov`.
      let off = 0;
      while (off + 8 <= stat.size) {
        await handle.read(head, 0, 8, off);
        const size = head.readUInt32BE(0);
        const type = head.subarray(4, 8).toString('ascii');
        if (size < 8) break;
        if (type === 'moov') {
          const moovEnd = off + size;
          let inner = off + 8;
          while (inner + 8 <= moovEnd) {
            await handle.read(head, 0, 8, inner);
            const isize = head.readUInt32BE(0);
            const itype = head.subarray(4, 8).toString('ascii');
            if (isize < 8) break;
            if (itype === 'mvhd') {
              // mvhd: version(1) flags(3) [creation 4 mod 4 timescale 4 duration 4]  (v0)
              //       version(1) flags(3) [creation 8 mod 8 timescale 4 duration 8]  (v1)
              const mvhdBuf = Buffer.alloc(Math.min(isize - 8, 32));
              await handle.read(mvhdBuf, 0, mvhdBuf.length, inner + 8);
              const version = mvhdBuf[0];
              if (version === 0 && mvhdBuf.length >= 20) {
                const timescale = mvhdBuf.readUInt32BE(12);
                const durUnits = mvhdBuf.readUInt32BE(16);
                if (timescale > 0) out.duration = Math.round(durUnits / timescale);
              } else if (version === 1 && mvhdBuf.length >= 32) {
                const timescale = mvhdBuf.readUInt32BE(20);
                const high = mvhdBuf.readUInt32BE(24);
                const low = mvhdBuf.readUInt32BE(28);
                const durUnits = high * 0x100000000 + low;
                if (timescale > 0) out.duration = Math.round(durUnits / timescale);
              }
            } else if (itype === 'trak' && (out.width === 0 || out.height === 0)) {
              // Find the first trak's tkhd; width / height live in the last 8
              // bytes of tkhd as 16.16 fixed-point (we read the integer part).
              const trakEnd = inner + isize;
              let tinner = inner + 8;
              while (tinner + 8 <= trakEnd) {
                await handle.read(head, 0, 8, tinner);
                const tsize = head.readUInt32BE(0);
                const ttype = head.subarray(4, 8).toString('ascii');
                if (tsize < 8) break;
                if (ttype === 'tkhd') {
                  const tkhdBuf = Buffer.alloc(Math.min(tsize - 8, 92));
                  await handle.read(tkhdBuf, 0, tkhdBuf.length, tinner + 8);
                  const tver = tkhdBuf[0];
                  // tkhd width/height are the last 8 bytes of the box body.
                  if (tkhdBuf.length >= (tver === 1 ? 92 : 80)) {
                    const wIdx = tkhdBuf.length - 8;
                    const hIdx = tkhdBuf.length - 4;
                    const w = tkhdBuf.readUInt32BE(wIdx) >>> 16;
                    const h = tkhdBuf.readUInt32BE(hIdx) >>> 16;
                    if (w > 0 && h > 0 && out.width === 0) { out.width = w; out.height = h; }
                  }
                }
                tinner += tsize;
              }
            }
            inner += isize;
          }
        }
        off += size;
      }
      return out.duration === 0 && out.width === 0 ? fail : out;
    } finally {
      await handle.close();
    }
  } catch {
    return fail;
  }
}

/**
 * Stage a video file for `sendMsg`'s VIDEO element. NT requires a thumbnail
 * alongside the video — we don't have ffmpeg, so use a 1×1 fallback PNG. NT
 * accepts the upload regardless; the recipient sees a placeholder thumb until
 * the video preview generates client-side.
 */
export async function stageVideoForSend(
  rawPath: string,
  msgService: ImageUploadDeps
): Promise<StagedVideo> {
  let step = 'resolveToLocalPath';
  let filePath = '';
  try {
    filePath = await resolveToLocalPath(rawPath);
    step = 'existsSync';
    if (!existsSync(filePath)) throw new Error(`video not found: ${filePath}`);
    step = 'statSync';
    const fileSize = statSync(filePath).size;
    if (fileSize === 0) throw new Error(`video file is empty: ${filePath}`);

    step = 'readFile';
    const buf = await fs.readFile(filePath);
    const videoMd5 = createHash('md5').update(buf).digest('hex');
    const fileName = basename(filePath);

    step = 'probeMp4Info';
    const probed = await probeMp4Info(filePath);

    step = 'getRichMediaFilePathForGuild';
    const mediaPath = msgService.getRichMediaFilePathForGuild({
      md5HexStr: videoMd5,
      fileName,
      elementType: 5,     // NTElementType.VIDEO
      elementSubType: 0,
      thumbSize: 0,
      needCreate: true,
      downloadType: 1,
      file_uuid: '',
    });
    if (!mediaPath || typeof mediaPath !== 'string') {
      throw new Error(`getRichMediaFilePathForGuild returned: ${typeof mediaPath}=${JSON.stringify(mediaPath)}`);
    }
    step = `copyFile→${mediaPath}`;
    await fs.copyFile(filePath, mediaPath);

    // Thumb-path trick: take the video path, swap `…/Ori/…` for
    // `…/Thumb/…`, write a `<md5>_0.png` next to it. NT picks the file up by
    // path convention without needing a separate API call.
    step = 'stageThumb';
    const sep = mediaPath.includes('\\') ? '\\' : '/';
    const thumbDirRaw = mediaPath.replace(`${sep}Ori${sep}`, `${sep}Thumb${sep}`);
    const thumbDir = thumbDirRaw.substring(0, thumbDirRaw.lastIndexOf(sep));
    await fs.mkdir(thumbDir, { recursive: true }).catch(() => undefined);
    const thumbPath = `${thumbDir}${sep}${videoMd5}_0.png`;
    // v0.4h-ζ: real frame via ffmpeg-static; falls back to 1×1 PNG on failure.
    const thumbBuf = await extractVideoThumbnail(filePath, probed.duration);
    await fs.writeFile(thumbPath, thumbBuf);
    const thumbMd5 = createHash('md5').update(thumbBuf).digest('hex');
    const thumbSize = thumbBuf.length;

    return {
      videoMd5,
      fileSize: String(fileSize),
      fileName,
      filePath: mediaPath,
      thumbPath: new Map([[0, thumbPath]]),
      thumbMd5,
      thumbSize,
      thumbWidth: probed.width || 1,
      thumbHeight: probed.height || 1,
      fileTime: probed.duration || 0,
    };
  } catch (e) {
    throw new Error(`[stageVideo:${step}] ${(e as Error).message}`);
  }
}
