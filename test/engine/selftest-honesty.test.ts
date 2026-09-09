import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HUMAN_OUTAGES,
  M2_ORDER,
  M3_ORDER,
  M3C_ORDER,
  OUTAGES,
  refuseOutage,
  runSelftest,
  SCENARIOS,
  type SelftestVerdict,
} from '../../src/engine/selftest/index.js';
import { parseArgs, runSelftestCli, summarise } from '../../src/engine/selftest/args.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * Attacking the one guarantee worth more than any other test in this repository:
 *
 *   "It must be impossible for the selftest to report success without a real device
 *    having played real video." — PRD story 13, criterion 13c.
 *
 * `selftest.test.ts` shows the machinery works. This file tries to make it lie: to reach
 * exit 0 with no device, with no assertions, with an assertion that measured nothing, or
 * by smuggling a scripted receiver in through the command line. Every one of these must
 * come back 1 or 2, and any verdict built on a fake must say so about itself.
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
 * A television, a film and a data directory **per test**.
 *
 * These runs are declared `concurrent`: none of them shares anything with another, and
 * the file used to spend 162 seconds — the whole suite's critical path — running them one
 * after another. Nothing about what they assert changes; only the waiting overlaps. Real
 * time still passes for every socket and every timer, which is the only kind of speed-up
 * this file is allowed to have.
 */
interface Fixture {
  readonly directory: string;
  readonly filePath: string;
  readonly receiver: FakeReceiver;
  readonly paths: () => AppPaths;
  readonly service: () => MdnsService;
}

async function withFixture(body: (fixture: Fixture) => Promise<void>): Promise<void> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-honesty-'));
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

