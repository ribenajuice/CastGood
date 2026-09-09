import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import type { Logger } from '../logging/index.js';
import type { FfmpegBinaries } from '../media/ffmpeg.js';
import type { SpawnLike } from '../media/ffprobe-runner.js';
import { SUBTITLES } from '../config.js';
import { parseCues, type Cue } from './cues.js';
import type { SubtitleOrigin, SubtitleSource } from './sources.js';

/**
 * **Turning the founder's choice into a cue list CastGood owns** — 18c, 18d, 18f, 18j.
 *
 * Four rules shape everything here, and each is a sentence of a criterion:
 *
 *  - **One extraction, and only when the source is chosen** (18d). A film with six language
 *    tracks costs exactly one ffmpeg process, because only the chosen track is asked for.
 *    Nothing runs on Cast: *"never an unexplained delay before the picture"*.
 *  - **Zero extractions when the words are already words.** A `.srt` or a `.vtt` beside the
 *    film is text we can already read — `parseCues` is the same reader story 20's shift is
 *    built on — so it costs a file read and no child process at all. ffmpeg is only the
 *    front end for the two shapes we cannot read: a stream inside a container, and ASS/SSA.
 *  - **The source file, never the prepared copy** (18f). The caller passes the film the
 *    founder chose; `Cars (CastGood).mp4` never reaches this module, which is what lets a
 *    film prepared before M3c existed still get subtitles.
 *  - **A track that parses to no cues is never produced** (18j). *"Never a film that plays
 *    with a blank track"* — so an empty file, a binary file and a `.srt` that is really HTML
 *    all end here, before Cast, rather than as a television showing nothing.
 *
 * **Nothing lands on disk, and that is not an optimisation** (2026-08-27 ADR). Step 3 wrote
 * one `.vtt` here and served it as a file; story 20's ladder needs thirteen differently
 * shifted versions of the same track, and thirteen files would be thirteen things to clean
 * up. So this returns **cues**, the media server shifts them per request, and 20g's *"the
 * founder's own subtitle file is byte-for-byte unchanged and no new file appears beside
 * it"* holds because no new file appears anywhere. The founder's own file is opened for
 * reading and is never moved, copied over, renamed or written to (18c).
 *
 * The **one** thing still written is ffmpeg's own output on the `extract`/`convert` routes —
 * it has to be handed a path — and it is read back and removed inside the same call.
 */

/** How a chosen source becomes WebVTT. Pure, so the policy is testable without a process. */
export type SubtitleRoute =
  /** Already text we can read. `parseCues` handles WebVTT and SubRip with one reader. */
  | 'parse'
  /** A text stream inside the film. One `ffmpeg -map 0:<index> -c:s webvtt`. */
  | 'extract'
  /** A sidecar in a format `parseCues` cannot read — ASS/SSA. The same ffmpeg conversion. */
  | 'convert';

/**
 * Extensions `parseCues` can read directly.
 *
 * **ASS and SSA are deliberately not here.** `parseCues` keys on a `-->` timing line and
 * theirs is `Dialogue: 0,0:00:01.00,0:00:03.00,…` — reading one directly yields zero cues
 * every time, which would have turned every ASS sidecar into 18j's refusal sentence instead
 * of a working subtitle. They go through ffmpeg, which does know the format.
 */
const READABLE_EXTENSIONS = new Set(['.srt', '.vtt', '.webvtt']);

export function subtitleRouteFor(origin: SubtitleOrigin): SubtitleRoute {
  if (origin.kind === 'embedded') return 'extract';
  return READABLE_EXTENSIONS.has(path.extname(origin.filePath).toLowerCase()) ? 'parse' : 'convert';
}

export type SubtitleFailure =
  /** The file or the film is not where it was — 18f's *"still casts without them"*. */
  | 'source-missing'
  /** Opened, and nothing in it could be decoded as text — 18j. */
  | 'unreadable'
  /** Read and parsed, and there is not one cue in it — 18j's blank track, refused. */
  | 'no-cues'
  /** ffmpeg would not produce a WebVTT from it. */
  | 'extract-failed'
  /** The founder chose something else, or the app is closing. Told to nobody. */
  | 'cancelled';

