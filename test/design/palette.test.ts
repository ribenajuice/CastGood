import { describe, expect, it } from 'vitest';
import {
  contrastRatio,
  lightnessOf,
  readPalettes,
  tokenMap,
  type Palette,
} from './design-system.js';

/**
 * **21c and 21d — contrast, computed rather than claimed.**
 *
 * `DESIGN-SYSTEM.md` §10 states a contrast ratio beside every token, and says how they
 * were arrived at: *"computed from the WCAG 2.1 relative-luminance formula … at the exact
 * hex values in the table — not eyeballed, and not 'AA-ish'."* Those numbers are about to
 * be painted onto **45 screens**, and the founder approved the palette on the strength of
 * them. So this file recomputes every one of them.
 *
 * That is a different and stronger check than "the palette passes AA". It catches the case
 * where a token is edited and the table beside it is not — the palette drifting away from
 * its own documentation, silently, while every ratio in the document still reads fine.
 *
 * **Note what this file does *not* do.** It grades the *palette*. It cannot grade what the
 * components actually put on top of what, because that is a question about rendered pairs
 * and this repo has no layout engine — see `overflow.test.ts`. 21c's *"every pair the
 * components can actually produce"* is only fully answered once the token set exists and
 * the components reference it by name; the pair enumeration below is over the pairs §10
 * itself declares, which is what exists to be checked today.
 */

/** §10: *"Nothing in this app relies on the 3:1 'large text' allowance."* */
const AA_BODY = 4.5;
/** Non-text: control boundaries and focus rings. */
const AA_NON_TEXT = 3;

/** Rounding tolerance: the table states two decimals. */
const TOLERANCE = 0.02;

/** Tokens whose job is to carry text, so they are held to 4.5:1 wherever they are used. */
const TEXT_TOKENS = ['--text', '--text-muted', '--on-brand'];

/** Tokens that identify a control or carry state, held to 3:1. */
const NON_TEXT_TOKENS = ['--line-strong', '--accent', '--track-prepared'];

/**
 * `--line` is explicitly decorative and is the one token allowed below 3:1 — §10:
 * *"`--line` is decorative and may never be the only thing identifying a control."*
 * That rule is graded by review, not here; what is graded here is that nothing *else*
 * is allowed to sit at its level.
 */
const DECORATIVE_TOKENS = ['--line'];

