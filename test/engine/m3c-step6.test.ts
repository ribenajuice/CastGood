import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import { TIMING } from '../../src/engine/config.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * **M3c step 6 — the failure paths.** 18j and 18l, and nothing else.
 *
 * Two promises, and they fail in opposite directions:
 *
 *  - **18j** — a chosen file that cannot be read is refused **at the moment it is chosen**,
 *    in one sentence with no parser output and no file path in it, with the film still
 *    *Ready to cast* without subtitles and another choice one press away. Never a failed
 *    cast, and never a film that plays with a blank track.
 *  - **18l** — a track the television accepted and then **never fetched** costs the founder
 *    a sentence and nothing else. The film keeps playing, no LOAD is re-issued underneath
 *    it, and — the line this milestone had to be careful about — the never-fetched track
 *    must never look like the film's own bytes dying and trip defect D2's media-path repair.
 *
 * **Real bytes, not mocks.** All four 18j fixtures are written to disk exactly as the
 * founder's picker would hand them over: an empty file, a binary file, an HTML error page
 * saved as `.srt`, and a UTF-16 file with no byte-order mark to tell anyone what it is.
 * A fixture that was a stubbed parser result would prove the refusal branch and nothing
 * about the files that actually reach it.
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

const SRT = `1
00:00:05,000 --> 00:00:08,000
Opening line.

2
00:02:00,000 --> 00:02:06,000
Two minutes in.
`;

let root: string;
let films: string;
let filmPath: string;
let paths: AppPaths;
let receiver: FakeReceiver;
let engine: Engine;
let mdns: FakeMdns;
let sink: ReturnType<typeof createMemorySink>;

function events(name: string): Record<string, unknown>[] {
  return sink.lines
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Record<string, unknown>];
      } catch {
        return [];
      }
    })
    .filter((record) => record['event'] === name);
}

