import { decodeFloatWav, encodeFloatWav } from '../audio/audioUtils';
import type { PartKind } from '../dsp/separate';
import type { EngineInfo, EngineResult, Part, RunOptions, SeparateInput, SeparationEngine } from './types';

// An engine that runs on a local server (server/ in this repo) and is reached
// over HTTP. Protocol, from the browser's side:
//   1. POST the audio as a float WAV → job id
//   2. follow the job's Server-Sent Events stream for progress until `done`
//   3. GET each part as a float WAV
//   4. DELETE the job (also how a cancel reaches the server)

const API = '/api';

interface DoneEvent {
  sampleRate: number;
  parts: { label: string; kind: PartKind; energy: number }[];
}

/** Ask the page's own server which engines it offers. Resolves [] when there is no server (e.g. GitHub Pages). */
export async function discoverServerEngines(timeoutMs = 1500): Promise<EngineInfo[]> {
  try {
    const res = await fetch(`${API}/engines`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json')) return [];
    const list: unknown = await res.json();
    return Array.isArray(list) ? (list as EngineInfo[]) : [];
  } catch {
    return [];
  }
}

export class HttpEngine implements SeparationEngine {
  constructor(readonly info: EngineInfo) {}

  async separate(input: SeparateInput, run?: RunOptions): Promise<EngineResult> {
    const form = new FormData();
    form.append('engine', this.info.id);
    form.append('options', JSON.stringify(input.options));
    form.append('audio', encodeFloatWav(input.channels, input.sampleRate), 'input.wav');

    run?.onProgress?.(0, 'Uploading');
    const res = await fetch(`${API}/jobs`, { method: 'POST', body: form, signal: run?.signal });
    if (!res.ok) throw new Error(`Server rejected the job (${res.status}): ${await res.text()}`);
    const { id } = (await res.json()) as { id: string };

    try {
      const done = await this.follow(id, run);
      const parts: Part[] = await Promise.all(
        done.parts.map(async (meta, i) => {
          const wav = await fetch(`${API}/jobs/${id}/parts/${i}.wav`, { signal: run?.signal });
          if (!wav.ok) throw new Error(`Couldn't fetch part ${i} (${wav.status})`);
          const { channels } = decodeFloatWav(await wav.arrayBuffer());
          return { ...meta, channels };
        }),
      );
      return { parts, sampleRate: done.sampleRate };
    } finally {
      // Frees the job's memory server-side; if it's still running, this cancels it.
      // keepalive lets the request finish even if the page is closing.
      void fetch(`${API}/jobs/${id}`, { method: 'DELETE', keepalive: true }).catch(() => {});
    }
  }

  dispose(): void {}

  // Resolve with the job's `done` payload, reporting progress along the way.
  private follow(id: string, run?: RunOptions): Promise<DoneEvent> {
    return new Promise<DoneEvent>((resolve, reject) => {
      const events = new EventSource(`${API}/jobs/${id}/events`);
      const close = (settle: () => void) => {
        events.close();
        run?.signal?.removeEventListener('abort', onAbort);
        settle();
      };
      const onAbort = () => close(() => reject(run?.signal?.reason));
      if (run?.signal?.aborted) return onAbort();
      run?.signal?.addEventListener('abort', onAbort, { once: true });

      events.addEventListener('progress', (e) => {
        const { fraction, stage } = JSON.parse((e as MessageEvent).data);
        run?.onProgress?.(fraction, stage);
      });
      events.addEventListener('done', (e) => close(() => resolve(JSON.parse((e as MessageEvent).data))));
      // Named 'error' events carry the server's message; a bare error with no data
      // means the connection dropped. EventSource would silently reconnect — don't.
      events.addEventListener('error', (e) => {
        const data = (e as MessageEvent).data;
        const message = data ? JSON.parse(data).message : 'Lost connection to the engine server';
        close(() => reject(new Error(message)));
      });
    });
  }
}
