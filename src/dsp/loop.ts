// Trim a reconstructed component to an exact loop length with a wrap-around
// crossfade so it repeats without a click at the boundary.
//
// The separation runs on a crop that is `loopLength + crossfade` samples long.
// The extra tail is the natural continuation of the loop; we fade it out while
// fading the real head in, so the last sample flows into the first. Because the
// identical operation is applied to every component, the components still sum to
// a (seamlessly looped) version of the original — conservation is preserved.
export function loopTrim(x: Float32Array, loopLength: number, crossfade: number): Float32Array {
  const M = Math.min(loopLength, x.length);
  const out = new Float32Array(M);
  out.set(x.subarray(0, M));

  const cf = Math.min(crossfade, M, x.length - M);
  for (let i = 0; i < cf; i++) {
    const w = i / cf; // 0 → 1 across the fade
    out[i] = (1 - w) * x[M + i] + w * x[i];
  }
  return out;
}
