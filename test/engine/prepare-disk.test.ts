import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { freeBytesOn, isWritableDirectory, roomFor } from '../../src/engine/prepare/disk.js';
import { PREPARATION } from '../../src/engine/config.js';

/**
 * P1: *"the shortfall is detected **before any work begins**, stated as a plain amount"*.
 *
 * The PRD calls this *"arithmetic over (estimated size, free bytes)"* and *"a pure
 * function"*, so it is tested as one — no disk, no mocking, just numbers and the sentence
 * they produce. That is the whole reason the I/O is a separate function.
 */

const GB = 1_000_000_000;

describe('will it fit? — the pre-flight arithmetic', () => {
  it('insists on the estimate plus 15%, which is the margin the PRD names', () => {
    // "An estimate that is exactly right is a coin flip. 15% is the margin between refusing
    // honestly up front and failing at 80%."
    const verdict = roomFor(4 * GB, 4.5 * GB);
    expect(verdict.requiredBytes).toBe(Math.ceil(4 * GB * PREPARATION.diskHeadroomFactor));
    // 4.6 GB required against 4.5 GB free: it *would* have fitted without the margin, and
    // that is exactly the job the margin exists to refuse.
    expect(verdict.ok).toBe(false);
    expect(verdict.shortfallBytes).toBeGreaterThan(0);
  });

  it('passes a job with room to spare and says nothing at all', () => {
    const verdict = roomFor(4 * GB, 40 * GB);
    expect(verdict.ok).toBe(true);
    expect(verdict.shortfallBytes).toBe(0);
    // When there is nothing to say, there is nothing to say. A "you have plenty of room"
    // reassurance is a sentence about a problem the founder does not have.
    expect(verdict.message).toBeNull();
  });

  it('states the shortfall as an amount a person would say, never a percentage', () => {
    const verdict = roomFor(4 * GB, 1 * GB);
    expect(verdict.message).toBe(
      'There isn’t enough room on that drive — CastGood needs about 3.6 GB more.',
    );
    // The PRD's own phrasing is "needs about 3 GB more". No path, no percentage, no bytes.
    expect(verdict.message).not.toMatch(/[0-9]{7}/);
    expect(verdict.message).not.toContain('%');
  });

  it('counts the margin into the shortfall, so freeing exactly that much is enough', () => {
    // The number the founder is given has to be one they can act on. If they free the
    // amount we asked for and the job then refuses again, the sentence was a lie.
    const verdict = roomFor(4 * GB, 1 * GB);
    const after = roomFor(4 * GB, 1 * GB + verdict.shortfallBytes);
    expect(after.ok).toBe(true);
  });

  it('is total: a nonsense estimate or a negative free figure still answers', () => {
    expect(roomFor(0, 0).ok).toBe(true);
    expect(roomFor(-5, -5).ok).toBe(true);
    // A `NaN` free figure is "we do not know", which must read as no room rather than as a
    // sentence with `NaN` in it. Both inputs come from outside — one from a probe, one from
    // the operating system — so neither is assumed to be a number.
    const unknown = roomFor(GB, Number.NaN);
    expect(unknown.ok).toBe(false);
    expect(unknown.message).not.toContain('NaN');
  });
});

describe('asking the operating system', () => {
  let directory: string;

  beforeEach(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-disk-'));
  });

  afterEach(async () => {
    await fsp.rm(directory, { recursive: true, force: true });
  });

  it('reports the room on the volume holding a file that does not exist yet', async () => {
    // It is always asked about the file we are *about* to write, so the question has to be
    // answered from the directory rather than from the file.
    const free = await freeBytesOn(path.join(directory, 'Cars (CastGood).mp4.partial'));
    expect(free).not.toBeNull();
    expect(free ?? 0).toBeGreaterThan(0);
  });

  it('returns null rather than throwing on a volume it cannot interrogate', async () => {
    // And the pipeline proceeds on `null`. Refusing a job because we could not *measure*
    // would turn an unusual filesystem into a film that will not play; P2 catches a disk
    // that really was full.
    expect(await freeBytesOn('/proc/self/nowhere-at-all/x')).toBeNull();
  });

  it('finds out whether a folder can be written to by writing to it', async () => {
    expect(await isWritableDirectory(directory)).toBe(true);
    expect(await isWritableDirectory(path.join(directory, 'does-not-exist'))).toBe(false);
    // And it leaves nothing behind, in a folder that belongs to the founder.
    expect(await fsp.readdir(directory)).toEqual([]);
  });

  it('believes a write over a permission bit, because Windows does not mean the same thing', async () => {
    // `W_OK` on NTFS reports a writable directory that ACLs and read-only shares then
    // refuse. The probe is a real write for that reason, so a read-only directory has to
    // come back false here rather than true-and-then-fail four gigabytes later.
    const readOnly = path.join(directory, 'read-only');
    await fsp.mkdir(readOnly);
    await fsp.chmod(readOnly, 0o500);
    try {
      expect(await isWritableDirectory(readOnly)).toBe(false);
    } finally {
      await fsp.chmod(readOnly, 0o700);
    }
  });
});