async function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  what = 'condition',
  timeoutMs = 10_000,
): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for ${what}; state ${engine.snapshot().session.state}`);
}

const settle = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function open(): Promise<void> {
  sink = createMemorySink();
  mdns = createFakeMdns();
  engine = createEngine({
    paths,
    logSink: sink,
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
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

async function chooseFilm(): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filmPath });
  await waitFor((s) => s.file?.path === filmPath, 'the film to be read');
}

async function chooseSubtitle(label: string): Promise<void> {
  const option = engine.snapshot().subtitles.options.find((entry) => entry.label === label);
  if (option === undefined) throw new Error(`no subtitle option labelled ${label}`);
  engine.dispatch({ type: 'subtitles.select', sourceId: option.id });
  await waitFor((s) => !s.subtitles.preparing, `${label} to be read`);
}

/** Pick a file from wherever it lives — 18c's route, and the one 18j is written about. */
async function pickSubtitleFile(file: string): Promise<void> {
  engine.dispatch({ type: 'subtitles.chooseFile', path: file });
  await waitFor((s) => !s.subtitles.preparing, `${path.basename(file)} to be read`);
}

async function castAndPlay(): Promise<void> {
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitFor((s) => s.session.state === 'playing', 'the film to play');
}

function loadCount(): number {
  return receiver.received.filter((message) => message.type === 'LOAD').length;
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: 900 });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-m3c6-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
  filmPath = path.join(films, 'Cars.mp4');
  await fsp.writeFile(filmPath, fixtureMp4());
  paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: root } });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

/**
 * The four shapes the PRD names, as bytes.
 *
 * The fourth is the one worth reading twice: **UTF-16 with no byte-order mark**. A file with
 * a BOM is decoded and used (that is a real Windows subtitle and step 3 made sure of it);
 * one without has nothing in it that says what encoding it is, and half its bytes are NULs.
 * It is the *"an encoding we cannot decode"* case, and it must be refused rather than turned
 * into a track full of replacement characters that a television would happily show.
 */
function utf16NoBom(text: string): Buffer {
  const bytes = Buffer.alloc(text.length * 2);
  for (let at = 0; at < text.length; at += 1) bytes.writeUInt16LE(text.charCodeAt(at), at * 2);
  return bytes;
}

const BROKEN_FIXTURES: readonly { readonly name: string; readonly bytes: Buffer }[] = [
  { name: 'empty.srt', bytes: Buffer.alloc(0) },
  { name: 'binary.srt', bytes: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x02, 0xff, 0x00, 0x13]) },
  {
    name: 'not-found.srt',
    bytes: Buffer.from(
      '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body>The subtitle you requested is gone.</body></html>\n',
      'utf8',
    ),
  },
  { name: 'utf16-no-bom.srt', bytes: utf16NoBom(SRT) },
];

describe('18j: a subtitle file that cannot be read', () => {
  it('refuses all four shapes at the moment they are chosen, before Cast', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await open();
    await chooseFilm();

    const readyBefore = engine.snapshot().file;
    expect(readyBefore).not.toBeNull();

    for (const fixture of BROKEN_FIXTURES) {
      const file = path.join(root, fixture.name);
      await fsp.writeFile(file, fixture.bytes);
      await pickSubtitleFile(file);

      const after = engine.snapshot();
      const problem = after.subtitles.problem;
      expect(problem, `${fixture.name} was accepted`).not.toBeNull();
      // **One sentence.** Not a stack, not a log line, not two.
      expect(problem?.split('. ').length, `${fixture.name} said more than one sentence`).toBe(1);
      // 18j says it twice: **no parser output and no file path**. Both are checked against
      // the fixture's own name and its own directory, because the only way a path can leak
      // is by being the one the founder just pointed at.
      for (const forbidden of [
        file,
        fixture.name,
        root,
        films,
        '\\',
        '/',
        'cue',
        'parse',
        'utf',
        'decode',
        'ffmpeg',
        'webvtt',
        'srt',
      ]) {
        expect(
          problem?.toLowerCase().includes(forbidden.toLowerCase()),
          `${fixture.name}'s sentence leaked "${forbidden}": ${problem ?? ''}`,
        ).toBe(false);
      }
      // Back at Off, with the film exactly as ready as it was. Never a failed cast.
      expect(after.subtitles.selectedId, fixture.name).toBeNull();
      expect(after.subtitles.selectedLabel, fixture.name).toBeNull();
      expect(after.session.state, fixture.name).toBe('idle');
      expect(after.notice, fixture.name).toBeNull();
      expect(after.file, fixture.name).toEqual(readyBefore);
    }

    // **Choosing another is one press.** One dispatch, from the last refusal straight to a
    // working track, with the sentence gone.
    await chooseSubtitle('Cars.srt');
    expect(engine.snapshot().subtitles.selectedLabel).toBe('Cars.srt');
    expect(engine.snapshot().subtitles.problem).toBeNull();
  }, 30_000);

  it('never lets a refused file reach a television, and the film still casts', async () => {
    await open();
    await chooseFilm();
    const file = path.join(root, 'empty.srt');
    await fsp.writeFile(file, '');
    await pickSubtitleFile(file);

    await castAndPlay();
    await settle();

    // 19a's shape, arrived at by refusal rather than by choice: no tracks key, nothing
    // served, and a film playing exactly as it would have with no subtitle at all.
    const load = receiver.received.filter((message) => message.type === 'LOAD').at(-1);
    const media = load?.payload['media'] as Record<string, unknown>;
    expect(media['tracks']).toBeUndefined();
    expect(load?.payload['activeTrackIds']).toBeUndefined();
    expect(receiver.trackFetches).toEqual([]);
    expect(engine.snapshot().session.state).toBe('playing');
    expect(engine.snapshot().session.subtitleLabel).toBeNull();
  }, 30_000);
});

