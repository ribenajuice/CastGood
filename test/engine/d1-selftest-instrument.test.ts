import { describe, expect, it } from 'vitest';
import {
  REPACKAGE_FIXTURE_CHANNELS,
  channelLimitFor,
  channelsAboveLimit,
  tierTakenFor,
} from '../../src/engine/selftest/m3.js';
import { SelftestAbort, assertion, compare } from '../../src/engine/selftest/kit.js';
import {
  classify,
  describeApproxBytes,
  isReusableArtifact,
} from '../../src/engine/prepare/classify.js';
import {
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
} from '../../src/engine/prepare/device-profiles.js';
import type { DeviceProfile } from '../../src/engine/types.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * **Is the instrument capable of the verdict it prints?**
 *
 * `d1-audio-channels.test.ts` and QA's rail both grade the *product*. This file grades the
 * thing that grades the product on hardware: the `m3` selftest's fixtures, its channel
 * target and its tier gate. Every case here comes from a defect QA found in round 1 of D1,
 * and each one has the same shape — an instrument that could not fail, or one that could
 * only fail wrongly.
 *
 *  - A `remux` scenario whose fixture is 5.1 never enters the Tier 2 branch on any device
 *    the founder owns, so breaking `-c copy` outright still exited 0.
 *  - A channel limit that falls back to 2 for a device it cannot name **invents** a failure
 *    on the one television that legitimately plays 5.1.
 *  - A pre-D1 artifact manufactured at a constant 6 channels is a file that television is
 *    right to reuse, so 7l's leg would have demanded a re-preparation that must not happen.
 *
 * **Which television that is changed on 2026-08-24 and the defects did not.** Both of those
 * last two were written about the Chromecast Ultra, on a `maxAudioChannels: 6` inferred from
 * `ac3`/`eac3` in its codec list; hardware measured the Ultra at 2 and the founder's
 * `AI PONT` at 6, so the cases below name the `AI PONT` instead. That is the strongest
 * argument this file makes for its own existence: an instrument carrying a constant would
 * still be grading the Ultra against 6 tonight, and nothing would say so.
 *
 * The scenarios themselves need ffmpeg, a real television and twenty minutes, so what is
 * unit-testable is the arithmetic underneath them — which is exactly the part that was
 * wrong. Every fixture channel count below is fed through the **real classifier** against
 * the **real profile table**, so a case passes only if the television in the founder's
 * house would really behave that way.
 */

/** Every profile a run can be graded against: the floor plus every entry in the table. */
const PROFILES: readonly (readonly [string, DeviceProfile])[] = [
  ['baseline (every set nobody has met — no longer the AI PONT, see 7j)', BASELINE_PROFILE],
  ...MODEL_TABLE.map(
    (entry) =>
      [entry.models[0] ?? entry.profile.id, entry.profile] as readonly [string, DeviceProfile],
  ),
];

/**
 * A picture this profile carries, so that **the sound is the only variable** below.
 *
 * The founder's film is 1080p and a Nest Hub's box is 720p, so a fixed 1920×1080 fixture is
 * a conversion on that device for a reason that has nothing to do with D1 — and it would
 * mask the thing every case here is about. (It is also the pre-existing `outputProfileFor`
 * defect QA pinned separately: a Nest Hub re-prepares the same film for ever. Not this
 * change's, and deliberately not papered over here either — it is simply not the variable.)
 */
function pictureInside(profile: DeviceProfile): fixture.StreamJson {
  const h264 = profile.video.find((capability) => capability.codec === 'h264');
  const width = Math.min(1920, h264?.maxWidth ?? 1920);
  const height = Math.min(1080, h264?.maxHeight ?? 1080);
  return fixture.videoStream({ width, height, coded_width: width, coded_height: height });
}

const soundOf = (channels: number): fixture.StreamJson =>
  fixture.audioStream({ channels, channel_layout: channels > 2 ? '5.1' : 'stereo' });

/** The Matroska clip `makeMkvClip` builds, as ffprobe would report it. */
const mkvClip = (profile: DeviceProfile, channels: number): unknown =>
  fixture.report({
    formatName: 'matroska,webm',
    streams: [pictureInside(profile), soundOf(channels)],
  });

