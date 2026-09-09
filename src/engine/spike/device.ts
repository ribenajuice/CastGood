import { createDiscovery } from '../discovery/index.js';
import { DISCOVERY } from '../config.js';
import type { Device } from '../types.js';
import type { Logger } from '../logging/index.js';
import { SpikeAbort } from './m2.js';

/**
 * **A television, found by the name on its front.** THROWAWAY, like everything else in this
 * directory — shared by SPIKE-4 (`m5b.ts`) and SPIKE-5 (`m5a.ts`).
 *
 * SPIKE-1, -2 and -3 all took `--address`, which was fine when a spike was aimed at one
 * device the author had just looked up. Both M5 spikes are run **three times each, on three
 * televisions**, by the founder — who knows those sets by the names shown on screen, and
 * does not know their addresses. So these two take `--device "<name>"`
 * and do the same lookup the selftest does, through the same mDNS discovery the app uses.
 *
 * The address still exists as an escape hatch (`--address`), because mDNS is the one part
 * of this that can fail for reasons unrelated to the question being asked, and a spike that
 * cannot be run at all when discovery has a bad minute is a spike that gets skipped.
 *
 * **Never finding the named device is exit 2, never a finding.** A run that did not reach a
 * television has observed nothing, and the whole value of this directory is that its numbers
 * came off real hardware.
 */

export interface FoundDevice {
  readonly friendlyName: string;
  readonly model: string;
  readonly address: string;
  readonly port: number;
}

export interface ResolveDeviceDeps {
  /** Exactly the name shown in the Google Home app. Matched case-insensitively, trimmed. */
  readonly name: string;
  readonly logger: Logger;
  /** How long to wait for that device to announce itself. */
  readonly waitMs?: number;
  /** Injected by tests. The real one browses mDNS, which only works on Windows. */
  readonly discover?: () => {
    start(): void;
    stop(): Promise<void>;
    devices(): readonly Device[];
    findByName(name: string): Device | undefined;
    rescan(): void;
  };
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}

/**
 * A one-line description of what discovery *did* see, for the abort message.
 *
 * Pure, and exported because the message is the thing a founder reads at 9pm when a spike
 * refuses to run: "no device named X" is unhelpful; "no device named X — 2 answered:
 * Living room TV, Kitchen TV" says immediately whether the name is wrong or the set is
 * off. Typo and switched-off are the two likely causes and they need different actions.
 */
export function describeSeen(devices: readonly { readonly friendlyName: string }[]): string {
  if (devices.length === 0) {
    return 'nothing answered mDNS at all — is this machine on the same network as the televisions?';
  }
  const names = devices.map((device) => `"${device.friendlyName}"`).join(', ');
  return `${String(devices.length)} device(s) answered: ${names}`;
}

export async function resolveDeviceByName(deps: ResolveDeviceDeps): Promise<FoundDevice> {
  const waitMs = deps.waitMs ?? DISCOVERY.deviceExpiryMs;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = deps.now ?? (() => Date.now());
  const logger = deps.logger.child({ component: 'spike-discovery' });

  const discovery =
    deps.discover?.() ??
    createDiscovery({
      logger,
      events: {
        onDeviceFound: (device) => {
          logger.info('spike.device_found', {
            friendlyName: device.friendlyName,
            model: device.model,
            address: device.address,
            port: device.port,
          });
        },
        onDeviceUpdated: () => undefined,
        onDeviceLost: () => undefined,
        onError: (error) => logger.warn('spike.discovery_error', { message: error.message }),
      },
    });

  discovery.start();
  try {
    const deadline = now() + waitMs;
    for (;;) {
      const match = discovery.findByName(deps.name);
      if (match !== undefined) {
        return {
          friendlyName: match.friendlyName,
          model: match.model,
          address: match.address,
          port: match.port,
        };
      }
      if (now() >= deadline) {
        throw new SpikeAbort(
          `no device named "${deps.name}" answered within ${String(Math.round(waitMs / 1000))} s — ` +
            `${describeSeen(discovery.devices())} ` +
            'Nothing was observed. Check the name is exactly the one in the Google Home app, ' +
            'that the television is on, and that this run is on Windows rather than in WSL.',
        );
      }
      await sleep(250);
    }
  } finally {
    await discovery.stop();
  }
}
