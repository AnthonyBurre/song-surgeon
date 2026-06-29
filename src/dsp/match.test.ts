import { describe, it, expect } from 'vitest';
import { matchComponents } from './match';
import type { ComponentMessage } from './worker';

const SR = 44100;

function tonal(chroma: number[]): ComponentMessage {
  return {
    channels: [new Float32Array(4096)],
    kind: 'harmonic',
    energy: 1,
    pitch: {
      pitchClass: 0,
      tonic: 0,
      mode: 'major',
      name: 'C major',
      confidence: 1,
      chroma: Float32Array.from(chroma),
    },
  };
}

// A deterministic tone-ish percussive signal so the spectral descriptor is stable.
function percussive(freq: number): ComponentMessage {
  const n = 8192;
  const sig = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    sig[i] = Math.sin((2 * Math.PI * freq * i) / SR) + 0.3 * Math.sin((2 * Math.PI * 3 * freq * i) / SR);
  }
  return { channels: [sig], kind: 'percussive', energy: 1 };
}

describe('matchComponents', () => {
  it('pairs identical tonal loops with ~1 similarity', () => {
    const c = [6, 1, 1, 1, 4, 1, 1, 5, 1, 1, 1, 2];
    const { pairs } = matchComponents([tonal(c)], [tonal(c)], SR, SR);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({ a: 0, b: 0, basis: 'tonal' });
    expect(pairs[0].similarity).toBeGreaterThan(0.999);
  });

  it('never pairs a tonal loop with a percussive one', () => {
    const result = matchComponents([tonal([6, 1, 1, 1, 4, 1, 1, 5, 1, 1, 1, 2])], [percussive(110)], SR, SR);
    expect(result.pairs).toHaveLength(0);
    expect(result.unpairedA).toEqual([0]);
    expect(result.unpairedB).toEqual([0]);
  });

  it('pairs percussive loops by spectral shape and scores identical ones highest', () => {
    const a = [percussive(110)];
    const b = [percussive(880), percussive(110)];
    const { pairs } = matchComponents(a, b, SR, SR);
    expect(pairs).toHaveLength(1);
    // The 110 Hz loop in B is identical to A's, so it should win over the 880 Hz one.
    expect(pairs[0]).toMatchObject({ a: 0, b: 1, basis: 'percussive' });
    expect(pairs[0].similarity).toBeGreaterThan(0.999);
  });

  it('prefers the most-similar tonal counterpart', () => {
    const cMajor = [6, 1, 1, 1, 4, 1, 1, 5, 1, 1, 1, 2];
    const shifted = [2, 6, 1, 1, 1, 4, 1, 1, 5, 1, 1, 1];
    const { pairs } = matchComponents([tonal(cMajor)], [tonal(shifted), tonal(cMajor)], SR, SR);
    expect(pairs[0]).toMatchObject({ a: 0, b: 1 });
  });
});
