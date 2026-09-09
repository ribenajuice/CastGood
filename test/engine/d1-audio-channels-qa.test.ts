import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { classify, isReusableArtifact } from '../../src/engine/prepare/classify.js';
import { createStore } from '../../src/engine/store/index.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import type { DeviceId } from '../../src/engine/types.js';
import { buildArgs, type JobRequest } from '../../src/engine/prepare/ffmpeg-job.js';
import {
  BASELINE_OUTPUT,
  NVENC_OUTPUT,
  outputProfileFor,
} from '../../src/engine/prepare/output-profiles.js';
import {
  applyNarrowingStep,
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
  narrowAfterRefusal,
  resolveDeviceProfile,
  type NarrowingStep,
} from '../../src/engine/prepare/device-profiles.js';
import type { DeviceProfile } from '../../src/engine/types.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * **QA's own verification of defect D1**, written independently of `d1-audio-channels.ts`
 * and deliberately not sharing its helpers.
 *
 * The developer's file proves the classifier reads the channel count. This one attacks the
 * three places that proof does not reach:
 *
 *  1. **The plan is not the file.** Criterion 7i is written in ffmpeg arguments —
 *     *"the plan converts it to `-c:a aac -b:a 192k -ac 2`"* — and until this file nothing
 *     in the suite asserted the `-ac 2`. Deleting it from `BASELINE_OUTPUT.audioArgs` left
 *     645 tests green while every prepared file went back to carrying 5.1, which is the
 *     defect restored in full with the whole suite still nodding.
 *  2. **The safety rail has the same blind spot the product had.** `m3-classifier.test.ts`
 *     checks *Ready to cast* against an oracle that reads codec names and never channels —
 *     which is exactly the sentence `audioSupported()` used to be. The rail below adds the
 *     dimension, over every fixture and every profile.
 *  3. **One fixture pair is not a sweep.** Every assertion here runs over the whole fixture
 *     library against every profile in the table, so a fixture added later is covered
 *     without anybody remembering to cover it.
 *
 * Each case was run against the shipped (pre-fix) rule and watched to fail, or is marked
 * in its own comment as a control that must hold in both states.
 */

// --- The fixture library, swept as one ---------------------------------------

/**
 * Every fixture that describes a film, with the channel count each carries stated here
 * rather than derived — so that a fixture whose sound is quietly changed shows up as a
 * failure of this table rather than as a silently weaker sweep.
 */
const LIBRARY: readonly (readonly [string, unknown])[] = [
  ['mp4 h264 aac (stereo)', fixture.mp4H264Aac()],
  ['mkv h264 aac (stereo)', fixture.mkvH264Aac()],
  ['mkv h264 ac3 5.1', fixture.mkvH264Ac3()],
  ['mp4 hevc 4k (stereo)', fixture.mp4Hevc4k()],
  ['mp4 h264 60fps (stereo)', fixture.mp4H264_60fps()],
  ['mp4 h264 high10 (stereo)', fixture.mp4H264High10()],
  ['webm vp9 opus (stereo)', fixture.webmVp9Opus()],
  ['mkv + pgs (stereo)', fixture.mkvWithPgs()],
  ['mkv + srt (stereo)', fixture.mkvWithSrt()],
  ['mp4 + cover art (stereo)', fixture.mp4WithCoverArt()],
  ['prepared sibling (stereo)', fixture.preparedSibling()],
  ['mp4 h264 aac 5.1', fixture.mp4H264Aac51()],
  ['mkv h264 aac 5.1', fixture.mkvH264Aac51()],
  ['mp4 hevc 4k 5.1', fixture.mp4Hevc4k51()],
  ['mp4 h264 aac 7.1', fixture.mp4H264Aac71()],
  ['mp4 h264 aac, channels unstated', fixture.mp4H264AacUnmeasured()],
  ['run 1’s film — LEGO Marvel', fixture.mkvLegoMarvel()],
  ['prepared sibling 5.1', fixture.preparedSibling51()],
];

const PROFILES: readonly (readonly [string, DeviceProfile])[] = [
  ['baseline', BASELINE_PROFILE],
  ...MODEL_TABLE.map(
    (entry) => [entry.profile.id, entry.profile] as readonly [string, DeviceProfile],
  ),
];

