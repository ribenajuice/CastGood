import type { SourceFile } from '../types.js';
import type { ProbeResult } from './ffprobe.js';
import { identifySource, probeSourceFile, type ProbedSource } from './probe.js';

/**
 * **One file, one source of truth about it.**
 *
 * The 2026-08-14 ADR shipped M1 without ffmpeg and read durations from container headers in
 * pure TypeScript, deferring one question to this milestone: *"decide whether the JS probe
 * stays as a fast path or is deleted. **Do not let the two disagree about the same file.**"*
 *
 * Settled here, 2026-08-19:
 *
 *  - **ffprobe is the only thing that speaks about a file in the product path.** Its
 *    duration is the duration — the number the scrubber is drawn from, which the
 *    2026-08-19 SPIKE-1 ADR made ours alone because the television reports `-1` forever.
 *    Its streams are the only input to the classifier.
 *  - **The header reader is not deleted, and is not a fast path either.** It is the
 *    *fallback for a machine with no ffprobe* — which is every WSL session, every engine
 *    unit test, and a Windows install whose binaries are missing. It reports a duration and
 *    nothing else, and a file it spoke about is a file that **cannot be classified**: header
 *    bytes cannot answer a codec question, and inventing a verdict from them is exactly the
 *    "two things that disagree" this ruling exists to prevent.
 *  - **They are never both consulted about the same file.** `inspectSource` picks one, in
 *    one place, and the choice is recorded on the result as `origin` so the log always names
 *    who spoke. A `ProbeResult` carries `origin: 'ffprobe'` in its type, so the header path
 *    literally cannot construct one.
 *
 * The alternative — keeping the JS parser as a fast path for duration and using ffprobe for
 * codecs — was rejected: it is two readers for one number, and the day they disagree is an
 * evening spent on a scrubber that does not match the film.
 */

export type ProbeOrigin = 'ffprobe' | 'headers';

/**
 * Why there is no probe — and these are four different facts, told four different ways.
 *
 * `unreadable` is a fact about the **file**: ffprobe ran and could make nothing of it, so
 * the check answers criterion 7d's *This file can't be cast* before the founder commits.
 * `timeout` is a fact about the **machine** — a sleeping drive, a share that went away —
 * and is never dressed up as a verdict about the film. `cancelled` is a superseded check
 * and is told to nobody. `ffprobe-failed` is a binary that would not start, which in a
 * packaged install means a damaged installation.
 */
export type ProbeFailure = 'unreadable' | 'timeout' | 'cancelled' | 'ffprobe-failed';

export interface SourceInspection extends SourceFile {
  readonly name: string;
  /** Who told us. `headers` means no ffprobe was available on this machine. */
  readonly origin: ProbeOrigin;
  /** The duration the whole app uses, from whichever source spoke. `null` if neither could. */
  readonly durationSec: number | null;
  /** The classifier's only possible input. `null` whenever `origin` is `headers`. */
  readonly probe: ProbeResult | null;
  /** Why `probe` is null, when ffprobe was the one who tried. `null` otherwise. */
  readonly failure: ProbeFailure | null;
}

export type FfprobeRunResult =
  | { readonly ok: true; readonly probe: ProbeResult }
  | { readonly ok: false; readonly failure: ProbeFailure };

export interface FfprobeRunOptions {
  /** 7a: a check is cancellable. Aborting kills the child process. */
  readonly signal?: AbortSignal;
}

/**
 * Runs ffprobe on a path. Supplied by the caller; **never rejects** — every failure is a
 * value, because this sits on the file-picker path and a throw there is a crash the founder
 * sees. `src/engine/media/ffprobe-runner.ts` is the only implementation that spawns.
 */
export type FfprobeRunner = (
  filePath: string,
  options?: FfprobeRunOptions,
) => Promise<FfprobeRunResult>;

export function inspectionFromProbe(
  source: ProbedSource | SourceFile,
  name: string,
  probe: ProbeResult,
): SourceInspection {
  return {
    path: source.path,
    sizeBytes: source.sizeBytes,
    mtimeMs: source.mtimeMs,
    name,
    origin: 'ffprobe',
    // ffprobe's duration, always — a header duration for this same file is never read, so
    // there is no second opinion to reconcile with and no rule about which one wins.
    durationSec: probe.durationSec,
    probe,
    failure: null,
  };
}

export function inspectionFromHeaders(probed: ProbedSource): SourceInspection {
  return {
    path: probed.path,
    sizeBytes: probed.sizeBytes,
    mtimeMs: probed.mtimeMs,
    name: probed.name,
    origin: 'headers',
    durationSec: probed.durationSec,
    probe: null,
    failure: null,
  };
}

/**
 * The single place a file is inspected.
 *
 * `runFfprobe` is `null` when this machine has no ffprobe — the WSL case — and only then
 * are the container headers read. There is no path through this function that consults
 * both.
 */
export async function inspectSource(
  filePath: string,
  runFfprobe: FfprobeRunner | null,
  options: FfprobeRunOptions = {},
): Promise<SourceInspection> {
  if (runFfprobe !== null) {
    // The stat comes first and is allowed to throw: a file that is not there is
    // `SOURCE_MISSING`, which is story 15's sentence and predates every one of these
    // failure modes. Only the *probe* is a value rather than an exception.
    const identity = await identifySource(filePath);
    const result = await runFfprobe(filePath, options);
    if (result.ok) return inspectionFromProbe(identity, identity.name, result.probe);
    // ffprobe exists and could not read the file. That is a fact about the file, not a
    // reason to ask a weaker reader for a second opinion: the check has failed and the
    // caller says so. Headers are for machines without ffprobe, never for files ffprobe
    // rejected.
    return {
      ...identity,
      origin: 'ffprobe',
      durationSec: null,
      probe: null,
      failure: result.failure,
    };
  }
  return inspectionFromHeaders(await probeSourceFile(filePath));
}

/** True when this file can be given a verdict at all — i.e. ffprobe spoke about it. */
export function isClassifiable(
  inspection: SourceInspection,
): inspection is SourceInspection & { readonly probe: ProbeResult } {
  return inspection.probe !== null;
}