describe.concurrent('the command line cannot smuggle in a fake device', () => {
  it('has no flag that reaches unsafeTestOverrides, under any spelling', () => {
    const spellings = [
      ['--unsafeTestOverrides', '{}'],
      ['--unsafe-test-overrides', '{}'],
      ['--transport', 'test-harness'],
      ['--mdns', 'fake'],
      ['--overrides', '{}'],
    ];
    for (const [flag, value] of spellings) {
      const result = parseArgs([
        '--device',
        'Family room TV',
        '--file',
        '/tmp/x.mp4',
        flag as string,
        value as string,
      ]);
      // Either rejected outright, or parsed into the fixed argument shape with the
      // extra key discarded. What must never happen is it reaching runSelftest.
      if (result.ok) {
        expect(Object.keys(result.args).sort()).toEqual([
          'conversionReadRate',
          'conversionReadRateAfterGate',
          'dataDir',
          'deviceName',
          'filePath',
          // `--watch`, added 2026-08-25 for 10b's full-film run. Admitted deliberately: this
          // list is a whitelist and a new flag failing this test until somebody writes it
          // down is exactly the point. It carries a duration in milliseconds and nothing
          // else — it cannot name a device, a transport or a path, so it cannot reach
          // unsafeTestOverrides.
          'headStartWatchMs',
          'help',
          'outage',
          'positionDurationMs',
          'scenario',
          // `--broken`, added 2026-08-28 for M3c step 6's refusal run — and the same
          // argument as the two below it: a bare boolean, no value of any kind, so there is
          // nothing in it that could name a device or a transport.
          'subtitleBroken',
          // `--timing`, added 2026-08-27 for story 20's run. Admitted deliberately, on the
          // same terms as `--watch` above: it is a bare boolean that takes no value at all,
          // so it cannot name a device, a transport or a path, and it cannot reach
          // `unsafeTestOverrides`. A new flag failing this test until somebody writes it
          // down here is the whole point of the list.
          'subtitleTiming',
        ]);
        expect(JSON.stringify(result.args)).not.toContain('harness');
      }
    }
  });

  it('exposes no scenario the PRD did not name', () => {
    expect([...SCENARIOS]).toEqual([
      'discovery',
      'cast',
      'transport',
      'position',
      'seek',
      'skip',
      'recover',
      'reattach',
      'takeover',
      'sourcegone',
      'finish',
      'resume',
      'check',
      'remux',
      'prepared',
      'convert',
      'headstart',
      'prepfail',
      // M3c: named by the PRD's "What M3c adds to the selftest" table. It carries the same
      // exit-2 clause as every M3 scenario — a film with no text track inside it and no
      // sidecar beside it cannot produce the condition it exists to test.
      'subtitles',
      // M5a: named by the PRD's "What M5a adds to the selftest" table. Its exit-2 list is
      // the longest in the product for the reason that table gives — the expensive lie
      // here is "we sent a message and nobody objected", so a set that will not take a
      // volume, a leg that began already at its target, a second sender that could not be
      // opened and a film that stopped playing are all runs that *could not happen*.
      'volume',
      'm1',
      'm2',
      'm3',
      // M3c's own aggregate, named by the same PRD table: "runs all three in order — the
      // one command the founder cares about". It adds no coverage; it runs the three
      // `subtitles` runs that already exist, and `m1`, `m2` and `m3` are unchanged.
      'm3c',
      // M5's aggregate, named by the M5b spec before M5a existed: `queue*` plus M5a's
      // `volume`. Deliberately **not** folded into m1/m2/m3/m3c, which are the untouched
      // regression baseline criterion 23j is graded by.
      'm5',
    ]);
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'always-pass']).ok).toBe(
      false,
    );
  });

  it('refuses `--rate` for anything but `headstart`, rather than ignoring it', () => {
    // A flag that changes what the product *does* must be refused loudly. `--rate` on `m3`
    // would slow every conversion in the aggregate to a crawl; on `convert` it would make
    // 8b's honesty clause meaningless — and in both cases the verdict would look ordinary.
    for (const scenario of ['m3', 'convert', 'cast'] as const) {
      const result = parseArgs([
        '--device',
        'TV',
        '--file',
        '/x',
        '--scenario',
        scenario,
        '--rate',
        '0.7',
      ]);
      expect(result.ok, `--rate must be refused for ${scenario}`).toBe(false);
    }
    const allowed = parseArgs([
      '--device',
      'TV',
      '--file',
      '/x',
      '--scenario',
      'headstart',
      '--rate',
      '0.7',
    ]);
    expect(allowed.ok).toBe(true);
    expect(allowed.ok && allowed.args.conversionReadRate).toBe(0.7);
    // And a rate that is not a rate is a usage error, never a silent 1×.
    expect(
      parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'headstart', '--rate', 'fast']).ok,
    ).toBe(false);
  });

  it('refuses a run whose two halves contradict each other', () => {
    // `--rate` requires the gate to stay shut; `--rate-after-gate` requires it to open and
    // then the guard to fire. A run given both would be a verdict about neither.
    const both = parseArgs([
      '--device',
      'TV',
      '--file',
      '/x',
      '--scenario',
      'headstart',
      '--rate',
      '0.7',
      '--rate-after-gate',
      '0.5',
    ]);
    expect(both.ok).toBe(false);
    // And a "fall behind" rate at or above real time is not falling behind at all — the
    // frontier keeps its lead and the guard can never fire, so the run would prove nothing.
    for (const rate of ['1', '1.5', '0']) {
      expect(
        parseArgs([
          '--device',
          'TV',
          '--file',
          '/x',
          '--scenario',
          'headstart',
          '--rate-after-gate',
          rate,
        ]).ok,
        rate,
      ).toBe(false);
    }
    const good = parseArgs([
      '--device',
      'TV',
      '--file',
      '/x',
      '--scenario',
      'headstart',
      '--rate-after-gate',
      '0.5',
    ]);
    expect(good.ok && good.args.conversionReadRateAfterGate).toBe(0.5);
    // Same rule as `--rate`: it belongs to one scenario and is refused everywhere else.
    expect(
      parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm3', '--rate-after-gate', '0.5'])
        .ok,
    ).toBe(false);
  });

  it('has a `headstart` scenario now that half B is built — and it can still fail', () => {
    // Through M3a this test asserted the **opposite**, and deliberately: a scenario named
    // after a feature that does not exist is the shape of green line this file exists to
    // prevent. M3b builds the feature, so the scenario may exist — and what it owes in
    // return is the ability to fail, which is criterion 10j and is pinned in
    // `stall-detector.test.ts` against a recorded run that really stalled.
    expect([...SCENARIOS]).toContain('headstart');
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'headstart']).ok).toBe(true);
  });

  it('runs every M3a scenario in `m3`, and the one expected to abort is last', () => {
    // Same rule `M2_ORDER` earned: a `SelftestAbort` ends the whole run at exit 2, so a
    // scenario that is *expected* to be unable to finish must not strand the ones behind
    // it. `prepfail` is that scenario in M3 — the PRD calls it "attempted; falls back to
    // human" — exactly as `takeover` is in M2.
    expect([...M3_ORDER]).toEqual([
      'check',
      'remux',
      'prepared',
      'convert',
      'headstart',
      'prepfail',
    ]);
    expect(M3_ORDER[M3_ORDER.length - 1]).toBe('prepfail');
    // And `m3` does not quietly become a subset of itself.
    for (const required of ['check', 'remux', 'prepared', 'convert', 'headstart'] as const) {
      expect([...M3_ORDER], `m3 cannot exist without ${required}`).toContain(required);
    }
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm3']).ok).toBe(true);
  });

  it('runs all three subtitle runs in `m3c`, and the one expected to abort is last', () => {
    // The PRD's own table: "runs all three in order. The one command the founder cares
    // about." Pinned so the aggregate can never quietly shrink to the runs somebody
    // remembered — the exact shape of the `m2` that "ran only the scenarios that existed"
    // and would have exited 0.
    expect(M3C_ORDER.map((leg) => leg.label)).toEqual([
      'subtitles',
      'subtitles-timing',
      'subtitles-broken',
    ]);
    // All three legs are the `subtitles` scenario, and every one of its three runs appears
    // exactly once. A leg that lost its flag would run the plain scenario a second time and
    // the verdict would still name three legs.
    expect(M3C_ORDER.map((leg) => leg.scenario)).toEqual(['subtitles', 'subtitles', 'subtitles']);
    expect(
      M3C_ORDER.map((leg) => `${String(leg.subtitleTiming)}/${String(leg.subtitleBroken)}`),
    ).toEqual(['false/false', 'true/false', 'false/true']);
    // `--broken` last, for the reason `takeover` is last in `m2` and `prepfail` in `m3`: it
    // is the leg whose abort is anticipated and outside our control (a television that
    // fetched the withheld track anyway exits 2), and an anticipated abort must not strand
    // the legs behind it.
    expect(M3C_ORDER.at(-1)?.subtitleBroken).toBe(true);
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm3c']).ok).toBe(true);
    // And the two flags are refused *beside* it rather than silently ignored: inside `m3c`
    // they are legs, so asking for one would be a question the verdict could not answer.
    for (const flag of ['--timing', '--broken']) {
      const asked = parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm3c', flag]);
      expect(asked.ok, `${flag} beside m3c`).toBe(false);
      expect(!asked.ok && asked.reason).toContain('m3c');
    }
  });

  it('offers `m2` only now that every M2 scenario behind it exists', () => {
    // This test used to assert the **opposite**, and deliberately: an `m2` that ran only
    // the scenarios that existed would have exited 0 and been read as "M2 passed", which
    // is precisely the kind of pass this file guards against. The three that were missing
    // — `recover`, `reattach`, `takeover` — are the ones whose shape SPIKE-2 had to settle
    // first. All three exist, so the aggregate may exist too, and what it runs is pinned
    // here so it can never quietly shrink back to a subset.
    expect([...SCENARIOS]).toContain('m2');
    for (const required of ['recover', 'reattach', 'takeover'] as const) {
      expect([...SCENARIOS], `m2 cannot exist without ${required}`).toContain(required);
    }
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm2']).ok).toBe(true);
  });

  it('runs every M2 scenario, and runs the one that is expected to abort last', () => {
    // A `SelftestAbort` ends the whole run at exit 2 — correctly; "this did not happen" is
    // not a promise that failed. But in an aggregate it also silently drops every scenario
    // after it, and the verdict cannot tell "never ran" from "never promised".
    //
    // `takeover` is the one the PRD expects to abort: "if it doesn't [behave like a phone
    // taking the TV], this becomes checklist item 4 and the scenario exits 2." Fifth of
    // eight, a television that would not be taken programmatically cost the run
    // `sourcegone`, `finish` and `resume` as well — three scenarios and eleven criteria,
    // unmeasured and unmentioned.
    expect([...M2_ORDER].sort()).toEqual(
      ['seek', 'skip', 'recover', 'reattach', 'takeover', 'sourcegone', 'finish', 'resume'].sort(),
    );
    expect(M2_ORDER.at(-1)).toBe('takeover');
    // And the exit-code contract is untouched by the reordering: `m2` still runs every one
    // of them, so it still cannot reach 0 without all eight having kept their promises.
    for (const scenario of M2_ORDER) expect([...SCENARIOS]).toContain(scenario);
  });

  it('rejects an outage kind nothing knows how to produce', () => {
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--outage', 'socket']).ok).toBe(true);
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--outage', 'heartbeat']).ok).toBe(true);
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--outage', 'wifi']).ok).toBe(false);
  });

  it('keeps the outage list to what this harness can actually produce, and says who does it', () => {
    // The list grew by one on 2026-08-18, and the addition is the only entry nothing in
    // this repository can perform: `cable` is a person walking to the PC. Pinned here
    // because the honesty of every `recover` verdict rests on the flag meaning what it
    // says — a `cable` run that quietly produced a severed socket instead would report a
    // pass for the one path that has never met a real network.
    //
    // It grew again on 2026-08-28, for defect D2: `network` takes the **television's**
    // route to this PC away — the control socket and every byte connection to the media
    // server — and gives it back, which is the one thing `socket` and `heartbeat` cannot
    // do and the condition D2 lives in. Unlike `cable` it needs nobody in the room, so it
    // is not in `HUMAN_OUTAGES` and it may run inside an aggregate.
    expect([...OUTAGES]).toEqual(['socket', 'heartbeat', 'network', 'cable']);
    expect([...HUMAN_OUTAGES]).toEqual(['cable']);
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--outage', 'unplug-the-tv']).ok).toBe(
      false,
    );

    // And the rule that keeps an unattended aggregate unattended. `m2` passed 107/107 on
    // a real television with nobody in the room; a scenario that stood waiting two minutes
    // for a cable nobody was going to pull, then exited 2, would have cost that run seven
    // scenarios and told the founder nothing.
    for (const outage of HUMAN_OUTAGES) {
      for (const scenario of SCENARIOS) {
        const allowed = refuseOutage(scenario, outage) === null;
        expect(allowed, `${scenario} + ${outage}`).toBe(scenario === 'recover');
        expect(
          parseArgs(['--device', 'TV', '--file', '/x', '--scenario', scenario, '--outage', outage])
            .ok,
          `${scenario} + ${outage} at the command line`,
        ).toBe(scenario === 'recover');
      }
    }
  });

  it.concurrent('treats --help as "no run happened", not as a pass', async () => {
    await withFixture(async () => {
      const out: string[] = [];
      const code = await runSelftestCli(['--help'], {
        out: (t) => out.push(t),
        err: () => undefined,
      });
      expect(code).toBe(2);
      expect(out.join('')).toContain('Exit codes');
    });
  });

  it.concurrent('carries every run-shaping flag from the command line into the run', async () => {
    // **This is the test that was missing on 2026-08-26, and a 148-minute film paid for it.**
    // `--watch` was parsed, range-checked, and guarded by `refuseWatch` — three correct
    // mechanisms around one line that did not exist: the flag was never handed to
    // `runSelftest`. So the full-film run took the ordinary three-minute watch, never
    // asserted `filmReachedEnd`, and reported PASSED exit 0 after 6.8 minutes. Every test
    // here covered one side of that seam or the other; none covered the seam.
    //
    // `runVariant` is the cheapest honest witness: it is stamped from the options before a
    // device is ever looked for, so a run that cannot happen at all still says which run was
    // asked for. A missing file exits 2 and still writes the verdict.
    const shapes = [
      { flags: ['--watch', '130m'], variant: 'full-film' },
      { flags: ['--rate', '0.7'], variant: 'starved' },
      { flags: ['--rate-after-gate', '0.5'], variant: 'falls-behind' },
      { flags: [], variant: null },
    ] as const;

    for (const shape of shapes) {
      const out: string[] = [];
      const code = await runSelftestCli(
        [
          '--device',
          'Family room TV',
          '--file',
          '/no/such/film.mkv',
          '--scenario',
          'headstart',
          ...shape.flags,
        ],
        { out: (t) => out.push(t), err: () => undefined },
      );
      // The run could not happen — that is the point. What is being checked is that the
      // flag reached the runner, not that anything played.
      expect(code, `${shape.flags.join(' ') || 'no flags'} should abort on a missing file`).toBe(2);
      const verdict: unknown = JSON.parse(out.join(''));
      expect(
        (verdict as { variant: string | null }).variant,
        `\`${shape.flags.join(' ') || '(none)'}\` must reach the run, not stop at the parser`,
      ).toBe(shape.variant);
    }
  });

  it('rejects an empty device name rather than matching the first TV it sees', () => {
    expect(parseArgs(['--device', '', '--file', '/x']).ok).toBe(false);
    expect(parseArgs(['--device', '   ', '--file', '/x']).ok).toBe(false);
    expect(parseArgs(['--device', 'TV', '--file', '   ']).ok).toBe(false);
  });
});

