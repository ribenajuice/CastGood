import { useCallback, useEffect, useRef, useState, type JSX, type PointerEvent } from 'react';
import { scrubberReadout } from '../state/view-model.js';

/**
 * The scrubber: a real `slider` once the engine says the session can be seeked into.
 *
 * **Nothing is sent while the finger is down** (PRD 6b). The handle follows the pointer
 * out of local drag state, and exactly one `onSeek` fires on release. That is the whole
 * reason this component holds state at all — it is the only place in the renderer that
 * does, and it holds a *gesture*, never a fact about the television.
 *
 * When `canDrag` is false it degrades to the M1 `progressbar`: no handle, no pointer
 * cursor, nothing that invites a drag the app cannot honour. A control that looks
 * pressable and does nothing is worse than one that plainly is not.
 *
 * **M3b (10d).** While a conversion is still running, part of the film does not exist yet.
 * That part is drawn hatched and inert, a hairline marks the furthest a jump may land, and
 * **the handle clamps there** — dragging into the hatching stops feeling like a rejected
 * instruction and starts feeling like the end of what exists, which is the truth. The
 * *value* that goes out on release is still the founder's own, unclamped: the engine is
 * the one authority on where a seek may land, it refuses anything past the limit and
 * reports the refusal, and that report is what puts the explanation under the track. Two
 * places clamping to two numbers is how a scrubber and a device end up disagreeing.
 *
 * **Everything this component decides, it decides in `scrubberReadout`** — a pure function
 * in the view model, because the suite runs headless with no DOM and arithmetic hidden in
 * a component is arithmetic nothing can test. What is left here is markup and the gesture.
 */

/**
 * Track, prepared fill, hatching and tick — shared by the slider and the progress bar so
 * the two cannot drift apart. Purely decorative: every label lives on the parent.
 */
function Track({
  playedPercent,
  frontierPercent,
  limitPercent,
  handle,
}: {
  readonly playedPercent: number;
  readonly frontierPercent: number | null;
  readonly limitPercent: number | null;
  readonly handle: boolean;
}): JSX.Element {
  return (
    <div className="relative h-2.5 w-full rounded-pill bg-track">
      {/* Prepared, and not yet prepared — the same boundary drawn from both sides.
          §10 gives them three independent cues, none of which is hue: the prepared side
          is *solid* `--track-prepared`, the unconverted side is a **135° hatch** of the
          same token at 4 px / 4 px, and the join is always marked by the limit tick
          below. The 45° travel band is the opposite diagonal for exactly this reason —
          during a forward skip inside a conversion the two are on screen six pixels
          apart, so they must never share an angle. */}
      {frontierPercent !== null && (
        <>
          <div
            aria-hidden
            className="absolute inset-y-0 left-0 rounded-l-pill bg-track-prepared"
            style={{ width: `${String(frontierPercent)}%` }}
          />
          <div
            aria-hidden
            className="absolute inset-y-0 right-0 cursor-not-allowed rounded-r-pill"
            style={{
              left: `${String(frontierPercent)}%`,
              backgroundImage:
                'repeating-linear-gradient(135deg, var(--track-prepared) 0 4px, transparent 4px 8px)',
            }}
          />
        </>
      )}
      <div
        className="absolute inset-y-0 left-0 rounded-l-pill bg-brand"
        style={{ width: `${String(playedPercent)}%` }}
      />
      {/* The limit tick. It visibly travels to the right as the conversion runs, and that
          single fact is what turns the limit from a bug into a mechanism. */}
      {limitPercent !== null && (
        <div
          aria-hidden
          className="absolute -top-1.5 -bottom-1.5 w-0.5 bg-text"
          style={{ left: `${String(limitPercent)}%` }}
        />
      )}
      {handle && (
        <div
          aria-hidden
          className="absolute top-1/2 size-[18px] -translate-x-1/2 -translate-y-1/2 rounded-pill bg-text"
          style={{ left: `${String(playedPercent)}%` }}
        />
      )}
    </div>
  );
}

