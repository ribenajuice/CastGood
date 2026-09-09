import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Criterion 2b: cancelling the file picker leaves the previous selection unchanged.
 *
 * This one criterion cannot be executed in WSL. The dialog is `dialog.showOpenDialog`,
 * which needs Electron, which needs Windows; and `src/renderer/bridge.ts` reads the DOM
 * `window` global, so it is outside the TypeScript project the test suite compiles under.
 * What *is* checkable here is the chain of three decisions that make the criterion true,
 * and the one thing that would silently break it: some future edit sending a `file.select`
 * intent on the cancelled branch.
 *
 * So this is a contract test, deliberately, and it is weaker than a behavioural one. The
 * behavioural half is `engine.test.ts`'s "a selection only changes when file.select
 * arrives"; the human half is item 4 on the founder's M1 checklist.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string): Promise<string> => readFile(path.join(repoRoot, relative), 'utf8');

describe('cancelling the picker (2b)', () => {
  it('main returns null for a cancelled dialog instead of an empty path', async () => {
    const source = await read('src/main/main.ts');
    expect(source).toContain('result.canceled ? undefined : result.filePaths[0]');
    expect(source).toMatch(/if \(chosen === undefined\)[\s\S]{0,300}?return null;/);
  });

  it('main also reports a dialog that failed to open as "nothing was chosen"', async () => {
    const source = await read('src/main/main.ts');
    // A thrown dialog must not read as a crash, and must not select anything either.
    expect(source).toMatch(/catch \(error\)[\s\S]{0,300}?return null;/);
  });

  it('the bridge turns both null and an empty string into "cancelled"', async () => {
    const source = await read('src/renderer/bridge.ts');
    expect(source).toContain("if (path === null || path === '') return { kind: 'cancelled' };");
    expect(source).toContain("return { kind: 'failed' };");
  });

  it('the cancelled branch in App sends no intent at all', async () => {
    const source = await read('src/renderer/App.tsx');
    const cancelled = /case 'cancelled':([\s\S]*?)return;/.exec(source);
    expect(cancelled, "App.tsx no longer has a 'cancelled' branch").not.toBeNull();
    // Comments only. The moment this branch dispatches anything, 2b is broken.
    expect(cancelled?.[1]).not.toContain('sendIntent');
    expect(cancelled?.[1]).not.toContain('setSnapshot');
  });

  it('only the "selected" branch ever sends file.select', async () => {
    const source = await read('src/renderer/App.tsx');
    const sends = source.match(/sendIntent\(\{ type: 'file\.select'/g) ?? [];
    expect(sends).toHaveLength(1);
  });

  it('opening the picker twice at once is impossible, so a stray second result cannot land', async () => {
    const source = await read('src/renderer/App.tsx');
    expect(source).toContain('if (picking) return;');
  });
});
