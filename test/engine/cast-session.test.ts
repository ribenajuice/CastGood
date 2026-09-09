import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink, systemClock, type Clock } from '../../src/engine/logging/index.js';
import { TIMING } from '../../src/engine/config.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';
import { ffprobeYielding, report } from './fixtures/ffprobe.js';

/**
 * The walking skeleton, end to end, with no television.
 *
 * This drives the **whole engine through its intents** — the same entry points the app
 * and the selftest use — against a scripted receiver speaking real CASTV2 over a real
 * socket, with the real media server serving a real file. What it proves is that the
 * logic is right. What it can never prove is that a Chromecast behaves like this; that
 * is what the selftest and the founder's eyes are for.
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

/** A 90-second WebM: Segment → Info → TimecodeScale + Duration. */
function fixtureWebm(): Buffer {
  const size = (length: number): Buffer => {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(0x10000000 | length, 0);
    return buffer;
  };
  const element = (id: number[], content: Buffer): Buffer =>
    Buffer.concat([Buffer.from(id), size(content.length), content]);

  const ticks = Buffer.alloc(8);
  ticks.writeDoubleBE(90_000);
  const info = element(
    [0x15, 0x49, 0xa9, 0x66],
    Buffer.concat([
      element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])), // 1_000_000 ns
      element([0x44, 0x89], ticks),
    ]),
  );
  return element([0x18, 0x53, 0x80, 0x67], info);
}

/**
 * The real clock, with a shove the test can give it.
 *
 * Two of M2's recovery promises are *deadlines* — 30 s of reconnecting before the founder
 * hears "Lost connection" (11c), and 15 s of holding an orderly close before it is called
 * a stop from the TV (SPIKE-2's takeover ordering). Waiting them out in real time would put
 * three quarters of a minute of sleeping into the suite for two assertions, and a suite
 * people skip protects nothing.
 *
 * So the engine gets a monotonic clock this file can push forward, and everything else —
 * sockets, the media server, the receiver, every real timer — runs at real speed. The
 * deadline logic under test is the shipping logic, unchanged: the only thing faked is how
 * long the outage *felt*.
 */
interface ShiftingClock extends Clock {
  /** Make the engine believe this many more milliseconds of outage have passed. */
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
let engine: Engine;
let clock: ShiftingClock;
let mdns: FakeMdns;
let directory: string;
let filePath: string;
let sink: ReturnType<typeof createMemorySink>;

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

const waitForState = (state: SessionState, timeoutMs = 10_000): Promise<StateSnapshot> =>
  waitFor((snapshot) => snapshot.session.state === state, timeoutMs);

/**
 * Polls a condition about the *receiver*, which changes without the engine pushing a
 * snapshot — and after Stop the engine stops pushing altogether.
 */
function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('timed out waiting for the receiver'));
      }
    }, 10);
  });
}

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

/** Every event name the engine has logged so far, in order. */
function loggedEvents(): string[] {
  return sink.lines
    .map((line) => (JSON.parse(line) as Record<string, unknown>)['event'])
    .filter((event): event is string => typeof event === 'string');
}

async function castAndPlay(): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filePath });
  await waitFor((snapshot) => snapshot.file !== null);
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitForState('playing');
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: 90 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-session-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());

  mdns = createFakeMdns();
  sink = createMemorySink();
  clock = createShiftingClock();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    clock,
    logSink: sink,
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
    // Stated, never resolved: see `ffprobeYielding`. The fixture on disk is 90 s of H.264
    // and AAC in an MP4, and this is what ffprobe says about it.
    ffprobe: ffprobeYielding(report({ durationSec: 90 })),
  });
  await engine.start();
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('discovery through the engine', () => {
  it('lists the device by its friendly name and preselects it', () => {
    const snapshot = engine.snapshot();
    expect(snapshot.discovery.phase).toBe('found');
    expect(snapshot.discovery.devices[0]?.friendlyName).toBe('Fake TV');
    expect(snapshot.discovery.selectedDeviceId).toBe(receiver.device.id);
  });
});

describe('choosing a file', () => {
  it('shows the name and duration and sends nothing to any device (2a)', async () => {
    engine.dispatch({ type: 'file.select', path: filePath });
    const snapshot = await waitFor((current) => current.file !== null);

    expect(snapshot.file?.name).toBe('Bluey - The Sign.mp4');
    expect(snapshot.file?.durationSec).toBeCloseTo(90, 3);
    expect(snapshot.file?.verdict?.headline).toBe('Ready to cast');
    expect(snapshot.file?.verdict?.kind).toBe('ready');
    expect(snapshot.session.state).toBe('idle');
    expect(receiver.received).toHaveLength(0);
  });

  it('keeps the previous selection when a file cannot be read (2b)', async () => {
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((current) => current.file !== null);

    engine.dispatch({ type: 'file.select', path: path.join(directory, 'gone.mp4') });
    const snapshot = await waitFor((current) => current.notice !== null);
    expect(snapshot.file?.name).toBe('Bluey - The Sign.mp4');
    expect(snapshot.notice?.message).toBe('That file is no longer where it was.');
  });
});

