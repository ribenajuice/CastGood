import { describe, expect, it } from 'vitest';
import { PREPARATION } from '../../src/engine/config.js';
import {
  canCatchUp,
  guardStep,
  headStartGate,
  recordFrontier,
  forecastGate,
  secondsUntilRelease,
  seekLimitSec,
  stillPreparingMessage,
  sustainedSpeed,
  willPlayWhenReadyMessage,
  INITIAL_GUARD,
  type FrontierSample,
  type GuardState,
} from '../../src/engine/prepare/head-start.js';

/**
 * M3b's two mechanisms, as arithmetic — criteria **10h** (the gate) and **10i** (the guard).
 *
 * Everything here runs in WSL against numbers, which is the only place either of them can be
 * tested at all: a gate can only be proved by the loads it *refuses*, and a guard can only be
 * proved by a conversion that falls behind — neither of which a television can be asked for
 * on demand. What this file proves is that the decisions are right. Whether the pause reaches
 * the picture in five seconds is `[hardware]`, and it is owed.
 */

/** A conversion running at a steady speed, sampled once a second, as ffmpeg reports it. */
function conversion(speed: number, seconds: number, fromSec = 0): FrontierSample[] {
  let samples: FrontierSample[] = [];
  for (let second = 0; second <= seconds; second += 1) {
    samples = recordFrontier(samples, {
      atMs: second * 1000,
      frontierSec: fromSec + second * speed,
    });
  }
  return samples;
}

describe('the sustained speed the gate reads (10h)', () => {
  it('has no answer until a full minute of conversion exists', () => {
    // The whole point: a conversion that has been running for fifty seconds has not yet
    // shown it can sustain anything, and `null` never opens the gate.
    expect(sustainedSpeed(conversion(2, 50))).toBeNull();
    expect(sustainedSpeed(conversion(2, 60))).toBeCloseTo(2, 3);
  });

  it('measures what the frontier really did, so a burst cannot flatter it', () => {
    // Fifty seconds at 4× — a cold machine on burst clocks — then ten at 0.5×. ffmpeg's own
    // instantaneous `speed=` would be reading 0.5 by now, and a naive average of its reports
    // would read about 3.4. The frontier moved 205 s in 60 s of wall clock.
    let samples = conversion(4, 50);
    for (let second = 51; second <= 60; second += 1) {
      samples = recordFrontier(samples, {
        atMs: second * 1000,
        frontierSec: 200 + (second - 50) * 0.5,
      });
    }
    expect(sustainedSpeed(samples)).toBeCloseTo(205 / 60, 2);
  });

  it('keeps enough history for a full window and no more', () => {
    const samples = conversion(1, 600);
    // Two windows' worth, so the oldest sample is always at least a window old — and the
    // list cannot grow for the length of a film.
    expect(samples.length).toBeLessThanOrEqual(121);
    expect(sustainedSpeed(samples)).toBeCloseTo(1, 3);
  });
});

