import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import {
  tcpTransportFactory,
  type CastTransport,
  type TransportFactory,
} from '../../src/engine/cast/index.js';
import { createMemorySink, systemClock, type LogRecord } from '../../src/engine/logging/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';
import { TIMING } from '../../src/engine/config.js';

/**
 * **Defect D2 — the film starves after a real network drop, and the app never says so.**
 *
 * Found on the founder's own hardware on 2026-08-27 by pulling the Ethernet cable out for
 * 24 seconds, with a film playing and subtitles on. What the log showed:
 *
 *  - the **control** channel recovered perfectly — `cast.rejoined` 243 ms after the
 *    address came back, the device reporting `PLAYING`;
 *  - the **television's own byte connection** had been reset six seconds into the outage
 *    (`ECONNRESET`), and after the network returned it asked this PC for **zero** bytes;
 *  - the film played out the ~23 s it had buffered and froze;
 *  - and then the app looped — ~75 rejoin-then-drop cycles, each logging a fresh
 *    `deadlineMs: 30000`, so the 30 s deadline 11c hangs *"Lost connection"* on never
 *    expired. The founder pressed stop after a minute of spinner.
 *
 * **Why nothing caught it, and why this file exists.** `--outage socket` and
 * `--outage heartbeat` kill *our own* connection while the media server stays reachable
 * the whole time, so the device's byte connection is never broken and this defect cannot
 * occur in either. And the fake receiver fetched a few kilobytes once and then advanced
 * its playhead on wall-clock time whatever happened to the bytes, so a television whose
 * stream had been reset went on "playing" perfectly happily.
 *
 * So the instrument had to be built before the fix: a television that **streams the film**
 * (`setStreamsFilm`) and starves when that stream dies, and an outage that takes the
 * device's route to this PC away *and gives it back* — `engine.unsafeMediaBlackout` for
 * the bytes, a partitioned transport for the control channel. Every test below was watched
 * red against the behaviour on `main` before the fix went in.
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
 * The control channel's half of the outage: live sockets die and new ones are refused.
 *
 * A cable pull takes both halves at once. This is the half the harness has always been
 * able to produce; `unsafeMediaBlackout` is the half it never could, and D2 lives entirely
 * in the second one.
 */
interface Partition {
  readonly factory: TransportFactory;
  unplug(): void;
  replug(): void;
}

