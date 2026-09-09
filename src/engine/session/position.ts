import type { PlaybackPosition } from '../types.js';
import { TIMING } from '../config.js';

/**
 * Where the playhead is, and why it does not drift.
 *
 * Two clocks are in play and only one of them is trustworthy. The device reports
 * `currentTime` about once a second; between reports we extrapolate so the readout
 * moves smoothly. Extrapolation anchors on a **monotonic** timestamp taken the instant
 * the report arrived — never the wall clock, which jumps when the PC resumes from sleep
 * and would otherwise teleport the playhead mid-film.
 *
 * Drift is impossible by construction rather than by careful arithmetic: every report
 * re-anchors the estimate. Over a 2-hour film that is ~7,200 corrections, so the error
 * at 1:55:00 is exactly the error at 0:05:00 — one round trip's worth.
 *
 * `divergenceSec` on each anchor is the *measurement* the PRD's ≤1 s accuracy target is
 * read from: it is what we predicted the moment before the device told us the truth.
 */

export interface PositionReport {
  readonly reportedSec: number;
  /** Monotonic ms, stamped when the status arrived off the socket. */
  readonly receivedAtMono: number;
  readonly durationSec: number | null;
  /** Only a playing device advances between reports. */
  readonly playing: boolean;
}

export interface AnchorResult {
  /** How far our display was from the device at the moment of the report. `null` on the first. */
  readonly divergenceSec: number | null;
  /** True when the divergence exceeded the 1 s tolerance and we snapped to the device. */
  readonly snapped: boolean;
  /**
   * True when a seek was in flight and this report was still describing the *old* position,
   * so the display kept the requested one instead. See `holdForSeek`.
   */
  readonly heldForSeek: boolean;
  /** True when this report landed on the seek target and the hold was released. */
  readonly seekConfirmed: boolean;
}

export interface PositionTracker {
  anchor(report: PositionReport): AnchorResult;
  /** The smooth, displayable position at this monotonic instant. */
  positionAt(monoMs: number): number;
  /**
   * Stops the clock where it is. Called when a session ends: without it the readout on the
   * *Stopped* screen goes on creeping upwards for a film that is no longer playing, because
   * the last thing the device said was "PLAYING" and nothing ever contradicts it.
   */
  freeze(monoMs: number): void;
  /**
   * Puts the playhead at a requested position and *holds* it there until the device
   * agrees, within `positionToleranceSec`.
   *
   * This is the one place the display is allowed to disagree with the device, and it
   * exists because the alternative is worse: a device answers a SEEK with one or two more
   * statuses describing where the film still is, and following those makes the readout
   * snap back to the old position and then jump forward again. PRD 6e forbids exactly
   * that. The hold is not open-ended — the supervisor gives up on it after
   * `seekConfirmMs`, retries once, and then calls `releaseSeekHold()` so device truth
   * wins the display back.
   */
  holdForSeek(targetSec: number, monoMs: number): void;
  /**
   * States the film's length ourselves, and stops believing the device about it.
   *
   * **CastGood owns the clock** (10c). A growing HLS conversion is a *live* stream as far
   * as the Default Media Receiver is concerned, so it has no duration to report and does not
   * invent one: `media.duration: -1` in all 72 status frames of SPIKE-1, on the Ultra and
   * again on the `AI PONT`, before **and** after `ENDLIST`. Without this the scrubber has no
   * length, which means no ready region, no unavailable region and no dragging at all.
   *
   * Progressive files never call it: there the device's own report is better than our
   * memory of it, and this is deliberately not a general-purpose override.
   */
  seedDuration(seconds: number): void;
  /**
   * Abandons the hold: the next report is believed, whatever it says.
   *
   * `restore` puts the playhead back where the film really was — for a jump that was never
   * sent, and for giving up on one the device never acknowledged. Without it the readout
   * keeps showing a destination until some later status happens to correct it, which on a
   * device that reports no position at all is never.
   */
  releaseSeekHold(monoMs: number, restore?: boolean): void;
  /** The position we are holding for, or `null` when the display is following the device. */
  readonly seekTargetSec: number | null;
  readonly position: PlaybackPosition | null;
  readonly durationSec: number;
  reset(): void;
}

