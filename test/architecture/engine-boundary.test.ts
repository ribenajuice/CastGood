import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The engine boundary, enforced mechanically.
 *
 * `src/engine/` must import nothing from Electron. That single rule is what lets the
 * reliability behaviour — reconnect, reattach, seek coalescing, frontier protection —
 * run headless under vitest in WSL and in CI, with no window and no Chromecast. It is
 * the reason the PRD's numeric targets are testable at all, so it is checked by a test
 * rather than trusted to code review.
 *
 * If this fails: the Electron-flavoured code belongs in `src/main/`, and the engine
 * should take what it needs as an injected dependency.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const engineRoot = path.join(repoRoot, 'src', 'engine');

const FORBIDDEN = [
  { pattern: /from\s+['"]electron(\/[^'"]*)?['"]/, description: "import ... from 'electron'" },
  { pattern: /require\(\s*['"]electron(\/[^'"]*)?['"]\s*\)/, description: "require('electron')" },
  { pattern: /import\(\s*['"]electron(\/[^'"]*)?['"]\s*\)/, description: "import('electron')" },
  { pattern: /from\s+['"][^'"]*\/main\/[^'"]*['"]/, description: 'import from src/main/' },
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(full);
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
    }),
  );
  return files.flat();
}

describe('engine boundary', () => {
  it('finds engine source files to check', async () => {
    const files = await collectSourceFiles(engineRoot);
    expect(files.length).toBeGreaterThan(5);
  });

  it('src/engine imports nothing from Electron or from src/main', async () => {
    const files = await collectSourceFiles(engineRoot);
    const violations: string[] = [];

    for (const file of files) {
      const source = await readFile(file, 'utf8');
      const lines = source.split('\n');
      lines.forEach((line, index) => {
        // Comments explain the rule; only real code may violate it.
        const code = line.replace(/\/\/.*$/, '').replace(/^\s*\*.*$/, '');
        for (const { pattern, description } of FORBIDDEN) {
          if (pattern.test(code)) {
            violations.push(
              `${path.relative(repoRoot, file)}:${index + 1} — ${description}\n    ${line.trim()}`,
            );
          }
        }
      });
    }

    expect(
      violations,
      `src/engine/ must stay Electron-free (see docs/ARCHITECTURE.md):\n${violations.join('\n')}`,
    ).toEqual([]);
  });
});
