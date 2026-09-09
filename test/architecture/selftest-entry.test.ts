import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The contract between the engine and `scripts/selftest.mjs`, checked mechanically.
 *
 * The wrapper bundles the *first* of `src/engine/selftest/cli.ts`, `main.ts`, `index.ts`,
 * `selftest.ts` that exists, and whatever it lands on must actually run when executed.
 * If someone turns `cli.ts` back into a library of exported functions, `npm run selftest`
 * silently prints nothing and the wrapper converts that to exit 2 — a selftest that can
 * never pass. That failure is quiet enough to deserve a test rather than a comment.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const entry = path.join(repoRoot, 'src', 'engine', 'selftest', 'cli.ts');

describe('selftest entry point', () => {
  it('exists where the packaging script looks for it first', async () => {
    await expect(access(entry)).resolves.toBeUndefined();
  });

  it('runs the CLI on import rather than only exporting it', async () => {
    const source = await readFile(entry, 'utf8');
    // Not inside a function, not behind an export: a bare call at module scope.
    expect(source).toMatch(/^runSelftestCli\(process\.argv\.slice\(2\)\)/m);
    expect(source).toMatch(/^installSignalHandlers\(\);/m);
  });

  it('sets an exit code on both paths, so success is never assumed', async () => {
    const source = await readFile(entry, 'utf8');
    expect(source).toContain('process.exitCode = code;');
    expect(source).toContain('process.exitCode = 2;');
  });

  it('writes nothing to stdout itself — stdout carries only the verdict JSON', async () => {
    const source = await readFile(entry, 'utf8');
    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('console.log');
  });
});
