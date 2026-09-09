import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPalettes, readTypeScale, repoRoot, tokenMap } from './design-system.js';

/**
 * **M4 step 2 — the token layer, held against the document it was copied from.**
 *
 * `src/renderer/tokens.css` is the only file in the renderer allowed to name a colour, and
 * everything downstream of it — 45 screens — inherits whatever it says. So the risk it
 * carries is not that a value is wrong today; it is that a value is *edited* later without
 * its row in `docs/DESIGN-SYSTEM.md` §10, leaving a palette whose stated contrast ratios
 * describe a colour the app no longer paints. `palette.test.ts` would go on proving §10's
 * arithmetic, correctly, about the wrong hex.
 *
 * This file closes that: every token is compared against §10, both directions, so neither
 * can move without the other.
 *
 * **Dark only, on purpose.** The ADR of 2026-08-30 chose one appearance for v1. §10
 * documents a light palette too and `palette.test.ts` verifies its numbers, but the app
 * ships the dark one, so that is the palette the stylesheet is required to carry — and
 * carrying the light one as well would be an appearance no screen has been approved in.
 */

const tokensPath = path.join(repoRoot, 'src', 'renderer', 'tokens.css');
const indexCssPath = path.join(repoRoot, 'src', 'renderer', 'index.css');
const mainPath = path.join(repoRoot, 'src', 'main', 'main.ts');

