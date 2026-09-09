import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  colourLiterals,
  modality,
  motion,
  opacityAsState,
  typeSizes,
  contrastOfPair,
  relativeToRepo,
} from './scan.js';

/**
 * **The instrument's own test: every checker is shown a fault it must catch.**
 *
 * `placeholder-baseline.json` records these checkers red against today's styling, and that
 * record is the evidence M4's step 1 asks for. But it is evidence with a shelf life: the
 * whole purpose of M4 is to empty that baseline, and once it is empty, a checker that
 * silently stopped working and a checker that has nothing left to find look **exactly the
 * same** — both report zero.
 *
 * This file is what tells them apart, and it keeps working after the restyle. Each checker
 * is pointed at a file containing a planted violation of the rule it owns, and must report
 * it. A regex broken by a refactor fails here on the day it breaks, not in six months when
 * someone notices the app has a hardcoded colour in it.
 *
 * This is 10j's pattern, and the project has been bitten by its absence before: *"nine
 * times a green instrument has said something true about the wrong thing"* (PRD, M4's
 * risks). A green checker is only worth what its ability to go red is worth.
 *
 * `modality` is the one that needs this most. It reports **zero** today — the app really
 * has no modals, and PR #35 removed the last one — so its baseline entry is an empty list
 * and it is indistinguishable from a checker that does nothing at all.
 */

let scratch: string | null = null;

async function fileContaining(contents: string, name = 'Planted.tsx'): Promise<string[]> {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'castgood-design-'));
  const file = path.join(scratch, name);
  await writeFile(file, contents, 'utf8');
  return [file];
}

afterEach(async () => {
  if (scratch !== null) await rm(scratch, { recursive: true, force: true });
  scratch = null;
});

