import { inNaturalOrder } from './order.js';

/**
 * The queue, as a pure value — M5b step 1, criteria 24a–24e, 24r, 24z and 24ab.
 *
 * ⚠️ **Nothing here reaches a television.** Adding, reordering, removing and selecting are
 * all list arithmetic. 24c says reordering sends nothing on the wire and 24ab says clicking
 * a row sends nothing either — **the cheapest way to keep both is for this file to have no
 * way to send anything at all.** A queue that could dispatch would need a rule against it;
 * a queue that is a value needs none.
 *
 * ⚠️ **Nothing here is written to disk (24r).** There is no serialiser and no `toJSON`, on
 * purpose: the queue dies with the app, and a reopened app reattaches to the film and treats
 * it as a queue of one.
 */

export interface QueueItem {
  readonly id: string;
  /** Absolute path, as chosen. The queue never rewrites it. */
  readonly path: string;
  /** File name, which is what 24z orders by and what a row shows. */
  readonly name: string;
}

export interface Queue {
  readonly items: readonly QueueItem[];
  /**
   * The row the founder last clicked — 24ab. **Selection is not playback.** A selected row
   * is a row that a press would start; it is not a row that is starting.
   */
  readonly selectedId: string | null;
  /** The item on a television, if any. `null` whenever nothing is playing. */
  readonly playingId: string | null;
}

export const EMPTY_QUEUE: Queue = { items: [], selectedId: null, playingId: null };

/**
 * ⚠️ **24b's invariant, as a function rather than as a hope.**
 *
 * *"A queue that is empty or holds one film behaves byte-for-byte as it did before M5b
 * existed."* Every caller that is about to do something queue-shaped asks this first, and
 * the v1 path is the one that runs when it answers false. That is why it is here, at the
 * top of the model, rather than being re-derived at each call site — three copies of
 * `items.length > 1` is three places for the invariant to rot.
 */
export function isQueueOfOne(queue: Queue): boolean {
  return queue.items.length <= 1;
}

/**
 * Add files, in natural order (24z), as one action.
 *
 * ⚠️ **Sorted as a batch, appended as a block.** Films added later do not re-sort the ones
 * already queued: a founder who added episodes 1–5 and then remembered episode 6 gets it at
 * the end, not silently interleaved into an order they had already arranged by hand. 24c
 * gives them reordering for that, and it is theirs to do.
 */
export function addFiles(
  queue: Queue,
  files: readonly { readonly path: string; readonly name: string }[],
  idFor: (path: string, index: number) => string,
): Queue {
  const ordered = inNaturalOrder(files, (file) => file.name);
  const existing = new Set(queue.items.map((item) => item.path));
  const added: QueueItem[] = [];
  ordered.forEach((file, index) => {
    // The same film twice in one evening is a thing people do — a re-watch, or a second
    // half. But the same PATH twice in one add is the picker returning a duplicate, and
    // queueing it twice is never what was meant.
    if (existing.has(file.path)) return;
    existing.add(file.path);
    added.push({
      id: idFor(file.path, queue.items.length + index),
      path: file.path,
      name: file.name,
    });
  });
  return { ...queue, items: [...queue.items, ...added] };
}

/** Move an item to a new index. Out-of-range targets clamp rather than throwing. */
export function moveItem(queue: Queue, id: string, toIndex: number): Queue {
  const from = queue.items.findIndex((item) => item.id === id);
  if (from < 0) return queue;
  const items = [...queue.items];
  const [moved] = items.splice(from, 1);
  if (moved === undefined) return queue;
  items.splice(Math.max(0, Math.min(toIndex, items.length)), 0, moved);
  return { ...queue, items };
}

/**
 * Remove a row — 24d, in one press and with no confirmation.
 *
 * ⚠️ **The playing item carries no Remove (24e)**, so this refuses it rather than trusting
 * every future caller to check first. The way past a film is Stop then *Skip to \<next\>*,
 * which is machinery M2 already built.
 *
 * **Nothing on disk is touched.** A preparation that already finished stays beside its
 * source — there is no cleanup policy (2026-08-19), and removing a row destroys nothing.
 */
export function removeItem(queue: Queue, id: string): Queue {
  if (queue.playingId === id) return queue;
  const items = queue.items.filter((item) => item.id !== id);
  if (items.length === queue.items.length) return queue;
  return {
    ...queue,
    items,
    // A selection that was removed is no selection. Leaving a dangling id would let a later
    // press start a row that is no longer there.
    selectedId: queue.selectedId === id ? null : queue.selectedId,
  };
}

/**
 * Click a row — 24ab. **Selects, and nothing else.**
 *
 * There is deliberately no variant of this that starts anything. Starting is a separate
 * press from the *Stopped* screen, and keeping the two apart in the model is what makes
 * *"nothing reaches the television"* true by construction rather than by care.
 */
export function selectItem(queue: Queue, id: string): Queue {
  if (!queue.items.some((item) => item.id === id)) return queue;
  return { ...queue, selectedId: id };
}

/** The item a press on *Stopped* would start: the selection, else the first row. */
export function itemToStart(queue: Queue): QueueItem | null {
  const selected = queue.items.find((item) => item.id === queue.selectedId);
  return selected ?? queue.items[0] ?? null;
}

/** The row after the one playing — what *Skip to \<next\>* names, and what autoplay takes. */
export function nextAfterPlaying(queue: Queue): QueueItem | null {
  const at = queue.items.findIndex((item) => item.id === queue.playingId);
  return at < 0 ? null : (queue.items[at + 1] ?? null);
}

/**
 * Where a row dropped on a target actually lands.
 *
 * ⚠️ **The subtraction is the whole function, and it is the easiest thing here to get
 * quietly wrong.** Dropping *below* row N means index N+1 — but the dragged row is removed
 * before it is re-inserted, which shifts everything after it down one. Without the
 * correction a one-place move down silently becomes a two-place move, which looks almost
 * right and reorders somebody's season.
 *
 * It lives here rather than in the component so the test and the rail use the same
 * arithmetic. A test that re-implements it asserts the author's memory twice over.
 */
export function dropIndex(from: number, targetIndex: number, below: boolean): number {
  const raw = targetIndex + (below ? 1 : 0);
  return raw > from ? raw - 1 : raw;
}
