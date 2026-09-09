import type { Device, DeviceId } from '../types.js';
import type { Clock, Logger } from '../logging/index.js';
import { systemClock } from '../logging/index.js';
import { CAST, DISCOVERY } from '../config.js';
import { createDeviceRegistry, type DeviceRegistry } from './registry.js';
import { createBonjourMdns, type Mdns, type MdnsBrowse } from './mdns.js';
import { describeNetwork, tcpProbe, type DeviceProbe } from './probe.js';

/**
 * Device discovery: mDNS finds devices and gives them their names; **TCP decides whether
 * they are still there**.
 *
 * The split is the lesson of the first hardware run. Discovery used to prove liveness by
 * re-browsing every 8 s, and on the founder's network those queries were never answered —
 * devices were only ever heard from when they re-announced themselves, every 60–120 s,
 * against a 25 s expiry. Every device therefore left the list on a metronome and came back
 * on the next announcement. All evening. Reliability is the north star and the device list
 * was the least reliable thing in the app.
 *
 * So liveness is now a direct question to the one device that can answer it: open a TCP
 * connection to its Cast port. It is powered on or it is not. The founder's log measured
 * that same connection at 0.09–0.11 s, and it does not care which interface the OS picks
 * for multicast — the thing we cannot yet see into.
 *
 * Three mechanisms, each doing only what it is good at:
 *  - **a long-lived mDNS browse** hears a TV announce itself when it is switched on;
 *  - **a periodic refresh browse** asks for anything we have not met yet;
 *  - **a TCP probe of every known device**, every 8 s, is what keeps the list honest.
 *
 * `deviceExpiryMs` survives as a last-resort net, now well above the observed announcement
 * interval, so it can no longer be what removes a device that is plainly still there.
 */

export interface DiscoveryEvents {
  onDeviceFound(device: Device): void;
  onDeviceUpdated(device: Device): void;
  onDeviceLost(deviceId: DeviceId): void;
  onError(error: Error): void;
}

export interface Discovery {
  start(): void;
  stop(): Promise<void>;
  /** Current best knowledge. Discovery owns this list; nothing else may mutate it. */
  devices(): readonly Device[];
  findByName(friendlyName: string): Device | undefined;
  /** The "Search again" button. Discovery is already continuous; this just hurries it. */
  rescan(): void;
  /** Pins a device so expiry cannot remove it while we are casting to it. */
  pin(deviceId: DeviceId): void;
  unpin(deviceId: DeviceId): void;
}

export interface DiscoveryDeps {
  logger: Logger;
  events: DiscoveryEvents;
  clock?: Clock;
  /** Injected by tests with a scripted responder; the app always gets real mDNS. */
  mdns?: Mdns;
  /** Injected by tests. The default opens a real TCP connection, which is the point. */
  probe?: DeviceProbe;
}

