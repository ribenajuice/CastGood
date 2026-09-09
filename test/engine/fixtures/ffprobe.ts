import { parseFfprobeReport, type ProbeResult } from '../../../src/engine/media/ffprobe.js';
import type { FfprobeRunner, ProbeFailure } from '../../../src/engine/media/inspection.js';

/**
 * Fixtures for the classifier, written as **raw ffprobe JSON** rather than as ready-made
 * `ProbeResult` objects.
 *
 * That is the whole point of them. This project has been burned six times by an instrument
 * kinder than reality, and hand-built result objects would test the classifier against our
 * idea of ffprobe rather than against ffprobe: numbers as strings, `"0/0"` frame rates,
 * `"und"` languages, `coded_height: 1088` beside `height: 1080`, a `filename` we must never
 * carry, cover art that is a video stream. Every fixture below is shaped like the real
 * output of
 *
 *     ffprobe -v quiet -print_format json -show_format -show_streams <file>
 *
 * and goes through the same parser the product uses. A fixture that stops matching real
 * ffprobe output is a fixture that has stopped proving anything — when the binaries land on
 * Windows, one run of the `check` selftest scenario against a real file is what re-earns the
 * trust in this file.
 */

export interface StreamJson {
  [key: string]: unknown;
}

export function videoStream(overrides: StreamJson = {}): StreamJson {
  return {
    index: 0,
    codec_name: 'h264',
    codec_long_name: 'H.264 / AVC / MPEG-4 AVC / MPEG-4 part 10',
    profile: 'High',
    codec_type: 'video',
    width: 1920,
    height: 1080,
    coded_width: 1920,
    coded_height: 1088,
    level: 41,
    r_frame_rate: '24000/1001',
    avg_frame_rate: '24000/1001',
    time_base: '1/24000',
    bit_rate: '4500000',
    disposition: { default: 1, forced: 0, attached_pic: 0 },
    tags: { language: 'und' },
    ...overrides,
  };
}

/**
 * The ordinary film's sound: **stereo**, and the default is stereo on purpose.
 *
 * It used to be `channels: 6, channel_layout: '5.1'`, which made `mp4H264Aac` — commented
 * *"Tier 1 everywhere"* — a file the plain Chromecast in the bedroom cannot play, and every
 * fixture built on it quietly wrong about the tier it claimed. Nothing noticed, because
 * until defect D1 (2026-08-24) no code in the product read `channels` at all.
 *
 * So the two cases are now **named** rather than inherited: this one is the film that plays,
 * `surroundAudioStream` is the film that does not. A fixture that means to carry 5.1 has to
 * say so, which is the whole of D1's regression rule 1 — *a test whose fixture cannot express
 * the defect is not evidence, however green it is.*
 */
export function audioStream(overrides: StreamJson = {}): StreamJson {
  return {
    index: 1,
    codec_name: 'aac',
    profile: 'LC',
    codec_type: 'audio',
    sample_rate: '48000',
    channels: 2,
    channel_layout: 'stereo',
    bit_rate: '192000',
    disposition: { default: 1, forced: 0, attached_pic: 0 },
    tags: { language: 'eng' },
    ...overrides,
  };
}

/**
 * The sound on every HEVC film in the founder's `D:\DUMP\Movies` — all thirty of them were
 * probed on 2026-08-24 and all thirty are 6-channel.
 *
 * This is the stream a stereo-only receiver plays for 0.232 s and then abandons.
 */
export function surroundAudioStream(overrides: StreamJson = {}): StreamJson {
  return audioStream({
    channels: 6,
    channel_layout: '5.1',
    bit_rate: '384000',
    ...overrides,
  });
}

/**
 * Sound whose channel count ffprobe would not state.
 *
 * Rare, and the reason it is here is that "we did not measure it" is the case a rule about
 * measurements is most likely to get wrong. `channels` is `null` for a stream ffprobe opened
 * but could not describe; the classifier's answer to it is pinned in `d1-audio-channels`.
 */
export function unmeasuredAudioStream(overrides: StreamJson = {}): StreamJson {
  return audioStream({ channels: null, channel_layout: null, ...overrides });
}

export function subtitleStream(overrides: StreamJson = {}): StreamJson {
  return {
    index: 2,
    codec_name: 'subrip',
    codec_type: 'subtitle',
    disposition: { default: 0, forced: 0, attached_pic: 0 },
    tags: { language: 'eng' },
    ...overrides,
  };
}

