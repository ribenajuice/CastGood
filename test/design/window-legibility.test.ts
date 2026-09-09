import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * **Why this file is in `test/design/` and not `test/architecture/`, where it was written.**
 *
 * Its subject is colour, which is M4's subject. It was filed under architecture because
 * when it was written there was no design suite to put it in — visual design was deferred
 * and this was the stopgap that kept a placeholder build legible until the real thing
 * arrived. The real thing is here.
 *
 * The move was forced, and the forcing is worth recording: **21j caught this file being
 * edited on an M4 branch and was right to.** That rule exists so a visual pass cannot
 * quietly change the tests that prove the engine still works, because the four hardware
 * aggregates are only evidence if they exercise code M4 did not touch. This test proves
 * nothing about the engine — it compares two hex values — so it was the one file in that
 * directory the rule should never have covered. The answer was to move it, not to put a
 * hole in the rule; see `engine-untouched.test.ts`, which now names this single path and
 * explains why it is the only one.
 *
 * ---
 *
 * The window's background colour is declared twice: once in the main process, so the
 * window paints before the renderer loads (no white flash), and once in the renderer's
 * stylesheet. If they drift apart the app looks broken; if the stylesheet omits `color`
 * entirely the text falls back to black, which on a dark window is invisible.
 *
 * That shipped once — an installed build showed black text on a near-black window. These
 * assertions exist so it cannot ship again.
 *
 * **M4 step 2 put a level of indirection in the way**: `index.css` now says
 * `background: var(--bg)` rather than a hex, because `tokens.css` is the only file allowed
 * to name a colour. A check that needed to see a literal would have started passing
 * vacuously — `?.[1]` on a failed match is `undefined`, and two `undefined`s compare
 * equal — which is precisely the incident this file exists to prevent, wearing a green
 * tick. So it resolves the token instead, and an unresolvable `var()` fails loudly.
 */

const root = path.resolve(__dirname, '../..');
const read = (p: string): string => readFileSync(path.join(root, p), 'utf8');

const hex = /#[0-9a-fA-F]{3,8}/;

/** `var(--bg)` → `#100e0a`, one level, against the file that declares the tokens. */
const resolveTokens = (css: string, tokens: string): string =>
  css.replace(/var\((--[a-z0-9-]+)\)/g, (whole, token: string) => {
    const declared = new RegExp(`^\\s*${token}\\s*:\\s*(#[0-9a-fA-F]{3,8})\\s*;`, 'm').exec(tokens);
    // Left as-is when it cannot be resolved, so the assertions below fail on the literal
    // `var(--x)` rather than quietly matching nothing.
    return declared?.[1] ?? whole;
  });

describe('window legibility', () => {
  const mainSource = read('src/main/main.ts');
  const cssSource = resolveTokens(read('src/renderer/index.css'), read('src/renderer/tokens.css'));

  it('resolves the two colours it is about to check, rather than checking nothing', () => {
    // The guard on the guard. If tokens.css is renamed, or `--bg` stops being declared as a
    // hex, the assertions below would be reading the literal `var(--bg)` and finding no
    // colour at all — passing on two `undefined`s. Only the colours have to resolve:
    // `font-family: var(--font-sans)` is not a hex and is not what this file is about.
    const bodyRule = /body\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? '';
    expect(bodyRule, 'body background did not resolve to a colour').toMatch(/background:\s*#/);
    expect(bodyRule, 'body text colour did not resolve to a colour').toMatch(/[^-]color:\s*#/);
  });

  it('declares a background colour on the BrowserWindow', () => {
    expect(mainSource).toMatch(/backgroundColor:\s*'#[0-9a-fA-F]{3,8}'/);
  });

  it('paints the same background in the renderer as the window does', () => {
    const windowBg = /backgroundColor:\s*'(#[0-9a-fA-F]{3,8})'/.exec(mainSource)?.[1];
    const bodyBg = /body\s*\{[^}]*background:\s*(#[0-9a-fA-F]{3,8})/.exec(cssSource)?.[1];

    expect(windowBg, 'no backgroundColor in src/main/main.ts').toBeDefined();
    expect(bodyBg, 'no body background in src/renderer/index.css').toBeDefined();
    expect(bodyBg?.toLowerCase()).toBe(windowBg?.toLowerCase());
  });

  it('sets an explicit text colour, so it never falls back to black', () => {
    const bodyRule = /body\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? '';
    expect(bodyRule).toMatch(/color:\s*#/);
  });

  it('keeps text and background far enough apart to read', () => {
    const bodyRule = /body\s*\{[^}]*\}/.exec(cssSource)?.[0] ?? '';
    const bg = /background:\s*(#[0-9a-fA-F]{6})/.exec(bodyRule)?.[1];
    const fg = /[^-]color:\s*(#[0-9a-fA-F]{6})/.exec(bodyRule)?.[1];

    expect(bg, 'body background must be a 6-digit hex for this check').toMatch(hex);
    expect(fg, 'body color must be a 6-digit hex for this check').toMatch(hex);

    // WCAG relative luminance → contrast ratio. AA body text is 4.5:1.
    const luminance = (colour: string): number => {
      const channels = [1, 3, 5].map((i) => parseInt(colour.slice(i, i + 2), 16) / 255);
      const [r, g, b] = channels.map((c) =>
        c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
      );
      return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
    };

    const a = luminance(bg!);
    const b = luminance(fg!);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });
});
