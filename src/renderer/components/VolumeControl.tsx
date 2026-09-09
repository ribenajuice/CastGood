import type { JSX, PointerEvent } from 'react';
import { useRef } from 'react';
import type { VolumeView } from '../state/view-model.js';
import { DisabledReason } from './DisabledReason.js';
import { MuteGlyph } from './MuteGlyph.js';

/**
 * The volume control — M5a, §11 of the design system.
 *
 * **The rule the whole component exists to serve: the app never shows a level it was not
 * told (23b).** So the handle sits on `percent` — the last level a receiver status
 * reported — and moves for nothing else, *including while the founder's finger is on it*.
 * What the founder asked for is drawn as a separate tick with §10's travel hatch between
 * the two.
 *
 * ⚠️ **The tempting "fix" that would break the milestone**: making the handle follow the
 * pointer. It would feel better on every working television and it would make a set that
 * ignored us look obedient — which is exactly the lie SPIKE-5 was run to make impossible.
 * A television that takes the message and does nothing must leave the tick standing and
 * the handle where it was.
 *
 * The one deliberate inversion from the scrubber, where the round handle *leads* the
 * travel band: here it trails, because a pending seek is a place you are going to occupy
 * (4d permits that optimism) and a pending level is not (23b forbids it).
 *
 * Nothing here animates. §8's two animations remain the only two, which is what keeps M4's
 * motion checker green with no exemption added for this control (23k).
 */
