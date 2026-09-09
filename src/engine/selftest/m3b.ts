import fsp from 'node:fs/promises';
import path from 'node:path';
import { PREPARATION, SELFTEST } from '../config.js';
import { preparedPathFor } from '../prepare/naming.js';
import {
  assertion,
  holdsTheTelevision,
  observation,
  SelftestAbort,
  type Assertion,
} from './kit.js';
import { detectStalls, samplesFromRecords, type ExcludedWindow } from './stalls.js';
import type { Context } from './index.js';

/**
 * `headstart` — Milestone 3b's scenario, and **the instrument every M3b verdict is read
 * through**.
 *
 * It exists because of criterion 10j, which exists because of a specific failure: the spike
 * that measured head-start casting reported *"confirmed"* twice about a run in which the
 * founder's picture froze eight times for 46 seconds. It had no stall assertion at all. So
 * the rules below are not style; each one is a way that report could have been false, closed:
 *
 *  - **Stalls are counted from the device's own position samples and its `playerState`
 *    histogram**, never from our guard's opinion. Our guard is one of the things under test.
 *  - **Both gate numbers are printed as measured at the moment of the LOAD**, and an absent
 *    one is a failed assertion rather than a silent pass.
 *  - **A run in which the gate never opened, or a film too short to head-start, exits 2** —
 *    never 0. A test that quietly degrades into something easier and goes green is the most
 *    expensive lie this project could tell itself, and it has already been told six times.
 *
 * The exit-code contract is unchanged and not negotiable: **0** every assertion passed,
 * **1** an assertion missed its target, **2** the run could not happen.
 */

/**
 * A film has to be longer than this for a head start to mean anything.
 *
 * The gate needs **ten minutes of prepared video** before it will open, so a film of ten
 * minutes and one second could technically qualify and would prove nothing: the conversion
 * would finish moments after the gate opened and there would be no live frontier to watch,
 * no margin to protect and no guard to observe. Five extra minutes is the smallest film that
 * produces a real head-start session — and anything shorter is exit 2 with that said plainly.
 */
const MINIMUM_FILM_SEC = PREPARATION.headStartSeconds + 300;

/** A conversion of a full-length film. It is minutes to hours, and that is the feature. */
const CONVERSION_WAIT_MS = 3 * 60 * 60_000;

/**
 * How long a starved run is watched before the negative is called.
 *
 * Long enough that the gate would have opened if it were going to — several speed windows
 * and enough conversion to pass the ten-minute mark at any honest speed — and short enough
 * that proving a negative does not cost an evening. At 0.7× this is about seven minutes of
 * film converted, against a gate that wants ten and a speed it will never see.
 */
const STARVED_OBSERVATION_MS = 10 * 60_000;

/**
 * How long the guard is given to fire, and then to let go, in the `--rate-after-gate` run.
 *
 * Generous because both waits are the *product's* own arithmetic on a real conversion: at
 * 0.5× the margin closes at half a second per second, and once the picture is held it
 * recovers at the conversion's speed. Neither is a target to design to — the criterion's own
 * 5 s reaction bound is measured from the log, not from this.
 */
const GUARD_WAIT_MS = 15 * 60_000;

/** How long to keep watching after a release, so a guard that flaps is caught. */
const WATCH_AFTER_RELEASE_MS = 90_000;

/**
 * How far from the held frame the film may resume and still be "where it was held".
 *
 * 10i says *at the frame it held*. The device reports its position about once a second and a
 * resume takes a round trip, so a second or two of slack is the measurement's own precision
 * rather than a weakening of the promise — anything larger is the film having moved.
 */
const RESUME_TOLERANCE_SEC = 3;

/** How often the full-film run asks whether the film is still going. */
const FULL_FILM_POLL_MS = 5_000;

/** Long enough for the picture to be settled, in the run whose subject is the guard. */
const SHORT_WATCH_MS = 20_000;

/** How long the film is watched, once it starts, before the run is wound up. */
const WATCH_MS = 3 * 60_000;

/**
 * How long a device command is excused for.
 *
 * A pause, a seek or a stop stops the picture on purpose, and counting that as a stall would
 * make the scenario report the freezes it caused itself. Eight seconds because a seek on the
 * `AI PONT` took up to 3.9 s to land and the status after it is not instant.
 */
const COMMAND_GRACE_MS = 8_000;

