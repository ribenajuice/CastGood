import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import { cueAt, parseCues } from '../../src/engine/subtitles/cues.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * **M3c step 5 — seeking, recovery and the remembered offset.** 18i, 18h, 20f, 20g.
 *
 * Everything here is about a subtitle that has to still be right *after* something happened:
 * the founder jumped twenty minutes, the wifi blipped, the window was closed and reopened,
 * or a week went by. The film and its position have had this treatment since M2; the words
 * had not, and 18h has been an open gap since M3b.
 *
 * **What this file may claim** is what a fake receiver and a real media server can answer
 * between them: which cue belongs at the position the *device* reported after a jump; that a
 * recovery, a resume, a *Take it back* and a reattach all put the same source back at the
 * same rung; that the correction survives the engine being torn down and rebuilt against the
 * same settings file; and that none of it ever writes anything of the founder's.
 *
 * **What it cannot claim** is 18i's own sentence — that the words a person can *read* moved
 * with the picture. Only a person can read a television. What is measured here is the cue
 * list the television was actually handed, taken back off CastGood's own media server over
 * HTTP, and compared against where the device says it is.
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
  mvhd.writeUInt32BE(900_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

const FILM_SEC = 900;

/**
 * A downloaded subtitle, spread across the film so that a jump has somewhere to land.
 *
 * Cue windows are deliberately several seconds wide and several minutes apart: 18i's promise
 * is *within 1 s of the new position*, and a fixture whose cues were 200 ms long could be
 * passed by luck and failed by rounding.
 */
const SRT = `1
00:00:05,000 --> 00:00:08,000
Opening line.

2
00:02:00,000 --> 00:02:06,000
Two minutes in.

3
00:04:30,000 --> 00:04:40,000
Four and a half minutes in.

4
00:05:00,000 --> 00:05:06,000
Five minutes in.

5
00:10:00,000 --> 00:10:08,000
Ten minutes in.
`;

/** The same words, cut for another release: same file name, different timings. */
const OTHER_RELEASE_SRT = SRT.replace('00:00:05,000', '00:00:09,000').replace(
  '00:10:00,000',
  '00:10:04,000',
);

let root: string;
let films: string;
let filmPath: string;
let paths: AppPaths;
let receiver: FakeReceiver;
let running: Engine[];
let engine: Engine;
let mdns: FakeMdns;

function makeEngine(options: { mediaPort?: number } = {}): Engine {
  mdns = createFakeMdns();
  const made = createEngine({
    paths,
    logSink: createMemorySink(),
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    // Omitted on a reopened engine on purpose: it has to rebind the port the store
    // remembers, because the television is still fetching URLs that name it.
    ...(options.mediaPort === undefined ? {} : { mediaPort: options.mediaPort }),
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
  what = 'condition',
  timeoutMs = 10_000,
): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}; state ${engine.snapshot().session.state}`);
}

const settle = (ms = 700): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Start an engine, announce the television, and select the film. */
async function open(options: { mediaPort?: number } = {}): Promise<void> {
  engine = makeEngine(options);
  await engine.start();
  announce();
}

async function chooseFilm(file = filmPath): Promise<void> {
  engine.dispatch({ type: 'file.select', path: file });
  await waitFor((s) => s.file?.path === file, 'the film to be read');
}

async function chooseSubtitle(label: string): Promise<void> {
  const option = engine.snapshot().subtitles.options.find((entry) => entry.label === label);
  if (option === undefined) throw new Error(`no subtitle option labelled ${label}`);
  engine.dispatch({ type: 'subtitles.select', sourceId: option.id });
  await waitFor((s) => !s.subtitles.preparing, `${label} to be read`);
}

async function castAndPlay(): Promise<void> {
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitFor((s) => s.session.state === 'playing', 'the film to play');
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

/** The offsets, in milliseconds, of every rung the last LOAD declared. */
function declaredOffsets(load = lastLoad()): number[] {
  return declaredTracks(load).map((track) => {
    const name = track.trackContentId.slice(track.trackContentId.lastIndexOf('/') + 1);
    return Number(name.replace('.vtt', ''));
  });
}

/** The offset the television was told to *show* — the active rung of the declared ladder. */
function activeOffsetOnTheWire(load = lastLoad()): number | null {
  const active = (load['activeTrackIds'] as number[] | undefined)?.[0];
  const track = declaredTracks(load).find((candidate) => candidate.trackId === active);
  if (track === undefined) return null;
  const name = track.trackContentId.slice(track.trackContentId.lastIndexOf('/') + 1);
  return Number(name.replace('.vtt', ''));
}

/** GET a URL the television was handed, exactly as it would. */
function fetchText(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, (response) => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (body += chunk));
      response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
    });
    request.on('error', reject);
    request.end();
  });
}

/** The cues the television is holding for the rung it is showing. */
async function servedCues(): Promise<ReturnType<typeof parseCues>> {
  const load = lastLoad();
  const active = (load['activeTrackIds'] as number[] | undefined)?.[0];
  const track = declaredTracks(load).find((candidate) => candidate.trackId === active);
  if (track === undefined) throw new Error('no active track was declared');
  const response = await fetchText(track.trackContentId);
  expect(response.status).toBe(200);
  return parseCues(response.body);
}

beforeEach(async () => {
  running = [];
  receiver = await startFakeReceiver({ durationSec: FILM_SEC });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-m3c5-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
  filmPath = path.join(films, 'Cars.mp4');
  await fsp.writeFile(filmPath, fixtureMp4());
  await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
  paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: root } });
});

afterEach(async () => {
  for (const started of running) await started.stop().catch(() => undefined);
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('20f: the correction comes back with the source, and says so', () => {
  it('applies and states an offset set in a previous run of the app', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
    // Not a "shut down tidily and everything is fine" test: the correction is written on
    // the press, so this is the founder's PC losing power between the nudge and the credits.
    await engine.stop();

    await open();
    // **19a first, and it is the guard on everything else in this describe block.** A
    // remembered correction must not put words on a television: the control reads Off on
    // this film exactly as it would if nobody had ever nudged anything.
    await chooseFilm();
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
    expect(engine.snapshot().subtitles.timingRemembered).toBe(false);

    await chooseSubtitle('Cars.srt');
    const after = engine.snapshot().subtitles;
    expect(after.offsetMs).toBe(1_000);
    expect(after.timing).toBe('+1.0 s');
    // 20f: *applied **and stated***. The screen turns this into "as you set it last time".
    expect(after.timingRemembered).toBe(true);
  }, 30_000);

  it('remembers against the subtitle source, never against the film', async () => {
    // One subtitle file, kept away from both films, chosen for each of them in turn — the
    // shape 20f's "never against the film" is actually about.
    const shared = path.join(root, 'Subs', 'Shared.srt');
    await fsp.mkdir(path.dirname(shared), { recursive: true });
    await fsp.writeFile(shared, SRT);
    const second = path.join(films, 'Toys.mp4');
    await fsp.writeFile(second, fixtureMp4());
    await fsp.writeFile(path.join(films, 'Toys.srt'), SRT);

    await open({ mediaPort: 0 });
    await chooseFilm();
    engine.dispatch({ type: 'subtitles.chooseFile', path: shared });
    await waitFor((s) => !s.subtitles.preparing && s.subtitles.selectedId !== null, 'the pick');
    engine.dispatch({ type: 'subtitles.nudge', steps: -1 });
    expect(engine.snapshot().subtitles.offsetMs).toBe(-500);
    await engine.stop();

    await open();
    // A different film entirely, and the same words.
    await chooseFilm(second);
    engine.dispatch({ type: 'subtitles.chooseFile', path: shared });
    await waitFor((s) => !s.subtitles.preparing && s.subtitles.selectedId !== null, 'the pick');
    expect(engine.snapshot().subtitles.offsetMs).toBe(-500);
    expect(engine.snapshot().subtitles.timingRemembered).toBe(true);

    // …and this film's *own* sidecar is a different source, so it is in sync and says
    // nothing. A correction that leaked from one file to another would be the app making a
    // perfectly good subtitle wrong.
    await chooseSubtitle('Toys.srt');
    expect(engine.snapshot().subtitles.offsetMs).toBe(0);
    expect(engine.snapshot().subtitles.timing).toBe('in sync');
    expect(engine.snapshot().subtitles.timingRemembered).toBe(false);
  }, 30_000);

  it('forgets it when the founder presses Reset', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 3 });
    engine.dispatch({ type: 'subtitles.resetTiming' });
    expect(engine.snapshot().subtitles.timing).toBe('in sync');
    await engine.stop();

    await open();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    // Reset is the founder saying *these words are in time*. Next week it must arrive in
    // sync with nothing said about it — a stored zero would be a correction of nothing.
    expect(engine.snapshot().subtitles.offsetMs).toBe(0);
    expect(engine.snapshot().subtitles.timingRemembered).toBe(false);
  }, 30_000);

  it('keeps it through turning subtitles off, which is not the same as Reset', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    engine.dispatch({ type: 'subtitles.clear' });
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
    // Off says nothing about whether that file is out of time. Choosing it again — in the
    // same evening, which is what 19b's "turn them back on" is — gets the correction back.
    await chooseSubtitle('Cars.srt');
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
  }, 30_000);

  it('does not apply a correction to words it was not set against', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    await engine.stop();

    // The founder found the subtitle cut for the release they actually own and dropped it
    // in over the old one. Same path, same name, different timings — and last week's
    // +1.0 s would make a correct file wrong.
    await fsp.writeFile(path.join(films, 'Cars.srt'), OTHER_RELEASE_SRT);

    await open();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    expect(engine.snapshot().subtitles.offsetMs).toBe(0);
    expect(engine.snapshot().subtitles.timingRemembered).toBe(false);
  }, 30_000);

  it('does not put a track on the wire for a film cast without one', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    await engine.stop();

    await open();
    await chooseFilm();
    await castAndPlay();
    // 19a, on the wire, with a remembered correction sitting in the store: no tracks key,
    // no active track, nothing fetched. The memory changes a number on a screen the founder
    // opened; it can never change what pressing Cast means.
    const media = lastLoad()['media'] as Record<string, unknown>;
    expect(Object.keys(media)).not.toContain('tracks');
    expect(receiver.trackFetches).toHaveLength(0);
  }, 30_000);
});

describe('18h: the subtitles come back with the film', () => {
  it('survives a wifi blip with the ladder intact — the next nudge is still a switch', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await castAndPlay();
    await settle(600);
    const loadsBefore = receiver.countOf('LOAD');
    expect(activeOffsetOnTheWire()).toBe(500);

    // The blip: the socket goes, the television plays on, and the app reconnects and
    // rejoins the session that is still running (11a).
    receiver.dropConnections();
    await waitFor(
      (s) => s.session.state === 'playing' && !s.session.flags.reconnecting,
      'recovery',
    );
    await settle(600);

    const after = engine.snapshot().subtitles;
    expect(after.selectedLabel).toBe('Cars.srt');
    expect(after.offsetMs).toBe(500);
    // The words are still on the set — nothing turned them off and nothing reloaded.
    expect(receiver.activeTrackIds).toHaveLength(1);
    expect(receiver.countOf('LOAD')).toBe(loadsBefore);

    // And the ladder is still ours: one more press is a track switch, not a reload.
    const edits = receiver.editTracksCount;
    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await settle(1_200);
    expect(receiver.editTracksCount).toBe(edits + 1);
    expect(receiver.countOf('LOAD')).toBe(loadsBefore);
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
  }, 40_000);

  it('comes back with Resume from <position>, from the same source at the same rung', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    await castAndPlay();
    await settle(1_200);

    engine.dispatch({ type: 'cast.stop' });
    await waitFor((s) => s.session.state === 'stopped', 'the film to stop');
    const resumeFrom = engine.snapshot().session.resumePositionSec;

    engine.dispatch({ type: 'cast.resume' });
    await waitFor((s) => s.session.state === 'playing', 'the film to resume');
    await settle(600);

    // 16c, with 18h's clause: the same source, still in time, **with the correction still
    // applied** — the resumed LOAD declares a ladder centred where the founder left it and
    // names the same rung as active.
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
    expect(activeOffsetOnTheWire()).toBe(1_000);
    expect(declaredOffsets()).toContain(1_000);
    expect(resumeFrom).toBeGreaterThan(0);
    expect(engine.snapshot().session.subtitleLabel).toBe('Subtitles: Cars.srt');
  }, 40_000);

  it('comes back with Take it back after somebody else grabs the television', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: -2 });
    await castAndPlay();
    await settle(600);

    // 14a: a phone starts Prime Video. CastGood steps aside and never takes it back by
    // itself — the founder presses the button (14c), which is `cast.resume`.
    receiver.takeover({ appId: 'ABCD1234', appName: 'Prime Video', gapMs: 0 });
    await waitFor((s) => s.session.state !== 'playing', 'CastGood to yield');
    engine.dispatch({ type: 'cast.resume' });
    await waitFor((s) => s.session.state === 'playing', 'the film to come back');
    await settle(600);

    expect(engine.snapshot().subtitles.offsetMs).toBe(-1_000);
    expect(activeOffsetOnTheWire()).toBe(-1_000);
  }, 40_000);

  it('comes back after the window is closed and reopened, on the URLs the TV still holds', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await castAndPlay();
    await settle(1_200);
    const loadsBefore = receiver.countOf('LOAD');
    const trackUrlBefore = declaredTracks().map((track) => track.trackContentId);
    const port = engine.mediaServerPort;

    // The founder closed the window. The television keeps playing, words and all.
    await engine.stop({ keepPlaying: true });

    await open();
    await waitFor((s) => s.session.state === 'playing', 'the reopened app to rejoin', 15_000);
    // 18h: the subtitles come back with the film, from the same source, at the same rung.
    await waitFor(
      // The **words**, not just the choice: `selectedLabel` is set the moment the source is
      // re-chosen, and the rung is only back once the file has been read again.
      (s) => s.subtitles.selectedLabel === 'Cars.srt' && !s.subtitles.preparing,
      'the words to come back',
    );
    expect(engine.snapshot().subtitles.offsetMs).toBe(500);
    // 12a is not weakened to get there: no LOAD, so the film was never restarted.
    expect(receiver.countOf('LOAD')).toBe(loadsBefore);
    expect(engine.mediaServerPort).toBe(port);

    // **The half that a kinder fake would hide.** The thirteen URLs the television is
    // holding name a mount that died with the old process. A press now makes the set go
    // back for the words: if the reopened app did not republish that token, this is a 404
    // — silent, minutes later, with nothing on screen to say so.
    expect(declaredTracks().map((track) => track.trackContentId)).toEqual(trackUrlBefore);
    const statusesBefore = receiver.trackFetchStatuses.length;
    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await settle(1_500);
    const fetched = receiver.trackFetchStatuses.slice(statusesBefore);
    expect(fetched.length).toBeGreaterThan(0);
    expect(fetched.every((status) => status === 200)).toBe(true);
    // And it was a switch: still no second LOAD.
    expect(receiver.countOf('LOAD')).toBe(loadsBefore);
    expect(engine.snapshot().subtitles.offsetMs).toBe(1_000);
  }, 45_000);

  it('does not bring subtitles back that the founder had turned off', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    await castAndPlay();
    await settle(600);
    engine.dispatch({ type: 'subtitles.clear' });
    await settle(1_000);
    await engine.stop({ keepPlaying: true });

    await open();
    await waitFor((s) => s.session.state === 'playing', 'the reopened app to rejoin', 15_000);
    await settle(1_500);
    // 19a's ruling reaches even here: the words were off when the window closed, so a
    // reopened app that turned them on would be subtitles arriving by themselves.
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
  }, 45_000);
});

describe('18i: the line matches the new position, in both directions and at long range', () => {
  it('lands on the right cue after a long seek and after a skip back', async () => {
    // A television does not land exactly where it was asked: it lands on a keyframe. 18i
    // promises the line is right *within 1 s*, so the device is made to miss on purpose.
    receiver.setSeekBehaviour({ errorSec: 0.4 });
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    await castAndPlay();
    await settle(600);

    const cues = await servedCues();
    expect(cues).toHaveLength(5);

    // **Measured where the device landed, not where it was aimed**, and read the instant
    // the landing is visible: the film is playing, so a position sampled a second later is
    // a second of honest playback and says nothing about the jump.
    engine.dispatch({ type: 'playback.seek', positionSec: 602 });
    const afterSeek = await waitFor(
      (s) => Math.abs(s.session.positionSec - 602) < 1.5,
      'the long seek to land',
    );
    const landed = afterSeek.session.positionSec;
    expect(Math.abs(landed - 602)).toBeLessThanOrEqual(1);
    expect(cueAt(cues, Math.round(landed * 1_000))?.text).toBe('Ten minutes in.');
    expect(cueAt(cues, 602_000)?.text).toBe('Ten minutes in.');

    // And backwards, by a skip rather than a drag: 4:35, inside cue 3.
    engine.dispatch({ type: 'playback.seek', positionSec: 305 });
    await waitFor((s) => Math.abs(s.session.positionSec - 305) < 1.5, 'the seek back to land');
    await settle(600);
    const from = engine.snapshot().session.positionSec;
    engine.dispatch({ type: 'playback.skip', deltaSec: -30 });
    const afterSkip = await waitFor(
      (s) => Math.abs(s.session.positionSec - (from - 30)) < 1.5,
      'the skip to land',
    );
    const skipped = afterSkip.session.positionSec;
    expect(Math.abs(skipped - (from - 30))).toBeLessThanOrEqual(1);
    expect(cueAt(cues, Math.round(skipped * 1_000))?.text).toBe('Four and a half minutes in.');
  }, 45_000);

  it('seeks against the corrected words, not the original ones', async () => {
    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    // Two seconds late — a release mismatch of the size the founder's library is full of.
    engine.dispatch({ type: 'subtitles.nudge', steps: 4 });
    await castAndPlay();
    await settle(600);

    // The rung the television is showing is served already shifted, so the line at a
    // position is the corrected line. A seek that landed on the *unshifted* cue would be
    // 18h's other failure — words that come back 2 s out.
    const cues = await servedCues();
    expect(cueAt(cues, 601_000)).toBeNull();
    expect(cueAt(cues, 603_000)?.text).toBe('Ten minutes in.');

    engine.dispatch({ type: 'playback.seek', positionSec: 603 });
    const afterSeek = await waitFor(
      (s) => Math.abs(s.session.positionSec - 603) < 1.5,
      'the seek to land',
    );
    const landed = afterSeek.session.positionSec;
    expect(Math.abs(landed - 603)).toBeLessThanOrEqual(1);
    expect(cueAt(cues, Math.round(landed * 1_000))?.text).toBe('Ten minutes in.');
    // No reload and no swap: seeking is the film's business, and the words ride along.
    expect(receiver.countOf('LOAD')).toBe(1);
  }, 45_000);
});

describe('20g: none of this writes anything of the founder’s', () => {
  it('leaves the subtitle file byte-for-byte unchanged through a nudge, a cast and a reattach', async () => {
    const sidecar = path.join(films, 'Cars.srt');
    const before = await fsp.stat(sidecar);
    const bytesBefore = await fsp.readFile(sidecar);
    const folderBefore = (await fsp.readdir(films)).sort();

    await open({ mediaPort: 0 });
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'subtitles.nudge', steps: 5 });
    await castAndPlay();
    await settle(1_000);
    await engine.stop({ keepPlaying: true });

    await open();
    await waitFor(
      (s) => s.subtitles.selectedLabel === 'Cars.srt' && !s.subtitles.preparing,
      'the words to come back',
      15_000,
    );
    engine.dispatch({ type: 'subtitles.nudge', steps: -1 });
    await settle(1_000);

    const after = await fsp.stat(sidecar);
    expect(await fsp.readFile(sidecar)).toEqual(bytesBefore);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    // Nothing new beside the film, and nothing subtitle-shaped in our own folder either —
    // the ladder is derived per request and lives nowhere at all (2026-08-27 ADR).
    expect((await fsp.readdir(films)).sort()).toEqual(folderBefore);
    expect(await fsp.readdir(paths.subtitlesDir).catch(() => [])).toEqual([]);
  }, 45_000);
});
