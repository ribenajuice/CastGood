import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  colourLiterals,
  modality,
  motion,
  opacityAsState,
  rendererFiles,
  sortViolations,
  typeSizes,
  type Violation,
} from './scan.js';

/**
 * **M4 step 1: the checkers, and the record of them red.**
 *
 * The PRD is blunt about why this file exists before any restyling happens: *"Against
 * today's placeholder styling they must **fail**. A checker written after the restyle
 * proves nothing (10j's pattern)."*
 *
 * So each checker is compared against `placeholder-baseline.json` — a machine-generated
 * record of **exactly** what is wrong with the placeholder styling on 2026-09-02, before
 * a single token exists. That comparison does three jobs at once:
 *
 *  1. **It is the "seen red" evidence.** 107 violations, listed by file and line, in the
 *     tree, reviewable. Not a claim in a status report that a checker once failed.
 *  2. **It fails on anything new.** A restyle that introduces a fresh literal is caught
 *     the same day rather than at the end of 45 screens.
 *  3. **It fails on anything *fixed* too**, which is the part that matters. Every step of
 *     the restyle must shrink this file, and the shrinking is visible in the diff. **M4 is
 *     finished, on this axis, when every list here is empty** — at which point these
 *     assertions are ordinary green checks and the baseline is an empty husk that should
 *     be deleted.
 *
 * The separate proof that these checkers *can* go red at all — independent of the
 * baseline, and surviving the restyle that empties it — is `checkers-can-fail.test.ts`.
 *
 * **The one M4 checker that is not here is overflow (22b).** It is a question about layout
 * and this repo has no layout engine; see `overflow.test.ts`, which says so rather than
 * pretending otherwise.
 */

const baselinePath = path.join(import.meta.dirname, 'placeholder-baseline.json');

interface Baseline {
  readonly colourLiterals: readonly Violation[];
  readonly typeSizes: readonly Violation[];
  readonly opacityAsState: readonly Violation[];
  readonly motion: readonly Violation[];
  readonly modality: readonly Violation[];
}

async function readBaseline(): Promise<Baseline> {
  return JSON.parse(await readFile(baselinePath, 'utf8')) as Baseline;
}

/**
 * `UPDATE_DESIGN_BASELINE=1 npm test` re-records the file.
 *
 * The message below has told people to run this since step 1; step 2 is the first time
 * the baseline actually shrinks, so this is the first time it needed to exist. It writes
 * the *whole* record from a single scan rather than patching entries, so a run cannot
 * leave a half-updated baseline behind.
 *
 * It is opt-in by environment variable and never by default, for the obvious reason: a
 * baseline that re-records itself whenever it disagrees with the source is not evidence
 * of anything. The diff is the review.
 */
const RE_RECORD = process.env['UPDATE_DESIGN_BASELINE'] === '1';

/**
 * Reports the difference in the direction that explains it, because the two directions
 * mean opposite things: something new is a regression, something gone is progress that
 * has not been recorded.
 */
function describeDrift(actual: readonly Violation[], expected: readonly Violation[]): string {
  const key = (v: Violation): string => `${v.file}:${String(v.line)} ${v.rule} ${v.detail}`;
  const before = new Set(expected.map(key));
  const after = new Set(actual.map(key));
  const added = [...after].filter((k) => !before.has(k));
  const fixed = [...before].filter((k) => !after.has(k));
  return [
    added.length === 0 ? '' : `NEW violations (a regression):\n  ${added.join('\n  ')}`,
    fixed.length === 0
      ? ''
      : `FIXED since the baseline — good, now re-run with UPDATE_DESIGN_BASELINE=1 to record it:\n  ${fixed.join('\n  ')}`,
  ]
    .filter((line) => line !== '')
    .join('\n\n');
}

describe('M4 step 1 — the checkers, against the placeholder styling', () => {
  it('has renderer files to check at all', async () => {
    const files = await rendererFiles();
    expect(files.length).toBeGreaterThan(10);
  });

  it('the baseline records the placeholder styling as failing', async () => {
    const baseline = await readBaseline();
    const total =
      baseline.colourLiterals.length +
      baseline.typeSizes.length +
      baseline.opacityAsState.length +
      baseline.motion.length +
      baseline.modality.length;
    // Not an arbitrary number: it is the count on the day the checkers were written, and
    // its only job is to make an empty baseline impossible to arrive at by accident. When
    // M4 legitimately empties it, this assertion is what forces a deliberate edit.
    expect(
      total,
      'the baseline is empty — either M4 is complete on these axes (delete this file and ' +
        'flip the assertions to expect zero), or the scanners have silently stopped finding ' +
        'anything, which is the failure mode this assertion exists to catch',
    ).toBeGreaterThan(0);
  });

  const cases = [
    { name: 'colourLiterals', criterion: '21b', run: colourLiterals },
    { name: 'typeSizes', criterion: '22a', run: typeSizes },
    { name: 'opacityAsState', criterion: '21d', run: opacityAsState },
    { name: 'motion', criterion: '21i', run: motion },
    { name: 'modality', criterion: '21i', run: modality },
  ] as const;

  for (const { name, criterion, run } of cases) {
    it(`${criterion} — ${name} matches the recorded baseline exactly`, async () => {
      const files = await rendererFiles();
      const actual = sortViolations(await run(files));
      const baseline = await readBaseline();
      const expected = baseline[name];
      if (RE_RECORD) {
        await writeFile(
          baselinePath,
          `${JSON.stringify({ ...baseline, [name]: actual }, null, 2)}\n`,
          'utf8',
        );
        return;
      }
      expect(actual, describeDrift(actual, expected)).toEqual(expected);
    });
  }
});
