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
 * **`headstart`'s exit-code contract, executed — criterion 10j.**
 *
 * *"Fails if `headstart` can reach exit 0 on a run where the gate never opened or the film
 * was too short to head-start (that is exit 2)."* Until this file, the scenario had never
 * been **run** by anything: it was written, reviewed and typechecked, which is exactly the
 * state six M2 scenarios were in on the evening they were first pointed at a television and
 * three of them failed on their own measurement rather than on the product.
 *
 * What this file can reach is the front of the scenario — the two refusals that decide
 * whether a run is evidence at all — and it reaches them through `runSelftest` itself, so
 * the abort really travels through the runner's exit-code mapping rather than being
 * inspected as a thrown object. What it deliberately cannot reach is a head start: that
 * needs a real conversion (`ffmpeg` is not on this machine and the runner has no seam for
 * one), so the scenario's **third** refusal — the gate that never opened, because the
 * conversion finished first or never sustained 1.5× — is still owed a real run on Windows,
 * and is recorded as `[selftest]` debt rather than as a green line here.
 *
 * The verdicts here stamp themselves `test-harness` and could never be read as a real run.
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

/** A file whose header says it is `durationSec` long. */
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

async function run(durationSec: number): Promise<SelftestVerdict> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-headstart-'));
  const filePath = path.join(directory, 'Cars.mp4');
  await fs.writeFile(filePath, fixtureMp4(durationSec));
  const receiver = await startFakeReceiver({ durationSec });
  try {
    return await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'headstart',
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
  // **Never 0, and never a green line either.** A refusal that still published a passing
  // assertion would be the degradation 10j names: an easier test, quietly gone green.
  expect(verdict.assertions.filter((item) => item.kind === 'promise')).toEqual([]);
  expect(verdict.environment.transport).toBe('test-harness');
}

describe('headstart refuses to be evidence it is not (10j)', () => {
  it('exits 2 on a film too short to head-start, naming the length it needed', async () => {
    // Ten minutes of prepared video is the gate, so a film that only just clears it would
    // finish converting moments after opening it: no live frontier, no margin, no guard.
    // The scenario needs fifteen minutes and says so rather than measuring nothing.
    expectCouldNotRun(await run(60), /at least 15 minutes.*nothing was cast/s);
  }, 60_000);

  it('exits 2 on a film that needs no conversion, because there is nothing to race', async () => {
    // A film the television can already play has no growing conversion behind it. Every
    // number a head start is made of — prepared seconds, sustained speed, the frontier —
    // is absent, and a scenario that shrugged and graded the remaining assertions would
    // report a television that was never raced as one that kept up.
    expectCouldNotRun(await run(3_000), /head start only applies/);
  }, 60_000);
});
