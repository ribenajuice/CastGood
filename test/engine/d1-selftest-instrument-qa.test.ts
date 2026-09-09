import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  REPACKAGE_FIXTURE_CHANNELS,
  channelLimitFor,
  channelsAboveLimit,
  fixturePictureFor,
  tierTakenFor,
} from '../../src/engine/selftest/m3.js';
import { SelftestAbort, compare } from '../../src/engine/selftest/kit.js';
import { classify, isReusableArtifact } from '../../src/engine/prepare/classify.js';
import { buildArgs, type JobRequest } from '../../src/engine/prepare/ffmpeg-job.js';
import { BASELINE_OUTPUT } from '../../src/engine/prepare/output-profiles.js';
import {
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
  narrowAfterRefusal,
  resolveDeviceProfile,
} from '../../src/engine/prepare/device-profiles.js';
import type { DeviceProfile } from '../../src/engine/types.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * **QA's round-2 verification: is the instrument now capable of the verdict it prints?**
 *
 * Round 1 found two defects in the `m3` scenarios and both were fixed in `4a8329f`. This
 * file is the independent check that they are *closed*, written without reusing the
 * developer's helpers or their fixture shapes, plus the sweep their cases do not do.
 *
 * The scenarios need ffmpeg, a television and twenty minutes, none of which exist in WSL.
 * What can be exercised here is every decision the scenarios make **before** they touch a
 * device: which fixture is built, what limit it is graded against, and which verdicts the
 * tier gate accepts. That is precisely where both defects lived.
 *
 * Each case names the edit that makes it fail, and every one of those edits was applied to a
 * scratch checkout and the case watched to go red.
 */

const PROFILES: readonly (readonly [string, DeviceProfile])[] = [
  ['baseline', BASELINE_PROFILE],
  ...MODEL_TABLE.map(
    (entry) => [entry.profile.id, entry.profile] as readonly [string, DeviceProfile],
  ),
];

/**
 * The file the repackage leg builds, described as `ffprobe` would describe it.
 *
 * `makeMkvClip(source, target, 2)` is a stream copy of the picture into Matroska with the
 * sound re-encoded to stereo AAC — so the picture is the founder's, and the two things this
 * leg depends on are the box (Matroska: no profile carries it) and the channel count. The
 * default picture here is the small one, so a sweep over profiles is about the sound; the
 * founder's real 1080p film is exercised in the Nest Hub case at the bottom of this file.
 */
const SMALL_PICTURE: Record<string, unknown> = {
  profile: 'High',
  level: 31,
  width: 1_280,
  height: 720,
  coded_width: 1_280,
  coded_height: 720,
  r_frame_rate: '24/1',
  avg_frame_rate: '24/1',
};

function repackageFixture(
  channels: number,
  video: Record<string, unknown> = SMALL_PICTURE,
): unknown {
  return fixture.report({
    formatName: 'matroska,webm',
    streams: [
      fixture.videoStream(video),
      fixture.audioStream({
        channels,
        channel_layout: channels === 2 ? 'stereo' : channels === 6 ? '5.1' : '7.1',
      }),
    ],
  });
}

/**
 * The file `makeMp4Clip` builds for `check`: 720p24 H.264 High 8-bit in an MP4.
 *
 * The geometry is transcribed from the shipping ffmpeg arguments — `scale=1280:720…pad`,
 * `-r 24`, `-profile:v high`, `-pix_fmt yuv420p`, `-f mp4` — because the whole claim that
 * makes `check`'s pair runnable is that this shape is inside **every** profile in the table.
 */
function checkPairFixture(channels: number, level = 31): unknown {
  return fixture.report({
    streams: [
      fixture.videoStream({
        profile: 'High',
        level,
        width: 1_280,
        height: 720,
        coded_width: 1_280,
        coded_height: 720,
        r_frame_rate: '24/1',
        avg_frame_rate: '24/1',
      }),
      fixture.audioStream({
        channels,
        channel_layout: channels === 2 ? 'stereo' : channels === 6 ? '5.1' : '7.1',
      }),
    ],
  });
}

// --- Defect 1: the Tier 2 regression -----------------------------------------

