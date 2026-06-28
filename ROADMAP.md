# Roadmap

A living document for where Song Surgeon is going. Sections:
[Status](#status) · [Next steps](#next-steps) · [Feature backlog](#feature-backlog) ·
[Tuning knobs](#tuning-knobs-where-to-refine) · [Known limitations](#known-limitations) ·
[Parking lot](#parking-lot)

---

## Status

**v1 (shipped)** — fully client-side decompose pipeline.

- [x] Decode + downmix to mono (Web Audio)
- [x] Waveform + draggable crop region (wavesurfer.js), 20s cap
- [x] STFT / ISTFT with hand-rolled radix-2 FFT
- [x] HPSS (median-filter harmonic/percussive split)
- [x] Per-stream NMF (KL multiplicative updates) → soft-mask reconstruction
- [x] Web Worker so the UI stays responsive + progress reporting
- [x] Result cards: synced solo / mute / loop, per-part waveform + playhead, WAV download
- [x] Unit tests (FFT, STFT, NMF, conservation) + GitHub Pages deploy workflow

**v1.1 (shipped)** — musical-loop upgrades.

- [x] Auto-suggest segments — onset-envelope + autocorrelation tempo detection
      ([`tempo.ts`](src/dsp/tempo.ts)); proposes a whole-bar crop and surfaces the
      detected tempo / bar length.
- [x] Beat-synced trimming — snap the crop to whole bars and trim each component to a
      seamless loop with a wrap-around crossfade ([`loop.ts`](src/dsp/loop.ts)). The
      selection snaps to the bar grid live while dragging/resizing; the waveform also
      zooms and scrolls for precise placement (controls live in the crop section).
- [x] Stereo output — analysis stays mono, but each component's mask is applied to both
      input channels so the output keeps its stereo image.

**v1.2 (shipped)** — let the tool decide the part count.

- [x] Auto part count (default) — over-segment each stream then merge near-duplicate NMF
      components and fold away tiny ones ([`separate.ts`](src/dsp/separate.ts)); leans
      conservative (≤2 per stream) because splitting is the only way back up.
- [x] Manual override — exact percussive/harmonic counts behind an "Advanced" expander.
- [x] Per-part splitting — a "Split" button re-runs NMF (K=2) on a single component's
      audio (no HPSS re-split) and replaces it with two sub-parts; re-splittable.
- [x] Combine parts — tick two or more cards and "Combine" sums their audio into one
      part (no re-analysis); mixing across streams yields a 'mixed' part. The inverse of
      Split, so over-/under-segmentation is recoverable in both directions.

---

## Next steps

Roughly in priority order. Check off as they land.

- [x] **Auto-suggest segments** — beat/tempo detection (onset envelope + autocorrelation) to
      propose crops that loop cleanly, and surface the detected tempo/bar length.
- [x] **Beat-synced trimming** — snap component start/end to whole bars so each part loops
      seamlessly instead of clicking at the boundary.
- [x] **Component clustering** — auto mode now merges near-duplicate NMF parts and prunes
      tiny ones so the count reflects musical structure. (Spectral-cosine clustering only;
      grouping *different* drums like kick + snare into one loop is still open.)
- [x] **Stereo output** — apply the mono-derived masks to both channels instead of collapsing.
- [ ] **First git commit** + enable Pages → "GitHub Actions" in repo settings.

---

## Feature backlog

Grouped, unordered. Pull into "Next steps" when ready.

### Separation engine
- [ ] Convolutive NMF (NMFD) — templates that span several frames, better for capturing a
      whole drum *pattern* as one component.
- [ ] Optional deep stem separation (Demucs / Spleeter via ONNX-WASM) as an alternate engine
      for fixed instrument stems (drums/bass/vocals/other). Heavy download; lazy-load it.
- [ ] Wiener-style multi-pass mask refinement.
- [ ] Per-component re-seed / "shuffle" button (NMF is init-dependent — let the user reroll).

### UX
- [ ] Spectrogram view alongside the waveform.
- [ ] Per-part volume faders (not just solo/mute).
- [ ] Export all parts as a zip; export as stems into a single multi-track file.
- [ ] Loading/empty/error states; friendly message when a file fails to decode.
- [ ] Remember last settings (localStorage).

### Analysis quality
- [x] Key/pitch detection per harmonic component — chroma + Krumhansl–Kessler key
      correlation ([`pitch.ts`](src/dsp/pitch.ts)); each tonal part's card is labelled
      with its estimated key. Percussive/atonal parts are left unlabelled.
- [ ] Confidence/quality score so the UI can warn "this segment won't split well."

### Infra
- [ ] Tune the GitHub Pages base path / custom domain.
- [ ] Bundle-size budget once a deep engine is added.

---

## Tuning knobs (where to refine)

The "prompts" you give the algorithm. These are the levers that change output quality — adjust
here when results aren't separating well. Defaults live in
[`DEFAULT_PARAMS`](src/dsp/separate.ts) and the call site in [`main.ts`](src/main.ts).

| Knob | Default | Where | Effect of changing it |
|------|---------|-------|-----------------------|
| **Part count** | Auto | UI ("Advanced" → manual 0–4) | Auto picks per stream; manual overrides with exact percussive/harmonic counts. |
| **AUTO_MAX_COMPONENTS** | 2 | [separate.ts](src/dsp/separate.ts) | Over-segmentation cap before merging — raise for finer auto splits (more over-segmentation risk). |
| **AUTO_MERGE_SIM** | 0.85 | [separate.ts](src/dsp/separate.ts) | Basis-cosine above which auto merges two parts; lower = merges more (fewer parts). |
| **AUTO_MIN_SHARE** | 0.08 | [separate.ts](src/dsp/separate.ts) | Auto folds parts below this energy share into a neighbour. |
| **fftSize** | 2048 | [main.ts](src/main.ts) / [separate.ts](src/dsp/separate.ts) | Larger = better frequency resolution (bass/tonal), worse time resolution (smears transients). |
| **hop** | 512 (fftSize/4) | same | Smaller = smoother reconstruction + more compute. Keep at fftSize/4 for clean overlap-add. |
| **iterations** | 80 | same | More NMF iterations = tighter fit, diminishing returns, slower. |
| **NMF seed** | 1 / 7 | [separate.ts](src/dsp/separate.ts) | NMF is init-dependent; different seeds give different (sometimes better) splits. |
| **HPSS winT / winF** | 17 / 17 | [hpss.ts](src/dsp/hpss.ts) | Bigger time window = stricter "harmonic"; bigger freq window = stricter "percussive". |
| **HPSS power** | 2 | [hpss.ts](src/dsp/hpss.ts) | Higher = harder (more binary) harmonic/percussive masking; lower = softer blend. |
| **MAX_CROP_SECONDS** | 20 | [main.ts](src/main.ts) | Upper bound on segment length; raise carefully — compute scales with it. |
| **manual stepper range** | 0–4 | [main.ts](src/main.ts) | Max selectable parts per stream in manual ("Advanced") mode. |
| **tempo prior** | 124 BPM, 0.9 oct | [tempo.ts](src/dsp/tempo.ts) | Log-Gaussian bias on the autocorrelation pick; recenter/narrow to fix octave (half/double-time) errors. |
| **tempo search range** | 60–200 BPM | [tempo.ts](src/dsp/tempo.ts) | Autocorrelation lag bounds for the beat period. |
| **loop crossfade** | 12 ms | [main.ts](src/main.ts) (`LOOP_CROSSFADE_SEC`) | Wrap-around fade length when snapping to bars; longer = smoother loop point, shorter = tighter transient. |

**Rules of thumb when refining:**
- Drums smearing into tonal parts → raise HPSS `power` or `winF`.
- Bass landing in percussive → raise `fftSize` (more frequency resolution).
- A loop split across too many parts → stay on Auto (it merges duplicates), or in manual mode *lower* the count; raise `AUTO_MERGE_SIM` only if Auto is over-merging.
- Want a part broken up further → use the **Split** button on its card instead of raising the global count.
- Results feel random run-to-run → that's the NMF seed; a reroll button is on the backlog.

---

## Known limitations

- Perfect loop recovery is impossible once a mix is summed/mastered — this is an approximation.
- NMF components aren't guaranteed to be musically clean; one loop can split across parts.
- Analysis (HPSS/NMF) is mono; output can be stereo (the mono mask is applied per channel).
- Tempo detection assumes a steady 4/4 pulse — it won't track tempo changes or odd meters.
- Synthetic/loopy material separates far better than dense, mastered full tracks.

---

## Parking lot

Half-formed ideas — no commitment.

- Drag a component back onto the timeline to A/B against the original.
- "Remix" mode: re-pitch / re-time individual parts.
- Shareable links that encode the file + crop + settings.
- MIDI transcription of a harmonic component.
