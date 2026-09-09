import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import {
  createLogger,
  createMemorySink,
  createTestClock,
  systemClock,
} from '../../src/engine/logging/index.js';
import type { LogFields, LogRecord } from '../../src/engine/logging/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { DISCOVERY } from '../../src/engine/config.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import { ffprobeYielding, report } from './fixtures/ffprobe.js';

/**
 * M1 acceptance criteria that had no test of their own.
 *
 * Everything here is [logic]: it runs headless in WSL and proves the engine's rules. None
 * of it is evidence that a Chromecast did anything — that is the selftest and the
 * founder's eyes, and no test in this repository may be read as a substitute.
 */

interface FakeMdns extends Mdns {
  up(service: MdnsService): void;
  down(service: MdnsService): void;
}

/**
 * One registration per `browse()` call, exactly like the real adapter — which builds a
 * fresh `browser` each time and stops only that one. Modelling every browse as a single
 * shared registration (a `Set` keyed on the handlers object, which discovery reuses for
 * both the persistent browse and each sweep) makes stopping a sweep silently stop the
 * persistent browse too, and that is a fake being wrong rather than the product.
 */
function createFakeMdns(): FakeMdns {
  const active: MdnsHandlers[] = [];
  const seen: MdnsService[] = [];
  const deliver = (send: (handlers: MdnsHandlers) => void): void => {
    for (const handlers of new Set([...active])) send(handlers);
  };
  return {
    browse(handlers) {
      active.push(handlers);
      for (const item of seen) handlers.onUp(item);
      let stopped = false;
      return {
        stop() {
          if (stopped) return;
          stopped = true;
          const index = active.indexOf(handlers);
          if (index !== -1) active.splice(index, 1);
        },
      };
    },
    destroy: () => Promise.resolve(),
    up(item) {
      seen.push(item);
      deliver((handlers) => handlers.onUp(item));
    },
    down(item) {
      const index = seen.findIndex((candidate) => candidate.id === item.id);
      if (index !== -1) seen.splice(index, 1);
      deliver((handlers) => handlers.onDown(item));
    },
  };
}

function service(overrides: Partial<MdnsService> = {}): MdnsService {
  return {
    id: 'tv-1',
    friendlyName: 'Living Room TV',
    model: 'Chromecast Ultra',
    address: '192.168.1.50',
    port: 8009,
    ...overrides,
  };
}

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-m1-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

/**
 * Every engine here states its ffprobe, and `null` is the statement, not the absence of
 * one: *this machine has none*. Leaving it undefined would let `resolveFfmpeg()` answer
 * from whatever happens to be in `resources/bin` of the working copy, which makes the
 * result of a test depend on whether a build script has been run. Tests that are about a
 * verdict hand in a scripted probe instead.
 */
function build(
  mdns: Mdns,
  clock = createTestClock(Date.UTC(2026, 7, 14), 0),
  ffprobe: FfprobeRunner | null = null,
) {
  const sink = createMemorySink();
  const engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    logSink: sink,
    logLevel: 'debug',
    clock,
    mdns,
    mediaPort: 0,
    ffprobe,
  });
  const records = (): LogRecord[] =>
    sink.lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as LogRecord];
      } catch {
        return [];
      }
    });
  return { engine, records, clock };
}

