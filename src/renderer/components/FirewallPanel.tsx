import type { JSX } from 'react';

/**
 * The manual way through the firewall (PRD 17b).
 *
 * *Allow through the firewall* raises Windows' own elevation prompt and does this for the
 * founder. This panel is the other half of the promise: if they decline it, cannot
 * elevate, or it simply fails, the steps stay on screen and nothing else changes. A
 * founder without administrator rights is not stuck — they can hand these four lines to
 * someone who has them.
 *
 * The steps name the *setting*, not our command line: `netsh` in front of a product
 * manager is a wall, and Windows' own dialog is the thing they will actually see.
 */
export function FirewallPanel({
  note,
  showSteps,
  canAllow,
}: {
  readonly note: string | null;
  readonly showSteps: boolean;
  readonly canAllow: boolean;
}): JSX.Element {
  return (
    <section
      aria-label="Firewall help"
      className="rounded-box border border-line bg-surface p-3.5 text-base text-text"
    >
      {note !== null && (
        <p aria-live="polite" className="mb-2 text-text">
          {note}
        </p>
      )}
      {!canAllow && (
        <p className="mb-2 text-sm text-muted">
          This build can’t change the firewall for you — the steps below do the same thing.
        </p>
      )}
      {showSteps && (
        <ol className="list-decimal space-y-1.5 pl-5 text-sm">
          <li>Open Windows Security, then Firewall &amp; network protection.</li>
          <li>Choose “Allow an app through firewall”, then “Change settings”.</li>
          <li>
            Find <span className="font-semibold text-text">CastGood</span> in the list and tick the{' '}
            <span className="font-semibold text-text">Private</span> box.
          </li>
          <li>Press OK, come back here and press “Try again”.</li>
        </ol>
      )}
    </section>
  );
}
