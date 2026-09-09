import type { JSX } from 'react';

/**
 * Small text placed *beside* a disabled control, never instead of it.
 *
 * "The app never shows a control that doesn't work; it disables it and says why."
 * (PRD, universal rules.) `--text-sm` / `--text-muted`, which measures 5.4:1 — dimmer
 * than the headline and still comfortably readable, because the control is the thing
 * that changed token, not its explanation.
 *
 * It matters more once the skip buttons are glyphs: this sentence is what tells the
 * founder *"Converted as far as 1:10:20"* when the forward arrow goes quiet.
 */
export function DisabledReason({ text }: { readonly text: string }): JSX.Element {
  return <span className="max-w-[34ch] self-center text-sm text-muted">{text}</span>;
}
