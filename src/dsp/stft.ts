import { fft } from './fft';

// A complex short-time Fourier transform stored frame-major: bin b of frame t
// lives at index t * bins + b. Only the non-redundant bins (0..N/2) are kept.
export interface Stft {
  re: Float32Array;
  im: Float32Array;
  frames: number;
  bins: number;
  fftSize: number;
  hop: number;
}

export function hann(n: number): Float32Array {
  const w = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n);
  }
  return w;
}

export function stft(signal: Float32Array, fftSize = 2048, hop = 512): Stft {
  const win = hann(fftSize);
  const bins = fftSize / 2 + 1;
  const frames = Math.max(0, Math.floor((signal.length - fftSize) / hop) + 1);
  const re = new Float32Array(frames * bins);
  const im = new Float32Array(frames * bins);
  const fr = new Float32Array(fftSize);
  const fi = new Float32Array(fftSize);

  for (let t = 0; t < frames; t++) {
    const off = t * hop;
    for (let i = 0; i < fftSize; i++) {
      fr[i] = signal[off + i] * win[i];
      fi[i] = 0;
    }
    fft(fr, fi, false);
    const base = t * bins;
    for (let b = 0; b < bins; b++) {
      re[base + b] = fr[b];
      im[base + b] = fi[b];
    }
  }

  return { re, im, frames, bins, fftSize, hop };
}

// Inverse STFT with windowed overlap-add. With a Hann window applied at both
// analysis and synthesis and hop = fftSize/4, the squared-window sum is
// constant (COLA), so we normalize by it to recover the signal exactly.
export function istft(s: Stft): Float32Array {
  const { re, im, frames, bins, fftSize, hop } = s;
  const win = hann(fftSize);
  const len = frames > 0 ? (frames - 1) * hop + fftSize : 0;
  const out = new Float32Array(len);
  const norm = new Float32Array(len);
  const fr = new Float32Array(fftSize);
  const fi = new Float32Array(fftSize);

  for (let t = 0; t < frames; t++) {
    const base = t * bins;
    // Rebuild the full Hermitian-symmetric spectrum from the half stored.
    for (let b = 0; b < bins; b++) {
      fr[b] = re[base + b];
      fi[b] = im[base + b];
    }
    for (let b = bins; b < fftSize; b++) {
      const m = fftSize - b;
      fr[b] = re[base + m];
      fi[b] = -im[base + m];
    }
    fft(fr, fi, true);
    const off = t * hop;
    for (let i = 0; i < fftSize; i++) {
      out[off + i] += fr[i] * win[i];
      norm[off + i] += win[i] * win[i];
    }
  }

  for (let i = 0; i < len; i++) {
    if (norm[i] > 1e-8) out[i] /= norm[i];
  }
  return out;
}

export function magnitude(s: Stft): Float32Array {
  const mag = new Float32Array(s.re.length);
  for (let i = 0; i < mag.length; i++) {
    mag[i] = Math.hypot(s.re[i], s.im[i]);
  }
  return mag;
}

// Apply a real-valued [0,1] mask (frame-major, same layout as the spectrogram)
// to a complex STFT and invert it back to a time-domain signal.
export function reconstruct(s: Stft, mask: Float32Array): Float32Array {
  const re = new Float32Array(s.re.length);
  const im = new Float32Array(s.im.length);
  for (let i = 0; i < re.length; i++) {
    re[i] = s.re[i] * mask[i];
    im[i] = s.im[i] * mask[i];
  }
  return istft({ ...s, re, im });
}
