import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  isOurName,
  partialPathFor,
  preparedNameFor,
  preparedPathFor,
  sourceStem,
  subtitlePathFor,
} from '../../src/engine/prepare/naming.js';

/**
 * The founder's ruling of 2026-08-19 in one file: *"place a copy of it in the same
 * directory, but with a filename change that implies it's been converted."*
 *
 * These tests are cheap and the thing they protect is not. Preparation runs **inside the
 * founder's own films folder**, and `isOurName` is the gate on every delete the pipeline
 * performs. It is the one place in CastGood where being wrong destroys something that
 * cannot be got back.
 */

describe('what a prepared file is called', () => {
  it('names it after the film, in the film’s own folder', () => {
    // POSIX separators throughout this file, deliberately. `node:path` follows the platform
    // it is running on, so it is `path.win32` on the founder's PC and `path.posix` under
    // vitest — and a `C:\Films\…` literal here would be one string with no separators in
    // it at all, quietly asserting nothing. The behaviour under test is the naming, which
    // is the same on both.
    expect(preparedNameFor('/media/films/Cars.mkv')).toBe('Cars (CastGood).mp4');
    expect(preparedPathFor('/media/films/Cars.mkv')).toBe(
      path.join('/media/films', 'Cars (CastGood).mp4'),
    );
  });

  it('keeps the name when the location falls back, so the file is still recognisable', () => {
    // 9e: a read-only source folder sends the artifact to CastGood's working folder. A
    // founder who later copies it back beside the film must still be able to see what it is.
    expect(preparedPathFor('/read-only/Cars.mkv', '/appdata/prepared')).toBe(
      path.join('/appdata/prepared', 'Cars (CastGood).mp4'),
    );
  });

  it('never stacks the suffix, because the founder can pick a prepared file themselves', () => {
    // It is a video file in their films folder and the picker will happily offer it.
    // `Cars (CastGood) (CastGood).mp4` would be our bookkeeping leaking twice, and
    // preparing a prepared file should overwrite it — which is what the 2026-08-19 ADR's
    // "preparation only ever narrows" wants to happen.
    expect(sourceStem('/f/Cars (CastGood).mp4')).toBe('Cars');
    expect(preparedNameFor('/f/Cars (CastGood).mp4')).toBe('Cars (CastGood).mp4');
    expect(preparedPathFor('/f/Cars (CastGood).mp4')).toBe(preparedPathFor('/f/Cars.mkv'));
  });

  it('stages beside the target, so the finishing move is a same-volume rename', () => {
    const target = preparedPathFor('/media/films/Cars.mkv');
    const partial = partialPathFor(target);
    expect(path.dirname(partial)).toBe(path.dirname(target));
    expect(partial.endsWith('.partial')).toBe(true);
    // Not `.mp4`: a half-written file Windows shows with a video icon is one the founder
    // can double-click into a broken player.
    expect(path.extname(partial)).not.toBe('.mp4');
  });
});

