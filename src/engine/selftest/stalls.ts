import { PREPARATION } from '../config.js';

/**
 * **The instrument.** Counting frozen pictures from the device's own reports, and nothing else.
 *
 * This file exists because of criterion 10j, and 10j exists because of a specific failure:
 * on 2026-08-21 a run in which the founder's picture froze eight times, for 46 seconds in
 * 343, reported *"assumption 1: confirmed"* and *"assumption 2: confirmed"*. Both statements
 * were true and beside the point — the spike had no assertion about stalling at all, so a
 * run that produced exactly the failure story 10 exists to prevent came back green. That was
 * the fourth misleading summary from that one script and the second "confirmed" that could
 * not have failed.
 *
 * Three rules follow, and they are the whole design:
 *
 *  1. **The evidence is the device's own position samples**, never our guard's opinion of
 *     them. Our guard could be wrong in exactly the way that matters — believing it held a
 *     picture that in fact froze — and an instrument that reads it would agree with it.
 *  2. **A stall has a definition and a number**: the reported position failing to advance
 *     for ≥ 2 s while the app believes the film is playing and nothing was pressed. 10b had
 *     no definition until 2026-08-21, so nothing could count them.
 *  3. **An announced hold is not a stall.** *"A held film is announced, a stall is not"* —
 *     when the guard holds the picture and says *Still preparing — back in about…*, the
 *     founder knows what is happening and is told when it ends. What 10b forbids is the
 *     picture stopping with nothing said.
 *
 * Everything here is pure, so it can be run over a **recorded** trace as a fixture — which
 * is how 10j's calibration works: the detector must find the 2026-08-21 run dirty before any
 * verdict it produces about a new run is worth reading.
 */

export interface PositionSample {
  /** Monotonic milliseconds, stamped when the status arrived off the socket. */
  readonly monoMs: number;
  /** The device's own `currentTime`. `null` when the status carried none. */
  readonly positionSec: number | null;
  /** The device's own `playerState`: PLAYING, BUFFERING, PAUSED, IDLE. */
  readonly playerState: string | null;
}

/**
 * A stretch of time in which a freeze does not count, and why there are two kinds.
 *
 * `commanded` — somebody pressed something: a pause, a seek, a stop. The picture is
 * *expected* to stop, and counting that would make every scenario report stalls it caused
 * itself.
 *
 * `announced` — the guard held the picture and the app said so on screen. That is the
 * behaviour 10i asks for, not the behaviour 10b forbids.
 */
export interface ExcludedWindow {
  readonly fromMs: number;
  readonly toMs: number;
  readonly why: 'commanded' | 'announced';
}

export interface Stall {
  /** Where in the film the picture stopped — the device's own number. */
  readonly atSec: number;
  readonly startedAtMs: number;
  /**
   * How long it was frozen for, **measured between the first and last report of the same
   * position**, which makes it a lower bound rather than a guess.
   *
   * A device reporting once a second can only prove a freeze as long as the reports it made
   * during it; the true freeze extends up to one report either side. Under-stating is the
   * right direction for an instrument whose whole job is to be believed.
   */
  readonly seconds: number;
  /** How many device reports carried the same position. Two is the minimum that proves one. */
  readonly samples: number;
}

export interface StallReport {
  readonly stalls: readonly Stall[];
  readonly count: number;
  readonly totalSeconds: number;
  readonly longestSeconds: number;
  /**
   * Every `playerState` the device reported, counted.
   *
   * **Read the histogram, never the verdict** — this is the line from the 2026-08-21
   * post-mortem, and it is here because the number that mattered that night (17 BUFFERING
   * against 48 PLAYING) was in the log all along with nothing pointing at it.
   */
  readonly playerStates: Readonly<Record<string, number>>;
  /** How many device reports the verdict was computed from. Zero is never a pass. */
  readonly samples: number;
}

const NOT_PLAYING = new Set(['PAUSED', 'IDLE', 'UNKNOWN']);

/**
 * Count the frozen pictures in a run.
 *
 * `minSeconds` is 10b's own two seconds and is a parameter only so a test can show the
 * threshold is doing something rather than that the trace happens to be clean.
 */
