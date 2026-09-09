import { SUBTITLES } from '../config.js';

/**
 * Subtitle cues, and the one operation story 20 is built on — **shifting them in time**.
 *
 * Everything in this file is a **pure function over cue lists**. No ffmpeg, no filesystem,
 * no device, no clock. That is deliberate and it is what M3c's build order asks for: the
 * PRD calls 20d *"the cheapest criterion in the milestone"* because a shift is verifiable
 * to the millisecond with nothing plugged in. Extraction from a container is ffmpeg's job
 * and lives elsewhere; by the time cues reach here they are already a list.
 *
 * **The founder's own file is never touched** (20g). Nothing in this file writes anything —
 * a shift produces a new list, and the caller serves it from CastGood's working directory.
 */

/**
 * One cue: when it starts, when it ends, and the words.
 *
 * Times are **integer milliseconds**, not seconds. 20d asks for a shift that is exact "to
 * the millisecond", and floating-point seconds cannot promise that — `0.1 + 0.2` is the
 * standard counter-example and a 2-hour film has thousands of chances to hit it.
 */
export interface Cue {
  readonly startMs: number;
  readonly endMs: number;
  /** The words, exactly as written. 20d: cue text unchanged. */
  readonly text: string;
  /** A cue identifier, when the source had one. WebVTT allows it; SRT's number is not one. */
  readonly id: string | null;
  /** WebVTT positioning settings from the timing line, carried through untouched. */
  readonly settings: string | null;
}

// --- Reading -----------------------------------------------------------------

/** `HH:MM:SS.mmm`, `MM:SS.mmm`, and SRT's comma form. Returns null when it is not a time. */
export function parseTimestamp(raw: string): number | null {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})$/.exec(raw.trim());
  if (match === null) return null;
  const [, hours, minutes, seconds, fraction] = match;
  // `.5` means 500 ms, not 5. Pad rather than parse, so `.5`, `.50` and `.500` agree.
  const ms = Number(fraction?.padEnd(3, '0') ?? '0');
  return Number(hours ?? '0') * 3_600_000 + Number(minutes) * 60_000 + Number(seconds) * 1_000 + ms;
}

const ARROW = /-->/;

/**
 * Parse WebVTT or SubRip. **One reader for both**, because they differ in three details and
 * a second parser would be a second place for a cue to go missing.
 *
 * What differs: SRT numbers its cues (a number that is not an identifier — it is an index,
 * and WebVTT has no use for it), SRT writes milliseconds after a comma, and WebVTT may
 * carry positioning settings after the end time. What is identical is the part that
 * matters: a timing line with `-->`, and the lines under it are the words.
 *
 * Anything that is not a cue — `WEBVTT`, `NOTE`, `STYLE`, blank lines, byte-order marks — is
 * skipped rather than refused. A file this cannot read at all yields an empty list, and
 * 18j's *"this subtitle file can't be read"* is the caller's sentence to say.
 */
export function parseCues(source: string): Cue[] {
  // `\uFEFF` as an escape, not as a literal byte-order mark: a real BOM in source is
  // invisible in every editor and `no-irregular-whitespace` is right to refuse it.
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  const cues: Cue[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (!ARROW.test(line)) continue;

    const [rawStart, rest] = line.split(ARROW, 2) as [string, string | undefined];
    if (rest === undefined) continue;
    // The end time is the first token after the arrow; anything after it is WebVTT settings.
    const restTrimmed = rest.trim();
    const spaceAt = restTrimmed.search(/\s/);
    const rawEnd = spaceAt === -1 ? restTrimmed : restTrimmed.slice(0, spaceAt);
    const settings = spaceAt === -1 ? null : restTrimmed.slice(spaceAt).trim() || null;

    const startMs = parseTimestamp(rawStart);
    const endMs = parseTimestamp(rawEnd);
    if (startMs === null || endMs === null) continue;

    // The line above a timing line is an identifier — unless it is SRT's index number, which
    // is an ordinal and carries nothing. Dropping it keeps `Cue.id` meaning what it says.
    const above = (lines[index - 1] ?? '').trim();
    const id = above === '' || /^\d+$/.test(above) ? null : above;

    const body: string[] = [];
    for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
      const next = lines[cursor] ?? '';
      if (next.trim() === '') break;
      if (ARROW.test(next)) break;
      body.push(next);
    }
    cues.push({ startMs, endMs, text: body.join('\n'), id, settings });
  }
  return cues;
}

// --- Writing -----------------------------------------------------------------

export function formatTimestamp(totalMs: number): string {
  const ms = Math.max(0, Math.round(totalMs));
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = Math.floor((ms % 60_000) / 1_000);
  const millis = ms % 1_000;
  return (
    `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:` +
    `${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}`
  );
}

/**
 * Write a WebVTT file.
 *
 * **WebVTT and nothing else**, because it is the only form a Chromecast renders — measured
 * on all three televisions by SPIKE-3 on 2026-08-26, not assumed. `mov_text` and ASS reach
 * here already converted.
 */
