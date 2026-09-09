import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink, systemClock } from '../../src/engine/logging/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * Story 12: the app is closed mid-film and opened again.
 *
 * Two criteria, and the second is the one that keeps being broken: **12b's silence.**
 * Reopening onto a television that is playing somebody else's video must land in *Idle*
 * with nothing said — no takeover claim, no reconnection, no error. The way that silence
 * was lost was not visible in an end-state assertion: the app reached Idle correctly and
 * flashed two wrong screens on the way. So these tests record **every snapshot** the
 * engine pushes and assert against the whole stream.
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

let receiver: FakeReceiver;
let directory: string;
let filePath: string;
let otherFilePath: string;
let paths: AppPaths;
/** Every engine started by a test, so `afterEach` can stop them whatever happened. */
let running: Engine[];

function makeEngine(options: { mdns: FakeMdns; mediaPort?: number }): Engine {
  const engine = createEngine({
    paths,
    clock: systemClock,
    logSink: createMemorySink(),
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns: options.mdns,
    // Omitted on the second run on purpose: the reopened app has to republish the *same*
    // URL the television is still fetching, and the port it names comes from the store.
    ...(options.mediaPort === undefined ? {} : { mediaPort: options.mediaPort }),
  });
  running.push(engine);
  return engine;
}

function announce(mdns: FakeMdns): void {
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
}

function waitFor(
  engine: Engine,
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

/** The app was casting and the window was closed: the film is left playing (story 12). */
async function castThenCloseTheWindow(): Promise<number> {
  const mdns = createFakeMdns();
  const first = makeEngine({ mdns, mediaPort: 0 });
  await first.start();
  announce(mdns);
  first.dispatch({ type: 'file.select', path: filePath });
  await waitFor(first, (snapshot) => snapshot.file !== null);
  first.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  first.dispatch({ type: 'cast.start' });
  await waitFor(first, (snapshot) => snapshot.session.state === 'playing');
  await new Promise((resolve) => setTimeout(resolve, 1_200));
  const playingAt = first.snapshot().session.positionSec;
  await first.stop({ keepPlaying: true });
  return playingAt;
}

beforeEach(async () => {
  running = [];
  receiver = await startFakeReceiver({ durationSec: 900 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-reattach-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  otherFilePath = path.join(directory, 'Cars.mp4');
  await fs.writeFile(filePath, fixtureMp4());
  await fs.writeFile(otherFilePath, fixtureMp4());
  paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } });
});

