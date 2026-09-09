import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPreparationPipeline } from '../../src/engine/prepare/index.js';
import type { PreparationPipeline, PrepareRequest } from '../../src/engine/prepare/index.js';
import { classify } from '../../src/engine/prepare/classify.js';
import { BASELINE_PROFILE } from '../../src/engine/prepare/device-profiles.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import type { ProbeResult } from '../../src/engine/media/ffprobe.js';
import {
  audioStream,
  mkvH264Aac,
  mkvWithSrt,
  probeOf,
  report,
  subtitleStream,
  videoStream,
} from './fixtures/ffprobe.js';
import { createFakeSpawn, outputOf, outputsOf, runToCompletion } from './fixtures/spawn.js';

/**
 * The pipeline that makes the file, and the promises it keeps about the founder's folder.
 *
 * Everything here runs in WSL against a scripted ffmpeg. That proves the **logic** — the
 * naming, the disk pre-check, the retry, the rename, and above all the cleanup — and it
 * proves nothing whatsoever about a conversion. The 60-second target on a 2-hour file, the
 * losslessness of the picture, and whether a television plays the result are the `remux` and
 * `convert` selftest scenarios and the founder's eyes.
 *
 * The one thing every case here also asserts, in one form or another: **the folder the film
 * came from is left exactly as it was found**, apart from the prepared file itself. That is
 * 8d and P2 and P3, and it is the promise this pipeline could break irreversibly.
 */

let films: string;
let working: string;
let sourcePath: string;
const sink = createMemorySink();

/** The film on disk, as a real file: the pipeline stats it, so it has to exist. */
const SOURCE_BYTES = 4_096;

beforeEach(async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-prep-'));
  films = path.join(root, 'Films');
  working = path.join(root, 'working');
  await fsp.mkdir(films, { recursive: true });
  sourcePath = path.join(films, 'Cars.mkv');
  await fsp.writeFile(sourcePath, Buffer.alloc(SOURCE_BYTES, 1));
  sink.lines.length = 0;
});

afterEach(async () => {
  await fsp.rm(path.dirname(films), { recursive: true, force: true });
});

/** An ffprobe that answers per-path, so the source and the artifact can differ. */
function probeBy(answers: Record<string, ProbeResult | null>): FfprobeRunner {
  return (filePath) => {
    const probe = answers[path.basename(filePath)];
    return Promise.resolve(
      probe === undefined || probe === null
        ? { ok: false as const, failure: 'unreadable' as const }
        : { ok: true as const, probe },
    );
  };
}

