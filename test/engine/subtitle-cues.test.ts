import { describe, expect, it } from 'vitest';
import {
  clampOffsetMs,
  cueAt,
  describeOffset,
  formatTimestamp,
  parseCues,
  parseTimestamp,
  shiftCues,
  toWebVtt,
  type Cue,
} from '../../src/engine/subtitles/cues.js';
import { SUBTITLES } from '../../src/engine/config.js';

/**
 * M3c step 1 — **the cue layer, and the shift story 20 is built on**.
 *
 * The PRD calls 20d *"the cheapest criterion in the milestone"*: a shift is verifiable to
 * the millisecond with nothing plugged in. So it is tested to the millisecond here, and the
 * television is never asked about arithmetic it cannot see.
 *
 * What this file may NOT claim: that a Chromecast renders any of it. SPIKE-3 measured that
 * on all three televisions on 2026-08-26 and it is [hardware], not [logic].
 */

const cue = (startMs: number, endMs: number, text = 'words'): Cue => ({
  startMs,
  endMs,
  text,
  id: null,
  settings: null,
});

describe('reading a subtitle file', () => {
  it('reads WebVTT, keeping identifiers and positioning settings', () => {
    const cues = parseCues(
      [
        'WEBVTT',
        '',
        'intro',
        '00:00:01.000 --> 00:00:04.500 line:90% align:center',
        'Hello',
        '',
      ].join('\n'),
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({
      startMs: 1_000,
      endMs: 4_500,
      text: 'Hello',
      id: 'intro',
      settings: 'line:90% align:center',
    });
  });

  it('reads SubRip, and does not mistake its index for an identifier', () => {
    // SRT numbers its cues. That number is an ordinal, not a name — carrying it into `id`
    // would put "1" on screen as a cue identifier and change the file for no reason.
    const cues = parseCues(
      [
        '1',
        '00:00:01,000 --> 00:00:04,500',
        'Hello',
        '',
        '2',
        '00:00:05,000 --> 00:00:06,000',
        'Again',
        '',
      ].join('\n'),
    );
    expect(cues).toHaveLength(2);
    expect(cues[0]?.id).toBeNull();
    expect(cues[0]?.startMs).toBe(1_000);
    // A comma is SubRip's decimal point. Reading it as anything else moves every cue.
    expect(cues[0]?.endMs).toBe(4_500);
    expect(cues[1]?.text).toBe('Again');
  });

  it('keeps multi-line cue text exactly as written, including blank-line boundaries', () => {
    const cues = parseCues(
      [
        'WEBVTT',
        '',
        '00:00:01.000 --> 00:00:02.000',
        '— Who is it?',
        '— Nobody.',
        '',
        '00:00:03.000 --> 00:00:04.000',
        'Fine.',
        '',
      ].join('\n'),
    );
    expect(cues[0]?.text).toBe('— Who is it?\n— Nobody.');
    expect(cues[1]?.text).toBe('Fine.');
  });

  it('skips everything that is not a cue rather than refusing the file', () => {
    // A real .vtt carries NOTE and STYLE blocks, a BOM, and CRLF line endings. None of them
    // is a cue and none of them is a reason to tell the founder the file cannot be read.
    const cues = parseCues(
      '﻿WEBVTT\r\n\r\nNOTE this is a comment\r\n\r\nSTYLE\r\n::cue { color: peachpuff }\r\n\r\n00:00:01.000 --> 00:00:02.000\r\nHello\r\n',
    );
    expect(cues).toHaveLength(1);
    expect(cues[0]?.text).toBe('Hello');
  });

  it('reads short and long timestamp forms, and pads a partial fraction', () => {
    expect(parseTimestamp('00:00:01.000')).toBe(1_000);
    expect(parseTimestamp('01:02:03.004')).toBe(3_723_004);
    expect(parseTimestamp('02:03.004')).toBe(123_004);
    // `.5` is half a second, not five milliseconds. Getting this wrong shifts every cue by
    // up to a second, in a file that looks perfectly well-formed.
    expect(parseTimestamp('00:00:01.5')).toBe(1_500);
    expect(parseTimestamp('00:00:01.50')).toBe(1_500);
    expect(parseTimestamp('not a time')).toBeNull();
  });

  it('yields nothing for a file that is not subtitles at all', () => {
    // 18j's sentence is the caller's to say; this only reports that there was nothing here.
    expect(parseCues('this is a shopping list\nmilk\nbread')).toEqual([]);
    expect(parseCues('')).toEqual([]);
  });
});

describe('writing WebVTT — the only form a Chromecast renders', () => {
  it('round-trips a file without moving anything', () => {
    const original = [
      'WEBVTT',
      '',
      'intro',
      '00:00:01.000 --> 00:00:04.500 align:center',
      'Hello',
      '',
    ].join('\n');
    expect(parseCues(toWebVtt(parseCues(original)))).toEqual(parseCues(original));
  });

  it('turns SubRip into WebVTT, which is the whole conversion for this shape', () => {
    const vtt = toWebVtt(parseCues(['1', '00:00:01,000 --> 00:00:04,500', 'Hello', ''].join('\n')));
    expect(vtt.startsWith('WEBVTT')).toBe(true);
    // A comma here is what a receiver silently refuses to render.
    expect(vtt).toContain('00:00:01.000 --> 00:00:04.500');
    expect(vtt).not.toContain(',500');
  });

  it('pads every field, because a receiver parses the text and not our intent', () => {
    expect(formatTimestamp(0)).toBe('00:00:00.000');
    expect(formatTimestamp(3_723_004)).toBe('01:02:03.004');
    expect(formatTimestamp(61_050)).toBe('00:01:01.050');
  });
});

describe('shifting cues — 20d, to the millisecond', () => {
  it('moves every cue by exactly the offset', () => {
    const shifted = shiftCues([cue(1_000, 2_000), cue(10_000, 12_000)], 600);
    expect(shifted.map((c) => [c.startMs, c.endMs])).toEqual([
      [1_600, 2_600],
      [10_600, 12_600],
    ]);
  });

  it('stays exact across a two-hour film, where floating seconds would not', () => {
    // 0.1 + 0.2 is the standard counter-example and a long film has thousands of chances to
    // hit it. Integer milliseconds are why `Cue` does not store seconds.
    const last = cue(7_199_900, 7_200_400);
    const shifted = shiftCues([last], 100);
    expect(shifted[0]?.startMs).toBe(7_200_000);
    expect(shifted[0]?.endMs).toBe(7_200_500);
  });

  it('leaves the words, the order and the count alone', () => {
    const cues = [
      cue(1_000, 2_000, 'first'),
      cue(3_000, 4_000, 'second'),
      cue(5_000, 6_000, 'third'),
    ];
    const shifted = shiftCues(cues, -250);
    expect(shifted.map((c) => c.text)).toEqual(['first', 'second', 'third']);
    expect(shifted).toHaveLength(3);
    // A new list, never an edit of the founder's own — 20g's promise starts here.
    expect(cues[0]?.startMs).toBe(1_000);
  });

  it('clips a cue that would start before the film does, rather than losing it', () => {
    // 20d: *"a cue shifted before 0:00 starts at 0:00"*. The words are still owed to the
    // founder; only the part of them that has nowhere to be shown is clipped.
    const shifted = shiftCues([cue(500, 3_000, 'still needed')], -2_000);
    expect(shifted).toHaveLength(1);
    expect(shifted[0]?.startMs).toBe(0);
    // The end keeps its true shifted time, so the cue does not silently grow or shrink.
    expect(shifted[0]?.endMs).toBe(1_000);
    expect(shifted[0]?.text).toBe('still needed');
  });

  it('drops only a cue whose whole life is before the film starts', () => {
    // *"a cue that would end before 0:00 is dropped, because a subtitle cannot play before
    // the film starts."* This is the one case where a cue is lost, and it is on purpose.
    const shifted = shiftCues([cue(500, 900, 'gone'), cue(5_000, 6_000, 'kept')], -1_000);
    expect(shifted.map((c) => c.text)).toEqual(['kept']);
  });

  it('drops a cue that lands exactly on 0:00 at its end, which has no duration left', () => {
    expect(shiftCues([cue(500, 1_000)], -1_000)).toEqual([]);
  });

  it('is Reset when the offset is zero, in one call and with nothing changed', () => {
    // 20e: *"Reset returns to in sync in one press and one swap"* — no separate path.
    const cues = [cue(1_000, 2_000), cue(3_000, 4_000)];
    expect(shiftCues(cues, 0)).toEqual(cues);
  });
});

describe('the offset the founder can reach — 20e', () => {
  it('clamps at ±30 s rather than letting the number run away', () => {
    expect(clampOffsetMs(999_000)).toBe(SUBTITLES.maxOffsetSeconds * 1_000);
    expect(clampOffsetMs(-999_000)).toBe(-SUBTITLES.maxOffsetSeconds * 1_000);
    expect(clampOffsetMs(30_000)).toBe(30_000);
  });

  it('applies the clamp to the CUES as well, so the screen and the file agree', () => {
    // If the clamp lived only in the view, the number on screen would say 30 s while the
    // words moved by 999. One function, called by both, is why that cannot happen.
    const shifted = shiftCues([cue(0, 1_000_000)], 999_000);
    expect(shifted[0]?.startMs).toBe(SUBTITLES.maxOffsetSeconds * 1_000);
  });

  it('treats a nonsense offset as no offset rather than producing NaN timestamps', () => {
    // `describeApproxBytes`' lesson: a NaN reaching a screen prints at the founder.
    expect(clampOffsetMs(Number.NaN)).toBe(0);
    expect(clampOffsetMs(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe('what the founder reads — 20a', () => {
  it('says "in sync" at zero, and never +0.0 s', () => {
    // *"so a film nobody has touched never looks adjusted."*
    expect(describeOffset(0)).toBe('in sync');
    expect(describeOffset(0)).not.toContain('0.0');
  });

  it('states a signed number in seconds, at one decimal place', () => {
    expect(describeOffset(600)).toBe('+0.6 s');
    expect(describeOffset(-600)).toBe('−0.6 s');
    expect(describeOffset(SUBTITLES.nudgeStepSeconds * 1_000)).toBe('+0.5 s');
  });

  it('states the real distance moved at the clamp, rather than reading as a dead button', () => {
    // 20e names this explicitly: the number keeps telling the truth even when the button
    // has stopped doing anything.
    expect(describeOffset(999_000)).toBe('+30.0 s');
  });

  it('never shows milliseconds, frame rates or cue counts', () => {
    for (const offset of [0, 500, -1_250, 30_000]) {
      const said = describeOffset(offset);
      expect(said).not.toMatch(/ms|fps|cue/i);
    }
  });
});

describe('which line belongs at this instant — 18i', () => {
  const lines: Cue[] = [
    cue(5_000, 8_000, 'Opening line.'),
    cue(120_000, 126_000, 'Two minutes in.'),
    cue(600_000, 608_000, 'Ten minutes in.'),
  ];

  it('finds the cue covering a position, and nothing between cues', () => {
    expect(cueAt(lines, 6_000)?.text).toBe('Opening line.');
    expect(cueAt(lines, 5_000)?.text).toBe('Opening line.');
    // The end is exclusive: at the millisecond a cue ends, it has gone.
    expect(cueAt(lines, 8_000)).toBeNull();
    expect(cueAt(lines, 60_000)).toBeNull();
    expect(cueAt(lines, 607_999)?.text).toBe('Ten minutes in.');
  });

  it('answers about the position at long range, in both directions', () => {
    // 18i: *"in both directions and at long range"*. A jump of ten minutes forward and one
    // of eight back are the same question asked of the same list.
    expect(cueAt(lines, 600_500)?.text).toBe('Ten minutes in.');
    expect(cueAt(lines, 121_000)?.text).toBe('Two minutes in.');
    expect(cueAt(lines, 0)).toBeNull();
  });

  it('answers about the CORRECTED words when there is an offset', () => {
    // The founder nudged this file 2 s later, so the line at 10:00 is now nothing and the
    // line at 10:02 is the one that used to be at 10:00. A seek graded against the
    // unshifted list would be 18h's other failure: words that come back out of time.
    expect(cueAt(lines, 600_500, 2_000)).toBeNull();
    expect(cueAt(lines, 602_500, 2_000)?.text).toBe('Ten minutes in.');
    expect(cueAt(lines, 598_500, -2_000)?.text).toBe('Ten minutes in.');
  });

  it('is 1 s accurate around a cue boundary, which is the promise it is scored on', () => {
    // The television lands on a keyframe, not on the frame it was asked for. What 18i
    // promises is that the line matches *within 1 s* of the new position, so a cue eight
    // seconds long answers the same at either end of that tolerance.
    for (const at of [600_000, 600_999, 601_000]) {
      expect(cueAt(lines, at)?.text).toBe('Ten minutes in.');
    }
  });

  it('says nothing rather than guessing when a list is empty', () => {
    expect(cueAt([], 1_000)).toBeNull();
  });
});