export function detectStalls(
  samples: readonly PositionSample[],
  options: {
    readonly excluded?: readonly ExcludedWindow[];
    readonly minSeconds?: number;
    readonly toleranceSec?: number;
    /**
     * Only for a trace that starts at the LOAD. See `isPreRoll` below — it is off by
     * default because a trace that begins mid-film begins at a moment the film was already
     * playing, and there the very first freeze is a real one.
     */
    readonly excludePreRoll?: boolean;
  } = {},
): StallReport {
  const minSeconds = options.minSeconds ?? PREPARATION.stallSeconds;
  const tolerance = options.toleranceSec ?? PREPARATION.stallToleranceSec;
  const excluded = options.excluded ?? [];

  const playerStates: Record<string, number> = {};
  for (const sample of samples) {
    const key = sample.playerState ?? 'none';
    playerStates[key] = (playerStates[key] ?? 0) + 1;
  }

  const isExcluded = (atMs: number): boolean =>
    excluded.some((window) => atMs >= window.fromMs && atMs <= window.toMs);

  /**
   * The pre-roll — everything before the picture first moves — is not a stall.
   *
   * **Opt-in (`excludePreRoll`), because it is only true of a trace that starts at the
   * LOAD.** A trace spliced from the middle of a film starts at a moment the picture was
   * already moving, and there the first freeze is a real one — two of this file's own
   * scripted cases are exactly that shape.
   *
   * 10b promises zero stalls **attributable to preparation**. The window between the load
   * and the first frame is not: on 2026-08-25 the bedroom Chromecast took **2.49 s** to
   * start with the conversion 602 s ahead at 6.06x, and **3.31 s** with it throttled to
   * 0.5x. Preparation was six times ahead of playback in the first case and there was no
   * frontier pressure available to cause it, so a window that appears in both cannot be
   * attributed to preparation. It is press-to-picture, which `firstCastToPictureMs` and
   * `convertPressToPictureMs` already promise against.
   *
   * Without this the threshold decides the verdict rather than the behaviour: those two
   * runs differ by 0.8 s of startup and landed on opposite sides of the two-second line,
   * so the same product behaviour passed once and failed once.
   *
   * **It cannot hide a film that never started.** If the position never advances there is
   * no first movement, nothing is excluded, and the whole dead run is reported as the one
   * enormous stall it is — which is the 2026-08-24 signature this project already pays for
   * missing once. The 2026-08-21 calibration trace is untouched: its own pre-roll is
   * 1.75 s, already under the threshold, so 10j's 6 / 66.8 / 25.6 are unchanged and the
   * calibration test is the proof.
   */
  const wantPreRoll = options.excludePreRoll ?? false;
  const firstPositioned = samples.find((sample) => sample.positionSec !== null);
  const startedAt = firstPositioned?.positionSec ?? null;
  const firstMovementMs =
    startedAt === null
      ? null
      : (samples.find(
          (sample) =>
            sample.positionSec !== null && Math.abs(sample.positionSec - startedAt) > tolerance,
        )?.monoMs ?? null);
  const isPreRoll = (atMs: number): boolean =>
    wantPreRoll && firstMovementMs !== null && atMs < firstMovementMs;

  interface Group {
    at: number;
    startedAtMs: number;
    endedAtMs: number;
    samples: number;
  }
  const groups: Group[] = [];
  let current: Group | null = null;
  for (const sample of samples) {
    // A device that says it is paused is not stalling: it is paused. A device that says
    // BUFFERING **is** stalling — that is precisely the frozen picture 10b is about, and
    // treating the receiver's own word for it as an excuse would be the instrument agreeing
    // with the failure.
    const believedPlaying = !NOT_PLAYING.has((sample.playerState ?? 'UNKNOWN').toUpperCase());
    if (
      sample.positionSec === null ||
      !believedPlaying ||
      isExcluded(sample.monoMs) ||
      isPreRoll(sample.monoMs)
    ) {
      current = null;
      continue;
    }
    if (current !== null && Math.abs(sample.positionSec - current.at) <= tolerance) {
      current.endedAtMs = sample.monoMs;
      current.samples += 1;
      continue;
    }
    current = {
      at: sample.positionSec,
      startedAtMs: sample.monoMs,
      endedAtMs: sample.monoMs,
      samples: 1,
    };
    groups.push(current);
  }

  const stalls: Stall[] = groups
    .map((group) => ({
      atSec: Math.round(group.at * 10) / 10,
      startedAtMs: group.startedAtMs,
      seconds: Math.round(((group.endedAtMs - group.startedAtMs) / 1000) * 10) / 10,
      samples: group.samples,
    }))
    .filter((stall) => stall.seconds >= minSeconds);

  return {
    stalls,
    count: stalls.length,
    totalSeconds: Math.round(stalls.reduce((total, stall) => total + stall.seconds, 0) * 10) / 10,
    longestSeconds: stalls.reduce((longest, stall) => Math.max(longest, stall.seconds), 0),
    playerStates,
    samples: samples.length,
  };
}

/**
 * Turn the engine's own `position.sample` log records into samples.
 *
 * The records are written the instant a `MEDIA_STATUS` arrives off the socket, carrying the
 * device's `playerState`, its `currentTime` and a monotonic stamp — so this is the device's
 * report and not our extrapolation of it, which is what 10b requires.
 */
export function samplesFromRecords(records: readonly Record<string, unknown>[]): PositionSample[] {
  const out: PositionSample[] = [];
  for (const record of records) {
    if (record['event'] !== 'position.sample') continue;
    const monoMs = record['monoMs'];
    if (typeof monoMs !== 'number') continue;
    const deviceSec = record['deviceSec'];
    const playerState = record['playerState'];
    out.push({
      monoMs,
      positionSec: typeof deviceSec === 'number' ? deviceSec : null,
      playerState: typeof playerState === 'string' ? playerState : null,
    });
  }
  return out;
}
