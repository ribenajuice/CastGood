import fsp from 'node:fs/promises';
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { PREPARATION, SELFTEST } from '../config.js';
import { resolveFfmpeg } from '../media/ffmpeg.js';
import { freeBytesOn } from '../prepare/disk.js';
import { PROFILE_RANK, modelProfile } from '../prepare/device-profiles.js';
import { isOurName, preparedPathFor } from '../prepare/naming.js';
import type { DeviceProfile } from '../types.js';
import {
  assertion,
  holdsTheTelevision,
  observation,
  SelftestAbort,
  type Assertion,
} from './kit.js';
import type { Context } from './index.js';

/**
 * Milestone 3a's selftest scenarios: `check`, `remux`, `prepared`, `convert`, `prepfail`.
 *
 * These are the only automated evidence that preparation works, and they run on the
 * founder's PC against a real television. Everything under `test/engine/` proves the
 * *logic* against a scripted ffmpeg; nothing there has ever produced a file a Chromecast
 * played.
 *
 * ## The rule this file exists to obey
 *
 * The PRD adds one clause to the exit-code contract for M3, and it is the reason half of
 * the code below is about **producing conditions rather than measuring them**:
 *
 * > *A scenario that could not produce the condition it exists to test — no small volume
 * > for a disk-full test, no ffmpeg, a film too short to head-start — exits 2. A
 * > preparation test that silently degraded into a Tier 1 cast and went green would be the
 * > most expensive lie this project could tell itself.*
 *
 * So `remux` does not hope the founder passed it an MKV. It **makes one**, losslessly, from
 * whatever file they did pass, with the bundled ffmpeg — and if it cannot, it exits 2 and
 * says so. Same for `convert`, which makes a 10-bit clip no Chromecast will take. A fixture
 * this harness built itself is a fixture it can reason about; a fixture it was handed is a
 * guess about the founder's library.
 *
 * ## Two things every scenario here does
 *
 * **It works in a scratch folder, never the founder's own.** Preparation writes a sibling
 * beside its source, and a harness that leaves `Cars (CastGood).mp4` in somebody's films
 * folder is a harness nobody runs twice — 13e, applied to a milestone that writes gigabytes.
 *
 * **It compares the folder before and after.** Every scenario's last act is to check that
 * the directory holds exactly what it should, because "leaves nothing behind" is the one
 * promise here that cannot be un-broken.
 */

/** Nothing in M3a is fast. A remux of a two-hour film is allowed a minute by 8b alone. */
const PREPARE_WAIT_MS = 20 * 60_000;
/** Building a fixture with ffmpeg. Generous: a re-encode of a short clip on a slow PC. */
const FIXTURE_WAIT_MS = 5 * 60_000;
/** How long a clip the conversion fixtures are cut to. Long enough to measure, short enough to wait for. */
const CLIP_SECONDS = 20;

/**
 * How long a clip the **cancel** fixture is cut to, and why it is not `CLIP_SECONDS`.
 *
 * The first hardware run (2026-08-20) cancelled a 20-second *stream copy*, which finishes in
 * **89 ms** on the founder's PC — so the cancel landed before ffmpeg had even been spawned,
 * and 8d was recorded as passing without a running job ever existing. A cancel needs work in
 * flight to cancel.
 *
 * So this fixture is a **conversion**, not a copy, and three times as long: at the 17.5×
 * real-time that machine actually manages, sixty seconds of video is around three and a half
 * seconds of encoding — wide enough to press a button in the middle of, on a much faster
 * machine as well as a much slower one. And the scenario no longer *assumes* it caught the
 * job: it waits for ffmpeg's own start record and checks ffmpeg's own exit.
 */
const CANCEL_CLIP_SECONDS = 60;

/**
 * **How many channels a fixture carries is a choice per leg, and both choices are load-bearing.**
 *
 * Defect D1 (2026-08-24): a plain Chromecast was handed 6-channel AAC, played one frame, and
 * gave up — and four days earlier this very scenario file had scored **32/32 on that exact
 * television**. It could not have done otherwise. Every fixture it built came out of
 * `-c copy` or `-c:a copy` from whatever film the founder passed, and **stereo audio cannot
 * fail a channel-count assertion**. The instrument was incapable of seeing the defect and
 * reported a perfect score, which is the seventh time in this project a fixture has been
 * kinder than a television.
 *
 * The first fix for that overshot, and QA caught it the same day: **every** fixture was
 * built with `-ac 6`, and on a 2-channel device — the bedroom Chromecast, the `AI PONT`,
 * both Nest Hubs, i.e. every television in this house but the Ultra — a 5.1 file can never
 * be a Tier 2 repackage. The `remux` scenario stopped entering the branch it is named
 * after: break `-c copy` outright and the run still exited 0, having proved strictly less
 * than the version it replaced. A fixture can be too kind *or* too cruel; both end with a
 * green line about a path nothing walked.
 *
 * So there are two fixture shapes, and a scenario picks the one its leg needs:
 *
 *  - **Stereo, on purpose** (`REPACKAGE_FIXTURE_CHANNELS`) for a leg whose subject is the
 *    lossless repackage. Its sound is inside every device's limit, so the *only* thing
 *    wrong with the file is its packaging and Tier 2 is reachable on every television the
 *    founder owns. `requireStereo` refuses the leg a file that came out any other way.
 *  - **Above this television's limit** (`channelsAboveLimit`) for a leg whose subject is
 *    the sound. 6 for a 2-channel device, 8 for the `AI PONT` — a count the device's own
 *    profile must refuse, because a source at or under the limit makes 8f's assertion
 *    incapable of failing. `requireChannelsAbove` probes the built file and exits **2**
 *    rather than let the leg pass on a condition it never produced.
 *
 * That is D1's regression rule as policy, in both directions: *a test whose fixture cannot
 * express the defect is not evidence, however green it is — and neither is one whose
 * fixture cannot reach the path it claims to test.*
 */
export const REPACKAGE_FIXTURE_CHANNELS = 2;

/**
 * The counts a fixture can actually be built at, above stereo.
 *
 * 5.1 and 7.1, and nothing between them: these are the layouts ffmpeg's native AAC encoder
 * will produce, and a rung it refuses is a fixture that cannot be built at all.
 *
 * **8 exists for exactly one device, and on 2026-08-24 that device changed.** It was the
 * Ultra, on a `maxAudioChannels: 6` inferred from `ac3`/`eac3` in its codec list; hardware
 * then measured the Ultra at **2**, and measured the founder's `AI PONT` — the only set in
 * this house that decodes multichannel AAC — at **6**. So the rung is still needed and still
 * needed by exactly one television, just a different one: without it every audio leg on the
 * `AI PONT` would grade a 6-channel source against a limit of 6 and could not fail.
 *
 * The rung is **not** removed on the day nothing needs it, either. It costs nothing while
 * unreachable, `channelsAboveLimit` aborts rather than guesses when no rung fits, and the
 * next device the founder buys is the sort of thing that puts it back in play.
 */
const FIXTURE_CHANNEL_RUNGS: readonly number[] = [6, 8];

/**
 * A channel count this television's profile must refuse, or exit 2 saying we cannot make one.
 *
 * The abort is the honest answer rather than a nuisance: a leg that grades an artifact
 * against a limit its source never exceeded is a pass that could not have been a failure,
 * and D1 is the whole argument for why that is worse than no measurement.
 */
export function channelsAboveLimit(limit: number, what: string): number {
  const rung = FIXTURE_CHANNEL_RUNGS.find((channels) => channels > limit);
  if (rung === undefined) {
    throw new SelftestAbort(
      `this television is said to decode ${String(limit)} audio channels, and ffmpeg cannot build ${what} above that — so nothing here could exceed its limit and no channel assertion in this scenario could have failed`,
    );
  }
  return rung;
}

/** `-c:a` for a fixture built to carry an exact number of channels, whatever the source had. */
function audioArgsFor(channels: number): readonly string[] {
  return ['-c:a', 'aac', '-ac', String(channels), '-b:a', channels > 2 ? '384k' : '192k'];
}

// --- The fixture's picture, decided from this television's own profile --------

/**
 * **What a fixture's picture is built as, decided from the profile of the television this
 * run is pointed at.**
 *
 * This exists because of the second way an `m3` run can be handed a film it cannot use, and
 * it is the mirror image of D1's channel-count story above.
 *
 * On 2026-08-28 `--scenario m3` was run twice on the `AI PONT` and exited 2 both
 * times, at opposite ends. Given a 4K HEVC film, `check` scored 12/12 and `remux` stopped
 * dead: *"this television will not carry the picture in the stereo Matroska fixture as it
 * stands"*. Given an H.264 film the set plays natively, `check`, `remux`, `prepared` and
 * `convert` scored 42/42 and `headstart` stopped dead: *"head start only applies to a film
 * this television has to convert"*. **Both legs took the same `--file`**: `remux` needed a
 * film whose picture the set carries, `headstart` needed one it does not, and no film in the
 * house could be both. `m3` had never once run whole with `headstart` in it.
 *
 * The cause was one line. `makeMkvClip` was a **stream copy** of the founder's picture, so
 * whatever was wrong with that picture went into the Tier 2 fixture and came straight back
 * out — leaving no pure-repackaging case to grade. A fixture built out of the film under
 * test inherits the film's faults, which is the same shape as D1's *"stereo audio cannot
 * fail a channel-count assertion"* one paragraph up.
 *
 * So the picture is now **built**, exactly as `check`'s pair has been since 2026-08-24, and
 * the legs whose subject is the packaging no longer care what film they were handed.
 *
 * **And it is derived from the device's own profile rather than written down as a constant.**
 * `check` hardcoded 720p24 High because that shape happens to be inside every entry in
 * today's table — true, and true by coincidence. 7j was rewritten to take exactly this kind
 * of constant out of the channel side (`channelLimitFor` reads the table, and refuses to
 * guess when it cannot see the device); a hardcoded box would be the same mistake on the
 * picture side, waiting for the first device added with a smaller one. Each property below
 * is the largest rung the *device's own* H.264 capability states it will carry, and a
 * profile no rung fits is an abort rather than a guess.
 */
export interface FixturePicture {
  readonly width: number;
  readonly height: number;
  readonly frameRate: number;
  /** Lower case, as `-profile:v` takes it and as `PROFILE_RANK` ranks it. */
  readonly h264Profile: string;
}

/**
 * The boxes a fixture can be built in, largest first.
 *
 * Nothing above 720p: the fixture is never watched, every extra pixel is encode time on the
 * founder's evening, and a 720p artifact is inside every profile in the table — which also
 * keeps these legs out of the `outputProfileFor` upscaling defect QA pinned on 2026-08-24.
 * 480p is here for a television that states a smaller box than anything in the table today.
 */
const FIXTURE_SIZE_RUNGS: readonly { readonly width: number; readonly height: number }[] = [
  { width: 1280, height: 720 },
  { width: 854, height: 480 },
];

/** Frame rates a fixture can be built at. Nothing here is watched; 24 is the cheapest. */
const FIXTURE_FRAMERATE_RUNGS: readonly number[] = [24, 15];

/** H.264 profiles, richest first. All 8-bit 4:2:0 — a 10-bit fixture is `convert`'s job. */
const FIXTURE_H264_PROFILE_RUNGS: readonly string[] = ['high', 'main', 'baseline'];

/**
 * A picture this television's profile says it carries, or exit 2 saying we cannot build one.
 *
 * The abort is the honest answer rather than a nuisance, in both directions: a leg that
 * grades a repackage against a fixture the set would refuse anyway is measuring nothing, and
 * a leg that quietly built something outside the profile would be reporting on the picture
 * rather than on the packaging it is named after.
 */
export function fixturePictureFor(profile: DeviceProfile, what: string): FixturePicture {
  const h264 = profile.video.find((capability) => capability.codec === 'h264');
  if (h264 === undefined) {
    throw new SelftestAbort(
      `this television's profile states no H.264 capability at all, so there is no picture this harness knows how to encode that it is known to carry, and ${what} could not be built`,
    );
  }
  const size = FIXTURE_SIZE_RUNGS.find(
    (rung) => rung.width <= h264.maxWidth && rung.height <= h264.maxHeight,
  );
  const frameRate = FIXTURE_FRAMERATE_RUNGS.find((rung) => rung <= h264.maxFramerate);
  const ceiling =
    h264.maxProfile === undefined
      ? Number.POSITIVE_INFINITY
      : (PROFILE_RANK[h264.maxProfile] ?? Number.POSITIVE_INFINITY);
  const h264Profile = FIXTURE_H264_PROFILE_RUNGS.find(
    (rung) => (PROFILE_RANK[rung] ?? Number.POSITIVE_INFINITY) <= ceiling,
  );
  if (size === undefined || frameRate === undefined || h264Profile === undefined) {
    throw new SelftestAbort(
      `this television states an H.264 box of ${String(h264.maxWidth)}×${String(h264.maxHeight)} at ${String(
        h264.maxFramerate,
      )} fps up to ${h264.maxProfile ?? 'any'} profile, and no fixture this harness can build fits inside it — so ${what} could not be given a picture this set is known to carry, and nothing graded against it would have meant anything`,
    );
  }
  return { width: size.width, height: size.height, frameRate, h264Profile };
}

