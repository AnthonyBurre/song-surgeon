// A small +/− integer stepper. Renders into `host` and keeps an internal value
// label in sync; `set` is called with each clamped new value.
export function stepper(
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