describe('casting', () => {
  it('reaches Playing, and the URL it handed the device really serves the file (3a)', async () => {
    await castAndPlay();

    expect(receiver.launched).toBe(true);
    expect(receiver.playerState).toBe('PLAYING');
    expect(receiver.loadedUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]{32}\/Bluey/);

    // The receiver would fetch this itself; here the test does, which proves the URL,
    // the token, the port and the range server all agree.
    const response = await fetch(receiver.loadedUrl as string, { headers: { Range: 'bytes=-16' } });
    expect(response.status).toBe(206);
    expect((await response.arrayBuffer()).byteLength).toBe(16);

    expect(engine.snapshot().session.durationSec).toBeCloseTo(90, 3);
  }, 20_000);

  it('passes through connecting → loading → buffering → playing in order', async () => {
    const states: SessionState[] = [];
    const unsubscribe = engine.subscribe((snapshot) => {
      const last = states[states.length - 1];
      if (snapshot.session.state !== last) states.push(snapshot.session.state);
    });
    await castAndPlay();
    unsubscribe();
    expect(states).toEqual(['idle', 'connecting', 'loading', 'buffering', 'playing']);
  }, 20_000);

  it('says "Couldn\'t play this file" and releases the device when the load is refused (3c)', async () => {
    receiver.rejectNextLoad();
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });

    const snapshot = await waitFor(
      (current) => current.notice?.message === "Couldn't play this file",
    );
    expect(snapshot.session.state).toBe('idle');
    expect(snapshot.file?.name).toBe('Bluey - The Sign.mp4');
    expect(snapshot.discovery.selectedDeviceId).toBe(receiver.device.id);
  }, 20_000);

  it('reports an unreachable device after two silent retries, well inside 15 s (3b)', async () => {
    const port = await freePort();
    mdns.up({
      id: 'dead-tv',
      friendlyName: 'Bedroom TV',
      model: 'Chromecast',
      address: '127.0.0.1',
      port,
    });
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: 'dead-tv' });

    const startedAt = Date.now();
    engine.dispatch({ type: 'cast.start' });
    const snapshot = await waitFor(
      (current) => current.notice?.message === "Couldn't reach Bedroom TV",
      15_000,
    );

    expect(Date.now() - startedAt).toBeLessThan(15_000);
    expect(snapshot.notice?.actionLabel).toBe('Try again');
    // Every other device stays selectable.
    expect(snapshot.discovery.devices.map((device) => device.friendlyName)).toContain('Fake TV');

    const attempts = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['event'] === 'session.connect_attempt_failed');
    expect(attempts).toHaveLength(3); // the first try plus two silent retries
  }, 20_000);
});

describe('what the receiver is told about the file', () => {
  it('announces the content type the media server will actually serve', async () => {
    await castAndPlay();
    const load = receiver.received.find((message) => message.type === 'LOAD');
    const media = load?.payload['media'] as { contentType?: string } | undefined;
    expect(media?.contentType).toBe('video/mp4');
  }, 20_000);

  it('announces video/webm for a WebM, rather than calling everything mp4', async () => {
    // The receiver trusts the LOAD metadata over the response header, so hardcoding
    // `video/mp4` earned a spurious "Couldn't play this file" for a natively supported
    // WebM — a file type the picker offers and the duration probe understands.
    const webm = path.join(directory, 'clip.webm');
    await fs.writeFile(webm, fixtureWebm());

    engine.dispatch({ type: 'file.select', path: webm });
    await waitFor((snapshot) => snapshot.file?.name === 'clip.webm');
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });
    await waitForState('playing');

    const load = receiver.received.find((message) => message.type === 'LOAD');
    const media = load?.payload['media'] as { contentType?: string } | undefined;
    expect(media?.contentType).toBe('video/webm');

    // And the server answers the URL it handed over with the same type.
    const response = await fetch(receiver.loadedUrl as string, { method: 'HEAD' });
    expect(response.headers.get('content-type')).toBe('video/webm');
  }, 20_000);
});

