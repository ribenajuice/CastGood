import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import path from 'node:path';
import { PREPARATION } from '../config.js';
import type { Logger } from '../logging/index.js';
import type { FfmpegBinaries } from '../media/ffmpeg.js';
import type { SpawnLike } from '../media/ffprobe-runner.js';
import type { PreparationPlan, SubtitleTrack } from './classify.js';
import { outputProfileFor, type OutputProfile } from './output-profiles.js';
import type { VideoEncoder } from './encoders.js';
import type { DeviceProfile } from '../types.js';

/**
 * The one place ffmpeg is spawned, and the one place its progress is believed.
 *
 * `ffprobe-runner.ts` is the same shape for the *question* half of the pipeline; this is the
 * *work* half. Everything above it sees `runFfmpegJob(...)`: one plan, one output path, one
 * result, no exceptions, and a stream of progress it can put on a screen.
 *
 * ## The three things this file is actually for
 *
 * **It writes to a staging path and never to the artifact's own name.** The caller renames
 * on success. A job that is cancelled, that fails, or whose process is killed with the app
 * has therefore left exactly one file behind, under a name nothing else will ever read, and
 * removing it is the whole of the cleanup (8d, P2, P3, P6, P7).
 *
 * **It reports progress from `-progress pipe:1 -nostats`, which is machine-readable by
 * design.** Nobody parses ffmpeg's stderr here — that has been the plan since 2026-08-13 and
 * the encoder ADR turns on it, because `speed=1.5x` is the exact number M3b's head-start
 * gate is specified against. M3a does not gate on it; it shows it to the founder as an
 * estimate, which is criterion 8b's honesty clause: *"a 3-minute job is never announced as
 * 20 seconds"*.
 *
 * **It never lets the progress bar go backwards.** The number M3 adds for testability says
 * so in as many words, and it is not cosmetic: a bar that retreats is the single clearest
 * signal a person can get that an app does not know what it is doing.
 *
 * ## What it refuses to do
 *
 *  - **Never throws.** Same rule as the probe runner: every failure is a value, because this
 *    runs behind a button the founder pressed.
 *  - **Never uses a shell.** Paths are argv elements. A film called `a" & del *.*.mkv` is a
 *    filename.
 *  - **Never chooses encoder settings inline.** They come from `output-profiles.ts`, which
 *    is where the encoder ADR requires them to live.
 */

/** Why a job did not produce a file. Four facts, told four different ways by the caller. */
export type JobFailure =
  /** ffmpeg ran and gave up on the file. Retried once (P3), then reported. */
  | 'failed'
  /** The founder cancelled, or the app is closing. Nobody is told anything (8d, P6). */
  | 'cancelled'
  /** The source went away underneath us (P7). M2's existing sentence covers it. */
  | 'source-missing'
  /** The volume filled during the job (P2). */
  | 'disk-full'
  /** The binary would not start. In a packaged install, a damaged installation. */
  | 'ffmpeg-failed';

export type JobResult =
  { readonly ok: true } | { readonly ok: false; readonly failure: JobFailure };

export interface JobProgress {
  /** 0–100, monotonic. Never goes backwards, even when ffmpeg's own numbers do. */
  readonly percent: number;
  /** Seconds of output written so far — the conversion frontier. M3b gates on this. */
  readonly frontierSec: number;
  /** ffmpeg's own `speed=`, rolling-averaged. `null` until it has said one. */
  readonly speed: number | null;
  /** `null` until there is enough evidence to be honest about it. */
  readonly secondsRemaining: number | null;
  /** What the output weighs so far. The pre-flight estimate is checked against this. */
  readonly bytesWritten: number;
}

