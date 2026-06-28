import { stft, magnitude, reconstruct, type Stft } from './stft';
import { hpssMasks } from './hpss';
import { nmf, type NmfResult } from './nmf';
import { loopTrim } from './loop';
import { analyzePitch, type PitchResult } from './pitch';

export type StreamKind = 'percussive' | 'harmonic';
// A displayed part is one of the analysis streams, or 'mixed' once the user
// combines parts across streams in the UI.
export type PartKind = StreamKind | 'mixed';

// Auto-mode model-order selection. We over-segment each stream, then merge
// components whose basis spectra are near-duplicates and fold away groups that
// carry almost no energy — the surviving group count becomes the part count.
// Auto deliberately leans conservative (≤2 per stream): splitting a part is the
// escape hatch for going finer, but there's no merge, so we under-segment.
const AUTO_MAX_COMPONENTS = 2;
const AUTO_MERGE_SIM = 0.85; // spectral cosine above which two groups merge
const AUTO_MIN_SHARE = 0.08; // groups below this energy share get merged away
const AUTO_STREAM_PRESENCE = 0.04; // stream energy share below this → no parts

// A stream is either auto (the system picks the count) or a fixed manual count.
export type StreamConfig = { mode: 'auto' } | { mode: 'manual'; count: number };

export interface LoopParams {
  /** Final loop length in samples (the crop minus the crossfade tail). */
  lengthSamples: number;
  /** Wrap-around crossfade length in samples. */
  crossfadeSamples: number;
}

export interface SeparationParams {
  fftSize: number;
  hop: number;
  iterations: number;
  percussive: StreamConfig;
  harmonic: StreamConfig;
  /** When set, components are trimmed to a seamless loop (beat-synced). */
  loop?: LoopParams;
}

export const DEFAULT_PARAMS: SeparationParams = {
  fftSize: 2048,
  hop: 512,
  iterations: 80,
  percussive: { mode: 'auto' },
  harmonic: { mode: 'auto' },
};

export interface Component {
  /** One entry per output channel (mono → 1, stereo → 2). */
  channels: Float32Array[];
  kind: PartKind;
  /** RMS energy, used for ordering and display. */
  energy: number;
  /** Estimated pitch / key; unpitched for percussive parts. */
  pitch?: PitchResult;
}

export interface SeparationResult {
  components: Component[];
  sampleRate: number;
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

function downmix(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const len = channels[0].length;
  const out = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) out[i] += ch[i];
  const scale = 1 / channels.length;
  for (let i = 0; i < len; i++) out[i] *= scale;
  return out;
}

// Build the freq-major matrix V (bins x frames) for one HPSS stream, by
// applying that stream's soft mask to the magnitude spectrogram and transposing
// from the frame-major layout used elsewhere.
function streamMatrix(
  mag: Float32Array,
  streamMask: Float32Array,
  frames: number,
  bins: number,
): Float32Array {
  const V = new Float32Array(bins * frames);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) {
      const src = t * bins + b;
      V[b * frames + t] = mag[src] * streamMask[src];
    }
  }
  return V;
}

// Turn one NMF component into a frame-major soft mask, multiplied by its
// stream's mask so that all components across both streams sum back to ~1.
function componentMask(
  fit: NmfResult,
  k: number,
  streamMask: Float32Array,
  frames: number,
  bins: number,
): Float32Array {
  const { W, H, K } = fit;
  const mask = new Float32Array(frames * bins);
  for (let t = 0; t < frames; t++) {
    for (let b = 0; b < bins; b++) {
      let denom = 0;
      for (let j = 0; j < K; j++) denom += W[b * K + j] * H[j * frames + t];
      const share = (W[b * K + k] * H[k * frames + t]) / (denom + 1e-12);
      const idx = t * bins + b;
      mask[idx] = streamMask[idx] * share;
    }
  }
  return mask;
}

function streamEnergyShare(mag: Float32Array, streamMask: Float32Array): number {
  let stream = 0;
  let total = 0;
  for (let i = 0; i < mag.length; i++) {
    total += mag[i];
    stream += mag[i] * streamMask[i];
  }
  return total > 0 ? stream / total : 0;
}

