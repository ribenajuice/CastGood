import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import { runSelftest } from '../../src/engine/selftest/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * Regression tests for three M1 blockers QA found on the walking skeleton's own path.
 *
 * Written by QA against commit d48a239 as failing reproductions, and kept — unchanged in
 * what they assert — now that the defects are fixed. Each one guards a criterion in
 * `docs/PRD.md` that the build silently did not meet, and every one of these failure modes
 * was invisible from a green test suite, which is exactly why they stay.
 *
 * What each one holds in place, and what broke it:
 *
 *  1. **Cast straight after Stop plays again (2c).** `cast()` used to call `release()`
 *     directly, outside the effect queue, so the *previous* stop's queued `release` ran
 *     afterwards and set `device` to null underneath the new session. `connect` threw, the
 *     throw was swallowed into `session.effect_failed`, and the app sat in *Connecting…*
 *     forever with only Cancel to escape. The takeover is now queued behind the old
 *     session's STOP, so the ordering cannot invert — and the previous TV is still
 *     properly released, which simply skipping the stale effect would not have guaranteed.
 *     Under 50 ms on loopback; a full STOP round trip against a real TV.
 *
 *  2. **`--scenario m1` can exit 0 (story 13d, and the PRD's definition of M1 being
 *     done).** `nothingSentBeforeCast` demanded `session.state === 'idle'`, which only the
 *     first scenario ever sees; the rest inherit `stopped`. The founder's one command for
 *     proving M1 works reported failure against perfect hardware. It now asserts what it
 *     always meant: no session is live *and* no device contact was logged between choosing
 *     the file and pressing Cast.
 *
 *  3. **A refused file puts the TV back on its own home screen (3c, 4b, 13e).** Every
 *     failure exit emitted `release` alone, which closes our socket and leaves the Default
 *     Media Receiver running — the founder's TV sitting on the Cast backdrop, and a failed
 *     selftest ending with the device still held. Every exit that can leave the receiver
 *     running now sends the receiver-namespace STOP first.
 */

function createFakeMdns(service: MdnsService | null): Mdns & { up(s: MdnsService): void } {
  const active = new Set<MdnsHandlers>();
  const seen: MdnsService[] = service === null ? [] : [service];
  return {
    browse(handlers) {
      active.add(handlers);
      for (const item of seen) setTimeout(() => handlers.onUp(item), 5);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
    up(item) {
      seen.push(item);
      for (const handlers of [...active]) handlers.onUp(item);
    },
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/** A 90-second MP4 with its moov at the end, like the founder's own file. */
function fixtureMp4(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(90_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(2_048, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

let receiver: FakeReceiver;
let directory: string;
let filePath: string;

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: 900 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-defects-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());
});

afterEach(async () => {
  await receiver.close();
  await fs.rm(directory, { recursive: true, force: true });
});

function service(): MdnsService {
  return {
    id: receiver.device.id,
    friendlyName: 'Family room TV',
    model: 'Chromecast',
    address: '127.0.0.1',
    port: receiver.port,
  };
}

describe('casting again immediately after Stop (criterion 2c)', () => {
  let engine: Engine;
  let sink: ReturnType<typeof createMemorySink>;

  beforeEach(async () => {
    const mdns = createFakeMdns(null);
    sink = createMemorySink();
    engine = createEngine({
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      logSink: sink,
      logLevel: 'debug',
      transport: tcpTransportFactory,
      mdns,
      mediaPort: 0,
    });
    await engine.start();
    mdns.up(service());
  });

  afterEach(async () => {
    await engine.stop();
  });

  function waitFor(predicate: (s: StateSnapshot) => boolean, timeoutMs = 10_000): Promise<void> {
    return new Promise((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      const timer = setTimeout(() => {
        unsubscribe();
        reject(new Error(`timed out; session is "${engine.snapshot().session.state}"`));
      }, timeoutMs);
      unsubscribe = engine.subscribe((snapshot) => {
        if (!predicate(snapshot)) return;
        clearTimeout(timer);
        queueMicrotask(() => unsubscribe());
        resolve();
      });
    });
  }

  it('plays again on one press, with no wait inserted between Stop and Cast', async () => {
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((s) => s.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing');

    engine.dispatch({ type: 'cast.stop' });
    await waitFor((s) => s.session.state === 'stopped');

    // "Casting it again is one click" (2c). A founder pressing Play again does not pause
    // politely for the previous session's effects to drain — so neither does this test.
    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 6_000);

    expect(receiver.launched).toBe(true);
    expect(receiver.playerState).toBe('PLAYING');

    // The observable fingerprint of the original defect, asserted separately so a future
    // timeout failure is not mistaken for an unrelated flake.
    const failures = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((record) => record['event'] === 'session.effect_failed');
    expect(failures).toEqual([]);
  }, 30_000);
});

describe('the selftest scenario that defines "M1 is done" (story 13d)', () => {
  it('exits 0 when every scenario in `m1` ran against a healthy device', async () => {
    const verdict = await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'm1',
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      deviceWaitMs: 5_000,
      positionDurationMs: 1_500,
      unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
    });

    const failed = verdict.assertions.filter((item) => !item.passed);
    expect(
      failed.map((item) => `${item.name}: measured ${String(item.measured)}`),
      'assertions that failed against a device that did everything asked of it',
    ).toEqual([]);
    expect(verdict.exitCode).toBe(0);
  }, 90_000);
});

describe('releasing the device when a file is refused (criteria 3c, 4b, 13e)', () => {
  it('puts the TV back on its own home screen when the device refuses the file', async () => {
    receiver.rejectNextLoad();
    const verdict = await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'cast',
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      deviceWaitMs: 5_000,
      unsafeTestOverrides: { transport: tcpTransportFactory, mdns: createFakeMdns(service()) },
    });

    // Failing the assertions is right; leaving the receiver app running is not.
    expect(verdict.exitCode).toBe(1);
    expect(receiver.playerState).not.toBe('PLAYING');
    expect(
      receiver.launched,
      'the Default Media Receiver is still running on the TV after the run ended',
    ).toBe(false);
    // The receiver-namespace STOP is the message that releases the device; nothing sent it.
    expect(receiver.received.filter((m) => m.type === 'STOP').length).toBeGreaterThan(0);
  }, 60_000);
});
