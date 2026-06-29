// Cross-song component matching ("suggested analogues"). Given the decomposed
// loops of two songs, pair each loop with its closest counterpart in the other
// song so the user can line up "A's bass ↔ B's bass" when building a transition.
//
// Matching is constrained to compatible kinds (percussive↔percussive, tonal↔
// tonal) and ranked by a similarity score: chroma cosine for tonal parts (which
// already carry a 12-bin chroma from pitch analysis), and a log-band spectral
// envelope cosine for percussive parts.

import { stft, magnitude } from './stft';
import type { PartKind } from './separate';
import type { ComponentMessage } from './worker';

// A loop is "tonal" for matching purposes when it isn't pure percussion — i.e.
// harmonic or mixed parts, which carry a chroma we can compare.
function isTonal(c: ComponentMessage): boolean {
  return c.kind !== 'percussive';
}

// Only the first couple of seconds are needed to characterise a loop.
const DESCRIPTOR_FFT = 1024;
const DESCRIPTOR_HOP = 512;
const DESCRIPTOR_SECONDS = 4;
const PERC_BANDS = 24;

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  const den = Math.sqrt(na) * Math.sqrt(nb);
  return den > 1e-12 ? dot / den : 0;
}

// Average log-magnitude over PERC_BANDS log-spaced frequency bands — a coarse
// spectral envelope that captures the timbre of a percussive loop (e.g. a kick's
// low-band weight vs. a hat's high-band weight). L2-normalized.
function percDescriptor(signal: Float32Array, sampleRate: number): Float32Array {
  const clip =
    signal.length > DESCRIPTOR_SECONDS * sampleRate
      ? signal.subarray(0, Math.floor(DESCRIPTOR_SECONDS * sampleRate))
      : signal;
  const bands = new Float32Array(PERC_BANDS);
  if (clip.length < DESCRIPTOR_FFT) return bands;

  const s = stft(clip, DESCRIPTOR_FFT, DESCRIPTOR_HOP);
  if (s.frames === 0) return bands;
  const mag = magnitude(s);
  const binHz = sampleRate / DESCRIPTOR_FFT;
  const nyquist = sampleRate / 2;
  const fMin = 40;
  const logMin = Math.log(fMin);
  const logMax = Math.log(nyquist);

  const counts = new Float32Array(PERC_BANDS);
  for (let t = 0; t < s.frames; t++) {
    const base = t * s.bins;
    for (let b = 1; b < s.bins; b++) {
      const freq = b * binHz;
      if (freq < fMin) continue;
      const pos = (Math.log(freq) - logMin) / (logMax - logMin);
      const band = Math.min(PERC_BANDS - 1, Math.max(0, Math.floor(pos * PERC_BANDS)));
      bands[band] += mag[base + b];
      counts[band] += 1;
    }
  }
  for (let i = 0; i < PERC_BANDS; i++) {
    bands[i] = Math.log1p(bands[i] / Math.max(1, counts[i]));
  }
  // L2 normalize so cosine compares shape, not loudness.
  let norm = 0;
  for (let i = 0; i < PERC_BANDS; i++) norm += bands[i] * bands[i];
  norm = Math.sqrt(norm);
  if (norm > 1e-12) for (let i = 0; i < PERC_BANDS; i++) bands[i] /= norm;
  return bands;
}

export interface AnaloguePair {
  /** Index into deck A's components. */
  a: number;
  /** Index into deck B's components. */
  b: number;
  /** 0..1 similarity within the matched kind. */
  similarity: number;
  /** Which descriptor produced the match. */
  basis: 'tonal' | 'percussive';
}

export interface MatchResult {
  pairs: AnaloguePair[];
  /** Indices of deck A components with no analogue in B. */
  unpairedA: number[];
  /** Indices of deck B components with no analogue in A. */
  unpairedB: number[];
}

// Greedy mutual matching: build the compatible-kind similarity matrix, then
// repeatedly take the highest-scoring unused (a, b) pair until none remain.
export function matchComponents(
  aComps: ComponentMessage[],
  bComps: ComponentMessage[],
  aSampleRate: number,
  bSampleRate: number,
): MatchResult {
  // Precompute descriptors once per component.
  const aDesc = aComps.map((c) =>
    isTonal(c) ? null : percDescriptor(c.channels[0], aSampleRate),
  );
  const bDesc = bComps.map((c) =>
    isTonal(c) ? null : percDescriptor(c.channels[0], bSampleRate),
  );

  const candidates: AnaloguePair[] = [];
  for (let a = 0; a < aComps.length; a++) {
    for (let b = 0; b < bComps.length; b++) {
      const ca = aComps[a];
      const cb = bComps[b];
      const tonalA = isTonal(ca);
      const tonalB = isTonal(cb);
      if (tonalA !== tonalB) continue; // never pair tonal with percussive

      let similarity: number;
      let basis: 'tonal' | 'percussive';
      if (tonalA) {
        const chA = ca.pitch?.chroma;
        const chB = cb.pitch?.chroma;
        if (!chA || !chB) continue;
        similarity = cosine(chA, chB);
        basis = 'tonal';
      } else {
        similarity = cosine(aDesc[a]!, bDesc[b]!);
        basis = 'percussive';
      }
      candidates.push({ a, b, similarity, basis });
    }
  }

  candidates.sort((x, y) => y.similarity - x.similarity);
  const usedA = new Set<number>();
  const usedB = new Set<number>();
  const pairs: AnaloguePair[] = [];
  for (const c of candidates) {
    if (usedA.has(c.a) || usedB.has(c.b)) continue;
    usedA.add(c.a);
    usedB.add(c.b);
    pairs.push(c);
  }

  const unpairedA = aComps.map((_, i) => i).filter((i) => !usedA.has(i));
  const unpairedB = bComps.map((_, i) => i).filter((i) => !usedB.has(i));
  return { pairs, unpairedA, unpairedB };
}

export type { PartKind };
