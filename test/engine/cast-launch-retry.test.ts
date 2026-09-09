import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink, systemClock, type Clock } from '../../src/engine/logging/index.js';
import { CAST, TIMING } from '../../src/engine/config.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { buildViewModel, type PickerState } from '../../src/renderer/state/view-model.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * A television that is slow to wake, and the two silent retries PRD 3b promises.
 *
 * **The defect this file exists for**, confirmed on the founder's own hardware on
 * 2026-08-18: a "Family room TV" that had been idle 56 minutes accepted the TCP+TLS
 * handshake in 181 ms and then took longer than ten seconds to answer `LAUNCH`. The app
 * gave up and said *"Couldn't reach Family room TV"* about a working television — because
 * the two silent retries covered `connect`, the fastest and most reliable step, and the
 * slowest exchange in the protocol had exactly one chance.
 *
 * Two things are proved here and neither can be proved by sampling the end state, which is
 * how a defect got through earlier the same day:
 *
 *  1. a LAUNCH that goes unanswered is re-sent, and the cast succeeds;
 *  2. **nothing about that is visible** — no counter, no error, no screen going backwards,
 *     across every snapshot of the whole episode, read through the real view model.
 *
 * The launch timeout is injected, exactly as `cast-heartbeat.test.ts` injects the ping
 * interval and for the same reason: what is under test is the *number of attempts* and
 * what the founder sees between them, not how long a `setTimeout` sleeps. Three attempts
 * at the shipping 14 s would put three quarters of a minute of sleeping in the suite.
 */

const LAUNCH_MS = 300;
const OTHER_DEVICE_ID = 'fake-device-2';
const IDLE_PICKER: PickerState = { available: true, busy: false, error: null };

interface FakeMdns extends Mdns {
  up(service: MdnsService): void;
}

function createFakeMdns(): FakeMdns {
  const active = new Set<MdnsHandlers>();
  const seen: MdnsService[] = [];
  return {
    browse(handlers) {
      active.add(handlers);
      for (const service of seen) handlers.onUp(service);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
    up(service) {
      seen.push(service);
      for (const handlers of [...active]) handlers.onUp(service);
    },
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/** A 90-second MP4 with its moov at the end, like the founder's own file. */
function fixtureMp4(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(90_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

/** The engine's monotonic clock, with a shove — see `cast-session.test.ts`. */
interface ShiftingClock extends Clock {
  shift(ms: number): void;
}

function createShiftingClock(): ShiftingClock {
  let offset = 0;
  return {
    wallMs: () => Date.now() + offset,
    monoMs: () => systemClock.monoMs() + offset,
    shift(ms) {
      offset += ms;
    },
  };
}

let receiver: FakeReceiver;
let other: FakeReceiver;
let engine: Engine;
let clock: ShiftingClock;
let mdns: FakeMdns;
let directory: string;
let filePath: string;
let sink: ReturnType<typeof createMemorySink>;
/** Every snapshot the renderer would have been pushed, in order. */
let stream: StateSnapshot[];

function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<StateSnapshot> {
  return new Promise((resolve, reject) => {
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error(`timed out; last state ${engine.snapshot().session.state}`));
    }, timeoutMs);
    unsubscribe = engine.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      resolve(snapshot);
    });
  });
}

function loggedEvents(): string[] {
  return sink.lines
    .map((line) => (JSON.parse(line) as Record<string, unknown>)['event'])
    .filter((event): event is string => typeof event === 'string');
}

