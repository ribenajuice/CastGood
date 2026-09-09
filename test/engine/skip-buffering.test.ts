import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  runSelftest,
  type Assertion,
  type SelftestVerdict,
} from '../../src/engine/selftest/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver } from './fake-receiver/index.js';

/**
 * **A television that buffers after a jump, and what 6f is allowed to say about it.**
 *
 * `skip.singleSkipStateUnchanged` read `session.state` in the tick the device first
 * reported the *new position*. A real receiver publishes the new position and `BUFFERING`
 * in the same breath — it has to go and fetch the region it jumped to — so the assertion
 * was a race between two facts that arrive together. It won that race on the two
 * televisions it was written against and lost it on a third: `m2` on the Master bedroom
 * Chromecast measured `buffering` on 2026-08-25 in three consecutive runs, on `main` (D1,
 * no M3b) as well as on `feat/m3b-head-start`. Nothing in the product had changed; the
 * bedroom set simply takes 0.5–2.7 s to come back to `PLAYING` after a jump.
 *
 * The scripted receiver could not express that condition, because `bufferMs` defaults to
 * **0** and a fake that teleports instantly is kinder than every television in the house.
 * So the leg went green headlessly for the same reason it went green on hardware: the
 * condition was never produced. This file produces it.
 *
 * What is graded here is the *instrument*, not the product: given a device that really does
 * buffer after a jump, does `skip` still report the truth about criterion 6f?
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

const FEATURE_LENGTH_SEC = 3_000;

/**
 * How long the scripted television buffers after a jump.
 *
 * Between the two numbers this television really produced (0.46 s and 2.69 s on
 * 2026-08-25) and comfortably longer than one position poll, so the tick that first
 * reports the new position reports `BUFFERING` with it — which is the condition, not a
 * coincidence of scheduling.
 */
const SEEK_BUFFER_MS = 1_500;

async function runSkip(seekBufferMs: number): Promise<SelftestVerdict> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-skipbuf-'));
  const filePath = path.join(directory, 'Cars.mp4');
  await fs.writeFile(filePath, fixtureMp4(FEATURE_LENGTH_SEC));
  const receiver = await startFakeReceiver({ durationSec: FEATURE_LENGTH_SEC });
  receiver.setSeekBehaviour({ bufferMs: seekBufferMs });
  try {
    return await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'skip',
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      deviceWaitMs: 5_000,
      unsafeTestOverrides: {
        transport: tcpTransportFactory,
        mdns: createFakeMdns({
          id: receiver.device.id,
          friendlyName: 'Family room TV',
          model: 'Chromecast',
          address: '127.0.0.1',
          port: receiver.port,
        }),
      },
    });
  } finally {
    await receiver.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function must(verdict: SelftestVerdict, name: string): Assertion {
  const found = [...verdict.assertions, ...verdict.observations].find((item) => item.name === name);
  expect(
    found,
    `skip reported no line called "${name}"; it reported: ${[
      ...verdict.assertions,
      ...verdict.observations,
    ]
      .map((item) => item.name)
      .join(', ')}`,
  ).toBeDefined();
  return found as Assertion;
}

describe.concurrent('skip — a television that buffers after a jump (6f)', () => {
  it.concurrent(
    'reports one tap as a film that kept playing, on a device that buffers to get there',
    async () => {
      const verdict = await runSkip(SEEK_BUFFER_MS);

      // The condition really was produced: the film passed through `buffering`. Without
      // this the case below is the old vacuous pass in a new file.
      expect(
        String(must(verdict, 'singleSkipStatesPassedThrough').measured),
        'the scripted television never buffered, so nothing here was tested',
      ).toContain('buffering');

      // …and the criterion still holds. A tap that only made the picture pause to fetch
      // new bytes is not a tap that changed what the film was doing.
      expect(must(verdict, 'singleSkipStateUnchanged').measured).toBe('playing');
      expect(must(verdict, 'singleSkipStateUnchanged').passed).toBe(true);
      expect(must(verdict, 'singleSkipNeverStoppedPlaying').measured).toBe('none');
      expect(must(verdict, 'singleSkipNeverStoppedPlaying').passed).toBe(true);
      expect(must(verdict, 'singleSkipBackToPlayingMs').measured).not.toBeNull();
    },
    120_000,
  );

  it.concurrent(
    'still goes red when a tap really does leave the film stopped',
    async () => {
      // **The new form is looser, so it has to be shown it can still fail.** A television
      // that buffers for a minute after a jump is a tap that stopped the film by any
      // reading of 6f, and the leg must say so — otherwise the change traded a false red
      // for a false green, which is the worse of the two.
      const verdict = await runSkip(21_000);
      const settled = must(verdict, 'singleSkipStateUnchanged');
      expect(settled.measured).toBe('buffering');
      expect(settled.passed).toBe(false);
      expect(verdict.exitCode).toBe(1);
      // …and the route says why, in a line a person can read without the source open.
      expect(String(must(verdict, 'singleSkipStatesPassedThrough').measured)).toContain(
        'buffering',
      );
      expect(must(verdict, 'singleSkipBackToPlayingMs').measured).toBeNull();
    },
    180_000,
  );
});
