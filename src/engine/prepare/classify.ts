import { PREPARATION } from '../config.js';
import type { Container, DeviceProfile, ProfileId, Tier, VideoCapability } from '../types.js';
import {
  audioCodecOf,
  audioStreams,
  primaryVideoStream,
  subtitleStreams,
  videoCodecOf,
  type ProbeResult,
  type ProbeStream,
  type SubtitleForm,
} from '../media/ffprobe.js';

/**
 * The classifier: `(probe, deviceProfile) -> verdict`. **Pure** — no I/O, no clock, no
 * device, no file path.
 *
 * That purity is not tidiness. It is what lets the decision the founder's whole experience
 * of "can I watch this?" rests on be exercised exhaustively in WSL, on fixtures, against a
 * television nobody has to own — including the awkward files (no video, a truncated header,
 * picture-only subtitles, 4K on a device that cannot take it) that are exactly the ones a
 * real evening produces and a happy-path test never does.
 *
 *   Tier 1 · *Ready to cast* — cast the source untouched.
 *   Tier 2 · *Ready in about \<time\>* — the streams are fine, only the packaging is wrong:
 *            a lossless `-c copy` repackage into MP4.
 *   Tier 3 · *Needs converting — about \<time\>* — a stream genuinely mismatches: convert
 *            only that stream, copy the rest.
 *   *This file can't be cast, \<one-line reason\>* — decided here, before the founder
 *            commits to anything, and never mid-cast (7d).
 *
 * **Nothing in the verdict's founder-facing strings may name a codec, a profile, a level, a
 * resolution or a file path** (7a). Those live in `detail`, which goes to the JSONL log and
 * never to the screen. `test/engine/m3-classifier.test.ts` fails the build if a codec name
 * ever appears in a sentence.
 *
 * M3a's only output shape is a single progressive MP4 beside the source
 * (`docs/ARCHITECTURE.md`: "no HLS anywhere in M3a"), so every plan here targets MP4. The
 * growing-playlist serving shape is M3b and is a property of how an artifact is *served*,
 * not of what the file needs.
 */

// --- The verdict -------------------------------------------------------------

/** Exactly the four verdicts of criterion 7a, one value each. */
export type VerdictKind = 'ready' | 'remux' | 'convert' | 'impossible';

export type ImpossibleReason = 'no-video' | 'damaged';

/**
 * A text subtitle stream to carry out of the source, and what to call the file.
 *
 * **Extracted beside the artifact as WebVTT, never muxed into the MP4** — and both halves of
 * that are load-bearing. `docs/ARCHITECTURE.md` §4 and the 2026-08-19 subtitles ADR: the
 * Default Media Receiver renders only WebVTT, TTML and CEA-608, and **never `mov_text`
 * inside the MP4**, so a track muxed in would satisfy 8e's letter — the words are still in
 * the file — while being unreadable by every television in the house. And `-c copy` on a
 * subtitle stream from Matroska **fails the job outright**, so a subtitle codec must not be
 * able to decide whether a film plays.
 *
 * So extraction is not extra work: WebVTT alongside the file is the only form in which a
 * subtitle can reach a Chromecast at all, which makes it the only form in which preserving
 * one means anything.
 */
export interface SubtitleTrack {
  /** The stream index in the **source**, which is what ffmpeg is pointed at. */
  readonly index: number;
  /** ISO code as ffprobe reports it (`eng`), or `null` when the file does not say. */
  readonly language: string | null;
}

export type PreparationPlan =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'remux';
      readonly container: 'mp4';
      readonly subtitleTracks: readonly SubtitleTrack[];
    }
  | {
      readonly kind: 'transcode';
      readonly container: 'mp4';
      readonly video: 'copy' | 'h264';
      readonly audio: 'copy' | 'aac';
      readonly subtitleTracks: readonly SubtitleTrack[];
    };

