import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';
import { audioStream, probeOf, report, subtitleStream, videoStream } from './fixtures/ffprobe.js';
import { createFakeSpawn, type FakeSpawn } from './fixtures/spawn.js';

/**
 * **Milestone 3c, steps 3 and 4, through the engine's own intents** — the founder chooses a
 * subtitle, CastGood serves it, the television is told about it on the LOAD, and from there
 * it can be turned off and nudged into time without the film stopping.
 *
 * What this file is allowed to claim, and it is narrow: given a film and a device, the
 * engine lists what subtitles the film could have without opening anything (18a, 18b, 18k),
 * converts **only** the chosen one and only when it is chosen (18d), serves it from its own
 * media server with the same headers every other response carries and declares it on the
 * LOAD without changing one byte of the video (18e), takes the words from the source rather
 * than from a prepared sibling (18f), starts every film at **Off** (19a) — and then keeps
 * story 20's promises about **what reaches the wire**: one message per settled burst, a
 * track switch rather than a reload inside ±3 s, and a clamp at ±30 s.
 *
 * What it cannot claim is the criterion the milestone exists for: **18g, that words appear
 * on a television, in time with the film** — nor 20b's own half of it, *"only a person can
 * see a word land on a face"*. Only a person can read a television. Nothing in WSL can, and
 * a green run here is not evidence of it. What is measured here is everything up to the
 * screen: the right message, once, naming the right track, with the film still playing.
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

const FILM_SEC = 7_200;

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello.

2
00:00:04,000 --> 00:00:06,000
Goodbye.
`;

/** Tier 1 with two text tracks and one that is pictures — 18a and 18k in one file. */
const WITH_TRACKS = () =>
  report({
    durationSec: FILM_SEC,
    sizeBytes: 4_000_000_000,
    streams: [
      videoStream({}),
      audioStream({}),
      subtitleStream({ index: 2, tags: { language: 'eng' } }),
      subtitleStream({ index: 3, tags: { language: 'fre' } }),
      subtitleStream({ index: 4, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'spa' } }),
    ],
  });

/** Tier 1 with nothing but picture and sound. */
const PLAIN = () =>
  report({
    durationSec: FILM_SEC,
    sizeBytes: 4_000_000_000,
    streams: [videoStream({}), audioStream({})],
  });

let root: string;
let films: string;
let filmPath: string;
let engine: Engine;
let receiver: FakeReceiver;
let mdns: FakeMdns;
let fake: FakeSpawn;
let sink: ReturnType<typeof createMemorySink>;

function probes(answers: Record<string, unknown>): FfprobeRunner {
  return (file) => {
    const json = answers[path.basename(file)];
    return Promise.resolve(
      json === undefined
        ? { ok: false as const, failure: 'unreadable' as const }
        : { ok: true as const, probe: probeOf(json) },
    );
  };
}

async function build(answers: Record<string, unknown> = { 'Cars.mp4': WITH_TRACKS() }) {
  fake = createFakeSpawn();
  sink = createMemorySink();
  mdns = createFakeMdns();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: root } }),
    logSink: sink,
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
    ffprobe: probes(answers),
    ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    videoEncoder: 'libx264',
    freeBytes: () => Promise.resolve(4_000_000_000_000),
    spawn: fake.spawn,
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

async function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  what = 'condition',
  timeoutMs = 8_000,
): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function chooseFilm(file = filmPath): Promise<void> {
  engine.dispatch({ type: 'file.select', path: file });
  await waitFor((s) => s.file !== null && s.check === null, 'the check');
}

/** The LOAD as the television received it, parsed. */
function lastLoad(): Record<string, unknown> {
  const load = receiver.received.filter((message) => message.type === 'LOAD').at(-1);
  if (load === undefined) throw new Error('no LOAD reached the receiver');
  return load.payload;
}

function mediaOf(load: Record<string, unknown>): Record<string, unknown> {
  return load['media'] as Record<string, unknown>;
}

/** The URL of one rung of the declared ladder, by its offset. `0` is *in sync*. */
function trackUrl(load: Record<string, unknown>, offsetMs = 0): string {
  const tracks = mediaOf(load)['tracks'] as { trackContentId: string }[] | undefined;
  if (tracks === undefined) throw new Error('no track was declared');
  const found = tracks.find((track) => track.trackContentId.endsWith(`/${String(offsetMs)}.vtt`));
  if (found === undefined) throw new Error(`no rung at ${String(offsetMs)} ms`);
  return found.trackContentId;
}

