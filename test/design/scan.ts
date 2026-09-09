import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { contrastRatio, readTypeScale, rendererRoot, repoRoot } from './design-system.js';

/**
 * **The static half of M4's checkers.**
 *
 * Six of M4's seven checks are answerable by reading the source: colour literals (21b),
 * the type floor (22a), opacity-as-disabled (§10 and 21d), motion (21i), modality (21i)
 * and the engine diff (21j). The seventh — overflow at 880 × 720 (22b) — is a question
 * about *layout*, and this repo has no layout engine: `vitest.config.ts` runs
 * `environment: 'node'` and there is no jsdom, no testing-library and no browser. It is
 * **not** faked here; see the ADR of 2026-09-02 and `overflow.test.ts`.
 *
 * Every scanner returns violations rather than asserting, so the same function can be
 * pointed at a planted fault in `checkers-can-fail.test.ts`. A checker that has never
 * been seen red is not evidence of anything — that is 10j's pattern, and it is the
 * reason M4's step 1 exists at all.
 */

export interface Violation {
  /** Repo-relative, so the baseline is stable across machines. */
  readonly file: string;
  readonly line: number;
  readonly rule: string;
  readonly detail: string;
}

/** Tailwind's built-in palette. Any of these is a colour chosen outside the token set. */
const TAILWIND_PALETTE =
  'slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|' +
  'sky|blue|indigo|violet|purple|fuchsia|pink|rose';

/** The utilities that can carry a colour. */
const COLOUR_PROPERTY = 'text|bg|border|outline|ring|fill|stroke|decoration|divide|accent|caret';

const COLOUR_RULES: readonly { readonly rule: string; readonly pattern: RegExp }[] = [
  {
    rule: '21b/hex-literal',
    pattern: /#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})\b/g,
  },
  { rule: '21b/rgb-or-hsl', pattern: /\b(?:rgba?|hsla?|oklch|color-mix)\s*\(/g },
  {
    rule: '21b/tailwind-palette',
    pattern: new RegExp(`\\b(?:${COLOUR_PROPERTY})-(?:${TAILWIND_PALETTE})-\\d{2,3}\\b`, 'g'),
  },
  {
    rule: '21b/named-colour',
    pattern: new RegExp(`\\b(?:${COLOUR_PROPERTY})-(?:white|black|transparent|current)\\b`, 'g'),
  },
];

/**
 * Tailwind's **default** type scale, in px — the sizes a `text-*` utility renders at
 * before the token layer redefines any of them.
 *
 * These are Tailwind's own values, not a design decision. They are here so the checker can
 * say *"`text-xs` is 12 px and the floor is 16"* rather than *"`text-xs` is not a token"*,
 * which is a much more useful thing to read in a failure.
 */
const TAILWIND_TYPE_PX: Readonly<Record<string, number>> = {
  'text-xs': 12,
  'text-sm': 14,
  'text-base': 16,
  'text-lg': 18,
  'text-xl': 20,
  'text-2xl': 24,
  'text-3xl': 30,
  'text-4xl': 36,
};

/**
 * The scale as it actually renders: Tailwind's defaults, with §10's four sizes over the
 * top of the four names the design system redefines.
 *
 * **This is why the checker reads the document instead of holding numbers.** M4 step 2
 * moved `text-base` from 16 px to 17 and `text-sm` from 14 to 15; a checker still quoting
 * Tailwind's table would be reporting sizes the app has not rendered since. Which names
 * fall below the floor happens to be unchanged by that move — `text-xs` and `text-sm`,
 * before and after — so the recorded baseline is unchanged too, and the difference is
 * confined to what a failure *says*.
 */
export async function typeScalePx(): Promise<Readonly<Record<string, number>>> {
  const resolved: Record<string, number> = { ...TAILWIND_TYPE_PX };
  for (const row of await readTypeScale()) resolved[row.token.slice(2)] = row.px;
  return resolved;
}

/** 22a, and the "Numbers M4 adds for testability only" table. */
export const TYPE_FLOOR_PX = {
  anything: 13,
  body: 16,
  statusHeadline: 28,
  positionReadout: 20,
} as const;

async function collect(dir: string, extensions: readonly string[]): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collect(full, extensions);
      return extensions.some((ext) => entry.name.endsWith(ext)) ? [full] : [];
    }),
  );
  return files.flat();
}