describe('transport controls', () => {
  it('pauses and resumes, following what the device confirms (4a)', async () => {
    await castAndPlay();

    engine.dispatch({ type: 'playback.pause' });
    await waitForState('paused');
    await waitUntil(() => receiver.playerState === 'PAUSED');

    const frozen = engine.snapshot().session.positionSec;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(engine.snapshot().session.positionSec).toBeCloseTo(frozen, 2);

    engine.dispatch({ type: 'playback.play' });
    await waitForState('playing');
    await waitUntil(() => receiver.playerState === 'PLAYING');
  }, 20_000);

  it('reverts an optimistic Paused and retries once when the device swallows the command (4d)', async () => {
    await castAndPlay();
    receiver.swallow('PAUSE');

    engine.dispatch({ type: 'playback.pause' });
    // Optimistic paint is immediate…
    expect(engine.snapshot().session.state).toBe('paused');

    // …and expires into device truth, having sent the command a second time.
    await waitFor((snapshot) => snapshot.session.state === 'playing', 8_000);
    await waitUntil(() => receiver.countOf('PAUSE') === 2, 5_000);
    expect(receiver.playerState).toBe('PLAYING');

    const events = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((record) => record['event']);
    expect(events).toContain('session.command_retried');
  }, 20_000);

  it('shows a state the device changed on its own within 2 seconds (4c)', async () => {
    await castAndPlay();

    const changedAt = Date.now();
    receiver.remoteSet('PAUSED'); // as if someone used the TV remote
    await waitForState('paused', 5_000);
    expect(Date.now() - changedAt).toBeLessThan(2_000);
  }, 20_000);

  it('stops, keeps the file selected, releases the device, and casts again in one click (4b, 2c)', async () => {
    await castAndPlay();

    engine.dispatch({ type: 'cast.stop' });
    const stopped = await waitForState('stopped');
    expect(stopped.file?.name).toBe('Bluey - The Sign.mp4');

    // Cast again *immediately*. This test used to wait for the receiver to report itself
    // released first, which hid the takeover race entirely: a founder presses the button
    // when the screen says Stopped, not when the previous session has finished tidying up.
    engine.dispatch({ type: 'cast.start' });
    await waitForState('playing');
    expect(receiver.launched).toBe(true);

    // The device really was released and re-launched, rather than the old session being
    // reused: two LAUNCHes, and a STOP between them.
    expect(receiver.countOf('LAUNCH')).toBe(2);
    expect(receiver.countOf('STOP')).toBeGreaterThan(0);
  }, 30_000);

  it('saves where the device stopped, not where we had extrapolated to (4b)', async () => {
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // The founder's TV took 386–843 ms to report the app gone. Every millisecond of that
    // used to be extrapolated onto the saved position, which is how a 843 ms release
    // produced a 1.003 s error against a 1 s target.
    receiver.setReleaseDelayMs(800);
    const linesBefore = sink.lines.length;
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');

    // Read the *settled* value, which is what the founder is left looking at: the release
    // is where the old code did its damage, freezing the readout at whatever it had
    // extrapolated to by the time the device finally reported the app gone.
    await waitUntil(
      () =>
        sink.lines
          .slice(linesBefore)
          .some(
            (line) => (JSON.parse(line) as Record<string, unknown>)['event'] === 'media.unmounted',
          ),
      5_000,
    );

    const finalSample = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (record) =>
          record['event'] === 'position.sample' &&
          record['playerState'] === 'IDLE' &&
          typeof record['deviceSec'] === 'number',
      )
      .at(-1);

    // The device reported where it stopped, and that is what the founder is shown.
    expect(finalSample, 'the device reported a final position').toBeDefined();
    const deviceFinalSec = Number(finalSample?.['deviceSec']);
    expect(engine.snapshot().session.positionSec).toBeCloseTo(deviceFinalSec, 2);
  }, 30_000);

  it('does not believe a device that answers a stop with currentTime 0', async () => {
    await castAndPlay();
    // Far enough in that a reported 0 cannot be an honest rounding of where we are — the
    // founder's own case was 402.678 s. **Waited for, not slept for**: a fixed sleep asserts
    // that a loaded machine kept up, which is not what this test is about.
    await waitFor(
      (snapshot) => snapshot.session.positionSec > TIMING.finalPositionToleranceSec + 1,
      20_000,
    );

    // Exactly what the founder's TV does: stopped at 402.678 s, reports 0. Anchoring on
    // that put 0:00:00 on the Stopped screen of a film they had been watching for minutes.
    receiver.setIdleReportsZero(true);
    // Read the readout from a **fresh** snapshot, not the cached one. The engine pushes at
    // 4 Hz, so `engine.snapshot()` can be a quarter of a second old, and comparing a stale
    // number against a freshly frozen one made this assertion pass or fail on where in the
    // tick cycle it happened to land — up to 0.25 s of pure tick phase against a 0.05 s
    // tolerance. What the test exists to catch is a rewind to 0:00:00, not that.
    const playingAt = (await waitFor(() => true)).session.positionSec;
    expect(playingAt).toBeGreaterThan(TIMING.finalPositionToleranceSec);

    const linesBefore = sink.lines.length;
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    await waitUntil(
      () =>
        sink.lines
          .slice(linesBefore)
          .some(
            (line) => (JSON.parse(line) as Record<string, unknown>)['event'] === 'media.unmounted',
          ),
      5_000,
    );

    // The device's 0 was not believed: the founder is still looking at the place the film
    // reached. The readout may lead the device by up to PRD 4b's 1 s and no further, and it
    // may never go backwards — the defect this test exists for was 402.678 s becoming
    // 0:00:00.
    const saved = engine.snapshot().session.positionSec;
    expect(saved).toBeGreaterThanOrEqual(playingAt);
    expect(saved - playingAt).toBeLessThan(1);
    // And it says so, rather than quietly discarding what the device claimed.
    const idle = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['event'] === 'position.sample' && record['playerState'] === 'IDLE');
    expect(idle).toMatchObject({ deviceSec: 0, rejectedDeviceSec: true, acceptedSec: null });
  }, 30_000);

  it('believes a device that reports 0 for a file genuinely stopped at the start', async () => {
    // The rule must not become "never believe 0": a founder who stops two seconds in has a
    // saved position of about zero, and that is the truth rather than a device resetting.
    receiver.setIdleReportsZero(true);
    await castAndPlay();

    const linesBefore = sink.lines.length;
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    await waitUntil(
      () =>
        sink.lines
          .slice(linesBefore)
          .some(
            (line) => (JSON.parse(line) as Record<string, unknown>)['event'] === 'media.unmounted',
          ),
      5_000,
    );

    expect(engine.snapshot().session.positionSec).toBeLessThan(1);
    const idle = sink.lines
      .slice(linesBefore)
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['event'] === 'position.sample' && record['playerState'] === 'IDLE');
    expect(idle).toMatchObject({ rejectedDeviceSec: false, acceptedSec: 0 });
  }, 30_000);

  it('does not report a stop timeout for a stop that answered promptly', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    await waitUntil(() => !receiver.launched, 5_000);

    // The bound on waiting for a STOP acknowledgement must not outlive the stop itself.
    // On real hardware the stop completed in 243 ms and the abandoned timer still logged
    // `session.stop_timed_out {afterMs: 2000}` two seconds later, on every stop.
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    const events = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .map((record) => record['event']);
    expect(events).not.toContain('session.stop_timed_out');
  }, 30_000);

  it('freezes the position readout once the session has stopped', async () => {
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));

    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    // Settle first: the device's own final position lands a moment after the stop and is
    // allowed to correct the readout. What must not happen is it moving after that.
    await waitUntil(() => !receiver.launched, 5_000);
    const atStop = engine.snapshot().session.positionSec;
    expect(atStop).toBeGreaterThan(0);

    // Nothing is playing, so the number the founder is looking at must not creep upwards.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(engine.snapshot().session.positionSec).toBeCloseTo(atStop, 3);
  }, 30_000);

  it('reaches the end at the end of the file, not at 0:00:00', async () => {
    await castAndPlay();
    const duration = engine.snapshot().session.durationSec;
    expect(duration).toBeGreaterThan(0);

    receiver.finish();
    const snapshot = await waitForState('ended', 5_000);

    // The device reports end-of-media as IDLE/FINISHED with **no** `currentTime` at all.
    // Anchoring the readout on that used to drag it to zero and freeze it there, so a
    // founder who watched a whole film was told their place was saved at 0:00:00.
    expect(snapshot.session.positionSec).toBeCloseTo(duration, 1);

    // And the TV goes back to its own home screen rather than sitting on the Cast
    // backdrop. (The state lands synchronously; the STOP is on its way behind it.)
    await waitUntil(() => !receiver.launched, 5_000);
  }, 20_000);

  it('keeps the duration the device reported once, without it on every status', async () => {
    await castAndPlay();
    // A real receiver puts `media` on the LOAD response and leaves it off the unsolicited
    // updates that follow, so a sender that does not cache it loses the total duration.
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(engine.snapshot().session.durationSec).toBeCloseTo(90, 3);
  }, 20_000);

  it('keeps the film and reconnects when the socket dies, rather than ending the session (11a)', async () => {
    // M1 ended the session here and said "Lost connection to Fake TV". Story 11 replaces
    // that outright: SPIKE-2 measured a real television carrying on playing through a
    // 15-second outage and a new connection rejoining the same media session in 126 ms
    // with a position error of 0.003 s. So a dead socket is a status line, not an ending.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;
    expect(playingAt).toBeGreaterThan(0);

    // Watch every frame of it: the promise is about what the founder never sees.
    const seen: StateSnapshot[] = [];
    const unsubscribe = engine.subscribe((snapshot) => seen.push(snapshot));
    receiver.dropConnections();

    await waitUntil(() => loggedEvents().includes('session.recovery_rejoined'), 20_000);
    unsubscribe();

    // 11a, in the criterion's own words: "nothing turns red, nothing shakes, no dialog
    // opens, and the file, position and scrubber all stay exactly where they were — only
    // the status line changes".
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((snapshot) => snapshot.session.flags.reconnecting)).toBe(true);
    expect(seen.every((snapshot) => snapshot.notice === null)).toBe(true);
    expect(seen.every((snapshot) => snapshot.file?.name === 'Bluey - The Sign.mp4')).toBe(true);
    expect(seen.every((snapshot) => snapshot.session.state === 'playing')).toBe(true);

    // And it is over without a press: back on a live connection, still playing, and the
    // film is further on than where it dropped — it never went back to the beginning.
    const settled = await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 20_000);
    expect(settled.session.state).toBe('playing');
    expect(settled.notice).toBeNull();
    expect(engine.snapshot().session.positionSec).toBeGreaterThanOrEqual(playingAt);
  }, 40_000);

  it('says the connection is lost — once — when the television never comes back (11c)', async () => {
    // The other half of the M1 test this replaces, and the half that must not be lost:
    // "without pretending to recover". Optimism has a deadline. When recovery genuinely
    // cannot happen, the founder is told so in plain words with the place saved, rather
    // than left on a spinner that spins forever.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;
    expect(playingAt).toBeGreaterThan(0);

    // The television is gone for good — not a blip: the port stops answering entirely, so
    // every reconnection attempt is refused.
    await receiver.close();
    const reconnecting = await waitFor((snapshot) => snapshot.session.flags.reconnecting, 10_000);
    expect(reconnecting.session.state).toBe('playing');
    expect(reconnecting.notice).toBeNull();

    // Five seconds short of the budget the founder is still told nothing (11c: "before
    // 30 s the founder is told nothing beyond Reconnecting").
    clock.shift(TIMING.reconnectBudgetMs - 5_000);
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(engine.snapshot().notice).toBeNull();
    expect(engine.snapshot().session.flags.reconnecting).toBe(true);

    clock.shift(6_000);
    const lost = await waitFor((snapshot) => snapshot.notice !== null, 10_000);
    expect(lost.notice?.kind).toBe('lost-connection');
    expect(lost.notice?.actionLabel).toBe('Reconnect');
    expect(lost.session.state).toBe('stopped');
    expect(lost.session.flags.reconnecting).toBe(false);
    // Stated as a number, and it is the place the film really reached: the last position
    // the *device* reported, not the readout that kept extrapolating through the outage.
    expect(Math.abs(lost.session.resumePositionSec - playingAt)).toBeLessThan(1.5);
    // Logged as what it was. (Queued behind the release, hence the wait rather than an
    // immediate read.)
    await waitUntil(() => loggedEvents().includes('session.connection_lost'), 5_000);
    expect(loggedEvents()).not.toContain('session.ended_by_device');
  }, 40_000);

  it('says Stopped the moment the television closes the session, and keeps the place (ruling of 2026-08-18)', async () => {
    // SPIKE-2 finding 1, on the founder's own hardware: a takeover sends `CLOSE` on the
    // connection namespace **first** and names the app that took the television only
    // 4.3–11.3 s later. For that whole window a takeover and someone pressing stop on the
    // TV's own remote are byte-identical.
    //
    // This was built as *Reconnecting…* for the full 15 s grace. The founder rejected it
    // on 2026-08-18: it claims a fault on the commonest action in the product. The ruling
    // is *Stopped*, immediately, corrected later if it turns out to have been a takeover.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;
    expect(playingAt).toBeGreaterThan(0);

    const seen: StateSnapshot[] = [];
    const unsubscribe = engine.subscribe((snapshot) => seen.push(snapshot));
    receiver.stopFromTv();

    const stopped = await waitFor((snapshot) => snapshot.session.state === 'stopped', 8_000);
    // A decision, not a failure: no error notice, no reconnection, and the place they got
    // to is on the screen as a number.
    expect(stopped.notice).toBeNull();
    expect(stopped.session.flags.reconnecting).toBe(false);
    expect(stopped.session.flags.yielded).toBe(false);
    expect(Math.abs(stopped.session.resumePositionSec - playingAt)).toBeLessThan(1.5);

    // **Never** the old screen, at any point in the stream.
    expect(seen.every((snapshot) => !snapshot.session.flags.reconnecting)).toBe(true);
    expect(seen.every((snapshot) => snapshot.notice === null)).toBe(true);

    // Hard requirement (i) of the ruling: the connection stays alive for the whole grace
    // period even though the screen already says *Stopped*. Otherwise the late
    // `RECEIVER_STATUS` that names a takeover can never arrive and the correction is
    // impossible. Measured on the wire: we are still asking the television who has it.
    const probesAtStop = receiver.countOf('GET_STATUS');
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(receiver.countOf('GET_STATUS')).toBeGreaterThan(probesAtStop);
    // And the position on the Stopped screen has not crept while we asked.
    expect(engine.snapshot().session.resumePositionSec).toBeCloseTo(
      stopped.session.resumePositionSec,
      3,
    );

    // Nothing else ever appeared on that television, so it was the founder's own decision.
    clock.shift(TIMING.takeoverGraceMs + 1_000);
    await waitUntil(() => loggedEvents().includes('session.ended_by_device'), 10_000);
    unsubscribe();

    const settled = engine.snapshot();
    expect(settled.session.state).toBe('stopped');
    expect(settled.session.flags.yielded).toBe(false);
    expect(settled.notice).toBeNull();
    expect(Math.abs(settled.session.resumePositionSec - playingAt)).toBeLessThan(1.5);
    expect(loggedEvents()).not.toContain('session.connection_lost');
    // And once the grace is over the questions stop: 14b's silence applies to a television
    // that simply stopped, too.
    const probesAtGiveUp = receiver.countOf('GET_STATUS');
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(receiver.countOf('GET_STATUS')).toBe(probesAtGiveUp);
  }, 40_000);

  it('corrects Stopped to a takeover when the television names the app inside the grace', async () => {
    // The other half of the ruling, at a gap the hardware actually produced. 12 s is inside
    // the 15 s grace and *above* SPIKE-2's measured 4.3–11.3 s — a gap of 1 s would pass
    // identically against a 1,500 ms grace and prove nothing about the number we shipped.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;

    const seen: StateSnapshot[] = [];
    const unsubscribe = engine.subscribe((snapshot) => seen.push(snapshot));
    receiver.takeover({ appId: '233637DE', appName: 'YouTube', gapMs: 12_000 });

    // First, the ruling's immediate answer: *Stopped*, with the place saved.
    const stopped = await waitFor((snapshot) => snapshot.session.state === 'stopped', 8_000);
    expect(stopped.session.flags.yielded).toBe(false);
    expect(stopped.notice).toBeNull();
    const savedAtStop = stopped.session.resumePositionSec;
    expect(Math.abs(savedAtStop - playingAt)).toBeLessThan(1.5);

    // Then, twelve seconds later, the truth.
    const yielded = await waitFor((snapshot) => snapshot.session.flags.yielded, 20_000);
    unsubscribe();
    expect(yielded.session.state).toBe('stopped');
    expect(yielded.session.yieldedToApp).toBe('YouTube');
    // Hard requirement (ii): the saved position survives the correction exactly.
    expect(yielded.session.resumePositionSec).toBeCloseTo(savedAtStop, 3);
    // 14a: stated as a fact — no error styling and no notice.
    expect(yielded.notice).toBeNull();
    await waitUntil(() => loggedEvents().includes('session.yielded'), 5_000);
    expect(loggedEvents()).not.toContain('session.connection_lost');

    // The correction runs one way only. Nothing in the stream ever said *Reconnecting*,
    // and nothing went back from "YouTube has it" to a plain stop.
    expect(seen.every((snapshot) => !snapshot.session.flags.reconnecting)).toBe(true);
    const firstYield = seen.findIndex((snapshot) => snapshot.session.flags.yielded);
    expect(firstYield).toBeGreaterThan(-1);
    expect(seen.slice(firstYield).every((snapshot) => snapshot.session.flags.yielded)).toBe(true);

    // 14b: from the yield on, that television hears nothing from us.
    const commands = ['LOAD', 'PLAY', 'PAUSE', 'SEEK', 'STOP', 'LAUNCH'] as const;
    const before = commands.map((type) => receiver.countOf(type));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(commands.map((type) => receiver.countOf(type))).toEqual(before);
  }, 60_000);

  it('stops asking after the grace, and never claims to know who has the television', async () => {
    // 16 s: outside the grace, and outside anything SPIKE-2 measured. The correction window
    // is bounded on purpose — a connection held open indefinitely against a television that
    // is no longer ours is exactly what 14b forbids. What the founder is left with is the
    // honest *Stopped* with their place saved, and *Resume from* is one press away: it
    // launches our receiver at the remembered position, which is what *Take it back* does.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;

    receiver.takeover({ appId: '233637DE', appName: 'YouTube', gapMs: 16_000 });
    const stopped = await waitFor((snapshot) => snapshot.session.state === 'stopped', 8_000);
    const savedAtStop = stopped.session.resumePositionSec;

    await waitUntil(() => loggedEvents().includes('session.ended_by_device'), 25_000);
    const commands = ['LOAD', 'PLAY', 'PAUSE', 'SEEK', 'STOP', 'LAUNCH'] as const;
    const before = commands.map((type) => receiver.countOf(type));

    // Past the naming, which now arrives to nobody.
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const settled = engine.snapshot();
    expect(settled.session.state).toBe('stopped');
    expect(settled.session.flags.yielded).toBe(false);
    // No claim about who has the television, because we no longer know — and never a
    // wrong one.
    expect(settled.session.yieldedToApp).toBeNull();
    expect(settled.notice).toBeNull();
    expect(settled.session.resumePositionSec).toBeCloseTo(savedAtStop, 3);
    expect(Math.abs(settled.session.resumePositionSec - playingAt)).toBeLessThan(1.5);
    expect(commands.map((type) => receiver.countOf(type))).toEqual(before);
  }, 60_000);

  it('declares a socket dead and recovers when the television stops answering PINGs (11f)', async () => {
    // 11f, and the fake's `goSilent()` had **no call sites at all** — so the one path M2's
    // whole foundation rests on had never been run by anything. This is the narrow half:
    // the device answers everything except the keep-alive, which is what a busy or
    // half-crashed receiver looks like, and the socket goes on looking perfectly healthy.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;

    receiver.setAnswersPings(false);
    const reconnecting = await waitFor((snapshot) => snapshot.session.flags.reconnecting, 25_000);
    // The give-up path ran, and it ran as a *lost connection*, not as an orderly end.
    expect(reconnecting.session.state).toBe('playing');
    expect(reconnecting.notice).toBeNull();
    await waitUntil(() => loggedEvents().includes('session.recovery_started'), 5_000);
    const started = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['event'] === 'session.recovery_started');
    expect(started?.['cause']).toBe('lost');
    expect(String(started?.['reason'])).toContain('PONG');

    // The television starts answering again, and the session comes back by itself.
    receiver.setAnswersPings(true);
    await waitUntil(() => loggedEvents().includes('session.recovery_rejoined'), 25_000);
    const settled = await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 25_000);
    expect(settled.session.state).toBe('playing');
    expect(settled.notice).toBeNull();
    expect(settled.session.positionSec).toBeGreaterThanOrEqual(playingAt);
    expect(loggedEvents()).not.toContain('session.ended_by_device');
  }, 60_000);

  it('ends in Lost connection when the television answers nothing at all (11f, 11c)', async () => {
    // The wide half of the same fake capability, and the case a closed socket cannot
    // produce: everything about the connection looks fine and nothing comes back — so the
    // reconnection succeeds at the TCP level and the *probe* is what times out, over and
    // over, until the budget runs out.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;

    receiver.goSilent();
    const reconnecting = await waitFor((snapshot) => snapshot.session.flags.reconnecting, 25_000);
    expect(reconnecting.session.state).toBe('playing');
    expect(reconnecting.notice).toBeNull();

    clock.shift(TIMING.reconnectBudgetMs + 1_000);
    const lost = await waitFor((snapshot) => snapshot.notice !== null, 20_000);
    expect(lost.notice?.kind).toBe('lost-connection');
    expect(lost.session.state).toBe('stopped');
    expect(Math.abs(lost.session.resumePositionSec - playingAt)).toBeLessThan(1.5);
    expect(loggedEvents()).not.toContain('session.ended_by_device');
  }, 60_000);

  it('calls a television that dropped to its screensaver Stopped, not "now playing Backdrop"', async () => {
    // `rejoin()` treated any appId that was not ours as somebody taking the television, so
    // a Chromecast that falls back to its ambient screensaver after a stop reported
    // "Fake TV is now playing Backdrop" — with a *Take it back* button, for a slideshow.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;

    receiver.stopFromTv();
    const stopped = await waitFor((snapshot) => snapshot.session.state === 'stopped', 8_000);
    expect(stopped.session.flags.yielded).toBe(false);

    // A few seconds later the television drops into Backdrop, which is what an idle
    // Chromecast does. It is still nobody's television but ours to come back to.
    receiver.setOtherApp({ appId: 'E8C28D3C', appName: 'Backdrop' });
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    expect(engine.snapshot().session.flags.yielded).toBe(false);
    expect(engine.snapshot().session.yieldedToApp).toBeNull();

    clock.shift(TIMING.takeoverGraceMs + 1_000);
    await waitUntil(() => loggedEvents().includes('session.ended_by_device'), 10_000);
    const settled = engine.snapshot();
    expect(settled.session.state).toBe('stopped');
    expect(settled.session.flags.yielded).toBe(false);
    expect(settled.session.yieldedToApp).toBeNull();
    expect(Math.abs(settled.session.resumePositionSec - playingAt)).toBeLessThan(1.5);
    expect(loggedEvents()).not.toContain('session.yielded');
  }, 40_000);

  it('casts onto a television that is announcing another app, without ever yielding to it (14c)', async () => {
    // Real Chromecasts broadcast receiver status whenever their state changes, including
    // the moment a new sender connects — so a television already playing YouTube tells us
    // so *between our CONNECT and our LAUNCH*. Read as a takeover, that turned a perfectly
    // ordinary Cast, and *Take it back* with it, into "the TV is now playing YouTube".
    receiver.setBroadcastsReceiverStatus(true);
    receiver.setOtherApp({ appId: '233637DE', appName: 'YouTube' });

    const seen: StateSnapshot[] = [];
    const unsubscribe = engine.subscribe((snapshot) => seen.push(snapshot));
    await castAndPlay();

    // The founder asked for this television, so the LAUNCH takes it — that is what *Take
    // it back* is — and at no point did the app announce that somebody else had it.
    expect(seen.every((snapshot) => !snapshot.session.flags.yielded)).toBe(true);
    expect(seen.every((snapshot) => snapshot.session.yieldedToApp === null)).toBe(true);
    expect(seen.every((snapshot) => snapshot.notice === null)).toBe(true);
    expect(seen.some((snapshot) => snapshot.session.state === 'playing')).toBe(true);
    expect(loggedEvents()).not.toContain('session.yielded');

    // Still ours a couple of seconds later: the film is playing and nobody has been told
    // that anybody else has the television.
    const settled = await waitForState('playing');
    unsubscribe();
    expect(settled.session.flags.yielded).toBe(false);
    expect(settled.notice).toBeNull();
  }, 30_000);

  it('states a takeover as a fact once the television names the app, and sends it nothing more (14a, 14b)', async () => {
    // The other ending the grace period exists to reach — the same CLOSE, a different
    // answer, and the app must never fight for the television.
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const playingAt = engine.snapshot().session.positionSec;

    // The real gaps were 4.3 s and 11.3 s; this is the same sequence, told sooner, so the
    // test costs seconds rather than minutes. What matters is that it arrives *after* the
    // CLOSE, which is the ordering the engine has to survive.
    receiver.takeover({ appId: '233637DE', appName: 'YouTube', gapMs: 1_000 });

    const yielded = await waitFor((snapshot) => snapshot.session.flags.yielded, 15_000);
    expect(yielded.session.state).toBe('stopped');
    expect(yielded.session.yieldedToApp).toBe('YouTube');
    // 14a: stated as a fact — no error styling, no notice, and the place is remembered.
    expect(yielded.notice).toBeNull();
    expect(Math.abs(yielded.session.resumePositionSec - playingAt)).toBeLessThan(1.5);
    await waitUntil(() => loggedEvents().includes('session.yielded'), 5_000);
    expect(loggedEvents()).not.toContain('session.connection_lost');

    // 14b: from the yield on, that television hears nothing from us — no load, no play,
    // no seek, no stop. Counted on the wire, which is where the criterion counts it.
    const commands = ['LOAD', 'PLAY', 'PAUSE', 'SEEK', 'STOP', 'LAUNCH'] as const;
    const before = commands.map((type) => receiver.countOf(type));
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(commands.map((type) => receiver.countOf(type))).toEqual(before);
  }, 40_000);
});

