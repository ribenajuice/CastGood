import { mkdtemp, mkdir, readFile, readdir, writeFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { exportDiagnostics } from '../../src/engine/diagnostics/export.js';

/**
 * Story 25 — the file a person actually hands over.
 *
 * The interesting assertions here are the two negative ones: that an export **never leaves an
 * empty file** for somebody to send, and that it **never disturbs the log it is exporting**.
 */

const SUBJECTS = {
  username: 'Darren',
  deviceNames: ['Family room TV'],
  fileNames: ['Cars.mp4'],
};

const made: string[] = [];
async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'cg-export-'));
  made.push(dir);
  return dir;
}
afterEach(() => {
  made.length = 0;
});

async function withLog(lines: readonly string[]): Promise<{ logDir: string; out: string }> {
  const root = await tempDir();
  const logDir = path.join(root, 'logs');
  const out = path.join(root, 'out');
  await mkdir(logDir, { recursive: true });
  await writeFile(path.join(logDir, 'engine-2026-09-09.jsonl'), lines.join('\n'), 'utf8');
  return { logDir, out };
}

describe('exporting a report', () => {
  it('writes a file, and it does not contain the person', async () => {
    const { logDir, out } = await withLog([
      '{"event":"engine.start"}',
      '{"event":"file.selected","path":"C:\\\\Users\\\\Darren\\\\Cars.mp4"}',
      '{"event":"cast","friendlyName":"Family room TV","address":"10.1.1.5"}',
    ]);

    const result = await exportDiagnostics({ logDir, destinationDir: out, subjects: SUBJECTS });
    expect(result.kind).toBe('written');
    if (result.kind !== 'written') return;

    const body = await readFile(result.filePath, 'utf8');
    expect(body).not.toMatch(/Darren/i);
    expect(body).not.toContain('Family room TV');
    expect(body).not.toContain('10.1.1.5');
    expect(body).toContain('<user-1>');
  });

  it('says what it removed, in the file, where the sender and receiver both see it', async () => {
    const { logDir, out } = await withLog([
      '{"event":"engine.start"}',
      '{"friendlyName":"Family room TV","path":"C:\\\\Users\\\\Darren\\\\Cars.mp4"}',
    ]);
    const result = await exportDiagnostics({ logDir, destinationDir: out, subjects: SUBJECTS });
    if (result.kind !== 'written') throw new Error('expected a file');

    const body = await readFile(result.filePath, 'utf8');
    expect(body).toContain('Names have been removed');
    // The promise the whole product rests on, restated where somebody will read it.
    expect(body).toContain('CastGood did not send this anywhere');
  });

  it('leaves NO file at all when there is no log — never an empty one', async () => {
    // ⚠️ A person handed an empty file will send it, and it will be read as "nothing
    // happened" rather than "there was nothing to send".
    const root = await tempDir();
    const logDir = path.join(root, 'logs');
    const out = path.join(root, 'out');
    await mkdir(logDir, { recursive: true });

    const result = await exportDiagnostics({ logDir, destinationDir: out, subjects: SUBJECTS });

    expect(result.kind).toBe('nothing-to-send');
    const written = await readdir(out).catch(() => []);
    expect(written, 'an empty report is worse than none').toEqual([]);
  });

  it('does not modify, rotate or delete the log it is exporting', async () => {
    // 25g: exporting evidence must not disturb the evidence.
    const { logDir, out } = await withLog(['{"event":"engine.start"}', '{"event":"note"}']);
    const logFile = path.join(logDir, 'engine-2026-09-09.jsonl');
    const before = await readFile(logFile, 'utf8');
    const beforeStat = await stat(logFile);

    await exportDiagnostics({ logDir, destinationDir: out, subjects: SUBJECTS });

    expect(await readFile(logFile, 'utf8')).toBe(before);
    expect((await stat(logFile)).size).toBe(beforeStat.size);
    expect(await readdir(logDir)).toEqual(['engine-2026-09-09.jsonl']);
  });

  it('writes outside the log directory, so it is never read back as a log', async () => {
    const { logDir, out } = await withLog(['{"event":"engine.start"}', '{"n":1}']);
    const result = await exportDiagnostics({ logDir, destinationDir: out, subjects: SUBJECTS });
    if (result.kind !== 'written') throw new Error('expected a file');

    expect(path.dirname(result.filePath)).not.toBe(logDir);
    expect(result.filePath.startsWith(logDir)).toBe(false);
  });

  it('exports this run only, and says so when it had to drop lines', async () => {
    const { logDir, out } = await withLog([
      '{"event":"engine.start"} yesterday',
      '{"event":"note"} old',
      '{"event":"engine.start"} today',
      ...Array.from({ length: 3 }, (_, i) => `{"n":${String(i)}}`),
    ]);
    const result = await exportDiagnostics({ logDir, destinationDir: out, subjects: SUBJECTS });
    if (result.kind !== 'written') throw new Error('expected a file');

    const body = await readFile(result.filePath, 'utf8');
    expect(body).toContain('today');
    expect(body, 'yesterday belongs to somebody else’s evening').not.toContain('yesterday');
    expect(result.lines).toBe(4);
  });
});
