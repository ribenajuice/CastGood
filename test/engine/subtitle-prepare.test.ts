import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import {
  buildExtractArgs,
  prepareSubtitle,
  subtitleRouteFor,
  subtitleWorkingName,
} from '../../src/engine/subtitles/prepare.js';
import type { SubtitleSource } from '../../src/engine/subtitles/sources.js';
import { createFakeSpawn, type FakeSpawn } from './fixtures/spawn.js';

/**
 * **Turning one chosen source into one WebVTT** — 18c, 18d, 18f, 18j, and the ASS decision.
 *
 * Everything here runs in WSL with no device and no real ffmpeg. What it can prove is the
 * part that decides whether a television is ever asked to render nothing: which sources
 * cost a child process and which do not, and which files are refused **before Cast** rather
 * than becoming a film that plays with a blank track.
 */

const SRT = `1
00:00:01,000 --> 00:00:03,500
Hello.

2
00:00:04,000 --> 00:00:06,000
Goodbye.
`;

let root: string;
let films: string;
let working: string;
let fake: FakeSpawn;
const sink = createMemorySink();
const logger = createLogger({ sink, level: 'debug' });

function sidecar(filePath: string): SubtitleSource {
  return {
    id: `sidecar:${filePath}`,
    label: path.basename(filePath),
    language: null,
    origin: { kind: 'sidecar', filePath },
  };
}

const EMBEDDED: SubtitleSource = {
  id: 'embedded:2',
  label: 'English',
  language: 'eng',
  origin: { kind: 'embedded', streamIndex: 2 },
};

/** Answer the next spawn the way ffmpeg does: write the output file, then exit 0. */
async function answerFfmpeg(text: string, code = 0): Promise<void> {
  const child = await fake.waitForChild(fake.children.length + 1);
  const output = child.args.at(-1) ?? '';
  if (code === 0) await fsp.writeFile(output, text, 'utf8');
  child.exit(code);
}

beforeEach(async () => {
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-subprep-'));
  films = path.join(root, 'Films');
  working = path.join(root, 'work');
  await fsp.mkdir(films, { recursive: true });
  fake = createFakeSpawn();
});

afterEach(async () => {
  await fsp.rm(root, { recursive: true, force: true });
});

describe('which sources cost a child process (the ASS decision)', () => {
  it('reads .srt and .vtt directly and spawns nothing', () => {
    expect(subtitleRouteFor({ kind: 'sidecar', filePath: '/f/Cars.srt' })).toBe('parse');
    expect(subtitleRouteFor({ kind: 'sidecar', filePath: '/f/Cars.vtt' })).toBe('parse');
    expect(subtitleRouteFor({ kind: 'picked', filePath: '/d/anything.SRT' })).toBe('parse');
  });

  it('routes .ass and .ssa through ffmpeg, because parseCues cannot read them', () => {
    // `parseCues` keys on a `-->` timing line. ASS writes `Dialogue: 0,0:00:01.00,…`, so a
    // direct read yields zero cues and 18j's refusal — for a file that is perfectly good.
    expect(subtitleRouteFor({ kind: 'sidecar', filePath: '/f/Cars.ass' })).toBe('convert');
    expect(subtitleRouteFor({ kind: 'sidecar', filePath: '/f/Cars.ssa' })).toBe('convert');
  });

  it('routes a track inside the film through ffmpeg', () => {
    expect(subtitleRouteFor({ kind: 'embedded', streamIndex: 3 })).toBe('extract');
  });
});

