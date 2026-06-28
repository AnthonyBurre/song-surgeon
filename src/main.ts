import './style.css';
import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';

import { decodeFile, toMono, cropChannels, toAudioBuffer, mixChannels, formatTime } from './audio/audioUtils';
import { PlaybackEngine } from './ui/playback';
import { renderComponents, type ComponentView } from './ui/components';
import { snapToBars, type TempoResult, type CropSuggestion } from './dsp/tempo';
import type { LoopParams, StreamConfig } from './dsp/separate';
import type {
  SeparateRequest,
  SplitRequest,
  AnalyzeRequest,
  ComponentMessage,
  WorkerMessage,
} from './dsp/worker';

const MAX_CROP_SECONDS = 20;
// Wrap-around crossfade applied when trimming components to whole bars.
const LOOP_CROSSFADE_SEC = 0.012;

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="masthead">
    <h1>Song Surgeon</h1>
    <p class="tagline">Drop in a track, crop a segment, and pull it apart into independent
      repeating signals you can solo, loop, and download.</p>
  </header>

  <section class="dropzone" id="dropzone">
    <input type="file" id="file" accept="audio/*" hidden />
    <p class="drop-main">Drop an audio file here, or <button class="link" id="browse" type="button">browse</button></p>
    <p class="hint">Works best on short, loop-based segments. Selections are capped at ${MAX_CROP_SECONDS}s.</p>
  </section>

  <section class="panel hidden" id="source">
    <h2>1 · Crop the segment</h2>
    <div id="waveform"></div>
    <div class="row waveform-tools">
      <label class="zoom"><span>Zoom</span><input type="range" id="zoom" min="1" max="500" value="1" /></label>
      <label class="snap"><input type="checkbox" id="snap-bars" checked /> Snap to whole bars</label>
    </div>
    <div class="row">
      <button class="btn" id="src-play" type="button">Play selection</button>
      <span class="crop-info" id="crop-info"></span>
    </div>
    <div class="row tempo-row">
      <span class="tempo-info" id="tempo-info">Detecting tempo…</span>
      <button class="btn ghost" id="use-suggestion" type="button" hidden>Use suggested loop</button>
    </div>
  </section>

  <section class="panel hidden" id="controls">
    <h2>2 · Choose the breakdown</h2>
    <p class="auto-note">The number of parts is chosen automatically. You can split any part
      again afterwards. <button class="link" id="advanced-toggle" type="button">Advanced</button></p>
    <div class="advanced hidden" id="advanced">
      <label class="manual"><input type="checkbox" id="manual-mode" /> Set the part counts manually</label>
      <div class="control-grid" id="manual-controls">
        <div class="control" id="ctrl-perc"></div>
        <div class="control" id="ctrl-harm"></div>
      </div>
    </div>
    <button class="btn primary" id="decompose" type="button">Decompose</button>
    <div class="progress hidden" id="progress">
      <div class="bar"><div class="fill" id="progress-fill"></div></div>
      <span class="progress-label" id="progress-label"></span>
    </div>
  </section>

  <section class="panel hidden" id="results">
    <h2>3 · Solo the loops</h2>
    <div class="transport">
      <button class="btn primary" id="play-all" type="button">Play all</button>
      <button class="btn" id="stop-all" type="button">Stop</button>
      <button class="btn" id="combine" type="button" disabled>Combine</button>
      <label class="loop"><input type="checkbox" id="loop" checked /> Loop</label>
    </div>
    <p class="results-note" id="results-note"></p>
    <div id="cards"></div>
  </section>
