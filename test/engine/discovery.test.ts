import net from 'node:net';
import type os from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDiscovery, createDeviceRegistry } from '../../src/engine/discovery/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { toMdnsService } from '../../src/engine/discovery/mdns.js';
import { describeNetwork, tcpProbe } from '../../src/engine/discovery/probe.js';
import {
  classifyInterfaces,
  selectQueryInterfaces,
} from '../../src/engine/discovery/interfaces.js';
import { createLogger, createMemorySink, createTestClock } from '../../src/engine/logging/index.js';
import { DISCOVERY } from '../../src/engine/config.js';

/**
 * Story 1 in full, without a television.
 *
 * The mDNS socket is behind an adapter, so "appears within 30 s" and "leaves within
 * 30 s" are decided by logic a fake clock can drive. What these tests cannot prove is
 * that multicast reaches the device at all — that is [hardware], and the selftest's
 * `discovery` scenario is where it gets measured.
 */

function service(overrides: Partial<MdnsService> = {}): MdnsService {
  return {
    id: 'device-a',
    friendlyName: 'Family room TV',
    model: 'Chromecast Ultra',
    address: '192.168.1.50',
    port: 8009,
    ...overrides,
  };
}

interface FakeMdns extends Mdns {
  up(service: MdnsService): void;
  down(service: MdnsService): void;
  readonly browseCount: number;
  readonly activeBrowses: number;
}

function createFakeMdns(): FakeMdns {
  const active = new Set<MdnsHandlers>();
  let browseCount = 0;
  return {
    browse(handlers) {
      browseCount += 1;
      active.add(handlers);
      return {
        stop() {
          active.delete(handlers);
        },
      };
    },
    destroy: () => Promise.resolve(),
    up(item) {
      for (const handlers of [...active]) handlers.onUp(item);
    },
    down(item) {
      for (const handlers of [...active]) handlers.onDown(item);
    },
    get browseCount() {
      return browseCount;
    },
    get activeBrowses() {
      return active.size;
    },
  };
}

describe('device registry', () => {
  it('adds, updates and reports devices sorted by name', () => {
    const registry = createDeviceRegistry(1_000);
    expect(registry.observe(service({ id: 'b', friendlyName: 'Zed TV' }), 0)).toBe('added');
    expect(registry.observe(service({ id: 'a', friendlyName: 'Attic TV' }), 0)).toBe('added');
    expect(registry.observe(service({ id: 'a', friendlyName: 'Attic TV' }), 10)).toBe('unchanged');
    expect(
      registry.observe(service({ id: 'a', friendlyName: 'Attic TV', address: '10.0.0.9' }), 20),
    ).toBe('updated');
    expect(registry.devices().map((device) => device.friendlyName)).toEqual(['Attic TV', 'Zed TV']);
    expect(registry.get('a')?.address).toBe('10.0.0.9');
  });

  it('expires a device that has stopped answering', () => {
    const registry = createDeviceRegistry(25_000);
    registry.observe(service(), 0);
    expect(registry.expire(24_000)).toEqual([]);
    expect(registry.expire(26_000)).toEqual(['device-a']);
    expect(registry.devices()).toHaveLength(0);
  });

  it('never removes the device currently in use, however quiet it goes', () => {
    const registry = createDeviceRegistry(25_000);
    registry.observe(service(), 0);
    registry.pin('device-a');
    expect(registry.expire(10 * 60_000)).toEqual([]);
    expect(registry.remove('device-a')).toBe(false);
    registry.unpin('device-a');
    expect(registry.expire(10 * 60_000)).toEqual(['device-a']);
  });

  it('finds a device by the name a human typed', () => {
    const registry = createDeviceRegistry();
    registry.observe(service(), 0);
    expect(registry.findByName('  family ROOM tv ')?.id).toBe('device-a');
    expect(registry.findByName('Kitchen')).toBeUndefined();
  });
});

describe('mDNS service mapping', () => {
  it('takes the display name from the TXT fn field, never an IP or a model code', () => {
    const mapped = toMdnsService({
      name: 'Chromecast-abc123',
      fqdn: 'Chromecast-abc123._googlecast._tcp.local',
      port: 8009,
      addresses: ['fe80::1', '192.168.1.50'],
      txt: { id: 'abc123', fn: 'Family room TV', md: 'Chromecast Ultra' },
    } as never);
    expect(mapped).toEqual({
      id: 'abc123',
      friendlyName: 'Family room TV',
      model: 'Chromecast Ultra',
      address: '192.168.1.50',
      port: 8009,
    });
  });

  it('ignores a service with no IPv4 address, because a receiver needs an IP literal', () => {
    expect(
      toMdnsService({
        name: 'x',
        fqdn: 'x._googlecast._tcp.local',
        port: 8009,
        addresses: ['fe80::1'],
        txt: { id: 'x', fn: 'X' },
      } as never),
    ).toBeNull();
  });
});