export interface JobRequest {
  readonly sourcePath: string;
  /** The staging path. The caller renames it into place; this file never does. */
  readonly outputPath: string;
  readonly plan: PreparationPlan;
  readonly deviceProfile: DeviceProfile;
  /** From the source probe. Drives percent and the estimate; `null` means neither is shown. */
  readonly durationSec: number | null;
  /** Which encoder this machine can actually open. See `detectVideoEncoder`. */
  readonly encoder: VideoEncoder;
  /**
   * The source picture's size, so an oversized one can be brought inside the output
   * profile's box. `null` when the container did not say — the classifier refuses such a
   * file as damaged long before a job is asked for, so this is belt and braces.
   */
  readonly sourceWidth: number | null;
  readonly sourceHeight: number | null;
  /**
   * 8e: text subtitle tracks to carry out of the source, each to its own WebVTT file.
   *
   * Paths are the **staging** ones — the caller renames them into place beside the artifact,
   * exactly as it does the MP4 — so a cancelled or failed job leaves nothing under a name
   * anything else would read.
   */
  readonly subtitleOutputs: readonly SubtitleOutput[];
  /**
   * M3b: write the picture as a **growing HLS playlist** instead of one MP4.
   *
   * Absent — the M3a shape — means one faststart MP4 and nothing else changes. Present, the
   * same conversion, at the same output profile, publishes segments as it goes so watching
   * can start before it finishes. One job, one encoder, one artifact in the end, two
   * releases: the segments are remuxed losslessly into that same MP4 when ffmpeg is done
   * (10g), so nothing about the founder's folder differs afterwards.
   */
  readonly hls?: HlsOutput;
  /**
   * Deliberately slow the conversion down, as a multiple of real time (`-readrate`).
   *
   * **This exists for one thing: producing the starved case through the product** rather
   * than through a spike script. The 2026-08-21 run — a conversion publishing at 0.7× while
   * a television watched — is the failure story 10 exists to prevent, and until now the only
   * way to produce it was a fixture republished on a timer, which is a fact about the
   * fixture. `--rate 0.7` on the selftest makes the *real* pipeline run that slowly.
   *
   * It is reachable from the selftest's command line and from nowhere else: there is no
   * intent for it, no setting, and no UI. Undefined in the app, always.
   */
  readonly readRate?: number;
  /**
   * Seconds of film to convert **at full speed before `readRate` engages**
   * (`-readrate_initial_burst`).
   *
   * This is what makes the guard reachable on a real television at all, and it is the whole
   * of `--rate-after-gate`. A conversion throttled from the first frame never satisfies the
   * head-start gate, so nothing is ever loaded and there is no film to hold — which left
   * **10b, the promise nothing in M3 may weaken, with no device evidence for the mechanism
   * that carries it**. Burst past the gate, then fall below real time, and the frontier walks
   * into the playhead exactly as it did on 2026-08-21 — with the guard in place this time.
   *
   * Selftest only, like `readRate` itself.
   */
  readonly readRateBurstSec?: number;
}

export interface HlsOutput {
  /** ffmpeg's own playlist. Read by the media server, **never served** to a device. */
  readonly playlistPath: string;
  /** `-hls_segment_filename`, e.g. `…/segment%05d.ts`. Absolute, and in our working dir. */
  readonly segmentPattern: string;
}

export interface SubtitleOutput extends SubtitleTrack {
  /** Where this track is written. One `.vtt` per track, beside the artifact. */
  readonly outputPath: string;
}

export interface JobDeps {
  readonly binaries: FfmpegBinaries;
  readonly logger?: Logger;
  readonly spawn?: SpawnLike;
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: JobProgress) => void;
  /** How long a killed process is given to actually exit. Injected by tests. */
  readonly exitWaitMs?: number;
}

/** Just enough stderr to diagnose a failed conversion from. Never rendered (7a). */
const STDERR_SAMPLE_BYTES = 4_000;

/**
 * Substrings of ffmpeg's own stderr that name a cause we can tell the founder about.
 *
 * Deliberately short and deliberately not clever. A wrong guess here would put the wrong
 * sentence on screen, and P3 already has an honest fallback for everything unmatched: the
 * detail goes to the log, and the founder gets *"Couldn't prepare \<filename\>"* with *Try
 * again*. This exists only for the two causes that have their own product behaviour.
 */
const DISK_FULL_MARKERS = ['no space left', 'enospc', 'disk full'];
const SOURCE_GONE_MARKERS = ['no such file or directory', 'enoent'];

function classifyStderr(stderr: string): JobFailure {
  const haystack = stderr.toLowerCase();
  if (DISK_FULL_MARKERS.some((marker) => haystack.includes(marker))) return 'disk-full';
  if (SOURCE_GONE_MARKERS.some((marker) => haystack.includes(marker))) return 'source-missing';
  return 'failed';
}

/**
 * The arguments, built from the plan rather than from a template string.
 *
 * Reading order matters here, so the order below is the order ffmpeg wants it: global
 * options, then the input, then what to do with it, then the output.
 *
 * **`-map` is explicit and it is not optional.** ffmpeg's default mapping picks *one* stream
 * of each type, which for a film with an English track and a director's commentary silently
 * picks whichever one comes first. `-map 0:v:0` takes the picture (the *first* video stream,
 * so a cover-art thumbnail cannot become the film — the classifier already refuses to treat
 * one as the picture and this is the same rule at the other end of the pipeline);
 * `-map 0:a` takes every sound track; each subtitle stream is mapped by index.
 *
 * **`-movflags +faststart` costs a second pass over the file** and is why the remux seed in
 * `config.ts` assumes the job moves roughly twice the bytes. It is not optional either: it
 * puts the index at the front, and without it a television must fetch the end of a four
 * gigabyte file before it can start, over a `Range` request, on a LAN, while the founder
 * watches a black screen.
 */
