import fsp from 'node:fs/promises';
import path from 'node:path';
import type { DeviceProfile, SourceFile, Tier } from '../types.js';
import type { FfmpegBinaries } from '../media/ffmpeg.js';
import type { Logger } from '../logging/index.js';
import { primaryVideoStream, type ProbeResult } from '../media/ffprobe.js';
import type { FfprobeRunner } from '../media/inspection.js';
import type { SpawnLike } from '../media/ffprobe-runner.js';
import { isReusableArtifact, type Verdict } from './classify.js';
import type { VideoEncoder } from './encoders.js';
import { PREPARATION } from '../config.js';
import { freeBytesOn, isWritableDirectory, roomFor, type RoomVerdict } from './disk.js';
import { isOurName, partialPathFor, preparedPathFor, subtitlePathFor } from './naming.js';
import {
  runFfmpegFinish,
  runFfmpegJob,
  type JobFailure,
  type JobProgress,
  type SubtitleOutput,
} from './ffmpeg-job.js';
import {
  headStartGate,
  recordFrontier,
  sustainedSpeed,
  type FrontierSample,
  type GateVerdict,
} from './head-start.js';
import { HLS_SOURCE_PLAYLIST } from '../media-server/hls.js';

/**
 * The preparation pipeline: **find what we already made, or make it, and never leave
 * anything behind.**
 *
 * The product's defining guarantee lives here — *nothing is ever converted underneath
 * playback* — and there are now two ways of keeping it. **M3a's** is blunt: a job runs to
 * completion and only then does anything reach a television. **M3b's** (`prepareWithHeadStart`)
 * publishes the same conversion as it goes and lets a gate decide when a television may be
 * told — which is a promise about *ordering* rather than about waiting, and is why the gate
 * and the margin guard are pure functions in `head-start.ts` rather than conditions
 * scattered through this file.
 *
 * ## The three properties everything else is arranged around
 *
 * **A prepared file is discovered by name and believed only after it is probed** (ADR
 * 2026-08-19). There is no metadata format, no sidecar, and the index in app data is a
 * cache that may be wrong without anything breaking. Two questions decide reuse: does
 * ffprobe say the sibling's duration matches the source within a second, and does the
 * classifier call it Tier 1 for *this* television. The second question **is** the profile
 * key, derived from the file rather than remembered about it — which is why story 9 costs
 * nearly nothing and survives a reinstall, a moved film, and an index we lost.
 *
 * **Work happens under a staging name, and the finishing move is a rename.** Same directory,
 * therefore same volume, therefore atomic and instant rather than a copy of four gigabytes.
 * A cancel, a failure, a crash and a closed app all leave exactly one file, under a name
 * only we would use, and removing it is the entire cleanup story (8d, P2, P3, P6, P7).
 *
 * **CastGood deletes nothing it did not name.** Every `rm` in this file is gated on
 * `isOurName`. 9e says it plainly — *"a file the founder put there is never ours"* — and
 * this pipeline runs inside the founder's own films folder, which is the one place in the
 * product where getting that wrong destroys something irreplaceable.
 */

export interface PreparationProgress {
  readonly percent: number;
  /** Seconds of output written so far — the conversion frontier. */
  readonly frontierSec: number;
  /** ffmpeg's own `speed=` output, rolling-averaged. Feeds M3b's head-start gate. */
  readonly speed: number | null;
  readonly secondsRemaining: number | null;
  readonly bytesWritten: number;
}

/** A prepared file on disk that this television can play untouched. */
export interface PreparedArtifact {
  readonly path: string;
  readonly probe: ProbeResult;
  readonly bytes: number;
  /** Which tier produced it, when we know. `null` for one found on disk from a past run. */
  readonly tier: Tier | null;
  /**
   * Did the prepared file end up somewhere other than beside its source?
   *
   * 9e: when the source's folder cannot be written to, the job falls back to CastGood's own
   * working folder **and the app says where it went**. This is what it says with.
   */
  readonly fallbackDirectory: string | null;
}

export type PreparationFailure =
  | { readonly kind: 'disk-space'; readonly room: RoomVerdict }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'source-missing' }
  | { readonly kind: 'ffmpeg-missing' }
  /** Everything else. P3: one plain sentence, *Try again*, and the detail in the log. */
  | { readonly kind: 'failed'; readonly attempts: number };

export type PreparationResult =
  | { readonly ok: true; readonly artifact: PreparedArtifact }
  | { readonly ok: false; readonly failure: PreparationFailure };

