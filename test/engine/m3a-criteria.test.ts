import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import type { LogRecord } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';
import { audioStream, probeOf, report, videoStream } from './fixtures/ffprobe.js';
import { createFakeSpawn, outputOf, type FakeSpawn } from './fixtures/spawn.js';

/**
 * Milestone 3a, driven through the engine's own intents — the same entry points the app and
 * the selftest use.
 *
 * **This is [logic] and nothing more.** It proves that pressing one button on a file the
 * television cannot play produces a prepared file beside the source and a cast that starts
 * by itself; it proves that a cancel leaves the folder untouched; it proves the confirmation
 * writes nothing. It proves **nothing whatsoever** about ffmpeg's output, about how long a
 * real conversion takes, or about whether a Chromecast plays the result. Those are the
 * `remux`, `convert`, `prepared` and `prepfail` selftest scenarios and the founder's eyes,
 * and no test in this file may be read as a substitute for them.
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

const HOUR = 6_990;

/** An MKV of H.264 + AAC. The television cannot take the container, so: Tier 2. */
const MKV_TIER2 = () =>
  report({ formatName: 'matroska,webm', durationSec: HOUR, sizeBytes: 4_000_000_000 });

/**
 * An MP4 whose **picture** the television cannot decode, and enough of it to be a long job:
 * **4K HEVC**, which no profile in the model table carries.
 *
 * Two corrections are baked into this fixture, and both were found by a test failing rather
 * than by reasoning. Sound-only conversion was the first attempt and was wrong: re-encoding
 * only the audio runs at ~20× real time, so a two-hour film is a six-minute job that never
 * reaches `LONG_PREP`. Then 1080p HEVC was wrong too — once SPIKE-4 replaced the estimate's
 * duration model with a **pixel** one (2026-08-20), a 1h56m 1080p re-encode came out at
 * about 16 minutes, which is *correctly* under the twenty-minute line.
 *
 * So the confirmation's fixture has to be a job that is genuinely long, and at ~400 Mpx/s
 * that means resolution rather than length. 4K is also the honest case: it is the film a
 * founder really would be asked to wait an hour for.
 */
const MP4_TIER3 = () =>
  report({
    durationSec: HOUR,
    sizeBytes: 4_000_000_000,
    streams: [
      videoStream({
        codec_name: 'hevc',
        profile: 'Main 10',
        width: 3_840,
        height: 2_160,
        coded_width: 3_840,
        coded_height: 2_160,
      }),
      audioStream({ codec_name: 'dts', profile: 'DTS-HD MA' }),
    ],
  });

/**
 * A film this television plays untouched — and long enough that being *refused* turns into
 * a job over `LONG_PREP`.
 *
 * 7e's safety net re-plans a refused file by narrowing the device's profile, which drops
 * H.264 High to Main and forces a picture re-encode. For the collision with 7f to happen at
 * all, that re-encode has to exceed twenty minutes, and under the pixel model a 1080p film
 * needs to be about four hours long to manage it. Which is a real thing to own: a boxed set,
 * a concert, a double feature.
 */
const LONG_FILM_SEC = 4 * 60 * 60;
const READY_BUT_LONG = () => report({ durationSec: LONG_FILM_SEC, sizeBytes: 12_000_000_000 });

/** The prepared copy: an MP4 of H.264 + AAC at the same length. Tier 1 anywhere. */
const PREPARED = () => report({ durationSec: HOUR, sizeBytes: 3_000_000_000 });

let root: string;
let films: string;
let sourcePath: string;
let engine: Engine;
let receiver: FakeReceiver;
let mdns: FakeMdns;
let fake: FakeSpawn;
let sink: ReturnType<typeof createMemorySink>;

/**
 * One ffprobe for the whole engine, answering per file name.
 *
 * The artifact's answer is registered up front rather than when it is written, because the
 * pipeline probes it the instant it exists — the same order the real one runs in.
 */
function probes(answers: Record<string, unknown>): FfprobeRunner {
  return (filePath) => {
    const json = answers[path.basename(filePath)];
    return Promise.resolve(
      json === undefined
        ? { ok: false as const, failure: 'unreadable' as const }
        : { ok: true as const, probe: probeOf(json) },
    );
  };
}