/**
 * The scale filter, or `null` when the picture already fits.
 *
 * **Never upscales.** A 1280×528 film stays 1280×528: making it bigger would cost encode
 * time and disk to invent detail that is not there, and `force_original_aspect_ratio` alone
 * would happily do it.
 *
 * `-2` rounding keeps both dimensions even, which H.264's 4:2:0 chroma requires — an odd
 * dimension is a second way to be refused by an encoder, and it would be a cryptic one.
 */
function scaleFilterFor(request: JobRequest, output: OutputProfile): string | null {
  const { sourceWidth: w, sourceHeight: h } = request;
  const maxW = output.maxWidth;
  const maxH = output.maxHeight;
  if (w === null || h === null || maxW === null || maxH === null) return null;
  if (w <= maxW && h <= maxH) return null;
  return `scale=w=${String(maxW)}:h=${String(maxH)}:force_original_aspect_ratio=decrease,scale=trunc(iw/2)*2:trunc(ih/2)*2`;
}

export function buildArgs(request: JobRequest, output: OutputProfile): string[] {
  const args = ['-hide_banner', '-nostdin', '-loglevel', 'error', '-y'];
  // Before `-i`, because it is an **input** option: it throttles how fast ffmpeg reads the
  // film, which is the only honest way to make a real conversion run slowly. Anything that
  // throttled the output would change what was produced as well as when.
  if (request.readRate !== undefined) {
    args.push('-readrate', String(request.readRate));
    // Ordered after `-readrate` because it modifies it: the first `n` seconds of *input*
    // are read as fast as the machine manages, and only then does the throttle apply.
    if (request.readRateBurstSec !== undefined) {
      args.push('-readrate_initial_burst', String(request.readRateBurstSec));
    }
  }
  args.push('-i', path.resolve(request.sourcePath));

  // --- Output 1: the film itself. Video and audio, and **deliberately no subtitles.**
  args.push('-map', '0:v:0', '-map', '0:a?');
  if (request.plan.kind === 'remux') {
    args.push('-c', 'copy');
  } else if (request.plan.kind === 'transcode') {
    if (request.plan.video === 'copy') {
      args.push('-c:v', 'copy');
    } else {
      // **Bring an oversized picture inside the box before encoding it.** This is where a
      // 4K film broke on 2026-08-20: `maxHeight` had been declared on the output profile
      // since it was written and **nothing ever read it**, so a 3840×1604 source was handed
      // to the encoder with `-level 4.1` attached. NVENC refused outright — *"Invalid
      // Level"* — and libx264 would have gone ahead and produced a 4K file that the
      // television cannot play *and* that we would never recognise as reusable, so it would
      // have been re-converted from scratch every single time.
      const scale = scaleFilterFor(request, output);
      if (scale !== null) args.push('-vf', scale);
      args.push(...output.videoArgs);
    }
    args.push(...(request.plan.audio === 'copy' ? ['-c:a', 'copy'] : output.audioArgs));
  }
  if (request.hls === undefined) {
    args.push('-movflags', '+faststart', '-f', 'mp4', path.resolve(request.outputPath));
  } else {
    args.push(...hlsArgs(request, request.hls));
  }

  // --- Outputs 2..n: one WebVTT file per text subtitle track, in the same invocation.
  //
  // 8e, and the reason it is a *second output* rather than a `-c:s` on the first is written
  // on `SubtitleTrack`: the Default Media Receiver renders WebVTT and never `mov_text`, so a
  // track muxed into the MP4 would be preserved and unreadable at the same time. And a
  // subtitle stream inside `-c copy` from Matroska fails the whole job, which would let a
  // subtitle codec decide whether a film plays at all.
  //
  // Same invocation, so it is one pass over the source rather than two, and one process to
  // cancel.
  for (const track of request.subtitleOutputs) {
    args.push(
      '-map',
      `0:${String(track.index)}`,
      '-c:s',
      'webvtt',
      '-f',
      'webvtt',
      path.resolve(track.outputPath),
    );
  }
  return args;
}

