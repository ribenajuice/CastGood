import fs from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  classify,
  describeApproxSeconds,
  isReusableArtifact,
  type Verdict,
} from '../../src/engine/prepare/classify.js';
import {
  applyNarrowingStep,
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
  narrowAfterRefusal,
  resolveDeviceProfile,
} from '../../src/engine/prepare/device-profiles.js';
import { parseFfprobeReport, parseFfprobeStdout } from '../../src/engine/media/ffprobe.js';
import { PREPARATION } from '../../src/engine/config.js';
import type { DeviceProfile } from '../../src/engine/types.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * Milestone 3a, criteria **7a–7e** and **8e**: what CastGood tells the founder about a file,
 * before anything is prepared and before anything is cast.
 *
 * Everything here is **[logic]** and every case is a fixture, because the classifier is a
 * pure function — no I/O, no clock, no device. That is what lets the awkward files be tested
 * at all: a file with no video in it, a part-downloaded header, an MKV whose subtitles are
 * pictures, 4K HEVC against a television that cannot take it, and a file that is already one
 * of our own prepared siblings. Those are the files a real evening produces and the ones a
 * happy-path suite never has.
 *
 * It proves nothing about a television. Whether the `AI PONT` accepts what we call Tier 1 is
 * the `check` selftest scenario and criterion 7e's safety net — which is itself tested here,
 * because the safety net is arithmetic even though the refusal is not.
 */

const ULTRA = modelProfile('Chromecast Ultra');
const UNKNOWN = modelProfile('AI PONT');

function verdictOf(json: unknown, profile: DeviceProfile = BASELINE_PROFILE): Verdict {
  return classify(fixture.probeOf(json), profile);
}

/** Every founder-visible string in a verdict, and nothing else. */
function screenText(verdict: Verdict): string {
  return [verdict.headline, verdict.reason ?? '', verdict.subtitleNotice ?? ''].join(' ');
}

describe('7a — exactly four verdicts, and the founder reads a sentence', () => {
  it('says Ready to cast for a file the device already plays', () => {
    const verdict = verdictOf(fixture.mp4H264Aac());
    expect(verdict.kind).toBe('ready');
    expect(verdict.tier).toBe(1);
    expect(verdict.plan).toEqual({ kind: 'none' });
    expect(verdict.headline).toBe('Ready to cast');
  });

  it('says Ready in about <time> when only the packaging is wrong', () => {
    const verdict = verdictOf(fixture.mkvH264Aac());
    expect(verdict.kind).toBe('remux');
    expect(verdict.tier).toBe(2);
    expect(verdict.plan).toMatchObject({ kind: 'remux', container: 'mp4' });
    expect(verdict.headline).toMatch(/^Ready in about .+$/);
  });

  it('says Needs converting — about <time> when a stream genuinely mismatches', () => {
    const verdict = verdictOf(fixture.mkvH264Ac3());
    expect(verdict.kind).toBe('convert');
    expect(verdict.tier).toBe(3);
    // The picture is copied; only the sound is re-encoded. That is the difference between
    // six minutes and an hour, and the plan has to say so.
    expect(verdict.plan).toMatchObject({ kind: 'transcode', video: 'copy', audio: 'aac' });
    expect(verdict.headline).toMatch(/^Needs converting — about .+$/);
  });

  it("says This file can't be cast, with a reason a person can act on", () => {
    const verdict = verdictOf(fixture.audioOnly());
    expect(verdict.kind).toBe('impossible');
    expect(verdict.tier).toBeNull();
    expect(verdict.headline).toBe("This file can't be cast");
    expect(verdict.reason).toBe("There's no video in this file.");
    expect(verdict.estimateSeconds).toBeNull();
  });

  it('never puts a codec, a profile, a level, a resolution or a path on screen', () => {
    const cases: [string, unknown, DeviceProfile][] = [
      ['tier 1', fixture.mp4H264Aac(), BASELINE_PROFILE],
      ['tier 2', fixture.mkvH264Aac(), BASELINE_PROFILE],
      ['tier 3 audio', fixture.mkvH264Ac3(), BASELINE_PROFILE],
      ['tier 3 video', fixture.mp4Hevc4k(), BASELINE_PROFILE],
      ['4k on an ultra', fixture.mp4Hevc4k(), ULTRA],
      ['webm', fixture.webmVp9Opus(), BASELINE_PROFILE],
      ['60 fps', fixture.mp4H264_60fps(), BASELINE_PROFILE],
      ['10-bit', fixture.mp4H264High10(), BASELINE_PROFILE],
      ['picture subtitles', fixture.mkvWithPgs(), BASELINE_PROFILE],
      ['text subtitles', fixture.mkvWithSrt(), BASELINE_PROFILE],
      ['no video', fixture.audioOnly(), BASELINE_PROFILE],
      ['truncated', fixture.truncatedHeader(), BASELINE_PROFILE],
    ];

    // Every word 7a forbids: the codec names ffprobe uses, the shorthand a person might
    // type instead, profile and level vocabulary, resolutions, and anything path-shaped.
    const forbidden = [
      /h\.?26[45]/i,
      /hevc/i,
      /avc/i,
      /vp[89]/i,
      /av1/i,
      /aac/i,
      /ac-?3/i,
      /mp3/i,
      /opus/i,
      /vorbis/i,
      /flac/i,
      /pgs|vobsub|subrip|mov_text|dvd_subtitle/i,
      /\bmkv\b|\bmatroska\b|\bmp4\b|\bwebm\b/i,
      /\bprofile\b|\blevel\b|\bmain 10\b|\bhigh\b/i,
      /\d{3,4}p\b/,
      /\d{3,4}x\d{3,4}/,
      /\bfps\b|frames? per second/i,
      /[/\\]|\.\w{3}\b/,
      /ffmpeg|ffprobe/i,
    ];

    for (const [name, json, profile] of cases) {
      const text = screenText(classify(fixture.probeOf(json), profile));
      for (const pattern of forbidden) {
        expect(text, `${name} leaked ${String(pattern)}`).not.toMatch(pattern);
      }
    }
  });

  it('keeps the evidence for the log, where it belongs', () => {
    const verdict = verdictOf(fixture.mp4Hevc4k());
    expect(verdict.detail.video?.codec).toBe('hevc');
    expect(verdict.detail.video?.failed).toContain('codec');
    expect(verdict.detail.profileId).toBe('baseline');
  });
});