function partitionable(inner: TransportFactory): Partition {
  let cut = false;
  const live = new Set<CastTransport>();
  return {
    factory: async (options, handlers) => {
      if (cut) throw new Error('EHOSTUNREACH: this PC has no route to the television');
      const transport = await inner(options, handlers);
      live.add(transport);
      return transport;
    },
    unplug() {
      cut = true;
      for (const transport of live) transport.close();
      live.clear();
    },
    replug() {
      cut = false;
    },
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/**
 * A film big enough to still be arriving, written sparse so it costs nothing.
 *
 * **16 MB rather than the usual 4 KB, and it is load-bearing.** The receiver here reads at
 * something like playback speed, and a delivery that finishes is not one an outage can
 * interrupt — a small fixture would leave no film in flight to break, which is exactly the
 * shape of "a fixture kinder than the house" that D2 is the ninth of.
 */
async function writeFixtureMp4(target: string): Promise<void> {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(900_000, 16);
  const ftyp = box('ftyp', Buffer.from('isom'));
  const mdatBytes = 16 * 1024 * 1024;
  const mdatHeader = Buffer.alloc(8);
  mdatHeader.writeUInt32BE(mdatBytes + 8, 0);
  mdatHeader.write('mdat', 4, 'latin1');
  const moov = box('moov', box('mvhd', mvhd));
  const handle = await fsp.open(target, 'w');
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

const SRT = `1
00:00:05,000 --> 00:00:09,000
The first line.

2
00:01:00,000 --> 00:01:04,000
A minute in.
`;

let root: string;
let films: string;
let filmPath: string;
let paths: AppPaths;
let receiver: FakeReceiver;
let engine: Engine;
let mdns: FakeMdns;
let partition: Partition;
let running: Engine[];
let sink: ReturnType<typeof createMemorySink>;

/** Every log record of one kind, in order — how a run of recoveries is counted. */
function records(event: string): LogRecord[] {
  return sink.lines
    .map((line) => JSON.parse(line) as LogRecord)
    .filter((record) => record.event === event);
}

function open(): Engine {
  mdns = createFakeMdns();
  partition = partitionable(tcpTransportFactory);
  sink = createMemorySink();
  const made = createEngine({
    paths,
    clock: systemClock,
    logSink: sink,
    logLevel: 'debug',
    transport: partition.factory,
    mdns,
    mediaPort: 0,
  });
  running.push(made);
  return made;
}

function announce(): void {
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
}

async function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  what: string,
  timeoutMs = 15_000,
): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(
    `timed out waiting for ${what}; state ${engine.snapshot().session.state}, ` +
      `reconnecting ${String(engine.snapshot().session.flags.reconnecting)}`,
  );
}

async function until(predicate: () => boolean, what: string, timeoutMs = 15_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * **Wait on the television, not on our own belief about it.**
 *
 * Through an interruption the engine deliberately keeps showing *Playing* and keeps the
 * readout moving, because the film really does play on out of the device's own buffer
 * (SPIKE-2, and 11a's *"only the status line changes"*). So `session.state === 'playing'`
 * is a flag that never changed, and grading D2 against it passes on the very defect —
 * the app believing a film is playing while the television has starved. Every promise
 * about "the film is back" below is read off the fake television's own player state.
 */
function starved(): boolean {
  return receiver.playerState === 'BUFFERING';
}

function playingOnTheTelevision(): boolean {
  return receiver.playerState === 'PLAYING';
}

/**
 * **Playing, *and* the film is arriving.**
 *
 * A real receiver reports `PLAYING` off the first bytes of a setup request — the
 * `AI PONT` did so eighteen seconds before it opened the delivery that carries the film —
 * and so does this fake now that it models that shape. So "the film is back" is graded on
 * both halves: the set is playing and there is a delivery in flight for it to play from.
 */
function playingFromLiveBytes(): boolean {
  return receiver.playerState === 'PLAYING' && receiver.filmStreamAlive;
}

/** Every snapshot the engine pushed, so 11a is judged across the whole episode. */
interface Watcher {
  readonly notices: readonly string[];
  /** Every session state the founder's screen passed through, in order, without repeats. */
  readonly states: readonly string[];
  readonly sawReconnecting: boolean;
  stop(): void;
}

function watch(): Watcher {
  const notices: string[] = [];
  const states: string[] = [];
  let sawReconnecting = false;
  const unsubscribe = engine.subscribe((snapshot) => {
    const message = snapshot.notice?.message ?? null;
    if (message !== null && !notices.includes(message)) notices.push(message);
    if (states.at(-1) !== snapshot.session.state) states.push(snapshot.session.state);
    if (snapshot.session.flags.reconnecting) sawReconnecting = true;
  });
  return {
    notices,
    states,
    get sawReconnecting() {
      return sawReconnecting;
    },
    stop: unsubscribe,
  };
}

/** Put the film on the television, streaming the way a real one does, and let it settle. */
async function castStreamingFilm(
  options: { subtitles?: boolean; nudgeBeforeCast?: boolean } = {},
): Promise<void> {
  engine = open();
  await engine.start();
  announce();
  // Before the LOAD, so the very first delivery is the held one a real film produces.
  receiver.setStreamsFilm(true, { bufferSec: 1 });
  engine.dispatch({ type: 'file.select', path: filmPath });
  await waitFor((snapshot) => snapshot.file?.path === filmPath, 'the film to be read');
  if (options.subtitles === true) {
    const option = engine.snapshot().subtitles.options.find((entry) => entry.label === 'Cars.srt');
    if (option === undefined) throw new Error('no sidecar subtitle was offered');
    engine.dispatch({ type: 'subtitles.select', sourceId: option.id });
    await waitFor((snapshot) => !snapshot.subtitles.preparing, 'the subtitle to be read');
    if (options.nudgeBeforeCast !== false) {
      engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    }
  }
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitFor((snapshot) => snapshot.session.state === 'playing', 'the film to play');
  await until(() => receiver.filmStreamAlive, 'the television to be streaming the film');
}

/** The cable comes out: the television's route to this PC goes, both halves of it. */
function unplug(): void {
  engine.unsafeMediaBlackout(true);
  partition.unplug();
}

/** And goes back in. */
function replug(): void {
  engine.unsafeMediaBlackout(false);
  partition.replug();
}

function loads(): number {
  return receiver.received.filter((message) => message.type === 'LOAD').length;
}

function lastLoad(): Record<string, unknown> {
  const load = receiver.received.filter((message) => message.type === 'LOAD').at(-1);
  if (load === undefined) throw new Error('no LOAD reached the receiver');
  return load.payload;
}

interface DeclaredTrack {
  trackId: number;
  trackContentId: string;
}

function declaredTracks(load = lastLoad()): DeclaredTrack[] {
  const media = load['media'] as { tracks?: DeclaredTrack[] };
  return media.tracks ?? [];
}

/** The offset, in milliseconds, of the rung the television was told to show. */
function activeOffsetOnTheWire(load = lastLoad()): number | null {
  const active = (load['activeTrackIds'] as number[] | undefined)?.[0];
  const track = declaredTracks(load).find((candidate) => candidate.trackId === active);
  if (track === undefined) return null;
  const name = track.trackContentId.slice(track.trackContentId.lastIndexOf('/') + 1);
  return Number(name.replace('.vtt', ''));
}

/**
 * The offset of the rung the television is **showing right now**, which is not the same
 * question as `activeOffsetOnTheWire()`. A nudge inside the ladder is an `EDIT_TRACKS_INFO`,
 * so the LOAD the set is holding still names the rung it was loaded at; only the receiver's
 * own `activeTrackIds` moves.
 */
function liveOffsetOnTheWire(): number | null {
  const active = receiver.activeTrackIds[0];
  const track = declaredTracks().find((candidate) => candidate.trackId === active);
  if (track === undefined) return null;
  const name = track.trackContentId.slice(track.trackContentId.lastIndexOf('/') + 1);
  return Number(name.replace('.vtt', ''));
}

/** Fetch a URL the way the television would, and report only what came back. */
function statusOf(url: string, range?: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.get(
      url,
      { headers: range === undefined ? {} : { Range: range } },
      (response) => {
        const status = response.statusCode ?? 0;
        response.destroy();
        resolve(status);
      },
    );
    request.on('error', reject);
    request.end();
  });
}

beforeEach(async () => {
  running = [];
  receiver = await startFakeReceiver({ durationSec: 900 });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-d2-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
  filmPath = path.join(films, 'Cars.mp4');
  await writeFixtureMp4(filmPath);
  await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
  paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: root } });
});

