import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { TIMING } from '../../src/engine/config.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * M5a's acceptance criteria — the volume control, driven through the whole engine.
 *
 * Everything here is **[logic]**: headless in WSL, against a scripted receiver over a real
 * socket. It proves the engine's rules and **nothing whatsoever about a television** —
 * whether a set takes a level, how fast it answers, and whether the *sound in the room*
 * moved are SPIKE-5, the `volume` scenario and the founder's own ears.
 *
 * ⚠️ **The expensive lie available in this milestone is "we sent a message and nobody
 * objected".** A volume test that issues `SET_VOLUME`, sees no error and reports green
 * would pass identically against a television that ignored it completely. So the fake
 * receiver here is deliberately unkind — it quantises, it clamps, it can swallow the
 * command silently, and it can report a `fixed` control — and **every assertion is made
 * against what came back**, never against what was asked for.
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
  mvhd.writeUInt32BE(7_200_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

let receiver: FakeReceiver;
let engine: Engine;
let mdns: FakeMdns;
let directory: string;
let filePath: string;

function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<StateSnapshot> {
  return new Promise((resolve, reject) => {
    if (predicate(engine.snapshot())) {
      resolve(engine.snapshot());
      return;
    }
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for a snapshot'));
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

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Comfortably past the retry deadline, so a retry that was going to happen has happened. */
const pastRetry = (): Promise<void> => sleep(TIMING.volumeEchoMs + 250);

const level = (): number | null => engine.snapshot().session.volume?.level ?? null;
const muted = (): boolean | null => engine.snapshot().session.volume?.muted ?? null;

/** Every `SET_VOLUME` the television actually received, in order, as it was asked. */
function volumeAsks(): { level?: number; muted?: boolean }[] {
  return receiver.received
    .filter((message) => message.type === 'SET_VOLUME')
    .map((message) => (message.payload['volume'] ?? {}) as { level?: number; muted?: boolean });
}

async function castAndPlay(): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filePath });
  await waitFor((snapshot) => snapshot.file !== null);
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitForState('playing');
  await waitFor((snapshot) => snapshot.session.durationSec > 0);
}

async function start(options: Parameters<typeof startFakeReceiver>[0] = {}): Promise<void> {
  receiver = await startFakeReceiver({ durationSec: 7_200, startupMs: 10, ...options });
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-m5a-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());

  mdns = createFakeMdns();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    logSink: createMemorySink(),
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
  });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fs.rm(directory, { recursive: true, force: true });
});

// --- 23a — one command on the wire, one value behind it ----------------------

