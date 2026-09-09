import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import fsp from 'node:fs/promises';
import type { ChildProcess } from 'node:child_process';
import type { SpawnLike } from '../../../src/engine/media/ffprobe-runner.js';

/**
 * A scripted child process, so the preparation pipeline can be run end to end in WSL.
 *
 * **This is the fake this project has been burned by six times**, in a new place. The
 * standing rule from M1 and M2 is that a fake kinder than reality proves nothing, so this
 * one is written to be *unkind* in the ways ffmpeg actually is:
 *
 *  - it writes its output file **before** it exits, so a pipeline that renames too early
 *    fails here rather than on the founder's disk;
 *  - it emits `-progress` blocks in ffmpeg's own shape, `out_time_ms` carrying microseconds
 *    and `speed=` carrying its `x` suffix, because both of those are real quirks;
 *  - it can step `out_time` **backwards**, which ffmpeg does at a chapter boundary, so the
 *    "the bar never retreats" promise is tested against the thing that would break it;
 *  - a kill reports a **signal and no exit code**, which is how Node reports a killed
 *    process and is what tells a cancel apart from a failure;
 *  - and it fails with ffmpeg's own words on stderr, so the sentence the founder gets is
 *    chosen by parsing what ffmpeg says rather than what we wish it said.
 *
 * What it deliberately does not do is encode anything. A ten-second clip with wrong audio
 * exercises every branch of the classifier; a real conversion is a hardware measurement,
 * and the PRD says so in as many words.
 */

export interface FakeChild {
  /** Push one `-progress` block. Values are ffmpeg's, in ffmpeg's units. */
  progress(fields: { outTimeSec: number; speed?: number; totalSize?: number; end?: boolean }): void;
  stderr(text: string): void;
  /** Finish as ffmpeg finishes: an exit code, and no signal. */
  exit(code: number): void;
  /**
   * Finish the way something *outside* CastGood ending the process looks — Task Manager, a
   * Windows shutdown: a signal and **no** exit code. Reading the code alone would turn
   * every one of these into "Couldn't prepare Cars.mkv".
   */
  closeWithSignal(signal?: NodeJS.Signals): void;
  readonly killed: boolean;
  readonly args: readonly string[];
  readonly command: string;
}

export interface FakeSpawn {
  readonly spawn: SpawnLike;
  /** Every process started so far, in order. */
  readonly children: readonly FakeChild[];
  /** Resolves once `count` processes have been started. */
  waitForChild(count?: number): Promise<FakeChild>;
}

interface Internals extends FakeChild {
  /** Set by a test to model a process that does not answer a kill. */
  ignoreKill?: boolean;
  readonly emitter: EventEmitter;
  readonly out: Readable;
  readonly err: Readable;
}

export function createFakeSpawn(): FakeSpawn {
  const children: Internals[] = [];
  const waiters: (() => void)[] = [];

  const spawn: SpawnLike = (command, args) => {
    const emitter = new EventEmitter();
    const out = new Readable({ read() {} });
    const err = new Readable({ read() {} });
    let killed = false;

    const child: Internals = {
      emitter,
      out,
      err,
      command,
      args: [...args],
      get killed() {
        return killed;
      },
      progress({ outTimeSec, speed, totalSize, end }) {
        const micro = Math.round(outTimeSec * 1e6);
        const lines = [
          `frame=${String(Math.round(outTimeSec * 24))}`,
          `total_size=${String(totalSize ?? Math.round(outTimeSec * 1_000_000))}`,
          // ffmpeg has printed **microseconds** under a name ending `_ms` for years. Both
          // keys are emitted because both are, and the parser must not believe the name.
          `out_time_us=${String(micro)}`,
          `out_time_ms=${String(micro)}`,
          `speed=${(speed ?? 1).toFixed(2)}x`,
          `progress=${end === true ? 'end' : 'continue'}`,
        ];
        out.push(`${lines.join('\n')}\n`);
      },
      stderr(text) {
        err.push(text);
      },
      closeWithSignal(signal = 'SIGTERM') {
        out.push(null);
        err.push(null);
        setImmediate(() => {
          emitter.emit('close', null, signal);
        });
      },
      exit(code) {
        out.push(null);
        err.push(null);
        // Asynchronous, exactly as a real close is: a pipeline that assumes the file is
        // there the instant it asks for the exit code would pass against a synchronous fake.
        setImmediate(() => {
          emitter.emit('close', code, null);
        });
      },
    };

    // `kill()` is not a method we can stub away — it is what cancellation is made of.
    const process_ = Object.assign(emitter, {
      stdout: out,
      stderr: err,
      kill: () => {
        if (killed) return true;
        killed = true;
        // A process that swallows its kill — set by the test that proves the wait for exit
        // is bounded. Real ones exist: a wedged encoder, a filesystem that will not return.
        if ((child as { ignoreKill?: boolean }).ignoreKill === true) return true;
        out.push(null);
        err.push(null);
        // A killed process reports a signal and **no** exit code. That distinction is the
        // whole of how a cancel is told apart from a failure.
        setImmediate(() => {
          emitter.emit('close', null, 'SIGTERM');
        });
        return true;
      },
    });

    children.push(child);
    for (const waiter of waiters.splice(0)) waiter();
    return process_ as unknown as ChildProcess;
  };

  return {
    spawn,
    get children() {
      return children;
    },
    async waitForChild(count = 1) {
      while (children.length < count) {
        await new Promise<void>((resolve) => waiters.push(resolve));
      }
      const child = children[count - 1];
      if (child === undefined) throw new Error('no child');
      return child;
    },
  };
}

/** The `-i` argument of a spawned ffmpeg, which is the file it was pointed at. */
export function inputOf(child: FakeChild): string | undefined {
  const index = child.args.indexOf('-i');
  return index === -1 ? undefined : child.args[index + 1];
}

/**
 * Every file an ffmpeg invocation was told to write, in order.
 *
 * Read from the `-f <format> <path>` pairs rather than from the end of the argv, and both
 * halves of that matter. `runFfmpegJob` appends `-progress pipe:1 -nostats` **after** the
 * outputs, so "the last argument" is `-nostats`; and a job with subtitles has **several**
 * outputs — one MP4 and one WebVTT per text track — so "the output" is not a single thing
 * at all. A helper that answered either question wrongly would have pipeline tests failing
 * for reasons that have nothing to do with the pipeline.
 */
export function outputsOf(child: FakeChild): string[] {
  const outputs: string[] = [];
  for (let index = 0; index < child.args.length - 2; index += 1) {
    if (child.args[index] === '-f') outputs.push(child.args[index + 2] ?? '');
  }
  return outputs;
}

/** The film itself, which is always the first output. */
export function outputOf(child: FakeChild): string {
  return outputsOf(child)[0] ?? '';
}

/**
 * The ordinary happy path: write the output file, report progress across the film, exit 0.
 *
 * The write happens **before** the exit, because that is the order a real ffmpeg does it in
 * and a pipeline that renames on the exit code alone must still find a file there.
 */
export async function runToCompletion(
  child: FakeChild,
  options: { durationSec: number; bytes?: number } = { durationSec: 90 },
): Promise<void> {
  await fsp.writeFile(outputOf(child), Buffer.alloc(options.bytes ?? 1_024, 7));
  for (const fraction of [0.25, 0.5, 0.75, 1]) {
    child.progress({
      outTimeSec: options.durationSec * fraction,
      speed: 12,
      totalSize: Math.round((options.bytes ?? 1_024) * fraction),
      end: fraction === 1,
    });
  }
  child.exit(0);
}
