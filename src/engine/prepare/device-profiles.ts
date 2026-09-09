import type {
  AudioCodec,
  Container,
  DeviceProfile,
  ProfileId,
  VideoCapability,
  VideoCodec,
} from '../types.js';
import {
  audioCodecFor,
  videoCodecFor,
  type ProbeResult,
  type ProbeStream,
} from '../media/ffprobe.js';
import { classify } from './classify.js';

/**
 * What can this television actually play?
 *
 * The Cast sender API has no way to ask, so the answer is **inferred, in three layers,
 * most specific wins** (ADR 2026-08-13):
 *
 *  1. **A conservative baseline** assumed safe for every Cast device that exists, including
 *     third-party "Chromecast built-in" sets we have never met — H.264 High ≤ L4.1, ≤ 1080p30,
 *     in MP4, with AAC or MP3 audio. An unknown `md=` gets exactly this and nothing more.
 *  2. **A model table keyed on the mDNS `md=` string**, widening the profile for devices we
 *     know — data, not code, extended one line at a time as devices are met.
 *  3. **Observed truth**: a device that refuses a progressive-MP4 load has its profile
 *     *permanently narrowed* by the fact, and the next plan is a repackage or a conversion
 *     rather than an error (criterion 7e).
 *
 * Layer 3 only ever narrows and layer 2 only ever widens, so composing them is
 * `narrow(widen(baseline))` and the order is not a matter of taste.
 *
 * Everything here is pure. Where the layer-3 record is *kept* is the store's business
 * (`docs/ARCHITECTURE.md`: `devices.json`, `observedFailures[]`); this module says what the
 * record contains and what it means.
 */

// --- Layer 1: the conservative baseline --------------------------------------

/**
 * The floor, and the profile every unfamiliar television gets.
 *
 * Note the container list: **MP4 only**. The Default Media Receiver does not play Matroska
 * at all, and WebM is a widening we only grant devices we recognise — so an MKV is always a
 * repackage, which is the common Tier 2 case the PRD names.
 */
export const BASELINE_PROFILE: DeviceProfile = {
  id: 'baseline',
  video: [
    {
      codec: 'h264',
      maxProfile: 'high',
      maxLevel: 41,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFramerate: 30,
    },
  ],
  audio: ['aac', 'mp3'],
  containers: ['mp4'],
  // **Stereo, and the founder was told plainly what it costs** (2026-08-24). The table's
  // stated philosophy is that the unrecognised device gets the most conservative answer and
  // *"the worst that costs is one lossless remux"*; the audio equivalent is one downmix,
  // `-c:v copy -c:a aac -ac 2` — and on a **feature-length** film that is *"Needs
  // converting — about 6 minutes"* on screen and a full-size duplicate on the disk, not the
  // seconds a 22-minute clip suggests. Weighed against a film that dies in a quarter of a
  // second it is still not a close call.
  //
  // The founder's main television — `md=AI PONT` — **used to land here**, and checklist
  // item 8b is what took it off the floor: measured, it decodes 5.1, so it has an entry of
  // its own below. Nothing about that widens the floor. It is the *only* device in this
  // house measured to manage multichannel, and the two Google-made sets that were assumed
  // to manage it both died on the same file — so the conservative answer for a television
  // nobody has met is more clearly right after 8b than it was before it.
  maxAudioChannels: 2,
};

// --- Layer 2: the model table (data, not code) -------------------------------

export interface ModelProfileEntry {
  /** mDNS `md=` strings this entry claims, compared lower-cased and trimmed. */
  readonly models: readonly string[];
  readonly profile: DeviceProfile;
}

const CHROMECAST_GEN_ANY: DeviceProfile = {
  id: 'chromecast',
  video: [
    {
      codec: 'h264',
      maxProfile: 'high',
      maxLevel: 41,
      maxWidth: 1920,
      maxHeight: 1080,
      maxFramerate: 30,
    },
    { codec: 'vp8', maxWidth: 1920, maxHeight: 1080, maxFramerate: 30 },
  ],
  audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
  containers: ['mp4', 'webm'],
  // **Measured on hardware, 2026-08-24, and not an inference.** The Master bedroom set is a
  // plain Chromecast: 5.1 AAC gave `PLAYING` at position 0 for 0.232 s and then `IDLE`
  // with `idleReason: ERROR`; the identical film downmixed to stereo played all 22 minutes
  // through without a single mid-film freeze. Same evening, same server, same engine.
  maxAudioChannels: 2,
};

