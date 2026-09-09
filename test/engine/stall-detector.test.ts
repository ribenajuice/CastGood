import { describe, expect, it } from 'vitest';
import { detectStalls, samplesFromRecords } from '../../src/engine/selftest/stalls.js';
import type { ExcludedWindow, PositionSample } from '../../src/engine/selftest/stalls.js';
import { STARVED_RUN } from './fixtures/starved-run-2026-08-21.js';

/**
 * **Criterion 10j: the instrument has to be able to fail, and here is it failing.**
 *
 * *"Given any verdict about stalls, then the thing that produced it must first have been
 * shown to fail on a run that really stalled."* The run is the recorded `--rate 0.7` trace
 * against the `AI PONT`; the spike that produced it reported both of its assumptions
 * "confirmed" while the founder's picture froze eight times.
 *
 * The one thing this file must never be allowed to do is report that trace as clean.
 */

const samples: PositionSample[] = STARVED_RUN.samples.map((sample) => ({
  monoMs: sample.monoMs,
  positionSec: sample.positionSec,
  playerState: sample.playerState,
}));

/**
 * The things the spike pressed, excluded exactly as a live run excludes them.
 *
 * Eight seconds after a command, because a seek on this device took up to 3.9 s to land and
 * a pause is followed by a stretch of quite deliberately frozen picture.
 */
const commanded: ExcludedWindow[] = STARVED_RUN.commands.map((command) => ({
  fromMs: command.monoMs - 500,
  toMs: command.monoMs + 8_000,
  why: 'commanded' as const,
}));

describe('the stall detector, against the run that really stalled (10j)', () => {
  const report = detectStalls(samples, { excluded: commanded });

  it('does not report the 2026-08-21 trace as clean', () => {
    // The failing condition, stated first because it is the one that matters: 10j fails if
    // the detector calls this run clean.
    expect(report.count).toBeGreaterThan(0);
    expect(report.totalSeconds).toBeGreaterThan(0);
  });

  it('finds at least the freezes STATUS recorded by hand, and measures them no smaller', () => {
    // STATUS's table for this run: eight freezes totalling 46 s, the worst 25.5 s, the first
    // long one at 70.8 s into the film and the last at 199.9 s.
    //
    // **The counts differ, and the difference is a finding rather than a discrepancy.** That
    // table was read by eye and counted every freeze, including three the founder would
    // barely notice; 10b's own definition counts only freezes of **2 s or more**, which is
    // six of them. Measured against the device's own reports the *total* is larger, not
    // smaller — 66.8 s against 46 — because the hand reading took each freeze's shortest
    // provable length and stopped there. So the instrument is stricter than the eye on
    // duration and looser on count, and this run is worse than it was recorded as being.
    expect(report.count).toBe(6);
    expect(report.totalSeconds).toBeGreaterThanOrEqual(46);
    expect(report.totalSeconds).toBe(66.8);
    expect(report.longestSeconds).toBeGreaterThanOrEqual(25.5);

    const positions = report.stalls.map((stall) => stall.atSec);
    // The three long freezes STATUS names, found at the same places in the film.
    expect(positions).toContain(70.8);
    expect(positions).toContain(133.7);
    expect(positions).toContain(199.9);
  });

  it('reports the histogram that nothing pointed at on the night', () => {
    // *"Read the `playerState` histogram, never the verdict."* 42 BUFFERING against 65
    // PLAYING across the whole wire trace: the number that mattered, in the log all along.
    expect(report.playerStates['BUFFERING']).toBe(42);
    expect(report.playerStates['PLAYING']).toBe(65);
    expect(report.samples).toBe(110);
  });

  it('would have called the same run clean if it read our own guard instead', () => {
    // The reason 10b insists the count comes from the device's samples: on that run *nothing
    // in our app had any idea*. There was no guard, nothing was paused, and every one of
    // these freezes happened while the app believed the film was playing perfectly.
    const believedPlaying = samples.filter(
      (sample) => sample.playerState === 'PLAYING' || sample.playerState === 'BUFFERING',
    );
    expect(believedPlaying.length).toBeGreaterThan(100);
  });
});

describe('the exclusions, on the trace and on a case where they bite', () => {
  it('changes nothing on this trace, and the docstring now says so', () => {
    // QA, 2026-08-21: every command in the recorded run lands after the last stall, so the
    // exclusions are inert here. Pinned rather than assumed, because the fixture's own
    // comment used to claim this trace exercised them — a check that could not have noticed.
    const withCommands = detectStalls(samples, { excluded: commanded });
    const without = detectStalls(samples);
    expect(without.count).toBe(withCommands.count);
    expect(without.totalSeconds).toBe(withCommands.totalSeconds);
    expect(without.longestSeconds).toBe(withCommands.longestSeconds);
    // …and the reason: the earliest command is later than the last freeze.
    const firstCommandMs = Math.min(...STARVED_RUN.commands.map((command) => command.monoMs));
    const lastStall = withCommands.stalls.at(-1);
    expect(lastStall?.startedAtMs ?? 0).toBeLessThan(firstCommandMs);
  });
});