describe.concurrent('an aggregate finds out what it cannot do before it starts', () => {
  it.concurrent(
    'refuses a film too short to grade, having cast nothing at all',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // `seek` needs a file long enough for a 20-minute jump in both directions, and it
        // aborts if it does not get one. First in the running order, that abort took the whole
        // of `m2` with it *after* a television had already been cast to — and the founder was
        // left with a verdict naming one scenario and no measurements. The same condition is
        // knowable from the file alone, before anything is on screen.
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'm2',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });

        expect(verdict.exitCode).toBe(2);
        expect(verdict.outcome).toBe('could-not-run');
        expect(verdict.reason).toContain('minutes');
        // Exit 2 asserts nothing — and nothing was played to find it out.
        expect(verdict.assertions).toEqual([]);
        expect(receiver.received.filter((message) => message.type === 'LAUNCH')).toHaveLength(0);
        expect(receiver.launched).toBe(false);
      });
    },
    30_000,
  );
});

describe.concurrent('a verdict built on a fake says so about itself', () => {
  it.concurrent(
    'stamps transport: "test-harness" on every run given a scripted receiver',
    async () => {
      await withFixture(async ({ filePath, paths, service }) => {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        expect(verdict.environment.transport).toBe('test-harness');
        // Including on the copy written next to the engine log, which is the artifact a
        // human would actually be shown.
        const written = await fs.readdir(paths().logDir);
        const file = written.find((name) => name.startsWith('selftest-cast-'));
        const parsed = JSON.parse(
          await fs.readFile(path.join(paths().logDir, file as string), 'utf8'),
        ) as SelftestVerdict;
        expect(parsed.environment.transport).toBe('test-harness');
      });
    },
    40_000,
  );

  it.concurrent(
    'stamps transport: "tls" only when nothing was overridden',
    async () => {
      await withFixture(async ({ filePath, paths }) => {
        // No overrides: real multicast, real TLS, and on this machine no device answers.
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 200,
        });
        expect(verdict.environment.transport).toBe('tls');
        expect(verdict.exitCode).toBe(2);
        expect(verdict.outcome).toBe('could-not-run');
        // And it records where it ran, so a verdict produced in WSL identifies itself as
        // one rather than being mistaken for a run on the founder's PC.
        expect(verdict.environment.platform).toBe(process.platform);
        expect(verdict.environment.nodeVersion).toBe(process.versions.node);
      });
    },
    20_000,
  );
});

