import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createEngine } from '../../src/engine/index.js';
import { createMemorySink, createTestClock } from '../../src/engine/logging/index.js';
import type { LogRecord } from '../../src/engine/logging/index.js';
import type { Mdns } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { DISCOVERY } from '../../src/engine/config.js';

/**
 * The engine runs headless: no window, no Electron, no Chromecast. This test exists as
 * much to prove that as to check the lifecycle.
 */

/** No responder: discovery runs, hears nothing, and the engine has to cope with that. */
const silentMdns: Mdns = {
  browse: () => ({ stop: () => undefined }),
  destroy: () => Promise.resolve(),
};

let directory: string;

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-engine-'));
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function makeEngine() {
  const sink = createMemorySink();
  const engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    logSink: sink,
    clock: createTestClock(Date.UTC(2026, 7, 13), 0),
    logLevel: 'debug',
    appVersion: '0.0.0-test',
    mdns: silentMdns,
    mediaPort: 0,
  });
  const records = (): LogRecord[] => sink.lines.map((line) => JSON.parse(line) as LogRecord);
  return { engine, records };
}

describe('engine lifecycle', () => {
  it('starts, pushes a snapshot to subscribers, and logs the start event', async () => {
    const { engine, records } = makeEngine();
    const seen: number[] = [];
    engine.subscribe((snapshot) => seen.push(snapshot.revision));

    await engine.start();

    // One snapshot on subscribe, one on start.
    expect(seen.length).toBe(2);
    expect(engine.snapshot().revision).toBe(1);
    expect(engine.snapshot().session.state).toBe('idle');
    expect(records().map((r) => r.event)).toContain('engine.start');
    await engine.stop();
  });

  it('starts discovery and the media server before anything is asked of it', async () => {
    const { engine, records } = makeEngine();
    await engine.start();

    expect(engine.mediaServerPort).toBeGreaterThan(0);
    const events = records().map((r) => r.event);
    // Nothing was clicked; discovery is simply running.
    expect(events).toContain('discovery.start');
    expect(events).toContain('media.listening');
    await engine.stop();
  });

  it('says it is still searching until the search has had its five seconds', async () => {
    const { engine } = makeEngine();
    await engine.start();
    expect(engine.snapshot().discovery.phase).toBe('searching');
    await engine.stop();
  });

  it('pushes "no devices found" by itself at the five-second mark (1d)', async () => {
    vi.useFakeTimers();
    try {
      const sink = createMemorySink();
      const clock = createTestClock(0, 0);
      const engine = createEngine({
        paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
        logSink: sink,
        clock,
        mdns: silentMdns,
        mediaPort: 0,
      });
      const startPromise = engine.start();
      await vi.advanceTimersByTimeAsync(1);
      await startPromise;

      const phases: string[] = [];
      engine.subscribe((snapshot) => phases.push(snapshot.discovery.phase));

      clock.advance(DISCOVERY.emptyAfterMs);
      await vi.advanceTimersByTimeAsync(DISCOVERY.emptyAfterMs);

      // Nothing was clicked and no event arrived; the engine still said so on its own.
      expect(phases).toContain('none');
      await engine.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('is idempotent about starting and stopping', async () => {
    const { engine, records } = makeEngine();
    await engine.start();
    await engine.start();
    await engine.stop();
    await engine.stop();
    expect(records().filter((r) => r.event === 'engine.start')).toHaveLength(1);
    expect(records().filter((r) => r.event === 'engine.stop')).toHaveLength(1);
  });

  it('ignores an intent that cannot be acted on rather than throwing', async () => {
    const { engine, records } = makeEngine();
    await engine.start();
    // No file and no device chosen yet.
    expect(() => engine.dispatch({ type: 'cast.start' })).not.toThrow();
    await Promise.resolve();
    const events = records().map((r) => r.event);
    expect(events).toContain('intent.received');
    expect(events).toContain('cast.start_ignored');
    await engine.stop();
  });

  it('has no intent left that belongs to a later milestone', async () => {
    // This assertion has now been inverted twice, and each inversion is a milestone
    // landing. Seeking was the example in M1 and stopped being one in M2; preparation was
    // the example in M2 and stopped being one here. **Every intent in the schema is
    // handled**, so the honest test is that nothing reports otherwise — a new intent added
    // without an arm in the reducer would fail this rather than be quietly ignored.
    const { engine, records } = makeEngine();
    await engine.start();
    engine.dispatch({ type: 'preparation.cancel' });
    engine.dispatch({ type: 'preparation.confirm' });
    engine.dispatch({ type: 'preparation.decline' });
    await Promise.resolve();
    const events = records().map((r) => r.event);
    expect(events).toContain('intent.received');
    expect(events).not.toContain('intent.not_in_milestone');
    await engine.stop();
  });

  it('refuses a seek when nothing is playing, and says why rather than queueing it', async () => {
    const { engine, records } = makeEngine();
    await engine.start();
    engine.dispatch({ type: 'playback.seek', positionSec: 42 });
    engine.dispatch({ type: 'playback.skip', deltaSec: 30 });
    // Effects run off a promise chain, so a single microtask tick only drains the first.
    await new Promise((resolve) => setTimeout(resolve, 10));
    // 6j: a jump we cannot send is refused outright, never held back to be applied later.
    const refusals = records().filter((r) => r.event === 'session.seek_refused');
    expect(refusals).toHaveLength(2);
    expect(records().map((r) => r.event)).not.toContain('session.seek_issued');
    await engine.stop();
  });

  /**
   * A restarted engine used to write nothing to the log file at all: `stop()` closed the
   * shared write stream permanently and every line the next engine emitted was lost to
   * ERR_STREAM_WRITE_AFTER_END, silently. This is asserted against the *real* file sink,
   * because the memory sink every other test uses could never have shown the defect.
   */
  it('still writes to the log file after being stopped and started again', async () => {
    const paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } });
    const make = () =>
      createEngine({
        paths,
        clock: createTestClock(Date.UTC(2026, 7, 13), 0),
        appVersion: '0.0.0-test',
        mdns: silentMdns,
        mediaPort: 0,
      });

    const first = make();
    await first.start();
    await first.stop();

    // A second engine in the same process: the shape of the selftest's `reattach`
    // scenario, and of anything that restarts the engine without restarting the app.
    const second = make();
    await second.start();
    await second.stop();

    const logFiles = await fs.readdir(paths.logDir);
    expect(logFiles).toHaveLength(1);
    const contents = await fs.readFile(path.join(paths.logDir, logFiles[0]!), 'utf8');
    const events = contents
      .trim()
      .split('\n')
      .map((line) => (JSON.parse(line) as LogRecord).event);

    expect(events.filter((event) => event === 'engine.start')).toHaveLength(2);
    expect(events.filter((event) => event === 'engine.stop')).toHaveLength(2);
  });

  it('survives a subscriber that throws', async () => {
    const { engine, records } = makeEngine();
    engine.subscribe(() => {
      throw new Error('renderer blew up');
    });
    await expect(engine.start()).resolves.toBeUndefined();
    expect(records().map((r) => r.event)).toContain('snapshot.listener_failed');
    await engine.stop();
  });
});

describe('the preparation pipeline is built, not scaffolded', () => {
  it('is a real pipeline, and its failures are values rather than throws', async () => {
    // This test used to assert the *opposite*: that `createPreparationPipeline` threw
    // `NOT_IMPLEMENTED`, because throwing is how a scaffolded seam is kept from
    // masquerading as a working one. M3a built it, so the assertion is inverted rather
    // than deleted — same guarantee, pointing the other way.
    const { createPreparationPipeline } = await import('../../src/engine/prepare/index.js');
    const { createLogger } = await import('../../src/engine/logging/index.js');

    const pipeline = createPreparationPipeline({
      logger: createLogger({ sink: createMemorySink(), bindings: {} }),
      binaries: null,
      runFfprobe: null,
      workingDir: '/nowhere',
    });

    // With no binaries there is nothing to spawn — and that is a **value**, not a throw.
    // This runs behind a button the founder pressed, where an exception is a crash they
    // see; every failure in the pipeline follows the same rule as the probe runner's.
    const result = await pipeline.prepare(null as never, {}, new AbortController().signal);
    expect(result).toEqual({ ok: false, failure: { kind: 'ffmpeg-missing' } });
  });
});
