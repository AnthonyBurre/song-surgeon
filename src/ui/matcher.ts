import type { ComponentMessage } from '../dsp/worker';
import type { MatchResult } from '../dsp/match';
import { KIND_META } from './components';
import { encodeWav } from '../audio/audioUtils';

export interface MatcherDeckData {
  components: ComponentMessage[];
  sampleRate: number;
  labels: string[];
}

export interface SelectedLoop {
  source: 'A' | 'B';
  index: number;
}

export interface MatcherCallbacks {
  /** Fired with every loop currently ticked for the transition. */
  onSelectionChange: (loops: SelectedLoop[]) => void;
}

const keyOf = (l: SelectedLoop): string => `${l.source}:${l.index}`;

function pitchLabel(comp: ComponentMessage): string {
  return comp.pitch && comp.pitch.name !== '—' ? comp.pitch.name : '';
}

// Render a single selectable loop "chip" (checkbox + label + key + download) and
// wire it into the shared selection set.
function loopChip(
  source: 'A' | 'B',
  index: number,
  comp: ComponentMessage,
  label: string,
  sampleRate: number,
  selected: Set<string>,
  emit: () => void,
): HTMLElement {
  const meta = KIND_META[comp.kind];
  const key = pitchLabel(comp);
  const chip = document.createElement('label');
  chip.className = `loop-chip ${meta.cls}`;
  chip.innerHTML = `
    <input class="loop-select" type="checkbox" />
    <span class="badge">${meta.tag}</span>
    <span class="chip-label">${source} · ${label}</span>
    ${key ? `<span class="pitch">${key}</span>` : ''}
    <button class="btn ghost chip-dl" type="button" title="Download this loop">⤓</button>`;

  const box = chip.querySelector<HTMLInputElement>('.loop-select')!;
  const id = keyOf({ source, index });
  box.checked = selected.has(id);
  chip.classList.toggle('selected', box.checked);
  box.addEventListener('change', () => {
    if (box.checked) selected.add(id);
    else selected.delete(id);
    chip.classList.toggle('selected', box.checked);
    emit();
  });

  chip.querySelector<HTMLButtonElement>('.chip-dl')!.addEventListener('click', (e) => {
    e.preventDefault();
    const blob = encodeWav(comp.channels, sampleRate);
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${source}-${label}`.replace(/\s+/g, '-').toLowerCase() + '.wav';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return chip;
}

export interface MatcherView {
  /** Loops currently ticked for the transition. */
  getSelection(): SelectedLoop[];
}

// Render the analogue-matching panel: suggested A↔B pairs plus any unpaired
// loops, each individually selectable for the transition. Selection persists
// across re-renders via the caller-owned `selected` set.
export function renderMatcher(
  root: HTMLElement,
  a: MatcherDeckData,
  b: MatcherDeckData,
  match: MatchResult,
  selected: Set<string>,
  callbacks: MatcherCallbacks,
): MatcherView {
  // Drop selections that no longer point at a real loop (e.g. after a re-split).
  for (const id of [...selected]) {
    const [src, idxStr] = id.split(':');
    const idx = Number(idxStr);
    const list = src === 'A' ? a.components : b.components;
    if (idx >= list.length) selected.delete(id);
  }

  const collect = (): SelectedLoop[] =>
    [...selected].map((id) => {
      const [source, idx] = id.split(':');
      return { source: source as 'A' | 'B', index: Number(idx) };
    });
  const emit = () => callbacks.onSelectionChange(collect());

  root.innerHTML = `
    <section class="panel cross-panel">
      <h2>Line up the loops</h2>
      <p class="cross-note">Tick the loops you want in the transition. Suggested analogues are
        paired by similarity; loops with no counterpart are listed below.</p>
      <div class="match-pairs"></div>
      <div class="match-unpaired"></div>
    </section>`;
  const pairsEl = root.querySelector<HTMLElement>('.match-pairs')!;
  const unpairedEl = root.querySelector<HTMLElement>('.match-unpaired')!;

  for (const pair of match.pairs) {
    const row = document.createElement('div');
    row.className = 'pair-row';
    const left = loopChip('A', pair.a, a.components[pair.a], a.labels[pair.a], a.sampleRate, selected, emit);
    const right = loopChip('B', pair.b, b.components[pair.b], b.labels[pair.b], b.sampleRate, selected, emit);
    const sim = document.createElement('span');
    sim.className = 'sim';
    sim.textContent = `↔ ${Math.round(pair.similarity * 100)}%`;
    sim.title = `${pair.basis} similarity`;
    row.append(left, sim, right);
    pairsEl.appendChild(row);
  }

  const unpaired: HTMLElement[] = [];
  for (const i of match.unpairedA) {
    unpaired.push(loopChip('A', i, a.components[i], a.labels[i], a.sampleRate, selected, emit));
  }
  for (const i of match.unpairedB) {
    unpaired.push(loopChip('B', i, b.components[i], b.labels[i], b.sampleRate, selected, emit));
  }
  if (unpaired.length) {
    const head = document.createElement('p');
    head.className = 'unpaired-head';
    head.textContent = 'No analogue';
    unpairedEl.append(head, ...unpaired);
  }

  emit();
  return { getSelection: collect };
}
