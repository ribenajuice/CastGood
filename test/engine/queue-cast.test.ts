import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/engine/index.js';
import { createMemorySink, createTestClock } from '../../src/engine/logging/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver } from './fake-receiver/index.js';

/**
 * **24e/24ab: casting the first item of a queue has to actually mark it as playing.**
 *
 * Until now, nothing dispatched `queue.add` and `cast.start` against a real engine
 * together, so nothing caught that `queue.playingId` was never being set at all —
 * `startCast` had no matching logic for it. The renderer's own `canRemove: item.id !==
 * playingId` (`view-model.ts`) was therefore always `true` for every row, including the one
 * actually on the television: 24e's *"the playing item carries no Remove"* has never been
 * enforced.
 */

function createFakeMdns(service: MdnsService): Mdns {
  const active = new Set<MdnsHandlers>();
  return {
    browse(handlers) {
      active.add(handlers);
      setTimeout(() => handlers.onUp(service), 5);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
  };
}

describe('casting the first item of a queue (24e, 24ab)', () => {
  it('sets queue.playingId to the row that was cast', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-queue-cast-'));
    const item1Dir = path.join(directory, 'Cars (2006)');
    await fs.mkdir(item1Dir, { recursive: true });
    const item1Path = path.join(item1Dir, 'Cars.mp4');
    const item2Path = path.join(directory, 'Ice Road Vengeance.mkv');
    await fs.writeFile(item1Path, Buffer.alloc(1024, 1));
    await fs.writeFile(item2Path, Buffer.alloc(1024, 2));

    const receiver = await startFakeReceiver({ durationSec: 6990 });
    const sink = createMemorySink();
    const engine = createEngine({
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      logSink: sink,
      clock: createTestClock(Date.UTC(2026, 7, 13), 0),
      mdns: createFakeMdns({
        id: receiver.device.id,
        friendlyName: 'Home Theatre TV',
        model: 'Chromecast',
        address: '127.0.0.1',
        port: receiver.port,
      }),
      transport: tcpTransportFactory,
      mediaPort: 0,
    });

    try {
      await engine.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const deviceId = engine.snapshot().discovery.devices[0]?.id;
      expect(deviceId).toBeDefined();

      engine.dispatch({ type: 'device.select', deviceId: deviceId! });
      engine.dispatch({ type: 'queue.add', paths: [item1Path, item2Path] });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(engine.snapshot().queue.items).toHaveLength(2);
      const firstItemId = engine.snapshot().queue.items[0]?.id;

      engine.dispatch({ type: 'file.select', path: item1Path });
      await new Promise((resolve) => setTimeout(resolve, 100));

      engine.dispatch({ type: 'cast.start' });
      let tries = 0;
      while (engine.snapshot().session.state !== 'playing' && tries < 50) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        tries += 1;
      }
      expect(engine.snapshot().session.state).toBe('playing');
      expect(engine.snapshot().queue.playingId).toBe(firstItemId);

      // Give any further, delayed onSessionChanged a chance to fire and confirm it holds.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(engine.snapshot().queue.playingId).toBe(firstItemId);
    } finally {
      await engine.stop();
      await receiver.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it('clears playingId once the session genuinely ends', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-queue-cast-'));
    const item1Path = path.join(directory, 'one.mp4');
    await fs.writeFile(item1Path, Buffer.alloc(1024, 1));

    const receiver = await startFakeReceiver({ durationSec: 6990 });
    const sink = createMemorySink();
    const engine = createEngine({
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      logSink: sink,
      clock: createTestClock(Date.UTC(2026, 7, 13), 0),
      mdns: createFakeMdns({
        id: receiver.device.id,
        friendlyName: 'Home Theatre TV',
        model: 'Chromecast',
        address: '127.0.0.1',
        port: receiver.port,
      }),
      transport: tcpTransportFactory,
      mediaPort: 0,
    });

    try {
      await engine.start();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const deviceId = engine.snapshot().discovery.devices[0]?.id;
      engine.dispatch({ type: 'device.select', deviceId: deviceId! });
      engine.dispatch({ type: 'queue.add', paths: [item1Path] });
      engine.dispatch({ type: 'file.select', path: item1Path });
      await new Promise((resolve) => setTimeout(resolve, 100));
      engine.dispatch({ type: 'cast.start' });
      let tries = 0;
      while (engine.snapshot().session.state !== 'playing' && tries < 50) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        tries += 1;
      }
      expect(engine.snapshot().queue.playingId).not.toBeNull();

      engine.dispatch({ type: 'cast.stop' });
      tries = 0;
      while (engine.snapshot().session.state !== 'stopped' && tries < 50) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        tries += 1;
      }
      expect(engine.snapshot().session.state).toBe('stopped');
      expect(engine.snapshot().queue.playingId).toBeNull();
    } finally {
      await engine.stop();
      await receiver.close();
      await fs.rm(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