describe('7a — the same file, a different television', () => {
  it('is a conversion on an unknown set and Ready to cast on an Ultra', () => {
    expect(verdictOf(fixture.mp4Hevc4k(), UNKNOWN).kind).toBe('convert');
    expect(verdictOf(fixture.mp4Hevc4k(), ULTRA).kind).toBe('ready');
  });

  it('gives an unrecognised model the baseline and nothing more', () => {
    // **This case used to be written about `AI PONT`, and cannot be any more.** That was the
    // founder's own third-party set and the perfect example of an `md=` string nobody has
    // documented — until checklist item 8b measured it decoding 5.1 AAC on 2026-08-24 and it
    // earned a model-table entry (`ai-pont`, the baseline plus that one number). A device in
    // the table is by definition recognised, so using it here would test the opposite of what
    // the case is named for, and would go green for the wrong reason every time.
    //
    // The replacement is chosen to stay unrecognised: no manufacturer will ship a receiver
    // announcing itself as this, so no future widening of the table can quietly hollow the
    // case out the way the `AI PONT` just did.
    expect(modelProfile('Nonesuch Receiver 9000 (not a real md= string)')).toEqual(
      BASELINE_PROFILE,
    );
    expect(modelProfile('')).toEqual(BASELINE_PROFILE);
    expect(modelProfile(null)).toEqual(BASELINE_PROFILE);
    // Not by prefix: a third-party set whose name starts the same way is not that device.
    expect(modelProfile('Chromecast Ultra HD TV')).toEqual(BASELINE_PROFILE);
    // …and now that the founder's own set is in the table, the same rule guards it too: the
    // one entry granted a capability above the floor must not spread to its near-namesakes.
    expect(modelProfile('AI PONT TV')).toEqual(BASELINE_PROFILE);
  });

  it('has no model-table entry that is narrower than the baseline it claims to widen', () => {
    for (const entry of MODEL_TABLE) {
      const h264 = entry.profile.video.find((capability) => capability.codec === 'h264');
      expect(h264, `${entry.profile.id} must still play the baseline codec`).toBeDefined();
      expect(entry.profile.containers).toContain('mp4');
      expect(entry.profile.audio).toContain('aac');
    }
  });
});

/**
 * The test that exists because this is the failure that reaches a television.
 *
 * `baselineCanPlay` is written **from the 2026-08-13 ADR's own words**, over the raw ffprobe
 * JSON, sharing not one line with the classifier. If the classifier ever says *Ready to
 * cast* about a file this predicate refuses, one of the two is wrong and the founder finds
 * out from a black screen.
 */