/** `--bg: #100e0a;` → `--bg` → `#100e0a`. Declarations only; `var(--x)` aliases are not. */
async function declaredTokens(): Promise<ReadonlyMap<string, string>> {
  const source = await readFile(tokensPath, 'utf8');
  const declarations = new Map<string, string>();
  const pattern = /^\s*(--[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/gm;
  for (;;) {
    const found = pattern.exec(source);
    if (found === null) break;
    declarations.set(found[1] as string, (found[2] as string).toLowerCase());
  }
  return declarations;
}

async function darkPalette(): Promise<ReadonlyMap<string, string>> {
  const palettes = await readPalettes();
  const dark = palettes.find((palette) => palette.name === 'dark');
  expect(
    dark,
    '§10 has no dark palette table — the heading it is found by has moved',
  ).toBeDefined();
  return tokenMap(dark as NonNullable<typeof dark>);
}

/** `--radius-box: var(--r);` inside a `@theme` block → `{ namespace: 'radius', name: 'box' }`. */
async function themeKeys(): Promise<readonly { namespace: string; name: string }[]> {
  const source = await readFile(tokensPath, 'utf8');
  const keys: { namespace: string; name: string }[] = [];
  const pattern = /^\s*--([a-z]+)-([a-z0-9-]+)\s*:/gm;
  for (;;) {
    const found = pattern.exec(source);
    if (found === null) break;
    keys.push({ namespace: found[1] as string, name: found[2] as string });
  }
  return keys;
}

describe('M4 step 2 — the tokens match the design system', () => {
  it('finds tokens to check at all, in both places', async () => {
    // The guard against a silently-passing test: a renamed heading or a moved file would
    // otherwise leave every assertion below comparing one empty set to another.
    expect((await darkPalette()).size).toBeGreaterThan(10);
    expect((await declaredTokens()).size).toBeGreaterThan(10);
  });

  it('carries every colour §10 names, at exactly the hex §10 states', async () => {
    const declared = await declaredTokens();
    for (const [token, hex] of await darkPalette()) {
      expect(declared.get(token), `${token} is missing from tokens.css`).toBe(hex.toLowerCase());
    }
  });

  it('names no colour §10 does not', async () => {
    const palette = await darkPalette();
    const invented = [...(await declaredTokens()).keys()].filter((token) => !palette.has(token));
    expect(
      invented,
      'tokens.css defines a colour with no row in §10, so it has no stated contrast ratio ' +
        'and no approval. Add the row, or spend an existing token.',
    ).toEqual([]);
  });

  it('sets the type scale to §10s sizes, not Tailwinds', async () => {
    const source = await readFile(tokensPath, 'utf8');
    const scale = await readTypeScale();
    expect(scale.length, '§10 has no type table').toBe(4);
    for (const row of scale) {
      expect(source, `${row.token} is not set to ${String(row.px)}px`).toMatch(
        new RegExp(`^\\s*${row.token}:\\s*${String(row.px)}px;`, 'm'),
      );
      expect(source).toMatch(
        new RegExp(`^\\s*${row.token}--line-height:\\s*${String(row.lineHeight)};`, 'm'),
      );
      expect(source).toMatch(
        new RegExp(`^\\s*${row.token}--font-weight:\\s*${String(row.weight)};`, 'm'),
      );
    }
  });

  it('is actually loaded — index.css imports it', async () => {
    // A token file nothing imports is a document, not a stylesheet. This is the cheapest
    // possible proof that the values reach a window.
    expect(await readFile(indexCssPath, 'utf8')).toMatch(/@import\s+'\.\/tokens\.css'/);
  });

  it("the window's own background is --bg, so first paint is not a different colour", async () => {
    // The pairing src/renderer/index.css used to describe in a comment and ask you to
    // remember. It was got wrong once already — black text on a black window.
    const background = /backgroundColor:\s*'(#[0-9a-fA-F]{6})'/.exec(
      await readFile(mainPath, 'utf8'),
    );
    expect(background, 'no backgroundColor in src/main/main.ts').not.toBeNull();
    expect(
      background?.[1]?.toLowerCase(),
      'BrowserWindow paints this before the renderer does. If it is not --bg, the window ' +
        'flashes a colour that is in no palette.',
    ).toBe((await darkPalette()).get('--bg')?.toLowerCase());
  });

  it('has no light-theme block, because v1 has one appearance', async () => {
    const source = await readFile(tokensPath, 'utf8');
    // The at-rule, not the words: the file's own comment explains why there isn't one,
    // and a test that could not tell those apart would fail on its own documentation.
    expect(
      source,
      'the ADR of 2026-08-30 chose dark only and no theme setting; a prefers-color-scheme ' +
        'block here is a second appearance nobody has approved a screen in',
    ).not.toMatch(/@media[^{]*prefers-color-scheme/);
  });
});

/**
 * Theme keys whose generated utility name means something **different** in Tailwind.
 *
 * Not every name Tailwind already uses. Redefining `--text-lg` is how theming is supposed
 * to work: it overrides `text-lg` with another font size, which is the same meaning at a
 * different value. The danger is only where the two meanings diverge — a custom
 * `--radius-r` and Tailwind's built-in `rounded-r` (round the *right-hand side*) both emit
 * `.rounded-r`, in the same layer, at the same specificity, and the built-in is written
 * second and wins. Nothing errors, nothing warns, the build succeeds, every checker stays
 * green, and the token reaches no rendered pixel.
 *
 * So this list is the directional and corner shorthands, which are the only radius names
 * that are not sizes, plus the colour keywords Tailwind already spends.
 */
const TAILWIND_UTILITY_NAMES: Readonly<Record<string, readonly string[]>> = {
  radius: ['t', 'r', 'b', 'l', 's', 'e', 'tl', 'tr', 'br', 'bl', 'ss', 'se', 'ee', 'es'],
  color: ['inherit', 'current', 'transparent', 'black', 'white'],
};

describe('M4 step 2 — no token quietly loses to a Tailwind utility of the same name', () => {
  it('reads theme keys out of tokens.css at all', async () => {
    expect((await themeKeys()).length).toBeGreaterThan(10);
  });

  it('names no utility Tailwind already defines', async () => {
    const collisions = (await themeKeys()).filter(({ namespace, name }) =>
      (TAILWIND_UTILITY_NAMES[namespace] ?? []).includes(name),
    );
    expect(
      collisions.map(({ namespace, name }) => `--${namespace}-${name}`),
      'this theme key generates a utility Tailwind already defines. Both are emitted, the ' +
        'built-in is written second, and it wins — so the token reaches no rendered pixel ' +
        'while the build stays green and every checker stays quiet. That shipped once: ' +
        '`--radius-r` gave every panel, region, row and button in the app square left ' +
        'corners and a 4 px right edge for the length of a review cycle. Rename the key.',
    ).toEqual([]);
  });
});
