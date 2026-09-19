import { describe, expect, it } from 'vitest';
import { LOOKAHEAD, PREPARATION } from '../../src/engine/config.js';
import {
  decide,
  watchPlayback,
  NO_WATCH,
  type LookaheadWatch,
  type PlaybackObservation,
} from '../../src/engine/queue/lookahead.js';
import type { SessionFlags } from '../../src/engine/types.js';

/**
 * **When a look-ahead may run, and the moment it must stop** — criteria 24g, 24i and 24k.
 *
 * Everything here is the rule itself, imported. Nothing in this file recomputes a threshold,
 * a deadline or a clean-play window of its own: a test that copies the arithmetic out of the
 * code it is testing can only ever agree with itself, and this milestone's whole promise is
 * a number measured from somebody else's clock.
 *
 * What this file can claim: that the rule reaches the right decision from a written-down
 * sequence of device reports. What it cannot: that a real television produces those reports,
 * or that abandoning one really removes an ffmpeg process from the founder's PC. Those are
 * `queue --lookahead --hesitate` and a person watching a film.
 */

const NO_FLAGS: SessionFlags = {
  reconnecting: false,
  reattaching: false,
  yielded: false,
  networkDown: false,
};

/** One look at a film that is playing perfectly well, `atMs` into the run. */
function playing(atMs: number, positionSec: number): PlaybackObservation {
  return {
    monoMs: atMs,
    state: 'playing',
    flags: NO_FLAGS,
    heldByGuard: false,
    currentConversionOpen: false,
    commanded: false,
    report: { monoMs: atMs, playerState: 'PLAYING', positionSec },
  };
}

/** Play cleanly from `fromMs`, one device report a second, for `seconds`. */
function playCleanly(
  watch: LookaheadWatch,
  fromMs: number,
  seconds: number,
  startPositionSec = 0,
): { watch: LookaheadWatch; atMs: number; positionSec: number } {
  let current = watch;
  let atMs = fromMs;
  let positionSec = startPositionSec;
  for (let tick = 0; tick < seconds; tick += 1) {
    atMs = fromMs + tick * 1_000;
    positionSec = startPositionSec + tick;
    current = watchPlayback(current, playing(atMs, positionSec));
  }
  return { watch: current, atMs, positionSec };
}

const WORK = { hasJob: false, hasWork: true };
const RUNNING = { hasJob: true, hasWork: true };

describe('the numbers M5b adds, and where they come from', () => {
  it('prepares exactly one item ahead', () => {
    // The product decision from the PRD, as a number the selftest can assert rather than
    // restate. Raising it would need a scheduler, and 24h stops being provable.
    expect(LOOKAHEAD.itemsAhead).toBe(1);
  });

  it('starts after 60 s of clean playing and abandons within 5 s of a hesitation', () => {
    expect(LOOKAHEAD.cleanPlayBeforeStartMs).toBe(60_000);
    // Deliberately the same number as 10i's guard reaction: one reaction time in the
    // product rather than two.
    expect(LOOKAHEAD.abandonWithinMs).toBe(5_000);
  });

  it('leaves 24y’s gate where M3b put it rather than copying it', () => {
    // *"Same rules as today"* (founder, 2026-09-06). A second copy of ten minutes and 1.5×
    // would be free to drift from the one the head-start gate is graded on.
    expect(PREPARATION.headStartSeconds).toBe(600);
    expect(PREPARATION.headStartMinSpeed).toBe(1.5);
  });
});

