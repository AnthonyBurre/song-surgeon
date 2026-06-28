// Non-negative matrix factorization with multiplicative updates minimizing the
// (generalized) Kullback–Leibler divergence, which models audio magnitude
// spectrograms well. Given V (F x T, frequency by time) we find W (F x K) basis
// spectra and H (K x T) activations such that V ≈ W·H.
//
// All matrices are stored dense and row-major:
//   V[f * T + t], W[f * K + k], H[k * T + t]

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface NmfResult {
  W: Float32Array;
  H: Float32Array;
  F: number;
  K: number;
  T: number;
}

function computeRatio(
  V: Float32Array,
  W: Float32Array,
  H: Float32Array,
  R: Float32Array,
  F: number,
  T: number,
  K: number,
): void {
  for (let f = 0; f < F; f++) {
    const wBase = f * K;
    const vBase = f * T;
    for (let t = 0; t < T; t++) {
      let wh = 0;
      for (let k = 0; k < K; k++) wh += W[wBase + k] * H[k * T + t];
      R[vBase + t] = V[vBase + t] / (wh + 1e-12);
    }
  }
}

export function nmf(
  V: Float32Array,
  F: number,
  T: number,
  K: number,
  iterations = 80,
  seed = 1,
  onProgress?: (fraction: number) => void,
): NmfResult {
  const rng = mulberry32(seed);
  const W = new Float32Array(F * K);
  const H = new Float32Array(K * T);
  for (let i = 0; i < W.length; i++) W[i] = rng() * 0.9 + 0.1;
  for (let i = 0; i < H.length; i++) H[i] = rng() * 0.9 + 0.1;

  const R = new Float32Array(F * T);
  const wColSum = new Float32Array(K);
  const hRowSum = new Float32Array(K);

  for (let it = 0; it < iterations; it++) {
    // --- Update H ---
    computeRatio(V, W, H, R, F, T, K);
    wColSum.fill(0);
    for (let f = 0; f < F; f++) {
      const wBase = f * K;
      for (let k = 0; k < K; k++) wColSum[k] += W[wBase + k];
    }
    for (let k = 0; k < K; k++) {
      const inv = 1 / (wColSum[k] + 1e-12);
      const hBase = k * T;
      for (let t = 0; t < T; t++) {
        let s = 0;
        for (let f = 0; f < F; f++) s += W[f * K + k] * R[f * T + t];
        H[hBase + t] *= s * inv;
      }
    }

    // --- Update W ---
    computeRatio(V, W, H, R, F, T, K);
    for (let k = 0; k < K; k++) {
      let s = 0;
      const hBase = k * T;
      for (let t = 0; t < T; t++) s += H[hBase + t];
      hRowSum[k] = s;
    }
    for (let f = 0; f < F; f++) {
      const wBase = f * K;
      const rBase = f * T;
      for (let k = 0; k < K; k++) {
        let s = 0;
        const hBase = k * T;
        for (let t = 0; t < T; t++) s += R[rBase + t] * H[hBase + t];
        W[wBase + k] *= s / (hRowSum[k] + 1e-12);
      }
    }

    onProgress?.((it + 1) / iterations);
  }

  return { W, H, F, K, T };
}
