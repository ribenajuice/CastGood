import type { DeviceProfile, ProfileId } from '../types.js';
import type { VideoEncoder } from './encoders.js';

/**
 * **What we encode to, as data.** One versioned table, named entries, no flags accumulating
 * in a string somewhere.
 *
 * This file exists because of a decision rather than a convenience. The 2026-08-19 encoder
 * ADR rejected HandBrake and its maintained device presets, and it did so on the condition
 * that we take the knowledge instead of the dependency: *"we write our own output-profile
 * table — named, versioned entries, keyed to the capability profile, **data not code, in one
 * file**, and it is the value prepared artifacts are keyed by. HandBrake's published preset
 * JSON is read as reference material when we pick those numbers, and cited in the table."*
 * So the numbers below are cited, and the reason each one is what it is is written down.
 *
 * ## The one thing that makes these numbers easy
 *
 * CastGood streams over a gigabit LAN from a local disk to a television in the same house.
 * Nothing is uploaded, nothing is stored on a phone, nothing crosses the internet. **Quality
 * per byte is worth almost nothing to us and speed is worth a great deal** — the founder is
 * sitting in front of the app waiting to watch a film. That single fact is why a generous
 * CRF and a fast preset are right here and would be wrong in a general-purpose encoder, and
 * it is the reason preset tuning — the thing HandBrake is famous for — buys us nothing.
 *
 * ## Why the id matters
 *
 * The 2026-08-19 sibling ADR keys a prepared artifact by *"the classifier returns Tier 1 for
 * the chosen device"*, derived from the file itself rather than remembered about it. The id
 * here is therefore **not** how an artifact is matched — it is how a *run* is described in
 * the log, so that a film that looks wrong on a television can be traced to the exact
 * settings that produced it. Change the numbers, change the id: an entry whose meaning has
 * drifted from its name is worse than no name.
 */

export interface OutputProfile {
  /** Versioned name. Appears in the log on every job; **never** on screen. */
  readonly id: string;
  /** ffmpeg arguments for the video encoder, when the picture is being re-encoded. */
  readonly videoArgs: readonly string[];
  /** ffmpeg arguments for the audio encoder, when the sound is being re-encoded. */
  readonly audioArgs: readonly string[];
  /**
   * The box the picture is scaled into when it is bigger, in **both** dimensions.
   *
   * Width matters as much as height, and assuming otherwise is how a 4K film broke. H.264's
   * `-level 4.1` is a limit on **macroblocks**, not on height: a 3840×1604 film scaled to
   * 1080 tall is still 2586 wide, which is 11,016 macroblocks against the level's 8,192 —
   * over the limit and refused, exactly as the unscaled frame was. A film is only safe when
   * it fits inside the box, aspect preserved.
   *
   * `null` on both means the picture is never touched.
   */
  readonly maxWidth: number | null;
  readonly maxHeight: number | null;
  /** Why these numbers. Read this before changing any of them. */
  readonly note: string;
}

/**
 * The only entry M3a needs, and the one every unfamiliar television gets.
 *
 * - **`libx264 -preset veryfast -crf 20`.** `veryfast` is the fastest preset that still
 *   produces a picture nobody would describe as soft at this bitrate, and it is roughly an
 *   order of magnitude quicker than `medium` — the difference between a film prepared over
 *   dinner and one prepared overnight. CRF 20 is one step better than x264's default 23,
 *   spending disk we have to protect a picture we cannot get back. *(HandBrake's "Chromecast
 *   1080p30 Surround" preset is x264 at RF 22, `veryfast`, and is the reference these were
 *   chosen against; we spend two CRF points more because we are not optimising for size.)*
 * - **`-profile:v high -level 4.1`.** Exactly the conservative baseline of the 2026-08-13
 *   capability ADR, so the output is playable on *every* Cast device in the house rather
 *   than only the one it was prepared for. That is what makes the sibling ADR's "preparation
 *   only ever narrows" true in practice: a narrower artifact still plays on every wider
 *   device, so one file converges instead of thrashing between two.
 * - **`-pix_fmt yuv420p`.** A 10-bit or 4:2:2 source re-encoded without this stays 10-bit,
 *   which the baseline profile does not allow and which a television refuses at load with
 *   the diagnostic-free `LOAD_FAILED` the HLS ADR is about. One flag, one whole class of
 *   evening lost.
 * - **`-g 96` (4 s at 24 fps).** M3a does not need keyframes for anything. M3b's growing
 *   playlist does — the HLS ADR measures every extra second of `TARGETDURATION` as three
 *   seconds of lost seek horizon — and a conversion that produced a 13-second GOP would
 *   have to be redone for it. Costing nothing now to avoid re-encoding every film later.
 * - **AAC-LC at 192 kbps, stereo.** The baseline profile's audio is `aac`/`mp3`, and 5.1
 *   sources are downmixed rather than passed through: a television that cannot decode the
 *   source's E-AC-3 is exactly the case this tier exists for, and a multichannel AAC track
 *   is a second thing for it to refuse. 192 kbps stereo is transparent for a film.
 */