describe.concurrent('no device, no pass', () => {
  it.concurrent(
    'never returns exit 0 for any scenario when the device never answers',
    async () => {
      await withFixture(async ({ filePath, paths }) => {
        for (const scenario of SCENARIOS) {
          const verdict = await runSelftest({
            deviceName: 'A TV That Is Not There',
            filePath,
            scenario,
            paths: paths(),
            deviceWaitMs: 200,
            positionDurationMs: 500,
            unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(null) },
          });
          expect(verdict.exitCode, scenario).toBe(2);
          expect(verdict.outcome, scenario).toBe('could-not-run');
          expect(verdict.reason, scenario).toContain('A TV That Is Not There');
          // A run that could not happen asserts nothing — and an empty assertion list is
          // never a pass, which is the other half of the same guarantee.
          expect(verdict.assertions, scenario).toEqual([]);
        }
      });
    },
    60_000,
  );

  it.concurrent(
    'cannot pass on an empty assertion list',
    async () => {
      await withFixture(async ({ filePath, paths }) => {
        const aborted = await runSelftest({
          deviceName: 'Nowhere',
          filePath,
          scenario: 'discovery',
          paths: paths(),
          deviceWaitMs: 200,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(null) },
        });
        expect(aborted.assertions).toHaveLength(0);
        expect(aborted.exitCode).not.toBe(0);
      });
    },
    20_000,
  );

  it.concurrent(
    'reports a device whose name differs only in case as found, and one that differs as absent',
    async () => {
      await withFixture(async ({ filePath, paths, service }) => {
        const matched = await runSelftest({
          deviceName: '  FAMILY room TV ',
          filePath,
          scenario: 'discovery',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        expect(matched.outcome).toBe('passed');

        const missed = await runSelftest({
          deviceName: 'Family room TV 2',
          filePath,
          scenario: 'discovery',
          paths: paths(),
          deviceWaitMs: 300,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        expect(missed.exitCode).toBe(2);
      });
    },
    40_000,
  );
});

describe.concurrent('a device that answers but does not play is a failure, not a pass', () => {
  it.concurrent(
    'exits 1, with a null measurement, when the device never reaches PLAYING',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        receiver.swallow('LOAD');
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

        // Which of these carries the cast timing has moved twice, so this test names the
        // guarantee rather than the arrangement: a device that answers but never plays must
        // fail the run, and the wait it never ended must be *measured as null*, never quietly
        // omitted. `firstCastToPictureMs` became a graded promise on 2026-08-18 (founder's
        // ruling: the whole wait is the only cast-speed promise), so it is asserted here as
        // one, and a null must fail it rather than pass it.
        const sequence = verdict.assertions.find((item) => item.name === 'firstStateSequence');
        expect(sequence?.passed).toBe(false);
        const toPicture = verdict.assertions.find((item) => item.name === 'firstCastToPictureMs');
        expect(toPicture?.measured).toBeNull();
        expect(toPicture?.passed).toBe(false);
        // A missing measurement must never be read as satisfying its target.
        expect(verdict.assertions.some((item) => item.measured === null && item.passed)).toBe(
          false,
        );
        // And nothing ungraded may hide among the graded, where it would be read as a promise.
        expect(verdict.assertions.every((item) => item.kind === 'promise')).toBe(true);
      });
    },
    60_000,
  );

  it.concurrent(
    'exits 1 when the device dies mid-scenario for good, rather than aborting into exit 2',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // The half of this that is non-negotiable: **a promise that could not be kept is a
        // failure, not a run that could not happen.** Exit 2 would say "nothing was proved
        // either way", which is a much softer thing to read in the morning than "the film
        // stopped and never came back".
        //
        // Story 11 made a *survivable* drop the wrong instrument for this — the engine now
        // reconnects through one, and the scenario really does keep every promise (see the
        // test below). So the television is killed outright: the port stops answering, every
        // reconnection is refused, and recovery cannot succeed however long it is given.
        const run = runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'transport',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        // Let it get as far as a picture, then take the television away permanently.
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        await receiver.close();
        const verdict = await run;

        expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(1);
        expect(verdict.outcome).toBe('failed');
        // And it failed for the honest reason: promises about a device that was gone were
        // measured as unmet rather than quietly dropped from the list.
        expect(verdict.assertions.some((item) => !item.passed)).toBe(true);
        expect(verdict.assertions.some((item) => item.measured === null && item.passed)).toBe(
          false,
        );
      });
    },
    90_000,
  );

  it.concurrent(
    'exits 0 when the connection dies and genuinely recovers, because that kept the promise',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // The other half, and the reason the test above had to change. A dropped socket is no
        // longer a broken evening: SPIKE-2 measured a real television playing on through it and
        // a new connection rejoining the same media session in 126 ms. If the scenario then
        // keeps every promise it made — pause, resume, stop, release, cast again — **0 is the
        // honest answer**, and a selftest that failed the run anyway would be lying in the
        // safe direction, which is still lying.
        const run = runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'transport',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        await new Promise((resolve) => setTimeout(resolve, 1_500));
        // A blip: the socket is destroyed, the television keeps playing, and the port is still
        // there to be reconnected to.
        receiver.dropConnections();
        const verdict = await run;

        expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(0);
        expect(verdict.outcome).toBe('passed');
        expect(verdict.assertions.every((item) => item.passed)).toBe(true);
        // Nothing was skipped to get there: the run really did pause, resume and stop a device
        // it had lost the connection to and got back.
        expect(verdict.assertions.map((item) => item.name)).toContain('pauseLatencyMs');
        expect(verdict.assertions.map((item) => item.name)).toContain('resumePositionErrorSec');
        expect(verdict.assertions.map((item) => item.name)).toContain('secondStateSequence');
      });
    },
    90_000,
  );
});

