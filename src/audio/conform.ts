import type { ConformRequest, WorkerMessage } from '../dsp/worker';

// Promise-based wrapper around the worker's `conform` op (time-stretch +
// pitch-shift). Results are cached by a caller-supplied key so that re-rendering
// a composition after only fade/repeat tweaks doesn't re-stretch unchanged audio
// (conforming a full song is the heaviest operation in the app).
export class ConformService {
  private worker = new Worker(new URL('../dsp/worker.ts', import.meta.url), { type: 'module' });
  private pending = new Map<number, (channels: Float32Array[]) => void>();
  private cache = new Map<string, Float32Array[]>();
  private nextId = 1;

  constructor() {
    this.worker.onmessage = (e: MessageEvent<WorkerMessage>) => {
      const msg = e.data;
      if (msg.type === 'conform-result') {
        const resolve = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        resolve?.(msg.channels);
      }
    };
  }

  // Conform one part. `timeRatio` scales length (tempo); `semitones` shifts pitch.
  // A ratio of 1 with no shift is returned (copied) immediately without a round-trip.
  conform(key: string, channels: Float32Array[], timeRatio: number, semitones: number): Promise<Float32Array[]> {
    const cached = this.cache.get(key);
    if (cached) return Promise.resolve(cached.map((c) => c.slice()));

    if (Math.abs(timeRatio - 1) < 1e-6 && Math.abs(semitones) < 1e-6) {
      const copy = channels.map((c) => c.slice());
      this.cache.set(key, copy);
      return Promise.resolve(copy.map((c) => c.slice()));
    }

    const id = this.nextId++;
    // Copy channels for transfer so the caller's source arrays aren't detached.
    const payload = channels.map((c) => c.slice());
    const request: ConformRequest = { type: 'conform', id, channels: payload, timeRatio, semitones };
    return new Promise<Float32Array[]>((resolve) => {
      this.pending.set(id, (result) => {
        this.cache.set(key, result.map((c) => c.slice()));
        resolve(result);
      });
      this.worker.postMessage(request, payload.map((c) => c.buffer));
    });
  }

  /** Drop cached conforms (e.g. when a deck's source/components change). */
  clearCache(): void {
    this.cache.clear();
  }
}
