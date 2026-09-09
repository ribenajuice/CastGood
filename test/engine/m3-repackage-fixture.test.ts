import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPACKAGE_FIXTURE_CHANNELS,
  channelsAboveLimit,
  describePicture,
  fixturePictureFor,
  profileFor,
  tierTakenFor,
  whyPictureIsOutside,
  type FixturePicture,
  type ProbedPicture,
} from '../../src/engine/selftest/m3.js';
import { SelftestAbort, assertion } from '../../src/engine/selftest/kit.js';
import { classify } from '../../src/engine/prepare/classify.js';
import { BASELINE_PROFILE, MODEL_TABLE } from '../../src/engine/prepare/device-profiles.js';
import type { DeviceProfile, VideoCapability } from '../../src/engine/types.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * **Can `m3` be graded in one run, and is the fixture that makes it possible still able to
 * fail?**
 *
 * The defect, measured on the `Family room TV` on 2026-08-28 and recorded in `docs/STATUS.md`:
 * `--scenario m3` exited **2** on both of the founder's two kinds of film, at opposite ends.
 * On the 4K HEVC film `check` scored 12/12 and `remux` stopped — *"this television will not
 * carry the picture in the stereo Matroska fixture as it stands"*. On the H.264 film 42
 * assertions passed and `headstart` stopped — *"head start only applies to a film this
 * television has to convert"*. **Both legs take the same `--file`**, they need opposite
 * films, and a definition-of-done clause in M3b requires the aggregate to run in full.
 *
 * The cause was one line: `makeMkvClip` stream-copied the picture out of the film passed on
 * the command line, so an unplayable picture went into the Tier 2 fixture and came straight
 * back out. QA had already pinned it on 2026-08-24 — *"the Matroska legs still carry the
 * founder's own resolution — the defect is only side-stepped"* — as a thing that would bite
 * a Nest Hub. It bit the founder's own television first.
 *
 * The scenarios need ffmpeg, a real set and twenty minutes, none of which exist in WSL. What
 * is exercisable here is the arithmetic the fixture is built from, and it is exactly where
 * the defect lived. Two questions, both asked against the **real classifier** and the **real
 * profile table**:
 *
 *  1. **Is the fixture Tier 2 on every television, for every film the founder might pass?**
 *     That is the claim that makes `m3` runnable in one go.
 *  2. **Is it still a fixture that can fail?** A re-encoded fixture that quietly sidesteps
 *     the condition it exists to test would be the twelfth time this project has been burned
 *     by a harness kinder than the house. So the cases below check that the file is Tier 2
 *     *because of its box and nothing else*, that a broken repackage still goes red, and that
 *     a leg which genuinely cannot produce its condition still exits 2.
 */

const PROFILES: readonly (readonly [string, DeviceProfile])[] = [
  ['baseline (every television nobody has met)', BASELINE_PROFILE],
  ...MODEL_TABLE.map(
    (entry) =>
      [entry.models[0] ?? entry.profile.id, entry.profile] as readonly [string, DeviceProfile],
  ),
];

/**
 * **The films the founder might pass on the command line**, as the picture inside them.
 *
 * The whole point of the fix is that this list stops mattering to the repackage legs, so it
 * is deliberately the widest it can be: the H.264 film that used to be the only one `remux`
 * could run against, the 4K HEVC film that killed the run on 2026-08-28, and two codecs no
 * profile in the table carries at all.
 */
const FILMS: readonly (readonly [string, Record<string, unknown>])[] = [
  [
    'How To Train Your Dragon — 720p H.264, the film that worked',
    { codec_name: 'h264', profile: 'High', level: 31, width: 1_280, height: 720 },
  ],
  [
    'All Quiet — 4K HEVC 10-bit, the film that stopped the run',
    {
      codec_name: 'hevc',
      profile: 'Main 10',
      level: 150,
      width: 3_840,
      height: 2_160,
      pix_fmt: 'yuv420p10le',
    },
  ],
  [
    'an AV1 download',
    { codec_name: 'av1', profile: 'Main', level: 8, width: 1_920, height: 1_080 },
  ],
  ['a VP9 download', { codec_name: 'vp9', profile: 'Profile 0', width: 1_920, height: 1_080 }],
];

