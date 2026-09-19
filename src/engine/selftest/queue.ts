import fsp from 'node:fs/promises';
import path from 'node:path';
import { LOOKAHEAD } from '../config.js';
import { preparedPathFor } from '../prepare/naming.js';
import type { Context } from './index.js';
import { assertion, observation, SelftestAbort, type Assertion } from './kit.js';
import { chooseAndCheck } from './m3.js';
import { detectStalls, samplesFromRecords } from './stalls.js';

/**
 * `queue --lookahead` — **the milestone**, proved against a real television.
 *
 * The PRD's own accounting (*"What M5b adds to the selftest"*) puts six criteria behind this
 * one command: 24f–24h, 24j–24l and 24ac. **This build proves 24h and the two of 24g's own
 * "fails if" clauses closest to it — nothing wider**, on the founder's explicit instruction
 * for tonight's run. What is deliberately not attempted, and why:
 *
 *  - **24j** (the media server's own per-mount delivery-in-flight record) needs the D2
 *    instrument built for 11g, wired to a per-mount view this file does not have access to.
 *    Deliberately not attempted here — it is real, separate work, not a gap in this scenario.
 *  - **24l** (the founder's folder compared byte-for-byte and by modification time, on both
 *    the completed and the abandoned path) is `check`'s `untouchedByUs` machinery generalised
 *    to two files and two paths through look-ahead. Deliberately not attempted here, for the
 *    same reason — it is its own piece of work, not folded in to make tonight's run wider
 *    than it was asked to be.
 *  - **24f** (abandon-on-reorder/-removal) and **24ac** (the row's own progress, and nowhere
 *    else) both need the renderer, or at least the queue mid-flight — this instrument only
 *    ever watches item 1 play undisturbed from load to its own natural end, which is exactly
 *    what 24h asks for and nothing about reordering or removing a row while it happens.
 *  - The base `queue` scenario's own criteria — 24a, 24c–24e, 24m–24r, 24w, 24z, 24aa, 24ab —
 *    are a different, larger instrument (reorder, remove, forecast, the end-of-queue screen,
 *    Stop/Resume, two-engine reattach, carried subtitles) and are **not** attempted by
 *    `--lookahead`. `queue` on its own (no `--lookahead`) is that instrument, and it does not
 *    exist yet — see the abort at the top of `scenarioQueue` below.
 *
 * ## The two films this needs, and why they are not interchangeable with `volume`'s one
 *
 * 24g's own milestone cannot be produced with one file: it is a *race*, and racing needs two
 * competitors. **Item 1** (`context.filePath`) has to be a film this television plays
 * natively — the same precondition `scenarioVolume` builds on — so that nothing about its own
 * playback depends on preparation. **Item 2** (`context.secondFilePath`) has to be a film this
 * television has to convert, and its own conversion has to be genuinely racing item 1's
 * runtime: too fast and 24g's "started after PLAYING, finished before item 1 ends" proves
 * nothing worth printing; too slow and the run exits 2 rather than pretend that never
 * happened (24g's own second "fails if").
 *
 * ## One fact this scenario discovered building it, worth stating rather than hiding
 *
 * **24z's natural order (`inNaturalOrder`, `src/engine/queue/order.ts`) decides which item
 * has a "next" one at all.** `queue.add` sorts the batch it is given; it does not preserve
 * the order the two paths were passed in. If item 2's file name sorts *before* item 1's in
 * that order, `queue.add` puts item 2 first, item 1 becomes the **last** row, and
 * `nextAfterPlaying` — the function look-ahead itself is built on — has nothing after it.
 * There would be no look-ahead to observe, and worse, no *sentence* explaining why: the run
 * would simply sit at item 1 forever with nothing next. So this checks the order immediately
 * after `queue.add`, before anything is checked or cast, and exits 2 with the fix in the
 * message rather than let the rest of the run discover it the slow way.
 *
 * ## What "for the whole of it" means for the stall count
 *
 * 24h's promise is graded across item 1's **entire** playback — from its own `LOAD` to its
 * own genuine end — using exactly `stalls.ts`'s instrument, unmodified, with `excludePreRoll`
 * set exactly as `m3`/`volume` already set it. The film is never stopped early: 24h's
 * condition is "a look-ahead job running for the whole of it", and stopping the film the
 * moment look-ahead finishes would grade a shorter, easier promise than the one written down.
 * Letting it run to a genuine `FINISHED` also lets 24m/24n's auto-advance actually fire, which
 * is the only way to confirm — from the log, not from having watched the scenario's own
 * intentions — that item 1 really did finish rather than this scenario merely giving up on it.
 */

