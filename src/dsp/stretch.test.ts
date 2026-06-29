import { describe, it, expect } from 'vitest';
import { timeStretch, pitchShift, resampleTo, conformSignal } from './stretch';

const SR = 44100;

function sine(freq: number, seconds: number): Float32Array {
  const n = Math.floor(seconds * SR);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * freq * i) / SR);
  return x;
}

// Zero-crossing rate (crossings per second) over the middle half of the signal,
// avoiding phase-vocoder edge artifacts. For a sine of frequency f, zcr ≈ 2f, so
// it tracks *pitch* independent of duration.
function zcr(x: Float32Array): number {
  const a = Math.floor(x.length * 0.25);
  const b = Math.floor(x.length * 0.75);
  let crossings = 0;
  for (let i = a + 1; i < b; i++) {
    if ((x[i - 1] <= 0 && x[i] > 0) || (x[i - 1] >= 0 && x[i] < 0)) crossings++;
  }
  return (crossings * SR) / Math.max(1, b - a);
}

describe('resampleTo', () => {
  it('hits the exact target length', () => {
    const x = sine(440, 0.1);
    expect(resampleTo(x, 2000).length).toBe(2000);
    expect(resampleTo(x, 500).length).toBe(500);
  });

  it('interpolates a linear ramp correctly', () => {
    const ramp = Float32Array.from({ length: 5 }, (_, i) => i); // 0..4
    const up = resampleTo(ramp, 9); // endpoints fixed, midpoints interpolated
    expect(up[0]).toBeCloseTo(0, 5);
    expect(up[8]).toBeCloseTo(4, 5);
    expect(up[4]).toBeCloseTo(2, 5); // middle of a 0..4 ramp
  });
});

describe('timeStretch', () => {
  it('lengthens by roughly the ratio while preserving pitch', () => {
    const x = sine(220, 1);
    const slow = timeStretch(x, 1.5);
    expect(slow.length).toBeGreaterThan(x.length * 1.4);
    expect(slow.length).toBeLessThan(x.length * 1.6);
    // Pitch (zcr) should be unchanged by time-stretching.
    expect(zcr(slow)).toBeGreaterThan(zcr(x) * 0.9);
    expect(zcr(slow)).toBeLessThan(zcr(x) * 1.1);
  });

  it('returns a copy for ratio 1', () => {
    const x = sine(330, 0.2);
    const y = timeStretch(x, 1);
    expect(y.length).toBe(x.length);
    expect(y).not.toBe(x);
  });
});

describe('pitchShift', () => {
  it('preserves length', () => {
    const x = sine(220, 1);
    expect(pitchShift(x, 7).length).toBe(x.length);
  });

  it('raises pitch by an octave (zcr roughly doubles) for +12 semitones', () => {
    const x = sine(220, 1);
    const up = pitchShift(x, 12);
    const ratio = zcr(up) / zcr(x);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });
});

describe('conformSignal', () => {
  it('scales length by the time ratio', () => {
    const x = sine(220, 1);
    const out = conformSignal(x, 0.75, 0);
    expect(out.length).toBe(Math.round(x.length * 0.75));
  });

  it('applies tempo and pitch together: shorter and an octave up', () => {
    const x = sine(220, 1);
    const out = conformSignal(x, 0.8, 12);
    expect(out.length).toBe(Math.round(x.length * 0.8));
    const ratio = zcr(out) / zcr(x);
    expect(ratio).toBeGreaterThan(1.8);
    expect(ratio).toBeLessThan(2.2);
  });
});
