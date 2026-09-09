import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  holdsTheTelevision,
  runSelftest,
  type Assertion,
  type ScenarioName,
  type SelftestVerdict,
} from '../../src/engine/selftest/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * **Do the instruments work?**
 *
 * Six of the selftest's scenarios — `seek`, `skip`, `recover`, `reattach`, `takeover` and
 * `sourcegone` — had never been executed by anything. They were written, reviewed, and
 * pointed at a television for the first time on a founder's evening. Three of the five
 * that *had* run that night failed on their own measurement rather than on the product,
 * and the evening was spent debugging the instrument instead of the app.
 *
 * This file runs each of them end to end against the scripted receiver and holds them to
 * the things a broken instrument gets wrong:
 *
 *  - it **completes** — no exception, no abort, and a verdict comes back;
 *  - **no assertion passes on a null measurement** (13b: "passed without a number is the
 *    thing this exists to replace");
 *  - **every assertion carries a name, a target, a comparison and a unit** (13b again).
 *
 * What it deliberately does **not** claim: that any of this works on a television. The
 * verdicts here stamp themselves `test-harness` and could never be read as a real run.
 * The point is narrower and it is the point that cost an evening — that the instrument
 * measures *something*, on every path, before anyone drives across the house to use it.
 */

function createFakeMdns(service: MdnsService): Mdns {
  const active = new Set<MdnsHandlers>();
  return {
    browse(handlers) {
      active.add(handlers);
      setTimeout(() => handlers.onUp(service), 5);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/** A file whose header says it is `durationSec` long — long enough for a 20-minute jump. */
function fixtureMp4(durationSec: number): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(durationSec * 1_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 3)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

/** `seek` grades a 20-minute jump in both directions, so the film has to be long. */
const FEATURE_LENGTH_SEC = 3_000;

/**
 * A television, a film and a data directory of this test's own.
 *
 * Deliberately **not** `beforeEach` state in module scope: these runs are declared
 * `concurrent`, and shared `let`s would have three scenarios casting to each other's
 * receiver. Every run here takes real time — a film really plays, a socket really dies —
 * so the honest way to shorten the wall clock is to overlap the waiting, not to fake it.
 */
/**
 * A subtitle beside the film, for the `subtitles` scenario to find.
 *
 * Cues far apart and several seconds wide on purpose: 18i grades a **long** jump onto a cue
 * it can land inside, and a fixture of one-frame cues in the opening minute would make the
 * scenario abort with "nothing to land on" rather than measure anything.
 */
const SIDECAR_SRT = `1
00:00:10,000 --> 00:00:14,000
Opening line.

2
00:10:00,000 --> 00:10:08,000
Ten minutes in.

3
00:20:00,000 --> 00:20:10,000
Twenty minutes in.

4
00:30:00,000 --> 00:30:08,000
Half an hour in.
`;

/**
 * A `.srt` that is offered by name and cannot be read once it is opened.
 *
 * 18a's list is built from the folder listing and the probe — it never parses — so this
 * film **has** a subtitle source as far as any precondition can tell, and the run only
 * discovers there is nothing in it when it tries to prepare it. That is the shape of a leg
 * that could not happen *after* the aggregate has already started, which is a different
 * fact from a film with no subtitle at all.
 */
const UNREADABLE_SRT = '<!DOCTYPE html>\n<html><body>404 — that subtitle is gone.</body></html>\n';

interface RunExtras {
  outage?: 'socket' | 'heartbeat';
  subtitleTiming?: boolean;
  subtitleBroken?: boolean;
  sidecar?: boolean;
  /** What to put in the sidecar, when the point of the run is that it cannot be read. */
  sidecarText?: string;
  /** The television, before the run starts: how this file makes a leg fail on purpose. */
  tweak?: (receiver: FakeReceiver) => void;
}

/** The verdict, and what the television was actually asked to do while it was produced. */
interface RunOutcome {
  readonly verdict: SelftestVerdict;
  readonly launched: boolean;
  readonly loads: number;
}

async function runWatching(scenario: ScenarioName, extra: RunExtras = {}): Promise<RunOutcome> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), `castgood-${scenario}-`));
  // **The film lives in a folder of its own, not in CastGood's data directory.** On the
  // founder's PC those two are never the same place — films are on their drives,
  // `settings.json` is under `%LOCALAPPDATA%` — and a fixture that conflated them made
  // 20g's *"nothing appears beside the film"* fail on CastGood's own settings file.
  const films = path.join(directory, 'Films');
  await fs.mkdir(films, { recursive: true });
  const filePath = path.join(films, 'Cars.mp4');
  await fs.writeFile(filePath, fixtureMp4(FEATURE_LENGTH_SEC));
  if (extra.sidecar === true) {
    await fs.writeFile(path.join(films, 'Cars.srt'), extra.sidecarText ?? SIDECAR_SRT);
  }
  const receiver = await startFakeReceiver({ durationSec: FEATURE_LENGTH_SEC });
  extra.tweak?.(receiver);
  try {
    const verdict = await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario,
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      deviceWaitMs: 5_000,
      ...(extra.outage === undefined ? {} : { outage: extra.outage }),
      ...(extra.subtitleTiming === undefined ? {} : { subtitleTiming: extra.subtitleTiming }),
      ...(extra.subtitleBroken === undefined ? {} : { subtitleBroken: extra.subtitleBroken }),
      unsafeTestOverrides: {
        transport: tcpTransportFactory,
        mdns: createFakeMdns({
          id: receiver.device.id,
          friendlyName: 'Family room TV',
          model: 'Chromecast',
          address: '127.0.0.1',
          port: receiver.port,
        }),
      },
    });
    return { verdict, launched: receiver.launched, loads: receiver.countOf('LOAD') };
  } finally {
    await receiver.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function run(scenario: ScenarioName, extra: RunExtras = {}): Promise<SelftestVerdict> {
  return (await runWatching(scenario, extra)).verdict;
}

function named(verdict: SelftestVerdict): Map<string, Assertion> {
  return new Map(verdict.assertions.map((item) => [item.name, item]));
}

/**
 * The named assertion, or a failure.
 *
 * `byName.get('typo')?.passed` is `undefined`, and `expect(undefined).not.toBe(false)`
 * passes — a test that cannot fail, which is the exact thing this file exists to catch in
 * somebody else's code.
 */
function must(verdict: SelftestVerdict, name: string): Assertion {
  const found = named(verdict).get(name);
  expect(
    found,
    `${verdict.scenario} reported no assertion called "${name}"; it reported: ${verdict.assertions
      .map((item) => item.name)
      .join(', ')}`,
  ).toBeDefined();
  return found as Assertion;
}

/**
 * The three things every scenario owes, whatever it measured.
 *
 * Note what is *not* here: that the run passed. A scenario is allowed to report a broken
 * product. What it is never allowed to do is report a pass it did not measure, or an
 * assertion nobody could read.
 */
function expectAHonestVerdict(verdict: SelftestVerdict, scenario: ScenarioName): void {
  expect(verdict.scenario, scenario).toBe(scenario);
  expect(verdict.environment.transport, scenario).toBe('test-harness');
  // It ran. An abort would be exit 2 with a reason and no measurements at all, which is
  // exactly the shape of the evening this file exists to prevent.
  expect(verdict.reason, `${scenario} aborted: ${verdict.reason ?? ''}`).toBeNull();
  expect(verdict.exitCode, scenario).not.toBe(2);
  expect(verdict.assertions.length, scenario).toBeGreaterThan(0);

  for (const item of [...verdict.assertions, ...verdict.observations]) {
    const where = `${scenario}.${item.name}`;
    expect(item.name, where).toMatch(/\S/);
    expect(item.unit, where).toMatch(/\S/);
    expect(typeof item.passed, where).toBe('boolean');
    if (item.kind === 'promise') {
      expect(item.target, where).not.toBeNull();
      expect(['lte', 'gte', 'eq'], where).toContain(item.comparison);
    }
    // 13b, and the failure mode that cost the 2026-08-17 evening: a measurement that
    // never arrived must never be counted as a target that was met.
    expect(item.kind === 'promise' && item.passed && item.measured === null, where).toBe(false);
  }

  // And the stronger claim, which is the one this file exists to make: **every promise
  // measured something.** Three of the five scenarios run at the television on
  // 2026-08-17 failed on a `null` — a number the instrument never took — and the evening
  // went on debugging the instrument. A null here is a broken instrument whatever the
  // television did, so it is called out by name rather than left inside an exit code.
  const unmeasured = verdict.assertions.filter((item) => item.measured === null);
  expect(
    unmeasured.map((item) => item.name),
    `${scenario} measured nothing for these`,
  ).toEqual([]);
}

describe.concurrent('seek — story 6', () => {
  it.concurrent(
    'completes, and every number it reports is one it measured',
    async () => {
      const verdict = await run('seek');
      expectAHonestVerdict(verdict, 'seek');

      // The instrument's own subject: a 20-minute jump graded in both directions, and a
      // seek issued while paused. If these measured null the run would say nothing at all
      // about 6a, 6c or 6d.
      expect(must(verdict, 'seekPositionErrorS').measured).not.toBeNull();
      expect(must(verdict, 'seekBackwardPositionErrorS').measured).not.toBeNull();
      expect(must(verdict, 'seekWhilePausedStaysPaused').measured).not.toBeNull();
      expect(must(verdict, 'burstSeekCommandsSent').measured).not.toBeNull();
    },
    120_000,
  );
});

describe.concurrent('skip — story 6b', () => {
  it.concurrent(
    'completes, and counts the coalesced jump on the wire',
    async () => {
      const verdict = await run('skip');
      expectAHonestVerdict(verdict, 'skip');

      // 6g is the criterion the whole 400 ms rule exists for, and it is only worth
      // anything if the count came off the wire rather than out of the app's intentions.
      //
      // Every one of these measured **null or 0 against a product that behaved perfectly**:
      // the scenario counted the wire messages in the same tick as the last tap, 400 ms
      // before the one command it was waiting for could possibly have been sent. Five red
      // lines and an exit 1 from an instrument, which is how the 2026-08-17 evening went.
      expect(must(verdict, 'seekCommandsSent').measured, JSON.stringify(verdict.assertions)).toBe(
        1,
      );
      expect(must(verdict, 'singleSkipRequestedDeltaSec').measured).toBe(30);
      expect(must(verdict, 'singleSkipLandedErrorS').measured).not.toBeNull();
      expect(must(verdict, 'coalescedSkipRequestedTravelSec').measured).not.toBeNull();
      expect(must(verdict, 'coalescedSkipPositionErrorS').measured).not.toBeNull();
      expect(must(verdict, 'skipBeforeStartClamps').measured).not.toBeNull();
    },
    120_000,
  );
});

describe.concurrent('recover — story 11', () => {
  it.concurrent(
    'completes for a socket that dies',
    async () => {
      const verdict = await run('recover', { outage: 'socket' });
      expectAHonestVerdict(verdict, 'recover');
      expect(must(verdict, 'recoveryNoticedMs').measured).not.toBeNull();
      expect(must(verdict, 'recoveryResumedMs').measured).not.toBeNull();
      expect(must(verdict, 'recoveryShowedNoError').measured).not.toBeNull();
    },
    120_000,
  );

  it.concurrent(
    'completes for a heartbeat that stops being answered (11f)',
    async () => {
      // The other outage, and the one nothing has ever run: `--outage heartbeat` reaches a
      // different give-up path, and a flag that silently produced the socket outage instead
      // would report a pass for a run that never happened.
      const verdict = await run('recover', { outage: 'heartbeat' });
      expectAHonestVerdict(verdict, 'recover');
      expect(must(verdict, 'recoveryGiveUpPathRan').measured).not.toBeNull();
      expect(must(verdict, 'recoveryResumedMs').measured).not.toBeNull();
    },
    120_000,
  );
});

describe.concurrent('sourcegone — story 15', () => {
  it.concurrent(
    'completes, and says nothing until the film is actually affected',
    async () => {
      const verdict = await run('sourcegone');
      expectAHonestVerdict(verdict, 'sourcegone');
      expect(must(verdict, 'silentWhilePlaybackUnaffected').measured).not.toBeNull();
      expect(must(verdict, 'sourceGoneMessage').measured).not.toBeNull();
    },
    120_000,
  );
});

describe.concurrent('reattach — story 12', () => {
  it.concurrent(
    'completes, and proves the television came back to the reopened server for bytes',
    async () => {
      const verdict = await run('reattach');
      expectAHonestVerdict(verdict, 'reattach');

      // The half of 12a nothing was watching. SPIKE-2's reattach worked *only* because the
      // second process republished an identical URL — same port and same token — and the
      // scenario asserted state, position, file name and "no LOAD", every one of which a
      // television plays out of its own buffer regardless.
      expect(
        must(verdict, 'reattachRepublishedOnTheRememberedPort').passed,
        JSON.stringify(verdict.assertions),
      ).toBe(true);
      expect(must(verdict, 'reattachDeviceCameBackForBytes').passed).toBe(true);
      expect(must(verdict, 'reattachFetchedOnTheRememberedToken').passed).toBe(true);
    },
    120_000,
  );
});

describe.concurrent('takeover — story 14', () => {
  it.concurrent(
    'completes against a television that really is taken by a second connection',
    async () => {
      // The scenario opens its own connection and launches a different app, exactly as a
      // phone does. Until the fake honoured a foreign `appId` this could only ever abort,
      // so the one automated route to 14a–14c had never been down.
      const verdict = await run('takeover');
      expectAHonestVerdict(verdict, 'takeover');

      expect(must(verdict, 'takeoverNamesTheOtherApp').measured).toBe('named');
      expect(must(verdict, 'takeoverCommandsSentAfterYield').measured).toBe(0);
      expect(must(verdict, 'takeoverRefusedTheSkip').passed).toBe(true);
    },
    120_000,
  );
});

describe.concurrent('subtitles — stories 18, 19 and 20', () => {
  it.concurrent(
    'runs the whole scenario, including step 5’s seeking, survival and remembered offset',
    async () => {
      // **The scenario body itself, exercised headlessly.** It is graded on hardware and
      // nowhere else, which means every line of it — the waits, the log reads, the two
      // engine runs — has only ever been proved by a television being in the room. A
      // scripted run cannot say the words appeared on a screen, and does not try to: what
      // it says is that the *instrument* works, so a hardware run measures the product
      // rather than a typo in the harness.
      const verdict = await run('subtitles', { sidecar: true, subtitleTiming: true });
      expectAHonestVerdict(verdict, 'subtitles');
      // **And it passes.** Every other scenario test here stops at "the verdict is honest",
      // because a scenario is allowed to report a broken product. This one goes further on
      // purpose: the fake receiver keeps all of story 18's and story 20's promises by
      // construction, so a red assertion is a fault in the *instrument* — which is exactly
      // what this caught while it was being written (a block that left the timing control
      // at +1.0 s, and the block after it grading a promise about +0.5 s).
      expect(
        verdict.assertions
          .filter((item) => item.kind === 'promise' && !item.passed)
          .map((i) => i.name),
        'the scripted run should meet every promise the scenario makes',
      ).toEqual([]);

      // 18i — the line keeps up with a jump, in both directions.
      expect(must(verdict, 'lineAfterALongSeek').measured).toBe('Half an hour in.');
      expect(must(verdict, 'seekWithATrackPositionErrorS').measured).not.toBeNull();
      expect(must(verdict, 'lineAfterASkipBack').measured).not.toBeNull();

      // 18h — through a blip, a reopen and a resume, with the correction still applied.
      expect(must(verdict, 'subtitleSourceAfterAnOutage').measured).toBe('Cars.srt');
      expect(must(verdict, 'subtitleOffsetAfterAnOutage').measured).toBe(500);
      expect(must(verdict, 'subtitleSourceAfterAReattach').measured).toBe('Cars.srt');
      expect(must(verdict, 'nudgeAfterAReattachIsStillASwitch').measured).toBe(1);
      expect(must(verdict, 'loadsDuringAReattachWithSubtitles').measured).toBe(0);
      expect(must(verdict, 'subtitleSourceAfterAResume').measured).toBe('Cars.srt');

      // 20f — two engine runs, which is the only way this criterion means anything.
      expect(must(verdict, 'reopenedFilmIsStillOff').measured).toBe('off');
      expect(must(verdict, 'rememberedOffsetAcrossTwoEngineRuns').measured).toBe(1_000);
      expect(must(verdict, 'rememberedOffsetIsStated').measured).toBe('stated');

      // 20g — asserted on bytes and modification times rather than on file names.
      expect(must(verdict, 'sourceFolderByteForByteUnchanged').measured).toBe('unchanged');
    },
    180_000,
  );

  it.concurrent(
    'exits 2, rather than passing, for a film with no subtitles anywhere near it',
    async () => {
      // The exit-code contract, on the scenario where it is most expensive to get wrong: a
      // subtitle test that quietly became an ordinary cast and went green is, in the PRD's
      // words, the most expensive lie available in this milestone.
      const verdict = await run('subtitles', { sidecar: false });
      expect(verdict.exitCode).toBe(2);
      expect(verdict.reason ?? '').toContain('no text subtitle track');
    },
    120_000,
  );
});

describe.concurrent('subtitles --broken — the refusal paths, 18j to 18l', () => {
  it.concurrent(
    'runs the refusal scenario end to end and measures every promise it makes',
    async () => {
      // **The instrument, exercised headlessly, exactly as step 5 and the D2 work were.**
      // This scenario is graded on a television and nowhere else, so without this its waits,
      // its log reads and its honesty gates would first be executed on a founder's evening.
      const verdict = await run('subtitles', { sidecar: true, subtitleBroken: true });
      expectAHonestVerdict(verdict, 'subtitles');
      expect(verdict.variant).toBe('broken');
      // The scripted receiver keeps every promise this run makes by construction — it
      // refuses nothing of its own — so a red assertion here is a fault in the instrument.
      expect(
        verdict.assertions
          .filter((item) => item.kind === 'promise' && !item.passed)
          .map((item) => item.name),
        'the scripted run should meet every promise the refusal scenario makes',
      ).toEqual([]);

      // 18j — all four files refused, and nothing technical said about any of them.
      expect(must(verdict, 'unreadableFilesRefusedBeforeCast').measured).toBe(4);
      expect(must(verdict, 'refusalSaysNothingTechnical').measured).toBe('none');
      expect(must(verdict, 'filmStillReadyAfterARefusal').measured).toBe('unchanged');

      // 18l — the condition really happened, the film survived it, and D2's repair was
      // never anywhere near it.
      expect(must(verdict, 'subtitlesDidNotLoadSaid').measured).toBe('said');
      expect(must(verdict, 'filmStillPlayingAfterASubtitleFailure').measured).toBe('playing');
      expect(must(verdict, 'loadsCausedByASubtitleFailure').measured).toBe(0);
      expect(must(verdict, 'repairsCausedByASubtitleFailure').measured).toBe(0);
      expect(must(verdict, 'trackFetchedAfterTryAgain').measured).toBe('fetched');
      expect(must(verdict, 'filmStillPlayingAfterTryAgain').measured).toBe('playing');
    },
    180_000,
  );

  it.concurrent(
    'exits 2 rather than passing when there is no track to withhold',
    async () => {
      // 18j needs no film and is measured either way; **18l does**, and a run that quietly
      // reported the refusals alone would read as evidence that a television survived a
      // subtitle failure it was never given.
      const verdict = await run('subtitles', { sidecar: false, subtitleBroken: true });
      expect(verdict.exitCode).toBe(2);
      expect(verdict.reason ?? '').toContain('18l cannot be produced');
    },
    120_000,
  );
});

describe.concurrent('m3c — the aggregate M3c is signed off on', () => {
  /** Which legs a verdict actually reported on, read off the assertion names themselves. */
  function legsIn(verdict: SelftestVerdict): string[] {
    const legs = new Set<string>();
    for (const item of [...verdict.assertions, ...verdict.observations]) {
      const dot = item.name.indexOf('.');
      if (dot > 0) legs.add(item.name.slice(0, dot));
    }
    return [...legs].sort();
  }

  it.concurrent(
    'runs all three subtitle runs, names every result after the run it came from, and passes',
    async () => {
      // **The whole aggregate, end to end.** Each leg is graded on hardware and nowhere
      // else, so without this the running order, the per-leg flags and the preflight would
      // first be executed on a founder's evening — which is the exact evening step 5 and
      // step 6 were written to stop happening again.
      const verdict = await run('m3c', { sidecar: true });
      expectAHonestVerdict(verdict, 'm3c');
      // Named before the exit code is read, so a red aggregate says *which* promise in
      // *which* of the three runs missed rather than only "1".
      expect(
        verdict.assertions
          .filter((item) => !item.passed)
          .map((item) => `${item.name}: ${String(item.measured)} (target ${String(item.target)})`),
        'the scripted run should meet every promise all three legs make',
      ).toEqual([]);
      expect(verdict.exitCode).toBe(0);

      // All three ran, and each is named. A failure has to be readable without re-running
      // anything, which is the whole reason the leg label is in the assertion name.
      expect(legsIn(verdict)).toEqual(['subtitles', 'subtitles-broken', 'subtitles-timing']);

      // And they really are three *different* runs rather than the same one three times —
      // the flags reached the scenario. Story 20's numbers exist only under `--timing`, and
      // 18l's only under `--broken`.
      const names = new Set(verdict.assertions.map((item) => item.name));
      expect(names.has('subtitles.trackFetchedByDevice')).toBe(true);
      expect(names.has('subtitles-timing.trackSwapMs')).toBe(true);
      expect(names.has('subtitles-timing.rememberedOffsetAcrossTwoEngineRuns')).toBe(true);
      expect(names.has('subtitles-broken.subtitlesDidNotLoadSaid')).toBe(true);
      expect(names.has('subtitles-broken.unreadableFilesRefusedBeforeCast')).toBe(true);
      // The plain leg is the plain run: it never measured a swap, because it never nudged.
      expect(names.has('subtitles.trackSwapMs')).toBe(false);
      expect(names.has('subtitles.unreadableFilesRefusedBeforeCast')).toBe(false);

      // Every leg promised something. A leg that ran and measured nothing would be an
      // aggregate reporting on the runs that happened to speak up.
      for (const leg of ['subtitles', 'subtitles-timing', 'subtitles-broken']) {
        expect(
          verdict.assertions.filter((item) => item.name.startsWith(`${leg}.`)).length,
          `${leg} promised nothing`,
        ).toBeGreaterThan(0);
      }
    },
    600_000,
  );

  it.concurrent(
    'exits 2 before casting anything when the film has no subtitle source at all',
    async () => {
      // All three legs stand on one fact, and it is knowable from the file. Found here it
      // costs one check; found inside the legs it costs three casts to say the same thing
      // three times.
      const outcome = await runWatching('m3c', { sidecar: false });
      expect(outcome.verdict.exitCode).toBe(2);
      expect(outcome.verdict.outcome).toBe('could-not-run');
      expect(outcome.verdict.reason ?? '').toContain('no text subtitle track');
      expect(outcome.verdict.reason ?? '').toContain('nothing was cast');
      // And it means it: no receiver was launched and no film was loaded.
      expect(outcome.launched, 'a television was driven for a run that could not happen').toBe(
        false,
      );
      expect(outcome.loads).toBe(0);
      // Exit 2 asserts nothing.
      expect(outcome.verdict.assertions).toEqual([]);
    },
    120_000,
  );

  it.concurrent(
    'exits 1, not 0, when one of the three runs misses a promise — and still runs the rest',
    async () => {
      // **A test that only ever sees three passes proves nothing about an aggregate.** This
      // one gives the aggregate a television that accepts the film and never fetches a text
      // track — a real failure a real set produces — so the plain leg's 18e promise misses.
      const verdict = await run('m3c', {
        sidecar: true,
        tweak: (receiver) => receiver.setFetchesTracks(false),
      });

      expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(1);
      expect(verdict.outcome).toBe('failed');
      const failed = verdict.assertions.filter((item) => !item.passed).map((item) => item.name);
      expect(failed).toContain('subtitles.trackFetchedByDevice');
      // A missed promise is not an abort: the other two runs still happened and are still in
      // the verdict, so the founder is told everything this evening found rather than only
      // the first thing that went wrong.
      expect(legsIn(verdict)).toEqual(['subtitles', 'subtitles-broken', 'subtitles-timing']);
    },
    600_000,
  );

  it.concurrent(
    'exits 2, not 0 or 1, when a run inside it could not happen — and stops there',
    async () => {
      // The other half of the contract, and the expensive one. The film is offered a
      // subtitle **by name** — so the preflight above cannot catch it — and the file turns
      // out to be unreadable, which is the first leg's own exit-2 clause. What must not
      // happen is the aggregate carrying on, collecting two runs' worth of green, and
      // publishing it as a pass.
      const verdict = await run('m3c', { sidecar: true, sidecarText: UNREADABLE_SRT });

      expect(verdict.exitCode, JSON.stringify(verdict)).toBe(2);
      expect(verdict.outcome).toBe('could-not-run');
      expect(verdict.reason ?? '').toContain('never had a track to send');
      // And the two runs behind it did not quietly happen anyway, nor report anything.
      expect(legsIn(verdict).filter((leg) => leg !== 'subtitles')).toEqual([]);
      expect(verdict.assertions.every((item) => item.name.startsWith('subtitles.'))).toBe(true);
    },
    300_000,
  );

  it.concurrent(
    'refuses --timing and --broken asked for beside it, rather than ignoring them',
    async () => {
      // Inside `m3c` these are legs, not flags. Silently overwritten by the running order,
      // an operator would be answered a question they did not ask — and the refusal is
      // checked at the runner as well as the command line, so nothing that bypasses
      // argument parsing can reach it either.
      for (const asked of [{ subtitleTiming: true }, { subtitleBroken: true }]) {
        const verdict = await run('m3c', { sidecar: true, ...asked });
        expect(verdict.exitCode, JSON.stringify(asked)).toBe(2);
        expect(verdict.reason ?? '').toContain('m3c');
      }
    },
    120_000,
  );
});

describe('what "nothing has been sent to any device" means between scenarios', () => {
  it('does not count a film that has finished as a television still being held', () => {
    // In the `m2` aggregate, `resume` runs straight after `finish`. The film has played
    // out, the device is back on its own home screen (16a) and nothing has been sent to it
    // since — but *Finished* was read as a live session, so the first thing `resume`
    // reported was "session ended, 0 device contact(s)" against a target of "nothing
    // sent". A red line on an aggregate run, from a television that behaved perfectly.
    expect(holdsTheTelevision('ended')).toBe(false);
    expect(holdsTheTelevision('idle')).toBe(false);
    expect(holdsTheTelevision('stopped')).toBe(false);
    // And everything that really is holding one still counts.
    for (const state of [
      'connecting',
      'loading',
      'buffering',
      'playing',
      'paused',
      'seeking',
    ] as const) {
      expect(holdsTheTelevision(state), state).toBe(true);
    }
  });
});
