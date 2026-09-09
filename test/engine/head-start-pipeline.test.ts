import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreparationPipeline } from '../../src/engine/prepare/index.js';
import type { PreparationPipeline, PrepareRequest } from '../../src/engine/prepare/index.js';
import { classify } from '../../src/engine/prepare/classify.js';
import { BASELINE_PROFILE } from '../../src/engine/prepare/device-profiles.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import type { ProbeResult } from '../../src/engine/media/ffprobe.js';
import { audioStream, probeOf, report, videoStream } from './fixtures/ffprobe.js';
import { createFakeSpawn, outputsOf } from './fixtures/spawn.js';

/**
 * The head-start pipeline's own promises about **the disk** — the ones the engine-level test
 * cannot see and the founder cannot un-break.
 *
 * A conversion that publishes as it goes writes two things instead of one: a folder of
 * segments in CastGood's own working directory, and the MP4 beside the source that everything
 * before M3b already produced. This file is about the first of those never outliving its job.
 */

let films: string;
let working: string;
let sourcePath: string;
const sink = createMemorySink();

/** A two-hour 4K film with DTS: nothing in the baseline plays it, so it is Tier 3. */
const SOURCE = () =>
  report({
    durationSec: 7_200,
    sizeBytes: 8_000_000_000,
    streams: [
      videoStream({
        codec_name: 'hevc',
        profile: 'Main 10',
        width: 3_840,
        height: 2_160,
        coded_width: 3_840,
        coded_height: 2_160,
      }),
      audioStream({ codec_name: 'dts' }),
    ],
  });

/**
 * A volume with room on it, stated rather than measured.
 *
 * P1's disk check is real work against a real filesystem, and leaving it real here means
 * this file passes or fails on how full the machine running it happens to be. `SOURCE` is a
 * two-hour 4K film, the estimate is twice its size and the check runs on two volumes, so
 * ~18 GB has to be free before any of these tests can reach ffmpeg. A developer box has it;
 * a CI runner does not — which is how this file was green in WSL and red on every CI run
 * this branch ever had. The pipeline refused on `disk-space`, correctly, and never spawned
 * the child every one of these tests was waiting for.
 */
const ROOMY = (): Promise<number> => Promise.resolve(4_000_000_000_000);

beforeEach(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-hs-'));
  films = path.join(root, 'Films');
  working = path.join(root, 'working');
  await fsp.mkdir(films, { recursive: true });
  sourcePath = path.join(films, 'Cars.mkv');
  await fsp.writeFile(sourcePath, Buffer.alloc(4_096, 1));
  sink.lines.length = 0;
});

afterEach(async () => {
  await fsp.rm(path.dirname(films), { recursive: true, force: true });
});

