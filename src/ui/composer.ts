import { stepper } from './stepper';
import type { FadeKind } from '../audio/arrangement';
import type { SelectedLoop } from './matcher';

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export interface SlotSettings {
  repeats: number;
  entrance: FadeKind;
  exit: FadeKind;
  gain: number;
}

export interface ComposerState {
  targetBpm: number;
  targetTonic: number;
  pitchMatch: boolean;
  /** Per-loop settings keyed "A:idx" / "B:idx". */
  slots: Map<string, SlotSettings>;
}

export interface ComposerLabels {
  a: string[];
  b: string[];
}

const keyOf = (l: SelectedLoop): string => `${l.source}:${l.index}`;

// Sensible defaults: lead-in (A) loops are already playing, so they hard-start
// and fade out; follow-up (B) loops fade in and hard-stop into song B.
function defaultSettings(source: 'A' | 'B'): SlotSettings {
  return source === 'A'
    ? { repeats: 4, entrance: 'hard', exit: 'fade', gain: 1 }
    : { repeats: 4, entrance: 'fade', exit: 'hard', gain: 1 };
}

function fadeToggle(value: FadeKind, onChange: (v: FadeKind) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.className = 'fade-toggle';
  (['hard', 'fade'] as FadeKind[]).forEach((kind) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `btn step${kind === value ? ' active' : ''}`;
    b.textContent = kind === 'hard' ? 'Hard' : 'Fade';
    b.addEventListener('click', () => {
      onChange(kind);
      wrap.querySelectorAll('button').forEach((x) => x.classList.remove('active'));
      b.classList.add('active');
    });
    wrap.appendChild(b);
  });
  return wrap;
}

export interface ComposerCallbacks {
  onChange: () => void;
}

// Render the transition composer: target tempo/key controls plus one row per
// selected loop (repeat count + entrance/exit envelope). Mutates the caller-owned
// `state`, pruning settings for loops that are no longer selected.
export function renderComposer(
  root: HTMLElement,
  selected: SelectedLoop[],
  labels: ComposerLabels,
  state: ComposerState,
  callbacks: ComposerCallbacks,
): void {
  // Ensure settings exist for current selection; prune stale entries.
  const live = new Set(selected.map(keyOf));
  for (const k of [...state.slots.keys()]) if (!live.has(k)) state.slots.delete(k);
  for (const loop of selected) {
    const k = keyOf(loop);
    if (!state.slots.has(k)) state.slots.set(k, defaultSettings(loop.source));
  }

  if (selected.length === 0) {
    root.innerHTML = `
      <section class="panel cross-panel">
        <h2>Build the transition</h2>
        <p class="cross-note">Tick some loops above to start building the transition.</p>
      </section>`;
    return;
  }

  const keyOptions = NOTE_NAMES.map(
    (n, i) => `<option value="${i}"${i === state.targetTonic ? ' selected' : ''}>${n}</option>`,
  ).join('');

  root.innerHTML = `
    <section class="panel cross-panel">
      <h2>Build the transition</h2>
      <div class="target-controls">
        <label class="target-field">Target tempo
          <span class="target-input"><input type="number" class="target-bpm" min="40" max="240" value="${Math.round(state.targetBpm)}" /> BPM</span>
        </label>
        <label class="target-field">Target key
          <select class="target-key">${keyOptions}</select>
        </label>
        <label class="match-key"><input type="checkbox" class="pitch-match"${state.pitchMatch ? ' checked' : ''} /> Match keys (pitch-shift)</label>
      </div>
      <div class="slot-rows"></div>
    </section>`;

  const bpmInput = root.querySelector<HTMLInputElement>('.target-bpm')!;
  bpmInput.addEventListener('change', () => {
    const v = Number(bpmInput.value);
    if (v >= 40 && v <= 240) {
      state.targetBpm = v;
      callbacks.onChange();
    }
  });
  const keySelect = root.querySelector<HTMLSelectElement>('.target-key')!;
  keySelect.addEventListener('change', () => {
    state.targetTonic = Number(keySelect.value);
    callbacks.onChange();
  });
  const matchBox = root.querySelector<HTMLInputElement>('.pitch-match')!;
  matchBox.addEventListener('change', () => {
    state.pitchMatch = matchBox.checked;
    callbacks.onChange();
  });

  const rows = root.querySelector<HTMLElement>('.slot-rows')!;
  for (const loop of selected) {
    const k = keyOf(loop);
    const settings = state.slots.get(k)!;
    const label = (loop.source === 'A' ? labels.a : labels.b)[loop.index] ?? `Loop ${loop.index + 1}`;

    const row = document.createElement('div');
    row.className = 'slot-row';
    row.innerHTML = `
      <span class="slot-name">${loop.source} · ${label}</span>
      <div class="slot-loops control"></div>
      <div class="slot-fade"><span class="fade-label">In</span></div>
      <div class="slot-fade"><span class="fade-label">Out</span></div>`;
    rows.appendChild(row);

    stepper(
      row.querySelector<HTMLElement>('.slot-loops')!,
      'Loops',
      () => settings.repeats,
      (v) => {
        settings.repeats = v;
        callbacks.onChange();
      },
      1,
      16,
    );
    row.querySelectorAll<HTMLElement>('.slot-fade')[0].appendChild(
      fadeToggle(settings.entrance, (v) => {
        settings.entrance = v;
        callbacks.onChange();
      }),
    );
    row.querySelectorAll<HTMLElement>('.slot-fade')[1].appendChild(
      fadeToggle(settings.exit, (v) => {
        settings.exit = v;
        callbacks.onChange();
      }),
    );
  }
}
