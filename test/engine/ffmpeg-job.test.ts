import { describe, expect, it } from 'vitest';
import { buildArgs, runFfmpegJob } from '../../src/engine/prepare/ffmpeg-job.js';
import type { JobProgress, JobRequest } from '../../src/engine/prepare/ffmpeg-job.js';
import { BASELINE_OUTPUT, NVENC_OUTPUT } from '../../src/engine/prepare/output-profiles.js';
import { BASELINE_PROFILE } from '../../src/engine/prepare/device-profiles.js';
import { createFakeSpawn } from './fixtures/spawn.js';

/**
 * The one place ffmpeg is spawned, held to the three things it exists to guarantee: the
 * right arguments, honest progress, and a cancel that really stops.
 *
 * Every case here uses a scripted child process — see `fixtures/spawn.ts` for why that fake
 * is written to be *unkind*. No binary is spawned, which is what lets these run in WSL where
 * a Windows ffmpeg cannot execute.
 */

const binaries = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };

function request(overrides: Partial<JobRequest> = {}): JobRequest {
  return {
    sourcePath: '/films/Cars.mkv',
    outputPath: '/films/Cars (CastGood).mp4.partial',
    plan: { kind: 'remux', container: 'mp4', subtitleTracks: [] },
    deviceProfile: BASELINE_PROFILE,
    durationSec: 100,
    subtitleOutputs: [],
    encoder: 'libx264',
    sourceWidth: 1280,
    sourceHeight: 528,
    ...overrides,
  };
}

