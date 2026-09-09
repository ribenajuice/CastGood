import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A closed BrowserWindow is a destroyed native object, and every method on it throws.
 *
 * `mainWindow` used to be assigned once and never cleared, so a second launch arriving
 * after the window closed but before the quit finished — the single-instance lock is
 * still held in that gap — called `isMinimized()` on the corpse and took the process
 * down. Story 12 (reopen the app while the TV is still playing) walks straight through
 * that gap, which is why it is fixed before any M2 behaviour is built on it.
 *
 * This is a contract test, deliberately: `second-instance` needs Electron, Electron needs
 * Windows, and the suite runs headless in WSL. It holds the two lines that make the
 * criterion true — the reference is dropped when the window closes, and the handler
 * checks the window is alive before touching it.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string): Promise<string> => readFile(path.join(repoRoot, relative), 'utf8');

describe('the main window reference', () => {
  it('is nulled when the window closes', async () => {
    const source = await read('src/main/main.ts');
    const handler = /window\.on\('closed',([\s\S]{0,300}?)\}\);/.exec(source);

    expect(handler, "src/main/main.ts has no 'closed' handler on the window").not.toBeNull();
    expect(handler?.[1]).toContain('mainWindow = null');
  });

  it('is checked for a destroyed window before a second instance touches it', async () => {
    const source = await read('src/main/main.ts');
    const handler = /app\.on\('second-instance',([\s\S]*?)\n {2}\}\);/.exec(source);

    expect(handler, "src/main/main.ts no longer handles 'second-instance'").not.toBeNull();
    const body = handler?.[1] ?? '';
    expect(body).toContain('isDestroyed()');
    // Whatever the guard reads, it must return before any window method is called.
    const guardAt = body.indexOf('isDestroyed()');
    const restoreAt = body.indexOf('isMinimized()');
    expect(restoreAt).toBeGreaterThan(guardAt);
  });
});
