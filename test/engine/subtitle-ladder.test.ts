import { describe, expect, it } from 'vitest';
import { SUBTITLES } from '../../src/engine/config.js';
import {
  buildLadder,
  ladderCentreFor,
  nudged,
  onLadder,
  rungFor,
  rungLabel,
  LADDER_SPAN_MS,
  LADDER_STEP_MS,
} from '../../src/engine/subtitles/ladder.js';

/**
 * **The ladder** — story 20's arithmetic, proved with nothing plugged in.
 *
 * A television takes text tracks only in a LOAD (SPIKE-3, three sets, 2026-08-26), so every
 * offset the founder can reach in one press has to be declared before they press anything.
 * That makes "which offsets exist" a decision this file can check to the millisecond, and
 * getting it wrong is a founder pressing *later* and watching nothing happen.
 */
describe('the rungs', () => {
  it('is thirteen rungs, half a second apart, across ±3 s', () => {
    const ladder = buildLadder();
    expect(ladder).toHaveLength(13);
    expect(ladder.map((rung) => rung.offsetMs)).toEqual([
      -3_000, -2_500, -2_000, -1_500, -1_000, -500, 0, 500, 1_000, 1_500, 2_000, 2_500, 3_000,
    ]);
    // Ascending with the offset, starting where step 3's single track started, so a wire
    // trace reads left to right without a lookup table.
    expect(ladder.map((rung) => rung.trackId)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
    expect(ladder[6]).toEqual({ trackId: 7, offsetMs: 0 });
  });

  it('follows the two numbers the founder chose rather than a hardcoded thirteen', () => {
    // 0.5 s and ±3 s, confirmed 2026-08-26 — and the PRD names the step as the first thing
    // to revise after a real evening, so the count has to be derived from it.
    expect(LADDER_STEP_MS).toBe(SUBTITLES.nudgeStepSeconds * 1_000);
    expect(LADDER_SPAN_MS).toBe(SUBTITLES.ladderSpanSeconds * 1_000);
    expect(buildLadder()).toHaveLength((2 * LADDER_SPAN_MS) / LADDER_STEP_MS + 1);
  });

  it('answers which rung an offset lands on, and null when there is none', () => {
    expect(rungFor(0)).toEqual({ trackId: 7, offsetMs: 0 });
    expect(rungFor(1_500)).toEqual({ trackId: 10, offsetMs: 1_500 });
    expect(rungFor(-3_000)).toEqual({ trackId: 1, offsetMs: -3_000 });
    // Past the span: a real offset, reachable, but not without loading again.
    expect(rungFor(3_500)).toBeNull();
    expect(onLadder(3_500)).toBe(false);
    // Between rungs: nothing the control can produce, and refused rather than rounded.
    expect(rungFor(250)).toBeNull();
  });
});

describe('a ladder hangs where the founder is, not at zero', () => {
  it('recentres past ±3 s so a long journey costs one reload, not one per press', () => {
    const ladder = buildLadder(5_000);
    expect(ladder.map((rung) => rung.offsetMs)).toEqual([
      2_000, 2_500, 3_000, 3_500, 4_000, 4_500, 5_000, 5_500, 6_000, 6_500, 7_000, 7_500, 8_000,
    ]);
    // The offset that caused the reload is the middle rung, so the founder lands on the
    // correction they asked for — not back at *in sync*, which would undo it.
    expect(rungFor(5_000, 5_000)).toEqual({ trackId: 7, offsetMs: 5_000 });
    // And the next press either way is instant again.
    expect(rungFor(5_500, 5_000)).not.toBeNull();
    expect(rungFor(4_500, 5_000)).not.toBeNull();
    expect(rungFor(9_000, 5_000)).toBeNull();
  });

  it('pulls the centre back from the clamp so every rung stays inside ±30 s', () => {
    const limit = SUBTITLES.maxOffsetSeconds * 1_000;
    expect(ladderCentreFor(limit)).toBe(limit - LADDER_SPAN_MS);
    const ladder = buildLadder(limit);
    expect(ladder[12]?.offsetMs).toBe(limit);
    for (const rung of ladder) expect(Math.abs(rung.offsetMs)).toBeLessThanOrEqual(limit);
    // **The furthest 20e allows is still a rung**, which is what stops the last half-second
    // of the promised range being unreachable.
    expect(rungFor(limit, ladderCentreFor(limit))).not.toBeNull();
    expect(rungFor(-limit, ladderCentreFor(-limit))).not.toBeNull();
  });
});

describe('one press — 20b and 20e', () => {
  it('moves by exactly one step in the direction pressed', () => {
    expect(nudged(0, 1)).toBe(500);
    expect(nudged(0, -1)).toBe(-500);
    expect(nudged(2_500, 1)).toBe(3_000);
    // Four presses inside the settle window sum before anything is sent (20c).
    expect(nudged(nudged(nudged(nudged(0, 1), 1), 1), 1)).toBe(2_000);
  });

  it('clamps at ±30 s and stops moving rather than reading as a dead button', () => {
    const limit = SUBTITLES.maxOffsetSeconds * 1_000;
    expect(nudged(limit, 1)).toBe(limit);
    expect(nudged(-limit, -1)).toBe(-limit);
    // **A founder at the limit is never stuck**: the other direction still moves.
    expect(nudged(limit, -1)).toBe(limit - LADDER_STEP_MS);
    // And the clamp states the real distance moved rather than overshooting to it.
    expect(nudged(limit - 200, 1)).toBe(limit);
  });
});

describe('what the television’s own track menu reads', () => {
  it('names the plain label at zero and the offset everywhere else', () => {
    // Thirteen rows all reading "English" would be a menu nobody could use — and it is the
    // set's own menu, not CastGood's, so this is the only place it can be made legible.
    expect(rungLabel('English', 0)).toBe('English');
    expect(rungLabel('English', 500)).toBe('English (+0.5 s)');
    expect(rungLabel('English', -2_500)).toBe('English (−2.5 s)');
  });
});
