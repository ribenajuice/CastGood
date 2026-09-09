import { describe, expect, it } from 'vitest';
import {
  SIDECAR_EXTENSIONS,
  embeddedLabel,
  languageName,
  sidecarLanguage,
  sidecarsFor,
  subtitleChoices,
} from '../../src/engine/subtitles/sources.js';
import { probeOf, report, subtitleStream, videoStream, audioStream } from './fixtures/ffprobe.js';

/**
 * M3c step 2 — **what subtitles this film could have**, and the list the founder chooses from.
 *
 * Every test here is a directory listing and a probe. Nothing is opened, because 18b says
 * discovery *"is a directory listing, not a parse"* — a folder of forty `.srt`s must cost
 * forty string comparisons, not forty reads.
 */

const FILM = '/films/Cars.mkv';

describe('finding the files beside a film — 18b', () => {
  it('offers the four shapes the criterion names by name', () => {
    expect(
      sidecarsFor(FILM, ['Cars.mkv', 'Cars.srt', 'Cars.en.srt', 'Cars.eng.srt', 'Cars.vtt']),
    ).toEqual(['/films/Cars.en.srt', '/films/Cars.eng.srt', '/films/Cars.srt', '/films/Cars.vtt']);
  });

  it('refuses a name that merely rhymes, which is the whole discipline of 18b', () => {
    // *"A file whose stem does not match the film's is never offered."* `Cars` is a prefix
    // of `Carsick`, and a loose prefix test is exactly the bug this refuses: the founder
    // would be offered another film's subtitles, in their own folder, looking plausible.
    expect(
      sidecarsFor(FILM, ['Carsick.srt', 'Cars 2.srt', 'Cars-commentary.srt', 'CarsXtra.vtt']),
    ).toEqual([]);
  });

  it('matches case-insensitively, because Windows filesystems do', () => {
    expect(sidecarsFor(FILM, ['CARS.SRT'])).toEqual(['/films/CARS.SRT']);
  });

  it('ignores files that are not subtitles at all', () => {
    expect(sidecarsFor(FILM, ['Cars.nfo', 'Cars.jpg', 'Cars.mp4', 'Cars.txt'])).toEqual([]);
  });

  it('never offers CastGood’s own tracks back, which would contradict 18f', () => {
    // 8e writes these beside the PREPARED copy. 18f requires the served track to come from
    // the source or a sidecar and never from the prepared copy, so ours are not candidates —
    // and a film prepared before M3c existed must still get subtitles from its own source.
    expect(
      sidecarsFor('/films/Cars.mkv', ['Cars (CastGood).eng.vtt', 'Cars (CastGood).eng2.vtt']),
    ).toEqual([]);
  });

  it('finds them beside the film, wherever the film lives', () => {
    expect(sidecarsFor('/a/b/Deep Film.mkv', ['Deep Film.srt'])).toEqual(['/a/b/Deep Film.srt']);
  });
});

describe('naming a track the founder can recognise — 18a', () => {
  it('uses the language the film names', () => {
    expect(languageName('eng')).toBe('English');
    expect(languageName('fr')).toBe('French');
  });

  it('treats "undetermined" as nobody having said, not as a language', () => {
    // ffprobe reports `und` for undetermined. It is a code, not a language, and printing it
    // teaches the founder nothing — the same judgement `subtitlePathFor` already makes.
    expect(languageName('und')).toBeNull();
    expect(languageName(null)).toBeNull();
    expect(languageName('')).toBeNull();
  });

  it('shows an unknown code rather than inventing a language for it', () => {
    expect(languageName('qaa')).toBe('QAA');
  });

  it('falls back to "Track N" when the film names no language', () => {
    // `und` is what ffprobe reports when the file says nothing — the fixture's default is
    // `eng`, so the absence has to be asked for explicitly.
    const stream = probeOf(report({ streams: [subtitleStream({ tags: { language: 'und' } })] }))
      .streams[0]!;
    expect(embeddedLabel(stream, 2)).toBe('Track 2');
  });

  it('says when a track is forced, because it is a different thing to choose', () => {
    // A forced track carries only the lines spoken in another language. A founder who picks
    // it expecting full subtitles has been misled by a label that said nothing.
    const stream = probeOf(
      report({
        streams: [subtitleStream({ tags: { language: 'eng' }, disposition: { forced: 1 } })],
      }),
    ).streams[0]!;
    expect(embeddedLabel(stream, 1)).toBe('English (forced)');
  });
});

