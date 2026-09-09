import type { JSX } from 'react';
import type { DiagnosticsView } from '../state/view-model.js';
import { Button } from './Button.js';

/**
 * *Save a report…* — story 25, criteria 25a and 25i.
 *
 * ⚠️ **This is the only control in CastGood that is never disabled and never hidden.**
 * Everything else goes inert while a question is pending, greys out when the PC loses its
 * network, or is simply absent before a film is chosen. This one is not, because **the
 * states somebody will actually press it in are the broken ones** — and a diagnostic that
 * needs a working app is absent exactly when it is wanted.
 *
 * It takes no state and no reason prop for the same purpose. There is nothing to pass that
 * could turn it off.
 *
 * **Drawn from the shipped token set**: `Button` in its secondary shape and `--text-muted`
 * for the sentence beside it. No new token, no new motion, nothing modal.
 *
 * ⚠️ **The sentence is `--text-base`, not `--text-sm` like `DisabledReason`.** The M4 type
 * checker caught the first version as a new 22a violation, and the fix is the larger size
 * rather than a baseline exception: **this sentence tells somebody what they are about to
 * share about themselves.** It is the one line in the app that must not be the smallest.
 */
export function DiagnosticsPanel({
  diagnostics,
  onSave,
}: {
  readonly diagnostics: DiagnosticsView;
  readonly onSave: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5 border-t border-line pt-3">
      <div className="flex items-center gap-3">
        <Button onClick={onSave}>{diagnostics.label}</Button>
        {/* 25i: what it removes and where it goes, BEFORE it is pressed. Saying nothing
            would be the app deciding something private on somebody's behalf. */}
        <span className="max-w-[52ch] text-base text-muted">{diagnostics.note}</span>
      </div>
    </div>
  );
}