async function chooseFileAndDevice(): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filePath });
  await waitFor((snapshot) => snapshot.file !== null);
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: 90 });
  other = await startFakeReceiver({ durationSec: 90 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-launch-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());

  mdns = createFakeMdns();
  sink = createMemorySink();
  clock = createShiftingClock();
  stream = [];
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    clock,
    logSink: sink,
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
    launchTimeoutMs: LAUNCH_MS,
  });
  await engine.start();
  engine.subscribe((snapshot) => stream.push(snapshot));
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
  // A second television, under its own identity: both fakes call themselves
  // `fake-device-1`, and announcing the second under that id replaced the first rather
  // than joining it — which quietly cast to the wrong receiver.
  mdns.up({
    id: OTHER_DEVICE_ID,
    friendlyName: 'Bedroom TV',
    model: other.device.model,
    address: '127.0.0.1',
    port: other.port,
  });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await other.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('a television that is slow to wake', () => {
  it('re-sends a LAUNCH the device never answered, and the cast succeeds (3b)', async () => {
    // Silent on the first LAUNCH and perfectly normal on the second: a set that was
    // asleep, which is the television the founder actually owns. Before this fix the
    // engine sent exactly one LAUNCH and reported an unreachable device.
    receiver.swallowNext('LAUNCH');
    await chooseFileAndDevice();
    engine.dispatch({ type: 'cast.start' });

    await waitFor((snapshot) => snapshot.session.state === 'playing');

    expect(receiver.countOf('LAUNCH')).toBe(2);
    expect(receiver.playerState).toBe('PLAYING');
    // The retry is in the log — where a human diagnosing an evening can find it — and
    // nowhere else.
    expect(loggedEvents()).toContain('session.launch_attempt_failed');
    expect(loggedEvents()).toContain('session.launch_retry_succeeded');
  }, 20_000);

  it('shows the founder one continuous "Connecting…" and never a retry (3b)', async () => {
    receiver.swallowNext('LAUNCH');
    await chooseFileAndDevice();
    const beforeCast = stream.length;
    engine.dispatch({ type: 'cast.start' });
    await waitFor((snapshot) => snapshot.session.state === 'playing');

    // **The whole episode, not the end of it.** The 12b defect on 2026-08-18 flashed three
    // wrong screens and its instrument sampled only where it finished, so it passed.
    const episode = stream
      .slice(beforeCast)
      .map((snapshot) => buildViewModel(snapshot, IDLE_PICKER));

    // Nothing that looks like a count of anything: "attempt 2 of 3" is what 3b forbids in
    // as many words, and a "trying again…" would say the same thing in longer form.
    for (const view of episode) {
      const words = `${view.headline} ${view.sub ?? ''}`;
      expect(words, 'a retry must never reach the founder').not.toMatch(
        /\d\s*of\s*\d|retry|retrying|again/i,
      );
      expect(view.tone, 'nothing about a slow television is an error').not.toBe('error');
    }
    // *Try again* is the failure screen's word (3b). While a cast is merely slow it must
    // never appear: an offer to retry is a retry the founder can see.
    for (const view of episode) {
      expect(view.actions.map((action) => action.label)).not.toContain('Try again');
    }

    // The screens it did show, in order, with no going backwards and no flicker: the
    // whole of the wake-up — both LAUNCHes — sits inside one *Connecting to Fake TV…*.
    const headlines: string[] = [];
    for (const view of episode) {
      if (headlines[headlines.length - 1] !== view.headline) headlines.push(view.headline);
    }
    expect(headlines).toEqual([
      'Connecting to Fake TV…',
      'Starting on Fake TV…',
      'Buffering…',
      'Playing on Fake TV',
    ]);
  }, 20_000);

  it('gives up on a device that never answers, and says so once (3b)', async () => {
    // A television that accepts the socket and answers nothing else — a set that is
    // wedged, or asleep past any patience. The connect succeeds, so this is entirely the
    // launch path's promise to keep.
    receiver.swallow('LAUNCH');
    await chooseFileAndDevice();
    engine.dispatch({ type: 'cast.start' });

    const failed = await waitFor((snapshot) => snapshot.notice !== null);
    const view = buildViewModel(failed, IDLE_PICKER);

    expect(view.headline).toBe("Couldn't reach Fake TV");
    expect(view.actions.map((action) => action.label)).toContain('Try again');
    // 3b's last clause, and the one a locked device list would break: the founder can
    // walk away from a television that will not wake and use another one.
    const bedroom = view.devices.rows.find((row) => row.name === 'Bedroom TV');
    expect(bedroom?.disabled).toBe(false);
    engine.dispatch({ type: 'device.select', deviceId: OTHER_DEVICE_ID });
    expect(engine.snapshot().discovery.selectedDeviceId).toBe(OTHER_DEVICE_ID);

    // Two silent retries, and the count is stated here because it is the promise: three
    // attempts in total, none of which the founder saw.
    expect(receiver.countOf('LAUNCH')).toBe(CAST.launchRetries + 1);
    // The failure is stated once. A second "Couldn't reach" would be the app arguing.
    const complaints = stream.filter((snapshot) => snapshot.notice !== null).length;
    expect(complaints).toBeGreaterThan(0);
    expect(new Set(stream.map((snapshot) => snapshot.notice?.message ?? null)).size).toBe(2);
  }, 20_000);

  it('stops retrying once the founder has waited long enough, rather than for ever', async () => {
    receiver.swallow('LAUNCH');
    await chooseFileAndDevice();
    engine.dispatch({ type: 'cast.start' });
    // The founder's whole wait, spent in one shove: the *next* attempt is the one that
    // must not start. The first always gets its full timeout — a budget that looks spent
    // before the first LAUNCH is a clock fault, not a slow television.
    clock.shift(TIMING.castUnreachableBudgetMs);

    await waitFor((snapshot) => snapshot.notice?.message === "Couldn't reach Fake TV");

    expect(receiver.countOf('LAUNCH')).toBe(1);
    expect(loggedEvents()).toContain('session.launch_budget_spent');
  }, 20_000);

  it('does not resurrect a cast the founder walked away from mid-launch', async () => {
    // The generation guard, on the path the retry loop opened up: the retry sleeps for a
    // whole launch timeout, and a television waking up inside that window must not land on
    // a session that no longer exists.
    receiver.swallow('LAUNCH');
    await chooseFileAndDevice();
    engine.dispatch({ type: 'cast.start' });
    await waitFor((snapshot) => snapshot.session.state === 'connecting');
    engine.dispatch({ type: 'cast.stop' });

    // Let every attempt that was in flight run out.
    await new Promise((resolve) => setTimeout(resolve, LAUNCH_MS * (CAST.launchRetries + 2)));

    expect(engine.snapshot().session.state).not.toBe('playing');
    expect(engine.snapshot().session.state).not.toBe('loading');
    expect(receiver.loadedUrl).toBeNull();
    // Nothing was left running on the television by a retry that lost its session.
    expect(receiver.launched).toBe(false);
  }, 20_000);
});