describe('QA round 2 — the repackage leg really is a repackage, on every television', () => {
  it('the stereo fixture is Tier 2 on every profile, which is what makes the branch reachable', () => {
    // The precondition the whole leg rests on. If this stops being true on any profile, the
    // `remuxTierTaken` assertion below cannot be met on that television and the run is red
    // rather than quietly measuring something else — which is the state round 1 found.
    for (const [name, profile] of PROFILES) {
      const verdict = classify(
        fixture.probeOf(repackageFixture(REPACKAGE_FIXTURE_CHANNELS)),
        profile,
      );
      expect(verdict.kind, name).toBe('remux');
      expect(verdict.plan.kind, name).toBe('remux');
    }
    expect(REPACKAGE_FIXTURE_CHANNELS).toBe(2);
  });

  it('the tier gate maps every possible verdict, and only one of them is a repackage', () => {
    // The full truth table, because round 1's defect was an *unfailable observation* and the
    // fix is an assertion whose target is the literal `'repackage'`. Anything that can also
    // produce that string is a way for a broken run to go green.
    expect(tierTakenFor('remux', true, 'x')).toBe('repackage');
    expect(tierTakenFor('convert', true, 'x')).toBe('audio-only conversion');
    for (const kind of ['ready', 'impossible', 'unheard-of', null, undefined]) {
      expect(() => tierTakenFor(kind, true, 'x'), String(kind)).toThrow(SelftestAbort);
    }
    // …and with the picture not carried, *nothing* is a Tier 2 condition — including a
    // `remux`, which cannot legitimately happen and would be the gate lying to itself.
    for (const kind of ['remux', 'convert', 'ready', 'impossible', null, undefined]) {
      expect(() => tierTakenFor(kind, false, 'x'), String(kind)).toThrow(SelftestAbort);
    }
  });

  it('QA’s round-1 failure scenario is dead: a run that never repackages cannot exit 0', () => {
    // **The scenario, restated as arithmetic.** Round 1: break the Tier 2 `-c copy` path and
    // `--scenario remux` still exited 0 on a 2-channel television, because the 5.1 fixture
    // meant the run never entered that branch. Two things had to change and both are checked
    // here: the fixture reaches `remux` on every profile (case 1), and the gate's answer is
    // *asserted* rather than observed.
    //
    // So: whatever a broken classifier returns instead of `remux`, the leg's outcome is
    // either an exception (exit 2) or a measured value that is not the target (exit 1).
    // There is no third option, and `'repackage'` is unreachable without a real repackage.
    const target = 'repackage';
    for (const kind of ['convert', 'ready', 'impossible', null]) {
      let measured: string;
      try {
        measured = tierTakenFor(kind, true, 'x');
      } catch (error) {
        expect(error, String(kind)).toBeInstanceOf(SelftestAbort);
        continue;
      }
      expect(compare('eq', measured, target), `${String(kind)} was graded as a repackage`).toBe(
        false,
      );
    }
    // And the one case that must still pass, so the leg is not simply always red.
    expect(compare('eq', tierTakenFor('remux', true, 'x'), target)).toBe(true);
  });

  it('the substitution on the stereo leg is stronger than the 8f assertion it replaced', () => {
    // They moved 8f (`lte limit`) off the stereo leg and put `eq sourceChannels` there. That
    // is only defensible if the new assertion fails everywhere the old one did **and more**.
    // Source and limit are both 2 on that leg, so this is the whole comparison.
    const source = 2;
    const limit = 2;
    for (const measured of [null, 0, 1, 2, 3, 6, 8]) {
      const oldWouldPass = compare('lte', measured, limit);
      const newWouldPass = compare('eq', measured, source);
      expect(
        !newWouldPass || oldWouldPass,
        `a ${String(measured)}-channel artifact passes the new assertion but not the old`,
      ).toBe(true);
    }
    // Strictly stronger, not merely equal: a repackage that quietly folded the sound to mono
    // is lossless-in-name-only, and only the new assertion notices.
    expect(compare('lte', 1, limit)).toBe(true);
    expect(compare('eq', 1, source)).toBe(false);
    // A repackage that dropped the audio stream altogether has no measurement at all, and
    // neither assertion may shrug at that.
    expect(compare('eq', null, source)).toBe(false);
  });

  it('8f is still asserted where it can fail, and the D1 Tier 2 regression is still caught twice', () => {
    // 8f moved to the audio leg. For it to be evidence, that leg's fixture must be judged a
    // conversion — so if `audioSupported` ever stopped reading channels, the same fixture
    // would be a `remux`, and *both* `remuxAudioTierTaken` (target: audio-only conversion)
    // and `remuxAudioArtifactAudioChannels` (lte limit) would go red. Neither is reachable
    // from a stereo source, which is why it is not on the leg above.
    for (const [name, profile] of PROFILES) {
      const channels = channelsAboveLimit(profile.maxAudioChannels, 'x');
      const verdict = classify(fixture.probeOf(repackageFixture(channels)), profile);
      expect(verdict.kind, name).toBe('convert');
      expect(verdict.plan, name).toMatchObject({ video: 'copy', audio: 'aac' });
      expect(tierTakenFor(verdict.kind, true, 'x'), name).toBe('audio-only conversion');
    }
  });
});

