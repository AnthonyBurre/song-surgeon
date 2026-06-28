import { describe, it, expect } from 'vitest';
import { analyzePitch } from './pitch';

function sine(sr: number, seconds: number, freq: number, amp = 0.5): Float32Array {
  const len = Math.floor(sr * seconds);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = amp * Math.sin((2 * Math.PI * freq * i) / sr);
  return x;
}

// Sum several sines into one buffer.
function chord(sr: number, seconds: number, freqs: number[]): Float32Array {
  const len = Math.floor(sr * seconds);
  const x = new Float32Array(len);
  for (const f of freqs) {
    for (let i = 0; i < len; i++) x[i] += 0.3 * Math.sin((2 * Math.PI * f * i) / sr);
  }
  return x;
}

describe('analyzePitch', () => {
  it('identifies the dominant pitch class of a sine', () => {
    const sr = 22050;
    const a4 = sine(sr, 4, 440); // A
    const res = analyzePitch(a4, sr);
    expect(res.pitchClass).toBe(9); // A
    expect(res.confidence).toBeGreaterThan(0.5);
  });

  it('reads white noise as unpitched', () => {
    const sr = 22050;
    const len = sr * 4;
    const noise = new Float32Array(len);
    for (let i = 0; i < len; i++) noise[i] = Math.random() * 2 - 1;
    const res = analyzePitch(noise, sr);
    expect(res.confidence).toBeLessThan(0.18);
    expect(res.name).toBe('—');
    expect(res.pitchClass).toBe(-1);
  });

  it('estimates a C major key from a C major triad', () => {
    const sr = 22050;
    // C4 / E4 / G4
    const triad = chord(sr, 4, [261.63, 329.63, 392.0]);
    const res = analyzePitch(triad, sr);
    expect(res.tonic).toBe(0); // C
    expect(res.mode).toBe('major');
    expect(res.name).toBe('C major');
  });

  it('returns unpitched for input shorter than the analysis window', () => {
    const res = analyzePitch(new Float32Array(1000), 22050);
    expect(res.pitchClass).toBe(-1);
    expect(res.confidence).toBe(0);
  });
});
