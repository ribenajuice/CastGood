import { describe, expect, it } from 'vitest';
import {
  createSessionSupervisor,
  type SessionSource,
  type SessionSupervisor,
} from '../../src/engine/session/index.js';
import type {
  CastClient,
  CastConnection,
  CastConnectionEvents,
  LoadRequest,
  MediaStatus,
} from '../../src/engine/cast/index.js';
import type { MediaMount, MediaServer } from '../../src/engine/media-server/index.js';
import type { Device } from '../../src/engine/types.js';
import { createLogger, createMemorySink, type Clock } from '../../src/engine/logging/index.js';
import {
  addFiles,
  EMPTY_QUEUE,
  nextAfterPlaying,
  type Queue,
} from '../../src/engine/queue/model.js';

/**
 * **24m/24n — the join between two queue items, at the session layer.**
 *
 * `session/index.ts`'s `handleStatus` is the one place that can tell a genuine `FINISHED`
 * apart from anything else `IDLE` can mean, and it is the one place that decides whether to
 * hand the television a live LOAD instead of releasing it. Driven here with a scripted
 * `CastConnection`, the way `recovery-loop.test.ts` drives the reconnect loop: every `await`
 * is under the test's control, and what is asserted is the wire itself — how many `LOAD`s,
 * how many `STOP`s, and which file each `LOAD` named — never our own opinion of what
 * happened.
 *
 * `nextQueuedSource` is written here exactly as `src/engine/index.ts`'s own copy is: it reads
 * a `Queue` (the real value type from `queue/model.ts`), decides readiness, and moves
 * `queue.playingId` on the way out. The only thing missing is the classifier/look-ahead
 * machinery that decides *readiness* in the shipping engine — this test controls that
 * directly, because 24m/24n do not depend on how an item became ready, only on what happens
 * once it is.
 */

const device: Device = {
  id: 'tv-1',
  friendlyName: 'Family room TV',
  model: 'Chromecast',
  address: '10.1.1.230',
  port: 8009,
  lastSeenAt: 0,
};

function mediaStatus(overrides: Partial<MediaStatus> = {}): MediaStatus {
  return {
    mediaSessionId: 1,
    playerState: 'PLAYING',
    currentTimeSec: 10,
    durationSec: 3_600,
    idleReason: null,
    contentId: 'http://10.1.1.5:8099/m/abc/film.mp4',
    receivedAtMono: 0,
    ...overrides,
  };
}

interface ScriptedConnection extends CastConnection {
  readonly events: CastConnectionEvents;
}

interface ScriptedClient extends CastClient {
  /** Every `LOAD` sent, in order — what `loadCurrentSource` actually put on the wire. */
  readonly loads: readonly LoadRequest[];
  /** How many times `stop()` was called — zero is 24m's whole promise for a clean advance. */
  readonly stops: number;
  /** How many times `connect()` was called — more than one is a relaunch (24m forbids it). */
  readonly connects: number;
  connection(): ScriptedConnection;
}

function createScriptedClient(): ScriptedClient {
  const loads: LoadRequest[] = [];
  let stops = 0;
  let connects = 0;
  let current: ScriptedConnection | null = null;
  const client: ScriptedClient = {
    loads,
    get stops() {
      return stops;
    },
    get connects() {
      return connects;
    },
    connection() {
      if (current === null) throw new Error('no connection yet');
      return current;
    },
    connect(_target, events): Promise<CastConnection> {
      connects += 1;
      const connection: ScriptedConnection = {
        events,
        localAddress: '10.1.1.5',
        launchDefaultReceiver: () => Promise.resolve(),
        load(request) {
          loads.push(request);
          return Promise.resolve(
            mediaStatus({
              mediaSessionId: loads.length,
              playerState: 'BUFFERING',
              currentTimeSec: request.startPositionSec,
              contentId: request.contentUrl,
            }),
          );
        },
        play: () => Promise.resolve(),
        pause: () => Promise.resolve(),
        setActiveTracks: () => Promise.resolve(),
        stop() {
          stops += 1;
          return Promise.resolve();
        },
        seek: () => Promise.resolve(),
        getStatus: () => Promise.resolve(null),
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
            volumeControlType: null,
            volumeStepInterval: null,
            receivedAtMono: 0,
          }),
        rejoin: () => Promise.reject(new Error('recovery is not exercised by this file')),
        close: () => Promise.resolve(),
      };
      current = connection;
      return Promise.resolve(connection);
    },
  };
  return client;
}