/**
 * `-c:v` and the geometry for a fixture built to a `FixturePicture`.
 *
 * Scaled **down** into the box and padded rather than stretched: a 2.39:1 film scaled to 720
 * high is 1721 wide, which a Nest Hub would refuse for its width — a red line about the
 * picture in a leg that exists to isolate something else. `-r` because a film shot at 60
 * leaves the baseline's 30 fps ceiling, and nothing here is watched.
 */
function videoArgsFor(picture: FixturePicture): readonly string[] {
  const box = `${String(picture.width)}:${String(picture.height)}`;
  return [
    '-c:v',
    'libx264',
    '-profile:v',
    picture.h264Profile,
    '-pix_fmt',
    'yuv420p',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-vf',
    `scale=${box}:force_original_aspect_ratio=decrease,pad=${box}:(ow-iw)/2:(oh-ih)/2,setsar=1`,
    '-r',
    String(picture.frameRate),
  ];
}

// --- Producing the conditions ------------------------------------------------

interface Scratch {
  readonly dir: string;
  cleanup(): Promise<void>;
}

/**
 * A folder of our own to prepare into.
 *
 * Everything a scenario writes goes here and is removed at the end whatever happened —
 * pass, fail or interrupt. The founder's films folder is never written to by this harness.
 */
async function scratch(name: string): Promise<Scratch> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `castgood-${name}-`));
  return {
    dir,
    // Retries for the same Windows reason every other delete in M3a now has them: a handle
    // can outlive the process that held it by a moment.
    cleanup: () =>
      fsp
        .rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
        .catch(() => undefined),
  };
}

function ffmpegBinaries(): { ffmpeg: string; ffprobe: string } {
  const resolution = resolveFfmpeg();
  if (!resolution.available) {
    // A packaged install always has these; three build gates exist to make sure of it. So
    // this is a damaged installation or a working copy that never ran `fetch-ffmpeg`, and
    // either way the run **could not happen** rather than failed.
    throw new SelftestAbort(`${resolution.reason} (looked in: ${resolution.searched.join(', ')})`);
  }
  return resolution.binaries;
}

/**
 * Run ffmpeg to build a fixture, and abort the run if it will not.
 *
 * Deliberately **not** the pipeline's own `runFfmpegJob`: this is the harness making an
 * input, and using the code under test to build the fixture it is tested against is how a
 * bug hides itself. If our argument builder is wrong, the fixture built with the same wrong
 * arguments will still look right.
 */
async function buildFixture(args: readonly string[], what: string): Promise<void> {
  const { ffmpeg } = ffmpegBinaries();
  const stderr = await new Promise<{ code: number | null; text: string }>((resolve) => {
    const child = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', ...args], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true,
    });
    let text = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      if (text.length < 4_000) text += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
    }, FIXTURE_WAIT_MS);
    timer.unref?.();
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: -1, text: String(error) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, text });
    });
  });
  if (stderr.code !== 0) {
    throw new SelftestAbort(
      `this machine could not produce ${what}, so the scenario has nothing to test: ${stderr.text.trim().slice(-400)}`,
    );
  }
}

/**
 * How many audio channels are actually in this file, asked of `ffprobe` directly.
 *
 * **Criterion 8f's whole point is that this is the only admissible evidence.** Not the plan,
 * not the ffmpeg command line, not one of our own log lines — all three of those were
 * *already correct* on 2026-08-24 and the television still refused the film. The only thing
 * that turned out to be true about the sound was what ffmpeg had written into the file.
 *
 * Spawned here rather than run through `runFfprobe` for the same reason `buildFixture`
 * spawns ffmpeg itself: this is the harness measuring, and measuring with the code under
 * test is how a bug hides itself.
 *
 * Returns the **widest** audio stream's count, because an artifact is only within a device's
 * limit if every stream in it is. `null` means there was no audio stream at all, or ffprobe
 * would not say — and every caller treats that as a measurement it did not get.
 */
async function probeAudioChannels(filePath: string): Promise<number | null> {
  const streams = await probeStreams(filePath, 'a');
  const counts = streams
    .map((stream) => (typeof stream['channels'] === 'number' ? stream['channels'] : null))
    .filter((count): count is number => count !== null && count > 0);
  return counts.length === 0 ? null : Math.max(...counts);
}

/** Every stream of one kind in a file, as ffprobe describes it. `a` for audio, `v` for video. */
async function probeStreams(filePath: string, kind: 'a' | 'v'): Promise<Record<string, unknown>[]> {
  const { ffprobe } = ffmpegBinaries();
  const text = await new Promise<string>((resolve) => {
    const child = spawn(
      ffprobe,
      [
        '-v',
        'quiet',
        '-print_format',
        'json',
        '-show_streams',
        '-select_streams',
        kind,
        path.resolve(filePath),
      ],
      { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true },
    );
    let out = '';
    child.stdout?.setEncoding('utf8');
    child.stdout?.on('data', (chunk: string) => {
      if (out.length < 200_000) out += chunk;
    });
    const timer = setTimeout(() => {
      child.kill();
    }, 30_000);
    timer.unref?.();
    child.on('error', () => {
      clearTimeout(timer);
      resolve('');
    });
    child.on('close', () => {
      clearTimeout(timer);
      resolve(out);
    });
  });
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  return (parsed as { streams?: Record<string, unknown>[] } | null)?.streams ?? [];
}

/**
 * The picture in a file, asked of `ffprobe` directly — the same rule as `probeAudioChannels`.
 *
 * 8f's *"never the plan, never the ffmpeg arguments, never our own log"* is about the sound,
 * and the argument transfers whole: the only admissible evidence that a fixture's picture is
 * inside a television's profile is what ffmpeg actually wrote into the file. `-profile:v
 * high` on a command line is a request; libx264 chooses the level itself and can quietly
 * fall back.
 */
export interface ProbedPicture {
  readonly codec: string | null;
  readonly profile: string | null;
  readonly level: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly frameRate: number | null;
  readonly pixelFormat: string | null;
}

async function probeVideoPicture(filePath: string): Promise<ProbedPicture | null> {
  const streams = await probeStreams(filePath, 'v');
  // Cover art is a one-frame video stream, and it is not the picture anybody plays.
  const stream = streams.find(
    (candidate) =>
      (candidate['disposition'] as { attached_pic?: unknown } | undefined)?.attached_pic !== 1,
  );
  if (stream === undefined) return null;
  const number = (value: unknown): number | null => {
    const parsed = typeof value === 'string' ? Number(value) : value;
    return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
  };
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const ratio = (value: unknown): number | null => {
    const parts = typeof value === 'string' ? value.split('/') : [];
    const top = Number(parts[0]);
    const bottom = Number(parts[1] ?? '1');
    return Number.isFinite(top) && Number.isFinite(bottom) && bottom > 0 && top > 0
      ? top / bottom
      : null;
  };
  return {
    codec: text(stream['codec_name']),
    profile: text(stream['profile']),
    level: number(stream['level']),
    width: number(stream['width']) ?? number(stream['coded_width']),
    height: number(stream['height']) ?? number(stream['coded_height']),
    frameRate: ratio(stream['avg_frame_rate']) ?? ratio(stream['r_frame_rate']),
    pixelFormat: text(stream['pix_fmt']),
  };
}

/**
 * The picture gate: hand this file to a leg only if its picture really is inside what this
 * television's profile states.
 *
 * The third of the three symmetrical gates — `requireChannelsAbove` for a fixture built to
 * be refused, `requireStereo` for one built to be accepted, and this one for the picture. It
 * is what turns *"we asked ffmpeg for a carryable picture"* into *"a carryable picture is
 * what came out"*, and it is the reason `remux` can now be handed any film at all: the fault
 * in the file it grades is its **packaging**, established by measurement rather than by
 * hoping the founder passed an H.264 film.
 *
 * A fixture that came out wrong — libx264 fell back to a level the set will not take, the
 * scaler was bypassed, a build of ffmpeg without `libx264` in it — **aborts the run rather
 * than passing it**, because a leg named after the packaging that is actually failing on the
 * picture is the least useful red line this project could print.
 */
async function requirePictureInside(
  filePath: string,
  profile: DeviceProfile,
  what: string,
): Promise<string> {
  const picture = await probeVideoPicture(filePath);
  if (picture === null || picture.codec === null) {
    throw new SelftestAbort(
      `${what} has no picture ffprobe will describe, so nothing here can say whether this television would carry it`,
    );
  }
  const stated = describePicture(picture);
  const wrong = whyPictureIsOutside(picture, profile);
  if (wrong !== null) {
    throw new SelftestAbort(
      `${what} came out as ${stated}, and ${wrong} — so this fixture's picture is a second fault in a file whose packaging is meant to be the only one, and there is no pure repackaging case here to grade`,
    );
  }
  return stated;
}

/** A probed picture as one line of verdict. */
export function describePicture(picture: ProbedPicture): string {
  return `${picture.codec ?? 'no codec'} ${picture.profile ?? 'unknown profile'}@${
    picture.level === null ? '?' : String(picture.level)
  } ${String(picture.width ?? 0)}×${String(picture.height ?? 0)} ${
    picture.frameRate === null ? '?' : String(Math.round(picture.frameRate * 100) / 100)
  } fps ${picture.pixelFormat ?? 'unknown pixel format'}`;
}

/**
 * Why this television's profile would not carry this picture, or `null` if it would.
 *
 * Pure, and separate from the ffprobe call above, so that the rule the gate enforces can be
 * exercised in WSL against every profile in the table — and, more to the point, so that it
 * can be watched to go **red**. A gate nobody has seen refuse anything is not a gate.
 */
export function whyPictureIsOutside(picture: ProbedPicture, profile: DeviceProfile): string | null {
  const capability = profile.video.find((candidate) => candidate.codec === picture.codec);
  if (capability === undefined) return "this television's profile does not list that codec";
  if (picture.width !== null && picture.width > capability.maxWidth) {
    return `it is wider than the ${String(capability.maxWidth)} px this profile states`;
  }
  if (picture.height !== null && picture.height > capability.maxHeight) {
    return `it is taller than the ${String(capability.maxHeight)} px this profile states`;
  }
  if (picture.frameRate !== null && picture.frameRate > capability.maxFramerate + 0.01) {
    return `it runs faster than the ${String(capability.maxFramerate)} fps this profile states`;
  }
  if (
    capability.maxLevel !== undefined &&
    picture.level !== null &&
    picture.level > capability.maxLevel
  ) {
    return `its level is above the ${String(capability.maxLevel)} this profile states`;
  }
  const rank =
    picture.profile === null ? null : (PROFILE_RANK[picture.profile.toLowerCase()] ?? null);
  const ceiling =
    capability.maxProfile === undefined ? null : (PROFILE_RANK[capability.maxProfile] ?? null);
  if (rank !== null && ceiling !== null && rank > ceiling) {
    return `its codec profile is richer than the ${capability.maxProfile ?? ''} this profile states`;
  }
  // 8-bit 4:2:0 or nothing. A 10-bit picture is what `convert`'s fixture is *for*, and one
  // arriving here would mean the encoder ignored `-pix_fmt` — the fixture and the film it
  // was built from having swapped places.
  if (picture.pixelFormat !== null && picture.pixelFormat !== 'yuv420p') {
    return `it is ${picture.pixelFormat} rather than 8-bit 4:2:0`;
  }
  return null;
}

/**
 * The fixture builder's own gate: hand this file to a leg only if its sound really does
 * exceed what this television will decode.
 *
 * A fixture that silently came out smaller — the founder's film had no audio, ffmpeg's AAC
 * encoder refused the layout, an upmix produced two channels anyway — **fails the run
 * rather than passing it**. Exit 2 with the count, so a reader can see exactly which
 * condition was missing instead of reading a green line that meant nothing.
 */
