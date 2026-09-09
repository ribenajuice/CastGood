import path from 'node:path';
import type { ProbeResult, ProbeStream } from '../media/ffprobe.js';
import { subtitleStreams } from '../media/ffprobe.js';

/**
 * **What subtitles this film could have** — the list the founder chooses from (18a, 18b, 18k).
 *
 * Pure, and deliberately so: it takes a probe and a **directory listing**, and returns names.
 * 18b is explicit that *"nothing beside the film is read until the founder chooses it;
 * discovery is a directory listing, not a parse."* So nothing here opens a file, and a
 * folder of forty `.srt`s costs forty string comparisons rather than forty reads.
 *
 * It also never produces a path or a codec name. 18a: *"No codec names, no stream indices,
 * no file paths."* The path is carried in `ref` for the engine to act on and is not for the
 * screen — the label is what the founder reads.
 */

/**
 * File extensions worth offering. Anything else beside a film is not a subtitle.
 *
 * **`.sub` was offered here and is not any more** (M3c step 3). A `.sub` is normally the
 * binary half of a VobSub pair — the words are pictures, in the `.idx` beside it — and 18k
 * already refuses picture subtitles in as many words. Offering it by name would have put a
 * file in the list that can only ever end in a refusal, which is the opposite of what 18k
 * asks for: it names what it cannot do *about tracks the founder can see inside the film*,
 * not about every file in the folder.
 *
 * **`.ass` and `.ssa` stay, and they are not parsed here.** `parseCues` keys on a `-->`
 * timing line, which ASS/SSA do not have — offered by name and read directly they would
 * yield zero cues every time. They go through the **same ffmpeg text conversion** the
 * embedded tracks use, which is what `subtitleRouteFor` in `prepare.ts` decides.
 */
export const SIDECAR_EXTENSIONS = ['.srt', '.vtt', '.ass', '.ssa'] as const;

/** Language codes that mean "nobody said", and so must not be shown as a language. */
const UNSPECIFIED = new Set(['', 'und', 'unknown', 'none']);

/**
 * Enough languages to name the common cases; anything else is shown by its own code rather
 * than invented. The same discipline `classify.ts` already applies to the prepared-copy
 * notice — a founder reading *"Track 3"* learns more than one reading *"qaa"*.
 */
const LANGUAGE_NAMES: Readonly<Record<string, string>> = {
  eng: 'English',
  en: 'English',
  fre: 'French',
  fra: 'French',
  fr: 'French',
  ger: 'German',
  deu: 'German',
  de: 'German',
  spa: 'Spanish',
  es: 'Spanish',
  ita: 'Italian',
  it: 'Italian',
  por: 'Portuguese',
  pt: 'Portuguese',
  dut: 'Dutch',
  nld: 'Dutch',
  nl: 'Dutch',
  jpn: 'Japanese',
  ja: 'Japanese',
  kor: 'Korean',
  ko: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  zh: 'Chinese',
  rus: 'Russian',
  ru: 'Russian',
  swe: 'Swedish',
  sv: 'Swedish',
  dan: 'Danish',
  da: 'Danish',
  nor: 'Norwegian',
  no: 'Norwegian',
  fin: 'Finnish',
  fi: 'Finnish',
  pol: 'Polish',
  pl: 'Polish',
  ara: 'Arabic',
  ar: 'Arabic',
  hin: 'Hindi',
  hi: 'Hindi',
};

/** True when a code is one this app can name — used to tell `Cars.en.srt` from `Cars.2.srt`. */
export function isKnownLanguageCode(code: string): boolean {
  const lower = code.trim().toLowerCase();
  return !UNSPECIFIED.has(lower) && lower in LANGUAGE_NAMES;
}

export function languageName(code: string | null): string | null {
  if (code === null) return null;
  const lower = code.trim().toLowerCase();
  if (UNSPECIFIED.has(lower)) return null;
  return LANGUAGE_NAMES[lower] ?? lower.toUpperCase();
}

/** Where a subtitle source's words come from. */
export type SubtitleOrigin =
  /** A text track inside the film itself. `ref` is the stream index, for ffmpeg. */
  | { readonly kind: 'embedded'; readonly streamIndex: number }
  /** A file sitting beside the film. `ref` is its full path. */
  | { readonly kind: 'sidecar'; readonly filePath: string }
  /** A file the founder picked from anywhere. 18c: it is used where it lives. */
  | { readonly kind: 'picked'; readonly filePath: string };