`;

// --- Element refs ---
const $ = <T extends HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const dropzone = $('#dropzone');
const fileInput = $<HTMLInputElement>('#file');
const sourcePanel = $('#source');
const controlsPanel = $('#controls');
const resultsPanel = $('#results');
const cropInfo = $('#crop-info');
const tempoInfo = $('#tempo-info');
const useSuggestionBtn = $<HTMLButtonElement>('#use-suggestion');
const snapBox = $<HTMLInputElement>('#snap-bars');
const waveformEl = $('#waveform');
const zoomSlider = $<HTMLInputElement>('#zoom');
const advancedToggle = $<HTMLButtonElement>('#advanced-toggle');
const advanced = $('#advanced');
const manualBox = $<HTMLInputElement>('#manual-mode');
const manualControls = $('#manual-controls');
const srcPlay = $<HTMLButtonElement>('#src-play');
const decomposeBtn = $<HTMLButtonElement>('#decompose');
const progress = $('#progress');
const progressFill = $('#progress-fill');
const progressLabel = $('#progress-label');
const playAll = $<HTMLButtonElement>('#play-all');
const stopAll = $<HTMLButtonElement>('#stop-all');
const combineBtn = $<HTMLButtonElement>('#combine');
const loopBox = $<HTMLInputElement>('#loop');
const resultsNote = $('#results-note');
const cards = $('#cards');

// --- State ---
interface RegionLike {
  start: number;
  end: number;
  play: () => void;
  setOptions: (o: { start?: number; end?: number }) => void;
}

let decoded: AudioBuffer | null = null;
let ws: WaveSurfer | null = null;
let region: RegionLike | null = null;
let tempo: TempoResult | null = null;
let suggestion: CropSuggestion | null = null;
let suggestionApplied = false;
let percComp = 2;
let harmComp = 2;

// Current result set, kept so a "Split"/"Combine" can edit parts in place.
let components: ComponentMessage[] = [];
let resultSampleRate = 44100;
let selection: number[] = []; // card indices ticked for combining
let busy = false; // a decompose or split is running

const engine = new PlaybackEngine();
let view: ComponentView | null = null;

const worker = new Worker(new URL('./dsp/worker.ts', import.meta.url), { type: 'module' });

// --- Component-count steppers ---
function stepper(
  host: HTMLElement,
  label: string,
  get: () => number,
  set: (v: number) => void,
  min: number,
  max: number,
): void {
  host.innerHTML = `
    <span class="control-label">${label}</span>
    <div class="stepper">
      <button class="btn step" data-d="-1" type="button">−</button>
      <span class="value">${get()}</span>
      <button class="btn step" data-d="1" type="button">+</button>
    </div>`;
  const value = host.querySelector<HTMLElement>('.value')!;
  host.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => {
    b.addEventListener('click', () => {
      const next = Math.max(min, Math.min(max, get() + Number(b.dataset.d)));
      set(next);
      value.textContent = String(get());
    });
  });
}

stepper($('#ctrl-perc'), 'Percussive parts', () => percComp, (v) => (percComp = v), 0, 4);
stepper($('#ctrl-harm'), 'Harmonic parts', () => harmComp, (v) => (harmComp = v), 0, 4);

advancedToggle.addEventListener('click', () => {
  const hidden = advanced.classList.toggle('hidden');
  advancedToggle.textContent = hidden ? 'Advanced' : 'Hide advanced';
});

// Manual counts only apply when the override is enabled; grey the steppers out
// otherwise so it's clear the system is in charge.
function syncManualState(): void {
  manualControls.classList.toggle('disabled', !manualBox.checked);
}
manualBox.addEventListener('change', syncManualState);
syncManualState();

// --- Source loading ---
async function handleFile(file: File): Promise<void> {
  engine.stop();
  resultsPanel.classList.add('hidden');
  tempo = null;
  suggestion = null;
  suggestionApplied = false;
  useSuggestionBtn.hidden = true;
  tempoInfo.textContent = 'Detecting tempo…';

  decoded = await decodeFile(file);
  loadWaveform(file, decoded.duration);
  sourcePanel.classList.remove('hidden');
  controlsPanel.classList.remove('hidden');

  // Kick off tempo detection on a downmixed clip (no transfer: we keep nothing,
  // and a structured-clone copy avoids detaching anything reused elsewhere).
  const mono = toMono(decoded);
  const analyzeReq: AnalyzeRequest = {
    type: 'analyze',
    signal: mono,
    sampleRate: decoded.sampleRate,
    maxCropSeconds: MAX_CROP_SECONDS,
  };
  worker.postMessage(analyzeReq);
}

function loadWaveform(file: File, duration: number): void {
  ws?.destroy();
  const url = URL.createObjectURL(file);
  const regions = RegionsPlugin.create();
  ws = WaveSurfer.create({
    container: '#waveform',
    height: 96,
    waveColor: '#3a4150',
    progressColor: '#7c9aff',
    cursorColor: '#e6e9ef',
    url,
    plugins: [regions],
  });

  ws.on('decode', () => {
    regions.clearRegions();
    region = regions.addRegion({
      start: 0,
      end: Math.min(duration, MAX_CROP_SECONDS),
      color: 'rgba(124, 154, 255, 0.18)',
      drag: true,
      resize: true,
    }) as unknown as RegionLike;
    updateCropInfo();
    // If tempo came back before the waveform decoded, apply the suggestion now.
    maybeApplySuggestion();
  });
  ws.on('ready', () => setupZoom(duration));
  regions.on('region-updated', (r: unknown) => {
    region = r as RegionLike;
    enforceMaxCrop();
    snapRegionLive(); // lock the selection to the bar grid as it's dragged
    updateCropInfo();
  });
  ws.on('play', () => (srcPlay.textContent = 'Pause'));
  ws.on('pause', () => (srcPlay.textContent = 'Play selection'));
  ws.on('finish', () => (srcPlay.textContent = 'Play selection'));
}

function enforceMaxCrop(): void {
  if (region && region.end - region.start > MAX_CROP_SECONDS) {
    region.end = region.start + MAX_CROP_SECONDS;
  }
}

function updateCropInfo(): void {
  if (!region) return;
  const dur = region.end - region.start;
  let bars = '';
  if (tempo) bars = `  ·  ≈ ${(dur / tempo.barLength).toFixed(1)} bars`;
  cropInfo.textContent = `${formatTime(region.start)} – ${formatTime(region.end)}  ·  ${dur.toFixed(1)}s selected${bars}`;
}

function applyRegion(start: number, end: number): void {
  if (!region) return;
  region.setOptions({ start, end });
  region.start = start;
  region.end = end;
  updateCropInfo();
}

// Live-snap the selection to the bar grid. Guarded so the setOptions call (which
// re-fires region-updated) doesn't recurse, and a no-op when nothing moves.
let snapping = false;
function snapRegionLive(): void {
  if (snapping || !snapBox.checked || !tempo || !region || !decoded) return;
  const s = snapToBars(tempo, region.start, region.end, decoded.duration, MAX_CROP_SECONDS);
  if (Math.abs(s.start - region.start) < 1e-4 && Math.abs(s.end - region.end) < 1e-4) return;
  snapping = true;
  region.setOptions({ start: s.start, end: s.end });
  region.start = s.start;
  region.end = s.end;
  snapping = false;
}

// Size the zoom slider to this clip: minimum = fit-to-width, so the whole file
// is visible zoomed out, up to a generous px/second for fine selection.
function setupZoom(duration: number): void {
  const width = waveformEl.clientWidth || 760;
  const fit = Math.max(1, Math.floor(width / Math.max(duration, 0.001)));
  zoomSlider.min = String(fit);
  zoomSlider.max = String(Math.max(fit + 1, 500));
  zoomSlider.value = String(fit);
  ws?.zoom(fit);
}

zoomSlider.addEventListener('input', () => ws?.zoom(Number(zoomSlider.value)));

function showTempoInfo(): void {
  if (!tempo) return;
  const bpm = Math.round(tempo.bpm);
  const bar = tempo.barLength.toFixed(2);
  const note = tempo.confidence < 0.12 ? '  ·  low confidence' : '';
  tempoInfo.textContent = `Detected tempo ≈ ${bpm} BPM  ·  ${tempo.beatsPerBar}/4  ·  bar ≈ ${bar}s${note}`;
}

// Apply the suggested loop once per file, as soon as both the region (waveform
// decoded) and the suggestion (tempo analysis) are available.
function maybeApplySuggestion(): void {
  if (suggestionApplied || !region || !suggestion) return;
  applyRegion(suggestion.start, suggestion.end);
  suggestionApplied = true;
}

useSuggestionBtn.addEventListener('click', () => {
  if (suggestion) applyRegion(suggestion.start, suggestion.end);
});

snapBox.addEventListener('change', () => {
  snapRegionLive(); // snap the current selection the moment snapping is enabled
  updateCropInfo();
});

srcPlay.addEventListener('click', () => {
  if (!ws) return;
  if (ws.isPlaying()) ws.pause();
  else if (region) region.play();
  else ws.play();
});

// --- File input / drag & drop ---
$('#browse').addEventListener('click', () => fileInput.click());
fileInput.addEventListener('change', () => {
  if (fileInput.files?.[0]) void handleFile(fileInput.files[0]);
});
['dragover', 'dragenter'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.add('drag');
  }),
);
['dragleave', 'drop'].forEach((ev) =>
  dropzone.addEventListener(ev, (e) => {
    e.preventDefault();
    dropzone.classList.remove('drag');
  }),
);
dropzone.addEventListener('drop', (e) => {
  const file = (e as DragEvent).dataTransfer?.files?.[0];
  if (file) void handleFile(file);
});

// --- Decompose ---
function showProgress(fraction: number, stage: string): void {
  progress.classList.remove('hidden');
  progressFill.style.width = `${Math.round(fraction * 100)}%`;
  progressLabel.textContent = `${stage}… ${Math.round(fraction * 100)}%`;
}

decomposeBtn.addEventListener('click', () => {
  if (!decoded || !region || busy) return;
  const manual = manualBox.checked;
  if (manual && percComp + harmComp < 1) {
    progressLabel.textContent = 'Pick at least one part.';
    progress.classList.remove('hidden');
    return;
  }
  const percussive: StreamConfig = manual ? { mode: 'manual', count: percComp } : { mode: 'auto' };
  const harmonic: StreamConfig = manual ? { mode: 'manual', count: harmComp } : { mode: 'auto' };

  const sr = decoded.sampleRate;
  let start = region.start;
  let end = region.end;
  let loop: LoopParams | undefined;
  let cropSamples: number;

  if (snapBox.checked && tempo) {
    const snapped = snapToBars(tempo, start, end, decoded.duration, MAX_CROP_SECONDS);
    start = snapped.start;
    end = snapped.end;
    applyRegion(start, end); // reflect the snapped window on the waveform
    const lengthSamples = Math.round((end - start) * sr);
    const crossfadeSamples = Math.min(
      Math.round(LOOP_CROSSFADE_SEC * sr),
      Math.max(0, lengthSamples - 1),
    );
    loop = { lengthSamples, crossfadeSamples };
    // Crop an extra crossfade tail so the wrap has real audio to fade against.
    cropSamples = lengthSamples + crossfadeSamples;
  } else {
    cropSamples = Math.round((end - start) * sr);
  }

  const channels = cropChannels(decoded, start, cropSamples);
  if ((channels[0]?.length ?? 0) < 2048) {
    progressLabel.textContent = 'Selection is too short.';
    progress.classList.remove('hidden');
    return;
  }

  busy = true;
  decomposeBtn.disabled = true;
  showProgress(0, 'Starting');
  const request: SeparateRequest = {
    type: 'separate',
    channels,
    sampleRate: sr,
    params: {
      fftSize: 2048,
      hop: 512,
      iterations: 80,
      percussive,
      harmonic,
      loop,
    },
  };
  worker.postMessage(request, channels.map((c) => c.buffer));
});

// Split the component at `index` into two finer parts (re-runs NMF on its audio).
function requestSplit(index: number): void {
  if (busy) return;
  const comp = components[index];
  if (!comp) return;
  busy = true;
  showProgress(0, 'Splitting');
  const request: SplitRequest = {
    type: 'split',
    id: index,
    // Copy the channels so the transfer doesn't detach our retained state.
    channels: comp.channels.map((c) => c.slice()),
    sampleRate: resultSampleRate,
    kind: comp.kind,
    count: 2,
    fftSize: 2048,
    hop: 512,
    iterations: 80,
  };
  worker.postMessage(
    request,
    request.channels.map((c) => c.buffer),
  );
}

// Combine the ticked parts into one by summing their audio (the masks already
// sum to ~1, so no re-analysis is needed). The result takes the first selected
// slot; mixing across streams yields a 'mixed' part.
function combineParts(indices: number[]): void {
  if (busy || indices.length < 2) return;
  const sorted = [...indices].sort((a, b) => a - b);
  const members = sorted.map((i) => components[i]);
  const channels = mixChannels(members.map((m) => m.channels));
  const kinds = new Set(members.map((m) => m.kind));
  const kind = kinds.size === 1 ? members[0].kind : 'mixed';

  const combined: ComponentMessage = { channels, kind, energy: rms(channels[0]) };
  const drop = new Set(sorted);
  const next: ComponentMessage[] = [];
  let inserted = false;
  components.forEach((comp, i) => {
    if (drop.has(i)) {
      if (!inserted) {
        next.push(combined);
        inserted = true;
      }
    } else {
      next.push(comp);
    }
  });
  components = next;
  engine.stop();
  renderResults();
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}

function describeParts(): string {
  const tally: Record<string, number> = { percussive: 0, harmonic: 0, mixed: 0 };
  for (const c of components) tally[c.kind] += 1;
  const bits = (['percussive', 'harmonic', 'mixed'] as const)
    .filter((k) => tally[k] > 0)
    .map((k) => `${tally[k]} ${k}`);
  const summary = bits.length ? bits.join(' · ') : 'no';
  const n = components.length;
  return `${n} part${n === 1 ? '' : 's'} (${summary}) — Split a part to go finer, or tick two and Combine.`;
}

function updateCombineButton(): void {
  combineBtn.disabled = selection.length < 2;
  combineBtn.textContent = selection.length >= 2 ? `Combine ${selection.length}` : 'Combine';
}

function renderResults(): void {
  selection = [];
  updateCombineButton();
  const buffers = components.map((c) => toAudioBuffer(c.channels, resultSampleRate));
  engine.setTracks(buffers);
  view = renderComponents(cards, components, engine, resultSampleRate, {
    onSplit: requestSplit,
    onSelectionChange: (indices) => {
      selection = indices;
      updateCombineButton();
    },
  });
  engine.onState = () => {
    view?.refreshStates();
    playAll.textContent = engine.playing ? 'Restart' : 'Play all';
  };
  resultsNote.textContent = describeParts();
  resultsPanel.classList.remove('hidden');
}

worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
  const msg = e.data;
  if (msg.type === 'progress') {
    showProgress(msg.fraction, msg.stage);
  } else if (msg.type === 'analysis') {
    tempo = msg.tempo;
    suggestion = msg.suggestion;
    showTempoInfo();
    updateCropInfo();
    useSuggestionBtn.hidden = false;
    maybeApplySuggestion();
  } else if (msg.type === 'result') {
    busy = false;
    decomposeBtn.disabled = false;
    progress.classList.add('hidden');
    components = msg.components;
    resultSampleRate = msg.sampleRate;
    renderResults();
    resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else {
    // split-result: replace the split part with its two sub-parts in place.
    busy = false;
    progress.classList.add('hidden');
    components.splice(msg.id, 1, ...msg.components);
    renderResults();
  }
};

// --- Transport ---
playAll.addEventListener('click', () => void engine.play());
stopAll.addEventListener('click', () => engine.stop());
combineBtn.addEventListener('click', () => combineParts(selection));
loopBox.addEventListener('change', () => engine.setLoop(loopBox.checked));

// Playhead animation.
function tick(): void {
  if (view) {
    const dur = engine.tracks[0]?.buffer.duration ?? 0;
    view.updatePlayheads(dur > 0 ? engine.positionSec() / dur : 0);
  }
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Keep component waveforms crisp on resize.
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => view?.redraw(), 150);
});