/**
 * Keyed on `md=`, matched **exactly**.
 *
 * Deliberately not by prefix: a third-party set that calls itself "Chromecast Ultra HD TV"
 * is not a Chromecast Ultra, and widening a profile on a string that merely starts the same
 * way is how an unknown television gets told it can decode HEVC. Anything unrecognised
 * falls to the baseline, and the worst that costs is one lossless remux.
 *
 * The founder's main television reports `md=AI PONT`, and it **was** absent from this table
 * on purpose — it was exactly the device layers 1 and 3 exist for. Checklist item 8b took it
 * off the floor on 2026-08-24 by measuring the one thing the baseline was wrong about. Its
 * entry is the first below and it is *the baseline plus one measured number*, which is the
 * only shape an entry for a set nobody documents is allowed to have.
 */
export const MODEL_TABLE: readonly ModelProfileEntry[] = [
  // **`AI PONT` — the founder's main television, and the only device in this house measured
  // to decode multichannel AAC** (2026-08-24, human checklist item 8b). It is here reluctantly
  // and the reluctance is the point: the comment above says an unrecognised set gets the
  // conservative answer, and this one is no longer unrecognised on the axis that matters.
  //
  // Everything except the audio limit is **the baseline, unchanged**. This is not a claim that
  // the set is capable; it is one measured fact bolted onto the conservative default, because
  // layer 3 can only ever *narrow* a profile and there is nowhere else to record a television
  // turning out to be **more** able than we assumed.
  //
  // The measurement, read from the engine log rather than the verdict: a 113-minute H.264 +
  // 6-channel AAC film cast **untouched** — `prepared: false`, no ffmpeg job, the source path —
  // ran **243 `PLAYING` samples over 118.6 s** with position advancing 0 → 118.6, no `ERROR`,
  // ending only on our own `CANCELLED`. The two Google-made sets in the same house both died
  // on that identical file in under a quarter of a second. **The third-party set is the only
  // one that can, and the inference that Google's own hardware would be the capable one was
  // exactly backwards.**
  {
    models: ['ai pont'],
    profile: { ...BASELINE_PROFILE, id: 'ai-pont', maxAudioChannels: 6 },
  },
  // 1st/2nd/3rd generation all report "Chromecast", and only the 3rd does 1080p60 — so the
  // shared entry stays at 30 fps and gains only what every generation has: VP8 and WebM.
  { models: ['chromecast'], profile: CHROMECAST_GEN_ANY },
  {
    models: ['chromecast ultra'],
    profile: {
      id: 'chromecast-ultra',
      video: [
        {
          codec: 'h264',
          maxProfile: 'high',
          maxLevel: 42,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFramerate: 60,
        },
        { codec: 'hevc', maxProfile: 'main 10', maxWidth: 3840, maxHeight: 2160, maxFramerate: 60 },
        { codec: 'vp9', maxWidth: 3840, maxHeight: 2160, maxFramerate: 60 },
        { codec: 'vp8', maxWidth: 1920, maxHeight: 1080, maxFramerate: 30 },
      ],
      audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3'],
      containers: ['mp4', 'webm'],
      // **Six, because this entry has been claiming multichannel since it was written**:
      // `ac3` and `eac3` above are, in a film, surround formats. Capping the Ultra at 2
      // would contradict a claim we already ship and cost a downmix on every 5.1 film in
      // the room where most of this project's hardware testing happens. It is still a
      // claim rather than a measurement — checklist item 8 is what proves it, and if it is
      // wrong `narrowAfterRefusal` takes it to 2 on the first refusal without ever
      // touching `aac`.
      // **2, MEASURED 2026-08-24 — and this entry used to say 6.** The 6 was inferred from
      // the `ac3`/`eac3` below, on the reasoning that a codec list naming Dolby implies a
      // multichannel decoder. It does not. A Chromecast **passes Dolby through** to whatever
      // is downstream of its HDMI; that says nothing about its **AAC** decoder, which is what
      // every film in this library actually carries. Sent a 6-channel AAC film untouched, the
      // Ultra reached `PLAYING` at position 0 and went `IDLE`/`ERROR` **81 ms** later,
      // `trigger: device.idle` — it quit on its own. The stereo control on the same television
      // minutes later ran 242 position samples across two minutes, 12/12. See STATUS 2026-08-24.
      maxAudioChannels: 2,
    },
  },
  {
    models: ['google tv streamer', 'chromecast google tv'],
    profile: {
      id: 'google-tv',
      video: [
        {
          codec: 'h264',
          maxProfile: 'high',
          maxLevel: 42,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFramerate: 60,
        },
        { codec: 'hevc', maxProfile: 'main 10', maxWidth: 3840, maxHeight: 2160, maxFramerate: 60 },
        { codec: 'vp9', maxWidth: 3840, maxHeight: 2160, maxFramerate: 60 },
        { codec: 'av1', maxWidth: 3840, maxHeight: 2160, maxFramerate: 60 },
        { codec: 'vp8', maxWidth: 1920, maxHeight: 1080, maxFramerate: 30 },
      ],
      audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'ac3', 'eac3'],
      containers: ['mp4', 'webm'],
      // Same entry shape as the Ultra, same `ac3`/`eac3` claim, same reasoning — and the
      // same unproven status.
      // **2, and never measured.** This was 6 on exactly the inference the Ultra just
      // disproved — `ac3`/`eac3` in the list below — and there is no Google TV in this house
      // to test. Nothing justifies keeping the more generous of two numbers when the one
      // device that shared its reasoning failed. Costs a downmix; buys a film that plays.
      maxAudioChannels: 2,
    },
  },
  {
    models: ['google nest hub', 'google home hub', 'nest hub'],
    profile: {
      id: 'nest-hub',
      video: [
        {
          codec: 'h264',
          maxProfile: 'high',
          maxLevel: 41,
          maxWidth: 1280,
          maxHeight: 720,
          maxFramerate: 30,
        },
        { codec: 'vp8', maxWidth: 1280, maxHeight: 720, maxFramerate: 30 },
      ],
      audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
      containers: ['mp4', 'webm'],
      // Two small speakers in one box, and nothing multichannel in its codec list.
      maxAudioChannels: 2,
    },
  },
  {
    models: ['google nest hub max', 'nest hub max'],
    profile: {
      id: 'nest-hub-max',
      video: [
        {
          codec: 'h264',
          maxProfile: 'high',
          maxLevel: 41,
          maxWidth: 1920,
          maxHeight: 1080,
          maxFramerate: 30,
        },
        { codec: 'vp8', maxWidth: 1920, maxHeight: 1080, maxFramerate: 30 },
      ],
      audio: ['aac', 'mp3', 'opus', 'vorbis', 'flac'],
      containers: ['mp4', 'webm'],
      // A bigger box, still two speakers.
      maxAudioChannels: 2,
    },
  },
];

