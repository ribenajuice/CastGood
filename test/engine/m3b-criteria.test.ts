import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine, type GuardTicker } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink, systemClock, type Clock } from '../../src/engine/logging/index.js';
import type { LogRecord } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { PREPARATION } from '../../src/engine/config.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import { HLS_PUBLISHED_PLAYLIST } from '../../src/engine/media-server/hls.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';
import { audioStream, probeOf, report, videoStream } from './fixtures/ffprobe.js';
import { createFakeSpawn, outputsOf, type FakeChild, type FakeSpawn } from './fixtures/spawn.js';

/**
 * Milestone 3b through the engine's own intents — **watching starts while the conversion is
 * still running, and it never stalls.**
 *
 * What this file is allowed to claim, and it is narrow: given a conversion that reports a
 * frontier and a speed, the engine loads a television **only** after the gate opens (10h),
 * hands it a growing playlist rather than a file, holds the picture when the margin falls
 * and lets go by itself when it recovers (10i), refuses a jump past the frontier (10d), and
 * finishes into one MP4 with no folder of fragments left behind (10g).
 *
 * What it cannot claim: that a real television plays a real growing playlist, that the pause
 * reaches the picture inside five seconds, or that a real conversion sustains 1.5×. Every
 * one of those is `[selftest] headstart` or `[hardware]`, and the ffmpeg here writes no
 * video at all.
 *
 * **The clock is shifted rather than waited on.** The gate's speed is sustained over 60 s by
 * design, and a suite that took a minute per assertion is a suite nobody runs — so the
 * engine is given the same `ShiftingClock` `cast-session.test.ts` uses, and time is pushed.
 */

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

/**
 * The guard's tick, driven by hand.
 *
 * **The guard's 2-second interval is the one piece of M3b that a test cannot honestly wait
 * for.** The sequence that matters most here — a held film escaping and being taken back —
 * is three consecutive ticks, six seconds of wall clock before any scheduling overhead, and
 * under the full suite a contended box slipped past the deadline and turned the test that
 * guards 10b red for a reason that had nothing to do with the guard. A longer timeout would
 * only have made it rarer: a check that passes or fails on machine load teaches everyone to
 * shrug at it, which is the same corrosion as a check that cannot fail.
 *
 * So the engine takes its tick as a seam and this drives it. Nothing about the guard's own
 * logic is faked — `sampleFrontier` runs exactly as it does in the app, reading the same
 * session model and calling the same pure `guardStep`. Only *when* is ours.
 */
interface ManualTicker {
  readonly ticker: GuardTicker;
  /** Run the guard `times` times, letting each one's effects settle before the next. */
  tick(times?: number): Promise<void>;
  /** True while the engine has the guard running — the timer's own lifecycle, observable. */
  readonly running: boolean;
  /**
   * The interval the **engine** asked for, which is the only place the shipping cadence is
   * observable at all.
   *
   * The tick is injected so the sequence can be decided rather than raced — but that seam
   * also means nothing else in the suite reads `frontierSampleMs`, and 10i's *"at least once
   * every 2 s"* and its five-second reaction both rest on it. Recorded here so a slower
   * cadence is a red test rather than a silent change to the one number the guard's promise
   * is made of.
   */
  readonly intervalMs: number | null;
}

function createManualTicker(): ManualTicker {
  let onTick: (() => void) | null = null;
  let asked: number | null = null;
  return {
    ticker: {
      start(intervalMs, tick) {
        asked = intervalMs;
        onTick = tick;
        return () => {
          onTick = null;
        };
      },
    },
    get running() {
      return onTick !== null;
    },
    get intervalMs() {
      return asked;
    },
    async tick(times = 1) {
      for (let count = 0; count < times; count += 1) {
        onTick?.();
        // A tick sends PAUSE or PLAY to a real fake receiver over a real socket, so its
        // effects need a turn of the event loop before the next tick asks what happened.
        await new Promise((resolve) => setTimeout(resolve, 30));
      }
    },
  };
}

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

/** A two-hour film. Long enough that ten minutes of it is a head start and not the whole job. */
const FILM_SEC = 7_200;