// Cluster the K over-segmented NMF components into groups (arrays of indices).
// Average-linkage agglomeration on basis-spectrum cosine merges near-duplicate
// templates; a second pass folds negligible-energy groups into their closest
// neighbour. Every index lands in exactly one group, so conservation holds.
function clusterComponents(fit: NmfResult): number[][] {
  const { W, H, F, K, T } = fit;
  if (K <= 1) return K === 1 ? [[0]] : [];

  // Pairwise cosine of the (non-negative) basis columns.
  const norm = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let s = 0;
    for (let b = 0; b < F; b++) s += W[b * K + k] * W[b * K + k];
    norm[k] = Math.sqrt(s) + 1e-12;
  }
  const cos = (i: number, j: number): number => {
    let s = 0;
    for (let b = 0; b < F; b++) s += W[b * K + i] * W[b * K + j];
    return s / (norm[i] * norm[j]);
  };

  // Component weight ≈ total spectral mass (basis sum × activation sum).
  const weight = new Float32Array(K);
  for (let k = 0; k < K; k++) {
    let wSum = 0;
    for (let b = 0; b < F; b++) wSum += W[b * K + k];
    let hSum = 0;
    for (let t = 0; t < T; t++) hSum += H[k * T + t];
    weight[k] = wSum * hSum;
  }
  let totalWeight = 0;
  for (let k = 0; k < K; k++) totalWeight += weight[k];
  totalWeight = totalWeight || 1;

  let groups: number[][] = Array.from({ length: K }, (_, k) => [k]);

  const linkage = (a: number[], b: number[]): number => {
    let s = 0;
    for (const i of a) for (const j of b) s += cos(i, j);
    return s / (a.length * b.length);
  };
  const groupShare = (g: number[]): number => {
    let w = 0;
    for (const k of g) w += weight[k];
    return w / totalWeight;
  };

  // Pass 1: merge the most-similar pair while it clears the threshold.
  while (groups.length > 1) {
    let bestSim = -Infinity;
    let bi = 0;
    let bj = 1;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const sim = linkage(groups[i], groups[j]);
        if (sim > bestSim) {
          bestSim = sim;
          bi = i;
          bj = j;
        }
      }
    }
    if (bestSim < AUTO_MERGE_SIM) break;
    groups[bi] = groups[bi].concat(groups[bj]);
    groups.splice(bj, 1);
  }

  // Pass 2: fold any negligible-energy group into its most-similar neighbour.
  while (groups.length > 1) {
    let minShare = Infinity;
    let mi = 0;
    for (let i = 0; i < groups.length; i++) {
      const share = groupShare(groups[i]);
      if (share < minShare) {
        minShare = share;
        mi = i;
      }
    }
    if (minShare >= AUTO_MIN_SHARE) break;
    let bestSim = -Infinity;
    let target = -1;
    for (let i = 0; i < groups.length; i++) {
      if (i === mi) continue;
      const sim = linkage(groups[mi], groups[i]);
      if (sim > bestSim) {
        bestSim = sim;
        target = i;
      }
    }
    groups[target] = groups[target].concat(groups[mi]);
    groups.splice(mi, 1);
  }

  return groups;
}

// Decide how many NMF components to fit for a stream, before any clustering.
function streamRank(config: StreamConfig, mag: Float32Array, streamMask: Float32Array): number {
  if (config.mode === 'manual') return Math.max(0, config.count);
  return streamEnergyShare(mag, streamMask) < AUTO_STREAM_PRESENCE ? 0 : AUTO_MAX_COMPONENTS;
}

// Factor one stream and return a frame-major soft mask per output part. In auto
// mode the over-segmented components are clustered down to the part count.
function streamMasks(
  mag: Float32Array,
  streamMask: Float32Array,
  frames: number,
  bins: number,
  k: number,
  auto: boolean,
  iterations: number,
  seed: number,
  onProgress?: (fraction: number) => void,
): Float32Array[] {
  if (k <= 0) return [];
  const rank = Math.min(k, frames, bins);
  const V = streamMatrix(mag, streamMask, frames, bins);
  const fit = nmf(V, bins, frames, rank, iterations, seed, onProgress);

  const groups = auto
    ? clusterComponents(fit)
    : Array.from({ length: rank }, (_, c) => [c]);

  return groups.map((group) => {
    const mask = new Float32Array(frames * bins);
    for (const c of group) {
      const cm = componentMask(fit, c, streamMask, frames, bins);
      for (let i = 0; i < mask.length; i++) mask[i] += cm[i];
    }
    return mask;
  });
}

// Apply a frame-major mask to every channel's complex STFT and trim/loop the
// resulting signals to a common length.
function renderComponent(
  channelStfts: Stft[],
  mask: Float32Array,
  kind: PartKind,
  targetLength: number,
  sampleRate: number,
  loop?: LoopParams,
): Component {
  const channels = channelStfts.map((s) => {
    let sig = reconstruct(s, mask);
    if (loop) {
      sig = loopTrim(sig, loop.lengthSamples, loop.crossfadeSamples);
    } else if (sig.length !== targetLength) {
      sig = sig.subarray(0, targetLength);
    }
    return sig;
  });
  // Pitch of broadband percussion is meaningless, so only tonal streams are
  // analyzed (the mask is applied per channel, so channel 0 is representative).
  const pitch = kind === 'percussive' ? undefined : analyzePitch(channels[0], sampleRate);
  return { channels, kind, energy: rms(channels[0]), pitch };
}