describe('the safety rail: Ready to cast is never said about a file the baseline cannot play', () => {
  function baselineCanPlay(json: unknown): boolean {
    const report = json as {
      streams?: Record<string, unknown>[];
      format?: Record<string, unknown>;
    };
    const formatNames = String(report.format?.['format_name'] ?? '').split(',');
    if (!formatNames.some((name) => ['mp4', 'mov', 'm4v', '3gp'].includes(name.trim()))) {
      return false; // "MP4 container"
    }
    const streams = report.streams ?? [];
    const video = streams.filter(
      (stream) =>
        stream['codec_type'] === 'video' &&
        (stream['disposition'] as Record<string, unknown> | undefined)?.['attached_pic'] !== 1,
    );
    if (video.length === 0) return false;
    const primary = video[0] as Record<string, unknown>;
    if (primary['codec_name'] !== 'h264') return false; // "H.264"
    if (!['Constrained Baseline', 'Baseline', 'Main', 'High'].includes(String(primary['profile'])))
      return false; // "High" and below
    const level = Number(primary['level']);
    if (!Number.isFinite(level) || level > 41) return false; // "≤ L4.1"
    const width = Number(primary['width']);
    const height = Number(primary['height']);
    if (!Number.isFinite(width) || !Number.isFinite(height)) return false;
    if (Math.max(width, height) > 1920 || Math.min(width, height) > 1080) return false; // "≤ 1080p"
    const [num, den] = String(primary['avg_frame_rate'] ?? '0/0').split('/');
    const fps = Number(num) / Number(den ?? '1');
    if (!Number.isFinite(fps) || fps > 30.5) return false; // "30"
    const audio = streams.filter((stream) => stream['codec_type'] === 'audio');
    return audio.every((stream) => ['aac', 'mp3'].includes(String(stream['codec_name']))); // "AAC-LC/MP3"
  }

  const everyFixture: [string, unknown][] = [
    ['mp4 h264 aac', fixture.mp4H264Aac()],
    ['mkv h264 aac', fixture.mkvH264Aac()],
    ['mkv h264 ac3', fixture.mkvH264Ac3()],
    ['mp4 hevc 4k', fixture.mp4Hevc4k()],
    ['mp4 h264 60fps', fixture.mp4H264_60fps()],
    ['mp4 h264 high10', fixture.mp4H264High10()],
    ['webm vp9 opus', fixture.webmVp9Opus()],
    ['mkv + pgs', fixture.mkvWithPgs()],
    ['mkv + srt', fixture.mkvWithSrt()],
    ['mp4 + cover art', fixture.mp4WithCoverArt()],
    ['audio only', fixture.audioOnly()],
    ['truncated header', fixture.truncatedHeader()],
    ['prepared sibling', fixture.preparedSibling()],
  ];

  it.each(everyFixture)('%s', (_name, json) => {
    const verdict = classify(fixture.probeOf(json), BASELINE_PROFILE);
    if (verdict.kind === 'ready') {
      expect(baselineCanPlay(json)).toBe(true);
    }
  });

  it('and the rail is not vacuous — the fixture set contains both answers', () => {
    const verdicts = everyFixture.map(
      ([, json]) => classify(fixture.probeOf(json), BASELINE_PROFILE).kind,
    );
    expect(verdicts).toContain('ready');
    expect(verdicts).toContain('remux');
    expect(verdicts).toContain('convert');
    expect(verdicts).toContain('impossible');
  });
});

