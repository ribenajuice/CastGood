import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { classify } from '../../src/engine/prepare/classify.js';
import { BASELINE_PROFILE, MODEL_TABLE } from '../../src/engine/prepare/device-profiles.js';
import type { DeviceProfile } from '../../src/engine/types.js';
import { REPACKAGE_FIXTURE_CHANNELS } from '../../src/engine/selftest/m3.js';
import * as fixture from './fixtures/ffprobe.js';

/**
 * **The `prepared` scenario's 9c leg: the fixture that replaces the film mid-scenario.**
 *
 * The third fixture defect of the same shape found on 2026-08-25, and the one that survived
 * two rounds of QA on the other two.
 *
 * `scenarioPrepared` measures which tier its Matroska fixture takes — `preparesInto` — from
 * a fixture built **stereo on purpose** (`REPACKAGE_FIXTURE_CHANNELS`), so that the leg
 * exercises the lossless repackage rather than a conversion. Every later assertion in the
 * scenario is graded against that same value. 9c then *replaced the source* with a shorter
 * film built by a hand-rolled `-map 0 -c copy`, which carried whatever sound the founder's
 * own film carried — 6 channels for every film in `D:\DUMP\Movies`.
 *
 * After D1 those are two different tiers on any television that decodes 2 channels. On the
 * Master bedroom Chromecast the product correctly re-checked the changed source and called
 * it an audio-only conversion; the instrument demanded a repackage and printed
 * `changedSourceIsRechecked: measured convert, target remux`. It had passed that morning
 * only because the film it was given was HEVC, where *both* fixtures are conversions and
 * the mismatch cancels out.
 *
 * The fix is to build the replacement through `makeMkvClip` at the same channel count as
 * the fixture it replaces, so the two differ in exactly one property — the duration, which
 * is the property 9c is about. This file is the arithmetic of that: **the expected tier and
 * the replacement's real tier agree on every television in the table, for either film the
 * founder might pass.**
 *
 * **Note, 2026-08-28.** `makeMkvClip` no longer stream-copies the picture either — it builds
 * one to the television's own profile, which is what makes `m3` gradeable in a single run.
 * The `PICTURES` sweep below therefore describes a fixture shape that can no longer occur,
 * and it is kept on purpose: it is the arithmetic of *why* a fixture inheriting the passed
 * film's properties is unsafe, which is the general rule both fixes are instances of. The
 * agreement it proves is now true for a second, stronger reason as well as the first.
 */

const PROFILES: readonly (readonly [string, DeviceProfile])[] = [
  ['baseline', BASELINE_PROFILE],
  ...MODEL_TABLE.map(
    (entry) => [entry.profile.id, entry.profile] as readonly [string, DeviceProfile],
  ),
];

/** The founder's two kinds of film, as the picture inside a Matroska fixture. */
const PICTURES: readonly (readonly [string, Record<string, unknown>])[] = [
  ['the libx264 comparison film', { codec_name: 'h264', profile: 'High', level: 40 }],
  ['an ordinary HEVC film', { codec_name: 'hevc', profile: 'Main 10', level: 120 }],
];

/**
 * What `makeMkvClip(source, target, channels)` produces, as ffprobe describes it: the
 * founder's picture stream-copied into Matroska with the sound re-encoded to `channels`.
 */