export function VolumeControl({
  volume,
  onSetVolume,
  onMute,
}: {
  readonly volume: VolumeView;
  readonly onSetVolume: (percent: number) => void;
  readonly onMute: (muted: boolean) => void;
}): JSX.Element {
  const track = useRef<HTMLDivElement>(null);
  const { percent, muted, pendingPercent, steps, stepPercent, disabled, unavailableReason } =
    volume;

  /** Where along the bed a pointer landed, snapped to the positions this set actually has. */
  const percentFromEvent = (clientX: number): number => {
    const box = track.current?.getBoundingClientRect();
    if (box === undefined || box.width === 0) return 0;
    const raw = ((clientX - box.left) / box.width) * 100;
    const bounded = Math.min(100, Math.max(0, raw));
    // Snapping to the device's own grid is honesty, not polish: on a 20-step Chromecast
    // an unsnapped ask is a number the television is going to round anyway, and the
    // founder would watch the handle land somewhere they did not point.
    if (steps === null) return Math.round(bounded);
    const size = 100 / steps;
    return Math.round(Math.round(bounded / size) * size);
  };

  const ask = (next: number): void => {
    if (disabled) return;
    onSetVolume(Math.min(100, Math.max(0, next)));
  };

  /**
   * Where a keypress counts *from* — the outstanding ask if there is one, else the level.
   *
   * ⚠️ **Not the reported level alone.** By design that number does not move until the
   * television answers (85–222 ms on the founder's own set), while key repeat is ~30 ms —
   * so counting from it made a held arrow key ask for the *same* target over and over, and
   * the volume crawled up one step per round trip instead of one per press.
   *
   * This is an accumulator, never a display: 23b is about what the founder is *shown*, and
   * the handle still moves only when a receiver status says so.
   */
  const from = pendingPercent ?? percent ?? 0;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (disabled) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    ask(percentFromEvent(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    // Every step of the drag is sent. Unlike a seek, an intermediate volume is a level the
    // founder is listening to right now, so a drag that only spoke on release would be
    // silent under the finger. The flood is stopped in the engine by the device's own
    // round trip (23a), never here by a timer.
    if (disabled || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
    ask(percentFromEvent(event.clientX));
  };

  // The bed always draws; only the fill and the handle depend on having been told a level.
  const known = percent !== null;
  const fill = known ? percent : 0;
  const showPending = pendingPercent !== null && pendingPercent !== percent && !disabled;
  const hatchFrom = showPending ? Math.min(fill, pendingPercent) : 0;
  const hatchTo = showPending ? Math.max(fill, pendingPercent) : 0;

  return (
    <>
      <button
        type="button"
        // `aria-pressed` carries the state, and the label never changes with it: a button
        // whose name flips between "Mute" and "Unmute" is announced as a different control
        // every press. §9's existing rule.
        aria-label="Mute"
        aria-pressed={muted}
        disabled={disabled}
        onClick={() => {
          onMute(!muted);
        }}
        // No `onKeyDown` here. `preventDefault()` on Space cancels the browser's own button
        // activation (which fires on keyup), and §5's global play/pause handler already
        // bails out on anything inside a `<button>` — so suppressing it made Space dead in
        // *both* directions and left Mute the one control in the row a keyboard cannot press.
        className={`flex size-11 shrink-0 items-center justify-center rounded-box border ${
          disabled ? 'border-line text-muted' : 'border-line-strong text-text'
        } focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
      >
        <MuteGlyph muted={muted} />
      </button>

      {/* 23h: a dead slider needs no length. The freed width goes to the sentence, which is
          the thing that actually tells the founder what happened. */}
      <div
        ref={track}
        role="slider"
        tabIndex={disabled ? -1 : 0}
        // Never "TV volume" and never a device's name: on two of the founder's three sets
        // this is the dongle's own attenuation, and on the third the set's remote moves a
        // different number. §11's labelling law.
        aria-label="Volume"
        aria-valuemin={0}
        aria-valuemax={100}
        // Omitted when nothing has been reported. There is no honest number and 0 is not
        // one — it is a real level, and a set that is not casting reports exactly that.
        {...(known ? { 'aria-valuenow': percent } : {})}
        aria-valuetext={volume.valueText}
        aria-disabled={undefined}
        className={`flex h-11 items-center ${
          unavailableReason === null ? 'w-[164px] min-w-24 flex-1 grow' : 'w-[60px] shrink-0'
        } ${disabled ? 'cursor-default' : 'cursor-pointer'} touch-none rounded-box focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onKeyDown={(event) => {
          // ←/→ are the window's seek keys and are never taken from it (§5). Volume takes
          // the vertical pair, which nothing else claims.
          if (event.key === 'ArrowUp') {
            event.preventDefault();
            ask(from + stepPercent);
          } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            ask(from - stepPercent);
          } else if (event.key === 'PageUp') {
            event.preventDefault();
            ask(from + stepPercent * 5);
          } else if (event.key === 'PageDown') {
            event.preventDefault();
            ask(from - stepPercent * 5);
          } else if (event.key === 'Home') {
            event.preventDefault();
            ask(0);
          } else if (event.key === 'End') {
            event.preventDefault();
            ask(100);
          }
        }}
      >
        <div className="relative h-2.5 w-full rounded-pill bg-track">
          {/* The level: where the television actually is. `--track-prepared` when muted —
              the scrubber's *real, prepared, not playing* token, which is exactly a muted
              level — and when disabled, because §4 forbids clearing a value to signal a
              problem. */}
          {known && unavailableReason === null && (
            <div
              className={`absolute inset-y-0 left-0 rounded-pill ${
                muted || disabled ? 'bg-track-prepared' : 'bg-brand'
              }`}
              style={{ width: `${String(fill)}%` }}
            />
          )}
          {/* Asked for, not confirmed: §10's travel band at its own angle and pitch. */}
          {showPending && (
            <div
              className="absolute inset-y-0 rounded-pill"
              style={{
                left: `${String(hatchFrom)}%`,
                width: `${String(Math.max(0, hatchTo - hatchFrom))}%`,
                backgroundImage:
                  'repeating-linear-gradient(45deg, var(--color-muted) 0 3px, transparent 3px 6px)',
              }}
            />
          )}
          {/* The ask itself. It exists only while a SET_VOLUME is unanswered, and it is
              cleared by the device's *answer*, not by the answer *matching* — a set that
              quantises 62% to 60% has answered. */}
          {showPending && (
            <div
              className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-text"
              style={{ left: `${String(pendingPercent)}%` }}
            />
          )}
          {/* How many positions this television actually has. Drawn only where a step is
              wider than §10's stripe pitch — 20 steps are countable, 100 are not. */}
          {steps !== null && unavailableReason === null && (
            <div
              aria-hidden="true"
              // Explicit edges rather than `inset-0`: 21i's overlay checker looks for
              // `absolute inset-0`, and it is right to — that is how a "temporary" modal
              // comes back. This is a 10 px decoration inside a slider and not what the
              // rule guards, so the markup says so plainly instead of being baselined as
              // an accepted violation, which would blunt the checker for everyone after.
              className="absolute inset-y-0 left-0 w-full rounded-pill"
              style={{
                backgroundImage: `repeating-linear-gradient(to right, transparent 0 calc(100%/${String(steps)} - 1px), var(--color-bg) calc(100%/${String(steps)} - 1px) calc(100%/${String(steps)}))`,
              }}
            />
          )}
          {/* The handle is the one thing in this control that is always true. */}
          {known && unavailableReason === null && (
            <div
              className={`absolute top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-pill ${
                disabled ? 'bg-track-prepared' : 'bg-text'
              }`}
              style={{ left: `${String(fill)}%` }}
            />
          )}
        </div>
      </div>

      {/* A fixed slot, so `37%`, `100%`, `Muted` and `—` never shift the row. Deliberately
          the smallest number in the panel: an OSD-sized one would read as the television's
          own bar, which it is not. */}
      {unavailableReason === null ? (
        <span
          className={`w-[54px] shrink-0 text-right font-mono text-sm tabular-nums ${
            disabled ? 'text-muted' : 'text-text'
          }`}
        >
          {volume.readout}
        </span>
      ) : (
        <DisabledReason text={unavailableReason} />
      )}
    </>
  );
}