/**
 * **The picture `makeMkvClip` and `makeMp4Clip` now write, as ffprobe would report it.**
 *
 * Transcribed from `videoArgsFor` — `-c:v libx264 -profile:v <profile> -pix_fmt yuv420p`,
 * scaled and padded into `picture.width × picture.height`, `-r picture.frameRate` — and the
 * transcription is pinned against the shipping source at the bottom of this file, because a
 * fixture describing a file nobody builds any more is the classic way a test goes on passing
 * about nothing.
 *
 * `level` is a parameter because **libx264 chooses the level itself**. Every case that cares
 * sweeps it rather than asserting one value, which is also why the shipped gate probes the
 * built file instead of trusting the command line.
 */
function builtPicture(picture: FixturePicture, level = 31): fixture.StreamJson {
  return fixture.videoStream({
    codec_name: 'h264',
    profile:
      picture.h264Profile === 'high'
        ? 'High'
        : picture.h264Profile === 'main'
          ? 'Main'
          : 'Baseline',
    level,
    width: picture.width,
    height: picture.height,
    coded_width: picture.width,
    coded_height: picture.height,
    pix_fmt: 'yuv420p',
    r_frame_rate: `${String(picture.frameRate)}/1`,
    avg_frame_rate: `${String(picture.frameRate)}/1`,
  });
}

const soundOf = (channels: number): fixture.StreamJson =>
  fixture.audioStream({
    channels,
    channel_layout: channels === 2 ? 'stereo' : channels === 6 ? '5.1' : '7.1',
  });

/** The Tier 2 fixture the repackage legs build for one television. */
const repackageFixture = (profile: DeviceProfile, channels: number, level = 31): unknown =>
  fixture.report({
    formatName: 'matroska,webm',
    streams: [builtPicture(fixturePictureFor(profile, 'x'), level), soundOf(channels)],
  });

/** The same streams in the box every Chromecast plays — the control, not a fixture. */
const sameStreamsInMp4 = (profile: DeviceProfile, channels: number, level = 31): unknown =>
  fixture.report({
    streams: [builtPicture(fixturePictureFor(profile, 'x'), level), soundOf(channels)],
  });

/** A `ProbedPicture` as the shipped gate would read it back out of a built fixture. */
function probedOf(picture: FixturePicture, overrides: Partial<ProbedPicture> = {}): ProbedPicture {
  return {
    codec: 'h264',
    profile: picture.h264Profile === 'high' ? 'High' : 'Main',
    level: 31,
    width: picture.width,
    height: picture.height,
    frameRate: picture.frameRate,
    pixelFormat: 'yuv420p',
    ...overrides,
  };
}

// --- 1. The claim that makes `m3` runnable in one go -------------------------

describe('the Tier 2 fixture is a repackage on every television, whatever film was passed', () => {
  it('is judged `remux` for every profile in the table and every film in the founder’s library', () => {
    // The defect, stated as a sweep. Before the fix the fixture carried the passed film's
    // own picture, so this table would be `convert` for the HEVC, AV1 and VP9 rows on every
    // profile but the Ultra's and the Google TV's — and `remux` had nothing to grade.
    //
    // The film is now irrelevant to the fixture by construction, so the sweep is over
    // profiles alone and the films are named only to record that the answer no longer
    // depends on them.
    for (const [television, profile] of PROFILES) {
      for (const [film] of FILMS) {
        const verdict = classify(
          fixture.probeOf(repackageFixture(profile, REPACKAGE_FIXTURE_CHANNELS)),
          profile,
        );
        expect(verdict.kind, `${television} · ${film}`).toBe('remux');
        // And the picture is carried, which is the gate `tierTakenFor` gets its answer from.
        expect(verdict.detail.video?.supported, `${television} · ${film}`).toBe(true);
        expect(tierTakenFor(verdict.kind, true, 'the stereo Matroska fixture')).toBe('repackage');
      }
    }
  });

  it('and libx264 may pick any level it likes without moving the verdict', () => {
    // The shipped gate measures the built file rather than trusting `-profile:v`, precisely
    // because libx264 chooses the level. If a level inside the profile ever changed the
    // verdict, the repackage leg would be red about the picture on some evenings and not
    // others — the worst kind of instrument.
    for (const [television, profile] of PROFILES) {
      for (const level of [30, 31, 32, 40, 41]) {
        const verdict = classify(
          fixture.probeOf(repackageFixture(profile, REPACKAGE_FIXTURE_CHANNELS, level)),
          profile,
        );
        expect(verdict.kind, `${television} @ level ${String(level)}`).toBe('remux');
      }
    }
  });

  it('and the surround half of the leg is an audio-only conversion, not a picture one', () => {
    // The second fixture the `remux` leg builds: the same picture, the same box, above this
    // television's limit. It is only evidence about the **sound** if the picture is not a
    // second variable — which, before the fix, it was on every HEVC film in the house.
    for (const [television, profile] of PROFILES) {
      const channels = channelsAboveLimit(profile.maxAudioChannels, 'x');
      const verdict = classify(fixture.probeOf(repackageFixture(profile, channels)), profile);
      expect(verdict.kind, television).toBe('convert');
      expect(verdict.detail.video?.supported, television).toBe(true);
      expect(verdict.plan, television).toMatchObject({ video: 'copy', audio: 'aac' });
      expect(tierTakenFor(verdict.kind, true, 'the surround Matroska fixture')).toBe(
        'audio-only conversion',
      );
    }
  });
});

