import { CAST, PREPARATION, SELFTEST, TIMING } from '../config.js';
import type { CastTransport, TransportFactory } from '../cast/index.js';
import type { Context } from './index.js';
import { assertion, observation, SelftestAbort, type Assertion } from './kit.js';
import { chooseAndCheck } from './m3.js';
import { detectStalls, samplesFromRecords } from './stalls.js';

/**
 * M5a's `volume` scenario — the volume control, on a real television, with a real film.
 *
 * ⚠️ **The expensive lie available in this milestone is "we sent a message and nobody
 * objected".** A volume run that issues `SET_VOLUME`, sees no error and reports green
 * would pass identically against a set that ignored it completely, one that clamped it to
 * a third of the value, and one that is not there. **It is prevented by construction, not
 * by care**: every assertion below is graded from an echoed `RECEIVER_STATUS`, the verdict
 * prints the level **before**, the level **asked for** and the level **reported after** for
 * every leg, and **a leg where before equals after is never a pass**.
 *
 * **What it cannot prove, ever**: that the sound in the room changed. That is story 23's
 * real promise, it is human checklist item 1, and no instrument in this project reaches it.
 *
 * ⚠️ **13e, and it is new in M5a: the television's volume is put back.** Everything this
 * selftest has ever written was ours to delete. A volume is the founder's television — it
 * is permanent, it outlives CastGood, and the next thing watched on that set starts where
 * we left it. A run that ends leaving a set at 10% is a defect even if every assertion
 * passed, so the restore happens on pass, on failure and on abort alike.
 *
 * **One refinement SPIKE-5 forced on that rule, learned the hard way on 2026-09-07**: a
 * television that is not casting reports `level: 0`, and that is **not its volume**. The
 * spike restored what it found and left the set silent. So this scenario reads the level to
 * restore **after the film is playing**, never before.
 */

/** Long enough for a repackage and a launch on real hardware; short of a full conversion. */
const REACH_PICTURE_MS = 10 * 60_000;

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';

/** How close two reported levels must be to count as the same number. */
const SAME = 0.005;

interface VolumeReading {
  readonly level: number | null;
  readonly muted: boolean | null;
}

function reported(context: Context): VolumeReading {
  const volume = context.snapshot().session.volume;
  return { level: volume?.level ?? null, muted: volume?.muted ?? null };
}

function sameLevel(a: number | null, b: number | null): boolean {
  return a !== null && b !== null && Math.abs(a - b) <= SAME;
}

/** Every `SET_VOLUME` that actually left this process since `afterMono`. */
function sent(context: Context, afterMono: number): number {
  return context.samples('session.volume_sent', afterMono).length;
}

function retries(context: Context, afterMono: number): number {
  return context.samples('session.volume_retry', afterMono).length;
}

/**
 * Somebody else's phone, played by a second CASTV2 connection — 23c.
 *
 * The change must genuinely not come through our session, which is the criterion's own
 * "fails if". Modelled on `launchOtherApp`, and like it, a connection that cannot be
 * opened is a run that could not happen rather than a broken promise.
 */
/**
 * Move this television's volume from a **second, independent CASTV2 connection**, and
 * return whether the set actually took it.
 *
 * ⚠️ **It used to return `true` unconditionally, and that turned an instrument failure into
 * a failed promise about the app.** The old version passed `onMessage: () => undefined`,
 * sent `CONNECT` and `SET_VOLUME`, waited 750 ms and resolved `true` — reasoning that
 * *"whether we hear about it is the thing under test, so this connection closes rather than
 * waiting for its own answer."* That conflates two different connections. Whether our
 * **engine's session** notices is indeed what 23c tests; whether **this sender's own
 * socket** was acknowledged is just this sender checking it did the thing it claims to have
 * done, and it touches nothing under test.
 *
 * On 2026-09-08 it cost a false failure on **both** televisions: 23c graded `null` against a
 * 2 s target while the engine's poll ran perfectly seventeen times, once a second, with
 * nothing to see — because the intervention never happened. SPIKE-5's `external` leg moved
 * the same set from a second connection four minutes later, which is what proved the app
 * innocent. The PRD is explicit that this must be **exit 2**: *"if the second sender could
 * not be opened and the run graded anything at all"*.
 *
 * So this now waits for a `RECEIVER_STATUS` **on its own connection** confirming a level
 * that actually moved. A device that quantises or clamps still counts — the test is *"did
 * the room change"*, not *"did it obey exactly"* — which is why this compares against
 * `previousLevel` rather than against what was asked.
 */
