import { describe, expect, it } from 'vitest';
import { detectVideoEncoder } from '../../src/engine/prepare/encoders.js';
import {
  BASELINE_OUTPUT,
  NVENC_OUTPUT,
  outputProfileFor,
} from '../../src/engine/prepare/output-profiles.js';
import { BASELINE_PROFILE } from '../../src/engine/prepare/device-profiles.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import { createFakeSpawn } from './fixtures/spawn.js';

/**
 * Which encoder this PC can use, and what happens when the answer is "none of the fast ones".
 *
 * The whole point of asking by **opening** an encoder rather than reading `ffmpeg -encoders`
 * is written on `encoders.ts`: on the founder's own machine that list included three
 * hardware encoders and exactly one of them worked, and the one that eventually did spent a
 * day refusing because the graphics driver predated the ffmpeg build. A capability list is a
 * fact about ffmpeg; whether an encoder opens is a fact about this machine today.
 */

const binaries = { ffmpeg: '/bin/ffmpeg', ffprobe: '/bin/ffprobe' };
const sink = createMemorySink();
const logger = () => createLogger({ sink, bindings: {} });

describe('finding out what this machine can do', () => {
  it('takes a clean exit as a yes', async () => {
    const fake = createFakeSpawn();
    const found = detectVideoEncoder({ binaries, logger: logger(), spawn: fake.spawn });
    (await fake.waitForChild()).exit(0);
    expect(await found).toBe('h264_nvenc');
  });

  it('probes with the settings we intend to ship, not with defaults', async () => {
    // `h264_mf` is the reason. It *runs* and silently produces Constrained Baseline, so an
    // encoder that "works" can still be the wrong encoder. Probing with `-profile:v high`
    // and `-pix_fmt yuv420p` means a pass is a pass for the thing we will actually do.
    const fake = createFakeSpawn();
    const found = detectVideoEncoder({ binaries, logger: logger(), spawn: fake.spawn });
    const child = await fake.waitForChild();
    expect(child.args.join(' ')).toContain('-c:v h264_nvenc');
    expect(child.args.join(' ')).toContain('-profile:v high');
    expect(child.args.join(' ')).toContain('-pix_fmt yuv420p');
    child.exit(0);
    await found;
  });

  it('falls back to software when the encoder refuses, and says why', async () => {
    // The real message from the founder's machine, verbatim.
    const fake = createFakeSpawn();
    const found = detectVideoEncoder({ binaries, logger: logger(), spawn: fake.spawn });
    const child = await fake.waitForChild();
    child.stderr(
      '[h264_nvenc @ 0000] Driver does not support the required nvenc API version. Required: 13.1 Found: 13.0\n',
    );
    child.exit(1);
    expect(await found).toBe('libx264');
    expect(sink.lines.join('')).toContain('nvenc API version');
  });

  it('falls back when ffmpeg will not start at all', async () => {
    const found = await detectVideoEncoder({
      binaries,
      logger: logger(),
      spawn: () => {
        throw new Error('EMFILE');
      },
    });
    expect(found).toBe('libx264');
  });

  it('falls back rather than hanging when a probe never answers', async () => {
    // A wedged driver must cost a slower conversion, never a preparation that will not start.
    const fake = createFakeSpawn();
    const found = detectVideoEncoder({
      binaries,
      logger: logger(),
      spawn: fake.spawn,
      timeoutMs: 20,
    });
    const child = await fake.waitForChild();
    expect(await found).toBe('libx264');
    expect(child.killed).toBe(true);
  });
});

describe('which settings each answer selects', () => {
  it('uses the hardware entry only when the hardware answered', () => {
    expect(outputProfileFor(BASELINE_PROFILE, 'h264_nvenc')).toBe(NVENC_OUTPUT);
    expect(outputProfileFor(BASELINE_PROFILE, 'libx264')).toBe(BASELINE_OUTPUT);
    // The default is the encoder that always exists.
    expect(outputProfileFor(BASELINE_PROFILE)).toBe(BASELINE_OUTPUT);
  });

  it('targets the same conservative baseline whichever encoder runs', () => {
    // The reason one artifact can serve a three-television house: preparation only ever
    // narrows, so both entries aim at what *every* device can play rather than at the one
    // in front of us. `h264_mf` was rejected for silently missing this.
    for (const profile of [BASELINE_OUTPUT, NVENC_OUTPUT]) {
      const args = profile.videoArgs.join(' ');
      expect(args, profile.id).toContain('-profile:v high');
      expect(args, profile.id).toContain('-level 4.1');
      expect(args, profile.id).toContain('-pix_fmt yuv420p');
      // M3b's segment boundaries must not depend on which encoder happened to run.
      expect(args, profile.id).toContain('-g 96');
    }
  });

  it('gives the two entries different ids, because they are different settings', () => {
    // "Change the numbers, change the id" — an entry whose meaning has drifted from its
    // name is worse than no name, and a prepared file's log line has to say what made it.
    expect(NVENC_OUTPUT.id).not.toBe(BASELINE_OUTPUT.id);
  });
});