describe('23a — exactly one SET_VOLUME in flight, and a slot rather than a queue', () => {
  it('never puts two on the wire at once across a 30-step drag, and sends the last value reached', async () => {
    await start();
    await engine.start();
    await castAndPlay();
    const before = volumeAsks().length;

    // A drag, at the pace a finger moves: thirty steps with no waiting in between. This is
    // the gesture 23a exists for, and the one that would flood the socket carrying the film.
    const steps = Array.from({ length: 30 }, (_, index) => 0.2 + index * 0.01);
    for (const step of steps) engine.dispatch({ type: 'volume.set', level: step });

    await waitFor(() => {
      const last = volumeAsks().at(-1)?.level;
      return last !== undefined && Math.abs(last - 0.49) < 1e-9;
    });
    await pastRetry();

    const asks = volumeAsks().slice(before);
    // **Far fewer messages than presses.** The exact count is the device's round trip and
    // is not a promise; what is promised is that it is nothing like thirty.
    expect(asks.length).toBeLessThan(steps.length);
    // The founder's last position is where the television ends up. An intermediate level
    // winning would leave the room at a volume nobody asked for.
    expect(asks.at(-1)?.level).toBeCloseTo(0.49, 9);
    // And the set really is there, read from what it reported rather than what we sent.
    expect(receiver.volume.level).toBeCloseTo(0.49, 9);
    await waitFor(() => level() !== null && Math.abs((level() ?? 0) - 0.49) < 1e-9);
  });

  it('does not let a drag step swallow a mute press waiting behind it', async () => {
    // A mute is a different control (question 42), not another point in a gesture. One
    // shared slot meant a press that produced no message, no sound and no feedback.
    await start({ volumeLevel: 0.5 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.5);

    engine.dispatch({ type: 'volume.set', level: 0.4 });
    engine.dispatch({ type: 'volume.mute', muted: true });
    engine.dispatch({ type: 'volume.set', level: 0.45 });

    await waitFor(() => muted() === true, 8_000);
    expect(receiver.volume.muted).toBe(true);
  }, 20_000);

  it('overwrites the pending value instead of accumulating one message per press', async () => {
    await start();
    await engine.start();
    await castAndPlay();
    const before = volumeAsks().length;

    // Three asks with nothing in between: at most the first is on the wire, and the second
    // is overwritten by the third before it can ever be sent.
    engine.dispatch({ type: 'volume.set', level: 0.3 });
    engine.dispatch({ type: 'volume.set', level: 0.4 });
    engine.dispatch({ type: 'volume.set', level: 0.5 });
    await waitFor(() => receiver.volume.level === 0.5);
    await pastRetry();

    const asks = volumeAsks().slice(before);
    expect(asks.length).toBeLessThanOrEqual(2);
    expect(asks.map((ask) => ask.level)).not.toContain(0.4);
  });
});

// --- 23b — the app never shows a level it was not told -----------------------

describe('23b — no optimistic readout', () => {
  it('does not move the displayed level when the television swallows the command', async () => {
    await start();
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() !== null);
    const shown = level();

    // A television that takes the message and says nothing. This is the cheap fake's
    // undoing: an optimistic readout looks perfect on every working device and only shows
    // itself here.
    receiver.swallow('SET_VOLUME');
    engine.dispatch({ type: 'volume.set', level: 0.15 });
    await pastRetry();
    await pastRetry();

    expect(level()).toBe(shown);
    expect(receiver.volume.level).toBe(shown);
  });

  it('shows the level the set reported, not the one that was asked for, when they differ', async () => {
    // A set that quantises to its own 0.05 grid — both of the founder's Chromecast dongles.
    await start({ volumeStepInterval: 0.05, volumeLevel: 0.5 });
    await engine.start();
    await castAndPlay();

    engine.dispatch({ type: 'volume.set', level: 0.37 });
    await waitFor(() => level() !== null && level() !== 0.5);
    await pastRetry();

    // 0.37 was asked for and 0.35 is what the television does. The app shows the set's
    // number; showing 0.37 would be the app inventing a level nobody reported.
    expect(level()).toBeCloseTo(0.35, 9);
    expect(volumeAsks().at(-1)?.level).toBeCloseTo(0.37, 9);
  });

  it('publishes the ask as its own field, and never as the level', async () => {
    // This replaces a test that asserted the keys of a literal it had just written down —
    // it could not fail, and what it claimed (no pending field) had stopped being true.
    // The real rule is that `pending` and `level` are different things and only one of
    // them is ever the displayed value.
    await start({ volumeLevel: 0.5 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.5);

    receiver.swallow('SET_VOLUME');
    engine.dispatch({ type: 'volume.set', level: 0.9 });
    // The ask must reach the screen — §11's tick exists to say "asked, not answered" — and
    // the level must not move a hair while the television stays silent.
    await waitFor(() => engine.snapshot().session.volume?.pending !== null);
    expect(engine.snapshot().session.volume?.pending).toBeCloseTo(0.9, 6);
    expect(level()).toBe(0.5);
  }, 20_000);
});

// --- 23c — somebody else moved it -------------------------------------------

describe('23c — a change the app did not ask for', () => {
  it('follows a change announced by the television', async () => {
    await start({ volumeLevel: 0.5 });
    receiver.setBroadcastsReceiverStatus(true);
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.5);

    receiver.changeVolumeExternally(0.2);
    await waitFor(() => level() === 0.2, 8_000);
    expect(level()).toBe(0.2);
  }, 20_000);

  it('finds a change on the poll when the set announces nothing at all', async () => {
    // ⚠️ The founder's own `AI PONT`, measured: 15 s of silence after a second sender moved
    // the level, then a poll read it in 8 ms. This is the harder world and the real one.
    await start({ volumeLevel: 0.5 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.5);

    receiver.changeVolumeExternally(0.8);
    // Nothing was broadcast; only the supervisor's own status poll can find this.
    await waitFor(() => level() === 0.8, 8_000);
    expect(level()).toBe(0.8);
  }, 20_000);
});

// --- 23d — one bounded retry, and only when nothing moved --------------------

describe('23d — retried exactly once, and only when the level did not move at all', () => {
  it('retries once when the television answers nothing', async () => {
    await start();
    await engine.start();
    await castAndPlay();
    receiver.swallow('SET_VOLUME');
    const before = volumeAsks().length;

    engine.dispatch({ type: 'volume.set', level: 0.25 });
    await pastRetry();
    await pastRetry();

    // Exactly two: the command and its one retry. A third would be a loop against a set
    // that is never going to answer.
    expect(volumeAsks().length - before).toBe(2);
  });

  it('does not retry a level the set answered exactly', async () => {
    await start({ volumeLevel: 0.9 });
    await engine.start();
    await castAndPlay();
    const before = volumeAsks().length;

    engine.dispatch({ type: 'volume.set', level: 0.4 });
    await waitFor(() => level() === 0.4);
    await pastRetry();
    await pastRetry();

    expect(volumeAsks().length - before).toBe(1);
  });

  it("does not treat a television's float wobble as the level moving", async () => {
    /**
     * ⚠️ **Measured on the founder's `Home Theatre TV` (a Chromecast Ultra), 2026-09-08.**
     * That set reports one unchanged level as `0.10000000149011612` and then
     * `0.09999999403953552`, about 100 ms apart, with nothing having happened.
     *
     * **What this is not**: it is not a missed 23d retry. That retry is triggered by a
     * *non-answer*, and the Ultra answers — it simply answers with the level it was already
     * on, which 23b requires the app to show. Getting that wrong in the first diagnosis is
     * why this test asserts the thing that is actually true.
     *
     * **What it is**: every wobble used to publish a fresh snapshot and log a level change
     * that never happened, and it feeds `volumeMovedSince`, which is where "did the set
     * move" is decided. A comparison that answers that question from float noise is wrong
     * however little it happens to cost.
     *
     * The fake could not express this until today: `answerFor` rounds to 1e-6 on purpose,
     * so the harness was kinder than the house.
     */
    await start({ volumeLevel: 0.1, volumeReportJitter: 1e-8 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() !== null);

    const seen = new Set<number | null>();
    for (let tick = 0; tick < 12; tick += 1) {
      await new Promise((resolve) => setTimeout(resolve, 120));
      seen.add(level());
    }

    // One level, however many statuses arrived. Before the epsilon this collected a fresh
    // value on nearly every poll.
    expect(seen.size).toBe(1);
  }, 20_000);

  it('does not retry a quantised answer — the set moved, so that is its answer', async () => {
    await start({ volumeStepInterval: 0.05, volumeLevel: 0.9 });
    await engine.start();
    await castAndPlay();
    const before = volumeAsks().length;

    engine.dispatch({ type: 'volume.set', level: 0.37 });
    await waitFor(() => level() === 0.35);
    await pastRetry();
    await pastRetry();

    // The defect available here is comparing the echo against the *requested* level: that
    // starts a retry loop chasing 0.37 on a set that will only ever report 0.35.
    expect(volumeAsks().length - before).toBe(1);
    expect(level()).toBeCloseTo(0.35, 9);
  });

  it('does not retry a clamped answer either', async () => {
    await start({ volumeMaxLevel: 0.6, volumeLevel: 0.1 });
    await engine.start();
    await castAndPlay();
    const before = volumeAsks().length;

    engine.dispatch({ type: 'volume.set', level: 1 });
    await waitFor(() => level() === 0.6);
    await pastRetry();
    await pastRetry();

    expect(volumeAsks().length - before).toBe(1);
    expect(level()).toBeCloseTo(0.6, 9);
  });
});

// --- 23e — the film is untouched --------------------------------------------

describe('23e — a volume change touches playback in no way at all', () => {
  it('sends zero media-namespace messages across twenty changes', async () => {
    await start();
    await engine.start();
    await castAndPlay();

    const mediaBefore =
      receiver.countOf('LOAD') +
      receiver.countOf('SEEK') +
      receiver.countOf('PAUSE') +
      receiver.countOf('PLAY') +
      receiver.countOf('STOP');

    for (let index = 0; index < 20; index += 1) {
      engine.dispatch({ type: 'volume.set', level: 0.2 + index * 0.02 });
      await sleep(20);
    }
    await pastRetry();

    // Counted from what the television received, never from our own session state — the
    // mistake 24c already had to name.
    const mediaAfter =
      receiver.countOf('LOAD') +
      receiver.countOf('SEEK') +
      receiver.countOf('PAUSE') +
      receiver.countOf('PLAY') +
      receiver.countOf('STOP');
    expect(mediaAfter).toBe(mediaBefore);
    expect(engine.snapshot().session.state).toBe('playing');
  });
});

// --- 23h / 23i — the refusals -----------------------------------------------

describe('23h and 23i — a set that will not take a volume, and a state with nothing to send over', () => {
  it('marks a fixed-control television as not controllable, and says nothing anywhere else', async () => {
    await start({ volumeControlType: 'fixed', volumeLevel: 0.4 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => engine.snapshot().session.volume !== null);

    expect(engine.snapshot().session.volume?.controllable).toBe(false);
    // A refusal known ahead is not a failure: nothing is announced and nothing is styled.
    expect(engine.snapshot().notice).toBeNull();
  });

  it('treats a set that never says how its volume works as controllable', async () => {
    // Silence is not refusal. SPIKE-5 found `master` and `attenuation` in the house and no
    // `fixed` anywhere, so reading an absent control type as "no" would disable the control
    // on every television that actually works.
    await start({ volumeLevel: 0.4 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => engine.snapshot().session.volume !== null);
    expect(engine.snapshot().session.volume?.controllable).toBe(true);
  });

  it('publishes no volume once the television has been let go', async () => {
    // ⚠️ The engine's half of 23i, and the half that was wrong: `volumeSnapshot()` asked
    // about `idle` alone, so after Stop — which keeps its transport row — the control was
    // still drawn. The renderer test for this handed in `volume: null` itself, so it
    // proved the renderer's response to a value the engine never produced.
    await start();
    await engine.start();
    await castAndPlay();
    await waitFor(() => engine.snapshot().session.volume !== null);

    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    expect(engine.snapshot().session.volume).toBeNull();
  }, 20_000);

  it("forgets one television's level rather than showing it for the next", async () => {
    // Cast at one level, stop, and the next session must start with nothing to draw. A
    // level that survived would put a handle on a set that has said nothing yet.
    await start({ volumeLevel: 0.8 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.8);

    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    engine.dispatch({ type: 'cast.start' });
    // At the instant the next session begins there is no reported level yet — the previous
    // set's 0.8 must not be standing in for one.
    const early = engine.snapshot().session.volume;
    expect(early === null || early.level === null).toBe(true);
  }, 25_000);

  it('publishes no volume at all when nothing is playing', async () => {
    await start();
    await engine.start();
    expect(engine.snapshot().session.volume).toBeNull();
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    // A file chosen is still not a session: 23i, and the founder's ruling on question 43.
    expect(engine.snapshot().session.volume).toBeNull();
  });
});

// --- 23f — mute is its own control ------------------------------------------

describe('23f — mute in one press, unmute in one press, and CastGood remembers nothing', () => {
  it('returns the room to the level it was at, with no level ever sent', async () => {
    await start({ volumeLevel: 0.45 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.45);
    const before = level();

    engine.dispatch({ type: 'volume.mute', muted: true });
    await waitFor(() => muted() === true);
    // The level is untouched while muted — the television is still holding it for us.
    expect(level()).toBe(before);

    engine.dispatch({ type: 'volume.mute', muted: false });
    await waitFor(() => muted() === false);

    // Byte-identical either side, and the app never sent a level to achieve it.
    expect(level()).toBe(before);
    const levelsSent = volumeAsks().filter((ask) => ask.level !== undefined);
    expect(levelsSent).toEqual([]);
  }, 20_000);

  it('is never implemented as a level of zero', async () => {
    await start({ volumeLevel: 0.6 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.6);

    engine.dispatch({ type: 'volume.mute', muted: true });
    await waitFor(() => muted() === true);

    // The founder's ruling on question 42, graded from the wire. A mute sent as `level: 0`
    // would destroy the number the set is holding, and unmuting would then need a memory
    // of ours — which is precisely what 23f forbids.
    expect(volumeAsks().some((ask) => ask.level === 0)).toBe(false);
    expect(receiver.volume.level).toBeCloseTo(0.6, 9);
  }, 20_000);

  it('unmutes when a level is set while muted', async () => {
    await start({ volumeLevel: 0.6 });
    await engine.start();
    await castAndPlay();
    engine.dispatch({ type: 'volume.mute', muted: true });
    await waitFor(() => muted() === true);

    engine.dispatch({ type: 'volume.set', level: 0.3 });
    await waitFor(() => level() === 0.3);
    expect(muted()).toBe(false);
  }, 20_000);
});

// --- 23k — volume never speaks ----------------------------------------------

describe('23k — a volume is a control value, never a state', () => {
  it('leaves the session state and every flag untouched across a change', async () => {
    await start();
    await engine.start();
    await castAndPlay();
    const before = engine.snapshot().session;

    engine.dispatch({ type: 'volume.set', level: 0.33 });
    await waitFor(() => level() === 0.33);

    const after = engine.snapshot().session;
    expect(after.state).toBe(before.state);
    expect(after.flags).toEqual(before.flags);
    expect(after.subtitleLabel).toBe(before.subtitleLabel);
    expect(engine.snapshot().notice).toBeNull();
  });

  it('mutes without zeroing the level, so unmuting needs no memory of ours', async () => {
    // 23f's mechanism, and the reason CastGood can promise to remember nothing: the set
    // holds `muted` and `level` as two independent facts. Measured on the `AI PONT`.
    await start({ volumeLevel: 0.45 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.45);

    receiver.changeVolumeExternally(0.45, true);
    await waitFor(() => muted() === true, 8_000);
    expect(level()).toBe(0.45);
  }, 20_000);
});