/** Choose a subtitle source by the label the founder would read. */
async function chooseSubtitle(label: string): Promise<void> {
  const option = engine.snapshot().subtitles.options.find((entry) => entry.label === label);
  if (option === undefined) throw new Error(`no subtitle option labelled ${label}`);
  engine.dispatch({ type: 'subtitles.select', sourceId: option.id });
  await waitFor((s) => !s.subtitles.preparing, 'the subtitle to be prepared');
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: FILM_SEC });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-m3c-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
  filmPath = path.join(films, 'Cars.mp4');
  await fsp.writeFile(filmPath, Buffer.alloc(4_096, 1));
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('18a, 18b, 18k: what this film could have, without opening anything', () => {
  it('lists the film’s own text tracks, the sidecars beside it, and refuses the pictures', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await fsp.writeFile(path.join(films, 'Cars.en.srt'), SRT);
    // Rhymes with the film and is not the film. 18b: *"a name that merely rhymes is not a
    // match"*, and this is the file that proves the rule is enforced end to end.
    await fsp.writeFile(path.join(films, 'Carsick.srt'), SRT);
    await build();
    await chooseFilm();

    const subtitles = engine.snapshot().subtitles;
    expect(subtitles.options.map((option) => option.label)).toEqual([
      'English',
      'French',
      'Cars.en.srt',
      'Cars.srt',
    ]);
    // 18k: seen, listed, refused — and the sentence never says PGS.
    expect(subtitles.unavailable).toHaveLength(1);
    expect(subtitles.unavailable[0]?.why).not.toMatch(/pgs|vobsub/i);
    // 18a: no codec names, no stream indices, no file paths on the screen.
    for (const option of subtitles.options) {
      expect(option.label).not.toContain(path.sep);
      expect(option.label).not.toMatch(/subrip|hdmv|stream/i);
    }
  });

  it('offers .ass beside the film and never offers .sub', async () => {
    await fsp.writeFile(path.join(films, 'Cars.ass'), 'not parsed here');
    // A `.sub` is normally the binary half of a VobSub pair — pictures, which 18k refuses.
    // Offering it by name would be a list entry that can only ever end in a refusal.
    await fsp.writeFile(path.join(films, 'Cars.sub'), Buffer.alloc(16, 0));
    await build({ 'Cars.mp4': PLAIN() });
    await chooseFilm();

    expect(engine.snapshot().subtitles.options.map((option) => option.label)).toEqual(['Cars.ass']);
  });

  it('costs no file reads: the sidecars are still untouched after the check', async () => {
    const sidecar = path.join(films, 'Cars.srt');
    await fsp.writeFile(sidecar, SRT);
    const before = await fsp.stat(sidecar);
    await build();
    await chooseFilm();

    expect(engine.snapshot().subtitles.options.map((o) => o.label)).toContain('Cars.srt');
    // 18b: *"nothing beside the film is read until the founder chooses it."* An access time
    // is not a promise on every filesystem, so the assertion that carries this is the one in
    // `subtitle-sources.test.ts` — that the listing function takes names and not a reader.
    // What is checked here is the half a filesystem can answer for: nothing was written.
    const after = await fsp.stat(sidecar);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
  });
});

describe('19a: Off, on every film, every time', () => {
  it('starts at Off however many tracks the film has', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
    expect(engine.snapshot().subtitles.selectedLabel).toBeNull();
  });

  it('does not carry a choice from one film to the next', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    const second = path.join(films, 'Toys.mp4');
    await fsp.writeFile(second, Buffer.alloc(4_096, 1));
    await fsp.writeFile(path.join(films, 'Toys.srt'), SRT);
    await build({ 'Cars.mp4': WITH_TRACKS(), 'Toys.mp4': WITH_TRACKS() });

    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    expect(engine.snapshot().subtitles.selectedLabel).toBe('Cars.srt');

    await chooseFilm(second);
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
  });

  it('sends no tracks key at all when subtitles are off', async () => {
    await build();
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    const load = lastLoad();
    // **Absent, not empty.** SPIKE-3 measured four declared tracks being fetched anyway on
    // all three televisions when `activeTrackIds: []` was sent, so an empty array is not
    // off — it is four downloads and a promise quietly broken.
    expect(Object.keys(mediaOf(load))).not.toContain('tracks');
    expect(Object.keys(load)).not.toContain('activeTrackIds');
    expect(engine.snapshot().session.subtitleLabel).toBeNull();
  });
});

