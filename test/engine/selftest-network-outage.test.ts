import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isHumanOutage,
  refuseOutage,
  runSelftest,
  type Assertion,
  type SelftestVerdict,
} from '../../src/engine/selftest/index.js';
import { parseArgs } from '../../src/engine/selftest/args.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { systemClock } from '../../src/engine/logging/index.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * **`--outage network`: the selftest's half of defect D2, exercised end to end.**
 *
 * `test/engine/d2-media-path.test.ts` proves the *product* mends the media path. This file
 * proves the **instrument** can see it — that a scenario exists which can produce the
 * condition, that it grades the two things that were wrong, and that it refuses to pass a
 * run in which the condition never occurred.
 *
 * That last one is the rule this project has now learned nine times: *a test whose fixture
 * cannot express the defect is not evidence, however green it is.* `--outage socket` and
 * `--outage heartbeat` kill our own connection while this PC's media server stays
 * reachable throughout, so the television's byte connection is never broken and D2 cannot
 * happen in either. `--outage cable` can produce it, needs a person, and has never been
 * pointed at the media server's socket.
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

/**
 * A film large enough to still be arriving, written sparse.
 *
 * A delivery that completes is not one an outage can interrupt — see the same note in
 * `d2-media-path.test.ts`. This is the fixture's own calibration.
 */
async function writeFixtureMp4(target: string, durationSec: number): Promise<void> {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(durationSec * 1_000, 16);
  const ftyp = box('ftyp', Buffer.from('isom'));
  const mdatBytes = 16 * 1024 * 1024;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(mdatBytes + 8, 0);
  mdatHeader.write('mdat', 4, 'latin1');
  const moov = box('moov', box('mvhd', mvhd));
  const handle = await fs.open(target, 'w');
  try {
    await handle.write(ftyp, 0, ftyp.length, 0);
    await handle.write(mdatHeader, 0, mdatHeader.length, ftyp.length);
    const moovAt = ftyp.length + mdatHeader.length + mdatBytes;
    await handle.truncate(moovAt);
    await handle.write(moov, 0, moov.length, moovAt);
  } finally {
    await handle.close();
  }
}

interface Run {
  readonly verdict: SelftestVerdict;
  readonly receiver: FakeReceiver;
}

