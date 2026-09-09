import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import { createNetworkWatcher, type NetworkState } from '../../src/engine/network/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import type { InterfaceSource } from '../../src/engine/discovery/interfaces.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import {
  createLogger,
  createMemorySink,
  systemClock,
  type Clock,
} from '../../src/engine/logging/index.js';
import { TIMING } from '../../src/engine/config.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * 11d: "this PC has lost its network connection", and the one signal that works.
 *
 * `src/engine/network/` shipped with no test at all, and the defect that hid there was
 * precisely the one the module's own comment warns about: the founder's PC keeps
 * `vEthernet (WSL) 172.24.16.1` when the Ethernet is unplugged, so "some interface still
 * has an address" is not the question — the question is whether the address the OS chose
 * to reach *this* television is still here.
 *
 * The interface list is scripted through `EngineOptions.networkInterfaces`, which is the
 * only way an unplugged cable can be produced in WSL.
 */

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

/** The founder's own machine: Ethernet, the WSL virtual adapter, and loopback. */
function foundersPc(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return {
    Ethernet: [ipv4('10.1.1.42')],
    'vEthernet (WSL)': [ipv4('172.24.16.1')],
    'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)],
  };
}

describe('the network watcher itself', () => {
  const logger = createLogger({ sink: createMemorySink(), clock: systemClock });

  it('separates the addresses multicast may leave by from the ones that merely exist', () => {
    const watcher = createNetworkWatcher({
      logger,
      interfaces: () => foundersPc(),
      onChanged: () => undefined,
    });

    // Loopback is a real address on this machine and a hopeless one to send mDNS out of.
    // Conflating the two lists declared a streaming PC offline once already.
    expect(watcher.state.addresses).toEqual(['10.1.1.42', '172.24.16.1']);
    expect(watcher.state.allAddresses).toContain('127.0.0.1');
    expect(watcher.state.up).toBe(true);
    expect(watcher.has('127.0.0.1')).toBe(true);
    expect(watcher.has('10.1.1.42')).toBe(true);
    expect(watcher.has('10.1.1.99')).toBe(false);
  });

  it('is down only when there is no usable address anywhere', () => {
    const watcher = createNetworkWatcher({
      logger,
      interfaces: () => ({ 'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)] }),
      onChanged: () => undefined,
    });
    expect(watcher.state.up).toBe(false);
    expect(watcher.state.addresses).toEqual([]);
  });

  it('announces a change once, and says nothing when nothing moved', () => {
    let interfaces = foundersPc();
    const changes: NetworkState[] = [];
    const watcher = createNetworkWatcher({
      logger,
      interfaces: () => interfaces,
      onChanged: (state) => changes.push(state),
    });

    expect(watcher.poll()).toBe(watcher.state);
    expect(changes).toHaveLength(0);

    // The cable comes out. The WSL adapter keeps its address, so `up` stays true — which
    // is exactly why `up` alone cannot answer 11d.
    interfaces = {
      'vEthernet (WSL)': [ipv4('172.24.16.1')],
      'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)],
    };
    const after = watcher.poll();
    expect(changes).toHaveLength(1);
    expect(after.up).toBe(true);
    expect(after.addresses).toEqual(['172.24.16.1']);
    expect(watcher.has('10.1.1.42')).toBe(false);

    watcher.poll();
    expect(changes).toHaveLength(1);
  });
});

interface FakeMdns extends Mdns {
  up(service: MdnsService): void;
}

function createFakeMdns(): FakeMdns {
  const active = new Set<MdnsHandlers>();
  const seen: MdnsService[] = [];
  return {
    browse(handlers) {
      active.add(handlers);
      for (const service of seen) handlers.onUp(service);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
    up(service) {
      seen.push(service);
      for (const handlers of [...active]) handlers.onUp(service);
    },
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

function fixtureMp4(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(90_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

interface ShiftingClock extends Clock {
  shift(ms: number): void;
}

function createShiftingClock(): ShiftingClock {
  let offset = 0;
  return {
    wallMs: () => Date.now() + offset,
    monoMs: () => systemClock.monoMs() + offset,
    shift(ms) {
      offset += ms;
    },
  };
}

describe('11d — the PC drops off the network mid-film', () => {
  let receiver: FakeReceiver;
  let engine: Engine;
  let clock: ShiftingClock;
  let mdns: FakeMdns;
  let directory: string;
  let filePath: string;
  /**
   * The serving address is `127.0.0.1` in a headless test, because that is where the fake
   * television is. So "the Ethernet came out" is scripted as the serving address leaving
   * the machine while the WSL adapter keeps its own — the founder's PC exactly.
   */
  let interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>;

  const source: InterfaceSource = () => interfaces;

  function waitFor(
    predicate: (snapshot: StateSnapshot) => boolean,
    timeoutMs = 10_000,
  ): Promise<StateSnapshot> {
    return new Promise((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out; last state ${engine.snapshot().session.state}`));
      }, timeoutMs);
      unsubscribe = engine.subscribe((snapshot) => {
        if (!predicate(snapshot)) return;
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        resolve(snapshot);
      });
    });
  }

  const waitForState = (state: SessionState): Promise<StateSnapshot> =>
    waitFor((snapshot) => snapshot.session.state === state);

  beforeEach(async () => {
    receiver = await startFakeReceiver({ durationSec: 90 });
    directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-network-'));
    filePath = path.join(directory, 'Bluey - The Sign.mp4');
    await fs.writeFile(filePath, fixtureMp4());

    interfaces = {
      Ethernet: [ipv4('10.1.1.42')],
      'vEthernet (WSL)': [ipv4('172.24.16.1')],
      'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)],
    };

    mdns = createFakeMdns();
    clock = createShiftingClock();
    engine = createEngine({
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      clock,
      logSink: createMemorySink(),
      logLevel: 'debug',
      transport: tcpTransportFactory,
      mdns,
      mediaPort: 0,
      networkInterfaces: source,
    });
    await engine.start();
    mdns.up({
      id: receiver.device.id,
      friendlyName: receiver.device.friendlyName,
      model: receiver.device.model,
      address: '127.0.0.1',
      port: receiver.port,
    });
  });

  afterEach(async () => {
    await engine.stop();
    await receiver.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  it('blames the unplugged cable rather than the television, and suspends the give-up clock', async () => {
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });
    await waitForState('playing');
    await new Promise((resolve) => setTimeout(resolve, 1_200));
    expect(engine.snapshot().session.flags.networkDown).toBe(false);

    // The cable comes out: the television is unreachable *and* the address we were serving
    // from has gone. The WSL adapter keeps 172.24.16.1, so `addresses.length > 0` is still
    // true — which is the whole trap.
    await receiver.close();
    interfaces = {
      'vEthernet (WSL)': [ipv4('172.24.16.1')],
    };

    const offline = await waitFor((snapshot) => snapshot.session.flags.networkDown, 15_000);
    // 11d: the position is held and the film is still the film. Nothing is said about the
    // television, because the television did nothing.
    expect(offline.session.state).toBe('playing');
    expect(offline.notice).toBeNull();

    // And the give-up clock is suspended: 11c's 30 seconds must not run out on an outage
    // the founder is still in the middle of, or the app accuses the TV of an unplugged
    // cable. This is the assertion that fails without the fix.
    clock.shift(TIMING.reconnectBudgetMs + 10_000);
    await new Promise((resolve) => setTimeout(resolve, 800));
    const still = engine.snapshot();
    expect(still.notice).toBeNull();
    expect(still.session.state).toBe('playing');
    expect(still.session.flags.networkDown).toBe(true);
  }, 40_000);
});