describe('what a subtitle track is called (8e)', () => {
  const artifact = preparedPathFor('/films/Cars.mkv');

  it('puts the language in the name, so two tracks are tellable apart at a glance', () => {
    expect(path.basename(subtitlePathFor(artifact, 'eng', 1))).toBe('Cars (CastGood).eng.vtt');
    expect(path.basename(subtitlePathFor(artifact, 'spa', 2))).toBe('Cars (CastGood).spa.vtt');
    expect(path.dirname(subtitlePathFor(artifact, 'eng', 1))).toBe(path.dirname(artifact));
  });

  it('numbers a second track of the same language, because films really have two', () => {
    // **This is the bug that threw away an eighteen-minute conversion** (2026-08-20). A film
    // with "English" and "English SDH" reports `eng` twice; both were handed the same
    // filename, ffmpeg was told to write two outputs to one path, one file appeared, and the
    // second rename died with `ENOENT` after the film had already been converted.
    const first = subtitlePathFor(artifact, 'eng', 1, 1);
    const second = subtitlePathFor(artifact, 'eng', 2, 2);
    expect(path.basename(first)).toBe('Cars (CastGood).eng.vtt');
    expect(path.basename(second)).toBe('Cars (CastGood).eng2.vtt');
    expect(first).not.toBe(second);
    // The common case is untouched: one English track is still just `.eng.vtt`.
    expect(subtitlePathFor(artifact, 'eng', 1)).toBe(first);
  });

  it('gives every track in a plausible film a distinct file', () => {
    // The shape a downloaded remux really comes in.
    const tracks: [string | null, number][] = [
      ['eng', 1],
      ['eng', 2],
      ['eng', 3],
      ['spa', 1],
      [null, 1],
      [null, 2],
      ['und', 3],
    ];
    const seen = new Map<string, number>();
    const paths = tracks.map(([lang], i) => {
      const key = (lang ?? '').toLowerCase();
      const n = (seen.get(key) ?? 0) + 1;
      seen.set(key, n);
      return subtitlePathFor(artifact, lang, i + 1, n);
    });
    expect(new Set(paths).size, `collision in ${paths.join(', ')}`).toBe(paths.length);
  });

  it('falls back to an ordinal rather than a stream number', () => {
    // `und` is ffprobe's "undetermined" — a code, not a language, and `Cars (CastGood).und.vtt`
    // tells the founder nothing. A stream index would be our bookkeeping in their folder.
    expect(path.basename(subtitlePathFor(artifact, null, 1))).toBe('Cars (CastGood).track1.vtt');
    expect(path.basename(subtitlePathFor(artifact, 'und', 2))).toBe('Cars (CastGood).track2.vtt');
  });

  it('cannot be talked into writing outside the folder we chose', () => {
    // A language tag comes out of a downloaded remux and is about to become a filename.
    const escaped = subtitlePathFor(artifact, '../../etc/passwd', 1);
    expect(path.dirname(escaped)).toBe(path.dirname(artifact));
    expect(escaped).not.toContain('..');
    expect(path.basename(subtitlePathFor(artifact, '!!!', 1))).toBe('Cars (CastGood).sub.vtt');
  });
});

describe('CastGood deletes nothing it did not name (9e)', () => {
  it('claims its own artifacts, subtitles and staging files', () => {
    expect(isOurName('Cars (CastGood).mp4')).toBe(true);
    expect(isOurName('Cars (CastGood).mp4.partial')).toBe(true);
    // The subtitles too, or a cancelled job would leave a `.vtt` behind that nothing was
    // allowed to remove — which is the same defect as a stranded `.partial`, in a smaller file.
    expect(isOurName('Cars (CastGood).eng.vtt')).toBe(true);
    expect(isOurName('Cars (CastGood).track1.vtt.partial')).toBe(true);
  });

  it('never claims a subtitle file the founder put there themselves', () => {
    // M3c's discovery looks for exactly these beside a film. Removing one would delete
    // somebody's own subtitles for a film they downloaded.
    for (const name of ['Cars.srt', 'Cars.eng.srt', 'Cars.vtt', 'Cars.eng.vtt']) {
      expect(isOurName(name), name).toBe(false);
    }
  });

  it('refuses everything else in the founder’s folder, however much it looks like ours', () => {
    for (const name of [
      // The founder's own films, which is the whole point.
      'Cars.mkv',
      'Cars.mp4',
      // A name that merely rhymes. The 2026-08-19 ruling refuses these by name: it may be a
      // trailer, a different cut, or another language.
      'Cars (2006).mp4',
      'Cars - CastGood.mp4',
      'Cars (castgood).mp4',
      'Cars (CastGood).mkv',
      // Something else entirely that happens to end the right way.
      'CastGood.mp4',
      'notes (CastGood).txt',
    ]) {
      expect(isOurName(name), name).toBe(false);
    }
  });

  it('holds for every name the pipeline itself can produce', () => {
    // The gate must never refuse a file we made, or a cancel would leave a staging file
    // behind — which is exactly what 8d promises does not happen.
    for (const source of [
      'Cars.mkv',
      'Cars.mp4',
      'A film with (brackets).mkv',
      'Ünïcode — dashes and “quotes”.mkv',
      'no-extension',
    ]) {
      const target = preparedPathFor(`/films/${source}`);
      expect(isOurName(path.basename(target)), source).toBe(true);
      expect(isOurName(path.basename(partialPathFor(target))), source).toBe(true);
    }
  });
});