/** Evidence for the log. **Never rendered.** */
export interface VerdictDetail {
  readonly profileId: ProfileId;
  readonly container: Container | 'other';
  readonly durationSec: number | null;
  readonly sizeBytes: number | null;
  readonly video: {
    readonly codec: string;
    readonly profile: string | null;
    readonly level: number | null;
    readonly width: number | null;
    readonly height: number | null;
    readonly frameRate: number | null;
    readonly supported: boolean;
    /** Which axis or axes put it outside the profile: `codec`, `profile`, `level`, `size`, `framerate`. */
    readonly failed: readonly string[];
  } | null;
  readonly audio: readonly {
    readonly index: number;
    readonly codec: string;
    /**
     * How many channels the track carries, and the field the log wanted on 2026-08-24.
     *
     * The night the defect surfaced, the only way to learn that the sound was 5.1 was to
     * probe the published segment by hand. `null` is ffprobe declining to say — which
     * `audioSupported` treats as too many, so a `null` beside `supported: false` is the
     * whole explanation of a conversion nobody expected.
     */
    readonly channels: number | null;
    readonly supported: boolean;
  }[];
  readonly subtitles: readonly {
    readonly index: number;
    readonly form: SubtitleForm;
    readonly language: string | null;
  }[];
  readonly reasonCode: ImpossibleReason | null;
}

export interface Verdict {
  readonly kind: VerdictKind;
  /** `null` for a file that cannot be cast at all. */
  readonly tier: Tier | null;
  readonly plan: PreparationPlan;
  readonly estimateSeconds: number | null;
  /**
   * Roughly what preparation will write, in bytes. `0` when nothing will be written.
   *
   * Two jobs: the sentence 7f owes the founder ("how much disk the job will use") and the
   * input to the pre-flight disk check (estimate + 15%). A **stream copy is the same
   * streams**, so a remux is the source's size and that number is close to exact; a
   * conversion is estimated at the source's size too, which is deliberately the
   * conservative direction — the encoder table that would let us do better is M3a's
   * preparation step, and a disk estimate that reads low is the one that fails at 80%.
   */
  readonly estimatedBytes: number;
  /** The one sentence the founder reads. Final wording. */
  readonly headline: string;
  /** One plain line under it, when there is something to add. Final wording, or `null`. */
  readonly reason: string | null;
  /**
   * 8e: what preparation would throw away, said **before** the founder commits.
   * `null` — the common case — means nothing would be lost, and nothing is said.
   */
  readonly subtitleNotice: string | null;
  /** 7f: over `LONG_PREP`, the primary button ends in an ellipsis and a confirmation follows. */
  readonly requiresConfirmation: boolean;
  readonly detail: VerdictDetail;
}

/**
 * How fast this machine prepares, in the units the estimate needs.
 *
 * Seeded from `config.ts` and **replaced by measurement** once a job has run on the
 * founder's own PC — criterion 8b's honesty clause says the number shown is the honest one,
 * and a seed is only honest until there is a measurement. Passing it in keeps the estimate
 * a pure function of (file, machine) rather than a hidden global.
 */
export interface ThroughputEstimate {
  /** Bytes per second for a stream copy, including the `+faststart` second pass. */
  readonly remuxBytesPerSecond: number;
  /** Output seconds of video per wall-clock second when only the sound is re-encoded. */
  readonly audioConvertSpeed: number;
  /**
   * …and when the **picture** is re-encoded, in **megapixels of output per second** rather
   * than as a multiple of real time.
   *
   * The unit is the finding, not the number. See `estimateTranscodeSeconds` and the
   * 2026-08-20 ADR: encode time tracks pixels, so a multiple of real time is a different
   * answer for every resolution and cannot be one seed.
   */
  readonly videoMegapixelsPerSecond: number;
}

export interface ClassifyOptions {
  /**
   * This probe is of a prepared sibling we already made, not of the founder's source (7c).
   * Only changes what is said — "already prepared" instead of nothing — never the tier.
   */
  readonly alreadyPrepared?: boolean;
  readonly throughput?: ThroughputEstimate;
}

// --- What MP4 can carry ------------------------------------------------------

/**
 * Codecs we are willing to put inside the one container M3a produces.
 *
 * Narrower than the specification allows on purpose: VP9 and Opus are legal in MP4 and
 * poorly handled by the Default Media Receiver, so a file holding them is converted rather
 * than repackaged into a shape that would load and then fail on a television.
 */
const MP4_VIDEO: readonly string[] = ['h264', 'hevc', 'av1'];
const MP4_AUDIO: readonly string[] = ['aac', 'mp3', 'ac3', 'eac3'];

// --- Matching a stream against a profile -------------------------------------

const PROFILE_RANK: Readonly<Record<string, number>> = {
  'constrained baseline': 0,
  baseline: 1,
  main: 2,
  high: 3,
  'high 10': 4,
  'high 10 intra': 4,
  'high 4:2:2': 5,
  'high 4:4:4': 6,
  'high 4:4:4 predictive': 6,
  'main 10': 4,
  'main still picture': 2,
};