/** 4K HEVC with DTS: nothing in the model table plays it, so the picture must be re-encoded. */
const TIER3 = () =>
  report({
    durationSec: FILM_SEC,
    sizeBytes: 8_000_000_000,
    streams: [
      videoStream({
        codec_name: 'hevc',
        profile: 'Main 10',
        width: 3_840,
        height: 2_160,
        coded_width: 3_840,
        coded_height: 2_160,
      }),
      audioStream({ codec_name: 'dts', profile: 'DTS-HD MA' }),
    ],
  });

const PREPARED = () => report({ durationSec: FILM_SEC, sizeBytes: 4_000_000_000 });

let root: string;
let films: string;
let sourcePath: string;
let engine: Engine;
let receiver: FakeReceiver;
let mdns: FakeMdns;
let fake: FakeSpawn;
let clock: ShiftingClock;
let guard: ManualTicker;
let sink: ReturnType<typeof createMemorySink>;

function probes(answers: Record<string, unknown>): FfprobeRunner {
  return (filePath) => {
    const json = answers[path.basename(filePath)];
    return Promise.resolve(
      json === undefined
        ? { ok: false as const, failure: 'unreadable' as const }
        : { ok: true as const, probe: probeOf(json) },
    );
  };
}

async function build(): Promise<void> {
  fake = createFakeSpawn();
  sink = createMemorySink();
  mdns = createFakeMdns();
  clock = createShiftingClock();
  guard = createManualTicker();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: root } }),
    logSink: sink,
    logLevel: 'debug',
    clock,
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
    ffprobe: probes({ 'Cars.mkv': TIER3(), 'Cars (CastGood).mp4': PREPARED() }),
    ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    videoEncoder: 'libx264',
    // A volume with room on it, stated rather than measured. The real check is P1's and
    // it runs in the app; leaving it real here would mean this file passed or failed on
    // how full the machine happened to be — see `PreparationDeps.freeBytes`.
    freeBytes: () => Promise.resolve(4_000_000_000_000),
    spawn: fake.spawn,
    guardTicker: guard.ticker,
  });
  await engine.start();
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
}

function records(): LogRecord[] {
  return sink.lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as LogRecord];
    } catch {
      return [];
    }
  });
}

async function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  what = 'condition',
  timeoutMs = 6_000,
): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Wait for the **device's own** report of where the film is to reach the engine.
 *
 * Moving the fake receiver's playhead is not the same as the engine knowing about it: the
 * position arrives on the next `MEDIA_STATUS`, about a second later, and the guard reads
 * that rather than our instruction. Waiting for it is waiting for a real device fact — which
 * is the thing this suite is allowed to wait for — and it is what makes the tick that
 * follows a decision about a known margin rather than a race with a poll.
 */
async function atPosition(seconds: number): Promise<void> {
  await waitFor(
    (s) => Math.abs(s.session.positionSec - seconds) <= 5,
    `the device to report ${String(seconds)} s`,
  );
}

/** Choose the film, answer the long-job confirmation, and get the conversion running. */
async function startConversion(): Promise<FakeChild> {
  engine.dispatch({ type: 'file.select', path: sourcePath });
  await waitFor((s) => s.file !== null && s.check === null, 'the check');
  expect(engine.snapshot().file?.verdict?.kind).toBe('convert');
  engine.dispatch({ type: 'cast.start' });
  if (engine.snapshot().file?.verdict?.requiresConfirmation === true) {
    await waitFor((s) => s.file?.verdict?.confirmation != null, 'the confirmation');
    engine.dispatch({ type: 'preparation.confirm' });
  }
  return fake.waitForChild(fake.children.length + 1);
}

/**
 * One progress report from the conversion, `seconds` of wall clock after the last.
 *
 * The frontier and the clock move together, which is what makes the sustained speed a real
 * measurement rather than a number handed to the gate.
 */
async function advance(
  child: FakeChild,
  options: { frontierSec: number; wallSec: number },
): Promise<void> {
  clock.shift(options.wallSec * 1000);
  child.progress({ outTimeSec: options.frontierSec, speed: 2 });
  await new Promise((resolve) => setTimeout(resolve, 10));
}