/** Long enough for a repackage and a launch on real hardware; item 1 needs no conversion. */
const REACH_PICTURE_MS = 10 * 60_000;

/**
 * How long, after item 1 reaches `playing`, to wait for `lookahead.started` naming item 2.
 *
 * `LOOKAHEAD.cleanPlayBeforeStartMs` (60 s) is the clock the product itself waits out before
 * starting anything (24i) — this adds margin for the device's own reporting cadence and the
 * time this process takes to notice and dispatch, never for the product to be slow.
 */
const LOOKAHEAD_START_WAIT_MS = LOOKAHEAD.cleanPlayBeforeStartMs + 60_000;

/**
 * Extra time added to item 1's own measured duration when racing "item 2 prepared" against
 * "item 1 ended" — covers this process's own polling interval and the last device report
 * arriving after the fact, never a promise about the product.
 */
const FINISH_RACE_MARGIN_MS = 5 * 60_000;

/** How long a real join between two queue items is given to reach a picture on this run. */
const ADVANCE_TO_PICTURE_WAIT_MS = 60_000;

/** How often this scenario polls the log while racing two outcomes against each other. */
const POLL_MS = 250;

function monoOf(record: Record<string, unknown>): number {
  const value = record['mono'];
  return typeof value === 'number' ? value : 0;
}

function deviceSampleMonoOf(record: Record<string, unknown>): number {
  const value = record['monoMs'];
  return typeof value === 'number' ? value : monoOf(record);
}

function itemIdOf(record: Record<string, unknown>): string | null {
  const value = record['itemId'];
  return typeof value === 'string' ? value : null;
}

/**
 * 24g's own "never two at once", reconstructed honestly from the log rather than from the
 * engine's internal invariant (`LOOKAHEAD.itemsAhead === 1`) that already enforces it —
 * the whole point of an external instrument is not to trust the thing it is grading.
 *
 * Walks `lookahead.started`/`prepared`/`abandoned`/`handed_over` in time order and counts
 * every `started` that arrives while a job is already open. Simple on purpose: a cleverer
 * reconstruction is a second copy of `lookahead-runner.ts`'s own bookkeeping, graded against
 * itself.
 */
function overlappingLookaheadStarts(context: Context, fromMono: number, toMono: number): number {
  interface Edge {
    readonly mono: number;
    readonly opens: boolean;
    readonly itemId: string | null;
  }
  const edges: Edge[] = [];
  for (const record of context.samples('lookahead.started', fromMono)) {
    if (monoOf(record) <= toMono)
      edges.push({ mono: monoOf(record), opens: true, itemId: itemIdOf(record) });
  }
  for (const event of [
    'lookahead.prepared',
    'lookahead.abandoned',
    'lookahead.handed_over',
  ] as const) {
    for (const record of context.samples(event, fromMono)) {
      if (monoOf(record) <= toMono)
        edges.push({ mono: monoOf(record), opens: false, itemId: itemIdOf(record) });
    }
  }
  edges.sort((a, b) => a.mono - b.mono);

  let open: string | null = null;
  let overlaps = 0;
  for (const edge of edges) {
    if (edge.opens) {
      if (open !== null) overlaps += 1;
      open = edge.itemId;
    } else if (open !== null && open === edge.itemId) {
      open = null;
    }
  }
  return overlaps;
}

