import path from 'node:path';

/**
 * What a prepared file is called, and how we recognise one we made.
 *
 * The founder's ruling of 2026-08-19: *"place a copy of it in the same directory, but with
 * a filename change that implies it's been converted."* So `Cars.mkv` prepares to
 * `Cars (CastGood).mp4`, sitting beside the original, recognisable at a glance in Explorer,
 * and there for as long as the founder leaves it there — there is no cleanup policy.
 *
 * Three rules, and each of them is a defect that would otherwise be found on hardware:
 *
 *  - **Only our own convention counts as ours** (same ruling). An unrelated `Cars.mp4`
 *    beside `Cars.mkv` may be a trailer, a different cut or another language. `isOurName`
 *    is also what makes 9e's *"nothing in that folder is ever moved, renamed or deleted by
 *    CastGood unless CastGood itself named it"* checkable rather than aspirational: every
 *    delete in the pipeline goes through it.
 *  - **The suffix never stacks.** The founder can pick `Cars (CastGood).mp4` out of the
 *    picker — it is a video file in their films folder — and preparing that must not
 *    produce `Cars (CastGood) (CastGood).mp4`. Preparing a prepared file overwrites it,
 *    which is exactly what the 2026-08-19 ADR's "preparation only ever narrows" wants.
 *  - **The staging file is the target plus one extension**, so the finishing move is a
 *    rename **within the same directory and therefore the same volume** — atomic, and
 *    never a copy of four gigabytes. `8d` and `P2` both depend on there being exactly one
 *    predictable name to remove.
 */

/** The visible part of the name. Spelled once. */
export const PREPARED_MARK = '(CastGood)';

/** The container M3a produces, and the only one. HLS is M3b and never lands beside a source. */
export const PREPARED_EXTENSION = '.mp4';

/**
 * The staging extension. **Not** `.mp4`, deliberately: a half-written file that Windows
 * shows with a video icon is one the founder can double-click into a broken player, and
 * one a future directory scan could mistake for an artifact.
 */
export const PARTIAL_EXTENSION = '.partial';

/** `Cars.mkv` → `Cars`. `Cars (CastGood).mp4` → `Cars`, so the suffix cannot stack. */
export function sourceStem(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  const marked = base.trimEnd();
  if (!marked.endsWith(PREPARED_MARK)) return base;
  return marked.slice(0, marked.length - PREPARED_MARK.length).trimEnd();
}

/** `Cars.mkv` → `Cars (CastGood).mp4`. The name only; no directory. */
export function preparedNameFor(filePath: string): string {
  return `${sourceStem(filePath)} ${PREPARED_MARK}${PREPARED_EXTENSION}`;
}

/**
 * Where the prepared sibling goes: beside the source.
 *
 * `directory` overrides that, and is how 9e's fallback is expressed — when the source's own
 * folder cannot be written to, the same name is used in CastGood's working folder and the
 * founder is told where it went. The *name* never changes with the location, so a file that
 * later gets copied back beside its source is still recognisably the prepared copy.
 */
export function preparedPathFor(filePath: string, directory?: string): string {
  return path.join(directory ?? path.dirname(filePath), preparedNameFor(filePath));
}

/** `…/Cars (CastGood).mp4` → `…/Cars (CastGood).mp4.partial`. Same directory, same volume. */
export function partialPathFor(preparedPath: string): string {
  return `${preparedPath}${PARTIAL_EXTENSION}`;
}

/** The one form a subtitle can reach a Chromecast in. See `SubtitleTrack`. */
export const SUBTITLE_EXTENSION = '.vtt';

/**
 * `…/Cars (CastGood).mp4` + `eng` → `…/Cars (CastGood).eng.vtt`.
 *
 * `docs/ARCHITECTURE.md` §4's name, and the language is in it because a film with an English
 * and a Spanish track needs two files the founder can tell apart on sight. A track whose
 * container does not name a language falls back to its ordinal — `track2` — rather than to
 * an index, which would be a stream number leaking into somebody's films folder.
 *
 * `ordinal` is the track's position among the ones being extracted, counted from 1. It is
 * used for the fallback name and to keep two unnamed tracks from colliding.
 */
export function subtitlePathFor(
  preparedPath: string,
  language: string | null,
  ordinal: number,
  occurrence = 1,
): string {
  const stem = preparedPath.slice(0, preparedPath.length - path.extname(preparedPath).length);
  // ffprobe reports `und` for "undetermined", which is a code and not a language. Treated
  // as absent, because `Cars (CastGood).und.vtt` tells the founder nothing.
  const code =
    language === null || language.toLowerCase() === 'und' ? null : language.toLowerCase();
  const label = code === null ? `track${String(ordinal)}` : sanitiseLanguage(code);
  // **The second English track is not the first one.** A film with "English" and "English
  // SDH" — or English plus a forced-subtitle track — is entirely ordinary, and both report
  // `eng`. Before this, both were handed the same filename: ffmpeg was told to write two
  // outputs to one path, only one file appeared, and the second rename failed with `ENOENT`
  // **after an eighteen-minute conversion had already succeeded** (found on the founder's
  // own film, 2026-08-20). The first of a language keeps the clean name; the rest are
  // numbered.
  const suffix = occurrence > 1 ? String(occurrence) : '';
  return `${stem}.${label}${suffix}${SUBTITLE_EXTENSION}`;
}

/**
 * A language code from a container is untrusted input, and it is about to become a filename.
 *
 * ffprobe hands back whatever the file said, which on a downloaded remux can be anything at
 * all. Anything outside `a–z0–9` is dropped, so a tag containing a path separator cannot
 * write outside the folder we chose.
 */
function sanitiseLanguage(code: string): string {
  const cleaned = code.replace(/[^a-z0-9]/g, '').slice(0, 12);
  return cleaned === '' ? 'sub' : cleaned;
}

/**
 * Did CastGood name this file?
 *
 * The gate on every delete the pipeline performs. A file the founder put in their own
 * films folder is never ours to remove, however much it looks like something we would
 * have written (9e).
 */
export function isOurName(fileName: string): boolean {
  const withoutPartial = fileName.endsWith(PARTIAL_EXTENSION)
    ? fileName.slice(0, fileName.length - PARTIAL_EXTENSION.length)
    : fileName;
  const extension = path.extname(withoutPartial).toLowerCase();
  if (extension === PREPARED_EXTENSION) {
    return path.basename(withoutPartial, extension).trimEnd().endsWith(PREPARED_MARK);
  }
  if (extension === SUBTITLE_EXTENSION) {
    // `Cars (CastGood).eng.vtt` — the mark sits before the language, so the language is
    // stripped before the mark is looked for. A `.vtt` the founder put there themselves has
    // no mark anywhere in it and is not ours to remove.
    const withoutLanguage = withoutPartial.slice(0, withoutPartial.length - extension.length);
    const stem = withoutLanguage.slice(0, withoutLanguage.lastIndexOf('.'));
    return stem.trimEnd().endsWith(PREPARED_MARK);
  }
  return false;
}
