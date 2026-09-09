import { useState, type JSX } from 'react';
import type { SubtitlesView } from '../state/view-model.js';
import { Button } from './Button.js';
import { PulseDot } from './Hairline.js';
import { DisabledReason } from './DisabledReason.js';

/**
 * The subtitle control — 18a, 18b, 18c, 18k, 19a's ruling, and story 20's timing nudge.
 *
 * **It reads *Off* on every film, every time**, and nothing here can make it read anything
 * else on its own: the selection is `subtitles.selectedId` from the engine, and this
 * component has no memory between films, no default and no "last used". The only local
 * state is whether the menu is open, which is a fact about a mouse and not about a
 * television.
 *
 * Rendering it sends nothing. A founder who never touches it gets exactly the app they had
 * before M3c existed, down to the bytes on the wire — which is what 19a promises and what
 * `test/engine/m3c-load-golden.test.ts` measures.
 *
 * Picture-only tracks (18k) are listed underneath, visibly refused, with *Choose a file…*
 * in the same breath. Hiding them is explicitly the wrong answer: *"hiding them entirely
 * reads as CastGood having missed the subtitles the founder can see in the file."*
 *
 * Restyled in M4 step 4 against §10's subtitle table. One thing here was never decoration
 * and predates the visual pass: the rows carry the same resting border and fill as
 * `Button`. The founder read a borderless list as *text on the screen* rather than
 * something to click (2026-08-27, on the Chromecast Ultra). Whether a control looks
 * pressable is an affordance, not a look, and this project has already fixed *"looks
 * pressable and does nothing"* once — this is the same fault with the sign reversed.
 */
