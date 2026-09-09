import { describe, expect, it } from 'vitest';
import {
  contentRangeHeader,
  parseRangeHeader,
  unsatisfiableContentRangeHeader,
} from '../../src/engine/media-server/range.js';

/**
 * Range parsing is on the critical path for the five-second cast target, not just for
 * seeking: the founder's reference file was not web-optimised, so its `moov` index sits
 * at the end and the receiver's *first* request is a suffix range. Getting `bytes=-N`
 * wrong looks exactly like a cast that never starts.
 */

const SIZE = 1_000;

describe('parseRangeHeader', () => {
  it('treats a missing or empty header as "send the whole thing"', () => {
    expect(parseRangeHeader(undefined, SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('   ', SIZE)).toEqual({ kind: 'none' });
  });

  it('parses a closed range', () => {
    expect(parseRangeHeader('bytes=0-499', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 499 },
    });
  });

  it('parses an open-ended range, the common seek shape', () => {
    expect(parseRangeHeader('bytes=500-', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 500, end: 999 },
    });
  });

  it('parses a suffix range — how a receiver finds a trailing moov', () => {
    expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 500, end: 999 },
    });
  });

  it('clamps a suffix larger than the file to the whole file', () => {
    expect(parseRangeHeader('bytes=-99999', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 999 },
    });
  });

  it('parses a single byte', () => {
    expect(parseRangeHeader('bytes=0-0', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 0 },
    });
  });

  it('clamps an end past the file to the last byte', () => {
    expect(parseRangeHeader('bytes=900-99999', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 900, end: 999 },
    });
  });

  it('tolerates whitespace and a capitalised unit', () => {
    expect(parseRangeHeader('Bytes = 10 - 20', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 10, end: 20 },
    });
  });

  it('answers a multi-range request with its first range only', () => {
    expect(parseRangeHeader('bytes=0-99,200-299', SIZE)).toEqual({
      kind: 'satisfiable',
      range: { start: 0, end: 99 },
    });
  });

  it('reports unsatisfiable rather than guessing', () => {
    expect(parseRangeHeader('bytes=1000-', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=5000-6000', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=-0', SIZE)).toEqual({ kind: 'unsatisfiable' });
    expect(parseRangeHeader('bytes=0-0', 0)).toEqual({ kind: 'unsatisfiable' });
  });

  it('ignores an invalid range-spec and sends the whole file (RFC 9110 §14.1.1)', () => {
    // Invalid, not unsatisfiable: a last-byte-pos below first-byte-pos means the header is
    // ignored entirely. Answering 416 aborted playback for a receiver that would have been
    // perfectly happy with the whole body.
    expect(parseRangeHeader('bytes=200-100', SIZE)).toEqual({ kind: 'none' });
  });

  it('ignores a unit or syntax it does not speak', () => {
    expect(parseRangeHeader('items=0-10', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=abc-def', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=12abc-', SIZE)).toEqual({ kind: 'none' });
    expect(parseRangeHeader('bytes=-', SIZE)).toEqual({ kind: 'none' });
  });

  it('formats the headers a 206 and a 416 need', () => {
    expect(contentRangeHeader({ start: 500, end: 999 }, SIZE)).toBe('bytes 500-999/1000');
    expect(unsatisfiableContentRangeHeader(SIZE)).toBe('bytes */1000');
  });
});
