import type { SeparateRequest, SplitRequest, WorkerMessage, ComponentMessage } from '../dsp/worker';
import type { StreamConfig } from '../dsp/separate';
import type { EngineInfo, EngineResult, OptionValues, Part, RunOptions, SeparateInput, SeparationEngine, SplitInput } from './types';

// Adapter: exposes the existing worker (HPSS + NMF) through the engine contract.
// The worker protocol is unchanged; this class owns its own worker and turns the
// message round-trip into a Promise.
//
// The worker messages carry no job id, so this runs one job at a time. Since the
// NMF loop is synchronous it can't be interrupted, so abort = terminate the
// worker and spawn a fresh one.

const FFT_SIZE = 2048;
const HOP = 512;
const ITERATIONS = 80;
// Kept in step with MAX_CROP_SECONDS in deck.ts — compute scales with length.
const MAX_SECONDS = 20;

const countChoices = [
  { value: 'auto', label: 'Auto' },
  ...[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) })),
];

const INFO: EngineInfo = {
  id: 'builtin-nmf',
  name: 'Built-in (loops)',
  runtime: 'browser',
  maxSeconds: MAX_SECONDS,
  canSplit: true,
  options: [
    { kind: 'choice', key: 'percussive', label: 'Percussive parts', choices: countChoices, default: 'auto' },
    { kind: 'choice', key: 'harmonic', label: 'Harmonic parts', choices: countChoices, default: 'auto' },
  ],
};

function streamConfig(value: OptionValues[string] | undefined): StreamConfig {
  return value === undefined || value === 'auto' ? { mode: 'auto' } : { mode: 'manual', count: Number(value) };
}

function toParts(components: ComponentMessage[]): Part[] {
  const seen: Record<string, number> = {};
  return components.map((c) => {
    seen[c.kind] = (seen[c.kind] ?? 0) + 1;
    const name = c.kind[0].toUpperCase() + c.kind.slice(1);
    return { ...c, label: `${name} ${seen[c.kind]}` };
  });
}

export class BuiltinEngine implements SeparationEngine {
  readonly info = INFO;
  private worker = this.spawn();
  private busy = false;

  separate(input: SeparateInput, run?: RunOptions): Promise<EngineResult> {
    const channels = input.channels.map((c) => c.slice()); // copy: transfer detaches
    const request: SeparateRequest = {
      type: 'separate',
      channels,
      sampleRate: input.sampleRate,
      params: {
        fftSize: FFT_SIZE,
        hop: HOP,
        iterations: ITERATIONS,
        percussive: streamConfig(input.options.percussive),
        harmonic: streamConfig(input.options.harmonic),
        // No `loop`: loop trimming is shared post-processing (finishParts).
      },
    };
    return this.run(request, channels, 'result', run);
  }

  split(input: SplitInput, run?: RunOptions): Promise<EngineResult> {
    const channels = input.channels.map((c) => c.slice());
    const request: SplitRequest = {
      type: 'split',
      id: 0,
      channels,
      sampleRate: input.sampleRate,
      kind: input.kind,
      count: input.count,
      fftSize: FFT_SIZE,
      hop: HOP,
      iterations: ITERATIONS,
    };
    return this.run(request, channels, 'split-result', run);
  }

  dispose(): void {
    this.worker.terminate();
  }

  private spawn(): Worker {
    return new Worker(new URL('../dsp/worker.ts', import.meta.url), { type: 'module' });
  }

  private run(
    request: SeparateRequest | SplitRequest,
    channels: Float32Array[],
    resultType: 'result' | 'split-result',
    run?: RunOptions,
  ): Promise<EngineResult> {
    if (this.busy) return Promise.reject(new Error('BuiltinEngine is already running a job'));
    if (run?.signal?.aborted) return Promise.reject(run.signal.reason);
    this.busy = true;

    return new Promise<EngineResult>((resolve, reject) => {
      const onAbort = () => {
        this.worker.terminate();
        this.worker = this.spawn();
        finish();
        reject(run?.signal?.reason);
      };
      const finish = () => {
        this.busy = false;
        this.worker.onmessage = null;
        run?.signal?.removeEventListener('abort', onAbort);
      };

      run?.signal?.addEventListener('abort', onAbort, { once: true });
      this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
        const msg = e.data;
        if (msg.type === 'progress') {
          run?.onProgress?.(msg.fraction, msg.stage);
        } else if (msg.type === resultType && (msg.type === 'result' || msg.type === 'split-result')) {
          finish();
          resolve({ parts: toParts(msg.components), sampleRate: msg.sampleRate });
        }
      };
      this.worker.postMessage(request, channels.map((c) => c.buffer));
    });
  }
}
