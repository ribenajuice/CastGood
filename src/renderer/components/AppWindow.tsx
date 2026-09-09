import type { JSX, ReactNode } from 'react';

/**
 * The layout shell: one window, four regions, always in the same place.
 *
 *   FilePanel      (what's chosen)   │  DevicePanel
 *   StatusRegion   (what's happening)│  (where it goes)
 *   TransportPanel (what you can do) │
 *
 * The device column is 240 px fixed, and there is **one layout**. A `max-[840px]` branch
 * used to stack the column beneath the main one; with the window minimum at 880 px it was
 * never reachable by resizing, so it was dead code describing a second layout M4 would
 * otherwise have had to design twice. Removed in M4 step 2, per §1's correction of
 * 2026-08-30 — which also retired the rule that dropped the status headline to 24 px
 * below that breakpoint, under story 22a's own 28 px floor.
 */
export function AppWindow({
  stateName,
  main,
  devices,
}: {
  readonly stateName: string;
  readonly main: ReactNode;
  readonly devices: ReactNode;
}): JSX.Element {
  return (
    <div
      // QA reads this to map a screen to a state without interpretation.
      data-castgood-state={stateName}
      className="flex h-full min-h-0 bg-bg font-sans text-base text-text"
    >
      <main aria-label="Cast" className="flex min-w-0 flex-1 flex-col gap-3.5 p-4">
        {/* The window's own title bar carries the name visually; this is what gives a
            screen reader a document heading to start from. */}
        <h1 className="sr-only">CastGood</h1>
        {main}
      </main>
      <aside
        // *Use a different device* moves focus in here; the attribute is the anchor.
        data-devices=""
        aria-label="Devices"
        className="w-60 shrink-0 border-l border-line p-4"
      >
        {devices}
      </aside>
    </div>
  );
}