// --- 2. Is it still a fixture that can fail? ---------------------------------

describe('the re-encoded fixture has not sidestepped the condition it exists to test', () => {
  it('is Tier 2 **because of its box** — the identical streams in an MP4 are Ready to cast', () => {
    // The one case that would make the whole leg a lie: a fixture so agreeable that the
    // television would have played it as it stands. Then `remux` would be grading a
    // repackage nobody needed, and a broken `-c copy` would still leave a playable film.
    //
    // Same picture, same sound, different container: `ready` on every profile. So Matroska
    // is doing all the work, which is the definition of Tier 2 — *the packaging is the only
    // thing wrong with it*.
    for (const [television, profile] of PROFILES) {
      expect(
        classify(fixture.probeOf(sameStreamsInMp4(profile, REPACKAGE_FIXTURE_CHANNELS)), profile)
          .kind,
        television,
      ).toBe('ready');
    }
  });

  it('a repackage that turns into a conversion is red, not green', () => {
    // The assertion `remuxTierTaken` makes, with the value a broken product would produce.
    // `-c copy` replaced by a re-encode, a plan that downmixes a stereo film, a classifier
    // that stops recognising Matroska as a packaging fault: all of them land here.
    const red = assertion(
      'remuxTierTaken',
      'eq',
      'repackage',
      tierTakenFor('convert', true, 'the stereo Matroska fixture'),
      'plan',
      'x',
    );
    expect(red.measured).toBe('audio-only conversion');
    expect(red.passed).toBe(false);
    // …and the same assertion against the fixture as shipped is green, so the case above is
    // a real red rather than an assertion that can never pass.
    expect(
      assertion(
        'remuxTierTaken',
        'eq',
        'repackage',
        tierTakenFor('remux', true, 'the stereo Matroska fixture'),
        'plan',
        'x',
      ).passed,
    ).toBe(true);
  });

  it('a repackage that changed the sound is red — the promise a stream copy owes', () => {
    // `remuxArtifactAudioChannels` compares ffprobe of the artifact against ffprobe of the
    // source, not against the device's limit, because a repackage changes **nothing** about
    // the sound. Re-encoding it, downmixing it or dropping the stream are the three ways
    // this goes wrong and all three are caught.
    for (const [name, artifactChannels] of [
      ['re-encoded to surround', 6],
      ['downmixed to mono', 1],
      ['dropped altogether', null],
    ] as const) {
      const red = assertion(
        'remuxArtifactAudioChannels',
        'eq',
        REPACKAGE_FIXTURE_CHANNELS,
        artifactChannels,
        'channels',
        'x',
      );
      expect(red.passed, name).toBe(false);
    }
    expect(
      assertion(
        'remuxArtifactAudioChannels',
        'eq',
        REPACKAGE_FIXTURE_CHANNELS,
        REPACKAGE_FIXTURE_CHANNELS,
        'channels',
        'x',
      ).passed,
    ).toBe(true);
  });

  it('a repackage that changed the running time is red', () => {
    // 8c's other half. A "lossless" copy that lost a minute of film is the failure a
    // duration assertion exists for, and it is unaffected by how the fixture was built.
    expect(assertion('remuxDurationDriftSec', 'lte', 1, 4.2, 's', 'x').passed).toBe(false);
    expect(assertion('remuxDurationDriftSec', 'lte', 1, 0.02, 's', 'x').passed).toBe(true);
  });

  it('and a leg that genuinely cannot produce its condition still exits 2, never 0', () => {
    // The line the fix must not cross. A television narrowed by an earlier refusal below
    // what the table says about it will not carry even this fixture's picture, and the
    // honest answer is still *this run could not happen* — never a green line, and never a
    // red one either, because nothing was measured.
    expect(() => tierTakenFor('convert', false, 'the stereo Matroska fixture')).toThrow(
      SelftestAbort,
    );
    expect(() => tierTakenFor('convert', false, 'the stereo Matroska fixture')).toThrow(
      /no Tier 2 condition here to measure/,
    );
    // And a fixture the set would simply play — the kind one, above — is not graded either.
    expect(() => tierTakenFor('ready', true, 'the stereo Matroska fixture')).toThrow(SelftestAbort);
  });
});