describe.concurrent(
  'criterion 13b — every assertion carries its target and its measurement',
  () => {
    it.concurrent(
      'leaves no assertion without a name, a target, a comparison and a unit',
      async () => {
        await withFixture(async ({ filePath, paths, service }) => {
          const verdict = await runSelftest({
            deviceName: 'Family room TV',
            filePath,
            scenario: 'cast',
            paths: paths(),
            deviceWaitMs: 5_000,
            unsafeTestOverrides: {
              transport: tcpTransportFactory,
              mdns: createFakeMdns(service()),
            },
          });

          expect(verdict.assertions.length).toBeGreaterThan(0);
          for (const item of verdict.assertions) {
            expect(item.name, JSON.stringify(item)).toMatch(/\S/);
            expect(item.target, item.name).not.toBeUndefined();
            expect(item.target, item.name).not.toBeNull();
            expect(['lte', 'gte', 'eq'], item.name).toContain(item.comparison);
            expect(item.unit, item.name).toMatch(/\S/);
            expect(typeof item.passed, item.name).toBe('boolean');
            // "Passed" without a number is the thing this exists to replace.
            expect(item.passed && item.measured === null, item.name).toBe(false);
          }
          expect(verdict.scenario).toBe('cast');
          expect(verdict.device).toBe('Family room TV');
          expect(verdict.file).toBe(filePath);
          expect(Date.parse(verdict.startedAt)).toBeGreaterThan(0);
          expect(verdict.durationMs).toBeGreaterThanOrEqual(0);
        });
      },
      40_000,
    );

    it('prints every assertion, pass and fail alike, with both numbers', () => {
      const text = summarise({
        scenario: 'cast',
        device: 'Family room TV',
        outcome: 'failed',
        exitCode: 1,
        reason: null,
        assertions: [
          {
            name: 'castToPictureMs',
            target: 10_000,
            comparison: 'lte',
            measured: 12_100,
            unit: 'ms',
            passed: false,
          },
          {
            name: 'fileDurationSec',
            target: 1,
            comparison: 'gte',
            measured: 90,
            unit: 's',
            passed: true,
          },
        ],
      } as unknown as SelftestVerdict);
      expect(text).toContain('FAIL castToPictureMs: measured 12100 ms (target <= 10000)');
      expect(text).toContain('PASS fileDurationSec: measured 90 s (target >= 1)');
      expect(text).toContain('exit 1');
    });

    it.concurrent(
      'says plainly why a run could not happen, with no stack trace',
      async () => {
        await withFixture(async ({ directory, paths, receiver, service }) => {
          const verdict = await runSelftest({
            deviceName: 'Family room TV',
            filePath: path.join(directory, 'not-here.mp4'),
            scenario: 'm1',
            paths: paths(),
            deviceWaitMs: 200,
            unsafeTestOverrides: {
              transport: tcpTransportFactory,
              mdns: createFakeMdns(service()),
            },
          });
          expect(verdict.exitCode).toBe(2);
          expect(verdict.reason).toContain('file not found');
          expect(verdict.reason).not.toContain('at ');
          expect(summarise(verdict)).toContain('could not run');
          // Nothing was launched on the device: the check happens before the engine starts.
          expect(receiver.received).toHaveLength(0);
        });
      },
      20_000,
    );
  },
);