/**
 * The channel counts in a fixture, read straight out of the raw ffprobe JSON.
 *
 * **Not** from `ProbeResult`, and not from anything the classifier touches: an oracle that
 * shares a parser with the thing it grades can be wrong in the same direction as it.
 * `undefined` and a non-number both come back as `null`, which is ffprobe declining to say.
 */
function rawAudioChannels(json: unknown): (number | null)[] {
  const streams = (json as { streams?: Record<string, unknown>[] } | null)?.streams ?? [];
  return streams
    .filter((stream) => stream['codec_type'] === 'audio')
    .map((stream) => (typeof stream['channels'] === 'number' ? stream['channels'] : null));
}

/** The audio codec names in a fixture, again read straight out of the raw ffprobe JSON. */
function rawAudioCodecs(json: unknown): string[] {
  const streams = (json as { streams?: Record<string, unknown>[] } | null)?.streams ?? [];
  return streams
    .filter((stream) => stream['codec_type'] === 'audio')
    .map((stream) => String(stream['codec_name'] ?? ''));
}

/**
 * Can this sound reach the television untouched *for reasons other than its channel count*?
 *
 * The device has to list the format and an MP4 has to be able to hold it — `opus` in a WebM
 * is decodable by a Chromecast and still has to be re-encoded on the way into an MP4. Both
 * are pre-D1 rules, and folding them in here is what keeps the case below about the one
 * thing it is meant to be about.
 */
function carryableCodec(codec: string, profile: DeviceProfile): boolean {
  return (
    (profile.audio as readonly string[]).includes(codec) &&
    ['aac', 'mp3', 'ac3', 'eac3'].includes(codec)
  );
}

/** Would this file, cast untouched, hand the device more channels than it can decode? */
function exceedsLimit(json: unknown, profile: DeviceProfile): boolean {
  return rawAudioChannels(json).some((count) => count === null || count > profile.maxAudioChannels);
}

function jobRequest(plan: JobRequest['plan'], profile: DeviceProfile): JobRequest {
  return {
    sourcePath: '/films/Film.mkv',
    outputPath: '/films/Film (CastGood).mp4.partial',
    plan,
    deviceProfile: profile,
    durationSec: 6_990,
    encoder: 'libx264',
    sourceWidth: 1_920,
    sourceHeight: 1_080,
    subtitleOutputs: [],
  };
}

/**
 * How many audio channels this ffmpeg command line will actually write.
 *
 * `null` means *"however many the source had"* — a stream copy, or an encode with no channel
 * flag at all. That is the answer criterion 7i forbids for a device with a limit below the
 * source, and reading it out of the argument list is the only way to notice that the flag
 * which does the downmixing has gone missing.
 */
function outputChannelsOf(
  args: readonly string[],
  sourceChannels: (number | null)[],
): {
  readonly copied: boolean;
  readonly channels: number | null;
} {
  const line = args.join(' ');
  const copied = line.includes('-c copy') || line.includes('-c:a copy');
  if (copied) {
    const known = sourceChannels.filter((c): c is number => c !== null);
    return { copied: true, channels: known.length === 0 ? null : Math.max(...known) };
  }
  const at = args.lastIndexOf('-ac');
  if (at === -1 || at === args.length - 1) return { copied: false, channels: null };
  const value = Number(args[at + 1]);
  return { copied: false, channels: Number.isFinite(value) ? value : null };
}

/**
 * The prepared file this product writes, described the way ffprobe would describe it.
 *
 * H.264 High L4.1 inside the output box, AAC at whatever `BASELINE_OUTPUT.audioArgs` asks
 * for, in an MP4, the same length as the source. Built from the shipping arguments rather
 * than from a guess, so if the downmix flag is ever removed this artifact grows the same
 * extra channels the real one would.
 */
function artifactAsWeWriteIt(durationSec: number): unknown {
  const args = BASELINE_OUTPUT.audioArgs;
  const at = args.lastIndexOf('-ac');
  const channels = at === -1 || at === args.length - 1 ? 6 : Number(args[at + 1]);
  return fixture.report({
    durationSec,
    streams: [
      fixture.videoStream({ profile: 'High', level: 41, width: 1_920, height: 1_080 }),
      fixture.audioStream({ channels, channel_layout: channels === 2 ? 'stereo' : '5.1' }),
    ],
  });
}

// --- 7i: the criterion is written in ffmpeg arguments, so read the arguments ---

