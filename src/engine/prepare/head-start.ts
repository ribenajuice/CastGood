import { PREPARATION } from '../config.js';
import { describeApproxSeconds } from './classify.js';

/**
 * M3b's arithmetic: **when it is safe to start watching, and when the picture must be
 * held.** Every function here is pure, and that is the point rather than a preference.
 *
 * The two mechanisms this file contains are the ones the 2026-08-21 starved run proved
 * necessary, and neither of them can be tried on a television in WSL:
 *
 *  - **The gate (10h)** — nothing reaches a television until ten minutes of video exist and
 *    the conversion is sustaining 1.5× real time, or the conversion has finished. The
 *    starved run was outside the gate on both counts (29.5 s prepared, 0.7×) and produced
 *    46 seconds of frozen picture in 343 seconds, so the gate is *validated* by that run
 *    rather than threatened by it.
 *  - **The live guard (10i)** — the same 2-minute margin 10b always named, checked every 2 s
 *    for the whole session instead of once at the start. The worst freeze of that run
 *    arrived 199.9 s in; an opening check would have been long past by then.
 *
 * ## Why the gate's speed is a sustained figure and never a burst
 *
 * The number ffmpeg prints as `speed=` is instantaneous, and a short reading of this
 * machine flatters it by roughly a third (SPIKE-4: a 60-second clip measured 362 Mpx/s of
 * a film that sustained 258–299 over its full length). A gate opened on a flattering
 * number is a gate that opens on a conversion that cannot hold the pace — which is exactly
 * the run above, arrived at by arithmetic rather than by `--rate 0.7`. So the speed the
 * gate reads is derived from **how far the frontier actually moved over at least the last
 * 60 s of wall clock**, which cannot be flattered by a burst.
 */

/** One reading of the conversion frontier, stamped on a monotonic clock. */
export interface FrontierSample {
  readonly atMs: number;
  /** Seconds of finished video at that instant — ffmpeg's own `out_time`. */
  readonly frontierSec: number;
}

/**
 * Frontier samples, oldest first, with anything too old to be useful dropped.
 *
 * Two windows read this list — the gate's 60 s and the guard's 10 s — so it keeps a little
 * more than the longer of them: enough to always have one sample *older* than the window,
 * which is what makes a full-length window measurable rather than approximated.
 */
export function recordFrontier(
  samples: readonly FrontierSample[],
  sample: FrontierSample,
  keepMs: number = PREPARATION.headStartSpeedWindowMs,
): FrontierSample[] {
  const all = [...samples, sample];
  // Everything inside the window, **plus the newest sample just outside it** — and that last
  // one is the whole trick. Pruning strictly by age throws away the only sample old enough to
  // anchor a full-length window, so a job whose reports are sparse (or a machine that paused
  // for a moment) would keep resetting to "no history", and no history reads as no speed.
  // Anchor first, then the window: the list is bounded and a minute is always measurable.
  const anchorIndex = all.findLastIndex((entry) => sample.atMs - entry.atMs > keepMs);
  return anchorIndex <= 0 ? all : all.slice(anchorIndex);
}

/**
 * How fast the conversion is really running, over **at least** `windowMs` of wall clock.
 *
 * `null` means the question cannot be answered yet — fewer than `windowMs` of history —
 * and `null` never opens the gate. That is deliberate: a conversion that has been running
 * for twenty seconds has not yet shown it can sustain anything, and the whole cost of
 * waiting is that the founder starts watching a minute later than they might have.
 *
 * The window is anchored on the newest sample that is *at least* `windowMs` old, so the
 * measurement spans a real minute rather than whatever happens to be in the buffer.
 */
export function sustainedSpeed(
  samples: readonly FrontierSample[],
  windowMs: number = PREPARATION.headStartSpeedWindowMs,
): number | null {
  const newest = samples.at(-1);
  if (newest === undefined) return null;
  let anchor: FrontierSample | null = null;
  for (const sample of samples) {
    if (newest.atMs - sample.atMs >= windowMs) anchor = sample;
    else break;
  }
  if (anchor === null) return null;
  const elapsedMs = newest.atMs - anchor.atMs;
  if (elapsedMs <= 0) return null;
  const produced = newest.frontierSec - anchor.frontierSec;
  return Math.max(0, produced / (elapsedMs / 1000));
}