describe('7b — a check never prepares and never casts', () => {
  it('reads nothing and writes nothing: the classifier imports no I/O at all', async () => {
    for (const file of [
      'src/engine/prepare/classify.ts',
      'src/engine/prepare/device-profiles.ts',
    ]) {
      const source = await fs.readFile(file, 'utf8');
      const imports = [...source.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${String(specifier)}`).not.toMatch(
          /^node:|^fs|^net|^http|^child_process|media-server|\/cast\//,
        );
      }
    }
  });

  it('has no clock and no randomness: it is the same answer twice, forever', () => {
    const now = Date.now;
    const random = Math.random;
    try {
      Date.now = () => {
        throw new Error('the classifier read a clock');
      };
      Math.random = () => {
        throw new Error('the classifier rolled a die');
      };
      const first = verdictOf(fixture.mkvH264Ac3());
      const second = verdictOf(fixture.mkvH264Ac3());
      expect(first).toEqual(second);
    } finally {
      Date.now = now;
      Math.random = random;
    }
  });
});

describe('7c — a film prepared before says so', () => {
  it('is Ready to cast, and tells the founder why there is no wait', () => {
    const verdict = classify(fixture.probeOf(fixture.preparedSibling()), BASELINE_PROFILE, {
      alreadyPrepared: true,
    });
    expect(verdict.kind).toBe('ready');
    expect(verdict.reason).toMatch(/prepared/i);
  });

  it('reuses a sibling only when it is the same film and this device can play it untouched', () => {
    const source = fixture.probeOf(fixture.mkvH264Ac3());
    expect(
      isReusableArtifact(source, fixture.probeOf(fixture.preparedSibling()), BASELINE_PROFILE),
    ).toBe(true);

    // A different cut, a trailer, another language: the duration is what tells them apart.
    expect(
      isReusableArtifact(source, fixture.probeOf(fixture.preparedSibling(6_900)), BASELINE_PROFILE),
    ).toBe(false);
    expect(
      isReusableArtifact(
        source,
        fixture.probeOf(
          fixture.preparedSibling(6_990 + PREPARATION.artifactDurationToleranceSec / 2),
        ),
        BASELINE_PROFILE,
      ),
    ).toBe(true);

    // An artifact prepared for a wider television is not reusable on a narrow one. That
    // second test *is* the profile key (ADR 2026-08-19), derived rather than remembered.
    const wide = fixture.probeOf(fixture.mp4Hevc4k());
    expect(isReusableArtifact(source, wide, BASELINE_PROFILE)).toBe(false);
    expect(isReusableArtifact(source, wide, ULTRA)).toBe(true);
  });
});

describe('7d — a file nothing can handle is refused at the check', () => {
  it('names the missing picture rather than a codec', () => {
    const verdict = verdictOf(fixture.audioOnly());
    expect(verdict.kind).toBe('impossible');
    expect(verdict.detail.reasonCode).toBe('no-video');
  });

  it('treats a part-downloaded header as damaged, not as something to convert', () => {
    const verdict = verdictOf(fixture.truncatedHeader());
    expect(verdict.kind).toBe('impossible');
    expect(verdict.detail.reasonCode).toBe('damaged');
    expect(verdict.reason).toBe('This file looks damaged or unfinished.');
  });

  it('is not fooled by cover art into thinking the artwork is the film', () => {
    const verdict = verdictOf(fixture.mp4WithCoverArt());
    expect(verdict.kind).toBe('ready');
    expect(verdict.detail.video?.codec).toBe('h264');
  });
});

describe('7e — a television that refuses a file teaches us something permanent', () => {
  /**
   * The property the safety net rests on: after a refusal, the same file is **never** called
   * *Ready to cast* again — the next plan is a repackage or a conversion, which is what
   * criterion 7e promises the founder sees instead of an error.
   */
  const refusals: [string, unknown, DeviceProfile][] = [
    ['4K HEVC on an Ultra', fixture.mp4Hevc4k(), ULTRA],
    ['WebM on an Ultra', fixture.webmVp9Opus(), ULTRA],
    ['a plain 1080p MP4 on an unknown set', fixture.mp4H264Aac(), UNKNOWN],
    ['60 fps on an Ultra', fixture.mp4H264_60fps(), ULTRA],
    ['a prepared sibling on an unknown set', fixture.preparedSibling(), UNKNOWN],
  ];

  it.each(refusals)(
    '%s: the re-plan is preparation, never the same load again',
    (_name, json, profile) => {
      const refused = fixture.probeOf(json);
      expect(classify(refused, profile).kind, 'fixture must start out Tier 1').toBe('ready');

      const downgrade = narrowAfterRefusal(profile, refused, 1_755_000_000_000);
      expect(downgrade.steps.length).toBeGreaterThan(0);

      const narrowed = downgrade.steps.reduce(applyNarrowingStep, profile);
      const replan = classify(refused, narrowed);
      expect(replan.kind).not.toBe('ready');
      expect(replan.kind).not.toBe('impossible');
      expect(replan.tier === 2 || replan.tier === 3).toBe(true);
    },
  );

  it('remembers it as a record the profile can be rebuilt from, on any later run', () => {
    const refused = fixture.probeOf(fixture.mp4Hevc4k());
    const downgrade = narrowAfterRefusal(ULTRA, refused, 1_755_000_000_000);

    // What the store keeps: steps and the evidence. Rebuilt from `md=` plus that record,
    // the profile is the narrowed one — which is what "permanently" means when the app has
    // been closed and reopened in between.
    const rebuilt = resolveDeviceProfile('Chromecast Ultra', [downgrade]);
    expect(classify(refused, rebuilt).kind).not.toBe('ready');
    expect(downgrade.signature.videoCodec).toBe('hevc');
    expect(downgrade.at).toBe(1_755_000_000_000);

    // …and it only ever narrows: nothing the record can do widens a profile.
    expect(rebuilt.video.length).toBeLessThanOrEqual(ULTRA.video.length);
    expect(rebuilt.audio.length).toBeLessThanOrEqual(ULTRA.audio.length);
    expect(rebuilt.containers.length).toBeLessThanOrEqual(ULTRA.containers.length);
  });

  it('can narrow the profile axis too, for a device that was believed about 10-bit', () => {
    // No device in the model table promises 10-bit today, so this is the axis a *future*
    // table entry would reach — and the ladder has to have a rung on it before then.
    const tolerant: DeviceProfile = {
      ...ULTRA,
      id: 'tolerant',
      video: ULTRA.video.map((capability) =>
        capability.codec === 'h264' ? { ...capability, maxProfile: 'high 10' } : capability,
      ),
    };
    const refused = fixture.probeOf(fixture.mp4H264High10());
    expect(classify(refused, tolerant).kind).toBe('ready');
    const downgrade = narrowAfterRefusal(tolerant, refused);
    expect(downgrade.steps).toContainEqual({
      kind: 'cap-profile',
      codec: 'h264',
      maxProfile: 'high',
    });
    expect(classify(refused, downgrade.steps.reduce(applyNarrowingStep, tolerant)).kind).toBe(
      'convert',
    );
  });

  it('narrows one axis at a time rather than throwing the profile away', () => {
    const refused = fixture.probeOf(fixture.mp4Hevc4k());
    const downgrade = narrowAfterRefusal(ULTRA, refused);
    const rebuilt = resolveDeviceProfile('Chromecast Ultra', [downgrade]);
    // The Ultra refused an HEVC file. It has not thereby stopped playing H.264.
    expect(rebuilt.video.some((capability) => capability.codec === 'h264')).toBe(true);
    expect(classify(fixture.probeOf(fixture.mp4H264Aac()), rebuilt).kind).toBe('ready');
  });

  it('stops when there is nothing left to take away, instead of narrowing forever', () => {
    // A television that refuses a file already at the floor is telling us about the file or
    // about itself; there is no narrower profile to re-plan into, and the caller reports it.
    const floor: DeviceProfile = {
      id: 'floor',
      video: [
        {
          codec: 'h264',
          maxProfile: 'baseline',
          maxLevel: 30,
          maxWidth: 854,
          maxHeight: 480,
          maxFramerate: 24,
        },
      ],
      audio: ['aac'],
      containers: ['mp4'],
      // Stereo is the floor of the audio axis too (D1): there is no rung below it, which is
      // what makes this profile genuinely the bottom of the ladder rather than nearly so.
      maxAudioChannels: 2,
    };
    const tiny = fixture.probeOf(
      fixture.report({
        streams: [
          fixture.videoStream({
            profile: 'Baseline',
            level: 30,
            width: 854,
            height: 480,
            coded_width: 854,
            coded_height: 480,
            r_frame_rate: '24/1',
            avg_frame_rate: '24/1',
          }),
          fixture.audioStream({ channels: 2 }),
        ],
      }),
    );
    expect(classify(tiny, floor).kind).toBe('ready');
    expect(narrowAfterRefusal(floor, tiny).steps).toEqual([]);
  });
});

describe('8e — preparation never silently discards a subtitle track', () => {
  it('says how many tracks and which languages will not survive, in one plain sentence', () => {
    const verdict = verdictOf(fixture.mkvWithPgs());
    expect(verdict.subtitleNotice).toBe(
      "2 subtitle tracks (English and French) are pictures rather than text, so they can't be carried into the prepared copy.",
    );
  });

  it('says nothing when nothing is lost — text tracks are carried, not dropped', () => {
    const verdict = verdictOf(fixture.mkvWithSrt());
    expect(verdict.subtitleNotice).toBeNull();
    // The plan carries the **language** as well as the index, because each track becomes a
    // file in the founder's folder and `Cars (CastGood).eng.vtt` has to be tellable from
    // `Cars (CastGood).spa.vtt` at a glance.
    expect(verdict.plan).toMatchObject({ subtitleTracks: [{ index: 2, language: 'eng' }] });
  });

  it('says nothing about a file that is not being prepared at all', () => {
    expect(verdictOf(fixture.mp4H264Aac()).subtitleNotice).toBeNull();
  });
});

describe('the subtitle cap — a film with 41 tracks keeps the English ones', () => {
  const tracksOf = (json: unknown): readonly { index: number; language: string | null }[] => {
    const plan = verdictOf(json).plan;
    return plan.kind === 'none' ? [] : plan.subtitleTracks;
  };

  it('carries every track at or under the cap, exactly as before', () => {
    const atCap = fixture.mkvWithManySubtitles(PREPARATION.subtitleTrackCap, 1);
    expect(tracksOf(atCap)).toHaveLength(PREPARATION.subtitleTrackCap);
    expect(verdictOf(atCap).subtitleNotice).toBeNull();
  });

  it('keeps only English once the film goes over the cap', () => {
    const many = fixture.mkvWithManySubtitles(41, 1);
    expect(tracksOf(many)).toEqual([{ index: 2, language: 'eng' }]);
  });

  it('keeps every English track when the film has several', () => {
    const tracks = tracksOf(fixture.mkvWithManySubtitles(41, 3));
    expect(tracks).toHaveLength(3);
    expect(tracks.every((track) => track.language === 'eng')).toBe(true);
  });

  it('says so in the verdict before the founder commits, and says where the rest went', () => {
    expect(verdictOf(fixture.mkvWithManySubtitles(41, 1)).subtitleNotice).toBe(
      'This film has 41 subtitle tracks, so only the English one will be kept beside the ' +
        'prepared copy — the other 40 (German, Spanish, Chinese and 3 more languages) stay ' +
        'in the original file.',
    );
  });

  it('never drops every track: no English at all still keeps the first the film lists', () => {
    const none = fixture.mkvWithManySubtitles(41, 0);
    expect(tracksOf(none)).toEqual([{ index: 2, language: 'ger' }]);
    expect(verdictOf(none).subtitleNotice).toContain('only the first will be kept');
  });

  it('counts languages it cannot name — the real film carries nine of them', () => {
    // Verified against the real `ffprobe` output for this film on 2026-08-21: 41 tracks,
    // 2 English kept, 39 dropped across 32 distinct languages. Counting only the ones we
    // have a display name for reported "20 more" where the truth is 29.
    const verdict = verdictOf(fixture.mkvAllQuiet());
    expect(verdict.subtitleNotice).toBe(
      'This film has 41 subtitle tracks, so only the 2 English ones will be kept beside the ' +
        'prepared copy — the other 39 (Arabic, Chinese, Czech and 29 more languages) stay ' +
        'in the original file.',
    );
    expect(tracksOf(fixture.mkvAllQuiet())).toEqual([
      { index: 10, language: 'eng' },
      { index: 11, language: 'eng' },
    ]);
  });

  it('caps a conversion as well as a repackage — the folder is the same folder', () => {
    // The film that found this bug converts rather than remuxes, and both plans write the
    // same `.vtt` files into the same folder, so the cap cannot live on one branch only.
    const remuxing = verdictOf(fixture.mkvWithManySubtitles(41, 1));
    expect(remuxing.kind).toBe('remux');

    const converting = verdictOf(fixture.mkvWithManySubtitles(41, 1, 'ac3'));
    expect(converting.kind).toBe('convert');
    expect(tracksOf(fixture.mkvWithManySubtitles(41, 1, 'ac3'))).toHaveLength(1);
  });
});

describe('7f — the 20-minute confirmation, decided by the same arithmetic', () => {
  it('asks first when the job is over LONG_PREP, and never below it', () => {
    const long = verdictOf(fixture.mp4Hevc4k());
    expect(long.estimateSeconds).toBeGreaterThan(PREPARATION.longPrepSeconds);
    expect(long.requiresConfirmation).toBe(true);

    const short = verdictOf(fixture.mkvH264Aac());
    expect(short.estimateSeconds).toBeLessThan(PREPARATION.longPrepSeconds);
    expect(short.requiresConfirmation).toBe(false);
  });

  it('states an estimate in words a person would use', () => {
    expect(describeApproxSeconds(3)).toBe('a few seconds');
    expect(describeApproxSeconds(22)).toBe('20 seconds');
    expect(describeApproxSeconds(75)).toBe('a minute');
    expect(describeApproxSeconds(350)).toBe('6 minutes');
    expect(describeApproxSeconds(4_660)).toBe('1 hour 20 minutes');
    expect(describeApproxSeconds(7_200)).toBe('2 hours');
  });

  it('estimates a picture re-encode from pixels, not from the length of the film', () => {
    // **The finding SPIKE-4 exists for** (2026-08-20). Measured on the founder's PC,
    // `libx264 -preset veryfast` ran at 24.3x real time on a 1280x528 film and 7.96x on a
    // 1080p one — three times apart — while both sat within 5% of each other at ~400
    // megapixels per second. A duration-based estimate is therefore not merely badly
    // calibrated: it is **blind to resolution**, and quotes a 4K film and a 480p film the
    // same wait for the same running time.
    const sameLength = { durationSec: 3_600 };
    const sd = classify(
      fixture.probeOf(
        fixture.report({
          ...sameLength,
          streams: [
            fixture.videoStream({ codec_name: 'hevc', width: 720, height: 400, coded_height: 400 }),
            fixture.audioStream(),
          ],
        }),
      ),
      BASELINE_PROFILE,
    );
    const uhd = classify(
      fixture.probeOf(
        fixture.report({
          ...sameLength,
          streams: [
            fixture.videoStream({
              codec_name: 'hevc',
              width: 3_840,
              height: 2_160,
              coded_height: 2_160,
            }),
            fixture.audioStream(),
          ],
        }),
      ),
      BASELINE_PROFILE,
    );

    expect(sd.kind).toBe('convert');
    expect(uhd.kind).toBe('convert');
    // Same running time, 28x the pixels. The old model gave these two identical estimates.
    const ratio = (uhd.estimateSeconds ?? 0) / (sd.estimateSeconds ?? 1);
    expect(ratio).toBeGreaterThan(20);
  });

  it('leaves an audio-only conversion measured in real time, because that is what binds it', () => {
    // Re-encoding only the sound leaves the picture a stream copy, and audio encoding really
    // is bound by the length of the film. Two units, on purpose — one of the few places in
    // this codebase where the *inconsistency* is the correct answer.
    const short = classify(
      fixture.probeOf(
        fixture.report({
          durationSec: 600,
          streams: [fixture.videoStream(), fixture.audioStream({ codec_name: 'dts' })],
        }),
      ),
      BASELINE_PROFILE,
    );
    const long = classify(
      fixture.probeOf(
        fixture.report({
          durationSec: 6_000,
          streams: [fixture.videoStream(), fixture.audioStream({ codec_name: 'dts' })],
        }),
      ),
      BASELINE_PROFILE,
    );
    expect(short.plan).toMatchObject({ video: 'copy', audio: 'aac' });
    expect((long.estimateSeconds ?? 0) / (short.estimateSeconds ?? 1)).toBeCloseTo(10, 0);
  });

  it('expects an H.264 conversion of an HEVC film to be bigger, not the same size (P1)', () => {
    // **Measured on the founder's own film** (2026-08-20): the pre-flight check said a job
    // needed 1.78 GB and ffmpeg wrote 3.43 GB. Estimating a conversion at the source's size
    // was called "the conservative direction" — true converting *from* H.264, exactly
    // backwards converting *to* it, which is the common case. Two terabytes free meant
    // nothing came of it; on a fuller drive it is P1 passing and P2 firing at 80%.
    const hevc = classify(
      fixture.probeOf(
        fixture.report({
          sizeBytes: 1_779_176_482,
          streams: [
            fixture.videoStream({ codec_name: 'hevc', profile: 'Main' }),
            fixture.audioStream(),
          ],
        }),
      ),
      BASELINE_PROFILE,
    );
    expect(hevc.kind).toBe('convert');
    expect(hevc.estimatedBytes).toBeGreaterThanOrEqual(3_400_000_000);

    // A repackage really is the same streams, so its estimate stays the source's size.
    const remux = classify(fixture.probeOf(fixture.mkvH264Aac()), BASELINE_PROFILE);
    expect(remux.kind).toBe('remux');
    expect(remux.estimatedBytes).toBe(remux.detail.sizeBytes);
  });

  it('never announces a job as shorter than a real full-length film managed (8b)', () => {
    // **The bound is the slowest *sustained* run, not the fastest clip**, and that
    // distinction cost a wrong estimate once. 60-second clips measured 362-413 Mpx/s; the
    // founder's real 113-minute conversion of one of those same films managed 258.8, and a
    // seed of 350 announced 15 minutes for a job that took 21. 8b forbids exactly that
    // direction. If anyone raises this above what a whole film has actually achieved, this
    // fails — and the number to beat is a full-length measurement, never a clip.
    expect(PREPARATION.throughput.videoMegapixelsPerSecond).toBeLessThanOrEqual(258);
  });

  it('takes the machine speed it is given rather than a hidden global', () => {
    const slow = classify(fixture.probeOf(fixture.mkvH264Aac()), BASELINE_PROFILE, {
      throughput: {
        remuxBytesPerSecond: 8_000_000,
        audioConvertSpeed: 20,
        videoMegapixelsPerSecond: 350,
      },
    });
    const fast = verdictOf(fixture.mkvH264Aac());
    expect(slow.estimateSeconds).toBeGreaterThan((fast.estimateSeconds ?? 0) * 5);
  });
});

describe('reading ffprobe: the parser trusts nothing it is handed', () => {
  it('keeps no file path from a report that contains one', () => {
    const probe = fixture.probeOf(fixture.mkvH264Aac());
    expect(JSON.stringify(probe)).not.toContain('Films');
    expect(JSON.stringify(probe)).not.toContain('\\');
  });

  it('reads the numbers ffprobe prints as strings, and the ratios it prints as fractions', () => {
    const probe = fixture.probeOf(fixture.mp4H264Aac());
    expect(probe.durationSec).toBeCloseTo(6_990, 3);
    expect(probe.sizeBytes).toBe(4_294_967_296);
    expect(probe.streams[0]?.frameRate).toBeCloseTo(23.976, 3);
    expect(probe.streams[0]?.width).toBe(1920);
    expect(probe.streams[1]?.language).toBe('eng');
    // `und` is ffprobe for "no language", and must not become a language called "und".
    expect(probe.streams[0]?.language).toBeNull();
  });

  it('returns null rather than a half-built result for something that is not media', () => {
    expect(parseFfprobeReport(fixture.notMedia())).toBeNull();
    expect(parseFfprobeReport(null)).toBeNull();
    expect(parseFfprobeReport('')).toBeNull();
    expect(parseFfprobeStdout('not json at all')).toBeNull();
    expect(parseFfprobeStdout('')).toBeNull();
  });

  it('survives a report with fields missing, misspelled or of the wrong type', () => {
    const probe = parseFfprobeReport({
      streams: [{ codec_type: 'video', codec_name: 'h264', width: 'wide', level: 'N/A' }],
      format: { format_name: 'mov,mp4', duration: 'N/A', size: -1 },
    });
    if (probe === null) throw new Error('a report with a stream in it must still parse');
    expect(probe.durationSec).toBeNull();
    expect(probe.sizeBytes).toBeNull();
    expect(probe.streams[0]?.width).toBeNull();
    // …and a file we cannot measure the picture of is refused, not guessed at.
    expect(classify(probe, BASELINE_PROFILE).kind).toBe('impossible');
  });

  it('tells an image subtitle track from a text one', () => {
    const probe = fixture.probeOf(fixture.mkvWithPgs());
    expect(probe.streams[2]?.subtitleForm).toBe('image');
    expect(fixture.probeOf(fixture.mkvWithSrt()).streams[2]?.subtitleForm).toBe('text');
  });
});

describe('estimates stay honest when the container is not forthcoming', () => {
  it('measures a file by its bitrate when the size field is missing', () => {
    const withSize = fixture.probeOf(fixture.report({ formatName: 'matroska,webm' }));
    const raw = fixture.report({ formatName: 'matroska,webm' }) as {
      format: Record<string, unknown>;
    };
    delete raw.format['size'];
    raw.format['bit_rate'] = '4915200';
    const withoutSize = fixture.probeOf(raw);

    expect(withoutSize.sizeBytes).toBeNull();
    const estimate = classify(withoutSize, BASELINE_PROFILE).estimateSeconds ?? 0;
    // 4.9 Mbit/s across 1:56:30 is roughly the 4 GB the size field would have reported, so
    // the estimate lands in the same minute rather than reading "a few seconds".
    expect(estimate).toBeGreaterThan(10);
    expect(estimate).toBeCloseTo(classify(withSize, BASELINE_PROFILE).estimateSeconds ?? 0, -1);
  });
});