describe('18d, 18e: chosen before Cast, served by us, declared on the LOAD', () => {
  it('converts on the choice and not on Cast', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');

    // The words are read **before** anything is cast: 18d forbids *"an unexplained delay
    // before the picture"*, and the way that promise is kept is by there being no work left
    // to do by the time the founder presses the button. Since 2026-08-27 the finished track
    // is a cue list rather than a file, so what proves the work happened is that the control
    // has stopped preparing and has a chosen source with nothing to say about it.
    expect(engine.snapshot().subtitles.preparing).toBe(false);
    expect(engine.snapshot().subtitles.selectedLabel).toBe('Cars.srt');
    expect(engine.snapshot().subtitles.problem).toBeNull();
    // And nothing was written to get there — not beside the film, not in our own folder.
    expect(await fsp.readdir(path.join(root, 'subtitles')).catch(() => [])).toEqual([]);
    expect((await fsp.readdir(films)).sort()).toEqual(['Cars.mp4', 'Cars.srt']);
  });

  it('serves the track with the same headers every other response carries', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    const url = trackUrl(lastLoad());
    const response = await fetch(url, { headers: { Origin: 'https://www.gstatic.com' } });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/vtt');
    // The 2026-08-19 CORS finding, applied for the third time. A text track is fetched by
    // the receiver's own JavaScript, which is the same shape of problem HLS was, and a
    // missing header there failed with no diagnostic whatsoever.
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.gstatic.com');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
    expect((await response.text()).startsWith('WEBVTT')).toBe(true);

    const preflight = await fetch(url, {
      method: 'OPTIONS',
      headers: { Origin: 'https://www.gstatic.com' },
    });
    expect(preflight.status).toBe(204);
    expect(preflight.headers.get('access-control-allow-origin')).toBe('https://www.gstatic.com');
  });

  it('declares the track in the shape SPIKE-3 proved on hardware', async () => {
    await fsp.writeFile(path.join(films, 'Cars.en.srt'), SRT);
    await build();
    await chooseFilm();
    await chooseSubtitle('Cars.en.srt');
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    const load = lastLoad();
    const tracks = mediaOf(load)['tracks'] as Record<string, unknown>[];
    // **Thirteen, not one** — the ladder, declared in full, because SPIKE-3 measured that a
    // television takes text tracks only in a LOAD. Every offset the founder can reach in one
    // press is already on the set before they press anything.
    expect(tracks).toHaveLength(13);
    expect(tracks.map((track) => track['trackId'])).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13,
    ]);
    // The middle rung is *in sync*, and it is the one that goes out active.
    expect(tracks[6]).toEqual({
      trackId: 7,
      type: 'TEXT',
      trackContentId: expect.stringMatching(
        /^http:\/\/127\.0\.0\.1:\d+\/m\/[0-9a-f]+\/sub\/0\.vtt$/,
      ) as string,
      // Without this the track goes out as `application/octet-stream`, which all three
      // televisions accepted while showing nothing.
      trackContentType: 'text/vtt',
      subtype: 'SUBTITLES',
      name: 'Cars.en.srt',
      language: 'en',
    });
    // Every rung names its own offset in its own URL, so distinct content is never behind
    // one URL — the fault that made "rewrite the file" unusable on real hardware.
    expect(tracks.map((track) => String(track['trackContentId']).split('/sub/')[1])).toEqual([
      '-3000.vtt',
      '-2500.vtt',
      '-2000.vtt',
      '-1500.vtt',
      '-1000.vtt',
      '-500.vtt',
      '0.vtt',
      '500.vtt',
      '1000.vtt',
      '1500.vtt',
      '2000.vtt',
      '2500.vtt',
      '3000.vtt',
    ]);
    // The set's own track menu has thirteen rows in it now; naming them by their offset is
    // what keeps that menu readable rather than thirteen rows reading "Cars.en.srt".
    expect(tracks[7]?.['name']).toBe('Cars.en.srt (+0.5 s)');
    expect(tracks[5]?.['name']).toBe('Cars.en.srt (−0.5 s)');
    expect(load['activeTrackIds']).toEqual([7]);
    // 18g's half a person on this side of the room can check.
    expect(engine.snapshot().session.subtitleLabel).toBe('Subtitles: Cars.en.srt');
  });

  it('sends exactly the same video with a track as without one', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();

    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');
    const bare = mediaOf(lastLoad());
    engine.dispatch({ type: 'cast.stop' });
    await waitFor((s) => s.session.state !== 'playing', 'the stop');

    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'cast.start' });
    await waitFor(
      () => receiver.received.filter((m) => m.type === 'LOAD').length === 2,
      'the second load',
    );
    const withTrack = mediaOf(lastLoad());

    // 18e: *"the video sent is unchanged"*. The mount token is new because the session is
    // new — everything the receiver decides how to play the film from is the same.
    expect(withTrack['contentType']).toBe(bare['contentType']);
    expect(withTrack['streamType']).toBe(bare['streamType']);
    expect(withTrack['metadata']).toEqual(bare['metadata']);
    expect(String(withTrack['contentId']).endsWith('/Cars.mp4')).toBe(true);
    expect(String(bare['contentId']).endsWith('/Cars.mp4')).toBe(true);
    // Choosing a subtitle never turned a Tier 1 cast into a preparation.
    expect(engine.snapshot().file?.verdict?.kind).toBe('ready');
    expect(engine.snapshot().preparation.active).toBe(false);
    expect(fake.children).toHaveLength(0);
  });
});