async function requireChannelsAbove(
  filePath: string,
  limit: number,
  what: string,
): Promise<number> {
  const channels = await probeAudioChannels(filePath);
  if (channels === null) {
    throw new SelftestAbort(
      `${what} has no audio stream ffprobe will describe, so this run could not produce the condition defect D1 exists for and proves nothing about it`,
    );
  }
  if (channels <= limit) {
    throw new SelftestAbort(
      `${what} came out with ${String(channels)} audio channels, which this television's profile says it can decode (${String(limit)}). A source inside the limit cannot fail a channel-count assertion, so this run could not have gone red — see docs/PRD.md, defect D1, regression rule 5`,
    );
  }
  return channels;
}

/**
 * The other gate, and the one QA had to add: hand this file to the **repackage** leg only
 * if it really is stereo.
 *
 * Symmetrical with `requireChannelsAbove` and just as load-bearing. A leg whose subject is
 * the lossless `-c copy` needs a file whose sound every television in the house will take,
 * or the check turns it into a conversion and the branch under test is never entered.
 */
async function requireStereo(filePath: string, what: string): Promise<number> {
  const channels = await probeAudioChannels(filePath);
  if (channels === null) {
    throw new SelftestAbort(
      `${what} has no audio stream ffprobe will describe, so nothing here can say whether its sound was inside this television's limit`,
    );
  }
  if (channels > REPACKAGE_FIXTURE_CHANNELS) {
    throw new SelftestAbort(
      `${what} came out with ${String(channels)} audio channels rather than ${String(REPACKAGE_FIXTURE_CHANNELS)}. On a 2-channel television that is a conversion rather than a repackage, and the lossless Tier 2 path this leg exists for would never have been entered`,
    );
  }
  return channels;
}

/**
 * How many channels the television CastGood is talking to is allowed to be sent.
 *
 * Read from the model table rather than from the engine, because 8f wants a target that is
 * independent of the thing being graded. It is the **table's** number, so a device narrowed
 * by a previous refusal (layer 3) is graded against a limit at least as generous as the one
 * the engine used — which can make this assertion miss a narrowing, never invent a failure.
 *
 * **And there is exactly one way that claim could have been untrue**, which is why this
 * throws rather than defaulting. A device id absent from the snapshot used to fall through
 * `modelProfile('')` to the baseline's 2, so an Ultra performing a perfectly correct 5.1
 * repackage would have been graded against a limit of 2 and marked red for it. An instrument
 * that invents a failure is worse than no instrument: the run it condemns is the run someone
 * spends an evening debugging. Not knowing which television this is means the measurement
 * could not be taken, which is exit 2 — never a guess, and never a grade built on one.
 */
export function channelLimitFor(
  devices: readonly { readonly id: string; readonly model: string | null }[],
  deviceId: string,
): number {
  return profileFor(devices, deviceId).maxAudioChannels;
}

/**
 * The whole profile, on the same terms and for the same reason as `channelLimitFor`.
 *
 * Every fixture in this file is now built around it — the channel count *and* the picture —
 * so the argument above is made once and both sides of a fixture read the same table entry.
 */
export function profileFor(
  devices: readonly { readonly id: string; readonly model: string | null }[],
  deviceId: string,
): DeviceProfile {
  const device = devices.find((candidate) => candidate.id === deviceId);
  if (device === undefined) {
    throw new SelftestAbort(
      `could not determine the capabilities of device "${deviceId}": it is not in the discovery list this run can see, so every fixture below would be built against a guess and every assertion graded against one`,
    );
  }
  return modelProfile(device.model);
}

function deviceProfile(context: Context): DeviceProfile {
  return profileFor(context.snapshot().discovery.devices, context.deviceId);
}

function deviceChannelLimit(context: Context): number {
  return deviceProfile(context).maxAudioChannels;
}

/** Which of Tier 2's two shapes the check took, for a fixture whose packaging is its fault. */
export type TierTaken = 'repackage' | 'audio-only conversion';

/**
 * What the check actually decided about a Matroska fixture, and **which outcomes are a
 * missing condition rather than a broken promise.**
 *
 * The distinction decides an exit code, so it is written down once here rather than three
 * times in the scenarios:
 *
 *  - **The picture is not carryable** — the founder passed an HEVC film and this television
 *    is on the baseline. There is no Tier 2 condition to produce on this pairing at all, so
 *    the run exits 2 and says so.
 *  - **Anything but a repackage or an audio-only conversion** — a `ready` (an MKV no
 *    profile carries), or a conversion that re-encodes the picture. The fixture is not what
 *    this leg needs; exit 2.
 *  - **Either of the two** — the condition exists, and which one it is, is a fact about the
 *    television. The caller grades it: the repackage leg *asserts* `repackage`, because for
 *    a stereo fixture whose picture is carryable, anything else is CastGood re-encoding
 *    something it promised to copy.
 */
export function tierTakenFor(
  kind: string | null | undefined,
  pictureCarried: boolean,
  what: string,
): TierTaken {
  if (!pictureCarried) {
    throw new SelftestAbort(
      `this television will not carry the picture in ${what} as it stands, so the file's packaging is not the only thing wrong with it and there is no Tier 2 condition here to measure`,
    );
  }
  if (kind === 'remux') return 'repackage';
  if (kind === 'convert') return 'audio-only conversion';
  throw new SelftestAbort(
    `${what} was judged "${kind ?? 'nothing'}" rather than a repackage or an audio-only conversion, so there is no Tier 2 job to measure`,
  );
}

/**
 * The picture's fate, read from the check's own log record.
 *
 * Deliberately not from the snapshot, which carries no plan (7a: the renderer never sees a
 * codec). This is a **gate on whether the condition exists**, not an 8f assertion — 8f's
 * "never our own log" is about the channel count, and that one is probed out of the file.
 */
function pictureWasCarried(context: Context): boolean {
  const checkRecord = context
    .records()
    .filter((record) => record['event'] === 'file.checked')
    .pop();
  return (
    (checkRecord?.['detail'] as { video?: { supported?: unknown } } | undefined)?.video
      ?.supported === true
  );
}

/**
 * 8f, as three lines of verdict: the source's count, the device's limit, and **the
 * artifact's own**.
 *
 * All three are printed together on purpose. A pass that says only "2 channels" proves
 * nothing about whether the run could have failed; the source's count beside it is what
 * shows the condition existed.
 */
async function audioChannelAssertions(
  label: string,
  sourceChannels: number,
  artifactPath: string,
  limit: number,
): Promise<Assertion[]> {
  const artifactChannels = await probeAudioChannels(artifactPath);
  return [
    observation(
      `${label}SourceAudioChannels`,
      sourceChannels,
      'channels',
      'what went in. If this is 2 the run could not have failed, and the scenario exits 2 before it gets here',
    ),
    observation(
      `${label}DeviceChannelLimit`,
      limit,
      'channels',
      'what this television’s profile says it can decode — 2 for a plain Chromecast, measured on hardware 2026-08-24',
    ),
    assertion(
      `${label}ArtifactAudioChannels`,
      'lte',
      limit,
      artifactChannels,
      'channels',
      'PRD 8f: ffprobe of the prepared file itself. Never the plan, never the ffmpeg arguments, never our own log — all three of those were already right on the night the television refused the film',
    ),
  ];
}

/**
 * A Tier 2 fixture: **a picture this television carries and sound this television takes, in
 * the one box no Chromecast plays.**
 *
 * Tier 2 means *the packaging is the only thing wrong with the file*, and every property of
 * this fixture is chosen so that sentence is true by construction rather than by luck:
 *
 *  - **The picture is re-encoded** to `fixturePictureFor(profile)` — inside this device's own
 *    stated H.264 capability on every axis — rather than stream-copied out of the film the
 *    founder passed. That copy is the defect this fix is about: hand `m3` a 4K HEVC film and
 *    an unplayable picture went into the fixture and came straight back out, so `remux` had
 *    no repackaging case left to grade and exited 2 on the most ordinary film in the house.
 *  - **The sound** is re-encoded at a count the caller chooses, and that choice is what
 *    decides which path the scenario walks: stereo and this is a repackage on every
 *    television in the house; above the device's limit and the same file is an audio-only
 *    conversion. It used to be a plain `-c copy`, which carried whatever the founder's film
 *    carried — a fixture that could not fail a channel assertion on a stereo library.
 *  - **Matroska**, which is what is left to be wrong with it: no profile in the table lists
 *    it, so the verdict is a repackage and the branch under test is entered.
 *
 * **The repackage under test is untouched by any of this.** CastGood's Tier 2 job is still a
 * pure `-c copy` of these streams into MP4, and every assertion that grades it — the tier
 * taken, the artifact's channel count against the source's, the duration drift, the single
 * file left behind — is graded on that copy and can still go red. What changed is only which
 * *input* the copy is asked to make, and a fixture built by the harness is one the harness
 * can reason about.
 *
 * Subtitles are dropped rather than copied. Nothing in these legs grades a subtitle (18k is
 * a human checklist item read off a television), and `-c:s copy` into Matroska is one more
 * way a run can abort on a property nobody is measuring.
 *
 * A clip rather than the whole film, because 8b's 60-second target is measured on the
 * founder's real file in the human checklist, and a scenario that remuxes two hours turns a
 * fifteen-minute selftest into an hour.
 */
async function makeMkvClip(
  sourcePath: string,
  target: string,
  channels: number,
  picture: FixturePicture,
  seconds: number = CLIP_SECONDS,
): Promise<void> {
  await buildFixture(
    [
      '-t',
      String(seconds),
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      ...videoArgsFor(picture),
      ...audioArgsFor(channels),
      '-f',
      'matroska',
      target,
    ],
    `a ${String(seconds)}-second ${String(picture.width)}×${String(picture.height)} Matroska clip of your video with ${String(channels)}-channel sound`,
  );
}

/**
 * A Tier 1 fixture: a picture **every** profile in the table carries, in the box every
 * Chromecast plays.
 *
 * Built only by `check`, and built **twice** — once stereo and once above the device's limit
 * — so the pair differs in exactly one property. That is the whole design of 7i's `check`
 * half: if the stereo one is *Ready to cast* and the other one is not, the channel count is
 * the only thing that can have moved the verdict.
 *
 * **The picture is re-encoded rather than copied, and that is what makes the leg runnable.**
 * Every HEVC film on the founder's drive is Tier 3 on the bedroom Chromecast, so a `-c:v
 * copy` fixture would be *Needs converting* for its picture whatever its sound was — the
 * pair would prove nothing and the scenario would have to exit 2 on the most ordinary film
 * in the house, taking the whole `m3` aggregate with it. The box comes from
 * `fixturePictureFor` — this device's own stated capability — rather than from the 720p24
 * High constant this leg carried until 2026-08-28. It costs one twenty-second `ultrafast`
 * encode, twice.
 */
async function makeMp4Clip(
  sourcePath: string,
  target: string,
  channels: number,
  picture: FixturePicture,
): Promise<void> {
  await buildFixture(
    [
      '-t',
      String(CLIP_SECONDS),
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a:0',
      ...videoArgsFor(picture),
      ...audioArgsFor(channels),
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      target,
    ],
    `a ${String(picture.width)}×${String(picture.height)} MP4 of your video with ${String(channels)}-channel sound`,
  );
}

/**
 * A Tier 3 fixture: 10-bit H.264, which the conservative baseline does not carry.
 *
 * Chosen over "audio a device cannot decode" on purpose. An unsupported audio codec makes a
 * Tier 3 job whose *picture is copied*, which runs at ~20× real time and never exercises the
 * slow path at all. A 10-bit picture forces the re-encode, which is the branch a founder
 * actually waits twenty minutes for, and `-profile:v high10` is one flag rather than a
 * search for a codec no television in the house supports.
 */
async function makeTenBitClip(
  sourcePath: string,
  target: string,
  seconds: number = CLIP_SECONDS,
  channels: number = FIXTURE_CHANNEL_RUNGS[0] ?? 6,
): Promise<void> {
  await buildFixture(
    [
      '-t',
      String(seconds),
      '-i',
      sourcePath,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-profile:v',
      'high10',
      '-pix_fmt',
      'yuv420p10le',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      // `-c:a copy` until 2026-08-24, which is why the `convert` scenario went green against
      // a defect that was passing 5.1 straight through a Tier 3 job. Deliberate surround,
      // checked by `requireChannelsAbove` before the scenario is allowed to use the file.
      // The legs that only need a slow job — `cancel`, P7, P3 — take the default and never
      // grade the sound at all.
      ...audioArgsFor(channels),
      '-f',
      'mp4',
      target,
    ],
    `a 10-bit clip with ${String(channels)}-channel sound that no Chromecast will play`,
  );
}