// --- Defect 2: the invented failure ------------------------------------------

describe('QA round 2 — no artifact is graded against a limit the engine did not use', () => {
  it('reads the device’s own profile, and refuses to guess when it cannot see the device', () => {
    const devices = [
      { id: 'tv-1', model: 'Chromecast' },
      { id: 'tv-2', model: 'Chromecast Ultra' },
      { id: 'tv-3', model: 'AI PONT' }, // measured at 6 on 2026-08-24, item 8b
      { id: 'tv-4', model: null },
    ];
    expect(channelLimitFor(devices, 'tv-1')).toBe(2);
    expect(channelLimitFor(devices, 'tv-2')).toBe(2);
    expect(channelLimitFor(devices, 'tv-3')).toBe(6);
    // A television that announced no model is the baseline for the instrument **and** for
    // the engine, which is agreement rather than a guess.
    expect(channelLimitFor(devices, 'tv-4')).toBe(2);
    expect(resolveDeviceProfile(null, []).maxAudioChannels).toBe(2);

    // The abort is reachable, not dead code: a device that has dropped out of discovery.
    expect(() => channelLimitFor(devices, 'tv-gone')).toThrow(SelftestAbort);
    expect(() => channelLimitFor([], 'tv-1')).toThrow(SelftestAbort);
    // …and it names the device, so a reader of the exit-2 line knows what happened.
    expect(() => channelLimitFor(devices, 'tv-gone')).toThrow(/tv-gone/);
  });

  it('never grades against a limit **below** the engine’s — the invented-failure direction', () => {
    // Round 1's defect in one sentence: the instrument's limit was allowed to be *stricter*
    // than the engine's, so a correct 5.1 repackage on an Ultra was marked red. The only
    // remaining difference between the two numbers is layer 3, and narrowing can only lower
    // the engine's — so the instrument's is always ≥ and can only ever miss a narrowing.
    for (const entry of MODEL_TABLE) {
      for (const model of entry.models) {
        const instrument = channelLimitFor([{ id: 'tv', model }], 'tv');
        const downgrades = [
          narrowAfterRefusal(modelProfile(model), fixture.probeOf(repackageFixture(6))),
          narrowAfterRefusal(modelProfile(model), fixture.probeOf(repackageFixture(8))),
        ];
        expect(instrument, model).toBeGreaterThanOrEqual(
          resolveDeviceProfile(model, downgrades).maxAudioChannels,
        );
      }
    }
  });

  it('an `AI PONT` doing a correct 5.1 repackage is not marked red by any leg', () => {
    // The exact run round 1's defect would have condemned, walked end to end: a television
    // that really decodes 5.1, a 5.1 Matroska, a lossless repackage, and a 5.1 artifact that
    // is right to be 5.1. Every leg must leave it alone.
    //
    // **The Ultra was that television until 2026-08-24 and is not any more.** Its 6 was
    // inferred from `ac3`/`eac3`; measured, it dies on a 6-channel AAC film in 81 ms and its
    // entry says 2. The founder's `AI PONT` is measured at 6 and is now the only set the
    // invented-failure defect could be demonstrated on at all — on a 2-channel television a
    // red line against a 5.1 artifact is the correct answer, so the case would prove nothing.
    const aiPont = modelProfile('AI PONT');
    const source = fixture.probeOf(repackageFixture(6));
    expect(classify(source, aiPont).kind).toBe('remux');
    const limit = channelLimitFor([{ id: 'tv', model: 'AI PONT' }], 'tv');
    expect(compare('lte', 6, limit)).toBe(true);
    expect(compare('eq', 6, 6)).toBe(true);
    // …and 7l's manufactured pre-D1 artifact must be one this television really refuses,
    // rather than one it is right to keep. At a constant 6 it was the latter. This is also
    // the single place the **8-channel rung** is still reached from a real device's limit:
    // the `AI PONT`'s 6 is what keeps `FIXTURE_CHANNEL_RUNGS`' top entry load-bearing.
    expect(channelsAboveLimit(limit, 'x')).toBe(8);
    const stale = fixture.probeOf(repackageFixture(8, {}));
    expect(isReusableArtifact(source, stale, aiPont)).toBe(false);
  });
});