describe('18d: one chosen source, one conversion', () => {
  it('converts a .srt sidecar with no ffmpeg at all', async () => {
    const file = path.join(films, 'Cars.en.srt');
    await fsp.writeFile(file, SRT, 'utf8');

    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null, spawn: fake.spawn },
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.track.cueCount).toBe(2);
    // `binaries: null` and it still worked, which is the assertion: no ffmpeg was needed.
    expect(fake.children).toHaveLength(0);
    expect(result.track.cues[0]).toMatchObject({ startMs: 1_000, endMs: 3_500 });
    // The cues *are* the track since 2026-08-27 — nothing was written for them to be in.
    expect(await fsp.readdir(working).catch(() => [])).toEqual([]);
  });

  it('extracts exactly one track from a film with six, and asks for that one', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(64, 1));

    const running = prepareSubtitle(
      { filmPath: film, source: EMBEDDED, language: 'eng', workingDir: working },
      { logger, binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, spawn: fake.spawn },
    );
    await answerFfmpeg(`WEBVTT\n\n00:00:02.000 --> 00:00:04.000\nBonjour.\n`);
    const result = await running;

    expect(result.ok).toBe(true);
    // **One process, not six.** This is the whole of 18d's answer to a film with six
    // language tracks, and it is a count rather than a claim.
    expect(fake.children).toHaveLength(1);
    const child = fake.children[0];
    expect(child?.args).toContain('-map');
    expect(child?.args[(child.args.indexOf('-map') ?? 0) + 1]).toBe('0:2');
    // 18f: the film the founder chose, never `Cars (CastGood).mp4`.
    expect(child?.args[(child.args.indexOf('-i') ?? 0) + 1]).toBe(film);
    if (result.ok) expect(result.track.language).toBe('eng');
  });

  it('names its own working file from the film and the source, and only there', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, SRT, 'utf8');
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    // **20g, in its strongest form**: no new file appears beside the founder's film, and
    // none appears in CastGood's own working directory either — the track is a cue list the
    // media server shifts per request, so there is nothing on disk to find (2026-08-27 ADR).
    expect(await fsp.readdir(films)).toEqual(['Cars.srt']);
    expect(await fsp.readdir(working).catch(() => [])).toEqual([]);
    // The scratch name is still deterministic per (film, source): it is the one path this
    // module constructs, for ffmpeg's own output, and it is removed inside the same call.
    expect(subtitleWorkingName(path.join(films, 'Cars.mkv'), `sidecar:${file}`)).toBe(
      subtitleWorkingName(path.join(films, 'Cars.mkv'), `sidecar:${file}`),
    );
  });

  it('leaves the founder’s own file byte-for-byte unchanged', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, SRT, 'utf8');
    const before = await fsp.readFile(file);
    const stat = await fsp.stat(file);

    await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );

    expect(await fsp.readFile(file)).toEqual(before);
    expect((await fsp.stat(file)).mtimeMs).toBe(stat.mtimeMs);
  });
});

describe('the encodings a Windows subtitle file actually arrives in', () => {
  // A UTF-16 file is roughly half NUL bytes, and the binary guard below refuses anything
  // containing a NUL. Since `.srt` and `.vtt` take the `parse` route, ffmpeg never gets a
  // chance to rescue one — so without a byte-order-mark check first, every subtitle written
  // by an ordinary Windows tool came back as 18j's *"couldn't be read"*. The binary refusal
  // still has to work, which is why both live in the same describe.

  it('reads a UTF-16LE .srt, the common Windows shape', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(
      file,
      Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(SRT, 'utf16le')]),
    );
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.track.cueCount).toBe(2);
  });

  it('reads a UTF-16BE .srt too', async () => {
    const le = Buffer.from(SRT, 'utf16le');
    const be = Buffer.alloc(le.length);
    for (let at = 0; at + 1 < le.length; at += 2) {
      be[at] = le[at + 1] ?? 0;
      be[at + 1] = le[at] ?? 0;
    }
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, Buffer.concat([Buffer.from([0xfe, 0xff]), be]));
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.track.cueCount).toBe(2);
  });

  it('still refuses a real binary, which has no byte-order mark', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00]));
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result).toEqual({ ok: false, failure: 'unreadable' });
  });
});