describe('the arguments', () => {
  it('maps every stream explicitly, because ffmpeg’s default takes one of each', () => {
    // A film with an English track and a director's commentary would silently lose one of
    // them to ffmpeg's default mapping — whichever came second.
    const args = buildArgs(request(), BASELINE_OUTPUT);
    expect(args).toContain('-map');
    expect(args.join(' ')).toContain('-map 0:v:0');
    expect(args.join(' ')).toContain('-map 0:a?');
  });

  it('takes the first video stream, so cover art can never become the picture', () => {
    // The classifier already refuses to treat an attached thumbnail as the picture. This is
    // the same rule at the other end of the pipeline, where it would produce a film that is
    // one still image and would still pass an exit-code check.
    expect(buildArgs(request(), BASELINE_OUTPUT).join(' ')).toContain('-map 0:v:0');
  });

  it('copies every stream for a repackage — that is what lossless means (8c)', () => {
    const args = buildArgs(request(), BASELINE_OUTPUT);
    expect(args.join(' ')).toContain('-c copy');
    expect(args.join(' ')).not.toContain('libx264');
  });

  it('re-encodes only the mismatched stream and copies the rest (Tier 3)', () => {
    const soundOnly = buildArgs(
      request({
        plan: {
          kind: 'transcode',
          container: 'mp4',
          video: 'copy',
          audio: 'aac',
          subtitleTracks: [],
        },
      }),
      BASELINE_OUTPUT,
    ).join(' ');
    // The tier that takes minutes rather than hours: the picture is untouched.
    expect(soundOnly).toContain('-c:v copy');
    expect(soundOnly).toContain('-c:a aac');
    expect(soundOnly).not.toContain('libx264');

    const picture = buildArgs(
      request({
        plan: {
          kind: 'transcode',
          container: 'mp4',
          video: 'h264',
          audio: 'copy',
          subtitleTracks: [],
        },
      }),
      BASELINE_OUTPUT,
    ).join(' ');
    expect(picture).toContain('libx264');
    expect(picture).toContain('-c:a copy');
  });

  it('scales an oversized picture into the box before encoding it (the 4K failure)', () => {
    // **The defect this exists for cost a real conversion on 2026-08-20.** `maxHeight` had
    // been declared on the output profile since it was written and nothing ever read it, so
    // a 3840x1604 film was handed to the encoder with `-level 4.1` attached. NVENC refused
    // — "Invalid Level" — and libx264 would have gone ahead and produced a 4K file the
    // television cannot play *and* that we would never recognise as reusable, so it would
    // be re-converted from scratch every time.
    const args = buildArgs(
      request({
        sourceWidth: 3_840,
        sourceHeight: 1_604,
        plan: {
          kind: 'transcode',
          container: 'mp4',
          video: 'h264',
          audio: 'copy',
          subtitleTracks: [],
        },
      }),
      BASELINE_OUTPUT,
    ).join(' ');
    expect(args).toContain('-vf scale=w=1920:h=1080:force_original_aspect_ratio=decrease');
    // Even dimensions, which 4:2:0 chroma requires — an odd one is a second, more cryptic
    // way to be refused.
    expect(args).toContain('trunc(iw/2)*2');
  });

  it('leaves a picture that already fits completely alone', () => {
    // Never upscales: making a 1280x528 film bigger would spend encode time and disk
    // inventing detail that is not there, and `force_original_aspect_ratio` alone would.
    const args = buildArgs(
      request({
        sourceWidth: 1_280,
        sourceHeight: 528,
        plan: {
          kind: 'transcode',
          container: 'mp4',
          video: 'h264',
          audio: 'copy',
          subtitleTracks: [],
        },
      }),
      BASELINE_OUTPUT,
    ).join(' ');
    expect(args).not.toContain('-vf');
  });

  it('scales for the hardware encoder too — it is the one that refuses', () => {
    const args = buildArgs(
      request({
        sourceWidth: 3_840,
        sourceHeight: 2_160,
        plan: {
          kind: 'transcode',
          container: 'mp4',
          video: 'h264',
          audio: 'copy',
          subtitleTracks: [],
        },
      }),
      NVENC_OUTPUT,
    ).join(' ');
    expect(args).toContain('-vf scale=w=1920:h=1080');
    expect(args).toContain('h264_nvenc');
  });

  it('never scales a stream copy, because nothing is being re-encoded', () => {
    // A remux carries the source's own picture across untouched. Scaling would make it a
    // conversion, which is the opposite of what Tier 2 promises.
    const args = buildArgs(request({ sourceWidth: 3_840, sourceHeight: 2_160 }), BASELINE_OUTPUT);
    expect(args.join(' ')).not.toContain('-vf');
    expect(args.join(' ')).toContain('-c copy');
  });

  it('always writes a faststart MP4, because the alternative is a black screen', () => {
    // Without it a television must fetch the end of a four-gigabyte file over a Range
    // request before it can show anything.
    const args = buildArgs(request(), BASELINE_OUTPUT).join(' ');
    expect(args).toContain('-movflags +faststart');
    expect(args).toContain('-f mp4');
  });

  it('writes each text subtitle track beside the artifact as WebVTT (8e)', () => {
    const args = buildArgs(
      request({
        subtitleOutputs: [
          { index: 2, language: 'eng', outputPath: '/films/Cars (CastGood).eng.vtt.partial' },
          { index: 3, language: 'spa', outputPath: '/films/Cars (CastGood).spa.vtt.partial' },
        ],
      }),
      BASELINE_OUTPUT,
    ).join(' ');
    expect(args).toContain('-map 0:2 -c:s webvtt -f webvtt /films/Cars (CastGood).eng.vtt.partial');
    expect(args).toContain('-map 0:3 -c:s webvtt -f webvtt /films/Cars (CastGood).spa.vtt.partial');
    // One invocation, so it is one pass over the source and one process to cancel.
    expect(args.match(/-i /g)).toHaveLength(1);
  });

  it('never muxes a subtitle into the MP4, because no television can read one there', () => {
    // The Default Media Receiver renders WebVTT, TTML and CEA-608 — **never `mov_text`
    // inside the MP4** (docs/ARCHITECTURE.md §4). A track muxed in would satisfy 8e's
    // letter, be preserved, and be invisible on every television in the house. And a
    // subtitle stream inside `-c copy` from Matroska fails the whole job, which would let a
    // subtitle codec decide whether a film plays at all.
    const args = buildArgs(
      request({
        subtitleOutputs: [
          { index: 2, language: 'eng', outputPath: '/films/Cars (CastGood).eng.vtt.partial' },
        ],
      }),
      BASELINE_OUTPUT,
    );
    expect(args.join(' ')).not.toContain('mov_text');
    // The subtitle mapping comes after the MP4 output, so it belongs to the second output
    // and cannot reach the first.
    expect(args.indexOf('-map')).toBeLessThan(args.indexOf('-f'));
    expect(args.lastIndexOf('-map')).toBeGreaterThan(args.indexOf('.mp4.partial'));
  });

  it('says nothing about subtitles when there are none to carry', () => {
    const args = buildArgs(request(), BASELINE_OUTPUT).join(' ');
    expect(args).not.toContain('webvtt');
    expect(args).not.toContain('-c:s');
  });

  it('passes the paths as arguments, so a filename can never be a command', () => {
    const nasty = '/films/a" & del *.*.mkv';
    const args = buildArgs(request({ sourcePath: nasty }), BASELINE_OUTPUT);
    // One argv element, whole and unquoted. There is no shell anywhere in this path.
    expect(args).toContain(nasty);
  });
});