describe('starting: a film that has played cleanly for a minute (24g)', () => {
  it('waits out the minute, then starts', () => {
    const before = playCleanly(NO_WATCH, 1_000, 55);
    expect(decide(before.watch, playing(before.atMs, before.positionSec), WORK)).toEqual({
      kind: 'wait',
      why: 'settling',
    });

    const after = playCleanly(before.watch, before.atMs + 1_000, 10, before.positionSec + 1);
    expect(decide(after.watch, playing(after.atMs, after.positionSec), WORK).kind).toBe('start');
  });

  it('never starts on a film whose picture has not moved, however long it has been playing', () => {
    // The television says PLAYING for five minutes and its position never changes. A rule
    // reading the session state alone would have started a conversion behind a dead picture.
    let watch = NO_WATCH;
    for (let tick = 0; tick < 300; tick += 1) {
      watch = watchPlayback(watch, playing(1_000 + tick * 1_000, 42));
    }
    const action = decide(watch, playing(301_000, 42), WORK);
    expect(action).toMatchObject({ kind: 'wait', why: 'hesitating' });
  });

  it('does not start while the playing film’s own conversion is still open (24k)', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const stillConverting = {
      ...playing(clean.atMs, clean.positionSec),
      currentConversionOpen: true,
    };
    expect(decide(clean.watch, stillConverting, WORK)).toEqual({
      kind: 'wait',
      why: 'current-conversion',
    });
  });

  it('does not start when there is nothing to prepare', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    expect(
      decide(clean.watch, playing(clean.atMs, clean.positionSec), {
        hasJob: false,
        hasWork: false,
      }),
    ).toEqual({ kind: 'wait', why: 'nothing-to-prepare' });
  });

  it('does not read the same device report twice as a frozen picture', () => {
    // The engine looks at the film on every session change as well as on every device
    // report. Without the seen-report rule, the second look at one sample finds the position
    // unchanged and declares a freeze on a film that is playing perfectly well.
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const sameReport = playing(clean.atMs, clean.positionSec);
    const again = watchPlayback(clean.watch, { ...sameReport, monoMs: sameReport.monoMs + 40 });
    expect(again.hesitationSinceMono).toBeNull();
    expect(again.cleanSinceMono).toBe(clean.watch.cleanSinceMono);
  });
});

describe('stopping: any hesitation at all (24i)', () => {
  it('dates a frozen picture from the device’s first missed sample, not from ours', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    // The picture stops. The device goes on reporting, once a second, at the same position.
    const frozenAt = clean.atMs + 1_000;
    const first = watchPlayback(clean.watch, playing(frozenAt, clean.positionSec + 1));
    const second = watchPlayback(first, playing(frozenAt + 1_000, clean.positionSec + 1));

    const action = decide(second, playing(frozenAt + 1_000, clean.positionSec + 1), RUNNING);
    expect(action.kind).toBe('abandon');
    if (action.kind !== 'abandon') return;
    // **The whole criterion.** The freeze was only *visible* at `frozenAt + 1000`; it
    // *began* at `frozenAt`, and that is what the five seconds are spent from.
    expect(action.reason).toBe('frozen');
    expect(action.sinceMono).toBe(frozenAt);
    expect(action.deadlineMono).toBe(frozenAt + LOOKAHEAD.abandonWithinMs);
    expect(action.deadlineMono - (frozenAt + 1_000)).toBe(LOOKAHEAD.abandonWithinMs - 1_000);
  });

  it('treats a position that creeps by less than the noise floor as frozen', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const at = clean.atMs + 1_000;
    // 0.065 s apart is what two reports of a genuinely stopped picture measured on the
    // founder's own hardware. Anything inside `stallToleranceSec` is not movement.
    const first = watchPlayback(clean.watch, playing(at, 500));
    const second = watchPlayback(
      first,
      playing(at + 1_000, 500 + PREPARATION.stallToleranceSec / 2),
    );
    expect(decide(second, playing(at + 1_000, 500), RUNNING).kind).toBe('abandon');
  });

  it('abandons on Reconnecting, which is a flag on a film that is still “playing”', () => {
    // ⚠️ The trap this milestone was warned about: `reconnecting` is a flag, not a state.
    // The session stays `playing` throughout, and a rule reading the state saw nothing.
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const outage: PlaybackObservation = {
      ...playing(clean.atMs + 1_000, clean.positionSec + 1),
      flags: { ...NO_FLAGS, reconnecting: true },
    };
    expect(outage.state).toBe('playing');
    const watch = watchPlayback(clean.watch, outage);
    const action = decide(watch, outage, RUNNING);
    expect(action).toMatchObject({ kind: 'abandon', why: 'hesitating', reason: 'interrupted' });
  });

  it.each([
    ['reattaching', { reattaching: true }],
    ['yielded', { yielded: true }],
    ['networkDown', { networkDown: true }],
  ])('abandons on %s as well', (_name, overlay) => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const obs: PlaybackObservation = {
      ...playing(clean.atMs + 1_000, clean.positionSec + 1),
      flags: { ...NO_FLAGS, ...overlay },
    };
    expect(decide(watchPlayback(clean.watch, obs), obs, RUNNING).kind).toBe('abandon');
  });

  it('abandons while the frontier guard is holding the picture (10i)', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const held: PlaybackObservation = {
      ...playing(clean.atMs + 1_000, clean.positionSec + 1),
      heldByGuard: true,
    };
    expect(decide(watchPlayback(clean.watch, held), held, RUNNING)).toMatchObject({
      kind: 'abandon',
      reason: 'held',
    });
  });

  it('abandons on Buffering', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const buffering: PlaybackObservation = {
      ...playing(clean.atMs + 1_000, clean.positionSec + 1),
      state: 'buffering',
      report: { monoMs: clean.atMs + 1_000, playerState: 'BUFFERING', positionSec: null },
    };
    expect(decide(watchPlayback(clean.watch, buffering), buffering, RUNNING)).toMatchObject({
      kind: 'abandon',
      reason: 'buffering',
    });
  });

  it.each(['stopped', 'ended', 'idle'] as const)('abandons when the film is %s (24k)', (state) => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const over: PlaybackObservation = { ...playing(clean.atMs + 1_000, 0), state };
    expect(decide(watchPlayback(clean.watch, over), over, RUNNING)).toMatchObject({
      kind: 'abandon',
      why: 'nothing-playing',
    });
  });

  it('does not resume inside the 60 s, and does resume after it', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const frozenAt = clean.atMs + 1_000;
    let watch = watchPlayback(clean.watch, playing(frozenAt, clean.positionSec + 1));
    watch = watchPlayback(watch, playing(frozenAt + 1_000, clean.positionSec + 1));
    expect(decide(watch, playing(frozenAt + 1_000, clean.positionSec + 1), RUNNING).kind).toBe(
      'abandon',
    );

    // The picture comes back. **The clock starts again from scratch** — 24i fails if a job
    // resumes inside the 60 s.
    const recovering = playCleanly(watch, frozenAt + 2_000, 40, clean.positionSec + 2);
    expect(
      decide(recovering.watch, playing(recovering.atMs, recovering.positionSec), WORK),
    ).toEqual({ kind: 'wait', why: 'settling' });

    const settled = playCleanly(
      recovering.watch,
      recovering.atMs + 1_000,
      25,
      recovering.positionSec + 1,
    );
    expect(decide(settled.watch, playing(settled.atMs, settled.positionSec), WORK).kind).toBe(
      'start',
    );
  });
});