export interface PreparedSubtitle {
  /** The choice this came from, so a stale answer can be recognised and dropped. */
  readonly sourceId: string;
  /** What the founder reads — the source's own label, never a path. */
  readonly label: string;
  /** BCP-47-ish, for the track declaration. `''` when the film named none. */
  readonly language: string;
  /**
   * **The words, in memory, and this is the whole track** (2026-08-27 ADR).
   *
   * Step 3 wrote a `.vtt` here and served it as a file. Story 20's ladder needs thirteen
   * differently-shifted versions of it, and writing thirteen files would be thirteen things
   * to clean up — so nothing is written at all: the media server shifts this list by the
   * offset named in each rung's own URL. Never empty; 18j refuses a zero-cue track before
   * it can become one.
   */
  readonly cues: readonly Cue[];
  /** How many cues it holds. Never zero — a zero-cue track is refused, not produced. */
  readonly cueCount: number;
}

export type PrepareSubtitleResult =
  | { readonly ok: true; readonly track: PreparedSubtitle }
  | { readonly ok: false; readonly failure: SubtitleFailure };

export interface PrepareSubtitleRequest {
  /**
   * The **source** film — 18f, and the word is load-bearing. Never the prepared sibling.
   */
  readonly filmPath: string;
  readonly source: SubtitleSource;
  /** The language the film named for this track, when it named one. */
  readonly language?: string;
  /** `paths.subtitlesDir`. Created on demand. */
  readonly workingDir: string;
}

export interface PrepareSubtitleDeps {
  readonly logger: Logger;
  /** `null` on a machine with no bundled ffmpeg — every WSL session and every engine test. */
  readonly binaries: FfmpegBinaries | null;
  readonly spawn?: SpawnLike;
  readonly signal?: AbortSignal;
}

/**
 * A subtitle file that is larger than this is not a subtitle file.
 *
 * A two-hour film's `.srt` is around 100 kB. Ten megabytes is a hundred times that, and the
 * point of the bound is that this reads a path the founder pointed at (18c) — a picker is
 * untrusted input in the same sense a renderer is, and *"read the whole file into memory"*
 * needs a ceiling that is not "whatever they clicked on".
 */
const MAX_SUBTITLE_BYTES = 10 * 1024 * 1024;

/** How long ffmpeg gets to produce one text track before we stop waiting for it. */
const EXTRACT_TIMEOUT_MS = SUBTITLES.prepareBudgetMs * 4;

/**
 * A stable name for one (film, source) pair — ffmpeg's scratch file, and nothing else.
 *
 * Deterministic so the same choice reuses the same name rather than littering the working
 * directory, and a hash so nothing in the founder's filenames — which may be anything at
 * all — ever reaches a path we construct.
 */
export function subtitleWorkingName(filmPath: string, sourceId: string): string {
  const key = crypto
    .createHash('sha256')
    .update(`${String(filmPath.length)}:${filmPath}:${sourceId}`)
    .digest('hex')
    .slice(0, 16);
  return `${key}.vtt`;
}

/**
 * Decode a subtitle file, or say why not.
 *
 * **UTF-8 first, Windows-1252 second, and a refusal for anything that is not text at all.**
 * Subtitle files in the wild are mostly UTF-8 and the rest are usually the Windows codepage;
 * decoding strictly first and falling back is what tells the two apart, rather than decoding
 * loosely and producing a file full of replacement characters that a television would
 * happily display. A NUL byte means this is not text in any encoding — 18j's binary file —
 * and it is refused here rather than reaching the parser.
 */