function createStubMediaServer(): MediaServer {
  const mounts = new Map<string, MediaMount>();
  return {
    start: () => Promise.resolve({ port: 8099 }),
    stop: () => Promise.resolve(),
    mount(request) {
      const token = request.token ?? `token-${String(mounts.size)}`;
      const created: MediaMount = {
        token,
        path: request.kind === 'subtitles' ? '' : request.path,
        kind: request.kind,
        // The name a real mount would carry, so two films produce two distinguishable URLs.
        name: request.kind === 'subtitles' ? 'sub.vtt' : (request.path.split('/').pop() ?? 'film'),
      };
      mounts.set(token, created);
      return created;
    },
    unmount: (token) => void mounts.delete(token),
    urlFor: (mount, localAddress) => `http://${localAddress}:8099/m/${mount.token}/${mount.name}`,
    subtitleUrlFor: (mount, localAddress, offsetMs) =>
      `http://${localAddress}:8099/m/${mount.token}/sub/${String(offsetMs)}.vtt`,
    hasServedRequest: () => true,
    deliveryFor: () => null,
    deliveriesInFlight: () => ({ count: 0, oldestForMs: 0 }),
    unsafeBlackout: () => 0,
    unsafeWithholdTracks: () => undefined,
    port: 8099,
  };
}

function createClock(): Clock {
  return { wallMs: () => Date.now(), monoMs: () => performance.now() };
}

/** A queue of two films, mirroring `src/engine/index.ts`'s own shape closely enough to test against. */
function twoFilmQueue(): Queue {
  return addFiles(
    EMPTY_QUEUE,
    [
      { path: '/films/one.mp4', name: 'one.mp4' },
      { path: '/films/two.mp4', name: 'two.mp4' },
    ],
    (path) => path,
  );
}

/**
 * Builds the harness: a session, a scripted client, and a `nextQueuedSource` closure that
 * follows `src/engine/index.ts`'s own contract — decide readiness, move `queue.playingId`,
 * hand back a `SessionSource` — over a `ready` flag the test controls directly.
 */
function createHarness(ready: boolean): {
  session: SessionSupervisor;
  cast: ScriptedClient;
  queue: () => Queue;
} {
  const cast = createScriptedClient();
  const clock = createClock();
  // The real engine's `startCast` sets `queue.playingId` to the row it is about to cast
  // before the cast itself begins (`src/engine/index.ts`). Mirrored here so
  // `nextAfterPlaying` has a `playingId` to look past.
  const built = twoFilmQueue();
  let queue: Queue = { ...built, playingId: built.items[0]?.id ?? null };
  const session = createSessionSupervisor({
    logger: createLogger({ sink: createMemorySink(), clock }),
    clock,
    cast,
    mediaServer: createStubMediaServer(),
    onChanged: () => undefined,
    nextQueuedSource: (): SessionSource | null => {
      if (!ready) return null;
      const next = nextAfterPlaying(queue);
      if (next === null) return null;
      queue = { ...queue, playingId: next.id };
      return { path: next.path, name: next.name };
    },
  });
  return { session, cast, queue: () => queue };
}

const settle = (ms = 30): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('24m — a film that genuinely finishes with a ready next item', () => {
  it('loads the next item into the same session: no STOP, no second connect', async () => {
    const { session, cast, queue } = createHarness(true);

    await session.cast(device, { path: '/films/one.mp4', name: 'one.mp4' }, {});
    // Mark the first item playing, the way `startCast` does in the real engine.
    const playingQueue = queue();
    const firstId = playingQueue.items[0]?.id;
    expect(firstId).toBeDefined();

    const connection = cast.connection();
    connection.events.onMediaStatus(mediaStatus({ playerState: 'PLAYING', currentTimeSec: 5 }));
    expect(session.model.state).toBe('playing');
    expect(cast.loads).toHaveLength(1);

    // The film reaches genuine end.
    connection.events.onMediaStatus(
      mediaStatus({ playerState: 'IDLE', idleReason: 'FINISHED', currentTimeSec: 3_600 }),
    );
    await settle();

    // A live LOAD for the second film — never a STOP, and never a second `connect()`.
    expect(cast.stops).toBe(0);
    expect(cast.connects).toBe(1);
    expect(cast.loads).toHaveLength(2);
    expect(cast.loads[1]?.contentUrl).toContain('two.mp4');
    expect(cast.loads[1]?.title).toBe('two.mp4');

    // The session is still live — never flashed through `ended`/`stopped` on the way.
    expect(session.model.state).not.toBe('ended');
    expect(session.model.state).not.toBe('stopped');
  });

  it('moves queue.playingId to the item it just loaded', async () => {
    const { session, cast, queue } = createHarness(true);
    await session.cast(device, { path: '/films/one.mp4', name: 'one.mp4' }, {});
    const secondId = queue().items[1]?.id;
    expect(secondId).toBeDefined();

    const connection = cast.connection();
    connection.events.onMediaStatus(mediaStatus({ playerState: 'PLAYING', currentTimeSec: 5 }));
    connection.events.onMediaStatus(
      mediaStatus({ playerState: 'IDLE', idleReason: 'FINISHED', currentTimeSec: 3_600 }),
    );
    await settle();

    expect(queue().playingId).toBe(secondId);
  });
});