describe('what the detector refuses to count', () => {
  it('does not count a picture that was paused, sought or stopped on purpose', () => {
    const scripted: PositionSample[] = [
      { monoMs: 0, positionSec: 10, playerState: 'PLAYING' },
      { monoMs: 1_000, positionSec: 11, playerState: 'PLAYING' },
      // A pause the founder pressed: five seconds of entirely correct frozen picture.
      { monoMs: 2_000, positionSec: 12, playerState: 'PAUSED' },
      { monoMs: 4_000, positionSec: 12, playerState: 'PAUSED' },
      { monoMs: 7_000, positionSec: 12, playerState: 'PAUSED' },
      { monoMs: 8_000, positionSec: 13, playerState: 'PLAYING' },
    ];
    expect(detectStalls(scripted).count).toBe(0);
  });

  it('does not count a hold the app announced — a held film is announced, a stall is not', () => {
    const scripted: PositionSample[] = [
      { monoMs: 0, positionSec: 10, playerState: 'PLAYING' },
      { monoMs: 2_000, positionSec: 10, playerState: 'BUFFERING' },
      { monoMs: 6_000, positionSec: 10, playerState: 'BUFFERING' },
      { monoMs: 10_000, positionSec: 11, playerState: 'PLAYING' },
    ];
    // Unannounced, this is a six-second stall and 10b forbids it outright…
    expect(detectStalls(scripted).count).toBe(1);
    // …and announced, it is the guard doing its job with a sentence on the screen.
    const announced: ExcludedWindow[] = [{ fromMs: 1_000, toMs: 9_000, why: 'announced' }];
    expect(detectStalls(scripted, { excluded: announced }).count).toBe(0);
  });

  it('counts a BUFFERING freeze, because that is exactly what the founder sees', () => {
    const scripted: PositionSample[] = [
      { monoMs: 0, positionSec: 30, playerState: 'PLAYING' },
      { monoMs: 2_500, positionSec: 30, playerState: 'BUFFERING' },
      { monoMs: 5_000, positionSec: 30.1, playerState: 'BUFFERING' },
      { monoMs: 7_000, positionSec: 31, playerState: 'PLAYING' },
    ];
    const report = detectStalls(scripted);
    expect(report.count).toBe(1);
    expect(report.stalls[0]?.seconds).toBeCloseTo(5, 1);
  });

  it('excludePreRoll drops the wait for the first frame, and only that', () => {
    // A load-anchored trace: nothing has moved yet, then the film starts and runs clean.
    const scripted: PositionSample[] = [
      { monoMs: 0, positionSec: 0, playerState: 'BUFFERING' },
      { monoMs: 1_500, positionSec: 0, playerState: 'PLAYING' },
      { monoMs: 2_600, positionSec: 0, playerState: 'PLAYING' },
      { monoMs: 3_600, positionSec: 1, playerState: 'PLAYING' },
      { monoMs: 4_600, positionSec: 2, playerState: 'PLAYING' },
    ];
    // Without the flag this is the 2026-08-25 false failure: 2.6 s at position 0, counted.
    expect(detectStalls(scripted).count).toBe(1);
    // With it, the wait for the first frame is press-to-picture and 10b says nothing here.
    expect(detectStalls(scripted, { excludePreRoll: true }).count).toBe(0);
  });

  it('excludePreRoll still reports a film that never started at all', () => {
    // The 2026-08-24 signature: the device accepted the load, said PLAYING, and never moved.
    // There is no first movement, so nothing is pre-roll and the whole dead run is the stall.
    const died: PositionSample[] = [
      { monoMs: 0, positionSec: 0, playerState: 'BUFFERING' },
      { monoMs: 1_000, positionSec: 0, playerState: 'PLAYING' },
      { monoMs: 30_000, positionSec: 0, playerState: 'PLAYING' },
      { monoMs: 60_000, positionSec: 0, playerState: 'PLAYING' },
    ];
    const report = detectStalls(died, { excludePreRoll: true });
    expect(report.count).toBe(1);
    expect(report.stalls[0]?.seconds).toBeCloseTo(60, 0);
  });

  it('is opt-in because on a mid-film trace it WOULD blunt a real freeze', () => {
    // The dangerous shape, stated as the reason for the flag rather than left implicit.
    // Spliced from the middle, the picture was already moving before the trace began, so
    // the freeze at 30 s is real — and `excludePreRoll` cannot tell that from a pre-roll,
    // because "the position has not moved yet" looks identical from inside the trace.
    const midFilm: PositionSample[] = [
      { monoMs: 0, positionSec: 30, playerState: 'PLAYING' },
      { monoMs: 3_000, positionSec: 30, playerState: 'PLAYING' },
      { monoMs: 6_000, positionSec: 31, playerState: 'PLAYING' },
    ];
    // Off — the default, and what every caller but `headstart` gets — it is counted.
    expect(detectStalls(midFilm).count).toBe(1);
    // On, it is swallowed. This is the cost of the flag, and the reason the only caller
    // that sets it first filters its samples to start at the LOAD.
    expect(detectStalls(midFilm, { excludePreRoll: true }).count).toBe(0);
  });

  it('ignores a freeze shorter than the two seconds 10b defines', () => {
    const scripted: PositionSample[] = [
      { monoMs: 0, positionSec: 30, playerState: 'PLAYING' },
      { monoMs: 1_400, positionSec: 30, playerState: 'PLAYING' },
      { monoMs: 3_000, positionSec: 31.5, playerState: 'PLAYING' },
    ];
    expect(detectStalls(scripted).count).toBe(0);
  });
});

describe('reading the device out of the engine log', () => {
  it('takes the device’s own report and nothing else', () => {
    const records = [
      {
        event: 'position.sample',
        monoMs: 100,
        deviceSec: 12.5,
        playerState: 'PLAYING',
        knownSec: 99,
      },
      // Our extrapolated readout is deliberately not read: `knownSec` is what *we* think.
      { event: 'position.sample', monoMs: 1_100, deviceSec: null, playerState: 'BUFFERING' },
      { event: 'session.state_changed', monoMs: 1_200 },
    ];
    expect(samplesFromRecords(records)).toEqual([
      { monoMs: 100, positionSec: 12.5, playerState: 'PLAYING' },
      { monoMs: 1_100, positionSec: null, playerState: 'BUFFERING' },
    ]);
  });
});