describe('continuous discovery', () => {
  let clock: ReturnType<typeof createTestClock>;
  let mdns: FakeMdns;
  let found: string[];
  let lost: string[];
  let alive: Set<string>;
  let probes: string[];
  let sink: ReturnType<typeof createMemorySink>;

  beforeEach(() => {
    vi.useFakeTimers();
    clock = createTestClock(0, 0);
    mdns = createFakeMdns();
    found = [];
    lost = [];
    probes = [];
    // Every device answers on its Cast port until a test says otherwise.
    alive = new Set(['192.168.1.50']);
    sink = createMemorySink();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function start() {
    const discovery = createDiscovery({
      logger: createLogger({ sink }),
      clock,
      mdns,
      probe: (address) => {
        probes.push(address);
        return Promise.resolve(alive.has(address));
      },
      events: {
        onDeviceFound: (device) => found.push(device.friendlyName),
        onDeviceUpdated: () => undefined,
        onDeviceLost: (id) => lost.push(id),
        onError: () => undefined,
      },
    });
    discovery.start();
    return discovery;
  }

  /** Advances both hands together, letting the sweep's async work settle each tick. */
  async function advance(ms: number): Promise<void> {
    const step = 500;
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      const slice = Math.min(step, ms - elapsed);
      clock.advance(slice);
      await vi.advanceTimersByTimeAsync(slice);
    }
  }

  function sweeps(): Record<string, unknown>[] {
    return sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['event'] === 'discovery.sweep');
  }

  it('starts browsing without anything being clicked', () => {
    start();
    expect(mdns.browseCount).toBeGreaterThanOrEqual(1);
    mdns.up(service());
    expect(found).toEqual(['Family room TV']);
  });

  it('keeps looking, so a device switched on later appears with no refresh', async () => {
    const discovery = start();
    await advance(DISCOVERY.sweepIntervalMs * 2 + 10);
    // A TV that was off announces itself, or answers a refresh browse.
    mdns.up(service({ id: 'later', friendlyName: 'Kitchen TV', address: '192.168.1.51' }));
    expect(found).toEqual(['Kitchen TV']);
    expect(discovery.devices()).toHaveLength(1);
  });

  it('keeps a device that answers on its Cast port, however quiet mDNS goes', async () => {
    const discovery = start();
    mdns.up(service());
    // Well past the old 25 s expiry, and past the 60–120 s announcement interval that used
    // to be the only thing keeping a device on the list.
    await advance(150_000);
    expect(lost).toEqual([]);
    expect(discovery.devices()).toHaveLength(1);
    expect(probes.length).toBeGreaterThan(10);
  });

  it('drops a device that stops answering, inside the 30 s budget', async () => {
    const discovery = start();
    mdns.up(service());
    await advance(DISCOVERY.sweepIntervalMs + 10);
    expect(discovery.devices()).toHaveLength(1);

    // Someone switches the TV off. It stops accepting connections.
    alive.clear();
    await advance(DISCOVERY.sweepIntervalMs * DISCOVERY.probeMissesBeforeLost + 100);

    expect(lost).toEqual(['device-a']);
    expect(discovery.devices()).toHaveLength(0);
    // The PRD's budget, measured against the mechanism that now decides it.
    expect(DISCOVERY.sweepIntervalMs * DISCOVERY.probeMissesBeforeLost).toBeLessThanOrEqual(30_000);
  });

  it('survives a single missed probe without dropping the device', async () => {
    const discovery = start();
    mdns.up(service());
    await advance(DISCOVERY.sweepIntervalMs + 10);

    alive.clear();
    await advance(DISCOVERY.sweepIntervalMs + 10);
    expect(lost).toEqual([]);

    alive.add('192.168.1.50');
    await advance(DISCOVERY.sweepIntervalMs * 3);
    expect(lost).toEqual([]);
    expect(discovery.devices()).toHaveLength(1);
  });

  it('does not probe the device being cast to', async () => {
    const discovery = start();
    mdns.up(service());
    discovery.pin('device-a');
    probes.length = 0;

    alive.clear();
    await advance(DISCOVERY.sweepIntervalMs * 4);

    expect(probes).toEqual([]);
    expect(lost).toEqual([]);
    expect(discovery.devices()).toHaveLength(1);
    expect(sweeps().at(-1)).toMatchObject({ probed: 0, pinned: 1 });
  });

  it('logs what each sweep probed, answered and missed', async () => {
    start();
    mdns.up(service());
    await advance(DISCOVERY.sweepIntervalMs + 10);

    const sweep = sweeps().at(-1);
    expect(sweep).toMatchObject({ probed: 1, answered: 1, missed: 0, lost: 0 });
    expect(sweep?.['elapsedMs']).toBeTypeOf('number');
    // The number whose silence was the whole defect: mDNS answers in the last window.
    expect(sweep?.['mdnsAnswersLastSweep']).toBeTypeOf('number');
  });

  it('keeps the device being cast to even when everything goes quiet', async () => {
    const discovery = start();
    mdns.up(service());
    discovery.pin('device-a');
    alive.clear();
    await advance(200_000);
    expect(lost).toEqual([]);
    expect(discovery.devices()).toHaveLength(1);
  });

  it('honours a goodbye packet immediately', () => {
    const discovery = start();
    mdns.up(service());
    mdns.down(service());
    expect(lost).toEqual(['device-a']);
    expect(discovery.devices()).toHaveLength(0);
  });

  it('stops every browse and timer when it is stopped', async () => {
    const discovery = start();
    await discovery.stop();
    expect(mdns.activeBrowses).toBe(0);
    const before = mdns.browseCount;
    const probesBefore = probes.length;
    await advance(DISCOVERY.sweepIntervalMs * 3);
    expect(mdns.browseCount).toBe(before);
    expect(probes.length).toBe(probesBefore);
  });
});

