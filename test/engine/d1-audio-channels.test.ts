import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { classify, isReusableArtifact } from '../../src/engine/prepare/classify.js';
import {
  applyNarrowingStep,
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
  narrowAfterRefusal,
  resolveDeviceProfile,
} from '../../src/engine/prepare/device-profiles.js';
import { createPreparationPipeline } from '../../src/engine/prepare/index.js';
import { createStore } from '../../src/engine/store/index.js';
import { createLogger, createMemorySink, createTestClock } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import type { ProbeResult } from '../../src/engine/media/ffprobe.js';
import type { DeviceId, DeviceProfile, ProfileId } from '../../src/engine/types.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * **Defect D1** — 5.1 sound was sent to a television that can only decode stereo, and the
 * television refused the film in a quarter of a second (`docs/STATUS.md`, 2026-08-24).
 *
 * ## Why this file exists rather than more cases in `m3-classifier.test.ts`
 *
 * Because the reason the defect shipped is a property of the *tests*, not of the classifier,
 * and it is worth keeping in one place where it can be read. `audioSupported()` compared
 * codec names and nothing else for the whole of M3a; `ffprobe` had captured `channels` since
 * M1 and no caller ever read it; and the `m3` selftest scored **32/32 on the very television
 * that later refused the film**, four days earlier, because every fixture it builds carries
 * stereo audio. **A test whose fixture cannot express the defect is not evidence, however
 * green it is** — the seventh time in this project that a fixture has been kinder than a
 * television.
 *
 * So every case below is built to be *capable of failing*:
 *
 *  - the multichannel fixtures say `channels: 6` **explicitly** (`surroundAudioStream`), and
 *    are paired one-for-one with the stereo fixture of the same tier, so the channel count is
 *    the only variable;
 *  - one of them is **run 1's own film** — `mkvLegoMarvel`, the probe recorded on the night —
 *    driven through the real classifier, the `mkvAllQuiet` pattern that found a defect in
 *    2026-08-21 that no synthetic fixture had;
 *  - and every one of them was run against the shipped rule and **watched to fail** before
 *    the fix landed. A test written alongside its fix and never seen red is a claim, not a
 *    measurement (criterion 10j's calibration pattern, applied to the classifier).
 */

const CHROMECAST = modelProfile('Chromecast');
const ULTRA = modelProfile('Chromecast Ultra');
/**
 * **The one television in this house measured to decode more than stereo** (2026-08-24,
 * checklist item 8b). Until that evening the Ultra held this role on a `6` inferred from
 * `ac3`/`eac3` in its codec list; the same 6-channel film killed the Ultra in 81 ms and ran
 * 243 `PLAYING` samples over 118.6 s on the `AI PONT`. Every case below that needs *a device
 * whose limit is above stereo* uses this one, because it is now the only one there is.
 */
const AI_PONT = modelProfile('AI PONT');

function verdictOf(json: unknown, profile: DeviceProfile = CHROMECAST) {
  return classify(fixture.probeOf(json), profile);
}

// --- 7j: the number is on the profile, and a profile cannot exist without it ---

describe('7j — every device profile carries its own audio channel limit', () => {
  it('pins the number on every profile in the table, and the reason for each', () => {
    // The PRD's table, transcribed, **after the 2026-08-24 correction**. Three of these are
    // measurements and one is a deliberate conservative guess:
    //
    //  - `chromecast` **2** — measured. 5.1 AAC gave `PLAYING` then `IDLE`/`ERROR` in 0.232 s.
    //  - `chromecast-ultra` **2** — measured, and **this entry used to say 6.** The 6 was
    //    inferred from `ac3`/`eac3` on its own entry; a Chromecast passes Dolby *through* its
    //    HDMI, which says nothing about the AAC decoder every film in this library needs.
    //    Sent the same 6-channel film it went `IDLE`/`ERROR` **81 ms** in, `trigger:
    //    device.idle`. The stereo control on the same set ran 242 samples, 12/12.
    //  - `google-tv` **2** — never measured, and lowered anyway: it was 6 on precisely the
    //    inference the Ultra just disproved, and there is no Google TV in this house. Costs a
    //    downmix; buys a film that plays.
    //  - `ai-pont` **6** — measured, and the *only* number above stereo in the whole table.
    //    243 `PLAYING` samples across 118.6 s on the film that killed both Google sets.
    //
    // The lesson the shape of this list records: **the two entries that named multichannel
    // codecs were the two that could not decode multichannel**, and the set with no
    // documentation at all was the one that could. 7k is the net for the next such surprise.
    const limits = Object.fromEntries(
      MODEL_TABLE.map((entry) => [entry.profile.id, entry.profile.maxAudioChannels]),
    );
    expect(limits).toEqual({
      'ai-pont': 6,
      chromecast: 2,
      'chromecast-ultra': 2,
      'google-tv': 2,
      'nest-hub': 2,
      'nest-hub-max': 2,
    });
    expect(BASELINE_PROFILE.maxAudioChannels).toBe(2);
  });

  it('gives a television nobody has met the baseline, and therefore 2', () => {
    // **This case used to be about the `AI PONT`**, which was absent from the model table on
    // purpose as exactly the device layers 1 and 3 exist for. Item 8b measured it and it now
    // has an entry, so it can no longer stand for "unrecognised" — the property survives with
    // a name that will never be a real television. An unrecognised set is stereo-only until
    // something proves otherwise, and that is *more* clearly right after 8b, not less: the
    // sets whose codec lists promised multichannel are the ones that refused it.
    const profile = modelProfile('Some Telly Nobody Has Met');
    expect(profile.id).toBe('baseline');
    expect(profile.maxAudioChannels).toBe(2);
    expect(modelProfile(null).maxAudioChannels).toBe(2);
  });

  it('gives the founder’s own television — `AI PONT` — the baseline plus one measured number', () => {
    // The other half of the case above, and the shape the entry is required to keep. Layer 3
    // can only ever *narrow*, so the model table is the only place a television turning out
    // to be **more** able than the floor can be recorded — and the discipline that keeps that
    // honest is that the entry widens exactly the one field that was measured and copies the
    // floor for everything else. A future edit that quietly grants this set HEVC, or 60 fps,
    // or Matroska, on the strength of an evening about *audio*, fails here.
    expect(AI_PONT.id).toBe('ai-pont');
    expect(AI_PONT.maxAudioChannels).toBe(6);
    expect({ ...AI_PONT, id: BASELINE_PROFILE.id, maxAudioChannels: 2 }).toEqual(BASELINE_PROFILE);
  });

  it('cannot be built without one — an absent limit is impossible, not `?? 2`', () => {
    // The criterion's own failure clause: *"fails if any profile can be constructed without
    // the number and a default is inferred at the call site"*. The guard is the type, so the
    // test is a type error — and `@ts-expect-error` fails `npm run typecheck` in **both**
    // directions: if the field ever becomes optional, this line stops erroring and the
    // unused directive is itself the error.
    // @ts-expect-error — maxAudioChannels is required on DeviceProfile
    const missing: DeviceProfile = {
      id: 'baseline' as ProfileId,
      video: [],
      audio: ['aac'],
      containers: ['mp4'],
    };
    expect(missing.audio).toEqual(['aac']);
  });
});

// --- 7i: the classifier reads the count, in all three tiers ------------------

describe('7i — more channels than the device can decode is not carryable, whatever the codec', () => {
  it('turns a Tier 1 file into a preparation (was: cast untouched, and refused)', () => {
    // Identical files but for the channel count. The stereo one is the promise M3a made;
    // the 5.1 one is the film that died at 0.232 s.
    expect(verdictOf(fixture.mp4H264Aac()).tier).toBe(1);

    const surround = verdictOf(fixture.mp4H264Aac51());
    expect(surround.kind).toBe('convert');
    expect(surround.tier).toBe(3);
    expect(surround.plan).toMatchObject({ kind: 'transcode', video: 'copy', audio: 'aac' });
  });

  it('makes a Tier 2 repackage convert its audio (was: `-c copy`, and refused)', () => {
    expect(verdictOf(fixture.mkvH264Aac()).tier).toBe(2);

    const surround = verdictOf(fixture.mkvH264Aac51());
    expect(surround.kind).toBe('convert');
    expect(surround.plan).toMatchObject({ kind: 'transcode', video: 'copy', audio: 'aac' });
  });

  it('stops a Tier 3 conversion copying the sound across (was: `-c:v h264 -c:a copy`)', () => {
    // Run 1's exact shape: the picture is converted because the device cannot decode HEVC,
    // and before D1 the sound went through untouched in the same invocation.
    expect(verdictOf(fixture.mp4Hevc4k()).plan).toMatchObject({ video: 'h264', audio: 'copy' });

    expect(verdictOf(fixture.mp4Hevc4k51()).plan).toMatchObject({ video: 'h264', audio: 'aac' });
  });

  it('judges run 1’s own film — the real probe — a conversion of both streams', () => {
    // `LEGO Marvel Avengers Mission Demolition 2024 1080p WEBRip x265-DH.mkv` on the plain
    // Chromecast in the bedroom. Everything about this verdict except the audio was already
    // right on the night.
    const verdict = verdictOf(fixture.mkvLegoMarvel());
    expect(verdict.kind).toBe('convert');
    expect(verdict.plan).toMatchObject({ kind: 'transcode', container: 'mp4', video: 'h264' });
    expect(verdict.plan).toMatchObject({ audio: 'aac' });
    // Both English subtitle tracks still survive the preparation — the fix takes nothing away.
    expect(verdict.plan).toMatchObject({
      subtitleTracks: [
        { index: 2, language: 'eng' },
        { index: 3, language: 'eng' },
      ],
    });
  });

  it('changes nothing for a stereo film — it is still Tier 1, and is not downmixed', () => {
    // The other half of the criterion, and the one a blunt "always re-encode the audio" fix
    // would break: a film the television can play must still cast untouched.
    expect(verdictOf(fixture.mp4H264Aac()).kind).toBe('ready');
    expect(verdictOf(fixture.mkvH264Aac()).plan).toMatchObject({ kind: 'remux' });
  });

  it('leaves 5.1 alone on the one device whose limit is 6 — the `AI PONT` — and refuses 7.1 there', () => {
    // **The limit is a number, not a flag**, and this is the case that proves it: a device
    // above stereo keeps its surround sound untouched, and the film one channel-count wider
    // than its measured limit is still converted. A fix that simply downmixed everything
    // would pass every other case in this file and fail this one.
    //
    // The Ultra played this role until 2026-08-24 on an inferred 6. It is measured at 2 now,
    // so the role moved to the television that earned it on hardware — and if the `AI PONT`
    // is ever lowered too, this case must move again rather than be deleted, because the
    // property is about the *arithmetic*, not about any one set.
    expect(verdictOf(fixture.mp4H264Aac51(), AI_PONT).kind).toBe('ready');
    expect(verdictOf(fixture.mp4H264Aac71(), AI_PONT).plan).toMatchObject({ audio: 'aac' });
    // And the same 5.1 film on the sets that were *assumed* to manage it is a conversion.
    expect(verdictOf(fixture.mp4H264Aac51(), ULTRA).kind).toBe('convert');
  });

  it('treats a channel count ffprobe would not state as a failed measurement', () => {
    // **The `channels: null` ruling.** An absent measurement is not a pass anywhere else in
    // this project — a selftest assertion with a null measurement fails, it does not shrug —
    // and the arithmetic here is the same. Believing an unstated count costs a black screen
    // and an evening; disbelieving it costs one audio-only conversion, which run 2 did to a
    // 22-minute film in seconds. Note it is *not* symmetric with `freeBytesOn` returning
    // `null`, where proceeding is the safe direction: there the unknown blocks a job that
    // would probably have worked, here it lets through a file that probably will not play.
    const verdict = verdictOf(fixture.mp4H264AacUnmeasured());
    expect(verdict.kind).toBe('convert');
    expect(verdict.plan).toMatchObject({ audio: 'aac' });
  });

  it('keeps the rule in the classifier — ffmpeg-job obeys the plan and never re-decides', () => {
    // The criterion's second failure clause: *"if the rule lives anywhere but the classifier
    // (a special case in `ffmpeg-job.ts` is a second source of truth) it fails"*. The job
    // builder's line was never wrong — `plan.audio === 'copy' ? ['-c:a','copy'] : audioArgs`
    // is exactly right — the plan handed to it was. Teaching it about channels would give
    // the product two places that decide the same thing, which is how they drift apart.
    const jobFile = fileURLToPath(
      new URL('../../src/engine/prepare/ffmpeg-job.ts', import.meta.url),
    );
    return fsp.readFile(jobFile, 'utf8').then((text) => {
      // Reading the field, naming the profile's limit, or emitting a channel flag — any of
      // the three is a second place that decides this. Prose is allowed; code is not.
      expect(text).not.toMatch(/\.channels\b|maxAudioChannels|'-ac'/);
    });
  });
});

// --- 7k: the refusal ladder narrows the limit before it drops a codec --------

describe('7k — the safety net narrows channels before codecs, and never drops `aac`', () => {
  it('caps the channel limit rather than taking `aac` away from the `AI PONT`', () => {
    // The case this rung exists for, and **2026-08-24 is the day it stopped being
    // hypothetical**. It used to be written about the Ultra, whose 6 was a claim: *if the
    // claim is wrong, the first thing we learn is that a 5.1 film was refused, and the old
    // ladder would have concluded "it cannot decode AAC" — false and unrecoverable.* The
    // claim was wrong. The Ultra is 2 now, by measurement rather than by this ladder.
    //
    // So the rung is aimed at the only limit above stereo left standing. The `AI PONT`'s 6
    // is a measurement, but one film on one evening is not every film, and the ladder is
    // what stands between a surprise and a founder who cannot play that film ever again.
    const refused = fixture.probeOf(fixture.mp4H264Aac51());
    const downgrade = narrowAfterRefusal(AI_PONT, refused);

    expect(downgrade.steps[0]).toEqual({ kind: 'cap-audio-channels', maxChannels: 2 });
    const narrowed = downgrade.steps.reduce(applyNarrowingStep, AI_PONT);
    expect(narrowed.maxAudioChannels).toBe(2);
    expect(narrowed.audio).toContain('aac');
    // 7e's convergence property, which is what makes the net a net: the same file is no
    // longer *Ready to cast* against the narrowed profile, so the next plan is a job.
    expect(classify(refused, narrowed).kind).not.toBe('ready');
  });

  it('never removes `aac` from a profile, however many times a television refuses', () => {
    // A profile that has lost stereo `aac` can never call a prepared file ready again —
    // every conversion we run produces exactly that — so the film would be re-prepared on
    // every selection, for ever. Driven to the floor to prove the ladder cannot get there.
    //
    // It has to start **above** the floor or it proves nothing: from a profile already at 2
    // the loop breaks on its first pass and the assertions below hold vacuously. Since
    // 2026-08-24 the `AI PONT` is the only entry in the table that starts above it, so this
    // is the only device this case can be written about at all.
    const refused = fixture.probeOf(fixture.mp4H264Aac51());
    let profile = AI_PONT;
    expect(profile.maxAudioChannels).toBeGreaterThan(2);
    let capped = false;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const downgrade = narrowAfterRefusal(profile, refused);
      if (downgrade.steps.length === 0) break;
      capped = true;
      profile = downgrade.steps.reduce(applyNarrowingStep, profile);
      expect(profile.audio).toContain('aac');
    }
    // The loop really ran: without this the case would go green the day every profile in
    // the table is stereo, having driven nothing anywhere.
    expect(capped).toBe(true);
    expect(profile.audio).toContain('aac');
    expect(profile.maxAudioChannels).toBe(2);
  });

  it('still drops a genuinely unsupported audio codec once the channels are already right', () => {
    // The rung it was inserted in front of has not been disabled: an AC-3 stereo film
    // refused by a device that claims AC-3 still costs that codec.
    const refused = fixture.probeOf(
      fixture.report({
        streams: [fixture.videoStream(), fixture.audioStream({ codec_name: 'ac3', profile: null })],
      }),
    );
    const downgrade = narrowAfterRefusal(ULTRA, refused);
    expect(downgrade.steps).toContainEqual({ kind: 'drop-audio-codec', codec: 'ac3' });
    expect(downgrade.steps).not.toContainEqual(
      expect.objectContaining({ kind: 'cap-audio-channels' }),
    );
  });
});

