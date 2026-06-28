// Per-component pitch / key estimation. Given a mono signal we build a chroma
// (12-bin pitch-class profile), report the dominant pitch class, and estimate a
// musical key by correlating the chroma against the Krumhansl–Kessler major and
// minor key profiles. A tonality score (how concentrated the chroma is) gates
// whether the result is musically meaningful — broadband percussion spreads its
// energy flat and reads as "unpitched".

import { stft, magnitude } from './stft';

// Pitch analysis wants finer frequency resolution than the separation grid, so
// neighbouring semitones land in distinct bins (a semitone near 110 Hz is only
// ~6.5 Hz wide).
const ANALYSIS_FFT = 4096;
const ANALYSIS_HOP = 1024;

// Only the first few seconds are inspected — components are short loops and the
// pitch content is stable across them.
const MAX_ANALYSIS_SECONDS = 10;

// Musical band for chroma accumulation: roughly C2 up to ~2 kHz. Below this the
// FFT can't resolve semitones; above it harmonics muddy the pitch classes.
const MIN_FREQ = 65;
const MAX_FREQ = 2000;

// Below this tonality the chroma is too flat to call a pitch (noise/percussion).
const TONALITY_THRESHOLD = 0.18;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

// Krumhansl–Kessler key profiles (perceived stability of each scale degree),
// rotated to start on the tonic. Correlating a chroma against all 12 rotations
// of each profile yields the most likely key.
const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

export interface PitchResult {
  /** Dominant pitch class 0–11 (C..B), or -1 when unpitched. */
  pitchClass: number;
  /** Estimated key tonic 0–11. */
  tonic: number;
  mode: 'major' | 'minor';
  /** Human label, e.g. "A minor", or "—" when not tonal enough. */
  name: string;
  /** 0–1 tonality: how concentrated the chroma is (low for noise/percussion). */
  confidence: number;
  /** 12-bin chroma, normalized to unit sum — for optional display. */
  chroma: Float32Array;
}

const unpitched = (): PitchResult => ({
  pitchClass: -1,
  tonic: 0,
  mode: 'major',
  name: '—',
  confidence: 0,
  chroma: new Float32Array(12),
});

// Sum magnitude into 12 pitch-class bins over the musical band, across all
// frames. Returns the chroma normalized to unit sum (zeroed if silent).
function buildChroma(mag: Float32Array, frames: number, bins: number, sampleRate: number, fftSize: number): Float32Array {
  const chroma = new Float32Array(12);
  const binHz = sampleRate / fftSize;
  const minBin = Math.max(1, Math.floor(MIN_FREQ / binHz));
  const maxBin = Math.min(bins - 1, Math.ceil(MAX_FREQ / binHz));

  // Precompute each bin's pitch class once (frequency is frame-independent).
  const pc = new Int8Array(bins);
  for (let b = minBin; b <= maxBin; b++) {
    const freq = b * binHz;
    const midi = Math.round(69 + 12 * Math.log2(freq / 440));
    pc[b] = (((midi % 12) + 12) % 12) as unknown as number;
  }

  for (let t = 0; t < frames; t++) {
    const base = t * bins;
    for (let b = minBin; b <= maxBin; b++) {
      chroma[pc[b]] += mag[base + b];
    }
  }

  let sum = 0;
  for (let i = 0; i < 12; i++) sum += chroma[i];
  if (sum > 0) for (let i = 0; i < 12; i++) chroma[i] /= sum;
  return chroma;
}

// Tonality = 1 − normalized Shannon entropy of the chroma. A single dominant
// pitch class → low entropy → ~1; a flat (noisy) chroma → high entropy → ~0.
function tonality(chroma: Float32Array): number {
  let entropy = 0;
  for (let i = 0; i < 12; i++) {
    const p = chroma[i];
    if (p > 0) entropy -= p * Math.log(p);
  }
  return 1 - entropy / Math.log(12);
}

// Pearson correlation between a chroma and a key profile rotated to `tonic`.
function correlate(chroma: Float32Array, profile: number[], tonic: number): number {
  let meanC = 0;
  let meanP = 0;
  for (let i = 0; i < 12; i++) {
    meanC += chroma[i];
    meanP += profile[i];
  }
  meanC /= 12;
  meanP /= 12;

  let num = 0;
  let dc = 0;
  let dp = 0;
  for (let i = 0; i < 12; i++) {
    const c = chroma[i] - meanC;
    const p = profile[(i - tonic + 12) % 12] - meanP;
    num += c * p;
    dc += c * c;
    dp += p * p;
  }
  const den = Math.sqrt(dc * dp);
  return den > 0 ? num / den : 0;
}

// Best-matching key across all 24 major/minor rotations.
function detectKey(chroma: Float32Array): { tonic: number; mode: 'major' | 'minor' } {
  let bestScore = -Infinity;
  let tonic = 0;
  let mode: 'major' | 'minor' = 'major';
  for (let k = 0; k < 12; k++) {
    const maj = correlate(chroma, MAJOR_PROFILE, k);
    if (maj > bestScore) {
      bestScore = maj;
      tonic = k;
      mode = 'major';
    }
    const min = correlate(chroma, MINOR_PROFILE, k);
    if (min > bestScore) {
      bestScore = min;
      tonic = k;
      mode = 'minor';
    }
  }
  return { tonic, mode };
}

// Estimate the pitch class / key of a mono component. Returns an unpitched
// result for silent or non-tonal input.
export function analyzePitch(signal: Float32Array, sampleRate: number): PitchResult {
  if (signal.length < ANALYSIS_FFT) return unpitched();

  const clip =
    signal.length > MAX_ANALYSIS_SECONDS * sampleRate
      ? signal.subarray(0, Math.floor(MAX_ANALYSIS_SECONDS * sampleRate))
      : signal;

  const s = stft(clip, ANALYSIS_FFT, ANALYSIS_HOP);
  if (s.frames === 0) return unpitched();
  const mag = magnitude(s);
  const chroma = buildChroma(mag, s.frames, s.bins, sampleRate, ANALYSIS_FFT);

  const confidence = tonality(chroma);
  if (confidence < TONALITY_THRESHOLD) return { ...unpitched(), confidence, chroma };

  let pitchClass = 0;
  for (let i = 1; i < 12; i++) if (chroma[i] > chroma[pitchClass]) pitchClass = i;
  const { tonic, mode } = detectKey(chroma);

  return {
    pitchClass,
    tonic,
    mode,
    name: `${NOTE_NAMES[tonic]} ${mode}`,
    confidence,
    chroma,
  };
}