export interface PrepareRequest {
  readonly source: SourceFile & { readonly name: string };
  readonly sourceProbe: ProbeResult;
  readonly verdict: Verdict;
  readonly deviceProfile: DeviceProfile;
}

export interface PreparationEvents {
  onProgress?(progress: PreparationProgress): void;
  /** Fires once, when the location has been settled — before a byte is written (9e). */
  onLocationChosen?(directory: string, isFallback: boolean): void;
}

/** Where a growing conversion is being written, and what it looked like when the gate opened. */
export interface HeadStartServe {
  /** The segment directory. What the media server mounts, `kind: 'hls'`. */
  readonly dir: string;
  /** ffmpeg's own playlist inside it — read by the server, never served to a device. */
  readonly playlistName: string;
  /** The two numbers 10h is graded on, **as measured at the moment of the LOAD**. */
  readonly preparedSec: number;
  readonly sustainedSpeed: number | null;
}

export interface HeadStartEvents extends PreparationEvents {
  /**
   * The gate opened. Nothing may be sent to a television before this fires (10h).
   *
   * Fires **once**: the gate is a threshold, not a state, and a second call would be a
   * second LOAD of a film already playing.
   */
  onGateOpen?(serve: HeadStartServe): void;
  /**
   * Every gate decision, open or shut, with both of its numbers.
   *
   * The founder sees this as *"watching starts in about…"* (10a) and the log sees it as the
   * evidence for 10h's *"fails if either number is absent"*.
   */
  onGateChecked?(verdict: GateVerdict): void;
  /** ffmpeg has written ENDLIST. The film is no longer growing; the guard stands down. */
  onConversionComplete?(): void;
}

export interface HeadStartRun {
  readonly result: PreparationResult;
  /**
   * Removes the folder of segments — 10g's *"no folder of fragments"*.
   *
   * **The caller decides when**, and that is the whole of *"the tidy-up must not disturb the
   * film in progress"*: when the conversion finishes, the television is still playing from
   * these segments and the MP4 beside the source is for next time. So they go when the
   * session lets the television go, not when ffmpeg exits.
   */
  discardSegments(): Promise<void>;
}

export interface PreparationPipeline {
  /**
   * Is there already a prepared file for this source that this television can play (7c, 9a)?
   *
   * `null` covers every honest way of not having one: never prepared, prepared for a
   * narrower television, the founder deleted it by hand (9d), or the source has changed
   * since and the sibling now describes a different film (9c). None of them is an error and
   * none of them is reported to the founder — the answer is simply a preparation.
   */
  findPrepared(
    sourcePath: string,
    sourceProbe: ProbeResult,
    profile: DeviceProfile,
  ): Promise<PreparedArtifact | null>;
  /** Runs a job to completion. One at a time; there is no queue and no worker pool. */
  prepare(
    request: PrepareRequest,
    events: PreparationEvents,
    signal: AbortSignal,
  ): Promise<PreparationResult>;
  /**
   * The same job, published as a growing playlist so watching can start part-way through.
   *
   * M3b, and it is the same conversion at the same output profile as `prepare` — one job,
   * one encoder, one artifact in the end. What differs is *when* a television may be told
   * about it, which is `headStartGate`'s decision and nobody else's.
   */
  prepareWithHeadStart(
    request: PrepareRequest,
    events: HeadStartEvents,
    signal: AbortSignal,
  ): Promise<HeadStartRun>;
}