export async function scenarioHeadStart(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const excluded: ExcludedWindow[] = [];
  const startedAt = context.mono();

  // --- Can this run happen at all? Every answer below is exit 2, never a pass -----------
  context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });
  context.engine.dispatch({ type: 'file.clear' });
  await context.waitFor('the previous file to clear', 5_000, (snapshot) => snapshot.file === null);
  context.engine.dispatch({ type: 'file.select', path: context.filePath });
  try {
    await context.waitFor(
      'the check to produce a verdict',
      SELFTEST.stateWaitMs,
      (snapshot) => snapshot.check === null && snapshot.file !== null,
    );
  } catch {
    throw new SelftestAbort(`the file could not be checked: ${context.filePath}`);
  }

  const chosen = context.snapshot().file;
  const durationSec = chosen?.durationSec ?? 0;
  if (durationSec < MINIMUM_FILM_SEC) {
    // **Exit 2, and this is one of the two cases 10j names.** A shorter film casts when its
    // conversion finishes — correct behaviour, and no evidence whatsoever about a head start.
    throw new SelftestAbort(
      `this scenario needs a film of at least ${String(Math.round(MINIMUM_FILM_SEC / 60))} minutes to head-start; "${
        chosen?.name ?? context.filePath
      }" is ${String(Math.round(durationSec / 60))} — nothing was cast`,
    );
  }
  if (chosen?.verdict?.kind !== 'convert') {
    throw new SelftestAbort(
      `head start only applies to a film this television has to convert; CastGood judged this one "${
        chosen?.verdict?.kind ?? 'nothing'
      }", so there is no growing conversion to watch — pass a film this device cannot play natively`,
    );
  }

  const folder = path.dirname(context.filePath);
  const artifact = preparedPathFor(context.filePath);
  const artifactExisted = await fsp.stat(artifact).then(
    () => true,
    () => false,
  );
  if (artifactExisted) {
    // A prepared sibling means the film casts instantly and no conversion runs at all.
    throw new SelftestAbort(
      `this film has already been prepared (${path.basename(artifact)}), so nothing would be converted — delete it, or pass a film that has not been prepared`,
    );
  }

  // --- The press, and the wait ---------------------------------------------------------
  const pressedAt = context.mono();
  context.engine.dispatch({ type: 'cast.start' });
  if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
    await context.waitFor(
      'the long-job confirmation',
      SELFTEST.stateWaitMs,
      (snapshot) => snapshot.file?.verdict?.confirmation != null,
    );
    context.engine.dispatch({ type: 'preparation.confirm' });
  }

  // 10a: *"the app said beforehand roughly when watching would start"*. Read before the
  // picture appears, because afterwards it is no longer a claim about the future.
  let saidBefore: number | null = null;
  try {
    await context.waitFor('CastGood to say when watching can start', 10 * 60_000, (snapshot) => {
      saidBefore = snapshot.preparation.watchableInSeconds;
      return saidBefore !== null;
    });
  } catch {
    // Reported as a failed assertion below rather than aborting: a run that got this far has
    // measurements worth having.
  }
  assertions.push(
    assertion(
      'saidWhenWatchingWouldStart',
      'eq',
      'stated',
      saidBefore === null ? 'never stated' : 'stated',
      'bool',
      '10a: the app said beforehand roughly when watching would start',
    ),
    observation(
      'watchingPredictedInSeconds',
      saidBefore === null ? null : Math.round(saidBefore),
      's',
      'what the founder was told before the picture appeared',
    ),
  );

  // --- `--rate`: the starved case, and its expectations are the mirror image -------------
  //
  // 10f's first half — *"below the speed gate when the founder presses"* — measured through
  // the product rather than through a spike republishing a fixture on a timer. What this run
  // must show is that **nothing was loaded on the television at all**, and that the founder
  // was given a wait that updates rather than an indefinite *starting soon…*.
  if (context.conversionReadRate !== null) {
    const estimates = new Set<number>();
    let served = false;
    /** Did the app ever state a *countdown to watching* on a conversion that cannot reach it? */
    let promisedAnEarlyStart = 0;
    /** …and did it say the honest thing instead? */
    let saidItPlaysOnCompletion = 0;
    const until = context.mono() + STARVED_OBSERVATION_MS;
    while (context.mono() < until) {
      const snapshot = context.snapshot();
      if (snapshot.headStart !== null) served = true;
      if (snapshot.preparation.secondsRemaining !== null) {
        estimates.add(Math.round(snapshot.preparation.secondsRemaining));
      }
      // **This is the assertion, and it used to be missing.** The old one counted distinct
      // values of the conversion's own ETA, which changes for any job that is progressing —
      // so it would have passed unchanged on the countdown-to-a-moment-that-cannot-arrive
      // that was fixed on 2026-08-21, which is the exact defect 10f is about.
      if (snapshot.preparation.watchableInSeconds !== null) promisedAnEarlyStart += 1;
      if (snapshot.preparation.playsOnCompletion) saidItPlaysOnCompletion += 1;
      await context.sleep(2_000);
    }
    if (served) {
      // The condition this run exists to test was not produced: at a throttled speed the
      // gate cannot legitimately open, so either `--rate` never reached ffmpeg or the gate
      // is not reading a sustained figure. Either way it is **exit 2** — this run is not
      // evidence about the starved case, and a green line here would be the lie 10j names.
      throw new SelftestAbort(
        `the gate opened on a conversion throttled to ${String(
          context.conversionReadRate,
        )}× real time, which it must never do — nothing here is evidence either way`,
      );
    }
    // **After the press, and only after it.** In the `m3` aggregate, `convert` has already
    // cast a film and left its own status records behind; counting those would report a
    // television that was never loaded as one that was.
    const statuses = context.samples('position.sample', pressedAt);
    assertions.push(
      assertion(
        'starvedNothingLoaded',
        'lte',
        0,
        statuses.length,
        'statuses',
        '10h: a conversion below the speed gate loads nothing on the television — not one media status arrived, because nothing was ever cast',
      ),
      assertion(
        'starvedNeverPromisedAnEarlyStart',
        'lte',
        0,
        promisedAnEarlyStart,
        'readings',
        '10f: **fails if the app states a time that cannot arrive.** A conversion below the gate can never start the film early, so a countdown to watching is a number about a moment that will not happen — the seventh time this project has had to correct one',
      ),
      assertion(
        'starvedSaidItPlaysOnCompletion',
        'gte',
        1,
        saidItPlaysOnCompletion,
        'readings',
        '10f: …and it says so plainly instead — the film plays when the conversion is done',
      ),
      assertion(
        'starvedWaitKeptUpdating',
        'gte',
        2,
        estimates.size,
        'estimates',
        '10f: a **live** estimate, never an indefinite “starting soon…” — the conversion’s own remaining time, restated as it changed',
      ),
      observation(
        'starvedConversionRate',
        context.conversionReadRate,
        '×',
        'what the conversion was throttled to, so the gate had to refuse it',
      ),
      observation(
        'starvedObservedSeconds',
        Math.round(STARVED_OBSERVATION_MS / 1000),
        's',
        'how long the gate was watched staying shut',
      ),
    );
    // Nothing is left running: the conversion is cancelled and the folder is as it was.
    context.engine.dispatch({ type: 'preparation.cancel' });
    await context.sleep(5_000);
    assertions.push(
      assertion(
        'starvedLeftNothingBehind',
        'eq',
        0,
        (await fsp.readdir(folder)).filter((name) => name.includes('(CastGood)')).length,
        'files',
        '8d: cancelling leaves nothing beside the source',
      ),
    );
    return assertions;
  }

  // --- 10h: the gate, and both of its numbers at the moment of the LOAD ------------------
  let servedAt: number | null = null;
  try {
    servedAt = await context.waitFor(
      'the head-start gate to open',
      CONVERSION_WAIT_MS,
      (snapshot) => snapshot.headStart !== null,
    );
  } catch {
    // Falls through to the exit-2 check below.
  }

  const loadRecord = context.samples('cast.head_start_serving', pressedAt).pop();
  if (servedAt === null || loadRecord === undefined) {
    // **The other exit-2 case 10j names.** The conversion may have finished first, or never
    // sustained 1.5×; either is a real answer about this PC and neither is evidence about a
    // head start. It is never exit 0.
    const gate = context.samples('preparation.finished', pressedAt).pop();
    throw new SelftestAbort(
      context.conversionReadRateAfterGate === null
        ? `the head-start gate never opened on this machine, so nothing here is evidence about watching before a conversion finishes — the conversion ${
            gate === undefined ? 'was still running' : 'finished first'
          }. This is not a pass and not a failure: it is a run that did not happen`
        : // The likeliest cause is not the gate at all: `--rate-after-gate` is built on
          // ffmpeg's `-readrate_initial_burst`, and a build without it refuses the whole
          // invocation. Naming the suspect beats reporting a gate that never got a chance.
          `the gate never opened on the --rate-after-gate run. If the conversion failed immediately, this build of ffmpeg may not support -readrate_initial_burst, which that flag is made of — check ffmpeg.job_failed in the log before reading anything into the gate`,
    );
  }

  const preparedAtLoad = loadRecord['preparedSec'];
  const speedAtLoad = loadRecord['sustainedSpeed'];
  assertions.push(
    assertion(
      'gatePreparedSecondsAtLoad',
      'gte',
      PREPARATION.headStartSeconds,
      typeof preparedAtLoad === 'number' ? Math.round(preparedAtLoad) : null,
      's',
      '10h: ≥ 10 minutes of video prepared before anything was loaded. **An absent number is a failed assertion, not a pass.**',
    ),
    assertion(
      'gateSustainedSpeedAtLoad',
      'gte',
      PREPARATION.headStartMinSpeed,
      typeof speedAtLoad === 'number' ? Math.round(speedAtLoad * 100) / 100 : null,
      '×',
      `10h: sustained over at least ${String(
        PREPARATION.headStartSpeedWindowMs / 1000,
      )} s of conversion, never a burst`,
    ),
    observation(
      'gateOpenedAfterMs',
      Math.round(servedAt - pressedAt),
      'ms',
      'how long the founder waited between pressing and the picture starting',
    ),
  );

  // --- The film plays, and is watched ----------------------------------------------------
  let playingAt: number | null = null;
  try {
    playingAt = await context.waitForState('playing', SELFTEST.stateWaitMs * 3);
  } catch {
    // Reported below.
  }
  assertions.push(
    assertion(
      'headStartReachedPlaying',
      'eq',
      'playing',
      playingAt === null ? context.snapshot().session.state : 'playing',
      'state',
      '10a: casting begins automatically, with no second press',
    ),
  );

  // 10c: the duration on screen is **CastGood's own**, for the whole session. Both device
  // classes report `media.duration: -1` from the first status to the last.
  const shownDuration = context.snapshot().session.durationSec;
  assertions.push(
    assertion(
      'durationIsOurOwn',
      'eq',
      Math.round(durationSec),
      Math.round(shownDuration),
      's',
      '10c: the length on screen is CastGood’s own probe’s, never the device’s (which is −1)',
    ),
  );
  const deviceDurations = context
    .samples('position.sample', pressedAt)
    .map((record) => record['durationSec'])
    .filter((value): value is number => typeof value === 'number');
  assertions.push(
    observation(
      'deviceReportedDuration',
      deviceDurations.length === 0 ? 'never reported' : String(deviceDurations.at(-1)),
      'sec',
      'what the television said the film’s length was — SPIKE-1 measured −1 on every status, on both device classes',
    ),
  );

  // Watch. Nothing is pressed for this stretch, which is what makes every freeze in it
  // attributable to preparation rather than to the harness.
  //
  // Shorter in the `--rate-after-gate` run, and deliberately: there the conversion is already
  // falling behind, so every second here is margin spent before the guard can be watched
  // doing its job — and a hold that fired in the middle of this stretch would land inside the
  // 10d jump below rather than in the block written to grade it.
  const fullFilmMs = context.headStartWatchMs;
  let watchedForMs = 0;
  let reachedEnd = false;
  if (fullFilmMs === null) {
    await context.sleep(context.conversionReadRateAfterGate === null ? WATCH_MS : SHORT_WATCH_MS);
  } else {
    // **The full-film run, and 10b's "the only evidence that counts".**
    //
    // Nothing is pressed for the whole of this — no jump, no guard, no throttle — which is
    // what makes every freeze in it attributable to preparation rather than to the harness.
    // It stops when the film ends or when the operator's window runs out, whichever is
    // first, and says which happened rather than letting a run that was cut short read like
    // a film watched through.
    const startedWatchAt = context.mono();
    const deadline = startedWatchAt + fullFilmMs;
    while (context.mono() < deadline) {
      const state = context.snapshot().session.state;
      if (!holdsTheTelevision(state)) {
        // `ended` is a film that played out. `stopped`/`idle` here would mean something took
        // the television away, which the assertions below will show as a film that did not
        // reach its end.
        reachedEnd = state === 'ended';
        break;
      }
      await context.sleep(Math.min(FULL_FILM_POLL_MS, Math.max(1, deadline - context.mono())));
    }
    watchedForMs = context.mono() - startedWatchAt;
  }

  // --- 10d and 10e: the unprepared region, and a jump into it ---------------------------
  const beforeSeek = context.snapshot();
  const limit = beforeSeek.headStart?.seekLimitSec ?? 0;
  // **10d only exists while there is still film that has not been converted.**
  //
  // On the `m3` aggregate of 2026-08-25 it did not, and the leg graded the jump anyway.
  // The founder's PC converted a 113-minute film at 47× — the whole thing was finished
  // 86 s after the picture appeared, well inside this scenario's own three-minute watch —
  // so by the time the jump was made the frontier *was* the end of the film. The engine
  // correctly clamped `frontier + 600` to the end, the television played the last frame,
  // the film finished, and the instrument had graded a jump into the unconverted region of
  // a film that was entirely converted. `ourClampHeldAndPlaybackContinued` would have
  // measured `ended` against a target of `still playing`: an invented failure about a
  // product that did the right thing twice.
  //
  // So the condition is checked rather than assumed, from the product's own
  // `conversionComplete`, and a run that cannot produce it says so by name instead of
  // pressing something. It is **reported, loudly, not silently skipped** — the same shape
  // as `conversionStillRunningAtEnd` at the end of this file — because the alternative is
  // an exit 2 that would take the gate, the stalls and the guard down with it, and those
  // were all really measured.
  const stillConverting =
    beforeSeek.headStart !== null && beforeSeek.headStart.conversionComplete !== true;
  if (!stillConverting) {
    assertions.push(
      observation(
        'unpreparedRegionAtJumpTime',
        'none — the conversion had already finished',
        'bool',
        '10d could not be graded on this run: there was no unconverted region left to jump into by the time the jump would have been made, so nothing here says anything about the clamp. A slower conversion, or a longer film, is what makes this leg measurable — see checklist',
      ),
    );
  } else {
    assertions.push(
      assertion(
        'seekLimitBehindFrontier',
        'gte',
        PREPARATION.frontierMarginSeconds,
        Math.round((beforeSeek.headStart?.frontierSec ?? 0) - limit),
        's',
        '10d: the furthest a jump may land is the frontier less the two-minute margin',
      ),
    );
  }

  // Skipped in the `--rate-after-gate` run: a jump to the far end of what is converted is
  // exactly what that run does for itself a moment later, and doing it twice would leave the
  // guard's block grading a hold that had already happened somewhere else.
  // Also skipped in the full-film run: 10b's evidence is a film nobody touched, and a jump
  // in the middle of it would make every freeze after it arguably the harness's doing.
  if (
    context.conversionReadRateAfterGate === null &&
    stillConverting &&
    context.headStartWatchMs === null
  ) {
    // **10d, and *not* 10e — the distinction cost this scenario an assertion that could not
    // fail.** Asking for a position past the frontier through the product's own intent never
    // reaches a television: the engine clamps it to `seekLimitSec` before a byte leaves this
    // PC, which is the belt working exactly as 10d says it should. What that measures is *our*
    // clamp, so that is what it is called now.
    //
    // 10e is about the **braces** — what the receiver does when a past-frontier seek reaches
    // it anyway — and no run through the product can produce that without deliberately
    // defeating our own guard. Its evidence is three measured traces on two device classes
    // (Ultra 2026-08-19: asked 348.9 s at a 228.9 s frontier, clamped to 181.9 s, played on;
    // `AI PONT` 2026-08-20: asked 620.1 s at 500.1 s, clamped to 457.5 s, played on; and again
    // in the starved run of 2026-08-21, which is the harder version). See the M3b report: the
    // PRD's `[selftest]` tag on 10e is owed a correction rather than a bypass in shipping code.
    const seekAt = context.mono();
    excluded.push({ fromMs: seekAt - 500, toMs: seekAt + COMMAND_GRACE_MS, why: 'commanded' });
    context.engine.dispatch({
      type: 'playback.seek',
      positionSec: (beforeSeek.headStart?.frontierSec ?? 0) + 600,
    });
    await context.sleep(COMMAND_GRACE_MS);
    const afterSeek = context.snapshot();
    assertions.push(
      assertion(
        'ourClampHeldAndPlaybackContinued',
        'eq',
        'still playing',
        afterSeek.session.state === 'playing' || afterSeek.session.state === 'buffering'
          ? 'still playing'
          : afterSeek.session.state,
        'state',
        '10d: a drag into the unconverted region lands at the furthest safe point and the film carries on — never a stall, never a dead session',
      ),
      assertion(
        'ourClampStoppedItReachingTheDevice',
        'lte',
        limit + PREPARATION.frontierMarginSeconds,
        Math.round(afterSeek.session.positionSec),
        's',
        '10d: the position the founder ended up at is inside what has been converted — which is also why this run says nothing about 10e, whose evidence is the spike traces',
      ),
      observation(
        'pastFrontierSeekLandedSec',
        Math.round(afterSeek.session.positionSec),
        's',
        'where the playhead ended up, read back from the device’s own status rather than assumed',
      ),
    );
    // Let it settle again before the stall count is taken.
    await context.sleep(15_000);
  }

  // --- `--rate-after-gate`: the conversion falls behind **mid-film** (10i, 10f) -----------
  //
  // **The run that makes the guard fire on a real television, and until 2026-08-21 there was
  // none.** `--rate` starves the conversion before the gate, so nothing is ever loaded and
  // there is no film to hold; an unthrottled conversion opens the gate at ≥1.5× and the
  // margin only ever grows. So the mechanism carrying 10b — the promise nothing in M3 may
  // weaken — had no automated route to a device at all, and M3b's own done-definition ("the
  // margin guard has been *seen* to hold a film mid-conversion and release it by itself")
  // had nothing to reach it with.
  //
  // What this does: the conversion has already burst past the gate at full speed and the film
  // is playing. Now it runs below real time, so the frontier closes on the playhead — the
  // exact 2026-08-21 condition, with the guard in place this time. One founder action speeds
  // it up: a drag to the furthest legal position, which is a thing a person really does and
  // which puts the playhead 120 s behind the frontier instead of an hour.
  if (context.conversionReadRateAfterGate !== null) {
    const beforeHold = context.snapshot();
    const target = beforeHold.headStart?.seekLimitSec ?? 0;
    const jumpedAt = context.mono();
    // Excused as a command: the picture stops on purpose while the device seeks, and
    // counting that would be the scenario reporting a stall it caused itself.
    excluded.push({ fromMs: jumpedAt - 500, toMs: jumpedAt + COMMAND_GRACE_MS, why: 'commanded' });
    context.engine.dispatch({ type: 'playback.seek', positionSec: target });
    await context.sleep(COMMAND_GRACE_MS);

    let heldAt: number | null = null;
    try {
      heldAt = await context.waitFor(
        'the guard to hold the picture',
        GUARD_WAIT_MS,
        (snapshot) => snapshot.headStart?.hold != null,
      );
    } catch {
      // Reported as a failed assertion rather than an abort: a run that got here produced
      // the condition, and "the guard never fired" is a **result**, not a run that did not
      // happen. It is the single most important red line this scenario can print.
    }
    const holdRecord = context.samples('headstart.guard_hold', jumpedAt).at(0);
    const heldSnapshot = context.snapshot();
    assertions.push(
      assertion(
        'guardHeldTheFilm',
        'eq',
        'held',
        heldAt === null ? 'never held' : 'held',
        'state',
        '10i: with the conversion falling behind, the guard paused the film rather than letting it reach the frontier. **This is the assertion that makes 10b more than a promise.**',
      ),
      assertion(
        'guardHoldWasAnnounced',
        'eq',
        'announced',
        (heldSnapshot.headStart?.hold?.message ?? '').startsWith('Still preparing')
          ? 'announced'
          : (heldSnapshot.headStart?.hold?.message ?? 'nothing said'),
        'sentence',
        '10b: *a held film is announced, a stall is not* — and never the word Buffering, which 11e would turn into a reconnection',
      ),
      observation(
        'guardHeldAtMarginSec',
        holdRecord === undefined ? null : Number(holdRecord['marginSec']),
        's',
        'how much converted film was left ahead of the playhead when the guard took the picture',
      ),
    );

    let releasedAt: number | null = null;
    if (heldAt !== null) {
      try {
        releasedAt = await context.waitFor(
          'the guard to let go by itself',
          GUARD_WAIT_MS,
          (snapshot) => snapshot.headStart?.hold == null,
        );
      } catch {
        // Same again: a hold that never releases is the worst outcome here and must print.
      }
      const releaseRecord = context.samples('headstart.guard_release', heldAt).at(0);
      const resumed = context.snapshot();
      assertions.push(
        assertion(
          'guardReleasedByItself',
          'eq',
          'released',
          releasedAt === null ? 'still holding' : 'released',
          'state',
          '10i: it resumes **by itself** when the margin recovers — nothing pressed, no error shown',
        ),
        assertion(
          'guardResumedWhereItHeld',
          'lte',
          RESUME_TOLERANCE_SEC,
          heldSnapshot.session.positionSec === 0
            ? null
            : Math.round(Math.abs(resumed.session.positionSec - heldSnapshot.session.positionSec)),
          's',
          '10i: **fails if the film resumes anywhere other than where it was held** — the device’s own position before and after, compared',
        ),
        observation(
          'guardHeldForSec',
          releaseRecord === undefined ? null : Number(releaseRecord['heldForSec']),
          's',
          'how long the founder waited, which is the number the sentence on screen was counting down',
        ),
        observation(
          'guardReleasedAtMarginSec',
          releaseRecord === undefined ? null : Number(releaseRecord['marginSec']),
          's',
          'the margin it let go at — hysteresis, so it cannot flap',
        ),
      );
      // Watch a little longer with the throttle still on, so a guard that flaps or a film
      // that walks into the frontier a second time is caught rather than missed by stopping.
      await context.sleep(WATCH_AFTER_RELEASE_MS);
    }
  }

  // --- The full-film run's own promises --------------------------------------------------
  if (fullFilmMs !== null) {
    const watchedSec = Math.round(watchedForMs / 1000);
    assertions.push(
      assertion(
        'filmReachedEnd',
        'eq',
        'ended',
        reachedEnd ? 'ended' : context.snapshot().session.state,
        'state',
        `10b: the film was watched to its end, untouched. **Fails if the window ran out first** — a run cut short has not seen the whole film and must not read as though it had. This one watched ${String(watchedSec)} s of a ${String(Math.round(durationSec))} s film`,
      ),
      observation(
        'filmWatchedSec',
        watchedSec,
        's',
        'how much of the film was actually watched with nothing pressed — the span every stall below was counted across',
      ),
      observation(
        'filmDurationSec',
        Math.round(durationSec),
        's',
        "the film's own length, from CastGood's probe. If the two numbers above are far apart the run did not see the film through",
      ),
    );
  }

  // --- 10b and 10j: the stalls, counted from the device ---------------------------------
  //
  // Every window in which the guard announced a hold is excused, because *"a held film is
  // announced, a stall is not"*. The holds themselves are reported as observations.
  const guardHolds = context.samples('headstart.guard_hold', pressedAt);
  const guardReleases = context.samples('headstart.guard_release', pressedAt);
  const monoOf = (record: Record<string, unknown>, fallback: number): number => {
    const stamped = record['monoMs'];
    if (typeof stamped === 'number') return stamped;
    const arrived = (record as { mono?: unknown }).mono;
    return typeof arrived === 'number' ? arrived : fallback;
  };
  for (const hold of guardHolds) {
    const from = monoOf(hold, pressedAt);
    // **The next release after this hold, not the one at the same index.** A hold the film
    // escaped — somebody pressed Play on a phone — is re-asserted without a release in
    // between, so pairing by position would mis-align every window after the first and
    // start excusing stretches of film that nobody explained.
    const to = guardReleases
      .map((release) => monoOf(release, context.mono()))
      .find((at) => at >= from);
    // Generous either side: the pause takes a round trip to reach the device and the film
    // takes one to start again, and neither is a frozen picture nobody explained.
    excluded.push({
      fromMs: from - 2_000,
      toMs: (to ?? context.mono()) + COMMAND_GRACE_MS,
      why: 'announced',
    });
  }

  const samples = samplesFromRecords(context.samples('position.sample', pressedAt)).filter(
    (sample) => sample.monoMs >= (playingAt ?? servedAt),
  );
  // `excludePreRoll`: these samples start at the LOAD (filtered above), so the window
  // before the first frame belongs to press-to-picture, not to 10b. Measured on the bedroom
  // Chromecast 2026-08-25: 2.49 s with the conversion 602 s ahead at 6.06x, 3.31 s with it
  // throttled to 0.5x — the same behaviour either side of the two-second line, so without
  // this the threshold decides the verdict instead of the product. A film that never starts
  // is still reported in full; see the note on `isPreRoll`.
  const stalls = detectStalls(samples, { excluded, excludePreRoll: true });

  assertions.push(
    assertion(
      'stallsAttributableToPreparation',
      'lte',
      0,
      stalls.count,
      'stalls',
      `10b: zero stalls, where a stall is the device's own position failing to advance for ≥ ${String(
        PREPARATION.stallSeconds,
      )} s while the app believed the film was playing and nothing was pressed. Counted from ${String(
        stalls.samples,
      )} device reports, never from our guard.`,
    ),
    assertion(
      // A verdict computed from no samples is the vacuous pass this whole file exists to
      // prevent: with zero reports, "zero stalls" is true and means nothing.
      'stallSamplesRead',
      'gte',
      10,
      stalls.samples,
      'samples',
      '10j: a stall verdict with no measured samples behind it is not a pass',
    ),
    observation('stallSecondsTotal', stalls.totalSeconds, 's', 'total frozen picture'),
    observation('stallLongestSeconds', stalls.longestSeconds, 's', 'the longest single freeze'),
    observation(
      'playerStateHistogram',
      Object.entries(stalls.playerStates)
        .map(([state, count]) => `${state}:${String(count)}`)
        .join(' '),
      'states',
      'read the histogram, never the verdict — 17 BUFFERING against 48 PLAYING was the number that mattered on 2026-08-21 and nothing pointed at it',
    ),
    observation(
      'guardHolds',
      guardHolds.length,
      'holds',
      '10i: how many times the guard held the picture, and each one was announced',
    ),
    observation(
      // A hold that had to be taken back means something outside CastGood was driving the
      // television — a phone, the Google Home app — or that a PAUSE went unanswered. Worth
      // knowing, and invisible without a name of its own.
      'guardHoldsReasserted',
      guardHolds.filter((hold) => hold['reasserted'] === true).length,
      'holds',
      'holds the film had escaped and the guard took back',
    ),
    observation(
      'guardHeldSecondsTotal',
      guardHolds.length === 0
        ? 0
        : Math.round(
            guardReleases.reduce((total, release) => total + Number(release['heldForSec'] ?? 0), 0),
          ),
      's',
      'how long the film spent held, in total',
    ),
    observation(
      'guardLongestHoldSeconds',
      guardReleases.reduce(
        (longest, release) => Math.max(longest, Number(release['heldForSec'] ?? 0)),
        0,
      ),
      's',
      'the longest single hold',
    ),
  );

  // --- 10g: one file beside the source, and no folder of fragments ----------------------
  context.engine.dispatch({ type: 'cast.stop' });
  await context.waitFor(
    'the television to be released',
    SELFTEST.stateWaitMs,
    // `ended` counts. This leg's own 10d jump can finish the film — and did, on the m3
    // aggregate of 2026-08-25 — after which the engine has already let the television go.
    (snapshot) => !holdsTheTelevision(snapshot.session.state),
  );
  // The tidy-up runs after the television is let go, so it is given a moment.
  await context.sleep(5_000);

  const finished = context
    .samples('preparation.finished', pressedAt)
    .filter((record) => record['ok'] === true)
    .pop();
  const conversionFinished = finished !== undefined;
  if (conversionFinished) {
    const after = await fsp.readdir(folder);
    const prepared = after.includes(path.basename(artifact));
    // **Where the segments actually live**, which is not beside the film. This looked in the
    // founder's own folder until 2026-08-21, where a `.ts` file can never appear — segments
    // are written to CastGood's working directory, so the count was zero by construction and
    // the assertion could not have caught 10g's real risk: a folder of fragments left behind
    // in app data after the television was let go.
    const segmentsDir = path.join(context.engine.paths.preparedDir, 'headstart');
    const fragments = await fsp.readdir(segmentsDir).catch(() => [] as string[]);
    assertions.push(
      assertion(
        'onePreparedFileBesideTheSource',
        'eq',
        'yes',
        prepared ? 'yes' : 'no',
        'bool',
        '10g: the conversion finishes into one file beside the source',
      ),
      assertion(
        'noStagingFilesBesideTheSource',
        'eq',
        0,
        after.filter((name) => name.endsWith('.partial')).length,
        'files',
        '8d/10g: nothing half-written left in the founder’s own folder',
      ),
      assertion(
        'noFragmentsLeftBehind',
        'eq',
        0,
        fragments.length,
        'files',
        `10g: **no folder of fragments** — counted in ${'CastGood’s own working folder'}, where segments really live, not beside the film where one could never appear`,
      ),
    );
  } else {
    assertions.push(
      observation(
        'conversionStillRunningAtEnd',
        'yes',
        'bool',
        '10g could not be graded: the run ended before the conversion did, so there is no finished artifact to look at yet. The scenario watched a head start and stopped it, which is what it exists to do.',
      ),
    );
  }

  assertions.push(
    observation(
      'runSeconds',
      Math.round((context.mono() - startedAt) / 1000),
      's',
      'how long this scenario took end to end',
    ),
  );
  return assertions;
}
