import type { JSX } from 'react';

/**
 * Mute, as a glyph — §11, and the `SkipGlyph` spec verbatim.
 *
 * Two shapes, not two colours: a speaker cone with two arcs, or the same cone with a
 * cross. §10 forbids hue as the only carrier of a state, and this is the one control in
 * the transport row whose state a founder reads at a glance.
 *
 * `currentColor` throughout, so the disabled treatment needs no second glyph, and
 * `aria-hidden` because the button's `aria-label` plus `aria-pressed` is the whole of
 * what a screen reader gets (§9).
 */
export function MuteGlyph({ muted }: { readonly muted: boolean }): JSX.Element {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      className="size-6"
    >
      {/* The cone is identical in both states: what changes is what is beside it. */}
      <path d="M4 9.5v5h3.5L12 18.5v-13L7.5 9.5H4Z" />
      {muted ? (
        <>
          <path d="M16 9.5l4.5 5" />
          <path d="M20.5 9.5l-4.5 5" />
        </>
      ) : (
        <>
          <path d="M15.5 9a4 4 0 0 1 0 6" />
          <path d="M18.5 6.5a7.5 7.5 0 0 1 0 11" />
        </>
      )}
    </svg>
  );
}
