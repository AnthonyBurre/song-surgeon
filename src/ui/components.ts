import type { ComponentMessage } from '../dsp/worker';
import type { PlaybackEngine } from './playback';
import { encodeWav } from '../audio/audioUtils';

// Draw a min/max waveform of a mono signal onto a canvas, sized for crisp
// rendering on high-DPI displays.
function drawWave(canvas: HTMLCanvasElement, signal: Float32Array, color: string): void {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 600;
  const cssH = canvas.clientHeight || 64;
  canvas.width = Math.floor(cssW * dpr);
  canvas.height = Math.floor(cssH * dpr);
  const g = canvas.getContext('2d')!;
  g.scale(dpr, dpr);
  g.clearRect(0, 0, cssW, cssH);

  const mid = cssH / 2;
  const step = Math.max(1, Math.floor(signal.length / cssW));
  g.strokeStyle = color;
  g.lineWidth = 1;
  g.beginPath();
  for (let x = 0; x < cssW; x++) {
    const start = x * step;
    let min = 1;
    let max = -1;
    for (let i = 0; i < step; i++) {
      const v = signal[start + i] ?? 0;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    g.moveTo(x + 0.5, mid - max * mid * 0.95);
    g.lineTo(x + 0.5, mid - min * mid * 0.95);
  }
  g.stroke();
}

export interface ComponentView {
  refreshStates(): void;
  updatePlayheads(fraction: number): void;
  redraw(): void;
}

export interface ComponentCallbacks {
  onSplit: (index: number) => void;
  /** Called with the sorted indices of cards ticked for combining. */
  onSelectionChange: (indices: number[]) => void;
}

const KIND_META = {
  percussive: { word: 'Percussive', tag: 'P', cls: 'kind-perc', color: '#ff8a5c' },
  harmonic: { word: 'Harmonic', tag: 'H', cls: 'kind-harm', color: '#5cc8ff' },
  mixed: { word: 'Mixed', tag: 'M', cls: 'kind-mixed', color: '#7c9aff' },
} as const;

export function renderComponents(
  root: HTMLElement,
  components: ComponentMessage[],
  engine: PlaybackEngine,
  sampleRate: number,
  callbacks: ComponentCallbacks,
): ComponentView {
  root.innerHTML = '';
  const canvases: HTMLCanvasElement[] = [];
  const playheads: HTMLElement[] = [];
  const soloButtons: HTMLButtonElement[] = [];
  const muteButtons: HTMLButtonElement[] = [];

  const counts: Record<string, number> = { percussive: 0, harmonic: 0, mixed: 0 };
  const selected = new Set<number>();
  const emitSelection = () =>
    callbacks.onSelectionChange([...selected].sort((a, b) => a - b));

  components.forEach((comp, i) => {
    const meta = KIND_META[comp.kind];
    counts[comp.kind] += 1;
    const n = counts[comp.kind];
    const label = `${meta.word} ${n}`;
    // A detected key for tonal parts; analyzePitch already collapses unpitched /
    // low-confidence results to "—", so anything else is worth showing.
    const key = comp.pitch && comp.pitch.name !== '—' ? comp.pitch.name : '';

    const card = document.createElement('div');
    card.className = `card ${meta.cls}`;
    card.innerHTML = `
      <div class="card-head">
        <input class="select" type="checkbox" title="Select to combine" />
        <span class="badge">${meta.tag}${n}</span>
        <span class="label">${label}</span>
        ${key ? `<span class="pitch" title="Estimated key">${key}</span>` : ''}
        <div class="card-actions">
          <button class="btn solo" type="button">Solo</button>
          <button class="btn mute" type="button">Mute</button>
          <button class="btn split" type="button" title="Break this part into two">Split</button>
          <button class="btn ghost dl" type="button">Download</button>
        </div>
      </div>
      <div class="wave-wrap">
        <canvas class="wave"></canvas>
        <div class="playhead"></div>
      </div>`;
    root.appendChild(card);

    const canvas = card.querySelector<HTMLCanvasElement>('canvas.wave')!;
    const playhead = card.querySelector<HTMLElement>('.playhead')!;
    const selectBox = card.querySelector<HTMLInputElement>('.select')!;
    const solo = card.querySelector<HTMLButtonElement>('.solo')!;
    const mute = card.querySelector<HTMLButtonElement>('.mute')!;
    const split = card.querySelector<HTMLButtonElement>('.split')!;
    const dl = card.querySelector<HTMLButtonElement>('.dl')!;

    canvases.push(canvas);
    playheads.push(playhead);
    soloButtons.push(solo);
    muteButtons.push(mute);

    drawWave(canvas, comp.channels[0], meta.color);

    selectBox.addEventListener('change', () => {
      if (selectBox.checked) selected.add(i);
      else selected.delete(i);
      card.classList.toggle('selected', selectBox.checked);
      emitSelection();
    });
    solo.addEventListener('click', () => engine.toggleSolo(i));
    mute.addEventListener('click', () => engine.toggleMute(i));
    split.addEventListener('click', () => callbacks.onSplit(i));
    dl.addEventListener('click', () => {
      const blob = encodeWav(comp.channels, sampleRate);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${label.replace(/\s+/g, '-').toLowerCase()}.wav`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
  });

  emitSelection();

  const refreshStates = () => {
    engine.tracks.forEach((t, i) => {
      soloButtons[i].classList.toggle('active', t.solo);
      muteButtons[i].classList.toggle('active', t.mute);
    });
  };

  const updatePlayheads = (fraction: number) => {
    const pct = `${Math.min(100, Math.max(0, fraction * 100))}%`;
    const visible = engine.playing ? 'block' : 'none';
    for (const ph of playheads) {
      ph.style.left = pct;
      ph.style.display = visible;
    }
  };

  const redraw = () => {
    components.forEach((comp, i) => {
      drawWave(canvases[i], comp.channels[0], KIND_META[comp.kind].color);
    });
  };

  refreshStates();
  return { refreshStates, updatePlayheads, redraw };
}