describe('M4 — the palette computes to what §10 says it computes to', () => {
  it('finds both palettes and every token in them', async () => {
    const palettes = await readPalettes();
    // The instrument's own guard: a renamed heading or a reformatted table must break the
    // build loudly rather than quietly checking nothing.
    expect(palettes.map((p) => p.name)).toEqual(['dark', 'light']);
    for (const palette of palettes) {
      expect(palette.rows.length, `${palette.name} palette`).toBeGreaterThanOrEqual(15);
      for (const row of palette.rows) {
        expect(row.hex, `${palette.name} ${row.token}`).toMatch(/^#[0-9A-Fa-f]{6}$/);
      }
    }
  });

  it('states at least forty contrast claims to check', async () => {
    const palettes = await readPalettes();
    const claims = palettes.flatMap((p) => p.rows.flatMap((r) => r.claims));
    expect(claims.length).toBeGreaterThanOrEqual(40);
  });

  const each = (name: string, body: (palette: Palette) => void | Promise<void>): void => {
    for (const which of ['dark', 'light'] as const) {
      it(`${which}: ${name}`, async () => {
        const palettes = await readPalettes();
        const palette = palettes.find((p) => p.name === which);
        expect(palette, `no ${which} palette`).toBeDefined();
        await body(palette as Palette);
      });
    }
  };

  each('every stated contrast ratio recomputes to the stated value', (palette) => {
    const map = tokenMap(palette);
    for (const row of palette.rows) {
      for (const claim of row.claims) {
        const against = map.get(claim.against);
        expect(
          against,
          `${row.token} is measured against ${claim.against}, which is not a token`,
        ).toBeDefined();
        const actual = contrastRatio(row.hex, against as string);
        expect(
          Math.abs(actual - claim.ratio),
          `${palette.name} ${row.token} (${row.hex}) on ${claim.against} (${String(against)}): ` +
            `§10 states ${String(claim.ratio)}:1, the formula gives ${actual.toFixed(2)}:1`,
        ).toBeLessThanOrEqual(TOLERANCE);
      }
    }
  });

  each('every stated L* recomputes to the stated value', (palette) => {
    const stated = palette.rows.filter((row) => row.lightness !== null);
    expect(stated.length, 'the surface ramp states no L* values').toBeGreaterThanOrEqual(3);
    for (const row of stated) {
      const actual = lightnessOf(row.hex);
      expect(
        Math.abs(actual - (row.lightness as number)),
        `${palette.name} ${row.token} (${row.hex}): §10 states L* ${String(row.lightness)}, ` +
          `the formula gives ${actual.toFixed(2)}`,
      ).toBeLessThanOrEqual(0.15);
    }
  });

  each('every text token meets 4.5:1 on every surface it is stated against', (palette) => {
    for (const row of palette.rows) {
      if (!TEXT_TOKENS.includes(row.token)) continue;
      expect(row.claims.length, `${row.token} states no contrast at all`).toBeGreaterThan(0);
      for (const claim of row.claims) {
        expect(
          claim.ratio,
          `${palette.name} ${row.token} on ${claim.against} is ${String(claim.ratio)}:1 — ` +
            'below AA for body text, and §10 does not spend the 3:1 large-text allowance',
        ).toBeGreaterThanOrEqual(AA_BODY);
      }
    }
  });

  each('every control-identifying token meets 3:1 wherever it is stated', (palette) => {
    for (const row of palette.rows) {
      if (!NON_TEXT_TOKENS.includes(row.token)) continue;
      for (const claim of row.claims) {
        expect(
          claim.ratio,
          `${palette.name} ${row.token} on ${claim.against} is ${String(claim.ratio)}:1, below 3:1`,
        ).toBeGreaterThanOrEqual(AA_NON_TEXT);
      }
    }
  });

  each('--error is legible on the surface the needsYou region actually uses', (palette) => {
    const error = palette.rows.find((row) => row.token === '--error');
    expect(error, 'no --error token').toBeDefined();
    const map = tokenMap(palette);
    const surface2 = map.get('--surface-2');
    expect(surface2).toBeDefined();
    // 21g reserves --error for `needsYou`, whose region sits on --surface-2. A border that
    // is the *only* thing marking a genuine failure has to clear 3:1 on the surface it is
    // actually drawn on, not on the one it happens to be tabulated against.
    const actual = contrastRatio((error as { hex: string }).hex, surface2 as string);
    expect(actual, `--error on --surface-2 is ${actual.toFixed(2)}:1`).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  each(
    'only --line is allowed to sit below 3:1 on a surface it is actually drawn on',
    (palette) => {
      // **Graded over the pairs §10 declares, not over every combination.** `--on-brand` is
      // the label on a `--brand` fill and is never drawn on `--surface`; `--track-prepared`
      // sits on `--track`. Inventing those pairs would fail the palette for a contrast that
      // nothing ever renders — the "hand-picked subset" failure of 21c in its other
      // direction, and the reason the claims are read out of the document rather than
      // enumerated here.
      for (const row of palette.rows) {
        if (DECORATIVE_TOKENS.includes(row.token)) continue;
        for (const claim of row.claims) {
          const actual = contrastRatio(row.hex, tokenMap(palette).get(claim.against) as string);
          expect(
            actual,
            `${palette.name} ${row.token} is ${actual.toFixed(2)}:1 on ${claim.against}. Only ` +
              '--line may sit below 3:1, and §10 says why: it may never be the only thing ' +
              'identifying a control',
          ).toBeGreaterThanOrEqual(AA_NON_TEXT);
        }
      }
    },
  );

  it('dark: the surface ramp really is a perceptible three-step ramp', async () => {
    const palettes = await readPalettes();
    const dark = palettes.find((p) => p.name === 'dark') as Palette;
    const map = tokenMap(dark);
    const steps = ['--bg', '--surface', '--surface-2'].map((token) =>
      lightnessOf(map.get(token) as string),
    );
    // §10 states 6.6 and 4.6 L*. Depth in this design is bought entirely with these two
    // steps plus a hairline — there are no shadows — so if they flatten, the window really
    // does become the "black rectangle" the direction section is written against.
    expect((steps[1] as number) - (steps[0] as number)).toBeGreaterThan(4);
    expect((steps[2] as number) - (steps[1] as number)).toBeGreaterThan(3);
  });

  it('dark: nothing is pure white, which is the dark-room rule §10 states', async () => {
    const palettes = await readPalettes();
    const dark = palettes.find((p) => p.name === 'dark') as Palette;
    for (const row of dark.rows) {
      expect(row.hex.toUpperCase(), `${row.token} is pure white`).not.toBe('#FFFFFF');
    }
  });
});