describe('the list the founder is offered — 18a, 18k', () => {
  const film = (streams: unknown[]) =>
    probeOf(report({ streams: [videoStream(), audioStream(), ...(streams as never[])] }));

  it('lists the film’s own text tracks, then what is beside it', () => {
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([
        subtitleStream({ index: 2, tags: { language: 'eng' } }),
        subtitleStream({ index: 3, tags: { language: 'fre' } }),
      ]),
      folderEntries: ['Cars.mkv', 'Cars.en.srt'],
    });
    expect(choices.sources.map((s) => s.label)).toEqual(['English', 'French', 'Cars.en.srt']);
    expect(choices.sources[0]?.origin).toEqual({ kind: 'embedded', streamIndex: 2 });
    expect(choices.sources[2]?.origin).toEqual({ kind: 'sidecar', filePath: '/films/Cars.en.srt' });
  });

  it('never puts a path, a codec or a stream index in front of the founder', () => {
    // 18a: *"No codec names, no stream indices, no file paths."* The path rides in `origin`
    // for the engine to act on; the label is what a person reads.
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([
        subtitleStream({ index: 2, codec_name: 'mov_text', tags: { language: 'eng' } }),
      ]),
      folderEntries: ['Cars.srt'],
    });
    for (const label of choices.sources.map((s) => s.label)) {
      expect(label).not.toContain('/');
      expect(label).not.toMatch(/mov_text|subrip|ass|index|stream/i);
    }
  });

  it('lists picture-only tracks as unavailable, with a reason and no jargon', () => {
    // 18k: *"hiding them entirely reads as CastGood having missed the subtitles the founder
    // can see in the file."* So they are shown, refused, and never burned into the picture.
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([
        subtitleStream({ index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'eng' } }),
      ]),
      folderEntries: [],
    });
    expect(choices.sources).toEqual([]);
    expect(choices.unavailable).toHaveLength(1);
    expect(choices.unavailable[0]?.label).toBe('English');
    expect(choices.unavailable[0]?.why).toMatch(/pictures rather than words/);
    expect(choices.unavailable[0]?.why).not.toMatch(/PGS|VobSub|hdmv/i);
  });

  it('numbers every subtitle track once, across both lists, so no two rows share a name', () => {
    // **Amended 2026-08-27, and the original reasoning is worth keeping.** This test used to
    // assert two independent counters, on the grounds that "a film with a picture track first
    // would otherwise offer Track 2 as its only text track, and the founder would wonder where
    // Track 1 went". The cost of that was two rows both reading *Track 1* — one selectable,
    // one refused — on the same screen at the same time, which is a worse fault than a list
    // that starts at 2: the same name for two different things.
    //
    // And the premise no longer holds. It assumed the picture track was invisible, but **18k
    // requires it to be listed rather than hidden** — "hiding them entirely reads as CastGood
    // having missed the subtitles the founder can see in the file". So the founder is never
    // left wondering where Track 1 went: it is on the screen, directly underneath, with one
    // sentence saying why it cannot be used. One counter makes each number mean exactly one
    // track, which is what `embeddedLabel` already says it means.
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([
        subtitleStream({ index: 2, codec_name: 'hdmv_pgs_subtitle', tags: { language: 'und' } }),
        subtitleStream({ index: 3, tags: { language: 'und' } }),
      ]),
      folderEntries: [],
    });
    expect(choices.unavailable[0]?.label).toBe('Track 1');
    expect(choices.sources[0]?.label).toBe('Track 2');
    // The point of the change, stated as its own assertion: nothing on this screen is named
    // the same as anything else on it.
    const names = [
      ...choices.sources.map((source) => source.label),
      ...choices.unavailable.map((track) => track.label),
    ];
    expect(new Set(names).size).toBe(names.length);
  });

  it('does not hoist a default track to the top, because Off is the state every time', () => {
    // 19a: promoting a default would be the first step towards a film that arrives with a
    // choice already made for the founder.
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([
        subtitleStream({ index: 2, tags: { language: 'fre' } }),
        subtitleStream({ index: 3, tags: { language: 'eng' }, disposition: { default: 1 } }),
      ]),
      folderEntries: [],
    });
    expect(choices.sources.map((s) => s.label)).toEqual(['French', 'English']);
  });

  it('offers what is beside a film even when the film itself has no tracks', () => {
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([]),
      folderEntries: ['Cars.srt'],
    });
    expect(choices.sources.map((s) => s.label)).toEqual(['Cars.srt']);
  });

  it('says nothing at all rather than failing when the film could not be probed', () => {
    expect(subtitleChoices({ filmPath: FILM, probe: null, folderEntries: [] })).toEqual({
      sources: [],
      unavailable: [],
    });
  });

  it('gives every source a stable id the renderer can name back', () => {
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: film([subtitleStream({ index: 2 })]),
      folderEntries: ['Cars.srt'],
    });
    const ids = choices.sources.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('which extensions are worth offering at all — the M3c step 3 decision', () => {
  it('offers .srt, .vtt, .ass and .ssa, and does not offer .sub', () => {
    // `.ass`/`.ssa` are offered and go through ffmpeg rather than `parseCues`, which cannot
    // read them — see `subtitleRouteFor`. `.sub` is normally the binary half of a VobSub
    // pair, and its words are pictures: 18k already refuses those, so offering the file by
    // name would put an entry in the list that can only ever end in a refusal.
    expect([...SIDECAR_EXTENSIONS]).toEqual(['.srt', '.vtt', '.ass', '.ssa']);
    expect(sidecarsFor(FILM, ['Cars.sub', 'Cars.idx'])).toEqual([]);
    expect(sidecarsFor(FILM, ['Cars.ass', 'Cars.ssa'])).toEqual([
      '/films/Cars.ass',
      '/films/Cars.ssa',
    ]);
  });
});

describe('the language a sidecar’s own name claims', () => {
  it('reads a dotted language code and refuses to invent one', () => {
    // For the **television's** own track menu, never for the screen — 18a keeps codes off
    // the screen and the label is the filename.
    expect(sidecarLanguage(FILM, '/films/Cars.en.srt')).toBe('en');
    expect(sidecarLanguage(FILM, '/films/Cars.eng.srt')).toBe('eng');
    expect(sidecarLanguage(FILM, '/films/Cars.srt')).toBeNull();
    // Neither of these is a language, and telling a television they were would be an
    // invention rather than a reading.
    expect(sidecarLanguage(FILM, '/films/Cars.forced.srt')).toBeNull();
    expect(sidecarLanguage(FILM, '/films/Cars.2.srt')).toBeNull();
  });

  it('carries it onto the source so the LOAD can declare it', () => {
    const choices = subtitleChoices({
      filmPath: FILM,
      probe: probeOf(report({ streams: [videoStream(), subtitleStream({ index: 1 })] })),
      folderEntries: ['Cars.fr.srt'],
    });
    expect(choices.sources.map((source) => source.language)).toEqual(['eng', 'fr']);
  });
});
