import { describe, it, expect } from 'vitest';
import { planTimeline, type RenderPlan, type RenderSlot } from './arrangement';

const SR = 44100;
const seconds = (s: number) => new Float32Array(Math.round(s * SR));

function slot(loopSec: number, repeats: number): RenderSlot {
  return { buffer: [seconds(loopSec)], repeats, entrance: 'hard', exit: 'hard', gain: 1 };
}

describe('planTimeline', () => {
  it('lays out A body → transition → B body in sequence', () => {
    const plan: RenderPlan = {
      sampleRate: SR,
      aBody: [seconds(1)],
      bBody: [seconds(1)],
      slots: [slot(0.5, 4)],
    };
    const tl = planTimeline(plan);
    expect(tl.aBodySec).toBeCloseTo(1, 3);
    expect(tl.transitionStartSec).toBeCloseTo(1, 3);
    expect(tl.transitionSec).toBeCloseTo(2, 3); // 0.5s × 4
    expect(tl.bBodyStartSec).toBeCloseTo(3, 3);
    expect(tl.bBodySec).toBeCloseTo(1, 3);
    expect(tl.totalSec).toBeCloseTo(4, 3);
    expect(tl.slots[0]).toMatchObject({ loopSec: expect.any(Number) });
    expect(tl.slots[0].startSec).toBeCloseTo(1, 3);
    expect(tl.slots[0].totalSec).toBeCloseTo(2, 3);
  });

  it('spans the transition over the longest slot', () => {
    const plan: RenderPlan = {
      sampleRate: SR,
      slots: [slot(1, 2), slot(0.5, 2)], // 2s vs 1s
    };
    const tl = planTimeline(plan);
    expect(tl.aBodySec).toBe(0);
    expect(tl.transitionStartSec).toBe(0);
    expect(tl.transitionSec).toBeCloseTo(2, 3);
    expect(tl.totalSec).toBeCloseTo(2, 3);
  });

  it('handles an empty selection as zero-length transition', () => {
    const tl = planTimeline({ sampleRate: SR, slots: [] });
    expect(tl.transitionSec).toBe(0);
    expect(tl.totalSec).toBe(0);
  });
});