/** Cover art, as ffprobe reports it inside an MKV or an MP4: a one-frame video stream. */
export function coverArtStream(overrides: StreamJson = {}): StreamJson {
  return {
    index: 3,
    codec_name: 'mjpeg',
    codec_type: 'video',
    width: 600,
    height: 900,
    r_frame_rate: '90000/1',
    avg_frame_rate: '0/0',
    disposition: { default: 0, forced: 0, attached_pic: 1 },
    ...overrides,
  };
}

export interface ReportOptions {
  readonly formatName?: string;
  readonly durationSec?: number | null;
  readonly sizeBytes?: number;
  readonly streams?: readonly StreamJson[];
}

export function report(options: ReportOptions = {}): unknown {
  const format: Record<string, unknown> = {
    // ffprobe really does print the path back at us. Nothing downstream may keep it.
    filename: 'C:\\Films\\Some Film (2019) 1080p.mkv',
    nb_streams: options.streams?.length ?? 2,
    format_name: options.formatName ?? 'mov,mp4,m4a,3gp,3g2,mj2',
    format_long_name: 'QuickTime / MOV',
    size: String(options.sizeBytes ?? 4_294_967_296),
    bit_rate: '4915200',
  };
  const duration = options.durationSec === undefined ? 6_990 : options.durationSec;
  if (duration !== null) format['duration'] = duration.toFixed(6);
  return {
    streams: options.streams ?? [videoStream(), audioStream()],
    format,
  };
}

/** Parses a fixture, failing loudly rather than letting a test run on `null`. */
export function probeOf(json: unknown): ProbeResult {
  const parsed = parseFfprobeReport(json);
  if (parsed === null) throw new Error('fixture did not parse as an ffprobe report');
  return parsed;
}

const MKV = 'matroska,webm';

// --- The library, as the founder's actually looks ----------------------------

/** The easy one: an MP4 of H.264 High L4.1 1080p23.976 with AAC. Tier 1 everywhere. */
export const mp4H264Aac = (): unknown => report();

/** The common Tier 2: identical streams, wrong box. No Chromecast plays Matroska. */
export const mkvH264Aac = (): unknown => report({ formatName: MKV });

/** A downloaded remux: fine picture, AC-3 sound the baseline does not promise. */
export const mkvH264Ac3 = (): unknown =>
  report({
    formatName: MKV,
    streams: [videoStream(), surroundAudioStream({ codec_name: 'ac3', profile: null })],
  });

/** 4K HEVC. An Ultra plays it; the baseline must not pretend to. */
export const mp4Hevc4k = (): unknown =>
  report({
    streams: [
      videoStream({
        codec_name: 'hevc',
        profile: 'Main 10',
        width: 3840,
        height: 2160,
        coded_width: 3840,
        coded_height: 2160,
        level: 153,
      }),
      audioStream(),
    ],
  });

/** 1080p60 — inside the baseline on every axis but one. */
export const mp4H264_60fps = (): unknown =>
  report({
    streams: [
      videoStream({ r_frame_rate: '60/1', avg_frame_rate: '60/1', level: 42 }),
      audioStream(),
    ],
  });

/** 10-bit H.264: the profile axis, which nothing else exercises. */
export const mp4H264High10 = (): unknown =>
  report({ streams: [videoStream({ profile: 'High 10' }), audioStream()] });

/** WebM/VP9/Opus — Tier 1 on an Ultra, a full conversion on an unknown television. */
export const webmVp9Opus = (): unknown =>
  report({
    formatName: MKV,
    streams: [
      videoStream({ codec_name: 'vp9', profile: 'Profile 0', level: null }),
      audioStream({ codec_name: 'opus', profile: null }),
    ],
  });

/** An MKV with picture-based subtitles — the shape 8e exists for. */
export const mkvWithPgs = (): unknown =>
  report({
    formatName: MKV,
    streams: [
      videoStream(),
      audioStream(),
      subtitleStream({ codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }),
      subtitleStream({ index: 3, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'fre' } }),
    ],
  });

/** …and one with text subtitles, which preparation carries rather than loses. */
export const mkvWithSrt = (): unknown =>
  report({ formatName: MKV, streams: [videoStream(), audioStream(), subtitleStream()] });

/**
 * *All Quiet On The Western Front*, in the shape that mattered: **41 text subtitle tracks**,
 * with duplicate languages, in the order the film lists them. `english` is how many of the
 * 41 are English, so the no-English case can be built from the same helper.
 */