/** Why the gate is shut, or which of its two ways it opened. */
export type GateReason =
  /** ffmpeg has finished. Everything is prepared, so nothing is being raced. */
  | 'conversion-complete'
  /** Both halves held: ≥ 10 minutes prepared and ≥ 1.5× sustained. */
  | 'head-start'
  /** Under ten minutes of video exists. */
  | 'not-enough-prepared'
  /** Under 60 s of conversion has happened, so no sustained figure exists yet. */
  | 'speed-not-sustained-yet'
  /** The conversion is running, and it is running too slowly to be trusted (10f). */
  | 'too-slow'
  /**
   * The film is shorter than the head start, so ten minutes of it will never exist.
   *
   * This clause is in the PRD's own numbers table and it is load-bearing: without it the
   * gate never opens for a short film and the founder waits forever for a conversion that
   * finished minutes ago. Such a film casts on **completion**, which is M3a's behaviour.
   */
  | 'film-shorter-than-head-start';

export interface GateInput {
  /** Seconds of finished video — the conversion frontier. */
  readonly preparedSec: number;
  /** From `sustainedSpeed`. `null` until a full window exists, and `null` never opens it. */
  readonly sustainedSpeed: number | null;
  readonly conversionComplete: boolean;
  /** The film's true length, from **our own** probe. `null` when it is not known. */
  readonly filmDurationSec: number | null;
}

export interface GateVerdict {
  readonly open: boolean;
  readonly reason: GateReason;
  /** Echoed back so whatever logs or asserts on this has both numbers beside the answer. */
  readonly preparedSec: number;
  readonly sustainedSpeed: number | null;
}

/**
 * **The gate — criterion 10h.** Nothing is loaded on a television unless this says so.
 *
 * Pure, and called with every progress report rather than once, because both of its inputs
 * move. The order of the tests is the order of the sentences the founder would be told.
 */
export function headStartGate(input: GateInput): GateVerdict {
  const decided = (open: boolean, reason: GateReason): GateVerdict => ({
    open,
    reason,
    preparedSec: input.preparedSec,
    sustainedSpeed: input.sustainedSpeed,
  });

  if (input.conversionComplete) return decided(true, 'conversion-complete');
  if (input.filmDurationSec !== null && input.filmDurationSec <= PREPARATION.headStartSeconds) {
    return decided(false, 'film-shorter-than-head-start');
  }
  if (input.preparedSec < PREPARATION.headStartSeconds) {
    return decided(false, 'not-enough-prepared');
  }
  if (input.sustainedSpeed === null) return decided(false, 'speed-not-sustained-yet');
  if (input.sustainedSpeed < PREPARATION.headStartMinSpeed) return decided(false, 'too-slow');
  return decided(true, 'head-start');
}

/**
 * What the founder is owed *before* watching starts — 10a's *"the app said beforehand"* and
 * 10f's *"says so with a live estimate"*, as one answer rather than two.
 *
 * **One function and one shape, because the two answers are mutually exclusive.** Either
 * this film starts part-way through its conversion, in which case there is a number of
 * seconds until it does; or it does not, in which case saying *when* watching starts is a
 * statement about something that will not happen.
 */
export interface GateForecast {
  /**
   * Seconds until the gate is expected to open, or `null` when there is nothing honest to
   * say — no measured speed yet, or a conversion that will never satisfy the gate at all.
   */
  readonly watchableInSeconds: number | null;
  /**
   * **This film will not start early: it plays when the conversion is done** (10f).
   *
   * True in exactly two cases, and both are facts rather than predictions: a film shorter
   * than the head start, which can never have ten minutes prepared; and a conversion whose
   * *sustained* speed is below the gate, which is 10f's *"below the speed gate when the
   * founder presses"*. The live estimate for this case is the conversion's own remaining
   * time, which the preparation snapshot already carries — so there is one number on screen,
   * not two that can disagree.
   *
   * It may change back. A conversion that speeds up past 1.5× is no longer in this case, and
   * 10f asks for exactly that: the wait **restated as it changes**.
   */
  readonly playsOnCompletion: boolean;
  /**
   * **There is no sustained speed yet, so the wait is still being worked out** — the founder
   * is told exactly that rather than shown a number or a false sentence.
   *
   * The third answer this shape was missing. `watchableInSeconds: null` with
   * `playsOnCompletion: false` has always meant *"we do not know yet"*, and the screen had
   * no words for it: it fell through to *"Nothing goes to the television until this has
   * finished"*, which is **false** for a film that is about to start early. This flag is
   * also what tells a repackage apart from a young conversion — `forecastGate` is only ever
   * asked about a head-start job, so nothing else can set it.
   */
  readonly estimatingWait: boolean;
}