export function createDiscovery(deps: DiscoveryDeps): Discovery {
  const logger = deps.logger.child({ component: 'discovery' });
  const clock = deps.clock ?? systemClock;
  const mdns = deps.mdns ?? createBonjourMdns();
  const probe = deps.probe ?? tcpProbe;
  const registry: DeviceRegistry = createDeviceRegistry(DISCOVERY.deviceExpiryMs);

  /** Consecutive failed probes per device. Reset by any success, or by an announcement. */
  const misses = new Map<DeviceId, number>();

  let persistent: MdnsBrowse | null = null;
  let refresh: MdnsBrowse | null = null;
  let refreshStopTimer: NodeJS.Timeout | null = null;
  let sweepTimer: NodeJS.Timeout | null = null;
  let expiryTimer: NodeJS.Timeout | null = null;
  let running = false;
  let sweeping = false;
  /** mDNS `up` events since the last sweep — the number that was silently zero all evening. */
  let mdnsAnswers = 0;

  const handlers = {
    onUp(service: {
      id: string;
      friendlyName: string;
      model: string;
      address: string;
      port: number;
    }): void {
      mdnsAnswers += 1;
      const result = registry.observe(service, clock.monoMs());
      misses.delete(service.id);
      const device = registry.get(service.id);
      if (device === undefined) return;
      if (result === 'added') {
        logger.info('discovery.device_found', {
          deviceId: device.id,
          friendlyName: device.friendlyName,
          model: device.model,
          address: device.address,
          // Always 8009 on real hardware, and the only way a scenario that opens its own
          // second connection (`takeover`) can reach a device it did not discover itself.
          port: device.port,
        });
        deps.events.onDeviceFound(device);
      } else if (result === 'updated') {
        logger.info('discovery.device_updated', { deviceId: device.id, address: device.address });
        deps.events.onDeviceUpdated(device);
      }
    },
    onDown(service: { id: string }): void {
      if (registry.remove(service.id)) {
        misses.delete(service.id);
        logger.info('discovery.device_lost', { deviceId: service.id, reason: 'goodbye' });
        deps.events.onDeviceLost(service.id);
      }
    },
    onError(error: Error): void {
      logger.error('discovery.error', { error });
      deps.events.onError(error);
    },
  };

  /** A short browse for devices we have not met. Liveness is not its job any more. */
  const startRefreshBrowse = (): void => {
    if (!running) return;
    refresh?.stop();
    refresh = mdns.browse(handlers);
    if (refreshStopTimer !== null) clearTimeout(refreshStopTimer);
    refreshStopTimer = setTimeout(() => {
      refresh?.stop();
      refresh = null;
    }, DISCOVERY.sweepWindowMs);
    refreshStopTimer.unref?.();
  };

  async function sweep(): Promise<void> {
    if (!running || sweeping) return;
    sweeping = true;
    const startedAt = clock.monoMs();
    const answersBefore = mdnsAnswers;
    mdnsAnswers = 0;

    try {
      startRefreshBrowse();

      // The device being cast to is pinned and cannot be removed anyway, and we already
      // hold a live connection to it that reports its own health. No need to knock twice.
      const targets = registry.devices().filter((device) => !registry.isPinned(device.id));
      const results = await Promise.all(
        targets.map(async (device) => {
          const at = clock.monoMs();
          const alive = await probe(
            device.address,
            device.port || CAST.port,
            DISCOVERY.probeTimeoutMs,
          ).catch(() => false);
          return { device, alive, elapsedMs: Math.round(clock.monoMs() - at) };
        }),
      );

      const lost: DeviceId[] = [];
      for (const { device, alive } of results) {
        if (alive) {
          // Answering is what "still here" means; refresh the clock on it.
          registry.observe(device, clock.monoMs());
          misses.delete(device.id);
          continue;
        }
        const failures = (misses.get(device.id) ?? 0) + 1;
        misses.set(device.id, failures);
        if (failures >= DISCOVERY.probeMissesBeforeLost && registry.remove(device.id)) {
          misses.delete(device.id);
          lost.push(device.id);
        }
      }

      // The line whose absence meant the flapping had to be inferred rather than read.
      logger.info('discovery.sweep', {
        probed: targets.length,
        answered: results.filter((result) => result.alive).length,
        missed: results.filter((result) => !result.alive).length,
        pinned: registry.devices().length - targets.length,
        lost: lost.length,
        slowestProbeMs: results.reduce((slowest, r) => Math.max(slowest, r.elapsedMs), 0),
        elapsedMs: Math.round(clock.monoMs() - startedAt),
        // Zero here, sweep after sweep, while devices are plainly answering TCP, means our
        // mDNS queries are going out and coming back with nothing — the open question from
        // the first hardware run, and the reason this number is in the log.
        mdnsAnswersLastSweep: answersBefore,
      });

      for (const id of lost) {
        logger.info('discovery.device_lost', { deviceId: id, reason: 'no answer on cast port' });
        deps.events.onDeviceLost(id);
      }
    } finally {
      sweeping = false;
    }
  }

  return {
    start() {
      if (running) return;
      running = true;
      logger.info('discovery.start', {
        sweepIntervalMs: DISCOVERY.sweepIntervalMs,
        probeTimeoutMs: DISCOVERY.probeTimeoutMs,
        probeMissesBeforeLost: DISCOVERY.probeMissesBeforeLost,
        expiryMs: DISCOVERY.deviceExpiryMs,
      });

      // Diagnostic only, and it must never delay startup or throw into it. It answers, in
      // one line, the question that took a hardware run and an inference last time: which
      // interfaces are we querying, which are we not, and why.
      void describeNetwork().then(
        (network) =>
          logger.info('discovery.network', {
            ...network,
            excluded: network.interfaces
              .filter((candidate) => candidate.excluded !== null)
              .map(
                (candidate) =>
                  `${candidate.name} ${candidate.address} (${String(candidate.excluded)})`,
              ),
            queriersBound: mdns.queryAddresses?.() ?? [],
          }),
        () => undefined,
      );

      // The long-lived browse: hears a TV announce itself when it is switched on.
      persistent = mdns.browse(handlers);

      void sweep();
      sweepTimer = setInterval(() => void sweep(), DISCOVERY.sweepIntervalMs);
      sweepTimer.unref?.();

      expiryTimer = setInterval(() => {
        for (const id of registry.expire(clock.monoMs())) {
          misses.delete(id);
          logger.info('discovery.device_lost', { deviceId: id, reason: 'expired' });
          deps.events.onDeviceLost(id);
        }
      }, DISCOVERY.expiryCheckMs);
      expiryTimer.unref?.();
    },

    async stop() {
      running = false;
      if (sweepTimer !== null) clearInterval(sweepTimer);
      if (expiryTimer !== null) clearInterval(expiryTimer);
      if (refreshStopTimer !== null) clearTimeout(refreshStopTimer);
      sweepTimer = null;
      expiryTimer = null;
      refreshStopTimer = null;
      refresh?.stop();
      persistent?.stop();
      refresh = null;
      persistent = null;
      registry.clear();
      misses.clear();
      await mdns.destroy();
      logger.info('discovery.stop', {});
    },

    devices: () => registry.devices(),
    findByName: (name) => registry.findByName(name),
    rescan() {
      logger.info('discovery.rescan', {});
      void sweep();
    },
    pin: (deviceId) => registry.pin(deviceId),
    unpin: (deviceId) => registry.unpin(deviceId),
  };
}

export { createDeviceRegistry, type DeviceRegistry, type DeviceObservation } from './registry.js';
export {
  createBonjourMdns,
  toMdnsService,
  type Mdns,
  type MdnsService,
  type MdnsHandlers,
  type MdnsBrowse,
} from './mdns.js';
export {
  tcpProbe,
  probeDevice,
  describeNetwork,
  type DeviceProbe,
  type NetworkDiagnostic,
} from './probe.js';