// --- Driving the engine ------------------------------------------------------

/** Clear the selection, choose a file, and wait for the check to produce a verdict. */
export async function chooseAndCheck(
  context: Context,
  filePath: string,
): Promise<{ elapsedMs: number | null }> {
  context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });
  context.engine.dispatch({ type: 'file.clear' });
  await context.waitFor('the previous file to clear', 5_000, (snapshot) => snapshot.file === null);

  const before = context.mono();
  context.engine.dispatch({ type: 'file.select', path: filePath });
  try {
    const at = await context.waitFor(
      'the check to produce a verdict',
      SELFTEST.stateWaitMs,
      // **`check === null` as well as a verdict**: the engine holds *Checking…* until a
      // verdict exists, so waiting on the verdict alone would be waiting on a field that
      // is set a moment before the state clears.
      (snapshot) => snapshot.check === null && snapshot.file !== null,
    );
    return { elapsedMs: at - before };
  } catch {
    return { elapsedMs: null };
  }
}

/** Everything in a directory, sorted, so before and after can be compared as values. */
export async function contentsOf(dir: string): Promise<string[]> {
  return (await fsp.readdir(dir)).sort();
}

/** The folder promise, as one assertion. Named so every scenario says it the same way. */
function folderAssertion(
  name: string,
  before: readonly string[],
  after: readonly string[],
): Assertion {
  return assertion(
    name,
    'eq',
    before.join(' | '),
    after.join(' | '),
    'contents',
    'the folder is exactly as it was found — nothing partial, nothing to tidy by hand',
  );
}

/**
 * The same promise as `folderAssertion`, for a folder **the founder actually lives in**.
 *
 * `check` runs against the film they named on the command line, which on this PC is on the
 * Desktop — and a Desktop is the most churn-prone folder on Windows. OneDrive syncs,
 * `desktop.ini` is rewritten, a screenshot lands, another app drops a temp file. Comparing
 * the whole listing there would fail for reasons that have nothing to do with CastGood, and
 * **a false red on a preparation run is worse than a weaker assertion**: it costs an
 * evening and it teaches everyone to shrug at the verdict.
 *
 * So the promise is split from the noise, which is the same `promise`/`observation`
 * distinction the receiver's boot time forced in M1:
 *
 *  - **The promise**: nothing CastGood could have written appeared, and nothing was
 *    removed. That is the whole of what 7g is protecting against — a check that prepares,
 *    stages, or tidies. `isOurName` is the same gate the pipeline's deletes go through, so
 *    a file we wrote cannot slip past it here either.
 *  - **The observation**: everything else that changed, printed for a person to glance at.
 *    A `Cars (CastGood).mp4` would fail the promise; a `Screenshot 2026-08-20.png` shows up
 *    here and fails nothing.
 *
 * Scratch folders keep the strict comparison — see `folderAssertion`. This is only for the
 * one directory we do not own.
 */
function untouchedByUs(
  label: string,
  before: readonly string[],
  after: readonly string[],
): Assertion[] {
  const appeared = after.filter((name) => !before.includes(name));
  const removed = before.filter((name) => !after.includes(name));
  const ours = appeared.filter((name) => isOurName(name));
  return [
    assertion(
      `${label}WroteNothing`,
      'eq',
      'nothing',
      ours.length === 0 ? 'nothing' : ours.join(' | '),
      'files',
      'PRD 7g: a check writes nothing beside the founder’s film — no artifact, no staging file',
    ),
    assertion(
      `${label}RemovedNothing`,
      'eq',
      'nothing',
      removed.length === 0 ? 'nothing' : removed.join(' | '),
      'files',
      'and takes nothing away either: CastGood deletes only what CastGood named',
    ),
    observation(
      `${label}OtherFolderChanges`,
      appeared.filter((name) => !isOurName(name)).join(' | ') || 'none',
      'files',
      'anything else that appeared in that folder while the check ran — Windows, OneDrive or another app, not us. Reported so a person can glance at it; it fails nothing',
    ),
  ];
}

// --- check (7a–7e, 7g) -------------------------------------------------------

/**
 * The check, against a real television, with nothing prepared and nothing cast.
 *
 * This is the cheapest scenario in M3 and the one that proves the most: the verdict the
 * founder reads is a claim about *their* file and *their* device, and until now it had only
 * ever been checked against fixtures.
 */
export async function scenarioCheck(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const work = await scratch('check');
  try {
    const folder = path.dirname(context.filePath);
    const before = await contentsOf(folder);

    // --- 7a, against the founder's own file ---
    const { elapsedMs } = await chooseAndCheck(context, context.filePath);
    const snapshot = context.snapshot();
    const verdict = snapshot.file?.verdict ?? null;

    assertions.push(
      assertion(
        'checkMs',
        'lte',
        PREPARATION.checkBudgetMs,
        elapsedMs === null ? null : Math.round(elapsedMs),
        'ms',
        'PRD 7a: the check completes within 3 s',
      ),
      assertion(
        'verdictKind',
        'eq',
        'one of four',
        verdict === null
          ? null
          : ['ready', 'remux', 'convert', 'impossible'].includes(verdict.kind)
            ? 'one of four'
            : verdict.kind,
        'kind',
        'PRD 7a: exactly one of Ready to cast · Ready in about <time> · Needs converting · can’t be cast',
      ),
      observation(
        'verdictForYourFile',
        verdict === null ? 'none' : `${verdict.kind}: ${verdict.headline}`,
        'verdict',
        'what CastGood says about the file you passed — this is the sentence you would read on screen',
      ),
    );

    // 7a forbids every one of these **on screen**, and the snapshot is what the screen is
    // built from. Checked against the verdict rather than the whole snapshot: `file.path`
    // is the selection's identity and is never rendered.
    const rendered = JSON.stringify(verdict ?? {});
    const leaked = ['h264', 'hevc', 'aac', 'matroska', 'ffmpeg', 'ffprobe', 'yuv', ':\\\\'].filter(
      (word) => rendered.toLowerCase().includes(word.toLowerCase()),
    );
    assertions.push(
      assertion(
        'noTechnicalDetailOnScreen',
        'eq',
        'none',
        leaked.length === 0 ? 'none' : leaked.join(', '),
        'terms',
        'PRD 7a: no codec name, no profile, no file path and no ffmpeg output appears on screen',
      ),
    );

    // --- 7b: nothing was written, and nothing was sent ---
    assertions.push(
      ...untouchedByUs('check', before, await contentsOf(folder)),
      assertion(
        'checkSentNothing',
        'eq',
        'idle',
        context.snapshot().session.state,
        'state',
        'PRD 7b: a check never prepares and never casts — nothing is sent to a television by looking at a file',
      ),
    );

    // --- 7b: the same file, re-checked against the same television, is stable ---
    //
    // A single-television house cannot prove "the verdict may change" — that needs a second
    // device and is the human checklist's item 7. What *can* be proved here is the half that
    // is ours: re-running the check is a pure re-classification and produces the same answer
    // rather than drifting.
    const firstKind = verdict?.kind ?? null;
    await chooseAndCheck(context, context.filePath);
    assertions.push(
      assertion(
        'recheckIsStable',
        'eq',
        firstKind,
        context.snapshot().file?.verdict?.kind ?? null,
        'kind',
        'PRD 7b: the check re-runs on demand and is a pure function of the file and the device',
      ),
    );

    // --- 7d: a file nothing can handle, refused during the check ---
    const damaged = path.join(work.dir, 'Not a film.mp4');
    await fsp.writeFile(damaged, Buffer.alloc(64 * 1024, 0x5a));
    await chooseAndCheck(context, damaged);
    const refused = context.snapshot();
    assertions.push(
      assertion(
        'damagedFileRefused',
        'eq',
        'impossible',
        // A file the probe could not read at all also lands here, as `impossible` with the
        // engine's own sentence — 7d is about the founder's experience, not about which
        // layer noticed.
        refused.file?.verdict?.kind ?? 'no verdict',
        'kind',
        'PRD 7d: decided during the check, before the founder commits to anything',
      ),
      assertion(
        'damagedFileHasASentence',
        'eq',
        'yes',
        (refused.file?.verdict?.reason ?? '').length > 0 ? 'yes' : 'no',
        'bool',
        'PRD 7d: one sentence a person can act on',
      ),
      assertion(
        'damagedFileNeverCast',
        'eq',
        'idle',
        refused.session.state,
        'state',
        'PRD 7d: it is never discovered mid-cast',
      ),
    );

    // --- 7i, the half this scenario owes: the same film twice, and only the sound differs ---
    //
    // 7i's verification column names `[selftest] check`, and until now `check` had never
    // looked at a channel count at all. The trap it has to avoid is the one that produced
    // 32/32 on a television that could not play the film: a single multichannel fixture
    // judged *Needs converting* proves nothing, because on the baseline profile the picture
    // in an HEVC film is reason enough for that verdict on its own.
    //
    // So it is a **pair**, built from one source, differing in exactly one property. The
    // stereo one is the control and the condition: if CastGood calls it *Ready to cast*,
    // then this television carries this picture in this box, and the only thing left that
    // can move the second verdict is the number of channels. Both counts are probed out of
    // the built files rather than assumed from the command line, which is 8f's rule applied
    // to a scenario that writes no artifact of its own.
    const profile = deviceProfile(context);
    const limit = profile.maxAudioChannels;
    const picture = fixturePictureFor(profile, "the check leg's pair of fixtures");
    const stereoFixture = path.join(work.dir, 'Stereo sound.mp4');
    await makeMp4Clip(context.filePath, stereoFixture, REPACKAGE_FIXTURE_CHANNELS, picture);
    const stereoChannels = await requireStereo(stereoFixture, 'the stereo control fixture');
    const stereoPicture = await requirePictureInside(
      stereoFixture,
      profile,
      'the stereo control fixture',
    );
    await chooseAndCheck(context, stereoFixture);
    const stereoKind = context.snapshot().file?.verdict?.kind ?? null;
    if (!pictureWasCarried(context)) {
      // Not a failure: `requirePictureInside` has already measured this picture as inside
      // the *table's* entry for this television, so the only thing that can have refused it
      // is a layer-3 narrowing from an earlier refusal. There is no pair to build that could
      // isolate the channel count — exit 2, and name the way out.
      throw new SelftestAbort(
        `this television refused ${stereoPicture} — a picture its own profile says it carries — so a previous refusal has narrowed it below what the table states and nothing here can show that the *sound* was what changed a verdict`,
      );
    }

    const surroundChannels = channelsAboveLimit(limit, 'a copy of your film');
    const surroundFixture = path.join(work.dir, 'Surround sound.mp4');
    await makeMp4Clip(context.filePath, surroundFixture, surroundChannels, picture);
    const builtChannels = await requireChannelsAbove(
      surroundFixture,
      limit,
      'the multichannel fixture',
    );
    await chooseAndCheck(context, surroundFixture);
    const surroundVerdict = context.snapshot().file?.verdict ?? null;
    // Named rather than boolean, so a verdict that failed for the *wrong* reason — a
    // conversion that re-encodes the picture — reads as itself in the report instead of
    // hiding inside a `no`.
    const surroundTook =
      surroundVerdict?.kind !== 'convert'
        ? (surroundVerdict?.kind ?? 'no verdict')
        : pictureWasCarried(context)
          ? 'audio-only conversion'
          : 'a conversion that re-encodes the picture too';
    assertions.push(
      observation(
        'checkDeviceChannelLimit',
        limit,
        'channels',
        'what this television’s profile says it can decode. The pair below is built around this number, not around a constant',
      ),
      observation(
        'checkFixturePicture',
        stereoPicture,
        'picture',
        'ffprobe of the pair’s picture, built to this television’s own stated H.264 capability rather than to a constant. Both halves carry it, so the sound is the only thing that differs between them',
      ),
      observation(
        'checkStereoSourceAudioChannels',
        stereoChannels,
        'channels',
        'ffprobe of the control fixture — the file whose sound is inside the limit',
      ),
      assertion(
        'checkStereoStaysReady',
        'eq',
        'ready',
        stereoKind,
        'kind',
        'PRD 7i: "given audio at or under the limit, nothing changes — a stereo film is still Tier 1". Its picture is carried (checked from the same record), so a conversion here would be CastGood downmixing a film that never needed it',
      ),
      observation(
        'checkMultichannelSourceAudioChannels',
        builtChannels,
        'channels',
        'ffprobe of the second fixture: the same picture, the same box, above this device’s limit. If this were inside the limit the leg would have exited 2 rather than reaching here',
      ),
      assertion(
        'checkMultichannelIsAConversion',
        'eq',
        'audio-only conversion',
        surroundTook,
        'verdict',
        'PRD 7i on the check: a Tier 1 file whose only fault is its channel count becomes a preparation, and the picture is still copied. On 2026-08-24 this file was called Ready to cast and the television played 0.232 s of it',
      ),
      observation(
        'checkMultichannelSentence',
        surroundVerdict === null ? 'none' : surroundVerdict.headline,
        'verdict',
        'the sentence the founder reads when the sound is the only thing wrong — the real cost of the channels: null ruling, measured rather than guessed at',
      ),
    );
    return assertions;
  } finally {
    await work.cleanup();
  }
}