describe('criterion 1d — the message disappears by itself', () => {
  it('goes none → found when a device answers, with nothing dispatched', async () => {
    vi.useFakeTimers();
    try {
      const mdns = createFakeMdns();
      const { engine, records, clock } = build(mdns);

      const start = engine.start();
      await vi.advanceTimersByTimeAsync(1);
      await start;

      // Five silent seconds: only now is "no devices found" an honest thing to say.
      clock.advance(DISCOVERY.emptyAfterMs);
      await vi.advanceTimersByTimeAsync(DISCOVERY.emptyAfterMs);
      expect(engine.snapshot().discovery.phase).toBe('none');

      const phases: string[] = [];
      engine.subscribe((snapshot) => phases.push(snapshot.discovery.phase));

      // A TV is switched on. Nothing is clicked.
      mdns.up(service());
      await vi.advanceTimersByTimeAsync(1);

      expect(phases).toContain('found');
      expect(engine.snapshot().discovery.phase).toBe('found');
      expect(engine.snapshot().discovery.devices[0]?.friendlyName).toBe('Living Room TV');

      // The proof that nothing was pressed: no intent ever reached the engine, and in
      // particular no rescan. Criterion 1a's "no button was pressed" holds here too.
      const intents = records().filter((record) => record.event === 'intent.received');
      expect(intents).toEqual([]);
      expect(records().filter((record) => record.event === 'discovery.rescan')).toEqual([]);

      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('goes back to "none" only after the list empties, never while a device is listed', async () => {
    vi.useFakeTimers();
    try {
      const mdns = createFakeMdns();
      const { engine, clock } = build(mdns);
      const start = engine.start();
      await vi.advanceTimersByTimeAsync(1);
      await start;

      mdns.up(service());
      await vi.advanceTimersByTimeAsync(1);
      clock.advance(DISCOVERY.emptyAfterMs * 4);
      await vi.advanceTimersByTimeAsync(DISCOVERY.emptyAfterMs * 4);
      expect(engine.snapshot().discovery.phase).toBe('found');

      // 1b: switched off, it leaves the list — and only then does the message return.
      mdns.down(service());
      await vi.advanceTimersByTimeAsync(1);
      expect(engine.snapshot().discovery.devices).toEqual([]);
      expect(engine.snapshot().discovery.phase).toBe('none');

      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('criterion 1a/1b — the device list keeps up with the house', () => {
  it('preselects the first device found and keeps that choice as more arrive', async () => {
    const mdns = createFakeMdns();
    const { engine } = build(mdns);
    await engine.start();

    mdns.up(service());
    expect(engine.snapshot().discovery.selectedDeviceId).toBe('tv-1');

    mdns.up(service({ id: 'tv-2', friendlyName: 'Attic TV' }));
    // A second device appearing must not silently move the founder's target.
    expect(engine.snapshot().discovery.selectedDeviceId).toBe('tv-1');
    expect(engine.snapshot().discovery.devices).toHaveLength(2);

    await engine.stop();
  });

  it('moves the selection off a device that disappears rather than pointing at nothing', async () => {
    const mdns = createFakeMdns();
    const { engine } = build(mdns);
    await engine.start();

    mdns.up(service());
    mdns.up(service({ id: 'tv-2', friendlyName: 'Attic TV' }));
    engine.dispatch({ type: 'device.select', deviceId: 'tv-2' });
    expect(engine.snapshot().discovery.selectedDeviceId).toBe('tv-2');

    mdns.down(service({ id: 'tv-2', friendlyName: 'Attic TV' }));
    const after = engine.snapshot().discovery;
    expect(after.devices.map((device) => device.id)).toEqual(['tv-1']);
    expect(after.selectedDeviceId).toBe('tv-1');

    await engine.stop();
  });

  it('refuses to select a device it has never heard of', async () => {
    const mdns = createFakeMdns();
    const { engine, records } = build(mdns);
    await engine.start();
    mdns.up(service());

    engine.dispatch({ type: 'device.select', deviceId: 'not-a-real-tv' });

    expect(engine.snapshot().discovery.selectedDeviceId).toBe('tv-1');
    expect(records().map((record) => record.event)).toContain('intent.unknown_device');
    await engine.stop();
  });
});

describe('criterion 2b — the selection only ever changes on purpose', () => {
  let engine: Engine;
  let filePath: string;

  beforeEach(async () => {
    filePath = path.join(directory, 'Bluey - The Sign.mp4');
    const box = (type: string, content: Buffer): Buffer => {
      const header = Buffer.alloc(8);
      header.writeUInt32BE(content.length + 8, 0);
      header.write(type, 4, 'latin1');
      return Buffer.concat([header, content]);
    };
    const mvhd = Buffer.alloc(100);
    mvhd.writeUInt32BE(1_000, 12);
    mvhd.writeUInt32BE(90_000, 16);
    await fs.writeFile(
      filePath,
      Buffer.concat([
        box('ftyp', Buffer.from('isom')),
        box('mdat', Buffer.alloc(1_024, 3)),
        box('moov', box('mvhd', mvhd)),
      ]),
    );
    const mdns = createFakeMdns();
    // The film on disk is 90 s of H.264 and AAC in an MP4 — what ffprobe would say about
    // it, said by a script, so the criterion is proved without a Windows binary.
    ({ engine } = build(mdns, undefined, ffprobeYielding(report({ durationSec: 90 }))));
    await engine.start();
    mdns.up(service());
  });

  afterEach(async () => {
    await engine.stop();
  });

  async function settle(): Promise<void> {
    for (let index = 0; index < 20; index += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }

  it('survives every other intent without dropping the chosen file', async () => {
    engine.dispatch({ type: 'file.select', path: filePath });
    await settle();
    expect(engine.snapshot().file?.name).toBe('Bluey - The Sign.mp4');
    const chosen = engine.snapshot().file;

    // This is what "the picker was cancelled" looks like from the engine's side: the
    // renderer sends nothing, so nothing here may change the selection either.
    engine.dispatch({ type: 'discovery.rescan' });
    engine.dispatch({ type: 'device.select', deviceId: 'tv-1' });
    engine.dispatch({ type: 'playback.play' });
    engine.dispatch({ type: 'playback.pause' });
    engine.dispatch({ type: 'playback.seek', positionSec: 12 });
    engine.dispatch({ type: 'cast.stop' });
    await settle();

    expect(engine.snapshot().file).toEqual(chosen);
  });

  it('re-runs the file panel against a newly chosen device without re-picking the file', async () => {
    engine.dispatch({ type: 'file.select', path: filePath });
    await settle();
    // Criterion 2a's status, now decided by the classifier against this television rather
    // than asserted by naming it. The device's name is the *screen's* to add: a verdict is
    // about a file and a television, and the panel already knows which television.
    expect(engine.snapshot().file?.verdict?.headline).toBe('Ready to cast');
    expect(engine.snapshot().file?.verdict?.kind).toBe('ready');

    engine.dispatch({ type: 'device.select', deviceId: 'tv-1' });
    await settle();
    expect(engine.snapshot().file?.name).toBe('Bluey - The Sign.mp4');
    expect(engine.snapshot().session.state).toBe('idle');
  });
});

describe('the log is the eyes — it has to say what happened', () => {
  it('records a state transition under its own name, not the name of its trigger', async () => {
    const sink = createMemorySink();
    const { createLogger } = await import('../../src/engine/logging/index.js');
    const logger = createLogger({ sink, bindings: { component: 'session' } });

    // The field names a payload uses are not allowed to rename the line they are on.
    // The cast is deliberate: `LogFields` now bans these names at compile time (2026-09-08),
    // and this test exists to prove the *runtime* guard still holds for anything that gets
    // past the type — a plain-JS caller, a spread, an `as` of its own.
    logger.info('session.state_changed', {
      from: 'idle',
      to: 'connecting',
      trigger: 'intent.cast',
      level: 'debug',
      seq: -1,
    } as unknown as LogFields);

    const record = JSON.parse(sink.lines[0] as string) as LogRecord;
    expect(record.event).toBe('session.state_changed');
    expect(record.level).toBe('info');
    expect(record.seq).not.toBe(-1);
    expect(record['trigger']).toBe('intent.cast');
    expect(record['to']).toBe('connecting');
  });
});

describe('the logger reserves five names, and a payload may not quietly lose one', () => {
  /**
   * ⚠️ **This exists because the guard that protects the record's identity also destroys
   * data, silently, and it did.**
   *
   * `emit` writes `t`, `mono`, `seq`, `level` and `event` *after* the caller's fields so a
   * payload cannot rename the line it sits on. The cost is that a payload key with one of
   * those names is **replaced, not rejected** — the log still parses, still has the key, and
   * still reads plausibly, with the wrong value in it.
   *
   * On 2026-09-08 that cost more than a log line. `session.volume_sent` passed
   * `level: change.level` and `seq`, so every record on the founder's own hardware read
   * `"level":"info"` with the logger's line counter for a sequence — and
   * `selftest/m5a.ts`'s 23f assertion, which counts levels sent during a mute by testing
   * `typeof record['level'] === 'number'`, was therefore **hard-wired to zero and could not
   * fail**. It passed vacuously in a run reported as 11/11 on real hardware.
   *
   * `LogFields` now rejects the names at compile time. This asserts the runtime half, and
   * that no volume event uses one — the type is the fence, this is the proof it is up.
   */
  it('overwrites a reserved payload key rather than rejecting it — the behaviour to design around', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sink, clock: systemClock });

    logger.info('probe.event', {
      level: 'debug',
      seq: -1,
      kept: 'yes',
    } as unknown as LogFields);

    const record = JSON.parse(sink.lines[0] as string) as LogRecord;
    expect(record.level).toBe('info');
    expect(record.seq).not.toBe(-1);
    expect(record['kept']).toBe('yes');
  });

  it('never lets a volume log line use a reserved name', () => {
    const source = readFileSync(
      new URL('../../src/engine/session/index.ts', import.meta.url),
      'utf8',
    );
    // The three volume events, and the fields they must never carry again.
    for (const event of [
      'session.volume_sent',
      'session.volume_echoed',
      'session.volume_reported',
    ]) {
      const start = source.indexOf(`logger.info('${event}'`);
      expect(start, `${event} is not logged at all`).toBeGreaterThan(-1);
      const block = source.slice(start, source.indexOf('});', start));
      for (const reserved of ['level:', 'seq:', 'event:', 'mono:', 't:']) {
        expect(block, `${event} carries the reserved key ${reserved}`).not.toContain(
          ` ${reserved}`,
        );
      }
    }
    expect(source).toContain('volumeLevel:');
    expect(source).toContain('commandSeq:');
  });
});