/** Everything M4 is allowed to restyle: the renderer's components and its stylesheet. */
export async function rendererFiles(): Promise<readonly string[]> {
  const files = await collect(rendererRoot, ['.tsx', '.ts', '.css']);
  return files.filter((file) => !file.endsWith('.d.ts')).sort();
}

/** Repo-relative and POSIX-separated, so a baseline is identical on every machine. */
export function relativeToRepo(file: string): string {
  return path.relative(repoRoot, file).split(path.sep).join('/');
}

const relative = relativeToRepo;

/** Re-exported so the checkers' own test can anchor the formula to WCAG's worked examples. */
export const contrastOfPair = contrastRatio;

/**
 * **A checker grades the code, not the prose about the code.**
 *
 * Comment bodies are replaced with spaces — same length, same line count, so every
 * reported line and column still points where it did. Found the day the restyle landed:
 * `PreparationPanel` gained the comment *"its width transition is 180 ms linear, §10's one
 * permitted transition"* and the motion rule reported two violations, on a sentence
 * describing the fix. A checker that can be failed by explaining yourself teaches people
 * to stop explaining themselves, which is a worse outcome than the rule was worth.
 *
 * It cuts the other way too, and that is the more valuable half: a hex sitting in a
 * comment is not a colour anything renders, and recording it as a violation would mean the
 * baseline could never empty without deleting documentation.
 *
 * `//` is only treated as a comment when it does not follow a `:`, so a `https://` inside
 * a string survives. There are none in the renderer today; the guard is for the day there
 * is one.
 */
function blankComments(source: string): string {
  let out = '';
  let state: 'code' | 'line' | 'block' | 'single' | 'double' | 'template' = 'code';
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i] as string;
    const next = source[i + 1];
    const keep = (): void => {
      out += c;
    };
    if (state === 'code') {
      if (c === '/' && next === '*') {
        state = 'block';
        out += '  ';
        i += 1;
        continue;
      }
      if (c === '/' && next === '/' && source[i - 1] !== ':') {
        state = 'line';
        out += '  ';
        i += 1;
        continue;
      }
      if (c === "'") state = 'single';
      else if (c === '"') state = 'double';
      else if (c === '`') state = 'template';
      keep();
      continue;
    }
    if (state === 'line') {
      if (c === '\n') {
        state = 'code';
        keep();
      } else out += ' ';
      continue;
    }
    if (state === 'block') {
      if (c === '*' && next === '/') {
        state = 'code';
        out += '  ';
        i += 1;
        continue;
      }
      out += c === '\n' ? c : ' ';
      continue;
    }
    // Inside a string: the only thing that matters is finding its end.
    if (c === '\\') {
      out += c + (next ?? '');
      i += 1;
      continue;
    }
    if (
      (state === 'single' && c === "'") ||
      (state === 'double' && c === '"') ||
      (state === 'template' && c === '`')
    ) {
      state = 'code';
    }
    keep();
  }
  return out;
}

async function scan(
  files: readonly string[],
  rules: readonly { readonly rule: string; readonly pattern: RegExp }[],
  skip?: (file: string) => boolean,
): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of files) {
    if (skip?.(file) === true) continue;
    const lines = blankComments(await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      for (const { rule, pattern } of rules) {
        pattern.lastIndex = 0;
        for (;;) {
          const found = pattern.exec(text);
          if (found === null) break;
          violations.push({
            file: relative(file),
            line: index + 1,
            rule,
            detail: found[0],
          });
          if (pattern.lastIndex === found.index) pattern.lastIndex += 1;
        }
      }
    });
  }
  return violations;
}

