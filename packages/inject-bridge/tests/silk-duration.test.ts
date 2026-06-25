import { describe, expect, it } from 'vitest';
import { estimateSilkDurationSec, pcmDurationSec, wavDurationSec } from '../src/silk-encode';

// Fact #75: silk-wasm's reported duration field underreports ~30% on short
// clips. We now derive duration from the source PCM/WAV bytes instead. These
// tests lock the math so a regression in the formula surfaces before live smoke.

describe('pcmDurationSec', () => {
  it('24 kHz mono s16le @ 48000 B/s', () => {
    expect(pcmDurationSec(48_000, 24000)).toBe(1);
    expect(pcmDurationSec(48_000 * 10, 24000)).toBe(10);
    // 14-second mp3 → ffmpeg → ~14 * 48000 PCM bytes; should report 14, not 9.
    expect(pcmDurationSec(48_000 * 14, 24000)).toBe(14);
  });

  it('rounds to nearest second, minimum 1', () => {
    expect(pcmDurationSec(0, 24000)).toBe(1);
    expect(pcmDurationSec(24_000, 24000)).toBe(1); // 0.5s → 1
    expect(pcmDurationSec(72_000, 24000)).toBe(2); // 1.5s → 2 (rounded)
  });

  it('honors non-default channels / bit depth', () => {
    // 48 kHz stereo s16le = 192_000 B/s
    expect(pcmDurationSec(192_000, 48000, 2, 2)).toBe(1);
    expect(pcmDurationSec(192_000 * 5, 48000, 2, 2)).toBe(5);
  });

  it('guards against bad inputs', () => {
    expect(pcmDurationSec(1_000_000, 0)).toBe(1);
    expect(pcmDurationSec(1_000_000, -1)).toBe(1);
  });
});

describe('wavDurationSec', () => {
  it('strips 44-byte header before computing', () => {
    // Want 5s mono @ 24 kHz → 5 * 48000 = 240_000 data bytes; +44 = 240_044.
    expect(wavDurationSec(240_044, 24000, 1)).toBe(5);
  });

  it('does not underflow on tiny buffers', () => {
    expect(wavDurationSec(10, 24000, 1)).toBe(1);
  });
});

describe('estimateSilkDurationSec (passthrough fallback)', () => {
  it('uses ~3 kB/s rate', () => {
    // 3 kB = 1s
    expect(estimateSilkDurationSec(3 * 1024)).toBe(1);
    // 30 kB ≈ 10s
    expect(estimateSilkDurationSec(30 * 1024)).toBe(10);
  });

  it('minimum 1s for tiny silk', () => {
    expect(estimateSilkDurationSec(0)).toBe(1);
    expect(estimateSilkDurationSec(500)).toBe(1);
  });
});
