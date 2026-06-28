// Tempo / beat analysis used to auto-suggest crops and beat-sync loops.
//
// Pipeline: STFT magnitude → spectral-flux onset envelope → autocorrelation for
// the dominant beat period (with a log-Gaussian prior to tame octave errors) →
// beat phase and downbeat (assuming 4/4) → a crop that spans whole bars and
// loops cleanly. Everything is derived from the mono analysis signal.

import { stft, magnitude } from './stft';

// Analysis resolution for onset detection. Smaller hop than the separation
// pipeline so transients land on distinct frames.
const ANALYSIS_FFT = 1024;
const ANALYSIS_HOP = 256;

// Plausible tempo search range. Octave folding is handled by the prior below.
const MIN_BPM = 60;
const MAX_BPM = 200;
// The prior is a Gaussian in log-tempo space, centred here, biasing the pick
// toward everyday tempos so a half/double-time peak doesn't win outright.
const PRIOR_CENTER_BPM = 124;
const PRIOR_WIDTH_OCT = 0.9;

const BEATS_PER_BAR = 4;

export interface TempoResult {
  bpm: number;
  /** Seconds per beat. */
  beatPeriod: number;
  /** Seconds per bar (BEATS_PER_BAR · beatPeriod). */
  barLength: number;
  beatsPerBar: number;
  /** Seconds to the first detected beat. */
  firstBeat: number;
  /** Seconds to the first detected downbeat (bar start). */
  firstDownbeat: number;
  /** Normalized autocorrelation strength at the chosen lag, 0..1-ish. */
  confidence: number;
}

export interface CropSuggestion {
  start: number;
  end: number;
  bars: number;
}

export interface TempoAnalysis {
  tempo: TempoResult;
  suggestion: CropSuggestion;
}

// Spectral-flux onset envelope: per-frame sum of positive magnitude increases,
// on a lightly compressed spectrum. Returns one value per STFT frame.
function onsetEnvelope(mag: Float32Array, frames: number, bins: number): Float32Array {
  const env = new Float32Array(frames);
  for (let t = 1; t < frames; t++) {
    let flux = 0;
    const cur = t * bins;
    const prev = (t - 1) * bins;
    for (let b = 0; b < bins; b++) {
      const d = Math.log1p(mag[cur + b]) - Math.log1p(mag[prev + b]);
      if (d > 0) flux += d;
    }
    env[t] = flux;
  }
  // High-pass the envelope by subtracting a local moving average, then clip to
  // positive — this removes slow loudness drift and sharpens beat pulses.
  const win = 16;
  const smoothed = new Float32Array(frames);
  let acc = 0;
  for (let t = 0; t < frames; t++) {
    acc += env[t];
    if (t >= win) acc -= env[t - win];
    smoothed[t] = acc / Math.min(t + 1, win);
  }
  for (let t = 0; t < frames; t++) {
    const v = env[t] - smoothed[t];
    env[t] = v > 0 ? v : 0;
  }
  return env;
}

// Autocorrelation of the onset envelope across the lag range implied by the
// tempo bounds, weighted by a log-tempo prior. Returns the best lag in frames.
function bestLag(env: Float32Array, frameRate: number): { lag: number; confidence: number } {
  const minLag = Math.max(1, Math.round((frameRate * 60) / MAX_BPM));
  const maxLag = Math.round((frameRate * 60) / MIN_BPM);

  let energy = 0;
  for (let t = 0; t < env.length; t++) energy += env[t] * env[t];
  energy = energy || 1;

  let best = minLag;
  let bestScore = -Infinity;
  let bestRaw = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    let ac = 0;
    for (let t = lag; t < env.length; t++) ac += env[t] * env[t - lag];
    const bpm = (frameRate * 60) / lag;
    const oct = Math.log2(bpm / PRIOR_CENTER_BPM);
    const prior = Math.exp(-0.5 * (oct * oct) / (PRIOR_WIDTH_OCT * PRIOR_WIDTH_OCT));
    const score = (ac / energy) * prior;
    if (score > bestScore) {
      bestScore = score;
      best = lag;
      bestRaw = ac / energy;
    }
  }
  return { lag: best, confidence: Math.min(1, bestRaw) };
}