// --- The picture gate itself, in both directions -----------------------------

describe('the picture a fixture is built to comes from the device’s own profile', () => {
  it('fits inside every profile in the table, on every axis it states', () => {
    for (const [television, profile] of PROFILES) {
      const picture = fixturePictureFor(profile, 'x');
      expect(whyPictureIsOutside(probedOf(picture), profile), television).toBeNull();
    }
  });

  it('is not a constant: a smaller television gets a smaller fixture', () => {
    // 7j's rule on the picture side. A 480p set is not in the table today and that is the
    // point — the harness must not need editing the day one arrives, and a hardcoded
    // 720p24 High box is exactly what would.
    const small: DeviceProfile = {
      ...BASELINE_PROFILE,
      id: 'small',
      video: [
        {
          codec: 'h264',
          maxProfile: 'main',
          maxLevel: 30,
          maxWidth: 854,
          maxHeight: 480,
          maxFramerate: 24,
        },
      ],
    };
    expect(fixturePictureFor(small, 'x')).toEqual({
      width: 854,
      height: 480,
      frameRate: 24,
      h264Profile: 'main',
    });
    // …and the everyday answer is still the 720p24 High the `check` leg has been using since
    // 2026-08-24, so nothing about the founder's own televisions changes shape.
    for (const [television, profile] of PROFILES) {
      expect(fixturePictureFor(profile, 'x'), television).toEqual({
        width: 1_280,
        height: 720,
        frameRate: 24,
        h264Profile: 'high',
      });
    }
  });

  it('exits 2 rather than guessing when no fixture it can build fits', () => {
    // The impossibility case, which must be a refusal and not a fixture built anyway. Each
    // of these is a plausible television, and on each of them a repackage leg would be
    // grading a file the set was always going to refuse for its picture.
    const withVideo = (video: readonly VideoCapability[]): DeviceProfile => ({
      ...BASELINE_PROFILE,
      id: 'awkward',
      video,
    });
    const noH264 = withVideo([
      { codec: 'vp9', maxWidth: 3_840, maxHeight: 2_160, maxFramerate: 60 },
    ]);
    const tiny = withVideo([{ codec: 'h264', maxWidth: 640, maxHeight: 360, maxFramerate: 30 }]);
    const slow = withVideo([
      { codec: 'h264', maxWidth: 1_920, maxHeight: 1_080, maxFramerate: 10 },
    ]);
    for (const profile of [noH264, tiny, slow]) {
      expect(() => fixturePictureFor(profile, 'the Matroska fixture')).toThrow(SelftestAbort);
    }
    expect(() => fixturePictureFor(noH264, 'the Matroska fixture')).toThrow(/no H.264 capability/);
    expect(() => fixturePictureFor(tiny, 'the Matroska fixture')).toThrow(
      /no fixture this harness can build fits inside it/,
    );
  });

  it('and the gate that reads the built file back really does refuse — every axis, watched red', () => {
    // The gate is only worth having if it can say no. Each of these is a real way a fixture
    // comes out wrong on a real machine: an ffmpeg without libx264 that fell back to another
    // encoder, a `-vf` that was dropped, a level libx264 picked above the profile, a
    // `-pix_fmt` that was ignored, `-r` that did not apply.
    const profile = BASELINE_PROFILE;
    const picture = fixturePictureFor(profile, 'x');
    const cases: readonly (readonly [string, Partial<ProbedPicture>, RegExp])[] = [
      ['another encoder entirely', { codec: 'hevc' }, /does not list that codec/],
      ['the scaler dropped', { width: 3_840, height: 2_160 }, /wider than/],
      ['a tall picture the scaler missed', { width: 1_280, height: 2_160 }, /taller than/],
      ['a frame rate that did not apply', { frameRate: 60 }, /faster than/],
      ['a level above the profile', { level: 51 }, /level is above/],
      ['a codec profile above the profile', { profile: 'High 10' }, /richer than/],
      ['10-bit, the `convert` fixture by mistake', { pixelFormat: 'yuv420p10le' }, /8-bit 4:2:0/],
    ];
    for (const [name, broken, reason] of cases) {
      const why = whyPictureIsOutside(probedOf(picture, broken), profile);
      expect(why, name).not.toBeNull();
      expect(why ?? '', name).toMatch(reason);
    }
    // The control: unbroken, it says nothing.
    expect(whyPictureIsOutside(probedOf(picture), profile)).toBeNull();
    expect(describePicture(probedOf(picture))).toContain('1280×720');
  });

  it('refuses to build a fixture for a television it cannot see, rather than guessing', () => {
    // The same argument `channelLimitFor` makes, now made once for the whole profile: an
    // instrument that invents a failure costs somebody an evening.
    const devices = [{ id: 'living-room', model: 'AI PONT' }];
    expect(profileFor(devices, 'living-room').maxAudioChannels).toBe(6);
    expect(() => profileFor(devices, 'bedroom')).toThrow(SelftestAbort);
    expect(() => profileFor(devices, 'bedroom')).toThrow(/built against a guess/);
  });
});