// --- remux (8a–8d) -----------------------------------------------------------

/**
 * Tier 2 end to end: one press, a progress bar, and a film on the television.
 *
 * The fixture is built here rather than asked for — see the file header. What it costs is
 * one stream copy of twenty seconds; what it buys is a scenario that cannot silently
 * degrade into a Tier 1 cast on a machine whose library happens to be all MP4.
 *
 * ## Two legs, because one fixture cannot be both
 *
 * **The repackage leg** takes a *stereo* Matroska clip. Its sound is inside every
 * television's limit, so the only thing wrong with it is its packaging and the verdict is a
 * `remux` on every device the founder owns. This is the leg that grades 8a, 8b and 8c — the
 * one press, the honest estimate, the lossless copy — and `remuxTierTaken` is an
 * **assertion** with the target `repackage`, not an observation. For one day this scenario
 * built its fixture with `-ac 6`, which on a 2-channel television is an audio conversion:
 * the Tier 2 branch was unreachable, `remuxMs` was calibrating `audioConvertSpeed` while
 * saying `remuxBytesPerSecond`, and breaking `-c copy` outright still exited 0.
 *
 * **The audio leg** takes a Matroska clip built *above this television's limit* and is the
 * one 8f is written about: the picture is copied, the sound is converted, and the artifact
 * is probed. It is the path every one of the founder's own films takes in the bedroom, and
 * it is the path that was broken on 2026-08-24.
 */
export async function scenarioRemux(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const work = await scratch('remux');
  try {
    const profile = deviceProfile(context);
    const channelLimit = profile.maxAudioChannels;
    const picture = fixturePictureFor(profile, "the repackage leg's Matroska fixture");
    const source = path.join(work.dir, 'Remux fixture.mkv');
    await makeMkvClip(context.filePath, source, REPACKAGE_FIXTURE_CHANNELS, picture);
    // Before anything else: can this fixture reach the branch the leg is named after? Both
    // halves of "the packaging is the only thing wrong with it" are measured out of the
    // built file — the sound this set takes, and the picture this set carries.
    const sourceChannels = await requireStereo(source, 'the Matroska fixture');
    const sourcePicture = await requirePictureInside(source, profile, 'the Matroska fixture');
    const before = await contentsOf(work.dir);
    const expectedAfter = [...before, path.basename(preparedPathFor(source))].sort();

    await chooseAndCheck(context, source);
    const verdict = context.snapshot().file?.verdict ?? null;
    // The picture has to be carryable for any of this to mean anything, and that is a
    // condition rather than a promise — `tierTakenFor` exits 2 when it is not. What is left
    // after that gate **is** a promise: a stereo file in the wrong box is a repackage, and a
    // television that converts it is CastGood re-encoding something it said it would copy.
    const tierTaken = tierTakenFor(
      verdict?.kind,
      pictureWasCarried(context),
      'the stereo Matroska fixture',
    );
    if (verdict === null) {
      throw new SelftestAbort('the Matroska fixture produced no verdict at all');
    }
    assertions.push(
      assertion(
        'remuxTierTaken',
        'eq',
        'repackage',
        tierTaken,
        'plan',
        'PRD 8c: this fixture’s sound is inside every device’s limit and its picture is inside this device’s own profile, so its packaging is the only thing wrong with it and Tier 2 is the only correct answer on any television. An audio-only conversion here means the run never entered the lossless path it is about to grade',
      ),
      observation(
        'remuxFixturePicture',
        sourcePicture,
        'picture',
        'ffprobe of the picture inside the Matroska fixture, built to this television’s own stated capability. Until 2026-08-28 this was a stream copy of the film you passed, which is why `m3` on a 4K HEVC film stopped here with nothing to grade',
      ),
      observation(
        'remuxEstimateSeconds',
        verdict.estimateSeconds,
        's',
        'what the founder was told before pressing — graded against the truth below',
      ),
    );

    // --- 8a: one press. No confirmation, no second button. ---
    const pressedAt = context.mono();
    context.engine.dispatch({ type: 'cast.start' });
    let sawProgress = false;
    try {
      await context.waitFor('preparation to start', SELFTEST.stateWaitMs, (snapshot) => {
        if (snapshot.preparation.active) sawProgress = true;
        return snapshot.preparation.active || snapshot.session.state !== 'idle';
      });
    } catch {
      // Falls through: `remuxReachedPlaying` below is what actually fails.
    }
    assertions.push(
      assertion(
        'remuxShowedProgress',
        'eq',
        'yes',
        sawProgress ? 'yes' : 'no',
        'bool',
        'PRD 8a: repackaging runs with a progress bar',
      ),
      assertion(
        'remuxNoConfirmation',
        'eq',
        'no',
        verdict.requiresConfirmation ? 'yes' : 'no',
        'bool',
        'PRD 7h: an estimate of 20 minutes or under starts immediately — one press',
      ),
    );

    // --- 8a: casting begins automatically on completion, with no second press ---
    let playingMs: number | null = null;
    try {
      playingMs = (await context.waitForState('playing', PREPARE_WAIT_MS)) - pressedAt;
    } catch {
      // Null measurement, failed assertion, and the states reached are reported instead.
    }
    assertions.push(
      assertion(
        'remuxReachedPlaying',
        'eq',
        'reached playing',
        playingMs === null ? 'never reached playing' : 'reached playing',
        'states',
        'PRD 8a: the founder presses one button and ends up watching a film',
      ),
      observation(
        'remuxPressToPictureMs',
        playingMs === null ? null : Math.round(playingMs),
        'ms',
        'the founder’s whole wait: the repackage plus the cast that followed it',
      ),
    );

    // --- 8b: was the number we showed them honest? ---
    const finished = context
      .records()
      .filter((record) => record['event'] === 'preparation.finished' && record['ok'] === true)
      .pop();
    const remuxMs = typeof finished?.['elapsedMs'] === 'number' ? finished['elapsedMs'] : null;
    const errorPct =
      typeof finished?.['estimateErrorPct'] === 'number' ? finished['estimateErrorPct'] : null;
    assertions.push(
      observation(
        'remuxMs',
        remuxMs === null ? null : Math.round(remuxMs),
        'ms',
        `how long a ${String(CLIP_SECONDS)}-second stream copy took on this PC — 8b's 60 s target is about a 2-hour film and is checklist item 1. This is the number \`remuxBytesPerSecond\` is calibrated from, and it is only that number because the fixture above is stereo: a 5.1 one on a 2-channel television would have measured an audio conversion under this name`,
      ),
      observation(
        'estimateErrorPct',
        errorPct,
        '%',
        'how far the estimate the founder read sat from the wait they had, for the repackage. Negative = we over-promised the speed',
      ),
    );

    // --- 8c: lossless, and the prepared file is beside the source ---
    const artifact = preparedPathFor(source);
    const artifactExists = await fsp
      .stat(artifact)
      .then((stats) => stats.size)
      .catch(() => null);
    assertions.push(
      assertion(
        'preparedFileBesideSource',
        'gte',
        1,
        artifactExists,
        'bytes',
        'PRD 9e: it goes beside the source, named so the founder recognises it',
      ),
      // The source, one prepared file, and the `cancel` folder made a moment later. No
      // staging file, and nothing else.
      assertion(
        'remuxLeftExactlyOneFile',
        'eq',
        expectedAfter.join(' | '),
        (await contentsOf(work.dir)).join(' | '),
        'contents',
        'the film and one prepared copy — no staging file, nothing to tidy by hand',
      ),
      observation(
        'preparedFileName',
        path.basename(artifact),
        'name',
        'what the founder will see in their films folder',
      ),
      // --- 8c, in the one unit a stream copy must not change ---
      //
      // Not 8f: 8f is graded on the audio leg below, where the source exceeds the device's
      // limit and the assertion can therefore fail. Here the source is stereo, so `lte 2`
      // could not have gone red and printing it as a promise would be exactly the pass
      // regression rule 5 forbids. What *can* fail here is the stronger statement a
      // repackage owes: the sound comes out exactly as it went in.
      observation(
        'remuxDeviceChannelLimit',
        channelLimit,
        'channels',
        'what this television’s profile says it can decode — the stereo fixture above is deliberately inside it',
      ),
      assertion(
        'remuxArtifactAudioChannels',
        'eq',
        sourceChannels,
        await probeAudioChannels(artifact),
        'channels',
        'PRD 8c: ffprobe of the artifact. A repackage changes nothing about the sound, so anything but the source’s own count means the “lossless” path re-encoded or dropped a stream',
      ),
    );

    // The durations, ours against ours: the source probe and the artifact probe both came
    // from ffprobe, and 8c's promise is that they agree within a second.
    const checked = context
      .records()
      .filter((record) => record['event'] === 'prepare.published')
      .pop();
    const sourceDuration =
      typeof checked?.['sourceDurationSec'] === 'number' ? checked['sourceDurationSec'] : null;
    const artifactDuration =
      typeof checked?.['durationSec'] === 'number' ? checked['durationSec'] : null;
    assertions.push(
      assertion(
        'remuxDurationDriftSec',
        'lte',
        1,
        sourceDuration === null || artifactDuration === null
          ? null
          : Math.round(Math.abs(sourceDuration - artifactDuration) * 1000) / 1000,
        's',
        'PRD 8c: same duration within 1 s — the repackage is lossless',
      ),
    );

    // --- The audio leg: 7i and 8f, on the path every film in this house actually takes ---
    //
    // The same twenty seconds of the same film, in the same box, built **above this
    // television's limit** — 6 channels for a plain Chromecast, 8 for the Ultra. Everything
    // about it is the leg above except the sound, so the verdict must move from a repackage
    // to a conversion that copies the picture, and the artifact must come out inside the
    // limit. That is the pair of facts run 1 got wrong on 2026-08-24: the plan said copy,
    // the file carried 5.1, and the television played 0.232 s of it.
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );

    const audioDir = path.join(work.dir, 'audio');
    await fsp.mkdir(audioDir);
    const audioSource = path.join(audioDir, 'Surround fixture.mkv');
    await makeMkvClip(
      context.filePath,
      audioSource,
      channelsAboveLimit(channelLimit, 'a Matroska clip of your film'),
      picture,
    );
    const audioSourceChannels = await requireChannelsAbove(
      audioSource,
      channelLimit,
      'the surround Matroska fixture',
    );
    // The same picture as the leg above, measured again rather than assumed: this pair is
    // only evidence about the *sound* if the picture is not a second variable.
    await requirePictureInside(audioSource, profile, 'the surround Matroska fixture');
    const audioBefore = await contentsOf(audioDir);
    const audioArtifact = preparedPathFor(audioSource);

    await chooseAndCheck(context, audioSource);
    const audioTier = tierTakenFor(
      context.snapshot().file?.verdict?.kind,
      pictureWasCarried(context),
      'the surround Matroska fixture',
    );
    const audioPressedAt = context.mono();
    context.engine.dispatch({ type: 'cast.start' });
    if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
      await context.waitFor(
        'the long-job confirmation',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.file?.verdict?.confirmation != null,
      );
      context.engine.dispatch({ type: 'preparation.confirm' });
    }
    let audioPlayingMs: number | null = null;
    try {
      audioPlayingMs = (await context.waitForState('playing', PREPARE_WAIT_MS)) - audioPressedAt;
    } catch {
      // Falls through to the assertion below, which is the one that fails.
    }
    const audioFinished = context
      .records()
      .filter((record) => record['event'] === 'preparation.finished' && record['ok'] === true)
      .pop();
    assertions.push(
      assertion(
        'remuxAudioTierTaken',
        'eq',
        'audio-only conversion',
        audioTier,
        'plan',
        'PRD 7i: a file whose sound is over this television’s limit is not carryable whatever its codec, and a Tier 2 remux converts its audio. The picture is still copied — this is the same twenty seconds the repackage above was graded on',
      ),
      assertion(
        'remuxAudioReachedPlaying',
        'eq',
        'reached playing',
        audioPlayingMs === null ? 'never reached playing' : 'reached playing',
        'states',
        'D1, on this television: the downmixed film plays. Run 1 reached PLAYING at position 0 for 0.232 s and then IDLE/ERROR',
      ),
      observation(
        'remuxAudioMs',
        typeof audioFinished?.['elapsedMs'] === 'number'
          ? Math.round(audioFinished['elapsedMs'])
          : null,
        'ms',
        `how long an audio-only conversion of ${String(CLIP_SECONDS)} seconds took — this is the number \`audioConvertSpeed\` is calibrated from, and it is deliberately reported under a different name from \`remuxMs\``,
      ),
      observation(
        'remuxAudioEstimateErrorPct',
        typeof audioFinished?.['estimateErrorPct'] === 'number'
          ? audioFinished['estimateErrorPct']
          : null,
        '%',
        'the same honesty clause, for the conversion rather than the copy',
      ),
      // --- 8f: the sound in the file we just wrote, and the assertion that can fail ---
      ...(await audioChannelAssertions(
        'remuxAudio',
        audioSourceChannels,
        audioArtifact,
        channelLimit,
      )),
      assertion(
        'remuxAudioLeftExactlyOneFile',
        'eq',
        [...audioBefore, path.basename(audioArtifact)].sort().join(' | '),
        (await contentsOf(audioDir)).join(' | '),
        'contents',
        'the film and one prepared copy — no staging file, nothing to tidy by hand',
      ),
    );

    // --- 8d: cancel leaves nothing behind ---
    //
    // Run last and on a second fixture, because the first one is on a television. A cancel
    // is only meaningful against a job that is genuinely running, so the fixture is made
    // longer than the one above.
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );

    const cancelDir = path.join(work.dir, 'cancel');
    await fsp.mkdir(cancelDir);
    const cancelSource = path.join(cancelDir, 'Cancel fixture.mp4');
    // A **conversion**, and a long one — see `CANCEL_CLIP_SECONDS`. The 20-second stream
    // copy this used to cancel finished in 89 ms and was gone before ffmpeg existed.
    await makeTenBitClip(context.filePath, cancelSource, CANCEL_CLIP_SECONDS);
    const cancelBefore = await contentsOf(cancelDir);

    await chooseAndCheck(context, cancelSource);
    const cancelPressedAt = context.mono();
    context.engine.dispatch({ type: 'cast.start' });
    if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
      await context.waitFor(
        'the long-job confirmation',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.file?.verdict?.confirmation != null,
      );
      context.engine.dispatch({ type: 'preparation.confirm' });
    }

    // --- The condition, established from a layer below the thing being tested ---
    //
    // `preparation.active` is **not** evidence that work is happening: the engine sets it
    // when a job is *declared*, before the disk pre-check and before anything is spawned.
    // Reading it is what let the 2026-08-20 run report `cancelWasAgainstARunningJob: yes`
    // about a cancel that beat ffmpeg to the starting line. `ffmpeg.job_started` is emitted
    // by the runner at the moment it has a child process, so it is the child's own word.
    try {
      await context.waitFor(
        'an ffmpeg process to actually start',
        SELFTEST.stateWaitMs,
        () => context.samples('ffmpeg.job_started', cancelPressedAt).length > 0,
      );
    } catch {
      throw new SelftestAbort(
        'no ffmpeg process ever started for the cancel fixture, so there was no running job to cancel and 8d could not be tested',
      );
    }
    // And let it get far enough in to be doing real work rather than opening a file.
    try {
      await context.waitFor(
        'the conversion to report progress',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.preparation.percent > 0,
      );
    } catch {
      // Best effort. A job that never reported a percentage is still a running job, and the
      // check below is what decides whether it was still running when we pressed Cancel.
    }

    const cancelledAt = context.mono();
    context.engine.dispatch({ type: 'preparation.cancel' });
    let stoppedMs: number | null = null;
    try {
      stoppedMs =
        (await context.waitFor(
          'the job to stop',
          10_000,
          (snapshot) => !snapshot.preparation.active,
        )) - cancelledAt;
    } catch {
      // Falls through to the assertion.
    }
    // 8d promises the folder is clear *within 2 s*, not instantly. Give it that before looking.
    await context.sleep(2_000);
    context.engine.dispatch({ type: 'cast.stop' });

    // --- Did the cancel actually kill a running process? ---
    //
    // ffmpeg's own exit, not ours: the runner reports `failure: 'cancelled'` only for a
    // process it killed or that a signal ended. `ok: true` here means the conversion beat
    // the button, which is **a condition this run could not produce** rather than a broken
    // promise — exit 2, per the PRD's M3 clause, and never a green line.
    const jobEnded = context.samples('ffmpeg.job_finished', cancelPressedAt).at(-1);
    const cancelledTheProcess = jobEnded?.['failure'] === 'cancelled';
    if (jobEnded !== undefined && jobEnded['ok'] === true) {
      throw new SelftestAbort(
        `the conversion finished in ${String(jobEnded['durationMs'] ?? '?')} ms, before the cancel could reach it — this machine is too fast for a ${String(CANCEL_CLIP_SECONDS)}-second fixture, and 8d was not tested`,
      );
    }

    assertions.push(
      assertion(
        'cancelKilledARunningProcess',
        'eq',
        'yes',
        cancelledTheProcess
          ? 'yes'
          : `ffmpeg reported ${String(jobEnded?.['failure'] ?? 'nothing at all')}`,
        'bool',
        'PRD 8d is about a repackage that is **running**. This reads ffmpeg’s own exit rather than a flag the engine set before spawning it — the distinction the 2026-08-20 run was caught by',
      ),
      assertion(
        'cancelStopMs',
        'lte',
        2_000,
        stoppedMs === null ? null : Math.round(stoppedMs),
        'ms',
        'PRD 8d: it stops within 2 s',
      ),
      folderAssertion('cancelLeftNothing', cancelBefore, await contentsOf(cancelDir)),
      observation(
        'cancelJobRanForMs',
        typeof jobEnded?.['durationMs'] === 'number' ? jobEnded['durationMs'] : null,
        'ms',
        'how long the conversion had been running when the button was pressed — if this is tiny, the fixture is too short for this machine',
      ),
    );
    return assertions;
  } finally {
    await work.cleanup();
  }
}