/** An MP4 of this profile's own picture: Tier 1 but for its sound. */
const mp4Clip = (profile: DeviceProfile, channels: number): unknown =>
  fixture.report({ streams: [pictureInside(profile), soundOf(channels)] });

/**
 * What `makeMp4Clip` actually writes for the `check` pair, as ffprobe would report it:
 * **720p24 H.264 High**, letterboxed into the smallest box any profile in the table states.
 *
 * Fixed rather than profile-shaped, because that is the point of it — one fixture that is
 * Tier 1 on every television in the house, so a run against an HEVC film (which is all of
 * the founder's) still has a control the device calls *Ready to cast* and the leg can
 * isolate the sound instead of exiting 2.
 */
const checkClip = (channels: number): unknown =>
  fixture.report({
    streams: [
      fixture.videoStream({
        width: 1280,
        height: 720,
        coded_width: 1280,
        coded_height: 720,
        level: 31,
        r_frame_rate: '24/1',
        avg_frame_rate: '24/1',
      }),
      soundOf(channels),
    ],
  });

// --- Defect 1: the leg named after Tier 2 has to reach Tier 2 ----------------

describe('the repackage leg’s fixture is a repackage on every television in the house', () => {
  it('is judged Tier 2 by every profile, not only the ones that decode 5.1', () => {
    // The round-1 regression, stated as the property it broke: with `-ac 6` this loop is
    // red for the baseline, the plain Chromecast and both Nest Hubs — four of the five
    // profiles, and every device the founder owns bar one. A `remux` scenario that never
    // reaches `kind: 'remux'` cannot notice a broken stream copy.
    for (const [name, profile] of PROFILES) {
      const verdict = classify(
        fixture.probeOf(mkvClip(profile, REPACKAGE_FIXTURE_CHANNELS)),
        profile,
      );
      expect(verdict.kind, `${name} did not repackage the repackage leg’s fixture`).toBe('remux');
      expect(verdict.plan.kind, `${name} did not plan a stream copy`).toBe('remux');
    }
  });

  it('is inside every profile’s limit, which is the reason it gets there', () => {
    for (const [name, profile] of PROFILES) {
      expect(REPACKAGE_FIXTURE_CHANNELS, `${name}`).toBeLessThanOrEqual(profile.maxAudioChannels);
    }
  });
});

describe('the tier gate never calls a conversion a repackage', () => {
  it('names the audio-only conversion as itself', () => {
    expect(tierTakenFor('convert', true, 'x')).toBe('audio-only conversion');
    expect(tierTakenFor('remux', true, 'x')).toBe('repackage');
  });

  it('grades the repackage leg against `repackage`, so a conversion there is red', () => {
    // The assertion the scenario actually pushes, built here from the same helper. An
    // observation cannot fail; this can, and on a 2-channel television it *would* have with
    // the round-1 fixture — which is the whole of QA's finding.
    const taken = tierTakenFor('convert', true, 'the stereo Matroska fixture');
    const graded = assertion('remuxTierTaken', 'eq', 'repackage', taken, 'plan');
    expect(graded.kind).toBe('promise');
    expect(graded.passed).toBe(false);
  });

  it('exits 2 rather than 1 when the picture is why there is no Tier 2 job', () => {
    // An HEVC film on a baseline television: no pairing of this file and this device can
    // produce a Tier 2 condition, so the run could not happen rather than failed.
    expect(() => tierTakenFor('convert', false, 'the fixture')).toThrow(SelftestAbort);
    expect(() => tierTakenFor('ready', true, 'the fixture')).toThrow(SelftestAbort);
    expect(() => tierTakenFor(null, true, 'the fixture')).toThrow(SelftestAbort);
  });
});

// --- Defect 2: the limit the instrument grades against -----------------------