describe('a pause is not a hesitation (24k, and what it does not say)', () => {
  const paused = (atMs: number, positionSec: number): PlaybackObservation => ({
    ...playing(atMs, positionSec),
    state: 'paused',
    report: { monoMs: atMs, playerState: 'PAUSED', positionSec },
  });

  it('leaves a running job alone', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const obs = paused(clean.atMs + 1_000, clean.positionSec);
    expect(decide(watchPlayback(clean.watch, obs), obs, RUNNING)).toEqual({ kind: 'continue' });
  });

  it('does not let a new one start, and makes the film earn its minute again', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const pause = watchPlayback(clean.watch, paused(clean.atMs + 1_000, clean.positionSec));
    expect(decide(pause, paused(clean.atMs + 1_000, clean.positionSec), WORK)).toEqual({
      kind: 'wait',
      why: 'nothing-playing',
    });

    const resumed = playCleanly(pause, clean.atMs + 2_000, 30, clean.positionSec + 1);
    expect(decide(resumed.watch, playing(resumed.atMs, resumed.positionSec), WORK)).toEqual({
      kind: 'wait',
      why: 'settling',
    });
  });

  it('does not count a seek the founder asked for as a frozen picture', () => {
    const clean = playCleanly(NO_WATCH, 1_000, 90);
    const seeking: PlaybackObservation = {
      ...playing(clean.atMs + 1_000, clean.positionSec),
      commanded: true,
    };
    const watch = watchPlayback(clean.watch, seeking);
    expect(watch.hesitationSinceMono).toBeNull();
    expect(decide(watch, seeking, RUNNING)).toEqual({ kind: 'continue' });
  });
});
