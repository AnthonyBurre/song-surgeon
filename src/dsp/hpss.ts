// Harmonic/percussive source separation by median filtering (Fitzgerald 2010).
//
// Harmonic content forms horizontal ridges in a spectrogram (stable across
// time), percussive content forms vertical ridges (broadband, brief). Median
// filtering along each axis isolates one and suppresses the other; the two
// estimates are turned into complementary soft masks that sum to one.

function median(buf: Float32Array, len: number): number {
  // Insertion sort is fine for the small windows used here.
  for (let i = 1; i < len; i++) {
    const v = buf[i];
    let j = i - 1;
    while (j >= 0 && buf[j] > v) {
      buf[j + 1] = buf[j];
      j--;
    }
    buf[j + 1] = v;
  }
  const m = len >> 1;
  return len % 2 ? buf[m] : 0.5 * (buf[m - 1] + buf[m]);
}

export interface HpssMasks {
  harmonic: Float32Array;
  percussive: Float32Array;
}

export function hpssMasks(
  mag: Float32Array,
  frames: number,
  bins: number,
  winT = 17,
  winF = 17,
  power = 2,
): HpssMasks {
  const H = new Float32Array(mag.length);
  const P = new Float32Array(mag.length);
  const halfT = winT >> 1;
  const halfF = winF >> 1;
  const buf = new Float32Array(Math.max(winT, winF));

  // Harmonic estimate: median across time for each frequency bin.
  for (let b = 0; b < bins; b++) {
    for (let t = 0; t < frames; t++) {
      let n = 0;
      for (let dt = -halfT; dt <= halfT; dt++) {
        const tt = t + dt;
        if (tt >= 0 && tt < frames) buf[n++] = mag[tt * bins + b];
      }
      H[t * bins + b] = median(buf, n);
    }
  }

  // Percussive estimate: median across frequency for each frame.
  for (let t = 0; t < frames; t++) {
    const rowBase = t * bins;
    for (let b = 0; b < bins; b++) {
      let n = 0;
      for (let db = -halfF; db <= halfF; db++) {
        const bb = b + db;
        if (bb >= 0 && bb < bins) buf[n++] = mag[rowBase + bb];
      }
      P[rowBase + b] = median(buf, n);
    }
  }

  const harmonic = new Float32Array(mag.length);
  const percussive = new Float32Array(mag.length);
  for (let i = 0; i < mag.length; i++) {
    const hp = Math.pow(H[i], power);
    const pp = Math.pow(P[i], power);
    const denom = hp + pp + 1e-12;
    harmonic[i] = hp / denom;
    percussive[i] = pp / denom;
  }
  return { harmonic, percussive };
}