describe('the gate itself (10h)', () => {
  const film = 7_200;

  it('stays shut on ten minutes prepared at a speed that has not been sustained yet', () => {
    const verdict = headStartGate({
      preparedSec: 900,
      sustainedSpeed: null,
      conversionComplete: false,
      filmDurationSec: film,
    });
    expect(verdict.open).toBe(false);
    expect(verdict.reason).toBe('speed-not-sustained-yet');
  });

  it('stays shut on a fast conversion that has not prepared ten minutes', () => {
    const verdict = headStartGate({
      preparedSec: 599,
      sustainedSpeed: 12,
      conversionComplete: false,
      filmDurationSec: film,
    });
    expect(verdict.open).toBe(false);
    expect(verdict.reason).toBe('not-enough-prepared');
  });

  it('stays shut on the 2026-08-21 run, which is the run it exists to refuse', () => {
    // 29.5 seconds prepared at 0.7×. Eight frozen pictures and 46 s of them followed.
    const verdict = headStartGate({
      preparedSec: 29.5,
      sustainedSpeed: 0.7,
      conversionComplete: false,
      filmDurationSec: 6_990,
    });
    expect(verdict.open).toBe(false);
    // Both numbers travel with the verdict: 10h fails on an absent one.
    expect(verdict.preparedSec).toBe(29.5);
    expect(verdict.sustainedSpeed).toBe(0.7);
  });

  it('opens on both halves and on nothing less', () => {
    expect(
      headStartGate({
        preparedSec: PREPARATION.headStartSeconds,
        sustainedSpeed: PREPARATION.headStartMinSpeed,
        conversionComplete: false,
        filmDurationSec: film,
      }),
    ).toMatchObject({ open: true, reason: 'head-start' });
    expect(
      headStartGate({
        preparedSec: PREPARATION.headStartSeconds,
        sustainedSpeed: PREPARATION.headStartMinSpeed - 0.01,
        conversionComplete: false,
        filmDurationSec: film,
      }),
    ).toMatchObject({ open: false, reason: 'too-slow' });
  });

  it('a film shorter than the head start waits for the conversion, and then casts', () => {
    // Without this clause the gate never opens for a short film and the founder waits
    // forever for a conversion that finished minutes ago.
    const shut = headStartGate({
      preparedSec: 400,
      sustainedSpeed: 20,
      conversionComplete: false,
      filmDurationSec: 480,
    });
    expect(shut).toMatchObject({ open: false, reason: 'film-shorter-than-head-start' });
    expect(
      headStartGate({
        preparedSec: 480,
        sustainedSpeed: 20,
        conversionComplete: true,
        filmDurationSec: 480,
      }),
    ).toMatchObject({ open: true, reason: 'conversion-complete' });
  });

  it('says when watching can start, and says nothing it cannot promise (10a, 10f)', () => {
    // A conversion that is keeping up: the countdown is the prepared-seconds half, measured
    // on the **same sustained speed the gate is decided by** — one speed, one clock.
    expect(
      forecastGate({
        preparedSec: 300,
        sustainedSpeed: 2,
        conversionComplete: false,
        filmDurationSec: 7_200,
      }),
    ).toEqual({ watchableInSeconds: 150, playsOnCompletion: false, estimatingWait: false });

    // No sustained speed yet: no sentence and no guess — and now it says so, rather than
    // falling through to "nothing goes to the television until this has finished", which is
    // false for a film that is about to start early.
    expect(
      forecastGate({
        preparedSec: 300,
        sustainedSpeed: null,
        conversionComplete: false,
        filmDurationSec: 7_200,
      }),
    ).toEqual({ watchableInSeconds: null, playsOnCompletion: false, estimatingWait: true });
  });

  it('will not count down on a burst, which is what told the founder 23 s for a 202 s wait', () => {
    // **2026-08-26, the `AI PONT`, a 4K film.** The countdown ran on a 10-second average so
    // it would track the progress bar. ffmpeg's opening seconds reported roughly 26×; the
    // job settled at 3.2×. 600 ÷ 26 said *"about 23 seconds"* and the picture arrived 202
    // seconds later — short, which is the one direction 8b's honesty clause forbids.
    //
    // The gate never believed the burst: it has always required a minute of sustained speed
    // because a burst must never open it. The countdown now uses that same figure.
    const burst = forecastGate({
      preparedSec: 0,
      // A minute has not passed, so there is no sustained figure — whatever the last ten
      // seconds looked like.
      sustainedSpeed: null,
      conversionComplete: false,
      filmDurationSec: 8_929,
    });
    expect(burst.watchableInSeconds).toBeNull();
    expect(burst.estimatingWait).toBe(true);
    expect(burst.playsOnCompletion).toBe(false);

    // A minute later, on the figure the gate itself is decided by: 600 s needed at 3.2×.
    const settled = forecastGate({
      preparedSec: 0,
      sustainedSpeed: 3.2,
      conversionComplete: false,
      filmDurationSec: 8_929,
    });
    expect(settled.estimatingWait).toBe(false);
    expect(settled.watchableInSeconds).toBeCloseTo(600 / 3.2, 3);
    // 187.5 s, against the 202 s the run actually took: long, and it lands on the right side
    // of the honesty clause. The old arithmetic said 23.
    expect(settled.watchableInSeconds ?? 0).toBeGreaterThan(150);
  });

  it('is estimating only while a head start is genuinely being waited for', () => {
    // A finished conversion knows the answer, and a film that plays on completion has a
    // different clock — neither is "working it out", and a screen that said so would be
    // stalling rather than informing.
    expect(
      forecastGate({
        preparedSec: 900,
        sustainedSpeed: null,
        conversionComplete: true,
        filmDurationSec: 7_200,
      }).estimatingWait,
    ).toBe(false);
    expect(
      forecastGate({
        preparedSec: 100,
        sustainedSpeed: 5,
        conversionComplete: false,
        filmDurationSec: 400,
      }).estimatingWait,
    ).toBe(false);
  });

  it('never counts down to a moment that cannot arrive — the 0.8× lie (10f)', () => {
    // **This is the defect this test exists for.** A conversion sustaining 0.8× would
    // reach ten minutes of prepared video in twelve and a half minutes, so the old
    // arithmetic said *"watching starts in about 12 minutes"* — and it never would, because
    // the speed half of the gate can never hold at 0.8×. The film starts on completion, an
    // hour later, and the founder was given a number that could not happen.
    const forecast = forecastGate({
      preparedSec: 0,
      sustainedSpeed: 0.8,
      conversionComplete: false,
      filmDurationSec: 7_200,
    });
    expect(forecast.watchableInSeconds).toBeNull();
    expect(forecast.playsOnCompletion).toBe(true);
  });

  it('says a short film plays on completion rather than counting down to a gate it has', () => {
    const forecast = forecastGate({
      preparedSec: 100,
      sustainedSpeed: 5,
      conversionComplete: false,
      filmDurationSec: 400,
    });
    // Ten minutes of a seven-minute film will never exist, so there is no head start to
    // count down to — and the wait the founder is shown is the conversion's own.
    expect(forecast).toEqual({
      watchableInSeconds: null,
      playsOnCompletion: true,
      estimatingWait: false,
    });
  });

  it('changes its mind when the conversion speeds up, which is 10f’s “restated as it changes”', () => {
    const slow = forecastGate({
      preparedSec: 200,
      sustainedSpeed: 1.2,
      conversionComplete: false,
      filmDurationSec: 7_200,
    });
    const recovered = forecastGate({
      preparedSec: 400,
      sustainedSpeed: 2.4,
      conversionComplete: false,
      filmDurationSec: 7_200,
    });
    expect(slow.playsOnCompletion).toBe(true);
    expect(recovered.playsOnCompletion).toBe(false);
    expect(recovered.watchableInSeconds).toBeCloseTo(200 / 2.4, 3);
  });
});