describe('position readout', () => {
  it('stays within a second of the device and logs the measurement (5a)', async () => {
    await castAndPlay();
    // Long enough for several device reports at the 1 Hz re-anchor rate.
    await new Promise((resolve) => setTimeout(resolve, 2_500));

    const samples = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter(
        (record) => record['event'] === 'position.sample' && record['playerState'] === 'PLAYING',
      )
      .map((record) => record['divergenceSec'])
      .filter((value): value is number => typeof value === 'number');

    expect(samples.length).toBeGreaterThan(0);
    expect(Math.max(...samples)).toBeLessThanOrEqual(1);
    expect(engine.snapshot().session.positionSec).toBeGreaterThan(0);
  }, 20_000);

  it('snaps to the device when the device disagrees with the extrapolation', async () => {
    await castAndPlay();
    receiver.setPositionSec(45);
    await waitFor((snapshot) => snapshot.session.positionSec > 40, 5_000);
    expect(engine.snapshot().session.positionSec).toBeGreaterThan(40);
  }, 20_000);

  /**
   * The PRD names this mechanism by hand for 5a: "[logic] fake receiver with a skewed
   * clock". The receiver has always been able to skew, and nothing was asking it to.
   */
  it('follows a device whose clock disagrees with ours, rather than its own arithmetic (5a)', async () => {
    await castAndPlay();
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    const beforeSkew = engine.snapshot().session.positionSec;

    // The device says it is 20 seconds further on than we believe. Device truth wins.
    receiver.setClockSkewSec(20);
    await waitFor((snapshot) => snapshot.session.positionSec > beforeSkew + 15, 6_000);

    const skewed = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['event'] === 'position.sample' && record['snapped'] === true);
    expect(skewed.length, 'the engine must record that it snapped, not hide it').toBeGreaterThan(0);

    // Having re-anchored, it must then stay with the device rather than drifting back.
    const settled = engine.snapshot().session.positionSec;
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const later = engine.snapshot().session.positionSec;
    expect(later).toBeGreaterThanOrEqual(settled);

    const divergences = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['event'] === 'position.sample')
      .slice(-3)
      .map((record) => record['divergenceSec'])
      .filter((value): value is number => typeof value === 'number');
    expect(divergences.length).toBeGreaterThan(0);
    expect(Math.max(...divergences)).toBeLessThanOrEqual(1);
  }, 25_000);
});