/** Frame rates are reported as 23.976 and 59.94; a whole-number cap must not reject them. */
const FRAMERATE_SLACK = 0.5;

function profileWithin(streamProfile: string | null, cap: string | undefined): boolean {
  if (cap === undefined) return true;
  const allowed = PROFILE_RANK[cap.toLowerCase()];
  if (allowed === undefined) return true;
  if (streamProfile === null) return false; // A profile we cannot read is not a profile we can vouch for.
  const rank = PROFILE_RANK[streamProfile.toLowerCase()];
  if (rank === undefined) return false; // Nor is one we have never heard of.
  return rank <= allowed;
}

/** Which axes of this capability the stream exceeds. Empty means it fits. */
function videoMisfits(stream: ProbeStream, capability: VideoCapability): string[] {
  const failed: string[] = [];
  if (!profileWithin(stream.profile, capability.maxProfile)) failed.push('profile');
  if (
    capability.maxLevel !== undefined &&
    stream.level !== null &&
    // Only H.264 states its level as level × 10; other codecs scale it differently and are
    // bounded by size and frame rate instead of by a number we would be guessing at.
    videoCodecOf(stream) === 'h264' &&
    stream.level > capability.maxLevel
  ) {
    failed.push('level');
  }
  const width = stream.width;
  const height = stream.height;
  if (width !== null && height !== null) {
    // Orientation is not a capability: a 1080×1920 portrait clip is the same pixels as
    // 1920×1080 and every device that plays one plays the other.
    const long = Math.max(width, height);
    const short = Math.min(width, height);
    if (long > Math.max(capability.maxWidth, capability.maxHeight)) failed.push('size');
    else if (short > Math.min(capability.maxWidth, capability.maxHeight)) failed.push('size');
  }
  if (stream.frameRate !== null && stream.frameRate > capability.maxFramerate + FRAMERATE_SLACK) {
    failed.push('framerate');
  }
  return failed;
}

interface VideoMatch {
  readonly supported: boolean;
  readonly failed: readonly string[];
}

function matchVideo(stream: ProbeStream, profile: DeviceProfile): VideoMatch {
  const codec = videoCodecOf(stream);
  const capabilities = codec === null ? [] : profile.video.filter((v) => v.codec === codec);
  if (capabilities.length === 0) return { supported: false, failed: ['codec'] };
  let best: string[] | null = null;
  for (const capability of capabilities) {
    const failed = videoMisfits(stream, capability);
    if (failed.length === 0) return { supported: true, failed: [] };
    if (best === null || failed.length < best.length) best = failed;
  }
  return { supported: false, failed: best ?? ['codec'] };
}

/**
 * Can this television play this sound track as it stands?
 *
 * **Two questions, and for the whole of M3a only the first was asked.** The codec name is
 * the obvious one. The channel count is the one that cost a film on 2026-08-24: a plain
 * Chromecast was handed 6-channel AAC — a codec its profile does list — played one frame,
 * and reported `IDLE`/`ERROR` 0.232 s later. `DeviceProfile.audio` describes formats, and a
 * receiver that decodes stereo AAC does not thereby decode 5.1 AAC. `ffprobe` has recorded
 * `channels` since M1 and nothing read it until defect D1.
 *
 * The count is checked **whatever the codec** (criterion 7i). Failing here is not a refusal:
 * it makes the sound non-carryable, and the classifier's own Tier 3 branch then plans
 * `BASELINE_OUTPUT.audioArgs` — `-c:a aac -b:a 192k -ac 2`, the downmix that file's comment
 * has described since it was written. The picture is untouched by any of this.
 *
 * **This is the only place in the product that reads a channel count.** `ffmpeg-job.ts`
 * emits what the plan says and second-guesses nothing; a channel special case there would be
 * a second source of truth about one decision, which 7i fails a build for.
 *
 * ## `channels: null` — a measurement we do not have
 *
 * Treated as **too many**, so the sound is converted. ffprobe leaves the field out for a
 * stream it opened but could not fully describe, and the two ways of being wrong are not
 * the same size — but **the cost of this direction is minutes and gigabytes, not seconds**,
 * and an earlier version of this comment said seconds by quoting a 22-minute clip. Measured
 * on the shipping seeds, a feature-length film whose channel count ffprobe will not state
 * is announced to the founder as ***"Needs converting — about 6 minutes"*** and writes a
 * **full-size duplicate beside the original** — several gigabytes, because a picture stream
 * copy is the same picture. That is the price of this ruling and it is still the right one:
 * the other way costs a black screen 0.232 s into a film they waited for, and a wait they
 * were told about beats a failure they were not. It is also the instinct the rest of this
 * project already runs on: a selftest assertion with a null measurement **fails**, it does
 * not shrug. (Not every unknown goes this way, and the asymmetry is the reason: `freeBytesOn`
 * returning `null` lets a job proceed, because there the unknown would block work that would
 * almost certainly have succeeded. Here the unknown would *admit* a file that probably will
 * not play.)
 */