describe('progress, and the promises made about it', () => {
  it('reads out_time in microseconds, whatever ffmpeg calls the field', () => {
    // `out_time_ms` has carried microseconds for years. A parser that believed the name
    // would report a two-hour film as finishing in seven seconds.
    const fake = createFakeSpawn();
    const seen: JobProgress[] = [];
    const done = runFfmpegJob(request(), {
      binaries,
      spawn: fake.spawn,
      onProgress: (p) => seen.push(p),
    });

    return fake.waitForChild().then(async (child) => {
      child.progress({ outTimeSec: 50, speed: 8 });
      child.progress({ outTimeSec: 100, speed: 8, end: true });
      child.exit(0);
      await done;
      expect(seen[0]?.frontierSec).toBeCloseTo(50, 3);
      expect(seen[0]?.percent).toBeCloseTo(50, 3);
    });
  });

  it('never lets the bar go backwards, even when ffmpeg does', async () => {
    // `out_time` really does step back at a chapter boundary. A bar that retreats is the
    // clearest signal a person can get that an app has lost the plot.
    const fake = createFakeSpawn();
    const seen: JobProgress[] = [];
    const done = runFfmpegJob(request(), {
      binaries,
      spawn: fake.spawn,
      onProgress: (p) => seen.push(p),
    });
    const child = await fake.waitForChild();
    child.progress({ outTimeSec: 60 });
    child.progress({ outTimeSec: 42 });
    child.progress({ outTimeSec: 80, end: true });
    child.exit(0);
    await done;

    const percents = seen.map((p) => p.percent);
    expect(percents).toEqual([...percents].sort((a, b) => a - b));
    expect(percents[1]).toBe(60);
  });

  it('stays silent about the remaining time until it has measured something', async () => {
    // The up-front estimate came from a seed in `config.ts`, whose whole job was to answer
    // before any work existed to measure. Repeating it here would be a guess wearing a
    // measurement's clothes; the honest answer for the first second is no answer.
    const fake = createFakeSpawn();
    const seen: JobProgress[] = [];
    const done = runFfmpegJob(request(), {
      binaries,
      spawn: fake.spawn,
      onProgress: (p) => seen.push(p),
    });
    const child = await fake.waitForChild();
    child.progress({ outTimeSec: 10, speed: 10 });
    child.progress({ outTimeSec: 20, speed: 10 });
    child.progress({ outTimeSec: 30, speed: 10 });
    child.progress({ outTimeSec: 40, speed: 10, end: true });
    child.exit(0);
    await done;

    expect(seen[0]?.secondsRemaining).toBeNull();
    expect(seen[1]?.secondsRemaining).toBeNull();
    // 60 s of film left at 10× real time.
    expect(seen[2]?.secondsRemaining).toBeCloseTo(7, 0);
  });

  it('reaches 100% exactly once, on a clean exit', async () => {
    const fake = createFakeSpawn();
    const seen: JobProgress[] = [];
    const done = runFfmpegJob(request(), {
      binaries,
      spawn: fake.spawn,
      onProgress: (p) => seen.push(p),
    });
    const child = await fake.waitForChild();
    child.progress({ outTimeSec: 99, speed: 5 });
    child.exit(0);
    expect(await done).toEqual({ ok: true });
    expect(seen[seen.length - 1]?.percent).toBe(100);
  });

  it('shows no percentage at all for a film whose length is unknown', async () => {
    // A truncated header gives no duration. Inventing a denominator would produce a bar
    // that races to 100% and then sits there.
    const fake = createFakeSpawn();
    const seen: JobProgress[] = [];
    const done = runFfmpegJob(request({ durationSec: null }), {
      binaries,
      spawn: fake.spawn,
      onProgress: (p) => seen.push(p),
    });
    const child = await fake.waitForChild();
    child.progress({ outTimeSec: 30, speed: 4 });
    child.exit(0);
    await done;
    expect(seen[0]?.percent).toBe(0);
    expect(seen[0]?.frontierSec).toBeCloseTo(30, 3);
    expect(seen[0]?.secondsRemaining).toBeNull();
  });
});

