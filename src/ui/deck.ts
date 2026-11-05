import WaveSurfer from 'wavesurfer.js';
import RegionsPlugin from 'wavesurfer.js/dist/plugins/regions.esm.js';

import {
  decodeFile,
  toMono,
  cropChannels,
  toAudioBuffer,
  mixChannels,
  formatTime,
} from '../audio/audioUtils';
import { PlaybackEngine } from './playback';
import { renderComponents, type ComponentView } from './components';
import { renderOptions } from './options';
import { snapToBars, type TempoResult, type CropSuggestion } from '../dsp/tempo';
import { analyzePitch } from '../dsp/pitch';
import type { LoopParams } from '../dsp/separate';
import type { AnalyzeRequest, WorkerMessage } from '../dsp/worker';
import { BuiltinEngine } from '../engine/builtin';
import { finishParts } from '../engine/finish';
import { defaultOptions, type OptionValues, type Part, type SeparationEngine } from '../engine/types';

// Starting selection length, and the longest loop the tempo pass suggests. The
// actual cap on a selection comes from the current engine (`maxCrop`).
const DEFAULT_CROP_SECONDS = 20;
// Wrap-around crossfade applied when trimming components to whole bars.
const LOOP_CROSSFADE_SEC = 0.012;

interface RegionLike {
  start: number;
  end: number;
  play: () => void;
  setOptions: (o: { start?: number; end?: number }) => void;
}

export interface DeckOptions {
  /** Stable identifier ('A' = lead-in, 'B' = follow-up). */
  id: 'A' | 'B';
  title: string;
  subtitle: string;
  /** Fired whenever this deck's components / tempo / crop change. */
  onChange?: () => void;
}

// One self-contained song pipeline: load → crop (waveform + tempo) → decompose →
// solo/loop/combine/download the resulting loops. Everything is scoped to the
// deck's root element so two decks can coexist without colliding on IDs.
export class Deck {
  readonly id: 'A' | 'B';
  private onChange?: () => void;

  // --- State ---
  decoded: AudioBuffer | null = null;
  region: RegionLike | null = null;
  tempo: TempoResult | null = null;
  components: Part[] = [];
  resultSampleRate = 44100;

  private ws: WaveSurfer | null = null;
  private suggestion: CropSuggestion | null = null;
  private suggestionApplied = false;
  private selection: number[] = []; // card indices ticked for combining
  private busy = false; // a decompose or split is running
  private job: AbortController | null = null; // cancels the running decompose/split
  private snapping = false; // guards recursive snap-on-region-update

  private engine = new PlaybackEngine();
  private view: ComponentView | null = null;
  // Tempo analysis stays on its own worker; separation goes through an engine.
  // The built-in engine is always first; server engines are added once discovered.
  private worker: Worker;
  private separators: SeparationEngine[] = [new BuiltinEngine()];
  private separator = this.separators[0];
  private separatorOptions: OptionValues = defaultOptions(this.separator.info);

  // --- Element refs ---
  private els: {
    dropzone: HTMLElement;
    fileInput: HTMLInputElement;
    browse: HTMLButtonElement;
    sourcePanel: HTMLElement;
    controlsPanel: HTMLElement;
    resultsPanel: HTMLElement;
    waveform: HTMLElement;
    zoom: HTMLInputElement;
    snapBox: HTMLInputElement;
    srcPlay: HTMLButtonElement;
    cropInfo: HTMLElement;
    tempoInfo: HTMLElement;
    useSuggestion: HTMLButtonElement;
    advancedToggle: HTMLButtonElement;
    advanced: HTMLElement;
    engineOptions: HTMLElement;
    enginePick: HTMLElement;
    engineSelect: HTMLSelectElement;
    engineDesc: HTMLElement;
    decompose: HTMLButtonElement;
    progress: HTMLElement;
    progressFill: HTMLElement;
    progressLabel: HTMLElement;
    cancel: HTMLButtonElement;
    playAll: HTMLButtonElement;
    stopAll: HTMLButtonElement;
    combine: HTMLButtonElement;
    loopBox: HTMLInputElement;
    resultsNote: HTMLElement;
    cards: HTMLElement;
  };