describe('18f: from the source, never from the prepared copy', () => {
  it('reads the film the founder chose even when a prepared sibling is being cast', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(4_096, 1));
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(4_096, 1));
    await build({
      'Cars.mkv': report({
        formatName: 'matroska,webm',
        durationSec: FILM_SEC,
        sizeBytes: 4_000_000_000,
        streams: [videoStream({}), audioStream({}), subtitleStream({ index: 2 })],
      }),
      'Cars (CastGood).mp4': PLAIN(),
    });
    await chooseFilm(film);
    await waitFor((s) => s.file?.verdict !== null, 'the verdict');

    const option = engine.snapshot().subtitles.options.find((o) => o.label === 'English');
    engine.dispatch({ type: 'subtitles.select', sourceId: option?.id ?? '' });

    // The one extraction was pointed at the source, not at the sibling — which is what
    // lets a film prepared before M3c existed still get subtitles.
    const child = await fake.waitForChild(1);
    expect(child.args[child.args.indexOf('-i') + 1]).toBe(film);
    await fsp.writeFile(
      child.args.at(-1) ?? '',
      'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello.\n',
      'utf8',
    );
    child.exit(0);
    await waitFor((state) => !state.subtitles.preparing, 'the extraction to finish');
    expect(engine.snapshot().subtitles.selectedLabel).toBe('English');
  });

  it('says so in one line and still casts when the subtitle file has gone', async () => {
    const sidecar = path.join(films, 'Cars.srt');
    await fsp.writeFile(sidecar, SRT);
    await build();
    await chooseFilm();

    const option = engine.snapshot().subtitles.options.find((o) => o.label === 'Cars.srt');
    await fsp.rm(sidecar);
    engine.dispatch({ type: 'subtitles.select', sourceId: option?.id ?? '' });
    await waitFor((s) => s.subtitles.problem !== null, 'the refusal');

    const subtitles = engine.snapshot().subtitles;
    expect(subtitles.problem).toBe('Those subtitles are no longer where they were.');
    // Back at Off, and the film is exactly as ready as it was.
    expect(subtitles.selectedId).toBeNull();
    expect(engine.snapshot().file?.verdict?.kind).toBe('ready');

    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play anyway');
    expect(Object.keys(mediaOf(lastLoad()))).not.toContain('tracks');
  });
});

describe('a subtitle never takes a working film down with it', () => {
  it('keeps the film playing when a track URL 404s mid-playback', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');

    // **The way a subtitle can 404 changed on 2026-08-27 and the rule did not.** There is no
    // `.vtt` on disk to delete any more — the track is derived per request — so the only
    // 404 a subtitle mount can produce is an offset past 20e's ±30 s, which is refused
    // rather than clamped: two URLs answering with the same bytes would undo the one
    // property this shape rests on. Asked for on the mount the television is really using.
    const url = trackUrl(lastLoad());
    const beyondTheClamp = url.replace('/sub/0.vtt', '/sub/99999.vtt');
    expect((await fetch(beyondTheClamp)).status).toBe(404);
    // And a real offset is still there, so the 404 above is the server refusing one URL
    // rather than the mount having gone.
    expect((await fetch(url)).status).toBe(200);
    await new Promise((resolve) => setTimeout(resolve, 100));

    // **The film is untouched.** Story 15b — *"the original file is no longer where it
    // was"* — belongs to the film's own mount and to nothing else; a subtitle that cannot
    // be served must never stop a film that is playing perfectly well.
    expect(engine.snapshot().session.state).toBe('playing');
    expect(engine.snapshot().notice?.kind).not.toBe('source-missing');
    expect(engine.snapshot().notice).toBeNull();
  });
});

