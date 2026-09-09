/**
 * Natural, numeric-aware ordering for files added together — M5b, criterion 24z.
 *
 * ⚠️ **Plain filename order puts episode 10 in front of episode 9**, and a queue is the
 * first feature where that is visible. Films never exposed it because they were chosen one
 * at a time; a season is chosen all at once, and the wrong order is not a cosmetic
 * complaint — it is the evening playing in the wrong sequence while somebody watches.
 *
 * The criterion names three shapes and they are the test cases:
 *
 *   `S01E09` before `S01E10`      — a number glued to letters
 *   `Episode 9` before `Episode 10` — a number after a word
 *   `2 - Pilot` before `10 - Finale` — a number at the start
 *
 * ## Why not `localeCompare(…, { numeric: true })`
 *
 * It very nearly works, and "very nearly" is the problem. Its numeric handling is
 * locale-dependent, it treats runs of digits differently across engines, and its behaviour
 * on `S01E09` versus `S1E9` is not something this project can pin down with a test it
 * controls. **This comparison is small enough to own**, and owning it means the failure
 * modes are in this file rather than in a browser's collation table.
 */

/**
 * The name without its extension.
 *
 * ⚠️ **Extensions must not drive the order, and they did.** `Episode 9.mkv` sorted AFTER
 * `Episode 9 - Extended.mkv`, because once both had matched `Episode ` and `9` the
 * comparison fell to `.mkv` against ` - Extended.mkv` — and a space sorts before a full
 * stop. The extension is a fact about the container, never about where a film belongs in a
 * season, and a folder holding both `.mkv` and `.mp4` would otherwise interleave by
 * container rather than by episode.
 */
function withoutExtension(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot > 0 ? value.slice(0, dot) : value;
}

/** A file name split into runs of digits and runs of everything else. */
function chunk(value: string): (string | number)[] {
  const parts: (string | number)[] = [];
  const pattern = /(\d+)|(\D+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value)) !== null) {
    const digits = match[1];
    // ⚠️ Number, not parseInt on the whole run: `0009` and `9` must compare equal so that
    // `S01E09` and `S1E9` interleave correctly rather than sorting by how many zeros
    // somebody's ripper happened to write.
    parts.push(digits === undefined ? (match[2] ?? '').toLowerCase() : Number(digits));
  }
  return parts;
}

/**
 * Compare two names the way a person reading a season folder would.
 *
 * Numbers compare as numbers, text compares case-insensitively, and a shorter name that is
 * a prefix of a longer one sorts first — `Episode 9` before `Episode 9 - Extended`.
 */
export function compareNatural(a: string, b: string): number {
  const left = chunk(withoutExtension(a));
  const right = chunk(withoutExtension(b));

  for (let i = 0; i < Math.min(left.length, right.length); i += 1) {
    const x = left[i];
    const y = right[i];
    if (x === undefined || y === undefined) break;

    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
      continue;
    }
    // A number sorts before text at the same position, so `2 - Pilot` leads `Extras`.
    if (typeof x === 'number') return -1;
    if (typeof y === 'number') return 1;
    if (x !== y) return x < y ? -1 : 1;
  }

  if (left.length !== right.length) return left.length - right.length;
  // Identical once folded: fall back to the raw strings so the order is at least stable
  // and does not depend on which file the OS happened to list first.
  return a === b ? 0 : a < b ? -1 : 1;
}

/**
 * Files as they should arrive in the queue when added together.
 *
 * ⚠️ **Never the order the picker handed them over in.** A file dialog returns whatever the
 * OS gave it, which on Windows is close to alphabetical and therefore wrong for exactly the
 * case this exists for.
 */
export function inNaturalOrder<T>(items: readonly T[], nameOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => compareNatural(nameOf(a), nameOf(b)));
}