  constructor(root: HTMLElement, opts: DeckOptions) {
    this.id = opts.id;
    this.onChange = opts.onChange;
    this.worker = new Worker(new URL('../dsp/worker.ts', import.meta.url), { type: 'module' });

    root.innerHTML = `
      <div class="deck">
        <header class="deck-head">
          <h2 class="deck-title">${opts.title}</h2>
          <p class="deck-sub">${opts.subtitle}</p>
        </header>

        <section class="dropzone">
          <input type="file" class="file" accept="audio/*" hidden />
          <p class="drop-main">Drop an audio file here, or <button class="link browse" type="button">browse</button></p>
          <p class="hint"></p>
        </section>

        <section class="panel source hidden">
          <h3>1 · Crop the segment</h3>
          <div class="waveform"></div>
          <div class="row waveform-tools">
            <label class="zoom"><span>Zoom</span><input type="range" class="zoom-range" min="1" max="500" value="1" /></label>
            <label class="snap"><input type="checkbox" class="snap-bars" checked /> Snap to whole bars</label>
          </div>
          <div class="row">
            <button class="btn src-play" type="button">Play selection</button>
            <span class="crop-info"></span>
          </div>
          <div class="row tempo-row">
            <span class="tempo-info">Detecting tempo…</span>
            <button class="btn ghost use-suggestion" type="button" hidden>Use suggested loop</button>
          </div>
        </section>

        <section class="panel controls hidden">
          <h3>2 · Choose the breakdown</h3>
          <label class="control engine-pick hidden">
            <span class="control-label">Engine</span>
            <select class="option-input engine-select"></select>
          </label>
          <p class="auto-note"><span class="engine-desc"></span>
            <button class="link advanced-toggle" type="button">Advanced</button></p>
          <div class="advanced hidden">
            <div class="control-grid engine-options"></div>
          </div>
          <button class="btn primary decompose" type="button">Decompose</button>
          <div class="progress hidden">
            <div class="bar"><div class="fill"></div></div>
            <span class="progress-label"></span>
            <button class="btn ghost cancel hidden" type="button">Cancel</button>
          </div>
        </section>

        <section class="panel results hidden">
          <h3>3 · Solo the loops</h3>
          <div class="transport">
            <button class="btn primary play-all" type="button">Play all</button>
            <button class="btn stop-all" type="button">Stop</button>
            <button class="btn combine" type="button" disabled>Combine</button>
            <label class="loop"><input type="checkbox" class="loop-box" checked /> Loop</label>
          </div>
          <p class="results-note"></p>
          <div class="cards"></div>
        </section>
      </div>`;

    const q = <T extends HTMLElement>(sel: string) => root.querySelector<T>(sel)!;
    this.els = {
      dropzone: q('.dropzone'),
      fileInput: q<HTMLInputElement>('.file'),
      browse: q<HTMLButtonElement>('.browse'),
      sourcePanel: q('.source'),
      controlsPanel: q('.controls'),
      resultsPanel: q('.results'),
      waveform: q('.waveform'),
      zoom: q<HTMLInputElement>('.zoom-range'),
      snapBox: q<HTMLInputElement>('.snap-bars'),
      srcPlay: q<HTMLButtonElement>('.src-play'),
      cropInfo: q('.crop-info'),
      tempoInfo: q('.tempo-info'),
      useSuggestion: q<HTMLButtonElement>('.use-suggestion'),
      advancedToggle: q<HTMLButtonElement>('.advanced-toggle'),
      advanced: q('.advanced'),
      engineOptions: q('.engine-options'),
      enginePick: q('.engine-pick'),
      engineSelect: q<HTMLSelectElement>('.engine-select'),
      engineDesc: q('.engine-desc'),
      decompose: q<HTMLButtonElement>('.decompose'),
      progress: q('.progress'),
      progressFill: q('.fill'),
      progressLabel: q('.progress-label'),
      cancel: q<HTMLButtonElement>('.cancel'),
      playAll: q<HTMLButtonElement>('.play-all'),
      stopAll: q<HTMLButtonElement>('.stop-all'),
      combine: q<HTMLButtonElement>('.combine'),
      loopBox: q<HTMLInputElement>('.loop-box'),
      resultsNote: q('.results-note'),
      cards: q('.cards'),
    };

    this.wireEvents();
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => this.onWorkerMessage(e.data);
    requestAnimationFrame(this.tick);
  }