async function runNetworkOutage(
  prepare: (receiver: FakeReceiver) => void = (receiver) =>
    // **The shape the founder's own log revealed**, and the scenario has to survive it: the
    // television makes its small setup requests first and does not open the delivery that
    // matters until seconds later — ~18 s on the `AI PONT`, 2026-08-28. A fixture that opens
    // its delivery the instant the LOAD lands cannot express 13h at all.
    receiver.setStreamsFilm(true, { bufferSec: 3, setupRequests: 2, deliveryDelayMs: 4_000 }),
): Promise<Run> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-netoutage-'));
  const filePath = path.join(directory, 'Cars.mp4');
  await writeFixtureMp4(filePath, 3_000);
  const receiver = await startFakeReceiver({ durationSec: 3_000 });
  prepare(receiver);
  try {
    const verdict = await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'recover',
      outage: 'network',
      clock: systemClock,
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      deviceWaitMs: 5_000,
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
    return { verdict, receiver };
  } finally {
    await receiver.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function must(verdict: SelftestVerdict, name: string): Assertion {
  const found = [...verdict.assertions, ...verdict.observations].find((item) => item.name === name);
  expect(
    found,
    `no assertion called "${name}"; the run reported: ${verdict.assertions
      .map((item) => item.name)
      .join(', ')}`,
  ).toBeDefined();
  return found as Assertion;
}

describe('--outage network — the outage that can express D2', () => {
  it('is a kind the command line accepts, and it needs nobody in the room', () => {
    const parsed = parseArgs([
      '--device=Family room TV',
      '--file=/tmp/x.mp4',
      '--scenario=recover',
      '--outage=network',
    ]);
    expect(parsed.ok && parsed.args.outage).toBe('network');
    // Unlike `cable`, it may run unattended — which is what makes it reachable from CI and
    // from an aggregate, and what stops D2 depending on somebody standing at a PC.
    expect(isHumanOutage('network')).toBe(false);
    expect(refuseOutage('m2', 'network')).toBeNull();
  });

  it('takes the television’s route to this PC away, gives it back, and grades the film coming back', async () => {
    const { verdict, receiver } = await runNetworkOutage();

    expect(verdict.reason, `aborted: ${verdict.reason ?? ''}`).toBeNull();

    // 13b: nothing may pass on a number it never took.
    for (const item of verdict.assertions) {
      expect(item.measured, `${item.name} measured nothing`).not.toBeNull();
      expect(item.target, item.name).not.toBeNull();
    }

    // **The condition existed.** The television really did have a byte connection to this
    // PC and it really was taken away — without which nothing below could have failed.
    expect(Number(must(verdict, 'networkOutageByteConnectionsCut').measured)).toBeGreaterThan(0);
    expect(receiver.filmStreamBreaks).toBeGreaterThan(0);

    // D2-1: the **film** came back, measured as the television fetching from this PC
    // again. This is the number that was zero for the whole minute after the cable went
    // back in on 2026-08-27.
    expect(
      must(verdict, 'networkOutageBytesFlowedAgainMs').passed,
      JSON.stringify(verdict.assertions),
    ).toBe(true);
    expect(must(verdict, 'networkOutageResumedMs').passed).toBe(true);
    expect(must(verdict, 'networkOutageResumePositionErrorS').passed).toBe(true);

    // **11b's own number**, from the route returning to the film running again, read off
    // the television. It measured 41.96 s on the `Family room TV` on 2026-08-28 — on a
    // recovery whose every other promise was met.
    const playingAgain = must(verdict, 'networkOutageFilmPlayingAgainMs');
    expect(playingAgain.measured, JSON.stringify(verdict.assertions)).not.toBeNull();
    expect(Number(playingAgain.measured)).toBeLessThanOrEqual(10_000);
    expect(playingAgain.passed).toBe(true);

    // **The route was not cut until the film was really being fetched**, which is the whole
    // of defect 13h. Zero here is honest — it means a delivery was already in flight when
    // the scenario looked; the case where it is not is the test below.
    expect(must(verdict, 'networkOutageWaitedForDeliveryMs').measured).not.toBeNull();

    // D2-3 and D2-4: it did not thrash, and the deadline was not restarted.
    expect(must(verdict, 'networkOutageRecoveryAttempts').passed).toBe(true);
    expect(must(verdict, 'networkOutageDeadlineNotRestarted').passed).toBe(true);

    // **D2, second half: the repair's own LOAD is not the television abandoning the film.**
    // The fixture answers a LOAD over a playing film the way a real receiver does — `IDLE`
    // with `idleReason: INTERRUPTED` for the media session being superseded — which is what
    // scored this scenario 0/18 on 2026-08-28 through 13g's guard, on a run where the film
    // was playing again a second later.
    expect(receiver.supersededIdles, 'the fixture never provoked the case').toBeGreaterThan(0);
    expect(
      must(verdict, 'networkOutageRepairIsNotARefusal').measured,
      JSON.stringify(verdict.assertions),
    ).toBe('no refusal');
    expect(must(verdict, 'networkOutageNeverSaidStopped').measured).toBe('never stopped');
    // …and 13g's guard therefore had nothing to demote: every promise above is counted.
    expect(verdict.assertions.some((item) => item.name === 'televisionRefusedMidPlay')).toBe(false);

    // 11a: only the status line changed.
    expect(must(verdict, 'networkOutageShowedNoError').measured).toBe('no error');
    expect(must(verdict, 'networkOutageKeptTheFile').measured).toBe('held');
    expect(must(verdict, 'networkOutageFounderPressedNothing').measured).toBe(0);

    // The television went back for the film's bytes more than once: the outage broke its
    // stream and something started a new one. (Its *end* state is not evidence — the
    // scenario stops the film and hands the television back before it returns.)
    expect(receiver.filmStreamAttempts).toBeGreaterThan(1);

    expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(0);
  }, 180_000);

  it('waits for a delivery that only opens seconds after playback, rather than racing it', async () => {
    // **The instrument fault, stated as a measurement.** This receiver behaves like the
    // `AI PONT`: it accepts the LOAD, makes its setup requests, **reaches PLAYING off those
    // first bytes** — and opens the delivery that matters twenty seconds later. On the
    // founder's set that gap was ~18 s and the scenario cut inside it, so it broke nothing
    // at all and exited 2 on three of four hardware attempts.
    const { verdict, receiver } = await runNetworkOutage((device) =>
      device.setStreamsFilm(true, { bufferSec: 3, setupRequests: 2, deliveryDelayMs: 20_000 }),
    );

    expect(verdict.reason, `aborted: ${verdict.reason ?? ''}`).toBeNull();
    // **It really did wait**, and the number says so: the delivery opened long after the
    // point this scenario used to cut at, and the run stood there until it did. Against the
    // scenario as it was — a cut the moment playback settled — `media.blackout` counts
    // `deliveries: 0` and the whole run exits 2, which is what the hardware kept reporting.
    expect(
      Number(must(verdict, 'networkOutageWaitedForDeliveryMs').measured),
    ).toBeGreaterThanOrEqual(1_000);
    // …and there was therefore something to break when it cut.
    expect(Number(must(verdict, 'networkOutageByteConnectionsCut').measured)).toBeGreaterThan(0);
    expect(receiver.filmStreamBreaks).toBeGreaterThan(0);
    expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(0);
  }, 240_000);

  it('issues no repair at all when the television mends its own byte connection', async () => {
    // **The conservative constraint, graded by the instrument rather than argued.** 11h: a
    // set that goes back for the bytes by itself is left alone — reloading a film that was
    // coming back anyway is a stutter nobody asked for, and it is the failure mode a watch
    // for late interruptions could most easily have introduced.
    const { verdict } = await runNetworkOutage((device) => {
      device.setStreamsFilm(true, { bufferSec: 3, setupRequests: 2, deliveryDelayMs: 2_000 });
      device.setRefetchesAfterStreamBreak(true);
    });

    expect(verdict.reason, `aborted: ${verdict.reason ?? ''}`).toBeNull();
    expect(Number(must(verdict, 'networkOutageMediaPathRepaired').measured)).toBe(0);
    // And the film still came back inside 11b's ten seconds — by itself, which is the point.
    expect(must(verdict, 'networkOutageFilmPlayingAgainMs').passed).toBe(true);
    expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(0);
  }, 240_000);

  it('exits 2 — never 0 — when the television was not fetching anything to take away', async () => {
    // A television that accepted the film and never came for the bytes has no byte
    // connection to break, so this run could not have produced D2 whatever the app did.
    // A pass here would be a green verdict for a promise nobody tested.
    const { verdict } = await runNetworkOutage((receiver) => {
      // A television that fetched the film once and finished — nothing is in flight for
      // an outage to interrupt. The film plays, every other promise could be graded, and
      // this one could not have failed. That is exit 2, not a pass.
      receiver.setStreamsFilm(false);
    });

    expect(verdict.exitCode).toBe(2);
    expect(verdict.outcome).toBe('could-not-run');
    expect(verdict.reason ?? '').toMatch(/no byte connection|could not have produced/i);
  }, 180_000);
});