function build(options: {
  spawn?: ReturnType<typeof createFakeSpawn>['spawn'];
  runFfprobe?: FfprobeRunner | null;
  binaries?: { ffmpeg: string; ffprobe: string } | null;
}): PreparationPipeline {
  return createPreparationPipeline({
    logger: createLogger({ sink, bindings: {} }),
    binaries:
      options.binaries === undefined ? { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' } : options.binaries,
    runFfprobe: options.runFfprobe === undefined ? probeBy({}) : options.runFfprobe,
    workingDir: working,
    ...(options.spawn === undefined ? {} : { spawn: options.spawn }),
  });
}

/** An MKV of H.264 + AAC: Tier 2 against the baseline, which is the common case. */
function tier2Request(): PrepareRequest {
  const sourceProbe = probeOf(mkvH264Aac());
  return {
    source: { path: sourcePath, name: 'Cars.mkv', sizeBytes: SOURCE_BYTES, mtimeMs: 1 },
    sourceProbe,
    verdict: classify(sourceProbe, BASELINE_PROFILE),
    deviceProfile: BASELINE_PROFILE,
  };
}

async function folderContents(): Promise<string[]> {
  return (await fsp.readdir(films)).sort();
}

describe('finding a film we prepared before (story 9)', () => {
  it('finds the sibling and believes it once ffprobe and the classifier agree (9a)', async () => {
    const artifactPath = path.join(films, 'Cars (CastGood).mp4');
    await fsp.writeFile(artifactPath, Buffer.alloc(2_048, 2));
    const sourceProbe = probeOf(mkvH264Aac());
    const pipeline = build({
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
    });

    const found = await pipeline.findPrepared(sourcePath, sourceProbe, BASELINE_PROFILE);
    expect(found?.path).toBe(artifactPath);
    expect(found?.bytes).toBe(2_048);
  });

  it('re-prepares rather than trusting a sibling whose length no longer matches (9c)', async () => {
    // The founder re-downloaded the film at a different cut. The name is identical and the
    // file is sitting right there; only the duration says it is a different thing.
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(2_048, 2));
    const pipeline = build({
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 3_000 })) }),
    });

    const found = await pipeline.findPrepared(sourcePath, probeOf(mkvH264Aac()), BASELINE_PROFILE);
    expect(found).toBeNull();
  });

  it('refuses a sibling this television cannot play untouched — the profile key (ADR)', async () => {
    // Prepared for a wider device. The classifier saying Tier 1 *is* the profile key, so a
    // sibling that is not Tier 1 here is simply not ours to use.
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(2_048, 2));
    const tooBig = probeOf(
      report({
        durationSec: 6_990,
        streams: [
          { index: 0, codec_name: 'hevc', codec_type: 'video', width: 3_840, height: 2_160 },
          { index: 1, codec_name: 'aac', codec_type: 'audio' },
        ],
      }),
    );
    const pipeline = build({ runFfprobe: probeBy({ 'Cars (CastGood).mp4': tooBig }) });

    expect(
      await pipeline.findPrepared(sourcePath, probeOf(mkvH264Aac()), BASELINE_PROFILE),
    ).toBeNull();
  });

  it('notices a prepared file the founder deleted by hand (9d)', async () => {
    // With no cleanup policy, deleting one by hand *is* the founder's cleanup policy, and
    // it must be safe. Nothing is on disk, so there is nothing to find and nothing to say.
    const pipeline = build({ runFfprobe: probeBy({}) });
    expect(
      await pipeline.findPrepared(sourcePath, probeOf(mkvH264Aac()), BASELINE_PROFILE),
    ).toBeNull();
  });

  it('never serves a sibling ffprobe cannot read', async () => {
    // Half-written by a run that died. Serving it is the worst available outcome: a wait,
    // and then a television that refuses the file.
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(16, 0));
    const pipeline = build({ runFfprobe: probeBy({}) });
    expect(
      await pipeline.findPrepared(sourcePath, probeOf(mkvH264Aac()), BASELINE_PROFILE),
    ).toBeNull();
  });
});

