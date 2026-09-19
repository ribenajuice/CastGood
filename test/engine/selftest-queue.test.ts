import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { runSelftest, type SelftestVerdict } from '../../src/engine/selftest/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver } from './fake-receiver/index.js';

/**
 * **`queue --lookahead`'s front door, executed — 24g/24h.**
 *
 * `queue.ts`'s own header explains what this instrument does and does not attempt. What
 * this file can reach, headlessly and in seconds, is the same slice `selftest-headstart.
 * test.ts` reaches for `headstart`: the refusals that decide whether a run is evidence at
 * all, before anything about a real look-ahead job or a real stall could be measured.
 *
 * **This machine has no ffprobe** (`build/ffmpeg-pin.json` is fetched for Windows packaging
 * only — see that file's own comment, and `selftest-headstart.test.ts`'s identical note).
 * That is not a gap this file works around; it is itself one of `scenarioQueue`'s own exit-2
 * paths, and the third test below exercises it directly rather than pretending it is not
 * there. A real run on Windows, where ffprobe exists, is the only way item 2's `kind` is ever
 * `'convert'`/`'remux'` rather than `null` — and that run is `scripts/win-test.sh`'s job, not
 * this suite's.
 *
 * What is deliberately **not** reached here, for the same reason `selftest-headstart.test.
 * ts` cannot reach a real head start: item 2 actually being prepared while item 1 plays, the
 * stall count across a real film, and the auto-advance into item 2. Those need a real
 * television and a real conversion, which is `queue --lookahead` on real hardware — the
 * founder's own run tonight, not a fake-receiver test.
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

/** A file whose header says it is `durationSec` long — the same fixture `headstart` uses. */
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

interface RunOptions {
  readonly item1Name: string;
  readonly item2Name: string;
  readonly lookahead: boolean;
}

async function run(options: RunOptions): Promise<SelftestVerdict> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-queue-'));
  const filePath = path.join(directory, options.item1Name);
  const secondFilePath = path.join(directory, options.item2Name);
  await fs.writeFile(filePath, fixtureMp4(90));
  await fs.writeFile(secondFilePath, fixtureMp4(90));
  const receiver = await startFakeReceiver({ durationSec: 90 });
  try {
    return await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'queue',
      lookahead: options.lookahead,
      // Mirrors the command line: `--file2` is only ever given alongside `--lookahead`
      // (`refuseFile2` refuses the reverse), so a plain `queue` run here passes none either.
      ...(options.lookahead ? { secondFilePath } : {}),
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

/** The shape of "this run did not happen": exit 2, a reason, and nothing graded green. */
function expectCouldNotRun(verdict: SelftestVerdict, because: RegExp): void {
  expect(verdict.exitCode, verdict.reason ?? 'no reason given').toBe(2);
  expect(verdict.outcome).toBe('could-not-run');
  expect(verdict.reason ?? '').toMatch(because);
  expect(verdict.assertions.filter((item) => item.kind === 'promise')).toEqual([]);
  expect(verdict.environment.transport).toBe('test-harness');
}

describe('queue refuses to be evidence it is not (24g/24h)', () => {
  it('exits 2 without --lookahead, naming the base scenario as unbuilt', async () => {
    // `queue` alone is the base instrument (24a, 24c-e, 24m-r, 24w, 24z, 24aa, 24ab), which
    // does not exist yet. A run that quietly took the one leg that IS built, or quietly did
    // nothing at all, would be the exact false green this suite exists to prevent.
    const verdict = await run({
      item1Name: '1 - Item one.mp4',
      item2Name: '2 - Item two.mp4',
      lookahead: false,
    });
    expectCouldNotRun(verdict, /does not implement it yet.*--lookahead/s);
  }, 60_000);

  it("exits 2 when item 1 would not sort first — 24z's own order, not the order passed", async () => {
    // `queue.add` sorts the batch it is given (24z) rather than preserving argument order.
    // If item 2's name sorts first, item 1 becomes the LAST row and `nextAfterPlaying` — the
    // function look-ahead itself is built on — has nothing after it. This is the guard that
    // catches that before anything is checked or cast.
    const verdict = await run({
      item1Name: '9 - Item one.mp4',
      item2Name: '1 - Item two.mp4',
      lookahead: true,
    });
    expectCouldNotRun(verdict, /sorts before.*natural order \(24z\)/s);
  }, 60_000);

  it('exits 2 when item 2 cannot be checked at all, rather than guessing it needs no conversion', async () => {
    // This machine has no ffprobe (see this file's header) — the same condition
    // `selftest-headstart.test.ts` cannot avoid either. `scenarioQueue` distinguishes a probe
    // that failed outright from a real verdict of `ready`/`impossible`, and says so, rather
    // than folding "unknown" into "plays natively" and reporting the wrong reason for exit 2.
    const verdict = await run({
      item1Name: '1 - Item one.mp4',
      item2Name: '2 - Item two.mp4',
      lookahead: true,
    });
    expectCouldNotRun(verdict, /could not be checked at all/);
  }, 60_000);
});