describe('18j: refused when it is chosen, and never a blank track', () => {
  it('refuses an empty file', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, '');
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result).toEqual({ ok: false, failure: 'no-cues' });
  });

  it('refuses a .srt that is really HTML', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, '<html><body>Not found</body></html>');
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result).toEqual({ ok: false, failure: 'no-cues' });
  });

  it('refuses a binary file before it reaches the parser', async () => {
    const file = path.join(films, 'Cars.srt');
    await fsp.writeFile(file, Buffer.from([0x00, 0x01, 0x02, 0xff, 0x00]));
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result).toEqual({ ok: false, failure: 'unreadable' });
  });

  it('reads a Windows-1252 file rather than refusing it', async () => {
    const file = path.join(films, 'Cars.srt');
    // `é` as a single 0xE9 byte: valid Windows-1252 and invalid UTF-8. Refusing it would
    // refuse a large share of the subtitle files in the world.
    const bytes = Buffer.concat([
      Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCaf', 'latin1'),
      Buffer.from([0xe9]),
      Buffer.from('\n', 'latin1'),
    ]);
    await fsp.writeFile(file, bytes);
    const result = await prepareSubtitle(
      { filmPath: path.join(films, 'Cars.mkv'), source: sidecar(file), workingDir: working },
      { logger, binaries: null },
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.track.cues.map((cue) => cue.text).join('\n')).toContain('Café');
  });

  it('refuses a source file that is not there, and writes nothing', async () => {
    const result = await prepareSubtitle(
      {
        filmPath: path.join(films, 'Cars.mkv'),
        source: sidecar(path.join(films, 'gone.srt')),
        workingDir: working,
      },
      { logger, binaries: null },
    );
    expect(result).toEqual({ ok: false, failure: 'source-missing' });
    expect(await fsp.readdir(working)).toEqual([]);
  });

  it('refuses an extraction ffmpeg would not do, and leaves no half-written file', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(64, 1));
    const running = prepareSubtitle(
      { filmPath: film, source: EMBEDDED, workingDir: working },
      { logger, binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, spawn: fake.spawn },
    );
    await answerFfmpeg('', 1);
    expect(await running).toEqual({ ok: false, failure: 'extract-failed' });
    expect(await fsp.readdir(working)).toEqual([]);
  });

  it('refuses an extraction that produced a file with no cues in it', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(64, 1));
    const running = prepareSubtitle(
      { filmPath: film, source: EMBEDDED, workingDir: working },
      { logger, binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' }, spawn: fake.spawn },
    );
    // A WebVTT header and nothing under it — which is exactly what an empty text stream
    // produces, and exactly the film-that-plays-with-a-blank-track 18j refuses.
    await answerFfmpeg('WEBVTT\n\n');
    expect(await running).toEqual({ ok: false, failure: 'no-cues' });
    expect(await fsp.readdir(working)).toEqual([]);
  });

  it('cannot extract on a machine with no ffmpeg, and says so rather than hanging', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(64, 1));
    const result = await prepareSubtitle(
      { filmPath: film, source: EMBEDDED, workingDir: working },
      { logger, binaries: null, spawn: fake.spawn },
    );
    expect(result).toEqual({ ok: false, failure: 'extract-failed' });
  });
});

describe('choosing something else while one is still converting', () => {
  it('answers cancelled and says nothing to the founder', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(64, 1));
    const abort = new AbortController();
    const running = prepareSubtitle(
      { filmPath: film, source: EMBEDDED, workingDir: working },
      {
        logger,
        binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
        spawn: fake.spawn,
        signal: abort.signal,
      },
    );
    await fake.waitForChild(1);
    abort.abort();
    expect(await running).toEqual({ ok: false, failure: 'cancelled' });
    expect(fake.children[0]?.killed).toBe(true);
  });
});

describe('the extraction command', () => {
  it('maps the one stream asked for and converts it to WebVTT', () => {
    expect(buildExtractArgs('/films/Cars.mkv', '0:4', '/work/x.vtt')).toEqual([
      '-hide_banner',
      '-nostdin',
      '-loglevel',
      'error',
      '-y',
      '-i',
      '/films/Cars.mkv',
      '-map',
      '0:4',
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      '/work/x.vtt',
    ]);
  });
});