describe('7k — the narrowed limit survives the app being closed and reopened', () => {
  let directory: string;
  const sink = createMemorySink();

  beforeEach(async () => {
    directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-d1-store-'));
    sink.lines.length = 0;
  });

  afterEach(async () => {
    await fsp.rm(directory, { recursive: true, force: true });
  });

  function makeStore() {
    return createStore({
      logger: createLogger({ sink, clock: createTestClock(1_700_000_000_000, 0) }),
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    });
  }

  it('round-trips a channel narrowing through `settings.json` (7e’s permanence, 7k’s step)', async () => {
    // A narrowing the store cannot parse is dropped **with the whole file**, so a new step
    // kind that never reached the schema would silently un-narrow every device on restart —
    // and the founder would meet the same black screen on the next evening.
    //
    // Written about the Ultra until 2026-08-24; moved to the `AI PONT` because the Ultra is
    // measured at 2 and a device already at the floor produces **no steps at all** — the
    // round trip would then be a round trip of an empty array, which every schema in the
    // world survives. The device this is written about must be one a narrowing can happen to.
    const refused = fixture.probeOf(fixture.mp4H264Aac51());
    const downgrade = narrowAfterRefusal(AI_PONT, refused, 1_700_000_000_000);
    expect(downgrade.steps).not.toEqual([]);

    const store = makeStore();
    await store.load();
    await store.rememberDevice('tv-1' as DeviceId, 'Family room TV', 'AI PONT');
    await store.recordDowngrade('tv-1' as DeviceId, downgrade);
    await store.flush();

    const reopened = makeStore();
    await reopened.load();
    const remembered = reopened.downgradesFor('tv-1' as DeviceId);
    expect(remembered[0]?.steps).toEqual(downgrade.steps);
    expect(resolveDeviceProfile('AI PONT', remembered).maxAudioChannels).toBe(2);
  });
});

