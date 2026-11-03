import { loopTrim } from '../dsp/loop';
import { analyzePitch } from '../dsp/pitch';
import type { LoopParams } from '../dsp/separate';
import type { EngineResult } from './types';

// Shared post-processing applied to every engine's output, so a part from the
// built-in NMF engine and one from a stem model are treated identically:
//   1. trim to a seamless loop (same op on every part → they still sum to the
//      looped original), and
//   2. estimate a key for tonal parts the engine didn't label itself.
export function finishParts(result: EngineResult, loop?: LoopParams): EngineResult {
  const parts = result.parts.map((p) => {
    const channels = loop ? p.channels.map((ch) => loopTrim(ch, loop.lengthSamples, loop.crossfadeSamples)) : p.channels;
    const pitch = p.pitch ?? (p.kind === 'percussive' ? undefined : analyzePitch(channels[0], result.sampleRate));
    return { ...p, channels, pitch };
  });
  return { parts, sampleRate: result.sampleRate };
}
