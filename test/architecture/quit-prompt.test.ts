import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  choiceFromButton,
  headStartQuitPrompt,
  needsQuitPrompt,
  PREPARING_QUIT_PROMPT,
  quitPromptFor,
  QUIT_PROMPT,
  questionFor,
  safeChoiceFor,
} from '../../src/main/quit.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/index.js';
import type { SessionState } from '../../src/engine/types.js';

/**
 * Closing CastGood mid-film asks first (founder's ruling, 2026-08-18).
 *
 * The *decision* is a pure function and is tested as one. The dialog itself needs
 * Electron, and Electron needs Windows, so the wiring is held by a contract test in the
 * same style as `window-lifecycle.test.ts` — the two facts that make the ruling true:
 * the engine's `keepPlaying` comes from the answer, and nothing under `src/engine/`
 * learns that dialogs exist.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const read = (relative: string): Promise<string> => readFile(path.join(repoRoot, relative), 'utf8');

function snapshotIn(
  state: SessionState,
  overrides: Partial<StateSnapshot['session']> = {},
): StateSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    session: { ...EMPTY_SNAPSHOT.session, state, ...overrides },
  };
}

describe('when quitting asks, and when it does not', () => {
  it('asks whenever a film is on the television', () => {
    for (const state of ['loading', 'buffering', 'playing', 'paused', 'seeking'] as const) {
      expect(needsQuitPrompt(snapshotIn(state)), state).toBe(true);
    }
  });

  it('says nothing on an ordinary quit', () => {
    // "Not playing, no prompt" — the ruling is explicit, and a modal on every close is how
    // a prompt stops being read.
    for (const state of ['idle', 'connecting', 'stopped', 'ended'] as const) {
      expect(needsQuitPrompt(snapshotIn(state)), state).toBe(false);
    }
  });

  it('does not offer to stop a film on a television that is no longer ours (14b)', () => {
    const yielded = snapshotIn('playing', {
      flags: { reconnecting: false, reattaching: false, yielded: true, networkDown: false },
    });
    expect(needsQuitPrompt(yielded)).toBe(false);
  });

  it('treats anything but an explicit "stop it" as leave it playing', () => {
    expect(choiceFromButton(0)).toEqual({ quit: true, keepPlaying: true });
    expect(choiceFromButton(1)).toEqual({ quit: true, keepPlaying: false });
    // A dialog dismissed by the window manager, or a button we do not know about: story 12
    // survives, which is the failure that cannot end somebody's evening.
    expect(choiceFromButton(-1)).toEqual({ quit: true, keepPlaying: true });
    expect(choiceFromButton(99)).toEqual({ quit: true, keepPlaying: true });
  });
});

describe('closing while a video is being prepared (P6)', () => {
  const preparing: StateSnapshot = {
    ...EMPTY_SNAPSHOT,
    preparation: { ...EMPTY_SNAPSHOT.preparation, active: true, percent: 30 },
  };

  it('asks, because closing throws work away', () => {
    expect(quitPromptFor(preparing)).toBe('preparing');
    expect(needsQuitPrompt(preparing)).toBe(true);
  });

  it('asks the preparation question when there is no film on the screen', () => {
    // M3a's shape: half A casts only once a job has finished, so a running preparation and
    // a playing film cannot coexist. The prompt says the job stops, and that is the whole
    // of what the founder loses.
    expect(quitPromptFor(preparing)).toBe('preparing');
    expect(PREPARING_QUIT_PROMPT.message).toContain('being prepared');
  });

  it('takes "stay open" as the safe answer, which is the opposite of the film prompt', () => {
    // The two prompts have opposite safe defaults, and the reason is not symmetry: a film
    // can be *left running* and picked up again (story 12), so leaving it is safe. A
    // preparation cannot — this process is doing the work — so the answer that loses
    // nothing is the one that does not close.
    expect(choiceFromButton(0, 'preparing')).toEqual({ quit: false, keepPlaying: false });
    expect(choiceFromButton(1, 'preparing')).toEqual({ quit: true, keepPlaying: false });
    expect(choiceFromButton(-1, 'preparing')).toEqual({ quit: false, keepPlaying: false });
    expect(choiceFromButton(99, 'preparing')).toEqual({ quit: false, keepPlaying: false });
  });

  it('never offers to leave a conversion running, because it cannot be left', () => {
    // Whatever the founder answers, `keepPlaying` is false: there is no television holding
    // anything, and story 12's "leave it and come back" does not apply to our own process.
    for (const index of [0, 1, -1, 99]) {
      expect(choiceFromButton(index, 'preparing').keepPlaying).toBe(false);
    }
  });

  it('tells the founder the two things they cannot see for themselves', () => {
    // The partial file is removed rather than left in their films folder, and the work
    // starts again from the beginning — the same sentence 7f's confirmation used.
    expect(PREPARING_QUIT_PROMPT.detail).toContain('removed');
    expect(PREPARING_QUIT_PROMPT.detail).toContain('starts from the beginning');
    expect(PREPARING_QUIT_PROMPT.stayLabel).not.toBe(PREPARING_QUIT_PROMPT.stopLabel);
  });
});

/**
 * **P6's head-start clause, and it is copy rather than a branch.**
 *
 * *"Where a head-start film is also playing, the same question says plainly that closing
 * stops the film too, because the conversion feeding it is stopping."* The version of this
 * file that shipped on 2026-08-21 carried that sentence as a comment and then asserted only
 * which prompt was chosen — so the prompt could say nothing whatsoever about the film on the
 * screen and the test would still pass. It did say nothing, for a day. Every assertion here
 * is on the words the founder reads.
 */