export function modelProfile(model: string | null | undefined): DeviceProfile {
  const key = (model ?? '').trim().toLowerCase();
  if (key === '') return BASELINE_PROFILE;
  const entry = MODEL_TABLE.find((candidate) => candidate.models.includes(key));
  return entry?.profile ?? BASELINE_PROFILE;
}

// --- Layer 3: observed failures ----------------------------------------------

/**
 * One narrowing, recorded because a television refused a file we said it could play.
 *
 * Steps rather than a whole stored profile: a step still means the right thing after the
 * model table above is widened by a future version, and it is small enough to read in a log.
 */
export type NarrowingStep =
  | { readonly kind: 'drop-container'; readonly container: Container }
  | { readonly kind: 'drop-video-codec'; readonly codec: VideoCodec }
  | { readonly kind: 'drop-audio-codec'; readonly codec: AudioCodec }
  /**
   * Fewer audio channels than we believed (D1, criterion 7k).
   *
   * Deliberately a **cap rather than a drop**, and deliberately ahead of `drop-audio-codec`
   * in the ladder. A television that refuses a 5.1 film has almost certainly refused the
   * *channel count*, not the format — and concluding "it cannot decode AAC" would take
   * `aac` off the profile for ever. Every conversion this product runs produces stereo
   * `aac`, so a profile that has lost it can never call a prepared file ready again: that
   * film would be re-prepared on every selection, for the life of the install.
   */
  | { readonly kind: 'cap-audio-channels'; readonly maxChannels: number }
  | { readonly kind: 'cap-resolution'; readonly maxWidth: number; readonly maxHeight: number }
  | { readonly kind: 'cap-framerate'; readonly maxFramerate: number }
  /** Level and profile are properties of one codec's bitstream, so they narrow one codec. */
  | { readonly kind: 'cap-level'; readonly codec: VideoCodec; readonly maxLevel: number }
  | { readonly kind: 'cap-profile'; readonly codec: VideoCodec; readonly maxProfile: string };

