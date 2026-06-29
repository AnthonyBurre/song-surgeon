// Independent time-stretching and pitch-shifting via a phase vocoder, built on
// the project's own STFT/FFT. Time-stretch changes duration while preserving
// pitch; pitch-shift changes pitch while preserving duration (stretch + resample).
// Used to "conform" one song's tempo and key to a transition's target so loops
// line up rhythmically and harmonically.

import { fft } from './fft';
import { stft, hann } from './stft';

const TWO_PI = 2 * Math.PI;
const DEFAULT_FFT = 2048;

// Phase-vocoder time-stretch. `ratio` > 1 lengthens (slows down) and < 1 shortens
// (speeds up); pitch is preserved. Analysis hop is fftSize/4 (clean Hann overlap);
// the synthesis hop is scaled by `ratio` and per-bin phase is propagated from the
// instantaneous frequency so partials stay coherent.
export function timeStretch(signal: Float32Array, ratio: number, fftSize = DEFAULT_FFT): Float32Array {
  if (!(ratio > 0)) return signal.slice();
  if (Math.abs(ratio - 1) < 1e-6 || signal.length < fftSize) return signal.slice();

  const Ha = Math.floor(fftSize / 4);
  const Hs = Math.max(1, Math.round(Ha * ratio));
  const s = stft(signal, fftSize, Ha);
  const { re, im, frames, bins } = s;
  const win = hann(fftSize);

  const outLen = frames > 0 ? (frames - 1) * Hs + fftSize : 0;
  const out = new Float32Array(outLen);
  const norm = new Float32Array(outLen);
  const synthPhase = new Float32Array(bins);
  const prevPhase = new Float32Array(bins);
  const fr = new Float32Array(fftSize);
  const fi = new Float32Array(fftSize);

  for (let t = 0; t < frames; t++) {
    const base = t * bins;
    for (let b = 0; b < bins; b++) {
      const reb = re[base + b];
      const imb = im[base + b];
      const mag = Math.hypot(reb, imb);
      const phase = Math.atan2(imb, reb);

      if (t === 0) {
        synthPhase[b] = phase;
      } else {
        const omega = (TWO_PI * b) / fftSize; // rad / sample for this bin
        let dphi = phase - prevPhase[b] - omega * Ha;
        dphi -= TWO_PI * Math.round(dphi / TWO_PI); // principal value
        const trueFreq = omega + dphi / Ha;
        synthPhase[b] += trueFreq * Hs;
      }
      prevPhase[b] = phase;
      fr[b] = mag * Math.cos(synthPhase[b]);
      fi[b] = mag * Math.sin(synthPhase[b]);
    }
    // Rebuild the Hermitian-symmetric upper half before the inverse FFT.
    for (let b = bins; b < fftSize; b++) {
      const m = fftSize - b;
      fr[b] = fr[m];
      fi[b] = -fi[m];
    }
    fft(fr, fi, true);
    const off = t * Hs;
    for (let i = 0; i < fftSize; i++) {
      out[off + i] += fr[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }
  for (let i = 0; i < outLen; i++) if (norm[i] > 1e-8) out[i] /= norm[i];
  return out;
}

// Linear-interpolating resample to an exact target length.
export function resampleTo(signal: Float32Array, targetLength: number): Float32Array {
  const out = new Float32Array(Math.max(0, targetLength));
  if (signal.length === 0 || targetLength === 0) return out;
  if (targetLength === 1) {
    out[0] = signal[0];
    return out;
  }
  const scale = (signal.length - 1) / (targetLength - 1);
  for (let i = 0; i < targetLength; i++) {
    const x = i * scale;
    const i0 = Math.floor(x);
    const i1 = Math.min(signal.length - 1, i0 + 1);
    const frac = x - i0;
    out[i] = signal[i0] * (1 - frac) + signal[i1] * frac;
  }
  return out;
}

// Pitch-shift by `semitones` while preserving duration: stretch by the pitch
// factor, then resample back to the original length.
export function pitchShift(signal: Float32Array, semitones: number, fftSize = DEFAULT_FFT): Float32Array {
  if (Math.abs(semitones) < 1e-6) return signal.slice();
  const factor = Math.pow(2, semitones / 12);
  const stretched = timeStretch(signal, factor, fftSize);
  return resampleTo(stretched, signal.length);
}

// Conform one signal to a target tempo and key in a single phase-vocoder pass:
// final length = round(len · timeRatio) (tempo) and pitch shifted by `semitones`.
// Combining lets us stretch once (by timeRatio · pitchFactor) and resample to the
// tempo-target length, which divides out the pitch factor.
export function conformSignal(signal: Float32Array, timeRatio: number, semitones: number, fftSize = DEFAULT_FFT): Float32Array {
  const targetLen = Math.max(1, Math.round(signal.length * timeRatio));
  if (Math.abs(timeRatio - 1) < 1e-6 && Math.abs(semitones) < 1e-6) return signal.slice();
  const pitchFactor = Math.pow(2, semitones / 12);
  const stretched = timeStretch(signal, timeRatio * pitchFactor, fftSize);
  return resampleTo(stretched, targetLen);
}

// Per-channel conform (mirrors conformSignal across a stereo/multi-channel part).
export function conformChannels(
  channels: Float32Array[],
  timeRatio: number,
  semitones: number,
  fftSize = DEFAULT_FFT,
): Float32Array[] {
  return channels.map((ch) => conformSignal(ch, timeRatio, semitones, fftSize));
}

// Nearest-octave semitone distance from one key tonic to another, in [-6, 6].
export function semitoneDistance(fromTonic: number, toTonic: number): number {
  return ((toTonic - fromTonic + 18) % 12) - 6;
}
