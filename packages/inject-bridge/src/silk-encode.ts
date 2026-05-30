/**
 * v0.4h-ε: encode arbitrary audio to SILK V3 for NT's PTT element.
 *
 * Pipeline:
 *   1. Already-SILK input               → pass through (size-heuristic duration)
 *   2. WAV input with silk-supported    → silk-wasm.encode(wavBytes, sampleRate)
 *      sample rate + mono channel
 *   3. Anything else (mp3, m4a, ogg, …) → spawn ffmpeg-static to transcode to
 *      24 kHz mono s16le PCM on stdout, then silk-wasm.encode(pcm, 24000)
 *
 * Output bytes start with the standard `#!SILK_V3` magic. We do NOT prepend
 * the Tencent `\x02` lead byte — NT 9.9 has accepted both flavors in testing,
 * and silk-wasm outputs the more portable form. If a recipient client fails
 * to play, that's the first thing to flip.
 */

import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { encode, isSilk, isWav, getWavFileInfo } from 'silk-wasm';
import ffmpegPath from 'ffmpeg-static';

const SILK_SUPPORTED_RATES = [8000, 12000, 16000, 24000, 32000, 44100, 48000];

export interface SilkResult {
  /** Encoded SILK V3 bytes. */
  silkBuf: Buffer;
  /** Duration in seconds, rounded to integer (NT only displays whole seconds). */
  durationSec: number;
  /** Sample rate used during encode (for diagnostics). */
  sampleRate: number;
  /** What route the pipeline took. */
  route: 'passthrough-silk' | 'wav-direct' | 'ffmpeg-pcm';
}

/**
 * Run ffmpeg-static to transcode arbitrary audio → 24 kHz mono s16le PCM,
 * piped to stdout. Returns the PCM bytes.
 */
function runFfmpegToPcm(inputPath: string): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    if (!ffmpegPath) {
      reject(new Error('ffmpeg-static binary not resolved (pnpm install may have failed)'));
      return;
    }
    const proc = spawn(
      ffmpegPath,
      ['-y', '-i', inputPath, '-f', 's16le', '-ar', '24000', '-ac', '1', '-loglevel', 'error', '-'],
      { windowsHide: true }
    );
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    proc.stdout.on('data', (c: Buffer) => outChunks.push(c));
    proc.stderr.on('data', (c: Buffer) => errChunks.push(c));
    proc.on('error', (err) => reject(new Error(`ffmpeg spawn failed: ${err.message}`)));
    proc.on('close', (code) => {
      if (code === 0) {
        const pcm = Buffer.concat(outChunks);
        if (pcm.length === 0) {
          reject(new Error('ffmpeg produced empty PCM output'));
        } else {
          resolve(pcm);
        }
      } else {
        const err = Buffer.concat(errChunks).toString('utf-8').trim();
        reject(new Error(`ffmpeg exit ${code}: ${err.slice(0, 240)}`));
      }
    });
  });
}

/**
 * Cheap duration estimate from silk byte count: silk averages ~3 kB/s @ 24
 * kHz mono. Min 1s. Used only when we have ONLY the encoded silk on hand —
 * for the routes where we still hold the PCM or WAV source, `pcmDurationSec`
 * produces a much more accurate value (fact #75: silk-wasm's reported
 * `duration` field underreports ~30% on short clips).
 */
export function estimateSilkDurationSec(silkSize: number): number {
  return Math.max(1, Math.floor(silkSize / 1024 / 3));
}

/**
 * Exact PCM-byte → seconds. mono s16le = 2 bytes/sample, so 24 kHz mono =
 * 48000 bytes/sec. Rounded up so a near-second clip still shows ≥1s.
 */
export function pcmDurationSec(
  pcmByteLen: number,
  sampleRate: number,
  channels = 1,
  bytesPerSample = 2
): number {
  const bytesPerSec = sampleRate * channels * bytesPerSample;
  if (bytesPerSec <= 0) return 1;
  return Math.max(1, Math.round(pcmByteLen / bytesPerSec));
}

/**
 * Approximate seconds from a raw WAV buffer when we know the format.
 * Real WAVs have variable-length headers (fmt + LIST + JUNK chunks before
 * the `data` chunk) but the 44-byte canonical header is correct for the
 * common case; an overestimate of one or two seconds is preferable to
 * silk-wasm's underestimate.
 */
export function wavDurationSec(
  wavByteLen: number,
  sampleRate: number,
  channels: number,
  bytesPerSample = 2,
  headerEstimate = 44
): number {
  const dataBytes = Math.max(0, wavByteLen - headerEstimate);
  return pcmDurationSec(dataBytes, sampleRate, channels, bytesPerSample);
}

/**
 * Encode an audio file to SILK bytes ready for NT's PTT element. Throws with
 * a clear message on failure — callers should let the error bubble up to the
 * wire response so the bot author can act.
 */
export async function encodeAudioToSilk(inputPath: string): Promise<SilkResult> {
  const inputBuf = await fs.readFile(inputPath);

  // Route 1 — already SILK. Don't re-encode; just measure.
  if (isSilk(inputBuf)) {
    return {
      silkBuf: inputBuf,
      durationSec: estimateSilkDurationSec(inputBuf.length),
      sampleRate: 24000,
      route: 'passthrough-silk',
    };
  }

  // Route 2 — WAV that silk-wasm can ingest natively (mono + supported rate).
  if (isWav(inputBuf)) {
    let fmt: { numberOfChannels: number; sampleRate: number } | null = null;
    try {
      const info = getWavFileInfo(inputBuf);
      fmt = (info as unknown as { fmt: { numberOfChannels: number; sampleRate: number } }).fmt;
    } catch { /* fallthrough to ffmpeg */ }
    if (fmt && fmt.numberOfChannels === 1 && SILK_SUPPORTED_RATES.includes(fmt.sampleRate)) {
      const result = await encode(inputBuf, fmt.sampleRate);
      return {
        silkBuf: Buffer.from(result.data),
        // Derive from WAV bytes, not silk-wasm's `result.duration` (fact #75).
        durationSec: wavDurationSec(inputBuf.length, fmt.sampleRate, fmt.numberOfChannels),
        sampleRate: fmt.sampleRate,
        route: 'wav-direct',
      };
    }
    // WAV but wrong channel/rate → fall through to ffmpeg.
  }

  // Route 3 — transcode with ffmpeg, then encode.
  const pcm = await runFfmpegToPcm(inputPath);
  const result = await encode(pcm, 24000);
  return {
    silkBuf: Buffer.from(result.data),
    // Derive from PCM bytes (24 kHz mono s16le = 48000 B/s). silk-wasm's
    // own `result.duration` field underreports ~30% on short clips per fact #75.
    durationSec: pcmDurationSec(pcm.length, 24000),
    sampleRate: 24000,
    route: 'ffmpeg-pcm',
  };
}