/**
 * When can watching start? — and the answer *"not until this is finished"* is a first-class
 * one rather than a silence.
 *
 * **This function used to lie, and the lie is worth recording.** It computed
 * `(600 − prepared) / speed` from the *prepared-seconds* half of the gate alone, so a
 * conversion sustaining 0.8× told the founder *"watching starts in about 12 minutes"* — a
 * time that would never come, because the speed half never held and the film would in fact
 * start on completion. Its own comment said under-stating this would be *"the flattering
 * direction, which is the one 8b's honesty clause forbids"*, immediately above the code
 * doing it. Found in frontend review, 2026-08-21; it is the seventh time this project has
 * corrected a stated number that could not happen, and the first time the correction was
 * cheap.
 *
 * **The countdown used to run on a different speed from the gate, and that was wrong.**
 * `speedNow` was a 10-second average, chosen so the countdown would not lag the progress
 * bar; the gate has always used the 60-second sustained figure, because a burst must never
 * open it. Ten seconds is not long enough to be a burst-free measurement either: on
 * 2026-08-26 a 4K conversion opened at roughly **26×** in its first seconds, settled at
 * **3.2×**, and the founder was told *"about 23 seconds"* for a wait that ran **202**.
 *
 * A number that is right for one moment and never again is not a smoother countdown, it is
 * a faster-moving wrong one — and it errs **short**, the single direction 8b's honesty
 * clause forbids. So the countdown now runs on the same sustained figure the gate does:
 * **one speed, one clock**, and no number at all until that figure exists. The first minute
 * says so out loud (`estimatingWait`), which is the honest thing the shape was missing
 * rather than a wait that got longer. *(Founder's decision, 2026-08-26, asked as a product
 * question: say it is still working it out.)*
 */
export function forecastGate(input: GateInput): GateForecast {
  const shortFilm =
    input.filmDurationSec !== null && input.filmDurationSec <= PREPARATION.headStartSeconds;
  // The gate reads a sustained figure and so does this: a conversion that has not yet shown
  // a minute of speed is not *failing* the gate, it simply has not answered it, and calling
  // that "plays on completion" would be a second confident wrong answer.
  const tooSlow =
    input.sustainedSpeed !== null && input.sustainedSpeed < PREPARATION.headStartMinSpeed;
  const playsOnCompletion = !input.conversionComplete && (shortFilm || tooSlow);

  if (input.conversionComplete) {
    return { watchableInSeconds: 0, playsOnCompletion: false, estimatingWait: false };
  }
  if (playsOnCompletion) {
    // No number here on purpose: the wait the founder is shown for this case is the
    // conversion's own remaining time, and inventing a second one would be two clocks.
    return { watchableInSeconds: null, playsOnCompletion: true, estimatingWait: false };
  }
  const speed = input.sustainedSpeed;
  if (speed === null || speed <= 0) {
    return { watchableInSeconds: null, playsOnCompletion: false, estimatingWait: true };
  }
  const neededSec = Math.max(0, PREPARATION.headStartSeconds - input.preparedSec);
  return { watchableInSeconds: neededSec / speed, playsOnCompletion: false, estimatingWait: false };
}

// --- The live guard (10i) ----------------------------------------------------

/**
 * What the guard is doing, carried between samples.
 *
 * `heldAtSec` is the frame the picture was held on. 10i promises the film resumes *"at the
 * frame it held"*, and the position readout stays where it was — so the position at the
 * moment of the hold is remembered here rather than re-read from a device that is now
 * paused and may report anything.
 */
