import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSelftest, type SelftestVerdict } from '../../src/engine/selftest/index.js';
import {
  parseArgs,
  parseDuration,
  runSelftestCli,
  summarise,
} from '../../src/engine/selftest/args.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * Tests for the thing that tests the product.
 *
 * The rule they exist to defend is 13c: **a run that never reached a device must never
 * exit 0.** Missing file, no such device, no port — all of those are exit 2 and say why.
 * The one scenario run here against the scripted receiver proves the harness itself
 * works end to end; note that its verdict is stamped `transport: "test-harness"`, so it
 * could never be mistaken for evidence that a real TV played anything.
 */

function createFakeMdns(service: MdnsService | null): Mdns {
  const active = new Set<MdnsHandlers>();
  return {
    browse(handlers) {
      active.add(handlers);
      if (service !== null) setTimeout(() => handlers.onUp(service), 5);
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

function fixtureMp4(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(90_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(2_048, 3)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

/**
 * A television, a film and a data directory **per test**, so these can run concurrently.
 *
 * Every run in this file waits on real sockets and real timers, and the file took 98
 * seconds running them one at a time. Overlapping the waiting is the only honest way to
 * shorten it: nothing here is faked, skipped or given a shorter budget.
 */
interface Fixture {
  readonly directory: string;
  readonly filePath: string;
  readonly receiver: FakeReceiver;
  readonly paths: () => AppPaths;
  readonly service: () => MdnsService;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-selftest-'));
  const filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());
  const receiver = await startFakeReceiver({ durationSec: 90 });
  try {
    await body({
      directory,
      filePath,
      receiver,
      paths: () => resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      service: () => ({
        id: receiver.device.id,
        friendlyName: 'Family room TV',
        model: 'Chromecast',
        address: '127.0.0.1',
        port: receiver.port,
      }),
    });
  } finally {
    await receiver.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe.concurrent('command line', () => {
  it('accepts the documented form', () => {
    const result = parseArgs([
      '--device',
      'Family room TV',
      '--file',
      'C:/x.mp4',
      '--scenario',
      'cast',
    ]);
    expect(result).toEqual({
      ok: true,
      args: {
        deviceName: 'Family room TV',
        filePath: 'C:/x.mp4',
        scenario: 'cast',
        positionDurationMs: 600_000,
        // `recover` is the only scenario that reads this, but every parse carries it: an
        // absent default would make `--outage` mean "socket" in one place and undefined in
        // another. PRD M2 names `socket` as the default kind of outage.
        outage: 'socket',
        conversionReadRate: undefined,
        conversionReadRateAfterGate: undefined,
        headStartWatchMs: undefined,
        // Off unless `--timing` is passed, and `--timing` takes no value — `subtitles` is
        // the only scenario it is accepted for, and anywhere else it is refused rather than
        // ignored, so a run cannot claim story 20's evidence without having produced it.
        subtitleTiming: false,
        // Off unless `--broken` is passed, on the same terms: a bare flag, `subtitles` only,
        // refused beside `--timing`, so a verdict can never claim the refusal paths were
        // exercised by a run that took the ordinary one.
        subtitleBroken: false,
        dataDir: undefined,
        help: false,
      },
    });
  });

  it('accepts --timing as a bare flag, and only for the subtitles scenario', () => {
    const timed = parseArgs([
      '--device',
      'Family room TV',
      '--file',
      'C:/x.mp4',
      '--scenario',
      'subtitles',
      '--timing',
    ]);
    expect(timed.ok && timed.args.subtitleTiming).toBe(true);
    // It swallows no value: a bare flag that ate the next token would silently change which
    // scenario ran.
    expect(timed.ok && timed.args.scenario).toBe('subtitles');

    const elsewhere = parseArgs(['--device', 'TV', '--file', 'C:/x.mp4', '--timing']);
    expect(elsewhere.ok).toBe(false);
  });

  it('accepts --broken as a bare flag, only for subtitles, and never beside --timing', () => {
    const broken = parseArgs([
      '--device',
      'Family room TV',
      '--file',
      'C:/x.mp4',
      '--scenario',
      'subtitles',
      '--broken',
    ]);
    expect(broken.ok && broken.args.subtitleBroken).toBe(true);
    expect(broken.ok && broken.args.scenario).toBe('subtitles');

    // Refused rather than ignored, which is the rule every flag in this file follows: an
    // operator who asked for the refusal run and silently got the ordinary one would read a
    // green verdict as evidence that a film survived a subtitle failure it never had.
    const elsewhere = parseArgs(['--device', 'TV', '--file', 'C:/x.mp4', '--broken']);
    expect(elsewhere.ok).toBe(false);
    expect(!elsewhere.ok && elsewhere.reason).toContain('--broken only applies');

    // Two runs, not one: one nudges a track that works, the other declares one the
    // television cannot fetch. A run that tried to be both would grade story 20 against a
    // track that was never there.
    const both = parseArgs([
      '--device=TV',
      '--file=C:/x.mp4',
      '--scenario=subtitles',
      '--broken',
      '--timing',
    ]);
    expect(both.ok).toBe(false);
    expect(!both.ok && both.reason).toContain('Ask for one');
  });

  it('accepts --flag=value and defaults the scenario to m1', () => {
    const result = parseArgs(['--device=Family room TV', '--file=/tmp/x.mp4']);
    expect(result.ok && result.args.scenario).toBe('m1');
  });

  it('refuses a run it cannot understand rather than guessing', () => {
    expect(parseArgs(['--file', '/tmp/x.mp4']).ok).toBe(false);
    expect(parseArgs(['--device', 'TV']).ok).toBe(false);
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'soak']).ok).toBe(false);
    expect(parseArgs(['--device']).ok).toBe(false);
    expect(parseArgs(['nonsense']).ok).toBe(false);
  });

  it('takes the kind of outage `recover` should produce, and refuses one it cannot make', () => {
    // 11a and 11f are two different failures — a dead socket and a heartbeat that stops
    // being answered — and the flag is how the founder asks for either. A kind the
    // selftest cannot produce must be refused at the command line rather than silently
    // demoted to the default, which would report a pass for a run that never happened.
    const heartbeat = parseArgs([
      '--device=Family room TV',
      '--file=/tmp/x.mp4',
      '--scenario=recover',
      '--outage=heartbeat',
    ]);
    expect(heartbeat.ok && heartbeat.args.outage).toBe('heartbeat');
    expect(
      parseArgs([
        '--device=Family room TV',
        '--file=/tmp/x.mp4',
        '--scenario=recover',
        '--outage=unplug-the-tv',
      ]).ok,
    ).toBe(false);
  });

  it('parses durations the way a human writes them', () => {
    expect(parseDuration('90s')).toBe(90_000);
    expect(parseDuration('10m')).toBe(600_000);
    expect(parseDuration('2h')).toBe(7_200_000);
    expect(parseDuration('500')).toBe(500);
    expect(parseDuration('soon')).toBeNull();
  });

  it.concurrent('writes the verdict file on the same path the founder runs (13a)', async () => {
    await withFixture(async ({ directory }) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runSelftestCli(
        [
          '--device',
          'Family room TV',
          '--file',
          path.join(directory, 'absent.mp4'),
          '--scenario',
          'm1',
          '--data-dir',
          directory,
        ],
        { out: (text) => out.push(text), err: (text) => err.push(text) },
      );

      expect(code).toBe(2);
      const verdict = JSON.parse(out[0] as string) as SelftestVerdict;
      expect(verdict.outcome).toBe('could-not-run');

      // The file the wrapper script tells the founder to go and read.
      const written = await fs.readdir(path.join(directory, 'logs'));
      expect(written.filter((name) => name.startsWith('selftest-m1-'))).toHaveLength(1);
      expect(err.join('\n')).toContain('verdict written to');
    });
  });

  it.concurrent('exits 2 with usage when the arguments are wrong — never 0', async () => {
    await withFixture(async () => {
      const errors: string[] = [];
      const code = await runSelftestCli(['--device', 'TV'], {
        out: () => undefined,
        err: (t) => errors.push(t),
      });
      expect(code).toBe(2);
      expect(errors.join('\n')).toContain('--device');
    });
  });

  it('prints every assertion with its target and its measured value', () => {
    const verdict = {
      scenario: 'cast',
      device: 'Family room TV',
      outcome: 'failed',
      exitCode: 1,
      reason: null,
      assertions: [
        {
          name: 'castToPictureMs',
          kind: 'promise',
          target: 10_000,
          comparison: 'lte',
          measured: 12_100,
          unit: 'ms',
          passed: false,
        },
      ],
      observations: [
        {
          name: 'receiverBootMs',
          kind: 'observation',
          target: null,
          comparison: 'observed',
          measured: 9_590,
          unit: 'ms',
          passed: true,
        },
      ],
    } as unknown as SelftestVerdict;
    const text = summarise(verdict);
    expect(text).toContain('FAIL castToPictureMs: measured 12100 ms (target <= 10000)');
    // An observation is never printed as a pass or a failure.
    expect(text).toContain('receiverBootMs: measured 9590 ms');
    expect(text).not.toContain('PASS receiverBootMs');
    expect(text).toContain('1 observations reported');
  });
});

describe.concurrent('runs that could not happen (exit 2)', () => {
  it.concurrent(
    'reports a missing file without touching a device, and still writes the verdict',
    async () => {
      await withFixture(async ({ directory, paths, receiver, service }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath: path.join(directory, 'nope.mp4'),
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 500,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        expect(verdict.exitCode).toBe(2);
        expect(verdict.outcome).toBe('could-not-run');
        expect(verdict.reason).toContain('file not found');
        expect(receiver.received).toHaveLength(0);

        // 13a. This exit used to return before writing anything — on the one path where the
        // saved verdict is all there is to look at afterwards.
        expect(verdict.environment.verdictFile).not.toBeNull();
        const saved = JSON.parse(
          await fs.readFile(verdict.environment.verdictFile as string, 'utf8'),
        ) as SelftestVerdict;
        expect(saved.reason).toBe(verdict.reason);
        expect(saved.exitCode).toBe(2);
      });
    },
  );

  it.concurrent('says which run of `headstart` a verdict came from (10j)', async () => {
    await withFixture(async ({ directory, paths, service }) => {
      // Three runs of one scenario, two of which assert **opposite** things about the
      // gate. Read literally, a `starved` pass is 10j's own fails-if — *"`headstart` can
      // reach exit 0 on a run where the gate never opened"* — so the verdict has to name
      // the question it answered. Checked on the cheapest path there is, a file that is
      // not there, because the variant is a fact about what was *asked for*.
      const run = (extra: Partial<Parameters<typeof runSelftest>[0]>): Promise<SelftestVerdict> =>
        runSelftest({
          deviceName: 'Family room TV',
          filePath: path.join(directory, 'nope.mp4'),
          scenario: 'headstart',
          paths: paths(),
          deviceWaitMs: 200,
          unsafeTestOverrides: {
            transport: tcpTransportFactory,
            mdns: createFakeMdns(service()),
          },
          ...extra,
        });

      expect((await run({})).variant).toBeNull();
      const starved = await run({ conversionReadRate: 0.7 });
      expect(starved.variant).toBe('starved');
      const fallsBehind = await run({ conversionReadRateAfterGate: 0.5 });
      expect(fallsBehind.variant).toBe('falls-behind');
      // A folder of verdicts is read by eye far more often than by machine, so the two
      // are not allowed to look like two attempts at the same run.
      expect(starved.environment.verdictFile).toContain('headstart-starved');
      expect(fallsBehind.environment.verdictFile).toContain('headstart-falls-behind');
      // …and the human summary says it on the first line, beside the scenario.
      expect(summarise(starved).split('\n')[0]).toContain('(starved)');
    });
  });

  it.concurrent(
    'writes a verdict on the device-not-found path too',
    async () => {
      await withFixture(async ({ filePath, paths }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 300,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(null) },
        });

        expect(verdict.exitCode).toBe(2);
        expect(verdict.environment.verdictFile).not.toBeNull();
        await expect(
          fs.readFile(verdict.environment.verdictFile as string, 'utf8'),
        ).resolves.toContain('could-not-run');
      });
    },
    15_000,
  );

  it.concurrent(
    'reports honestly when the verdict cannot be written, instead of claiming it was',
    async () => {
      await withFixture(async ({ directory }) => {
        // A log directory that cannot be created: the run still returns its verdict, and says
        // so rather than naming a file that is not there.
        const blocked = path.join(directory, 'blocked');
        await fs.writeFile(blocked, 'not a directory');
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath: path.join(directory, 'nope.mp4'),
          scenario: 'cast',
          paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: blocked } }),
          deviceWaitMs: 300,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(null) },
        });

        expect(verdict.exitCode).toBe(2);
        expect(verdict.environment.verdictFile).toBeNull();
      });
    },
  );

  it.concurrent(
    'reports a device that never answered, and never exits 0 for it',
    async () => {
      await withFixture(async ({ filePath, paths }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 300,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(null) },
        });

        expect(verdict.exitCode).toBe(2);
        expect(verdict.outcome).toBe('could-not-run');
        expect(verdict.reason).toContain('no device named "Family room TV"');
        expect(verdict.assertions).toEqual([]);
      });
    },
    15_000,
  );

  it.concurrent(
    'reports a device with a different name as not found',
    async () => {
      await withFixture(async ({ filePath, paths, service }) => {
        const verdict = await runSelftest({
          deviceName: 'Kitchen TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 300,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        expect(verdict.exitCode).toBe(2);
      });
    },
    15_000,
  );
});