  // --- Public accessors for the orchestrator ---
  get sampleRate(): number {
    return this.decoded?.sampleRate ?? 44100;
  }
  /** The current crop window in seconds, or null before a file is loaded. */
  get crop(): { start: number; end: number } | null {
    return this.region ? { start: this.region.start, end: this.region.end } : null;
  }
  get hasComponents(): boolean {
    return this.components.length > 0;
  }
  /** Detected tempo in BPM, or a neutral default before analysis. */
  get bpm(): number {
    return this.tempo?.bpm ?? 120;
  }
  /** Representative key tonic (0–11) from the most energetic tonal loop, or null. */
  get tonic(): number | null {
    let best: { energy: number; tonic: number } | null = null;
    for (const c of this.components) {
      if (c.pitch && c.pitch.name !== '—' && (!best || c.energy > best.energy)) {
        best = { energy: c.energy, tonic: c.pitch.tonic };
      }
    }
    return best ? best.tonic : null;
  }

  private wireEvents(): void {
    const e = this.els;

    this.useEngine(this.separator);
    e.engineSelect.addEventListener('change', () => {
      const next = this.separators.find((s) => s.info.id === e.engineSelect.value);
      if (next) this.useEngine(next);
    });

    e.advancedToggle.addEventListener('click', () => {
      const hidden = e.advanced.classList.toggle('hidden');
      e.advancedToggle.textContent = hidden ? 'Advanced' : 'Hide advanced';
    });

    e.browse.addEventListener('click', () => e.fileInput.click());
    e.fileInput.addEventListener('change', () => {
      if (e.fileInput.files?.[0]) void this.handleFile(e.fileInput.files[0]);
    });
    ['dragover', 'dragenter'].forEach((ev) =>
      e.dropzone.addEventListener(ev, (event) => {
        event.preventDefault();
        e.dropzone.classList.add('drag');
      }),
    );
    ['dragleave', 'drop'].forEach((ev) =>
      e.dropzone.addEventListener(ev, (event) => {
        event.preventDefault();
        e.dropzone.classList.remove('drag');
      }),
    );
    e.dropzone.addEventListener('drop', (event) => {
      const file = (event as DragEvent).dataTransfer?.files?.[0];
      if (file) void this.handleFile(file);
    });

    e.zoom.addEventListener('input', () => this.ws?.zoom(Number(e.zoom.value)));
    e.snapBox.addEventListener('change', () => {
      this.snapRegionLive();
      this.updateCropInfo();
    });
    e.useSuggestion.addEventListener('click', () => {
      if (this.suggestion) this.applyRegion(this.suggestion.start, this.suggestion.end);
    });
    e.srcPlay.addEventListener('click', () => {
      if (!this.ws) return;
      if (this.ws.isPlaying()) this.ws.pause();
      else if (this.region) this.region.play();
      else this.ws.play();
    });

    e.decompose.addEventListener('click', () => void this.decompose());
    e.cancel.addEventListener('click', () => this.job?.abort());
    e.playAll.addEventListener('click', () => void this.engine.play());
    e.stopAll.addEventListener('click', () => this.engine.stop());
    e.combine.addEventListener('click', () => this.combineParts(this.selection));
    e.loopBox.addEventListener('change', () => this.engine.setLoop(e.loopBox.checked));
  }

  // --- Engines ---
  /** Offer more separation engines (e.g. from a local server); shows the picker. */
  addEngines(engines: SeparationEngine[]): void {
    if (engines.length === 0) return;
    this.separators.push(...engines);
    this.els.engineSelect.replaceChildren(...this.separators.map((s) => new Option(s.info.name, s.info.id)));
    this.els.engineSelect.value = this.separator.info.id;
    this.els.enginePick.classList.remove('hidden');
  }

  private useEngine(engine: SeparationEngine): void {
    this.separator = engine;
    this.separatorOptions = defaultOptions(engine.info);
    this.els.engineDesc.textContent = engine.info.description ?? '';
    renderOptions(this.els.engineOptions, engine.info.options, this.separatorOptions);
    this.updateHint();
    // Switching to an engine with a smaller cap trims the selection to fit.
    if (this.region && this.region.end - this.region.start > this.maxCrop) {
      this.applyRegion(this.region.start, this.region.start + this.maxCrop);
      this.snapRegionLive();
      this.updateCropInfo();
    }
  }

  /** Longest selection the current engine accepts, in seconds. */
  private get maxCrop(): number {
    return this.separator.info.maxSeconds ?? Infinity;
  }

  private updateHint(): void {
    const hint = this.els.dropzone.querySelector('.hint');
    if (!hint) return;
    const cap = this.maxCrop;
    const limit = !Number.isFinite(cap) ? '' : ` Selections are capped at ${cap >= 60 ? `${cap / 60} min` : `${cap}s`}.`;
    hint.textContent = `Works best on short, loop-based segments.${limit}`;
  }

