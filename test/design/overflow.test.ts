import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './design-system.js';

/**
 * **22b — the checker that is NOT built, and why.**
 *
 * *"Given the minimum window, 880 × 720, then every one of the 45 renders without
 * truncation, without a scrollbar and without overflow."*
 *
 * That is a question about **layout**, and answering it needs something that performs
 * layout. This repo has none: `vitest.config.ts` runs `environment: 'node'`, and there is
 * no jsdom, no happy-dom, no testing-library and no browser in `devDependencies`. Adding
 * one is a stack decision — a new dependency, browser binaries in CI, and a second way to
 * run tests — and the architect owns stack decisions, not this file.
 *
 * **So 22b is not graded yet, and nothing here pretends otherwise.** A test that rendered
 * markup into a string and asserted something about class names would be exactly the
 * instrument this project keeps warning itself about: *"nine times a green instrument has
 * said something true about the wrong thing"*. An overflow checker that cannot measure a
 * box is one of those nine.
 *
 * What this file does instead is hold the two things that **can** be checked without a
 * layout engine, and keep the gap visible:
 *
 *  1. The window minimum the whole criterion is written about is really what the app
 *     enforces. 22b's own [tooling] cell still says *"rendered at 760 × 560 and at
 *     1000 × 680"*, which the 2026-08-30 correction superseded — the sizes now live in the
 *     "Numbers M4 adds for testability only" table as **880 × 720** and **1100 × 720**.
 *     One of those two places is wrong, and this test makes the code the tiebreaker.
 *  2. `minHeight` was owed a change from 560 to 720 by that same correction. **M4 step 2
 *     made it**, which is what this test was written to catch, so it now asserts the
 *     corrected number. The window the app enforces and the window 22b is written about
 *     are finally the same window — which is the precondition for grading 22b at all, not
 *     the grading itself. That gap is still open; see Decision 4 of the 2026-09-02 ADR.
 *
 * See the ADR of 2026-09-02 for the recommendation on how 22b eventually gets graded.
 */

const mainPath = path.join(repoRoot, 'src', 'main', 'main.ts');

/** The corrected pair, from the PRD's own numbers table (2026-08-30). */
export const WINDOW_SIZES = [
  { width: 880, height: 800, why: 'the enforced minimum — type is under pressure here' },
  { width: 1100, height: 720, why: 'the size the window actually opens at' },
] as const;

async function mainSource(): Promise<string> {
  return readFile(mainPath, 'utf8');
}

describe('22b — the window the criterion is written about', () => {
  it('the app enforces the 880 px minimum width the corrected criterion names', async () => {
    const source = await mainSource();
    const found = /minWidth\s*:\s*(\d+)/.exec(source);
    expect(found, 'no minWidth in src/main/main.ts').not.toBeNull();
    expect(
      Number(found?.[1]),
      'PRD §M4 corrected the minimum to 880 × 720 on 2026-08-30 on the strength of ' +
        'main.ts already enforcing 880. If this number moves, 22b is measuring the wrong window.',
    ).toBe(WINDOW_SIZES[0].width);
  });

  it('enforces the 800 px minimum height that criterion 22b now rests on', async () => {
    const source = await mainSource();
    const found = /minHeight\s*:\s*(\d+)/.exec(source);
    expect(found, 'no minHeight in src/main/main.ts').not.toBeNull();
    // 560 → 720 in step 2, then **720 → 800 on 2026-09-04**, when the founder chose to
    // prevent the overflow rather than measure it: CastGood requires a 1080p display, and
    // the window cannot be dragged below a size the layout fits in. 22b is now satisfied by
    // this number holding, so it is asserted here rather than graded by a browser.
    expect(
      Number(found?.[1]),
      'the minimum window is 880 x 800, and criterion 22b rests on it: the tallest ' +
        'persistent state measures 735 px of content. A smaller height here means the app ' +
        'can be dragged to a window that clips a film playing with subtitles on.',
    ).toBe(WINDOW_SIZES[0].height);
  });

  it('is honest that 22b itself is not graded by any tooling yet', () => {
    // There is no assertion to make here beyond the one this comment is. The criterion is
    // [tooling] in the PRD and there is no tooling; that is a gap in M4's evidence and it
    // is recorded in STATUS and in the ADR rather than papered over with a green tick.
    expect(WINDOW_SIZES).toHaveLength(2);
  });
});