export const BASELINE_OUTPUT: OutputProfile = {
  id: 'h264-high41-1080p-aac-v1',
  videoArgs: [
    '-c:v',
    'libx264',
    '-preset',
    'veryfast',
    '-crf',
    '20',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '96',
  ],
  audioArgs: ['-c:a', 'aac', '-b:a', '192k', '-ac', '2'],
  maxWidth: 1920,
  maxHeight: 1080,
  note: 'Conservative baseline: plays on every Cast device we know of, including ones we have never met.',
};

/**
 * NVIDIA's encoder, measured and adopted on 2026-08-20 — the entry the 2026-08-19 encoder
 * ADR reserved a place for and refused to fill from documentation.
 *
 * **Everything here was earned rather than looked up.** SPIKE-5 held file size still and
 * compared pictures with VMAF: at 13.5 MB against 13.6 MB, nvenc scored **85.03 to
 * libx264's 84.33** — ahead by less than the one point at which a difference becomes
 * detectable at all — and the founder, shown both on a television, could not tell them
 * apart. Over a whole 113-minute film it managed **809.3 Mpx/s in 6.6 minutes** against the
 * software path's 258–299 in 18–21. Same size, same picture, **2.7–3.1× the speed.**
 *
 *  - **`-cq 25`, and the number is not a guess.** 23 was what the spike started with; 25 is
 *    the value whose output landed on the software path's file size, which is what makes
 *    the quality comparison mean anything and what stops prepared files quietly growing.
 *  - **`-preset p4`.** NVENC's presets trade encode time for efficiency and p4 is the
 *    middle; the measurements above are all at p4, so it is the one they vouch for.
 *  - **`-profile:v high`, `-pix_fmt yuv420p`, `-level 4.1`** are the same conservative
 *    baseline the software entry targets, for the same reason: one artifact every
 *    television in the house can play. `h264_mf` was rejected precisely for silently
 *    emitting Constrained Baseline instead.
 *  - **`-g 96`** matches the software entry, so M3b's segment boundaries do not depend on
 *    which encoder happened to run.
 *
 * The output was cast to the `AI PONT` — the third-party set, the fussiest device in the
 * house — and played to the end through two seeks before this entry was written.
 */
export const NVENC_OUTPUT: OutputProfile = {
  id: 'h264-nvenc-high41-1080p-aac-v1',
  videoArgs: [
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p4',
    '-cq',
    '25',
    '-profile:v',
    'high',
    '-level',
    '4.1',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '96',
  ],
  audioArgs: BASELINE_OUTPUT.audioArgs,
  maxWidth: 1920,
  maxHeight: 1080,
  note: 'NVIDIA hardware encoding: same size and picture as the software path, 2.7-3.1x faster.',
};

/**
 * Which output profile for this television, on this machine?
 *
 * The device profile decides *what shape* the output has to be; the encoder decides *what
 * produces it*. They are separate arguments because they answer separate questions — a
 * television narrower than the baseline (layer 3 of the capability model, criterion 7e)
 * will one day need an entry of its own, whichever encoder is running.
 *
 * `encoder` comes from `detectVideoEncoder`, which finds out by **opening** an encoder
 * rather than by reading a capability list. Anything unrecognised falls back to the
 * software path, which is always present and always works.
 */
export function outputProfileFor(
  _profile: DeviceProfile,
  encoder: VideoEncoder = 'libx264',
): OutputProfile {
  return encoder === 'h264_nvenc' ? NVENC_OUTPUT : BASELINE_OUTPUT;
}

/** For the log line that names what a job actually ran with. */
export function describeOutputProfile(profile: OutputProfile, deviceProfile: ProfileId): string {
  return `${profile.id} for ${deviceProfile}`;
}