describe('how a job ends', () => {
  it('kills the process on abort, and reports a cancel rather than a failure', async () => {
    const abort = new AbortController();
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), { binaries, spawn: fake.spawn, signal: abort.signal });
    const child = await fake.waitForChild();
    abort.abort();
    expect(await done).toEqual({ ok: false, failure: 'cancelled' });
    expect(child.killed).toBe(true);
  });

  it('does not answer until the process has actually gone', async () => {
    // **The bug this exists for was found on hardware, and Linux cannot show it.** This used
    // to resolve on the kill and let the caller delete the staging file while ffmpeg still
    // held it open: `unlink` on an open file is fine here and is `EBUSY` on Windows, so a
    // `.partial` was left beside the founder's film — exactly what 8d promises never happens.
    //
    // The discriminator is timing, and it is exact. The old code called `finish()`
    // **synchronously** inside the abort handler, so the promise settled on the next
    // microtask. The fake emits `close` on a macrotask, as a real process does. So: abort,
    // drain the microtask queue, and the promise must still be pending.
    const abort = new AbortController();
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), { binaries, spawn: fake.spawn, signal: abort.signal });
    const child = await fake.waitForChild();

    let settled = false;
    void done.then(() => {
      settled = true;
    });

    abort.abort();
    expect(child.killed, 'the kill goes out immediately — only the answer waits').toBe(true);
    for (let drain = 0; drain < 10; drain += 1) await Promise.resolve();
    expect(settled, 'the job answered before the process had exited').toBe(false);

    expect(await done).toEqual({ ok: false, failure: 'cancelled' });
  });

  it('still answers when a killed process refuses to die', async () => {
    // The backstop. A cancel that hung forever would be worse than one that answers a moment
    // early — 8d promises 2 s — so the wait is bounded and the caller's retrying delete is
    // what covers the rest.
    const abort = new AbortController();
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), {
      binaries,
      spawn: fake.spawn,
      signal: abort.signal,
      exitWaitMs: 20,
      // A process that swallows the kill: `close` never comes.
      onProgress: () => undefined,
    });
    const child = await fake.waitForChild();
    (child as unknown as { ignoreKill?: boolean }).ignoreKill = true;
    abort.abort();
    expect(await done).toEqual({ ok: false, failure: 'cancelled' });
  });

  it('never starts at all when the signal is already aborted', async () => {
    const abort = new AbortController();
    abort.abort();
    const fake = createFakeSpawn();
    const result = await runFfmpegJob(request(), {
      binaries,
      spawn: fake.spawn,
      signal: abort.signal,
    });
    expect(result).toEqual({ ok: false, failure: 'cancelled' });
    expect(fake.children).toHaveLength(0);
  });

  it('tells a killed process apart from a failed one by the signal', async () => {
    // Node reports a killed process as a signal and **no** exit code. Reading the code alone
    // would turn every cancel into "Couldn't prepare Cars.mkv".
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), { binaries, spawn: fake.spawn });
    const child = await fake.waitForChild();
    // Something outside CastGood killed it — Task Manager, a shutdown.
    child.closeWithSignal();
    expect(await done).toEqual({ ok: false, failure: 'cancelled' });
  });

  it('reads a full disk out of ffmpeg’s own words (P2)', async () => {
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), { binaries, spawn: fake.spawn });
    const child = await fake.waitForChild();
    child.stderr('av_interleaved_write_frame(): No space left on device\n');
    child.exit(1);
    expect(await done).toEqual({ ok: false, failure: 'disk-full' });
  });

  it('reads a vanished source the same way (P7)', async () => {
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), { binaries, spawn: fake.spawn });
    const child = await fake.waitForChild();
    child.stderr('/films/Cars.mkv: No such file or directory\n');
    child.exit(1);
    expect(await done).toEqual({ ok: false, failure: 'source-missing' });
  });

  it('falls back to a plain failure for anything it cannot name (P3)', async () => {
    // And that is the honest outcome: one sentence, *Try again*, detail in the log. A
    // cleverer guess here would put the wrong sentence in front of the founder.
    const fake = createFakeSpawn();
    const done = runFfmpegJob(request(), { binaries, spawn: fake.spawn });
    const child = await fake.waitForChild();
    child.stderr('Invalid data found when processing input\n');
    child.exit(1);
    expect(await done).toEqual({ ok: false, failure: 'failed' });
  });

  it('is a value, not a throw, when the binary will not start', async () => {
    const result = await runFfmpegJob(request(), {
      binaries,
      spawn: () => {
        throw new Error('EMFILE');
      },
    });
    expect(result).toEqual({ ok: false, failure: 'ffmpeg-failed' });
  });
});
