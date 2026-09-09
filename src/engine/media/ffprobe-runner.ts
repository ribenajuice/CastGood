import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import path from 'node:path';
import { PREPARATION } from '../config.js';
import type { Logger } from '../logging/index.js';
import type { FfmpegBinaries } from './ffmpeg.js';
import { parseFfprobeStdout } from './ffprobe.js';
import type { FfprobeRunResult, FfprobeRunner, ProbeFailure } from './inspection.js';

/**
 * The one place ffprobe is actually spawned.
 *
 * `./ffprobe.ts` is the *result* half of the probe seam — the parser, which treats
 * ffprobe's output as untrusted input — and says in as many words that there is no `spawn`
 * in it. This is the other half, and it is the only file in the engine that starts a child
 * process for a probe. Everything above it (`inspectSource`, the classifier, the engine)
 * sees a `FfprobeRunner`: one function, one file path, one result, no exceptions.
 *
 * ## Four ways a probe goes wrong, and they are not the same fact
 *
 * The engine tells the founder different things for each, so the runner distinguishes them
 * rather than collapsing everything into "no probe":
 *
 *  - `unreadable` — ffprobe ran and could not make sense of the file (non-zero exit, or a
 *    zero exit with nothing usable on stdout). **That is a fact about the file**, and the
 *    check turns it into criterion 7d's *This file can't be cast*, before the founder
 *    commits to anything.
 *  - `timeout` — nothing answered inside the budget. A fact about the *machine* (a drive
 *    that has spun down, a network share that has gone away), not a verdict about the file,
 *    so the founder is told the check could not finish rather than that their film is
 *    broken.
 *  - `cancelled` — a newer check superseded this one, or the engine is stopping. Nobody is
 *    told anything: the result is simply dropped.
 *  - `ffprobe-failed` — the binary would not start at all. In a packaged install that means
 *    the installation is damaged, which the engine surfaces (2026-08-20 ADR).
 *
 * ## What it refuses to do
 *
 *  - **Never throws.** A rejected promise here would surface as a crash on the file-picker
 *    path; every failure is a value. `resolveFfmpeg()` returning `available: false` is
 *    likewise a typed absence — `createFfprobeRunner` is simply never built, and the caller
 *    holds `null`.
 *  - **Never uses a shell.** The path is passed as one argv element to `spawn`, so a file
 *    called `a" & del *.*.mkv` is a filename and nothing else.
 *  - **Never buffers without a bound.** stdout is capped; a binary that decides to print a
 *    gigabyte is killed rather than believed.
 *  - **Never blocks.** It is a promise over a child process; the caller stays live and can
 *    abort it (7a: the check is cancellable and the window is never blocked).
 */

/** The documented invocation — `docs/ARCHITECTURE.md` §2. Headers only; it never reads the file through. */
const FFPROBE_ARGS: readonly string[] = [
  '-v',
  'quiet',
  '-print_format',
  'json',
  '-show_format',
  '-show_streams',
];

/** Just enough stderr to debug from, and never enough to be a payload in the log. */
const STDERR_SAMPLE_BYTES = 2_000;

export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface FfprobeRunnerDeps {
  readonly binaries: FfmpegBinaries;
  readonly logger?: Logger;
  /** Defaults to `PREPARATION.probeTimeoutMs`, which sits inside 7a's 3 s check budget. */
  readonly timeoutMs?: number;
  /** Injected by tests: a spawn that never has to exist on this machine. */
  readonly spawn?: SpawnLike;
  /** Injected by tests. Defaults to `PREPARATION.probeStdoutLimitBytes`. */
  readonly stdoutLimitBytes?: number;
}

function failed(failure: ProbeFailure): FfprobeRunResult {
  return { ok: false, failure };
}

/**
 * Build a runner bound to one pair of binaries.
 *
 * There is no caching of results: the same file may be probed twice in a session because
 * something about it changed, and a memo would be the "two things that disagree about one
 * file" the 2026-08-20 source-of-truth ADR exists to prevent.
 */
