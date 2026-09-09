import { z } from 'zod';
import type { AudioCodec, Container, VideoCodec } from '../types.js';

/**
 * What inspecting a file tells us, and the parser that produces it.
 *
 * **There is no `spawn` in this file, on purpose.** This is the *result* half of the probe
 * seam: the shape the classifier reasons over, and the validation of ffprobe's JSON on the
 * way in. Running the binary is the other half (`FfmpegBinaries` in `../prepare/index.ts`,
 * whose paths the packaged app supplies). Keeping the two apart is what lets the whole
 * classifier — the part of M3 that decides what the founder is told — be exercised
 * headlessly in WSL, where there is no ffprobe and never will be.
 *
 * ## ffprobe output is untrusted input
 *
 * It comes from another process, it differs between ffmpeg versions, and it prints most
 * numbers as strings. Everything below is optional, coerced, range-checked and defaulted:
 * a field we cannot make sense of becomes `null`, never a crash and never a guess. The
 * command that produces it is the one `docs/ARCHITECTURE.md` names:
 *
 * ```
 * ffprobe -v quiet -print_format json -show_format -show_streams <file>
 * ```
 *
 * ## Nothing in here is ever rendered
 *
 * Codec names, profiles, levels and resolutions are evidence for the log and inputs to the
 * classifier (PRD 7a forbids every one of them on screen). The only founder-facing strings
 * in the preparation path are the verdict's own, built in `../prepare/classify.ts`.
 */

export type StreamKind = 'video' | 'audio' | 'subtitle' | 'other';

/**
 * Can this subtitle track become the WebVTT a Chromecast can show?
 *
 * `text` tracks can (subrip, ass/ssa, mov_text, webvtt). `image` tracks are pictures —
 * PGS and VobSub, common inside downloaded remuxes — and turning them into text needs OCR,
 * which this product does not do. The distinction is the whole of criterion 8e: an image
 * track cannot survive preparation, so the founder is told before they commit.
 */
export type SubtitleForm = 'text' | 'image';

export interface ProbeStream {
  readonly index: number;
  readonly kind: StreamKind;
  /** ffprobe's `codec_name`, lower-cased. Log and classifier only — never rendered. */
  readonly codec: string;
  /** e.g. `High`, `Main 10`. `null` when ffprobe does not say. */
  readonly profile: string | null;
  /** ffprobe's `level`. For H.264 that is level × 10 (41 = L4.1); other codecs scale it differently. */
  readonly level: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly channels: number | null;
  /** ISO 639-2 from `tags.language`, lower-cased. */
  readonly language: string | null;
  readonly title: string | null;
  /** Subtitle streams only. `null` for every other kind. */
  readonly subtitleForm: SubtitleForm | null;
  readonly isDefault: boolean;
  readonly isForced: boolean;
  /**
   * Cover art carried as a one-frame video stream (`disposition.attached_pic`).
   *
   * It is a picture, not the film, and treating it as the video stream would make every
   * MKV with artwork look like an unsupported format.
   */
  readonly isAttachedPicture: boolean;
}

export interface ProbeResult {
  /**
   * The one source of truth this result came from.
   *
   * A literal rather than a comment: the header-reading fallback in `./probe.ts` cannot
   * produce this type, so nothing can accidentally classify a file from container headers.
   * See the 2026-08-19 ruling in `docs/DECISIONS.md`.
   */
  readonly origin: 'ffprobe';
  /** ffprobe's `format_name`, split — e.g. `['mov', 'mp4', 'm4a', '3gp', '3g2', 'mj2']`. */
  readonly formatNames: readonly string[];
  /** What we will treat the container as. `other` is anything we do not serve untouched. */
  readonly container: Container | 'other';
  readonly durationSec: number | null;
  readonly sizeBytes: number | null;
  readonly bitrate: number | null;
  readonly streams: readonly ProbeStream[];
}

// --- Codec vocabulary --------------------------------------------------------

const VIDEO_CODECS: Readonly<Record<string, VideoCodec>> = {
  h264: 'h264',
  avc1: 'h264',
  hevc: 'hevc',
  h265: 'hevc',
  vp8: 'vp8',
  vp9: 'vp9',
  av1: 'av1',
};