describe('the design checkers can go red', () => {
  it('21b catches a hex literal', async () => {
    const files = await fileContaining('const style = { color: "#ff0000" };\n');
    const found = await colourLiterals(files);
    expect(found.map((v) => v.rule)).toContain('21b/hex-literal');
  });

  it('21b catches an rgb() literal', async () => {
    const files = await fileContaining('const bg = "rgb(12 12 12)";\n');
    const found = await colourLiterals(files);
    expect(found.map((v) => v.rule)).toContain('21b/rgb-or-hsl');
  });

  it('21b catches a Tailwind palette colour, which is the way it will actually happen', async () => {
    const files = await fileContaining('<div className="text-neutral-400 bg-sky-700" />\n');
    const found = await colourLiterals(files);
    expect(found.filter((v) => v.rule === '21b/tailwind-palette')).toHaveLength(2);
  });

  it('21b catches bg-white, which is not a palette number and would slip a numeric rule', async () => {
    const files = await fileContaining('<div className="bg-white" />\n');
    const found = await colourLiterals(files);
    expect(found.map((v) => v.rule)).toContain('21b/named-colour');
  });

  it('21b does NOT fire on the one file allowed to name colours', async () => {
    // The token file defines the palette; if it could not name a colour, nothing could.
    const files = await fileContaining('--text: #F4ECE1;\n', 'tokens.css');
    const found = await colourLiterals(files, relativeToRepo(files[0] as string));
    expect(found).toEqual([]);
  });

  it('22a catches type below the 16 px body floor', async () => {
    const files = await fileContaining('<p className="text-xs" />\n');
    const found = await typeSizes(files);
    expect(found.map((v) => v.rule)).toContain('22a/below-floor');
  });

  it('22a catches an arbitrary size that dodges the token set', async () => {
    const files = await fileContaining('<p className="text-[15px]" />\n');
    const found = await typeSizes(files);
    expect(found.map((v) => v.rule)).toContain('22a/arbitrary-size');
  });

  it('21d catches opacity used as a disabled treatment', async () => {
    const files = await fileContaining('<button className="disabled:opacity-60" />\n');
    const found = await opacityAsState(files);
    expect(found.map((v) => v.rule)).toContain('21d/opacity-utility');
  });

  it('21d catches a raw opacity property too', async () => {
    const files = await fileContaining('.thing { opacity: 0.42; }\n', 'planted.css');
    const found = await opacityAsState(files);
    expect(found.map((v) => v.rule)).toContain('21d/opacity-property');
  });

  it('21d still catches an opacity smuggled into an unlisted keyframes block', async () => {
    // The carve-out added in step 4 lets `opacity` live inside the two animations §10
    // specifies by name. This is the fault it must still catch: the same trick under a
    // third animation's name, which is how the rule would be got around if it could be.
    const files = await fileContaining(
      '@keyframes fade-out { 0% { opacity: 1; } 100% { opacity: 0.3; } }\n',
      'planted.css',
    );
    const found = await opacityAsState(files);
    expect(
      found.map((v) => v.rule),
      'a keyframes block §10 does not name is not a licence to fade a control',
    ).toContain('21d/opacity-property');
  });

  it('21d does not fire on the two animations §10 specifies by name', async () => {
    // The other half of the same proof: a checker that caught this would make the design
    // system's own pulsing dot unbuildable, and the honest fix would then look like a
    // weakened rule rather than a wrong one.
    const files = await fileContaining(
      '@keyframes pulse-dot { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }\n' +
        '@media (prefers-reduced-motion: reduce) { .pulse-dot { opacity: 0.75; } }\n',
      'planted.css',
    );
    expect(await opacityAsState(files)).toEqual([]);
  });

  it('21i catches an unlisted @keyframes', async () => {
    const files = await fileContaining('@keyframes slide-in { from { top: 0 } }\n', 'planted.css');
    const found = await motion(files);
    expect(found.map((v) => v.rule)).toContain('21i/unlisted-keyframes');
  });

  it('21i allows the two §8 animations by name', async () => {
    const files = await fileContaining(
      '@keyframes pulse-dot { }\n@keyframes hairline-slide { }\n',
      'planted.css',
    );
    expect(await motion(files)).toEqual([]);
  });

  it('21i catches a transition on anything but the progress bar width', async () => {
    const files = await fileContaining('<div className="transition-colors duration-300" />\n');
    const found = await motion(files);
    expect(found.map((v) => v.rule)).toContain('21i/transition');
  });

  it('21i catches the allowed width transition run at the wrong duration', async () => {
    const files = await fileContaining(
      '<div className="transition-[width] duration-500 ease-linear" />\n',
    );
    const found = await motion(files);
    expect(found.map((v) => v.rule)).toContain('21i/transition-duration');
  });

  it('21i accepts the allowed width transition at its stated parameters', async () => {
    const files = await fileContaining(
      '<div className="transition-[width] duration-180 ease-linear" />\n',
    );
    expect(await motion(files)).toEqual([]);
  });

  /**
   * The four modality checks matter more than the rest put together, because this checker
   * finds nothing today and will keep finding nothing right up until the moment it should
   * not. A "temporary" overlay for a hard-to-reach state is the exact way the PRD says a
   * modal would come back.
   */
  it('21i catches a <dialog>', async () => {
    const files = await fileContaining('<dialog open>hello</dialog>\n');
    expect((await modality(files)).map((v) => v.rule)).toContain('21i/dialog');
  });

  it('21i catches a React portal', async () => {
    const files = await fileContaining('createPortal(<Thing />, document.body)\n');
    expect((await modality(files)).map((v) => v.rule)).toContain('21i/portal');
  });

  it('21i catches a full-bleed overlay', async () => {
    const files = await fileContaining('<div className="fixed inset-0 bg-black/50" />\n');
    expect((await modality(files)).map((v) => v.rule)).toContain('21i/overlay');
  });

  it('21i catches a title attribute, which is a tooltip carrying information', async () => {
    const files = await fileContaining('<span title="the real explanation">?</span>\n');
    expect((await modality(files)).map((v) => v.rule)).toContain('21i/title-attribute');
  });

  it('21c: the contrast formula agrees with the WCAG worked examples', () => {
    // Black on white is the standard's own anchor, and it is 21:1 exactly.
    expect(contrastOfPair('#000000', '#FFFFFF')).toBeCloseTo(21, 5);
    expect(contrastOfPair('#FFFFFF', '#FFFFFF')).toBeCloseTo(1, 5);
    // A pair that is genuinely borderline, so the checker is not merely ordering things:
    // #767676 on white is the canonical "exactly AA for body text" grey.
    expect(contrastOfPair('#767676', '#FFFFFF')).toBeGreaterThanOrEqual(4.5);
    expect(contrastOfPair('#777777', '#FFFFFF')).toBeLessThan(4.54);
  });
});