/**
 * The permanent record criterion 7e asks for: this device, this refusal, this narrowing.
 *
 * `signature` is evidence for the log — what the file was that it would not play — and is
 * never rendered. `steps` is the part that changes behaviour.
 */
export interface CapabilityDowngrade {
  /** Wall clock, for the log. Never used for arithmetic. */
  readonly at: number;
  readonly signature: RefusedSignature;
  readonly steps: readonly NarrowingStep[];
}

export interface RefusedSignature {
  readonly container: Container | 'other';
  readonly videoCodec: string | null;
  readonly videoProfile: string | null;
  readonly videoLevel: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly audioCodecs: readonly string[];
}

/** Rungs we step down to, so a narrowing always lands somewhere a device plausibly supports. */
const RESOLUTION_RUNGS: readonly { readonly width: number; readonly height: number }[] = [
  { width: 3840, height: 2160 },
  { width: 1920, height: 1080 },
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
];
const FRAMERATE_RUNGS: readonly number[] = [60, 30, 24];
/**
 * The channel counts a receiver plausibly stops at: 7.1, 5.1, stereo.
 *
 * Mono is absent on purpose. No Cast device refuses stereo — the Default Media Receiver's
 * own baseline is stereo AAC — so a rung below 2 would be a narrowing that can only make a
 * film unplayable, and 2 is where this ladder is meant to come to rest.
 */
const AUDIO_CHANNEL_RUNGS: readonly number[] = [8, 6, 2];
const LEVEL_RUNGS: readonly number[] = [51, 50, 42, 41, 40, 31, 30];
const PROFILE_RUNGS: readonly string[] = ['high 4:4:4', 'high 10', 'high', 'main', 'baseline'];

export const PROFILE_RANK: Readonly<Record<string, number>> = {
  'constrained baseline': 0,
  baseline: 1,
  main: 2,
  high: 3,
  'high 10': 4,
  'high 10 intra': 4,
  'high 4:2:2': 5,
  'high 4:4:4': 6,
  'high 4:4:4 predictive': 6,
  // HEVC names, so an HEVC capability can be written the same way.
  'main 10': 4,
  'main still picture': 2,
};

function highestBelow<T>(rungs: readonly T[], isBelow: (rung: T) => boolean): T | null {
  return rungs.find(isBelow) ?? null;
}

function capVideo(
  video: readonly VideoCapability[],
  change: (capability: VideoCapability) => VideoCapability,
): readonly VideoCapability[] {
  return video.map(change);
}