describe('a different television keeps the founder’s choice', () => {
  it('re-validates the list and holds the selection', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');

    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    await waitFor((s) => s.discovery.selectedDeviceId === receiver.device.id, 'the device');
    await new Promise((resolve) => setTimeout(resolve, 50));

    // 7b re-runs the check for a new television. Which subtitles a film has is not a fact
    // about a television, so the choice survives it — founder's decision.
    expect(engine.snapshot().subtitles.selectedLabel).toBe('Cars.srt');
  });
});

describe('the working directory, and the founder’s folder', () => {
  it('writes nothing anywhere, before or during a cast — 20g', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();
    await chooseSubtitle('Cars.srt');

    const working = path.join(root, 'subtitles');
    const empty = async (): Promise<string[]> => fsp.readdir(working).catch(() => []);
    // **The strongest form of 20g, and it is stronger than the criterion asks for.** The
    // PRD says the shifted track *"lives in the app's working directory"*; since the ladder
    // is derived per request it lives nowhere at all, so *"the founder's own subtitle file
    // is byte-for-byte unchanged and no new file appears beside it"* holds by construction
    // rather than by tidying up afterwards.
    expect(await empty()).toEqual([]);
    expect((await fsp.readdir(films)).sort()).toEqual(['Cars.mp4', 'Cars.srt']);

    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');
    // A television fetching all thirteen rungs still writes nothing here.
    await fetch(trackUrl(lastLoad(), 1_500));
    expect(await empty()).toEqual([]);

    await engine.stop();
    expect(await empty()).toEqual([]);
    expect((await fsp.readdir(films)).sort()).toEqual(['Cars.mp4', 'Cars.srt']);
  });
});

// --- Step 4: the toggle and the timing control (19b, 20a–20e) -------------------

/** How long to wait for the 400 ms coalescing window to close and the wire to move. */
const SETTLED_MS = 550;

async function settled(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SETTLED_MS));
}

/** Cast a film with `Cars.srt` already chosen, and wait for the picture. */
async function castWithSubtitle(): Promise<void> {
  await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
  await build();
  await chooseFilm();
  await chooseSubtitle('Cars.srt');
  engine.dispatch({ type: 'cast.start' });
  await waitFor((s) => s.session.state === 'playing', 'the film to play');
}

function loadCount(): number {
  return receiver.received.filter((message) => message.type === 'LOAD').length;
}

describe('20a: what the timing control reads', () => {
  it('says in sync until it is touched, then a signed number — never +0.0 s', async () => {
    await fsp.writeFile(path.join(films, 'Cars.srt'), SRT);
    await build();
    await chooseFilm();

    // **Off has no timing control at all.** A correction with nothing to correct is a
    // control that cannot mean anything, and 20a puts this one *"beside them"*.
    expect(engine.snapshot().subtitles.timing).toBe('in sync');
    expect(engine.snapshot().subtitles.selectedId).toBeNull();

    await chooseSubtitle('Cars.srt');
    // A film nobody has touched never looks adjusted — the criterion says so in as many
    // words, which is why this is not `+0.0 s`.
    expect(engine.snapshot().subtitles.timing).toBe('in sync');
    expect(engine.snapshot().subtitles.offsetMs).toBe(0);

    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    expect(engine.snapshot().subtitles.timing).toBe('+0.5 s');
    engine.dispatch({ type: 'subtitles.nudge', steps: -3 });
    expect(engine.snapshot().subtitles.timing).toBe('−1.0 s');
    // No frame rates, no milliseconds, no cue counts.
    expect(engine.snapshot().subtitles.timing).not.toMatch(/ms|cue|fps/i);
  });

  it('moves the number on the press, before anything reaches the television', async () => {
    await castWithSubtitle();
    const before = receiver.editTracksCount;

    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    // 20c: *"the displayed number moves on every press; the wire does not."* This is the
    // instant after the press, and the two halves have already parted company.
    expect(engine.snapshot().subtitles.timing).toBe('+0.5 s');
    expect(receiver.editTracksCount).toBe(before);

    await settled();
    expect(receiver.editTracksCount).toBe(before + 1);
  });
});

