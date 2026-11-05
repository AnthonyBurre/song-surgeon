# Song Surgeon

A web app that pulls a track apart into independent, repeating signals you
can solo, loop, and download. Drop in an audio file, crop a segment, choose how
many parts to extract, and the app decomposes the segment on your own machine —
nothing is uploaded anywhere. It runs as a static page (e.g. GitHub Pages), or
locally with an optional engine server for neural stem separation.

## How it works

Everything runs in the browser. The decomposition pipeline lives in `src/dsp/` and
runs inside a Web Worker so the UI stays responsive.

1. **Decode & crop** — the file is decoded with the Web Audio API and downmixed to
   mono for analysis. A draggable [wavesurfer.js](https://wavesurfer.xyz) region
   selects the segment to process (capped at 20s to bound compute); the waveform can
   be zoomed and scrolled to place the selection precisely. On load, a tempo pass
   (`src/dsp/tempo.ts`) — onset-envelope spectral flux + autocorrelation — estimates
   the BPM and bar length, and auto-proposes a whole-bar crop that loops cleanly. With
   **snap to bars** on, the selection snaps to the bar grid live as you drag or resize
   it, and each component gets a short wrap-around crossfade (`src/dsp/loop.ts`) so it
   repeats without a click.
2. **STFT** — a short-time Fourier transform (`src/dsp/stft.ts`) produces a complex
   spectrogram. A hand-rolled radix-2 FFT (`src/dsp/fft.ts`) does the transform.
3. **HPSS** — harmonic/percussive source separation by median filtering
   (`src/dsp/hpss.ts`, Fitzgerald 2010) splits the spectrogram into a percussive
   stream (broadband, transient) and a harmonic stream (tonal, sustained) via
   complementary soft masks.
4. **NMF** — non-negative matrix factorization with KL-divergence multiplicative
   updates (`src/dsp/nmf.ts`) factors each stream into components. Each component is a
   recurring spectral template × an activation pattern over time — i.e. a candidate
   loop. By default the part count is chosen automatically: each stream is
   over-segmented, then near-duplicate components are merged and tiny ones folded away
   (`src/dsp/separate.ts`), leaning conservative. You can override with exact counts
   under **Advanced**, **Split** any resulting part to break it down further (which
   re-runs NMF on just that part's audio), or tick two parts and **Combine** them into
   one (which just sums their audio).
5. **Reconstruction** — each component becomes a soft mask over the *original*
   complex STFT and is inverted back to audio (`reconstruct` / `istft`). The masks
   sum to ~1, so the parts add back up to the original segment. The mono-derived mask
   is applied to each input channel independently, so a stereo source yields stereo
   stems that keep their original image.

Each tonal part is also labelled with an estimated musical key — a chroma
(pitch-class profile) correlated against the Krumhansl–Kessler key profiles
(`src/dsp/pitch.ts`); percussive/atonal parts are left unlabelled.

The result is a set of stems played in sync (`src/ui/playback.ts`) with per-part
solo/mute/loop and (mono or stereo) WAV download.

## What it can and can't do

Once loops are summed into a mix (and especially after mastering), perfect recovery
is mathematically impossible — this produces a useful *approximation*. It works best
on short, clearly loop-based segments. A single drum loop may split across
components, and results depend on the chosen part counts.

## Separation engines

Splitting goes through a small engine interface (`src/engine/types.ts`), so the
same UI can use different separators. Each engine describes its own options and the
UI draws them; pick one from the **Engine** menu in step 2.

| Engine | Runs in | Output | Needs |
|--------|---------|--------|-------|
| **Built-in loops** | the browser | repeating loops (HPSS + NMF) | nothing |
| **Demucs stems** | local server | instrument stems: drums, bass, vocals, other (or 6 stems incl. guitar, piano) | Python + PyTorch |

The local server is optional. Without it (e.g. on GitHub Pages) only the built-in
engine appears. **Split** always uses the built-in engine, so a Demucs stem can be
broken down further into loops.

### Run locally with the engine server

Requires [uv](https://docs.astral.sh/uv/) and Node. Apple Silicon (MPS), NVIDIA
(CUDA), or CPU; Intel Macs aren't supported by current PyTorch.

```bash
npm install
npm start        # builds the UI, then serves it + the engine API at http://localhost:8000
```

The first `npm start` installs the Python dependencies (PyTorch is large), and the
first separation downloads the chosen Demucs model (~80 MB, cached afterwards). The
server listens on `127.0.0.1` only. `uv run --project server song-surgeon --help`
lists its flags (`--port`, `--device`, …).

The HTTP protocol between the page and the server is documented at the top of
`server/song_surgeon_server/app.py`.

## Develop

```bash
npm install
npm run dev      # Vite dev server (proxies /api to an engine server on :8000)
npm run engine   # optional: the engine server, in a second terminal
npm test         # unit tests (DSP, WAV codec, arrangement)
npm run build    # typecheck + production build to dist/
```

## Deploy

Pushing to `main` triggers `.github/workflows/deploy.yml`, which builds and
publishes `dist/` to GitHub Pages (enable Pages → "GitHub Actions" in the repo
settings). The build uses relative asset paths, so it works under any repo name.

## Roadmap

See [ROADMAP.md](ROADMAP.md) for next steps, the feature backlog, and the tuning knobs
(the parameters you can refine to improve separation quality).
