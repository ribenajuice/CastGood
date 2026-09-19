import { describe, expect, it } from 'vitest';
import { buildViewModel } from '../../src/renderer/state/view-model.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/protocol/index.js';
import { dropIndex, moveItem, type Queue } from '../../src/engine/queue/model.js';

const IDLE_PICKER = { available: true, busy: false, error: null };

function withQueue(names: readonly string[], over: Partial<StateSnapshot['queue']> = {}) {
  const snapshot: StateSnapshot = {
    ...EMPTY_SNAPSHOT,
    queue: {
      items: names.map((name) => ({ id: `q:${name}`, name, verdict: null })),
      selectedId: null,
      playingId: null,
      ...over,
    },
  };
  return buildViewModel(snapshot, IDLE_PICKER).queue;
}

describe('24b — the rail is absent for a queue of one', () => {
  it('is hidden at zero and one, shown at two', () => {
    expect(withQueue([]).visible).toBe(false);
    expect(withQueue(['A.mkv']).visible, 'a single chosen film is the v1 product').toBe(false);
    expect(withQueue(['A.mkv', 'B.mkv']).visible).toBe(true);
  });
});

describe('24e — the playing row carries no Remove', () => {
  it('withholds it from the playing row and gives it to every other', () => {
    const rail = withQueue(['A.mkv', 'B.mkv'], { playingId: 'q:A.mkv' });
    expect(rail.rows[0]?.canRemove, 'the playing row must not offer Remove').toBe(false);
    expect(rail.rows[0]?.current).toBe(true);
    expect(rail.rows[1]?.canRemove).toBe(true);
  });
});

describe('24ab — selection is not playback', () => {
  it('marks the selected row without marking it current', () => {
    const rail = withQueue(['A.mkv', 'B.mkv'], { selectedId: 'q:B.mkv' });
    expect(rail.rows[1]?.selected).toBe(true);
    expect(rail.rows[1]?.current, 'selected is not playing').toBe(false);
  });
});

/**
 * The drop arithmetic, tested against the model it drives.
 *
 * ⚠️ **This is the piece most likely to be quietly wrong.** Dropping *below* row N means
 * index N+1 — but the dragged row is removed first, which shifts everything after it down
 * one. Off by one here reorders somebody's season into the wrong order in a way that looks
 * almost right, which is the worst kind of wrong.
 *
 * ⚠️ It is IMPORTED, not re-implemented here. The first version of this test copied the
 * arithmetic out of the component, which meant it could only ever agree with itself — the
 * same flaw as a test that lists the functions it just imported and checks those names.
 */
describe('dropping a row where the line was drawn', () => {
  const queue: Queue = {
    items: ['A', 'B', 'C', 'D'].map((n) => ({ id: n, path: n, name: n })),
    selectedId: null,
    playingId: null,
  };
  const after = (from: number, target: number, below: boolean): string[] =>
    moveItem(queue, queue.items[from]?.id ?? '', dropIndex(from, target, below)).items.map(
      (i) => i.name,
    );

  it('drops the first row below the last and it lands last', () => {
    expect(after(0, 3, true)).toEqual(['B', 'C', 'D', 'A']);
  });

  it('drops the last row above the first and it lands first', () => {
    expect(after(3, 0, false)).toEqual(['D', 'A', 'B', 'C']);
  });

  it('moves one place down — the case an off-by-one silently breaks', () => {
    // Drag A onto the bottom half of B. It should end up after B, not after C.
    expect(after(0, 1, true)).toEqual(['B', 'A', 'C', 'D']);
  });

  it('moves one place up', () => {
    expect(after(2, 1, false)).toEqual(['A', 'C', 'B', 'D']);
  });

  it('is a no-op when dropped back where it came from', () => {
    expect(dropIndex(1, 1, false)).toBe(1);
    expect(after(1, 0, true), 'dropping below the row above is where it already is').toEqual([
      'A',
      'B',
      'C',
      'D',
    ]);
  });
});
