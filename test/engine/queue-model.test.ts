import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  addFiles,
  EMPTY_QUEUE,
  isQueueOfOne,
  itemToStart,
  moveItem,
  nextAfterPlaying,
  removeItem,
  selectItem,
  type Queue,
} from '../../src/engine/queue/model.js';

/** Deterministic ids, so a test never depends on how they are minted. */
const idFor = (path: string): string => `id:${path}`;
const file = (name: string) => ({ path: `D:\\Season\\${name}`, name });

function queueOf(...names: string[]): Queue {
  return addFiles(EMPTY_QUEUE, names.map(file), idFor);
}

describe('adding films (24a, 24z)', () => {
  it('arrives in natural order however the picker handed them over', () => {
    const q = queueOf('Episode 10.mkv', 'Episode 2.mkv', 'Episode 1.mkv');
    expect(q.items.map((i) => i.name)).toEqual([
      'Episode 1.mkv',
      'Episode 2.mkv',
      'Episode 10.mkv',
    ]);
  });

  it('appends a later batch as a block rather than re-sorting what was arranged', () => {
    // ⚠️ Somebody who queued 1–3 and then remembered 6 gets it at the end. Silently
    // interleaving would undo an order they may have set by hand with 24c.
    const first = queueOf('Episode 3.mkv', 'Episode 1.mkv');
    const both = addFiles(first, [file('Episode 2.mkv')], idFor);
    expect(both.items.map((i) => i.name)).toEqual([
      'Episode 1.mkv',
      'Episode 3.mkv',
      'Episode 2.mkv',
    ]);
  });

  it('ignores a path already queued, because that is the picker repeating itself', () => {
    const q = addFiles(queueOf('A.mkv'), [file('A.mkv')], idFor);
    expect(q.items).toHaveLength(1);
  });
});

describe('24b — a queue of one is the v1 product untouched', () => {
  it('is true when empty and when holding one film, false at two', () => {
    expect(isQueueOfOne(EMPTY_QUEUE)).toBe(true);
    expect(isQueueOfOne(queueOf('A.mkv'))).toBe(true);
    expect(isQueueOfOne(queueOf('A.mkv', 'B.mkv'))).toBe(false);
  });
});

describe('reordering (24c) and removing (24d, 24e)', () => {
  it('moves a row without touching anything else about the queue', () => {
    const q = queueOf('A.mkv', 'B.mkv', 'C.mkv');
    const moved = moveItem(q, idFor('D:\\Season\\C.mkv'), 0);
    expect(moved.items.map((i) => i.name)).toEqual(['C.mkv', 'A.mkv', 'B.mkv']);
    expect(moved.playingId).toBe(q.playingId);
    expect(moved.selectedId).toBe(q.selectedId);
  });

  it('clamps an out-of-range move rather than throwing at the founder', () => {
    const q = queueOf('A.mkv', 'B.mkv');
    expect(moveItem(q, idFor('D:\\Season\\A.mkv'), 99).items.map((i) => i.name)).toEqual([
      'B.mkv',
      'A.mkv',
    ]);
  });

  it('removes in one press', () => {
    const q = queueOf('A.mkv', 'B.mkv');
    expect(removeItem(q, idFor('D:\\Season\\A.mkv')).items.map((i) => i.name)).toEqual(['B.mkv']);
  });

  it('refuses to remove the playing item — 24e, rather than trusting every caller', () => {
    const q = { ...queueOf('A.mkv', 'B.mkv'), playingId: idFor('D:\\Season\\A.mkv') };
    expect(removeItem(q, idFor('D:\\Season\\A.mkv')).items).toHaveLength(2);
  });

  it('clears a selection that was removed, so no press can start a row that is gone', () => {
    const q = selectItem(queueOf('A.mkv', 'B.mkv'), idFor('D:\\Season\\A.mkv'));
    expect(removeItem(q, idFor('D:\\Season\\A.mkv')).selectedId).toBeNull();
  });
});

describe('clicking a row selects it and does nothing else (24ab)', () => {
  it('changes only the selection', () => {
    const q = queueOf('A.mkv', 'B.mkv');
    const clicked = selectItem(q, idFor('D:\\Season\\B.mkv'));
    expect(clicked.selectedId).toBe(idFor('D:\\Season\\B.mkv'));
    // ⚠️ The whole criterion: nothing about what is playing may change.
    expect(clicked.playingId).toBe(q.playingId);
    expect(clicked.items).toEqual(q.items);
  });

  it('ignores a click on a row that is not there', () => {
    const q = queueOf('A.mkv');
    expect(selectItem(q, 'id:nonsense').selectedId).toBeNull();
  });

  it('cannot reach a television at all — 24c and 24ab hold by construction', async () => {
    // ⚠️ Two earlier versions of this test were wrong, and the second is the instructive one.
    //
    // The first listed the functions it had just imported and checked THOSE names, which
    // could only ever pass — a `startItem` added tomorrow would not be in the list. It
    // asserted the author's memory rather than the module.
    //
    // The second read the real exports and matched names against /start|play|…/, and
    // immediately flagged `itemToStart` and `nextAfterPlaying`. Those are QUERIES: they say
    // what a press WOULD start. Name-matching was measuring the wrong property.
    //
    // The property that actually makes 24c and 24ab true is structural: this module has no
    // access to anything that can send. Reordering cannot reach the wire because there is no
    // wire in scope, not because every caller remembered.
    const source = await readFile(
      path.join(fileURLToPath(new URL('../..', import.meta.url)), 'src/engine/queue/model.ts'),
      'utf8',
    );
    const imports = [...source.matchAll(/^import .*? from '([^']+)';/gm)].map((m) => m[1]);
    expect(imports, 'the queue model may import nothing that can send').toEqual(['./order.js']);
  });
});

describe('what a press would start, and what comes next', () => {
  it('starts the selection, or the first row when nothing is selected', () => {
    const q = queueOf('A.mkv', 'B.mkv');
    expect(itemToStart(q)?.name).toBe('A.mkv');
    expect(itemToStart(selectItem(q, idFor('D:\\Season\\B.mkv')))?.name).toBe('B.mkv');
    expect(itemToStart(EMPTY_QUEUE)).toBeNull();
  });

  it('names the row after the playing one, and nothing at the end', () => {
    const q = { ...queueOf('A.mkv', 'B.mkv'), playingId: idFor('D:\\Season\\A.mkv') };
    expect(nextAfterPlaying(q)?.name).toBe('B.mkv');
    expect(nextAfterPlaying({ ...q, playingId: idFor('D:\\Season\\B.mkv') })).toBeNull();
  });
});