afterEach(async () => {
  for (const engine of running) await engine.stop().catch(() => undefined);
  await receiver.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('12a — reopening while the television is still playing our film', () => {
  it('picks the session up where it was, without starting the film again', async () => {
    const playingAt = await castThenCloseTheWindow();
    const launchesBefore = receiver.countOf('LAUNCH');
    const loadsBefore = receiver.countOf('LOAD');

    const mdns = createFakeMdns();
    const second = makeEngine({ mdns });
    announce(mdns);
    await second.start();

    const resumed = await waitFor(second, (snapshot) => snapshot.session.state === 'playing');
    expect(resumed.file?.name).toBe('Bluey - The Sign.mp4');
    expect(resumed.notice).toBeNull();
    // "It does **not** start the film again": no second LAUNCH, no second LOAD, and the
    // playhead is where the first process left it rather than back at the opening titles.
    expect(receiver.countOf('LAUNCH')).toBe(launchesBefore);
    expect(receiver.countOf('LOAD')).toBe(loadsBefore);
    expect(resumed.session.positionSec).toBeGreaterThanOrEqual(playingAt - 0.5);
  }, 30_000);
});

describe('the reattach must never race the founder', () => {
  it('leaves the film and the cast the founder chose exactly alone', async () => {
    await castThenCloseTheWindow();

    // The reopened app: the remembered television is **not** announced yet, so the
    // reattach sits in its device-wait loop exactly as it does on a real launch.
    const mdns = createFakeMdns();
    const second = makeEngine({ mdns });
    await second.start();

    // The founder does not wait. They pick a different film and press Cast — and only
    // *then* does the remembered device turn up.
    second.dispatch({ type: 'file.select', path: otherFilePath });
    await waitFor(second, (snapshot) => snapshot.file?.name === 'Cars.mp4');
    announce(mdns);
    second.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    second.dispatch({ type: 'cast.start' });

    const playing = await waitFor(second, (snapshot) => snapshot.session.state === 'playing');
    expect(playing.file?.name).toBe('Cars.mp4');

    // Well past the 5 s budget, so a reattach that was still going to fire has fired.
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    const settled = second.snapshot();
    // Their film, their cast, still playing. The defect swapped the file underneath them
    // and reset the session to `connecting` on a cast they had already made.
    expect(settled.file?.name).toBe('Cars.mp4');
    expect(settled.session.state).toBe('playing');
    expect(settled.session.flags.reattaching).toBe(false);
    expect(receiver.loadedUrl).not.toBeNull();
  }, 30_000);

  it('does not reattach at all when the founder has already chosen a file', async () => {
    await castThenCloseTheWindow();

    const mdns = createFakeMdns();
    const second = makeEngine({ mdns });
    announce(mdns);
    // Chosen before the engine has even started looking — the reattach must stand down
    // rather than replace it with last night's film.
    const seen: StateSnapshot[] = [];
    second.subscribe((snapshot) => seen.push(snapshot));
    second.dispatch({ type: 'file.select', path: otherFilePath });
    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(second.snapshot().file?.name).toBe('Cars.mp4');
    expect(seen.every((snapshot) => !snapshot.session.flags.reattaching)).toBe(true);
  }, 30_000);
});

describe('12b — reopening while the television is playing something else', () => {
  it('says nothing at all, and never flashes a takeover or a reconnection', async () => {
    await castThenCloseTheWindow();

    // Somebody casts YouTube to the same television while CastGood is closed.
    receiver.takeover({ appId: '233637DE', appName: 'YouTube', gapMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const mdns = createFakeMdns();
    const second = makeEngine({ mdns });
    announce(mdns);

    // **Every** snapshot, from before `start()` returns to well after the answer is known.
    const seen: StateSnapshot[] = [];
    second.subscribe((snapshot) => seen.push(snapshot));
    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    // The wrong screens, each of which really appeared:
    //  - "Family room TV is now playing YouTube" with *Take it back*, because `rejoin()`'s
    //    own GET_STATUS reply was published as though the television had volunteered it;
    //  - "Reconnecting to Fake TV…", because closing the probe announced itself as a
    //    device-initiated disconnection at `connecting`.
    expect(seen.every((snapshot) => !snapshot.session.flags.yielded)).toBe(true);
    expect(seen.every((snapshot) => snapshot.session.yieldedToApp === null)).toBe(true);
    expect(seen.every((snapshot) => !snapshot.session.flags.reconnecting)).toBe(true);
    expect(seen.every((snapshot) => snapshot.notice === null)).toBe(true);
    // Nothing that is not either Idle or the reattach attempt itself was ever on screen.
    expect(
      seen.every(
        (snapshot) =>
          snapshot.session.state === 'idle' ||
          (snapshot.session.state === 'connecting' && snapshot.session.flags.reattaching),
      ),
    ).toBe(true);

    // And it ends in Idle, with the record forgotten so the next open is silent too.
    expect(second.snapshot().session.state).toBe('idle');
    expect(second.snapshot().session.flags.reattaching).toBe(false);
  }, 30_000);

  it('never launches anything on a television it did not recognise (14b)', async () => {
    await castThenCloseTheWindow();
    receiver.takeover({ appId: '233637DE', appName: 'YouTube', gapMs: 10 });
    await new Promise((resolve) => setTimeout(resolve, 100));

    const before = (['LAUNCH', 'LOAD', 'PLAY', 'PAUSE', 'SEEK', 'STOP'] as const).map((type) =>
      receiver.countOf(type),
    );
    const mdns = createFakeMdns();
    const second = makeEngine({ mdns });
    announce(mdns);
    await second.start();
    await new Promise((resolve) => setTimeout(resolve, 1_500));

    expect(
      (['LAUNCH', 'LOAD', 'PLAY', 'PAUSE', 'SEEK', 'STOP'] as const).map((type) =>
        receiver.countOf(type),
      ),
    ).toEqual(before);
  }, 30_000);
});