export interface PreparationDeps {
  readonly logger: Logger;
  readonly binaries: FfmpegBinaries | null;
  /** Probes the sibling, and re-probes the artifact we just wrote. Never `null` with binaries. */
  readonly runFfprobe: FfprobeRunner | null;
  /** CastGood's own working folder — 9e's fallback, and nothing else in M3a. */
  readonly workingDir: string;
  /**
   * Which encoder to use, asked **per job** rather than fixed at construction.
   *
   * The pipeline is built lazily on the first check, and hardware detection is an
   * asynchronous probe that may not have answered by then. A value captured at construction
   * would pin the whole session to the software path because of a race at startup; a
   * function is read when a job actually starts, by which point the answer is in.
   */
  readonly videoEncoder?: () => VideoEncoder;
  readonly spawn?: SpawnLike;
  /** Monotonic-ish milliseconds. Injected by tests; `Date.now` everywhere else. */
  readonly now?: () => number;
  /**
   * How much room is left on the volume holding a path. `freeBytesOn` everywhere else.
   *
   * **Injected by tests for the same reason the guard's tick is.** P1's check is real
   * work against a real filesystem, and a suite that leaves it real is a suite whose
   * result depends on how full the machine's disk happens to be. That is not
   * hypothetical: the M3b fixtures declare a two-hour 4K film, the estimate is twice its
   * size and the check runs on two volumes, so ~18 GB has to be free before a head-start
   * test can even reach ffmpeg. A developer box has it and a CI runner does not — which
   * is exactly how 22 tests were green in WSL and red on every CI run this branch ever
   * had, refusing on `disk-space` and never spawning the child the tests were waiting
   * for. The product was right every time; the tests were measuring the disk.
   */
  readonly freeBytes?: (target: string) => Promise<number | null>;
  /**
   * Slow every conversion to this multiple of real time — **the selftest's starved case**.
   *
   * `null`/undefined in the app and in every other caller. See `JobRequest.readRate`.
   */
  readonly conversionReadRate?: number | null;
  /**
   * Seconds converted at full speed before `conversionReadRate` engages — the selftest's
   * *falls behind mid-film* case. See `JobRequest.readRateBurstSec`.
   */
  readonly conversionReadRateBurstSec?: number | null;
}

/**
 * P3: *"a conversion is retried once automatically before the founder is told anything."*
 *
 * Restated as a number in M3's own table so the selftest can count it rather than infer it.
 * One, not two, and not "until it works": a job that fails the same way twice is a fact
 * about the file, and a third attempt is only a longer wait before the same sentence.
 */
const ATTEMPTS = 2;

/**
 * The one folder segments are ever written to, inside CastGood's own working directory.
 *
 * A fixed name rather than a unique one, because *"one conversion at a time. No queue, no
 * worker pool"* is an architecture rule — so a folder that is already there belongs to a run
 * that died, and removing it before starting is the whole of the sweep. A unique name per
 * job would accumulate a folder of fragments for every crash, which is precisely what 10g
 * promises the founder never sees.
 */
const HEAD_START_DIR = 'headstart';
/** ffmpeg's `-hls_segment_filename` pattern. Five digits covers a 27-hour film at 4 s. */
const HEAD_START_SEGMENT_PATTERN = 'segment%05d.ts';

/** Failures that are about the founder's situation, not the file, and are never retried. */
const NOT_RETRYABLE: ReadonlySet<JobFailure> = new Set<JobFailure>([
  'cancelled',
  'source-missing',
  'disk-full',
  'ffmpeg-failed',
]);

