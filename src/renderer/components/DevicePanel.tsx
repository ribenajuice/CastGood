import type { JSX } from 'react';
import type { DevicePanelView, DeviceRowView } from '../state/view-model.js';
import { Button } from './Button.js';
import { DisabledReason } from './DisabledReason.js';

/**
 * Where it goes. A radio group of real device names — never an IP, a model code or
 * "Device 1" (criterion 1c); the model line underneath is the mDNS `md=` string, which
 * is what the founder sees in the Google Home app.
 *
 * Discovery is continuous and started before this window existed, so nothing here is a
 * "start searching" control: "Search again" only exists because a founder staring at an
 * empty list wants something to press.
 */

function DeviceRow({
  device,
  onSelect,
}: {
  readonly device: DeviceRowView;
  readonly onSelect: (id: string) => void;
}): JSX.Element {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={device.selected}
      disabled={device.disabled}
      onClick={() => {
        onSelect(device.id);
      }}
      // Selection is a 2 px `--accent` border *and* a filled radio, never colour alone;
      // `aria-checked` carries it for anyone who can see neither. A device that cannot be
      // chosen swaps token like every other unavailable control in the app — §10 forbids
      // dimming it, because a row read at three metres has no contrast to spare.
      className={`flex min-h-11 w-full items-start gap-3 rounded-box bg-surface text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent ${
        device.disabled ? 'cursor-not-allowed text-muted' : 'text-text'
      } ${
        device.selected
          ? 'border-2 border-accent px-2.5 py-[9px]'
          : 'border border-line-strong px-[11px] py-2.5'
      }`}
    >
      <span
        aria-hidden="true"
        className={`mt-1 size-4 shrink-0 rounded-pill border ${
          device.selected ? 'border-accent bg-accent' : 'border-line-strong'
        }`}
      />
      <span className="min-w-0">
        <span className="block text-base font-semibold break-words">{device.name}</span>
        <span className="mt-0.5 block text-sm text-muted">{device.meta}</span>
      </span>
    </button>
  );
}

function EmptyDeviceState({
  kind,
  canRescan,
  onRescan,
}: {
  readonly kind: 'searching' | 'none-found';
  readonly canRescan: boolean;
  readonly onRescan: () => void;
}): JSX.Element {
  if (kind === 'searching') {
    return <p className="text-sm text-muted">Looking for devices on your network…</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-base font-semibold">No devices found on this network.</p>
      <ul className="list-disc pl-4 text-sm leading-relaxed text-muted">
        <li>Is the TV or speaker switched on?</li>
        <li>Is it on the same wifi as this PC?</li>
      </ul>
      {/* Self-clearing: the moment a device answers, this whole block is replaced by the
          list. Nothing to dismiss, nothing to press (criterion 1d). */}
      <p className="text-sm text-muted">Still looking — the list fills in by itself.</p>
      <div>
        <Button small onClick={onRescan} disabled={!canRescan}>
          Search again
        </Button>
      </div>
    </div>
  );
}

export function DevicePanel({
  devices,
  onSelect,
  onRescan,
}: {
  readonly devices: DevicePanelView;
  readonly onSelect: (id: string) => void;
  readonly onRescan: () => void;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold tracking-[0.09em] text-muted uppercase">Devices</h2>
        <span className="text-sm text-muted">{devices.statusLabel}</span>
      </div>

      {devices.empty !== null ? (
        <EmptyDeviceState kind={devices.empty} canRescan={devices.canRescan} onRescan={onRescan} />
      ) : (
        <>
          <div role="radiogroup" aria-label="Cast to" className="flex flex-col gap-2">
            {devices.rows.map((device) => (
              <DeviceRow key={device.id} device={device} onSelect={onSelect} />
            ))}
          </div>
          {devices.disabledReason !== null && <DisabledReason text={devices.disabledReason} />}
        </>
      )}
    </div>
  );
}