describe('preparing one, from the press to the file', () => {
  it('writes beside the source, under a name the founder can read (8a, 9e)', async () => {
    const fake = createFakeSpawn();
    const artifact = probeOf(report({ durationSec: 6_990 }));
    const pipeline = build({
      spawn: fake.spawn,
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': artifact }),
    });

    const done = pipeline.prepare(tier2Request(), {}, new AbortController().signal);
    const child = await fake.waitForChild();
    // The staging name, not the artifact's — the rename is the finishing move.
    expect(path.basename(outputOf(child))).toBe('Cars (CastGood).mp4.partial');
    await runToCompletion(child, { durationSec: 6_990, bytes: 3_000 });

    const result = await done;
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.artifact.path).toBe(path.join(films, 'Cars (CastGood).mp4'));
      expect(result.artifact.bytes).toBe(3_000);
      expect(result.artifact.fallbackDirectory).toBeNull();
    }
    // The film, the prepared copy, and nothing else. No staging file, no folder of
    // fragments, nothing to tidy up by hand.
    expect(await folderContents()).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);
  });

  it('reports progress the founder can watch, and reaches the end', async () => {
    const fake = createFakeSpawn();
    const percents: number[] = [];
    const pipeline = build({
      spawn: fake.spawn,
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
    });

    const done = pipeline.prepare(
      tier2Request(),
      { onProgress: (p) => percents.push(p.percent) },
      new AbortController().signal,
    );
    await runToCompletion(await fake.waitForChild(), { durationSec: 6_990 });
    await done;

    expect(percents.length).toBeGreaterThan(1);
    expect(percents[percents.length - 1]).toBe(100);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
  });

  it('stops on cancel and leaves the folder exactly as it was (8d)', async () => {
    const before = await folderContents();
    const abort = new AbortController();
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });

    const done = pipeline.prepare(tier2Request(), {}, abort.signal);
    const child = await fake.waitForChild();
    // Part-way through, with bytes already on disk — the case where a naive cleanup leaves
    // a four-gigabyte `.partial` in the founder's films folder.
    await fsp.writeFile(outputOf(child), Buffer.alloc(2_048, 9));
    child.progress({ outTimeSec: 500, speed: 10 });
    abort.abort();

    expect(await done).toEqual({ ok: false, failure: { kind: 'cancelled' } });
    expect(child.killed).toBe(true);
    expect(await folderContents()).toEqual(before);
  });

  it('retries a failed conversion exactly once, silently, before saying anything (P3)', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({
      spawn: fake.spawn,
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
    });

    const done = pipeline.prepare(tier2Request(), {}, new AbortController().signal);
    const first = await fake.waitForChild(1);
    first.stderr('Invalid data found when processing input\n');
    first.exit(1);
    // The second attempt succeeds, so the founder is never told anything at all.
    await runToCompletion(await fake.waitForChild(2), { durationSec: 6_990 });

    expect((await done).ok).toBe(true);
    expect(fake.children).toHaveLength(2);
  });

  it('gives up after the second failure, with one sentence and nothing left behind (P3)', async () => {
    const before = await folderContents();
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });

    const done = pipeline.prepare(tier2Request(), {}, new AbortController().signal);
    for (const attempt of [1, 2]) {
      const child = await fake.waitForChild(attempt);
      await fsp.writeFile(outputOf(child), Buffer.alloc(512, 3));
      child.stderr('Invalid data found when processing input\n');
      child.exit(1);
    }

    expect(await done).toEqual({ ok: false, failure: { kind: 'failed', attempts: 2 } });
    // Exactly two: "the state model says retries once, restated so the selftest can count
    // it rather than infer it".
    expect(fake.children).toHaveLength(2);
    expect(await folderContents()).toEqual(before);
  });

  it('does not retry a cancel, a full disk or a vanished source', async () => {
    for (const [stderr, expected] of [
      ['No space left on device', 'disk-space'],
      ['Cars.mkv: No such file or directory', 'source-missing'],
    ] as const) {
      const fake = createFakeSpawn();
      const pipeline = build({ spawn: fake.spawn });
      const done = pipeline.prepare(tier2Request(), {}, new AbortController().signal);
      const child = await fake.waitForChild();
      child.stderr(`${stderr}\n`);
      child.exit(1);
      const result = await done;
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.failure.kind).toBe(expected);
      // A second attempt at a disk that is full is a second wait for the same answer.
      expect(fake.children).toHaveLength(1);
    }
  });

  it('falls back to the working folder when the film’s own folder is read-only (9e)', async () => {
    // A network share, a read-only drive. The founder asked for a location, not for a cast
    // to die when that location is unavailable.
    await fsp.chmod(films, 0o500);
    try {
      const fake = createFakeSpawn();
      const pipeline = build({
        spawn: fake.spawn,
        runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
      });
      const locations: { directory: string; fallback: boolean }[] = [];

      const done = pipeline.prepare(
        tier2Request(),
        { onLocationChosen: (directory, fallback) => locations.push({ directory, fallback }) },
        new AbortController().signal,
      );
      await runToCompletion(await fake.waitForChild(), { durationSec: 6_990 });
      const result = await done;

      // Said **before** a byte is written, so the founder learns where their file is going
      // before it is four gigabytes into going there.
      expect(locations).toEqual([{ directory: working, fallback: true }]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.artifact.path).toBe(path.join(working, 'Cars (CastGood).mp4'));
        expect(result.artifact.fallbackDirectory).toBe(working);
      }
      // The name is unchanged by the location, so a file copied back beside the film is
      // still recognisably the prepared copy.
      expect(await fsp.readdir(working)).toEqual(['Cars (CastGood).mp4']);
    } finally {
      await fsp.chmod(films, 0o700);
    }
  });

  it('refuses before any work begins when the job will not fit (P1)', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    const request = tier2Request();
    // A four-exabyte film. Nothing on this machine has room for it, and the point is that
    // nobody has to find that out at 80%.
    const huge: PrepareRequest = {
      ...request,
      verdict: { ...request.verdict, estimatedBytes: Number.MAX_SAFE_INTEGER },
    };

    const result = await pipeline.prepare(huge, {}, new AbortController().signal);
    expect(result.ok).toBe(false);
    if (!result.ok && result.failure.kind === 'disk-space') {
      expect(result.failure.room.message).toContain('needs about');
    } else {
      expect.unreachable('a job that cannot fit must be refused as disk-space');
    }
    // **Before any work begins**: ffmpeg was never started, and nothing was written.
    expect(fake.children).toHaveLength(0);
    expect(await folderContents()).toEqual(['Cars.mkv']);
  });

  it('removes an artifact it wrote but cannot read back', async () => {
    // We produced a file ffprobe will not open. Handing that to a television is a wait
    // followed by a refusal — the worst outcome available — so it goes.
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn, runFfprobe: probeBy({}) });
    const done = pipeline.prepare(tier2Request(), {}, new AbortController().signal);
    await runToCompletion(await fake.waitForChild(), { durationSec: 6_990 });

    expect((await done).ok).toBe(false);
    expect(await folderContents()).toEqual(['Cars.mkv']);
  });

  it('clears a staging file left by a run that died before it could tidy up', async () => {
    const orphan = path.join(films, 'Cars (CastGood).mp4.partial');
    await fsp.writeFile(orphan, Buffer.alloc(9_999, 4));
    const fake = createFakeSpawn();
    const pipeline = build({
      spawn: fake.spawn,
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
    });

    const done = pipeline.prepare(tier2Request(), {}, new AbortController().signal);
    await runToCompletion(await fake.waitForChild(), { durationSec: 6_990, bytes: 500 });
    await done;
    expect(await folderContents()).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);
  });

  it('writes each text subtitle beside the artifact, and cleans them up together (8e)', async () => {
    const fake = createFakeSpawn();
    const pipeline = build({
      spawn: fake.spawn,
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
    });
    const sourceProbe = probeOf(mkvWithSrt());
    const request: PrepareRequest = {
      source: { path: sourcePath, name: 'Cars.mkv', sizeBytes: SOURCE_BYTES, mtimeMs: 1 },
      sourceProbe,
      verdict: classify(sourceProbe, BASELINE_PROFILE),
      deviceProfile: BASELINE_PROFILE,
    };

    const done = pipeline.prepare(request, {}, new AbortController().signal);
    const child = await fake.waitForChild();
    // ffmpeg writes both outputs in one invocation, so the fake writes both too.
    await fsp.writeFile(outputOf(child), Buffer.alloc(3_000, 7));
    const vtt = outputsOf(child)[1] ?? '';
    expect(path.basename(vtt)).toBe('Cars (CastGood).eng.vtt.partial');
    await fsp.writeFile(vtt, 'WEBVTT\n');
    child.progress({ outTimeSec: 6_990, speed: 30, end: true });
    child.exit(0);

    expect((await done).ok).toBe(true);
    expect(await folderContents()).toEqual([
      'Cars (CastGood).eng.vtt',
      'Cars (CastGood).mp4',
      'Cars.mkv',
    ]);
  });

  it('publishes the film even when a subtitle cannot be written', async () => {
    // **This is the defect that cost the founder eighteen minutes** (2026-08-20). A 3.4 GB
    // conversion completed, was renamed into place, and was then *deleted* because a `.vtt`
    // ffmpeg had never written could not be renamed. `docs/ARCHITECTURE.md` §4 already said
    // "a subtitle codec must not be able to fail the job" — the rule was applied to the
    // ffmpeg invocation and not to the publish that follows it.
    const fake = createFakeSpawn();
    const pipeline = build({
      spawn: fake.spawn,
      runFfprobe: probeBy({ 'Cars (CastGood).mp4': probeOf(report({ durationSec: 6_990 })) }),
    });
    const sourceProbe = probeOf(mkvWithSrt());
    const request: PrepareRequest = {
      source: { path: sourcePath, name: 'Cars.mkv', sizeBytes: SOURCE_BYTES, mtimeMs: 1 },
      sourceProbe,
      verdict: classify(sourceProbe, BASELINE_PROFILE),
      deviceProfile: BASELINE_PROFILE,
    };

    const done = pipeline.prepare(request, {}, new AbortController().signal);
    const child = await fake.waitForChild();
    // The film is written; the subtitle is **not** — exactly what happened on hardware.
    await fsp.writeFile(outputOf(child), Buffer.alloc(3_000, 7));
    child.progress({ outTimeSec: 6_990, speed: 30, end: true });
    child.exit(0);

    const result = await done;
    expect(result.ok, 'the film must survive a subtitle that never arrived').toBe(true);
    // The film is there, under its own name, ready to cast. The missing track is a defect
    // in the log, not an outcome the founder pays eighteen minutes for.
    expect(await folderContents()).toEqual(['Cars (CastGood).mp4', 'Cars.mkv']);
    expect(sink.lines.join('')).toContain('prepare.subtitle_lost');
  });

  it('gives two tracks of the same language two different files', async () => {
    // A film with "English" and "English SDH" is ordinary, and both report `eng`. Naming
    // them both after the language told ffmpeg to write two outputs to one path.
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    const twoEnglish = probeOf(
      report({
        formatName: 'matroska,webm',
        streams: [
          videoStream(),
          audioStream(),
          subtitleStream({ index: 2 }),
          subtitleStream({ index: 3 }),
        ],
      }),
    );
    const request: PrepareRequest = {
      source: { path: sourcePath, name: 'Cars.mkv', sizeBytes: SOURCE_BYTES, mtimeMs: 1 },
      sourceProbe: twoEnglish,
      verdict: classify(twoEnglish, BASELINE_PROFILE),
      deviceProfile: BASELINE_PROFILE,
    };

    void pipeline.prepare(request, {}, new AbortController().signal);
    const child = await fake.waitForChild();
    const outs = outputsOf(child);
    expect(outs).toHaveLength(3);
    expect(new Set(outs).size, `ffmpeg was told to write ${outs.join(' and ')}`).toBe(3);
    expect(outs.map((o) => path.basename(o))).toEqual([
      'Cars (CastGood).mp4.partial',
      'Cars (CastGood).eng.vtt.partial',
      'Cars (CastGood).eng2.vtt.partial',
    ]);
    child.exit(1);
  });

  it('leaves no half-written subtitle behind when the job fails (8d, P3)', async () => {
    // A job that wrote three files must not leave two of them. A stranded `.vtt` is the
    // same defect as a stranded `.partial`, in a smaller file that is easier to miss.
    const before = await folderContents();
    const fake = createFakeSpawn();
    const pipeline = build({ spawn: fake.spawn });
    const sourceProbe = probeOf(mkvWithSrt());
    const request: PrepareRequest = {
      source: { path: sourcePath, name: 'Cars.mkv', sizeBytes: SOURCE_BYTES, mtimeMs: 1 },
      sourceProbe,
      verdict: classify(sourceProbe, BASELINE_PROFILE),
      deviceProfile: BASELINE_PROFILE,
    };

    const done = pipeline.prepare(request, {}, new AbortController().signal);
    for (const attempt of [1, 2]) {
      const child = await fake.waitForChild(attempt);
      await fsp.writeFile(outputOf(child), Buffer.alloc(512, 3));
      await fsp.writeFile(outputsOf(child)[1] ?? '', 'WEBVTT\n');
      child.stderr('Invalid data found when processing input\n');
      child.exit(1);
    }

    expect((await done).ok).toBe(false);
    expect(await folderContents()).toEqual(before);
  });

  it('is a value rather than a throw when there is no ffmpeg on this machine', async () => {
    const pipeline = build({ binaries: null, runFfprobe: null });
    expect(await pipeline.prepare(tier2Request(), {}, new AbortController().signal)).toEqual({
      ok: false,
      failure: { kind: 'ffmpeg-missing' },
    });
  });
});
