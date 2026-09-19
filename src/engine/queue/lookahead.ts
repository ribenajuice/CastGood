import { LOOKAHEAD, PREPARATION } from '../config.js';
import type { SessionFlags, SessionState } from '../types.js';

/**
 * **When a look-ahead may run, and the exact moment it must stop** — M5b, criteria 24g,
 * 24i and 24k.
 *
 * Everything here is a pure function over one observation of the film on screen. That is
 * not tidiness: 24i is graded on *"the 5 s is measured from the device's first missed
 * sample rather than from our own decision"*, and the only way to prove that in WSL is for
 * the rule to be arithmetic over device reports that a test can write down.
 *
 * ## The three traps, named
 *
 * **(1) `reconnecting`, `reattaching`, `yielded` and `networkDown` are flags, not states.**
 * A film whose connection has just died is still `state: 'playing'` — criterion 11a insists
 * on it, because the scrubber and the file name must not move. A rule written as
 * `state === 'playing'` therefore reads *"everything is fine"* through the whole of an
 * outage, which is exactly the shape of the defect this product shipped once already. So
 * the flags are checked **first**, before the state is looked at at all.
 *
 * **(2) The hesitation clock starts at the device's report, not at ours.** A television
 * reports about once a second, so the first *evidence* of a frozen picture is the second
 * sample carrying the same position — and the freeze began at the **first** of them. The
 * anchor below keeps that earlier timestamp, so the 5-second budget is spent from where the
 * picture actually stopped. Starting it at the sample that revealed the freeze would quietly
 * make the promise 5 s + one report.
 *
 * **(3) A paused film is not a hesitating film.** 24k names *stopped, idle, reconnecting,
 * yielded* — pause is in none of those lists, and a device that says `PAUSED` is not stalling,
 * it is paused (the same ruling `selftest/stalls.ts` already makes for counting stalls). So a
 * pause stops a look-ahead from **starting** and does not abandon one that is running: there
 * is no picture to protect while the picture is deliberately still. It does reset the clean
 * clock, so a film resumed has to earn its 60 s again.
 */

/**
 * One `MEDIA_STATUS` from the television, as it arrived — never our extrapolation of it.
 *
 * `monoMs` is what dates a frozen picture, and it is the **device's** report time. Two
 * observations carrying the same report carry no new evidence, and the watch below says so
 * rather than reading the same sample twice as two seconds of a freeze.
 */
export interface DeviceReport {
  readonly monoMs: number;
  readonly playerState: string | null;
  readonly positionSec: number | null;
}

/** One look at the film on screen, as the engine knows it at that instant. */
export interface PlaybackObservation {
  /** Now, on the engine's monotonic clock. */
  readonly monoMs: number;
  /** The session's own state. Never sufficient on its own — see trap (1). */
  readonly state: SessionState;
  readonly flags: SessionFlags;
  /** 10i's frontier guard is holding the picture. A held film is a hesitating film. */
  readonly heldByGuard: boolean;
  /**
   * The **playing** film's own conversion has not fully exited — 24k(a), *finishing remux
   * included*. `ARCHITECTURE.md`'s *"one conversion at a time. No queue, no worker pool"* is
   * kept literally true by this one flag.
   */
  readonly currentConversionOpen: boolean;
  /**
   * Somebody pressed something — a pause, a seek — and the picture is *expected* to stop.
   *
   * The same exclusion `detectStalls` makes for `commanded` windows, and for the same
   * reason: counting a founder's own pause as a hesitation would abandon a job every time
   * they answered the door.
   */
  readonly commanded: boolean;
  /** The television's last word. `null` before it has said anything. */
  readonly report: DeviceReport | null;
}

/** Why the film on screen is hesitating. Logged; the response is the same for all four. */
export type HesitationReason = 'buffering' | 'interrupted' | 'held' | 'frozen';

/** Why there is no look-ahead running. Every one of them is a sentence in 24i or 24k. */
export type LookaheadBlock =
  'nothing-playing' | 'hesitating' | 'current-conversion' | 'settling' | 'nothing-to-prepare';