afterEach(async () => {
  for (const started of running) await started.stop().catch(() => undefined);
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('D2 — the film has to come back, not just our connection to it', () => {
  it('is measured against an outage that can actually break the television’s byte connection', async () => {
    await castStreamingFilm();

    // The fixture's own calibration, and it is the assertion this whole file rests on: the
    // television really is holding a delivery open, so there is something for an outage to
    // break. Against the old fake — a few kilobytes and hang up — this reads `false`, and
    // every promise below would be graded on a condition that never happened.
    expect(receiver.filmStreamAlive).toBe(true);
    expect(receiver.filmStreamBreaks).toBe(0);

    unplug();
    await until(() => !receiver.filmStreamAlive, 'the television’s byte connection to die');
    expect(receiver.filmStreamBreaks).toBe(1);
    // And the film really stops, which is the condition D2 is about. Against the fake as
    // it was on `main` — a playhead that advanced on wall-clock time whatever happened to
    // the bytes — this never becomes true and every promise below is unfalsifiable.
    await until(starved, 'the television to starve');
  }, 40_000);

  it('brings the film back within 10 s of the network returning, with nobody pressing anything', async () => {
    await castStreamingFilm();
    const watcher = watch();
    const loadsBefore = loads();
    const streamsBefore = receiver.filmStreamAttempts;

    unplug();
    // The buffer runs out while the network is away, exactly as it did in the house: the
    // television stops playing and sits in BUFFERING. **This is the defect's condition**,
    // and a run where it never happened has proved nothing.
    await until(starved, 'the television to starve');

    replug();
    const networkBackAt = Date.now();
    // 11b: *the film*, not our socket. On `main` the control channel rejoins in
    // milliseconds and the television never asks for another byte, so this wait times out.
    //
    // **Both halves of "playing"**: a receiver reports `PLAYING` off the first bytes of a
    // setup request — the `AI PONT` did so eighteen seconds before its real delivery opened
    // — so the picture being back is graded together with a delivery being in flight.
    await until(playingFromLiveBytes, 'the film to be playing on the television again');
    const resumedMs = Date.now() - networkBackAt;

    expect(resumedMs).toBeLessThanOrEqual(10_000);
    // The television went and got the film again — because it was handed it again. One
    // repair, not a loop of them.
    expect(receiver.filmStreamAttempts).toBe(streamsBefore + 1);
    expect(loads()).toBe(loadsBefore + 1);
    expect(receiver.filmStreamAlive).toBe(true);
    // 11a, across every snapshot of the episode rather than the one at the end: nothing
    // turned red, no dialog opened, and the film and its place stayed on screen.
    expect(watcher.notices).toEqual([]);
    expect(watcher.sawReconnecting).toBe(true);
    expect(engine.snapshot().file?.name).toBe('Cars.mp4');
    watcher.stop();
  }, 60_000);

  it('picks the film up where the television actually got to, not where the cable came out', async () => {
    await castStreamingFilm();
    await settle(1_200);
    const beforeSec = engine.snapshot().session.positionSec;

    unplug();
    await until(starved, 'the television to starve');
    await settle(1_500);
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');

    // 11b: within 2 s of the lost position. The television played on out of its own buffer
    // while the network was away, so the position it comes back at is *ahead* of where the
    // cable came out — rewinding it to the drop would be its own visible fault.
    const load = lastLoad();
    const startedAt = Number(load['currentTime']);
    expect(startedAt).toBeGreaterThanOrEqual(beforeSec);
    expect(Math.abs(engine.snapshot().session.positionSec - startedAt)).toBeLessThanOrEqual(2);
  }, 60_000);

  it('proves the media server was answering the whole time — the television simply never asked', async () => {
    await castStreamingFilm();
    const url = receiver.received
      .filter((message) => message.type === 'LOAD')
      .map((message) => (message.payload['media'] as { contentId?: string }).contentId)
      .at(-1);
    expect(url).toBeDefined();

    unplug();
    await until(starved, 'the television to starve');
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');

    // The **mechanism**, stated as a measurement rather than as a hypothesis: our listening
    // socket is bound to `0.0.0.0`, nothing in the app tells it about a network change, and
    // the mount was never let go of — so the same URL the television was holding is
    // answered on demand. What was broken was on the television, and only a fresh LOAD
    // mends it.
    //
    // (The URL here is the *repaired* one; the point is that the server was reachable at
    // every moment either side of the outage, from this process, over TCP.)
    const repaired = receiver.received
      .filter((message) => message.type === 'LOAD')
      .map((message) => (message.payload['media'] as { contentId?: string }).contentId)
      .at(-1);
    expect(await statusOf(String(repaired), 'bytes=0-')).toBe(206);
  }, 60_000);

  it('leaves a television that mends its own byte connection alone', async () => {
    // The kind receiver: it goes back for the bytes by itself when its stream dies. It
    // needs no repair, and issuing one would be a reload the founder never asked for.
    await castStreamingFilm();
    receiver.setRefetchesAfterStreamBreak(true);
    const loadsBefore = loads();

    unplug();
    await until(() => !receiver.filmStreamAlive, 'the byte connection to die');
    replug();
    await until(() => receiver.filmStreamAlive, 'the television to be streaming again');
    // Past the grace, so a repair that was going to fire has fired.
    await settle(4_000);

    expect(playingOnTheTelevision()).toBe(true);
    expect(loads()).toBe(loadsBefore);
  }, 60_000);

  it('is not mistaken for the television abandoning the film', async () => {
    // **The defect this test exists for, seen on the `Family room TV` on 2026-08-28.**
    //
    // The repair worked: `media.first_request` on the new mount, `cast.loaded` with
    // `playerState: PLAYING`, the film genuinely running again. And 101 ms after the repair
    // LOAD the set reported `IDLE`/`INTERRUPTED` **for the media session the repair had
    // just superseded** — which is simply what a receiver says when a new LOAD replaces the
    // old media — and the session read it as the film stopping: `playing → stopped`,
    // `session.refused_mid_play`, and 13g's guard then correctly voided every one of the
    // run's 18 promises. The founder would have seen *Stopped* flash mid-recovery.
    await castStreamingFilm();
    const watcher = watch();
    const supersededBefore = receiver.supersededIdles;

    unplug();
    await until(starved, 'the television to starve');
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');
    // **Waited for, and this is the barrier the assertions below need.** The founder's log
    // wrote its `refused_mid_play` a full 2 s after the repair LOAD, because a log line is
    // an *effect* and effects run on the session's queue behind whatever is on it — the
    // LOAD itself, that evening. Both outcomes of this decision are logged from the same
    // reducer path, so waiting for the one that should happen is a fair wait for the one
    // that should not.
    await until(
      () => records('session.idle_ignored_during_live_load').length > 0,
      'the television’s answer to the repair LOAD to be read and logged',
    );
    await settle(2_000);

    // **The fixture's own calibration, and the assertion the rest of this test rests on.**
    // The television really did answer the repair the way the `AI PONT` did. Against a fake
    // that goes straight to the new media session — which is what this one did for ten
    // builds — nothing below can fail, however broken the app is.
    expect(receiver.supersededIdles).toBe(supersededBefore + 1);

    // 13g means what it says: a refusal is a television abandoning a film. A LOAD of our
    // own being acknowledged is not one, and writing this line for it makes every scenario
    // that meets it unreadable.
    expect(records('session.refused_mid_play')).toEqual([]);
    // The reducer knew whose LOAD it was, rather than guessing from `idleReason`.
    const ignored = records('session.idle_ignored_during_live_load');
    expect(ignored.length).toBeGreaterThanOrEqual(1);
    expect(ignored.map((record) => record['why'])).toEqual(ignored.map(() => 'repair'));
    expect(ignored[0]?.['idleReason']).toBe('INTERRUPTED');
    // 11a, across every snapshot of the episode: the film and its place stayed on screen
    // and only the status line changed. *Stopped* is not a status line — it is the end of
    // the evening, and it is what the founder would have seen flash past mid-recovery.
    expect(watcher.states.filter((state) => ['stopped', 'idle', 'ended'].includes(state))).toEqual(
      [],
    );
    expect(watcher.notices).toEqual([]);
    expect(engine.snapshot().session.state).toBe('playing');
    watcher.stop();
  }, 60_000);

  it('still catches a television that really does abandon the film during a recovery', async () => {
    // **The other direction, and it matters more than the first.** A fix that simply stopped
    // trusting `IDLE` would be worse than the bug: 13g exists because a run once scored 9/9
    // against a film that had been dead for twenty seconds. So the deafness lasts exactly as
    // long as our own LOAD is in flight, and a set that quits *after* the repair — the
    // hardest case, because the app is still inside the interruption — is still caught.
    await castStreamingFilm();
    unplug();
    await until(starved, 'the television to starve');
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');
    await settle(1_500);
    expect(records('session.refused_mid_play')).toEqual([]);

    // The repaired film now dies on the television: IDLE/ERROR, mid-play, the shape 13g is
    // written about.
    receiver.failMedia();

    await waitFor((snapshot) => snapshot.notice !== null, 'the founder to be told', 15_000);
    expect(engine.snapshot().notice?.message).toBe('The TV stopped playing this file');
    expect(engine.snapshot().session.state).toBe('stopped');
    // **Waited for, not read straight off.** The screen changes synchronously in the
    // reducer; the log line is an *effect*, and effects run on the session's queue behind
    // whatever is already on it — the STOP and the release, here. Reading immediately
    // passed alone and failed under a loaded machine, which is an instrument fault rather
    // than a product one.
    await until(
      () => records('session.refused_mid_play').length > 0,
      'the refusal to be written to the log',
    );
    const refusals = records('session.refused_mid_play');
    expect(refusals.length).toBe(1);
    expect(refusals[0]?.['idleReason']).toBe('ERROR');
    // The position is the one 13g asks for: where the film had got to, not zero.
    expect(Number(refusals[0]?.['positionSec'])).toBeGreaterThan(0);
    // And it is still the founder's place afterwards.
    expect(engine.snapshot().session.resumePositionSec).toBeGreaterThan(0);
  }, 60_000);

  it('issues no LOAD at all when only our own socket died — 12a is untouched', async () => {
    await castStreamingFilm();
    const loadsBefore = loads();
    const streamsBefore = receiver.filmStreamAttempts;

    // `--outage socket`: our connection dies and the television's byte connection does
    // not. This is the case that has always passed, and it must keep passing silently.
    const watcher = watch();
    receiver.dropConnections();
    await until(() => watcher.sawReconnecting, 'the app to notice its own socket die');
    await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 'the app to rejoin');
    // Well past the repair grace, so a repair that was going to fire has fired.
    await settle(4_000);

    expect(receiver.filmStreamAlive).toBe(true);
    expect(receiver.filmStreamAttempts).toBe(streamsBefore);
    expect(loads()).toBe(loadsBefore);
    expect(playingOnTheTelevision()).toBe(true);
    watcher.stop();
  }, 60_000);
});

describe('D2 — the interruption that surfaces after the check has already looked (11b)', () => {
  /**
   * **The 229 ms race, and it cost the founder 32 seconds.**
   *
   * `Family room TV`, 2026-08-28, 22 s of cable out. The route came back at `05:27:08.876`
   * and the control channel rejoined 171 ms later. The post-rejoin check looked at the
   * film's byte path and **saw a healthy delivery** — because a black-holed socket is one
   * neither end has been told about yet. `media.delivery_interrupted` was recorded at
   * `05:27:11.276`, **229 ms after the check**, and nothing was watching by then. The
   * repair fell through to the stall route: the buffer ran dry at `05:27:37`, ten seconds
   * of buffering, `recovery_started {cause: "stalled"}`, and the film finally played again
   * at `05:27:50.835` — **41.96 s** against 11b's ten.
   *
   * **When a dead socket becomes observable is not ours to choose.** It surfaced *six
   * seconds into* the outage on 2026-08-27 and *2.4 s after the rejoin* on 2026-08-28; it
   * depends on the OS and on the network. So the fix is not a longer grace — that trades
   * one arbitrary number for another and slows every healthy recovery — but a **watch**:
   * for a bounded window after a rejoin, an interruption *arriving* is looked at.
   *
   * This is the fixture half of it. `stallFilmStream()` takes the bytes away without
   * closing anything, so the media server still counts a delivery in flight while the
   * check looks; `breakFilmStreamNow()` lets the reset surface at the instant the test
   * chooses, which is what makes the race reproducible rather than lucky.
   */
  async function outageWhoseResetSurfacesLate(): Promise<number> {
    // The cable comes out. Nothing is closed — bytes simply stop arriving, at both ends.
    receiver.stallFilmStream();
    partition.unplug();
    await until(starved, 'the television to starve');
    await settle(800);

    partition.replug();
    const networkBackAt = Date.now();
    await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 'the app to rejoin');
    // The check has now looked, and it saw a delivery in flight, because there was one.
    expect(records('media.path_suspect')).toEqual([]);
    await settle(300);
    // …and *now* the reset surfaces, 300 ms after the check — the house's 229.
    receiver.breakFilmStreamNow();
    return networkBackAt;
  }

  it('hands the film back within 10 s of the route returning, not 42', async () => {
    await castStreamingFilm();
    const watcher = watch();
    const loadsBefore = loads();
    const networkBackAt = await outageWhoseResetSurfacesLate();

    await until(playingFromLiveBytes, 'the film to be playing on the television again', 40_000);
    const resumedMs = Date.now() - networkBackAt;

    // **11b, measured the way the founder measures it**: from the network coming back to
    // the film running again. On `main` this waits for the buffer to run dry, ten seconds
    // of buffering and a stalled recovery, and lands far past ten seconds.
    expect(resumedMs).toBeLessThanOrEqual(10_000);
    expect(loads()).toBe(loadsBefore + 1);
    expect(receiver.filmStreamAlive).toBe(true);

    // The repair came through the **watch**, not through the stall route — the two are
    // 32 seconds apart on the founder's screen and identical at the end of the run, so
    // the route is asserted rather than the outcome alone.
    const suspects = records('media.path_suspect');
    expect(suspects.length).toBe(1);
    expect(suspects[0]?.['trigger']).toBe('interruption');
    expect(
      records('session.recovery_started').filter((record) => record['cause'] === 'stalled'),
    ).toEqual([]);

    // 11a: nothing turned red and nothing was said, all the way through.
    expect(watcher.notices).toEqual([]);
    expect(watcher.states.filter((state) => ['stopped', 'idle', 'ended'].includes(state))).toEqual(
      [],
    );
    watcher.stop();
  }, 90_000);

  it('picks it up where the television got to, with the words still corrected (11b, 18h)', async () => {
    await castStreamingFilm({ subtitles: true });
    expect(activeOffsetOnTheWire()).toBe(1_000);
    const beforeSec = engine.snapshot().session.positionSec;

    await outageWhoseResetSurfacesLate();
    await until(playingFromLiveBytes, 'the film to be playing again', 40_000);

    // 11b's other half — within 2 s of the lost position, and never rewound behind it.
    const startedAt = Number(lastLoad()['currentTime']);
    expect(startedAt).toBeGreaterThanOrEqual(beforeSec);
    expect(Math.abs(engine.snapshot().session.positionSec - startedAt)).toBeLessThanOrEqual(2);
    // 18h rides on this repair exactly as it rides on the other one.
    expect(activeOffsetOnTheWire()).toBe(1_000);
    expect(declaredTracks().length).toBe(13);
  }, 90_000);

  it('leaves a film whose delivery survived the outage completely alone', async () => {
    // **The conservative constraint, and it is the one that binds.** A repair must never
    // reload a film that is playing perfectly well. Our own socket dies, the television's
    // byte connection does not, and the watch opens and closes having done nothing.
    await castStreamingFilm();
    const loadsBefore = loads();
    const streamsBefore = receiver.filmStreamAttempts;
    const watcher = watch();

    partition.unplug();
    await until(() => watcher.sawReconnecting, 'the app to notice its own socket die');
    partition.replug();
    await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 'the app to rejoin');
    // Past the whole watch window **and** the grace behind it, so anything that was going
    // to fire has fired.
    await settle(TIMING.mediaRepairWatchMs + TIMING.mediaRepairGraceMs + 2_000);

    expect(records('media.path_suspect')).toEqual([]);
    expect(loads()).toBe(loadsBefore);
    expect(receiver.filmStreamAttempts).toBe(streamsBefore);
    expect(receiver.filmStreamAlive).toBe(true);
    expect(playingOnTheTelevision()).toBe(true);
    watcher.stop();
  }, 90_000);

  it('does not read an interruption from before the outage as this outage’s', async () => {
    // A seek abandons a delivery every time, and a television that came straight back for
    // a new range is healthy. An outage later must not repair on the strength of that old
    // scar.
    await castStreamingFilm();
    receiver.setRefetchesAfterStreamBreak(true);
    const breaksBefore = receiver.filmStreamBreaks;
    receiver.breakFilmStreamNow();
    // **Waited for, both halves.** `filmStreamAlive` is still true for the tick between a
    // socket being destroyed and its `close` arriving, so reading it straight after the
    // break passes on the connection that was just killed. That is an instrument fault of
    // exactly the kind this project keeps meeting.
    await until(() => receiver.filmStreamBreaks > breaksBefore, 'the byte connection to die');
    await until(() => receiver.filmStreamAlive, 'the television to come back for the film');
    const loadsBefore = loads();
    expect(records('media.delivery_interrupted').length).toBeGreaterThan(0);

    partition.unplug();
    await waitFor((snapshot) => snapshot.session.flags.reconnecting, 'the app to notice');
    partition.replug();
    await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 'the app to rejoin');
    await settle(TIMING.mediaRepairWatchMs + TIMING.mediaRepairGraceMs + 2_000);

    expect(records('media.path_suspect')).toEqual([]);
    expect(loads()).toBe(loadsBefore);
  }, 90_000);

  it('stands down when the television mends its own byte connection inside the window', async () => {
    // The interruption arrives late, inside the watch — and then the set goes back for the
    // bytes by itself. Reloading a film that was coming back anyway is a stutter nobody
    // asked for, so the watch says so in the log and does nothing.
    await castStreamingFilm();
    receiver.setRefetchesAfterStreamBreak(true);
    const loadsBefore = loads();

    receiver.stallFilmStream();
    partition.unplug();
    await waitFor((snapshot) => snapshot.session.flags.reconnecting, 'the app to notice');
    partition.replug();
    await waitFor((snapshot) => !snapshot.session.flags.reconnecting, 'the app to rejoin');
    await settle(300);
    receiver.breakFilmStreamNow();

    await until(
      () => records('media.path_recovered').length > 0,
      'the app to notice the television came back by itself',
      20_000,
    );
    await settle(2_000);
    expect(loads()).toBe(loadsBefore);
    expect(playingOnTheTelevision()).toBe(true);
  }, 90_000);
});