  /** Splitting re-runs on one part's audio, so any engine that supports it will do. */
  private get splitter(): SeparationEngine | undefined {
    return this.separators.find((s) => s.info.canSplit && s.split);
  }

  // --- Source loading ---
  private async handleFile(file: File): Promise<void> {
    this.engine.stop();
    this.els.resultsPanel.classList.add('hidden');
    this.components = [];
    this.tempo = null;
    this.suggestion = null;
    this.suggestionApplied = false;
    this.els.useSuggestion.hidden = true;
    this.els.tempoInfo.textContent = 'Detecting tempo…';

    const hint = this.els.dropzone.querySelector('.hint');
    try {
      this.decoded = await decodeFile(file);
    } catch {
      if (hint) hint.textContent = `Couldn't decode "${file.name}". Try a WAV, MP3, or FLAC file.`;
      this.els.dropzone.classList.add('error');
      this.onChange?.(); // components were cleared above — let the cross panels update
      return;
    }
    this.els.dropzone.classList.remove('error');
    this.updateHint();
    this.loadWaveform(file, this.decoded.duration);
    this.els.sourcePanel.classList.remove('hidden');
    this.els.controlsPanel.classList.remove('hidden');

    const mono = toMono(this.decoded);
    const analyzeReq: AnalyzeRequest = {
      type: 'analyze',
      signal: mono,
      sampleRate: this.decoded.sampleRate,
      maxCropSeconds: DEFAULT_CROP_SECONDS,
    };
    this.worker.postMessage(analyzeReq);
    this.onChange?.();
  }

  private loadWaveform(file: File, duration: number): void {
    this.ws?.destroy();
    const url = URL.createObjectURL(file);
    const regions = RegionsPlugin.create();
    this.ws = WaveSurfer.create({
      container: this.els.waveform,
      height: 96,
      waveColor: '#3a4150',
      progressColor: '#7c9aff',
      cursorColor: '#e6e9ef',
      url,
      plugins: [regions],
    });

    this.ws.on('decode', () => {
      regions.clearRegions();
      this.region = regions.addRegion({
        start: 0,
        end: Math.min(duration, DEFAULT_CROP_SECONDS, this.maxCrop),
        color: 'rgba(124, 154, 255, 0.18)',
        drag: true,
        resize: true,
      }) as unknown as RegionLike;
      this.updateCropInfo();
      this.maybeApplySuggestion();
    });
    this.ws.on('ready', () => this.setupZoom(duration));
    regions.on('region-updated', (r: unknown) => {
      this.region = r as RegionLike;
      this.enforceMaxCrop();
      this.snapRegionLive();
      this.updateCropInfo();
    });
    this.ws.on('play', () => (this.els.srcPlay.textContent = 'Pause'));
    this.ws.on('pause', () => (this.els.srcPlay.textContent = 'Play selection'));
    this.ws.on('finish', () => (this.els.srcPlay.textContent = 'Play selection'));
  }

  private enforceMaxCrop(): void {
    if (this.region && this.region.end - this.region.start > this.maxCrop) {
      this.region.end = this.region.start + this.maxCrop;
    }
  }

  private updateCropInfo(): void {
    if (!this.region) return;
    const dur = this.region.end - this.region.start;
    let bars = '';
    if (this.tempo) bars = `  ·  ≈ ${(dur / this.tempo.barLength).toFixed(1)} bars`;
    this.els.cropInfo.textContent = `${formatTime(this.region.start)} – ${formatTime(this.region.end)}  ·  ${dur.toFixed(1)}s selected${bars}`;
    this.onChange?.();
  }

  private applyRegion(start: number, end: number): void {
    if (!this.region) return;
    this.region.setOptions({ start, end });
    this.region.start = start;
    this.region.end = end;
    this.updateCropInfo();
  }

  private snapRegionLive(): void {
    if (this.snapping || !this.els.snapBox.checked || !this.tempo || !this.region || !this.decoded)
      return;
    const s = snapToBars(
      this.tempo,
      this.region.start,
      this.region.end,
      this.decoded.duration,
      this.maxCrop,
    );
    if (Math.abs(s.start - this.region.start) < 1e-4 && Math.abs(s.end - this.region.end) < 1e-4)
      return;
    this.snapping = true;
    this.region.setOptions({ start: s.start, end: s.end });
    this.region.start = s.start;
    this.region.end = s.end;
    this.snapping = false;
  }