export const mkvWithManySubtitles = (count = 41, english = 1, audioCodec = 'aac'): unknown => {
  const others = ['ger', 'ger', 'ger', 'spa', 'spa', 'spa', 'chi', 'por', 'tur', 'tur', 'fre'];
  const languages: string[] = [];
  for (let i = 0; i < count; i += 1) {
    languages.push(i < english ? 'eng' : (others[(i - english) % others.length] as string));
  }
  return report({
    formatName: MKV,
    streams: [
      videoStream(),
      audioStream({ codec_name: audioCodec }),
      ...languages.map((language, i) => subtitleStream({ index: 2 + i, tags: { language } })),
    ],
  });
};

/**
 * The real thing: *All Quiet On The Western Front* (2022), **41 `subrip` tracks**, in the
 * order and languages `ffprobe` actually reported them on 2026-08-21. Two are English and
 * nine of the rest (Basque, Galician, Filipino, Norwegian Bokmål …) are codes the notice has
 * no display name for — which is exactly the case that made "and N more languages" undercount.
 */
const AQOTWF_LANGUAGES: readonly string[] = [
  'ara',
  'baq',
  'cat',
  'chi',
  'chi',
  'cze',
  'dan',
  'dut',
  'eng',
  'eng',
  'fin',
  'fre',
  'ger',
  'ger',
  'ger',
  'glg',
  'gre',
  'heb',
  'hrv',
  'hun',
  'ind',
  'ita',
  'jpn',
  'kor',
  'may',
  'nob',
  'phi',
  'pol',
  'por',
  'por',
  'rum',
  'rus',
  'spa',
  'spa',
  'spa',
  'swe',
  'tha',
  'tur',
  'tur',
  'ukr',
  'vie',
];

/**
 * That real subtitle list on a film, for the 41-track notice — and **its sound is the
 * library's stereo default, not the 5.1 the real file carries** (D1). Nothing here reads
 * the channel count; the pairs below are where that is spelled out on purpose.
 */
export const mkvAllQuiet = (): unknown =>
  report({
    formatName: MKV,
    streams: [
      videoStream(),
      audioStream(),
      ...AQOTWF_LANGUAGES.map((language, i) =>
        subtitleStream({ index: 2 + i, tags: { language } }),
      ),
    ],
  });

// --- Defect D1: the same library, with the sound it actually has ------------
//
// Three fixtures, one per tier, identical to the three above **but for the channel count**.
// Pairing them that way is the point: the only difference between a film that plays and a
// film that dies in a quarter of a second is a number nothing in the product read until D1.

/** Tier 1's shape — MP4, H.264 High L4.1, AAC — carrying 5.1 sound. */
export const mp4H264Aac51 = (): unknown =>
  report({ streams: [videoStream(), surroundAudioStream()] });

/** Tier 2's shape — the same streams in the wrong box — carrying 5.1 sound. */
export const mkvH264Aac51 = (): unknown =>
  report({ formatName: MKV, streams: [videoStream(), surroundAudioStream()] });

/** Tier 3's shape — a picture the baseline cannot take — carrying 5.1 sound. */
export const mp4Hevc4k51 = (): unknown =>
  report({
    streams: [
      videoStream({
        codec_name: 'hevc',
        profile: 'Main 10',
        width: 3840,
        height: 2160,
        coded_width: 3840,
        coded_height: 2160,
        level: 153,
      }),
      surroundAudioStream(),
    ],
  });

/** 7.1, so "more channels than the limit" can be tested against a profile whose limit is 6. */
export const mp4H264Aac71 = (): unknown =>
  report({
    streams: [videoStream(), surroundAudioStream({ channels: 8, channel_layout: '7.1' })],
  });

/** A film whose audio channel count ffprobe declined to state. */
export const mp4H264AacUnmeasured = (): unknown =>
  report({ streams: [videoStream(), unmeasuredAudioStream()] });

/**
 * **Run 1's film**, as `ffprobe` described it on 2026-08-24 — the `mkvAllQuiet` pattern
 * (2026-08-21) applied to defect D1.
 *
 * `LEGO Marvel Avengers Mission Demolition 2024 1080p WEBRip x265-DH.mkv`, cast to the
 * **Master bedroom TV** (a plain `Chromecast`). CastGood converted the picture, copied the
 * sound, and the television played **one frame**: `PLAYING` at position 0 for 0.232 s, then
 * `IDLE` with `idleReason: ERROR`. `ffprobe` of the segment CastGood published said
 * `aac LC, 6 channels, 5.1` — the whole defect, in one line of somebody else's output.
 *
 * **What is recorded and what is reconstructed.** The fields the run recorded are the ones
 * the diagnosis rests on and they are exact: Matroska, HEVC **Main 10** at 1920x1080 and
 * 24 fps, **AAC LC, 6 channels, 5.1**, two English text subtitle tracks, 2412 s from our own
 * probe. The rest — bitrates, file size, the HEVC `level` — was not written down, and is
 * ordinary-looking for a 40-minute 1080p x265 WEBRip. Nothing the classifier decides for this
 * film depends on the reconstructed half; every field it reads is from the record.
 */