describe.concurrent('criterion 13e — the selftest never leaves a TV playing', () => {
  it.concurrent(
    'releases the device after a scenario that passed',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'cast',
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        expect(receiver.launched).toBe(false);
        expect(receiver.playerState).not.toBe('PLAYING');
      });
    },
    40_000,
  );

  // The failure case — a device that refuses the file — is DEFECT 3 in
  // `confirmed-defects.test.ts`: the receiver app is left running on the TV.
});

/**
 * **Criterion 13g — the run that scored 9/9 on a film that was already dead.**
 *
 * 2026-08-24, from `docs/STATUS.md`: `--scenario cast` against the Chromecast Ultra with a
 * 113-minute H.264 + 6-channel AAC film. `PLAYING` at `deviceSec 0`, then `IDLE` with
 * `idleReason: ERROR` **81 ms** later, `trigger: device.idle` — the television quit on its
 * own; the two `cast.stop`s in the log arrive ten and twenty seconds afterwards from a
 * scenario still waiting for samples that never came. The verdict said **9/9, exit 0**, and
 * `firstStateSequence: reached playing` was one of the nine. **It was true.** The device
 * really did say `PLAYING`. It was true about a corpse.
 *
 * That verdict was then written into the PRD as a measurement of a television decoding 5.1
 * audio, and retracted two hours later when a two-minute run said the opposite. It is the
 * only time in this project a misleading instrument has cost a wrong fact in a live
 * decision rather than a confusing evening, and it is the argument that pulled 13g forward
 * onto this branch.
 *
 * This test is that run, reproduced against a scripted television: same scenario, same
 * shape, same 81 ms. **It must not be able to end in a pass.**
 */
