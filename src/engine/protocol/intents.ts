import { z } from 'zod';

/**
 * Intents: the only things the UI is allowed to ask for.
 *
 * Truth flows device → engine → UI. Nothing flows back up except these, and every
 * one of them is validated at the IPC boundary in `src/main/` before the engine
 * sees it. A renderer is a browser context; it is not trusted input.
 */

const deviceId = z.string().min(1).max(256);
const filePath = z.string().min(1).max(4096);

export const intentSchema = z.discriminatedUnion('type', [
  /** Start/refresh discovery. Discovery runs continuously anyway; this is the "Search again" button. */
  z.object({ type: z.literal('discovery.rescan') }),
  z.object({ type: z.literal('device.select'), deviceId }),
  /** Renderer cannot open a file dialog itself; main does, then reports the chosen path. */
  z.object({ type: z.literal('file.select'), path: filePath }),
  z.object({ type: z.literal('file.clear') }),
  z.object({ type: z.literal('cast.start') }),
  /**
   * *Resume from 0:32:10* — the same cast, loaded at the remembered position (PRD 16c).
   * A separate intent rather than a parameter on `cast.start`, so *Start from the
   * beginning* and *Resume* can never be confused for one another at the boundary.
   */
  z.object({ type: z.literal('cast.resume') }),
  z.object({ type: z.literal('cast.stop') }),
  z.object({ type: z.literal('playback.play') }),
  z.object({ type: z.literal('playback.pause') }),
  /** Emitted once on drag release, never during the drag. */
  z.object({ type: z.literal('playback.seek'), positionSec: z.number().finite().min(0) }),
  /**
   * M5a: move the television's volume. **Sent on every step of a drag, not on release.**
   *
   * The opposite of `playback.seek`, and deliberately so. A seek is coalesced in the
   * renderer because an intermediate position is a *place the founder never wanted to be*;
   * an intermediate volume is a level they are listening to right now, so a drag that only
   * spoke on release would be silent under the finger. The flood it would otherwise cause
   * is stopped in the engine instead, by the device's own round trip (23a): one command on
   * the wire at a time, one pending value behind it, and everything else overwritten.
   *
   * Bounded to 0–1 because that is the protocol's own range. A television is free to clamp
   * or quantise inside it, and whatever it answers is what the app shows (23b).
   */
  z.object({ type: z.literal('volume.set'), level: z.number().finite().min(0).max(1) }),
  /**
   * M5a: mute or unmute — **its own control, not the slider at zero.**
   *
   * The founder's ruling, question 42, and the television's own behaviour agrees with it:
   * `muted` and `level` are two independent facts, so muting does not zero the level and
   * unmuting brings the room back **without CastGood remembering anything** (23f). That is
   * why this intent carries the flag it wants rather than being a level of 0 — a mute
   * implemented as 0 would destroy the number the set is holding for us, and then unmuting
   * really would need a memory, which 23f forbids.
   */
  z.object({ type: z.literal('volume.mute'), muted: z.boolean() }),
  /**
   * One press of Back 30s / Forward 30s. The engine owns the arithmetic and the clamping,
   * because the renderer holds no position of its own to add 30 to (PRD 6f, 6i).
   */
  z.object({
    type: z.literal('playback.skip'),
    // Bounded so a renderer bug cannot ask for a jump of 10^9 seconds. Generous next to
    // the ±30 s the UI actually sends.
    deltaSec: z.number().finite().min(-3_600).max(3_600),
  }),
  /**
   * The two halves of the 20-minute confirmation (7f, 7g), and two intents rather than one
   * with a boolean: *Not now* must be impossible to confuse with *Start* at the boundary,
   * because one of them writes gigabytes to the founder's disk and the other must write
   * nothing at all.
   */
  z.object({ type: z.literal('preparation.confirm') }),
  z.object({ type: z.literal('preparation.decline') }),
  z.object({ type: z.literal('preparation.cancel') }),
  /**
   * The founder chose a subtitle source from the control (18a).
   *
   * `sourceId` is an id the engine put in the snapshot, and it is checked against the list
   * the engine is holding — a renderer is a browser context and an id that arrived over IPC
   * could name anything. Bounded here so a malformed one is refused at the boundary rather
   * than reaching a `Map` lookup; an unknown-but-well-formed one is refused by the engine,
   * which is the only place that knows what the current list is.
   */
  z.object({ type: z.literal('subtitles.select'), sourceId: z.string().min(1).max(4_352) }),
  /**
   * *Choose a file…* (18c). The renderer cannot open a file dialog, so main does and reports
   * the path — exactly as `file.select` does for the film.
   *
   * The file is used **where it lives**: nothing is moved, copied or renamed into the
   * founder's film folder — and nothing is written anywhere else either, since the track
   * CastGood serves is a cue list held in memory (20g, ADR 2026-08-27).
   */
  z.object({ type: z.literal('subtitles.chooseFile'), path: filePath }),
  /** Back to **Off** — the state every film starts in and returns to (19a). */
  z.object({ type: z.literal('subtitles.clear') }),
  /**
   * One press of **earlier** or **later** — story 20's nudge.
   *
   * `steps`, not milliseconds: the size of a nudge is a product decision that belongs to
   * the engine (`SUBTITLES.nudgeStepSeconds`, revisable after one real evening), and a
   * renderer that could name its own offset would be a second place that number lives.
   * Bounded well past the ±1 a button sends, so a renderer bug cannot ask for a jump of
   * a thousand steps — the engine clamps to ±30 s regardless (20e).
   */
  z.object({
    type: z.literal('subtitles.nudge'),
    steps: z.number().int().min(-8).max(8),
  }),
  /** **Reset** — back to *in sync* in one press and one swap (20e). */
  z.object({ type: z.literal('subtitles.resetTiming') }),
  /**
   * 18l: the television never fetched the declared track, and the founder wants the words.
   *
   * No payload — there is exactly one track it could be about, and the engine is the only
   * thing that knows which. A press with nothing to retry is ignored, not an error.
   */
  z.object({ type: z.literal('subtitles.retry') }),
  /**
   * Story 25. Writes a redacted report of this run and opens the folder it is in.
   *
   * ⚠️ **It carries nothing.** No destination, no address, no "share with" — there is
   * deliberately nothing in this shape that could grow into somewhere to send it, and
   * `test/architecture/no-telemetry.test.ts` is what stops one being added.
   */
  z.object({ type: z.literal('diagnostics.export') }),
  /**
   * The queue — M5b step 1. **None of these reaches a television.**
   *
   * 24c and 24ab both promise that reordering and clicking send nothing on the wire. The
   * queue model has no way to send (its only import is its own sort function), and these
   * intents carry nothing a session could act on: an id and, for a move, a destination.
   */
  z.object({ type: z.literal('queue.add'), paths: z.array(filePath).min(1) }),
  z.object({
    type: z.literal('queue.move'),
    id: z.string().min(1),
    toIndex: z.number().int().min(0),
  }),
  z.object({ type: z.literal('queue.remove'), id: z.string().min(1) }),
  z.object({ type: z.literal('queue.select'), id: z.string().min(1) }),
]);

export type Intent = z.infer<typeof intentSchema>;
export type IntentType = Intent['type'];

export interface IntentParseSuccess {
  ok: true;
  intent: Intent;
}
export interface IntentParseFailure {
  ok: false;
  /** Safe to log. Never returned to the renderer verbatim. */
  reason: string;
}

export function parseIntent(value: unknown): IntentParseSuccess | IntentParseFailure {
  const result = intentSchema.safeParse(value);
  if (result.success) return { ok: true, intent: result.data };
  return { ok: false, reason: z.prettifyError(result.error) };
}