/** Drive the conversion to just past the gate: ten minutes of film in five of wall clock. */
async function openTheGate(child: FakeChild): Promise<void> {
  await advance(child, { frontierSec: 0, wallSec: 0 });
  await advance(child, { frontierSec: 400, wallSec: 200 });
  await advance(child, { frontierSec: 700, wallSec: 150 });
  await waitFor((s) => s.headStart !== null, 'the head start to be serving');
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: FILM_SEC });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-m3b-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
  sourcePath = path.join(films, 'Cars.mkv');
  await fsp.writeFile(sourcePath, Buffer.alloc(4_096, 1));
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('the gate, enforced before the first frame (10h)', () => {
  it('converts to a growing playlist, and tells no television about it yet', async () => {
    await build();
    const child = await startConversion();
    // The working set from the ADR, and every flag in it is a measurement.
    expect(child.args).toContain('-hls_time');
    expect(child.args).toContain('-hls_list_size');
    expect(child.args[child.args.indexOf('-hls_list_size') + 1]).toBe('0');
    expect(child.args).toContain('-hls_playlist_type');
    expect(child.args[child.args.indexOf('-hls_playlist_type') + 1]).toBe('event');
    // Forced keyframes, because this job re-encodes the picture and can choose where they go.
    expect(child.args).toContain('-force_key_frames');
    expect(outputsOf(child).at(0)).toMatch(/index\.m3u8$/);

    // Nine minutes prepared at 2×: **both halves are required, and this is only one.**
    await advance(child, { frontierSec: 0, wallSec: 0 });
    await advance(child, { frontierSec: 540, wallSec: 270 });
    expect(engine.snapshot().headStart).toBeNull();
    expect(engine.snapshot().session.state).toBe('idle');
  });

  it('refuses to open on a speed that has not been sustained for a minute', async () => {
    await build();
    const child = await startConversion();
    // Twenty minutes of film in twenty seconds of wall clock — a burst, and exactly the
    // kind of reading that over-states this machine by about a third.
    await advance(child, { frontierSec: 0, wallSec: 0 });
    await advance(child, { frontierSec: 1_200, wallSec: 20 });
    expect(engine.snapshot().headStart).toBeNull();
    const gate = records().filter((record) => record['event'] === 'prepare.head_start_gate_open');
    expect(gate).toHaveLength(0);
  });

  it('opens on both halves, and says both numbers as it loads', async () => {
    await build();
    const child = await startConversion();
    await openTheGate(child);

    const opened = records().find((r) => r['event'] === 'prepare.head_start_gate_open');
    // **10h fails if either number is absent.** They are on the record that decided it…
    expect(opened?.['preparedSec']).toBe(700);
    expect(opened?.['sustainedSpeed']).toBeCloseTo(2, 1);
    // …and again on the record of the load itself, measured at that moment.
    const serving = records().find((r) => r['event'] === 'cast.head_start_serving');
    expect(serving?.['preparedSec']).toBe(700);
    expect(serving?.['sustainedSpeed']).toBeCloseTo(2, 1);
    expect(serving?.['durationSec']).toBe(FILM_SEC);
  });

  it('hands the television a playlist, not a file, and our own duration with it (10c)', async () => {
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    const loading = records().find((record) => record['event'] === 'session.loading');
    expect(String(loading?.['url'])).toContain(`/${HLS_PUBLISHED_PLAYLIST}`);
    // The device reports `duration: -1` for the whole session on both device classes, so a
    // scrubber with a length is a scrubber CastGood gave a length to.
    expect(engine.snapshot().session.durationSec).toBe(FILM_SEC);
    expect(engine.snapshot().session.canSeek).toBe(true);
  });

  it('keeps its own length even when the television insists the film is −1 (10c)', async () => {
    // **Why this needs its own receiver.** The default fake answers with the film's real
    // length, so the assertion above cannot tell a duration that came from our probe from
    // one that came from the device: both are 7200. Every television in the house reports
    // `duration: -1` for a whole session on a growing playlist — three device classes — and
    // a scrubber that believed it would have no length, no percentage and no seekable range.
    await receiver.close();
    receiver = await startFakeReceiver({ durationSec: FILM_SEC, reportsDurationSec: -1 });
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    expect(engine.snapshot().session.durationSec).toBe(FILM_SEC);
    expect(engine.snapshot().session.canSeek).toBe(true);
    // The scrubber's own arithmetic depends on it: everything past the frontier is drawn
    // against this number, and a −1 would put the whole film past the end of the track.
    expect(engine.snapshot().headStart?.frontierSec).toBe(700);
  });

  it('says roughly when watching will start, before it starts (10a)', async () => {
    await build();
    const child = await startConversion();
    await advance(child, { frontierSec: 0, wallSec: 0 });
    await advance(child, { frontierSec: 300, wallSec: 150 });
    // 300 s of the 600 s head start still to prepare, at 2×.
    const watchable = engine.snapshot().preparation.watchableInSeconds;
    expect(watchable).not.toBeNull();
    expect(watchable ?? 0).toBeCloseTo(150, 0);
  });
});