describe('the TCP liveness probe itself', () => {
  it('says yes to something listening and no to a closed port', async () => {
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;

    // A real socket against a real listener: this is the mechanism, not a stand-in for it.
    await expect(tcpProbe('127.0.0.1', port, 2_000)).resolves.toBe(true);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(tcpProbe('127.0.0.1', port, 2_000)).resolves.toBe(false);
  });

  it('gives up rather than hanging on an address that never answers', async () => {
    // 198.51.100.0/24 is TEST-NET-2: reserved for documentation, routed nowhere.
    const startedAt = Date.now();
    await expect(tcpProbe('198.51.100.9', 8009, 300)).resolves.toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('describes the network without sending anything or throwing', async () => {
    const network = await describeNetwork();
    expect(Array.isArray(network.interfaces)).toBe(true);
    // The fields that make the next log answer the interface question outright.
    expect(network).toHaveProperty('multicastSourceAddress');
    expect(Array.isArray(network.queryAddresses)).toBe(true);
  });
});

describe('which interfaces the queries go out of', () => {
  const fake = (entries: Record<string, Partial<os.NetworkInterfaceInfo>[]>) => () =>
    Object.fromEntries(
      Object.entries(entries).map(([name, list]) => [
        name,
        list.map((item) => ({
          family: 'IPv4',
          internal: false,
          netmask: '255.255.255.0',
          mac: '00:00:00:00:00:00',
          cidr: null,
          address: '0.0.0.0',
          ...item,
        })),
      ]),
    ) as NodeJS.Dict<os.NetworkInterfaceInfo[]>;

  it('queries every real interface, including ones that look virtual', () => {
    // The founder's own machine: the LAN the TVs are on, plus WSL's adapter, plus
    // VirtualBox. Windows picked the WSL one for multicast and discovery suffered. We do
    // not pick — we ask on all of them, because "prefer ethernet" or "skip anything called
    // vEthernet" is just a different guess, and the next machine is a laptop on wifi.
    const addresses = selectQueryInterfaces(
      fake({
        Ethernet: [{ address: '10.1.1.230' }],
        'vEthernet (WSL)': [{ address: '172.24.16.1' }],
        'Ethernet 2': [{ address: '192.168.56.1' }],
        'Wi-Fi': [{ address: '192.168.1.14' }],
      }),
    );
    expect(addresses).toEqual(['10.1.1.230', '172.24.16.1', '192.168.56.1', '192.168.1.14']);
  });

  it('excludes only what is structurally not a network, and says which and why', () => {
    const classified = classifyInterfaces(
      fake({
        Ethernet: [{ address: '10.1.1.230' }],
        'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', internal: true }],
        'Unplugged NIC': [{ address: '169.254.10.2' }],
        'Wi-Fi': [{ address: 'fe80::1', family: 'IPv6' }],
      }),
    );

    expect(classified.find((c) => c.address === '10.1.1.230')?.excluded).toBeNull();
    expect(classified.find((c) => c.address === '127.0.0.1')?.excluded).toBe('internal');
    expect(classified.find((c) => c.address === '169.254.10.2')?.excluded).toBe('link-local');
    expect(classified.find((c) => c.address === 'fe80::1')?.excluded).toBe('not-ipv4');
  });

  it('falls back to letting the OS choose rather than discovering nothing', () => {
    // Every candidate excluded. An arbitrary interface beats no interface at all.
    expect(
      selectQueryInterfaces(
        fake({ 'Loopback Pseudo-Interface 1': [{ address: '127.0.0.1', internal: true }] }),
      ),
    ).toEqual([]);
  });

  it('reads the real machine without throwing, whatever it is plugged into', () => {
    expect(() => selectQueryInterfaces()).not.toThrow();
    for (const candidate of classifyInterfaces()) {
      expect(typeof candidate.address).toBe('string');
    }
  });
});