export function createPreparationPipeline(deps: PreparationDeps): PreparationPipeline {
  const logger = deps.logger.child({ component: 'prepare' });
  /**
   * The clock the sustained-speed window is measured against.
   *
   * Injected so a test can prove a **60-second** window in a millisecond. Without it, every
   * assertion about the gate would need a minute of real time, and a suite nobody will wait
   * for is a suite that stops being run.
   */
  const now = deps.now ?? ((): number => Date.now());
  const freeBytesFor = deps.freeBytes ?? freeBytesOn;

  /** Removes a file, and only ever one we named. */
  async function removeOurs(target: string): Promise<void> {
    if (!isOurName(path.basename(target))) {
      // Unreachable by construction — every name here came from `naming.ts`. Kept because
      // the cost of being wrong is a file in the founder's films folder, and a loud refusal
      // is worth more than a comment saying it cannot happen.
      logger.error('prepare.refused_to_delete', { target });
      return;
    }
    // `maxRetries`/`retryDelay` are Node's own answer to Windows holding a handle open for
    // a moment after the process that had it has gone — they retry `EBUSY`, `EPERM` and
    // friends, and do nothing at all on a filesystem that never raises them. Without this,
    // a cancelled job left a `.partial` beside the founder's film (found on hardware,
    // 2026-08-20); `ffmpeg-job.ts` waits for the process to exit, and this covers the lag
    // after it has.
    await fsp
      .rm(target, {
        force: true,
        maxRetries: PREPARATION.cleanupRetries,
        retryDelay: PREPARATION.cleanupRetryDelayMs,
      })
      .catch((error: unknown) => {
        // Still worth a line: a file we could not remove is a file in somebody's folder.
        logger.warn('prepare.cleanup_failed', { error, target });
      });
  }

  /**
   * Everything one job writes: the film, and one WebVTT per text subtitle track (8e).
   *
   * **Every path here has to be distinct**, and that is not automatic: two tracks of the
   * same language are ordinary, and naming them both after the language handed ffmpeg two
   * outputs pointing at one file. Counting occurrences per language is what makes
   * `subtitlePathFor` produce `.eng.vtt` and `.eng2.vtt` rather than the same name twice.
   */
  function outputsFor(
    target: string,
    tracks: readonly { index: number; language: string | null }[],
  ) {
    const partial = partialPathFor(target);
    const seen = new Map<string, number>();
    const subtitles: (SubtitleOutput & { readonly finalPath: string })[] = tracks.map(
      (track, position) => {
        const key = (track.language ?? '').toLowerCase();
        const occurrence = (seen.get(key) ?? 0) + 1;
        seen.set(key, occurrence);
        const finalPath = subtitlePathFor(target, track.language, position + 1, occurrence);
        return { ...track, finalPath, outputPath: partialPathFor(finalPath) };
      },
    );
    return { partial, subtitles };
  }

  async function probeFile(filePath: string): Promise<ProbeResult | null> {
    if (deps.runFfprobe === null) return null;
    const result = await deps.runFfprobe(filePath);
    return result.ok ? result.probe : null;
  }

  /**
   * Where does the prepared file go?
   *
   * Beside the source, which is the founder's ruling and the whole point of it — their films
   * live on roomy storage drives and the copies should too. The fallback exists because a
   * source folder can be read-only, on a share, or full, and the same ruling says the cast
   * must not die for it: *"fall back to the app's working directory and say so plainly"*.
   */
  async function chooseDirectory(sourcePath: string): Promise<{ dir: string; fallback: boolean }> {
    const beside = path.dirname(path.resolve(sourcePath));
    if (await isWritableDirectory(beside)) return { dir: beside, fallback: false };
    logger.info('prepare.source_folder_unwritable', { directory: beside });
    await fsp.mkdir(deps.workingDir, { recursive: true }).catch(() => undefined);
    return { dir: deps.workingDir, fallback: true };
  }

  /**
   * Everything between "ffmpeg exited 0" and "there is a prepared film beside the source".
   *
   * One copy, because M3b gave it a second caller: the head-start path finishes by remuxing
   * its segments into the same staging file and then does exactly this. A second copy would
   * have been a second place for the rule that cost eighteen minutes of the founder's
   * evening — *a subtitle must not be able to destroy the film* — to be forgotten.
   */
  async function publishArtifact(options: {
    readonly request: PrepareRequest;
    readonly partial: string;
    readonly target: string;
    readonly subtitles: readonly (SubtitleOutput & { readonly finalPath: string })[];
    readonly staging: readonly string[];
    readonly directory: string;
    readonly fallback: boolean;
    readonly attempt: number;
  }): Promise<PreparationResult> {
    const { request, partial, target, subtitles, staging, directory, fallback, attempt } = options;
    // The finishing move. Same directory, same volume: atomic, and a television is
    // never handed a URL for a file that is still being written.
    // **The film first, and the film alone decides whether this job succeeded.**
    try {
      await fsp.rename(partial, target);
    } catch (error) {
      logger.error('prepare.publish_failed', { error, partial, target });
      for (const file of [...staging, target]) await removeOurs(file);
      return { ok: false, failure: { kind: 'failed', attempts: attempt } };
    }

    // **A subtitle can no longer destroy the film**, and this is not a theoretical
    // tidy-up: on 2026-08-20 an eighteen-minute conversion of a 3.4 GB film completed,
    // was renamed into place, and was then **deleted** because a `.vtt` that ffmpeg
    // had never written could not be renamed. The founder got "Couldn't prepare…" and
    // nothing to show for eighteen minutes.
    //
    // `docs/ARCHITECTURE.md` §4 already had the principle — *"a subtitle codec must
    // not be able to fail the job"* — and it was applied to the ffmpeg invocation and
    // not to the publish that follows it. Now it is applied to both: a track that will
    // not move is logged loudly and dropped, and the film goes to the television.
    const published: string[] = [];
    for (const track of subtitles) {
      try {
        await fsp.rename(track.outputPath, track.finalPath);
        published.push(path.basename(track.finalPath));
      } catch (error) {
        logger.error('prepare.subtitle_lost', {
          error,
          track: path.basename(track.finalPath),
          sourceStreamIndex: track.index,
          language: track.language,
          // Said plainly because it is the thing a reader needs to know first: the
          // film is fine. This is a defect to chase, not an outcome to design around.
          filmPublished: true,
        });
      }
    }

    const probe = await probeFile(target);
    const stats = await fsp.stat(target).catch(() => null);
    if (probe === null || stats === null) {
      // We wrote a file ffprobe will not read. Serving it would be the worst
      // available outcome — a cast that fails on the television after a wait — so it
      // is removed and reported as a failed preparation.
      logger.error('prepare.artifact_unreadable', { target });
      for (const file of [target, ...subtitles.map((t) => t.finalPath)]) {
        await removeOurs(file);
      }
      return { ok: false, failure: { kind: 'failed', attempts: attempt } };
    }

    logger.info('prepare.published', {
      target,
      tier: request.verdict.tier,
      bytes: stats.size,
      estimatedBytes: request.verdict.estimatedBytes,
      durationSec: probe.durationSec,
      sourceDurationSec: request.sourceProbe.durationSec,
      fallbackDirectory: fallback ? directory : null,
      subtitleFiles: published,
      subtitleTracksPlanned: subtitles.length,
      attempts: attempt,
    });

    return {
      ok: true,
      artifact: {
        path: target,
        probe,
        bytes: stats.size,
        tier: request.verdict.tier,
        fallbackDirectory: fallback ? directory : null,
      },
    };
  }

  return {
    async findPrepared(sourcePath, sourceProbe, profile) {
      const candidate = preparedPathFor(sourcePath);
      let bytes: number;
      try {
        const stats = await fsp.stat(candidate);
        if (!stats.isFile()) return null;
        bytes = stats.size;
      } catch {
        // 9d: the founder deleted it, or it was never there. Both mean "prepare it".
        return null;
      }

      const probe = await probeFile(candidate);
      if (probe === null) {
        // A sibling we cannot read is a sibling we will not serve. Half-written by a
        // previous run that died, or corrupted since; either way it is replaced, not fixed.
        logger.info('prepare.sibling_unreadable', { candidate });
        return null;
      }

      // 9c, and the whole of the 2026-08-19 ADR's validation: the duration says it is the
      // same film rather than a trailer or a different cut, and Tier 1 for *this* television
      // is the profile key. A source re-downloaded at a different length fails the first
      // test; an artifact prepared for a wider device fails the second.
      const reusable = isReusableArtifact(sourceProbe, probe, profile);
      logger.info('prepare.sibling_checked', {
        candidate,
        reusable,
        sourceDurationSec: sourceProbe.durationSec,
        artifactDurationSec: probe.durationSec,
        profileId: profile.id,
      });
      if (!reusable) return null;

      return { path: candidate, probe, bytes, tier: null, fallbackDirectory: null };
    },

    async prepare(request, events, signal) {
      if (deps.binaries === null) {
        // Three build gates exist to stop an installer being made without ffmpeg, so this
        // is a damaged installation rather than an ordinary condition. It is still a value.
        logger.error('prepare.no_ffmpeg', {});
        return { ok: false, failure: { kind: 'ffmpeg-missing' } };
      }
      if (request.verdict.plan.kind === 'none') {
        // Nothing to prepare is not a job that succeeded with no output; it is a call that
        // should never have been made, and pretending otherwise would hand back an artifact
        // that does not exist.
        logger.error('prepare.nothing_to_do', { kind: request.verdict.kind });
        return { ok: false, failure: { kind: 'failed', attempts: 0 } };
      }

      const { dir, fallback } = await chooseDirectory(request.source.path);
      const target = preparedPathFor(request.source.path, dir);
      const { partial, subtitles } = outputsFor(target, request.verdict.plan.subtitleTracks);
      const staging = [partial, ...subtitles.map((track) => track.outputPath)];
      events.onLocationChosen?.(dir, fallback);

      // P1: **before any work begins**, and stated as a plain amount. A volume we cannot
      // interrogate returns `null` and the job proceeds — see `freeBytesOn`.
      const free = await freeBytesFor(partial);
      if (free !== null) {
        const room = roomFor(request.verdict.estimatedBytes, free);
        logger.info('prepare.disk_checked', {
          directory: dir,
          estimatedBytes: room.estimatedBytes,
          requiredBytes: room.requiredBytes,
          freeBytes: room.freeBytes,
          ok: room.ok,
        });
        if (!room.ok) return { ok: false, failure: { kind: 'disk-space', room } };
      }

      // Staging files from a run that died before it could tidy up. Ours by name, so
      // removing them is allowed, and leaving them would make `-y` overwrite them anyway.
      for (const file of staging) await removeOurs(file);

      let lastFailure: JobFailure = 'failed';
      for (let attempt = 1; attempt <= ATTEMPTS; attempt += 1) {
        const result = await runFfmpegJob(
          {
            sourcePath: request.source.path,
            outputPath: partial,
            plan: request.verdict.plan,
            deviceProfile: request.deviceProfile,
            durationSec: request.sourceProbe.durationSec,
            encoder: deps.videoEncoder?.() ?? 'libx264',
            sourceWidth: primaryVideoStream(request.sourceProbe)?.width ?? null,
            sourceHeight: primaryVideoStream(request.sourceProbe)?.height ?? null,
            subtitleOutputs: subtitles,
          },
          {
            binaries: deps.binaries,
            logger,
            ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
            signal,
            onProgress: (progress: JobProgress) => {
              events.onProgress?.(progress);
            },
          },
        );

        if (result.ok) {
          return await publishArtifact({
            request,
            partial,
            target,
            subtitles,
            staging,
            directory: dir,
            fallback,
            attempt,
          });
        }

        lastFailure = result.failure;
        // 8d, P2, P3: whichever way it ended, **every** staging file goes — the film and
        // each subtitle. There is never a partial file beside the founder's source to tidy
        // up by hand, and a job that wrote three files must not leave two of them.
        for (const file of staging) await removeOurs(file);
        if (NOT_RETRYABLE.has(result.failure)) break;
        if (attempt < ATTEMPTS) {
          logger.warn('prepare.retrying', { attempt, failure: result.failure });
        }
      }

      switch (lastFailure) {
        case 'cancelled':
          return { ok: false, failure: { kind: 'cancelled' } };
        case 'source-missing':
          return { ok: false, failure: { kind: 'source-missing' } };
        case 'disk-full': {
          // P2: the disk filled *during* the job. The shortfall is measured now rather than
          // guessed, and no existing prepared file is ever removed to make room.
          const remaining = await freeBytesFor(partial);
          return {
            ok: false,
            failure: {
              kind: 'disk-space',
              room: roomFor(request.verdict.estimatedBytes, remaining ?? 0),
            },
          };
        }
        case 'ffmpeg-failed':
          return { ok: false, failure: { kind: 'ffmpeg-missing' } };
        default:
          return { ok: false, failure: { kind: 'failed', attempts: ATTEMPTS } };
      }
    },

    async prepareWithHeadStart(request, events, signal) {
      const failed = (failure: PreparationFailure): HeadStartRun => ({
        result: { ok: false, failure },
        discardSegments: () => Promise.resolve(),
      });

      if (deps.binaries === null) {
        logger.error('prepare.no_ffmpeg', {});
        return failed({ kind: 'ffmpeg-missing' });
      }
      if (request.verdict.plan.kind !== 'transcode') {
        // Head start exists for Tier 3. A remux is seconds of work — publishing it as a
        // growing playlist would add a serving shape, a guard and a tidy-up to a wait the
        // founder barely sees, and would trade M3a's fully-prepared MP4 for it.
        logger.error('prepare.head_start_not_applicable', { kind: request.verdict.plan.kind });
        return failed({ kind: 'failed', attempts: 0 });
      }

      const { dir, fallback } = await chooseDirectory(request.source.path);
      const target = preparedPathFor(request.source.path, dir);
      const { partial, subtitles } = outputsFor(target, request.verdict.plan.subtitleTracks);
      const staging = [partial, ...subtitles.map((track) => track.outputPath)];
      events.onLocationChosen?.(dir, fallback);

      // **Segments live in CastGood's own working folder, never in the founder's films
      // folder** — they are a working format, they are numerous, and nobody should ever see
      // one (10g, founder's ruling 2026-08-19). One job at a time means one fixed name,
      // which is also what makes a leftover from a run that died sweepable rather than
      // accumulating: it is removed before this one starts.
      const segmentsDir = path.join(deps.workingDir, HEAD_START_DIR);
      const discardSegments = async (): Promise<void> => {
        // Bounded to the folder we made inside our own working directory. `isOurName` guards
        // the founder's folder; nothing we write there is touched by this at all.
        await fsp
          .rm(segmentsDir, {
            recursive: true,
            force: true,
            maxRetries: PREPARATION.cleanupRetries,
            retryDelay: PREPARATION.cleanupRetryDelayMs,
          })
          .catch((error: unknown) => {
            logger.warn('prepare.segments_cleanup_failed', { error, segmentsDir });
          });
      };
      await discardSegments();
      try {
        await fsp.mkdir(segmentsDir, { recursive: true });
      } catch (error) {
        logger.error('prepare.segments_dir_failed', { error, segmentsDir });
        return failed({ kind: 'failed', attempts: 0 });
      }

      // P1, and **twice over for this shape**: the finished MP4 lands beside the source and
      // the segments land on the working volume, so both have to have room. The segments are
      // the same conversion, so the same estimate applies to each.
      for (const probePath of [partial, path.join(segmentsDir, 'x')]) {
        const free = await freeBytesFor(probePath);
        if (free === null) continue;
        const room = roomFor(request.verdict.estimatedBytes, free);
        logger.info('prepare.disk_checked', {
          directory: path.dirname(probePath),
          estimatedBytes: room.estimatedBytes,
          requiredBytes: room.requiredBytes,
          freeBytes: room.freeBytes,
          ok: room.ok,
        });
        if (!room.ok) {
          await discardSegments();
          return failed({ kind: 'disk-space', room });
        }
      }

      for (const file of staging) await removeOurs(file);

      let samples: FrontierSample[] = [];
      let gateOpened = false;
      let openedWith: GateVerdict | null = null;

      const result = await runFfmpegJob(
        {
          sourcePath: request.source.path,
          outputPath: partial,
          plan: request.verdict.plan,
          deviceProfile: request.deviceProfile,
          durationSec: request.sourceProbe.durationSec,
          encoder: deps.videoEncoder?.() ?? 'libx264',
          sourceWidth: primaryVideoStream(request.sourceProbe)?.width ?? null,
          sourceHeight: primaryVideoStream(request.sourceProbe)?.height ?? null,
          subtitleOutputs: subtitles,
          ...(deps.conversionReadRate == null ? {} : { readRate: deps.conversionReadRate }),
          ...(deps.conversionReadRateBurstSec == null
            ? {}
            : { readRateBurstSec: deps.conversionReadRateBurstSec }),
          hls: {
            playlistPath: path.join(segmentsDir, HLS_SOURCE_PLAYLIST),
            segmentPattern: path.join(segmentsDir, HEAD_START_SEGMENT_PATTERN),
          },
        },
        {
          binaries: deps.binaries,
          logger,
          ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
          signal,
          onProgress: (progress: JobProgress) => {
            events.onProgress?.(progress);
            // **The gate reads the frontier's own history, not ffmpeg's `speed=`.** A
            // sustained figure cannot be flattered by a burst, and a burst is exactly what
            // opened a gate on a conversion that could not hold the pace — measured on this
            // machine at about a third too fast over clip lengths.
            samples = recordFrontier(samples, {
              atMs: now(),
              frontierSec: progress.frontierSec,
            });
            const verdict = headStartGate({
              preparedSec: progress.frontierSec,
              sustainedSpeed: sustainedSpeed(samples),
              // Not `true` here, ever: the job is still running. A completed conversion is
              // the *other* way a film reaches a television, and it goes as a finished MP4.
              conversionComplete: false,
              filmDurationSec: request.sourceProbe.durationSec,
            });
            events.onGateChecked?.(verdict);
            if (!verdict.open || gateOpened) return;
            gateOpened = true;
            openedWith = verdict;
            logger.info('prepare.head_start_gate_open', {
              preparedSec: Math.round(verdict.preparedSec),
              sustainedSpeed: verdict.sustainedSpeed,
              reason: verdict.reason,
              requiredPreparedSec: PREPARATION.headStartSeconds,
              requiredSpeed: PREPARATION.headStartMinSpeed,
            });
            events.onGateOpen?.({
              dir: segmentsDir,
              playlistName: HLS_SOURCE_PLAYLIST,
              preparedSec: verdict.preparedSec,
              sustainedSpeed: verdict.sustainedSpeed,
            });
          },
        },
      );

      if (!result.ok) {
        // **No retry once a television is watching.** P3's automatic retry exists for a job
        // nobody has seen; restarting the conversion underneath a playing film would delete
        // the segments it is fetching, which is the stall the whole milestone forbids. A
        // head-start job that fails after the gate opened is reported, and the founder's
        // place is kept by the session.
        for (const file of staging) await removeOurs(file);
        await discardSegments();
        logger.warn('prepare.head_start_failed', {
          failure: result.failure,
          gateOpened,
        });
        switch (result.failure) {
          case 'cancelled':
            return failed({ kind: 'cancelled' });
          case 'source-missing':
            return failed({ kind: 'source-missing' });
          case 'disk-full': {
            const remaining = await freeBytesFor(partial);
            return failed({
              kind: 'disk-space',
              room: roomFor(request.verdict.estimatedBytes, remaining ?? 0),
            });
          }
          case 'ffmpeg-failed':
            return failed({ kind: 'ffmpeg-missing' });
          default:
            return failed({ kind: 'failed', attempts: 1 });
        }
      }

      events.onConversionComplete?.();
      logger.info('prepare.head_start_converted', {
        gateOpened,
        openedWith:
          openedWith === null
            ? null
            : {
                preparedSec: Math.round((openedWith as GateVerdict).preparedSec),
                sustainedSpeed: (openedWith as GateVerdict).sustainedSpeed,
              },
      });

      // 10g: **one file beside the source**, made from the segments losslessly. The film in
      // progress is reading those segments while this runs and is not disturbed by it —
      // this reads them, and the folder goes only when the caller says the television has
      // been let go.
      const finish = await runFfmpegFinish(path.join(segmentsDir, HLS_SOURCE_PLAYLIST), partial, {
        binaries: deps.binaries,
        logger,
        ...(deps.spawn === undefined ? {} : { spawn: deps.spawn }),
        signal,
        durationSec: request.sourceProbe.durationSec,
      });
      if (!finish.ok) {
        for (const file of staging) await removeOurs(file);
        logger.error('prepare.head_start_finish_failed', { failure: finish.failure });
        return {
          result: {
            ok: false,
            failure:
              finish.failure === 'cancelled'
                ? { kind: 'cancelled' }
                : { kind: 'failed', attempts: 1 },
          },
          discardSegments,
        };
      }

      const published = await publishArtifact({
        request,
        partial,
        target,
        subtitles,
        staging,
        directory: dir,
        fallback,
        attempt: 1,
      });
      return { result: published, discardSegments };
    },
  };
}

