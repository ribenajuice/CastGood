/**
 * The growing playlist, as **we** emit it — never as ffmpeg wrote it.
 *
 * This is measured behaviour from SPIKE-1 rather than documentation, and getting any of it
 * wrong fails with **no diagnostic whatsoever**: a bare `LOAD_FAILED` with no reason
 * attached, identical to the one a device sends when it genuinely cannot decode a file.
 * Two refused runs on 2026-08-19 cost an evening between them, one for relative segment
 * URLs and one for missing CORS headers plus an untrue `TARGETDURATION`.
 *
 * ## Why ffmpeg's `index.m3u8` is an input and never the thing we serve
 *
 * It is wrong in two ways that matter, and both are ffmpeg being reasonable rather than
 * ffmpeg being broken:
 *
 *  1. **Its `#EXT-X-TARGETDURATION` is what it was asked for, not what it produced.** A
 *     stream copy can only cut at keyframes, so `-hls_time 4` against a real film produces
 *     anything from 0.96 s to 12.26 s — and SPIKE-1's fixture declared `12` next to a
 *     **12.262256 s** segment. That is invalid HLS and a candidate cause of a refused load.
 *     Ours is recomputed as `ceil(max(EXTINF))` over the segments that actually exist.
 *  2. **Its segment names are relative**, and the Default Media Receiver wants absolute
 *     URLs with no redirect. A relative name *should* resolve against the playlist URL; the
 *     first spike run used one and the television refused the load.
 *
 * Everything here is pure. The one thing that touches a disk is the caller, which lists the
 * directory and hands the result in — so what we publish can be tested against a scripted
 * conversion in WSL, which is the only place any of this can be tested at all.
 */

/**
 * The name we publish a growing conversion under, and the file we read it from.
 *
 * They are deliberately different names. `index.m3u8` is ffmpeg's, and a request for it
 * would be answered off the disk by the ordinary file path — serving the very playlist the
 * ADR says we must never serve. `stream.m3u8` exists only in our answers, so the untrue one
 * is unreachable by construction rather than by remembering not to ask for it.
 */
export const HLS_SOURCE_PLAYLIST = 'index.m3u8';
export const HLS_PUBLISHED_PLAYLIST = 'stream.m3u8';

export interface HlsSegment {
  /** The file name as ffmpeg wrote it, e.g. `segment00042.ts`. Never a path. */
  readonly name: string;
  readonly durationSec: number;
}

export interface HlsIndex {
  readonly segments: readonly HlsSegment[];
  /** True once ffmpeg has written `#EXT-X-ENDLIST` — the conversion is finished. */
  readonly ended: boolean;
}

/**
 * Read ffmpeg's own playlist for the one thing it is trustworthy about: **which segments
 * exist and how long each really is.**
 *
 * Durations come from `#EXTINF`, which is measured rather than requested, and that
 * distinction has already cost this project a run: treating `TARGETDURATION` as the segment
 * length made SPIKE-1 report a conversion running at 1.5× while it actually crawled at
 * 0.55×, with every "how far did it get" number wrong and a stall blamed on the television.
 *
 * Anything unrecognised is ignored rather than guessed at. This is another process's output.
 */
export function parseHlsIndex(text: string): HlsIndex {
  const segments: HlsSegment[] = [];
  let pending: number | null = null;
  let ended = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    if (trimmed === '#EXT-X-ENDLIST') {
      ended = true;
      continue;
    }
    const inf = /^#EXTINF:(\d+(?:\.\d+)?)/.exec(trimmed);
    if (inf?.[1] !== undefined) {
      pending = Number(inf[1]);
      continue;
    }
    if (trimmed.startsWith('#')) continue;
    // A segment line with no `#EXTINF` in front of it is a playlist we do not understand.
    // Dropping it is safer than publishing a duration we invented: an `#EXTINF` that does
    // not match its segment is a playlist no receiver has ever seen.
    if (pending === null) continue;
    segments.push({ name: trimmed, durationSec: pending });
    pending = null;
  }
  return { segments, ended };
}

/** Seconds of film published so far — **summed, never multiplied.** */
export function publishedSeconds(segments: readonly HlsSegment[]): number {
  return segments.reduce((total, segment) => total + segment.durationSec, 0);
}

/**
 * `TARGETDURATION`, computed from what is really there.
 *
 * It is a **ceiling that must actually hold**, and it costs the founder something: the
 * receiver reloads the playlist once per target duration, and its own seek horizon is three
 * of them behind the live edge. So it is kept as small as the segments allow rather than
 * padded for safety. A floor of 1 because `#EXT-X-TARGETDURATION:0` is not a playlist.
 */
export function targetDurationFor(segments: readonly HlsSegment[]): number {
  const longest = segments.reduce((max, segment) => Math.max(max, segment.durationSec), 0);
  return Math.max(1, Math.ceil(longest));
}

export interface PlaylistOptions {
  readonly segments: readonly HlsSegment[];
  /**
   * Absolute, and ending in a `/`. Every segment line is this plus the segment's name.
   *
   * SPIKE-1's first refused run is the reason this is not optional and not relative.
   */
  readonly baseUrl: string;
  /**
   * Write `#EXT-X-ENDLIST`.
   *
   * **This single line is what decides live-vs-VOD**, observed rather than merely
   * documented: `streamType: BUFFERED` was sent deliberately on every SPIKE-1 run — the VOD
   * answer — and the receiver applied live semantics anyway until ENDLIST appeared, at
   * which point `liveSeekableRange.isLiveDone` flipped to `true` and the whole film became
   * seekable.
   */
  readonly ended: boolean;
}

/** The playlist we serve. Absolute URLs, an honest target duration, EVENT while it grows. */
export function buildPlaylist(options: PlaylistOptions): string {
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${String(targetDurationFor(options.segments))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    // EVENT, not VOD: the list only ever grows, nothing is ever removed from the front, and
    // a receiver that has read it once may re-read it and find more.
    '#EXT-X-PLAYLIST-TYPE:EVENT',
  ];
  for (const segment of options.segments) {
    lines.push(`#EXTINF:${segment.durationSec.toFixed(6)},`, `${options.baseUrl}${segment.name}`);
  }
  if (options.ended) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/**
 * The segments that are both listed **and** on the disk, in playlist order.
 *
 * Belt and braces over ffmpeg, which writes a segment's `#EXTINF` line only once that
 * segment is closed — so in principle the intersection is the whole list. In practice a
 * playlist read while it is being rewritten, a segment deleted by a tidy-up, or a job that
 * died mid-write are all cheaper to survive than to reason about, and publishing a name
 * that 404s is the one thing this serving shape must never do: it is the stall the PRD
 * forbids, arriving as our own fault.
 */
export function existingSegments(
  segments: readonly HlsSegment[],
  present: ReadonlySet<string>,
): HlsSegment[] {
  return segments.filter((segment) => present.has(segment.name));
}
