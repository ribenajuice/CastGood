import { describe, expect, it } from 'vitest';
import {
  buildViewModel,
  CHOOSE_FILE_ID,
  OFF_ID,
  type PickerState,
} from '../../src/renderer/state/view-model.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/protocol/index.js';

/**
 * **The subtitle control, as words** — 18a, 18c, 18k, 19a, 18g.
 *
 * `buildViewModel` decides every row and every sentence in that control, so this is where
 * the founder-facing half of those criteria is provable without a DOM and without a
 * television. What it cannot prove is the other half of each: that the words reach a
 * screen, and that they reach it *in time with the film*. That is `[hardware]`, and 18g
 * says so in as many words.
 *
 * The load-bearing one here is **19a**: *"whatever was chosen for the previous film,
 * whatever this film contains, and whatever was chosen the last time this film was cast"* —
 * the control reads Off. The wire half of 19a is measured in
 * `test/engine/m3c-load-golden.test.ts`; this is the half the founder can see.
 */

const IDLE_PICKER: PickerState = { available: true, busy: false, error: null };

const FILE: StateSnapshot['file'] = {
  path: 'D:\\Films\\Cars.mkv',
  name: 'Cars.mkv',
  durationSec: 6_990,
  verdict: null,
};

function snapshot(subtitles: Partial<StateSnapshot['subtitles']> = {}): StateSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    file: FILE,
    subtitles: { ...EMPTY_SNAPSHOT.subtitles, ...subtitles },
  };
}

function view(subtitles: Partial<StateSnapshot['subtitles']> = {}) {
  return buildViewModel(snapshot(subtitles), IDLE_PICKER, IDLE_PICKER).subtitles;
}

describe('19a — Off is the state on every film, every time', () => {
  it('reads Off when the engine has chosen nothing', () => {
    const subtitles = view({
      options: [
        { id: 'embedded:2', label: 'English' },
        { id: 'sidecar:D:\\Films\\Cars.en.srt', label: 'Cars.en.srt' },
      ],
    });

    expect(subtitles?.summary).toBe('Off');
    expect(subtitles?.choices.find((choice) => choice.selected)?.id).toBe(OFF_ID);
  });

  it('offers Off as a real row rather than implying it by nothing being ticked', () => {
    // A blank first entry, or a list where "none selected" means Off, is one refactor away
    // from a film that arrives pre-chosen. Off is addressable and it is a row.
    const choices = view({ options: [{ id: 'embedded:2', label: 'English' }] })?.choices ?? [];
    expect(choices[0]).toEqual({ id: OFF_ID, label: 'Off', selected: true });
  });

  it('keeps exactly one row selected once a source is chosen', () => {
    const subtitles = view({
      options: [
        { id: 'embedded:2', label: 'English' },
        { id: 'embedded:3', label: 'German' },
      ],
      selectedId: 'embedded:3',
      selectedLabel: 'German',
    });

    expect(subtitles?.summary).toBe('German');
    expect(
      subtitles?.choices.filter((choice) => choice.selected).map((choice) => choice.id),
    ).toEqual(['embedded:3']);
  });
});

describe('18a — what the list contains, and in what order', () => {
  it('puts the film’s own tracks before sidecars, and the picker last', () => {
    const choices =
      view({
        options: [
          { id: 'embedded:2', label: 'English' },
          { id: 'sidecar:D:\\Films\\Cars.en.srt', label: 'Cars.en.srt' },
        ],
      })?.choices ?? [];

    expect(choices.map((choice) => choice.label)).toEqual([
      'Off',
      'English',
      'Cars.en.srt',
      'Choose a file…',
    ]);
  });

  it('still offers Choose a file… for a film with nothing beside it and nothing inside it', () => {
    // The film in the founder's own library whose `.srt` was renamed by the release and so
    // is never matched. The picker is the answer for exactly that film, so it is never
    // conditional on the list having found something.
    const choices = view()?.choices ?? [];
    expect(choices.map((choice) => choice.id)).toEqual([OFF_ID, CHOOSE_FILE_ID]);
  });

  it('is absent entirely until a film is chosen', () => {
    expect(buildViewModel(EMPTY_SNAPSHOT, IDLE_PICKER, IDLE_PICKER).subtitles).toBeNull();
  });
});