export interface LookaheadWatch {
  /** When the picture last **started** moving cleanly. `null` whenever it is not. */
  readonly cleanSinceMono: number | null;
  /**
   * The device's own first missed sample — trap (2). `null` when nothing is wrong.
   *
   * This is the instant the 5-second abandonment budget is spent from.
   */
  readonly hesitationSinceMono: number | null;
  readonly reason: HesitationReason | null;
  /**
   * The first report carrying the position the device is currently reporting.
   *
   * Kept rather than "the previous report" so a freeze that lasts ten reports is still
   * dated from the first of them.
   */
  readonly anchor: { readonly positionSec: number; readonly monoMs: number } | null;
  /**
   * The report this watch has already read.
   *
   * ⚠️ **Without it the rule invents freezes.** The engine looks at the film on every
   * session change as well as on every device report, so the same sample is seen several
   * times over — and a rule that compared a report with itself would find the position
   * unchanged and declare the picture frozen a few milliseconds after a device said it was
   * playing perfectly well.
   */
  readonly seenReportMonoMs: number | null;
}

export const NO_WATCH: LookaheadWatch = {
  cleanSinceMono: null,
  hesitationSinceMono: null,
  reason: null,
  anchor: null,
  seenReportMonoMs: null,
};

/** States in which there is no film to protect and no look-ahead may run at all (24k). */
const DEAD_STATES: readonly SessionState[] = ['idle', 'connecting', 'loading', 'ended', 'stopped'];

/** A device saying one of these is not a device with a frozen picture. */
const NOT_PLAYING = new Set(['PAUSED', 'IDLE', 'UNKNOWN']);

function interrupted(flags: SessionFlags): boolean {
  return flags.reconnecting || flags.reattaching || flags.yielded || flags.networkDown;
}

/**
 * Step the watch on one observation.
 *
 * Total and pure: hand it the same sequence twice and it answers the same thing twice,
 * which is what lets 24i be graded against a written-down trace rather than against a run.
 */
export function watchPlayback(watch: LookaheadWatch, obs: PlaybackObservation): LookaheadWatch {
  const hesitate = (reason: HesitationReason, sinceMono: number): LookaheadWatch => ({
    ...watch,
    cleanSinceMono: null,
    // **The earliest evidence wins.** A freeze that is then joined by a reconnection is
    // still dated from the freeze — taking the later of the two would hand ourselves back
    // the seconds trap (2) exists to stop us claiming.
    hesitationSinceMono:
      watch.hesitationSinceMono === null
        ? sinceMono
        : Math.min(watch.hesitationSinceMono, sinceMono),
    reason: watch.reason ?? reason,
  });

  // Trap (1): the flags, before anything else. They ride on top of `playing`.
  if (interrupted(obs.flags)) return hesitate('interrupted', obs.monoMs);

  if (obs.state === 'buffering') {
    return hesitate('buffering', obs.report?.monoMs ?? obs.monoMs);
  }

  if (DEAD_STATES.includes(obs.state)) {
    // No film. Nothing to date a hesitation from, and the clean clock starts again from
    // scratch whenever one next appears.
    return NO_WATCH;
  }

  if (obs.state !== 'playing') {
    // Paused or seeking — trap (3). Not a hesitation, and not clean playing either.
    return { ...NO_WATCH, seenReportMonoMs: watch.seenReportMonoMs };
  }

  if (obs.heldByGuard) return hesitate('held', obs.monoMs);

  const report = obs.report;
  if (report === null || report.monoMs === watch.seenReportMonoMs) {
    // No new word from the television. Nothing about the picture has been learned, so
    // nothing about the picture changes — including a hesitation already running.
    return watch;
  }

  // From here on the session believes the film is playing and the device has just spoken.
  // The only thing that decides whether it really is playing is its own position.
  const seen = { ...watch, seenReportMonoMs: report.monoMs };
  const believedPlaying = !NOT_PLAYING.has((report.playerState ?? 'UNKNOWN').toUpperCase());
  if (!believedPlaying) {
    // The device says PAUSED or IDLE while we say playing. That is a disagreement to
    // resolve elsewhere; here it is simply not clean playing, and not a frozen picture.
    return { ...NO_WATCH, seenReportMonoMs: report.monoMs };
  }

  if (obs.commanded || report.positionSec === null) {
    // A press is outstanding, or the status carried no position: no evidence either way.
    // The clean clock is held rather than reset — a seek is not a failure of the film.
    return { ...seen, hesitationSinceMono: null, reason: null, anchor: null };
  }

  const anchor = watch.anchor;
  const moved =
    anchor === null ||
    Math.abs(report.positionSec - anchor.positionSec) > PREPARATION.stallToleranceSec;

  if (!moved) {
    // The same position twice: the picture stopped at `anchor.monoMs`, not now.
    return { ...hesitate('frozen', anchor.monoMs), seenReportMonoMs: report.monoMs };
  }

  return {
    // A picture that has just started moving again starts the 60 s from **now**, which is
    // 24i's *"does not start again until the film has been playing cleanly for 60 s"*.
    cleanSinceMono: watch.cleanSinceMono ?? report.monoMs,
    hesitationSinceMono: null,
    reason: null,
    anchor: { positionSec: report.positionSec, monoMs: report.monoMs },
    seenReportMonoMs: report.monoMs,
  };
}