describe.concurrent('a film that dies mid-scenario cannot leave passing assertions behind', () => {
  it.concurrent(
    'reproduces the run that graded a corpse, and refuses to count any of it (13g)',
    async () => {
      await withFixture(async ({ filePath, paths, receiver, service }) => {
        // `position`, because that is the scenario the real evidence came from
        // (`--scenario position --duration 2m`) and because it keeps talking to the
        // television long after it has stopped answering — which is the condition. Its
        // opening leg is the same `castToPicture` the 9/9 `cast` run scored, so
        // `firstStateSequence` is graded here exactly as it was there.
        const kill = (async () => {
          for (let attempt = 0; attempt < 800; attempt += 1) {
            if (receiver.playerState === 'PLAYING') {
              // The 81 ms, near enough. Nothing stops it: `failMedia` is `IDLE` with
              // `idleReason: ERROR` and no STOP in sight, which is precisely what
              // `trigger: device.idle` meant in the log that night.
              await new Promise((resolve) => setTimeout(resolve, 81));
              receiver.failMedia();
              return true;
            }
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
          return false;
        })();

        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'position',
          positionDurationMs: 3_000,
          paths: paths(),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
        });
        // If the television never played at all this test proves nothing, so it says so
        // loudly rather than passing on a run that could not have failed — D1's own rule.
        expect(await kill, 'the scripted television never reached PLAYING').toBe(true);

        expect(verdict.outcome).toBe('failed');
        expect(verdict.exitCode).toBe(1);

        // **The line that used to be green on a corpse.** It still reports what it measured
        // — the device did reach playing, and hiding that would be its own kind of lie —
        // but it no longer counts, and it says why.
        const sequence = verdict.assertions.find((item) => item.name === 'firstStateSequence');
        expect(sequence?.measured).toBe('reached playing');
        expect(sequence?.passed).toBe(false);
        expect(sequence?.note).toContain('13g');
        expect(sequence?.note).toContain('IDLE/ERROR');

        // The event itself is named as a failure of its own, so a reader of the verdict is
        // told what happened rather than left to infer it from a page of demoted lines.
        const refused = verdict.assertions.find((item) => item.name === 'televisionRefusedMidPlay');
        expect(refused?.passed).toBe(false);
        expect(refused?.measured).toBe('yes');

        // **The whole of the criterion's failure clause**: not one passing assertion in the
        // verdict. Nine of these were green on the night.
        expect(verdict.assertions.filter((item) => item.passed)).toEqual([]);
      });
    },
    60_000,
  );

  it.concurrent(
    'leaves an ordinary run alone — a deliberate stop is not a refusal',
    async () => {
      await withFixture(async ({ filePath, paths, service }) => {
        // The guard's blast radius, measured rather than asserted. Every scenario in this
        // file ends by issuing `cast.stop`, and a real television answers that with
        // `IDLE`/`idleReason: CANCELLED` — a reason that is not `FINISHED`. If the guard
        // keyed on the reason instead of on who asked, **every run in the project would
        // fail**, which is the way this fix could do more damage than the defect.
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
        expect(verdict.assertions.some((item) => item.name === 'televisionRefusedMidPlay')).toBe(
          false,
        );
        expect(verdict.assertions.every((item) => item.passed)).toBe(true);
      });
    },
    60_000,
  );
});