/**
 * The numbers themselves, pinned to the measurements they came from.
 *
 * These are not arbitrary: every one of them is a hardware observation this milestone
 * recorded, and a future session tempted to "tidy" one of them should have to change this
 * test and read why first.
 */
describe('the launch budget', () => {
  it('leaves real headroom over the worst receiver boot ever measured', () => {
    // Warm boots on the founder's televisions: 6,172 / 6,191 / 6,235 / 6,288 / 7,931 /
    // 7,986 ms. Worst ever observed, on a colder set: 10,590 ms. The old 10,000 ms left
    // ~2 s of headroom on a warm device and none at all on a cold one.
    const worstObservedBootMs = 10_590;
    expect(CAST.launchTimeoutMs).toBeGreaterThanOrEqual(worstObservedBootMs * 1.25);
  });

  it("keeps the worst case inside the founder's 25-30 s ruling", () => {
    // Founder's ruling, 2026-08-18: "keep trying, tell me later" — a cast that succeeds at
    // 20 s beats a failure at 15 s — with ~25-30 s accepted before being told. The worst
    // path is a connect that answers, a full launch that does not, one retry of it, and
    // then a LOAD that also hangs on its floor.
    const worstCaseMs = TIMING.castUnreachableBudgetMs + CAST.loadMinTimeoutMs;
    expect(worstCaseMs).toBeLessThanOrEqual(30_000);
    expect(TIMING.castUnreachableBudgetMs).toBeGreaterThanOrEqual(25_000);
    // …and a retry is only ever started when it could still outlast the *fastest* boot
    // ever measured (6,172 ms). Anything less is a wait that cannot succeed.
    expect(CAST.launchMinAttemptMs).toBeGreaterThanOrEqual(6_172);
  });

  it('still reports a device that is simply switched off inside 15 s (3b)', () => {
    // The classic 3b case never reaches the wall above: a TCP connect to a dead address
    // fails or times out at 4 s, three times over, and is reported at ~13 s.
    const connectPathMs =
      CAST.connectTimeoutMs * (CAST.connectRetries + 1) +
      CAST.connectRetryDelayMs * CAST.connectRetries;
    expect(connectPathMs).toBeLessThanOrEqual(TIMING.castFailureBudgetMs);
  });
});