describe('18l: a declared track the television never fetches', () => {
  it('says so, keeps the film playing, and never re-loads it', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await open();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');

    // **The fake gets stingier.** It accepts the LOAD and fetches the film, and never goes
    // for the track — which is what a real set does when the track's URL is the one thing
    // it cannot reach, and 18l is unreachable without it.
    receiver.setFetchesTracks(false);
    await castAndPlay();
    const loadsAtStart = loadCount();

    const told = await waitFor(
      (s) => s.subtitles.problem !== null,
      'the founder to be told the track did not load',
      TIMING.firewallDiagnosisMs + 10_000,
    );

    // The sentence 18l names, and the way out beside it.
    expect(told.subtitles.problem).toContain('Subtitles didn’t load');
    expect(told.subtitles.canRetry).toBe(true);
    // It really was never fetched — otherwise this test proves nothing at all.
    expect(receiver.trackFetches).toEqual([]);

    // **The film survives, and that is the whole criterion.** Still playing, still one
    // LOAD, nothing red, and the founder's place untouched.
    expect(told.session.state).toBe('playing');
    expect(told.notice).toBeNull();
    expect(loadCount()).toBe(loadsAtStart);
    expect(receiver.playerState).toBe('PLAYING');
    // 17a's own diagnosis is about the **film's** bytes and they arrived. A subtitle must
    // never be able to accuse the founder's firewall.
    expect(events('session.media_never_fetched')).toHaveLength(0);

    // **And it never trips defect D2's repair.** The media-path watch exists for the film's
    // bytes; a track nobody fetched is not a dead film delivery and must not read as one.
    expect(events('media.path_repairing')).toHaveLength(0);
    expect(events('media.path_watch')).toHaveLength(0);
  }, 60_000);

  it('puts the words back on one press of Try again, with the film still playing', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await open();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');

    receiver.setFetchesTracks(false);
    await castAndPlay();
    const positionBefore = engine.snapshot().session.positionSec;
    await waitFor(
      (s) => s.subtitles.canRetry,
      'the track to be reported as never fetched',
      TIMING.firewallDiagnosisMs + 10_000,
    );

    // Whatever was in the way has gone: the founder presses Try again.
    const loadsBefore = loadCount();
    receiver.setFetchesTracks(true);
    engine.dispatch({ type: 'subtitles.retry' });

    // **Graded on the television having the words, not on the sentence going away.** The
    // sentence goes the instant the retry starts — it was about a declaration that no
    // longer stands — so a test that waited for it to clear would pass on a retry that did
    // nothing at all. What proves this worked is bytes leaving this PC.
    const deadline = Date.now() + 20_000;
    while (receiver.trackFetches.length === 0 && Date.now() < deadline) {
      await settle(50);
    }
    expect(receiver.trackFetches.length).toBeGreaterThan(0);
    // One reload, which is what a television costs for a track it never took the first
    // time — stated to the founder rather than hidden, and the film comes straight back.
    expect(loadCount()).toBe(loadsBefore + 1);
    await waitFor((s) => s.session.state === 'playing', 'the film to be playing again');
    expect(engine.snapshot().subtitles.problem).toBeNull();
    expect(engine.snapshot().session.subtitleLabel).toBe('Subtitles: Cars.srt');
    // The founder's place is kept: a retry lands where they are, not at the opening titles.
    expect(engine.snapshot().session.positionSec).toBeGreaterThanOrEqual(positionBefore - 1);
    expect(events('media.path_repairing')).toHaveLength(0);
  }, 60_000);

  it('says nothing at all when the television does fetch the track', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await open();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    await castAndPlay();

    // The negative control, and it is the one that stops this instrument crying wolf: the
    // same wait, a television that behaved, and nothing said.
    await settle(TIMING.firewallDiagnosisMs + 2_000);
    expect(receiver.trackFetches.length).toBeGreaterThan(0);
    expect(engine.snapshot().subtitles.problem).toBeNull();
    expect(engine.snapshot().subtitles.canRetry).toBe(false);
    expect(engine.snapshot().session.state).toBe('playing');
  }, 60_000);
});