export function Scrubber({
  positionSec,
  durationSec,
  positionLabel,
  durationLabel,
  percent,
  canDrag,
  frontierPercent = null,
  limitPercent = null,
  seekLimitSec = null,
  onSeek,
  onSkip,
}: {
  readonly positionSec: number;
  readonly durationSec: number;
  readonly positionLabel: string;
  readonly durationLabel: string;
  readonly percent: number;
  readonly canDrag: boolean;
  /** 10d: how much of the film exists. `null` when all of it does. */
  readonly frontierPercent?: number | null;
  /** 10d: the furthest a jump may land, as a percentage of the true duration. */
  readonly limitPercent?: number | null;
  /** The same limit in seconds, for the readout a screen reader gets. */
  readonly seekLimitSec?: number | null;
  readonly onSeek: (positionSec: number) => void;
  /** The ±30 s arrow keys. A *skip*, not a drag — see the keydown handler. */
  readonly onSkip: (deltaSec: number) => void;
}): JSX.Element {
  const track = useRef<HTMLDivElement | null>(null);
  const [dragPercent, setDragPercent] = useState<number | null>(null);

  const positionFromEvent = useCallback((clientX: number): number => {
    const element = track.current;
    if (element === null) return 0;
    const box = element.getBoundingClientRect();
    if (box.width <= 0) return 0;
    return Math.min(100, Math.max(0, ((clientX - box.left) / box.width) * 100));
  }, []);

  // A drag that ends outside the window still has to end. Without this, releasing the
  // button off-screen left the handle stuck to the pointer and the seek never fired.
  useEffect(() => {
    if (dragPercent === null) return;
    const cancel = (): void => {
      setDragPercent(null);
    };
    window.addEventListener('blur', cancel);
    return () => {
      window.removeEventListener('blur', cancel);
    };
  }, [dragPercent]);

  const readout = scrubberReadout({
    percent,
    dragPercent,
    durationSec,
    positionLabel,
    durationLabel,
    limitPercent,
    seekLimitSec,
  });

  if (!canDrag) {
    return (
      <div
        role="progressbar"
        aria-label="Playback position"
        aria-valuemin={0}
        aria-valuemax={Math.round(durationSec)}
        aria-valuenow={Math.round(positionSec)}
        aria-valuetext={readout.valueText}
        className="flex h-11 items-center rounded-box focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      >
        <Track
          playedPercent={percent}
          frontierPercent={frontierPercent}
          limitPercent={limitPercent}
          handle={false}
        />
      </div>
    );
  }

  // The handle stops at the limit however far the pointer goes. The *raw* gesture is what
  // is kept in state, so the release still tells the engine where the founder actually
  // pointed and the engine still gets to refuse it in one place.
  const shown = readout.handlePercent;

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragPercent(positionFromEvent(event.clientX));
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragPercent === null) return;
    setDragPercent(positionFromEvent(event.clientX));
  };
  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    if (dragPercent === null) return;
    const released = positionFromEvent(event.clientX);
    setDragPercent(null);
    // The one message this gesture sends, and only on release.
    onSeek((released / 100) * durationSec);
  };

  return (
    <div
      ref={track}
      role="slider"
      tabIndex={0}
      aria-label="Playback position"
      aria-valuemin={0}
      aria-valuemax={Math.round(durationSec)}
      aria-valuenow={Math.round(readout.handleSec)}
      // Mid-drag this reads out the **destination**, not where the film still is — the
      // same promise the visible readout makes once the drag is released, kept for anyone
      // listening to the window rather than looking at it.
      aria-valuetext={readout.valueText}
      className="flex h-11 cursor-pointer touch-none items-center rounded-box focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={() => {
        setDragPercent(null);
      }}
      onKeyDown={(event) => {
        // The design system's ±30 s arrow keys are the **skip buttons under another name**,
        // so they take the skip path — which is what gives a held arrow key its running
        // `+2:00` total and keeps the status line off *Seeking…* (6h). Routing them through
        // the drag path coalesced correctly and then told the founder the wrong story.
        if (event.key === 'ArrowLeft') {
          event.preventDefault();
          onSkip(-30);
        } else if (event.key === 'ArrowRight') {
          event.preventDefault();
          onSkip(30);
        } else if (event.key === 'Home') {
          // Home is a destination, not a distance: a drag to the very beginning.
          event.preventDefault();
          onSeek(0);
        }
      }}
    >
      <Track
        playedPercent={shown}
        frontierPercent={frontierPercent}
        limitPercent={limitPercent}
        handle
      />
    </div>
  );
}
