import type { JSX } from 'react';
import type { ActionId, ActionView } from '../state/view-model.js';
import { Button } from './Button.js';
import { DisabledReason } from './DisabledReason.js';

/**
 * The buttons under a status message. At most one primary, always leftmost.
 *
 * A disabled action keeps its place and grows a reason beside it — it never disappears,
 * because a control that vanishes takes its explanation with it.
 */
export function ActionRow({
  actions,
  onAction,
}: {
  readonly actions: readonly ActionView[];
  readonly onAction: (id: ActionId) => void;
}): JSX.Element | null {
  if (actions.length === 0) return null;
  return (
    <div className="mt-auto flex flex-wrap items-center gap-2.5 pt-1.5">
      {actions.map((item) => (
        <div key={item.id} className="flex items-center gap-2.5">
          <Button
            variant={item.primary ? 'primary' : 'secondary'}
            disabled={item.disabledReason !== null}
            onClick={() => {
              onAction(item.id);
            }}
          >
            {item.label}
          </Button>
          {item.disabledReason !== null && <DisabledReason text={item.disabledReason} />}
        </div>
      ))}
    </div>
  );
}
