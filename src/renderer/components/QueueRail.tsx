import { useState, type DragEvent, type JSX, type KeyboardEvent } from 'react';
import { dropIndex } from '../../engine/queue/model.js';
import type { QueueRailView, QueueRowView } from '../state/view-model.js';
import { Button } from './Button.js';

/**
 * The queue — M5b step 1, §12.
 *
 * ⚠️ **Reorder is the whole row and there is no drag handle**, per §12: a handle costs 44 px
 * of a 340 px rail to duplicate a target the row already is. The keyboard's path is
 * `Alt` + `↑`/`↓`, which does the same move and keeps focus on the row it moved.
 *
 * ⚠️ **Nothing here reaches a television.** Dragging, dropping, arrowing and clicking all
 * emit queue intents, and the queue is a value with no way to send (24c, 24ab). The one
 * thing a row must never do is start a film by being touched.
 *
 * **The list is not a `listbox`** and that is deliberate (§12): a `role="option"` may not
 * contain a button, and every row carries Remove. Rows are toggle buttons with
 * `aria-pressed` and `aria-current`, one tab stop, roving `tabindex`.
 */

/** Where a dragged row would land, drawn as a line rather than by moving anything. */
interface DropTarget {
  readonly index: number;
  readonly below: boolean;
}

function QueueRow({
  row,
  index,
  focused,
  dropTarget,
  onSelect,
  onRemove,
  onMove,
  onDragStart,
  onDragOver,
  onDrop,
  onFocus,
}: {
  readonly row: QueueRowView;
  readonly index: number;
  readonly focused: boolean;
  readonly dropTarget: DropTarget | null;
  readonly onSelect: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onMove: (id: string, toIndex: number) => void;
  readonly onDragStart: (index: number) => void;
  readonly onDragOver: (target: DropTarget) => void;
  readonly onDrop: () => void;
  readonly onFocus: (index: number) => void;
}): JSX.Element {
  const showLineAbove = dropTarget?.index === index && !dropTarget.below;
  const showLineBelow = dropTarget?.index === index && dropTarget.below;

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    // §12's keyboard reorder. Alt is what separates *moving the row* from *moving focus*,
    // and the plain arrows are handled by the rail so focus stays one tab stop.
    if (event.altKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      onMove(row.id, index + (event.key === 'ArrowUp' ? -1 : 1));
      return;
    }
    if ((event.key === 'Delete' || event.key === 'Backspace') && row.canRemove) {
      event.preventDefault();
      onRemove(row.id);
    }
  };

  return (
    <div
      className="relative"
      // The drop line is drawn on the row, not by moving rows around under the pointer —
      // a list that rearranges itself while you are aiming at it is a list you cannot aim at.
      onDragOver={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        const box = event.currentTarget.getBoundingClientRect();
        onDragOver({ index, below: event.clientY > box.top + box.height / 2 });
      }}
      onDrop={(event: DragEvent<HTMLDivElement>) => {
        event.preventDefault();
        onDrop();
      }}
    >
      {showLineAbove && (
        <div aria-hidden="true" className="absolute -top-1 h-0.5 w-full bg-accent" />
      )}
      {/* ⚠️ The row and its Remove sit SIDE BY SIDE, never stacked.
          
          The first version positioned Remove absolutely over the row, and on a scene-release
          name — which wraps, because §12 forbids truncating it — the button landed on top of
          the text and covered part of the filename. §12's own width arithmetic says what
          this should have been all along: 199 px of text, 54 px of gap, 44 px of button.
          The space is budgeted, so it must be reserved rather than borrowed. */}
      <div className="flex items-start gap-2.5">
        <button
          type="button"
          draggable
          onDragStart={() => {
            onDragStart(index);
          }}
          aria-pressed={row.selected}
          {...(row.current ? { 'aria-current': 'true' as const } : {})}
          tabIndex={focused ? 0 : -1}
          onFocus={() => {
            onFocus(index);
          }}
          onKeyDown={onKeyDown}
          onClick={() => {
            // 24ab: selects. Never loads, stops, pauses or replaces what is on screen.
            onSelect(row.id);
          }}
          className={`flex min-h-11 min-w-0 flex-1 items-start gap-2.5 rounded-box bg-surface text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
            row.selected
              ? 'border-2 border-accent px-2.5 py-[9px]'
              : 'border border-line-strong px-[11px] py-2.5'
          }`}
        >
          <span
            aria-hidden="true"
            className={`mt-1 size-4 shrink-0 rounded-pill border ${
              row.selected ? 'border-accent bg-accent' : 'border-line-strong'
            }`}
          />
          <span className="min-w-0 flex-1">
            {/* §12: the name wraps and is never truncated. A scene-release name costs rows on
              screen; an ellipsis costs the ability to tell two episodes apart. */}
            <span className="block text-base font-semibold break-words">{row.name}</span>
            <span className={`mt-0.5 block text-sm ${row.current ? 'text-text' : 'text-muted'}`}>
              {row.current ? 'Playing' : (row.verdict ?? 'Queued')}
            </span>
          </span>
        </button>
        {/* 24e: the playing row carries no Remove at all — not a disabled one. A row without
          one keeps the full width for its name rather than leaving a hole where a control
          would be. */}
        {row.canRemove && (
          <span className="shrink-0">
            <Button
              small
              square
              ariaLabel={`Remove ${row.name}`}
              onClick={() => {
                // 24d: one press, no confirmation. Nothing on disk is touched.
                onRemove(row.id);
              }}
            >
              ×
            </Button>
          </span>
        )}
      </div>
      {showLineBelow && (
        <div aria-hidden="true" className="absolute -bottom-1 h-0.5 w-full bg-accent" />
      )}
    </div>
  );
}

