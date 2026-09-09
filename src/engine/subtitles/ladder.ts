import { SUBTITLES } from '../config.js';
import { clampOffsetMs, describeOffset } from './cues.js';

/**
 * **The ladder** — the thirteen shifted variants of one track that make a nudge instant.
 *
 * This file exists because of one measurement. SPIKE-3 asked all three televisions in this
 * house whether a text track can be changed while a film is playing, on 2026-08-26, and the
 * answer was no in two of the three ways it could have been yes: pointing a declared track
 * at a **new URL** mid-film is accepted and then ignored (0 fetches, every device), and
 * **rewriting the file** at a stable URL is served from cache (0 re-fetches — and the
 * founder confirmed on the `AI PONT` that the shifted words never reached the screen, so
 * the instrument and a person agreed). What *does* work is switching between tracks that
 * were declared **before** the LOAD, and it is fast: 11–36 ms, no buffering, on all three.
 *
 * So the offset cannot be computed when the founder presses *later*. Every offset they
 * might reach in one press has to already be on the television. That is the ladder: a fixed
 * set of rungs declared up front, and a press is a **track switch** rather than anything
 * being made.
 *
 * Everything here is a **pure function over numbers** — no cues, no I/O, no device. The cue
 * shift itself lives in `cues.ts` and the serving lives in the media server; this is only
 * the arithmetic of which rungs exist and which one an offset lands on.
 */

/** One rung: an offset the founder can reach in one press, and the `trackId` carrying it. */
export interface LadderRung {
  /** What the LOAD declares and `EDIT_TRACKS_INFO` names. Ascending with `offsetMs`. */
  readonly trackId: number;
  /** How far this rung's cues are shifted, in integer milliseconds. */
  readonly offsetMs: number;
}

/** One nudge, in milliseconds. 0.5 s — the founder confirmed the step on 2026-08-26. */
export const LADDER_STEP_MS = Math.round(SUBTITLES.nudgeStepSeconds * 1_000);

/** How far the ladder reaches either side of *in sync*. ±3 s, same conversation. */
export const LADDER_SPAN_MS = Math.round(SUBTITLES.ladderSpanSeconds * 1_000);

/**
 * **Where a ladder is hung**, given the offset it has to cover.
 *
 * The ladder reaches ±3 s and 20e promises ±30 s, so a ladder is not always centred on
 * *in sync* — a founder who has nudged to +5 s gets one hung around +5 s, and their next
 * press is instant again rather than costing a second reload. Pulled back far enough from
 * the clamp that every rung is inside it: at ±27 s the top rung is exactly ±30 s, which is
 * the furthest 20e allows anyone to go.
 */
export function ladderCentreFor(offsetMs: number): number {
  const reach = SUBTITLES.maxOffsetSeconds * 1_000 - LADDER_SPAN_MS;
  const offset = clampOffsetMs(offsetMs);
  return Math.max(-reach, Math.min(reach, offset));
}

/**
 * Every rung of the ladder hung at `centreMs`, most negative first.
 *
 * **Ascending with the offset rather than centred**, so `trackId` and *earlier/later* run in
 * the same direction and a wire trace can be read without a lookup table: rung 1 is the
 * furthest early, rung 13 the furthest late, and the centre is the one in the middle.
 *
 * Thirteen is not a constant here, it is `2 × span ÷ step + 1`. The two numbers it comes
 * from are the ones the founder actually chose, and they are the pair the PRD names as the
 * first thing to revise after a real evening — so the count has to follow them.
 */
export function buildLadder(centreMs = 0): readonly LadderRung[] {
  const centre = ladderCentreFor(centreMs);
  const rungs: LadderRung[] = [];
  let trackId = SUBTITLES.firstTrackId;
  for (let step = -LADDER_SPAN_MS; step <= LADDER_SPAN_MS; step += LADDER_STEP_MS) {
    rungs.push({ trackId, offsetMs: centre + step });
    trackId += 1;
  }
  return rungs;
}

/** Is this offset one the ladder at `centreMs` already holds — reachable without a reload? */
export function onLadder(offsetMs: number, centreMs = 0): boolean {
  const offset = clampOffsetMs(offsetMs);
  const centre = ladderCentreFor(centreMs);
  return Math.abs(offset - centre) <= LADDER_SPAN_MS && (offset - centre) % LADDER_STEP_MS === 0;
}

/**
 * The rung an offset lands on, or `null` when it is off this ladder.
 *
 * `null` is not a failure: it is *"one reload at the remembered position"* (2026-08-26 ADR),
 * and the reload hangs a **new** ladder around where the founder has got to, so it happens
 * at most once per journey rather than once per press. The caller is the only thing that
 * knows whether a reload is possible right now, which is why this answers the question
 * rather than deciding what to do about it.
 */
export function rungFor(offsetMs: number, centreMs = 0): LadderRung | null {
  if (!onLadder(offsetMs, centreMs)) return null;
  const offset = clampOffsetMs(offsetMs);
  return buildLadder(centreMs).find((rung) => rung.offsetMs === offset) ?? null;
}

/**
 * One nudge from where we are, clamped to 20e's ±30 s.
 *
 * The clamp is `clampOffsetMs`, the same one the displayed number goes through, so *"states
 * the real distance moved rather than reading as a dead button"* is true by construction:
 * a press at the limit returns the limit, and the screen and the cues cannot disagree.
 */
export function nudged(offsetMs: number, steps: number): number {
  return clampOffsetMs(clampOffsetMs(offsetMs) + steps * LADDER_STEP_MS);
}

/**
 * What the **television's own** track menu shows for one rung.
 *
 * A cost of the ladder that is worth naming: a set that lists its text tracks will now list
 * thirteen of them, and thirteen rows all reading *English* would be a menu nobody can use.
 * The rung at zero keeps the founder's plain label — it is the one they chose — and the
 * others carry the offset they represent, in the same words CastGood's own control uses.
 */
export function rungLabel(label: string, offsetMs: number): string {
  return offsetMs === 0 ? label : `${label} (${describeOffset(offsetMs)})`;
}