describe('24n — only a genuine finish may advance the queue', () => {
  it('does not advance on an error mid-play, even with a ready next item', async () => {
    const { session, cast, queue } = createHarness(true);
    await session.cast(device, { path: '/films/one.mp4', name: 'one.mp4' }, {});
    const firstId = queue().items[0]?.id;

    const connection = cast.connection();
    connection.events.onMediaStatus(mediaStatus({ playerState: 'PLAYING', currentTimeSec: 5 }));
    // A device reporting the film died — not a finish.
    connection.events.onMediaStatus(
      mediaStatus({ playerState: 'IDLE', idleReason: 'ERROR', currentTimeSec: 12 }),
    );
    await settle();

    // Today's ordinary release: one STOP, no second LOAD, and the queue has not moved on.
    expect(cast.stops).toBe(1);
    expect(cast.loads).toHaveLength(1);
    expect(queue().playingId).toBe(firstId ?? null);
    // `stopped`, not `ended` — an error is a refusal (13g), never a finish, and the reducer's
    // own `state: finished ? 'ended' : 'stopped'` line is the fact this asserts.
    expect(session.model.state).toBe('stopped');
  });

  it('does not advance on a refusal mid-play (13g), even with a ready next item', async () => {
    const { session, cast, queue } = createHarness(true);
    await session.cast(device, { path: '/films/one.mp4', name: 'one.mp4' }, {});
    const firstId = queue().items[0]?.id;

    const connection = cast.connection();
    connection.events.onMediaStatus(mediaStatus({ playerState: 'PLAYING', currentTimeSec: 5 }));
    // CANCELLED is 13g's refusal shape: an `IDLE` that is not `FINISHED`.
    connection.events.onMediaStatus(
      mediaStatus({ playerState: 'IDLE', idleReason: 'CANCELLED', currentTimeSec: 8 }),
    );
    await settle();

    expect(cast.stops).toBe(1);
    expect(cast.loads).toHaveLength(1);
    expect(queue().playingId).toBe(firstId ?? null);
  });
});

describe('regression: today’s release when there is nothing to advance to', () => {
  it('releases exactly as it always has when the next item is not ready', async () => {
    const { session, cast, queue } = createHarness(false);
    await session.cast(device, { path: '/films/one.mp4', name: 'one.mp4' }, {});
    const firstId = queue().items[0]?.id;

    const connection = cast.connection();
    connection.events.onMediaStatus(mediaStatus({ playerState: 'PLAYING', currentTimeSec: 5 }));
    connection.events.onMediaStatus(
      mediaStatus({ playerState: 'IDLE', idleReason: 'FINISHED', currentTimeSec: 3_600 }),
    );
    await settle();

    expect(cast.stops).toBe(1);
    expect(cast.loads).toHaveLength(1);
    expect(session.model.state).toBe('ended');
    // `nextQueuedSource` never moved the queue on, because it answered `null`.
    expect(queue().playingId).toBe(firstId ?? null);
  });

  it('releases exactly as it always has when there is no next item at all', async () => {
    const cast = createScriptedClient();
    const clock = createClock();
    const session = createSessionSupervisor({
      logger: createLogger({ sink: createMemorySink(), clock }),
      clock,
      cast,
      mediaServer: createStubMediaServer(),
      onChanged: () => undefined,
      // A queue of one: nothing after the item playing, so this is `null` by construction —
      // exactly `nextAfterPlaying`'s own answer for the last row (24o).
      nextQueuedSource: () => null,
    });

    await session.cast(device, { path: '/films/one.mp4', name: 'one.mp4' }, {});
    const connection = cast.connection();
    connection.events.onMediaStatus(mediaStatus({ playerState: 'PLAYING', currentTimeSec: 5 }));
    connection.events.onMediaStatus(
      mediaStatus({ playerState: 'IDLE', idleReason: 'FINISHED', currentTimeSec: 3_600 }),
    );
    await settle();

    expect(cast.stops).toBe(1);
    expect(cast.loads).toHaveLength(1);
    expect(session.model.state).toBe('ended');
  });
});