function build(options: {
  spawn: ReturnType<typeof createFakeSpawn>['spawn'];
  now?: () => number;
}): PreparationPipeline {
  return createPreparationPipeline({
    logger: createLogger({ sink, bindings: {} }),
    binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    runFfprobe: (filePath) =>
      Promise.resolve(
        path.basename(filePath).includes('(CastGood)')
          ? { ok: true as const, probe: probeOf(report({ durationSec: 7_200 })) }
          : { ok: true as const, probe: probeOf(SOURCE()) },
      ),
    workingDir: working,
    freeBytes: ROOMY,
    spawn: options.spawn,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

function request(): PrepareRequest {
  const sourceProbe: ProbeResult = probeOf(SOURCE());
  return {
    source: { path: sourcePath, name: 'Cars.mkv', sizeBytes: 4_096, mtimeMs: 1 },
    sourceProbe,
    verdict: classify(sourceProbe, BASELINE_PROFILE),
    deviceProfile: BASELINE_PROFILE,
  };
}

describe('the folder of segments (10g)', () => {
  it('writes segments into CastGood’s own working folder, never beside the film', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    void pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();

    const playlist = outputsOf(child).at(0) ?? '';
    expect(playlist.startsWith(working)).toBe(true);
    const pattern = child.args[child.args.indexOf('-hls_segment_filename') + 1] ?? '';
    expect(pattern.startsWith(path.join(working, 'headstart'))).toBe(true);
    // The founder's folder has nothing in it but their film, and will not until the job ends.
    expect(await fsp.readdir(films)).toEqual(['Cars.mkv']);
    child.exit(1);
  });

  it('sweeps a folder left behind by a run that died before starting a new one', async () => {
    const orphan = path.join(working, 'headstart');
    await fsp.mkdir(orphan, { recursive: true });
    await fsp.writeFile(path.join(orphan, 'segment00000.ts'), Buffer.alloc(16, 1));

    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    void pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    await fake.waitForChild();
    // One conversion at a time is an architecture rule, so a folder that is already there
    // belongs to a run that died — and removing it is the whole of the sweep. Without it a
    // crash would leave a folder of fragments for every crash, forever.
    expect(await fsp.readdir(orphan)).toEqual([]);
  });

  it('removes them itself when the job fails, because nobody is watching them', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    const run = pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();
    child.stderr('Conversion failed!');
    child.exit(1);

    const result = await run;
    expect(result.result.ok).toBe(false);
    expect(
      await fsp.stat(path.join(working, 'headstart')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    expect(await fsp.readdir(films)).toEqual(['Cars.mkv']);
  });

  it('hands the caller the tidy-up rather than doing it, so a film in progress is not disturbed', async () => {
    const fake = createFakeSpawn();
    // A clock that jumps a minute per report, so the sustained window is measurable at once.
    let now = 0;
    const pipeline = build({
      spawn: fake.spawn,
      now: () => now,
    });
    const opened: { preparedSec: number; sustainedSpeed: number | null }[] = [];
    const run = pipeline.prepareWithHeadStart(
      request(),
      {
        onGateOpen: (serve) => {
          opened.push({ preparedSec: serve.preparedSec, sustainedSpeed: serve.sustainedSpeed });
        },
      },
      new AbortController().signal,
    );
    const child = await fake.waitForChild();
    child.progress({ outTimeSec: 0, speed: 2 });
    // Let the first block be consumed before the clock moves: two reports stamped at the
    // same instant span no time at all, which is exactly what the real thing avoids by
    // arriving a second apart.
    await new Promise((resolve) => setTimeout(resolve, 20));
    now += 90_000;
    child.progress({ outTimeSec: 900, speed: 2 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    // 900 s of film in 90 s of wall clock: both halves of the gate, measured rather than
    // taken from ffmpeg's own `speed=`.
    expect(opened).toEqual([{ preparedSec: 900, sustainedSpeed: 10 }]);

    child.progress({ outTimeSec: 7_200, speed: 2, end: true });
    child.exit(0);
    const finish = await fake.waitForChild(2);
    await fsp.writeFile(outputsOf(finish)[0] ?? '', Buffer.alloc(1_024, 7));
    finish.exit(0);
    const result = await run;

    expect(result.result.ok).toBe(true);
    // **The segments are still there when the job reports success**, because a television is
    // still reading them. The MP4 is beside the source already.
    expect(await fsp.readdir(films)).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);
    expect(
      await fsp.stat(path.join(working, 'headstart')).then(
        () => true,
        () => false,
      ),
    ).toBe(true);

    await result.discardSegments();
    expect(
      await fsp.stat(path.join(working, 'headstart')).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  });
});

describe('the throttles that exist only for the selftest', () => {
  it('runs the whole conversion slowly for the starved case', async () => {
    const fake = createFakeSpawn();
    const pipeline = createPreparationPipeline({
      logger: createLogger({ sink, bindings: {} }),
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      runFfprobe: () => Promise.resolve({ ok: true as const, probe: probeOf(SOURCE()) }),
      workingDir: working,
      freeBytes: ROOMY,
      spawn: fake.spawn,
      conversionReadRate: 0.7,
    });
    void pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();
    // An **input** option, before `-i`: it throttles how fast ffmpeg reads the film, which
    // is the only honest way to make a real conversion run slowly.
    expect(child.args.indexOf('-readrate')).toBeLessThan(child.args.indexOf('-i'));
    expect(child.args[child.args.indexOf('-readrate') + 1]).toBe('0.7');
    // No burst: this run is starved from the first frame, so the gate never opens.
    expect(child.args).not.toContain('-readrate_initial_burst');
    child.exit(1);
  });

  it('bursts past the gate first when the conversion is meant to fall behind mid-film', async () => {
    const fake = createFakeSpawn();
    const pipeline = createPreparationPipeline({
      logger: createLogger({ sink, bindings: {} }),
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      runFfprobe: () => Promise.resolve({ ok: true as const, probe: probeOf(SOURCE()) }),
      workingDir: working,
      freeBytes: ROOMY,
      spawn: fake.spawn,
      conversionReadRate: 0.5,
      conversionReadRateBurstSec: 660,
    });
    void pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();
    // **The only route to a guard hold on a real television.** Full speed until there is
    // more than the ten minutes the gate wants, then below real time so the frontier walks
    // into the playhead — the 2026-08-21 condition, with the guard in place.
    expect(child.args[child.args.indexOf('-readrate') + 1]).toBe('0.5');
    expect(child.args[child.args.indexOf('-readrate_initial_burst') + 1]).toBe('660');
    expect(child.args.indexOf('-readrate_initial_burst')).toBeLessThan(child.args.indexOf('-i'));
    // The burst has to clear the gate, or the run proves nothing: ten minutes and a margin.
    expect(660).toBeGreaterThan(600);
    child.exit(1);
  });

  it('says nothing about read rates on an ordinary conversion', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    void pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();
    // The founder's own conversions run as fast as their PC manages. Nothing here is
    // reachable from the app: there is no intent, no setting and no UI for it.
    expect(child.args).not.toContain('-readrate');
    expect(child.args).not.toContain('-readrate_initial_burst');
    child.exit(1);
  });
});

describe('what a head-start job will not do', () => {
  it('does not retry, because a retry would delete what a television is reading', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    const run = pipeline.prepareWithHeadStart(request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();
    child.stderr('Conversion failed!');
    child.exit(1);
    await run;
    // P3's automatic retry exists for a job nobody has seen. Restarting a conversion that is
    // feeding a live playlist would pull the segments out from under the film.
    expect(fake.children).toHaveLength(1);
  });

  it('refuses a plan that is not a conversion, rather than inventing one', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    const remux: PrepareRequest = {
      ...request(),
      verdict: classify(
        probeOf(report({ formatName: 'matroska,webm', durationSec: 7_200 })),
        BASELINE_PROFILE,
      ),
    };
    const result = await pipeline.prepareWithHeadStart(remux, {}, new AbortController().signal);
    expect(result.result.ok).toBe(false);
    // A remux is seconds of work; publishing it as a growing playlist would add a serving
    // shape, a guard and a tidy-up to a wait the founder barely sees.
    expect(fake.children).toHaveLength(0);
  });
});
