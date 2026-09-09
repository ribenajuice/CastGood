import { spawn as nodeSpawn } from 'node:child_process';
import type { Logger } from '../logging/index.js';
import type { FfmpegBinaries } from '../media/ffmpeg.js';
import type { SpawnLike } from '../media/ffprobe-runner.js';

/**
 * Which video encoder can this PC actually use?
 *
 * **Asked by trying, never by asking.** `ffmpeg -encoders` lists what the *build* was
 * compiled with, which on the founder's machine included `h264_nvenc`, `h264_qsv` and
 * `h264_amf` — and exactly one of them worked. The other two have no silicon here, and
 * NVENC itself refused for a whole day on a driver older than the build required:
 *
 *     Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0
 *
 * A capability list is a fact about ffmpeg. Whether an encoder opens is a fact about this
 * machine, this driver and this hour, and the only way to learn it is to open one.
 *
 * ## Why this is allowed to use a synthetic clip
 *
 * SPIKE-4 banned `testsrc` from throughput measurement, because flat colour and simple
 * motion are not a film and the number meant nothing. This is a different question — *does
 * the encoder start* — and for that the content is irrelevant. A quarter-second of black is
 * enough to find out, and it is far cheaper than reading the founder's disk to ask.
 */

export type VideoEncoder = 'libx264' | 'h264_nvenc';

export interface EncoderProbeDeps {
  readonly binaries: FfmpegBinaries;
  readonly logger?: Logger;
  readonly spawn?: SpawnLike;
  /** Bound on the probe. It is a quarter-second encode; anything slower is a broken driver. */
  readonly timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 10_000;

/**
 * The hardware encoder we try, and the settings that make the attempt meaningful.
 *
 * `-profile:v high` and `-pix_fmt yuv420p` are here rather than being left to defaults for
 * a reason found on this machine: `h264_mf` *runs* and silently produces Constrained
 * Baseline, so an encoder that "works" can still be the wrong encoder. Probing with the
 * settings we intend to ship means a pass is a pass for the thing we will actually do.
 */
const NVENC_PROBE_ARGS: readonly string[] = [
  '-f',
  'lavfi',
  '-i',
  'color=black:s=256x256:r=25:d=0.25',
  '-c:v',
  'h264_nvenc',
  '-profile:v',
  'high',
  '-pix_fmt',
  'yuv420p',
  '-f',
  'null',
  '-',
];

function tryEncoder(deps: EncoderProbeDeps, args: readonly string[]): Promise<string | null> {
  const spawnProcess = deps.spawn ?? (nodeSpawn as SpawnLike);
  return new Promise<string | null>((resolve) => {
    let child;
    let stderr = '';
    let settled = false;
    const finish = (reason: string | null): void => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };

    try {
      child = spawnProcess(deps.binaries.ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch (error) {
      finish(String(error));
      return;
    }

    const timer = setTimeout(() => {
      finish('the probe did not finish in time');
      try {
        child.kill();
      } catch {
        // Already gone is the outcome we wanted.
      }
    }, deps.timeoutMs ?? PROBE_TIMEOUT_MS);
    timer.unref?.();

    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      // The tail, not the head: ffmpeg says why it refused at the end. Learned the hard way
      // in SPIKE-5, where capping from the front truncated away the answer.
      stderr = (stderr + chunk).slice(-4_000);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      finish(String(error));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) {
        finish(null);
        return;
      }
      const named =
        stderr
          .split('\n')
          .find((line) => /not support|minimum|Cannot load|Error|failed/i.test(line)) ??
        stderr.split('\n').filter((l) => l.trim() !== '')[0] ??
        `exit ${String(code)}`;
      finish(named.trim().slice(0, 220));
    });
  });
}

/**
 * The encoder to use, decided once per run.
 *
 * **The fallback is the point.** `libx264` is always there — it is compiled into every
 * build we ship and needs no hardware — so a machine with no usable GPU encoder, a driver
 * that regressed, or a card being used by something else gets a slower conversion rather
 * than a failed one. A preparation that dies because a graphics driver was updated badly
 * would be the worst possible way to lose an evening.
 */
export async function detectVideoEncoder(deps: EncoderProbeDeps): Promise<VideoEncoder> {
  const refusal = await tryEncoder(deps, NVENC_PROBE_ARGS);
  if (refusal === null) {
    deps.logger?.info('encoder.detected', { encoder: 'h264_nvenc' });
    return 'h264_nvenc';
  }
  // Not a warning. No hardware encoder is the ordinary condition on most PCs, and the
  // software path is a supported way to run this product rather than a degraded one.
  deps.logger?.info('encoder.detected', { encoder: 'libx264', hardwareRefusedBecause: refusal });
  return 'libx264';
}
