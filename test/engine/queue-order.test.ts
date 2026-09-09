import { describe, expect, it } from 'vitest';
import { inNaturalOrder } from '../../src/engine/queue/order.js';

/**
 * Criterion 24z — several items added at once arrive in natural, numeric-aware order.
 *
 * ⚠️ **The failure this prevents is not cosmetic.** Plain filename order puts episode 10 in
 * front of episode 9, and a queue is the first feature where that shows: it is the evening
 * playing in the wrong sequence while somebody watches it happen.
 */

const sorted = (names: readonly string[]): string[] => inNaturalOrder(names, (n) => n);

describe('the three shapes the criterion names', () => {
  it('S01E09 before S01E10 — a number glued to letters', () => {
    expect(sorted(['S01E10.mkv', 'S01E09.mkv', 'S01E01.mkv'])).toEqual([
      'S01E01.mkv',
      'S01E09.mkv',
      'S01E10.mkv',
    ]);
  });

  it('Episode 9 before Episode 10 — a number after a word', () => {
    expect(sorted(['Episode 10.mp4', 'Episode 9.mp4', 'Episode 2.mp4'])).toEqual([
      'Episode 2.mp4',
      'Episode 9.mp4',
      'Episode 10.mp4',
    ]);
  });

  it('2 - Pilot before 10 - Finale — a number at the start', () => {
    expect(sorted(['10 - Finale.mkv', '2 - Pilot.mkv'])).toEqual([
      '2 - Pilot.mkv',
      '10 - Finale.mkv',
    ]);
  });
});

describe('the ways a naive comparison goes wrong', () => {
  it('is not plain alphabetical order, which is the whole point', () => {
    const names = ['S01E10.mkv', 'S01E09.mkv'];
    expect([...names].sort()).toEqual(['S01E09.mkv', 'S01E10.mkv']);
    // ...which is right by accident here. The one that actually breaks:
    const harder = ['Episode 10.mp4', 'Episode 9.mp4'];
    expect([...harder].sort(), 'plain sort puts 10 first').toEqual([
      'Episode 10.mp4',
      'Episode 9.mp4',
    ]);
    expect(sorted(harder), 'natural order must not').toEqual(['Episode 9.mp4', 'Episode 10.mp4']);
  });

  it('treats 0009 and 9 as the same number, so zero padding cannot reorder a season', () => {
    // Two rippers, one season. Padding is a fact about the tool, not about the episode.
    //
    // ⚠️ It does NOT compare equal, deliberately: a total order needs a tiebreak, or the
    // result depends on which file the OS happened to list first. What must hold is that
    // padding cannot REORDER a season, which is the assertion that matters.
    expect(sorted(['S1E10', 'S01E09'])).toEqual(['S01E09', 'S1E10']);
    expect(sorted(['S01E10', 'S1E9'])).toEqual(['S1E9', 'S01E10']);
  });

  it('ignores case, because a season is rarely capitalised consistently', () => {
    expect(sorted(['episode 2.mkv', 'Episode 1.mkv'])).toEqual(['Episode 1.mkv', 'episode 2.mkv']);
  });

  it('puts a prefix before the longer name that contains it', () => {
    expect(sorted(['Episode 9 - Extended.mkv', 'Episode 9.mkv'])).toEqual([
      'Episode 9.mkv',
      'Episode 9 - Extended.mkv',
    ]);
  });

  it('handles a full season without interleaving 1 and 10', () => {
    const season = Array.from(
      { length: 24 },
      (_, i) => `Show S02E${String(i + 1).padStart(2, '0')}.mkv`,
    );
    const shuffled = [...season].reverse();
    expect(sorted(shuffled)).toEqual(season);
  });

  it('is stable and total — equal-folding names still order deterministically', () => {
    const out = sorted(['A.mkv', 'a.mkv']);
    expect(out).toHaveLength(2);
    expect(sorted([...out].reverse()), 'the order must not depend on input order').toEqual(out);
  });
});

describe('ordering by a projected name', () => {
  it('sorts objects by whatever name they are asked about', () => {
    const items = [{ file: 'Episode 10.mp4' }, { file: 'Episode 2.mp4' }];
    expect(inNaturalOrder(items, (i) => i.file).map((i) => i.file)).toEqual([
      'Episode 2.mp4',
      'Episode 10.mp4',
    ]);
  });

  it('does not mutate what it was given', () => {
    const items = ['Episode 10.mp4', 'Episode 2.mp4'];
    inNaturalOrder(items, (n) => n);
    expect(items[0], 'the picker’s array is not ours to reorder').toBe('Episode 10.mp4');
  });
});
