/**
 * Two failing reproductions found while walking the M5a diff for 23j.
 * Copy to test/engine/ to run: `npx vitest run test/engine/m5a-review-repro.test.ts`.
 *
 *  R1 — a mute press parked behind an unanswered command survives the session and is
 *       delivered to the NEXT one (`forgetVolume` never clears `pendingMute`).
 *  R2 — a drag against a television that answers nothing puts 7 SET_VOLUMEs on the wire,
 *       all still outstanding (23a: "never more than one on the wire").
 */
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

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
  mvhd.writeUInt32BE(7_200_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

let receiver: FakeReceiver;
let engine: Engine;
let mdns: FakeMdns;
let directory: string;
let filePath: string;

function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<StateSnapshot> {
  return new Promise((resolve, reject) => {
    if (predicate(engine.snapshot())) {
      resolve(engine.snapshot());
      return;
    }
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for a snapshot'));
    }, timeoutMs);
    unsubscribe = engine.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      resolve(snapshot);
    });
  });
}

const waitForState = (state: SessionState, timeoutMs = 10_000): Promise<StateSnapshot> =>
  waitFor((snapshot) => snapshot.session.state === state, timeoutMs);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

function volumeAsks(): { level?: number; muted?: boolean }[] {
  return receiver.received
    .filter((message) => message.type === 'SET_VOLUME')
    .map((message) => (message.payload['volume'] ?? {}) as { level?: number; muted?: boolean });
}

const level = (): number | null => engine.snapshot().session.volume?.level ?? null;

async function castAndPlay(): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filePath });
  await waitFor((snapshot) => snapshot.file !== null);
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitForState('playing');
  await waitFor((snapshot) => snapshot.session.durationSec > 0);
}

async function start(options: Parameters<typeof startFakeReceiver>[0] = {}): Promise<void> {
  receiver = await startFakeReceiver({ durationSec: 7_200, startupMs: 10, ...options });
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-m5a-review-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());
  mdns = createFakeMdns();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    logSink: createMemorySink(),
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
  });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fs.rm(directory, { recursive: true, force: true });
});

describe('M5a review reproductions', () => {
  it('R1: a mute pressed in one session must not be delivered to the next', async () => {
    await start({ volumeLevel: 0.5 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.5);

    // A level goes on the wire and the television answers nothing; a mute parks behind it.
    receiver.swallow('SET_VOLUME');
    engine.dispatch({ type: 'volume.set', level: 0.4 });
    await sleep(150);
    engine.dispatch({ type: 'volume.mute', muted: true });
    await sleep(50);
    // ...and the founder stops the film before the television ever answers.
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    receiver.unswallow('SET_VOLUME');
    await sleep(1_200);
    const afterStop = volumeAsks().length;

    // A brand new session, and one level change in it.
    engine.dispatch({ type: 'cast.start' });
    await waitForState('playing');
    await sleep(300);
    engine.dispatch({ type: 'volume.set', level: 0.6 });
    await sleep(1_500);

    const asks = volumeAsks().slice(afterStop);
    // Observed today: [{"level":0.6},{"muted":true}] — the new film is muted by a press
    // the founder made against the previous one.
    expect(asks.some((ask) => ask.muted === true)).toBe(false);
    expect(receiver.volume.muted).toBe(false);
  }, 40_000);

  it('R2: a drag on a silent television keeps one command on the wire', async () => {
    await start({ volumeLevel: 0.5 });
    await engine.start();
    await castAndPlay();
    await waitFor(() => level() === 0.5);

    receiver.swallow('SET_VOLUME');
    const before = volumeAsks().length;
    for (let index = 0; index < 30; index += 1) {
      engine.dispatch({ type: 'volume.set', level: 0.2 + index * 0.01 });
      await sleep(100);
    }
    // Nothing was answered, so everything sent inside the last 5 s is still outstanding.
    // Observed today: 7.
    expect(volumeAsks().length - before).toBeLessThanOrEqual(2);
  }, 40_000);
});