export interface SubtitleSource {
  /** Stable within one film+device check, so the renderer can name a choice back to us. */
  readonly id: string;
  /** What the founder reads. Never a path, a codec or a stream index. */
  readonly label: string;
  /**
   * The language code, for the **television's own** track menu — never for the screen.
   *
   * `null` when nobody said. From the film's own metadata for an embedded track, and from a
   * dotted qualifier for a sidecar (`Cars.en.srt`) — but only when that qualifier is a
   * language code this app recognises, so `Cars.2.srt` and `Cars.forced.srt` stay unnamed
   * rather than being asserted to be languages called *2* and *forced*.
   */
  readonly language: string | null;
  readonly origin: SubtitleOrigin;
}

/**
 * A track we can see and cannot use — 18k.
 *
 * *"Listing them and refusing is deliberate: hiding them entirely reads as CastGood having
 * missed the subtitles the founder can see in the file."* So it carries its own sentence,
 * and the sentence never mentions PGS or VobSub.
 */
export interface UnavailableSubtitle {
  readonly label: string;
  readonly why: string;
}

/**
 * **Read an id back into the source it names** — how a subtitle comes back after a reattach.
 *
 * A source's id already carries everything needed to find the words again: `embedded:3` is
 * the third stream of the film, `sidecar:<path>` and `picked:<path>` are files. Story 12
 * writes that one string down when the app is closed mid-film and hands it back on the next
 * launch, so that 18h's *"the subtitles come back with the film, from the same source"* is a
 * matter of re-reading what the founder already chose rather than of guessing.
 *
 * **Total, and refuses rather than assumes.** The string comes off disk, where it can be
 * hand-edited or left behind by a future version, so anything that is not one of the three
 * shapes returns `null` and the caller comes back with no subtitles — which is the same
 * thing that happens when the file has been deleted, and is never a failed cast.
 */
export function subtitleOriginFromId(id: string): SubtitleOrigin | null {
  const at = id.indexOf(':');
  if (at <= 0) return null;
  const kind = id.slice(0, at);
  const rest = id.slice(at + 1);
  if (rest === '') return null;
  if (kind === 'embedded') {
    // A stream index, and only a stream index: it is fed to ffmpeg's `-map`, so a value
    // that is not a plain non-negative integer must never reach it.
    if (!/^\d{1,4}$/.test(rest)) return null;
    return { kind: 'embedded', streamIndex: Number(rest) };
  }
  if (kind === 'sidecar') return { kind: 'sidecar', filePath: rest };
  if (kind === 'picked') return { kind: 'picked', filePath: rest };
  return null;
}

export interface SubtitleChoices {
  readonly sources: readonly SubtitleSource[];
  readonly unavailable: readonly UnavailableSubtitle[];
}

// --- Sidecars ----------------------------------------------------------------

/**
 * Which files beside the film are this film's subtitles — **18b, and the rule is strict**.
 *
 * `Cars.mkv` matches `Cars.srt`, `Cars.en.srt`, `Cars.eng.srt` and `Cars.vtt`. It does not
 * match `Cars 2.srt`, `Cars-commentary.srt` or `Carsick.srt`.
 *
 * *"A file whose stem does not match the film's is never offered — the discipline of the
 * prepared-sibling decision applies here too: a name that merely rhymes is not a match."*
 * So the test is the film's stem followed by **either nothing or a dot**, never a loose
 * prefix. `Cars` is a prefix of `Carsick` and that is exactly the mistake being refused.
 *
 * Comparison is case-insensitive because Windows filesystems are, and a founder who typed
 * `CARS.SRT` meant this film.
 *
 * **CastGood's own artifacts are excluded.** 8e writes `Cars (CastGood).eng.vtt` beside the
 * prepared copy, and offering those back would contradict 18f, which requires the track to
 * come from the source or a sidecar and **never from the prepared copy**.
 */
export function sidecarsFor(filmPath: string, entries: readonly string[]): string[] {
  const filmBase = path.basename(filmPath);
  const stem = filmBase.slice(0, filmBase.length - path.extname(filmBase).length).toLowerCase();
  if (stem === '') return [];
  const directory = path.dirname(filmPath);

  const found: string[] = [];
  for (const entry of entries) {
    const lower = entry.toLowerCase();
    const extension = path.extname(lower);
    if (!(SIDECAR_EXTENSIONS as readonly string[]).includes(extension)) continue;
    // Ours, not theirs — see 18f.
    if (lower.includes('(castgood)')) continue;

    const entryStem = lower.slice(0, lower.length - extension.length);
    // Either the same name, or the same name plus a dotted qualifier like `.en`.
    if (entryStem !== stem && !entryStem.startsWith(`${stem}.`)) continue;
    found.push(path.join(directory, entry));
  }
  return found.sort((a, b) => a.localeCompare(b));
}