// --- The fixture rungs -------------------------------------------------------

describe('QA round 2 — a fixture built to be refused, on every television in the table', () => {
  it('has a rung above every profile’s limit, and the rung is genuinely refused', () => {
    for (const [name, profile] of PROFILES) {
      const channels = channelsAboveLimit(profile.maxAudioChannels, 'x');
      expect(channels, name).toBeGreaterThan(profile.maxAudioChannels);
      const verdict = classify(fixture.probeOf(checkPairFixture(channels)), profile);
      expect(verdict.kind, name).toBe('convert');
      expect(verdict.plan, name).toMatchObject({ video: 'copy', audio: 'aac' });
    }
  });

  it('exits 2 rather than grading a guess when no buildable rung exists', () => {
    // ffmpeg's native AAC encoder tops out at 7.1, so a profile claiming 8 channels has no
    // fixture that could exceed it. The honest answer is exit 2.
    expect(() => channelsAboveLimit(8, 'a clip')).toThrow(SelftestAbort);
    expect(() => channelsAboveLimit(16, 'a clip')).toThrow(SelftestAbort);
    expect(channelsAboveLimit(2, 'a clip')).toBe(6);
    // The 8 rung, pinned whatever the table happens to say today. It was put there for the
    // Ultra's inferred 6; since 2026-08-24 the founder's `AI PONT` is the only measured 6 and
    // therefore the only device that reaches it. **It is not deleted the day nothing reaches
    // it** — an unreachable rung costs nothing, `channelsAboveLimit` aborts rather than
    // guesses when no rung fits, and the next television in the house may need it back.
    expect(channelsAboveLimit(6, 'a clip')).toBe(8);
  });

  it('warns, by failing, the day a profile is added that no fixture can exceed', () => {
    // **Not a redundant restatement of the case above.** If someone adds an 8-channel
    // profile to the table, `check`, the `remux` audio leg, `prepared`'s 7l leg and
    // `convert` all begin exiting 2 on that television — the whole `m3` aggregate becomes
    // unrunnable there, and the first anyone would know is a founder's evening. This is the
    // line that says so at build time instead.
    for (const [name, profile] of PROFILES) {
      expect(() => channelsAboveLimit(profile.maxAudioChannels, 'x'), name).not.toThrow();
    }
  });
});

// --- 7i's `check` half, and the re-encoded fixture it rests on ---------------