async function build(
  options: { source?: unknown; artifact?: unknown; encoder?: 'libx264' | 'h264_nvenc' } = {},
): Promise<void> {
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
    ffprobe: probes({
      'Cars.mkv': options.source ?? MKV_TIER2(),
      ...(options.artifact === undefined ? {} : { 'Cars (CastGood).mp4': options.artifact }),
    }),
    // Stated, never resolved — the same rule as `ffprobe`. `resolveFfmpeg()` will not
    // offer the Windows binaries sitting in `resources/bin` to a Linux process, and it is
    // right not to; every child process here is `fake.spawn` anyway.
    ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    // Stated, so the engine does not go and open a real encoder to find out — a probe
    // through `fake.spawn` would be counted as the job under test.
    videoEncoder: options.encoder ?? 'libx264',
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

function records(): LogRecord[] {
  return sink.lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as LogRecord];
    } catch {
      return [];
    }
  });
}

async function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  what = 'condition',
): Promise<StateSnapshot> {
  const deadline = Date.now() + 4_000;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Choose the film and let the check finish. */
async function chooseFilm(): Promise<StateSnapshot> {
  engine.dispatch({ type: 'file.select', path: sourcePath });
  return waitFor((s) => s.file !== null && s.check === null, 'the check to finish');
}

/** The prepared copy is written, progress runs to the end, ffmpeg exits cleanly. */
async function completeJob(): Promise<void> {
  const child = await fake.waitForChild(fake.children.length + 1);
  await fsp.writeFile(outputOf(child), Buffer.alloc(3_000, 7));
  child.progress({ outTimeSec: HOUR / 2, speed: 20 });
  child.progress({ outTimeSec: HOUR, speed: 20, end: true });
  child.exit(0);
}

async function folderContents(): Promise<string[]> {
  return (await fsp.readdir(films)).sort();
}

/**
 * Wait for the film's folder to settle on an exact list.
 *
 * 8d's promise is *"within 2 s"*, not "synchronously": the founder's press stops ffmpeg at
 * once, and removing the staging file is the next thing that happens. Polling here is the
 * criterion, not a workaround for one — and the failure message names what is still there.
 */
async function expectFolder(expected: string[]): Promise<void> {
  const deadline = Date.now() + 2_000;
  let seen: string[] = [];
  while (Date.now() < deadline) {
    seen = await folderContents();
    if (JSON.stringify(seen) === JSON.stringify(expected)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  expect(seen).toEqual(expected);
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: HOUR });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-m3a-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
  sourcePath = path.join(films, 'Cars.mkv');
  await fsp.writeFile(sourcePath, Buffer.alloc(4_096, 1));
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

describe('the check makes a claim it can stand behind (7a, 7b)', () => {
  it('names the wait rather than saying "ready" about a file that is not', async () => {
    await build();
    const snapshot = await chooseFilm();
    expect(snapshot.file?.verdict?.kind).toBe('remux');
    expect(snapshot.file?.verdict?.headline).toMatch(/^Ready in about /);
    // 7a forbids all of this on screen, and the cheapest way to guarantee it is for the
    // renderer never to receive it. The *verdict* is what reaches the screen; `file.path`
    // is the selection's identity and is never rendered — the panel shows `file.name`.
    const rendered = JSON.stringify(snapshot.file?.verdict);
    for (const forbidden of ['h264', 'aac', 'matroska', 'High', sourcePath]) {
      expect(rendered).not.toContain(forbidden);
    }
    // The evidence exists — it is in the log, where it is worth reading.
    const checked = records().find((r) => r.event === 'file.checked');
    expect(JSON.stringify(checked)).toContain('h264');
  });

  it('shows a checking state while it looks, and never blocks (7a)', async () => {
    await build();
    engine.dispatch({ type: 'file.select', path: sourcePath });
    // The panel names the file it is looking at, before `file` is set — see `CheckSnapshot`
    // for why a half-inspected entry must not appear in the selection.
    const looking = engine.snapshot();
    expect(looking.check?.name).toBe('Cars.mkv');
    expect(looking.file).toBeNull();
    await chooseFilm();
    expect(engine.snapshot().check).toBeNull();
  });
});

describe('a film prepared before never waits again (7c, 9a, 9b)', () => {
  it('says it is already prepared, and casts the prepared file (7c, 9a)', async () => {
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(3_000, 7));
    await build({ artifact: PREPARED() });
    const snapshot = await chooseFilm();

    expect(snapshot.file?.verdict?.kind).toBe('ready');
    // The founder is told *why* there is no wait, rather than left guessing.
    expect(snapshot.file?.verdict?.reason).toBe(
      'It was prepared last time, so there is nothing to wait for.',
    );
    // And the film's own name is still what the panel shows. `Cars (CastGood).mp4` is our
    // bookkeeping, not the founder's word for the film.
    expect(snapshot.file?.name).toBe('Cars.mkv');

    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'playback');
    expect(receiver.loadedUrl).not.toBeNull();
    // **No preparation step at all.** The wait never happens twice.
    expect(fake.children).toHaveLength(0);
    expect(records().some((r) => r.event === 'preparation.started')).toBe(false);
  });

  it('survives the app being closed and reopened, because it is a file (9b)', async () => {
    // Story 9's "remembered across sessions" is a property of the filesystem, not of a
    // database: the memory *is* the file sitting next to the original. So a second engine,
    // with a fresh store, must find it.
    await build({ artifact: PREPARED() });
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    await completeJob();
    await waitFor((s) => s.session.state === 'playing', 'the first cast');
    await engine.stop();

    await build({ artifact: PREPARED() });
    const second = await chooseFilm();
    expect(second.file?.verdict?.kind).toBe('ready');
    expect(second.file?.verdict?.reason).toMatch(/prepared last time/i);
    expect(fake.children).toHaveLength(0);
  });
});