describe('QA 7i — the downmix has to be in the command line, not only in the plan', () => {
  it.each([
    ['baseline (libx264)', BASELINE_OUTPUT],
    ['nvenc', NVENC_OUTPUT],
  ])('%s writes stereo AAC, and says so with a flag', (_name, output) => {
    // **The hole this closes.** Deleting `-ac 2` from `BASELINE_OUTPUT.audioArgs` — the one
    // edit that undoes the whole of D1, because the plan still says `aac` and the classifier
    // still says `convert` — left the entire suite green on 2026-08-24. Nothing anywhere
    // asserted the flag that performs the fold. Both profiles are checked because they share
    // one `audioArgs` today and a future encoder entry might not.
    const args = output.audioArgs;
    expect(args.join(' ')).toContain('-c:a aac');
    const at = args.lastIndexOf('-ac');
    expect(at, 'the audio arguments must carry an explicit channel flag').not.toBe(-1);
    expect(Number(args[at + 1])).toBeLessThanOrEqual(2);
  });

  it.each(LIBRARY)(
    '%s — the invocation for a stereo-only television never copies sound it cannot decode',
    (_name, json) => {
      // Criterion 7i's first failure clause, read off the command line rather than the plan:
      // *"fails if any plan for a 2-channel device contains `-c:a copy` for a source with
      // more than 2 channels"*. `-c copy` (a Tier 2 repackage) is the same failure wearing
      // the lossless label, so it is caught here too.
      const profile = modelProfile('Chromecast');
      const probe = fixture.probeOf(json);
      const verdict = classify(probe, profile);
      if (verdict.plan.kind === 'none') {
        expect(exceedsLimit(json, profile)).toBe(false);
        return;
      }
      const measured = outputChannelsOf(
        buildArgs(jobRequest(verdict.plan, profile), BASELINE_OUTPUT),
        rawAudioChannels(json),
      );
      if (!exceedsLimit(json, profile)) return;
      expect(measured.copied, 'sound the television cannot decode was stream-copied').toBe(false);
      expect(measured.channels).not.toBeNull();
      expect(measured.channels ?? Infinity).toBeLessThanOrEqual(profile.maxAudioChannels);
    },
  );

  it('sweeps every fixture against every profile: what is written is always decodable', () => {
    // The same rule as above, over the whole table rather than one television, and stated as
    // one assertion so a new profile or a new fixture is covered without anyone remembering.
    const offenders: string[] = [];
    for (const [profileName, profile] of PROFILES) {
      for (const [fixtureName, json] of LIBRARY) {
        const verdict = classify(fixture.probeOf(json), profile);
        const source = rawAudioChannels(json);
        if (verdict.plan.kind === 'none') {
          if (exceedsLimit(json, profile)) {
            offenders.push(
              `${profileName} / ${fixtureName}: cast untouched with ${String(source)}`,
            );
          }
          continue;
        }
        const measured = outputChannelsOf(
          buildArgs(jobRequest(verdict.plan, profile), BASELINE_OUTPUT),
          source,
        );
        const written = measured.channels;
        if (written === null || written > profile.maxAudioChannels) {
          offenders.push(
            `${profileName} / ${fixtureName}: writes ${String(written)} against a limit of ${String(profile.maxAudioChannels)}`,
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('a stereo film is never downmixed for the sake of it — the other half of 7i', () => {
    // Control: green in both states. *"Fails if a stereo source is downmixed anyway."* A
    // blunt "always re-encode the audio" fix would pass every assertion above and cost the
    // founder a wait on every film they own.
    //
    // Stated as *the sound is left alone* rather than *the verdict is ready*, because a
    // Nest Hub converts this film for its picture (720p box) and that is nothing to do with
    // D1. What must never happen is the **audio** being re-encoded for a source already
    // inside the limit.
    for (const [profileName, profile] of PROFILES) {
      for (const [fixtureName, json] of LIBRARY) {
        if (exceedsLimit(json, profile)) continue;
        // …and the sound is in a format the device lists *and* an MP4 can hold, so any
        // re-encode left over could only be about the channel count.
        if (!rawAudioCodecs(json).every((codec) => carryableCodec(codec, profile))) continue;
        const plan = classify(fixture.probeOf(json), profile).plan;
        if (plan.kind !== 'transcode') continue;
        expect(plan.audio, `${profileName} / ${fixtureName}: sound re-encoded for nothing`).toBe(
          'copy',
        );
      }
    }
    // …and the ordinary film is still a one-press cast on the televisions that fit it.
    for (const name of ['Chromecast', 'Chromecast Ultra', 'AI PONT', 'nest hub max']) {
      expect(classify(fixture.probeOf(fixture.mp4H264Aac()), modelProfile(name)).kind, name).toBe(
        'ready',
      );
    }
  });
});

// --- The safety rail, with the dimension D1 walked through -------------------

describe('QA — the rail that let D1 through: Ready to cast, and the channel count', () => {
  it('never says ready about a file whose sound has more channels than the set decodes', () => {
    // `m3-classifier.test.ts` has a rail of exactly this shape and its oracle
    // (`baselineCanPlay`) reads codec **names** and never channels — which is the sentence
    // `audioSupported()` used to be, reproduced in the test that was supposed to catch it.
    // The oracle here reads the raw ffprobe JSON, so it cannot agree with the classifier by
    // sharing its mistake, and the D1 fixtures are in the swept set.
    const promised: string[] = [];
    for (const [profileName, profile] of PROFILES) {
      for (const [fixtureName, json] of LIBRARY) {
        if (classify(fixture.probeOf(json), profile).kind !== 'ready') continue;
        if (exceedsLimit(json, profile)) promised.push(`${profileName} / ${fixtureName}`);
      }
    }
    expect(promised).toEqual([]);
  });

  it('and the rail is not vacuous — the library contains films that must not be promised', () => {
    // D1's regression rule 1, applied to this file: if every fixture were stereo the rail
    // above could not fail, however green it is. It has to be able to.
    const capable = LIBRARY.filter(([, json]) => exceedsLimit(json, modelProfile('Chromecast')));
    expect(capable.length).toBeGreaterThanOrEqual(6);
    // …and at least one of them is the film the television actually refused.
    expect(rawAudioChannels(fixture.mkvLegoMarvel())).toEqual([6]);
  });
});

// --- 7i: one source of truth, stated behaviourally ---------------------------

describe('QA 7i — the job builder has no opinion about channels', () => {
  it('builds identical arguments for a 5.1 source and a stereo one, given the same plan', () => {
    // *"Fails if the rule lives anywhere but the classifier."* The developer's version of
    // this greps `ffmpeg-job.ts` for `.channels`, which passes in both states and would miss
    // a second source of truth introduced in `output-profiles.ts` or in the pipeline. This
    // one is behavioural: the job builder is handed the same plan twice and must not be able
    // to tell the two films apart, because it is never told which film it has.
    const plan: JobRequest['plan'] = {
      kind: 'transcode',
      container: 'mp4',
      video: 'copy',
      audio: 'aac',
      subtitleTracks: [],
    };
    const stereo = buildArgs(jobRequest(plan, modelProfile('Chromecast')), BASELINE_OUTPUT);
    const surround = buildArgs(jobRequest(plan, modelProfile('Chromecast Ultra')), BASELINE_OUTPUT);
    expect(surround).toEqual(stereo);
    expect(stereo.join(' ')).toContain('-c:a aac -b:a 192k -ac 2');
  });
});

// --- 7j: the number exists on every profile a device can actually be given ---

describe('QA 7j — every profile a device can end up with carries the number', () => {
  it('holds for the table, for a television nobody has met, and for a narrowed one', () => {
    const names = [
      ...MODEL_TABLE.flatMap((entry) => entry.models),
      'AI PONT',
      'Some Telly Nobody Has Met',
      '',
      '   ',
    ];
    for (const name of names) {
      const table = modelProfile(name);
      expect(Number.isInteger(table.maxAudioChannels), name).toBe(true);
      expect(table.maxAudioChannels, name).toBeGreaterThanOrEqual(2);

      const refused = fixture.probeOf(fixture.mp4H264Aac51());
      const narrowed = resolveDeviceProfile(name, [narrowAfterRefusal(table, refused)]);
      expect(Number.isInteger(narrowed.maxAudioChannels), `${name} narrowed`).toBe(true);
      expect(narrowed.maxAudioChannels, `${name} narrowed`).toBeGreaterThanOrEqual(2);
    }
  });

  it('resolves the founder’s own television to the same limit whatever its name arrives as', () => {
    // **The property here is the normalisation, not the number**, and that is why this case
    // survived 2026-08-24 with its number inverted. `md=` arrives off the wire, and how it is
    // cased and padded is the television's business: trimmed and lower-cased it must land on
    // one profile every time. Before item 8b every spelling had to reach the *baseline*;
    // now every spelling has to reach the `ai-pont` entry and its measured 6. A `modelProfile`
    // that stopped trimming would, today, silently hand the founder's own set a stereo
    // downmix on every film — the same class of defect as before, in the other direction.
    for (const spelling of ['AI PONT', 'ai pont', '  AI PONT  ']) {
      expect(modelProfile(spelling).id, spelling).toBe('ai-pont');
      expect(modelProfile(spelling).maxAudioChannels, spelling).toBe(6);
    }
    // And the fall-through the trimming must not swallow: a name that is *nearly* the
    // founder's is a different television and gets the floor. Matching is exact, never by
    // prefix, which is the rule the table's own comment states.
    for (const spelling of ['AI PONT TV', 'AIPONT', 'AI  PONT']) {
      expect(modelProfile(spelling).id, spelling).toBe('baseline');
      expect(modelProfile(spelling).maxAudioChannels, spelling).toBe(2);
    }
  });
});

// --- 7k: the ladder, swept rather than sampled -------------------------------

describe('QA 7k — narrowing only ever narrows, and never past `aac`', () => {
  it('cannot raise a limit, whatever step is applied — including one read back from disk', () => {
    // `settings.json` is a file on the founder's PC. A step whose `maxChannels` is *wider*
    // than the profile it is applied to — an older recording, a hand edit, a device whose
    // table entry was tightened by a later version — must not give a television back a
    // capability it was narrowed out of. This is also what makes 8f's target direction safe.
    const steps: NarrowingStep[] = [
      { kind: 'cap-audio-channels', maxChannels: 8 },
      { kind: 'cap-audio-channels', maxChannels: 6 },
      { kind: 'cap-audio-channels', maxChannels: 2 },
    ];
    for (const [, profile] of PROFILES) {
      for (const step of steps) {
        expect(applyNarrowingStep(profile, step).maxAudioChannels).toBeLessThanOrEqual(
          profile.maxAudioChannels,
        );
      }
      // …and applying them all in any order lands on the floor, never below it.
      const all = steps.reduce(applyNarrowingStep, profile);
      expect(all.maxAudioChannels).toBe(2);
    }
  });

  it('converges for every film any profile calls ready, and keeps `aac` throughout', () => {
    // 7e's convergence property and 7k's `aac` rule, over the whole library rather than the
    // single Ultra case in `d1-audio-channels.ts`. *"Fails if `classify` still returns ready
    // after the ladder has run."*
    for (const [profileName, base] of PROFILES) {
      for (const [fixtureName, json] of LIBRARY) {
        const refused = fixture.probeOf(json);
        if (classify(refused, base).kind !== 'ready') continue;
        let profile = base;
        let rounds = 0;
        while (rounds < 12) {
          const downgrade = narrowAfterRefusal(profile, refused);
          if (downgrade.steps.length === 0) break;
          profile = downgrade.steps.reduce(applyNarrowingStep, profile);
          expect(profile.audio, `${profileName} / ${fixtureName}`).toContain('aac');
          rounds += 1;
        }
        expect(profile.audio, `${profileName} / ${fixtureName}`).toContain('aac');
        expect(
          classify(refused, profile).kind,
          `${profileName} / ${fixtureName} is still promised after the ladder ran`,
        ).not.toBe('ready');
      }
    }
  });
});

describe('QA 7k — every narrowing the ladder can produce survives a restart', () => {
  it('round-trips the whole ladder, because one unrecognised step drops the entire file', () => {
    // **The blast radius is bigger than the criterion says.** `store.load()` does not skip a
    // step it cannot parse — it quarantines the *whole* `settings.json` and starts from
    // defaults, so an unrecognised narrowing costs every device's narrowings, the remembered
    // television, and the place the founder had got to in their film. The developer's own
    // test round-trips one `cap-audio-channels`; this one drives every step the ladder can
    // emit from every profile against every fixture, so the next rung added without a schema
    // entry fails here rather than on a founder's evening.
    const produced = new Map<string, NarrowingStep>();
    for (const [, base] of PROFILES) {
      for (const [, json] of LIBRARY) {
        const refused = fixture.probeOf(json);
        let profile = base;
        for (let round = 0; round < 12; round += 1) {
          const downgrade = narrowAfterRefusal(profile, refused);
          if (downgrade.steps.length === 0) break;
          for (const step of downgrade.steps) produced.set(JSON.stringify(step), step);
          profile = downgrade.steps.reduce(applyNarrowingStep, profile);
        }
      }
    }
    // The sweep has to have found something, and it has to include D1's own rung.
    expect(produced.size).toBeGreaterThan(3);
    expect([...produced.values()].some((step) => step.kind === 'cap-audio-channels')).toBe(true);

    return (async () => {
      const directory = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-qa-d1-store-'));
      const sink = createMemorySink();
      const makeStore = () =>
        createStore({
          logger: createLogger({ sink }),
          paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
        });
      try {
        const store = makeStore();
        await store.load();
        await store.rememberDevice('tv-qa' as DeviceId, 'Lounge TV', 'Chromecast Ultra');
        const steps = [...produced.values()];
        await store.recordDowngrade('tv-qa' as DeviceId, {
          at: 1_700_000_000_000,
          signature: {
            container: 'mp4',
            videoCodec: 'h264',
            videoProfile: 'High',
            videoLevel: 41,
            width: 1_920,
            height: 1_080,
            frameRate: 24,
            audioCodecs: ['aac'],
          },
          steps,
        });
        await store.flush();

        sink.lines.length = 0;
        const reopened = makeStore();
        await reopened.load();
        expect(
          sink.lines.filter((line) => line.includes('store.corrupt')),
          'the settings file was thrown away, taking every narrowing and the resume point with it',
        ).toEqual([]);
        expect(reopened.downgradesFor('tv-qa' as DeviceId)[0]?.steps).toEqual(steps);
      } finally {
        await fsp.rm(directory, { recursive: true, force: true });
      }
    })();
  });
});

// --- 8f: the target the selftest grades an artifact against ------------------

describe('QA 8f — the model table’s limit is never stricter than the engine’s', () => {
  it('can miss a narrowing, and can never invent a failure', () => {
    // The developer flagged this seam themselves: `deviceChannelLimit()` in the `m3`
    // scenario reads `modelProfile(model).maxAudioChannels`, while the engine classifies
    // against `resolveDeviceProfile(model, downgrades)`. The claimed direction is only safe
    // if narrowing can never widen — proved here for every model against every downgrade the
    // ladder can produce from the library, plus a hand-written wide one.
    const handWritten = {
      at: 0,
      signature: {
        container: 'mp4' as const,
        videoCodec: 'h264',
        videoProfile: 'High',
        videoLevel: 41,
        width: 1_920,
        height: 1_080,
        frameRate: 24,
        audioCodecs: ['aac'],
      },
      steps: [{ kind: 'cap-audio-channels' as const, maxChannels: 8 }],
    };
    for (const entry of MODEL_TABLE) {
      for (const model of entry.models) {
        const table = modelProfile(model).maxAudioChannels;
        const downgrades = LIBRARY.map(([, json]) =>
          narrowAfterRefusal(modelProfile(model), fixture.probeOf(json)),
        );
        for (const downgrade of [...downgrades, handWritten]) {
          expect(
            resolveDeviceProfile(model, [downgrade]).maxAudioChannels,
            `${model} resolved wider than the table`,
          ).toBeLessThanOrEqual(table);
        }
        expect(resolveDeviceProfile(model, downgrades).maxAudioChannels).toBeLessThanOrEqual(table);
      }
    }
  });
});

// --- 7l: prepared once, and the replacement is accepted ----------------------

describe('QA 7l — the replacement satisfies the rule that rejected its predecessor', () => {
  it('accepts our own output for every film any profile sends to preparation', () => {
    // *"Fails if the film is re-prepared on every subsequent selection."* One fixture pair
    // proves it for one film; a rule that rejects its own output for **any** film in the
    // library is an unbounded wait, so the whole library is swept. The artifact is built
    // from the shipping `audioArgs`, so removing the downmix flag fails this too.
    //
    // `nest-hub` is excluded and the reason is a **separate, pre-existing defect** pinned in
    // the next case: its picture box is 720p, the output box is 1080p, and `outputProfileFor`
    // ignores the device profile — so its artifacts are rejected for their resolution, which
    // is not D1's rule and would mask D1's if it were folded in here.
    for (const [profileName, profile] of PROFILES) {
      if (profileName === 'nest-hub') continue;
      for (const [fixtureName, json] of LIBRARY) {
        const source = fixture.probeOf(json);
        const verdict = classify(source, profile);
        if (verdict.plan.kind === 'none') continue;
        if (source.durationSec === null) continue;
        const artifact = fixture.probeOf(artifactAsWeWriteIt(source.durationSec));
        expect(
          isReusableArtifact(source, artifact, profile),
          `${profileName} / ${fixtureName} would be prepared again on every selection`,
        ).toBe(true);
      }
    }
  });

  it('the sound in our own output is decodable by every profile, Nest Hub included', () => {
    // The audio half of the clause above, held for **every** profile with no exclusions: the
    // artifact's sound must never be the reason a prepared file is rejected.
    for (const [profileName, profile] of PROFILES) {
      const artifact = fixture.probeOf(artifactAsWeWriteIt(6_990));
      const detail = classify(artifact, profile).detail;
      expect(
        detail.audio.map((track) => track.supported),
        `${profileName} cannot decode the sound we write`,
      ).toEqual([true]);
    }
  });

  it('a pre-fix 5.1 sibling is refused, and refused for the channel count alone', () => {
    // The two files differ in one number. If the rejection came from anything else — the
    // duration tolerance, the container, the picture — this criterion would be passing for
    // the wrong reason.
    const source = fixture.probeOf(fixture.mkvH264Aac51());
    const chromecast = modelProfile('Chromecast');
    expect(
      isReusableArtifact(source, fixture.probeOf(fixture.preparedSibling51(6_990)), chromecast),
    ).toBe(false);
    expect(
      isReusableArtifact(source, fixture.probeOf(fixture.preparedSibling(6_990)), chromecast),
    ).toBe(true);
    // …and on a television that decodes 5.1 the same old artifact is still perfectly good,
    // so nothing is re-prepared for the sake of the rule. **This clause is the reason the
    // case is not just "the count is compared"**: a rejection rule that fired everywhere
    // would re-convert a pre-D1 file that the founder's own set can play perfectly well, on
    // every selection, for ever. It was written about the Ultra; the Ultra is measured at 2
    // since 2026-08-24 and the `AI PONT` is the only set left that can hold the role.
    expect(
      isReusableArtifact(
        source,
        fixture.probeOf(fixture.preparedSibling51(6_990)),
        modelProfile('AI PONT'),
      ),
    ).toBe(true);
    // …and refused again on the Ultra, which is the same file and the same rule reaching the
    // opposite answer purely on the device's measured limit.
    expect(
      isReusableArtifact(
        source,
        fixture.probeOf(fixture.preparedSibling51(6_990)),
        modelProfile('Chromecast Ultra'),
      ),
    ).toBe(false);
  });

  it('an artifact whose channel count ffprobe will not state is never reusable — and what that costs', () => {
    // **Characterisation, not approval.** `channels: null` is treated as too many wherever it
    // appears, and a prepared file is judged by the same rule as a source (7l). So if ffprobe
    // ever declined to describe the sound in *our own output*, that film would be re-prepared
    // on every single selection, for ever — 7l's sharpest failure clause, reached through the
    // `null` ruling rather than through the channel count.
    //
    // It is not reachable today: every artifact this product writes is a faststart MP4 of
    // AAC-LC that ffprobe describes fully. It is recorded here so that the day something
    // changes the output container, the codec, or the ffprobe build, this line is the one
    // that says what the founder will experience.
    const source = fixture.probeOf(
      fixture.report({
        formatName: 'matroska,webm',
        streams: [fixture.videoStream(), fixture.surroundAudioStream()],
      }),
    );
    const undescribable = fixture.probeOf(
      fixture.report({
        streams: [fixture.videoStream(), fixture.unmeasuredAudioStream()],
      }),
    );
    expect(isReusableArtifact(source, undescribable, modelProfile('Chromecast'))).toBe(false);
  });
});

// --- The shapes a rule about measurements gets wrong -------------------------

describe('QA — the edges of a rule that reads a number off every audio stream', () => {
  it('a film with no sound at all is still Ready to cast, not converted for silence', () => {
    // `audioMatches.every(...)` over an empty list is `true`, which is the right answer and
    // an easy one to lose: a rule phrased as "every stream must state a count within the
    // limit" would refuse a silent film for having stated nothing. A home video, a converted
    // GIF, a film whose audio track was stripped — none of them may be sent to a conversion
    // that has nothing to convert.
    const silent = fixture.probeOf(fixture.report({ streams: [fixture.videoStream()] }));
    for (const [profileName, profile] of PROFILES) {
      const verdict = classify(silent, profile);
      if (verdict.plan.kind === 'transcode') {
        // Only ever for the picture — a Nest Hub's 720p box. Never for the silence.
        expect(verdict.plan.audio, profileName).toBe('copy');
        continue;
      }
      expect(verdict.kind, profileName).toBe('ready');
      expect(verdict.plan.kind, profileName).toBe('none');
    }
  });

  it('pre-existing, and not D1: a Nest Hub re-prepares the same film on every selection', () => {
    // **Found while sweeping for 7l, and reported rather than fixed.** `outputProfileFor()`
    // takes the device profile as `_profile` and ignores it, so every conversion is written
    // into the 1080p baseline box. A `nest-hub` plays 720p at most, so the artifact it just
    // waited 23 minutes for is judged unplayable the next time the film is chosen — and
    // prepared again, for ever. It is the identical shape to 7l's failure clause, on the
    // resolution axis instead of the channel one, and D1 neither caused it nor fixes it.
    //
    // No founder device is a Nest Hub today, which is why this is a pin and not a stop-ship.
    // The line to delete is this whole case, on the day the output box learns to read the
    // profile it is handed.
    const hub = modelProfile('nest hub');
    expect(outputProfileFor(hub, 'libx264').maxHeight).toBe(1_080);
    const source = fixture.probeOf(fixture.mp4H264Aac());
    expect(classify(source, hub).kind).toBe('convert');
    const artifact = fixture.probeOf(artifactAsWeWriteIt(6_990));
    expect(isReusableArtifact(source, artifact, hub)).toBe(false);
  });

  it('`channels: 0` is a measurement we did not get, not a film with no channels', () => {
    // ffprobe prints `0` for some broken headers, and the probe parser folds that to `null`
    // on the way in. Both spellings have to reach the same answer or the rule has a hole
    // exactly the width of one malformed file.
    const zero = fixture.probeOf(
      fixture.report({ streams: [fixture.videoStream(), fixture.audioStream({ channels: 0 })] }),
    );
    expect(zero.streams.find((s) => s.kind === 'audio')?.channels).toBeNull();
    const verdict = classify(zero, modelProfile('Chromecast'));
    expect(verdict.kind).toBe('convert');
    expect(verdict.plan).toMatchObject({ audio: 'aac' });
  });

  it('one 5.1 track beside a stereo one converts both, and the result is reusable', () => {
    // A film with a surround track and a stereo commentary. `-map 0:a?` carries every audio
    // stream and the output arguments apply to all of them, so the artifact is uniformly
    // stereo — but the classifier has to refuse the *file*, not just the widest stream.
    const mixed = fixture.report({
      streams: [
        fixture.videoStream(),
        fixture.surroundAudioStream({ index: 1 }),
        fixture.audioStream({ index: 2 }),
      ],
    });
    const chromecast = modelProfile('Chromecast');
    const source = fixture.probeOf(mixed);
    const verdict = classify(source, chromecast);
    expect(verdict.kind).toBe('convert');
    expect(verdict.plan).toMatchObject({ video: 'copy', audio: 'aac' });
    expect(verdict.detail.audio.map((track) => track.supported)).toEqual([false, true]);
    const artifact = fixture.probeOf(artifactAsWeWriteIt(source.durationSec ?? 6_990));
    expect(isReusableArtifact(source, artifact, chromecast)).toBe(true);
  });

  it('the log carries the number that explains the conversion (D1’s own reason to exist)', () => {
    // On the night of the defect the only way to learn the sound was 5.1 was to probe a
    // published segment by hand. `channels` beside `supported: false` in `file.checked` is
    // the whole explanation, and it is the field a future evening will be diagnosed from.
    const verdict = classify(fixture.probeOf(fixture.mkvLegoMarvel()), modelProfile('Chromecast'));
    expect(verdict.detail.audio).toEqual([
      { index: 1, codec: 'aac', channels: 6, supported: false },
    ]);
  });
});
