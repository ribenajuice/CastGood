import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectSource, isClassifiable } from '../../src/engine/media/inspection.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import { ffprobeFailing, ffprobeYielding, report } from './fixtures/ffprobe.js';

/**
 * The 2026-08-14 ADR left one thing to M3: *"decide whether the JS probe stays as a fast
 * path or is deleted. **Do not let the two disagree about the same file.**"*
 *
 * These are the tests of that ruling. Every case here is deliberately set up so the two
 * readers **would** disagree — the file on disk says 7200 s, ffprobe says 6990 s — because a
 * test where they agree cannot tell you which one answered.
 */

let directory: string;
let filePath: string;

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/** A real MP4 header, readable by the pure-JS parser, claiming a two-hour film. */
function twoHourMp4(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(7_200_000, 16);
  return Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', box('mvhd', mvhd))]);
}

/** ffprobe's answer for the same file: 6990 s, which is what a 1:56:30 film really is. */
const ffprobeSays: FfprobeRunner = ffprobeYielding(report({ durationSec: 6_990 }));

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-inspect-'));
  filePath = path.join(directory, 'Some Film.mp4');
  await fs.writeFile(filePath, twoHourMp4());
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

describe('one file, one source of truth', () => {
  it('believes ffprobe and never the headers when ffprobe is there', async () => {
    const inspection = await inspectSource(filePath, ffprobeSays);
    expect(inspection.origin).toBe('ffprobe');
    expect(inspection.durationSec).toBe(6_990);
    expect(isClassifiable(inspection)).toBe(true);
    // The identity still comes off the filesystem — that is a stat, not a second opinion.
    expect(inspection.sizeBytes).toBeGreaterThan(0);
    expect(inspection.name).toBe('Some Film.mp4');
  });

  it('answers from ffprobe even for a file whose headers say nothing at all', async () => {
    const unreadable = path.join(directory, 'Some Film.avi');
    await fs.writeFile(unreadable, Buffer.alloc(4_096, 0x5a));
    const inspection = await inspectSource(unreadable, ffprobeSays);
    expect(inspection.durationSec).toBe(6_990);
    expect(inspection.probe).not.toBeNull();
  });

  it('falls back to the headers only where there is no ffprobe — and cannot be classified', async () => {
    const inspection = await inspectSource(filePath, null);
    expect(inspection.origin).toBe('headers');
    expect(inspection.durationSec).toBe(7_200);
    expect(inspection.probe).toBeNull();
    // This is the part that makes the ruling enforceable rather than aspirational: there is
    // no `ProbeResult` here, so `classify` cannot be called on this file at all.
    expect(isClassifiable(inspection)).toBe(false);
  });

  it('does not ask the weaker reader for a second opinion when ffprobe rejected the file', async () => {
    const inspection = await inspectSource(filePath, ffprobeFailing('unreadable'));
    expect(inspection.origin).toBe('ffprobe');
    // The headers would happily have said 7200. A check that could not run says so.
    expect(inspection.durationSec).toBeNull();
    expect(inspection.failure).toBe('unreadable');
    expect(isClassifiable(inspection)).toBe(false);
  });

  it('still reports a missing file as a missing file, whichever reader is in play', async () => {
    const missing = path.join(directory, 'gone.mp4');
    await expect(inspectSource(missing, ffprobeSays)).rejects.toMatchObject({
      code: 'SOURCE_MISSING',
    });
    await expect(inspectSource(missing, null)).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
  });
});
