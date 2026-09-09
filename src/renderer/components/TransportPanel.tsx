import type { JSX } from 'react';
import type { ActionId, TransportView } from '../state/view-model.js';
import { Button } from './Button.js';
import { DisabledReason } from './DisabledReason.js';
import { Scrubber } from './Scrubber.js';
import { SkipGlyph } from './SkipGlyph.js';
import { VolumeControl } from './VolumeControl.js';

/**
 * What you can do: position, duration, the ±30 s skips, Play/Pause and Stop.
 *
 * The skip buttons are **hidden, not greyed**, once the TV has been released (6k): there
 * is nothing to skip inside a session that is over, and a permanently dead control is
 * worse than an absent one.
 *
 * Position and duration come straight from the snapshot — the renderer never extrapolates
 * a position between pushes, so what is on screen is what the engine last worked out from
 * what the device reported. The one exception is the scrubber's own handle mid-drag, which
 * is a gesture rather than a claim about the television.
 */
export function TransportPanel({
  transport,
  onAction,
  onSeek,
  onSkip,
  onSetVolume,
  onMute,
}: {
  readonly transport: TransportView;
  readonly onAction: (id: ActionId) => void;
  readonly onSeek: (positionSec: number) => void;
  readonly onSkip: (deltaSec: number) => void;
  readonly onSetVolume: (percent: number) => void;
  readonly onMute: (muted: boolean) => void;
}): JSX.Element {
  const { toggle, controlsDisabled, disabledReason, dimmed, skips, seekNote } = transport;
  const visibleSkips = skips.filter((skip) => !skip.hidden);
  const reason =
    transport.stopDisabledReason ??
    (controlsDisabled ? disabledReason : transport.dragDisabledReason);

  /**
   * One rule for the ±30 s controls, whichever way they were asked for.
   *
   * The arrow keys live on the scrubber and used to bypass the buttons entirely, so a
   * direction the app had just greyed out was still one keypress away. That matters most
   * at the frontier: during a hold, everything ahead is inside the margin the guard is
   * defending, so a forward jump clamps *backwards* into film already watched — a press
   * that moves the film the wrong way. The buttons and the keys now consult the same
   * answer, which is the view model's.
   */
  const skipIfAvailable = (deltaSec: number): void => {
    const back = deltaSec < 0;
    const skip = skips.find((candidate) => candidate.deltaSec < 0 === back);
    if (skip === undefined || skip.hidden || skip.disabledReason !== null) return;
    onSkip(deltaSec);
  };

  return (
    <section
      aria-label="Playback controls"
      // `dimmed` swaps the token the panel hands down, never its opacity: §10 forbids
      // opacity as a state because it destroys a measured contrast ratio, and a dropout is
      // exactly when the founder most needs to read what is on screen.
      className={`rounded-box border border-line bg-surface p-3.5 ${dimmed ? 'text-muted' : 'text-text'}`}
    >
      <div className="flex items-center gap-3 font-mono text-lg tabular-nums">
        <span className="font-semibold">{transport.positionLabel}</span>
        {/* The delta chip: the running total of taps not yet sent, or what happened when
            a jump hit an end of the film. It sits with the position because that is what
            it changes, it exists **only** while a jump is pending — the resting transport
            row has no pill in it — and it leads with a sign glyph, so position, border and
            sign carry it three times over without colour. */}
        {seekNote !== null && (
          <span
            aria-live="polite"
            className="rounded-pill border border-line-strong px-2.5 py-[5px] text-sm font-normal"
          >
            {seekNote}
          </span>
        )}
        <span className="ml-auto text-sm font-normal text-muted">{transport.durationLabel}</span>
      </div>

      {/*
        18g: *Subtitles: \<name\>*, so the founder can see which track is on **without
        looking at the television**. Read-only on purpose — turning them off and nudging the
        timing are step 4, and a disabled control here would be a promise the app cannot yet
        keep. `null` is the common case and means nothing is rendered at all.
      */}
      {transport.subtitleLabel !== null && (
        <p className="mt-1.5 text-sm text-muted">{transport.subtitleLabel}</p>
      )}

      <Scrubber
        positionSec={transport.positionSec}
        durationSec={transport.durationSec}
        positionLabel={transport.positionLabel}
        durationLabel={transport.durationLabel}
        percent={transport.percent}
        canDrag={transport.canDrag}
        frontierPercent={transport.frontierPercent}
        limitPercent={transport.limitPercent}
        seekLimitSec={transport.seekLimitSec}
        onSeek={onSeek}
        onSkip={skipIfAvailable}
      />

      {/* 10d's one line, and it sits here permanently while part of the film is still
          being converted — under the thing it is about, not in the status region, which
          answers a different question and must not be re-announced by a limit that moves
          every second. It sharpens when a jump actually ran into the limit. */}
      {transport.frontierNote !== null && (
        <p className="mt-2 max-w-[62ch] text-sm text-muted">{transport.frontierNote}</p>
      )}

      {/* ⚠️ `nowrap`, and it is load-bearing. The volume control joins this row rather than
          adding one, so the window's height arithmetic is unchanged — but a wrap would add
          44 px in a window whose floor has 33 px of headroom, and 22b would fail in the
          state the app spends most of its life in. The slider is the single flexible
          element; everything else keeps its size. */}
      <div className="mt-3 flex flex-nowrap items-center gap-2.5">
        {visibleSkips.map((skip) => (
          <Button
            key={skip.id}
            // `aria-disabled`, never `disabled`: the frontier advances continuously, so
            // *Forward 30s* comes back into reach on its own, and a control that vanished
            // from the tab order while the founder's finger was on it would be worse than
            // one that says no. The label is the whole announcement.
            ariaDisabled={skip.disabledReason !== null}
            ariaLabel={skip.deltaSec < 0 ? 'Back 30 seconds' : 'Forward 30 seconds'}
            square
            onClick={() => {
              skipIfAvailable(skip.deltaSec);
            }}
          >
            {/* 21h — the one place M4 changes what is on screen. The label was the only
                thing carrying direction, and at three metres a word is a shape. */}
            <SkipGlyph direction={skip.deltaSec < 0 ? 'back' : 'forward'} />
          </Button>
        ))}
        <Button
          variant="primary"
          disabled={controlsDisabled}
          onClick={() => {
            onAction(toggle.id);
          }}
        >
          {toggle.label}
        </Button>
        <Button
          // Stop is the way out of every live state, including a jump that is taking its
          // time. It is disabled only when there is genuinely no television to let go of.
          disabled={transport.stopDisabledReason !== null}
          onClick={() => {
            onAction('stop');
          }}
        >
          Stop
        </Button>
        {/* One sentence, never three: the most specific thing that is currently stopping
            the founder doing something. */}
        {/* `shrink-0` because the row no longer wraps: without it the browser takes the
            space out of the Play/Stop labels and this sentence, which wraps them to two
            lines and grows exactly the 44 px the nowrap was protecting (22b). The slider
            is the only thing here allowed to give. */}
        {reason !== null && (
          <span className="shrink-0">
            <DisabledReason text={reason} />
          </span>
        )}
        {/* The seam: the four controls on the left act on the film, the two on the right
            act on what CastGood is sending. `margin-left: auto` rather than a rule — §10
            has no divider and does not need one here. `null` is *not rendered at all*,
            which is every state that has released the television (23i). */}
        {transport.volume !== null && (
          <div className="ml-auto flex min-w-0 flex-1 items-center justify-end gap-2.5">
            <VolumeControl volume={transport.volume} onSetVolume={onSetVolume} onMute={onMute} />
          </div>
        )}
      </div>
    </section>
  );
}