/**
 * What to call a sidecar on screen — **its own filename**, which is what 18b promises.
 *
 * The founder put that file there and named it; showing them anything else would be us
 * being clever about a thing they already recognise.
 */
export function sidecarLabel(filePath: string): string {
  return path.basename(filePath);
}

/**
 * The language a sidecar's own name claims, when it claims one this app can name.
 *
 * `Cars.en.srt` → `en`. `Cars.srt` → `null`. `Cars.forced.srt` → `null`, because *forced*
 * is not a language and telling a television it is would be an invention.
 */
export function sidecarLanguage(filmPath: string, filePath: string): string | null {
  const filmBase = path.basename(filmPath);
  const stem = filmBase.slice(0, filmBase.length - path.extname(filmBase).length).toLowerCase();
  const base = path.basename(filePath).toLowerCase();
  const withoutExtension = base.slice(0, base.length - path.extname(base).length);
  if (!withoutExtension.startsWith(`${stem}.`)) return null;
  const qualifier = withoutExtension.slice(stem.length + 1);
  return isKnownLanguageCode(qualifier) ? qualifier : null;
}

// --- Embedded tracks ---------------------------------------------------------

/**
 * What to call a track inside the film.
 *
 * 18a: *"labelled with the language the film names, or **Track 2** when it names none"*. The
 * ordinal is the track's place among the subtitle tracks the founder can see, not its stream
 * index — a stream index is bookkeeping and 18a forbids it on screen.
 *
 * `forced` earns a word because a forced track is a genuinely different thing: it carries
 * only the lines spoken in another language, and a founder who picks it expecting full
 * subtitles has been misled by a label that said nothing.
 */
export function embeddedLabel(stream: ProbeStream, ordinal: number): string {
  const named = languageName(stream.language);
  const base = named ?? `Track ${String(ordinal)}`;
  return stream.isForced ? `${base} (forced)` : base;
}

// --- The list ----------------------------------------------------------------

/**
 * Build the founder-facing list — 18a's *"every text subtitle track in the film, any sidecar
 * file found beside it, and Choose a file…"*, with **Off** selected by the caller.
 *
 * Order is deliberate: **the film's own tracks first**, because they are the ones that
 * belong to it and need no explanation; then files found beside it; then the picker. A
 * default track is not hoisted to the top — 19a says Off is the state on every film every
 * time, so promoting one would be the first step towards a film that arrives pre-chosen.
 */
export function subtitleChoices(input: {
  readonly filmPath: string;
  readonly probe: ProbeResult | null;
  /** A plain directory listing — names only, nothing read. */
  readonly folderEntries: readonly string[];
}): SubtitleChoices {
  const sources: SubtitleSource[] = [];
  const unavailable: UnavailableSubtitle[] = [];

  const streams = input.probe === null ? [] : subtitleStreams(input.probe);
  // **One counter, not two.** `embeddedLabel` says the ordinal is "the track's place among
  // the subtitle tracks the founder can see" — and a founder looking at a film with one
  // unnamed text track and one unnamed PGS track can see both. Two independent counters
  // labelled them *Track 1* in the list and *Track 1* in the refused rows underneath it:
  // the same name for two different things, on the same screen, at the same time.
  let ordinal = 0;
  for (const stream of streams) {
    if (stream.subtitleForm === 'text') {
      ordinal += 1;
      sources.push({
        id: `embedded:${String(stream.index)}`,
        label: embeddedLabel(stream, ordinal),
        language: stream.language,
        origin: { kind: 'embedded', streamIndex: stream.index },
      });
      continue;
    }
    // 18k: seen, listed, refused — and never re-encoded to burn them in.
    ordinal += 1;
    const named = languageName(stream.language);
    unavailable.push({
      label: named ?? `Track ${String(ordinal)}`,
      why: 'These subtitles are pictures rather than words, so they can’t be sent to a television.',
    });
  }

  for (const filePath of sidecarsFor(input.filmPath, input.folderEntries)) {
    sources.push({
      id: `sidecar:${filePath}`,
      label: sidecarLabel(filePath),
      language: sidecarLanguage(input.filmPath, filePath),
      origin: { kind: 'sidecar', filePath },
    });
  }

  return { sources, unavailable };
}
