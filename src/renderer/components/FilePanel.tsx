import type { JSX } from 'react';
import type { FileView, PickView } from '../state/view-model.js';
import { Button } from './Button.js';
import { DisabledReason } from './DisabledReason.js';

/**
 * What's chosen. Empty (dashed) or chosen (name + duration).
 *
 * Deliberately no folder and no path: "never show a file path" (docs/DESIGN-SYSTEM.md
 * §6), and the snapshot's `path` is for the engine, not the founder. Choosing a file
 * sends nothing to any device — the Cast press does that, and only that.
 */
export function FilePanel({
  file,
  pick,
  onPick,
}: {
  readonly file: FileView | null;
  readonly pick: PickView;
  readonly onPick: () => void;
}): JSX.Element {
  const disabled = pick.disabledReason !== null;

  if (file === null) {
    return (
      <section
        aria-label="Chosen video"
        className="flex flex-col items-center gap-3 rounded-box border border-dashed border-line-strong bg-surface px-3 py-6"
      >
        <p className="text-base text-muted">No video chosen</p>
        <Button variant="primary" onClick={onPick} disabled={disabled}>
          {pick.label}
        </Button>
        {pick.disabledReason !== null && <DisabledReason text={pick.disabledReason} />}
      </section>
    );
  }

  return (
    <section aria-label="Chosen video" className="rounded-box border border-line bg-surface p-3.5">
      <p className="text-lg break-words">{file.name}</p>
      <p className="mt-1 text-sm tabular-nums text-muted">
        {file.durationLabel ?? 'Reading the duration…'}
      </p>
      {/*
        8e: **preparation never silently discards a subtitle track.** Said here, on the file,
        because it is a fact about the file and it has to survive every state the file passes
        through on the way to being prepared. `null` — the common case — means nothing is
        said at all: no warning icon, no empty row. When there is nothing to say, there is
        nothing here.
      */}
      {file.subtitleNotice !== null && (
        <p className="mt-1.5 max-w-[62ch] text-sm text-muted">{file.subtitleNotice}</p>
      )}
      <div className="mt-3 flex flex-wrap items-center gap-2.5">
        <Button small onClick={onPick} disabled={disabled}>
          {pick.label}
        </Button>
        {pick.disabledReason !== null && <DisabledReason text={pick.disabledReason} />}
      </div>
    </section>
  );
}
