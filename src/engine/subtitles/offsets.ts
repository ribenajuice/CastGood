import path from 'node:path';
import type { Cue } from './cues.js';
import type { SubtitleSource } from './sources.js';

/**
 * **What a remembered timing correction is remembered against** — criterion 20f.
 *
 * *"It is remembered against the **subtitle source**, never against the film, the device or
 * the session."* Everything in this file is the arithmetic of that sentence, and it is pure:
 * strings in, strings out, no store, no clock, no filesystem. The store keeps what these
 * functions produce and nothing else decides what a key means.
 *
 * The reasoning the PRD gives is why the key has this shape: an offset *"is a fact about the
 * file, not a preference"* — `Cars.en.srt` is 0.6 s out today because it was cut for a
 * different release, and it will still be 0.6 s out next week. So the identity of the thing
 * corrected is the identity of the **words**, not of the evening they were watched in.
 */

/**
 * A path as a key: separators normalised, and case folded **only for Windows paths**.
 *
 * Windows filesystems are case-insensitive, so `D:\Films\Cars.en.srt` and
 * `d:\films\cars.EN.srt` are one file and must be one key — a founder who reaches the same
 * file by a differently-cased route has not chosen a different subtitle. POSIX paths are
 * case-*sensitive* and folding them would merge two genuinely different files.
 *
 * The test is the **path**, not `process.platform`, so the answer is the same in WSL as it
 * is on Windows and this stays provable headlessly. A drive letter is what says "this is a
 * Windows path"; a UNC path (`\\nas\films\…`) says it with its separators.
 */
export function normalisePathKey(filePath: string): string {
  const slashed = filePath.replace(/\\/g, '/');
  // Asked of the path as written, before anything tidies it: `path.posix.normalize`
  // collapses a leading `//`, and a UNC share would stop looking like one halfway through.
  const windows = /^[a-z]:\//i.test(slashed) || slashed.startsWith('//');
  // **`path.posix`, deliberately, on every platform.** `path.normalize` behaves differently
  // in WSL and on Windows, and a key that depended on which one asked would be a correction
  // that came back in the tests and not on the founder's PC.
  const normalised = path.posix.normalize(slashed);
  return windows ? normalised.toLowerCase() : normalised;
}

/**
 * The key one subtitle source is remembered under.
 *
 * Three shapes, and the difference between them is exactly the difference 20f draws:
 *
 *  - **A sidecar or a picked file** is keyed by its own path and nothing else. The same file
 *    chosen for a different film — a founder who keeps one `.srt` and two rips of the same
 *    film — is the same correction, because it is the same words.
 *  - **A track inside a film** has no path of its own, so it is keyed by the film that
 *    carries it *and* the stream it is. That is not "keyed against the film": choosing a
 *    different track of the same film gets a different key, and the film's own timing
 *    correction is a thing that does not exist.
 *
 * A key is never shown to the founder and never travels over IPC — it is a line in our own
 * settings file — but it does contain a path, which is why nothing renders it.
 */
export function subtitleOffsetKey(input: {
  readonly filmPath: string;
  readonly source: SubtitleSource;
}): string {
  const { origin } = input.source;
  if (origin.kind === 'embedded') {
    return `embedded:${normalisePathKey(input.filmPath)}#${String(origin.streamIndex)}`;
  }
  return `file:${normalisePathKey(origin.filePath)}`;
}

/**
 * **Are these the same words we were corrected for?** — a cheap guard on a real hazard.
 *
 * The store keys on a path, and a path is a place rather than a file: the founder can
 * replace `Cars.en.srt` with a copy cut for the release they actually own, which is the
 * *most likely reason they ever go looking for another subtitle file at all*. Applying last
 * week's +0.6 s to those new words would be the app confidently making a correct file wrong.
 *
 * So the record carries a fingerprint of the cue list it was set against, and a correction
 * whose fingerprint no longer matches is dropped rather than applied. It costs **nothing** —
 * the cues have just been parsed for this very choice, so there is no second read of
 * anything — and the loss when it fires is the loss 20f already accepts in as many words:
 * *"losing the memory costs a 30-second re-nudge, never correctness."*
 *
 * Deliberately **not** a hash of the file's bytes. The same words re-saved by a different
 * editor, re-encoded from Latin-1 to UTF-8, or converted from ASS are the same subtitle and
 * the correction still holds; what this asks is whether the *timing* is the timing we fixed.
 */
export function subtitleFingerprint(cues: readonly Cue[]): string {
  const first = cues[0];
  const last = cues[cues.length - 1];
  return [
    cues.length,
    first === undefined ? 0 : first.startMs,
    last === undefined ? 0 : last.endMs,
  ].join(':');
}
