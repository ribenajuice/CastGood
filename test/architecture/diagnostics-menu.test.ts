import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DIAGNOSTIC_MENU_LABEL } from '../../src/main/diagnostics-menu.js';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/**
 * Story 25 as a menu item — the founder's ruling of 2026-09-09, after seeing it on screen:
 * *"this needs to be tucked into a menu, this doesn't need to be visible at all."*
 */
describe('the report is reachable from the menu, and says what it takes', () => {
  it('adds no modal, because the app has a ruling against them (2026-08-30)', async () => {
    // ⚠️ The first version of this feature reached for a confirmation dialog and
    // `quit-prompt.test.ts` failed it BY NAME: "including for a new question that has
    // nothing to do with quitting". The rule anticipated exactly this.
    const source = await readFile(path.join(repoRoot, 'src', 'main', 'main.ts'), 'utf8');
    expect(source).not.toContain('showMessageBox');
  });

  it('has a label that says what it does without needing a dialog to explain it', () => {
    expect(DIAGNOSTIC_MENU_LABEL).toMatch(/report/i);
    // The ellipsis is the platform convention for "this opens something", and it is what
    // tells a person the press is not the end of the interaction.
    expect(DIAGNOSTIC_MENU_LABEL).toMatch(/…$/);
  });

  it('is in the menu unconditionally — 25a has no state to fail in', async () => {
    // ⚠️ The whole reason a menu beats a panel: there is no snapshot, no flag and no
    // inert-while-asking path between the person and this item. A `click` guarded by any
    // condition would put one back, so the source is checked for it.
    const source = await readFile(path.join(repoRoot, 'src', 'main', 'main.ts'), 'utf8');
    // Wide enough to survive the comment that explains why there is no dialog. The first
    // version capped this at 200 characters and failed the moment that comment was added —
    // a test that breaks when a comment grows is testing the wrong thing.
    const menuBlock =
      /label: DIAGNOSTIC_MENU_LABEL,[\s\S]{0,900}?\n {10}\},/.exec(source)?.[0] ?? '';

    expect(menuBlock, 'the menu item was not found in main.ts').toContain('click');
    expect(menuBlock, 'the item must never be conditionally enabled').not.toMatch(/enabled:/);
    expect(menuBlock, 'the item must never be conditionally visible').not.toMatch(/visible:/);
  });

  it('keeps the standard roles, so building a menu does not cost copy and paste', async () => {
    const source = await readFile(path.join(repoRoot, 'src', 'main', 'main.ts'), 'utf8');
    for (const role of ['editMenu', 'viewMenu', 'windowMenu']) {
      expect(
        source,
        `setApplicationMenu replaces the default wholesale; ${role} was lost`,
      ).toContain(role);
    }
  });
});