/** Applies one recorded narrowing. Narrowing is monotone: this can only ever remove. */
export function applyNarrowingStep(profile: DeviceProfile, step: NarrowingStep): DeviceProfile {
  switch (step.kind) {
    case 'drop-container':
      return { ...profile, containers: profile.containers.filter((c) => c !== step.container) };
    case 'drop-video-codec':
      return { ...profile, video: profile.video.filter((v) => v.codec !== step.codec) };
    case 'drop-audio-codec':
      return { ...profile, audio: profile.audio.filter((a) => a !== step.codec) };
    case 'cap-audio-channels':
      return {
        ...profile,
        maxAudioChannels: Math.min(profile.maxAudioChannels, step.maxChannels),
      };
    case 'cap-resolution':
      return {
        ...profile,
        video: capVideo(profile.video, (v) => ({
          ...v,
          maxWidth: Math.min(v.maxWidth, step.maxWidth),
          maxHeight: Math.min(v.maxHeight, step.maxHeight),
        })),
      };
    case 'cap-framerate':
      return {
        ...profile,
        video: capVideo(profile.video, (v) => ({
          ...v,
          maxFramerate: Math.min(v.maxFramerate, step.maxFramerate),
        })),
      };
    case 'cap-level':
      return {
        ...profile,
        video: capVideo(profile.video, (v) =>
          v.codec !== step.codec
            ? v
            : {
                ...v,
                maxLevel:
                  v.maxLevel === undefined ? step.maxLevel : Math.min(v.maxLevel, step.maxLevel),
              },
        ),
      };
    case 'cap-profile':
      return {
        ...profile,
        video: capVideo(profile.video, (v) => {
          if (v.codec !== step.codec) return v;
          const current = v.maxProfile === undefined ? null : (PROFILE_RANK[v.maxProfile] ?? null);
          const next = PROFILE_RANK[step.maxProfile] ?? null;
          if (current !== null && next !== null && current <= next) return v;
          return { ...v, maxProfile: step.maxProfile };
        }),
      };
  }
}

/**
 * The whole three-layer composition, in one line of arithmetic each.
 *
 * `downgrades` is whatever the store has remembered about this device — pass `[]` for a
 * device that has never refused anything.
 */
export function resolveDeviceProfile(
  model: string | null | undefined,
  downgrades: readonly CapabilityDowngrade[] = [],
): DeviceProfile {
  const base = modelProfile(model);
  const steps = downgrades.flatMap((downgrade) => downgrade.steps);
  if (steps.length === 0) return base;
  const narrowed = steps.reduce(applyNarrowingStep, base);
  return { ...narrowed, id: `${base.id}+narrowed${String(steps.length)}` as ProfileId };
}

export function signatureOf(probe: ProbeResult, video: ProbeStream | null): RefusedSignature {
  return {
    container: probe.container,
    videoCodec: video?.codec ?? null,
    videoProfile: video?.profile ?? null,
    videoLevel: video?.level ?? null,
    width: video?.width ?? null,
    height: video?.height ?? null,
    frameRate: video?.frameRate ?? null,
    audioCodecs: probe.streams.filter((s) => s.kind === 'audio').map((s) => s.codec),
  };
}

/**
 * A television refused a file we told the founder it could play. What do we now believe?
 *
 * Criterion 7e: the next plan must be a repackage or a conversion, **not** the same load
 * again — so this does not merely record a fact, it keeps narrowing along a fixed ladder
 * until the classifier stops calling that exact file *Ready to cast*. That property is what
 * makes the safety net a safety net rather than a loop, and it is asserted directly in the
 * tests.
 *
 * Returns `steps: []` when the profile is already at the floor and there is nothing left to
 * take away — the caller then has a television that will not play a baseline file, which is
 * a fact about the file or the television, and is reported rather than re-planned.
 *
 * **Only progressive-MP4 loads may call this** (ADR 2026-08-19): SPIKE-1 showed an HLS load
 * refused for a *serving* reason arrives as the identical bare `LOAD_FAILED`, and would
 * teach this table a fact about our own media server.
 */
