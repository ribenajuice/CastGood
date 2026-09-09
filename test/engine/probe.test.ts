import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDuration, probeSourceFile } from '../../src/engine/media/probe.js';

/**
 * M1 asks a file exactly one question: how long is it? These fixtures are built byte by
 * byte in the test rather than checked in, so there are no binaries in git — and the
 * important one is the *hard* shape: `moov` after `mdat`, which is what the founder's
 * own file looks like and what a naive parser gets wrong.
 */

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-probe-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

function mvhdV0(timescale: number, duration: number): Buffer {
  const content = Buffer.alloc(100);
  content.writeUInt8(0, 0); // version 0
  content.writeUInt32BE(0, 4); // creation time
  content.writeUInt32BE(0, 8); // modification time
  content.writeUInt32BE(timescale, 12);
  content.writeUInt32BE(duration, 16);
  return box('mvhd', content);
}

function mvhdV1(timescale: number, duration: bigint): Buffer {
  const content = Buffer.alloc(112);
  content.writeUInt8(1, 0); // version 1
  content.writeUInt32BE(timescale, 20);
  content.writeBigUInt64BE(duration, 24);
  return box('mvhd', content);
}

async function write(name: string, buffer: Buffer): Promise<string> {
  const file = path.join(directory, name);
  await fs.writeFile(file, buffer);
  return file;
}

describe('duration probing — MP4', () => {
  it('reads the duration of a file whose moov is at the very end (not web-optimised)', async () => {
    const file = await write(
      'trailing-moov.mp4',
      Buffer.concat([
        box('ftyp', Buffer.from('isom')),
        box('free', Buffer.alloc(64)),
        box('mdat', Buffer.alloc(200_000)),
        box('moov', mvhdV0(1000, 90_000)),
      ]),
    );
    const probed = await probeSourceFile(file);
    expect(probed.durationSec).toBeCloseTo(90, 5);
    expect(probed.name).toBe('trailing-moov.mp4');
    expect(probed.sizeBytes).toBeGreaterThan(200_000);
  });

  it('reads the duration of a faststart file too', async () => {
    const file = await write(
      'faststart.mp4',
      Buffer.concat([
        box('ftyp', Buffer.from('isom')),
        box('moov', mvhdV0(90_000, 90_000 * 3_600)),
        box('mdat', Buffer.alloc(1_000)),
      ]),
    );
    expect((await probeSourceFile(file)).durationSec).toBeCloseTo(3_600, 5);
  });

  it('reads a 64-bit (version 1) movie header', async () => {
    const file = await write(
      'v1.mp4',
      Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', mvhdV1(1_000, 7_200_000n))]),
    );
    expect((await probeSourceFile(file)).durationSec).toBeCloseTo(7_200, 5);
  });

  it('returns null rather than inventing a number when the header says "unknown"', async () => {
    const file = await write(
      'unknown.mp4',
      Buffer.concat([box('ftyp', Buffer.from('isom')), box('moov', mvhdV0(1_000, 0xffffffff))]),
    );
    expect((await probeSourceFile(file)).durationSec).toBeNull();
  });

  it('returns null for a file with no moov, and still reports name and size', async () => {
    const file = await write('no-moov.mp4', Buffer.concat([box('ftyp', Buffer.from('isom'))]));
    const probed = await probeSourceFile(file);
    expect(probed.durationSec).toBeNull();
    expect(probed.sizeBytes).toBe(12);
  });

  it('does not hang on a corrupt zero-length box', async () => {
    const corrupt = Buffer.alloc(64);
    corrupt.write('moov', 4, 'latin1'); // size field left at 0 inside the file
    const file = await write('corrupt.mp4', corrupt);
    expect((await probeSourceFile(file)).durationSec).toBeNull();
  });
});

describe('duration probing — WebM/Matroska', () => {
  function ebmlSize(length: number): Buffer {
    const buffer = Buffer.alloc(4);
    buffer.writeUInt32BE(0x10000000 | length, 0);
    return buffer;
  }
  function element(id: number[], content: Buffer): Buffer {
    return Buffer.concat([Buffer.from(id), ebmlSize(content.length), content]);
  }

  it('reads Duration × TimecodeScale from the Info element', async () => {
    const timecodeScale = element([0x2a, 0xd7, 0xb1], Buffer.from([0x0f, 0x42, 0x40])); // 1_000_000
    const durationValue = Buffer.alloc(8);
    durationValue.writeDoubleBE(90_000); // ticks
    const duration = element([0x44, 0x89], durationValue);
    const info = element([0x15, 0x49, 0xa9, 0x66], Buffer.concat([timecodeScale, duration]));
    const segment = element([0x18, 0x53, 0x80, 0x67], info);

    const file = await write('clip.webm', segment);
    expect((await probeSourceFile(file)).durationSec).toBeCloseTo(90, 5);
  });

  it('returns null for an EBML file with no Info element', async () => {
    const file = await write('empty.webm', Buffer.from([0x18, 0x53, 0x80, 0x67, 0x10, 0, 0, 0]));
    expect((await probeSourceFile(file)).durationSec).toBeNull();
  });
});

describe('probing failures', () => {
  it('reports a missing file in plain language, with no path in the founder-facing text', async () => {
    await expect(probeSourceFile(path.join(directory, 'nope.mp4'))).rejects.toMatchObject({
      code: 'SOURCE_MISSING',
      userMessage: 'That file is no longer where it was.',
    });
  });

  it('refuses a directory', async () => {
    await expect(probeSourceFile(directory)).rejects.toMatchObject({ code: 'SOURCE_MISSING' });
  });
});

describe('formatDuration', () => {
  it('formats as H:MM:SS, which is the readout the PRD names', () => {
    expect(formatDuration(0)).toBe('0:00:00');
    expect(formatDuration(65)).toBe('0:01:05');
    expect(formatDuration(3_661)).toBe('1:01:01');
    expect(formatDuration(7_199.9)).toBe('1:59:59');
  });
});