function mkvClip(channels: number, video: Record<string, unknown>): unknown {
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
 * The old 9c replacement: `-map 0 -c copy` of the founder's film into Matroska.
 *
 * Everything is carried, including the channel count — which is why it could not be relied
 * on to be anything in particular. 6 is what all thirty films in `D:\DUMP\Movies` measured
 * on 2026-08-24.
 */
function copiedFromTheFoundersFilm(video: Record<string, unknown>): unknown {
  return mkvClip(6, video);
}

describe('9c’s replacement film takes the tier the leg expects, on every television', () => {
  it('only the fixture’s own channel count agrees with `preparesInto` on every television', () => {
    // The sweep, rather than a restatement of the fix. `preparesInto` is measured on a
    // stereo fixture; the replacement can be built at any count ffmpeg will produce, and
    // exactly one of them gives the same answer on every television the founder owns. If
    // that ever stops being `REPACKAGE_FIXTURE_CHANNELS`, this case says so by name.
    const agreesEverywhere: number[] = [];
    for (const channels of [2, 6, 8]) {
      let agrees = true;
      for (const [, profile] of PROFILES) {
        for (const [, video] of PICTURES) {
          const preparesInto = classify(
            fixture.probeOf(mkvClip(REPACKAGE_FIXTURE_CHANNELS, video)),
            profile,
          ).kind;
          const replacement = classify(fixture.probeOf(mkvClip(channels, video)), profile).kind;
          if (replacement !== preparesInto) agrees = false;
          // Whatever the count, 9c's own promise must still be gradeable: the replacement
          // is always a preparation, never the sibling being handed back.
          expect(['remux', 'convert']).toContain(replacement);
        }
      }
      if (agrees) agreesEverywhere.push(channels);
    }
    expect(agreesEverywhere).toEqual([REPACKAGE_FIXTURE_CHANNELS]);
  });

  it('and the shipped leg builds it that way, through the same gate as every other fixture', () => {
    // Read from the source the selftest actually ships, because the arithmetic above is
    // only about this leg if this leg is what produces the file. The hand-rolled
    // `-map 0 -c copy` that carried the founder's own sound is named so it cannot come
    // back unnoticed.
    const source = fsSync.readFileSync(
      fileURLToPath(new URL('../../src/engine/selftest/m3.ts', import.meta.url)),
      'utf8',
    );
    const leg = source.slice(
      source.indexOf('--- 9c: a changed source is re-checked'),
      source.indexOf("'changedSourceIsRechecked'"),
    );
    expect(leg.length).toBeGreaterThan(200);
    expect(leg).toContain('makeMkvClip(');
    expect(leg).toContain('REPACKAGE_FIXTURE_CHANNELS');
    expect(leg).toContain('requireStereo(');
    expect(leg).not.toContain("'-map',\n        '0',\n        '-c',\n        'copy',");
  });

  it('the defect, as arithmetic: the old replacement disagreed on every 2-channel set', () => {
    // Red-first, kept as a record. This is the assertion that would have gone red on
    // 2026-08-24 had it existed, and the one line of the verdict the bedroom Chromecast
    // actually printed.
    let disagreements = 0;
    for (const [profileName, profile] of PROFILES) {
      for (const [filmName, video] of PICTURES) {
        const where = `${profileName} · ${filmName}`;
        const preparesInto = classify(
          fixture.probeOf(mkvClip(REPACKAGE_FIXTURE_CHANNELS, video)),
          profile,
        ).kind;
        const oldReplacement = classify(
          fixture.probeOf(copiedFromTheFoundersFilm(video)),
          profile,
        ).kind;
        if (profile.maxAudioChannels < 6 && preparesInto === 'remux') {
          // The exact failure: a repackage was expected and an audio-only conversion is
          // the correct answer.
          expect(preparesInto, where).toBe('remux');
          expect(oldReplacement, where).toBe('convert');
          disagreements += 1;
        }
      }
    }
    // If this ever becomes 0 the case above has stopped being evidence of anything, so it
    // is named rather than left implicit.
    expect(
      disagreements,
      'no television in the table could have produced 9c’s mismatch, so this file proves nothing',
    ).toBeGreaterThan(0);
  });

  it('every television in the table states a channel limit, so the leg is never a guess', () => {
    for (const [name, profile] of PROFILES) {
      expect(typeof profile.maxAudioChannels, name).toBe('number');
      expect(profile.maxAudioChannels, name).toBeGreaterThan(0);
    }
    expect(REPACKAGE_FIXTURE_CHANNELS).toBe(2);
  });
});
