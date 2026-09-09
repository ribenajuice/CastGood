import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createFileSink,
  createLogger,
  createMemorySink,
  createTestClock,
  type LogRecord,
} from '../../src/engine/logging/index.js';

/**
 * The log is how a WSL session sees what happened on Windows. If it is unparseable,
 * out of order, or missing, every later milestone loses its only source of evidence.
 */

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'castgood-log-'));
  tempDirs.push(dir);
  return dir;
}

function parse(lines: string[]): LogRecord[] {
  return lines.map((line) => JSON.parse(line) as LogRecord);
}

describe('logger', () => {
  it('writes one parseable JSON object per event, with bindings applied', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sink, clock: createTestClock(1_700_000_000_000, 0) });

    logger.info('engine.start', { dataDir: 'C:\\Users\\Darren\\AppData\\Local\\CastGood' });
    logger.child({ component: 'cast' }).warn('cast.ping_missed', { misses: 1 });

    const records = parse(sink.lines);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      level: 'info',
      event: 'engine.start',
      dataDir: 'C:\\Users\\Darren\\AppData\\Local\\CastGood',
    });
    expect(records[0]?.t).toBe('2023-11-14T22:13:20.000Z');
    expect(records[1]).toMatchObject({
      level: 'warn',
      event: 'cast.ping_missed',
      component: 'cast',
      misses: 1,
    });
  });

  it('stamps monotonic timestamps and a strictly increasing sequence', () => {
    const sink = createMemorySink();
    const clock = createTestClock(1_700_000_000_000, 500);
    const logger = createLogger({ sink, clock });

    logger.info('a');
    logger.info('b');
    // The wall clock jumps backwards — NTP correction, or waking from sleep mid-film.
    clock.setWall(1_600_000_000_000);
    clock.advance(10);
    logger.info('c');

    const records = parse(sink.lines);
    const seqs = records.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(new Set(seqs).size).toBe(3);

    const monos = records.map((r) => r.mono);
    expect(monos).toEqual([...monos].sort((a, b) => a - b));
    expect(monos[2]).toBeGreaterThan(monos[1] ?? 0);
  });

  it('honours the level threshold', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sink, level: 'warn' });

    logger.debug('noise');
    logger.info('noise');
    logger.error('cast.load_rejected', { detail: 'MEDIA_UNKNOWN' });

    expect(sink.lines).toHaveLength(1);
    expect(parse(sink.lines)[0]?.event).toBe('cast.load_rejected');
  });

  it('never throws on unserialisable fields', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sink });

    const circular: Record<string, unknown> = { name: 'loop' };
    circular['self'] = circular;

    expect(() => {
      logger.info('weird', { circular, big: 10n, fn: () => undefined, err: new Error('boom') });
    }).not.toThrow();

    const record = parse(sink.lines)[0];
    expect(record).toBeDefined();
    expect(record?.['big']).toBe('10');
    expect(record?.['err']).toMatchObject({ name: 'Error', message: 'boom' });
  });

  it('keeps a repeated reference that is not a cycle', () => {
    const sink = createMemorySink();
    const logger = createLogger({ sink });

    // The shape M1 logs constantly: the same device under two keys, or twice in a
    // list. Neither occurrence is a cycle, so both must survive in full.
    const device = { id: 'living-room', name: 'Living Room' };
    logger.info('devices.found', { devices: [device, device], selected: device });

    const record = parse(sink.lines)[0];
    expect(record?.['devices']).toEqual([device, device]);
    expect(record?.['selected']).toEqual(device);
  });

  it('appends JSONL to a dated file in the log directory', async () => {
    const dir = await makeTempDir();
    const clock = createTestClock(Date.UTC(2026, 7, 13, 12, 0, 0), 0);
    const sink = createFileSink(dir, clock);
    const logger = createLogger({ sink, clock });

    logger.info('engine.start', {});
    logger.info('engine.stop', {});
    await logger.flush();
    await logger.close();

    const files = await readdir(dir);
    expect(files).toEqual(['engine-2026-08-13.jsonl']);

    const contents = await readFile(path.join(dir, 'engine-2026-08-13.jsonl'), 'utf8');
    const lines = contents.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(parse(lines).map((r) => r.event)).toEqual(['engine.start', 'engine.stop']);
  });

  /**
   * The defect: `close()` ended the write stream permanently, so everything the *second*
   * engine in a process wrote hit ERR_STREAM_WRITE_AFTER_END and was swallowed by the
   * logger's own never-throw guard. It failed silently, which is the worst way for a log
   * to fail — M2's reattach scenario stops one engine and starts another by definition,
   * and would have produced no evidence at all that the second one ever ran.
   */
  it('reopens after close, so a second engine in one process is still logged', async () => {
    const dir = await makeTempDir();
    const clock = createTestClock(Date.UTC(2026, 7, 13, 12, 0, 0), 0);
    const sink = createFileSink(dir, clock);
    const logger = createLogger({ sink, clock });

    logger.info('engine.start', { run: 1 });
    await logger.flush();
    await logger.close();

    logger.info('engine.start', { run: 2 });
    logger.info('engine.stop', { run: 2 });
    await logger.flush();
    await logger.close();

    const files = await readdir(dir);
    expect(files).toEqual(['engine-2026-08-13.jsonl']);

    const contents = await readFile(path.join(dir, 'engine-2026-08-13.jsonl'), 'utf8');
    const records = parse(contents.trim().split('\n'));
    expect(records.map((r) => r.event)).toEqual(['engine.start', 'engine.start', 'engine.stop']);
    // Appended, never truncated: the first run's line survives the reopen.
    expect(records.map((r) => r['run'])).toEqual([1, 2, 2]);
  });

  it('flushes and closes without opening a file when nothing was ever written', async () => {
    const dir = await makeTempDir();
    const sink = createFileSink(dir, createTestClock(Date.UTC(2026, 7, 13), 0));

    await sink.flush();
    await sink.close();

    expect(await readdir(dir)).toEqual([]);
  });
});