describe('the live margin guard (10i)', () => {
  /** A scripted session: the playhead advances in real time, the frontier as told. */
  function run(script: readonly { atMs: number; positionSec: number; frontierSec: number }[]) {
    let state: GuardState = INITIAL_GUARD;
    const actions: { atMs: number; action: string; marginSec: number }[] = [];
    for (const point of script) {
      const step = guardStep(state, {
        atMs: point.atMs,
        positionSec: point.positionSec,
        frontierSec: point.frontierSec,
        conversionComplete: false,
        // The film plays unless the guard itself has taken it.
        playing: !state.held,
      });
      state = step.state;
      if (step.action !== 'none') {
        actions.push({ atMs: point.atMs, action: step.action, marginSec: step.marginSec });
      }
    }
    return { state, actions };
  }

  it('holds when the margin falls under two minutes and not before', () => {
    const script = [
      { atMs: 0, positionSec: 100, frontierSec: 400 },
      // Exactly 120 s of margin is the margin holding, not failing: the number is the floor.
      { atMs: 2_000, positionSec: 102, frontierSec: 222 },
      { atMs: 4_000, positionSec: 104, frontierSec: 223.5 },
    ];
    const { actions, state } = run(script);
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ atMs: 4_000, action: 'hold' });
    // The frame it was held on, which is where 10i promises it resumes.
    expect(state.heldAtSec).toBe(104);
  });

  it('releases at three minutes, by itself, and does not flap between the two', () => {
    // A conversion that falls to 0.4× eats the margin; a fast patch afterwards gives it
    // back. Sampled every 2 s for twelve minutes, with the playhead frozen whenever the
    // guard is holding it — because that is what a paused film does, and it is the reason
    // the margin can recover at all.
    let state: GuardState = INITIAL_GUARD;
    const actions: { atMs: number; action: string; marginSec: number }[] = [];
    let frontier = 300;
    let position = 100;
    for (let tick = 0; tick < 360; tick += 1) {
      const atMs = tick * 2_000;
      // Slow from a minute in to six minutes in; 2× either side.
      const speed = atMs >= 60_000 && atMs < 360_000 ? 0.4 : 2;
      frontier += speed * 2;
      const step = guardStep(state, {
        atMs,
        positionSec: position,
        frontierSec: frontier,
        conversionComplete: false,
        playing: !state.held,
      });
      state = step.state;
      if (step.action !== 'none') {
        actions.push({ atMs, action: step.action, marginSec: step.marginSec });
      }
      if (!state.held) position += 2;
    }
    // One hold and one release, in that order, and nothing else.
    expect(actions.map((entry) => entry.action)).toEqual(['hold', 'release']);
    const [hold, release] = actions;
    expect(hold?.marginSec).toBeLessThan(PREPARATION.frontierMarginSeconds);
    expect(release?.marginSec).toBeGreaterThanOrEqual(PREPARATION.frontierReleaseMarginSeconds);
    // Hysteresis, measured: **10i fails if the guard fires and releases inside 30 s.**
    expect((release?.atMs ?? 0) - (hold?.atMs ?? 0)).toBeGreaterThan(30_000);
    expect(state.holds).toBe(1);
  });

  it('re-holds a film that started playing again from somewhere else — the escape', () => {
    // **The defect this test exists for, found in frontend review on 2026-08-21.** The guard
    // used to return early whenever it was holding, so from a hold it could only ever
    // produce `none` or its own release. A `PLAY` that did not come from this app — the
    // Google Home app, another phone, the whole reason *Take it back* exists — left the
    // state pinned at `held: true` **while the picture played**, and no further hold could
    // ever fire. The film then walked into the frontier with the guard watching: precisely
    // the 2026-08-21 failure, reached from an ordinary state.
    const held = guardStep(INITIAL_GUARD, {
      atMs: 0,
      positionSec: 500,
      frontierSec: 600,
      conversionComplete: false,
      playing: true,
    });
    expect(held.action).toBe('hold');

    // Somebody presses Play on a phone. The next sample sees a film that is playing, still
    // inside the margin, and closing on the frontier.
    const escaped = guardStep(held.state, {
      atMs: 4_000,
      positionSec: 504,
      frontierSec: 602,
      conversionComplete: false,
      playing: true,
    });
    // Before the fix this was `none`, with `held` stuck true for the rest of the film.
    expect(escaped.action).toBe('hold');
    expect(escaped.state.held).toBe(true);
    // A second hold really happened, and the log and the verdict say so.
    expect(escaped.state.holds).toBe(2);
    // …and it is held at the frame it is at **now**, because the film moved while it was
    // away. 10i's "resumes at the frame it held" means the frame it was actually taken from.
    expect(escaped.state.heldAtSec).toBe(504);
  });

  it('stands down rather than re-holding when the escape happened above the margin', () => {
    const held = guardStep(INITIAL_GUARD, {
      atMs: 0,
      positionSec: 500,
      frontierSec: 600,
      conversionComplete: false,
      playing: true,
    });
    // The film is playing again and the margin has recovered to 150 s — between the two
    // numbers. There is nothing to hold: the guard lets go and will hold again if the margin
    // falls under 120 s, which is the hysteresis working rather than being bypassed.
    const escaped = guardStep(held.state, {
      atMs: 6_000,
      positionSec: 500,
      frontierSec: 650,
      conversionComplete: false,
      playing: true,
    });
    expect(escaped.action).toBe('release');
    expect(escaped.state.held).toBe(false);
    expect(escaped.state.holds).toBe(1);
    // The time it did spend held is still counted — the verdict reports total held seconds.
    expect(escaped.state.heldTotalSec).toBeCloseTo(6, 3);
  });

  it('does not re-hold against our own pause while the device is catching up', () => {
    // The pause is painted immediately (`intent.pause` sets `paused` inside the optimistic
    // window), so the sample after a hold sees a film that is not playing. This is the case
    // that would flap if `playing` were read carelessly.
    const held = guardStep(INITIAL_GUARD, {
      atMs: 0,
      positionSec: 500,
      frontierSec: 600,
      conversionComplete: false,
      playing: true,
    });
    const next = guardStep(held.state, {
      atMs: 2_000,
      positionSec: 500,
      frontierSec: 601,
      conversionComplete: false,
      playing: false,
    });
    expect(next.action).toBe('none');
    expect(next.state.holds).toBe(1);
  });

  it('never takes a picture the founder paused themselves', () => {
    const step = guardStep(INITIAL_GUARD, {
      atMs: 0,
      positionSec: 100,
      frontierSec: 150,
      conversionComplete: false,
      playing: false,
    });
    expect(step.action).toBe('none');
    expect(step.state.held).toBe(false);
  });

  it('lets go the moment the conversion finishes, whatever the margin says', () => {
    const held = guardStep(INITIAL_GUARD, {
      atMs: 0,
      positionSec: 100,
      frontierSec: 150,
      conversionComplete: false,
      playing: true,
    });
    expect(held.action).toBe('hold');
    const released = guardStep(held.state, {
      atMs: 4_000,
      positionSec: 100,
      frontierSec: 150,
      conversionComplete: true,
      playing: false,
    });
    expect(released.action).toBe('release');
    expect(released.state.held).toBe(false);
    // Counted, because the selftest reports holds as observations (count, total, longest).
    expect(released.state.holds).toBe(1);
    expect(released.state.heldTotalSec).toBeCloseTo(4, 3);
  });
});

