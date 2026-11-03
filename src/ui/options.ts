import type { OptionSpec, OptionValues } from '../engine/types';

// Render an engine's self-described options as form controls into `host`.
// The UI never hard-codes an engine's settings: whatever `info.options` lists is
// what gets drawn, and `values` is updated in place as the user changes them.
export function renderOptions(host: HTMLElement, specs: OptionSpec[], values: OptionValues): void {
  host.innerHTML = '';
  for (const spec of specs) {
    const field = document.createElement('label');
    field.className = 'control';
    const label = document.createElement('span');
    label.className = 'control-label';
    label.textContent = spec.label;
    field.append(label);

    if (spec.kind === 'choice') {
      const select = document.createElement('select');
      select.className = 'option-input';
      for (const c of spec.choices) select.add(new Option(c.label, c.value));
      select.value = String(values[spec.key] ?? spec.default);
      select.addEventListener('change', () => (values[spec.key] = select.value));
      field.append(select);
    } else if (spec.kind === 'number') {
      const input = document.createElement('input');
      input.type = 'number';
      input.className = 'option-input';
      input.min = String(spec.min);
      input.max = String(spec.max);
      input.step = String(spec.step);
      input.value = String(values[spec.key] ?? spec.default);
      input.addEventListener('change', () => {
        const v = Math.max(spec.min, Math.min(spec.max, Number(input.value)));
        values[spec.key] = v;
        input.value = String(v);
      });
      field.append(input);
    } else {
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = Boolean(values[spec.key] ?? spec.default);
      box.addEventListener('change', () => (values[spec.key] = box.checked));
      field.append(box);
    }
    host.append(field);
  }
}