export function QueueRail({
  queue,
  onSelect,
  onRemove,
  onMove,
}: {
  readonly queue: QueueRailView;
  readonly onSelect: (id: string) => void;
  readonly onRemove: (id: string) => void;
  readonly onMove: (id: string, toIndex: number) => void;
}): JSX.Element | null {
  const [dragFrom, setDragFrom] = useState<number | null>(null);
  const [dropTarget, setDropTarget] = useState<DropTarget | null>(null);
  const [focusedIndex, setFocusedIndex] = useState(0);

  // 24b: below two items there is no rail at all, and the app is the v1 product.
  if (!queue.visible) return null;

  const commitDrop = (): void => {
    const target = dropTarget;
    const from = dragFrom;
    setDragFrom(null);
    setDropTarget(null);
    if (from === null || target === null) return;
    const row = queue.rows[from];
    if (row === undefined) return;
    const to = dropIndex(from, target.index, target.below);
    if (to !== from) onMove(row.id, to);
  };

  return (
    <aside
      data-queue=""
      aria-label="Queue"
      className="flex w-[340px] shrink-0 flex-col gap-2.5 border-l border-line p-4"
      onDragEnd={() => {
        setDragFrom(null);
        setDropTarget(null);
      }}
    >
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-[0.09em] text-muted uppercase">Queue</h2>
        <span className="text-sm text-muted">{queue.label}</span>
      </div>
      <div
        role="group"
        aria-label="Queued films"
        // §12: one tab stop, roving tabindex, and plain arrows move focus rather than rows.
        onKeyDown={(event: KeyboardEvent<HTMLDivElement>) => {
          if (event.altKey) return;
          if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
          event.preventDefault();
          const next = focusedIndex + (event.key === 'ArrowUp' ? -1 : 1);
          // §12: clamped at the ends and never wrapping — the scrubber clamps too.
          setFocusedIndex(Math.max(0, Math.min(next, queue.rows.length - 1)));
        }}
        className="flex flex-col gap-2 overflow-y-auto [scrollbar-gutter:stable]"
      >
        {queue.rows.map((row, index) => (
          <QueueRow
            key={row.id}
            row={row}
            index={index}
            focused={index === focusedIndex}
            dropTarget={dragFrom === null ? null : dropTarget}
            onSelect={onSelect}
            onRemove={onRemove}
            onMove={onMove}
            onDragStart={setDragFrom}
            onDragOver={setDropTarget}
            onDrop={commitDrop}
            onFocus={setFocusedIndex}
          />
        ))}
      </div>
    </aside>
  );
}
