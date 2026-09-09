import type { SessionState, StateSnapshot } from '../engine/index.js';

/**
 * Closing CastGood mid-film asks first (founder's ruling, 2026-08-18).
 *
 * `before-quit` used to call `stop({ keepPlaying: true })` unconditionally. That is right
 * for "closed it by accident, reopen, carry on" — story 12 exists for exactly that — and
 * wrong for "finished, closing up": the television keeps playing against a URL that
 * stopped answering the moment the process died, and stalls a minute later with nothing
 * watching it.
 *
 * The decision of *whether to ask* lives here rather than in `main.ts` so it can be tested
 * headless, and it is deliberately a pure function of the snapshot the renderer already
 * gets. The dialog itself belongs to Electron and stays in `main.ts`; nothing under
 * `src/engine/` learns that modal dialogs exist.
 */

/**
 * States in which something of ours is on the television, or on its way there.
 *
 * `connecting` is not one of them: nothing has been launched yet, so there is nothing to
 * leave playing and nothing to ask about. Neither are `stopped`, `ended` or `idle` — the
 * ruling is explicit that an ordinary quit with nothing playing gets no prompt at all,
 * and a modal on every close is exactly how a prompt stops being read.
 */
const ON_THE_TELEVISION: readonly SessionState[] = [
  'loading',
  'buffering',
  'playing',
  'paused',
  'seeking',
];

/** Is there a film on the television that quitting would decide the fate of? */
function filmIsPlaying(snapshot: StateSnapshot): boolean {
  // Already handed over: 14b says we send that television nothing further, and asking
  // whether to stop somebody else's video would be the app offering to do exactly that.
  if (snapshot.session.flags.yielded) return false;
  return ON_THE_TELEVISION.includes(snapshot.session.state);
}

/**
 * Which question, if any, closing has to ask.
 *
 * `playing` is the 2026-08-18 ruling. `preparing` is criterion P6, and it is a **different
 * question with a different answer**, not a variant of the first:
 *
 *  - A film mid-play can be *left running* — that is what story 12 is for, and the safe
 *    default is to leave it, because a wrongly stopped film ends somebody's evening.
 *  - A preparation **cannot**. It is this process doing the work; there is nothing to leave
 *    behind, and P6 says in as many words that *"there is no conversion running after the
 *    app is gone"*. So the honest question is not "leave it?" but "are you sure?", and the
 *    safe default is the one that loses no work: **stay open**.
 *
 * Preparation wins when both are somehow true, because it is the one with unfinished work
 * on the disk and the one whose "cancel" cannot be undone by reopening.
 *
 * **`head-start` is the third, and it is a criterion rather than a refinement.** P6: *"where
 * a head-start film is also playing, the same question says plainly that closing stops the
 * film too, because the conversion feeding it is stopping."* Until 2026-08-21 that case got
 * the plain `preparing` prompt — *"A video is still being prepared. Closing stops it…"* —
 * which says nothing at all about the film the founder is **watching at that moment**, and
 * is the one prompt in the product where being incomplete costs somebody their evening.
 *
 * It is chosen on the head start rather than on the conversion, and that is deliberate: the
 * segments feeding the television are removed when this process goes, so **closing stops the
 * film even after the conversion has finished**. In that state `preparation.active` is
 * already false and the ordinary `playing` prompt would offer to *leave it playing* — an
 * offer we cannot honour, because the file it is reading goes with us.
 */
export type QuitPromptKind = 'playing' | 'preparing' | 'head-start';

export function quitPromptFor(snapshot: StateSnapshot): QuitPromptKind | null {
  // First, because a head start is both of the other two at once and its question is the
  // only one that mentions the film on the screen.
  if (snapshot.headStart !== null) return 'head-start';
  if (snapshot.preparation.active) return 'preparing';
  return filmIsPlaying(snapshot) ? 'playing' : null;
}

/** Kept for the call sites and the tests that ask the original question. */
export function needsQuitPrompt(snapshot: StateSnapshot): boolean {
  return quitPromptFor(snapshot) !== null;
}

/**
 * What the answer means.
 *
 * `quit: false` is only reachable from the preparation prompt: a film mid-play has no
 * "stay open" answer, because leaving it playing *is* the way to keep it.
 */
export interface QuitChoice {
  readonly quit: boolean;
  /** Story 12's precondition. Meaningless when `quit` is false. */
  readonly keepPlaying: boolean;
}

export const QUIT_PROMPT = {
  /** Index 0. Also what Escape and the window's close button resolve to — see `cancelId`. */
  keepPlayingLabel: 'Leave it playing',
  stopLabel: 'Stop it and close',
  title: 'Close CastGood?',
  message: 'Leave the film playing on the TV?',
  detail:
    'CastGood is what sends the video, so the TV will stop a minute or so after this window closes. Reopen CastGood and it will pick the film up where you left it.',
} as const;

/**
 * P6's prompt. The safe answer is index 0, and index 0 is *stay open*.
 *
 * The detail says the two things the founder needs to decide with, and neither is obvious:
 * the partial file is removed rather than left in their films folder, and the work starts
 * again from the beginning next time — which is the same sentence 7f's confirmation used,
 * deliberately, because it is the same fact.
 */