export interface GuardState {
  readonly held: boolean;
  readonly heldAtSec: number | null;
  readonly heldSinceMs: number | null;
  /** How many times the guard has held this session, for the verdict and the log. */
  readonly holds: number;
  /** Total seconds the film has spent held, for the same reason. */
  readonly heldTotalSec: number;
}

export const INITIAL_GUARD: GuardState = {
  held: false,
  heldAtSec: null,
  heldSinceMs: null,
  holds: 0,
  heldTotalSec: 0,
};

export interface GuardInput {
  readonly atMs: number;
  /** The device's own reported playhead, extrapolated. Never our guess about it. */
  readonly positionSec: number;
  /** ffmpeg's frontier. */
  readonly frontierSec: number;
  readonly conversionComplete: boolean;
  /**
   * Is the film playing as far as the app is concerned?
   *
   * Two things turn on it, and the second was missing until 2026-08-21 (frontend review).
   *
   * The guard may only *take* the picture from a film that is playing — a film the founder
   * paused themselves is not the guard's to hold, and resuming it later would be the app
   * pressing play on their behalf.
   *
   * And **a held film that is playing is not held**, whoever restarted it. The app's own
   * Play button is disabled during a hold, but the app is not the only thing that can drive
   * this television: the Google Home app and any phone in the house can send `PLAY` straight
   * to the device, which is the whole reason stories 12 and 13 and *Take it back* exist. So
   * `playing` is consulted on **every** sample, held or not — see `guardStep`.
   */
  readonly playing: boolean;
}

export type GuardAction = 'none' | 'hold' | 'release';

export interface GuardStep {
  readonly state: GuardState;
  readonly action: GuardAction;
  /** Seconds of video between the playhead and the frontier at this sample. */
  readonly marginSec: number;
}

/**
 * One comparison of playhead against frontier — the whole of 10i's mechanism.
 *
 * **Two numbers, not one.** It holds under `frontierMarginSeconds` (120) and releases at
 * `frontierReleaseMarginSeconds` (180), and the gap between them is what stops it flapping:
 * with one number, the release would immediately re-arm the hold and the founder would get
 * a picture that stutters on and off, which is worse than the stall.
 *
 * A finished conversion releases unconditionally — there is no frontier left to protect.
 *
 * ## The escape, and why the shape of this function changed
 *
 * It used to return early whenever `held` was true, so from a hold it could only ever
 * produce `none` or its own `release`. **A film that started playing again by any other
 * route therefore ran with the guard pinned open**: `held` stayed true, no further hold
 * could ever fire, and the playhead walked into the frontier — which is exactly the
 * 2026-08-21 failure the guard exists to prevent, reached from an ordinary state. Found in
 * frontend review, 2026-08-21, and it was reachable: the app's Play button is disabled
 * during a hold, but a `PLAY` from the Google Home app or a phone never passes our button.
 *
 * So there is no early return any more. A held film that is playing is **un-held and then
 * re-evaluated in the same step**, which yields the honest answer for every case: still
 * under the margin, and it is held again with a fresh `PAUSE` on the wire; recovered past
 * 180 s, and it simply stays playing; anywhere between, and the guard stands down and will
 * hold again the moment the margin next falls. The one thing it can no longer do is watch.
 *
 * This does not flap against our own pause: `intent.pause` paints `paused` immediately, so
 * the sample after a hold sees a film that is not playing. If the device never confirms, the
 * optimistic window expires, the model goes back to `playing` — and re-asserting the hold is
 * then precisely the right answer rather than a spurious one.
 */