const AUDIO_CODECS: Readonly<Record<string, AudioCodec>> = {
  aac: 'aac',
  mp3: 'mp3',
  mp3float: 'mp3',
  opus: 'opus',
  vorbis: 'vorbis',
  flac: 'flac',
  ac3: 'ac3',
  eac3: 'eac3',
};

/** Subtitle codecs that are words. Anything else is assumed to be pictures. */
const TEXT_SUBTITLE_CODECS: readonly string[] = [
  'subrip',
  'srt',
  'ass',
  'ssa',
  'mov_text',
  'text',
  'webvtt',
  'vtt',
];

/** ffprobe's `codec_name` → the vocabulary the capability model speaks, or `null`. */
export function videoCodecFor(codecName: string): VideoCodec | null {
  return VIDEO_CODECS[codecName] ?? null;
}

export function audioCodecFor(codecName: string): AudioCodec | null {
  return AUDIO_CODECS[codecName] ?? null;
}

export function videoCodecOf(stream: ProbeStream): VideoCodec | null {
  return videoCodecFor(stream.codec);
}

export function audioCodecOf(stream: ProbeStream): AudioCodec | null {
  return audioCodecFor(stream.codec);
}

// --- Parsing -----------------------------------------------------------------

/** ffprobe prints numbers as strings, and `"N/A"` when it does not know. */
function numeric(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function positive(value: unknown): number | null {
  const parsed = numeric(value);
  return parsed !== null && parsed > 0 ? parsed : null;
}

/** `"24000/1001"` → 23.976. `"0/0"` — ffprobe's "no idea" — is `null`. */
function ratio(value: unknown): number | null {
  if (typeof value !== 'string') return numeric(value);
  const [top, bottom] = value.split('/');
  const numerator = numeric(top);
  const denominator = bottom === undefined ? 1 : numeric(bottom);
  if (numerator === null || denominator === null || denominator === 0) return null;
  const result = numerator / denominator;
  return Number.isFinite(result) && result > 0 ? result : null;
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'n/a' || trimmed.toLowerCase() === 'und') {
    return null;
  }
  return trimmed;
}

const looseNumber = z.union([z.number(), z.string()]).nullish();

const dispositionSchema = z
  .object({
    default: looseNumber,
    forced: looseNumber,
    attached_pic: looseNumber,
  })
  .partial()
  .loose();

const streamSchema = z
  .object({
    index: looseNumber,
    codec_type: z.string().nullish(),
    codec_name: z.string().nullish(),
    profile: z.union([z.string(), z.number()]).nullish(),
    level: looseNumber,
    width: looseNumber,
    height: looseNumber,
    coded_width: looseNumber,
    coded_height: looseNumber,
    avg_frame_rate: z.string().nullish(),
    r_frame_rate: z.string().nullish(),
    channels: looseNumber,
    duration: looseNumber,
    disposition: dispositionSchema.nullish(),
    tags: z.record(z.string(), z.unknown()).nullish(),
  })
  .partial()
  .loose();

const reportSchema = z
  .object({
    format: z
      .object({
        format_name: z.string().nullish(),
        duration: looseNumber,
        size: looseNumber,
        bit_rate: looseNumber,
      })
      .partial()
      .loose()
      .nullish(),
    streams: z.array(streamSchema).nullish(),
  })
  .partial()
  .loose();

function flag(value: unknown): boolean {
  return numeric(value) === 1;
}

function kindOf(codecType: string | null): StreamKind {
  switch (codecType) {
    case 'video':
      return 'video';
    case 'audio':
      return 'audio';
    case 'subtitle':
      return 'subtitle';
    default:
      return 'other';
  }
}

/**
 * Which container are we looking at?
 *
 * ffprobe reports `matroska,webm` for both `.mkv` and `.webm`, so the two are told apart by
 * what is inside them: a WebM may only carry VP8/VP9/AV1 video and Vorbis/Opus audio. The
 * distinction only ever matters for a device whose profile lists `webm`, and getting it
 * wrong in either direction costs one lossless remux — never a bad cast.
 */
