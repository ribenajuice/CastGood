import { memo, type JSX } from 'react';
import type { PreparationView } from '../state/view-model.js';

/**
 * The bar, while a film is being prepared (8a).
 *
 * **Its own panel rather than part of the status region**, and for one reason: the status
 * region is a `role="status"` live region, so a percentage inside it would re-announce
 * itself to a screen reader every time it ticked. The words live there; the number lives
 * here, marked `aria-hidden` on the readout and carried properly by the progress bar's own
 * `aria-valuenow` instead.
 *
 * The bar **never goes backwards** — the engine guarantees that, because ffmpeg's own
 * `out_time` can step back at a chapter boundary and a bar that retreats is the clearest
 * signal a person can get that an app has lost the plot.
 *
 * One bar per screen, ever. The determinate bar is 10 px on a `--track` bed with a
 * `--brand` fill; the percentage sits left in `--text` and the next-thing right in
 * `--text-muted`. Its width transition is **180 ms linear** — §10's one permitted
 * transition, and it is smoothing a sampled number rather than decorating a change. It
 * ran at 500 ms until M4's checkers found it, which is half a second of looking like lag.
 */
function PreparationPanelImpl({
  preparation,
}: {
  readonly preparation: PreparationView;
}): JSX.Element {
  return (
    <section
      aria-label="Preparation progress"
      className="rounded-box border border-line bg-surface p-3.5"
    >
      <div className="flex items-baseline justify-between gap-3">
        <p className="text-base text-text">{preparation.headline}</p>
        <p className="text-sm font-semibold tabular-nums text-text" aria-hidden="true">
          {preparation.percentLabel}
        </p>
      </div>
      <div
        role="progressbar"
        aria-label={preparation.headline}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(preparation.percent)}
        className="mt-2.5 h-2.5 w-full overflow-hidden rounded-pill bg-track"
      >
        <div
          className="h-full bg-brand transition-[width] duration-180 ease-linear"
          style={{ width: `${String(Math.min(100, Math.max(0, preparation.percent)))}%` }}
        />
      </div>
      {/*
        8b's honesty clause, rendered as an absence. Until the job has measured itself there
        is no estimate, and no estimate is shown — a number invented in the first second
        would be the flattering one the criterion forbids.
      */}
      {preparation.remainingLabel !== null && (
        <p className="mt-2 text-sm tabular-nums text-muted">{preparation.remainingLabel}</p>
      )}
    </section>
  );
}

export const PreparationPanel = memo(PreparationPanelImpl);