describe('closing while watching a film that is still being converted (P6)', () => {
  const watching = (conversionComplete: boolean): StateSnapshot => ({
    ...EMPTY_SNAPSHOT,
    preparation: {
      ...EMPTY_SNAPSHOT.preparation,
      active: !conversionComplete,
      percent: 60,
    },
    headStart: {
      frontierSec: 1_800,
      seekLimitSec: 1_680,
      hold: null,
      conversionComplete,
    },
    session: { ...EMPTY_SNAPSHOT.session, state: 'playing' },
  });

  it('asks its own question rather than the plain preparation one', () => {
    expect(quitPromptFor(watching(false))).toBe('head-start');
    expect(needsQuitPrompt(watching(false))).toBe(true);
  });

  it('says plainly that the film they are watching stops', () => {
    const prompt = headStartQuitPrompt(watching(false));
    // The sentence P6 asks for, in the two places a person actually reads.
    expect(prompt.message.toLowerCase()).toContain('stops the film');
    expect(prompt.detail.toLowerCase()).toContain('stops when this window closes');
    // …and why, which is the half that makes it a decision rather than a threat.
    expect(prompt.detail.toLowerCase()).toContain('conversion feeding it stops too');
    // The plain preparation prompt says none of this, which is exactly why it is the wrong
    // question here — it would have the founder answering about a file, not about a film.
    expect(PREPARING_QUIT_PROMPT.detail.toLowerCase()).not.toContain('film');
  });

  it('never offers to leave it playing, because the segments go with the app', () => {
    // The television is reading a folder inside this process's working directory. "Leave it
    // playing" would be an offer we cannot honour — 10g removes those segments on the way
    // out — and the film would freeze seconds later with nobody able to explain why.
    for (const index of [0, 1, -1, 99]) {
      expect(choiceFromButton(index, 'head-start').keepPlaying).toBe(false);
    }
    expect(headStartQuitPrompt(watching(false)).stayLabel).not.toBe(QUIT_PROMPT.keepPlayingLabel);
    // Staying open is still the safe answer, as it is for any half-finished work.
    expect(choiceFromButton(-1, 'head-start')).toEqual({ quit: false, keepPlaying: false });
    expect(choiceFromButton(1, 'head-start')).toEqual({ quit: true, keepPlaying: false });
  });

  it('still asks after the conversion has finished, and stops promising a wait', () => {
    // 10g leaves the film playing from the segments after ffmpeg has gone, so
    // `preparation.active` is false and the *ordinary* prompt would offer to leave it
    // playing — an offer that is false for this shape and only this shape.
    expect(quitPromptFor(watching(true))).toBe('head-start');
    const prompt = headStartQuitPrompt(watching(true));
    expect(prompt.message.toLowerCase()).toContain('stops the film');
    // Nothing is lost this time: the prepared file is already beside their video.
    expect(prompt.detail).toContain('finished preparing');
    expect(prompt.detail.toLowerCase()).not.toContain('half-finished');
  });
});