export function toWebVtt(cues: readonly Cue[]): string {
  const parts = ['WEBVTT', ''];
  for (const cue of cues) {
    if (cue.id !== null) parts.push(cue.id);
    parts.push(
      `${formatTimestamp(cue.startMs)} --> ${formatTimestamp(cue.endMs)}` +
        (cue.settings === null ? '' : ` ${cue.settings}`),
    );
    parts.push(cue.text, '');
  }
  return parts.join('\n');
}

// --- The offset (20d, 20e) ---------------------------------------------------

/**
 * Hold an offset inside the range story 20e promises, in whole nudge steps.
 *
 * 20e: *"the offset clamps at ±30 s and states the real distance moved rather than reading
 * as a dead button"*. The clamp is here so the number on screen and the number applied to
 * the cues can never disagree — one function, called by both.
 */
export function clampOffsetMs(offsetMs: number): number {
  if (!Number.isFinite(offsetMs)) return 0;
  const limit = SUBTITLES.maxOffsetSeconds * 1_000;
  return Math.max(-limit, Math.min(limit, Math.round(offsetMs)));
}

/**
 * Shift every cue by exactly `offsetMs` — **20d, to the millisecond**.
 *
 * The rules, and each is a sentence of the criterion rather than a taste:
 *
 * - **Every cue moves by exactly the offset.** Integer milliseconds in, integer out, so a
 *   two-hour film's last cue is as exact as its first.
 * - **Cue text is unchanged and cue order is unchanged.** This returns a new list; it never
 *   edits, reorders, merges or re-numbers.
 * - **A cue shifted before 0:00 starts at 0:00.** It is still on screen, just clipped at the
 *   front — dropping it would lose words the founder can see are missing.
 * - **A cue that would END before 0:00 is dropped**, because a subtitle cannot play before
 *   the film starts. This is the only case where a cue is lost, and it is lost on purpose.
 *
 * `Reset` is this function with `0`, which is why 20e's *"one press and one swap"* needs no
 * separate path.
 */
export function shiftCues(cues: readonly Cue[], offsetMs: number): Cue[] {
  const offset = clampOffsetMs(offsetMs);
  if (offset === 0) return [...cues];

  const shifted: Cue[] = [];
  for (const cue of cues) {
    const endMs = cue.endMs + offset;
    // A cue whose whole life is before the film starts has nowhere to be shown.
    if (endMs <= 0) continue;
    const startMs = cue.startMs + offset;
    shifted.push({
      ...cue,
      // Clipped at the front rather than moved: the end keeps its true shifted time, so a
      // cue straddling 0:00 does not silently get longer or shorter than the words need.
      startMs: Math.max(0, startMs),
      endMs,
    });
  }
  return shifted;
}

/**
 * **Which line is on the television at this instant** — the question 18i is scored on.
 *
 * *"When the founder seeks or skips, the line shown matches the new position within 1 s."*
 * Nothing in CastGood renders a word — the receiver does that, from the track it fetched —
 * so this is not how subtitles get onto a screen. It is how a test asks whether the words
 * and the picture agree: take the position the **device** reports after a jump, ask this
 * function what belongs there, and compare it against the line the founder aimed at.
 *
 * `offsetMs` is applied to the cue list rather than to the position, so the answer is about
 * the rung that is actually showing — a track nudged +0.6 s late genuinely does show a
 * different line at 0:32:10, and a comparison that ignored that would grade the wrong thing.
 *
 * The **first** covering cue in file order, when cues overlap. A television draws both; the
 * one this returns is the one it draws first, and it is a stable answer for a comparison.
 */
export function cueAt(cues: readonly Cue[], atMs: number, offsetMs = 0): Cue | null {
  const offset = clampOffsetMs(offsetMs);
  for (const cue of cues) {
    const startMs = Math.max(0, cue.startMs + offset);
    // Sorted by start, so the first cue that begins after this instant ends the search —
    // a two-hour film is a few thousand cues and a seek must not walk all of them.
    if (startMs > atMs) return null;
    if (cue.endMs + offset > atMs) return cue;
  }
  return null;
}

/**
 * The founder-facing sentence for an offset — 20a.
 *
 * *"At zero it reads **Timing: in sync** — never `+0.0 s` — so a film nobody has touched
 * never looks adjusted."* And a signed number otherwise, in seconds, because the nudge step
 * is half a second and milliseconds are below what anyone can judge from a sofa.
 */
export function describeOffset(offsetMs: number): string {
  const offset = clampOffsetMs(offsetMs);
  if (offset === 0) return 'in sync';
  const seconds = offset / 1_000;
  // One decimal place: 0.5 s steps mean the second digit would always be zero, and a wait
  // stated more precisely than it is known reads as a promise nothing can keep.
  const magnitude = Math.abs(seconds).toFixed(1);
  return `${offset > 0 ? '+' : '−'}${magnitude} s`;
}