export type { FfmpegBinaries } from '../media/ffmpeg.js';
export {
  buildArgs,
  buildFinishArgs,
  runFfmpegFinish,
  runFfmpegJob,
  type HlsOutput,
  type JobFailure,
  type JobProgress,
} from './ffmpeg-job.js';
export {
  canCatchUp,
  guardStep,
  headStartGate,
  recordFrontier,
  forecastGate,
  secondsUntilRelease,
  seekLimitSec,
  stillPreparingMessage,
  sustainedSpeed,
  willPlayWhenReadyMessage,
  INITIAL_GUARD,
  type FrontierSample,
  type GateInput,
  type GateReason,
  type GateForecast,
  type GateVerdict,
  type GuardAction,
  type GuardInput,
  type GuardState,
  type GuardStep,
} from './head-start.js';
export { freeBytesOn, isWritableDirectory, roomFor, type RoomVerdict } from './disk.js';
export {
  isOurName,
  partialPathFor,
  preparedNameFor,
  preparedPathFor,
  sourceStem,
  subtitlePathFor,
  PREPARED_MARK,
  SUBTITLE_EXTENSION,
} from './naming.js';
export { detectVideoEncoder, type VideoEncoder } from './encoders.js';
export {
  BASELINE_OUTPUT,
  NVENC_OUTPUT,
  outputProfileFor,
  describeOutputProfile,
  type OutputProfile,
} from './output-profiles.js';

export {
  classify,
  confirmationFor,
  describeApproxBytes,
  describeApproxSeconds,
  isReusableArtifact,
  type ClassifyOptions,
  type ImpossibleReason,
  type PreparationPlan,
  type ThroughputEstimate,
  type Verdict,
  type VerdictConfirmation,
  type VerdictDetail,
  type VerdictKind,
} from './classify.js';

export {
  applyNarrowingStep,
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
  narrowAfterRefusal,
  resolveDeviceProfile,
  signatureOf,
  type CapabilityDowngrade,
  type ModelProfileEntry,
  type NarrowingStep,
  type RefusedSignature,
} from './device-profiles.js';

export {
  parseFfprobeReport,
  parseFfprobeStdout,
  primaryVideoStream,
  subtitleStreams,
  type ProbeResult,
  type ProbeStream,
  type SubtitleForm,
} from '../media/ffprobe.js';
