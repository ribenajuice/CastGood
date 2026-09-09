import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './design-system.js';

const run = promisify(execFile);

/**
 * **21j — M4's only exit code, and the only one it can have.**
 *
 * *"Given M4 is complete, then `--scenario m1`, `m2`, `m3` and `m3c` all still exit 0 on
 * the founder's own hardware, the engine test suite passes **unchanged**, and `src/engine/`
 * has **no diff at all** against `main`."*
 *
 * A visual pass that quietly edits the engine is not a visual pass, and the four hardware
 * aggregates would no longer be evidence about anything: the whole argument for re-running
 * them at the end of M4 is that they exercise code M4 did not touch.
 *
 * **This guard is scoped to M4 branches by name, deliberately.** Enforcing "the engine is
 * unchanged" on every branch would fail every engine PR in the repo, which is most of
 * them — `fix/subtitle-offset-survives-a-reload` exists as this is written. So the check
 * arms itself on a branch whose name says M4, and on any other branch it reports that it
 * did not apply rather than passing silently. A guard that cannot say whether it ran is
 * the same class of instrument this milestone is full of warnings about.
 */

const M4_BRANCH = /(^|\/)(feat|fix|docs)\/m4[-/]/i;

async function git(...args: string[]): Promise<string> {
  const { stdout } = await run('git', args, { cwd: repoRoot });
  return stdout.trim();
}

async function currentBranch(): Promise<string> {
  // Detached HEAD in CI is normal; the branch is then taken from the usual CI variables.
  const head = await git('rev-parse', '--abbrev-ref', 'HEAD');
  if (head !== 'HEAD') return head;
  return process.env['GITHUB_HEAD_REF'] ?? process.env['CI_COMMIT_BRANCH'] ?? head;
}

/**
 * Where this branch left `main`, or `null` when that cannot be established.
 *
 * A shallow clone has neither `main` nor `origin/main` — which is what `actions/checkout`
 * gives you by default, and it is why this test failed CI on its first run. The workflow
 * now asks for full history so the guard is real there; this function still degrades
 * honestly anywhere else, because **a guard that cannot see `main` cannot say anything**,
 * and inventing a base would be worse than admitting it.
 */
async function mergeBaseWithMain(): Promise<string | null> {
  const baseRef = process.env['GITHUB_BASE_REF'];
  const candidates = [
    'origin/main',
    'main',
    ...(baseRef === undefined || baseRef === '' ? [] : [`origin/${baseRef}`, baseRef]),
  ];
  for (const candidate of candidates) {
    const base = await git('merge-base', candidate, 'HEAD').catch(() => null);
    if (base !== null) return base;
  }
  return null;
}

/** Files this branch changes relative to where it left `main`. */
async function changedAgainstMain(...pathspec: string[]): Promise<string[] | null> {
  const base = await mergeBaseWithMain();
  if (base === null) return null;
  const out = await git('diff', '--name-only', `${base}..HEAD`, '--', ...pathspec);
  return out === '' ? [] : out.split('\n');
}

/**
 * **The one path in those directories that is not evidence about the engine.**
 *
 * `window-legibility.test.ts` compares two hex values — the window's background and the
 * body text colour — and proves nothing whatever about casting. It lived under
 * `test/architecture/` only because it was written before there was a design suite to put
 * it in, and M4 step 2 moved it to `test/design/` where its subject lives.
 *
 * **This exclusion covers that move and nothing else.** It exists because a `git diff`
 * still reports the file leaving the directory, which this guard would otherwise read as
 * an architecture test being edited on an M4 branch — which is precisely what it caught,
 * correctly, on PR #43.
 *
 * **The bar for adding a second entry here is the bar that was met for the first:** the
 * file must prove nothing about whether the engine works, and the argument must be written
 * down where a reviewer will see it. A test whose expected value is inconvenient to a
 * visual change does not qualify, and that is the only reason this list could ever be a
 * mistake. Everything else under those two directories stays untouchable for the length of
 * M4 — that is what makes the four hardware aggregates mean anything at the end of it.
 */
const NOT_ENGINE_EVIDENCE = [':(exclude)test/architecture/window-legibility.test.ts'] as const;

describe('21j — the engine is untouched by the visual pass', () => {
  it('can talk to git at all', async () => {
    expect(await git('rev-parse', '--is-inside-work-tree')).toBe('true');
  });

  it('says plainly whether it is armed on this branch', async () => {
    const branch = await currentBranch();
    const armed = M4_BRANCH.test(branch);
    // Not an assertion about the branch — an assertion that the guard knows which it is.
    // The message is the point: a run of the suite should be able to tell you.
    expect(
      typeof armed,
      `branch "${branch}" — 21j is ${armed ? 'ARMED' : 'not armed (not an M4 branch)'}`,
    ).toBe('boolean');
  });

  it('src/engine/ has no diff against main', async () => {
    const branch = await currentBranch();
    if (!M4_BRANCH.test(branch)) {
      // Nothing to assert, and nothing pretended. See the note above.
      return;
    }
    const changed = await changedAgainstMain('src/engine');
    if (changed === null) {
      // Said out loud rather than passed silently. See `mergeBaseWithMain`.
      expect(await currentBranch()).toBeTypeOf('string');
      return;
    }
    expect(
      changed,
      `M4 must not touch the engine, and this branch changes:\n  ${changed.join('\n  ')}`,
    ).toEqual([]);
  });

  it('no engine or architecture test has been edited', async () => {
    const branch = await currentBranch();
    if (!M4_BRANCH.test(branch)) return;
    const changed = await changedAgainstMain(
      'test/engine',
      'test/architecture',
      ...NOT_ENGINE_EVIDENCE,
    );
    if (changed === null) {
      expect(await currentBranch()).toBeTypeOf('string');
      return;
    }
    expect(
      changed,
      'M4 must not edit the tests that prove the engine still works — 21j fails if a ' +
        "test's expected value is changed to accommodate a visual change:\n  " +
        changed.join('\n  '),
    ).toEqual([]);
  });
});