/**
 * The growing-playlist working set, and **every flag in it is a measurement.**
 *
 * `-hls_time 4` is a *floor*, not a promise: segments can only start on a keyframe, so on a
 * stream copy the film's own GOPs decide the boundaries and SPIKE-1's fixture produced
 * segments from 0.96 s to 12.26 s against a `-hls_time 4`. That is why the playlist we
 * publish computes its `TARGETDURATION` from the segments rather than from this number, and
 * why `-force_key_frames` is here at all: when we *are* re-encoding the picture we can
 * choose where the keyframes go, and 4-second segments cost the founder a third of the seek
 * horizon and a third of the new-content latency that 12-second ones would.
 *
 * `-hls_list_size 0` keeps every segment in the list — an EVENT playlist never drops one,
 * and a receiver that rejoins must find the beginning of the film still named.
 *
 * `-hls_playlist_type event` is the line the whole 2026-08-13 ADR turns on: it withholds
 * `#EXT-X-ENDLIST` until the conversion finishes, and **ENDLIST alone decides live-vs-VOD**
 * — observed, not merely documented, on two device classes that were both sent
 * `streamType: BUFFERED` (the VOD answer) and applied live semantics anyway.
 */
function hlsArgs(request: JobRequest, hls: HlsOutput): string[] {
  const args: string[] = [];
  // Only meaningful when we are choosing the keyframes, i.e. re-encoding the picture. On a
  // stream copy ffmpeg cannot move a keyframe it did not create, and asking it to would
  // either be ignored or force a re-encode nobody asked for.
  if (request.plan.kind === 'transcode' && request.plan.video !== 'copy') {
    args.push('-force_key_frames', `expr:gte(t,n_forced*${String(PREPARATION.hlsSegmentSeconds)})`);
  }
  args.push(
    '-hls_time',
    String(PREPARATION.hlsSegmentSeconds),
    '-hls_list_size',
    '0',
    '-hls_playlist_type',
    'event',
    '-hls_segment_filename',
    path.resolve(hls.segmentPattern),
    '-f',
    'hls',
    path.resolve(hls.playlistPath),
  );
  return args;
}

/**
 * The finishing move (10g): the segments, losslessly, into the one MP4 beside the source.
 *
 * A stream copy of what has already been encoded — no second encode, no quality cost, and a
 * couple of minutes at disk speed on a two-hour film. `+faststart` for the same reason the
 * ordinary job has it: the index goes at the front, so the next play does not begin with a
 * range request for the last four gigabytes.
 *
 * **`-protocol_whitelist` is here because the input is a playlist rather than a film.**
 * ffmpeg's HLS demuxer refuses to follow references it was not told it may follow, and a
 * local playlist naming local segments is exactly such a reference. It costs nothing when
 * it is not needed and is a cryptic refusal when it is missing. *Unverified on hardware as
 * of writing — see the M3b report.*
 */
export function buildFinishArgs(playlistPath: string, outputPath: string): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-protocol_whitelist',
    'file,crypto,data',
    '-i',
    path.resolve(playlistPath),
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c',
    'copy',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    path.resolve(outputPath),
  ];
}

/** `00:01:23.456000` → 83.456. ffmpeg prints `N/A` before the first frame lands. */
function parseOutTime(value: string): number | null {
  const match = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(value.trim());
  if (match === null) return null;
  return Number(match[1]) * 3_600 + Number(match[2]) * 60 + Number(match[3]);
}

/**
 * How much of the job is left, and when we are willing to say.
 *
 * The number M3 adds for testability: *"after the first 30 s of a job, the remaining time
 * shown is within ±30% of the truth"*. The only way to be inside that band is to compute it
 * from **what this machine is actually doing right now**, not from the seeded throughput the
 * classifier used for its up-front estimate — the seed's whole job was to answer before any
 * work existed to measure.
 *
 * So: silence until there is real evidence, then the remaining film divided by the observed
 * speed. `null` renders as no estimate at all, which is honest; a number invented in the
 * first second would be the flattering one criterion 8b forbids.
 */
const MIN_SAMPLES_BEFORE_ESTIMATING = 3;

interface SpeedAverage {
  add(speed: number): void;
  readonly value: number | null;
  readonly samples: number;
}

/**
 * A rolling mean over the last few `speed=` reports.
 *
 * Rolling rather than cumulative because a conversion genuinely changes pace — a quiet
 * scene and a bright one are different work — and an average over the whole run stops
 * responding to that exactly when the estimate matters most, near the end.
 */