export async function scenarioQueue(context: Context): Promise<Assertion[]> {
  // The base `queue` scenario — 24a, 24c–24e, 24m–24r, 24w, 24z, 24aa, 24ab, run end to end
  // with nothing prepared ahead — is a separate, larger instrument that does not exist yet.
  // A `queue` run given no `--lookahead` silently becoming a weaker, undocumented thing would
  // be exactly the false green this file's own header warns against.
  if (!context.lookahead) {
    throw new SelftestAbort(
      '`--scenario queue` on its own is the base instrument (24a, 24c-e, 24m-r, 24w, 24z, 24aa, ' +
        '24ab) and this build does not implement it yet. Pass `--lookahead` for the one leg this ' +
        'build proves: 24g/24h, a look-ahead job running for the whole of item 1.',
    );
  }
  const item2Path = context.secondFilePath;
  if (item2Path === null) {
    // The command line already refuses this combination (`refuseFile2`) before a device is
    // even looked for. Guarded again here so nothing that constructs a `Context` directly —
    // a test, a future caller — can reach a queue of one and call it a look-ahead run.
    throw new SelftestAbort(
      '`--scenario queue --lookahead` needs a second file this television has to convert: `--file2 <path>`',
    );
  }

  const assertions: Assertion[] = [];
  const item1Path = context.filePath;
  const item1Name = path.basename(item1Path);
  const item2Name = path.basename(item2Path);
  const item2ArtifactPath = preparedPathFor(item2Path);

  // A clean slate: no queue left behind by a previous run in this same process, no file
  // still selected from one.
  context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });
  context.engine.dispatch({ type: 'file.clear' });
  await context.waitFor('the previous file to clear', 5_000, (snapshot) => snapshot.file === null);

  const scenarioStartMono = context.mono();
  context.engine.dispatch({ type: 'queue.add', paths: [item1Path, item2Path] });
  await context.waitFor(
    'both files to appear in the queue',
    5_000,
    (snapshot) => snapshot.queue.items.length >= 2,
  );

  // See the header: 24z's natural order, not the order the two paths were passed in, decides
  // which row is first — and only the first of two has a "next" one for look-ahead to reach.
  const rows = context.snapshot().queue.items;
  const firstRow = rows[0];
  const secondRow = rows[1];
  if (firstRow === undefined || secondRow === undefined) {
    throw new SelftestAbort('the queue never held two rows after `queue.add` — nothing was cast');
  }
  if (firstRow.name !== item1Name || secondRow.name !== item2Name) {
    throw new SelftestAbort(
      `"${item2Name}" sorts before "${item1Name}" in the queue's own natural order (24z), so item 1 ` +
        'would be the LAST row with nothing after it for a look-ahead to run against — this run could ' +
        'not have demonstrated 24g. Rename item 1 so it sorts first (e.g. a leading "1 - "), or swap ' +
        'which file is --file and which is --file2, and run again.',
    );
  }
  const item2Id = secondRow.id;

  // 24a's own per-row check, read from the log rather than guessed at a fixed delay: the
  // fact both rows need before anything about a job or a stall could mean 24g/24h.
  let item1Checked: Record<string, unknown> | undefined;
  let item2Checked: Record<string, unknown> | undefined;
  const checkDeadline = context.mono() + 30_000;
  while (
    context.mono() < checkDeadline &&
    (item1Checked === undefined || item2Checked === undefined)
  ) {
    const checked = context.samples('queue.item_checked', scenarioStartMono);
    item1Checked ??= checked.find((record) => record['name'] === item1Name);
    item2Checked ??= checked.find((record) => record['name'] === item2Name);
    if (item1Checked === undefined || item2Checked === undefined) await context.sleep(150);
  }
  if (item1Checked === undefined || item2Checked === undefined) {
    throw new SelftestAbort('the queue never finished checking both rows — nothing was cast');
  }

  // --- 24g's own first "fails if": item 2 already had a prepared sibling. ------------------
  //
  // Read from `queue.item_checked`'s own `preparedPath` — the exact fact `lookaheadTarget`
  // itself gates on (`check.prepared !== null`) — rather than this file independently
  // `stat`-ing the disk and risking a different answer from the one the engine is about to act
  // on.
  const alreadyPrepared = item2Checked['preparedPath'];
  if (typeof alreadyPrepared === 'string') {
    throw new SelftestAbort(
      `"${item2Name}" already has a prepared sibling on disk (${alreadyPrepared}) before this run cast ` +
        'anything — this run could not have demonstrated look-ahead (24g). Delete it, or pass a second ' +
        'file with none, and run again.',
    );
  }
  // A probe that failed outright (no ffprobe on this machine, or an unreadable file) leaves
  // `kind` `null` — distinct from a real verdict of `ready`/`impossible`, and worth its own
  // sentence rather than folding into either.
  if (item2Checked['kind'] === null) {
    throw new SelftestAbort(
      `"${item2Name}" could not be checked at all — there is no verdict to say whether it needs ` +
        'converting, so there is nothing here that could be a look-ahead job. Nothing was cast.',
    );
  }
  // Not one of 24g's own named "fails if" clauses, but the same shape of honesty: a second
  // item that plays natively has no preparation for a look-ahead to run, and a run that
  // quietly cast two ordinary films and called it 24g would be the exact lie this harness
  // exists to prevent.
  if (item2Checked['kind'] === 'ready') {
    throw new SelftestAbort(
      `"${item2Name}" plays natively on "${context.deviceName}" — CastGood needs no preparation for ` +
        'it, so there is no job for a look-ahead to run and this run could not demonstrate 24g/24h. ' +
        'Pass a second file this television has to convert.',
    );
  }
  if (item2Checked['kind'] === 'impossible') {
    throw new SelftestAbort(
      `"${item2Name}" is judged impossible for "${context.deviceName}" — no look-ahead could ever be ` +
        'started for it. Pass a second file this television can play once converted.',
    );
  }

  try {
    // --- Cast item 1, the ordinary way, and let the queue adopt it -------------------------
    //
    // `chooseAndCheck` re-selects item 1's own path through the single-file check, which is
    // the same live check `queueCheckFor` reads back for whichever row matches it by path
    // (`index.ts`'s `queueCheckFor`). `startCast` then matches the cast source back to
    // `queue.items` by path and sets `queue.playingId` itself (`index.ts`'s `startCast`) —
    // nothing here reaches into the queue to do that by hand.
    await chooseAndCheck(context, item1Path);
    const item1DurationSec = context.snapshot().file?.durationSec ?? 0;
    if (item1DurationSec <= 0) {
      throw new SelftestAbort(`"${item1Name}" reported no duration — nothing here could be timed`);
    }

    const castStartMono = context.mono();
    context.engine.dispatch({ type: 'cast.start' });
    let item1PlayingMono: number;
    try {
      item1PlayingMono = await context.waitForState('playing', REACH_PICTURE_MS);
    } catch {
      throw new SelftestAbort(
        `item 1 ("${item1Name}") never reached playing within ` +
          `${String(Math.round(REACH_PICTURE_MS / 60_000))} minutes — nothing about look-ahead could ` +
          'be measured',
      );
    }
    if (context.snapshot().queue.playingId === null) {
      throw new SelftestAbort(
        'the queue never adopted item 1 as its playing row (`queue.playingId` stayed null) — this run ' +
          'cannot tell whether it is testing the queue or an ordinary cast',
      );
    }

    // --- 24g: item 2's job started after item 1 reached PLAYING ----------------------------
    let startedRecord: Record<string, unknown> | undefined;
    const startDeadline = context.mono() + LOOKAHEAD_START_WAIT_MS;
    while (startedRecord === undefined && context.mono() < startDeadline) {
      startedRecord = context
        .samples('lookahead.started', item1PlayingMono)
        .find((record) => itemIdOf(record) === item2Id);
      if (startedRecord === undefined) {
        // Bail early rather than wait out the full budget if item 1 has already ended —
        // there is no clean-play window left for a job to start inside.
        const alreadyOver = context
          .samples('position.sample', castStartMono)
          .some((record) => record['idleReason'] === 'FINISHED');
        if (alreadyOver) break;
        await context.sleep(POLL_MS);
      }
    }
    if (startedRecord === undefined) {
      throw new SelftestAbort(
        `no look-ahead job ever started for item 2 ("${item2Name}") while item 1 played. Pass an ` +
          `item 1 that plays cleanly for at least ${String(LOOKAHEAD.cleanPlayBeforeStartMs / 1000)}s ` +
          '(24i), or check the log for why look-ahead never started.',
      );
    }
    const lookaheadStartedAtMono = monoOf(startedRecord);
    assertions.push(
      assertion(
        'lookaheadStartedAfterItem1Playing',
        'eq',
        1,
        lookaheadStartedAtMono >= item1PlayingMono ? 1 : 0,
        'bool',
        "24g: proved from timestamps, not from intent — item 2's job started at a mono time at or " +
          'after item 1 reached PLAYING',
      ),
      observation(
        'lookaheadStartDelayAfterPlayingMs',
        Math.round(lookaheadStartedAtMono - item1PlayingMono),
        'ms',
        '24i: the clean-play clock before look-ahead may start is 60s; printed so a run that started ' +
          'suspiciously early or late is visible',
      ),
    );

    // --- 24g: item 2's job finished before item 1 ended -------------------------------------
    //
    // A race, not a sequence: either `lookahead.prepared` for item 2 arrives, or item 1's own
    // device-reported `FINISHED` arrives first. The second of those is 24g's own second
    // "fails if" — "if item 1 was shorter than item 2's measured conversion" — and it exits 2,
    // never 1: a run that could not produce the condition it exists to test is not a broken
    // promise about the app.
    let preparedRecord: Record<string, unknown> | undefined;
    let item1FinishedRecord: Record<string, unknown> | undefined;
    const raceDeadline = castStartMono + item1DurationSec * 1_000 + FINISH_RACE_MARGIN_MS;
    while (
      preparedRecord === undefined &&
      item1FinishedRecord === undefined &&
      context.mono() < raceDeadline
    ) {
      preparedRecord = context
        .samples('lookahead.prepared', lookaheadStartedAtMono)
        .find((record) => itemIdOf(record) === item2Id);
      if (preparedRecord !== undefined) break;
      item1FinishedRecord = context
        .samples('position.sample', castStartMono)
        .find((record) => record['idleReason'] === 'FINISHED');
      if (item1FinishedRecord !== undefined) break;
      await context.sleep(POLL_MS);
    }
    if (preparedRecord === undefined) {
      throw new SelftestAbort(
        item1FinishedRecord !== undefined
          ? `item 1 ("${item1Name}") reached its own end before item 2's look-ahead conversion ` +
              "finished — item 1 was shorter than item 2's measured conversion, so this run could not " +
              'demonstrate 24g\'s milestone (its own "fails if"). Pass a longer item 1, or a second ' +
              'file whose conversion is faster.'
          : "neither item 2's look-ahead finished nor item 1 reached its own end within item 1's " +
              'measured duration plus margin — nothing here proves or disproves 24h. Nothing was ' +
              'measured to a conclusion.',
      );
    }
    const lookaheadPreparedAtMono = monoOf(preparedRecord);

    // --- Let the film finish for real (24h: "for the whole of it") -------------------------
    while (item1FinishedRecord === undefined && context.mono() < raceDeadline) {
      item1FinishedRecord = context
        .samples('position.sample', castStartMono)
        .find((record) => record['idleReason'] === 'FINISHED');
      if (item1FinishedRecord === undefined) await context.sleep(POLL_MS);
    }
    if (item1FinishedRecord === undefined) {
      throw new SelftestAbort(
        `item 1 ("${item1Name}") never reported reaching its own end within its measured duration ` +
          'plus margin — 24h\'s "for the whole of it" could not be closed out.',
      );
    }
    const item1FinishedAtMono = deviceSampleMonoOf(item1FinishedRecord);

    assertions.push(
      assertion(
        'lookaheadPreparedBeforeItem1Ended',
        'eq',
        1,
        lookaheadPreparedAtMono < item1FinishedAtMono ? 1 : 0,
        'bool',
        "24g: item 2's job finished before item 1 ended, proved from timestamps",
      ),
    );

    // --- 24g: never two look-ahead jobs at once, across the whole of item 1's playback -----
    const overlaps = overlappingLookaheadStarts(context, castStartMono, item1FinishedAtMono);
    assertions.push(
      assertion(
        'neverTwoLookaheadJobsAtOnce',
        'eq',
        0,
        overlaps,
        'overlaps',
        '24g: at most one look-ahead job exists at any moment, reconstructed from ' +
          "lookahead.started/prepared/abandoned/handed_over across item 1's whole load-to-finish window",
      ),
    );

    // --- 24h: the stall count, from the device's own samples, across the whole of item 1 ---
    const stallReport = detectStalls(
      samplesFromRecords(
        context.samples('position.sample', castStartMono) as Record<string, unknown>[],
      ),
      { excludePreRoll: true },
    );
    assertions.push(
      assertion(
        'stallsAcrossItem1WithLookaheadRunning',
        'eq',
        0,
        stallReport.count,
        'stalls',
        "24h: zero stalls attributable to preparation, counted from the device's own position " +
          'samples and playerState histogram — never our own opinion. This is the promise the whole ' +
          'product is built on',
      ),
      observation(
        'item1StallTotalSeconds',
        stallReport.totalSeconds,
        's',
        '24h: printed beside the count — a single long stall and many short ones both cost an evening',
      ),
      observation(
        'item1StallLongestSeconds',
        stallReport.longestSeconds,
        's',
        '24h: the founder’s own patience is spent on the longest hold, not the average',
      ),
      observation(
        'item1PlayerStateHistogram',
        JSON.stringify(stallReport.playerStates),
        'states',
        'stalls.ts\'s own rule: "read the histogram, never the verdict" — this is what that costs ' +
          'when it is wrong',
      ),
    );

    // --- 24h's own exit-2 guard: a clean film with no look-ahead proves nothing -------------
    //
    // Unreachable given the wait above already found `startedRecord` — kept as a cheap,
    // explicit belt-and-braces the PRD asks for by name, rather than trusted to have been
    // true four hundred lines ago.
    if (
      stallReport.count === 0 &&
      context
        .samples('lookahead.started', castStartMono)
        .every((record) => itemIdOf(record) !== item2Id)
    ) {
      throw new SelftestAbort(
        "24h's own exit-2 guard: the film was clean, but no look-ahead job for item 2 was ever " +
          'observed running against it — a clean film with nothing prepared ahead of it is not ' +
          'evidence for 24h. This should be unreachable given the wait earlier in this run.',
      );
    }

    // --- 24m/24n, observed live: only confirming the join genuinely happened ---------------
    //
    // Not this scenario's graded promise — the ≤10s join budget is 24m's own number, and the
    // base `queue` scenario (not built by this instrument) is where it is asserted. This only
    // confirms the film that just finished really did hand over to item 2 in the same live
    // session, which is what makes 24h's "for the whole of it" a claim about a real, complete
    // evening rather than a run this scenario cut short.
    let item2PlayingAtMono: number | null;
    try {
      item2PlayingAtMono = await context.waitFor(
        'item 2 to reach playing after item 1 finished, in the same live session',
        ADVANCE_TO_PICTURE_WAIT_MS,
        () =>
          context.snapshot().session.state === 'playing' &&
          context.samples('queue.advance_ready', item1FinishedAtMono).length > 0,
      );
    } catch {
      item2PlayingAtMono = null;
    }
    const advanceStarted = context.samples('queue.advance_started', item1FinishedAtMono);
    const advanceReady = context.samples('queue.advance_ready', item1FinishedAtMono);
    const joinWindowEnd = item2PlayingAtMono ?? context.mono();
    const releasedMidJoin = context
      .samples('session.state_changed', item1FinishedAtMono)
      .filter((record) => monoOf(record) <= joinWindowEnd)
      .some((record) => record['to'] === 'stopped' || record['to'] === 'ended');

    assertions.push(
      assertion(
        'queueAdvanceStartedFired',
        'eq',
        1,
        advanceStarted.length > 0 ? 1 : 0,
        'bool',
        "24m/24n: item 1's own FINISHED was treated as the join, not a stop or a refusal",
      ),
      assertion(
        'queueAdvanceReadyFired',
        'eq',
        1,
        advanceReady.length > 0 ? 1 : 0,
        'bool',
        "24m/24n: item 2 was ready with no preparation wait — look-ahead's whole payoff",
      ),
      assertion(
        'item2ReachedPlayingAfterAdvance',
        'eq',
        1,
        item2PlayingAtMono !== null ? 1 : 0,
        'bool',
        '24m: item 2 came up in the same session after item 1 genuinely finished',
      ),
      assertion(
        'televisionNeverReleasedMidJoin',
        'eq',
        0,
        releasedMidJoin ? 1 : 0,
        'bool',
        "24m/24n: the session never showed stopped/ended between item 1's own end and item 2's " +
          'picture — the same fact test/engine/queue-advance.test.ts already asserts on, observed ' +
          'live here',
      ),
    );
  } finally {
    // 13e in spirit, for a folder rather than a volume — see the header on why a
    // *successfully completed* look-ahead artifact is left exactly where the product's own
    // 2026-08-19 "no cleanup policy" ADR leaves one (9d: the founder deletes it by hand). This
    // only removes an artifact that this run's own abort left behind despite look-ahead never
    // actually finishing — which the pipeline's atomic rename (9e/P2) and `engine.stop()`'s
    // own dispose() (P6) already guarantee cannot happen. Defensive, and cheap: if it ever
    // fires, that is itself a finding, not routine housekeeping.
    const everCompleted = context
      .samples('lookahead.prepared', scenarioStartMono)
      .some((record) => itemIdOf(record) === item2Id);
    if (!everCompleted) {
      await fsp.rm(item2ArtifactPath, { force: true }).catch(() => undefined);
    }
  }

  return assertions;
}
