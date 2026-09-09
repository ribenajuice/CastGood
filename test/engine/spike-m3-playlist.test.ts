import { describe, expect, it } from 'vitest';
import {
  parsePlaylist,
  playlistFor,
  secondsIn,
  segmentsWithin,
} from '../../src/engine/spike/m3.js';

/**
 * The one part of SPIKE-1 that must be right before a television is asked anything.
 *
 * The spike's findings are only worth reading if the playlist it serves is a playlist a
 * receiver has actually seen before. A malformed one — wrong `EXTINF` values, a missing
 * `TARGETDURATION`, an `ENDLIST` that leaks in early — would produce behaviour that tells
 * us about our own arithmetic rather than about the device. **This project has paid twice
 * for instruments that lied** (M1's phantom 2-second stop delay; M2's three miscalculated
 * selftest numbers), so the generator is pinned here even though the spike itself is
 * deliberately outside `npm test` and CI.
 *
 * Everything below is pure string work. Nothing here touches a network or a device.
 */

const FFMPEG_OUTPUT = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:5
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:VOD
#EXTINF:4.170833,
000.ts
#EXTINF:4.170833,
001.ts
#EXTINF:3.795000,
002.ts
#EXT-X-ENDLIST
`;

describe('reading what ffmpeg actually wrote', () => {
  it('takes the real segment durations rather than assuming they are all equal', () => {
    const fixture = parsePlaylist(FFMPEG_OUTPUT);
    expect(fixture.segments).toEqual([
      { name: '000.ts', durationSec: 4.170833 },
      { name: '001.ts', durationSec: 4.170833 },
      // The last segment of a real encode is always short, and inventing 4.17 s here
      // would make every "how far did it get" measurement wrong at the end of the film.
      { name: '002.ts', durationSec: 3.795 },
    ]);
    expect(fixture.targetDurationSec).toBe(5);
  });

  it('refuses a playlist with no segments rather than serving an empty one', () => {
    expect(() => parsePlaylist('#EXTM3U\n#EXT-X-VERSION:3\n')).toThrow(/names no segments/);
  });

  it('survives CRLF, which is what a file written on Windows contains', () => {
    const fixture = parsePlaylist(FFMPEG_OUTPUT.replace(/\n/g, '\r\n'));
    expect(fixture.segments.map((s) => s.name)).toEqual(['000.ts', '001.ts', '002.ts']);
    // A trailing \r on the name would 404 every segment request and look exactly like the
    // frontier defect this spike exists to detect.
    expect(fixture.segments.every((s) => !s.name.includes('\r'))).toBe(true);
  });
});

describe('the playlist a still-converting film would serve', () => {
  const fixture = parsePlaylist(FFMPEG_OUTPUT);

  it('publishes only what the imaginary conversion has finished', () => {
    const playlist = playlistFor(fixture, 2, false);
    expect(playlist).toContain('000.ts');
    expect(playlist).toContain('001.ts');
    // The whole risk: a segment named before it exists is a segment the TV will fetch and
    // get a 404 for, which is the stall the PRD forbids.
    expect(playlist).not.toContain('002.ts');
  });

  /**
   * `#EXT-X-ENDLIST` is the single line the 2026-08-13 ADR turns on: Google documents that
   * its player decides live-vs-VOD **solely** by its presence. Emitting it early would tell
   * the receiver the film is complete while segments were still missing — and the spike
   * would then be measuring a bug of ours, not a property of the television.
   */
  it('never writes ENDLIST while the conversion is still running', () => {
    expect(playlistFor(fixture, 2, false)).not.toContain('#EXT-X-ENDLIST');
    expect(playlistFor(fixture, 3, false)).not.toContain('#EXT-X-ENDLIST');
    expect(playlistFor(fixture, 3, true)).toContain('#EXT-X-ENDLIST');
  });

  it('is an EVENT playlist, which is what makes it growable', () => {
    expect(playlistFor(fixture, 1, false)).toContain('#EXT-X-PLAYLIST-TYPE:EVENT');
  });

  it('rounds TARGETDURATION up, because the spec requires it to be an integer', () => {
    const odd = parsePlaylist('#EXTM3U\n#EXTINF:4.170833,\n000.ts\n');
    expect(playlistFor(odd, 1, false)).toContain('#EXT-X-TARGETDURATION:5');
  });

  /**
   * **TARGETDURATION is a ceiling and it has to hold.** ffmpeg declares it from what it was
   * *asked* for (`-hls_time 4` → 12 here after keyframe rounding) and then stream-copies at
   * keyframes, overshooting: the founder's own film produced `TARGETDURATION:12` beside a
   * **12.26 s** segment. That is invalid HLS, and grounds for a strict receiver to refuse
   * the playlist — one of the two candidate causes of the `LOAD_FAILED` this spike hit on
   * its first run against a real Chromecast Ultra.
   */
  it('recomputes TARGETDURATION from the real segments, not from what ffmpeg declared', () => {
    const overshooting = parsePlaylist(
      '#EXTM3U\n#EXT-X-TARGETDURATION:12\n#EXTINF:12.260000,\n000.ts\n',
    );
    expect(overshooting.targetDurationSec).toBe(12);
    // 12 would be a lie about a 12.26 s segment.
    expect(playlistFor(overshooting, 1, false)).toContain('#EXT-X-TARGETDURATION:13');
  });

  /**
   * The 2026-08-13 ADR says "absolute URLs, no redirects" in as many words. The first run of
   * this spike used bare segment names, which *should* resolve against the playlist URL —
   * and is the other candidate cause of that `LOAD_FAILED`. Following the ADR removes the
   * variable rather than arguing with it.
   */
  it('names segments absolutely when given a base URL', () => {
    const playlist = playlistFor(fixture, 2, false, 'http://10.1.1.230:8010/');
    expect(playlist).toContain('http://10.1.1.230:8010/000.ts');
    expect(playlist).toContain('http://10.1.1.230:8010/001.ts');
    expect(playlist).not.toMatch(/^000\.ts$/m);
  });

  it('pairs every EXTINF with exactly one segment, in order', () => {
    const lines = playlistFor(fixture, 3, true).trim().split('\n');
    const body = lines.filter((line) => line.startsWith('#EXTINF') || !line.startsWith('#'));
    expect(body).toEqual([
      '#EXTINF:4.170833,',
      '000.ts',
      '#EXTINF:4.170833,',
      '001.ts',
      '#EXTINF:3.795000,',
      '002.ts',
    ]);
  });
});