describe('18c — a picked file is a row of its own, and it is ticked', () => {
  it('never leaves the menu with nothing selected while a subtitle is on', () => {
    // A picked file is deliberately absent from `options` — it lives wherever the founder
    // pointed at it and belongs to no film's list. Without a row for it, opening the control
    // showed **nothing** selected while the closed control read the filename: the screen
    // disagreeing with itself about whether subtitles are on.
    const subtitles = view({
      options: [{ id: 'embedded:2', label: 'English' }],
      selectedId: 'picked:D:\\Elsewhere\\Cars.en.srt',
      selectedLabel: 'Cars.en.srt',
    });

    expect(subtitles?.summary).toBe('Cars.en.srt');
    const selected = subtitles?.choices.filter((choice) => choice.selected) ?? [];
    expect(selected).toHaveLength(1);
    expect(selected[0]?.label).toBe('Cars.en.srt');
    // Off is not ticked, because subtitles are not off.
    expect(subtitles?.choices.find((choice) => choice.id === OFF_ID)?.selected).toBe(false);
  });
});

describe('18k — picture tracks are listed and refused, never hidden', () => {
  it('renders the engine’s own sentence beside each one', () => {
    const subtitles = view({
      unavailable: [{ label: 'English', why: 'These subtitles are pictures rather than words.' }],
    });

    expect(subtitles?.unavailable).toEqual([
      { label: 'English', why: 'These subtitles are pictures rather than words.' },
    ]);
    // And the picker is offered in the same breath — that is the whole point of listing them.
    expect(subtitles?.choices.some((choice) => choice.id === CHOOSE_FILE_ID)).toBe(true);
  });
});

describe('18d — Preparing subtitles… is a named step, not an unexplained delay', () => {
  it('names it only while a preparation is actually running', () => {
    expect(view()?.preparingLabel).toBeNull();
    expect(view({ preparing: true })?.preparingLabel).toBe('Preparing subtitles…');
  });
});

describe('the one line when a source could not be used', () => {
  it('renders the engine’s sentence verbatim and says nothing when there is nothing to say', () => {
    expect(view()?.problem).toBeNull();
    expect(view({ problem: 'That subtitle file couldn’t be read.' })?.problem).toBe(
      'That subtitle file couldn’t be read.',
    );
  });
});

describe('18l — Subtitles didn’t load, with a way out', () => {
  it('offers Try again only for the one problem that has a retry', () => {
    // 18j's refusals are answered by choosing another source, which is a press the founder
    // already has — offering *Try again* there would be a second button that does the same
    // thing as the menu. 18l is the only state where the choice was right and the
    // television simply never came for the words.
    expect(view({ problem: 'That subtitle file couldn’t be read.' })?.canRetry).toBe(false);
    const failed = view({
      problem: 'Subtitles didn’t load.',
      canRetry: true,
      selectedId: 'sidecar:Cars.srt',
      selectedLabel: 'Cars.srt',
    });
    expect(failed?.problem).toBe('Subtitles didn’t load.');
    expect(failed?.canRetry).toBe(true);
    // And the control still reads as on, because it is: the track is chosen, the film is
    // playing, and the only thing missing is the words on the television.
    expect(failed?.summary).toBe('Cars.srt');
  });

  it('says nothing and offers nothing while everything is working', () => {
    expect(view()?.canRetry).toBe(false);
    expect(view()?.problem).toBeNull();
  });
});

describe('18c — the picker says so rather than looking pressable and doing nothing', () => {
  it('names why Choose a file… cannot be used in this build', () => {
    const built = buildViewModel(snapshot(), IDLE_PICKER, {
      available: false,
      busy: false,
      error: null,
    });
    expect(built.subtitles?.chooseDisabledReason).toBe(
      'The file picker isn’t available in this build',
    );
  });

  it('is pressable when the picker is there', () => {
    expect(view()?.chooseDisabledReason).toBeNull();
  });
});