describe('D2 — a run of failing recoveries shares one deadline (fault 2)', () => {
  /**
   * The evening's second half, and the half that is not optional.
   *
   * The control channel comes back and the television's route to the bytes does not — the
   * cable is half in, the router is up but this PC is firewalled, the set has lost its own
   * wifi. Recovery *succeeds* every time and the film never plays, which is precisely the
   * shape that made 11c unreachable: every attempt logged a fresh `deadlineMs: 30000`.
   */
  async function halfMended(): Promise<number> {
    await castStreamingFilm();
    // The instant the trouble starts, which is the instant 11c's thirty seconds runs from.
    const troubleAt = Date.now();
    unplug();
    await until(starved, 'the television to starve');
    // Only the control channel comes back. The bytes stay away.
    partition.replug();
    return troubleAt;
  }

  it('says "Lost connection" after about 30 s — once, rather than never', async () => {
    const troubleAt = await halfMended();

    await until(
      () => engine.snapshot().notice !== null,
      'the founder to be told the connection was lost',
      60_000,
    );
    const saidAfterMs = Date.now() - troubleAt;
    const notice = engine.snapshot().notice;

    // 11c: **after ~30 s and not before.** On `main` this never arrives at all: each
    // recovery restarts the deadline, so the founder watches a spinner until they press
    // stop. The upper bound is generous because 11e waits ten seconds on a buffer before
    // it calls anything wrong; the lower bound is the half of the criterion that says
    // nothing may be said early.
    expect(saidAfterMs).toBeGreaterThanOrEqual(25_000);
    expect(saidAfterMs).toBeLessThanOrEqual(50_000);
    expect(notice?.message ?? '').toContain('Lost connection');
    // …and it states the saved position as a number, with a way back in.
    expect(notice?.actionLabel).toBe('Reconnect');
    expect(engine.snapshot().session.resumePositionSec).toBeGreaterThan(0);
  }, 90_000);

  it('does not thrash: the deadline is never restarted and the cycles are countable', async () => {
    await halfMended();

    await until(
      () => engine.snapshot().notice !== null,
      'the founder to be told the connection was lost',
      60_000,
    );

    const started = records('session.recovery_started');
    expect(started.length).toBeGreaterThan(0);
    // **The deadline is not restarted.** Every attempt after the first must show less of
    // the run's deadline left than the one before it. On `main` every one of the seventy-six
    // cycles logged the full 30,000 ms, which is the defect stated as a number.
    const remaining = started.map((record) => Number(record['deadlineInMs']));
    for (let index = 1; index < remaining.length; index += 1) {
      expect(remaining[index]).toBeLessThan(Number(remaining[index - 1]));
    }
    // **And the cycles are countable.** The founder's log had ~75 rejoin-then-drop cycles
    // in twenty seconds — 2.5 a second — because a rejoin into *Buffering* inherited a
    // stopwatch that was already past 11e's ten seconds. One attempt per ten seconds of
    // unresolved buffer is the honest rate; five leaves room for the first `lost` attempt
    // and for a slow machine.
    expect(started.length).toBeLessThanOrEqual(5);
    // It ended by saying something, once, rather than by looping.
    expect(records('session.connection_lost').length).toBe(1);
  }, 90_000);
});