function decodeSubtitle(bytes: Buffer): string | null {
  // **UTF-16 before the NUL test, or half the Windows subtitle world is "not text".**
  // A UTF-16 file is roughly 50% NUL bytes, so the binary check below refuses every one of
  // them — and `.srt`/`.vtt` take the `parse` route, so ffmpeg never gets the chance to
  // rescue it. The founder would read 18j's *couldn't be read* about a perfectly good file
  // written by a perfectly ordinary Windows tool. A byte-order mark is what tells the two
  // apart: a real binary does not begin with one.
  if (bytes.length >= 2) {
    const bom = bytes.readUInt16LE(0);
    // 0xFEFF little-endian reads as FF FE on disk; 0xFFFE little-endian is FE FF, big-endian.
    if (bom === 0xfeff) return new TextDecoder('utf-16le').decode(bytes.subarray(2));
    if (bom === 0xfffe) return new TextDecoder('utf-16be').decode(bytes.subarray(2));
  }
  if (bytes.includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    // Never throws: every byte has a mapping. That is why it is the fallback and not the
    // first attempt — asked first, it would silently accept genuinely broken UTF-8.
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

async function readSubtitleText(
  filePath: string,
): Promise<{ ok: true; text: string } | { ok: false; failure: SubtitleFailure }> {
  let bytes: Buffer;
  try {
    const stat = await fsp.stat(filePath);
    if (!stat.isFile()) return { ok: false, failure: 'source-missing' };
    if (stat.size > MAX_SUBTITLE_BYTES) return { ok: false, failure: 'unreadable' };
    bytes = await fsp.readFile(filePath);
  } catch {
    return { ok: false, failure: 'source-missing' };
  }
  const text = decodeSubtitle(bytes);
  return text === null ? { ok: false, failure: 'unreadable' } : { ok: true, text };
}

/**
 * The one ffmpeg invocation this module ever makes.
 *
 * `-map` is explicit for the same reason it is explicit in the preparation pipeline: the
 * default mapping picks whichever stream comes first, which for a film with an English track
 * and a director's commentary is a coin toss. `-c:s webvtt -f webvtt` is the whole
 * conversion — a text stream copy into the one format a Chromecast renders.
 */
export function buildExtractArgs(
  inputPath: string,
  mapSpecifier: string,
  outputPath: string,
): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-loglevel',
    'error',
    '-y',
    '-i',
    path.resolve(inputPath),
    '-map',
    mapSpecifier,
    '-c:s',
    'webvtt',
    '-f',
    'webvtt',
    path.resolve(outputPath),
  ];
}

function runExtract(
  args: string[],
  deps: PrepareSubtitleDeps,
  binaries: FfmpegBinaries,
): Promise<{ ok: boolean; stderr: string }> {
  const spawnProcess = deps.spawn ?? (nodeSpawn as SpawnLike);
  return new Promise((resolve) => {
    let child: ChildProcess;
    let settled = false;
    let stderr = '';
    let timer: NodeJS.Timeout | null = null;

    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      deps.signal?.removeEventListener('abort', onAbort);
      resolve({ ok, stderr });
    };
    function onAbort(): void {
      try {
        child.kill();
      } catch {
        // Already gone is the outcome we were asking for.
      }
      finish(false);
    }

    try {
      child = spawnProcess(binaries.ffmpeg, args, {
        stdio: ['ignore', 'ignore', 'pipe'],
        windowsHide: true,
      });
    } catch {
      finish(false);
      return;
    }
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr = `${stderr}${String(chunk)}`.slice(0, 4_000);
    });
    child.on('error', () => finish(false));
    child.on('close', (code: number | null) => finish(code === 0));
    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        // See above.
      }
      finish(false);
    }, EXTRACT_TIMEOUT_MS);
    timer.unref?.();
    if (deps.signal?.aborted === true) onAbort();
    else deps.signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * The whole of 18d for one chosen source: read or extract, parse, refuse or write.
 *
 * Staging is the same discipline the preparation pipeline uses — write `.partial`, rename
 * on success — so a cancelled or failed run never leaves a half-written `.vtt` for the next
 * cast to serve.
 */
