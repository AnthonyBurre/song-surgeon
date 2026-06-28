import { describe, it, expect } from 'vitest';
import { mixChannels } from './audioUtils';

describe('mixChannels', () => {
  it('sums stereo parts channel-by-channel', () => {
    const a = [Float32Array.from([1, 2, 3]), Float32Array.from([0, -1, 2])];
    const b = [Float32Array.from([0.5, 0.5, 0.5]), Float32Array.from([1, 1, 1])];
    const out = mixChannels([a, b]);
    expect(out).toHaveLength(2);
    expect(Array.from(out[0])).toEqual([1.5, 2.5, 3.5]);
    expect(Array.from(out[1])).toEqual([1, 0, 3]);
  });

  it('folds a mono part into every channel of a stereo mix', () => {
    const stereo = [Float32Array.from([1, 1]), Float32Array.from([2, 2])];
    const mono = [Float32Array.from([10, 20])];
    const out = mixChannels([stereo, mono]);
    expect(out).toHaveLength(2);
    expect(Array.from(out[0])).toEqual([11, 21]);
    expect(Array.from(out[1])).toEqual([12, 22]);
  });
});