function audioSupported(stream: ProbeStream, profile: DeviceProfile): boolean {
  const codec = audioCodecOf(stream);
  if (codec === null || !profile.audio.includes(codec)) return false;
  return stream.channels !== null && stream.channels <= profile.maxAudioChannels;
}

// --- Estimates ---------------------------------------------------------------

/**
 * How big is this file, when the container did not say?
 *
 * `format.size` is normally there, but a stream, a pipe or an unusual container can leave
 * it out — and a remux estimate of "a few seconds" for a 4 GB film because one field was
 * missing is exactly the flattering number criterion 8b forbids. Bitrate × duration is the
 * same file measured another way.
 */
function estimateBytes(probe: ProbeResult): number {
  if (probe.sizeBytes !== null) return probe.sizeBytes;
  if (probe.bitrate !== null && probe.durationSec !== null) {
    return (probe.bitrate / 8) * probe.durationSec;
  }
  return 0;
}

/**
 * Codecs that fit more film into fewer bits than H.264 does.
 *
 * Re-encoding one of these **to** H.264 makes the file bigger, not smaller, and that is the
 * whole reason this list exists.
 */
const MORE_EFFICIENT_THAN_H264: readonly string[] = ['hevc', 'av1', 'vp9'];

/**
 * How much bigger the H.264 output is than a source in one of those codecs.
 *
 * **Measured, once, on the founder's own film** (2026-08-20): a 1.78 GB HEVC film came out
 * as a 3.43 GB H.264 one at our settings — a factor of **1.93**. Rounded to 2 and used as a
 * floor rather than a fit, because one measurement is one measurement and P1's whole job is
 * to refuse honestly *before* any work begins.
 */
const H264_SIZE_FACTOR = 2;

/**
 * Roughly what a job will write.
 *
 * A **stream copy is the same streams**, so a remux is the source's size and that number is
 * close to exact. A **conversion is not**: `classify.ts` used to estimate one at the source's
 * size too and called that "the conservative direction", which is true converting *from*
 * H.264 and exactly backwards converting *to* it. On 2026-08-20 the pre-flight check told
 * the founder a job needed 1.78 GB and ffmpeg wrote 3.43 GB. There were two terabytes free
 * so nothing came of it — on a fuller drive it is P1 passing and P2 firing at 80%, which is
 * the failure P1 exists to prevent.
 */
function estimateOutputBytes(probe: ProbeResult, reEncodingVideo: boolean): number {
  const bytes = estimateBytes(probe);
  if (!reEncodingVideo) return bytes;
  const codec = videoCodecOf(primaryVideoStream(probe) ?? ({} as ProbeStream));
  return MORE_EFFICIENT_THAN_H264.includes(codec ?? '') ? bytes * H264_SIZE_FACTOR : bytes;
}

function estimateRemuxSeconds(probe: ProbeResult, throughput: ThroughputEstimate): number {
  const seconds = estimateBytes(probe) / Math.max(1, throughput.remuxBytesPerSecond);
  return Math.max(PREPARATION.minimumEstimateSeconds, seconds);
}

/**
 * A frame rate to reckon with when the container will not say.
 *
 * Only reachable for a file whose header is partly unreadable, and 25 is the middle of the
 * range films actually come in — a wrong guess here moves an estimate, it does not break a
 * cast.
 */
const ASSUMED_FRAME_RATE = 25;

