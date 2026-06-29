import './style.css';
import { Deck } from './ui/deck';
import { renderMatcher, type SelectedLoop } from './ui/matcher';
import { renderComposer, type ComposerState } from './ui/composer';
import { renderMaster, type MasterView, type CompositionMode } from './ui/master';
import { componentLabels } from './ui/components';
import { matchComponents } from './dsp/match';
import { semitoneDistance } from './dsp/stretch';
import { renderComposition, type RenderPlan, type RenderSlot } from './audio/arrangement';
import { ConformService } from './audio/conform';
import { audioContext, cropChannels, encodeWav } from './audio/audioUtils';
import type { ComponentMessage } from './dsp/worker';

const app = document.querySelector<HTMLDivElement>('#app')!;
app.innerHTML = `
  <header class="masthead">
    <h1>Song Surgeon</h1>
    <p class="tagline">Stitch two tracks together. Crop and decompose a portion of each song,
      line up their loops, and build a transition you can play and download.</p>
  </header>

  <div class="decks">
    <div class="deck-host" id="deck-a"></div>
    <div class="deck-host" id="deck-b"></div>
  </div>

  <div class="cross" id="cross"></div>
`;

const cross = document.querySelector<HTMLElement>('#cross')!;

const deckA = new Deck(document.querySelector<HTMLElement>('#deck-a')!, {
  id: 'A',
  title: 'Lead-in song',
  subtitle: 'Plays first — crop the part you want to transition out of.',
  onChange: refreshCrossSong,
});
const deckB = new Deck(document.querySelector<HTMLElement>('#deck-b')!, {
  id: 'B',
  title: 'Follow-up song',
  subtitle: 'Plays second — crop the part you want to transition into.',
  onChange: refreshCrossSong,
});

// --- Cross-song state ---
const conformer = new ConformService();
const selectedLoops = new Set<string>(); // matcher selection, keyed "A:idx"
let selection: SelectedLoop[] = [];
const composerState: ComposerState = { targetBpm: 120, targetTonic: 0, pitchMatch: true, slots: new Map() };
let compositionMode: CompositionMode = 'full';
let master: MasterView | null = null;
let labelsA: string[] = [];
let labelsB: string[] = [];
let rendered: AudioBuffer | null = null; // cached render; invalidated on any change
let player: AudioBufferSourceNode | null = null;

// Only rebuild the cross-song panels when component sets change (decks also fire
// onChange while the crop is dragged, which doesn't affect matching/composition).
let lastA: ComponentMessage[] | null = null;
let lastB: ComponentMessage[] | null = null;

function refreshCrossSong(): void {
  if (deckA.components === lastA && deckB.components === lastB) return;
  lastA = deckA.components;
  lastB = deckB.components;
  conformer.clearCache(); // component audio changed → conformed cache is stale
  invalidateRender();
  renderCross();
}

function invalidateRender(): void {
  rendered = null;
}

function renderCross(): void {
  if (!deckA.hasComponents || !deckB.hasComponents) {
    stopRendered();
    cross.innerHTML = '';
    master = null;
    return;
  }
  labelsA = componentLabels(deckA.components);
  labelsB = componentLabels(deckB.components);
  // Default the transition target to the lead-in song each time the sources change.
  composerState.targetBpm = Math.round(deckA.bpm);
  composerState.targetTonic = deckA.tonic ?? deckB.tonic ?? 0;

  cross.innerHTML = `
    <div id="match-host"></div>
    <div id="composer-host"></div>
    <div id="master-host"></div>`;

  renderMatchPanel();
  renderComposerPanel();
  renderMasterPanel();
}

function renderMatchPanel(): void {
  const host = document.querySelector<HTMLElement>('#match-host')!;
  const match = matchComponents(deckA.components, deckB.components, deckA.resultSampleRate, deckB.resultSampleRate);
  renderMatcher(
    host,
    { components: deckA.components, sampleRate: deckA.resultSampleRate, labels: labelsA },
    { components: deckB.components, sampleRate: deckB.resultSampleRate, labels: labelsB },
    match,
    selectedLoops,
    {
      onSelectionChange: (loops) => {
        selection = loops;
        invalidateRender();
        renderComposerPanel();
      },
    },
  );
}

function renderComposerPanel(): void {
  const host = document.querySelector<HTMLElement>('#composer-host');
  if (!host) return;
  renderComposer(host, selection, { a: labelsA, b: labelsB }, composerState, {
    onChange: () => {
      invalidateRender();
      master?.setStatus('Settings changed — press Play to re-render.');
    },
  });
}