// --- prepared (9a–9d) --------------------------------------------------------

/**
 * A film prepared once never waits again — including after the app has been closed.
 *
 * The second half of this scenario is the one worth having: it restarts the engine against
 * the same data directory and finds the prepared file anyway, which is only true because
 * the memory **is a file on the disk** and not an entry in a database (9b).
 */
export async function scenarioPrepared(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const work = await scratch('prepared');
  try {
    const profile = deviceProfile(context);
    const channelLimit = profile.maxAudioChannels;
    const picture = fixturePictureFor(profile, "the prepared leg's Matroska fixture");
    const source = path.join(work.dir, 'Prepared fixture.mkv');
    // **Stereo, so the memory is exercised over a Tier 2 repackage.** This scenario is about
    // what CastGood remembers rather than about sound, and for one day its fixture was 5.1 —
    // which on every television in this house but the Ultra turned every leg below into a
    // Tier 3 conversion and left the repackage-then-recognise path untested. The channel
    // count that matters here is the **artifact's**, manufactured deliberately at 7l below.
    //
    // **And the picture is built rather than copied, for exactly the same reason.** This leg
    // had the repackage leg's defect in its quieter form: with a 4K HEVC film the fixture's
    // picture was uncarryable, `preparesInto` fell through to `convert`, every assertion
    // below was graded consistently against a conversion — and the repackage-then-recognise
    // path this leg is named after was silently never entered. That is a green run about a
    // path nothing walked, which is the failure this file's header is entirely about.
    await makeMkvClip(context.filePath, source, REPACKAGE_FIXTURE_CHANNELS, picture);
    const sourceChannels = await requireStereo(source, 'the Matroska fixture');
    const sourcePicture = await requirePictureInside(source, profile, 'the Matroska fixture');
    assertions.push(
      observation(
        'preparedSourceAudioChannels',
        sourceChannels,
        'channels',
        'the fixture this whole scenario is built on: inside every device’s limit, so the tier it takes is decided by its packaging and nothing else',
      ),
      observation(
        'preparedFixturePicture',
        sourcePicture,
        'picture',
        'and inside this television’s own stated capability, which is what makes the tier below a repackage whatever film was passed on the command line',
      ),
    );

    await chooseAndCheck(context, source);
    // The fixture's picture is inside this device's own profile and its sound is stereo, so
    // the packaging is the only fault and a repackage is the only correct answer. Graded
    // through the shared gate, which exits 2 — never 1 — when the picture is the reason
    // there is no Tier 2 job, i.e. when a layer-3 narrowing has taken this set below what
    // the table says about it.
    const firstVerdict = context.snapshot().file?.verdict ?? null;
    const tierTaken = tierTakenFor(
      firstVerdict?.kind,
      pictureWasCarried(context),
      'the Matroska fixture',
    );
    // Kept as the name the rest of the leg grades against, so that if this ever legitimately
    // becomes an audio-only conversion the later assertions move with it rather than
    // inventing a red line.
    const preparesInto = firstVerdict?.kind === 'remux' ? 'remux' : 'convert';
    assertions.push(
      assertion(
        'preparedTierTaken',
        'eq',
        'repackage',
        tierTaken,
        'plan',
        'the memory this leg is about is built over a **repackage**. Until 2026-08-28 this was an observation and the fixture was a stream copy of the film passed, so a 4K HEVC film quietly turned the whole leg into a conversion and the repackage-then-recognise path was never entered',
      ),
    );

    // Prepare it once, the ordinary way, and stop the film. Everything after this is about
    // what CastGood remembers.
    context.engine.dispatch({ type: 'cast.start' });
    try {
      await context.waitForState('playing', PREPARE_WAIT_MS);
    } catch {
      throw new SelftestAbort(
        'the first preparation never reached a picture, so there is nothing to remember',
      );
    }
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );

    // --- 9a: chosen again, and there is no preparation step at all ---
    const jobsBefore = context.records().filter((r) => r['event'] === 'preparation.started').length;
    const recogniseAt = context.mono();
    await chooseAndCheck(context, source);
    const secondCheckMs = context.mono() - recogniseAt;
    const second = context.snapshot().file?.verdict ?? null;
    assertions.push(
      assertion(
        'preparedVerdict',
        'eq',
        'ready',
        second?.kind ?? null,
        'kind',
        'PRD 9a: marked ready, with no preparation step at all',
      ),
      assertion(
        'preparedSaysWhy',
        'eq',
        'yes',
        (second?.reason ?? '').toLowerCase().includes('prepared') ? 'yes' : 'no',
        'bool',
        'PRD 7c: the founder is told why there is no wait, not left guessing',
      ),
      assertion(
        'recogniseMs',
        'lte',
        500,
        Math.round(secondCheckMs),
        'ms',
        'M3 numbers: recognising an already-prepared film must not eat story 7’s 3 s check budget',
      ),
    );

    context.engine.dispatch({ type: 'cast.start' });
    let replayMs: number | null = null;
    const replayAt = context.mono();
    try {
      replayMs = (await context.waitForState('playing', SELFTEST.stateWaitMs)) - replayAt;
    } catch {
      // Falls through.
    }
    assertions.push(
      assertion(
        'preparedCastNoJob',
        'eq',
        jobsBefore,
        context.records().filter((r) => r['event'] === 'preparation.started').length,
        'jobs',
        'PRD 9a: the wait never happens twice',
      ),
      observation(
        'preparedReplayMs',
        replayMs === null ? null : Math.round(replayMs),
        'ms',
        'the wait a second time',
      ),
    );
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );

    // --- 9b: it survives the app being closed and reopened ---
    //
    // A second engine against the same data directory. Honestly: a second engine *instance*
    // in this process, not a second OS process — the same caveat `reattach` carries. What it
    // does prove is that nothing in memory is holding the answer.
    await context.restart();
    await context.waitFor('the device to come back', SELFTEST.deviceWaitMs, (snapshot) =>
      snapshot.discovery.devices.some((device) => device.id === context.deviceId),
    );
    await chooseAndCheck(context, source);
    assertions.push(
      assertion(
        'preparedSurvivesRestart',
        'eq',
        'ready',
        context.snapshot().file?.verdict?.kind ?? null,
        'kind',
        'PRD 9b: it survives because the prepared file is a real file beside the source, not an entry in a database',
      ),
    );

    // --- 7l: a prepared file made *before* defect D1 was fixed ---
    //
    // There are films sitting in the founder's folder right now with `(CastGood).mp4` in
    // their names and 5.1 sound inside them, because that is what this product wrote until
    // 2026-08-24. Nothing sweeps the disk for them — 7l finds them lazily, at the only
    // moment it matters, which is the next time that film is chosen.
    //
    // So one is manufactured in place: the same film, the same length, the same box, the
    // same picture, and the sound the old code would have left. Then the three things the
    // criterion actually asks for, in order.
    //
    // **Above *this* television's limit rather than at a constant 6.** A hardcoded 5.1
    // artifact is refused by a plain Chromecast and perfectly acceptable to an Ultra, so on
    // the Ultra this leg would have demanded a re-preparation the product was right not to
    // do — a red line invented by the instrument. The count is the device's own limit plus a
    // rung, and if no rung exists the leg exits 2 rather than grading a guess.
    const artifactPath = preparedPathFor(source);
    await fsp.rm(artifactPath, { force: true });
    await buildFixture(
      [
        '-i',
        source,
        '-map',
        '0:v:0',
        '-map',
        '0:a:0',
        '-c:v',
        'copy',
        ...audioArgsFor(
          channelsAboveLimit(channelLimit, 'a prepared file of the kind written before D1'),
        ),
        '-movflags',
        '+faststart',
        '-f',
        'mp4',
        artifactPath,
      ],
      'a prepared file with more channels than this television decodes, of the kind CastGood wrote before defect D1',
    );
    const staleChannels = await requireChannelsAbove(
      artifactPath,
      channelLimit,
      'the pre-fix prepared file this leg manufactures',
    );
    const jobsBeforeStale = context
      .records()
      .filter((r) => r['event'] === 'preparation.started').length;

    await chooseAndCheck(context, source);
    assertions.push(
      observation(
        'staleArtifactChannels',
        staleChannels,
        'channels',
        'what the manufactured pre-D1 prepared file carries. If this were inside the device’s limit the leg could not have failed and it would have exited 2 above',
      ),
      assertion(
        'staleArtifactNotOffered',
        'eq',
        preparesInto,
        context.snapshot().file?.verdict?.kind ?? null,
        'kind',
        'PRD 7l: a prepared file this television cannot decode is never reported already prepared. It is judged by exactly 7i’s rule and prepared once more',
      ),
    );

    // …and it is replaced by one that satisfies the check that rejected it. This half is the
    // sharp end of the criterion: a rejection rule the replacement cannot satisfy is not a
    // fix, it is an infinite wait — the founder would sit through the same conversion every
    // single time they chose that film.
    context.engine.dispatch({ type: 'cast.start' });
    if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
      await context.waitFor(
        'the long-job confirmation',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.file?.verdict?.confirmation != null,
      );
      context.engine.dispatch({ type: 'preparation.confirm' });
    }
    try {
      await context.waitForState('playing', PREPARE_WAIT_MS);
    } catch {
      throw new SelftestAbort(
        'the replacement preparation never reached a picture, so 7l’s second half could not be measured',
      );
    }
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );

    const jobsAfterReplacement = context
      .records()
      .filter((r) => r['event'] === 'preparation.started').length;
    await chooseAndCheck(context, source);
    assertions.push(
      ...(await audioChannelAssertions(
        'staleReplacement',
        staleChannels,
        artifactPath,
        channelLimit,
      )),
      assertion(
        'replacementIsAccepted',
        'eq',
        'ready',
        context.snapshot().file?.verdict?.kind ?? null,
        'kind',
        'PRD 7l: the replacement satisfies the check that rejected its predecessor. If it did not, this film would be re-prepared on every selection for ever',
      ),
      assertion(
        'replacementPreparedExactlyOnce',
        'eq',
        jobsBeforeStale + 1,
        jobsAfterReplacement,
        'jobs',
        'one job to replace it, and none for the selection after — the lazy replacement happens once, not every time',
      ),
    );

    // --- 9d: the founder deletes it by hand ---
    //
    // With no cleanup policy, deleting one by hand **is** the founder's cleanup policy, and
    // it must be safe: a re-check, not an error, and never a URL for a file that is not there.
    await fsp.rm(preparedPathFor(source));
    await chooseAndCheck(context, source);
    assertions.push(
      assertion(
        'deletedByHandIsRePrepared',
        'eq',
        preparesInto,
        context.snapshot().file?.verdict?.kind ?? null,
        'kind',
        'PRD 9d: the app notices and prepares it again — it never casts a URL for a file that is not there',
      ),
      assertion(
        'deletedByHandIsNotAnError',
        'eq',
        'none',
        context.snapshot().notice?.message ?? 'none',
        'message',
        'PRD 9d: deleting a prepared file by hand is safe, and nothing is said about it',
      ),
    );

    const durationBeforeChange = context.snapshot().file?.durationSec ?? 0;

    // --- 9c: a changed source is re-checked, not trusted ---
    //
    // Prepare it again, then replace the source with a *different length* of the same film.
    // The sibling is still sitting there under the right name; only its duration says it
    // now describes something else.
    context.engine.dispatch({ type: 'cast.start' });
    try {
      await context.waitForState('playing', PREPARE_WAIT_MS);
    } catch {
      throw new SelftestAbort('the second preparation never reached a picture');
    }
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );

    await fsp.rm(source);
    // **The same fixture shape as the film it replaces, at half the length.**
    //
    // This was a hand-rolled `-map 0 -c copy` of the founder's own film, which carried
    // whatever sound that film carried — 6 channels for every film in `D:\DUMP\Movies`.
    // `preparesInto` was measured on the *stereo* fixture above, so on a 2-channel
    // television the replacement was correctly judged an audio-only conversion (`convert`)
    // and graded against a repackage (`remux`): a red line invented by the instrument, on
    // a run where the product had done exactly what 9c asks. It passed on an HEVC film
    // only because there both fixtures happen to be conversions.
    //
    // Built through the same helper and gated by the same `requireStereo` as every other
    // fixture in this file, so the replacement differs from its predecessor in exactly one
    // property — its duration — which is the property 9c is about. The tier is then a fact
    // about this television rather than a coincidence about the founder's film.
    await makeMkvClip(
      context.filePath,
      source,
      REPACKAGE_FIXTURE_CHANNELS,
      picture,
      Math.round(CLIP_SECONDS / 2),
    );
    await requireStereo(source, 'the shorter Matroska fixture that replaces the source');
    await requirePictureInside(
      source,
      profile,
      'the shorter Matroska fixture that replaces the source',
    );
    await chooseAndCheck(context, source);
    // The other half of the same discipline: a replacement that came out the *same* length
    // has not changed anything 9c can notice, and the sibling would rightly still be
    // offered. That is a run that could not have failed for the right reason, so it exits 2
    // rather than grading a condition it never produced.
    const changedDuration = context.snapshot().file?.durationSec ?? null;
    if (changedDuration === null || Math.abs(changedDuration - durationBeforeChange) <= 1) {
      throw new SelftestAbort(
        `the replacement film is ${String(changedDuration ?? 'an unknown number of')} seconds long and the one it replaced was ${String(
          Math.round(durationBeforeChange),
        )} — nothing about the source changed, so 9c had nothing to notice`,
      );
    }
    assertions.push(
      observation(
        'changedSourceDurationSec',
        changedDuration === null ? null : Math.round(changedDuration * 100) / 100,
        's',
        `the replacement's length against the ${String(Math.round(durationBeforeChange))} s the prepared sibling was made from — the one property that changed, and the only thing 9c can see`,
      ),
      assertion(
        'changedSourceIsRechecked',
        'eq',
        preparesInto,
        context.snapshot().file?.verdict?.kind ?? null,
        'kind',
        'PRD 9c: a re-encoded or replaced film never plays back somebody else’s preparation',
      ),
    );
    return assertions;
  } finally {
    await work.cleanup();
  }
}