  private setupZoom(duration: number): void {
    const width = this.els.waveform.clientWidth || 760;
    const fit = Math.max(1, Math.floor(width / Math.max(duration, 0.001)));
    this.els.zoom.min = String(fit);
    this.els.zoom.max = String(Math.max(fit + 1, 500));
    this.els.zoom.value = String(fit);
    this.ws?.zoom(fit);
  }

  private showTempoInfo(): void {
    if (!this.tempo) return;
    const bpm = Math.round(this.tempo.bpm);
    const bar = this.tempo.barLength.toFixed(2);
    const note = this.tempo.confidence < 0.12 ? '  ·  low confidence' : '';
    this.els.tempoInfo.textContent = `Detected tempo ≈ ${bpm} BPM  ·  ${this.tempo.beatsPerBar}/4  ·  bar ≈ ${bar}s${note}`;
  }

  private maybeApplySuggestion(): void {
    if (this.suggestionApplied || !this.region || !this.suggestion) return;
    this.applyRegion(this.suggestion.start, this.suggestion.end);
    this.suggestionApplied = true;
  }

  // --- Decompose ---
  private showProgress(fraction: number, stage: string): void {
    this.els.progress.classList.remove('hidden');
    this.els.progressFill.style.width = `${Math.round(fraction * 100)}%`;
    this.els.progressLabel.textContent = `${stage}… ${Math.round(fraction * 100)}%`;
  }

  private showMessage(text: string): void {
    this.els.progressFill.style.width = '0%';
    this.els.progressLabel.textContent = text;
    this.els.progress.classList.remove('hidden');
  }

  // Mark a decompose/split as running; the returned signal fires on Cancel.
  private startJob(stage: string): AbortSignal {
    this.busy = true;
    this.job = new AbortController();
    this.els.decompose.disabled = true;
    this.els.cancel.classList.remove('hidden');
    this.showProgress(0, stage);
    return this.job.signal;
  }

  private endJob(): void {
    this.busy = false;
    this.job = null;
    this.els.decompose.disabled = false;
    this.els.cancel.classList.add('hidden');
  }

