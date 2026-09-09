import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * **The design system, read rather than retyped.**
 *
 * `docs/DESIGN-SYSTEM.md` §10 is the source of truth for M4's tokens: it carries the hex
 * values *and* the contrast ratio claimed for each one, computed when the palette was
 * drawn. Every number in it is about to be painted onto 45 screens, so the checkers read
 * it instead of keeping a second copy that could drift — a hand-copied palette is exactly
 * the "list that can drift from the enum" 21a rejects, in a different variable.
 *
 * Parsing markdown is brittle, and that is handled the way this repo handles every other
 * instrument: `parse-is-not-empty.test.ts` fails if the tables stop being found, so a
 * renamed heading breaks the build loudly rather than silently checking nothing.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
export const designSystemPath = path.join(repoRoot, 'docs', 'DESIGN-SYSTEM.md');
export const rendererRoot = path.join(repoRoot, 'src', 'renderer');
export { repoRoot };

export interface TokenRow {
  readonly token: string;
  readonly hex: string;
  readonly use: string;
  /** Every `X:1 on --token` claim on the row, in the order written. */
  readonly claims: readonly { readonly ratio: number; readonly against: string }[];
  /** `L* 4.0`, when the row states one instead of a ratio. */
  readonly lightness: number | null;
}

export interface Palette {
  readonly name: 'dark' | 'light';
  readonly rows: readonly TokenRow[];
}

/** `#F4ECE1` → `[244, 236, 225]`. Throws rather than guessing at a malformed value. */
export function rgbOf(hex: string): readonly [number, number, number] {
  const match = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (match === null) throw new Error(`not a 6-digit hex colour: ${hex}`);
  const digits = match[1] as string;
  return [
    Number.parseInt(digits.slice(0, 2), 16),
    Number.parseInt(digits.slice(2, 4), 16),
    Number.parseInt(digits.slice(4, 6), 16),
  ];
}

/** WCAG 2.1 relative luminance: `0.2126R + 0.7152G + 0.0722B` over linearised sRGB. */
export function relativeLuminance(hex: string): number {
  const channels = rgbOf(hex).map((value) => {
    const s = value / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return (
    0.2126 * (channels[0] as number) +
    0.7152 * (channels[1] as number) +
    0.0722 * (channels[2] as number)
  );
}

/** WCAG 2.1 contrast ratio. Order-independent, as the standard defines it. */
export function contrastRatio(a: string, b: string): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}

/** CIE L\*, the perceptual lightness the surface ramp's steps are stated in. */
export function lightnessOf(hex: string): number {
  const y = relativeLuminance(hex);
  return y <= 216 / 24389 ? y * (24389 / 27) : Math.cbrt(y) * 116 - 16;
}

const CLAIM = /\*{0,2}(\d+\.\d+):1\*{0,2}\s+on\s+`(--[a-z0-9-]+)`/gi;
const ROW = /^\|\s*`(--[a-z0-9-]+)`\s*\|\s*`(#[0-9A-Fa-f]{6})`\s*\|([^|]*)\|([^|]*)\|\s*$/;

/**
 * The two palette tables of §10, in document order: dark first, then light.
 *
 * A table is identified by the `**Dark**` / `**Light:**` label that introduces it rather
 * than by position, so inserting a section above them changes nothing here.
 */
export async function readPalettes(): Promise<readonly Palette[]> {
  const markdown = await readFile(designSystemPath, 'utf8');
  const lines = markdown.split('\n');
  const palettes: { name: 'dark' | 'light'; rows: TokenRow[] }[] = [];
  let current: { name: 'dark' | 'light'; rows: TokenRow[] } | null = null;

  for (const line of lines) {
    if (/^\*\*Dark\*\*/.test(line)) {
      current = { name: 'dark', rows: [] };
      palettes.push(current);
      continue;
    }
    if (/^\*\*Light:?\*\*/.test(line)) {
      current = { name: 'light', rows: [] };
      palettes.push(current);
      continue;
    }
    if (current === null) continue;
    const row = ROW.exec(line);
    if (row === null) continue;

    const measured = (row[4] as string).trim();
    const claims: { ratio: number; against: string }[] = [];
    CLAIM.lastIndex = 0;
    for (;;) {
      const claim = CLAIM.exec(measured);
      if (claim === null) break;
      claims.push({ ratio: Number(claim[1]), against: claim[2] as string });
    }
    const lightness = /L\\?\*\s*(\d+\.\d+)/.exec(measured);
    current.rows.push({
      token: row[1] as string,
      hex: row[2] as string,
      use: (row[3] as string).trim(),
      claims,
      lightness: lightness === null ? null : Number(lightness[1]),
    });
  }
  return palettes;
}

/** `--text` → `#F4ECE1`, for one palette. */
export function tokenMap(palette: Palette): ReadonlyMap<string, string> {
  return new Map(palette.rows.map((row) => [row.token, row.hex]));
}

export interface TypeRow {
  /** `--text-xl`, as §10 names it — which is also the Tailwind utility, minus the dash. */
  readonly token: string;
  readonly px: number;
  readonly lineHeight: number;
  readonly weight: number;
}

const TYPE_ROW =
  /^\|\s*`(--text-(?:xl|lg|base|sm))`\s*\|\s*\*\*(\d+) px\*\*\s*\/\s*([\d.]+)\s*\/\s*(\d+)/;

/**
 * §10's type scale, read from the same document as the palette and for the same reason.
 *
 * The sizes matter to more than the stylesheet: `scan.ts` grades a `text-*` utility
 * against them, and after M4 step 2 they are **not** Tailwind's defaults — `text-base` is
 * 17 px, not 16. A checker holding its own copy of the old numbers would go on reporting
 * a size the app has not rendered since the tokens landed.
 */
export async function readTypeScale(): Promise<readonly TypeRow[]> {
  const markdown = await readFile(designSystemPath, 'utf8');
  const rows: TypeRow[] = [];
  for (const line of markdown.split('\n')) {
    const found = TYPE_ROW.exec(line);
    if (found === null) continue;
    rows.push({
      token: found[1] as string,
      px: Number(found[2]),
      lineHeight: Number(found[3]),
      weight: Number(found[4]),
    });
  }
  return rows;
}
