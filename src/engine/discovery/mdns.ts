import net from 'node:net';
import { Bonjour } from 'bonjour-service';
import type { Service } from 'bonjour-service';
import { CAST } from '../config.js';
import { selectQueryInterfaces } from './interfaces.js';

/**
 * The mDNS adapter: `bonjour-service` in, plain data out.
 *
 * Discovery's *rules* (when a device appears, when it leaves, what it is called) are
 * pure logic in `registry.ts`. This file is the only place that knows a multicast
 * socket exists, which is what lets the rules be tested in WSL — where multicast does
 * not work and never will.
 *
 * Reading the TXT record is where story 1c is won: `fn=` is the name the founder gave
 * the TV in the Google Home app. We fall back to the service name only if a device
 * publishes no `fn`, and never to an IP or a model code.
 *
 * **One querier per interface.** A single querier sends its queries out of whichever
 * interface the OS picks for the multicast group, and on the founder's PC that is WSL's
 * virtual adapter rather than the LAN the TVs are on — so queries went somewhere with no
 * Chromecasts on it and we heard devices only when they re-announced themselves. Rather
 * than guessing a better interface (which breaks on the next machine), we bind a querier
 * to every plausible one and let the answers arrive from wherever the devices are.
 *
 * `multicast-dns` takes an `interface` address and calls `setMulticastInterface()` with it;
 * `bonjour-service` passes its constructor options straight through. Sockets bind with
 * `reuseAddr`, and each is on a distinct local address, so several on port 5353 coexist.
 * Every instance is independent: one that fails to bind is logged and skipped, and the
 * default instance alone still behaves exactly as it did before.
 */

export interface MdnsService {
  /** TXT `id=` — stable across IP changes, which the fqdn is not. */
  readonly id: string;
  readonly friendlyName: string;
  readonly model: string;
  readonly address: string;
  readonly port: number;
}

export interface MdnsHandlers {
  onUp(service: MdnsService): void;
  /** A goodbye packet or a TTL expiry from the mDNS layer itself. */
  onDown(service: MdnsService): void;
  onError(error: Error): void;
}

export interface MdnsBrowse {
  stop(): void;
}

export interface Mdns {
  /**
   * Starts a browse of `_googlecast._tcp.local` on every querier. A device reachable from
   * more than one interface answers more than once; the registry keys on the TXT `id`, so
   * the duplicates collapse and cost nothing.
   */
  browse(handlers: MdnsHandlers): MdnsBrowse;
  /**
   * Which interfaces ended up being queried. Diagnostics only — nothing decides anything
   * from it, and it is optional so the scripted responders in the tests need not pretend
   * to have interfaces.
   */
  queryAddresses?(): readonly string[];
  destroy(): Promise<void>;
}

function txtValue(txt: unknown, key: string): string | null {
  if (typeof txt !== 'object' || txt === null) return null;
  const value = (txt as Record<string, unknown>)[key];
  if (typeof value === 'string') return value.length === 0 ? null : value;
  if (Buffer.isBuffer(value)) {
    const decoded = value.toString('utf8');
    return decoded.length === 0 ? null : decoded;
  }
  return null;
}

/** IPv4 only: the Default Media Receiver is handed an IP literal, and v6 has bitten others. */
function pickAddress(service: Service): string | null {
  const addresses = service.addresses ?? [];
  const v4 = addresses.find((address) => net.isIPv4(address));
  if (v4 !== undefined) return v4;
  const referer = service.referer?.address;
  if (referer !== undefined && net.isIPv4(referer)) return referer;
  return null;
}

export function toMdnsService(service: Service): MdnsService | null {
  const address = pickAddress(service);
  if (address === null) return null;
  const id = txtValue(service.txt, 'id') ?? service.fqdn;
  const friendlyName = txtValue(service.txt, 'fn') ?? service.name;
  if (friendlyName === undefined || friendlyName === '') return null;
  return {
    id,
    friendlyName,
    model: txtValue(service.txt, 'md') ?? 'Unknown',
    address,
    port: service.port > 0 ? service.port : CAST.port,
  };
}

/**
 * `bonjour-service` types its constructor options as `Partial<ServiceConfig>`, which does
 * not mention `interface` — but it hands the whole object to `multicast-dns`, which does.
 * Naming the extra field here keeps the cast honest and in one place.
 */
type MdnsOptions = ConstructorParameters<typeof Bonjour>[0] & { interface?: string };

export interface BonjourMdnsDeps {
  /** Reports each querier as it is created, or fails to be. Diagnostics only. */
  onQuerier?(info: { address: string | null; ok: boolean; error?: unknown }): void;
  /** Injected by tests. Defaults to the real interface list. */
  addresses?: readonly string[];
}

/** The real adapter: one querier per plausible interface, plus the OS default. */
export function createBonjourMdns(deps: BonjourMdnsDeps = {}): Mdns {
  let instances: { address: string | null; bonjour: Bonjour }[] | null = null;

  const build = (handlers: MdnsHandlers): { address: string | null; bonjour: Bonjour }[] => {
    if (instances !== null) return instances;
    const onError = (error: unknown): void => {
      handlers.onError(error instanceof Error ? error : new Error(String(error)));
    };
    const created: { address: string | null; bonjour: Bonjour }[] = [];

    const add = (address: string | null): void => {
      try {
        const options: MdnsOptions = address === null ? {} : { interface: address };
        created.push({ address, bonjour: new Bonjour(options, onError) });
        deps.onQuerier?.({ address, ok: true });
      } catch (error) {
        // One interface that will not bind must never cost us the others.
        deps.onQuerier?.({ address, ok: false, error });
      }
    };

    // The default querier: binds 0.0.0.0 and joins the group on every interface, which is
    // what has always heard the devices' own announcements. It stays exactly as it was.
    add(null);

    const addresses = deps.addresses ?? selectQueryInterfaces();
    for (const address of addresses) add(address);

    instances = created;
    return created;
  };

  return {
    browse(handlers) {
      const browsers = build(handlers).map(({ bonjour }) => {
        const browser = bonjour.find({ type: CAST.serviceType, protocol: 'tcp' });
        const up = (service: Service): void => {
          const mapped = toMdnsService(service);
          if (mapped !== null) handlers.onUp(mapped);
        };
        browser.on('up', up);
        browser.on('srv-update', up);
        browser.on('txt-update', up);
        browser.on('down', (service: Service) => {
          const mapped = toMdnsService(service);
          if (mapped !== null) handlers.onDown(mapped);
        });
        return browser;
      });
      return {
        stop: () => {
          for (const browser of browsers) browser.stop();
        },
      };
    },

    queryAddresses: () =>
      (instances ?? [])
        .map((instance) => instance.address)
        .filter((address): address is string => address !== null),

    destroy() {
      const current = instances ?? [];
      instances = null;
      return Promise.all(
        current.map(
          ({ bonjour }) =>
            new Promise<void>((resolve) => {
              try {
                bonjour.destroy(() => resolve());
              } catch {
                resolve();
              }
            }),
        ),
      ).then(() => undefined);
    },
  };
}