  private showJobError(err: unknown, what: string): void {
    // Engines reject with the signal's AbortError when the user cancels.
    if (err instanceof DOMException && err.name === 'AbortError') this.showMessage(`${what} cancelled.`);
    else this.showMessage(`${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  private async decompose(): Promise<void> {
    if (!this.decoded || !this.region || this.busy) return;

    const sr = this.decoded.sampleRate;
    let start = this.region.start;
    let end = this.region.end;
    let loop: LoopParams | undefined;
    let cropSamples: number;

    if (this.els.snapBox.checked && this.tempo) {
      const snapped = snapToBars(this.tempo, start, end, this.decoded.duration, this.maxCrop);
      start = snapped.start;
      end = snapped.end;
      this.applyRegion(start, end);
      const lengthSamples = Math.round((end - start) * sr);
      const crossfadeSamples = Math.min(
        Math.round(LOOP_CROSSFADE_SEC * sr),
        Math.max(0, lengthSamples - 1),
      );
      loop = { lengthSamples, crossfadeSamples };
      cropSamples = lengthSamples + crossfadeSamples;
    } else {
      cropSamples = Math.round((end - start) * sr);
    }

    const channels = cropChannels(this.decoded, start, cropSamples);
    if ((channels[0]?.length ?? 0) < 2048) {
      this.showMessage('Selection is too short.');
      return;
    }

    const signal = this.startJob('Starting');
    try {
      const raw = await this.separator.separate(
        { channels, sampleRate: sr, options: this.separatorOptions },
        { onProgress: (f, stage) => this.showProgress(f, stage), signal },
      );
      const result = finishParts(raw, loop);
      if (result.parts.length === 0) {
        this.showMessage('No parts were produced. Pick at least one part under Advanced.');
        return;
      }
      this.els.progress.classList.add('hidden');
      this.components = result.parts;
      this.resultSampleRate = result.sampleRate;
      this.renderResults();
      this.els.resultsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      this.showJobError(err, 'Separation');
    } finally {
      this.endJob();
    }
  }

  private async requestSplit(index: number): Promise<void> {
    const splitter = this.splitter;
    if (this.busy || !splitter?.split) return;
    const comp = this.components[index];
    if (!comp) return;
    const signal = this.startJob('Splitting');
    try {
      const raw = await splitter.split(
        { channels: comp.channels, sampleRate: this.resultSampleRate, kind: comp.kind, count: 2 },
        { onProgress: (f, stage) => this.showProgress(f, stage), signal },
      );
      // The parent was already loop-trimmed, so its sub-parts need no trim.
      const result = finishParts(raw);
      this.els.progress.classList.add('hidden');
      // Sub-parts keep the parent's name ("Drums" → "Drums 1", "Drums 2").
      const parts = result.parts.map((p) => ({ ...p, label: comp.label }));
      this.components.splice(index, 1, ...parts);
      this.renderResults();
    } catch (err) {
      this.showJobError(err, 'Split');
    } finally {
      this.endJob();
    }
  }

  private combineParts(indices: number[]): void {
    if (this.busy || indices.length < 2) return;
    const sorted = [...indices].sort((a, b) => a - b);
    const members = sorted.map((i) => this.components[i]);
    const channels = mixChannels(members.map((m) => m.channels));
    const kinds = new Set(members.map((m) => m.kind));
    const kind = kinds.size === 1 ? members[0].kind : 'mixed';

    const pitch = kind === 'percussive' ? undefined : analyzePitch(channels[0], this.resultSampleRate);
    const names = [...new Set(members.map((m) => m.label))];
    const label = names.join(' + ');
    const combined: Part = { channels, kind, label, energy: rms(channels[0]), pitch };
    const drop = new Set(sorted);
    const next: Part[] = [];
    let inserted = false;
    this.components.forEach((comp, i) => {
      if (drop.has(i)) {
        if (!inserted) {
          next.push(combined);
          inserted = true;
        }
      } else {
        next.push(comp);
      }
    });
    this.components = next;
    this.engine.stop();
    this.renderResults();
  }

  private describeParts(): string {
    const tally: Record<string, number> = { percussive: 0, harmonic: 0, mixed: 0 };
    for (const c of this.components) tally[c.kind] += 1;
    const bits = (['percussive', 'harmonic', 'mixed'] as const)
      .filter((k) => tally[k] > 0)
      .map((k) => `${tally[k]} ${k}`);
    const summary = bits.length ? bits.join(' · ') : 'no';
    const n = this.components.length;
    return `${n} part${n === 1 ? '' : 's'} (${summary}) — Split a part to go finer, or tick two and Combine.`;
  }

  private updateCombineButton(): void {
    this.els.combine.disabled = this.selection.length < 2;
    this.els.combine.textContent = this.selection.length >= 2 ? `Combine ${this.selection.length}` : 'Combine';
  }

  private renderResults(): void {
    this.selection = [];
    this.updateCombineButton();
    const buffers = this.components.map((c) => toAudioBuffer(c.channels, this.resultSampleRate));
    this.engine.setTracks(buffers);
    this.view = renderComponents(this.els.cards, this.components, this.engine, this.resultSampleRate, {
      onSplit: this.splitter ? (index) => void this.requestSplit(index) : undefined,
      onSelectionChange: (indices) => {
        this.selection = indices;
        this.updateCombineButton();
      },
    });
    this.engine.onState = () => {
      this.view?.refreshStates();
      this.els.playAll.textContent = this.engine.playing ? 'Restart' : 'Play all';
    };
    this.els.resultsNote.textContent = this.describeParts();
    this.els.resultsPanel.classList.remove('hidden');
    this.onChange?.();
  }

  private onWorkerMessage(msg: WorkerMessage): void {
    if (msg.type === 'progress') {
      this.showProgress(msg.fraction, msg.stage);
    } else if (msg.type === 'analysis') {
      this.tempo = msg.tempo;
      this.suggestion = msg.suggestion;
      this.showTempoInfo();
      this.updateCropInfo();
      this.els.useSuggestion.hidden = false;
      this.maybeApplySuggestion();
    }
  }

  // Playhead animation for this deck's component cards.
  private tick = (): void => {
    if (this.view) {
      const dur = this.engine.tracks[0]?.buffer.duration ?? 0;
      this.view.updatePlayheads(dur > 0 ? this.engine.positionSec() / dur : 0);
    }
    requestAnimationFrame(this.tick);
  };

  redraw(): void {
    this.view?.redraw();
  }
}

function rms(x: Float32Array): number {
  let s = 0;
  for (let i = 0; i < x.length; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, x.length));
}
