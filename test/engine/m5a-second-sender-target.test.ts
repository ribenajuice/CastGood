import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSelftest } from '../../src/engine/selftest/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * The 23c leg spends its full wait when the second sender is pointed elsewhere, and a
 * timeout is a worse verdict than a failed assertion: it says nothing about which
 * television was moved. This is sized so the run always reaches its verdict.
 *
 * ⚠️ It is a named constant rather than a literal with a comment above it because a
 * comment between a closing `}` and `it()`'s trailing timeout argument has nowhere
 * stable to sit — Prettier rewrote it into a different order on every run and never
 * converged, which failed `format:check` on a file that had just been formatted.
 */
const REACHES_ITS_VERDICT_MS = 120_000;

/**
 * **23c's second sender has to reach the television under test, and nothing else.**
 *
 * On 2026-09-08 the `volume` scenario read 10/11 on the `Home Theatre TV`, with
 * `deviceSideChangeShownMs` null, and it had done the same on the `Family room TV` the day
 * before. Both were written up as the app failing to notice a change made from another
 * sender. **The app was innocent in both cases.**
 *
 * The selftest resolved the address for its second connection out of the engine's log as
 * `records().filter(event === 'discovery.device_found').at(-1)` — *the last device
 * discovery happened to find*, not the one named on the command line. In this household
 * that is three Chromecasts answering mDNS within 60 ms of each other, so the leg opened a
 * connection to **a different television**, moved that set's volume, correctly confirmed
 * that set had moved, and reported success — while the app, watching the set under test,
 * correctly reported no change. The engine's own log proves it: the run targeted
 * `10.1.1.54` and the second sender had been handed `10.1.1.193`.
 *
 * Two things were wrong at once, and this file grades both:
 *
 *  1. **The measurement was of the wrong television**, so 23c could never pass except by
 *     the luck of discovery order — which is also why it *did* pass once.
 *  2. **An unrelated set was left at whatever level the leg chose**, which 13e forbids for
 *     the device under test and nobody had thought to forbid for a device that was never
 *     supposed to be touched at all.
 *
 * The decoy here answers mDNS *after* the device under test, because that is the ordering
 * that makes `.at(-1)` wrong. Reverting the resolver to `.at(-1)` fails both assertions.
 */

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

function fixtureMp4(durationSec: number): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(durationSec * 1_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 3)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

/**
 * Two televisions, the decoy announced second.
 *
 * The delay is what reproduces the defect: a resolver that takes the newest
 * `discovery.device_found` line ends up holding the decoy's address, exactly as it did on
 * the founder's network.
 */
function createTwoDeviceMdns(underTest: MdnsService, decoy: MdnsService): Mdns {
  const active = new Set<MdnsHandlers>();
  return {
    browse(handlers) {
      active.add(handlers);
      // **One sweep, both sets, the decoy answering last.** Announcing the decoy on a
      // later timer did not reproduce anything: the address is resolved the moment the
      // *named* device is found, so a decoy arriving 20 ms later was not yet in the log and
      // `.at(-1)` was right by accident. The founder's own network logged its three
      // televisions at mono 124, 125 and 181 — one sweep — which is this.
      setTimeout(() => {
        handlers.onUp(underTest);
        handlers.onUp(decoy);
      }, 5);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
  };
}

describe('the second sender 23c opens', () => {
  it(
    'reaches the television under test, and leaves every other set alone',
    async () => {
      const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-23c-target-'));
      const films = path.join(directory, 'Films');
      await fs.mkdir(films, { recursive: true });
      const filePath = path.join(films, 'Cars.mp4');
      await fs.writeFile(filePath, fixtureMp4(3_000));

      const underTest: FakeReceiver = await startFakeReceiver({ durationSec: 3_000 });
      // **The decoy never casts anything.** It exists only to answer mDNS last and to be
      // asked, by a leg that should never have found it, to change its volume. Its level
      // starts somewhere unmistakable so a stray `SET_VOLUME` cannot hide in the noise.
      const decoy: FakeReceiver = await startFakeReceiver({
        durationSec: 3_000,
        volumeLevel: 0.77,
      });
      const decoyLevelBefore = decoy.volume.level;

      try {
        const verdict = await runSelftest({
          deviceName: 'Family room TV',
          filePath,
          scenario: 'volume',
          paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
          deviceWaitMs: 5_000,
          unsafeTestOverrides: {
            transport: tcpTransportFactory,
            mdns: createTwoDeviceMdns(
              {
                id: underTest.device.id,
                friendlyName: 'Family room TV',
                model: 'Chromecast',
                address: '127.0.0.1',
                port: underTest.port,
              },
              {
                // ⚠️ **A distinct id, written out rather than read off the receiver.**
                // Every `startFakeReceiver` reports the same hard-coded `fake-device-1`, so
                // announcing the decoy under its own id made the registry treat it as an
                // *update* of the set under test — one `device_found` line, `.at(-1)` right
                // by accident, and this test passed with the defect reinstated. Two
                // televisions have to be two devices for the ordering to mean anything.
                id: 'fake-device-2-decoy',
                friendlyName: 'Master bedroom TV',
                model: 'Chromecast',
                address: '127.0.0.1',
                port: decoy.port,
              },
            ),
          },
        });

        // The run has to have *happened*: an abort would be exit 2, and a 23c that could
        // not be produced is precisely the outcome this defect used to hide behind.
        expect(verdict.reason, `the run aborted: ${verdict.reason ?? ''}`).toBeNull();

        const shown = verdict.assertions.find((item) => item.name === 'deviceSideChangeShownMs');
        expect(shown, 'the volume scenario reported no deviceSideChangeShownMs').toBeDefined();
        // ⚠️ Graded on the *measurement*, not only on `passed`. A null that happens to sit
        // beside `passed: false` is the same non-answer the hardware runs kept producing.
        expect(
          shown?.measured,
          '23c measured nothing: the second sender did not reach the set under test',
        ).not.toBeNull();
        expect(shown?.passed, '23c did not pass against the set under test').toBe(true);

        // **And the set nobody named was never touched.** This is the half that made the
        // defect expensive rather than merely wrong.
        expect(
          decoy.volume.level,
          'a television that was never under test had its volume changed',
        ).toBe(decoyLevelBefore);
        expect(decoy.countOf('SET_VOLUME'), 'the decoy was sent a SET_VOLUME').toBe(0);
      } finally {
        await underTest.close();
        await decoy.close();
        await fs.rm(directory, { recursive: true, force: true });
      }
    },
    REACHES_ITS_VERDICT_MS,
  );
});
