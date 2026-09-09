import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCastClient, tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { MediaStatus, ReceiverStatus } from '../../src/engine/cast/index.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import { TIMING } from '../../src/engine/config.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * The heartbeat: how long a silent socket takes to be declared dead.
 *
 * `config.ts` promises "two missed PONGs (10 s)", and the implementation took 15 — it
 * counted a ping before sending it and waited a whole interval before the first one. This
 * path had no test at all until the fake receiver learned to swallow a PING, which is the
 * only way to simulate a device that is still connected but no longer answering.
 *
 * The interval is injected so the arithmetic is checked in a fifth of a second rather than
 * in ten. What is under test is the *count* of unanswered pings, not the wall time.
 */

const BEAT_MS = 50;

let receiver: FakeReceiver;
let sink: ReturnType<typeof createMemorySink>;

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: 90 });
  sink = createMemorySink();
});

afterEach(async () => {
  await receiver.close();
});

function connect(events: {
  onDisconnected(info: { reason: string; deviceInitiated: boolean }): void;
}): Promise<Awaited<ReturnType<ReturnType<typeof createCastClient>['connect']>>> {
  const client = createCastClient({
    logger: createLogger({ sink, level: 'debug' }),
    transport: tcpTransportFactory,
    heartbeatIntervalMs: BEAT_MS,
  });
  return client.connect(receiver.device, {
    onMediaStatus: (_status: MediaStatus) => undefined,
    onReceiverStatus: (_status: ReceiverStatus) => undefined,
    onDisconnected: events.onDisconnected,
  });
}

describe('heartbeat', () => {
  it('declares a socket dead after exactly two unanswered pings', async () => {
    receiver.swallow('PING');
    // `performance.now()` and not `Date.now()`: this machine's wall clock steps backwards
    // by ~2.4 s every 30 s, which once measured a socket as having died 2,303 ms *before*
    // the test started it. Elapsed time is the question, so ask something monotonic.
    const startedAt = performance.now();
    let reason: string | null = null;
    let deviceInitiated: boolean | null = null;

    const closed = new Promise<void>((resolve) => {
      void connect({
        onDisconnected: (info) => {
          reason = info.reason;
          deviceInitiated = info.deviceInitiated;
          resolve();
        },
      });
    });
    await closed;

    const elapsed = performance.now() - startedAt;
    // First ping goes immediately, the second one interval later, and the check on the
    // interval after that finds two outstanding: dead at 2 × the interval, not 3 ×.
    expect(elapsed).toBeGreaterThanOrEqual(BEAT_MS * TIMING.pingMissesBeforeDead);
    expect(elapsed).toBeLessThan(BEAT_MS * (TIMING.pingMissesBeforeDead + 1.5));
    expect(reason).toContain('PONG');
    // A socket that stopped answering is a failure, not an orderly close.
    expect(deviceInitiated).toBe(false);
    // The real interval keeps the promise config.ts makes.
    expect(TIMING.pingIntervalMs * TIMING.pingMissesBeforeDead).toBe(10_000);
  }, 10_000);

  it('stays up while the device answers', async () => {
    let dropped: string | null = null;
    const connection = await connect({ onDisconnected: (info) => (dropped = info.reason) });

    await new Promise((resolve) => setTimeout(resolve, BEAT_MS * 6));
    expect(dropped).toBeNull();
    expect(receiver.countOf('PING')).toBeGreaterThan(2);

    await connection.close();
  }, 10_000);
});