export function SubtitlesPanel({
  subtitles,
  onSelect,
  onCancelPreparing,
  onRetry,
  onNudge,
  onResetTiming,
}: {
  readonly subtitles: SubtitlesView;
  /**
   * Every row goes back through here, including *Off* and *Choose a file…* — App maps the
   * two sentinel ids to a `subtitles.clear` intent and to opening a dialog. The component
   * stays a list of things that can be pressed and knows nothing about what they mean.
   */
  readonly onSelect: (id: string) => void;
  readonly onCancelPreparing: () => void;
  /**
   * 18l's *Try again*. Only ever rendered when the engine says there is something to retry —
   * a television that took the track and never fetched it, with the film still playing.
   */
  readonly onRetry: () => void;
  /** One press of earlier (`-1`) or later (`+1`). The engine owns what a step is worth. */
  readonly onNudge: (steps: number) => void;
  readonly onResetTiming: () => void;
}): JSX.Element {
  const [open, setOpen] = useState(false);

  return (
    <section aria-label="Subtitles" className="rounded-box border border-line bg-surface p-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted">Subtitles</span>
        <Button
          small
          onClick={() => {
            setOpen((was) => !was);
          }}
          aria-expanded={open}
        >
          {subtitles.summary}
        </Button>
        {subtitles.preparingLabel !== null && (
          <>
            {/* The same transient vocabulary as everywhere else, in its own panel rather
                than in the StatusRegion — the film is not waiting on this. Without the dot
                a wait has a sentence and a button and nothing that says *working*, which
                reads as a line of text that has stopped. */}
            <PulseDot />
            <span className="text-base">{subtitles.preparingLabel}</span>
            <Button
              small
              onClick={() => {
                onCancelPreparing();
              }}
            >
              Cancel
            </Button>
          </>
        )}
      </div>

      {/*
        **The timing control, beside the subtitles and only when there are any** — 20a.

        The reading is the engine's sentence with one word in front of it: *in sync* until
        touched, then a signed number. Never `+0.0 s`, so a film nobody has adjusted never
        looks adjusted.

        A press is instant and the number moves with it — inside ±3 s the television is
        already holding every offset the founder can reach, so *earlier* and *later* are a
        track switch and the picture does not stop (20b). Beyond that it costs one reload,
        and `reloadingLabel` is where that is said out loud rather than hidden.
      */}
      {subtitles.timing !== null && (
        <div className="mt-3 flex flex-wrap items-center gap-2.5">
          <span className="text-base">{subtitles.timing.label}</span>
          <Button
            small
            onClick={() => {
              onNudge(-1);
            }}
            disabled={!subtitles.timing.canGoEarlier}
          >
            Earlier
          </Button>
          <Button
            small
            onClick={() => {
              onNudge(1);
            }}
            disabled={!subtitles.timing.canGoLater}
          >
            Later
          </Button>
          <Button
            small
            onClick={() => {
              onResetTiming();
            }}
            disabled={!subtitles.timing.canReset}
          >
            Reset
          </Button>
          {subtitles.timing.reloadingLabel !== null && (
            <span className="text-sm text-muted">{subtitles.timing.reloadingLabel}</span>
          )}
        </div>
      )}

      {open && (
        <ul
          // **Capped, and it scrolls inside itself.** Nothing in this app clips: there is
          // no `overflow` anywhere in the window, so content that does not fit is simply
          // gone — no scrollbar, no way to reach it. The source list is the one thing that
          // can grow without bound (tracks inside the film, every matching sidecar beside
          // it, and *Choose a file…*), and with four sources at the size the window opens
          // at, the bottom rows were unreachable.
          //
          // Four rows and a peek at the fifth: enough that the list is obviously a list,
          // capped so the panel can never push the transport row off the bottom of the
          // window. The scroll is inside the list rather than on the page, which keeps
          // §8's "no scrollbar" true of the window itself.
          className="mt-3 flex max-h-[208px] max-w-[420px] flex-col gap-1.5 overflow-y-auto"
          role="listbox"
          aria-label="Subtitle source"
        >
          {subtitles.choices.map((choice) => (
            <li key={choice.id}>
              <button
                type="button"
                role="option"
                aria-selected={choice.selected}
                className="flex min-h-11 w-full items-center gap-2.5 rounded-box border border-line-strong bg-surface-2 px-3 text-left text-base text-text focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={() => {
                  setOpen(false);
                  onSelect(choice.id);
                }}
              >
                {choice.selected ? '• ' : '  '}
                {choice.label}
              </button>
            </li>
          ))}
        </ul>
      )}

      {/*
        **Outside the menu, not inside it.** Every row closes the menu before it acts, so a
        reason rendered only while `open` could never be read: pressing *Choose a file…* in a
        build with no picker closed the list, set the sentence, and showed nothing — the exact
        "looks pressable and does nothing" this project fixed once already for Choose video….
      */}
      {subtitles.chooseDisabledReason !== null && (
        <DisabledReason text={subtitles.chooseDisabledReason} />
      )}

      {/*
        18j / 18f: one sentence, the engine's own, rendered verbatim. Never parser output and
        never a file path — and when there is nothing to say, there is nothing here.
      */}
      {subtitles.problem !== null && (
        <div className="mt-2.5 flex flex-wrap items-center gap-2.5">
          <p className="max-w-[62ch] text-base">{subtitles.problem}</p>
          {/*
            18l: *Subtitles didn't load*, with **Try again** — and the film is playing
            behind this the whole time. Nothing here can stop it: the press goes back to
            the engine, which hands the television the track again at the founder's place.
          */}
          {subtitles.canRetry && (
            <Button
              small
              onClick={() => {
                onRetry();
              }}
            >
              Try again
            </Button>
          )}
        </div>
      )}

      {/*
        18k. Listed, not hidden, and refused in the engine's own words — with the picker
        offered in the same breath, which for a downloaded library is the answer that
        actually works.
      */}
      {subtitles.unavailable.length > 0 && (
        <ul className="mt-3 flex flex-col gap-1">
          {subtitles.unavailable.map((track) => (
            <li key={track.label} className="max-w-[62ch] text-sm text-muted">
              {track.label} — {track.why}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