describe.concurrent('a scenario that did happen', () => {
  it.concurrent(
    'casts, measures, stops and leaves nothing playing',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        expect(verdict.outcome).toBe('passed');
        expect(verdict.exitCode).toBe(0);
        expect(verdict.environment.transport).toBe('test-harness');

        const byName = new Map(verdict.assertions.map((item) => [item.name, item]));

        // The founder's wait is the promise (ruling of 2026-08-18: cast speed matters only in
        // that it is reasonable, and the whole wait is what they experience). Graded at 15 s,
        // not the PRD's 10 s expectation, because up to 10.59 s of it is the television.
        const toPicture = byName.get('firstCastToPictureMs');
        expect(toPicture?.kind).toBe('promise');
        expect(toPicture?.target).toBe(15_000);
        expect(typeof toPicture?.measured).toBe('number');
        expect(toPicture?.passed).toBe(true);

        // Our own share is measured precisely and graded not at all — it failed a run on
        // 2026-08-18 that met the product promise with 4 s to spare. It must still be a
        // *number*, though: dropping it would lose the trend that makes a real regression
        // visible (883 → 1,395 → 3,664 ms across three hardware runs).
        const ourWork = new Map(verdict.observations.map((item) => [item.name, item])).get(
          'firstCastWithoutReceiverBootMs',
        );
        expect(ourWork?.kind).toBe('observation');
        expect(ourWork?.target).toBeNull();
        expect(typeof ourWork?.measured).toBe('number');

        // And what the television controls is reported, not graded. Its receiver boot swings
        // from 6.42 s to 10.59 s on real hardware and would otherwise flap this run red about
        // once in eight, which teaches everyone to ignore a red line.
        const observed = new Map(verdict.observations.map((item) => [item.name, item]));
        const boot = observed.get('firstReceiverBootMs');
        expect(boot?.kind).toBe('observation');
        expect(boot?.target).toBeNull();
        expect(typeof boot?.measured).toBe('number');

        // The founder-visible total is the graded one — asserted above as a promise — so it
        // must NOT also appear among the observations. Checked because this measure has now
        // moved between the two lists twice, and a stray copy in the wrong list is exactly the
        // "ungraded hiding among the graded" failure the next assertion guards against.
        expect(observed.get('firstCastToPictureMs')).toBeUndefined();
        // And nothing ungraded leaks into the graded list.
        expect(verdict.assertions.every((item) => item.kind === 'promise')).toBe(true);
        expect(byName.get('fileDurationSec')?.measured).toBeCloseTo(90, 3);
        expect(byName.get('firstStopToDeviceReleasedMs')?.passed).toBe(true);

        // 13e: the device is released and nothing is left playing.
        expect(receiver.launched).toBe(false);
        expect(receiver.playerState).not.toBe('PLAYING');

        // 13a: the same object is written next to the engine log.
        const written = await fs.readdir(paths().logDir);
        const verdictFile = written.find((name) => name.startsWith('selftest-cast-'));
        expect(verdictFile).toBeDefined();
        const parsed = JSON.parse(
          await fs.readFile(path.join(paths().logDir, verdictFile as string), 'utf8'),
        ) as SelftestVerdict;
        expect(parsed.assertions.length).toBe(verdict.assertions.length);
        expect(written.some((name) => name.startsWith('engine-'))).toBe(true);
      });
    },
    40_000,
  );

  it.concurrent(
    'measures position accuracy against the device, not against itself',
    async () => {
      await withFixture(async ({ filePath, paths, service }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'position',
          paths: paths(),
          deviceWaitMs: 5_000,
          positionDurationMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        const byName = new Map(verdict.assertions.map((item) => [item.name, item]));
        expect(byName.get('maxDivergenceSec')?.target).toBe(1);
        expect(byName.get('maxDivergenceSec')?.measured).toBeLessThanOrEqual(1);
        expect(byName.get('positionSamples')?.passed).toBe(true);
        expect(verdict.exitCode).toBe(0);
      });
    },
    40_000,
  );

  it.concurrent(
    'refuses a film shorter than the window it is about to watch, rather than failing it',
    async () => {
      // **Found on hardware, 2026-09-04, `Home Theatre TV`.** `--scenario m1` on a
      // 36-second phone clip cast four times and then reported three broken promises:
      // `positionSamples` 76 against 480, `firstStopToDeviceReleasedMs` null, and
      // `firstStoppedPositionErrorSec` 2.507 s against 1. Every one of them reads as a
      // defect in the product. The cause was the file — the film ended before the watch
      // window closed, so the stop had nothing left to stop.
      //
      // That is exit **2**, a run that could not happen, and the difference matters more
      // than it looks: exit 1 sends somebody looking for a regression that is not there.
      // `seek`, `resume`, `finish` and `headstart` all declared their minimum; `position`
      // was the one member of the four aggregates that never had.
      await withFixture(async ({ filePath, paths, service }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'position',
          paths: paths(),
          deviceWaitMs: 5_000,
          // The receiver reports a 90-second film; ask to watch it for two minutes.
          positionDurationMs: 120_000,
          unsafeTestOverrides: {
            transport: tcpTransportFactory,
            mdns: createFakeMdns(service()),
          },
        });

        expect(verdict.exitCode, 'a film too short is a run that could not happen').toBe(2);
        expect(verdict.reason ?? '').toContain('position scenario');
        // The numbers are in the sentence, so nobody has to re-derive why it stopped.
        expect(verdict.reason ?? '').toMatch(/120 s/);
        // And nothing was graded — a partial verdict here would be the false red all over
        // again, wearing an exit 2.
        expect(verdict.assertions.filter((item) => item.name.startsWith('position'))).toHaveLength(
          0,
        );
      });
    },
    40_000,
  );

  it.concurrent(
    'does not grade the saved position against a device report the engine rejected',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // The founder's TV answers a stop 598 s into a film with `currentTime: 0`. The engine
        // rejects that — stopping cannot rewind the playhead — and keeps its own figure, which
        // was right to within 0.724 s. The measurement then adopted the very 0 the engine had
        // thrown out and reported a 598-second error against a ≤1 s target: a red line for a
        // product that had behaved correctly. Twice now a reference choice has made this
        // number wrong, so it is pinned here.
        const run = runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'position',
          paths: paths(),
          deviceWaitMs: 5_000,
          positionDurationMs: 4_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        // Once it is playing, jump the device deep into the film and make it answer the stop
        // with 0, exactly as the founder's hardware does.
        setTimeout(() => {
          receiver.setPositionSec(598);
          receiver.setIdleReportsZero(true);
        }, 2_000);

        const verdict = await run;
        const error = verdict.assertions.find(
          (item) => item.name === 'firstStoppedPositionErrorSec',
        );

        expect(Number(error?.measured)).toBeLessThan(1);
        expect(error?.passed).toBe(true);
        // And the verdict says which reference it used, so the two cases can be told apart.
        expect(error?.note).toContain('rejected as untrustworthy');
      });
    },
    60_000,
  );

  it.concurrent(
    'grades the saved position against where the film really was, not where it had been (seeking)',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // The third lying instrument of 2026-08-17, and the second time this one number has
        // been wrong. On hardware it measured an error of **1,142.986 s** against a ≤1 s
        // target while the engine had saved the position **correctly**: the device answered
        // the stop with `currentTime: 0`, the engine rejected that, and the measurement then
        // fell back to advancing the last PLAYING sample by the elapsed time — an assumption
        // that the playhead only ever moves forward at 1×. True in M1. Seeking made it false.
        const run = runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'position',
          paths: paths(),
          deviceWaitMs: 5_000,
          positionDurationMs: 6_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        // The film runs on to near the end of the file…
        setTimeout(() => receiver.setPositionSec(70), 2_000);
        // …is then jumped **backwards** and paused — which is exactly the shape of the run that
        // produced the 1,142 s figure: the last position the device reported *while playing*
        // was far ahead of where the film actually sat when it was stopped…
        setTimeout(() => {
          receiver.setPositionSec(10);
          receiver.remoteSet('PAUSED');
          // …and it is stopped by a device that answers with `currentTime: 0`, which is what
          // the founder's TV does, so the engine's rejection is the only honest reference left.
          receiver.setIdleReportsZero(true);
        }, 4_000);

        const verdict = await run;
        const error = verdict.assertions.find(
          (item) => item.name === 'firstStoppedPositionErrorSec',
        );

        // ~60 s of "error" is what the old fallback reports here: the instrument re-deriving
        // the position from a PLAYING sample the film had long since left.
        expect(Number(error?.measured)).toBeLessThan(1);
        expect(error?.passed).toBe(true);
        expect(error?.note).toContain("engine's own position");
      });
    },
    60_000,
  );

  it.concurrent(
    'waits for the television to say it was released before measuring the end of a film (16a)',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // The first lying instrument of 2026-08-17: `finishedReleaseMs` measured **null** for a
        // television that was back on its own home screen **85 ms** after the film ended, well
        // inside the 2 s promise. The scenario read the evidence before it could have arrived.
        //
        // The delay below is what makes this a test rather than a coincidence: on loopback the
        // release lands within a millisecond, so a fake that answers instantly would let the
        // broken version pass. The founder's own hardware takes 386–843 ms.
        receiver.setReleaseDelayMs(300);
        const run = runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'finish',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        // The end of a film is the device's news to break, and this fake only does it when
        // told — a real receiver reaches it by playing.
        setTimeout(() => receiver.finish(), 2_500);

        const verdict = await run;
        const released = verdict.assertions.find((item) => item.name === 'finishedReleaseMs');

        expect(released?.measured, JSON.stringify(verdict.assertions)).not.toBeNull();
        expect(Number(released?.measured)).toBeLessThanOrEqual(2_000);
        expect(released?.passed).toBe(true);
        // And the state it was measured from is the one 16a names.
        expect(verdict.assertions.find((item) => item.name === 'reachedFinished')?.measured).toBe(
          'ended',
        );
      });
    },
    60_000,
  );

  it.concurrent(
    'counts only positions the device reported while playing, when checking a Resume (16c)',
    async () => {
      await withFixture(async ({ directory, paths }) => {
        // The second lying instrument of 2026-08-17. *Resume from 0:32:10* landed dead on
        // **1500.001 s** and the run said it had played from the beginning: the zeros it found
        // were an IDLE receiver with nothing loaded and a device still BUFFERING, neither of
        // which is a playback position. A red line for a product that was exactly right.
        //
        // The scenario needs somewhere to resume *from*, so this one gets a feature-length
        // file and a television to match.
        const longPath = path.join(directory, 'Feature length.mp4');
        const mvhd = Buffer.alloc(100);
        mvhd.writeUInt32BE(1_000, 12);
        mvhd.writeUInt32BE(2_000_000, 16);
        await fs.writeFile(
          longPath,
          Buffer.concat([
            box('ftyp', Buffer.from('isom')),
            box('mdat', Buffer.alloc(2_048, 3)),
            box('moov', box('mvhd', mvhd)),
          ]),
        );
        const long = await startFakeReceiver({ durationSec: 2_000 });
        // And it is asked to be as unhelpful as the founder's own TV: 0 until the film really
        // starts, whatever position the LOAD carried. Without this the fake reports the
        // requested position from the first millisecond and the defect cannot exist here.
        long.setBufferingReportsZero(true);
        try {
          const verdict = await runSelftest({
            deviceName: 'Family room TV',
            filePath: longPath,
            scenario: 'resume',
            paths: paths(),
            deviceWaitMs: 5_000,
            unsafeTestOverrides: {
              transport: tcpTransportFactory,
              mdns: createFakeMdns({
                id: long.device.id,
                friendlyName: 'Family room TV',
                model: 'Chromecast',
                address: '127.0.0.1',
                port: long.port,
              }),
            },
          });

          const byName = new Map(verdict.assertions.map((item) => [item.name, item]));
          const zero = byName.get('resumeNeverPlayedFromZero');
          // The film really did load at the saved position…
          expect(
            byName.get('resumePositionErrorS')?.passed,
            JSON.stringify(verdict.assertions),
          ).toBe(true);
          expect(byName.get('resumeSeeksIssued')?.measured).toBe(0);
          // …so the instrument must say so, rather than reporting a 0 nothing ever played.
          expect(Number(zero?.measured)).toBeGreaterThan(Number(zero?.target));
          expect(zero?.passed).toBe(true);
        } finally {
          await long.close();
        }
      });
    },
    90_000,
  );

  it.concurrent(
    'fails — not aborts — when the device refuses the file',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        receiver.rejectNextLoad();
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        expect(verdict.outcome).toBe('failed');
        expect(verdict.exitCode).toBe(1);
        // A cast that never produced a picture must fail on BOTH counts: the state sequence
        // says it never reached playing, and the wait it never ended is measured as null and
        // fails its own promise rather than passing on an absent number.
        const sequence = verdict.assertions.find((item) => item.name === 'firstStateSequence');
        expect(sequence?.kind).toBe('promise');
        expect(sequence?.passed).toBe(false);
        const toPicture = verdict.assertions.find((item) => item.name === 'firstCastToPictureMs');
        expect(toPicture?.kind).toBe('promise');
        expect(toPicture?.measured).toBeNull();
        expect(toPicture?.passed).toBe(false);
      });
    },
    60_000,
  );
});