function channelStfts(channels: Float32Array[], analysis: Stft, fftSize: number, hop: number): Stft[] {
  // Mono reuses the analysis STFT; stereo transforms each input channel once.
  return channels.length === 1 ? [analysis] : channels.map((ch) => stft(ch, fftSize, hop));
}

// Full pipeline: STFT → HPSS → per-stream NMF (auto-clustered) → masked
// reconstruction. Analysis is mono; masks are applied to each input channel so
// output keeps the stereo image (Component.channels has one entry per channel).
export function separate(
  channels: Float32Array[],
  sampleRate: number,
  params: SeparationParams = DEFAULT_PARAMS,
  onProgress?: (fraction: number, stage: string) => void,
): SeparationResult {
  onProgress?.(0.02, 'Analyzing spectrum');
  const mono = downmix(channels);
  const sMono = stft(mono, params.fftSize, params.hop);
  const mag = magnitude(sMono);

  onProgress?.(0.08, 'Splitting harmonic / percussive');
  const { harmonic, percussive } = hpssMasks(mag, sMono.frames, sMono.bins);

  let kPerc = streamRank(params.percussive, mag, percussive);
  let kHarm = streamRank(params.harmonic, mag, harmonic);
  // Auto mode should never produce nothing for an audible clip: keep one part on
  // the louder stream if both fell below the presence threshold.
  if (kPerc === 0 && kHarm === 0 && params.percussive.mode === 'auto' && params.harmonic.mode === 'auto') {
    if (streamEnergyShare(mag, percussive) >= streamEnergyShare(mag, harmonic)) kPerc = 1;
    else kHarm = 1;
  }

  // NMF dominates the cost; map its per-stream progress onto [0.15, 0.95].
  const total = Math.max(1, kPerc + kHarm);
  let finished = 0;
  const streamProgress = (count: number) => (frac: number) => {
    onProgress?.(0.15 + 0.8 * ((finished + frac * count) / total), 'Extracting components');
  };

  const percMasks = streamMasks(mag, percussive, sMono.frames, sMono.bins, kPerc, params.percussive.mode === 'auto', params.iterations, 1, streamProgress(kPerc));
  finished += kPerc;
  const harmMasks = streamMasks(mag, harmonic, sMono.frames, sMono.bins, kHarm, params.harmonic.mode === 'auto', params.iterations, 7, streamProgress(kHarm));
  finished += kHarm;

  const stfts = channelStfts(channels, sMono, params.fftSize, params.hop);
  const targetLength = mono.length;
  const components: Component[] = [
    ...percMasks.map((m) => renderComponent(stfts, m, 'percussive', targetLength, sampleRate, params.loop)),
    ...harmMasks.map((m) => renderComponent(stfts, m, 'harmonic', targetLength, sampleRate, params.loop)),
  ];
  onProgress?.(1, 'Done');

  // Loudest first within the percussive→harmonic grouping.
  components.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'percussive' ? -1 : 1;
    return b.energy - a.energy;
  });

  return { components, sampleRate };
}

export interface SplitOptions {
  fftSize: number;
  hop: number;
  iterations: number;
}

// Break a single existing component into `count` finer parts by re-running NMF
// on just its audio (no HPSS — it already belongs to one stream). The parts sum
// back to the input, so a seamless parent stays seamless.
export function splitComponent(
  channels: Float32Array[],
  sampleRate: number,
  kind: PartKind,
  count: number,
  opts: SplitOptions,
  onProgress?: (fraction: number, stage: string) => void,
): SeparationResult {
  onProgress?.(0.05, 'Analyzing part');
  const mono = downmix(channels);
  const sMono = stft(mono, opts.fftSize, opts.hop);
  const mag = magnitude(sMono);
  const ones = new Float32Array(mag.length).fill(1);

  const masks = streamMasks(mag, ones, sMono.frames, sMono.bins, count, false, opts.iterations, 1, (frac) =>
    onProgress?.(0.1 + 0.85 * frac, 'Splitting part'),
  );

  const stfts = channelStfts(channels, sMono, opts.fftSize, opts.hop);
  const targetLength = mono.length;
  const components = masks.map((m) => renderComponent(stfts, m, kind, targetLength, sampleRate));
  onProgress?.(1, 'Done');

  components.sort((a, b) => b.energy - a.energy);
  return { components, sampleRate };
}