/**
 * **The one file that may write a value down, because it is where values are written.**
 *
 * M4 step 2 built it: `src/renderer/tokens.css` carries §10's palette and type scale, and
 * nothing else in the renderer names a colour or a size. Both scanners below skip it, for
 * the same reason and with the same limit — **a definition is not a use.** A token file
 * that had to obey the rules it defines could not state a colour at all, and `--text-sm:
 * 15px` would read as a 15 px body line rather than as the declaration that makes one
 * possible.
 *
 * The exemption is deliberately **one path, not a directory**, so a second stylesheet
 * cannot quietly inherit permission to invent a colour. What keeps it honest is
 * `tokens.test.ts`, which holds every value in that file against §10 in both directions:
 * the file is unpoliced by these scanners and fully policed by that one.
 */
const TOKEN_FILE = 'src/renderer/tokens.css';

/** **21b** — every colour comes from the token set. */
export async function colourLiterals(
  files: readonly string[],
  tokenFile = TOKEN_FILE,
): Promise<Violation[]> {
  return scan(files, COLOUR_RULES, (file) => relative(file) === tokenFile);
}

/** **22a** — nothing renders below the floor, and sizes come from the token set. */
export async function typeSizes(
  files: readonly string[],
  tokenFile = TOKEN_FILE,
): Promise<Violation[]> {
  const scale = await typeScalePx();
  const rules = [
    {
      rule: '22a/below-floor',
      pattern: new RegExp(
        `\\b(${Object.entries(scale)
          .filter(([, px]) => px < TYPE_FLOOR_PX.body)
          .map(([name]) => name)
          .join('|')})\\b`,
        'g',
      ),
    },
    { rule: '22a/arbitrary-size', pattern: /\btext-\[[^\]]+\]/g },
  ];
  return scan(files, rules, (file) => relative(file) === tokenFile);
}

/** The two animations §10 permits, by name. Used by both the motion and opacity rules. */
const ALLOWED_ANIMATIONS = ['pulse-dot', 'hairline-slide'] as const;

/**
 * **§10 and 21d** — *"disabled means a different colour token, never a lower opacity"*.
 *
 * An `opacity` on a dark surface destroys measured contrast and cannot be stated in a
 * table, which is exactly why 21d refuses WCAG's own disabled-text exemption.
 *
 * **The two places §10 does state an opacity, and the only two exempt here**: inside the
 * `pulse-dot` and `hairline-slide` keyframes — *"opacity 0.5 → 1.0 → 0.5 over 1.1 s"* is
 * how that dot is specified — and inside a `prefers-reduced-motion` block, where the same
 * section gives the resting values the animation is replaced by.
 *
 * This was flagged as owed when the tokens landed (ADR of 2026-09-04) rather than
 * discovered here, and it is deliberately a **rule, not a file exemption**: the carve-out
 * follows the two constructs wherever they appear, so `motion.css` gets no blanket pass
 * and a disabled control faded inside it would still be caught. The proof that the
 * narrowing did not blunt the checker is a planted fault in `checkers-can-fail.test.ts`,
 * including one *inside* an unlisted keyframes block.
 */
const OPACITY_ALLOWED_IN = [...ALLOWED_ANIMATIONS, 'prefers-reduced-motion'] as const;

/**
 * The line ranges of every block §10 permits an opacity inside, by brace depth.
 *
 * Depth rather than a regex over the whole file, because both constructs nest: a
 * `@media (prefers-reduced-motion)` holds rule bodies, and `@keyframes` holds percentage
 * bodies. The block ends where the brace it opened is closed, and not at the first `}`.
 */
function opacityExemptLines(source: string): ReadonlySet<number> {
  const exempt = new Set<number>();
  const lines = source.split('\n');
  let depth: number | null = null;
  let running = 0;
  lines.forEach((text, index) => {
    if (depth === null && OPACITY_ALLOWED_IN.some((name) => text.includes(name))) {
      // The block starts on the line that names it, even before its brace opens.
      depth = running;
    }
    if (depth !== null) exempt.add(index + 1);
    for (const character of text) {
      if (character === '{') running += 1;
      if (character === '}') running -= 1;
    }
    if (depth !== null && running <= depth) depth = null;
  });
  return exempt;
}

