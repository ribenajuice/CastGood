import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Stats } from 'node:fs';
import type { SourceFile } from '../types.js';
import { EngineError } from '../errors.js';

/**
 * How long is this file?
 *
 * That is the *only* question M1 asks of a video file. It is explicitly **not** a
 * compatibility judgement — the founder is expected to pick a file the device already
 * plays, and the "can this be cast?" verdict is Milestone 3's classifier with ffprobe
 * behind it. Reading a duration is a header read; deciding a codec plan is not.
 *
 * It is done in pure JavaScript, from the container's own headers, for one reason: the
 * alternative is shipping a 70 MB ffprobe binary in M1 purely to print one number, and
 * the milestone that actually needs ffprobe is M3. Two containers are understood, which
 * is exactly the set a Chromecast plays natively:
 *
 *  - **ISO-BMFF** (`.mp4`, `.m4v`, `.mov`) — walk top-level boxes to `moov`, then `mvhd`.
 *    The walk reads 16 bytes per box and *seeks over* the media data, so a 347 MB file
 *    with its `moov` at the very end (the founder's reference file: not web-optimised)
 *    costs a handful of positioned reads, not a 347 MB read.
 *  - **EBML** (`.webm`, `.mkv`) — Segment → Info → TimecodeScale + Duration.
 *
 * Anything else, or a header we cannot make sense of, yields `null`: the app shows the
 * file without a duration rather than refusing it or inventing one.
 *
 * ## Demoted at M3 (2026-08-19), not deleted
 *
 * The 2026-08-14 ADR said "revisit at M3: decide whether the JS probe stays as a fast path
 * or is deleted — do not let the two disagree about the same file". It is **not** a fast
 * path. ffprobe is the only reader in the product path; this one runs **only where there is
 * no ffprobe** — every WSL session and every engine unit test — and reports a duration and
 * nothing else. A file read here cannot be classified: `../prepare/classify.ts` takes a
 * `ProbeResult`, which carries `origin: 'ffprobe'` in its type and cannot be built from
 * these bytes. The choice between the two readers is made in exactly one place,
 * `./inspection.ts`, which never consults both about the same file.
 *
 * (The line that used to sit here — "the device's own `MEDIA_STATUS` is the authority once
 * playback starts" — was wrong, and SPIKE-1 proved it on hardware: the receiver reports
 * `duration: -1` for a prepared stream, forever. CastGood owns the clock.)
 */

export interface ProbedSource extends SourceFile {
  readonly name: string;
  /** `null` when the container does not tell us, which is not an error. */
  readonly durationSec: number | null;
}

/** A malformed header must never send us walking through gigabytes of boxes. */
const MAX_BOXES = 4_096;
const EBML_HEAD_BYTES = 4 * 1024 * 1024;

interface BoxHeader {
  readonly type: string;
  readonly contentStart: number;
  readonly boxEnd: number;
}

async function readAt(
  handle: fsp.FileHandle,
  offset: number,
  length: number,
): Promise<Buffer | null> {
  const buffer = Buffer.alloc(length);
  const { bytesRead } = await handle.read(buffer, 0, length, offset);
  return bytesRead === 0 ? null : buffer.subarray(0, bytesRead);
}

