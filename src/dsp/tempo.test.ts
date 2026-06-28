import { describe, it, expect } from 'vitest';
import { analyzeTempo, snapToBars, type TempoResult } from './tempo';

// Build a click train at a known tempo: a short decaying impulse on every beat,
// over a quiet tonal bed so the onset envelope has clear periodic peaks.
function clickTrain(sr: number, seconds: number, bpm: number): Float32Array {
  const len = Math.floor(sr * seconds);
  const x = new Float32Array(len);
  for (let i = 0; i < len; i++) x[i] = 0.05 * Math.sin((2 * Math.PI * 110 * i) / sr);
  const period = Math.round((60 / bpm) * sr);
  for (let beat = 0; beat * period < len; beat++) {
    const start = beat * period;
    for (let i = 0; i < 400 && start + i < len; i++) {
      x[start + i] += Math.exp(-i / 60) * (i % 2 ? -0.8 : 0.8);
    }
  }
  return x;
}

describe('analyzeTempo', () => {
  it('detects the tempo of a click train', () => {
    const sr = 22050;
    const x = clickTrain(sr, 8, 120);
    const { tempo } = analyzeTempo(x, sr, 20);
    expect(tempo.bpm).toBeGreaterThan(116);
    expect(tempo.bpm).toBeLessThan(124);
    expect(tempo.barLength).toBeCloseTo((60 / 120) * 4, 1);
  });

  it('suggests a whole-bar crop within the cap', () => {
    const sr = 22050;
    const x = clickTrain(sr, 12, 100);
    const { tempo, suggestion } = analyzeTempo(x, sr, 20);
    const bars = (suggestion.end - suggestion.start) / tempo.barLength;
    expect(Math.abs(bars - Math.round(bars))).toBeLessThan(0.05);
    expect(suggestion.bars).toBeGreaterThanOrEqual(1);
    expect(suggestion.end - suggestion.start).toBeLessThanOrEqual(20 + 1e-6);
  });
});

describe('snapToBars', () => {
  const tempo: TempoResult = {
    bpm: 120,
    beatPeriod: 0.5,
    barLength: 2,
    beatsPerBar: 4,
    firstBeat: 0,
    firstDownbeat: 0,
    confidence: 1,
  };

  it('snaps length to a whole number of bars', () => {
    const snapped = snapToBars(tempo, 0.1, 5.2, 60, 20);
    const bars = (snapped.end - snapped.start) / tempo.barLength;
    expect(bars).toBe(Math.round(bars));
    expect(snapped.bars).toBe(3); // 5.1s ≈ 2.55 bars → rounds to 3
  });

  it('never exceeds the available duration', () => {
    const snapped = snapToBars(tempo, 1, 30, 10, 20);
    expect(snapped.end).toBeLessThanOrEqual(10 + 1e-6);
  });
});
