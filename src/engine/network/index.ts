import os from 'node:os';
import type { Clock, Logger } from '../logging/index.js';
import { TIMING } from '../config.js';
import { classifyInterfaces, type InterfaceSource } from '../discovery/interfaces.js';

/**
 * Does this PC still have a network, and is it still the *same* one?
 *
 * PRD 11d is about the founder's own machine dropping off the network — wifi switched
 * off, a cable pulled, a laptop moved — as distinct from the television going quiet. The
 * two look identical from a dead socket, and they need opposite screens: one says
 * "Reconnecting to \<name\>…", the other says "This PC has lost its network
 * connection" and greys the controls, because there is nothing to reconnect *over*.
 *
 * Two signals, and the second is the one that actually works on the founder's machine:
 *
 *  1. **No usable IPv4 address anywhere.** The blunt case: everything is off.
 *  2. **The address we were serving from has gone.** The founder's PC has three
 *     interfaces and two of them are virtual — `vEthernet (WSL)` keeps its 172.24.16.1
 *     whether or not the Ethernet the televisions live on is plugged in. So "some
 *     interface still has an address" is not the question. The question is whether the
 *     address the OS chose to reach *this* device still exists, and that comes from the
 *     live Cast socket (`connection.localAddress`), never from a guess about which
 *     adapter matters.
 *
 * Signal 2 is why nothing here names an adapter. The founder's ruling of 2026-08-14
 * stands: no code chooses an interface, because any such rule is a different guess that
 * breaks on someone else's machine.
 */

export interface NetworkState {
  /**
   * Every IPv4 address the discovery filter considers *usable* — outward-facing, not
   * loopback, not link-local. This is the set that answers "where could we reach a
   * television from?", and it is what decides `up`.
   */
  readonly addresses: readonly string[];
  /**
   * Every IPv4 address on the machine, **unfiltered** — loopback and link-local included.
   *
   * This answers a different question, and conflating the two is a bug we have already
   * made once: "which interfaces should multicast go out of?" is not "does this address
   * still exist?". The serving address comes from the live Cast socket, and the OS is
   * perfectly entitled to have chosen one the discovery filter excludes — 127.0.0.1 when
   * the receiver is local, for instance. Asking the *filtered* list whether the serving
   * address survived declared the PC offline while it was streaming perfectly well.
   */
  readonly allAddresses: readonly string[];
  /** False when there is no usable IPv4 address at all: the machine is plainly offline. */
  readonly up: boolean;
}

export interface NetworkWatcher {
  start(): void;
  stop(): void;
  readonly state: NetworkState;
  /**
   * True when this exact local address is still on *any* interface.
   *
   * Deliberately asked of the unfiltered set — see `allAddresses`.
   */
  has(address: string): boolean;
  /** Re-reads the interfaces now rather than waiting for the next tick. */
  poll(): NetworkState;
}

export interface NetworkWatcherDeps {
  logger: Logger;
  clock?: Clock;
  /** Injected by tests; `os.networkInterfaces()` in the app. */
  interfaces?: InterfaceSource;
  /** Fires only when the usable address set actually changes. */
  onChanged(state: NetworkState): void;
}

function read(source: InterfaceSource): NetworkState {
  const candidates = classifyInterfaces(source);
  const addresses = candidates
    .filter((candidate) => candidate.excluded === null)
    .map((candidate) => candidate.address);
  // `not-ipv4` is the one exclusion that really does mean "not an address we could ever be
  // serving from"; `internal` and `link-local` are perfectly real addresses that the
  // discovery filter simply does not want to send multicast out of.
  const allAddresses = candidates
    .filter((candidate) => candidate.excluded !== 'not-ipv4')
    .map((candidate) => candidate.address);
  return { addresses, allAddresses, up: addresses.length > 0 };
}

function same(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
}

export function createNetworkWatcher(deps: NetworkWatcherDeps): NetworkWatcher {
  const logger = deps.logger.child({ component: 'network' });
  const source: InterfaceSource = deps.interfaces ?? os.networkInterfaces;
  let state: NetworkState = read(source);
  let timer: NodeJS.Timeout | null = null;

  function poll(): NetworkState {
    const next = read(source);
    // Both lists matter. A change confined to `allAddresses` — loopback appearing or
    // going — still moves the answer to "is the address we are serving from still here?",
    // so comparing only the usable set would sit on it until something else changed.
    if (same(next.addresses, state.addresses) && same(next.allAddresses, state.allAddresses)) {
      return state;
    }
    const previous = state;
    state = next;
    logger.info('network.changed', {
      up: next.up,
      addresses: next.addresses,
      allAddresses: next.allAddresses,
      lost: previous.addresses.filter((address) => !next.addresses.includes(address)),
      gained: next.addresses.filter((address) => !previous.addresses.includes(address)),
    });
    deps.onChanged(next);
    return next;
  }

  return {
    start() {
      if (timer !== null) return;
      // Two seconds: fast enough that a blip is noticed well inside the PRD's 30 s
      // patience, slow enough that reading the interface table is free.
      timer = setInterval(poll, TIMING.interfaceWatchMs);
      timer.unref?.();
    },
    stop() {
      if (timer !== null) clearInterval(timer);
      timer = null;
    },
    get state() {
      return state;
    },
    has: (address) => state.allAddresses.includes(address),
    poll,
  };
}