describe('how much film is actually published — the arithmetic that nearly lied', () => {
  const fixture = parsePlaylist(FFMPEG_OUTPUT);

  /**
   * A stream-copied fixture **cannot** have even segments. ffmpeg only cuts at keyframes,
   * so `-hls_time 4` against the founder's own film produced 1,592 segments ranging from
   * **0.96 s to 12.26 s** with a `TARGETDURATION` of 12.
   *
   * The first version of the spike multiplied `TARGETDURATION` by a segment count. That
   * would have reported a conversion running comfortably at 1.5x playback while it actually
   * crawled at 0.55x — starving the playhead, making every "how far did it get" figure
   * wrong, and blaming the television for a stall we had caused ourselves. Caught by reading
   * what ffmpeg really wrote instead of what it had been asked for.
   */
  it('sums real durations rather than multiplying the target duration', () => {
    expect(secondsIn(fixture, 2)).toBeCloseTo(8.341666, 5);
    expect(secondsIn(fixture, 3)).toBeCloseTo(12.136666, 5);
    // The trap: 3 x TARGETDURATION would be 36 s for a fixture only 12.1 s long.
    expect(secondsIn(fixture, 3)).toBeLessThan(3 * fixture.targetDurationSec);
  });

  it('never counts past the end of the film', () => {
    expect(secondsIn(fixture, 99)).toBeCloseTo(12.136666, 5);
    expect(secondsIn(fixture, 0)).toBe(0);
    expect(secondsIn(fixture, -5)).toBe(0);
  });

  it('publishes only whole segments — half a segment is not watchable', () => {
    expect(segmentsWithin(fixture, 0)).toBe(0);
    expect(segmentsWithin(fixture, 4.0)).toBe(0);
    expect(segmentsWithin(fixture, 4.2)).toBe(1);
    expect(segmentsWithin(fixture, 8.4)).toBe(2);
    expect(segmentsWithin(fixture, 1000)).toBe(3);
  });

  it('round-trips: what fits in what was published is what was published', () => {
    for (const count of [0, 1, 2, 3]) {
      expect(segmentsWithin(fixture, secondsIn(fixture, count))).toBe(count);
    }
  });
});