describe('the live margin guard (10i, 10f)', () => {
  it('holds the picture, says how long, and lets go by itself', async () => {
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    // The conversion falls behind: the frontier barely moves while the film plays on. The
    // margin is 705 − 650 = 55 s, well under the two minutes the guard defends.
    await advance(child, { frontierSec: 705, wallSec: 60 });
    receiver.setPositionSec(650);

    // **One tick, and the guard has to decide on it.** No wall clock is waited for: this is
    // the same `sampleFrontier` the app runs every two seconds, run once, deliberately.
    await atPosition(650);
    await guard.tick();
    const held = await waitFor((s) => s.headStart?.hold != null, 'the guard to hold');

    // The founder's own words, and **never the word Buffering**: 11e would turn a Buffering
    // over ten seconds into a reconnection and tear down a healthy connection.
    expect(held.headStart?.hold?.message).toMatch(/^Still preparing/);
    expect(held.headStart?.hold?.message).not.toMatch(/buffer/i);
    // *Stop* stays live throughout — the way out is M2's two presses, not a new control.
    expect(held.session.state === 'paused' || held.session.state === 'playing').toBe(true);

    // A tick with the margin still short changes nothing: the guard is not a metronome, and
    // a second hold here would be a founder watching the picture flicker.
    await guard.tick();
    expect(records().filter((record) => record['event'] === 'headstart.guard_hold')).toHaveLength(
      1,
    );

    // The conversion catches up past the release margin, and nothing is pressed.
    await advance(child, { frontierSec: 900, wallSec: 40 });
    await guard.tick();
    const released = await waitFor((s) => s.headStart?.hold == null, 'the guard to let go');
    expect(released.headStart?.hold).toBeNull();

    const holds = records().filter((record) => record['event'] === 'headstart.guard_hold');
    const releases = records().filter((record) => record['event'] === 'headstart.guard_release');
    // Exact, and it is exact because the ticks are counted rather than waited for: one hold
    // and one release out of three samples of the guard.
    expect(holds).toHaveLength(1);
    expect(releases).toHaveLength(1);
    // Hysteresis: it held under 120 s of margin and let go at or above 180 s.
    expect(Number(holds[0]?.['marginSec'])).toBeLessThan(PREPARATION.frontierMarginSeconds);
    expect(Number(releases[0]?.['marginSec'])).toBeGreaterThanOrEqual(
      PREPARATION.frontierReleaseMarginSeconds,
    );
  });

  it('takes the picture back when something else starts the film playing again', async () => {
    // A phone, or the Google Home app, sends `PLAY` straight to the television — the whole
    // reason *Take it back* exists. Our own Play button is disabled during a hold, so the UI
    // is no defence at all here, and until 2026-08-21 the guard stayed pinned at "holding"
    // while the picture played on into the unconverted region.
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    await advance(child, { frontierSec: 705, wallSec: 60 });
    receiver.setPositionSec(650);
    await atPosition(650);

    // Tick 1 — the hold.
    await guard.tick();
    await waitFor((s) => s.headStart?.hold != null, 'the guard to hold');
    expect(records().filter((record) => record['event'] === 'headstart.guard_hold')).toHaveLength(
      1,
    );

    // Somebody presses Play somewhere else in the house. The television is playing again and
    // the margin has not recovered: 705 − 650 is still 55 s.
    receiver.remoteSet('PLAYING');
    await waitFor((s) => s.session.state === 'playing', 'the film to escape the hold');

    // Tick 2 — and this is the assertion the whole seam exists for. Before the fix this tick
    // produced nothing at all: `held` stayed true, the picture played on, and no further hold
    // could ever fire for the rest of the film.
    await guard.tick();
    const holds = records().filter((record) => record['event'] === 'headstart.guard_hold');
    expect(holds).toHaveLength(2);
    // Named in the log as what it is, so a run full of these reads as a television being
    // driven from elsewhere rather than as a guard that cannot make its mind up.
    expect(holds[1]?.['reasserted']).toBe(true);
    // And it is a hold rather than a release: no `guard_release` came between the two.
    expect(records().filter((record) => record['event'] === 'headstart.guard_release')).toEqual([]);
    await waitFor((s) => s.headStart?.hold != null, 'the picture to be held again');
  });

  it('really starts the television again on release — not just our own state (10i)', async () => {
    // **The gap this closes.** Every existing check on the release reads the *snapshot*:
    // `headStart.hold` becomes null and the guard's own books say it let go. Delete the
    // `session.play()` in the engine's release branch and all 722 tests still pass — the
    // film stays paused on the television for ever, under a sentence that says it is coming
    // back. That is our guard's opinion of the picture, which is the one thing 10b and 10j
    // both say never to grade a stall on. So this reads the **device**: the PLAY on the
    // wire, the receiver's own player state, and the frame it starts from.
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    await advance(child, { frontierSec: 705, wallSec: 60 });
    receiver.setPositionSec(650);
    await atPosition(650);
    await guard.tick();
    await waitFor((s) => s.headStart?.hold != null, 'the guard to hold');
    // The pause reached the television, which is what makes the rest of this a real resume.
    await waitFor(() => receiver.playerState === 'PAUSED', 'the television to be paused');
    const playsBefore = receiver.countOf('PLAY');

    // The conversion catches up past the release margin. Nothing is pressed.
    await advance(child, { frontierSec: 900, wallSec: 40 });
    await guard.tick();
    await waitFor((s) => s.headStart?.hold == null, 'the guard to let go');

    // 10i: *"it resumes by itself, at the frame it held, with nothing pressed and no error"*.
    await waitFor(
      () => receiver.playerState === 'PLAYING',
      'the television to be playing again',
      3_000,
    );
    expect(receiver.countOf('PLAY')).toBe(playsBefore + 1);
    // At the frame it held: a resume is never a seek, so the device's own position is still
    // where the guard took it, give or take the moment it has been playing again.
    expect(Math.abs(engine.snapshot().session.positionSec - 650)).toBeLessThan(5);
    // …and no error shown: the release is silent, which is the rest of that sentence.
    expect(engine.snapshot().notice).toBeNull();
  });

  it('asks for the cadence 10i names, rather than whatever the seam is given', async () => {
    // The tick is injected so the sequence can be decided rather than raced, and that seam
    // is right — but it means **nothing else in the suite reads the shipping interval**.
    // `frontierSampleMs` can be changed from 2 s to a minute and all 722 tests stay green,
    // while the guard's five-second reaction (10i) quietly becomes a minute. The number the
    // promise is made of is asserted here, at the one place the engine states it.
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    expect(guard.running).toBe(true);
    expect(guard.intervalMs).toBe(PREPARATION.frontierSampleMs);
    // 10i: *"at least once every 2 s for the whole session"* — the floor, not a taste.
    expect(guard.intervalMs ?? Infinity).toBeLessThanOrEqual(2_000);
  });

  it('stops sampling once the television has been let go', async () => {
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');
    expect(guard.running).toBe(true);

    engine.dispatch({ type: 'cast.stop' });
    await waitFor(
      (s) => s.session.state === 'stopped' || s.session.state === 'idle',
      'the television to be released',
    );
    // A guard still ticking against a session that is over would be pausing a television
    // somebody else may be using by now.
    await guard.tick();
    expect(guard.running).toBe(false);
    expect(records().filter((record) => record['event'] === 'headstart.guard_hold')).toEqual([]);
  });
});