export const PREPARING_QUIT_PROMPT = {
  stayLabel: 'Keep CastGood open',
  stopLabel: 'Close and stop preparing',
  title: 'Close CastGood?',
  message: 'A video is still being prepared.',
  detail:
    'Closing stops it. The half-finished file is removed rather than left beside your video, and preparing it again starts from the beginning.',
} as const;

/**
 * P6's prompt **for a film that is playing from a conversion still running** — the case the
 * criterion names in as many words.
 *
 * Two facts the founder cannot see, and the first one is the whole reason this exists: the
 * film in front of them stops, because CastGood is what is feeding it. Not "the TV will stop
 * a minute or so after this window closes" — that is the progressive-file sentence, and it
 * is wrong here in both directions: this stops immediately, and there is nothing to come
 * back to.
 *
 * The second sentence depends on a fact rather than being fixed, because the honest answer
 * changes: mid-conversion the work is thrown away, and after it the prepared file is already
 * beside their video and next time there is no wait at all.
 */
export function headStartQuitPrompt(snapshot: StateSnapshot): {
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly stayLabel: string;
  readonly stopLabel: string;
} {
  const finished = snapshot.headStart?.conversionComplete ?? false;
  return {
    title: 'Close CastGood?',
    message: 'Closing stops the film you are watching.',
    detail: finished
      ? 'CastGood is what is sending this film to the TV, so it stops when this window closes. It has finished preparing, so it will start straight away next time.'
      : 'CastGood is what is sending this film to the TV, so it stops when this window closes — the conversion feeding it stops too. The half-finished file is removed rather than left beside your video, and preparing it again starts from the beginning.',
    stayLabel: 'Keep watching',
    stopLabel: 'Close and stop the film',
  };
}

/**
 * Turn the button index the dialog returned into what should happen.
 *
 * **Anything unrecognised takes the safe answer**, and the safe answer differs by prompt: a
 * dismissed film prompt leaves the film playing, because story 12 survives that and a
 * wrongly stopped film does not; a dismissed preparation prompt keeps the app open, because
 * that loses nothing and closing loses the job.
 */
export function choiceFromButton(index: number, kind: QuitPromptKind = 'playing'): QuitChoice {
  // A head start answers like a preparation and for a stronger reason: there is no "leave it
  // playing" to offer at all. The television is reading segments in this process's working
  // folder, and they go when it does — so `keepPlaying` is false whatever is pressed.
  if (kind === 'preparing' || kind === 'head-start') {
    return { quit: index === 1, keepPlaying: false };
  }
  return { quit: true, keepPlaying: index !== 1 };
}

/**
 * The answer to take when the question could not be asked, or was not answered.
 *
 * **Index 0 is the safe answer for every kind**, and this is where that stops being a
 * coincidence and becomes an invariant: it is `choiceFromButton(0, kind)` and nothing
 * else, so a fourth kind cannot be added with an unsafe default without changing this
 * line too.
 *
 * It replaces a hand-written ternary in `main.ts` that special-cased `preparing` and
 * therefore gave a failed **head-start** prompt `{ quit: true, keepPlaying: true }` — the
 * one answer `choiceFromButton` says in as many words cannot be honoured, because the
 * segments feeding the television live in this process's working folder and go when it
 * does. That combination promised a film would keep playing while removing the files it
 * was reading.
 */
export function safeChoiceFor(kind: QuitPromptKind): QuitChoice {
  return choiceFromButton(0, kind);
}

/**
 * The closing question as a **surface**, not a dialog (founder's ruling, 2026-08-30:
 * *"make it in-window, no modals"*).
 *
 * Same three questions, same words, same safe answers. What goes is the box: there is no
 * `title` here, because a state in the window has no title bar to put one in, and the
 * three `'Close CastGood?'` strings retire with it.
 *
 * `answers[0]` is always the safe one, matching `safeChoiceFor` and `choiceFromButton`'s
 * index contract. The renderer sends back an index and never a meaning, so the mapping
 * lives here in one testable place rather than in a browser context.
 */
export interface QuitQuestion {
  readonly kind: QuitPromptKind;
  readonly headline: string;
  readonly detail: string;
  /** Index 0 is the safe answer. */
  readonly answers: readonly [string, string];
}

export function questionFor(snapshot: StateSnapshot, kind: QuitPromptKind): QuitQuestion {
  if (kind === 'head-start') {
    const prompt = headStartQuitPrompt(snapshot);
    return {
      kind,
      headline: prompt.message,
      detail: prompt.detail,
      answers: [prompt.stayLabel, prompt.stopLabel],
    };
  }
  if (kind === 'preparing') {
    return {
      kind,
      headline: PREPARING_QUIT_PROMPT.message,
      detail: PREPARING_QUIT_PROMPT.detail,
      answers: [PREPARING_QUIT_PROMPT.stayLabel, PREPARING_QUIT_PROMPT.stopLabel],
    };
  }
  return {
    kind,
    headline: QUIT_PROMPT.message,
    detail: QUIT_PROMPT.detail,
    answers: [QUIT_PROMPT.keepPlayingLabel, QUIT_PROMPT.stopLabel],
  };
}