describe('QA round 2 — the 720p24 pair, and the shared helper that now re-encodes', () => {
  it('the stereo half is Ready to cast on every profile — the claim that makes the leg runnable', () => {
    // The developer's justification for re-encoding rather than stream-copying is that
    // 720p24 H.264 High 8-bit is inside every profile on every axis. If that is wrong for
    // any entry in the table, `checkStereoStaysReady` is red on that television for a reason
    // that has nothing to do with sound — which is the failure mode this pair exists to
    // avoid. Levels 3.0 to 4.1 are swept because libx264 chooses the level itself.
    for (const [name, profile] of PROFILES) {
      for (const level of [30, 31, 32, 40, 41]) {
        const verdict = classify(fixture.probeOf(checkPairFixture(2, level)), profile);
        expect(verdict.kind, `${name} @ level ${String(level)}`).toBe('ready');
      }
    }
  });

  it('and this file’s transcription of that geometry still matches the shipping arguments', () => {
    // **Why a text check, here of all places.** The sweep above is only evidence if
    // `checkPairFixture` really describes what `makeMp4Clip` writes, and that fixture is a
    // hand transcription of an ffmpeg command line — the classic way a test keeps passing
    // about a file nobody builds any more. Change the box, the frame rate, the profile or
    // the container in the scenario and this line says so, instead of the sweep quietly
    // grading a shape that stopped existing.
    //
    // **The geometry moved on 2026-08-28 and this pin moved with it.** It used to be written
    // into `makeMp4Clip` as the constants `scale=1280:720`, `-r 24`, `-profile:v high`; it is
    // now derived per television by `fixturePictureFor` and written by the shared
    // `videoArgsFor`. So the pin is in two halves: the shape the shared writer produces, and
    // the fact that this file's fixture is still the answer that writer gives for every
    // television in the table. The second half is `fixturePictureFor` itself, called below.
    const source = fsSync.readFileSync(
      fileURLToPath(new URL('../../src/engine/selftest/m3.ts', import.meta.url)),
      'utf8',
    );
    const clip = source.slice(
      source.indexOf('async function makeMp4Clip'),
      source.indexOf('async function makeTenBitClip'),
    );
    expect(clip.length).toBeGreaterThan(200);
    for (const token of ['videoArgsFor(picture)', 'audioArgsFor(channels)', "'-f',\n      'mp4'"]) {
      expect(clip, `makeMp4Clip no longer says ${token}`).toContain(token);
    }
    const writer = source.slice(
      source.indexOf('function videoArgsFor'),
      source.indexOf('// --- Producing the conditions'),
    );
    for (const token of ['libx264', 'yuv420p', 'scale=${box}', 'pad=${box}']) {
      expect(writer, `videoArgsFor no longer says ${token}`).toContain(token);
    }
    // …and for every television the founder owns, that writer is still asked for the 720p24
    // High picture this file's fixtures describe.
    for (const [name, profile] of PROFILES) {
      expect(fixturePictureFor(profile, 'x'), name).toEqual({
        width: 1_280,
        height: 720,
        frameRate: 24,
        h264Profile: 'high',
      });
    }
  });

  it('the pair differs in exactly one property, and moves exactly one verdict', () => {
    // The trap named in the criterion: a single multichannel fixture judged *Needs
    // converting* proves nothing, because the picture can be reason enough on its own. The
    // pair is only evidence if the control is `ready`.
    for (const [name, profile] of PROFILES) {
      const stereo = classify(fixture.probeOf(checkPairFixture(2)), profile);
      const surround = classify(
        fixture.probeOf(checkPairFixture(channelsAboveLimit(profile.maxAudioChannels, 'x'))),
        profile,
      );
      expect(stereo.kind, name).toBe('ready');
      expect(surround.kind, name).toBe('convert');
      // The picture is still copied — so the only thing that moved the verdict is the sound.
      expect(surround.plan, name).toMatchObject({ video: 'copy', audio: 'aac' });
      expect(surround.detail.video?.supported, name).toBe(true);
    }
  });

  it('a 720p artifact is never upscaled, so the pair does not walk into the Nest Hub defect', () => {
    // Their claim is that fixture sizing keeps the pre-existing `outputProfileFor` bug out of
    // D1's way. It holds **for this leg**: the conversion copies a 720p picture, the output
    // box only ever scales down, and the artifact stays inside a Nest Hub's 720p limit.
    const hub = modelProfile('nest hub');
    const source = fixture.probeOf(checkPairFixture(6));
    const plan = classify(source, hub).plan;
    const args = buildArgs(
      {
        sourcePath: '/f/in.mp4',
        outputPath: '/f/out.mp4.partial',
        plan,
        deviceProfile: hub,
        durationSec: 20,
        encoder: 'libx264',
        sourceWidth: 1_280,
        sourceHeight: 720,
        subtitleOutputs: [],
      } satisfies JobRequest,
      BASELINE_OUTPUT,
    );
    expect(args.join(' ')).not.toContain('scale=');
    expect(args.join(' ')).toContain('-c:v copy');
    // …and the artifact that produces is one a Nest Hub keeps, so nothing here is re-prepared.
    const artifact = fixture.probeOf(checkPairFixture(2));
    expect(isReusableArtifact(source, artifact, hub)).toBe(true);
  });

  it('the re-encode is what lets `check` run on the founder’s own library at all', () => {
    // Scrutinising the developer's reasoning rather than taking it. In round 2 this case
    // read *"`makeMkvClip` is still `-c:v copy`, so on the bedroom Chromecast a clip of any
    // film on `D:\\DUMP\\Movies` has an uncarryable picture and `remux` exits 2 before it
    // measures anything"*, and recorded that `check`'s pair was therefore the **only** D1 leg
    // that ran against the library the founder actually owns.
    //
    // **That prediction came true on the founder's own television on 2026-08-28**, not on
    // the bedroom Chromecast: `--scenario m3` on the 4K HEVC film scored 12/12 on `check` and
    // stopped dead on `remux`. It is fixed on `fix/m3-remux-fixture` and the sweep lives in
    // `m3-repackage-fixture.test.ts`. What is kept here is the arithmetic that made the
    // prediction — a stream-copied HEVC picture is uncarryable and `tierTakenFor` refuses it —
    // because that is the shape any future fixture built out of the passed film would have.
    const baseline = BASELINE_PROFILE;
    const hevcClip = fixture.probeOf(
      repackageFixture(2, { codec_name: 'hevc', profile: 'Main 10', level: 120 }),
    );
    expect(classify(hevcClip, baseline).detail.video?.supported).toBe(false);
    expect(() => tierTakenFor(classify(hevcClip, baseline).kind, false, 'x')).toThrow(
      SelftestAbort,
    );
    // The same film through the shared picture writer is Ready to cast in an MP4, which is
    // what makes `check`, `remux` and `prepared` all runnable on any film the founder passes.
    expect(classify(fixture.probeOf(checkPairFixture(2)), baseline).kind).toBe('ready');
  });

  it('and the Matroska legs no longer carry the founder’s own resolution — the pin is closed', () => {
    // **Round 2 reported this and did not fix it**: `makeMkvClip` was `-c:v copy`, so `remux`
    // and `prepared` handed a Nest Hub an artifact at the founder's 1080p, the pre-existing
    // `outputProfileFor` bug bit, and the prepared file was not recognised. The first half
    // below is that defect, still true of a stream-copied fixture.
    const hub = modelProfile('nest hub');
    // `{}` is the fixture library's ordinary 1080p picture — the founder's film.
    const copiedFromTheFilm = fixture.probeOf(repackageFixture(2, {}));
    const artifact = fixture.probeOf(
      fixture.report({ streams: [fixture.videoStream(), fixture.audioStream()] }),
    );
    expect(classify(copiedFromTheFilm, hub).kind).toBe('convert');
    expect(isReusableArtifact(copiedFromTheFilm, artifact, hub)).toBe(false);

    // And the second half is the fix: the fixture is now built to `fixturePictureFor(hub)`,
    // which is inside the Nest Hub's own 720p box, so the leg is a repackage there and the
    // artifact it produces is one that set keeps.
    const built = fixturePictureFor(hub, 'x');
    expect(built).toMatchObject({ width: 1_280, height: 720 });
    const nowSource = fixture.probeOf(
      repackageFixture(2, {
        width: built.width,
        height: built.height,
        coded_width: built.width,
        coded_height: built.height,
        level: 31,
        r_frame_rate: '24/1',
        avg_frame_rate: '24/1',
      }),
    );
    expect(classify(nowSource, hub).kind).toBe('remux');
    expect(isReusableArtifact(nowSource, fixture.probeOf(checkPairFixture(2)), hub)).toBe(true);
  });

  it('and when the picture is why there is no Tier 2 job, the leg exits 2 — never a green line', () => {
    // The honest degradation, and the line the fix above must not cross. A television
    // narrowed below what the table states will not carry even the built fixture, and
    // `tierTakenFor` says so with an abort rather than quietly grading whatever did happen —
    // which is exactly what round 1's version did wrong.
    const hub = modelProfile('nest hub');
    const source = fixture.probeOf(repackageFixture(2, {}));
    const verdict = classify(source, hub);
    expect(verdict.detail.video?.supported).toBe(false);
    expect(() => tierTakenFor(verdict.kind, false, 'the stereo Matroska fixture')).toThrow(
      SelftestAbort,
    );
  });
});
