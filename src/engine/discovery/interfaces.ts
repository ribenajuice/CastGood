import os from 'node:os';

/**
 * Which network interfaces to send mDNS queries out of.
 *
 * The first hardware run showed Windows choosing WSL's `vEthernet (WSL)` adapter
 * (172.24.16.1) as the source for the multicast group, while the TVs were on the LAN
 * (192.0.2.230). Answers arrived only when a device happened to re-announce itself, and
 * the founder's requirement rules out fixing that with a better guess:
 *
 *   > "If I want to be able to run this on any computer, nothing can be hard coded…
 *   >  some people might be on Wifi, some on ethernet etc."
 *
 * So there is **no rule that picks an interface**. We query out of every plausible one and
 * let the answers come back from wherever the devices actually are. An interface with no
 * Chromecasts on it costs one socket and a packet every few seconds; an interface wrongly
 * left out costs the founder their device list.
 *
 * The only exclusions are structural facts, not judgements about what an adapter is *for*:
 *
 *  - **not IPv4** — the media URL and the Cast port are IPv4 (receivers need an IP literal).
 *  - **internal** — loopback. `os` tells us this outright.
 *  - **link-local (169.254/16)** — an adapter that failed to get an address. It is not on a
 *    network, so there is nothing there to find.
 *
 * There is deliberately **no name-based exclusion list** for the WSL/VirtualBox/VMware
 * family. It was considered and rejected: including a virtual adapter is harmless (nothing
 * on it answers as a Chromecast), while a name pattern that accidentally matches a real
 * adapter is exactly the "hard coded" failure the founder ruled out. Cheap to be wrong in
 * the harmless direction; expensive to be wrong in the other.
 */

export type ExclusionReason = 'not-ipv4' | 'internal' | 'link-local';

export interface InterfaceCandidate {
  readonly name: string;
  readonly address: string;
  readonly netmask: string;
  /** `null` when the interface is selected for querying. */
  readonly excluded: ExclusionReason | null;
}

/** Injected by tests; `os.networkInterfaces()` in the app. */
export type InterfaceSource = () => NodeJS.Dict<os.NetworkInterfaceInfo[]>;

export function classifyInterfaces(
  source: InterfaceSource = os.networkInterfaces,
): readonly InterfaceCandidate[] {
  const candidates: InterfaceCandidate[] = [];

  for (const [name, entries] of Object.entries(source())) {
    for (const entry of entries ?? []) {
      // Node reports `family` as 'IPv4' on current versions and 4 on some older ones.
      const isIpv4 = entry.family === 'IPv4' || (entry.family as unknown as number) === 4;
      const excluded: ExclusionReason | null = !isIpv4
        ? 'not-ipv4'
        : entry.internal
          ? 'internal'
          : entry.address.startsWith('169.254.')
            ? 'link-local'
            : null;
      candidates.push({ name, address: entry.address, netmask: entry.netmask, excluded });
    }
  }

  return candidates;
}

/**
 * The addresses to bind a querier to, or an empty list meaning "let the OS decide".
 *
 * An empty result is a real outcome, not an error: on a machine where every interface is
 * excluded, one arbitrary interface still beats discovering nothing at all, so the caller
 * falls back to the default behaviour rather than giving up.
 */
export function selectQueryInterfaces(
  source: InterfaceSource = os.networkInterfaces,
): readonly string[] {
  return classifyInterfaces(source)
    .filter((candidate) => candidate.excluded === null)
    .map((candidate) => candidate.address);
}