// Given the beat period, fold the envelope over one period to find the phase
// (which offset the beats sit on), then over a bar to find the downbeat.
function findPhase(
  env: Float32Array,
  lag: number,
): { firstBeatFrame: number; firstDownbeatFrame: number } {
  const phaseScore = new Float32Array(lag);
  for (let t = 0; t < env.length; t++) phaseScore[t % lag] += env[t];
  let beatPhase = 0;
  for (let p = 1; p < lag; p++) if (phaseScore[p] > phaseScore[beatPhase]) beatPhase = p;

  // Among the BEATS_PER_BAR candidate beats, the loudest on average is the
  // downbeat. Sum onset strength at each beat position modulo the bar.
  const barScore = new Float32Array(BEATS_PER_BAR);
  const barCount = new Float32Array(BEATS_PER_BAR);
  let beatIndex = 0;
  for (let frame = beatPhase; frame < env.length; frame += lag) {
    const slot = beatIndex % BEATS_PER_BAR;
    // Look at the strongest envelope value in a small neighbourhood of the beat.
    let peak = 0;
    for (let d = -1; d <= 1; d++) {
      const f = frame + d;
      if (f >= 0 && f < env.length && env[f] > peak) peak = env[f];
    }
    barScore[slot] += peak;
    barCount[slot] += 1;
    beatIndex++;
  }
  let downbeatSlot = 0;
  for (let b = 1; b < BEATS_PER_BAR; b++) {
    const avg = barScore[b] / Math.max(1, barCount[b]);
    const bestAvg = barScore[downbeatSlot] / Math.max(1, barCount[downbeatSlot]);
    if (avg > bestAvg) downbeatSlot = b;
  }
  return { firstBeatFrame: beatPhase, firstDownbeatFrame: beatPhase + downbeatSlot * lag };
}

// Pick a whole-bar crop that loops cleanly: starts on the first downbeat and
// spans the largest power-of-two bar count (capped at 8) that fits the limit.
function suggestCrop(tempo: TempoResult, duration: number, maxSeconds: number): CropSuggestion {
  const { barLength, firstDownbeat } = tempo;
  const usable = Math.min(maxSeconds, duration);
  const maxBars = Math.max(1, Math.floor(usable / barLength));
  let bars = 1;
  for (const candidate of [8, 4, 2, 1]) {
    if (candidate <= maxBars) {
      bars = candidate;
      break;
    }
  }
  let start = firstDownbeat;
  let end = start + bars * barLength;
  // Slide back inside the track if the window runs past the end.
  if (end > duration) {
    start = Math.max(0, duration - bars * barLength);
    end = Math.min(duration, start + bars * barLength);
  }
  return { start, end, bars };
}

// Full tempo analysis. `signal` is mono; only the first `maxAnalysisSeconds`
// are inspected so long tracks stay fast (tempo is stable across a track).
export function analyzeTempo(
  signal: Float32Array,
  sampleRate: number,
  maxCropSeconds: number,
  maxAnalysisSeconds = 60,
): TempoAnalysis {
  const duration = signal.length / sampleRate;
  const clip =
    signal.length > maxAnalysisSeconds * sampleRate
      ? signal.subarray(0, Math.floor(maxAnalysisSeconds * sampleRate))
      : signal;

  const s = stft(clip, ANALYSIS_FFT, ANALYSIS_HOP);
  const mag = magnitude(s);
  const env = onsetEnvelope(mag, s.frames, s.bins);
  const frameRate = sampleRate / ANALYSIS_HOP;

  const { lag, confidence } = bestLag(env, frameRate);
  const beatPeriod = lag / frameRate;
  const bpm = 60 / beatPeriod;
  const { firstBeatFrame, firstDownbeatFrame } = findPhase(env, lag);

  const tempo: TempoResult = {
    bpm,
    beatPeriod,
    barLength: BEATS_PER_BAR * beatPeriod,
    beatsPerBar: BEATS_PER_BAR,
    firstBeat: (firstBeatFrame * ANALYSIS_HOP) / sampleRate,
    firstDownbeat: (firstDownbeatFrame * ANALYSIS_HOP) / sampleRate,
    confidence,
  };

  return { tempo, suggestion: suggestCrop(tempo, duration, maxCropSeconds) };
}

// Snap an arbitrary [start, end] selection to the beat grid: start moves to the
// nearest beat, length to the nearest whole number of bars (≥ 1). Used so a
// hand-dragged crop still trims to a seamless loop.
export function snapToBars(
  tempo: TempoResult,
  start: number,
  end: number,
  duration: number,
  maxSeconds: number,
): { start: number; end: number; bars: number } {
  const { beatPeriod, barLength, firstBeat } = tempo;
  const beatIndex = Math.round((start - firstBeat) / beatPeriod);
  let snappedStart = firstBeat + beatIndex * beatPeriod;
  if (snappedStart < 0) snappedStart += beatPeriod * Math.ceil(-snappedStart / beatPeriod);

  const maxBars = Math.max(1, Math.floor(Math.min(maxSeconds, duration - snappedStart) / barLength));
  let bars = Math.max(1, Math.round((end - start) / barLength));
  bars = Math.min(bars, maxBars);
  const snappedEnd = snappedStart + bars * barLength;

  return { start: snappedStart, end: snappedEnd, bars };
}