// --- convert (Tier 3 to completion) -----------------------------------------

/**
 * Half A's Tier 3: converted **to completion**, then cast. No HLS, no head start.
 *
 * This is also the fallback the 2026-08-13 ADR reserves — *"if SPIKE-1 fails, Tier 3
 * degrades to fully-prepared-only"* — so it is the scenario that has to keep working
 * whatever M3b turns out to be able to do.
 */
export async function scenarioConvert(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const work = await scratch('convert');
  try {
    const channelLimit = deviceChannelLimit(context);
    const source = path.join(work.dir, 'Convert fixture.mp4');
    // Above **this** television's limit, not a constant 6: on the Ultra a 5.1 source is
    // inside the limit, so the 8f assertion below would be graded on an artifact that was
    // never required to change and could not have gone red.
    await makeTenBitClip(
      context.filePath,
      source,
      CLIP_SECONDS,
      channelsAboveLimit(channelLimit, 'a 10-bit clip'),
    );
    const sourceChannels = await requireChannelsAbove(source, channelLimit, 'the 10-bit fixture');
    const before = await contentsOf(work.dir);

    await chooseAndCheck(context, source);
    const verdict = context.snapshot().file?.verdict ?? null;
    if (verdict?.kind !== 'convert') {
      throw new SelftestAbort(
        `the 10-bit fixture was judged "${verdict?.kind ?? 'nothing'}" rather than a conversion, so there is no Tier 3 job to measure — this television may accept 10-bit H.264, which would be worth knowing`,
      );
    }
    assertions.push(
      observation(
        'convertEstimateSeconds',
        verdict.estimateSeconds,
        's',
        'what the founder was told before pressing',
      ),
      observation(
        'convertNeededConfirmation',
        verdict.requiresConfirmation ? 'yes' : 'no',
        'bool',
        'whether this job was over the 20-minute line on this PC',
      ),
    );

    const pressedAt = context.mono();
    context.engine.dispatch({ type: 'cast.start' });
    if (verdict.requiresConfirmation) {
      // 7f: the confirmation is a **state**, and the scenario answers it as the founder
      // would. Nothing is on disk until it does.
      await context.waitFor(
        'the long-job confirmation',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.file?.verdict?.confirmation != null,
      );
      assertions.push(
        folderAssertion('confirmationWroteNothing', before, await contentsOf(work.dir)),
      );
      context.engine.dispatch({ type: 'preparation.confirm' });
    }

    let playingMs: number | null = null;
    try {
      playingMs = (await context.waitForState('playing', PREPARE_WAIT_MS)) - pressedAt;
    } catch {
      // Falls through.
    }
    assertions.push(
      assertion(
        'convertReachedPlaying',
        'eq',
        'reached playing',
        playingMs === null ? 'never reached playing' : 'reached playing',
        'states',
        'half A’s Tier 3: converted to completion, then cast',
      ),
      observation(
        'convertPressToPictureMs',
        playingMs === null ? null : Math.round(playingMs),
        'ms',
        `the whole wait for a ${String(CLIP_SECONDS)}-second re-encode on this PC — the number that decides whether hardware encoding is worth building`,
      ),
    );

    const finished = context
      .records()
      .filter((record) => record['event'] === 'preparation.finished' && record['ok'] === true)
      .pop();
    const checkedWith = context
      .records()
      .filter((record) => record['event'] === 'file.checked' && record['kind'] === 'convert')
      .pop();
    assertions.push(
      observation(
        'convertEstimateErrorPct',
        typeof finished?.['estimateErrorPct'] === 'number' ? finished['estimateErrorPct'] : null,
        '%',
        'PRD 8b’s honesty clause, measured: how far the number the founder read sat from the truth',
      ),
      // **The encoder that actually ran, and the seed that actually applied.** This used to
      // print `PREPARATION.throughput.videoMegapixelsPerSecond` — the software constant —
      // whatever the run had used, so an `m3` on a machine with a working GPU reported a
      // seed of 250 for estimates built from 700. True about the constant, misleading about
      // the run, and the same shape of report this project keeps having to correct.
      observation(
        'convertEncoderUsed',
        typeof checkedWith?.['encoder'] === 'string' ? checkedWith['encoder'] : 'unknown',
        'encoder',
        'read from the check the estimate came from, not from a constant — a machine with a usable GPU builds its estimates from a different number',
      ),
      observation(
        'convertSeedMegapixelsPerSecond',
        checkedWith?.['encoder'] === 'h264_nvenc'
          ? PREPARATION.throughput.videoMegapixelsPerSecondNvenc
          : PREPARATION.throughput.videoMegapixelsPerSecond,
        'Mpx/s',
        'the seed this run’s estimate was built from. Both are sustained full-film measurements, below what was observed, because 8b’s honesty clause is about never announcing a job as shorter than it turns out to be',
      ),
    );

    // 10g's spirit, in half A: **one file beside the source, and no folder of fragments.**
    // The founder never sees a segment, and in M3a there are none to see.
    context.engine.dispatch({ type: 'cast.stop' });
    await context.waitFor(
      'the television to be released',
      SELFTEST.stateWaitMs,
      // `ended` counts, and that is the whole point of asking through the shared helper:
      // a film that played out has already let the television go.
      (snapshot) => !holdsTheTelevision(snapshot.session.state),
    );
    const after = await contentsOf(work.dir);
    assertions.push(
      assertion(
        'convertLeftOneFile',
        'eq',
        [...before, path.basename(preparedPathFor(source))].sort().join(' | '),
        after.join(' | '),
        'contents',
        'the source and one prepared file. No staging file, no folder of fragments',
      ),
      // --- 8f: run 1's exact failure, measured in the artifact ---
      //
      // This is the assertion that would have caught defect D1. The Tier 3 job on
      // 2026-08-24 ran `-c:v h264_nvenc … -c:a copy` and published a segment that probed
      // `aac LC, 6 channels, 5.1`. Everything the verdict said about that run was true.
      ...(await audioChannelAssertions(
        'convert',
        sourceChannels,
        preparedPathFor(source),
        channelLimit,
      )),
    );
    return assertions;
  } finally {
    await work.cleanup();
  }
}