describe('the unprepared part of the film (10d)', () => {
  it('publishes how far ahead a jump may go, and clamps one that goes further', async () => {
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    const snapshot = engine.snapshot();
    expect(snapshot.headStart?.frontierSec).toBe(700);
    expect(snapshot.headStart?.seekLimitSec).toBe(700 - PREPARATION.frontierMarginSeconds);

    // A drag into video that does not exist yet: refused with a landing place, not an error.
    // The guard re-states the frontier on every sample: a cast resets the session model, so
    // the clamp is in place from the first sample after the picture. One tick, not a sleep.
    await waitFor((s) => s.session.state === 'playing', 'the film');
    await guard.tick();
    engine.dispatch({ type: 'playback.seek', positionSec: 3_000 });
    const seeking = await waitFor((s) => s.session.seek !== null, 'the seek');
    expect(seeking.session.seek?.clamped).toBe('frontier');
    expect(seeking.session.seek?.targetSec).toBe(580);
  });
});

describe('finishing the job (10g)', () => {
  it('leaves one file beside the source and no folder of fragments', async () => {
    await build();
    const child = await startConversion();
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    // ffmpeg finishes: ENDLIST is written and the conversion is over.
    child.progress({ outTimeSec: FILM_SEC, speed: 2, end: true });
    child.exit(0);

    // The finishing remux is a **second** invocation, reading the playlist, copying streams.
    const finish = await fake.waitForChild(fake.children.length + 1);
    expect(finish.args).toContain('-protocol_whitelist');
    expect(finish.args[finish.args.indexOf('-i') + 1]).toMatch(/index\.m3u8$/);
    expect(finish.args).toContain('+faststart');
    await fsp.writeFile(outputsOf(finish)[0] ?? '', Buffer.alloc(2_048, 7));
    finish.exit(0);

    await waitFor((s) => !s.preparation.active, 'the job to finish');
    expect((await fsp.readdir(films)).sort()).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);

    // **The film in progress is not disturbed**: it is still playing from the segments, and
    // the segments are therefore still there.
    expect(engine.snapshot().session.state).toBe('playing');
    expect(engine.snapshot().headStart?.conversionComplete).toBe(true);
    const segments = path.join(root, 'prepared', 'headstart');
    expect(
      await fsp.stat(segments).then(
        () => true,
        () => false,
      ),
    ).toBe(true);

    // …until the television is let go, which is when the founder stops seeing a segment.
    engine.dispatch({ type: 'cast.stop' });
    const deadline = Date.now() + 3_000;
    let gone = false;
    while (Date.now() < deadline && !gone) {
      gone = await fsp.stat(segments).then(
        () => false,
        () => true,
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(gone).toBe(true);
    expect((await fsp.readdir(films)).sort()).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);
  });

  it('a film shorter than the head start casts when the conversion completes', async () => {
    // Without this clause the gate never opens and a short conversion hangs forever. The
    // ending is M3a's exactly: the finished MP4, fully seekable, no HLS involved at all.
    await build();
    engine.dispatch({ type: 'file.select', path: sourcePath });
    await waitFor((s) => s.file !== null && s.check === null, 'the check');
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.file?.verdict?.confirmation != null, 'the confirmation');
    engine.dispatch({ type: 'preparation.confirm' });
    const child = await fake.waitForChild(fake.children.length + 1);

    // Eight minutes of film, converted quickly, and the gate never opens: there will never
    // be ten minutes of it.
    await advance(child, { frontierSec: 480, wallSec: 120 });
    expect(engine.snapshot().headStart).toBeNull();
    child.progress({ outTimeSec: 480, speed: 4, end: true });
    child.exit(0);
    const finish = await fake.waitForChild(fake.children.length + 1);
    await fsp.writeFile(outputsOf(finish)[0] ?? '', Buffer.alloc(2_048, 7));
    finish.exit(0);

    await waitFor((s) => s.session.state === 'playing', 'the film to play at last', 8_000);
    const loading = records()
      .filter((record) => record['event'] === 'session.loading')
      .at(-1);
    // The MP4, not a playlist.
    expect(String(loading?.['url'])).toContain('Cars%20(CastGood).mp4');
    const segments = path.join(root, 'prepared', 'headstart');
    expect(
      await fsp.stat(segments).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});