export function guardStep(state: GuardState, input: GuardInput): GuardStep {
  const marginSec = input.frontierSec - input.positionSec;
  let current = state;
  let released = false;

  if (current.held) {
    const recovered = marginSec >= PREPARATION.frontierReleaseMarginSeconds;
    // `input.playing` is the escape: something outside this guard has the television.
    if (!recovered && !input.conversionComplete && !input.playing) {
      return { state, action: 'none', marginSec };
    }
    const heldForSec =
      current.heldSinceMs === null ? 0 : Math.max(0, (input.atMs - current.heldSinceMs) / 1000);
    current = {
      ...current,
      held: false,
      heldAtSec: null,
      heldSinceMs: null,
      heldTotalSec: current.heldTotalSec + heldForSec,
    };
    released = true;
  }

  // …and now the same question as any other sample, from a state that is not held. A film
  // that escaped a hold into a margin still under two minutes is held again here, with a
  // `hold` action, so a fresh PAUSE goes to the device.
  if (!input.conversionComplete && input.playing && marginSec < PREPARATION.frontierMarginSeconds) {
    return {
      state: {
        ...current,
        held: true,
        // The frame it is held on **now** — a film that escaped has moved since, and 10i's
        // "resumes at the frame it held" means the frame it was actually taken from.
        heldAtSec: input.positionSec,
        heldSinceMs: input.atMs,
        holds: current.holds + 1,
      },
      action: 'hold',
      marginSec,
    };
  }

  return { state: current, action: released ? 'release' : 'none', marginSec };
}

/**
 * How long until the margin is back — the *\<time\>* in *Still preparing — back in about…*.
 *
 * While the picture is held the playhead does not move, so the whole of the recovery is the
 * frontier's own progress: the margin grows at the conversion's speed. `null` when no speed
 * has been measured yet or the conversion has stopped moving, in which case there is no
 * honest number and the sentence says so by leaving it out.
 */
export function secondsUntilRelease(marginSec: number, speed: number | null): number | null {
  if (speed === null || speed <= 0) return null;
  const shortfallSec = PREPARATION.frontierReleaseMarginSeconds - marginSec;
  if (shortfallSec <= 0) return 0;
  return shortfallSec / speed;
}

/**
 * Can this conversion ever keep ahead of playback again?
 *
 * Below real time it cannot: every second watched costs more than a second produced, so the
 * margin the guard just recovered would be spent again immediately and the film would spend
 * more of the evening held than playing. 10f's answer to that is to stop pretending and say
 * the film will play when the conversion is done.
 *
 * Measured against 1.0× and not against the gate's 1.5×, deliberately: 1.5 is the margin of
 * safety we require before *starting*, and applying it here would send a film that is
 * genuinely keeping up — say 1.2× — to the back of a queue it does not belong in.
 */
export function canCatchUp(speed: number | null): boolean {
  return speed === null || speed > 1;
}

/**
 * The founder's sentence while the picture is held.
 *
 * **The founder chose these words on 2026-08-21**, over *Waiting for the conversion* and
 * *Catching up*: "preparing" is the vocabulary the rest of the app already uses for this
 * work, so a held picture reads as the same job continuing rather than a new kind of
 * problem. It is deliberately **not** *Buffering* — criterion 11e turns a *Buffering* over
 * 10 s into a reconnection attempt, and three of the 2026-08-21 freezes (10.2 s, 10.3 s,
 * 25.5 s) would each have torn down a perfectly healthy connection to fix a problem that
 * was never the network's.
 */
export function stillPreparingMessage(secondsUntilBack: number | null): string {
  if (secondsUntilBack === null) return 'Still preparing…';
  return `Still preparing — back in about ${describeApproxSeconds(secondsUntilBack)}`;
}

/**
 * …and the sentence when it will not be back: 10f's *"says so plainly"*.
 *
 * No new control comes with it (M3b cut 2). The way out is the two presses M2 already
 * built — *Stop*, then *Resume from \<position\>* — and both of those stay live, which is
 * why this is a sentence rather than a button.
 */
export function willPlayWhenReadyMessage(secondsRemaining: number | null): string {
  if (secondsRemaining === null)
    return 'Still preparing — this film will play when the conversion is done';
  return `Still preparing — this film will play when the conversion is done, in about ${describeApproxSeconds(
    secondsRemaining,
  )}`;
}

/**
 * The furthest a seek may land: the frontier, less the margin the guard defends (10d).
 *
 * Refusing at exactly the frontier would put the playhead where the guard is about to hold
 * it, which is a jump into a held picture — technically correct and useless. Never
 * negative: early in a conversion there is nowhere forward to go, and 0 says that honestly.
 */
export function seekLimitSec(frontierSec: number): number {
  return Math.max(0, frontierSec - PREPARATION.frontierMarginSeconds);
}
