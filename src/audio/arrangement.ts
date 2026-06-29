// Composition model + offline render. The full output plays at a single target
// tempo/key throughout: an optional conformed A-body, a transition built from
// looped/faded selected loops, and an optional conformed B-body. Rendering uses
// an OfflineAudioContext so playback and download come from the identical buffer.
//
// `planTimeline` is the pure (browser-API-free) timing core and is unit-tested;
// `renderComposition` wires that plan into Web Audio.

export type FadeKind = 'hard' | 'fade';

export interface RenderSlot {
  /** Conformed loop channels (already at the target tempo/key). */
  buffer: Float32Array[];
  repeats: number;
  entrance: FadeKind;
  exit: FadeKind;
  /** 0..1 overall level. */
  gain: number;
}

export interface RenderPlan {
  sampleRate: number;
  /** Conformed song-A body (plays before the transition). Omitted in transition-only mode. */
  aBody?: Float32Array[];
  /** Conformed song-B body (plays after the transition). Omitted in transition-only mode. */
  bBody?: Float32Array[];
  slots: RenderSlot[];
}

export interface PlannedSlot {
  startSec: number;
  loopSec: number;
  totalSec: number;
}

export interface Timeline {
  aBodySec: number;
  transitionStartSec: number;
  transitionSec: number;
  bBodyStartSec: number;
  bBodySec: number;
  totalSec: number;
  slots: PlannedSlot[];
}

const lenOf = (chs?: Float32Array[]): number => chs?.[0]?.length ?? 0;

// Pure timing: where each segment sits on the composition timeline. The
// transition spans the longest slot (repeats × conformed loop length); every
// slot starts together at the transition start.
export function planTimeline(plan: RenderPlan): Timeline {
  const sr = plan.sampleRate;
  const aBodySec = lenOf(plan.aBody) / sr;
  const bBodySec = lenOf(plan.bBody) / sr;

  let transitionSec = 0;
  const slots: PlannedSlot[] = plan.slots.map((s) => {
    const loopSec = lenOf(s.buffer) / sr;
    const totalSec = loopSec * Math.max(0, s.repeats);
    if (totalSec > transitionSec) transitionSec = totalSec;
    return { startSec: aBodySec, loopSec, totalSec };
  });

  const transitionStartSec = aBodySec;
  const bBodyStartSec = aBodySec + transitionSec;
  const totalSec = aBodySec + transitionSec + bBodySec;
  return { aBodySec, transitionStartSec, transitionSec, bBodyStartSec, bBodySec, totalSec, slots };
}

function makeBuffer(ctx: BaseAudioContext, channels: Float32Array[], outChannels: number): AudioBuffer {
  const length = Math.max(1, lenOf(channels));
  const buf = ctx.createBuffer(outChannels, length, ctx.sampleRate);
  for (let c = 0; c < outChannels; c++) {
    const src = channels[Math.min(c, channels.length - 1)] ?? channels[0];
    if (src) buf.getChannelData(c).set(src.subarray(0, length));
  }
  return buf;
}

function placeBody(ctx: BaseAudioContext, dest: AudioNode, channels: Float32Array[], atSec: number, outChannels: number): void {
  const src = ctx.createBufferSource();
  src.buffer = makeBuffer(ctx, channels, outChannels);
  src.connect(dest);
  src.start(atSec);
}

// Schedule a looping slot with an entrance/exit envelope. A "fade" ramps over the
// first/last half of the slot's life; "hard" starts/stops instantly.
function scheduleSlot(
  ctx: BaseAudioContext,
  dest: AudioNode,
  slot: RenderSlot,
  startSec: number,
  totalSec: number,
  outChannels: number,
): void {
  if (totalSec <= 0) return;
  const src = ctx.createBufferSource();
  src.buffer = makeBuffer(ctx, slot.buffer, outChannels);
  src.loop = true;
  const g = ctx.createGain();
  src.connect(g);
  g.connect(dest);

  const endSec = startSec + totalSec;
  const base = Math.max(0, slot.gain);
  const half = totalSec / 2;

  if (slot.entrance === 'fade') {
    const fade = Math.min(half, totalSec);
    g.gain.setValueAtTime(0, startSec);
    g.gain.linearRampToValueAtTime(base, startSec + fade);
  } else {
    g.gain.setValueAtTime(base, startSec);
  }
  if (slot.exit === 'fade') {
    const fade = Math.min(half, totalSec);
    g.gain.setValueAtTime(base, Math.max(startSec, endSec - fade));
    g.gain.linearRampToValueAtTime(0, endSec);
  }

  src.start(startSec);
  src.stop(endSec);
}

// Render the whole composition to a single AudioBuffer.
export async function renderComposition(plan: RenderPlan): Promise<AudioBuffer> {
  const tl = planTimeline(plan);
  const sr = plan.sampleRate;
  const outChannels = 2;
  const totalSamples = Math.max(1, Math.ceil(tl.totalSec * sr));
  const ctx = new OfflineAudioContext(outChannels, totalSamples, sr);
  const master = ctx.createGain();
  master.connect(ctx.destination);

  if (plan.aBody && lenOf(plan.aBody) > 0) placeBody(ctx, master, plan.aBody, 0, outChannels);
  if (plan.bBody && lenOf(plan.bBody) > 0) placeBody(ctx, master, plan.bBody, tl.bBodyStartSec, outChannels);
  plan.slots.forEach((slot, i) => {
    scheduleSlot(ctx, master, slot, tl.slots[i].startSec, tl.slots[i].totalSec, outChannels);
  });

  return ctx.startRendering();
}