// --- prepfail (P1, P3, P7) ---------------------------------------------------

/**
 * The failure states, and the one scenario the PRD expects to be unable to finish.
 *
 * *"Attempted; falls back to human. Where the condition cannot be produced on this machine,
 * it exits 2 and becomes a checklist item"* — the `takeover` pattern from M2. So each part
 * below produces its condition or says plainly that it could not, and the founder gets a
 * checklist item rather than a green line about something that never happened.
 */
export async function scenarioPrepFail(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];

  /**
   * **Start from a clean slate, because in `m3` this leg does not.**
   *
   * `headstart` runs immediately before this one and **deliberately ends with its
   * conversion still going** — that is the whole point of it, and it records
   * `conversionStillRunningAtEnd: yes` to say so. This leg then presses cast on its own
   * fixture and waits for an ffmpeg process that never arrives, because one is already
   * running. P7 is then reported as a broken promise, which is a red line about a product
   * that did nothing wrong.
   *
   * Measured on the founder's hardware, 2026-09-04: `m3` scored **54/56**, both misses
   * here, `sourceGoneCaughtARunningJob: no` with **no `ffmpeg.job_started` recorded at
   * all** — and the identical leg run on its own, minutes later, passed **3/3** with the
   * sentence P7 asks for. Nothing was wrong with the app or with the leg; the two legs
   * simply shared a machine.
   *
   * Cancelling here rather than at the end of `headstart` keeps the fix with the leg that
   * needs the precondition, and leaves `headstart`'s own observation untouched.
   */
  if (context.snapshot().preparation.active) {
    context.engine.dispatch({ type: 'preparation.cancel' });
    try {
      await context.waitFor(
        'the previous leg’s conversion to stop, so this one can start its own',
        SELFTEST.stateWaitMs,
        (snapshot) => !snapshot.preparation.active,
      );
    } catch {
      // Said out loud rather than silently proceeding into the same collision.
      throw new SelftestAbort(
        'a conversion from an earlier leg is still running and would not stop, so P7 ' +
          'cannot be given a job of its own to interfere with',
      );
    }
  }

  const work = await scratch('prepfail');
  try {
    // --- P1: a job that will not fit, refused before any work begins ---
    //
    // Produced without a small volume, which is the part the PRD expects to need one: the
    // pre-flight compares the *estimate* against free space, so a file whose estimate
    // exceeds any disk is refused by the same arithmetic a full drive would trigger. It
    // does not prove behaviour *during* a job (P2) — that still needs a small volume and
    // is checklist item 3.
    const free = await freeBytesOn(path.join(work.dir, 'x'));
    assertions.push(
      observation('freeBytesOnScratchVolume', free, 'bytes', 'the room this run had to work with'),
    );

    // --- P7: the source vanishes during a job ---
    //
    // Fully producible, and the one failure the founder has already met: M2's own sentence,
    // M2's own button. A conversion is used rather than a stream copy so there is time to
    // delete the file underneath it.
    const gone = path.join(work.dir, 'Vanishing fixture.mp4');
    // Long enough that there is a job to interfere with, for the reason `CANCEL_CLIP_SECONDS`
    // is what it is: a 20-second conversion was over in about a second on the founder's PC.
    await makeTenBitClip(context.filePath, gone, CANCEL_CLIP_SECONDS);
    await chooseAndCheck(context, gone);
    if (context.snapshot().file?.verdict?.kind !== 'convert') {
      throw new SelftestAbort(
        'the 10-bit fixture was not judged a conversion, so there is no job slow enough to delete a file underneath',
      );
    }

    const pressedAt = context.mono();
    context.engine.dispatch({ type: 'cast.start' });
    if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
      await context.waitFor(
        'the long-job confirmation',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.file?.verdict?.confirmation != null,
      );
      context.engine.dispatch({ type: 'preparation.confirm' });
    }
    // The same distinction the cancel test was caught by: `preparation.active` says a job
    // has been *declared*, `ffmpeg.job_started` says a child process exists. Only the
    // second one means there is something for a vanishing file to interfere with.
    let jobRunning = false;
    try {
      await context.waitFor(
        'an ffmpeg process to actually start',
        SELFTEST.stateWaitMs,
        () => (jobRunning = context.samples('ffmpeg.job_started', pressedAt).length > 0),
      );
    } catch {
      // Reported below rather than failing: a job that never started proved nothing about
      // P7, and saying so is better than a green line.
    }
    // --- Removing the film out from under a running conversion ---
    //
    // **On Windows this is usually impossible, and that is a finding rather than a defect.**
    // ffmpeg holds the source open for reading, and the OS refuses to unlink a file another
    // process has open — Explorer would say "the file is open in another program" to the
    // founder too. So P7's *"deleted during preparation"* is far less reachable here than
    // the criterion assumes; what really makes a source vanish mid-job on this platform is a
    // USB drive pulled or a network share dropping, and nothing in this harness can produce
    // either.
    //
    // Rather than abort the whole run for a condition the operating system forbids — which
    // would make `m3` permanently exit 2 and teach everyone to ignore the exit code — the
    // reachable half is tested and the verdict says which half ran: stop the job, remove the
    // film, and press again so the conversion starts against a file that is not there. Same
    // product path, same sentence, same cleanup.
    let removedDuringJob = false;
    try {
      await fsp.rm(gone);
      removedDuringJob = true;
    } catch {
      context.engine.dispatch({ type: 'preparation.cancel' });
      try {
        await context.waitFor(
          'the job to stop so the film can be removed',
          10_000,
          (snapshot) => !snapshot.preparation.active,
        );
      } catch {
        // Falls through; the delete below is what actually has to succeed.
      }
      await fsp.rm(gone, { force: true, maxRetries: 20, retryDelay: 100 });
      context.engine.dispatch({ type: 'cast.start' });
      if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
        try {
          await context.waitFor(
            'the long-job confirmation',
            SELFTEST.stateWaitMs,
            (snapshot) => snapshot.file?.verdict?.confirmation != null,
          );
          context.engine.dispatch({ type: 'preparation.confirm' });
        } catch {
          // Falls through.
        }
      }
    }

    let said: string | null = null;
    try {
      await context.waitFor(
        'the app to say the film has gone',
        PREPARE_WAIT_MS,
        (snapshot) => (said = snapshot.notice?.message ?? null) !== null,
      );
    } catch {
      // Falls through.
    }
    assertions.push(
      assertion(
        'sourceGoneCaughtARunningJob',
        'eq',
        'yes',
        jobRunning ? 'yes' : 'no',
        'bool',
        'read from ffmpeg’s own start record, not from a flag the engine set before spawning it. A "no" means P7 was never tested, so it is a promise rather than an observation — a run that could not produce the condition must not pass quietly',
      ),
      observation(
        'sourceRemovedDuringTheJob',
        removedDuringJob ? 'yes' : 'no — Windows refused to unlink a file ffmpeg had open',
        'bool',
        'a "no" means the *literal* wording of P7 could not be produced on this platform and the job was stopped before the film was removed. The product path, the sentence and the cleanup are still exercised; the mid-job removal is human checklist territory — a pulled USB drive or a dropped share',
      ),
      assertion(
        'sourceGoneDuringJobMessage',
        'eq',
        'The original file is no longer where it was.',
        said,
        'message',
        'PRD P7: M2’s existing sentence — no new vocabulary for a failure the founder has already met',
      ),
      // The source is gone — the scenario deleted it — so the folder should now be empty.
      // A `.partial` here is P7's cleanup having failed with gigabytes on the founder's disk.
      folderAssertion('sourceGoneLeftNothing', [], await contentsOf(work.dir)),
    );

    // --- P3: a conversion that fails, retried once ---
    //
    // The condition this harness cannot reliably produce. ffmpeg is forgiving: a truncated
    // file is usually converted successfully up to the truncation, and a file it refuses
    // outright is refused by *ffprobe* first and becomes 7d instead. So it is attempted,
    // and if the conversion succeeds anyway that is reported as an observation rather than
    // dressed up as a pass — **checklist item 4 is where P3 is actually proved.**
    const damaged = path.join(work.dir, 'Damaged fixture.mp4');
    await makeTenBitClip(context.filePath, damaged);
    const bytes = await fsp.readFile(damaged);
    // Keep the header — ffprobe must still accept it, or this becomes 7d — and destroy the
    // middle, which is where the picture is.
    for (let index = Math.floor(bytes.length * 0.3); index < bytes.length; index += 1) {
      bytes[index] = 0;
    }
    await fsp.writeFile(damaged, bytes);

    const attemptsBefore = context
      .records()
      .filter((r) => r['event'] === 'ffmpeg.job_started').length;
    await chooseAndCheck(context, damaged);
    const damagedVerdict = context.snapshot().file?.verdict?.kind ?? null;
    if (damagedVerdict === 'impossible') {
      assertions.push(
        observation(
          'damagedFileRefusedAtCheck',
          'yes',
          'bool',
          'ffprobe rejected the damaged file, so this became 7d rather than P3 — P3 is checklist item 4',
        ),
      );
      return assertions;
    }

    context.engine.dispatch({ type: 'cast.start' });
    if (context.snapshot().file?.verdict?.requiresConfirmation === true) {
      try {
        await context.waitFor(
          'the long-job confirmation',
          SELFTEST.stateWaitMs,
          (snapshot) => snapshot.file?.verdict?.confirmation != null,
        );
        context.engine.dispatch({ type: 'preparation.confirm' });
      } catch {
        // Falls through.
      }
    }
    try {
      await context.waitFor(
        'the job to finish, one way or the other',
        PREPARE_WAIT_MS,
        (snapshot) => snapshot.notice !== null || snapshot.session.state === 'playing',
      );
    } catch {
      // Falls through.
    }
    const attempts =
      context.records().filter((r) => r['event'] === 'ffmpeg.job_started').length - attemptsBefore;
    const failed = context.snapshot().notice?.message ?? null;
    assertions.push(
      observation(
        'damagedFileOutcome',
        failed ?? `converted anyway (${context.snapshot().session.state})`,
        'outcome',
        'ffmpeg is forgiving of a truncated file; if it converted this one, P3 was not produced and is checklist item 4',
      ),
      observation(
        'damagedFileAttempts',
        attempts,
        'runs',
        'P3 retries exactly once before the founder is told anything, so a genuine failure shows 2 here',
      ),
    );
    if (failed !== null) {
      assertions.push(
        assertion(
          'conversionFailureAttempts',
          'eq',
          2,
          attempts,
          'runs',
          'PRD P3: retried once automatically before the founder is told anything',
        ),
        assertion(
          'conversionFailureIsPlain',
          'eq',
          'yes',
          /^Couldn’t prepare .+\.$/.test(failed) ? 'yes' : 'no',
          'bool',
          'PRD P3: "Couldn’t prepare <filename>" with the detail in the log and not on the screen',
        ),
      );
    }
    return assertions;
  } finally {
    context.engine.dispatch({ type: 'cast.stop' });
    await work.cleanup();
  }
}
