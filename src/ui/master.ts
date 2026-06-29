export type CompositionMode = 'full' | 'cropped';

export interface MasterCallbacks {
  onPlay: () => void;
  onStop: () => void;
  onDownload: () => void;
  onModeChange: (mode: CompositionMode) => void;
}

export interface MasterView {
  setStatus(text: string): void;
  setBusy(busy: boolean): void;
  setPlaying(playing: boolean): void;
  getMode(): CompositionMode;
}

// Master transport for the assembled composition: choose how much of the songs
// to include, then play / stop / download the rendered mix.
export function renderMaster(root: HTMLElement, initialMode: CompositionMode, callbacks: MasterCallbacks): MasterView {
  let mode = initialMode;

  root.innerHTML = `
    <section class="panel cross-panel master">
      <h2>Play the composition</h2>
      <div class="master-controls">
        <div class="mode-toggle">
          <button class="btn mode" data-mode="full" type="button">Full songs</button>
          <button class="btn mode" data-mode="cropped" type="button">Transition only</button>
        </div>
        <div class="master-transport">
          <button class="btn primary play-comp" type="button">Play composition</button>
          <button class="btn stop-comp" type="button">Stop</button>
          <button class="btn dl-comp" type="button">Download .wav</button>
        </div>
      </div>
      <div class="progress hidden master-progress">
        <div class="bar"><div class="fill"></div></div>
        <span class="progress-label"></span>
      </div>
      <p class="master-note">Full songs play A up to the transition, the loop bridge, then B from its
        intro on — all conformed to the target tempo so it stays seamless.</p>
    </section>`;

  const modeButtons = root.querySelectorAll<HTMLButtonElement>('.mode');
  const syncMode = () =>
    modeButtons.forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  modeButtons.forEach((b) =>
    b.addEventListener('click', () => {
      mode = b.dataset.mode as CompositionMode;
      syncMode();
      callbacks.onModeChange(mode);
    }),
  );
  syncMode();

  const playBtn = root.querySelector<HTMLButtonElement>('.play-comp')!;
  const stopBtn = root.querySelector<HTMLButtonElement>('.stop-comp')!;
  const dlBtn = root.querySelector<HTMLButtonElement>('.dl-comp')!;
  const progress = root.querySelector<HTMLElement>('.master-progress')!;
  const fill = root.querySelector<HTMLElement>('.fill')!;
  const label = root.querySelector<HTMLElement>('.progress-label')!;

  playBtn.addEventListener('click', () => callbacks.onPlay());
  stopBtn.addEventListener('click', () => callbacks.onStop());
  dlBtn.addEventListener('click', () => callbacks.onDownload());

  return {
    setStatus(text: string) {
      progress.classList.remove('hidden');
      label.textContent = text;
      fill.style.width = text.toLowerCase().includes('ready') ? '100%' : '50%';
    },
    setBusy(busy: boolean) {
      playBtn.disabled = busy;
      dlBtn.disabled = busy;
      if (busy) {
        progress.classList.remove('hidden');
      }
    },
    setPlaying(playing: boolean) {
      playBtn.textContent = playing ? 'Restart' : 'Play composition';
    },
    getMode() {
      return mode;
    },
  };
}
