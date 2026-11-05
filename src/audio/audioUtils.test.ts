import { describe, it, expect } from 'vitest';
import { decodeFloatWav, encodeFloatWav, encodeWav, mixChannels } from './audioUtils';

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

describe('float WAV', () => {
  it('round-trips planar float32 audio losslessly', async () => {
    const left = Float32Array.from([0, 0.25, -0.5, 1e-7, 0.999]);
    const right = Float32Array.from([1, -1, 0.125, -1e-7, 0]);
    const bytes = await encodeFloatWav([left, right], 48000).arrayBuffer();
    const out = decodeFloatWav(bytes);
    expect(out.sampleRate).toBe(48000);
    expect(out.channels).toHaveLength(2);
    expect(out.channels[0]).toEqual(left);
    expect(out.channels[1]).toEqual(right);
  });

  it('skips unknown chunks before the audio data', async () => {
    const plain = new Uint8Array(await encodeFloatWav([Float32Array.from([0.5, -0.5])], 44100).arrayBuffer());
    // Insert a 4-byte 'fact' chunk (as libsndfile writes) between fmt and data.
    const fact = new Uint8Array([0x66, 0x61, 0x63, 0x74, 4, 0, 0, 0, 2, 0, 0, 0]);
    const withFact = new Uint8Array(plain.length + fact.length);
    withFact.set(plain.subarray(0, 36));
    withFact.set(fact, 36);
    withFact.set(plain.subarray(36), 36 + fact.length);
    const out = decodeFloatWav(withFact.buffer);
    expect(Array.from(out.channels[0])).toEqual([0.5, -0.5]);
  });

  it('rejects 16-bit PCM', async () => {
    const pcm = await encodeWav([Float32Array.from([0.5])], 44100).arrayBuffer();
    expect(() => decodeFloatWav(pcm)).toThrow(/32-bit float/);
  });
});