/**
 * How long a conversion takes, and **the two tiers are measured in different units**.
 *
 * SPIKE-4 (2026-08-20) settled this on the founder's own PC. Re-encoding the **picture** is
 * bound by pixels, not by the length of the film: `libx264 -preset veryfast` managed
 * **24.3× real time** on a 1280×528 film and **7.96×** on a 1080p one — three times apart —
 * while both runs sat within 5% of each other at ~400 megapixels per second. So a
 * duration-based number was not just badly calibrated, it was **blind to resolution**, and
 * would have quoted a 4K film and a 480p film the same wait.
 *
 * Re-encoding only the **sound** leaves the picture a stream copy, and audio encoding really
 * is bound by the length of the film. That one stays a multiple of real time.
 */
function estimateTranscodeSeconds(
  probe: ProbeResult,
  reEncodingVideo: boolean,
  throughput: ThroughputEstimate,
): number {
  const duration =
    probe.durationSec ??
    // No duration in the headers: fall back to size at the seeded remux rate, which is the
    // only other thing we know about the file. An estimate from one honest number beats no
    // estimate at all, and it is replaced by ffmpeg's own `speed=` within 30 s of starting.
    estimateBytes(probe) / Math.max(1, throughput.remuxBytesPerSecond);

  if (!reEncodingVideo) {
    return Math.max(
      PREPARATION.minimumEstimateSeconds,
      duration / Math.max(0.01, throughput.audioConvertSpeed),
    );
  }

  const video = primaryVideoStream(probe);
  const width = video?.width ?? null;
  const height = video?.height ?? null;
  if (width === null || height === null) {
    // Unreachable through `classify`, which refuses a file whose picture has no stated size
    // as damaged before any estimate is asked for. Kept because this function is exported
    // arithmetic and an estimate of `Infinity` on the way to a screen would be worse than a
    // conservative guess: fall back to the old shape at a rate the measurements support.
    return Math.max(PREPARATION.minimumEstimateSeconds, duration / 8);
  }
  const megapixels = (width * height * (video?.frameRate ?? ASSUMED_FRAME_RATE) * duration) / 1e6;
  return Math.max(
    PREPARATION.minimumEstimateSeconds,
    megapixels / Math.max(0.01, throughput.videoMegapixelsPerSecond),
  );
}

// --- Founder-facing wording --------------------------------------------------

/**
 * "about 20 seconds", "about 6 minutes", "about 1 hour 10 minutes".
 *
 * Rounded to something a person would say. A wait stated to the second reads as a promise
 * nothing can keep; a wait rounded up reads as honesty.
 */
