import type { JSX } from 'react';

/**
 * The ±30 s controls, as glyphs (§10, and criterion 21h).
 *
 * **The one place M4 changes what is on screen rather than how it looks.** The two are
 * mirror images of each other, so *"which way does this go"* is answered by shape at any
 * size and at any distance — the labels *Back 30s* / *Forward 30s* were the only thing
 * carrying direction before, and at three metres they were a word-shape.
 *
 * The numeral is a real `<text>` element rather than a path: it inherits the font stack
 * and scales with the button, so a raised Windows text size grows the glyph with
 * everything else. `currentColor` throughout, so the two unavailability treatments in
 * `Button` need no second glyph.
 *
 * `aria-hidden`, because the button's `aria-label` is unchanged and is now the only thing
 * a screen reader has — exactly as §9 anticipated when it wrote those labels.
 */
export function SkipGlyph({ direction }: { readonly direction: 'back' | 'forward' }): JSX.Element {
  const back = direction === 'back';
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
      {/* The circle, opened at the top so the arrowhead has somewhere to sit. Mirrored on
          the vertical axis for the forward glyph, which is what makes the pair readable. */}
      <g transform={back ? undefined : 'translate(24 0) scale(-1 1)'}>
        <path d="M4.2 9.4A8.2 8.2 0 1 0 12 3.8H5.6" />
        <path d="M8.5 1.2 5.2 3.8l3.3 2.6" />
      </g>
      <text
        x="12"
        y="16.3"
        textAnchor="middle"
        fontSize="10"
        stroke="none"
        fill="currentColor"
        className="font-sans tabular-nums"
      >
        30
      </text>
    </svg>
  );
}