function setVolumeFromSecondSender(
  address: string,
  port: number,
  connect: TransportFactory,
  level: number,
  previousLevel: number | null,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    let pollTimer: NodeJS.Timeout | null = null;
    const finish = (result: boolean, transport?: CastTransport): void => {
      if (settled) return;
      settled = true;
      if (pollTimer !== null) clearInterval(pollTimer);
      transport?.close();
      resolve(result);
    };
    /** A status that proves the set moved: it reports a level, and not the one it was on. */
    const confirms = (raw: string): boolean => {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== 'object' || parsed === null) return false;
        const status = (parsed as { status?: { volume?: { level?: unknown } } }).status;
        const reported = status?.volume?.level;
        if (typeof reported !== 'number') return false;
        if (sameLevel(reported, level)) return true;
        // A set that clamps or quantises still counts — the question is *"did the room
        // change"*, not *"did it obey exactly"*. But it must have moved **towards** what was
        // asked, so ordinary drift and somebody else's unrelated change cannot confirm it.
        if (previousLevel === null) return !sameLevel(reported, null);
        const movedTowards =
          Math.abs(reported - level) < Math.abs(previousLevel - level) &&
          !sameLevel(reported, previousLevel);
        return movedTowards;
      } catch {
        return false;
      }
    };
    void connect(
      { host: address, port, timeoutMs: CAST.connectTimeoutMs },
      {
        onMessage: (message) => {
          if (message.namespace === NS_RECEIVER && confirms(message.data)) {
            finish(true);
          }
        },
        onClose: () => finish(false),
      },
    ).then(
      (transport) => {
        const timer = setTimeout(() => finish(false, transport), CAST.requestTimeoutMs);
        timer.unref?.();
        const send = (namespace: string, payload: Record<string, unknown>): void => {
          transport.send({
            sourceId: 'sender-volume',
            destinationId: 'receiver-0',
            namespace,
            data: JSON.stringify(payload),
          });
        };
        send(NS_CONNECTION, { type: 'CONNECT' });
        send(NS_RECEIVER, { type: 'SET_VOLUME', volume: { level }, requestId: 1 });
        // ⚠️ **Then ASK. These televisions do not announce.**
        //
        // Waiting for an unsolicited `RECEIVER_STATUS` here was wrong for the exact reason
        // SPIKE-5 exists to have established: on all three of the founder's sets a volume
        // change is **poll-only** — 15 s of silence, then a poll reads it in 2–8 ms. The
        // only status that arrives unbidden is the direct reply to our own `SET_VOLUME`,
        // and on a `Chromecast Ultra` that reply can still carry the *previous* level.
        // So this sender polls for its own confirmation, which is what `spike/m5a.ts`'s
        // `external` leg does and why that leg reads this set correctly.
        const ask = (): void => send(NS_RECEIVER, { type: 'GET_STATUS', requestId: 2 });
        const poll = setInterval(ask, 250);
        poll.unref?.();
        pollTimer = poll;
        setTimeout(ask, 120).unref?.();
      },
      () => finish(false),
    );
  });
}

/**
 * Wait until **this app** has stopped moving the volume, and the set has stopped answering.
 *
 * ⚠️ **23c is unmeasurable until this is true, and on 2026-09-08 that cost a false failure
 * on a `Chromecast Ultra`.** The leg had begun ~4 ms after the app's own `SET_VOLUME` for
 * 0.39 went out, and that command was still unanswered. A second sender watching receiver
 * statuses **cannot tell who moved a volume** — so a status carrying our own late change
 * looked exactly like the intervention arriving, the second sender reported success, and the
 * app was then graded for not showing a change nobody had made.
 *
 * The fix is not a cleverer check. It is making the window unambiguous: once nothing of ours
 * is in flight and the reported level has held still, **any** change during 23c has one
 * possible author.
 */