function containerOf(
  formatNames: readonly string[],
  streams: readonly ProbeStream[],
): Container | 'other' {
  const names = new Set(formatNames);
  if (names.has('mp4') || names.has('mov') || names.has('m4v') || names.has('3gp')) return 'mp4';
  if (names.has('hls') || names.has('applehttp')) return 'hls';
  if (names.has('matroska') || names.has('webm')) {
    const webmSafe = streams.every((stream) => {
      if (stream.kind === 'video') {
        const codec = videoCodecOf(stream);
        return codec === 'vp8' || codec === 'vp9' || codec === 'av1';
      }
      if (stream.kind === 'audio') {
        const codec = audioCodecOf(stream);
        return codec === 'opus' || codec === 'vorbis';
      }
      return true;
    });
    return webmSafe ? 'webm' : 'mkv';
  }
  return 'other';
}

function parseStream(raw: z.infer<typeof streamSchema>, fallbackIndex: number): ProbeStream {
  const kind = kindOf(text(raw.codec_type)?.toLowerCase() ?? null);
  const codec = text(raw.codec_name)?.toLowerCase() ?? '';
  const disposition = raw.disposition ?? {};
  const tags = raw.tags ?? {};
  const language = text(tags['language'])?.toLowerCase() ?? null;
  return {
    index: numeric(raw.index) ?? fallbackIndex,
    kind,
    codec,
    profile: typeof raw.profile === 'number' ? String(raw.profile) : text(raw.profile),
    level: numeric(raw.level),
    width: positive(raw.width) ?? positive(raw.coded_width),
    height: positive(raw.height) ?? positive(raw.coded_height),
    frameRate: ratio(raw.avg_frame_rate) ?? ratio(raw.r_frame_rate),
    channels: positive(raw.channels),
    language,
    title: text(tags['title']),
    subtitleForm:
      kind === 'subtitle' ? (TEXT_SUBTITLE_CODECS.includes(codec) ? 'text' : 'image') : null,
    isDefault: flag(disposition.default),
    isForced: flag(disposition.forced),
    isAttachedPicture: flag(disposition.attached_pic),
  };
}

/**
 * ffprobe's JSON → a `ProbeResult`, or `null` when there is nothing usable in it.
 *
 * `null` means "we could not inspect this file" — an empty report, unparseable JSON, a
 * binary that printed a warning and nothing else. It is **not** a verdict: deciding what
 * the founder is told about an unreadable file is the classifier's job, and it needs a
 * probe to say it about. A caller with `null` here has a *check that could not run*.
 */
export function parseFfprobeReport(raw: unknown): ProbeResult | null {
  const parsed = reportSchema.safeParse(raw);
  if (!parsed.success) return null;

  const format = parsed.data.format ?? {};
  const streams = (parsed.data.streams ?? []).map((stream, index) => parseStream(stream, index));
  const formatNames = (text(format.format_name) ?? '')
    .split(',')
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name !== '');

  if (formatNames.length === 0 && streams.length === 0) return null;

  return {
    origin: 'ffprobe',
    formatNames,
    container: containerOf(formatNames, streams),
    durationSec: positive(format.duration),
    sizeBytes: positive(format.size),
    bitrate: positive(format.bit_rate),
    streams,
  };
}

/** Parses the raw stdout of the documented ffprobe invocation. */
export function parseFfprobeStdout(stdout: string): ProbeResult | null {
  let json: unknown;
  try {
    json = JSON.parse(stdout) as unknown;
  } catch {
    return null;
  }
  return parseFfprobeReport(json);
}

// --- Reading a probe ---------------------------------------------------------

/** The film's own video stream — never the cover art, and never a second angle. */
export function primaryVideoStream(probe: ProbeResult): ProbeStream | null {
  const video = probe.streams.filter((s) => s.kind === 'video' && !s.isAttachedPicture);
  return video.find((s) => s.isDefault) ?? video[0] ?? null;
}

export function audioStreams(probe: ProbeResult): readonly ProbeStream[] {
  return probe.streams.filter((s) => s.kind === 'audio');
}

export function subtitleStreams(probe: ProbeResult): readonly ProbeStream[] {
  return probe.streams.filter((s) => s.kind === 'subtitle');
}
