import { describe, it, expect } from 'vitest';
import { fft } from './fft';
import { stft, istft } from './stft';
import { nmf } from './nmf';
import { separate, splitComponent } from './separate';

function maxAbsDiff(a: Float32Array, b: Float32Array, from = 0, to = a.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(a[i] - b[i]));
  return m;
}

describe('fft', () => {
  it('inverse round-trips', () => {
    const n = 256;
    const re = new Float32Array(n);
    const im = new Float32Array(n);
    for (let i = 0; i < n; i++) re[i] = Math.sin(i * 0.3) + 0.5 * Math.cos(i * 0.11);
    const re0 = re.slice();
    fft(re, im, false);
    fft(re, im, true);
    expect(maxAbsDiff(re, re0)).toBeLessThan(1e-4);
  });
});

describe('stft / istft', () => {
  it('reconstructs the interior of a signal', () => {
    const len = 8192;
    const fftSize = 1024;
    const hop = 256;
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      x[i] = 0.6 * Math.sin(i * 0.05) + 0.3 * Math.sin(i * 0.21 + 1);
    }
    const y = istft(stft(x, fftSize, hop));
    // Edge frames lack full overlap; check the well-covered interior.
    expect(maxAbsDiff(x, y, fftSize, len - fftSize)).toBeLessThan(1e-3);
  });
});

describe('nmf', () => {
  it('recovers a low-rank non-negative matrix', () => {
    const F = 24;
    const T = 32;
    const K = 2;
    const W0 = new Float32Array(F * K);
    const H0 = new Float32Array(K * T);
    for (let i = 0; i < W0.length; i++) W0[i] = Math.random();
    for (let i = 0; i < H0.length; i++) H0[i] = Math.random();
    const V = new Float32Array(F * T);
    for (let f = 0; f < F; f++)
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let k = 0; k < K; k++) s += W0[f * K + k] * H0[k * T + t];
        V[f * T + t] = s;
      }

    const { W, H } = nmf(V, F, T, K, 400, 3);
    let num = 0;
    let den = 0;
    for (let f = 0; f < F; f++)
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let k = 0; k < K; k++) s += W[f * K + k] * H[k * T + t];
        const d = V[f * T + t] - s;
        num += d * d;
        den += V[f * T + t] * V[f * T + t];
      }
    expect(Math.sqrt(num / den)).toBeLessThan(0.05);
  });
});