describe('one press, and a film (8a, 7h)', () => {
  it('prepares and then casts with no second press (8a)', async () => {
    await build({ artifact: PREPARED() });
    await chooseFilm();

    engine.dispatch({ type: 'cast.start' });
    // 7h: an estimate under 20 minutes starts immediately and no confirmation ever appears.
    await waitFor((s) => s.preparation.active, 'preparation to start');
    expect(engine.snapshot().preparation.headline).toBe('Repackaging Cars.mkv…');
    expect(engine.snapshot().file?.verdict?.confirmation).toBeNull();

    await completeJob();
    // The founder pressed one button and ends up watching a film.
    await waitFor((s) => s.session.state === 'playing', 'playback');
    expect(engine.snapshot().preparation.active).toBe(false);
    // And what went to the television is the prepared copy, not the source.
    expect(receiver.loadedUrl).not.toBeNull();
    expect(await folderContents()).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);
  });

  it('shows progress that reaches the end without ever retreating', async () => {
    await build({ artifact: PREPARED() });
    await chooseFilm();
    const seen: number[] = [];
    engine.subscribe((s) => {
      if (s.preparation.active) seen.push(s.preparation.percent);
    });

    engine.dispatch({ type: 'cast.start' });
    const child = await fake.waitForChild();
    await fsp.writeFile(outputOf(child), Buffer.alloc(3_000, 7));
    child.progress({ outTimeSec: HOUR * 0.6, speed: 20 });
    // ffmpeg steps back at a chapter boundary. The founder must never see it.
    child.progress({ outTimeSec: HOUR * 0.4, speed: 20 });
    child.progress({ outTimeSec: HOUR, speed: 20, end: true });
    child.exit(0);
    await waitFor((s) => s.session.state === 'playing', 'playback');

    expect(seen.length).toBeGreaterThan(1);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
  });
});

describe('the 20-minute confirmation (7f, 7g)', () => {
  it('is a state, and nothing is on disk while it is up (7f)', async () => {
    await build({ source: MP4_TIER3(), artifact: PREPARED() });
    const snapshot = await chooseFilm();
    // A 1h56m film whose picture must be re-encoded: well over LONG_PREP.
    expect(snapshot.file?.verdict?.kind).toBe('convert');
    expect(snapshot.file?.verdict?.requiresConfirmation).toBe(true);

    engine.dispatch({ type: 'cast.start' });
    const confirming = await waitFor(
      (s) => s.file?.verdict?.confirmation != null,
      'the confirmation',
    );
    const confirmation = confirming.file?.verdict?.confirmation;
    // The three things 7f says it must state.
    expect(confirmation?.startsWatching).toMatch(/Watching can start/);
    expect(confirmation?.diskUse).toMatch(/It will write about/);
    expect(confirmation?.cancelWarning).toMatch(/starts again/);
    // **Nothing has been written and nothing has been started.**
    expect(fake.children).toHaveLength(0);
    expect(await folderContents()).toEqual(['Cars.mkv']);
  });

  it('leaves zero bytes behind when the founder says Not now (7g)', async () => {
    await build({ source: MP4_TIER3(), artifact: PREPARED() });
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.file?.verdict?.confirmation != null, 'the confirmation');

    engine.dispatch({ type: 'preparation.decline' });
    const after = await waitFor((s) => s.file?.verdict?.confirmation == null, 'the way back');
    // Back at the verdict with the file still chosen. There was never anything to undo:
    // the confirmation is the state that comes *before* the first byte.
    expect(after.file?.name).toBe('Cars.mkv');
    expect(after.file?.verdict?.kind).toBe('convert');
    expect(await folderContents()).toEqual(['Cars.mkv']);
    expect(fake.children).toHaveLength(0);
  });

  it('starts the job — and only then — when the founder confirms (7f)', async () => {
    await build({ source: MP4_TIER3(), artifact: PREPARED() });
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.file?.verdict?.confirmation != null, 'the confirmation');

    engine.dispatch({ type: 'preparation.confirm' });
    await waitFor((s) => s.preparation.active, 'preparation to start');
    expect(engine.snapshot().preparation.headline).toBe('Converting Cars.mkv…');
  });
});