export function createFfprobeRunner(deps: FfprobeRunnerDeps): FfprobeRunner {
  const spawnProcess = deps.spawn ?? (nodeSpawn as SpawnLike);
  const timeoutMs = deps.timeoutMs ?? PREPARATION.probeTimeoutMs;
  const stdoutLimit = deps.stdoutLimitBytes ?? PREPARATION.probeStdoutLimitBytes;

  return function runFfprobe(filePath, options = {}): Promise<FfprobeRunResult> {
    // `path.resolve` for one reason beyond tidiness: a relative path that begins with `-`
    // would be read by ffprobe as an option rather than a file. Resolved, it never can be.
    const target = path.resolve(filePath);
    const signal = options.signal;
    if (signal?.aborted === true) return Promise.resolve(failed('cancelled'));

    return new Promise<FfprobeRunResult>((resolve) => {
      let child: ChildProcess;
      const startedAt = Date.now();
      let settled = false;
      let stdout = '';
      let stdoutBytes = 0;
      let stderr = '';
      let overflowed = false;
      let timer: NodeJS.Timeout | null = null;

      /** One resolution, whatever happens next: a killed process still emits `close`. */
      function finish(result: FfprobeRunResult, context: Record<string, unknown> = {}): void {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        deps.logger?.debug('ffprobe.finished', {
          ok: result.ok,
          failure: result.ok ? null : result.failure,
          durationMs: Date.now() - startedAt,
          ...context,
        });
        resolve(result);
      }

      function kill(): void {
        try {
          child.kill();
        } catch {
          // A process that has already gone is exactly the outcome we wanted.
        }
      }

      function onAbort(): void {
        finish(failed('cancelled'));
        kill();
      }

      try {
        child = spawnProcess(deps.binaries.ffprobe, [...FFPROBE_ARGS, target], {
          stdio: ['ignore', 'pipe', 'pipe'],
          // No console window flashes up on the founder's desktop every time they pick a
          // film. Reading `windowsHide` is not an Electron dependency; it is a Node option.
          windowsHide: true,
        });
      } catch (error) {
        // spawn can throw synchronously (EMFILE, a bad path). It is still not an exception
        // the file picker should ever see.
        deps.logger?.warn('ffprobe.spawn_failed', { error });
        finish(failed('ffprobe-failed'));
        return;
      }

      signal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        finish(failed('timeout'), { timeoutMs });
        kill();
      }, timeoutMs);
      timer.unref?.();

      child.stdout?.setEncoding('utf8');
      child.stdout?.on('data', (chunk: string) => {
        stdoutBytes += Buffer.byteLength(chunk, 'utf8');
        if (stdoutBytes > stdoutLimit) {
          // Untrusted output with an unbounded appetite. Stop believing it and stop it.
          overflowed = true;
          finish(failed('unreadable'), { why: 'stdout overflowed', stdoutBytes });
          kill();
          return;
        }
        stdout += chunk;
      });
      child.stderr?.setEncoding('utf8');
      child.stderr?.on('data', (chunk: string) => {
        if (stderr.length < STDERR_SAMPLE_BYTES) stderr += chunk;
      });

      child.on('error', (error) => {
        deps.logger?.warn('ffprobe.spawn_failed', { error });
        finish(failed('ffprobe-failed'));
      });

      child.on('close', (code) => {
        if (settled || overflowed) return;
        if (code !== 0) {
          // ffprobe's own diagnosis of the file goes to the log, never to the screen (7a).
          deps.logger?.info('ffprobe.rejected_file', {
            exitCode: code,
            stderr: stderr.slice(0, STDERR_SAMPLE_BYTES).trim(),
          });
          finish(failed('unreadable'), { exitCode: code });
          return;
        }
        const probe = parseFfprobeStdout(stdout);
        if (probe === null) {
          // Exit 0 and nothing usable on stdout — a build that printed a warning, an empty
          // report, JSON that is not the shape we know. Treated exactly like a refusal.
          finish(failed('unreadable'), { why: 'nothing usable on stdout', stdoutBytes });
          return;
        }
        finish({ ok: true, probe }, { streams: probe.streams.length, container: probe.container });
      });
    });
  };
}