describe('19b: the words stop, and the film does not', () => {
  it('turns subtitles off with one message and no reload', async () => {
    await castWithSubtitle();
    const loadsBefore = loadCount();
    expect(receiver.activeTrackIds).toEqual([7]);

    engine.dispatch({ type: 'subtitles.clear' });
    await settled();

    // **No reload, no re-buffer, no lost position** — the promise 19b keeps as written,
    // because turning a declared track off is the one thing a television will accept.
    expect(receiver.activeTrackIds).toEqual([]);
    expect(loadCount()).toBe(loadsBefore);
    expect(engine.snapshot().session.state).toBe('playing');
    expect(engine.snapshot().subtitles.selectedId).toBeNull();
  });

  it('turns them back on just as fast, without reading the file again', async () => {
    await castWithSubtitle();
    const loadsBefore = loadCount();
    engine.dispatch({ type: 'subtitles.clear' });
    await settled();

    const before = Date.now();
    await chooseSubtitle('Cars.srt');
    // *"Turning them back on restores them just as fast."* The words were read once, when
    // the founder first chose them; Off does not throw them away, so this is not a second
    // extraction — it is the same cue list and the same ladder already on the set.
    expect(engine.snapshot().subtitles.preparing).toBe(false);
    expect(Date.now() - before).toBeLessThan(500);
    await settled();

    expect(receiver.activeTrackIds).toEqual([7]);
    expect(loadCount()).toBe(loadsBefore);
    expect(engine.snapshot().session.state).toBe('playing');
  });
});