describe('cancelling, and what is left afterwards (8d)', () => {
  it('stops and leaves nothing behind', async () => {
    await build({ artifact: PREPARED() });
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    const child = await fake.waitForChild();
    // Bytes really on disk, which is the case where a naive cleanup leaves a four-gigabyte
    // `.partial` in the founder's films folder.
    await fsp.writeFile(outputOf(child), Buffer.alloc(50_000, 3));
    child.progress({ outTimeSec: HOUR * 0.3, speed: 20 });
    await waitFor((s) => s.preparation.percent > 0, 'some progress');

    engine.dispatch({ type: 'preparation.cancel' });
    await waitFor((s) => !s.preparation.active, 'the job to stop');

    expect(child.killed).toBe(true);
    await expectFolder(['Cars.mkv']);
    // A cancel is not a failure and the founder is told nothing: they pressed the button.
    expect(engine.snapshot().notice).toBeNull();
    // The film is still chosen and the verdict is still on screen.
    expect(engine.snapshot().file?.verdict?.kind).toBe('remux');
  });

  it('stops a job when the app closes, so nothing is converting after we are gone (P6)', async () => {
    await build({ artifact: PREPARED() });
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    const child = await fake.waitForChild();
    await fsp.writeFile(outputOf(child), Buffer.alloc(50_000, 3));
    child.progress({ outTimeSec: HOUR * 0.3, speed: 20 });
    await waitFor((s) => s.preparation.active, 'preparation');

    await engine.stop();
    expect(child.killed).toBe(true);
    // The window asks first — that is `src/main/`'s prompt, the same one a film mid-play
    // gets. By the time the engine stops, the answer was yes.
    expect(records().some((r) => r.event === 'preparation.cancelled')).toBe(true);
  });
});

describe('when preparation cannot happen (P1, P3, P7)', () => {
  it('states the shortfall and writes nothing when the job will not fit (P1)', async () => {
    // A film claiming to be larger than any disk. The shortfall is found before any work
    // begins, and the sentence is a plain amount.
    await build({
      source: report({
        formatName: 'matroska,webm',
        durationSec: HOUR,
        sizeBytes: Number.MAX_SAFE_INTEGER,
      }),
    });
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    // A film that will not fit on any disk is also, at any honest throughput, a job over
    // twenty minutes — so the confirmation comes first. That ordering is the point: the
    // founder agrees to the wait, and *then* the disk check refuses before a byte is
    // written, rather than the two questions being asked in the wrong order.
    await waitFor((s) => s.file?.verdict?.confirmation != null, 'the confirmation');
    engine.dispatch({ type: 'preparation.confirm' });

    const failed = await waitFor((s) => s.notice !== null, 'the disk notice');
    expect(failed.notice?.message).toContain('needs about');
    expect(failed.notice?.actionLabel).toBe('Try again');
    expect(fake.children).toHaveLength(0);
    expect(await folderContents()).toEqual(['Cars.mkv']);
  });

  it('says one plain sentence after the retry also fails, with the detail in the log (P3)', async () => {
    await build();
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });

    for (const attempt of [1, 2]) {
      const child = await fake.waitForChild(attempt);
      child.stderr('Invalid data found when processing input\n');
      child.exit(1);
    }
    const failed = await waitFor((s) => s.notice !== null, 'the failure notice');

    expect(failed.notice?.message).toBe('Couldn’t prepare Cars.mkv.');
    expect(failed.notice?.actionLabel).toBe('Try again');
    // No ffmpeg output on screen — and it is in the log, where it is the first thing
    // anyone debugging this will want.
    expect(failed.notice?.message).not.toContain('Invalid data');
    expect(sink.lines.join('')).toContain('Invalid data found');
    await expectFolder(['Cars.mkv']);
  });

  it('reuses M2’s own sentence when the film goes away mid-job (P7)', async () => {
    // No new vocabulary for a failure the founder has already met, and *Find it again* is
    // the button they already know.
    await build();
    await chooseFilm();
    engine.dispatch({ type: 'cast.start' });
    const child = await fake.waitForChild();
    child.stderr('Cars.mkv: No such file or directory\n');
    child.exit(1);

    const failed = await waitFor((s) => s.notice !== null, 'the source-missing notice');
    expect(failed.notice?.message).toBe('The original file is no longer where it was.');
    expect(failed.notice?.actionLabel).toBe('Find it again');
    // Not retried: a film that is not there will not be there a second time either.
    expect(fake.children).toHaveLength(1);
  });
});