function renderMasterPanel(): void {
  const host = document.querySelector<HTMLElement>('#master-host')!;
  master = renderMaster(host, compositionMode, {
    onModeChange: (m) => {
      compositionMode = m;
      invalidateRender();
    },
    onPlay: () => void ensureRenderedThen(playRendered),
    onStop: stopRendered,
    onDownload: () => void ensureRenderedThen(downloadRendered),
  });
}

// --- Composition assembly ---
async function buildPlan(): Promise<RenderPlan> {
  const sr = deckA.resultSampleRate;
  const { targetBpm, targetTonic, pitchMatch } = composerState;

  const slots: RenderSlot[] = [];
  for (const loop of selection) {
    const deck = loop.source === 'A' ? deckA : deckB;
    const comp = deck.components[loop.index];
    const settings = composerState.slots.get(`${loop.source}:${loop.index}`);
    if (!comp || !settings) continue;
    const ratio = deck.bpm / targetBpm;
    const semis = pitchMatch ? semitoneDistance(deck.tonic ?? targetTonic, targetTonic) : 0;
    const key = `loop:${loop.source}:${loop.index}:${targetBpm}:${targetTonic}:${pitchMatch}`;
    const buffer = await conformer.conform(key, comp.channels, ratio, semis);
    slots.push({ buffer, repeats: settings.repeats, entrance: settings.entrance, exit: settings.exit, gain: settings.gain });
  }

  let aBody: Float32Array[] | undefined;
  let bBody: Float32Array[] | undefined;
  if (compositionMode === 'full') {
    const a = deckA.crop;
    const b = deckB.crop;
    if (deckA.decoded && a) aBody = await conformBody('A', deckA, 0, a.start, targetBpm, targetTonic, pitchMatch);
    if (deckB.decoded && b) bBody = await conformBody('B', deckB, b.end, deckB.decoded.duration, targetBpm, targetTonic, pitchMatch);
  }

  return { sampleRate: sr, aBody, bBody, slots };
}

async function conformBody(
  src: 'A' | 'B',
  deck: Deck,
  startSec: number,
  endSec: number,
  targetBpm: number,
  targetTonic: number,
  pitchMatch: boolean,
): Promise<Float32Array[] | undefined> {
  if (!deck.decoded) return undefined;
  const lenSamples = Math.round((endSec - startSec) * deck.decoded.sampleRate);
  if (lenSamples <= 0) return undefined;
  const channels = cropChannels(deck.decoded, startSec, lenSamples);
  const ratio = deck.bpm / targetBpm;
  const semis = pitchMatch ? semitoneDistance(deck.tonic ?? targetTonic, targetTonic) : 0;
  const key = `body:${src}:${startSec.toFixed(2)}:${endSec.toFixed(2)}:${targetBpm}:${targetTonic}:${pitchMatch}`;
  return conformer.conform(key, channels, ratio, semis);
}

async function ensureRenderedThen(after: () => void): Promise<void> {
  if (rendered) {
    after();
    return;
  }
  if (selection.length === 0 && compositionMode === 'cropped') {
    master?.setStatus('Tick some loops above to build the transition.');
    return;
  }
  try {
    master?.setBusy(true);
    master?.setStatus('Conforming & rendering…');
    rendered = await renderComposition(await buildPlan());
    master?.setBusy(false);
    master?.setStatus('Ready.');
    after();
  } catch (err) {
    master?.setBusy(false);
    master?.setStatus(`Render failed: ${(err as Error).message}`);
  }
}

async function playRendered(): Promise<void> {
  if (!rendered) return;
  stopRendered();
  const ctx = audioContext();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createBufferSource();
  src.buffer = rendered;
  src.connect(ctx.destination);
  src.onended = () => {
    if (player === src) player = null;
    master?.setPlaying(false);
  };
  src.start();
  player = src;
  master?.setPlaying(true);
}

function stopRendered(): void {
  if (player) {
    try {
      player.onended = null;
      player.stop();
    } catch {
      // already stopped
    }
    player = null;
  }
  master?.setPlaying(false);
}

function downloadRendered(): void {
  if (!rendered) return;
  const channels: Float32Array[] = [];
  for (let c = 0; c < rendered.numberOfChannels; c++) channels.push(rendered.getChannelData(c));
  const blob = encodeWav(channels, rendered.sampleRate);
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'song-surgeon-transition.wav';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  master?.setStatus('Ready — downloaded.');
}

// Keep component waveforms crisp on resize.
let resizeTimer: number | undefined;
window.addEventListener('resize', () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(() => {
    deckA.redraw();
    deckB.redraw();
  }, 150);
});
