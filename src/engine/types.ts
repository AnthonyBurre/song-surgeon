import type { PartKind } from '../dsp/separate';
import type { PitchResult } from '../dsp/pitch';

// The separation-engine contract. The UI talks to *an* engine through this
// interface and never to a specific implementation, so the built-in TS engine,
// an in-browser ONNX model, or a local Python server are interchangeable.
//
// Deliberately narrow: an engine only turns audio into parts. Tempo analysis,
// time-stretching, loop trimming and key labelling stay in the shared app code
// (see `finishParts`) so every engine's output is post-processed identically.

/** One control an engine wants the UI to render. The UI draws these generically. */
export type OptionSpec =
  | { kind: 'choice'; key: string; label: string; choices: { value: string; label: string }[]; default: string }
  | { kind: 'number'; key: string; label: string; min: number; max: number; step: number; default: number }
  | { kind: 'toggle'; key: string; label: string; default: boolean };

export type OptionValues = Record<string, string | number | boolean>;

/** Static self-description: what the engine is and what it can do. */
export interface EngineInfo {
  /** Stable id, e.g. 'builtin-nmf' or 'demucs-htdemucs'. */
  id: string;
  /** Human name for the engine picker. */
  name: string;
  /** Where the compute happens — shown to the user so the cost is visible. */
  runtime: 'browser' | 'local-server';
  /** Longest input the engine accepts, in seconds (undefined = no cap). */
  maxSeconds?: number;
  /** Whether `split` is supported (re-separating a single part). */
  canSplit: boolean;
  /** Controls to render for `separate`. */
  options: OptionSpec[];
}

export interface SeparateInput {
  /** One entry per channel (mono → 1, stereo → 2). Engines must not mutate these. */
  channels: Float32Array[];
  sampleRate: number;
  options: OptionValues;
}

export interface SplitInput {
  channels: Float32Array[];
  sampleRate: number;
  kind: PartKind;
  count: number;
}

/** A separated part, as returned by an engine (before shared post-processing). */
export interface Part {
  channels: Float32Array[];
  /**
   * Coarse class the matcher relies on (chroma vs. spectral-envelope matching).
   * Stem engines map their stems onto it: drums → percussive, the rest → harmonic.
   */
  kind: PartKind;
  /** Display name, e.g. 'Percussive 1', 'Vocals', 'Bass'. */
  label: string;
  /** RMS energy, for ordering and display. */
  energy: number;
  /** Optional — engines may supply it; otherwise `finishParts` estimates it. */
  pitch?: PitchResult;
}

export interface EngineResult {
  parts: Part[];
  sampleRate: number;
}

export type ProgressFn = (fraction: number, stage: string) => void;

export interface RunOptions {
  onProgress?: ProgressFn;
  /** Aborting rejects the promise with an AbortError and stops the work if possible. */
  signal?: AbortSignal;
}

export interface SeparationEngine {
  readonly info: EngineInfo;
  separate(input: SeparateInput, run?: RunOptions): Promise<EngineResult>;
  /** Only called when `info.canSplit` is true. */
  split?(input: SplitInput, run?: RunOptions): Promise<EngineResult>;
  /** Release threads / connections. */
  dispose(): void;
}

/** Defaults for an engine's options, for initial UI state. */
export function defaultOptions(info: EngineInfo): OptionValues {
  return Object.fromEntries(info.options.map((o) => [o.key, o.default]));
}