export function describeApproxSeconds(seconds: number): string {
  const total = Math.max(1, Math.round(seconds));
  if (total < 10) return 'a few seconds';
  if (total < 60) return `${String(Math.round(total / 5) * 5)} seconds`;
  if (total < 90) return 'a minute';
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  const hourWord = `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  if (rest === 0) return hourWord;
  if (rest === 60) return `${String(hours + 1)} hours`;
  return `${hourWord} ${String(rest)} minutes`;
}

/**
 * "about 700 MB", "about 4.2 GB". Rounded the way a person reads a disk, never to the byte.
 *
 * Decimal GB rather than GiB, because that is what Windows Explorer and every "you need
 * this much free space" sentence the founder has ever read means by the word.
 */
export function describeApproxBytes(bytes: number): string {
  const value = Math.max(0, bytes);
  if (value < 1_000_000) return 'less than a megabyte';
  if (value < 1_000_000_000) return `about ${String(Math.round(value / 1_000_000))} MB`;
  const gb = value / 1_000_000_000;
  return `about ${gb < 10 ? gb.toFixed(1) : String(Math.round(gb))} GB`;
}

/**
 * The three things criterion 7f says the confirmation must state, as final sentences.
 *
 * The wording is here rather than in the renderer for the reason every other verdict string
 * is: the engine holds the numbers, and a screen that formats its own would be a second
 * place for the estimate to be rounded differently. `null` for any verdict that never
 * reaches a confirmation — nothing to confirm, nothing to say.
 *
 * **M3a wording, deliberately.** "Watching can start when it is ready" is true of half A,
 * where preparation runs to completion before anything is cast. M3b's head start makes
 * watching start *sooner* than the job finishes, and this sentence is one of the things
 * that changes when it does.
 */
export interface VerdictConfirmation {
  /** When watching can start. */
  readonly startsWatching: string;
  /** How much disk the job will use. */
  readonly diskUse: string;
  /** That cancelling means starting again. */
  readonly cancelWarning: string;
}

export function confirmationFor(verdict: Verdict): VerdictConfirmation | null {
  if (verdict.estimateSeconds === null || verdict.plan.kind === 'none') return null;
  return {
    startsWatching: `Watching can start in about ${describeApproxSeconds(verdict.estimateSeconds)}.`,
    diskUse: `It will write ${describeApproxBytes(verdict.estimatedBytes)} next to the original file.`,
    cancelWarning: 'If you cancel part-way, it starts again from the beginning next time.',
  };
}

/** Enough languages to name the common cases; anything else is simply not named. */
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
  swe: 'Swedish',
  nor: 'Norwegian',
  dan: 'Danish',
  fin: 'Finnish',
  pol: 'Polish',
  rus: 'Russian',
  ru: 'Russian',
  jpn: 'Japanese',
  ja: 'Japanese',
  kor: 'Korean',
  ko: 'Korean',
  chi: 'Chinese',
  zho: 'Chinese',
  zh: 'Chinese',
  ara: 'Arabic',
  hin: 'Hindi',
  tur: 'Turkish',
  cze: 'Czech',
  ces: 'Czech',
  gre: 'Greek',
  ell: 'Greek',
  heb: 'Hebrew',
  tha: 'Thai',
  vie: 'Vietnamese',
  hun: 'Hungarian',
  rum: 'Romanian',
  ron: 'Romanian',
};

function languageName(code: string | null): string | null {
  if (code === null) return null;
  return LANGUAGE_NAMES[code.toLowerCase()] ?? null;
}

function joinWords(words: readonly string[]): string {
  if (words.length <= 1) return words[0] ?? '';
  return `${words.slice(0, -1).join(', ')} and ${String(words[words.length - 1])}`;
}

/**
 * `eng`, `en`, and the `en-GB` a few muxers write. Anything else is another language.
 */
function isEnglish(code: string | null): boolean {
  if (code === null) return false;
  const lower = code.toLowerCase();
  return lower === 'eng' || lower === 'en' || lower.startsWith('en-');
}

/**
 * Which text tracks are carried out beside the artifact, once a film has absurdly many.
 *
 * Founder decision, 2026-08-21: **above `subtitleTrackCap` text tracks, keep English only.**
 * Every carried track becomes a `.vtt` in the founder's own film folder, and 41 of them
 * beside one film is mess rather than preservation.
 *
 * Two things stop this being a silent loss. The cap is **disclosed in the verdict before
 * the founder commits**, which is the branch 8e always allowed. And the dropped tracks are
 * not destroyed — they are still in the source file, which 18f says is where M3c reads
 * subtitles from anyway, so every one of those 41 languages stays selectable at watch time.
 *
 * A film over the cap with **no English track at all** keeps the first track the film
 * lists, not zero: question 17 takes the file's own order as the order the founder sees,
 * and a total silent loss is the one outcome 8e exists to forbid.
 */
function selectTextTracks(text: readonly ProbeStream[]): {
  readonly kept: readonly ProbeStream[];
  readonly dropped: readonly ProbeStream[];
} {
  if (text.length <= PREPARATION.subtitleTrackCap) return { kept: text, dropped: [] };
  const english = text.filter((stream) => isEnglish(stream.language));
  const kept = english.length > 0 ? english : text.slice(0, 1);
  const keptIndexes = new Set(kept.map((stream) => stream.index));
  return { kept, dropped: text.filter((stream) => !keptIndexes.has(stream.index)) };
}

/**
 * 8e's sentence, and only when there is something to say.
 *
 * Picture-based tracks (the PGS and VobSub common in downloaded remuxes) are the only thing
 * preparation *cannot* carry: text tracks are extracted beside the artifact as WebVTT,
 * which is the only form a Chromecast can show anyway. No codec name appears, per 7a —
 * "pictures rather than text" is the whole of the explanation a person needs.
 */
function lostToPicturesNotice(subtitles: readonly ProbeStream[]): string | null {
  const lost = subtitles.filter((stream) => stream.subtitleForm === 'image');
  if (lost.length === 0) return null;
  const named = lost
    .map((stream) => languageName(stream.language))
    .filter((n): n is string => n !== null);
  const count = lost.length === 1 ? 'One subtitle track' : `${String(lost.length)} subtitle tracks`;
  const languages = named.length === lost.length ? ` (${joinWords(named)})` : '';
  const verb = lost.length === 1 ? 'is' : 'are';
  const carried = lost.length === 1 ? "it can't" : "they can't";
  return `${count}${languages} ${verb} pictures rather than text, so ${carried} be carried into the prepared copy.`;
}

/**
 * 8e's other sentence: the tracks preparation *chooses* not to carry, and where they went.
 *
 * Three languages are named and the rest counted — naming all 38 would be a paragraph on a
 * screen that 7a keeps to plain sentences. The closing clause is the load-bearing half:
 * nothing was destroyed, so this reads as a tidy folder rather than a loss.
 */
function cappedNotice(
  kept: readonly ProbeStream[],
  dropped: readonly ProbeStream[],
): string | null {
  if (dropped.length === 0) return null;
  const total = kept.length + dropped.length;
  // Named languages are what we can *show*; distinct codes are what we must *count*. The
  // real 41-track film carries Basque, Galician and Filipino among others, and counting only
  // the ones `LANGUAGE_NAMES` knows would understate "and N more" by nine languages.
  const codes = new Set(
    dropped.map((stream) => stream.language?.toLowerCase()).filter((c): c is string => c != null),
  );
  const shown = [
    ...new Set(
      dropped.map((stream) => languageName(stream.language)).filter((n): n is string => n !== null),
    ),
  ].slice(0, 3);
  const rest = codes.size - shown.length;
  const languages =
    shown.length === 0
      ? ''
      : ` (${joinWords(rest > 0 ? [...shown, `${String(rest)} more languages`] : shown)})`;
  const keeping = isEnglish(kept[0]?.language ?? null)
    ? kept.length === 1
      ? 'only the English one will be kept'
      : `only the ${String(kept.length)} English ones will be kept`
    : 'only the first will be kept';
  return `This film has ${String(total)} subtitle tracks, so ${keeping} beside the prepared copy — the other ${String(dropped.length)}${languages} stay in the original file.`;
}

function subtitleNoticeFor(
  subtitles: readonly ProbeStream[],
  kept: readonly ProbeStream[],
  dropped: readonly ProbeStream[],
): string | null {
  const sentences = [lostToPicturesNotice(subtitles), cappedNotice(kept, dropped)].filter(
    (s): s is string => s !== null,
  );
  return sentences.length === 0 ? null : sentences.join(' ');
}

// --- The classifier ----------------------------------------------------------

function impossible(
  reason: ImpossibleReason,
  sentence: string,
  detail: Omit<VerdictDetail, 'reasonCode'>,
): Verdict {
  return {
    kind: 'impossible',
    tier: null,
    plan: { kind: 'none' },
    estimateSeconds: null,
    estimatedBytes: 0,
    headline: "This file can't be cast",
    reason: sentence,
    subtitleNotice: null,
    requiresConfirmation: false,
    detail: { ...detail, reasonCode: reason },
  };
}

export function classify(
  probe: ProbeResult,
  profile: DeviceProfile,
  options: ClassifyOptions = {},
): Verdict {
  const throughput = options.throughput ?? PREPARATION.throughput;
  const video = primaryVideoStream(probe);
  const audio = audioStreams(probe);
  const subtitles = subtitleStreams(probe);

  const videoMatch = video === null ? null : matchVideo(video, profile);
  const audioMatches = audio.map((stream) => ({
    index: stream.index,
    codec: stream.codec,
    channels: stream.channels,
    supported: audioSupported(stream, profile),
  }));

  const detail: Omit<VerdictDetail, 'reasonCode'> = {
    profileId: profile.id,
    container: probe.container,
    durationSec: probe.durationSec,
    sizeBytes: probe.sizeBytes,
    video:
      video === null || videoMatch === null
        ? null
        : {
            codec: video.codec,
            profile: video.profile,
            level: video.level,
            width: video.width,
            height: video.height,
            frameRate: video.frameRate,
            supported: videoMatch.supported,
            failed: videoMatch.failed,
          },
    audio: audioMatches,
    subtitles: subtitles.map((stream) => ({
      index: stream.index,
      form: stream.subtitleForm ?? 'image',
      language: stream.language,
    })),
  };

  // --- The three ways a file is refused, all decided here and never mid-cast (7d).
  if (probe.streams.length === 0) {
    return impossible('damaged', 'There is nothing readable in this file.', detail);
  }
  if (video === null || videoMatch === null) {
    return impossible('no-video', "There's no video in this file.", detail);
  }
  if (video.width === null || video.height === null) {
    // A picture whose size the container will not state is a header that stops before it
    // gets there — a part-downloaded or truncated file. Nothing can decode it and nothing
    // should try.
    return impossible('damaged', 'This file looks damaged or unfinished.', detail);
  }

  const containerOk = probe.container !== 'other' && profile.containers.includes(probe.container);
  const videoOk = videoMatch.supported;
  const audioOk = audioMatches.every((match) => match.supported);

  const { kept: keptText, dropped: droppedText } = selectTextTracks(
    subtitles.filter((stream) => stream.subtitleForm === 'text'),
  );
  const subtitleTracks: SubtitleTrack[] = keptText.map((stream) => ({
    index: stream.index,
    language: stream.language,
  }));

  // Tier 1 — nothing to do.
  if (containerOk && videoOk && audioOk) {
    return {
      kind: 'ready',
      tier: 1,
      plan: { kind: 'none' },
      estimateSeconds: 0,
      estimatedBytes: 0,
      headline: 'Ready to cast',
      reason:
        options.alreadyPrepared === true
          ? 'It was prepared last time, so there is nothing to wait for.'
          : null,
      subtitleNotice: null,
      requiresConfirmation: false,
      detail: { ...detail, reasonCode: null },
    };
  }

  const videoCarryable = videoOk && MP4_VIDEO.includes(videoCodecOf(video) ?? '');
  const audioCarryable = audio.every(
    (stream) => audioSupported(stream, profile) && MP4_AUDIO.includes(audioCodecOf(stream) ?? ''),
  );

  // Tier 2 — the packaging is the only thing wrong: a lossless repackage into MP4.
  if (videoCarryable && audioCarryable) {
    const estimate = estimateRemuxSeconds(probe, throughput);
    return {
      kind: 'remux',
      tier: 2,
      plan: { kind: 'remux', container: 'mp4', subtitleTracks },
      estimateSeconds: estimate,
      estimatedBytes: estimateOutputBytes(probe, false),
      headline: `Ready in about ${describeApproxSeconds(estimate)}`,
      reason: 'Nothing is re-encoded, so the picture and sound are untouched.',
      subtitleNotice: subtitleNoticeFor(subtitles, keptText, droppedText),
      requiresConfirmation: estimate > PREPARATION.longPrepSeconds,
      detail: { ...detail, reasonCode: null },
    };
  }

  // Tier 3 — convert only what mismatches, copy the rest.
  const reEncodeVideo = !videoCarryable;
  const estimate = estimateTranscodeSeconds(probe, reEncodeVideo, throughput);
  return {
    kind: 'convert',
    tier: 3,
    plan: {
      kind: 'transcode',
      container: 'mp4',
      video: reEncodeVideo ? 'h264' : 'copy',
      audio: audioCarryable ? 'copy' : 'aac',
      subtitleTracks,
    },
    estimateSeconds: estimate,
    estimatedBytes: estimateOutputBytes(probe, reEncodeVideo),
    headline: `Needs converting — about ${describeApproxSeconds(estimate)}`,
    reason: reEncodeVideo
      ? 'The picture has to be converted before this television can play it.'
      : 'Only the sound has to be converted; the picture is copied across untouched.',
    subtitleNotice: subtitleNoticeFor(subtitles, keptText, droppedText),
    requiresConfirmation: estimate > PREPARATION.longPrepSeconds,
    detail: { ...detail, reasonCode: null },
  };
}

/**
 * Is this prepared sibling the film, and can this television play it untouched?
 *
 * The 2026-08-19 ADR's whole answer to "is a prepared file reusable?": discover it by name,
 * believe it only after probing. Two questions, both answered from the artifact itself —
 * the duration says it is the same film rather than a trailer, a different cut or another
 * language, and Tier 1 *is* the profile key, derived rather than remembered.
 */
export function isReusableArtifact(
  source: ProbeResult,
  artifact: ProbeResult,
  profile: DeviceProfile,
): boolean {
  const sourceDuration = source.durationSec;
  const artifactDuration = artifact.durationSec;
  if (sourceDuration === null || artifactDuration === null) return false;
  if (Math.abs(sourceDuration - artifactDuration) > PREPARATION.artifactDurationToleranceSec) {
    return false;
  }
  return classify(artifact, profile).kind === 'ready';
}