describe('what the founder is told while the picture is held (10f, 10i)', () => {
  it('states how long, and restates it as the margin recovers', () => {
    // Held at a 90-second margin with the conversion running at 2×: 90 s of margin to make
    // up, produced at 2 s per second.
    expect(secondsUntilRelease(90, 2)).toBeCloseTo(45, 3);
    expect(secondsUntilRelease(150, 2)).toBeCloseTo(15, 3);
    expect(stillPreparingMessage(45)).toBe('Still preparing — back in about 45 seconds');
    expect(stillPreparingMessage(15)).toBe('Still preparing — back in about 15 seconds');
  });

  it('never says Buffering, because 11e would tear down a healthy connection', () => {
    for (const seconds of [3, 11, 26, 300]) {
      expect(stillPreparingMessage(seconds)).not.toMatch(/buffer/i);
      expect(stillPreparingMessage(seconds)).toMatch(/^Still preparing/);
    }
    expect(willPlayWhenReadyMessage(600)).not.toMatch(/buffer/i);
  });

  it('says nothing it cannot measure', () => {
    expect(secondsUntilRelease(90, null)).toBeNull();
    expect(secondsUntilRelease(90, 0)).toBeNull();
    expect(stillPreparingMessage(null)).toBe('Still preparing…');
  });

  it('tells the founder plainly when the conversion cannot catch up at all (10f)', () => {
    // Below real time, every second watched costs more than a second produced.
    expect(canCatchUp(0.7)).toBe(false);
    expect(canCatchUp(1.2)).toBe(true);
    // The gate's 1.5 is a margin of safety before *starting*; applying it here would send a
    // film that is genuinely keeping up to the back of a queue it does not belong in.
    expect(canCatchUp(1.4)).toBe(true);
    expect(willPlayWhenReadyMessage(1_200)).toBe(
      'Still preparing — this film will play when the conversion is done, in about 20 minutes',
    );
  });
});

describe('how far ahead a jump may land (10d)', () => {
  it('is the frontier less the margin the guard defends, and never negative', () => {
    expect(seekLimitSec(600)).toBe(480);
    expect(seekLimitSec(100)).toBe(0);
    expect(seekLimitSec(0)).toBe(0);
  });
});
