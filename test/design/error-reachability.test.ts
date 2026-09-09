import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './design-system.js';

/**
 * **21g — `--error` is unreachable from every state that is not a failure.**
 *
 * *"Given a state that is **not a failure** … then nothing about it is styled as an error."*
 *
 * This checker exists because of what happened without it. `ConfirmLongPrepare` — the
 * *"this is a long job, shall I?"* question — shipped on `tone: 'needsYou'`, which draws a
 * 2 px `--error` border on a raised surface: the app's language for *something has gone
 * wrong and cannot proceed*. Nothing had gone wrong. §10 names that state in as many
 * words — *"**Steady, not `needsYou`** … It is a decision, and it must not be dressed as a
 * warning"* — and it took a human reading all 50 rows of §2 to notice, in step 6, after the
 * restyle had already been reviewed and its CI had gone green twice.
 *
 * **Nothing else could have caught it.** `21b` sees only colour literals, and this used a
 * token correctly. `21c` recomputes the ratios §10 *states* rather than the pairs the
 * components actually produce. The state renders, reads well and measures 6.71:1. It was
 * simply the wrong sentence in the wrong voice.
 *
 * So the check is not about colour at all. It is: **which states can reach the `needsYou`
 * tone**, compared against the list §10 says may — and the list is read out of the document
 * rather than retyped here, for the same reason the palette is.
 */

const viewModelPath = path.join(repoRoot, 'src', 'renderer', 'state', 'view-model.ts');
const statusRegionPath = path.join(repoRoot, 'src', 'renderer', 'components', 'StatusRegion.tsx');
const designSystemPath = path.join(repoRoot, 'docs', 'DESIGN-SYSTEM.md');

/**
 * The seven `--error` states, read from §10's own sentence.
 *
 * *"`--error` appears on exactly seven states — `Impossible`, `ConnectFailed`, … — and
 * nowhere else in the product."* Parsing it means an eighth cannot be sanctioned by editing
 * a list in a test file, which is the only way this check could be quietly disarmed.
 */
async function statesThatMayFail(): Promise<readonly string[]> {
  const markdown = await readFile(designSystemPath, 'utf8');
  const sentence = /`--error`\*{0,2} appears on exactly seven states\*{0,2} — ([^.]+?) — and/.exec(
    markdown,
  );
  expect(
    sentence,
    '§10 no longer states which states may carry --error, so this checker has nothing to ' +
      'compare against and would pass by knowing nothing',
  ).not.toBeNull();
  return [...(sentence?.[1] ?? '').matchAll(/`([A-Za-z]+)`/g)].map((m) => m[1] as string);
}

/**
 * Every `stateName` in the view model paired with the tone it is returned with.
 *
 * The two sit in the same object literal, so the pairing is the nearest `tone:` after each
 * `stateName:`. Crude, and deliberately so — it reads what a reviewer reads. The guard
 * against it silently matching nothing is the count assertion below.
 */
async function tonesByState(): Promise<ReadonlyMap<string, string>> {
  const source = await readFile(viewModelPath, 'utf8');
  const pairs = new Map<string, string>();
  const pattern = /stateName:\s*'([A-Za-z]+)'[\s\S]{0,600}?tone:\s*'(info|working|needsYou)'/g;
  for (;;) {
    const found = pattern.exec(source);
    if (found === null) break;
    const state = found[1] as string;
    const tone = found[2] as string;
    // A state reached by more than one branch keeps the most severe tone it can produce.
    if (pairs.get(state) === 'needsYou') continue;
    pairs.set(state, tone);
  }
  return pairs;
}

/**
 * §2's names and the DOM's `stateName`s are not the same vocabulary — the code collapses
 * several §2 rows into one rendered state. Flagged by the step 6 review as undocumented;
 * recorded here because 21g cannot be graded without it, and a mapping written down is the
 * first half of fixing it.
 */
const RENDERED_NAME_FOR: Readonly<Record<string, readonly string[]>> = {
  // One `Failed` branch renders ConnectFailed, DiskFull and PrepareFailed.
  Failed: ['ConnectFailed', 'DiskFull', 'PrepareFailed'],
  SourceMissing: ['SourceGone'],
};

describe('21g — nothing that is not a failure is styled as one', () => {
  it('finds both lists at all', async () => {
    expect((await statesThatMayFail()).length).toBe(7);
    expect((await tonesByState()).size).toBeGreaterThan(15);
  });

  it('the StatusRegion really does draw needsYou, and only needsYou, with --error', async () => {
    // The premise the whole test rests on. If the tone stopped carrying `--error`, every
    // assertion below would still pass while measuring nothing.
    const source = await readFile(statusRegionPath, 'utf8');
    const tone = /const TONE[\s\S]*?\n};/.exec(source)?.[0] ?? '';
    expect(tone, 'no TONE map in StatusRegion').not.toBe('');
    const errorLines = tone.split('\n').filter((line) => line.includes('error'));
    expect(errorLines).toHaveLength(1);
    expect(errorLines[0]).toMatch(/needsYou/);
  });

  it('no state outside §10s seven can reach the failure treatment', async () => {
    const permitted = new Set(await statesThatMayFail());
    const offenders: string[] = [];
    for (const [state, tone] of await tonesByState()) {
      if (tone !== 'needsYou') continue;
      const covers = RENDERED_NAME_FOR[state] ?? [state];
      if (covers.some((name) => permitted.has(name))) continue;
      offenders.push(state);
    }
    expect(
      offenders,
      'these states draw the 2 px --error border and the raised surface — the app’s ' +
        'language for "something has gone wrong and cannot proceed" — and §10 does not ' +
        'list them among the seven that may. `ConfirmLongPrepare` is why this test ' +
        'exists: a question that colours itself like a fault is the thing the founder’s ' +
        '"must not look alarming" test forbids.',
    ).toEqual([]);
  });

  it('the three states §10 names as specifically not failures are not failures', async () => {
    // Named because they are the ones most likely to be mistaken for faults: a television
    // taken by someone else, a network that has gone, and a reconnection in progress.
    const tones = await tonesByState();
    for (const state of ['Yielded', 'NetworkDown', 'Reconnecting']) {
      expect(tones.get(state), `${state} has no tone in the view model`).toBeDefined();
      expect(tones.get(state), `§10: ${state} is never styled as a failure`).not.toBe('needsYou');
    }
  });
});