async function settleOurOwnVolume(context: Context): Promise<void> {
  const QUIET_MS = 1_200;
  const GIVE_UP_MS = 15_000;
  const startedAt = context.mono();
  let lastSeen = sent(context, startedAt);
  let lastLevel = reported(context).level;
  let quietSince = context.mono();
  while (context.mono() - startedAt < GIVE_UP_MS) {
    await context.sleep(150);
    const seenNow = sent(context, startedAt);
    const levelNow = reported(context).level;
    const stirred = seenNow !== lastSeen || !sameLevel(levelNow, lastLevel);
    lastSeen = seenNow;
    lastLevel = levelNow;
    if (stirred) {
      quietSince = context.mono();
      continue;
    }
    if (context.mono() - quietSince >= QUIET_MS) return;
  }
  // Falling out is not a failure: the caller still grades, and a set that never goes quiet
  // is a finding the assertion itself will express.
}

/** A level this set is demonstrably **not** at, so a leg cannot pass by standing still. */
function targetAwayFrom(current: number | null): number {
  if (current === null) return 0.3;
  return current > 0.45 ? 0.25 : 0.55;
}

export async function scenarioVolume(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];

  // The film first: a volume with nothing playing is a different question from the one
  // M5a asks (23i, and the founder's ruling on question 43).
  // The precondition, and it is the same one every live scenario builds on: the film is
  // chosen, checked, cast, and has been playing for a few seconds. A film interrupted in
  // its first half-second proves nothing about an evening.
  await chooseAndCheck(context, context.filePath);
  context.engine.dispatch({ type: 'cast.start' });
  await context.waitForState('playing', PREPARATION.checkBudgetMs + REACH_PICTURE_MS).catch(() => {
    throw new SelftestAbort(
      'the television never reached playing within ' +
        `${String(Math.round(REACH_PICTURE_MS / 60_000))} minutes. Pass a film this set plays with at most a ` +
        'repackage — nothing measured after this point would be a fact about a volume.',
    );
  });
  await context.sleep(5_000);
  if (context.snapshot().session.volume === null) {
    throw new SelftestAbort(
      'the app published no volume at all while a film was playing, so there was nothing to grade — ' +
        'this device reported no volume object on any receiver status.',
    );
  }

  const atStart = reported(context);
  if (atStart.level === null) {
    throw new SelftestAbort(
      'this television reported no volume level while playing, so every number below would be about a control we cannot even read',
    );
  }
  if (context.snapshot().session.volume?.controllable !== true) {
    // 23h's behaviour, not 23a's failure: a run that could not happen.
    throw new SelftestAbort(
      'this television reports `controlType: fixed` — it owns its own volume and will not take one from us. ' +
        'That is criterion 23h and the app shows a disabled control with a reason; there is nothing here to measure.',
    );
  }
  if (atStart.muted === true) {
    throw new SelftestAbort(
      'this television was already muted when the run began, so the mute leg could demonstrate nothing. Unmute it and run again.',
    );
  }

  /** 13e. Read **after** the film is playing, never before — SPIKE-5's lesson. */
  const restoreTo = atStart;

  try {
    // --- 23a and the round trip ------------------------------------------------
    const askedFor = targetAwayFrom(atStart.level);
    const beforeA = reported(context).level;
    const markA = context.mono();
    context.engine.dispatch({ type: 'volume.set', level: askedFor });
    let echoMs: number | null = null;
    try {
      echoMs =
        (await context.waitFor(
          'the television to report a new level',
          SELFTEST.stateWaitMs,
          (snapshot) => !sameLevel(snapshot.session.volume?.level ?? null, beforeA),
        )) - markA;
    } catch {
      echoMs = null;
    }
    const afterA = reported(context).level;
    // ⚠️ **23a is measured from the command being sent, never from the founder's press**,
    // and that is the criterion's own "fails if". The first version of this leg graded the
    // press-to-screen span and failed at 616 ms on hardware whose wire round trip is
    // 86–120 ms — the instrument was wrong, not the app. The engine stamps the wire span
    // itself (`session.volume_echoed.elapsedMs`, from the command leaving to the response
    // arriving), and that is what this reads. The press-to-screen number is kept below as
    // an observation, because it is what the founder actually experiences.
    // The screen updates from the *arriving status*, which is a beat before the request's
    // own promise settles and writes its timing line — so reading the log the instant the
    // snapshot moved finds nothing. This waits for the line rather than for a duration's
    // sake; without it the leg reports `null` and a null is a missed target, which would
    // fail the run for a race in the instrument.
    await context.sleep(500);
    const echoes = context
      .samples('session.volume_echoed', markA)
      .filter((record) => typeof record['elapsedMs'] === 'number');
    const wireMs = echoes.length === 0 ? null : Number(echoes[echoes.length - 1]?.['elapsedMs']);
    const firstRetries = retries(context, markA);
    if (sameLevel(afterA, beforeA)) {
      // The set answered nothing, or answered by standing still. Either way no level was
      // demonstrated to move, and a green run here would be exactly the lie this scenario
      // exists to prevent.
      throw new SelftestAbort(
        `this television did not move its volume at all: asked for ${askedFor.toFixed(2)} from ` +
          `${String(beforeA)} and it still reports ${String(afterA)}. Nothing about a volume could be measured.`,
      );
    }
    assertions.push(
      observation(
        'firstChangeEchoMs',
        wireMs === null ? null : Math.round(wireMs),
        'ms',
        "the FIRST volume command after a cast, kept as an observation rather than graded — it is documented as slow (23d's retry is what carries it) and grading this one sample is what made this leg a coin flip. 23a is graded on the distribution, below",
      ),
      observation(
        'pressToScreenMs',
        echoMs === null ? null : Math.round(echoMs),
        'ms',
        "what the founder actually experiences: the intent dispatched → a new level on screen. Not 23a's number, and deliberately ungraded — it includes any retry 23d issued",
      ),
      observation(
        'retriesOnTheFirstChange',
        firstRetries,
        'retries',
        "⚠️ Worth watching: on the founder's own hardware (2026-09-07) the FIRST volume command after a cast went unanswered past 500 ms and 23d's single retry is what carried it. Steady-state round trips on the same set are 86–120 ms, so this is about the moments just after a LOAD rather than about the set",
      ),
      observation(
        'levelBeforeAskedAfter',
        `${String(beforeA)} → asked ${askedFor.toFixed(2)} → reported ${String(afterA)}`,
        'levels',
        '23b: what the set answered, which is never assumed to be what was asked',
      ),
    );

    // --- 23a: a thirty-step drag is not thirty messages ------------------------
    const markDrag = context.mono();
    const base = reported(context).level ?? 0.3;
    const steps = Array.from({ length: 30 }, (_, index) =>
      Math.min(0.95, Math.max(0.05, base + (index - 15) * 0.01)),
    );
    for (const step of steps) context.engine.dispatch({ type: 'volume.set', level: step });
    const lastAsked = steps[steps.length - 1] ?? base;
    try {
      await context.waitFor(
        'the drag to settle on the last level asked for',
        SELFTEST.stateWaitMs,
        (snapshot) => {
          const level = snapshot.session.volume?.level ?? null;
          // A quantising set lands near, not on: the criterion is that the *last* value
          // wins, not that the set has our precision.
          return level !== null && Math.abs(level - lastAsked) <= 0.06;
        },
      );
    } catch {
      /* graded below from what was actually sent and reported */
    }
    const onWire = sent(context, markDrag);
    assertions.push(
      assertion(
        'dragMessagesOnWire',
        'lte',
        // **A small constant, not `presses - 1`.** Graded against 29-for-30 a regression
        // from one slot to a full queue would have come within one message of passing. The
        // rule is "one on the wire and one behind it", so what a drag costs is bounded by
        // the number of round trips it spans, not by how many times a finger moved: the
        // founder's two sets measure 2–3 for thirty presses.
        SELFTEST.dragVolumeMessages,
        onWire,
        'messages',
        '23a: one command in flight and a single pending value — never a queue, so a drag cannot flood the socket carrying the film',
      ),
      observation(
        'dragLastAskedAndReported',
        `asked ${lastAsked.toFixed(2)} last, television reports ${String(reported(context).level)} after ${String(onWire)} message(s) for ${String(steps.length)} presses`,
        'levels',
        '23a: the value the founder finished on is the one the room ends at',
      ),
    );

    // --- 23d: a set that answers by moving is never retried --------------------
    assertions.push(
      assertion(
        'retriesAfterAnAnsweredCommand',
        'eq',
        0,
        retries(context, markDrag),
        'retries',
        "23d: a level that landed somewhere other than what was asked is the device's answer, accepted permanently",
      ),
    );

    // --- 23c: somebody else's phone -------------------------------------------
    if (context.deviceAddress === '') {
      throw new SelftestAbort(
        'the device address was never logged, so no second sender could be opened — 23c cannot be produced (human checklist item 2 instead)',
      );
    }
    // Nothing of ours may still be in the air when the window opens — see `settleOurOwnVolume`.
    await settleOurOwnVolume(context);
    const beforeC = reported(context).level;
    const elsewhere = targetAwayFrom(beforeC);
    const markC = context.mono();
    const opened = await setVolumeFromSecondSender(
      context.deviceAddress,
      context.devicePort,
      context.secondConnection,
      elsewhere,
      beforeC,
    );
    if (!opened) {
      throw new SelftestAbort(
        'a second connection to this television did not move its volume, so the device-side change never ' +
          'happened — an intervention that never arrived is a run that could not happen, never a broken ' +
          'promise by the app (human checklist item 2 instead). ⚠️ This is exit 2 on purpose: on 2026-09-08 ' +
          'the same condition was graded as a failed 23c on both televisions while the engine polled ' +
          'faultlessly seventeen times with nothing to see.',
      );
    }
    let deviceSideMs: number | null = null;
    try {
      deviceSideMs =
        (await context.waitFor(
          'the app to follow a change it did not make',
          SELFTEST.stateWaitMs,
          (snapshot) => sameLevel(snapshot.session.volume?.level ?? null, elsewhere),
        )) - markC;
    } catch {
      deviceSideMs = null;
    }
    assertions.push(
      assertion(
        'deviceSideChangeShownMs',
        'lte',
        TIMING.optimisticWindowMs,
        deviceSideMs === null ? null : Math.round(deviceSideMs),
        'ms',
        "23c/4c: a change made from a second sender, shown without the app asking for it. ⚠️ SPIKE-5 found the AI PONT never announces one, so this is the supervisor's own receiver poll finding it",
      ),
    );

    // --- 23f: mute and unmute, and nothing remembered --------------------------
    const beforeMute = reported(context).level;
    context.engine.dispatch({ type: 'volume.mute', muted: true });
    let mutedSeen = false;
    try {
      await context.waitFor(
        'the television to report itself muted',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.volume?.muted === true,
      );
      mutedSeen = true;
    } catch {
      mutedSeen = false;
    }
    const whileMuted = reported(context).level;
    context.engine.dispatch({ type: 'volume.mute', muted: false });
    try {
      await context.waitFor(
        'the television to report itself unmuted',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.volume?.muted === false,
      );
    } catch {
      /* graded below */
    }
    const afterUnmute = reported(context).level;
    assertions.push(
      assertion(
        'muteRoundTripReported',
        'eq',
        1,
        mutedSeen && reported(context).muted === false ? 1 : 0,
        'both',
        '23f: the set reported itself muted and then unmuted, in one press each',
      ),
      assertion(
        'levelUnchangedAcrossMute',
        'eq',
        1,
        sameLevel(beforeMute, afterUnmute) ? 1 : 0,
        'identical',
        '23f: the reported level is the same either side of a mute/unmute pair, and CastGood sent no level to achieve it',
      ),
      observation(
        'muteLevels',
        `before ${String(beforeMute)} · while muted ${String(whileMuted)} · after unmute ${String(afterUnmute)}`,
        'levels',
        '23f: muting must not zero the level — that is what makes "we remember nothing" possible',
      ),
      assertion(
        'levelsSentDuringMute',
        'eq',
        0,
        context
          // ⚠️ **`volumeLevel`, not `level`** — and this is why the rename matters rather
          // than being tidy-up. `level` is a name the logger stamps on every record, so this
          // filter was reading the severity string `"info"` and `typeof … === 'number'` was
          // **always false**: the count was hard-wired to 0 and this assertion could not
          // fail. It passed vacuously in the 11/11 of 2026-09-08. Found 2026-09-08 while
          // trying to read a volume level out of the log and finding none there.
          .samples('session.volume_sent', markC)
          .filter((record) => typeof record['volumeLevel'] === 'number').length,
        'levels',
        "23f: mute is its own control and is never implemented as a level of zero (founder's ruling, question 42)",
      ),
    );

    // --- 23e: twenty changes, and the film does not notice ---------------------
    const markE = context.mono();
    const stateBefore = context.snapshot().session.state;
    if (stateBefore !== 'playing') {
      throw new SelftestAbort(
        `the film was not playing when the zero-effect leg began (it was ${stateBefore}), so there was no playback to be unaffected`,
      );
    }
    const settled = reported(context).level ?? 0.4;
    for (let index = 0; index < 20; index += 1) {
      context.engine.dispatch({
        type: 'volume.set',
        level: Math.min(0.9, Math.max(0.05, settled + (index % 2 === 0 ? 0.05 : -0.05))),
      });
      await context.sleep(400);
    }
    await context.sleep(2_000);
    const mediaMessages =
      context.samples('session.loading', markE).length +
      context.samples('session.seek_sent', markE).length +
      context.samples('session.play_sent', markE).length +
      context.samples('session.pause_sent', markE).length;
    // Stalls from the **device's own position samples**, never from our opinion — 10b's
    // definition unchanged, and the same instrument `m3` grades a whole film with.
    const stalls = detectStalls(
      samplesFromRecords(context.samples('position.sample', markE) as Record<string, unknown>[]),
      {},
    );
    // --- 23a: the round trip, graded across every echo the run produced --------
    //
    // ⚠️ **This is deliberately a distribution and not a sample, and the reason is not
    // flakiness.** Grading one command could fail a correct product — it did, at 573 ms on
    // 2026-09-09, on a set whose steady state is 86–120 ms, because the sample landed on
    // the first command after a LOAD, which this scenario's own observation already
    // documents as slow. **But the worse direction is the quiet one: a uniform regression
    // to 400 ms would have sailed through, every time, because 400 < 500.** One sample
    // cannot tell a slow moment from a slow product.
    //
    // The 23e leg above is the honest source: twenty changes at 400 ms spacing, and a
    // round trip of ~100 ms means each one completes before the next is sent, so they are
    // twenty real, independent round trips rather than a coalesced burst. The drag is not
    // usable for this — it puts **2–3** messages on the wire for thirty presses, which is
    // the coalescing it exists to prove.
    const echoMsAll = context
      .samples('session.volume_echoed', markA)
      .map((record) => record['elapsedMs'])
      .filter((value): value is number => typeof value === 'number')
      .sort((a, b) => a - b);
    const medianOf = (sorted: readonly number[]): number | null => {
      if (sorted.length === 0) return null;
      const mid = Math.floor(sorted.length / 2);
      const upper = sorted[mid];
      if (upper === undefined) return null;
      if (sorted.length % 2 === 1) return upper;
      const lower = sorted[mid - 1];
      return lower === undefined ? upper : (lower + upper) / 2;
    };
    const median = medianOf(echoMsAll);
    const overBudget = echoMsAll.filter((value) => value > TIMING.volumeEchoMs).length;
    if (echoMsAll.length < 5) {
      // Fewer than five round trips is not a distribution, and a median of two numbers
      // would be graded as though it were one. Nothing to say: exit 2, not a verdict.
      throw new SelftestAbort(
        `only ${String(echoMsAll.length)} volume round trip(s) were recorded, which is not enough to grade 23a as a distribution — the television answered too few commands for the median to mean anything`,
      );
    }
    assertions.push(
      assertion(
        'setVolumeToEchoMs',
        'lte',
        TIMING.volumeEchoMs,
        median === null ? null : Math.round(median),
        'ms',
        `23a, graded as the MEDIAN of ${String(echoMsAll.length)} round trips: the command leaving → the device's own echoed level arriving. Measured from the wire, never from the press — a press-to-screen number would spend the budget on the app's own plumbing and make the criterion unmeetable. A median rather than a sample so that neither a single slow moment fails a correct product, nor a uniform regression under the budget passes a broken one`,
      ),
      assertion(
        'volumeEchoesOverBudget',
        'lte',
        1,
        overBudget,
        'round trips',
        `23a: at most one round trip of ${String(echoMsAll.length)} may exceed ${String(TIMING.volumeEchoMs)} ms. The first command after a LOAD is the documented one, and 23d's retry carries it — a SECOND slow trip is a real finding and this is what catches it, which a median alone would hide`,
      ),
      observation(
        'volumeEchoSpreadMs',
        echoMsAll.length === 0
          ? null
          : `min ${String(Math.round(echoMsAll[0] ?? 0))} · median ${String(Math.round(median ?? 0))} · max ${String(Math.round(echoMsAll[echoMsAll.length - 1] ?? 0))}`,
        `ms across ${String(echoMsAll.length)} round trips`,
        'the shape of the round trip, so a run that is drifting is visible before it is failing',
      ),
      assertion(
        'mediaMessagesDuringVolumeChanges',
        'eq',
        0,
        mediaMessages,
        'messages',
        '23e: a volume change touches playback in no way at all — no LOAD, SEEK, PAUSE or PLAY',
      ),
      assertion(
        'stallsDuringVolumeChanges',
        'eq',
        0,
        stalls.stalls.length,
        'stalls',
        "23e/10b: the device's reported position never failed to advance for ≥2 s across twenty changes",
      ),
      assertion(
        'stillPlayingAfterTwentyChanges',
        'eq',
        1,
        context.snapshot().session.state === 'playing' ? 1 : 0,
        'playing',
        '23e: the film is still playing, which is the whole point of the leg',
      ),
    );
  } finally {
    // --- 13e: hand the television back exactly as it was found ----------------
    //
    // On pass, on failure and on abort. This runs before the harness stops the session,
    // so the connection the engine is holding is still the one that can do it.
    if (restoreTo.level !== null) {
      context.engine.dispatch({ type: 'volume.mute', muted: restoreTo.muted ?? false });
      await context.sleep(300);
      context.engine.dispatch({ type: 'volume.set', level: restoreTo.level });
      try {
        await context.waitFor(
          'the television to return to the level this run found it at',
          SELFTEST.stateWaitMs,
          (snapshot) => sameLevel(snapshot.session.volume?.level ?? null, restoreTo.level),
        );
      } catch {
        /* reported as an observation below rather than swallowed */
      }
      assertions.push(
        assertion(
          'volumeRestored',
          'eq',
          1,
          sameLevel(reported(context).level, restoreTo.level) ? 1 : 0,
          'restored',
          '13e: the volume belongs to the television, is permanent, and outlives CastGood — a run that ends leaving a set at 10% is a defect however green the rest was',
        ),
      );
    }
  }

  return assertions;
}
