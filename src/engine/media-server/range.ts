/**
 * `Range` header parsing, kept separate from the server because it is a pure function
 * and therefore the cheapest thing in the project to test exhaustively.
 *
 * This is not a nicety. The founder's reference file was produced without "web
 * optimised", so its `moov` index sits at the *end* of 347 MB: the receiver's first act
 * is a range request near the tail, and it cannot show a single frame until that
 * answer arrives. Range handling is therefore on the critical path for the 5-second
 * cast target, not a seeking detail.
 *
 * Cases handled (RFC 9110 §14.1.1):
 *   bytes=0-499     first 500 bytes
 *   bytes=500-      open-ended, the common seek shape from a receiver
 *   bytes=-500      suffix, how the receiver finds a trailing `moov`
 *   bytes=0-0       single byte
 *   unsatisfiable   → 416 with `Content-Range: bytes * /<size>` (valid, but out of range)
 *   invalid         → ignored entirely: 200 and the whole file (RFC 9110 §14.1.1)
 *   multi-range     → answered as the first range only; receivers never ask for multi
 */

export interface ByteRange {
  /** Inclusive. */
  readonly start: number;
  /** Inclusive. */
  readonly end: number;
}

export type RangeParseResult =
  | { readonly kind: 'none' }
  | { readonly kind: 'satisfiable'; readonly range: ByteRange }
  | { readonly kind: 'unsatisfiable' };

const NONE: RangeParseResult = { kind: 'none' };
const UNSATISFIABLE: RangeParseResult = { kind: 'unsatisfiable' };

/** Digits only. `parseInt` would accept "12abc" and `Number("")` is 0; both are wrong here. */
function parseCount(text: string): number | null {
  if (!/^\d+$/.test(text)) return null;
  const value = Number(text);
  return Number.isSafeInteger(value) ? value : null;
}

export function parseRangeHeader(header: string | undefined, sizeBytes: number): RangeParseResult {
  if (header === undefined || header.trim() === '') return NONE;

  const match = /^bytes\s*=\s*(.+)$/i.exec(header.trim());
  if (match === null) return NONE; // A unit we do not speak: ignore it and send the whole file.

  const first = (match[1] as string).split(',')[0]?.trim() ?? '';
  const parts = /^(\d*)\s*-\s*(\d*)$/.exec(first);
  if (parts === null) return NONE;

  const startText = parts[1] as string;
  const endText = parts[2] as string;
  if (startText === '' && endText === '') return NONE;

  // A zero-length resource can satisfy nothing.
  if (sizeBytes <= 0) return UNSATISFIABLE;

  if (startText === '') {
    // Suffix range: the last N bytes. N larger than the file means the whole file.
    const suffix = parseCount(endText);
    if (suffix === null) return NONE;
    if (suffix === 0) return UNSATISFIABLE;
    const start = Math.max(0, sizeBytes - suffix);
    return { kind: 'satisfiable', range: { start, end: sizeBytes - 1 } };
  }

  const start = parseCount(startText);
  if (start === null) return NONE;
  if (start >= sizeBytes) return UNSATISFIABLE;

  if (endText === '') {
    return { kind: 'satisfiable', range: { start, end: sizeBytes - 1 } };
  }

  const end = parseCount(endText);
  if (end === null) return NONE;
  // RFC 9110 §14.1.1: a last-byte-pos below first-byte-pos makes the byte-range-spec
  // *invalid*, and an invalid Range header is ignored — the whole representation is sent.
  // 416 is reserved for a syntactically valid range that cannot be satisfied. Answering
  // 416 here aborts playback for a receiver that would have accepted the full body.
  if (end < start) return NONE;
  return { kind: 'satisfiable', range: { start, end: Math.min(end, sizeBytes - 1) } };
}

export function contentRangeHeader(range: ByteRange, sizeBytes: number): string {
  return `bytes ${range.start}-${range.end}/${sizeBytes}`;
}

export function unsatisfiableContentRangeHeader(sizeBytes: number): string {
  return `bytes */${sizeBytes}`;
}
