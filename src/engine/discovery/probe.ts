import net from 'node:net';
import dgram from 'node:dgram';
import { CAST, DISCOVERY } from '../config.js';
import { classifyInterfaces, type InterfaceCandidate } from './interfaces.js';

/**
 * Liveness, decided by TCP rather than by mDNS.
 *
 * A Chromecast listens on port 8009 whenever it is powered on. Opening a TCP connection to
 * it and immediately closing it is therefore a direct question with a direct answer, and
 * the founder's own log says how fast: the two real casts connected in **0.11 s and
 * 0.09 s**. Nothing about it depends on multicast, on which network interface the OS picks
 * for it, or on how often a device feels like re-announcing itself.
 *
 * That last point is why this exists. On the founder's network the mDNS sweep produced no
 * answers at all: devices were only ever heard from when they re-announced themselves,
 * every 60–120 s, against a 25 s expiry. They flapped in and out of the list all evening.
 * Re-browsing was never the right instrument for "is it still there?" — it asks the whole
 * network a question and hopes; this asks one device and is told.
 *
 * mDNS keeps the job it is actually good at: finding devices we do not know about yet, and
 * telling us their names.
 */

export interface ProbeResult {
  readonly alive: boolean;
  readonly elapsedMs: number;
}

/** Injected in tests. The default opens a real socket, because that is the whole point. */
export type DeviceProbe = (address: string, port: number, timeoutMs: number) => Promise<boolean>;

export const tcpProbe: DeviceProbe = (address, port, timeoutMs) =>
  new Promise<boolean>((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect({ host: address, port });
  });

export async function probeDevice(
  address: string,
  probe: DeviceProbe = tcpProbe,
  port: number = CAST.port,
  timeoutMs: number = DISCOVERY.probeTimeoutMs,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  const alive = await probe(address, port, timeoutMs);
  return { alive, elapsedMs: Date.now() - startedAt };
}

/**
 * A one-off diagnostic, written to the log at startup and never used to decide anything.
 *
 * The open question after the first hardware run is why our mDNS queries are never
 * answered while the devices' own announcements arrive fine. The likeliest explanation is
 * that the query leaves by the wrong interface — this machine has WSL's vEthernet
 * alongside the real LAN, and that exact failure is risk #3 in the architecture doc for
 * media URLs. Asking the OS which source address it *would* use for the mDNS group costs
 * nothing (a connected UDP socket sends no packets) and turns the next run's log into an
 * answer instead of an inference.
 */
export interface NetworkDiagnostic {
  /**
   * The source address the OS would use to reach the mDNS multicast group *by default*.
   * On the founder's PC this was WSL's virtual adapter while the TVs were on the LAN —
   * which is why queries now go out of every interface rather than just this one. Kept in
   * the log because it is the number that explains an otherwise baffling discovery time.
   */
  readonly multicastSourceAddress: string | null;
  /** Every IPv4 interface, with the reason for any that will not be queried. */
  readonly interfaces: readonly InterfaceCandidate[];
  /** The addresses a querier will be bound to. Empty means "let the OS choose". */
  readonly queryAddresses: readonly string[];
}

export function describeNetwork(): Promise<NetworkDiagnostic> {
  const interfaces = classifyInterfaces();
  const queryAddresses = interfaces
    .filter((candidate) => candidate.excluded === null)
    .map((candidate) => candidate.address);

  return new Promise<NetworkDiagnostic>((resolve) => {
    const finish = (multicastSourceAddress: string | null): void =>
      resolve({ multicastSourceAddress, interfaces, queryAddresses });
    let socket: dgram.Socket;
    try {
      socket = dgram.createSocket('udp4');
    } catch {
      finish(null);
      return;
    }
    // A diagnostic must never be able to delay or break startup.
    const timer = setTimeout(() => {
      try {
        socket.close();
      } catch {
        /* already closed */
      }
      finish(null);
    }, 500);
    timer.unref?.();

    socket.once('error', () => {
      clearTimeout(timer);
      finish(null);
    });
    try {
      // `connect` on a UDP socket sends nothing; it only asks the routing table which
      // local address would be used. Same principle as reading `localAddress` off the
      // Cast socket, which is how the media URL avoids guessing an interface.
      socket.connect(5353, '224.0.0.251', () => {
        clearTimeout(timer);
        let address: string | null;
        try {
          address = socket.address().address;
        } catch {
          address = null;
        }
        try {
          socket.close();
        } catch {
          /* already closed */
        }
        finish(address);
      });
    } catch {
      clearTimeout(timer);
      finish(null);
    }
  });
}
