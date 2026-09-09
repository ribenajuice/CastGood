import { memo, type JSX } from 'react';
import type { ActionId, ActionView, Tone } from '../state/view-model.js';
import { ActionRow } from './ActionRow.js';
import { Hairline, PulseDot } from './Hairline.js';

/**
 * The only place in the app that says what is happening.
 *
 * No second banner, no toast, no red dot in a corner. `role="status"` +
 * `aria-live="polite"`. A live region only announces when the DOM inside it actually
 * changes, and this component's props are derived words rather than raw numbers — so a
 * once-a-second position update elsewhere in the window mutates nothing here and cannot
 * re-announce the message or steal focus.
 *
 * A minimum height keeps the layout still as messages change length — states must not
 * make the window twitch.
 */

interface StatusRegionProps {
  readonly tone: Tone;
  readonly headline: string;
  readonly sub: string | null;
  readonly hairline: boolean;
  readonly actions: readonly ActionView[];
  readonly onAction: (id: ActionId) => void;
}

/**
 * The three kinds, and every signal here is non-chromatic (§10).
 *
 * `needsYou` doubles the border weight *and* steps the surface up — two structural
 * changes, both visible in greyscale and at three metres. The `--error` colour is
 * redundant on top of them, and it appears on exactly seven states in the whole product.
 * The padding drops by 1 px so the 2 px border does not move the content.
 *
 * The headline stays `--text` in all three. It is the sentence the founder has to read,
 * so it keeps maximum contrast; the failure is announced by the region, never by tinting
 * the words.
 */
const TONE: Record<Tone, string> = {
  info: 'border border-line bg-surface p-4',
  working: 'border border-line bg-surface p-4',
  needsYou: 'border-2 border-error bg-surface-2 p-[15px]',
};

function StatusRegionImpl({
  tone,
  headline,
  sub,
  hairline,
  actions,
  onAction,
}: StatusRegionProps): JSX.Element {
  return (
    <section
      role="status"
      aria-live="polite"
      // 184 px, raised from 132 by the founder on 2026-08-30: 132 was measured at the
      // placeholder type scale and at M4's the region would visibly jump between a short
      // message and a long one, which is the exact thing the number exists to prevent.
      className={`flex min-h-[184px] flex-1 flex-col gap-3 rounded-box ${TONE[tone]}`}
    >
      <h2 className="flex items-start gap-3 text-xl">
        {hairline && <PulseDot />}
        <span>{headline}</span>
      </h2>
      {sub !== null && sub !== '' && <p className="max-w-[62ch] text-base text-muted">{sub}</p>}
      {hairline && <Hairline />}
      <ActionRow actions={actions} onAction={onAction} />
    </section>
  );
}

export const StatusRegion = memo(StatusRegionImpl);
