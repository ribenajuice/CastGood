import type { JSX, ReactNode } from 'react';

/**
 * The one button in the app.
 *
 * **Disabled changes colour token, never opacity** (§10). A faded control on a dark
 * surface is unreadable at sofa distance and its contrast cannot be stated in a table,
 * which is why the classes below are computed rather than layered as `disabled:` variants:
 * a structurally unavailable primary has to *lose its fill*, not dim it.
 *
 * That is the colour-independent half of §10's unavailability table, and it is the fault
 * this project has already fixed twice — a dead primary must never look pressable:
 *
 * | | Fill | Border | Label | Focus |
 * |---|---|---|---|---|
 * | Available (primary) | `--brand` | `--brand` | `--on-brand` | in tab order |
 * | Available (secondary) | none | `--line-strong` | `--text` | in tab order |
 * | **Momentarily** unavailable | fill removed | `--line` | `--text-muted` | **stays in tab order** |
 * | **Structurally** unavailable | fill removed | `--line` | `--text-muted` | out of tab order |
 *
 * The 44 px minimum and the visible focus ring are §9, and apply regardless of any of it.
 */

export type ButtonVariant = 'primary' | 'secondary';

interface ButtonProps {
  readonly children: ReactNode;
  readonly onClick: () => void;
  readonly variant?: ButtonVariant;
  readonly disabled?: boolean;
  /**
   * **Momentarily** unavailable, which is not the same thing as `disabled`.
   *
   * The design system draws the line and the frontier is the reason it exists: *Forward
   * 30s* flickers in and out of reach as the conversion advances, and a control that drops
   * out of the tab order under the founder's finger is worse than one that says no. So
   * this stays focusable and keeps its place in the reading order, is announced as
   * unavailable, and swallows the press. Real `disabled` is for things that are
   * structurally not there — Pause during a dropout.
   */
  readonly ariaDisabled?: boolean;
  readonly small?: boolean;
  readonly ariaLabel?: string;
  /** A 44 x 44 square holding a glyph rather than a label. The two skip controls. */
  readonly square?: boolean;
}

// `shrink-0`: M5a made the transport row `nowrap` so the volume control could join it
// without costing the window 44 px. A button that can shrink defeats that — the space
// comes out of "Play" and "Stop" and they wrap to two lines, which is the same height the
// nowrap was protecting (22b). Buttons keep their size; the slider is what gives.
const BASE =
  'inline-flex min-h-11 shrink-0 items-center justify-center rounded-box border ' +
  'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent';

/** Both kinds of unavailable look the same; only the tab order tells them apart. */
const UNAVAILABLE = 'cursor-not-allowed border-line text-muted';

export function Button({
  children,
  onClick,
  variant = 'secondary',
  disabled = false,
  ariaDisabled = false,
  small = false,
  ariaLabel,
  square = false,
}: ButtonProps): JSX.Element {
  const unavailable = disabled || ariaDisabled;
  const appearance = unavailable
    ? UNAVAILABLE
    : variant === 'primary'
      ? 'border-brand bg-brand font-semibold text-on-brand'
      : 'border-line-strong text-text';
  const size = square ? 'w-11 min-w-11 p-0' : small ? 'px-3.5 text-sm' : 'px-4.5 text-base';

  return (
    <button
      type="button"
      onClick={() => {
        // A no-op press, not a missing handler: the button is still focusable and still
        // reachable by keyboard, it simply does nothing until it is available again.
        if (ariaDisabled) return;
        onClick();
      }}
      disabled={disabled}
      {...(ariaDisabled ? { 'aria-disabled': true } : {})}
      {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
      className={`${BASE} ${appearance} ${size}`}
    >
      {children}
    </button>
  );
}