describe('the estimate follows the encoder that will actually run', () => {
  it('quotes a hardware conversion as faster than a software one, for the same film', async () => {
    // Two measured numbers, not one: 250 Mpx/s sustained for `libx264 -preset veryfast`,
    // 700 for NVENC. Sharing a seed would make every estimate wrong on one of the two
    // machines this product might be running on.
    await build({ source: MP4_TIER3(), artifact: PREPARED() });
    const software = (await chooseFilm()).file?.verdict?.estimateSeconds ?? 0;
    await engine.stop();

    await build({ source: MP4_TIER3(), artifact: PREPARED(), encoder: 'h264_nvenc' });
    const hardware = (await chooseFilm()).file?.verdict?.estimateSeconds ?? 0;

    expect(software).toBeGreaterThan(0);
    expect(hardware).toBeGreaterThan(0);
    expect(hardware).toBeLessThan(software);
    // 700 against 250 — the ratio the two measurements support.
    expect(software / hardware).toBeCloseTo(700 / 250, 1);
  });

  it('assumes the slower encoder until the machine has been asked', async () => {
    // Detection opens a real encoder and takes a moment. Until it answers, the estimate is
    // built from the **software** figure — which over-states the wait rather than
    // under-stating it, and 8b only forbids one of those directions.
    await build({ source: MP4_TIER3(), artifact: PREPARED() });
    const snapshot = await chooseFilm();
    expect(snapshot.file?.verdict?.kind).toBe('convert');
    const checked = records().find((r) => r.event === 'file.checked');
    expect(checked?.['encoder']).toBe('libx264');
  });
});

describe('the television refuses a file we promised it could play (7e)', () => {
  it('records the refusal, re-plans, and shows preparation rather than an error', async () => {
    // An MP4 of H.264 + AAC: Tier 1 by every rule we know. This is the safety net for the
    // `AI PONT` and every other television we have never met.
    await build({ source: READY_BUT_LONG(), artifact: PREPARED() });
    const ready = await chooseFilm();
    expect(ready.file?.verdict?.kind).toBe('ready');

    receiver.rejectNextLoad();
    engine.dispatch({ type: 'cast.start' });

    // The re-plan is a four-hour 1080p re-encode, which is over LONG_PREP — so what the founder gets
    // is 7f's confirmation, which is preparation starting rather than an error. The two
    // criteria meet here and neither gives way: 7e says *not an error*, 7f says *not a byte
    // written without a yes*.
    const replanned = await waitFor(
      (s) => s.file?.verdict?.confirmation != null,
      'the re-planned confirmation',
    );
    expect(replanned.file?.verdict?.kind).toBe('convert');
    // **And the error is gone.** Showing "Needs converting" over the top of "Couldn't play
    // this file" would be the app saying two things at once about the same press.
    expect(replanned.notice).toBeNull();

    expect(records().find((r) => r.event === 'capability.downgraded')).toBeDefined();
    // The verdict can no longer come back `ready` for this file on this television — the
    // property `narrowAfterRefusal` exists to guarantee, and what makes the safety net a
    // net rather than a loop.
    expect(engine.snapshot().file?.verdict?.kind).not.toBe('ready');

    // Saying yes starts the work.
    engine.dispatch({ type: 'preparation.confirm' });
    await waitFor((s) => s.preparation.active, 'preparation to start');
    expect(engine.snapshot().preparation.headline).toBe('Converting Cars.mkv…');
  });

  it('remembers the refusal permanently, so the same file is never promised twice', async () => {
    // The whole value of 7e is that it happens **once**. A device that "recovered" between
    // runs would put the founder back in front of the same failure tomorrow.
    await build({ source: READY_BUT_LONG(), artifact: PREPARED() });
    await chooseFilm();
    receiver.rejectNextLoad();
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.file?.verdict?.confirmation != null, 'the re-planned confirmation');
    await engine.stop();

    // A second app, a second engine, the same television and the same film.
    await build({ source: READY_BUT_LONG(), artifact: PREPARED() });
    const reopened = await chooseFilm();
    expect(reopened.file?.verdict?.kind).toBe('convert');
  });
});