export type LookaheadAction =
  /** Begin the one job 24g allows. */
  | { readonly kind: 'start' }
  /** A job is running and everything is as it should be. */
  | { readonly kind: 'continue' }
  /** Nothing is running and nothing may start. */
  | { readonly kind: 'wait'; readonly why: LookaheadBlock }
  /**
   * Stop the job, remove its partial work, and start the 60 s again (24i).
   *
   * `sinceMono` is what the deadline is measured from, and it is the **device's** number
   * whenever there is one.
   */
  | {
      readonly kind: 'abandon';
      readonly why: LookaheadBlock;
      readonly reason: HesitationReason | null;
      readonly sinceMono: number;
      readonly deadlineMono: number;
    };

export interface LookaheadInputs {
  readonly hasJob: boolean;
  /** Is there a next item that actually needs preparing, and is not prepared already? */
  readonly hasWork: boolean;
}

/** When an abandonment must be complete by. 24i's whole promise, as one line of arithmetic. */
export function abandonDeadline(sinceMono: number): number {
  return sinceMono + LOOKAHEAD.abandonWithinMs;
}

/**
 * The decision, in the order the criteria are written.
 *
 * Read it top to bottom: everything that stops a job comes before everything that starts
 * one, so there is no ordering in which both could be true.
 */
export function decide(
  watch: LookaheadWatch,
  obs: PlaybackObservation,
  inputs: LookaheadInputs,
): LookaheadAction {
  const stop = (
    why: LookaheadBlock,
    sinceMono: number,
    reason: HesitationReason | null,
  ): LookaheadAction =>
    inputs.hasJob
      ? { kind: 'abandon', why, reason, sinceMono, deadlineMono: abandonDeadline(sinceMono) }
      : { kind: 'wait', why };

  // 24i: any hesitation at all, from the device's own first missed sample.
  if (watch.hesitationSinceMono !== null) {
    return stop('hesitating', watch.hesitationSinceMono, watch.reason);
  }

  // 24k: stopped, idle — and everything else where no film is on a television.
  if (DEAD_STATES.includes(obs.state)) return stop('nothing-playing', obs.monoMs, null);

  // 24k(a): a conversion feeding the film on screen never shares this machine with one
  // that isn't — finishing remux included.
  if (obs.currentConversionOpen) return stop('current-conversion', obs.monoMs, null);

  // Trap (3): paused or seeking. A running job is left alone; a new one may not begin.
  if (obs.state !== 'playing') {
    return inputs.hasJob ? { kind: 'continue' } : { kind: 'wait', why: 'nothing-playing' };
  }

  if (inputs.hasJob) return { kind: 'continue' };
  if (!inputs.hasWork) return { kind: 'wait', why: 'nothing-to-prepare' };

  const cleanFor = watch.cleanSinceMono === null ? 0 : obs.monoMs - watch.cleanSinceMono;
  if (cleanFor < LOOKAHEAD.cleanPlayBeforeStartMs) return { kind: 'wait', why: 'settling' };

  return { kind: 'start' };
}
