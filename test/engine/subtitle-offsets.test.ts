import { describe, expect, it } from 'vitest';
import {
  normalisePathKey,
  subtitleFingerprint,
  subtitleOffsetKey,
} from '../../src/engine/subtitles/offsets.js';
import { subtitleOriginFromId } from '../../src/engine/subtitles/sources.js';
import type { SubtitleSource } from '../../src/engine/subtitles/sources.js';
import type { Cue } from '../../src/engine/subtitles/cues.js';

/**
 * **What a timing correction is remembered against** — criterion 20f, as arithmetic.
 *
 * *"It is remembered against the **subtitle source**, never against the film, the device or
 * the session."* That sentence has three claims in it and each is a test below: the same
 * file chosen for two films is one correction; two tracks of one film are two corrections;
 * and nothing about a television or an evening reaches a key at all.
 */

const cue = (startMs: number, endMs: number, text = 'words'): Cue => ({
  startMs,
  endMs,
  text,
  id: null,
  settings: null,
});

const sidecar = (filePath: string): SubtitleSource => ({
  id: `sidecar:${filePath}`,
  label: 'Cars.srt',
  language: null,
  origin: { kind: 'sidecar', filePath },
});

const embedded = (streamIndex: number): SubtitleSource => ({
  id: `embedded:${String(streamIndex)}`,
  label: 'English',
  language: 'eng',
  origin: { kind: 'embedded', streamIndex },
});

describe('20f: the key is the subtitle source', () => {
  it('is the same for one file chosen for two different films', () => {
    // The founder keeps one `.srt` and two rips of the same film. It is 0.6 s out because
    // of how it was cut, which is a fact about the words and not about either film.
    const key = subtitleOffsetKey({
      filmPath: '/films/Cars.mkv',
      source: sidecar('/subs/Cars.en.srt'),
    });
    expect(
      subtitleOffsetKey({
        filmPath: '/films/Cars (2006) 1080p.mp4',
        source: sidecar('/subs/Cars.en.srt'),
      }),
    ).toBe(key);
  });

  it('is different for two different files beside the same film', () => {
    const film = '/films/Cars.mkv';
    expect(subtitleOffsetKey({ filmPath: film, source: sidecar('/films/Cars.en.srt') })).not.toBe(
      subtitleOffsetKey({ filmPath: film, source: sidecar('/films/Cars.fr.srt') }),
    );
  });

  it('separates two tracks inside one film — which is not "keyed against the film"', () => {
    // A track inside a film has no path of its own, so the film is part of naming it. What
    // 20f forbids is a correction that applies to whatever subtitle this film is showing,
    // and these two keys are what stop that.
    const film = '/films/Cars.mkv';
    expect(subtitleOffsetKey({ filmPath: film, source: embedded(2) })).not.toBe(
      subtitleOffsetKey({ filmPath: film, source: embedded(3) }),
    );
    expect(subtitleOffsetKey({ filmPath: film, source: embedded(2) })).toBe(
      subtitleOffsetKey({ filmPath: film, source: embedded(2) }),
    );
  });

  it('treats a picked file and the same file found beside the film as one source', () => {
    // 18c says a picked file is used where it lives. If that happens to be beside the film,
    // the founder has chosen the same words by another route and their correction stands.
    const filePath = '/films/Cars.srt';
    expect(subtitleOffsetKey({ filmPath: '/films/Cars.mkv', source: sidecar(filePath) })).toBe(
      subtitleOffsetKey({
        filmPath: '/films/Cars.mkv',
        source: {
          id: `picked:${filePath}`,
          label: 'Cars.srt',
          language: null,
          origin: { kind: 'picked', filePath },
        },
      }),
    );
  });

  it('folds case for a Windows path and never for a POSIX one', () => {
    // Windows filesystems are case-insensitive, so two spellings are one file — and the
    // test is the **path**, not the platform, so this is the same answer in WSL as it is
    // on the founder's PC.
    expect(normalisePathKey('D:\\Films\\Cars.EN.srt')).toBe(
      normalisePathKey('d:/films/cars.en.srt'),
    );
    expect(normalisePathKey('\\\\nas\\Films\\Cars.srt')).toBe(
      normalisePathKey('//NAS/films/cars.srt'),
    );
    expect(normalisePathKey('/films/Cars.srt')).not.toBe(normalisePathKey('/films/cars.srt'));
  });

  it('carries nothing about a device or a session', () => {
    const key = subtitleOffsetKey({
      filmPath: 'D:\\Films\\Cars.mkv',
      source: embedded(2),
    });
    expect(key).toBe('embedded:d:/films/cars.mkv#2');
  });
});

describe('20f: a correction is not applied to different words', () => {
  it('changes when the timings change, and not when the text does', () => {
    const original = [cue(1_000, 3_000, 'Hello.'), cue(4_000, 6_000, 'Goodbye.')];
    // Re-saved by another editor, or converted from ASS: the same subtitle, and the
    // correction still holds.
    const reworded = [cue(1_000, 3_000, 'Hello!'), cue(4_000, 6_000, 'Goodbye!')];
    // Cut for a different release: not the file that was corrected.
    const otherRelease = [cue(1_400, 3_400, 'Hello.'), cue(4_400, 6_400, 'Goodbye.')];

    expect(subtitleFingerprint(reworded)).toBe(subtitleFingerprint(original));
    expect(subtitleFingerprint(otherRelease)).not.toBe(subtitleFingerprint(original));
    // And a file that gained or lost lines is not the same file either.
    expect(subtitleFingerprint([...original, cue(8_000, 9_000)])).not.toBe(
      subtitleFingerprint(original),
    );
  });

  it('has an answer for an empty list rather than throwing on one', () => {
    expect(subtitleFingerprint([])).toBe('0:0:0');
  });
});

describe('18h: reading a source id back off disk', () => {
  it('recognises the three shapes it wrote', () => {
    expect(subtitleOriginFromId('embedded:3')).toEqual({ kind: 'embedded', streamIndex: 3 });
    expect(subtitleOriginFromId('sidecar:D:\\Films\\Cars.srt')).toEqual({
      kind: 'sidecar',
      filePath: 'D:\\Films\\Cars.srt',
    });
    expect(subtitleOriginFromId('picked:/subs/Cars.srt')).toEqual({
      kind: 'picked',
      filePath: '/subs/Cars.srt',
    });
  });

  it('refuses anything else, because this string came off a disk', () => {
    // A settings file can be hand-edited, half-written by a power cut, or left behind by a
    // future version. The stream index in particular is fed to ffmpeg's `-map`.
    for (const id of [
      '',
      'embedded:',
      'embedded:-1',
      'embedded:0x2',
      'embedded:2;rm -rf /',
      'nonsense',
      ':/x',
      'sidecar:',
    ]) {
      expect(subtitleOriginFromId(id)).toBeNull();
    }
  });
});