function speedAverage(window = 8): SpeedAverage {
  const samples: number[] = [];
  return {
    add(speed) {
      if (!Number.isFinite(speed) || speed <= 0) return;
      samples.push(speed);
      if (samples.length > window) samples.shift();
    },
    get value() {
      if (samples.length === 0) return null;
      return samples.reduce((total, sample) => total + sample, 0) / samples.length;
    },
    get samples() {
      return samples.length;
    },
  };
}

export function runFfmpegJob(request: JobRequest, deps: JobDeps): Promise<JobResult> {
  const output = outputProfileFor(request.deviceProfile, request.encoder);
  return runFfmpeg(buildArgs(request, output), deps, {
    durationSec: request.durationSec,
    what: request.hls === undefined ? request.plan.kind : `${request.plan.kind}-hls`,
    outputProfileId: output.id,
    subtitleTracks: request.subtitleOutputs.length,
  });
}

/**
 * 10g's finishing move, run as an ordinary job: the segments into the one MP4.
 *
 * It reports progress like any other, because on a two-hour film it is a couple of minutes
 * of disk work and a founder who has finished watching is entitled to know something is
 * still happening. The film they are watching is untouched throughout — the segments are
 * read, never moved.
 */
export function runFfmpegFinish(
  playlistPath: string,
  outputPath: string,
  deps: JobDeps & { readonly durationSec: number | null },
): Promise<JobResult> {
  return runFfmpeg(buildFinishArgs(playlistPath, outputPath), deps, {
    durationSec: deps.durationSec,
    what: 'hls-finish',
    outputProfileId: 'copy',
    subtitleTracks: 0,
  });
}

interface RunOptions {
  readonly durationSec: number | null;
  /** What this invocation is, for the log: `remux`, `transcode`, `transcode-hls`, `hls-finish`. */
  readonly what: string;
  readonly outputProfileId: string;
  readonly subtitleTracks: number;
}

/**
 * One ffmpeg process, from spawn to exit — the shared body of every invocation we make.
 *
 * Extracted when M3b added a second and a third (the growing-playlist conversion and the
 * remux that finishes it). The alternative was a copy of the cancellation discipline, and
 * that discipline is where the Windows bugs live: *kill, then wait for the process to
 * actually exit before answering*, because `unlink` on a file another process still holds
 * is fine on Linux and `EBUSY` on Windows. A second copy of that would have been a second
 * chance to get it wrong on the only platform this product runs on.
 */