describe('18g — which track is on, without looking at the television', () => {
  it('carries the engine’s finished sentence onto the transport row', () => {
    const playing: StateSnapshot = {
      ...snapshot(),
      session: {
        ...EMPTY_SNAPSHOT.session,
        state: 'playing',
        deviceId: 'device-1',
        durationSec: 6_990,
        positionSec: 42,
        subtitleLabel: 'Subtitles: English',
      },
    };
    expect(buildViewModel(playing, IDLE_PICKER, IDLE_PICKER).transport?.subtitleLabel).toBe(
      'Subtitles: English',
    );
  });

  it('says nothing at all when no track was declared', () => {
    const playing: StateSnapshot = {
      ...snapshot(),
      session: {
        ...EMPTY_SNAPSHOT.session,
        state: 'playing',
        deviceId: 'device-1',
        durationSec: 6_990,
      },
    };
    expect(buildViewModel(playing, IDLE_PICKER, IDLE_PICKER).transport?.subtitleLabel).toBeNull();
  });
});

describe('the timing control — 20a, 20e', () => {
  /** The control as the founder would see it, for a snapshot that has one. */
  function timing(subtitles: Partial<StateSnapshot['subtitles']>) {
    const found = view({ selectedId: 'a', selectedLabel: 'English', ...subtitles })?.timing;
    if (found === undefined || found === null) throw new Error('no timing control');
    return found;
  }

  it('is absent while subtitles are Off, because there is nothing to correct', () => {
    expect(view({ selectedId: null, selectedLabel: null })?.timing).toBeNull();
  });

  it('reads the engine’s own sentence with one word in front of it', () => {
    // *in sync* versus a signed number is a product rule with a criterion behind it — *"a
    // film nobody has touched never looks adjusted"* — so the screen renders what the
    // engine said rather than composing its own from `offsetMs`.
    expect(timing({ timing: 'in sync' }).label).toBe('Timing: in sync');
    expect(timing({ timing: '+0.5 s', offsetMs: 500 }).label).toBe('Timing: +0.5 s');
  });

  it('offers Reset only when there is something to reset', () => {
    expect(timing({}).canReset).toBe(false);
    expect(timing({ offsetMs: -1_500 }).canReset).toBe(true);
  });

  it('disables only the direction that cannot move — 20e’s clamp', () => {
    const clamped = timing({ offsetMs: 30_000, timing: '+30.0 s', canGoLater: false });
    expect(clamped.canGoLater).toBe(false);
    // A founder at the limit is never stuck: the way back is always still offered.
    expect(clamped.canGoEarlier).toBe(true);
  });

  it('says where a remembered correction came from — 20f', () => {
    // *"Timing: +0.6 s, as you set it last time"*, with Reset beside it. The statement is
    // the condition the memory was accepted under: this is the one number on the screen the
    // founder did not just choose, so it has to say so rather than appear silently.
    const remembered = timing({ timing: '+0.6 s', offsetMs: 600, timingRemembered: true });
    expect(remembered.label).toBe('Timing: +0.6 s, as you set it last time');
    expect(remembered.canReset).toBe(true);
    // And the moment they touch it, it is theirs again and the clause goes.
    expect(timing({ timing: '+1.1 s', offsetMs: 1_100 }).label).toBe('Timing: +1.1 s');
  });

  it('says the reload out loud while it is happening, and nothing when it is not', () => {
    // The founder accepted one reload on the condition it is **stated rather than hidden**
    // (2026-08-26). Every nudge inside ±3 s costs nothing, so this is silent nearly always.
    expect(timing({}).reloadingLabel).toBeNull();
    expect(timing({ reloading: true }).reloadingLabel).toBe('Moving the subtitles…');
  });
});
