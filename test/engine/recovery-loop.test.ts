import { describe, expect, it } from 'vitest';
import { createSessionSupervisor, type SessionSupervisor } from '../../src/engine/session/index.js';
import type {
  CastClient,
  CastConnection,
  CastConnectionEvents,
  MediaStatus,
  RejoinResult,
} from '../../src/engine/cast/index.js';
import type { MediaMount, MediaServer } from '../../src/engine/media-server/index.js';
import type { Device } from '../../src/engine/types.js';
import { createLogger, createMemorySink, type Clock } from '../../src/engine/logging/index.js';

/**
 * The recovery loop, driven directly, with every await under the test's control.
 *
 * The integration tests in `cast-session.test.ts` drive a real socket against a scripted
 * television, which is the right way to prove *behaviour*. It is the wrong way to prove
 * that two overlapping loops cannot both take ownership of a connection: that needs a
 * connect to hang exactly as long as the test says, and a `close()` to be observable.
 *
 * So this file scripts the cast client instead. What it asserts is an invariant rather
 * than a screen: **at most one connection is ever live, and every connection the
 * supervisor opens is either the current one or closed.** A live socket with live handlers
 * on the current generation is what fires a `device.disconnected` for a session that is
 * perfectly healthy.
 */

const device: Device = {
  id: 'tv-1',
  friendlyName: 'Family room TV',
  model: 'Chromecast',
  address: '10.1.1.230',
  port: 8009,
  lastSeenAt: 0,
};

interface ScriptedConnection extends CastConnection {
  readonly id: number;
  readonly closed: boolean;
  readonly events: CastConnectionEvents;
  /** Resolves the `rejoin()` this connection is sitting on. */
  answerRejoin(result: RejoinResult): void;
}

interface ScriptedClient extends CastClient {
  readonly connections: readonly ScriptedConnection[];
  /** Connections that were opened and never closed. More than one is the defect. */
  readonly live: readonly ScriptedConnection[];
  /** The next `connect()` fails, the way an unreachable television does. */
  refuseNext(): void;
  waitForConnection(index: number, timeoutMs?: number): Promise<ScriptedConnection>;
}

function mediaStatus(overrides: Partial<MediaStatus> = {}): MediaStatus {
  return {
    mediaSessionId: 1,
    playerState: 'PLAYING',
    currentTimeSec: 120,
    durationSec: 3_600,
    idleReason: null,
    contentId: 'http://10.1.1.5:8099/m/abc/film.mp4',
    receivedAtMono: 0,
    ...overrides,
  };
}

function createScriptedClient(): ScriptedClient {
  const connections: ScriptedConnection[] = [];
  let refuse = false;

  return {
    connections,
    get live() {
      return connections.filter((connection) => !connection.closed);
    },
    refuseNext() {
      refuse = true;
    },
    waitForConnection(index, timeoutMs = 2_000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise<ScriptedConnection>((resolve, reject) => {
        const poll = setInterval(() => {
          const found = connections[index];
          if (found !== undefined) {
            clearInterval(poll);
            resolve(found);
            return;
          }
          if (Date.now() > deadline) {
            clearInterval(poll);
            reject(new Error(`no connection #${String(index)} after ${String(timeoutMs)} ms`));
          }
        }, 5);
      });
    },
    connect(_target, events): Promise<CastConnection> {
      if (refuse) {
        refuse = false;
        return Promise.reject(new Error('device unreachable'));
      }
      let closed = false;
      let answer: ((result: RejoinResult) => void) | null = null;
      const connection: ScriptedConnection = {
        id: connections.length,
        get closed() {
          return closed;
        },
        events,
        localAddress: '10.1.1.5',
        launchDefaultReceiver: () => Promise.resolve(),
        load: () => Promise.resolve(mediaStatus({ playerState: 'BUFFERING', currentTimeSec: 0 })),
        play: () => Promise.resolve(),
        pause: () => Promise.resolve(),
        setActiveTracks: () => Promise.resolve(),
        stop: () => Promise.resolve(),
        seek: () => Promise.resolve(),
        getStatus: () => Promise.resolve(null),
        // M5a. This double is about recovery and never sends a volume; it answers with
        // the same reading it gives for a status, which is what a real set does.
        setVolume: () =>
          Promise.resolve({
            appId: 'CC1AD845',
            appName: 'Default Media Receiver',
            volumeLevel: 1,
            muted: false,
            volumeControlType: null,
            volumeStepInterval: null,
            receivedAtMono: 0,
          }),
        getReceiverStatus: () =>
          Promise.resolve({
            appId: 'CC1AD845',
            appName: 'Default Media Receiver',
            volumeLevel: 1,
            muted: false,
            // M5a widened ReceiverStatus; this fixture is about recovery and says nothing
            // about a volume control, so it reports the two new facts as absent rather
            // than inventing a control type it was never asked about.
            volumeControlType: null,
            volumeStepInterval: null,
            receivedAtMono: 0,
          }),
        rejoin: () =>
          new Promise<RejoinResult>((resolve) => {
            answer = resolve;
          }),
        answerRejoin(result) {
          answer?.(result);
          answer = null;
        },
        close() {
          closed = true;
          return Promise.resolve();
        },
      };
      connections.push(connection);
      return Promise.resolve(connection);
    },
  };
}