describe('the channel limit an artifact is graded against is never a guess', () => {
  it('reads the television’s own profile when it can see the device', () => {
    // **The two numbers here swapped on 2026-08-24 and the property did not move.** What is
    // asserted is that the instrument reads the *engine's* table rather than carrying a
    // constant of its own; the correction is the strongest possible evidence for why, since
    // a hardcoded 6 for the Ultra would now be grading every artifact on that television
    // against a limit the engine stopped believing.
    expect(channelLimitFor([{ id: 'tv-1', model: 'Chromecast Ultra' }], 'tv-1')).toBe(2);
    expect(channelLimitFor([{ id: 'tv-1', model: 'Chromecast' }], 'tv-1')).toBe(2);
    // The founder's main television has its own entry since item 8b (7j) — measured at 6,
    // and the only limit above stereo the table now holds.
    expect(channelLimitFor([{ id: 'tv-1', model: 'AI PONT' }], 'tv-1')).toBe(6);
    expect(channelLimitFor([{ id: 'tv-1', model: null }], 'tv-1')).toBe(2);
  });

  it('aborts the run when the device is not in the snapshot, rather than falling back to 2', () => {
    // The one direction the round-1 safety claim did not hold. `modelProfile('')` is 2, so
    // a device the snapshot has lost was graded as a stereo set.
    //
    // The refusal now covers the **whole profile** rather than the channel limit alone — as
    // of 2026-08-28 the picture in every fixture is built from the same table entry — so the
    // sentence names the fixtures as well as the assertions. The rule is unchanged: not
    // knowing which television this is means the measurement could not be taken.
    expect(() => channelLimitFor([], 'tv-gone')).toThrow(SelftestAbort);
    expect(() => channelLimitFor([{ id: 'other', model: 'Chromecast Ultra' }], 'tv-gone')).toThrow(
      /could not determine the capabilities of device/,
    );
  });

  it('does not invent a failure for an `AI PONT` playing a correct 5.1 remux', () => {
    // 8f as the scenario grades it: `lte` the limit, measured by ffprobe of the artifact.
    // A legitimate 5.1 repackage for a set that decodes 5.1 passes against that set's 6 and
    // fails against the baseline's 2 — so a fallback is not a conservative guess, it is a
    // red line on a correct file, in the instrument everything else is graded by.
    //
    // Written about the Ultra until hardware measured it at 2 on 2026-08-24. The invented
    // failure this guards against needs a device the engine really would let keep its
    // surround, and the `AI PONT` is now the only one; on the Ultra the assertion below
    // would be *correctly* red, which proves nothing about fallbacks.
    const aiPontProfile = modelProfile('ai pont');
    expect(compare('lte', 6, aiPontProfile.maxAudioChannels)).toBe(true);
    expect(compare('lte', 6, modelProfile('').maxAudioChannels)).toBe(false);
    // And the artifact really is one this television should be given: nothing to prepare.
    expect(classify(fixture.probeOf(mp4Clip(aiPontProfile, 6)), aiPontProfile).kind).toBe('ready');
  });
});

// --- Defect 3 / the 7l artifact: a count this television must refuse ---------