export const mkvLegoMarvel = (): unknown =>
  report({
    formatName: MKV,
    durationSec: 2_412,
    sizeBytes: 1_186_988_032,
    streams: [
      videoStream({
        codec_name: 'hevc',
        codec_long_name: 'H.265 / HEVC (High Efficiency Video Coding)',
        profile: 'Main 10',
        level: 120,
        r_frame_rate: '24/1',
        avg_frame_rate: '24/1',
        bit_rate: null,
        tags: { language: 'und', BPS: '3600000' },
      }),
      surroundAudioStream({ index: 1, bit_rate: null, tags: { language: 'eng', BPS: '384000' } }),
      subtitleStream({ index: 2, tags: { language: 'eng', title: 'English' } }),
      subtitleStream({ index: 3, tags: { language: 'eng', title: 'English SDH' } }),
    ],
  });

/** Artwork inside the film. The classifier must not mistake it for the picture. */
export const mp4WithCoverArt = (): unknown =>
  report({ streams: [videoStream(), audioStream(), coverArtStream()] });

/** A file with no video in it at all (7d). */
export const audioOnly = (): unknown =>
  report({
    formatName: 'mp3',
    streams: [audioStream({ index: 0, codec_name: 'mp3', profile: null })],
  });

/**
 * A part-downloaded film: ffprobe opens it, names the codec, and cannot say how big the
 * picture is or how long the film is, because the header stops before it gets there.
 */
export const truncatedHeader = (): unknown =>
  report({
    formatName: MKV,
    durationSec: null,
    streams: [
      videoStream({
        width: null,
        height: null,
        coded_width: null,
        coded_height: null,
        level: null,
        r_frame_rate: '0/0',
        avg_frame_rate: '0/0',
      }),
    ],
  });

/** What ffprobe prints for something that is not a media file at all. */
export const notMedia = (): unknown => ({ streams: [], format: {} });

/** The sibling we made last time: `Some Film (CastGood).mp4`, and Tier 1 by construction. */
export const preparedSibling = (durationSec = 6_990): unknown =>
  report({ durationSec, sizeBytes: 3_221_225_472 });

/**
 * A sibling made **before** defect D1 was fixed: the right film, the right box, the right
 * picture — and 5.1 sound a stereo-only receiver will refuse exactly as it refused the
 * source. Criterion 7l is about this file, and about not offering it as already prepared.
 */
export const preparedSibling51 = (durationSec = 6_990): unknown =>
  report({
    durationSec,
    sizeBytes: 3_221_225_472,
    streams: [videoStream(), surroundAudioStream()],
  });

// --- Scripted runners --------------------------------------------------------

/**
 * A scripted `FfprobeRunner`, so no test ever spawns a real binary.
 *
 * There is a Windows `ffprobe.exe` sitting in `resources/bin` of this working copy the
 * moment anyone runs `scripts/fetch-ffmpeg.mjs`, and `resolveFfmpeg()` finds it from the
 * repo root — which is exactly where vitest runs. An engine test that leaves `ffprobe`
 * undefined therefore behaves differently depending on whether a build artifact happens to
 * be on disk, which is the kind of instrument that has misled this project before. Every
 * engine test states its answer: a runner from here, or `ffprobe: null` for "this machine
 * has none".
 */
export function ffprobeYielding(json: unknown): FfprobeRunner {
  const probe = probeOf(json);
  return () => Promise.resolve({ ok: true, probe });
}

/** A probe that did not produce a result, and says which of the four ways it went wrong. */
export function ffprobeFailing(failure: ProbeFailure): FfprobeRunner {
  return () => Promise.resolve({ ok: false, failure });
}

/**
 * A probe that never answers until the check is cancelled — a drive that has gone to sleep.
 * Resolves as `cancelled` on abort so nothing is left pending at the end of a test.
 */
export function ffprobeHanging(): FfprobeRunner {
  return (_filePath, options) =>
    new Promise((resolve) => {
      const signal = options?.signal;
      if (signal === undefined) return;
      if (signal.aborted) {
        resolve({ ok: false, failure: 'cancelled' });
        return;
      }
      signal.addEventListener('abort', () => {
        resolve({ ok: false, failure: 'cancelled' });
      });
    });
}