export function narrowAfterRefusal(
  profile: DeviceProfile,
  refused: ProbeResult,
  now = 0,
): CapabilityDowngrade {
  const video = refused.streams.find((s) => s.kind === 'video' && !s.isAttachedPicture) ?? null;
  const steps: NarrowingStep[] = [];
  let current = profile;

  const ladder: (() => NarrowingStep | null)[] = [
    // The rungs are in order of **what it most likely was, cheapest to be wrong about
    // first** — because a narrowing is a guess, and the only way to test the guess is to
    // prepare a file and watch the television accept it. Guessing "the sound" costs the
    // founder minutes; guessing "the picture is too big" costs an hour and some quality.
    // A wrong guess is not a dead end either: the next refusal narrows the next rung down,
    // and the sequence converges on a file the device will take.

    // 1. We served the file untouched in a container this device turns out not to take.
    //    A repackage is seconds and lossless, and this is far and away the likeliest cause.
    () => {
      const container = refused.container;
      if (container === 'other' || container === 'mp4') return null;
      return current.containers.includes(container) ? { kind: 'drop-container', container } : null;
    },
    // 2. More channels than it can decode. **Before the codec rung, and never past `aac`**
    //    (D1, 7k): this is the likelier cause by far — a 5.1 track in a format the profile
    //    already lists is precisely what the bedroom Chromecast refused on 2026-08-24 —
    //    and it is the recoverable one. It costs a downmix, which is a stream copy of the
    //    picture, and it leaves every codec on the profile intact.
    () => {
      const widest = refused.streams
        .filter((s) => s.kind === 'audio')
        .reduce<number | null>(
          (most, s) => (s.channels === null ? most : Math.max(most ?? 0, s.channels)),
          null,
        );
      // A file whose channel count ffprobe never stated cannot tell us where to cap, and
      // `audioSupported` has already declined to carry it — so there is nothing to learn
      // here and the ladder moves on rather than guessing a number.
      if (widest === null || widest > current.maxAudioChannels) return null;
      const rung = highestBelow(AUDIO_CHANNEL_RUNGS, (candidate) => candidate < widest);
      return rung === null ? null : { kind: 'cap-audio-channels', maxChannels: rung };
    },
    // 3. Sound we believed and should not have — a conversion that leaves the picture alone.
    //    **`aac` is never a candidate**, for the reason written on `cap-audio-channels`.
    () => {
      const codec = refused.streams
        .filter((s) => s.kind === 'audio')
        .map((s) => audioCodecFor(s.codec))
        .find((c) => c !== null && c !== 'aac' && current.audio.includes(c));
      return codec === undefined || codec === null ? null : { kind: 'drop-audio-codec', codec };
    },
    // 4. A video codec we believed and should not have. Everything from here is a re-encode.
    () => {
      const codec = video === null ? null : videoCodecFor(video.codec);
      return codec !== null && codec !== 'h264' && current.video.some((v) => v.codec === codec)
        ? { kind: 'drop-video-codec', codec }
        : null;
    },
    // 5. Too many frames per second: the claim a device is likeliest to have oversold.
    () => {
      const fps = video?.frameRate ?? null;
      if (fps === null) return null;
      const rung = highestBelow(FRAMERATE_RUNGS, (candidate) => candidate < fps - 0.5);
      return rung === null ? null : { kind: 'cap-framerate', maxFramerate: rung };
    },
    // 6. A bitstream feature — 10-bit and friends — that the decoder does not have.
    () => {
      const codec = video === null ? null : videoCodecFor(video.codec);
      const name = video?.profile?.toLowerCase() ?? null;
      const rank = name === null ? null : (PROFILE_RANK[name] ?? null);
      if (codec === null || rank === null) return null;
      const rung = highestBelow(
        PROFILE_RUNGS,
        (candidate) => (PROFILE_RANK[candidate] ?? 99) < rank,
      );
      return rung === null ? null : { kind: 'cap-profile', codec, maxProfile: rung };
    },
    // 7. …or simply a stream more demanding than its decoder.
    () => {
      const codec = video === null ? null : videoCodecFor(video.codec);
      const level = video?.level ?? null;
      if (codec === null || level === null) return null;
      const rung = highestBelow(LEVEL_RUNGS, (candidate) => candidate < level);
      return rung === null ? null : { kind: 'cap-level', codec, maxLevel: rung };
    },
    // 8. Last, and only last: fewer pixels. It is the one narrowing the founder can see.
    () => {
      const width = video?.width ?? null;
      const height = video?.height ?? null;
      if (width === null || height === null) return null;
      const rung = highestBelow(
        RESOLUTION_RUNGS,
        (candidate) => candidate.width < width || candidate.height < height,
      );
      return rung === null
        ? null
        : { kind: 'cap-resolution', maxWidth: rung.width, maxHeight: rung.height };
    },
  ];

  for (const rung of ladder) {
    if (classify(refused, current).kind !== 'ready') break;
    const step = rung();
    if (step === null) continue;
    steps.push(step);
    current = applyNarrowingStep(current, step);
  }

  return { at: now, signature: signatureOf(refused, video), steps };
}