describe('20b, 20c: a press is a track switch, and a burst is one message', () => {
  it('swaps to the rung the founder pressed for, with the film still playing', async () => {
    await castWithSubtitle();
    const loadsBefore = loadCount();
    const editsBefore = receiver.editTracksCount;

    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await settled();

    // Rung 8 is +0.5 s on a ladder hung at zero. One message, no LOAD, still playing —
    // which is 20b's *"the film keeps playing: no re-buffer, no black frame, no lost
    // position"* measured on the wire rather than asserted.
    expect(receiver.activeTrackIds).toEqual([8]);
    expect(receiver.editTracksCount).toBe(editsBefore + 1);
    expect(loadCount()).toBe(loadsBefore);
    expect(engine.snapshot().session.state).toBe('playing');
  });

  it('collapses four presses inside the window into exactly one swap', async () => {
    await castWithSubtitle();
    const loadsBefore = loadCount();
    const editsBefore = receiver.editTracksCount;

    for (let press = 0; press < 4; press += 1) {
      engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
      // Well inside SETTLE's 400 ms, so every press replaces the window rather than
      // queueing behind it — the same rule 6g's four taps and one jump follow.
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    // The number has already moved four times.
    expect(engine.snapshot().subtitles.timing).toBe('+2.0 s');
    expect(receiver.editTracksCount).toBe(editsBefore);

    await settled();
    // **One** message, for the summed offset: rung 11 is +2.0 s.
    expect(receiver.editTracksCount).toBe(editsBefore + 1);
    expect(receiver.activeTrackIds).toEqual([11]);
    expect(loadCount()).toBe(loadsBefore);
  });

  it('serves each rung shifted by exactly the offset in its own URL — 20d on the wire', async () => {
    await castWithSubtitle();
    const load = lastLoad();

    const inSync = await (await fetch(trackUrl(load, 0))).text();
    expect(inSync).toContain('00:00:01.000 --> 00:00:03.500');

    const late = await (await fetch(trackUrl(load, 1_500))).text();
    expect(late).toContain('00:00:02.500 --> 00:00:05.000');

    const early = await (await fetch(trackUrl(load, -1_000))).text();
    expect(early).toContain('00:00:00.000 --> 00:00:02.500');

    // Distinct content, distinct URL — the property that makes the ladder work at all,
    // given a television that served a rewritten file out of its own cache.
    expect(late).not.toBe(inSync);
    expect(early).not.toBe(inSync);
  });

  it('fetches every declared rung, which is what declaring one costs', async () => {
    await castWithSubtitle();
    await waitFor(() => receiver.trackFetches.length >= 13, 'the ladder to be fetched');
    // SPIKE-3 measured this on all three sets: a declared track is fetched whether it is
    // active or not. Thirteen small fetches is the price of an instant nudge, and it is
    // recorded here so nobody has to rediscover it from a slow evening.
    expect(new Set(receiver.trackFetches).size).toBe(13);
  });
});

describe('20e: the clamp, and the one press back', () => {
  it('stops at ±30 s and states the distance rather than reading as a dead button', async () => {
    await castWithSubtitle();

    for (let press = 0; press < 61; press += 1) {
      engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    }
    const snapshot = engine.snapshot().subtitles;
    expect(snapshot.offsetMs).toBe(30_000);
    expect(snapshot.timing).toBe('+30.0 s');
    // The button that cannot move says so; the other one still can, so a founder who has
    // nudged themselves into a mess is never stuck at the edge.
    expect(snapshot.canGoLater).toBe(false);
    expect(snapshot.canGoEarlier).toBe(true);
  });

  it('resets to in sync in one press and one swap', async () => {
    await castWithSubtitle();
    engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
    await settled();
    // Two steps is +1.0 s: rung 9 on a ladder hung at zero.
    expect(receiver.activeTrackIds).toEqual([9]);
    const editsBefore = receiver.editTracksCount;
    const loadsBefore = loadCount();

    engine.dispatch({ type: 'subtitles.resetTiming' });
    expect(engine.snapshot().subtitles.timing).toBe('in sync');
    await settled();

    // *In sync* is a rung of the ladder like any other, so getting back to it is the same
    // track switch every nudge is — one message, no reload.
    expect(receiver.activeTrackIds).toEqual([7]);
    expect(receiver.editTracksCount).toBe(editsBefore + 1);
    expect(loadCount()).toBe(loadsBefore);
  });
});

describe('past the ladder: one reload, at the founder’s place', () => {
  it('reloads once, keeps the position, and hangs a new ladder where they got to', async () => {
    await castWithSubtitle();
    await waitFor((s) => s.session.positionSec > 0.2, 'the film to get going');
    const loadsBefore = loadCount();
    const positionBefore = engine.snapshot().session.positionSec;

    // **Every state the session passes through while the reload happens.** The 2026-08-26
    // ADR names the trap this closes: `session.cast()` calls `release()`, `release()` reaches
    // `stopped`, and `stopped` discards a head start — so a reload built the obvious way
    // would delete a conversion the founder is watching. The reload is a new LOAD on the
    // live session, and this is what says so.
    const states: string[] = [];
    const unsubscribe = engine.subscribe((snapshot) => states.push(snapshot.session.state));

    // Eight presses is +4.0 s, past the ±3 s the declared ladder covers.
    engine.dispatch({ type: 'subtitles.nudge', steps: 8 });
    expect(engine.snapshot().subtitles.timing).toBe('+4.0 s');
    await settled();
    await waitFor((s) => s.session.state === 'playing', 'the film to be playing again');
    unsubscribe();
    expect(states).not.toContain('stopped');
    expect(states).not.toContain('idle');
    expect(states).not.toContain('ended');
    expect(states).not.toContain('connecting');

    // **Exactly one reload**, which is the cost the founder accepted on 2026-08-26 with the
    // full price in front of them — not one per press.
    expect(loadCount()).toBe(loadsBefore + 1);
    const media = mediaOf(lastLoad());
    const tracks = media['tracks'] as { trackContentId: string }[];
    // The new ladder is hung around +4.0 s, so the founder lands on the correction they
    // asked for and their next press either way is instant again.
    expect(tracks.map((track) => track.trackContentId.split('/sub/')[1])).toContain('4000.vtt');
    expect(tracks.map((track) => track.trackContentId.split('/sub/')[1])).toContain('4500.vtt');
    expect(lastLoad()['activeTrackIds']).toEqual([7]);
    // At the founder's place, not at the opening titles — measured at 0 s error on all
    // three televisions on the day the reload was accepted.
    expect(Number(lastLoad()['currentTime'])).toBeGreaterThanOrEqual(positionBefore - 0.5);

    const editsBefore = receiver.editTracksCount;
    const loadsAfter = loadCount();
    engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await settled();
    expect(engine.snapshot().subtitles.timing).toBe('+4.5 s');
    expect(receiver.editTracksCount).toBe(editsBefore + 1);
    expect(loadCount()).toBe(loadsAfter);
  });
});
