import type { Device, DeviceId } from '../types.js';
import { DISCOVERY } from '../config.js';

/**
 * The device list, as a pure data structure.
 *
 * Everything the PRD asks of discovery that is *not* mDNS lives here — appear, update,
 * expire, and the one exception that matters: **the device currently being cast to is
 * never removed from the list**, however quiet the network goes. Keeping it pure means
 * the "appears within 30 s / leaves within 30 s" behaviour is provable in milliseconds
 * against a fake clock instead of by switching a television off and counting.
 *
 * Time in here is monotonic milliseconds only. Wall clock jumps (sleep, NTP) must never
 * make a device vanish.
 */

export interface DeviceObservation {
  readonly id: DeviceId;
  readonly friendlyName: string;
  readonly model: string;
  readonly address: string;
  readonly port: number;
}

export type ObservationResult = 'added' | 'updated' | 'unchanged';

export interface DeviceRegistry {
  observe(observation: DeviceObservation, monoMs: number): ObservationResult;
  /** An explicit goodbye packet. Honoured immediately — unless the device is pinned. */
  remove(id: DeviceId): boolean;
  /** Drops everything unheard from for longer than the expiry window. Returns what went. */
  expire(monoMs: number): DeviceId[];
  /** Pins the device we are casting to, so TTL expiry cannot take it off the list. */
  pin(id: DeviceId): void;
  unpin(id: DeviceId): void;
  isPinned(id: DeviceId): boolean;
  devices(): readonly Device[];
  get(id: DeviceId): Device | undefined;
  /** Case-insensitive, trimmed: the founder types a name, they do not paste an id. */
  findByName(friendlyName: string): Device | undefined;
  clear(): void;
}

interface Entry {
  device: Device;
  lastSeenMono: number;
}

function sameDevice(a: Device, b: DeviceObservation): boolean {
  return (
    a.friendlyName === b.friendlyName &&
    a.model === b.model &&
    a.address === b.address &&
    a.port === b.port
  );
}

export function createDeviceRegistry(expiryMs: number = DISCOVERY.deviceExpiryMs): DeviceRegistry {
  const entries = new Map<DeviceId, Entry>();
  const pinned = new Set<DeviceId>();

  const sorted = (): Device[] =>
    [...entries.values()]
      .map((entry) => entry.device)
      .sort((a, b) => a.friendlyName.localeCompare(b.friendlyName));

  return {
    observe(observation, monoMs) {
      const existing = entries.get(observation.id);
      const device: Device = { ...observation, lastSeenAt: monoMs };
      entries.set(observation.id, { device, lastSeenMono: monoMs });
      if (existing === undefined) return 'added';
      return sameDevice(existing.device, observation) ? 'unchanged' : 'updated';
    },

    remove(id) {
      if (pinned.has(id)) return false;
      return entries.delete(id);
    },

    expire(monoMs) {
      const gone: DeviceId[] = [];
      for (const [id, entry] of entries) {
        if (pinned.has(id)) continue;
        if (monoMs - entry.lastSeenMono > expiryMs) {
          entries.delete(id);
          gone.push(id);
        }
      }
      return gone;
    },

    pin: (id) => void pinned.add(id),
    unpin: (id) => void pinned.delete(id),
    isPinned: (id) => pinned.has(id),
    devices: sorted,
    get: (id) => entries.get(id)?.device,

    findByName(friendlyName) {
      const wanted = friendlyName.trim().toLowerCase();
      return sorted().find((device) => device.friendlyName.trim().toLowerCase() === wanted);
    },

    clear() {
      entries.clear();
      pinned.clear();
    },
  };
}