describe('D2 — 18h and 19a ride on whatever repairs the film', () => {
  it('brings the subtitle and its correction back with the film', async () => {
    await castStreamingFilm({ subtitles: true });
    // Two presses of *Later*: +1.0 s, the correction the founder had set in the house.
    expect(activeOffsetOnTheWire()).toBe(1_000);

    unplug();
    await until(starved, 'the television to starve');
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');

    // 18h: the words come back **with the film**, from the same source, at the same rung.
    // The repair is a fresh LOAD, so it must declare the ladder around the correction the
    // founder had — a repair that landed them back at *in sync* would silently undo it.
    expect(activeOffsetOnTheWire()).toBe(1_000);
    expect(declaredTracks().length).toBe(13);
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
    // And the television could actually fetch what it was declared.
    const active = declaredTracks().find(
      (track) => track.trackId === (lastLoad()['activeTrackIds'] as number[])[0],
    );
    expect(await statusOf(String(active?.trackContentId))).toBe(200);
  }, 60_000);

  it('keeps a correction made **while the film was playing** — the switch path (18h)', async () => {
    // The test above nudges before Cast, so the very first LOAD already carries +1.0 s and
    // the ladder is centred on it. That is not how a founder finds a timing problem: they
    // find it *watching*, and the press that fixes it is served by a **track switch** on a
    // ladder already declared at zero — the cheap path 20b exists for, and the one the
    // 2026-09-02 `Master bedroom TV` run caught re-loading at 0.
    await castStreamingFilm({ subtitles: true, nudgeBeforeCast: false });
    expect(activeOffsetOnTheWire()).toBe(0);
    const loadsBeforeTheNudge = loads();

    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    await until(() => liveOffsetOnTheWire() === 1_000, 'the track switch to reach the television');
    // 20b: it really was a switch and not a reload — the film never stopped, and the LOAD
    // the set is holding still names rung zero. If this ever becomes a LOAD, the defect
    // below cannot arise and this test would be proving nothing.
    expect(loads()).toBe(loadsBeforeTheNudge);
    expect(activeOffsetOnTheWire()).toBe(0);

    unplug();
    await until(starved, 'the television to starve');
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');

    // The repair is a fresh LOAD. It must centre the ladder on where the founder actually
    // is, not on where the last LOAD left them.
    expect(loads()).toBe(loadsBeforeTheNudge + 1);
    expect(activeOffsetOnTheWire()).toBe(1_000);
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
  }, 60_000);

  it('never puts words on a film the founder left subtitles off for — 19a', async () => {
    await castStreamingFilm();
    expect(declaredTracks().length).toBe(0);

    unplug();
    await until(starved, 'the television to starve');
    replug();
    await until(playingOnTheTelevision, 'the film to be playing again');

    // The repair issued a LOAD, and 19a says that LOAD is byte-for-byte the one this app
    // would have sent before M3c existed: no `tracks`, no `activeTrackIds`, nothing.
    expect(loads()).toBe(2);
    expect(declaredTracks().length).toBe(0);
    expect(lastLoad()['activeTrackIds']).toBeUndefined();
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
  }, 60_000);
});