// --- The transcription pin ---------------------------------------------------

describe('the shipped fixtures are still the ones this file describes', () => {
  const source = fsSync.readFileSync(
    fileURLToPath(new URL('../../src/engine/selftest/m3.ts', import.meta.url)),
    'utf8',
  );

  it('`makeMkvClip` builds its picture and no longer stream-copies the film it was given', () => {
    // The defect, named so it cannot come back unnoticed. `-map 0 -c copy` is what made an
    // unplayable picture pass straight through the Tier 2 fixture on 2026-08-28.
    const clip = source.slice(
      source.indexOf('async function makeMkvClip'),
      source.indexOf('async function makeMp4Clip'),
    );
    expect(clip.length).toBeGreaterThan(200);
    expect(clip).toContain('videoArgsFor(picture)');
    expect(clip).toContain('audioArgsFor(channels)');
    expect(clip).toContain("'matroska'");
    expect(clip).not.toContain("'-c',\n      'copy'");
  });

  it('`makeMp4Clip` takes the same picture, so `check` and the repackage legs agree', () => {
    const clip = source.slice(
      source.indexOf('async function makeMp4Clip'),
      source.indexOf('async function makeTenBitClip'),
    );
    expect(clip.length).toBeGreaterThan(200);
    expect(clip).toContain('videoArgsFor(picture)');
    expect(clip).not.toContain('scale=1280:720');
  });

  it('and `videoArgsFor` still writes the geometry this file transcribes', () => {
    const args = source.slice(
      source.indexOf('function videoArgsFor'),
      source.indexOf('// --- Producing the conditions'),
    );
    expect(args.length).toBeGreaterThan(200);
    for (const token of [
      "'libx264'",
      "'-profile:v',\n    picture.h264Profile",
      "'yuv420p'",
      'force_original_aspect_ratio=decrease',
      "'-r',\n    String(picture.frameRate)",
    ]) {
      expect(args, `videoArgsFor no longer says ${token}`).toContain(token);
    }
  });

  it('every leg that builds a Matroska fixture measures its picture before using it', () => {
    // Three call sites — the repackage leg, its surround half, the `prepared` leg and 9c's
    // replacement — and a fourth that forgot would be a leg back to grading whatever it was
    // handed. Counted rather than named, so a new leg is caught too.
    const builds = source.match(/await makeMkvClip\(/g) ?? [];
    const gates = source.match(/requirePictureInside\(/g) ?? [];
    expect(builds.length).toBeGreaterThanOrEqual(4);
    // One definition plus one call per Matroska fixture, plus the two MP4 halves of `check`.
    expect(gates.length).toBeGreaterThanOrEqual(builds.length + 1);
  });
});
