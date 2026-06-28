import { separate, splitComponent, type SeparationParams, type PartKind } from './separate';
import { analyzeTempo, type TempoResult, type CropSuggestion } from './tempo';
import type { PitchResult } from './pitch';

export interface SeparateRequest {
  type: 'separate';
  channels: Float32Array[];
  sampleRate: number;
  params: SeparationParams;
}

export interface SplitRequest {
  type: 'split';
  /** Index of the component being split, echoed back so the UI can splice it. */
  id: number;
  channels: Float32Array[];
  sampleRate: number;
  kind: PartKind;
  count: number;
  fftSize: number;
  hop: number;
  iterations: number;
}

export interface AnalyzeRequest {
  type: 'analyze';
  signal: Float32Array;
  sampleRate: number;
  maxCropSeconds: number;
}

export type WorkerRequest = SeparateRequest | SplitRequest | AnalyzeRequest;

export interface ProgressMessage {
  type: 'progress';
  fraction: number;
  stage: string;
}

export interface ComponentMessage {
  channels: Float32Array[];
  kind: PartKind;
  energy: number;
  pitch?: PitchResult;
}

export interface ResultMessage {
  type: 'result';
  components: ComponentMessage[];
  sampleRate: number;
}

export interface SplitResultMessage {
  type: 'split-result';
  id: number;
  components: ComponentMessage[];
  sampleRate: number;
}

export interface AnalysisMessage {
  type: 'analysis';
  tempo: TempoResult;
  suggestion: CropSuggestion;
}

export type WorkerMessage = ProgressMessage | ResultMessage | SplitResultMessage | AnalysisMessage;

const ctx = self as unknown as Worker;

function toMessages(components: { channels: Float32Array[]; kind: PartKind; energy: number; pitch?: PitchResult }[]): {
  payload: ComponentMessage[];
  transfers: Transferable[];
} {
  const payload: ComponentMessage[] = components.map((c) => ({
    channels: c.channels,
    kind: c.kind,
    energy: c.energy,
    pitch: c.pitch,
  }));
  const transfers = payload.flatMap((c) => c.channels.map((ch) => ch.buffer as ArrayBuffer));
  return { payload, transfers };
}

ctx.onmessage = (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const progress = (fraction: number, stage: string) =>
    ctx.postMessage({ type: 'progress', fraction, stage } satisfies ProgressMessage);

  if (req.type === 'analyze') {
    const { tempo, suggestion } = analyzeTempo(req.signal, req.sampleRate, req.maxCropSeconds);
    ctx.postMessage({ type: 'analysis', tempo, suggestion } satisfies AnalysisMessage);
    return;
  }

  if (req.type === 'split') {
    const result = splitComponent(req.channels, req.sampleRate, req.kind, req.count, {
      fftSize: req.fftSize,
      hop: req.hop,
      iterations: req.iterations,
    }, progress);
    const { payload, transfers } = toMessages(result.components);
    ctx.postMessage(
      { type: 'split-result', id: req.id, components: payload, sampleRate: result.sampleRate } satisfies SplitResultMessage,
      transfers,
    );
    return;
  }

  const result = separate(req.channels, req.sampleRate, req.params, progress);
  const { payload, transfers } = toMessages(result.components);
  ctx.postMessage(
    { type: 'result', components: payload, sampleRate: result.sampleRate } satisfies ResultMessage,
    transfers,
  );
};