export async function prepareSubtitle(
  request: PrepareSubtitleRequest,
  deps: PrepareSubtitleDeps,
): Promise<PrepareSubtitleResult> {
  const route = subtitleRouteFor(request.source.origin);
  // The only path this function constructs, and the only file it can leave behind. It is
  // removed before the extraction and again after it, on every route out.
  const rawPath = `${path.join(
    request.workingDir,
    subtitleWorkingName(request.filmPath, request.source.id),
  )}.raw`;
  const startedAt = Date.now();

  const cleanup = async (): Promise<void> => {
    await fsp.rm(rawPath, { force: true }).catch(() => undefined);
  };
  const give = async (failure: SubtitleFailure): Promise<PrepareSubtitleResult> => {
    await cleanup();
    deps.logger.warn('subtitle.prepare_failed', {
      sourceId: request.source.id,
      route,
      failure,
      elapsedMs: Date.now() - startedAt,
    });
    return { ok: false, failure };
  };

  /** Read through a call rather than a field, so one early check cannot narrow the rest. */
  const aborted = (): boolean => deps.signal?.aborted === true;
  if (aborted()) return { ok: false, failure: 'cancelled' };

  try {
    await fsp.mkdir(request.workingDir, { recursive: true });
  } catch {
    return give('extract-failed');
  }

  let text: string;
  if (route === 'parse') {
    const origin = request.source.origin;
    /* c8 ignore next */
    if (origin.kind === 'embedded') return give('extract-failed');
    const read = await readSubtitleText(origin.filePath);
    if (!read.ok) return give(read.failure);
    text = read.text;
  } else {
    if (deps.binaries === null) return give('extract-failed');
    const origin = request.source.origin;
    const input = origin.kind === 'embedded' ? request.filmPath : origin.filePath;
    // The stream index for an embedded track; the first (and normally only) subtitle
    // stream of a sidecar file for a converted one.
    const specifier = origin.kind === 'embedded' ? `0:${String(origin.streamIndex)}` : '0:s:0';
    await cleanup();
    const run = await runExtract(buildExtractArgs(input, specifier, rawPath), deps, deps.binaries);
    if (aborted()) {
      await cleanup();
      return { ok: false, failure: 'cancelled' };
    }
    if (!run.ok) {
      deps.logger.warn('subtitle.extract_rejected', {
        sourceId: request.source.id,
        stderr: run.stderr.slice(0, 500),
      });
      return give('extract-failed');
    }
    const read = await readSubtitleText(rawPath);
    if (!read.ok) return give(read.failure === 'source-missing' ? 'extract-failed' : read.failure);
    text = read.text;
  }

  const cues: Cue[] = parseCues(text);
  // **18j's floor, and it is a floor rather than a preference.** A track with no cues is a
  // film that plays with a blank track, which the criterion refuses in as many words. It is
  // never written, never mounted and never declared.
  if (cues.length === 0) return give('no-cues');

  // **Nothing is written.** The cues are the track from here on: the media server derives
  // every rung of the ladder from them at request time, so there is no working copy to
  // stage, rename, serve or tidy up — and 20g's *"no new file appears beside it"* holds
  // because no new file appears anywhere at all.
  await cleanup();

  const elapsedMs = Date.now() - startedAt;
  deps.logger.info('subtitle.prepared', {
    sourceId: request.source.id,
    route,
    cues: cues.length,
    elapsedMs,
    // 18d promises 5 s for a 2-hour film. If it is ever missed, the log says so rather
    // than the promise being quietly untrue — exactly as `file.check_slow` does for 7a.
    budgetMs: SUBTITLES.prepareBudgetMs,
  });
  if (elapsedMs > SUBTITLES.prepareBudgetMs) {
    deps.logger.warn('subtitle.prepare_slow', { elapsedMs, budgetMs: SUBTITLES.prepareBudgetMs });
  }

  return {
    ok: true,
    track: {
      sourceId: request.source.id,
      label: request.source.label,
      language: request.language ?? '',
      cues,
      cueCount: cues.length,
    },
  };
}