describe('the quit path in the Electron host', () => {
  it('stops the engine with the answer, not with an assumption', async () => {
    const source = await read('src/main/main.ts');
    // The defect this replaces, in one line: `.stop({ keepPlaying: true })`, unconditional.
    expect(source).not.toMatch(/stop\(\s*\{\s*keepPlaying:\s*true\s*\}\s*\)/);
    expect(source).toContain('current.stop({ keepPlaying: choice.keepPlaying })');
    // P6: an answer of "keep CastGood open" must genuinely abandon the quit, not defer it.
    expect(source).toContain('if (!choice.quit)');
    expect(source).toContain('quitPromptFor');
    // P6's head-start clause reaches the question rather than stopping at the decision.
    expect(source).toContain('questionFor');
  });

  it('asks on the window `close`, because that is where the X actually arrives', async () => {
    // Clicking the X closes the BrowserWindow *first*: `closed` nulls the reference,
    // `window-all-closed` calls `app.quit()`, and only then does `before-quit` run — with
    // the window already destroyed. A modal could be raised with no window; the in-window
    // question cannot. If the veto ever moves back to `before-quit` alone, the founder gets
    // no question at all on the commonest path in the product.
    const source = await read('src/main/main.ts');
    expect(source).toMatch(/window\.on\('close',/);
    const handler = /window\.on\('close',([\s\S]*?)\n {2}\}\);/.exec(source);
    expect(handler, "src/main/main.ts no longer vetoes the window 'close'").not.toBeNull();
    const body = handler?.[1] ?? '';
    expect(body).toContain('event.preventDefault()');
    // A minimised or buried window would hold the close open behind a question nobody can
    // see, which reads as the app refusing to close.
    expect(body).toContain('restore()');
    expect(body).toContain('focus()');
  });

  it('never leaves the app unclosable', async () => {
    const source = await read('src/main/main.ts');
    // A renderer that crashed, hung or never painted must not be able to hold the window
    // open for ever. The question answers itself, safely, if it is never acknowledged.
    expect(source).toContain('PAINT_ACK_MS');
    expect(source).toContain('app.quit_question_unpainted');
    // Shutdown gives a process no time to ask and nowhere to show a question.
    expect(source).toMatch(/window\.on\('session-end',/);
    // A question that throws still lets the close through, on the safe answer.
    expect(source).toContain('safeChoiceFor');
  });

  it('has no modal left anywhere in the app', async () => {
    // The founder's ruling of 2026-08-30: "make it in-window, no modals". This is the one
    // that fails if somebody reaches for a message box again — including for a new
    // question that has nothing to do with quitting.
    for (const file of ['src/main/main.ts', 'src/main/quit.ts', 'src/main/preload.ts']) {
      expect(await read(file), `${file} shows a modal dialog`).not.toContain('showMessageBox');
    }
  });

  it('keeps the question out of the engine', async () => {
    const quit = await read('src/main/quit.ts');
    expect(quit).not.toContain("from 'electron'");
    // The copy the founder reads lives beside the decision, so a future change to either
    // is visible in one place — and the two answers are exactly the two the ruling names.
    expect([QUIT_PROMPT.keepPlayingLabel, QUIT_PROMPT.stopLabel]).toHaveLength(2);
    expect(QUIT_PROMPT.keepPlayingLabel).not.toBe(QUIT_PROMPT.stopLabel);
  });
});

/**
 * The closing question as a surface (founder's ruling, 2026-08-30).
 *
 * The words and the index contract move out of `main.ts` and into two pure functions, so
 * the part that decides what the founder reads is testable without Electron. What is *not*
 * testable anywhere headless is whether the app then closes — the selftest never starts
 * Electron, and this feature has no exit code. It is proved by hands on the X.
 */
const headStartWatching = (conversionComplete: boolean): StateSnapshot => ({
  ...EMPTY_SNAPSHOT,
  preparation: { ...EMPTY_SNAPSHOT.preparation, active: !conversionComplete, percent: 60 },
  headStart: {
    frontierSec: 1_800,
    seekLimitSec: 1_680,
    hold: null,
    conversionComplete,
  },
  session: { ...EMPTY_SNAPSHOT.session, state: 'playing' },
});

describe('the closing question, as words rather than a dialog', () => {
  it('index 0 is the safe answer for every kind, and that is now enforced', () => {
    // This is the fix for a real defect. `main.ts` used to hand-write the fallback as a
    // ternary that special-cased only `preparing`, so a **head-start** prompt that failed
    // to open resolved to `{ quit: true, keepPlaying: true }` — the one answer
    // `choiceFromButton` says in as many words cannot be honoured, because the segments
    // feeding the television live in this process's folder and go when it does. It
    // promised a film would keep playing while removing the files it was reading.
    for (const kind of ['playing', 'preparing', 'head-start'] as const) {
      expect(safeChoiceFor(kind), kind).toEqual(choiceFromButton(0, kind));
    }
    expect(safeChoiceFor('head-start')).toEqual({ quit: false, keepPlaying: false });
    expect(safeChoiceFor('preparing')).toEqual({ quit: false, keepPlaying: false });
    // The film question's safe answer still leaves the film playing: story 12 survives it,
    // and a wrongly stopped film does not.
    expect(safeChoiceFor('playing')).toEqual({ quit: true, keepPlaying: true });
  });

  it('carries the same three questions, word for word', () => {
    const playing = questionFor(headStartWatching(false), 'playing');
    expect(playing.headline).toBe(QUIT_PROMPT.message);
    expect(playing.detail).toBe(QUIT_PROMPT.detail);
    expect(playing.answers).toEqual([QUIT_PROMPT.keepPlayingLabel, QUIT_PROMPT.stopLabel]);

    const preparing = questionFor(headStartWatching(false), 'preparing');
    expect(preparing.headline).toBe(PREPARING_QUIT_PROMPT.message);
    expect(preparing.answers).toEqual([
      PREPARING_QUIT_PROMPT.stayLabel,
      PREPARING_QUIT_PROMPT.stopLabel,
    ]);

    // The head-start question is built from the snapshot, not from a constant, because its
    // second sentence depends on whether the conversion finished.
    expect(questionFor(headStartWatching(false), 'head-start').detail).toContain('half-finished');
    expect(questionFor(headStartWatching(true), 'head-start').detail).toContain(
      'finished preparing',
    );
  });

  it('answers[0] is always the safe one the renderer presses first', () => {
    for (const kind of ['playing', 'preparing', 'head-start'] as const) {
      const question = questionFor(headStartWatching(false), kind);
      expect(question.answers).toHaveLength(2);
      expect(question.answers[0], kind).not.toBe(question.answers[1]);
      // Pressing answers[0] must produce exactly the fallback answer, or a founder who
      // takes the offered default gets something different from a founder who walks away.
      expect(choiceFromButton(0, kind), kind).toEqual(safeChoiceFor(kind));
    }
  });

  it('has no title, because a state in a window has no title bar', () => {
    // The three `'Close CastGood?'` strings belonged to the box and retire with it.
    for (const kind of ['playing', 'preparing', 'head-start'] as const) {
      expect(Object.keys(questionFor(headStartWatching(false), kind))).not.toContain('title');
    }
  });
});