// --- 7l: an artifact made before the fix is not "already prepared" -----------

describe('7l — a prepared file carrying too many channels is not offered as ready', () => {
  let films: string;
  let working: string;
  let sourcePath: string;
  const sink = createMemorySink();

  beforeEach(async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-d1-prep-'));
    films = path.join(root, 'Films');
    working = path.join(root, 'working');
    await fsp.mkdir(films, { recursive: true });
    sourcePath = path.join(films, 'Cars.mkv');
    await fsp.writeFile(sourcePath, Buffer.alloc(4_096, 1));
    sink.lines.length = 0;
  });

  afterEach(async () => {
    await fsp.rm(path.dirname(films), { recursive: true, force: true });
  });

  function pipelineProbing(artifact: ProbeResult) {
    const runFfprobe: FfprobeRunner = (filePath) =>
      Promise.resolve(
        path.basename(filePath) === 'Cars (CastGood).mp4'
          ? { ok: true as const, probe: artifact }
          : { ok: false as const, failure: 'unreadable' as const },
      );
    return createPreparationPipeline({
      logger: createLogger({ sink, bindings: {} }),
      binaries: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
      runFfprobe,
      workingDir: working,
    });
  }

  it('judges the artifact by exactly 7i’s rule rather than by its name', () => {
    const source = fixture.probeOf(fixture.mkvH264Aac51());
    expect(
      isReusableArtifact(source, fixture.probeOf(fixture.preparedSibling51(6_990)), CHROMECAST),
    ).toBe(false);
    // Same film, same length, same box — the 6-channel one is refused and the 2-channel one
    // is kept, which is the whole difference.
    expect(
      isReusableArtifact(source, fixture.probeOf(fixture.preparedSibling(6_990)), CHROMECAST),
    ).toBe(true);
  });

  it('does not report a pre-fix sibling as already prepared, and does not sweep the disk', async () => {
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(2_048, 2));
    const pipeline = pipelineProbing(fixture.probeOf(fixture.preparedSibling51(6_990)));

    const found = await pipeline.findPrepared(
      sourcePath,
      fixture.probeOf(fixture.mkvH264Aac51()),
      CHROMECAST,
    );
    expect(found).toBeNull();
    // Nothing went looking for others, and nothing was deleted on the way past: the file is
    // still sitting there, and it is the *next* preparation that replaces it.
    expect(await fsp.readdir(films)).toEqual(['Cars (CastGood).mp4', 'Cars.mkv'].sort());
  });

  it('accepts the replacement, so the film is not re-prepared on every selection', async () => {
    // The criterion's sharpest clause. A rejection rule the replacement cannot satisfy is
    // not a fix, it is an infinite wait: the founder would sit through the same conversion
    // every single time they chose that film. The replacement is what our own conversion
    // writes — `-c:a aac -b:a 192k -ac 2` — so this is the artifact D1 actually produces.
    await fsp.writeFile(path.join(films, 'Cars (CastGood).mp4'), Buffer.alloc(2_048, 2));
    const pipeline = pipelineProbing(fixture.probeOf(fixture.preparedSibling(6_990)));

    const found = await pipeline.findPrepared(
      sourcePath,
      fixture.probeOf(fixture.mkvH264Aac51()),
      CHROMECAST,
    );
    expect(found?.path).toBe(path.join(films, 'Cars (CastGood).mp4'));
  });
});