describe('a fixture built to be refused is built above *this* television’s limit', () => {
  it('exceeds the limit of every profile in the table', () => {
    for (const [name, profile] of PROFILES) {
      expect(
        channelsAboveLimit(profile.maxAudioChannels, 'a fixture'),
        `${name} would have been handed a fixture it can decode`,
      ).toBeGreaterThan(profile.maxAudioChannels);
    }
  });

  it('makes the check refuse a file whose only fault is its sound, on every profile', () => {
    // 7i's `[selftest] check` half, as a pair: the same picture in the same box, stereo and
    // above the limit. With a constant 6 the Ultra and the Google TV call the second one
    // *Ready to cast* — the leg passes having tested nothing.
    for (const [name, profile] of PROFILES) {
      const control = classify(fixture.probeOf(checkClip(REPACKAGE_FIXTURE_CHANNELS)), profile);
      expect(control.kind, `${name} would not carry the control fixture`).toBe('ready');

      const over = channelsAboveLimit(profile.maxAudioChannels, 'a fixture');
      const verdict = classify(fixture.probeOf(checkClip(over)), profile);
      expect(verdict.kind, `${name} accepted ${String(over)} channels`).toBe('convert');
      expect(
        verdict.plan.kind === 'transcode' && verdict.plan.video,
        `${name} re-encoded the picture`,
      ).toBe('copy');
      expect(
        verdict.plan.kind === 'transcode' && verdict.plan.audio,
        `${name} kept the sound`,
      ).toBe('aac');
    }
  });

  it('makes 7l’s manufactured pre-D1 artifact one this television really refuses', () => {
    // The stale artifact `prepared` writes in place. At a constant 6 this is *reusable* on
    // an Ultra, so `staleArtifactNotOffered` demanded a re-preparation the product was
    // right not to do: an invented red on the one television that plays 5.1.
    for (const [name, profile] of PROFILES) {
      const source = fixture.probeOf(mkvClip(profile, REPACKAGE_FIXTURE_CHANNELS));
      const stale = fixture.probeOf(
        mp4Clip(profile, channelsAboveLimit(profile.maxAudioChannels, 'a prepared file')),
      );
      expect(isReusableArtifact(source, stale, profile), `${name} reused the stale artifact`).toBe(
        false,
      );
      // …and the replacement the run then writes is accepted, or the film is prepared for ever.
      expect(
        isReusableArtifact(source, fixture.probeOf(mp4Clip(profile, 2)), profile),
        `${name} rejected our own output`,
      ).toBe(true);
    }
  });

  it('exits 2 rather than pass when no rung above the limit can be built', () => {
    // 7.1 is the top of what ffmpeg's native AAC encoder will produce. A television that
    // claimed 8 could not be given a source it refuses, so the run could not happen —
    // never a green line about a condition nothing produced.
    expect(() => channelsAboveLimit(8, 'a fixture')).toThrow(SelftestAbort);
    expect(() => channelsAboveLimit(8, 'a fixture')).toThrow(/no channel assertion/);
    expect(channelsAboveLimit(2, 'a fixture')).toBe(6);
    // **The 8 rung, pinned deliberately after 2026-08-24.** It used to exist for the Ultra;
    // the Ultra is measured at 2 now and the `AI PONT` is the single device that reaches it.
    // The rung is *not* deleted if that ever stops being true — this line, and the sweep
    // above, are what keep its arithmetic honest while it waits for the next device.
    expect(channelsAboveLimit(6, 'a fixture')).toBe(8);
    const aboveStereo = PROFILES.filter(([, profile]) => profile.maxAudioChannels > 2);
    expect(aboveStereo.map(([, profile]) => profile.id)).toEqual(['ai-pont']);
  });
});

// --- The number the `channels: null` ruling is justified by ------------------

describe('what a film whose channel count ffprobe will not state actually costs', () => {
  it('is about six minutes and a full-size duplicate, not "seconds"', () => {
    // `audioSupported`'s comment used to justify the ruling at *"seconds, on a picture
    // stream-copy"*, citing a 22-minute clip. This is the founder-facing cost for a
    // feature-length film on the shipping seeds, and the comment now states these two
    // numbers — so if a seed moves, this goes red beside the comment that quotes it.
    const film = fixture.report({
      streams: [fixture.videoStream(), fixture.unmeasuredAudioStream()],
    });
    const verdict = classify(fixture.probeOf(film), BASELINE_PROFILE);

    expect(verdict.kind).toBe('convert');
    expect(verdict.headline).toBe('Needs converting — about 6 minutes');
    // The picture is copied — that part of the old comment was true — and a copy of the
    // picture is a second copy of the film on the founder's disk.
    expect(verdict.plan.kind === 'transcode' && verdict.plan.video).toBe('copy');
    expect(describeApproxBytes(verdict.estimatedBytes)).toBe('about 4.3 GB');
    expect(verdict.estimatedBytes).toBeGreaterThan(1_000_000_000);
  });

  it('is the same sentence for a 5.1 film on the television that cannot decode it', () => {
    // Not a hypothetical: every HEVC film on the founder's drive is 6-channel, and the
    // `AI PONT` is on the baseline until checklist item 8b says otherwise.
    const verdict = classify(fixture.probeOf(mp4Clip(BASELINE_PROFILE, 6)), BASELINE_PROFILE);
    expect(verdict.headline).toBe('Needs converting — about 6 minutes');
    expect(verdict.reason).toBe(
      'Only the sound has to be converted; the picture is copied across untouched.',
    );
  });
});