export function createPositionTracker(): PositionTracker {
  let anchoredSec = 0;
  let anchoredAtMono = 0;
  let duration = 0;
  /** True once `seedDuration` has spoken. A device report may not overrule ours (10c). */
  let durationIsOurs = false;
  let playing = false;
  let hasAnchor = false;
  let seekTarget: number | null = null;
  /** Where the film really was when the hold started, so an abandoned jump can undo itself. */
  let before: { sec: number; atMono: number; playing: boolean; had: boolean } | null = null;

  function estimate(monoMs: number): number {
    if (!hasAnchor) return 0;
    const elapsedSec = playing ? Math.max(0, (monoMs - anchoredAtMono) / 1000) : 0;
    const value = anchoredSec + elapsedSec;
    if (duration > 0) return Math.min(Math.max(value, 0), duration);
    return Math.max(value, 0);
  }

  return {
    anchor(report) {
      const predicted = hasAnchor ? estimate(report.receivedAtMono) : null;
      const divergenceSec = predicted === null ? null : Math.abs(predicted - report.reportedSec);
      if (!durationIsOurs && report.durationSec !== null && report.durationSec > 0) {
        duration = report.durationSec;
      }

      // A seek is in flight and this report is still describing where the film was. Keep
      // the requested position on screen and say so; the caller decides how long to wait.
      if (seekTarget !== null) {
        const reachedTarget = Math.abs(report.reportedSec - seekTarget) <= TIMING.seekToleranceSec;
        if (!reachedTarget) {
          // The device is *playing* from somewhere else, so the hold must not advance:
          // freeze at the target rather than extrapolating away from it.
          playing = false;
          return { divergenceSec, snapped: false, heldForSeek: true, seekConfirmed: false };
        }
        seekTarget = null;
        anchoredSec = Math.max(0, report.reportedSec);
        anchoredAtMono = report.receivedAtMono;
        playing = report.playing;
        hasAnchor = true;
        return { divergenceSec, snapped: false, heldForSeek: false, seekConfirmed: true };
      }

      anchoredSec = Math.max(0, report.reportedSec);
      anchoredAtMono = report.receivedAtMono;
      playing = report.playing;
      hasAnchor = true;

      return {
        divergenceSec,
        snapped: divergenceSec !== null && divergenceSec > TIMING.positionToleranceSec,
        heldForSeek: false,
        seekConfirmed: false,
      };
    },

    positionAt: estimate,

    freeze(monoMs: number) {
      if (!hasAnchor) return;
      anchoredSec = estimate(monoMs);
      anchoredAtMono = monoMs;
      playing = false;
    },

    seedDuration(seconds) {
      if (!Number.isFinite(seconds) || seconds <= 0) return;
      duration = seconds;
      durationIsOurs = true;
    },

    holdForSeek(targetSec, monoMs) {
      // Remember where the film actually was, once — a second tap inside the same window
      // must not overwrite it with the first tap's destination, or abandoning the jump
      // would fall back to a place the film never reached either.
      if (seekTarget === null) {
        before = { sec: estimate(monoMs), atMono: monoMs, playing, had: hasAnchor };
      }
      seekTarget = Math.max(0, duration > 0 ? Math.min(targetSec, duration) : targetSec);
      anchoredSec = seekTarget;
      anchoredAtMono = monoMs;
      // Held, not running: a held playhead that kept extrapolating would drift away from
      // the very position we are claiming to be at.
      playing = false;
      hasAnchor = true;
    },

    releaseSeekHold(monoMs, restore = false) {
      const held = before;
      seekTarget = null;
      before = null;
      // `restore` is for a jump that was **never sent**. The film did not move, so the
      // readout must go back to where it really is rather than keep claiming a destination
      // nothing was ever asked to reach.
      //
      // Without it, giving up on a seek leaves the target on screen until the next status
      // re-anchors — which is a moment on a healthy device and *forever* on one that
      // reports no position at all. That is 6e's "a seek that failed is never displayed as
      // one that worked" failing in exactly the firmware case the fake is told to model.
      if (!restore || held === null || !held.had) return;
      const elapsedSec = held.playing ? Math.max(0, (monoMs - held.atMono) / 1000) : 0;
      anchoredSec = Math.max(0, held.sec + elapsedSec);
      anchoredAtMono = monoMs;
      playing = held.playing;
    },

    get seekTargetSec() {
      return seekTarget;
    },

    get position(): PlaybackPosition | null {
      if (!hasAnchor) return null;
      return {
        reportedSec: anchoredSec,
        reportedAtMono: anchoredAtMono,
        durationSec: duration,
      };
    },

    get durationSec() {
      return duration;
    },

    reset() {
      anchoredSec = 0;
      anchoredAtMono = 0;
      duration = 0;
      // A new session is a new film: our claim about the last one must not outlive it.
      durationIsOurs = false;
      playing = false;
      hasAnchor = false;
      seekTarget = null;
      before = null;
    },
  };
}