describe('separate', () => {
  function toneClickMix(sr: number, len: number): Float32Array {
    const x = new Float32Array(len);
    for (let i = 0; i < len; i++) x[i] = 0.4 * Math.sin((2 * Math.PI * 220 * i) / sr); // tonal
    for (let c = 0; c < len; c += 2000) x[c] += 0.9; // periodic clicks
    return x;
  }

  it('splits a tone+click mix into components that sum back to the original', () => {
    const sr = 16000;
    const len = 16384;
    const x = toneClickMix(sr, len);

    const { components } = separate([x], sr, {
      fftSize: 1024,
      hop: 256,
      percussive: { mode: 'manual', count: 1 },
      harmonic: { mode: 'manual', count: 1 },
      iterations: 30,
    });

    expect(components).toHaveLength(2);
    for (const comp of components) expect(comp.channels).toHaveLength(1);

    // Component masks sum to exactly 1, so the components must reconstruct the
    // original (in the overlap-covered interior).
    const sum = new Float32Array(len);
    for (const comp of components) {
      const sig = comp.channels[0];
      for (let i = 0; i < sig.length; i++) sum[i] += sig[i];
    }
    expect(maxAbsDiff(x, sum, 1024, len - 1024)).toBeLessThan(1e-2);
  });

  it('outputs one channel per input and reconstructs each in stereo', () => {
    const sr = 16000;
    const len = 16384;
    const left = toneClickMix(sr, len);
    const right = new Float32Array(len);
    // Right channel is the left scaled down — masks are shared but the per-channel
    // reconstruction must preserve each channel's own level.
    for (let i = 0; i < len; i++) right[i] = 0.5 * left[i];

    const { components } = separate([left, right], sr, {
      fftSize: 1024,
      hop: 256,
      percussive: { mode: 'manual', count: 1 },
      harmonic: { mode: 'manual', count: 1 },
      iterations: 30,
    });

    for (const comp of components) expect(comp.channels).toHaveLength(2);

    const sumL = new Float32Array(len);
    const sumR = new Float32Array(len);
    for (const comp of components) {
      for (let i = 0; i < len; i++) {
        sumL[i] += comp.channels[0][i];
        sumR[i] += comp.channels[1][i];
      }
    }
    expect(maxAbsDiff(left, sumL, 1024, len - 1024)).toBeLessThan(1e-2);
    expect(maxAbsDiff(right, sumR, 1024, len - 1024)).toBeLessThan(1e-2);
  });

  it('trims to a seamless loop with no boundary discontinuity', () => {
    const sr = 16000;
    const len = 16384;
    const x = toneClickMix(sr, len);
    const loopLength = 12000;
    const crossfade = 192;

    const { components } = separate([x], sr, {
      fftSize: 1024,
      hop: 256,
      percussive: { mode: 'manual', count: 1 },
      harmonic: { mode: 'manual', count: 1 },
      iterations: 30,
      loop: { lengthSamples: loopLength, crossfadeSamples: crossfade },
    });

    for (const comp of components) {
      expect(comp.channels[0]).toHaveLength(loopLength);
    }

    // Seamlessness: wrapping from the last sample back to the first should match
    // how the *original* continues past the loop point (the crossfade folds the
    // real continuation onto the head), so the looped jump ≈ the original jump.
    const sum = new Float32Array(loopLength);
    for (const comp of components) {
      const sig = comp.channels[0];
      for (let i = 0; i < loopLength; i++) sum[i] += sig[i];
    }
    const loopJump = sum[0] - sum[loopLength - 1];
    const origJump = x[loopLength] - x[loopLength - 1];
    expect(Math.abs(loopJump - origJump)).toBeLessThan(3e-2);
  });

  it('auto mode picks a sensible part count and still conserves energy', () => {
    const sr = 16000;
    const len = 16384;
    const x = toneClickMix(sr, len);

    const { components } = separate([x], sr, {
      fftSize: 1024,
      hop: 256,
      percussive: { mode: 'auto' },
      harmonic: { mode: 'auto' },
      iterations: 40,
    });

    // A tone + a click train: at least one part per kind, never a runaway count.
    expect(components.length).toBeGreaterThanOrEqual(2);
    expect(components.length).toBeLessThanOrEqual(8);
    expect(components.some((c) => c.kind === 'percussive')).toBe(true);
    expect(components.some((c) => c.kind === 'harmonic')).toBe(true);

    // Whatever the count, the parts still sum back to the original.
    const sum = new Float32Array(len);
    for (const comp of components) {
      const sig = comp.channels[0];
      for (let i = 0; i < sig.length; i++) sum[i] += sig[i];
    }
    expect(maxAbsDiff(x, sum, 1024, len - 1024)).toBeLessThan(1e-2);
  });
});

describe('splitComponent', () => {
  it('breaks a part into sub-parts that sum back to it (stereo)', () => {
    const sr = 16000;
    const len = 12000;
    const left = new Float32Array(len);
    const right = new Float32Array(len);
    for (let i = 0; i < len; i++) {
      const v = 0.3 * Math.sin((2 * Math.PI * 180 * i) / sr) + 0.2 * Math.sin((2 * Math.PI * 320 * i) / sr);
      left[i] = v;
      right[i] = 0.7 * v;
    }

    const { components } = splitComponent([left, right], sr, 'harmonic', 2, {
      fftSize: 1024,
      hop: 256,
      iterations: 40,
    });

    expect(components).toHaveLength(2);
    const partLen = components[0].channels[0].length;
    expect(partLen).toBeGreaterThan(0);
    expect(partLen).toBeLessThanOrEqual(len);
    for (const comp of components) {
      expect(comp.kind).toBe('harmonic');
      expect(comp.channels).toHaveLength(2);
      // All parts share one length so they stay phase-locked on playback.
      expect(comp.channels[0]).toHaveLength(partLen);
      expect(comp.channels[1]).toHaveLength(partLen);
    }

    const sumL = new Float32Array(len);
    const sumR = new Float32Array(len);
    for (const comp of components) {
      for (let i = 0; i < len; i++) {
        sumL[i] += comp.channels[0][i];
        sumR[i] += comp.channels[1][i];
      }
    }
    expect(maxAbsDiff(left, sumL, 1024, len - 1024)).toBeLessThan(1e-2);
    expect(maxAbsDiff(right, sumR, 1024, len - 1024)).toBeLessThan(1e-2);
  });
});