async function readBoxHeader(
  handle: fsp.FileHandle,
  offset: number,
  limit: number,
): Promise<BoxHeader | null> {
  if (offset + 8 > limit) return null;
  const head = await readAt(handle, offset, 16);
  if (head === null || head.length < 8) return null;

  let size = head.readUInt32BE(0);
  const type = head.subarray(4, 8).toString('latin1');
  let headerSize = 8;

  if (size === 1) {
    if (head.length < 16) return null;
    const large = head.readBigUInt64BE(8);
    if (large > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    size = Number(large);
    headerSize = 16;
  } else if (size === 0) {
    size = limit - offset; // "to end of file", per the spec
  }

  if (size < headerSize) return null;
  return { type, contentStart: offset + headerSize, boxEnd: Math.min(offset + size, limit) };
}

async function findBox(
  handle: fsp.FileHandle,
  start: number,
  end: number,
  type: string,
): Promise<BoxHeader | null> {
  let offset = start;
  for (let visited = 0; visited < MAX_BOXES && offset < end; visited += 1) {
    const header = await readBoxHeader(handle, offset, end);
    if (header === null) return null;
    if (header.type === type) return header;
    if (header.boxEnd <= offset) return null; // zero-length box: corrupt, stop.
    offset = header.boxEnd;
  }
  return null;
}

export async function readMp4Duration(
  handle: fsp.FileHandle,
  sizeBytes: number,
): Promise<number | null> {
  const moov = await findBox(handle, 0, sizeBytes, 'moov');
  if (moov === null) return null;
  const mvhd = await findBox(handle, moov.contentStart, moov.boxEnd, 'mvhd');
  if (mvhd === null) return null;

  const body = await readAt(handle, mvhd.contentStart, 32);
  if (body === null || body.length < 20) return null;

  const version = body.readUInt8(0);
  if (version === 1) {
    // 24 + 8: the 64-bit duration read below needs 32 bytes, not 28. A file truncated to
    // 28–31 bytes of movie header threw a RangeError instead of reporting "no duration".
    if (body.length < 32) return null;
    const timescale = body.readUInt32BE(20);
    const duration = Number(body.readBigUInt64BE(24));
    return timescale > 0 ? duration / timescale : null;
  }
  const timescale = body.readUInt32BE(12);
  const duration = body.readUInt32BE(16);
  // 0xFFFFFFFF is the spec's "unknown duration".
  if (timescale === 0 || duration === 0xffffffff) return null;
  return duration / timescale;
}

// --- EBML (WebM / Matroska) --------------------------------------------------

interface EbmlRead {
  readonly value: number;
  readonly next: number;
}

/** Element ids keep their length marker; sizes have theirs stripped. */
function readEbmlNumber(buffer: Buffer, offset: number, keepMarker: boolean): EbmlRead | null {
  if (offset >= buffer.length) return null;
  const first = buffer[offset] as number;
  if (first === 0) return null;
  let length = 1;
  while (length <= 8 && (first & (0x80 >> (length - 1))) === 0) length += 1;
  if (length > 8 || offset + length > buffer.length) return null;

  let value = keepMarker ? first : first & (0xff >> length);
  for (let i = 1; i < length; i += 1) {
    value = value * 256 + (buffer[offset + i] as number);
    if (!Number.isSafeInteger(value)) return null;
  }
  return { value, next: offset + length };
}

function findEbmlChild(
  buffer: Buffer,
  start: number,
  end: number,
  id: number,
): { start: number; end: number } | null {
  let offset = start;
  for (let visited = 0; visited < MAX_BOXES && offset < end; visited += 1) {
    const elementId = readEbmlNumber(buffer, offset, true);
    if (elementId === null) return null;
    const size = readEbmlNumber(buffer, elementId.next, false);
    if (size === null) return null;
    const contentStart = size.next;
    const contentEnd = Math.min(contentStart + size.value, end);
    if (elementId.value === id) return { start: contentStart, end: contentEnd };
    if (contentEnd <= offset) return null;
    offset = contentEnd;
  }
  return null;
}

export function readEbmlDuration(buffer: Buffer): number | null {
  const segment = findEbmlChild(buffer, 0, buffer.length, 0x18538067);
  if (segment === null) return null;
  const info = findEbmlChild(buffer, segment.start, segment.end, 0x1549a966);
  if (info === null) return null;

  const scale = findEbmlChild(buffer, info.start, info.end, 0x2ad7b1);
  let timecodeScale = 1_000_000; // EBML default: nanoseconds per tick
  if (scale !== null) {
    let value = 0;
    for (let i = scale.start; i < scale.end; i += 1) value = value * 256 + (buffer[i] as number);
    if (value > 0) timecodeScale = value;
  }

  const duration = findEbmlChild(buffer, info.start, info.end, 0x4489);
  if (duration === null) return null;
  const length = duration.end - duration.start;
  let ticks: number;
  if (length === 4) ticks = buffer.readFloatBE(duration.start);
  else if (length === 8) ticks = buffer.readDoubleBE(duration.start);
  else return null;

  if (!Number.isFinite(ticks) || ticks <= 0) return null;
  return (ticks * timecodeScale) / 1e9;
}

// --- The entry point ---------------------------------------------------------

/**
 * Who and how big — the facts about a file that need no parser at all.
 *
 * Split out so the ffprobe path can identify a file without the header reader ever being
 * asked about its duration. See `./inspection.ts` for why that matters.
 */
export async function identifySource(filePath: string): Promise<SourceFile & { name: string }> {
  const stat: Stats = await statSource(filePath);
  return {
    path: filePath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    name: path.basename(filePath),
  };
}

async function statSource(filePath: string): Promise<Stats> {
  let stat: Stats;
  try {
    stat = await fsp.stat(filePath);
  } catch (error) {
    throw new EngineError('SOURCE_MISSING', 'the selected file could not be read', {
      userMessage: 'That file is no longer where it was.',
      context: { filePath },
      cause: error,
    });
  }
  if (!stat.isFile()) {
    throw new EngineError('SOURCE_MISSING', 'the selected path is not a file', {
      userMessage: 'That is not a video file.',
      context: { filePath },
    });
  }
  return stat;
}

export async function probeSourceFile(filePath: string): Promise<ProbedSource> {
  const stat: Stats = await statSource(filePath);
  const base: SourceFile & { name: string } = {
    path: filePath,
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    name: path.basename(filePath),
  };

  const extension = path.extname(filePath).toLowerCase();
  let durationSec: number | null = null;
  let handle: fsp.FileHandle | null = null;
  try {
    handle = await fsp.open(filePath, 'r');
    if (extension === '.webm' || extension === '.mkv') {
      const head = await readAt(handle, 0, Math.min(EBML_HEAD_BYTES, stat.size));
      durationSec = head === null ? null : readEbmlDuration(head);
    } else {
      durationSec = await readMp4Duration(handle, stat.size);
    }
  } catch {
    // A duration we cannot read is a missing readout, never a failed file selection:
    // `durationSec` is still null, and the file stays selected.
  } finally {
    await handle?.close();
  }

  if (durationSec !== null && (!Number.isFinite(durationSec) || durationSec <= 0)) {
    durationSec = null;
  }
  return { ...base, durationSec };
}

/** `H:MM:SS`, the readout format the PRD names. */
export function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${String(hours)}:${pad(minutes)}:${pad(secs)}`;
}