function createStubMediaServer(): MediaServer {
  const mounts = new Map<string, MediaMount>();
  return {
    start: () => Promise.resolve({ port: 8099 }),
    stop: () => Promise.resolve(),
    mount(request) {
      const token = request.token ?? 'abc';
      const created: MediaMount = {
        token,
        path: request.kind === 'subtitles' ? '' : request.path,
        kind: request.kind,
        name: 'film.mp4',
      };
      mounts.set(token, created);
      return created;
    },
    unmount: (token) => void mounts.delete(token),
    urlFor: (mount, localAddress) => `http://${localAddress}:8099/m/${mount.token}/film.mp4`,
    subtitleUrlFor: (mount, localAddress, offsetMs) =>
      `http://${localAddress}:8099/m/${mount.token}/sub/${String(offsetMs)}.vtt`,
    hasServedRequest: () => true,
    // This file scripts the cast client to prove one connection is ever live; it has no
    // media server and no television fetching bytes, so there is no delivery to report.
    // `null` is the honest answer and it keeps D2's repair path out of these tests.
    deliveryFor: () => null,
    deliveriesInFlight: () => ({ count: 0, oldestForMs: 0 }),
    unsafeBlackout: () => 0,
    unsafeWithholdTracks: () => undefined,
    port: 8099,
  };
}

function createClock(): Clock & { advance(ms: number): void } {
  let offset = 0;
  return {
    wallMs: () => Date.now() + offset,
    monoMs: () => performance.now() + offset,
    advance(ms) {
      offset += ms;
    },
  };
}

function createHarness(): {
  session: SessionSupervisor;
  cast: ScriptedClient;
  clock: ReturnType<typeof createClock>;
} {
  const cast = createScriptedClient();
  const clock = createClock();
  const session = createSessionSupervisor({
    logger: createLogger({ sink: createMemorySink(), clock }),
    clock,
    cast,
    mediaServer: createStubMediaServer(),
    onChanged: () => undefined,
  });
  return { session, cast, clock };
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('the recovery loop cannot outlive its cancellation', () => {
  it('never leaves two connections live when a loop is cancelled mid-backoff', async () => {
    const { session, cast } = createHarness();

    await session.cast(device, { path: '/films/film.mp4', name: 'film.mp4' });
    const first = await cast.waitForConnection(0);
    expect(session.model.state).toBe('buffering');

    // The socket dies. Loop A starts, and its first reconnection is refused — so it is now
    // sitting inside `await sleep(backoffFor(0))`, which is where the old boolean guard
    // could be reset out from under it by a third function.
    cast.refuseNext();
    first.events.onDisconnected({ reason: 'socket closed', deviceInitiated: false });
    await settle();
    expect(session.model.flags.reconnecting).toBe(true);

    // The founder presses Stop. `release()` used to clear `recovering` while loop A slept.
    await session.stop();
    expect(session.model.state).toBe('stopped');

    // And immediately starts again — a new session, a new generation, and an interruption
    // of its own, so `model.recovery` is non-null again when loop A wakes up.
    await session.cast(device, { path: '/films/film.mp4', name: 'film.mp4' });
    const second = await cast.waitForConnection(cast.connections.length - 1);
    second.events.onDisconnected({ reason: 'socket closed', deviceInitiated: false });
    await settle();

    // Loop B is now probing. Let everything unwind: loop A's backoff (500 ms) expires well
    // inside this, so if it were still alive it would connect, rejoin and assign itself as
    // *the* connection alongside loop B's.
    const before = cast.connections.length;
    await settle(900);
    for (const connection of cast.connections.slice(before)) {
      connection.answerRejoin({
        appId: 'CC1AD845',
        appName: 'Default Media Receiver',
        ours: true,
        media: mediaStatus(),
      });
    }
    await settle(200);

    // The invariant. Two live connections means one of them is a socket nobody owns, with
    // live handlers on the current generation, waiting to report a disconnection that has
    // nothing to do with the session on screen.
    expect(cast.live.length).toBeLessThanOrEqual(1);
    // And whatever loop A opened after being cancelled was closed rather than adopted.
    expect(cast.live[0]).toBe(cast.connections.find((connection) => !connection.closed));
  }, 20_000);

  it('closes, rather than adopts, a connection that lands after the founder has moved on', async () => {
    const { session, cast } = createHarness();

    await session.cast(device, { path: '/films/film.mp4', name: 'film.mp4' });
    const first = await cast.waitForConnection(0);

    // The connection dies and recovery reconnects — but the television is slow to answer
    // the probe, which is the window SPIKE-2 measured at up to 11.3 seconds.
    first.events.onDisconnected({ reason: 'socket closed', deviceInitiated: false });
    const probe = await cast.waitForConnection(1);

    // The founder gives up waiting and casts again while the probe is still open.
    await session.cast(device, { path: '/films/film.mp4', name: 'film.mp4' });
    await settle();

    // The television finally answers the *old* probe. It must be closed and forgotten, not
    // adopted into the session that replaced it.
    probe.answerRejoin({
      appId: 'CC1AD845',
      appName: 'Default Media Receiver',
      ours: true,
      media: mediaStatus(),
    });
    await settle(100);

    expect(probe.closed).toBe(true);
    expect(cast.live.length).toBeLessThanOrEqual(1);
    expect(session.model.flags.reconnecting).toBe(false);
  }, 20_000);
});
