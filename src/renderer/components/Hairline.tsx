import type { JSX } from 'react';

/**
 * The indeterminate wait indicator, only ever rendered alongside a named activity —
 * there are no unqualified spinners anywhere in this app.
 *
 * A 32 %-wide runner crossing a 3 px `--track` bed. Both this and the dot below take
 * their motion from `motion.css`, which is the only place either animation is written
 * down, and both hold still rather than vanishing under `prefers-reduced-motion`.
 */
export function Hairline(): JSX.Element {
  return (
    <div
      aria-hidden="true"
      className="relative h-[3px] w-full overflow-hidden rounded-pill bg-track"
    >
      <div className="hairline-runner absolute inset-y-0 w-[32%] bg-muted" />
    </div>
  );
}

/**
 * The pulsing dot beside a transient headline.
 *
 * 9 px of `--text`. Its dim end measures 4.58:1 on `--surface`, so the trough of the
 * pulse is still legible — a dot that says "working" has to be readable at both ends of
 * its own animation. Redundant with the headline, never the only signal.
 */
export function PulseDot(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      className="pulse-dot mt-2.5 size-[9px] shrink-0 rounded-pill bg-text"
    />
  );
}