export async function opacityAsState(files: readonly string[]): Promise<Violation[]> {
  const found = await scan(files, [
    { rule: '21d/opacity-utility', pattern: /\bopacity-\d{1,3}\b/g },
    { rule: '21d/opacity-property', pattern: /\bopacity\s*:\s*0?\.\d+/g },
  ]);
  const exemptByFile = new Map<string, ReadonlySet<number>>();
  for (const file of files) {
    exemptByFile.set(relative(file), opacityExemptLines(await readFile(file, 'utf8')));
  }
  return found.filter(
    (violation) => exemptByFile.get(violation.file)?.has(violation.line) !== true,
  );
}

/**
 * **21i** — no new motion beyond §8's pulsing dot and sliding hairline.
 *
 * Both allowed animations are named, so a third `@keyframes` is a violation by name
 * rather than by count, and renaming one to sneak it past is itself the violation.
 */

/**
 * The one transition §10 allows, quoted exactly: *"no easing on the progress bar beyond
 * the 0.18 s linear width it already has (which is smoothing a sampled number, not
 * decoration)"*. So a `width` transition is permitted, at **180 ms**, linear — and any
 * other duration is the parameter being ignored rather than the exception being taken.
 */
const ALLOWED_TRANSITION_MS = 180;

export async function motion(files: readonly string[]): Promise<Violation[]> {
  const violations: Violation[] = [];
  for (const file of files) {
    const lines = blankComments(await readFile(file, 'utf8')).split('\n');
    lines.forEach((text, index) => {
      const at = (rule: string, detail: string): void => {
        violations.push({ file: relative(file), line: index + 1, rule, detail });
      };

      const keyframes = /@keyframes\s+([A-Za-z0-9_-]+)/g;
      for (;;) {
        const found = keyframes.exec(text);
        if (found === null) break;
        const name = found[1] as string;
        if ((ALLOWED_ANIMATIONS as readonly string[]).includes(name)) continue;
        at('21i/unlisted-keyframes', `@keyframes ${name}`);
      }

      const transitions = /\btransition(?:-\[([a-z-]+)\]|-([a-z]+))?/g;
      for (;;) {
        const found = transitions.exec(text);
        if (found === null) break;
        const property = found[1] ?? found[2] ?? 'all';
        if (property === 'none') continue;
        if (property !== 'width') {
          at('21i/transition', found[0]);
          continue;
        }
        // The allowed one. Its parameters are still parameters.
        const duration = /\bduration-(\d+)\b/.exec(text);
        const ms = duration === null ? null : Number(duration[1]);
        if (ms !== ALLOWED_TRANSITION_MS) {
          at(
            '21i/transition-duration',
            `width transition at ${ms === null ? 'an unstated duration' : `${String(ms)} ms`}, §10 says ${String(ALLOWED_TRANSITION_MS)} ms`,
          );
        }
        if (!/\bease-linear\b/.test(text)) {
          at('21i/transition-easing', `width transition is not ease-linear: ${found[0]}`);
        }
      }
    });
  }
  return violations;
}

/**
 * **21i** — nothing modal, and nothing that carries information over the content.
 *
 * PR #35 removed the product's last modal on purpose. This is what stops one arriving back
 * as a *"temporary"* overlay for a hard-to-reach state, which the PRD names as the likely
 * way it would happen.
 */
export async function modality(files: readonly string[]): Promise<Violation[]> {
  return scan(files, [
    { rule: '21i/dialog', pattern: /<dialog\b|showModal\s*\(|HTMLDialogElement/g },
    { rule: '21i/portal', pattern: /createPortal\s*\(/g },
    { rule: '21i/overlay', pattern: /\b(?:fixed|absolute)\s+inset-0\b/g },
    { rule: '21i/title-attribute', pattern: /\btitle=["'{]/g },
  ]);
}

/** Sorted so a baseline comparison is order-independent. */
export function sortViolations(violations: readonly Violation[]): Violation[] {
  return [...violations].sort(
    (a, b) =>
      a.file.localeCompare(b.file) ||
      a.line - b.line ||
      a.rule.localeCompare(b.rule) ||
      a.detail.localeCompare(b.detail),
  );
}