function runFfmpeg(args: string[], deps: JobDeps, run: RunOptions): Promise<JobResult> {
  const spawnProcess = deps.spawn ?? (nodeSpawn as SpawnLike);
  const signal = deps.signal;
  const exitWaitMs = deps.exitWaitMs ?? PREPARATION.cancelExitWaitMs;

  if (signal?.aborted === true) return Promise.resolve({ ok: false, failure: 'cancelled' });

  return new Promise<JobResult>((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let stderr = '';
    let pending = '';
    let percent = 0;
    let exitTimer: NodeJS.Timeout | null = null;
    let frontierSec = 0;
    let bytesWritten = 0;
    const speed = speedAverage();
    const startedAt = Date.now();

    function finish(result: JobResult, context: Record<string, unknown> = {}): void {
      if (settled) return;
      settled = true;
      if (exitTimer !== null) clearTimeout(exitTimer);
      signal?.removeEventListener('abort', onAbort);
      deps.logger?.info('ffmpeg.job_finished', {
        ok: result.ok,
        failure: result.ok ? null : result.failure,
        durationMs: Date.now() - startedAt,
        frontierSec,
        bytesWritten,
        outputProfile: run.outputProfileId,
        ...context,
      });
      resolve(result);
    }

    function kill(): void {
      try {
        child.kill();
      } catch {
        // Already gone is the outcome we were asking for.
      }
    }

    /**
     * 8d: stop within 2 s and leave nothing behind.
     *
     * **The kill is immediate; the resolution is not, and that distinction is the whole of
     * a bug found on hardware on 2026-08-20.** This used to resolve the promise and *then*
     * kill, so the caller went off to delete the staging file while ffmpeg still had it
     * open. On Linux `unlink` on an open file succeeds, so 596 tests passed. On Windows it
     * is `EBUSY`, the delete failed, and a `.partial` was left sitting beside the founder's
     * film — which is precisely what 8d promises never happens.
     *
     * So: kill, and let the `close` handler resolve once the process has actually gone and
     * released the handle. `exitWaitMs` is the backstop for a process that will not die —
     * we still answer, and the caller's retrying delete is what covers the rest.
     */
    function onAbort(): void {
      kill();
      exitTimer = setTimeout(() => {
        finish(
          { ok: false, failure: 'cancelled' },
          { why: 'the process did not exit within the kill budget' },
        );
      }, exitWaitMs);
      exitTimer.unref?.();
    }

    function emit(): void {
      const remaining =
        run.durationSec === null || speed.samples < MIN_SAMPLES_BEFORE_ESTIMATING
          ? null
          : Math.max(0, (run.durationSec - frontierSec) / Math.max(0.01, speed.value ?? 1));
      deps.onProgress?.({
        percent,
        frontierSec,
        speed: speed.value,
        secondsRemaining: remaining,
        bytesWritten,
      });
    }

    /**
     * `-progress` emits `key=value` lines in blocks terminated by `progress=continue|end`.
     * Anything unrecognised is ignored rather than guessed at — this is another process's
     * output and the same untrusted-input rule as the probe parser applies.
     */
    function consume(chunk: string): void {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop() ?? '';
      for (const line of lines) {
        const index = line.indexOf('=');
        if (index <= 0) continue;
        const key = line.slice(0, index).trim();
        const value = line.slice(index + 1).trim();
        if (key === 'out_time_us' || key === 'out_time_ms') {
          // `out_time_ms` has carried microseconds for years — a long-standing ffmpeg
          // misnomer. Both are read as microseconds because both are, and `out_time_us`
          // is preferred by being handled identically rather than by being trusted more.
          const micro = Number(value);
          if (Number.isFinite(micro) && micro >= 0)
            frontierSec = Math.max(frontierSec, micro / 1e6);
        } else if (key === 'out_time') {
          const seconds = parseOutTime(value);
          if (seconds !== null) frontierSec = Math.max(frontierSec, seconds);
        } else if (key === 'total_size') {
          const size = Number(value);
          if (Number.isFinite(size) && size >= 0) bytesWritten = Math.max(bytesWritten, size);
        } else if (key === 'speed') {
          speed.add(Number.parseFloat(value.replace(/x$/i, '')));
        } else if (key === 'progress') {
          if (run.durationSec !== null && run.durationSec > 0) {
            // Monotonic by construction, not by hoping ffmpeg is: `out_time` can step back
            // a frame at a chapter boundary, and a bar that retreats is the clearest signal
            // a person can get that an app has lost the plot.
            percent = Math.min(100, Math.max(percent, (frontierSec / run.durationSec) * 100));
          }
          emit();
        }
      }
    }

    try {
      child = spawnProcess(deps.binaries.ffmpeg, [...args, '-progress', 'pipe:1', '-nostats'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      deps.logger?.warn('ffmpeg.spawn_failed', { error });
      finish({ ok: false, failure: 'ffmpeg-failed' });
      return;
    }

    deps.logger?.info('ffmpeg.job_started', {
      plan: run.what,
      outputProfile: run.outputProfileId,
      durationSec: run.durationSec,
      subtitleTracks: run.subtitleTracks,
      // The full argv, once, in the log and nowhere else. It is the first thing anyone will
      // want from a conversion that produced the wrong picture.
      args,
    });

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (data: string) => {
      consume(data);
    });
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (data: string) => {
      // `-loglevel error` means anything arriving here is worth keeping. Bounded anyway:
      // a build that decides to be chatty must not become a megabyte in a log line.
      if (stderr.length < STDERR_SAMPLE_BYTES) stderr += data;
    });

    child.on('error', (error) => {
      deps.logger?.warn('ffmpeg.spawn_failed', { error });
      finish({ ok: false, failure: 'ffmpeg-failed' });
    });

    child.on('close', (code, signalName) => {
      if (settled) return;
      if (code === 0) {
        percent = 100;
        emit();
        finish({ ok: true });
        return;
      }
      // A process we killed reports a signal rather than a code, and it is not a failure of
      // the file — somebody asked for it to stop.
      if (signalName !== null) {
        finish({ ok: false, failure: 'cancelled' }, { signal: signalName });
        return;
      }
      const failure = classifyStderr(stderr);
      deps.logger?.warn('ffmpeg.job_failed', {
        exitCode: code,
        failure,
        // ffmpeg's own diagnosis. The log, never the screen (7a, P3).
        stderr: stderr.slice(0, STDERR_SAMPLE_BYTES).trim(),
      });
      finish({ ok: false, failure }, { exitCode: code });
    });
  });
}
