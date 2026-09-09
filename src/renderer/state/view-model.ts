import type {
  DeviceSnapshot,
  FileVerdictSnapshot,
  StateSnapshot,
} from '../../engine/protocol/index.js';
import { hms, hmsOrNull, percentOf, signedDelta } from '../lib/format.js';

/**
 * Snapshot → screen, in one pure function.
 *
 * Every word, every enabled button and every disabled reason in the window is decided
 * here, so "what state is the app in?" has exactly one answer that QA can read, and the
 * React components below stay dumb. Nothing in this file holds state, reads the clock,
 * or talks to the bridge.
 *
 * Milestone 1 built these states (docs/PRD.md, "States built in M1"):
 *   Nothing chosen (searching) · No devices found · Devices found / Ready to cast ·
 *   Connecting · Couldn't reach the device · Starting on the device · Buffering ·
 *   Playing · Paused · Stopped · Couldn't play this file.
 *
 * Milestone 3a adds, here: **Checking what this file needs** · *Ready to cast* with a
 * compatibility claim that is finally true · *Ready in about \<time\>* · *Needs converting
 * — about \<time\>* · **Confirm a long preparation** · **Repackaging / Converting**, with a
 * bar and a Cancel · *This file can't be cast*, which replaces M1's blunt "Couldn't play
 * this file". Every one of those sentences is the **engine's own** and is rendered rather
 * than composed: the engine holds the numbers, and a screen that formatted its own estimate
 * would be a second place for it to be rounded differently.
 *
 * Milestone 2 adds, here: Seeking · Skipping, with the accumulating readout · **Finished**,
 * which the end of a film now reaches instead of parking on Stopped · **Stopped with
 * Resume from \<position\>** · Source file vanished · Windows Firewall is blocking
 * CastGood. The scrubber becomes a real slider and the ±30 s controls are rendered.
 *
 * M2's reliability third adds the four states the flags were built for: **Reconnecting**,
 * **Picking up where you left off** (story 12), **\<name\> is playing something else**
 * (14a, stated as a fact — `info` tone, no error styling, no warning icon; upgraded to
 * "is now playing \<other app\>" only if the device ever names one) and **This PC has
 * lost its network connection** (11d, whose *Open network settings* button appears only
 * after 30 s, because a blip the founder could ignore must not look like a job).
 *
 * Milestone 3b adds, here: **Still preparing**, the guard holding the picture while the
 * conversion catches up (10i) — the *only* new state on the playback screen, and its
 * sentence is the **engine's**, rendered verbatim. It is deliberately never the word
 * *Buffering*: criterion 11e turns a *Buffering* longer than 10 s into a reconnection
 * attempt, and a hold is routinely longer than that, so saying it here would tear down a
 * healthy connection to fix a problem that was never the network's. Beside it: *when
 * watching starts* on a conversion that has a head start ahead of it (10a), and a scrubber
 * that draws the unconverted part of the film as unavailable and says how far ahead a jump
 * may go (10d).
 *
 * Two M1 rough edges remain, deliberately:
 *   - Ready to cast still makes **no compatibility claim**. Nothing checks a file until M3.
 *   - Placeholder styling only. M4 owns how any of this looks.
 */

type SessionState = StateSnapshot['session']['state'];

export type Tone = 'info' | 'working' | 'needsYou';

/** Everything the founder can press. Mapped to intents in one place, in App. */
export type ActionId =
  | 'pick'
  | 'cast'
  | 'stop'
  | 'play'
  | 'pause'
  | 'rescan'
  /** *Resume from 0:32:10* — cast this file again, starting where it stopped (16b/16c). */
  | 'resume'
  /** *Find it again* after the source moved. Opens the picker at the old folder (15b). */
  | 'relocate'
  /** *Allow through the firewall* — main runs the elevated command (17b). */
  | 'allowFirewall'
  /** *Show me how to do it myself* — the manual instructions, no elevation (17b). */
  | 'firewallHelp'
  /**
   * *Use a different device* — offered beside *Take it back* (14a) and beside *Reconnect*
   * (11c). It does not choose anything: the device list is already on screen and live, so
   * this moves the founder to it rather than inventing a second way to pick a TV.
   */
  | 'chooseDevice'
  /** 11d: opens Windows' own network settings, and only after 30 s of being offline. */
  | 'networkSettings'
  /**
   * The two halves of the 20-minute confirmation (7f, 7g).
   *
   * Two ids rather than one with a flag, for the same reason the engine has two intents:
   * one of them writes gigabytes to the founder's disk and the other must write nothing at
   * all, and they are next to each other on the screen.
   */
  | 'confirmPreparation'
  | 'declinePreparation'
  /** 8d: stop the job, within 2 s, leaving nothing behind. */
  | 'cancelPreparation'
  /**
   * The two answers to the closing question (founder's ruling, 2026-08-30: in-window, not
   * a modal).
   *
   * Named by **safety rather than by meaning**, because the meaning changes with the
   * question: for a film on the television the safe answer leaves it playing, and for a
   * preparation it keeps the app open. The words come from the host on the snapshot; all
   * the renderer knows is which of the two cannot end somebody's evening by accident.
   */
  | 'quitAnswerSafe'
  | 'quitAnswerOther';

export interface ActionView {
  readonly id: ActionId;
  readonly label: string;
  readonly primary: boolean;
  /** Present ⇒ the control is rendered disabled with this sentence beside it. */
  readonly disabledReason: string | null;
}

export interface FileView {
  readonly name: string;
  /** `null` while the engine is still reading the duration — never a fabricated 0:00:00. */
  readonly durationLabel: string | null;
  /**
   * 8e: what preparation would throw away, said **before** the founder commits.
   *
   * It lives on the file rather than in the status region because it is a fact about the
   * *file*, and because it must survive every state the file passes through on the way to
   * being prepared — the verdict, the confirmation, and the job itself. `null` is the
   * common case and means **nothing is said**: no warning icon, no empty row.
   */
  readonly subtitleNotice: string | null;
}

/**
 * A preparation the founder is watching (8a, 8d).
 *
 * Its own view rather than part of the status region, because it has a bar and a number
 * that change once a second, and the status region is a `role="status"` live region — a
 * percentage inside it would re-announce itself to a screen reader every tick.
 */
export interface PreparationView {
  readonly headline: string;
  readonly percent: number;
  readonly percentLabel: string;
  /** *"about 4 minutes left"*, or `null` until the job has measured itself (8b). */
  readonly remainingLabel: string | null;
  /**
   * 9e: where the file is going, **only** when it is not beside the source.
   *
   * The one path the founder is ever shown, and it is shown because the sentence is
   * useless without it — they have to be able to go and find the file.
   */
  readonly fallbackDirectory: string | null;
}

export interface PickView {
  readonly label: string;
  readonly disabledReason: string | null;
}

/** One row in the subtitle menu. `id` is opaque to the screen — it goes back as an intent. */
export interface SubtitleChoiceView {
  readonly id: string;
  readonly label: string;
  readonly selected: boolean;
}

/**
 * **The subtitle control** — 18a, 18b, 18c, 18k, 19a.
 *
 * `Off` is not a flag here any more than it is in the snapshot: it is the row whose `id` is
 * `null`, and it is selected whenever nothing else is. One representation, so the screen
 * cannot disagree with the engine about whether subtitles are on.
 *
 * Every sentence in `unavailable` and in `problem` is the **engine's own**, rendered rather
 * than composed — the same rule the preparation estimates follow, and for the same reason.
 */
export interface SubtitlesView {
  /** *Off*, then the film's own tracks, then sidecars beside it, then *Choose a file…*. */
  readonly choices: readonly SubtitleChoiceView[];
  /** What the closed control reads: *Off*, or the chosen source's label. */
  readonly summary: string;
  readonly unavailable: readonly { readonly label: string; readonly why: string }[];
  /** 18d's named step. `null` unless a preparation is actually running. */
  readonly preparingLabel: string | null;
  /** One sentence from the engine when a chosen source could not be used. */
  readonly problem: string | null;
  /**
   * 18l: the sentence above is *Subtitles didn't load*, and there is a way out of it.
   *
   * Present only for that one problem. Every other sentence in this control is answered by
   * choosing a different source, which is a press the founder already has.
   */
  readonly canRetry: boolean;
  /** Present ⇒ *Choose a file…* is rendered disabled with this sentence beside it. */
  readonly chooseDisabledReason: string | null;
  /**
   * **The timing control** — story 20. `null` whenever subtitles are Off, because a
   * correction with nothing to correct is a control that cannot mean anything (20a puts it
   * *"beside them"*, and there is no them).
   */
  readonly timing: SubtitleTimingView | null;
}

/**
 * *Timing: in sync* / *Timing: +0.6 s*, with earlier, later and Reset — 20a, 20b, 20e.
 *
 * The **sentence is the engine's**, not this file's: `in sync` versus a signed number is a
 * product rule with a criterion behind it (*"never `+0.0 s`, so a film nobody has touched
 * never looks adjusted"*), and a screen that composed its own could drift from the number
 * actually on the wire. All this decides is that the word *Timing* goes in front of it.
 */
export interface SubtitleTimingView {
  /**
   * *Timing: in sync*, *Timing: +0.6 s*, or — when the correction is one the founder set on
   * an earlier evening (20f) — *Timing: +0.6 s, as you set it last time*. Ready to render.
   */
  readonly label: string;
  /** 20e: at ±30 s the button that cannot move is disabled rather than dead. */
  readonly canGoEarlier: boolean;
  readonly canGoLater: boolean;
  /** Reset is only worth offering when there is something to reset. */
  readonly canReset: boolean;
  /**
   * *Moving the subtitles…* while a change is costing a reload, and `null` the rest of the
   * time — which is every nudge inside ±3 s, i.e. nearly all of them.
   *
   * The founder accepted the reload on the condition it is **stated rather than hidden**
   * (2026-08-26). This is where it is stated.
   */
  readonly reloadingLabel: string | null;
}

/**
 * One ±30 s control.
 *
 * `hidden` and `disabledReason` are different answers to different questions, and 6k turns
 * on the difference: on *Finished* and *Stopped* the TV has been released, so there is
 * nothing to skip **inside** and the buttons are hidden outright. A greyed control implies
 * "not right now"; an absent one says "not a thing here".
 */
export interface SkipView {
  readonly id: 'skipBack' | 'skipForward';
  readonly label: string;
  readonly deltaSec: number;
  readonly hidden: boolean;
  readonly disabledReason: string | null;
}

/**
 * Everything the volume control draws, decided here rather than in the component — M5a §11.
 *
 * The component owns no rules. Whether the control exists, whether it is dead, whether the
 * step ladder is drawn and what the readout says are all answered once, in this file, from
 * the snapshot the engine pushed. That is what keeps the renderer a pure view: there is no
 * second opinion about a volume anywhere in the app.
 */
export interface VolumeView {
  /** The reported level as a percentage, or `null` when the set has not said. */
  readonly percent: number | null;
  readonly muted: boolean;
  /** The outstanding ask as a percentage. Draws the tick; **never the handle** (23b). */
  readonly pendingPercent: number | null;
  /**
   * How many positions this television actually has, or `null` to draw a continuous bar.
   *
   * Derived, never chosen: the ladder is drawn only when one step is wider than §10's
   * existing 3 px stripe pitch, which is why 20 steps are countable and 100 are not.
   */
  readonly steps: number | null;
  /** One keypress, in percentage points — one drawn position, or 5 on a continuous bar. */
  readonly stepPercent: number;
  /** Really `disabled` — never `aria-disabled`. §11 has exactly one unavailable treatment. */
  readonly disabled: boolean;
  /** 23h's one sentence, and the only sentence M5a adds to the product. */
  readonly unavailableReason: string | null;
  /** `37%` · `Muted` · `—`. The whole of the visible readout. */
  readonly readout: string;
  /** The whole of the value for a screen reader — §9's pattern, never a live region. */
  readonly valueText: string;
}

export interface TransportView {
  readonly positionLabel: string;
  readonly durationLabel: string;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly percent: number;
  readonly toggle: { readonly id: 'play' | 'pause'; readonly label: string };
  /** Governs Play/Pause only. Stop has its own answer — see `stopDisabledReason`. */
  readonly controlsDisabled: boolean;
  readonly disabledReason: string | null;
  /**
   * Why Stop cannot be pressed, or `null` when it can.
   *
   * Separate from `controlsDisabled` because they are separate questions. Play/Pause is
   * meaningless mid-jump — the film is between two places and "Pause" would be a promise
   * about which one — but **Stop is always meaningful while a television is ours**, and the
   * state model requires every state that can outlast 2 s to have a way out of it. A drag
   * can occupy up to 4.4 s (settle, confirm, retry), which it did with a dead Stop button
   * and no explanation beside it.
   */
  readonly stopDisabledReason: string | null;
  /**
   * *Subtitles: \<name\>* while a film is playing with a track declared — **read-only**
   * (18g), so the founder can see which one is on without looking at the television.
   *
   * The engine's finished sentence, rendered verbatim, and `null` whenever nothing was
   * declared. There is no toggle and no timing control here: those are step 4, and a
   * disabled one would be a promise the app cannot yet keep.
   */
  readonly subtitleLabel: string | null;
  /**
   * The volume control — M5a, §11. `null` means **not rendered at all**, which is every
   * idle and verdict state (23i): a control that is absent is not the same as one that is
   * dead, and this milestone owes both.
   */
  readonly volume: VolumeView | null;
  /** No live session: the row is shown dimmed rather than vanishing, so nothing jumps. */
  readonly dimmed: boolean;
  /** False ⇒ the scrubber renders as a progress bar with no handle and no drag (6k). */
  readonly canDrag: boolean;
  readonly dragDisabledReason: string | null;
  readonly skips: readonly SkipView[];
  /**
   * What the readout says about a jump that has not landed yet: the running total while
   * taps accumulate (`+1:30`), or the plain truth when the jump hit an end of the film.
   * `null` when the playhead is simply where the device says it is.
   */
  readonly seekNote: string | null;
  /** True while a jump is pending, so the scrubber can show the destination as pending. */
  readonly seeking: boolean;
  /**
   * **M3b, 10d.** How much of the film exists so far, as a percentage of the *true* full
   * duration — the prepared fill on the track. `null` whenever the whole film is there,
   * which is every M3a session and every head start once the conversion has finished: with
   * nothing unavailable, nothing is drawn as unavailable.
   */
  readonly frontierPercent: number | null;
  /** The limit tick: the furthest a jump may land, as a percentage. `null` with `frontierPercent`. */
  readonly limitPercent: number | null;
  /** The same limit in seconds, for the scrubber's own clamp and its `aria-valuetext`. */
  readonly seekLimitSec: number | null;
  /**
   * The one line under the scrubber while part of the film is still being converted (10d).
   *
   * It is **permanent** while the unconverted region exists — *"you can jump ahead to
   * 1:10:20 for now"* — and sharpens when a jump actually ran into the limit, which is the
   * engine's `seek.clamped: 'frontier'`. Never an error: the limit moving to the right is
   * the mechanism working, and the founder can watch it move.
   */
  readonly frontierNote: string | null;
}

export interface DeviceRowView {
  readonly id: string;
  readonly name: string;
  readonly meta: string;
  readonly selected: boolean;
  readonly disabled: boolean;
}

export interface DevicePanelView {
  readonly statusLabel: string;
  readonly rows: readonly DeviceRowView[];
  readonly empty: 'searching' | 'none-found' | null;
  readonly disabledReason: string | null;
  readonly canRescan: boolean;
}

/**
 * A question the **host** needs answered before it can act — today, only the closing one.
 *
 * It is not an engine state and never appears in the engine's enum: `src/engine/` is a
 * plain Node library that does not know this process can be closed. It arrives stapled to
 * the snapshot so it can never describe a world that has already moved on.
 */
export interface HostQuestion {
  readonly id: string;
  readonly kind: string;
  readonly headline: string;
  readonly detail: string;
  readonly answers: readonly string[];
  /** Always 0. The renderer never has to work out which answer is the safe one. */
  readonly safeIndex: number;
}

export interface DiagnosticsView {
  readonly label: string;
  /**
   * 25i. What is removed and what is kept, **before** the control is pressed.
   *
   * Silence here would be the app deciding something private on somebody's behalf, which is
   * the thing question 45 was asked to avoid.
   */
  readonly note: string;
}

export interface ViewModel {
  /** The `docs/DESIGN-SYSTEM.md` §2 name of this state. On the DOM for QA to read. */
  readonly stateName: string;
  readonly documentTitle: string;
  readonly tone: Tone;
  readonly headline: string;
  readonly sub: string | null;
  readonly hairline: boolean;
  readonly actions: readonly ActionView[];
  readonly file: FileView | null;
  readonly pick: PickView;
  /**
   * `null` until a film is chosen — there is nothing to have subtitles for before that.
   * A film with no text tracks and no sidecars beside it still gets a control, because
   * *Choose a file…* is the answer for exactly that film (18c).
   */
  readonly subtitles: SubtitlesView | null;
  readonly transport: TransportView | null;
  readonly devices: DevicePanelView;
  /** Non-null exactly while a job is running. */
  readonly preparation: PreparationView | null;
  /**
   * True while the closing question is on screen.
   *
   * The main process already refuses every other intent while a question is pending, so
   * nothing behind the question can act. This is what lets the surfaces *say* so rather
   * than looking pressable and doing nothing.
   */
  readonly questionPending: boolean;
  /**
   * The one control that is **never absent and never disabled** — story 25, criterion 25a.
   *
   * ⚠️ **It cannot live in the StatusRegion.** §1 allows that region exactly one answer to
   * *"what is happening right now"*, and this is not an event. More importantly, the
   * StatusRegion's actions change with the state — and the states somebody will actually
   * press this in are the broken ones. **A diagnostic that needs a working app is a
   * diagnostic that is absent exactly when it is wanted.**
   */
  readonly diagnostics: DiagnosticsView;
}

/**
 * What the scrubber draws and reads out, as a pure function — **10d's handle clamp**.
 *
 * It lives here rather than in `Scrubber.tsx` for the reason everything else lives here:
 * the renderer is a pure view of state, and this is a derivation over that state plus one
 * gesture. In a project whose tests run headless with no DOM, a derivation inside a
 * component is a derivation nothing can reach — and this particular one is the thing that
 * stops the founder dragging the handle into film that does not exist yet.
 *
 * **The clamp applies to the gesture and never to the film's own position.** During a guard
 * hold the playhead is by definition *past* the limit — the margin fell under two minutes,
 * which is what `frontier − 2 min` subtracts — so clamping the resting handle would drag it
 * (and the played fill) backwards to the tick and read as the film having jumped back.
 * Where the film is, is not the founder's to negotiate; where they are *pointing* is.
 */
export interface ScrubberInput {
  /** Where the film is, per the snapshot, as a percentage of the true full duration. */
  readonly percent: number;
  /** The gesture in progress, as a raw percentage of the track. `null` when nobody is dragging. */
  readonly dragPercent: number | null;
  readonly durationSec: number;
  readonly positionLabel: string;
  readonly durationLabel: string;
  /** 10d's limit, as a percentage. `null` when the whole film exists. */
  readonly limitPercent: number | null;
  /** The same limit in seconds, for the readout a screen reader gets. */
  readonly seekLimitSec: number | null;
}

export interface ScrubberReadout {
  /** Where the handle and the played fill go. */
  readonly handlePercent: number;
  readonly handleSec: number;
  /** True when the drag asked for more film than exists and the handle stopped at the tick. */
  readonly pinnedToLimit: boolean;
  /** `aria-valuetext`: where the film is, of how long, and the limit when there is one. */
  readonly valueText: string;
}

export function scrubberReadout(input: ScrubberInput): ScrubberReadout {
  const { dragPercent, limitPercent } = input;
  const dragging = dragPercent !== null;
  const pinnedToLimit = dragging && limitPercent !== null && dragPercent > limitPercent;
  const handlePercent = !dragging
    ? input.percent
    : limitPercent === null
      ? dragPercent
      : Math.min(dragPercent, limitPercent);
  const handleSec = (handlePercent / 100) * input.durationSec;
  // The limit is named for anyone listening rather than looking (design system §9), and
  // only when there is one: an empty clause on every film would be noise in every readout.
  const limitClause =
    input.seekLimitSec === null ? '' : `. Converted up to ${hms(input.seekLimitSec)}`;
  // Mid-drag this reads out the **destination** — the clamped one, which is where the
  // handle is and where the film will land — rather than where the film still is.
  const where = dragging ? hms(handleSec) : input.positionLabel;
  return {
    handlePercent,
    handleSec,
    pinnedToLimit,
    valueText: `${where} of ${input.durationLabel}${limitClause}`,
  };
}

export interface PickerState {
  /** False when the main process has not exposed a file picker (see bridge.ts). */
  readonly available: boolean;
  /** True while the native dialog is open — the button must not open a second one. */
  readonly busy: boolean;
  readonly error: string | null;
}

/** The same three facts about the **subtitle** picker. A separate dialog, so a separate state. */
export type SubtitlePickerState = PickerState;

/**
 * The two rows in the subtitle menu that are not subtitle sources.
 *
 * They are strings rather than `null` because a menu is a list of things with ids, and a
 * row that cannot be addressed cannot be pressed. Neither ever reaches the engine: App maps
 * `OFF_ID` to a `subtitles.clear` intent and `CHOOSE_FILE_ID` to opening a dialog. The
 * prefix is deliberate — an engine source id is `embedded:2` or `sidecar:<path>`, so these
 * cannot collide with one.
 */
export const OFF_ID = 'castgood:off';
export const CHOOSE_FILE_ID = 'castgood:choose-file';

const LIVE_SESSION: readonly SessionState[] = [
  'connecting',
  'loading',
  'buffering',
  'playing',
  'paused',
  'seeking',
];

/** States where a transport row makes sense at all: a picture exists or is imminent. */
const TRANSPORT_LIVE: readonly SessionState[] = ['buffering', 'playing', 'paused', 'seeking'];

/**
 * States where something is (or is about to be) on the TV screen.
 *
 * `seeking` belongs here: the film is on the television, it is simply moving. Leaving it
 * out told the founder to "Cancel first to choose a different device" during a jump, when
 * there is no Cancel — and would have let an unrelated error notice black out a film that
 * was playing perfectly well.
 */
const HAS_PICTURE: readonly SessionState[] = ['buffering', 'playing', 'paused', 'seeking'];

function isLive(state: SessionState): boolean {
  return LIVE_SESSION.includes(state);
}

/**
 * A failure the founder has to deal with, whatever the session says it is doing.
 *
 * Precedence matters for criterion 3b: after "Couldn't reach <name>" every other device
 * must stay selectable. If the engine leaves the session sitting in `connecting` while it
 * reports the failure, a rule that keyed only off the session state would leave the whole
 * device list locked. If there *is* a picture on the TV, the picture wins — an error
 * notice must not black out a film that is playing perfectly well.
 */
function hasFailed(snapshot: StateSnapshot): boolean {
  const notice = snapshot.notice;
  if (notice === null) return false;
  // A vanished source is graded `warning` — the film played, and the founder is being told
  // where their copy went, not that something broke. It still owns the status region,
  // because it is a thing they have to deal with and it carries the only way out.
  const demandsAttention = notice.severity === 'error' || notice.kind === 'source-missing';
  return demandsAttention && !HAS_PICTURE.includes(snapshot.session.state);
}

function findDevice(snapshot: StateSnapshot, id: string | null): DeviceSnapshot | null {
  if (id === null) return null;
  return snapshot.discovery.devices.find((device) => device.id === id) ?? null;
}

/**
 * The name to say. Never an IP, never a model code, never "Device 1" (criterion 1c) —
 * and never nothing: a message with a hole where the name should be reads as a bug.
 *
 * **Whose name it is depends on whether the session is over**, and that distinction is the
 * founder's bug report of 2026-09-03: *"I hit the stop button and then selected the Family
 * Room TV… the UI implied that it was going to start casting again on the master bedroom
 * TV."*
 *
 * While anything is on a television — playing, buffering, reconnecting, yielded, lost —
 * the name that matters is the set **holding the film**, whatever the founder has since
 * clicked in the list. Once the session is `stopped` there is nothing on any television,
 * `session.deviceId` is only a record of where it *used to be*, and the set that matters is
 * the one **the next press will cast to** — which `startCast` reads from `selectedDeviceId`.
 * Preferring the stale one there named the wrong television in the one sentence that tells
 * the founder where *Resume* is about to send their film.
 *
 * **`ended` is included too, and the reason it once was not is worth keeping.** When this
 * rule was written (PR #39) the Finished screen said *"<name> is back on its own home
 * screen"* — a statement of fact about the television that just played, true whatever the
 * founder clicked next, and pointing it at a newly selected set would have told a lie
 * rather than fixed one. **The founder's ruling of 2026-09-03 deleted that sentence**: a
 * film that plays out now draws the screen the app opens on, whose sentence is *"Pressing
 * Cast sends it to <name>"* — a statement about **where the film goes next**, exactly like
 * *Stopped*. So the carve-out inverted: keeping `ended` on the stale name reproduced the
 * founder's original bug on the one screen it had just been fixed off. Neither PR could
 * see this on its own, and the two merged without a textual conflict.
 */
/**
 * §10's stripe pitch, reused rather than re-chosen.
 *
 * The step ladder is drawn only where one position is wider than the hatch pitch the
 * design system already uses — 8.2 px on a 20-step Chromecast, 1.6 px on the AI PONT's
 * hundred. Borrowing a number the system owns is what stops this being a magic threshold.
 */
const STRIPE_PITCH_PX = 3;
/** §11: `flex: 1 1 164px`, and the ladder is judged against the resting width. */
const TRACK_WIDTH_PX = 164;

/**
 * Everything the volume control shows, worked out once — M5a §11.
 *
 * ⚠️ **Nothing here invents a level.** `percent` is the device's own last word and the
 * only thing that positions the handle; `pendingPercent` is an outstanding *request* and
 * draws a separate mark. If this function ever falls back to the ask when the level is
 * missing, 23b is broken and a television that ignored us starts looking obedient.
 */
function volumeView(snapshot: StateSnapshot, live: boolean): VolumeView | null {
  const volume = snapshot.session.volume;
  // 23i: not rendered at all — absent, not greyed — wherever the television has been
  // released. The engine already publishes `null` for those states.
  if (volume === null) return null;

  const level = volume.level;
  const percent = level === null ? null : Math.round(level * 100);
  const pendingPercent = volume.pending === null ? null : Math.round(volume.pending * 100);
  const muted = volume.muted ?? false;

  const positions =
    volume.stepInterval !== null && volume.stepInterval > 0
      ? Math.round(1 / volume.stepInterval)
      : null;
  const steps =
    positions !== null && TRACK_WIDTH_PX / positions > STRIPE_PITCH_PX ? positions : null;
  // One keypress asks for the next position the founder can actually see. Where the bar is
  // continuous there is no drawn position, so it is five points — §11's own rule.
  const stepPercent = steps === null ? 5 : Math.max(1, Math.round(100 / steps));

  // 23h: the set owns its own volume. The only sentence M5a adds, and it names the device
  // precisely because it exists to state the separation.
  const unavailableReason = volume.controllable
    ? null
    : `${deviceName(snapshot)} keeps its own volume.`;
  // 23i again, from the other side: a session that exists but cannot be *sent to*.
  //
  // ⚠️ **Reconnecting, reattaching, yielded and network-down are FLAGS, not states** — the
  // session state stays `playing` throughout — so asking `live` alone leaves the control
  // enabled in exactly the four situations 23i names, and a press in `Yielded` would send
  // a volume to a television somebody else is watching. That is 14b, and it is the one
  // thing in this component that would be a genuine fault rather than a cosmetic one.
  const flags = snapshot.session.flags;
  const cannotSend = flags.reconnecting || flags.reattaching || flags.yielded || flags.networkDown;
  // Really `disabled`, and never `aria-disabled` — §11 has one unavailable treatment, not
  // two, because nothing about a volume flickers in and out of reach the way the frontier
  // does. Out of the tab order is the point.
  const disabled = !live || cannotSend || !volume.controllable;

  const readout = !volume.controllable
    ? '—'
    : muted
      ? 'Muted'
      : percent === null
        ? '—'
        : `${String(percent)}%`;
  const valueText = !volume.controllable
    ? 'Not available'
    : percent === null
      ? 'Not reported yet'
      : muted
        ? `Muted, ${String(percent)}%`
        : pendingPercent === null || pendingPercent === percent
          ? `${String(percent)}%`
          : `${String(percent)}%, asking for ${String(pendingPercent)}%`;

  return {
    percent,
    muted,
    pendingPercent,
    steps,
    stepPercent,
    disabled,
    unavailableReason,
    readout,
    valueText,
  };
}

function deviceName(snapshot: StateSnapshot): string {
  const over = snapshot.session.state === 'stopped' || snapshot.session.state === 'ended';
  const inUse = over ? null : findDevice(snapshot, snapshot.session.deviceId);
  const selected = findDevice(snapshot, snapshot.discovery.selectedDeviceId);
  return inUse?.friendlyName ?? selected?.friendlyName ?? 'your TV';
}

/**
 * The television this message is **about** — which is not always the one the next press
 * would go to, and issue #66 is what happens when the two are confused.
 *
 * `deviceName` above answers *"where will Cast send it?"*, and for *Stopped* and
 * *Finished* that is right: it is the founder's ruling of 2026-09-03, and it deliberately
 * prefers the **selected** device once the session is over. **Two screens are not asking
 * that question.** *"Lost connection to \<name\>"* and *"\<name\> is now playing …"* are
 * statements about the set that was **holding the film**, and naming a different
 * television there is worse than saying nothing — on 2026-09-09 it named a healthy set
 * sitting in the same room.
 *
 * ⚠️ **It reads the name the engine remembered, never the device list.** A lost connection
 * ends in `stopped`, so the rule above would have skipped the session's device anyway; but
 * even without that, a television that has lost power **is no longer in
 * `discovery.devices`** and cannot be looked up at all. The lookup is kept only as a
 * fallback for sessions that predate the remembered name.
 */
function heldDeviceName(snapshot: StateSnapshot): string {
  return (
    snapshot.session.deviceName ??
    findDevice(snapshot, snapshot.session.deviceId)?.friendlyName ??
    'your TV'
  );
}

interface StatusView {
  readonly stateName: string;
  readonly tone: Tone;
  readonly headline: string;
  readonly sub: string | null;
  readonly hairline: boolean;
  readonly actions: readonly ActionView[];
}

function action(
  id: ActionId,
  label: string,
  primary: boolean,
  disabledReason: string | null = null,
): ActionView {
  return { id, label, primary, disabledReason };
}

/**
 * A condition that outranks the session state itself: the connection is gone, so
 * "Playing" would be a claim the device has not made.
 *
 * Only the two *working* flags live here. A takeover and an offline PC are answered
 * earlier, in `statusOf`, because they outrank a failure notice as well as a state — a
 * television somebody else is using is not a problem to be reported, it is the explanation
 * for everything else on the screen.
 */
function flagOverride(snapshot: StateSnapshot, name: string): StatusView | null {
  const { flags, positionSec } = snapshot.session;
  if (flags.reattaching) {
    return {
      stateName: 'Reattaching',
      tone: 'working',
      headline: `Picking up where you left off on ${name}…`,
      sub: 'The film never stopped — CastGood is taking the controls back.',
      hairline: true,
      // Transient, and the approved mockup labels it ≤5 s. Nothing to cancel: cancelling
      // would mean stopping a film the founder deliberately left running.
      actions: [],
    };
  }
  if (flags.reconnecting) {
    return {
      stateName: 'Reconnecting',
      tone: 'working',
      headline: `Reconnecting to ${name}…`,
      // 11a: nothing turns red, nothing shakes, no dialog opens. The number moves because
      // the film really is still playing on the television — SPIKE-2 measured the position
      // error at 0.003 s across a 15-second outage — so freezing it would be the lie.
      sub: `Your place is held at ${hms(positionSec)}.`,
      hairline: true,
      actions: [],
    };
  }
  return null;
}

/**
 * **The guard is holding the picture — 10i, and 10f when it will not be back soon.**
 *
 * The one state M3b adds to the playback screen, and it is a *sentence on the screen the
 * founder is already looking at*, not a new screen: the file panel, the device list, the
 * scrubber and the position readout are all exactly where they were, and Stop is live
 * throughout (the transport row's own answer — see `transportOf`).
 *
 * **The headline is the engine's, rendered verbatim.** It carries the estimate and it
 * restates itself as that estimate changes, which is 10f's *"a wait that does not update
 * is a bug"*. Composing it here would put the same number in two places to be rounded
 * differently, and — the reason that actually matters — **it must never be the word
 * *Buffering***: criterion 11e turns a *Buffering* longer than 10 s into a reconnection
 * attempt, and three of the freezes in the 2026-08-21 starved run were 10.2 s, 10.3 s and
 * 25.5 s. Each one would have torn down a perfectly healthy connection to fix a problem
 * that was never the network's.
 *
 * No action of its own, deliberately (M3b cut 2). When the conversion catches up the film
 * resumes by itself; when it cannot, the way out is the two presses M2 already built —
 * *Stop*, then *Resume from \<position\>* — and a third loading path in the most
 * reliability-sensitive code in the product is exactly what that cut refused.
 */
function holdStatus(snapshot: StateSnapshot, name: string): StatusView | null {
  // The engine sends one nullable object rather than a boolean and a message that could
  // disagree with it: **its presence is the hold**, and its sentence is always there.
  const hold = snapshot.headStart?.hold ?? null;
  if (hold === null) return null;
  // The position readout stays exactly where it was: the engine stops extrapolating a
  // paused playhead, so this is the frame the guard held, not a number that kept moving.
  const held = hms(snapshot.session.positionSec);
  return {
    // Two names for QA to read off the DOM, because they are two different promises: one
    // says the film comes back on its own, the other says it comes back when the whole
    // conversion is done. The founder-facing sentence for both is the engine's.
    stateName: hold.waitingForCompletion ? 'WaitingForConversion' : 'FrontierHold',
    tone: 'working',
    headline: hold.message,
    sub: hold.waitingForCompletion
      ? `Your place is held at ${held}. Stop keeps it, and Resume picks it up from there.`
      : `Your place is held at ${held}. ${name} carries on by itself — there is nothing to press.`,
    hairline: true,
    actions: [],
  };
}

/**
 * Somebody else has the television (14a).
 *
 * Stated as a **fact**: `info` tone, no error styling, no warning icon, no retry loop. The
 * founder's own ruling of 2026-08-15 is why *Take it back* is a button and not something
 * that happens by itself — quietly seizing a shared television the moment someone else
 * stops using it is precisely the surprise this product exists to avoid.
 */
function yieldedStatus(snapshot: StateSnapshot, hasDevice: boolean, name: string): StatusView {
  const app = snapshot.session.yieldedToApp;
  const saved = hms(snapshot.session.resumePositionSec);
  return {
    stateName: 'Yielded',
    tone: 'info',
    // Naming the other app is a **bonus, never a promise** (founder ruling, 2026-08-19).
    // Checklist item 4 measured this television taking **45.9 s** to name YouTube, against a
    // 15 s grace — so the unnamed case is the common one, not the edge case, and it must read
    // as a finished sentence rather than a gap where a name should have been. "is now playing
    // another app" was that gap. We state the one thing we can honestly speak for: the
    // television is busy with something that is not us.
    headline: app === null ? `${name} is playing something else` : `${name} is now playing ${app}`,
    sub: `CastGood stepped aside. Your place is saved at ${saved}.`,
    hairline: false,
    actions: [
      action('resume', 'Take it back', true, hasDevice ? null : 'No device to cast to yet'),
      action('chooseDevice', 'Use a different device', false),
    ],
  };
}

/**
 * ~30 seconds of failed reconnection (11c).
 *
 * The saved position is **stated as a number**, which the criterion asks for in as many
 * words, and the device's name is put back into the sentence here rather than baked into
 * the engine's notice — the screen already knows which television it is talking about.
 */
function lostConnectionStatus(snapshot: StateSnapshot, name: string): StatusView {
  const saved = hms(snapshot.session.resumePositionSec);
  return {
    stateName: 'LostConnection',
    tone: 'needsYou',
    headline: `Lost connection to ${name}`,
    sub: `Your place is saved at ${saved}.`,
    hairline: false,
    actions: [
      action('resume', 'Reconnect', true),
      action('chooseDevice', 'Use a different device', false),
    ],
  };
}

/**
 * This PC's own network went away (11d).
 *
 * The button that opens Windows' network settings appears **after 30 s and not before**:
 * the engine decides when, because the renderer holds no clock. A ten-second blip is a
 * hiccup the founder can ignore, and offering them a settings page for it turns something
 * that fixed itself into something that looked like their problem.
 */
function offlineStatus(snapshot: StateSnapshot): StatusView {
  const held = hms(snapshot.session.positionSec);
  const live = TRANSPORT_LIVE.includes(snapshot.session.state);
  return {
    stateName: 'NetworkDown',
    tone: 'working',
    headline: 'This PC has lost its network connection',
    sub: live
      ? `Waiting for it to come back. Your place is held at ${held}.`
      : 'Waiting for it to come back. Nothing can be cast until it does.',
    hairline: true,
    actions: snapshot.session.offlineHelp
      ? [action('networkSettings', 'Open network settings', false)]
      : [],
  };
}

/**
 * Stopped, with the way back in as the primary action (16b).
 *
 * The saved position is stated **and** offered. It is deliberately not adjustable — the
 * founder's ruling on 2026-08-14: Stop is a clean exit, you resume from exactly where you
 * left off, and the skip controls are how you move once it is playing again.
 */
function stoppedStatus(snapshot: StateSnapshot, hasDevice: boolean, name: string): StatusView {
  const reason = hasDevice ? null : 'No device to cast to yet';
  const saved = hms(snapshot.session.resumePositionSec);
  // A film stopped in its opening second has nothing to resume to, and *Resume from
  // 0:00:00* beside *Start from the beginning* is two buttons for one action.
  const worthResuming = snapshot.session.resumePositionSec >= 1;
  return {
    stateName: 'Stopped',
    tone: 'info',
    headline: 'Stopped',
    sub: `Your place is saved at ${saved}. Resuming picks it up on ${name}.`,
    hairline: false,
    actions: worthResuming
      ? [
          action('resume', `Resume from ${saved}`, true, reason),
          action('cast', 'Start from the beginning', false, reason),
          action('pick', 'Choose another video', false),
        ]
      : [action('cast', 'Play again', true, reason), action('pick', 'Choose another video', false)],
  };
}

/**
 * The source file went away (15a/15b).
 *
 * Stated as a fact about this PC, not as a failure of the cast — and only ever *after*
 * playback ended, which the engine enforces by holding the flag in silence until then.
 */
function sourceMissingStatus(snapshot: StateSnapshot): StatusView {
  const saved = snapshot.session.resumePositionSec;
  return {
    stateName: 'SourceMissing',
    tone: 'needsYou',
    headline: 'The original file is no longer where it was',
    // No raw Windows path and no `ENOENT`: the name is what the founder recognises, and
    // the folder is where the button takes them.
    sub:
      saved >= 1
        ? `CastGood can pick up from ${hms(saved)} once it knows where the file went.`
        : 'CastGood needs to know where it went before it can play it again.',
    hairline: false,
    actions: [
      action('relocate', 'Find it again', true),
      action('pick', 'Choose another video', false),
    ],
  };
}

/**
 * The device took the video and never came back for it (17a).
 *
 * Named rather than spun: on Windows this is nearly always the firewall, and a spinner
 * that never ends is the one outcome the PRD refuses to ship. Two ways out, and the second
 * needs no admin rights — a founder who cannot elevate is not stuck.
 */
function firewallStatus(snapshot: StateSnapshot, hasDevice: boolean, name: string): StatusView {
  // *Try again* is not decoration, and leaving it out is what checklist item 6 caught on
  // 2026-08-19: after the elevated command really did add the rules, the app said "The rule
  // was added. Press Cast to try again." — on a screen with no Cast button on it. The
  // founder was told to press a control that did not exist, and the manual route ends with
  // the same sentence, so it stranded them too. Every "needs you" state owes the founder a
  // way out; this one owed two and had none.
  const blocked =
    snapshot.file === null ? 'No video chosen' : hasDevice ? null : 'No device chosen';
  // A firewall block can interrupt a *Resume from 0:32:10* as easily as a fresh cast, and
  // `media.not_fetched` deliberately keeps the saved position through it. So the way back has
  // to honour that position: `cast` restarts at 0:00 and overwrites it, which would quietly
  // turn "the firewall stopped my film" into "my film started again from the beginning". The
  // Stopped screen has told these two apart all along; this one had only the beginning.
  const saved = snapshot.session.resumePositionSec >= 1;
  return {
    stateName: 'FirewallBlocked',
    tone: 'needsYou',
    headline: 'Windows Firewall is blocking CastGood',
    sub: `${name} accepted the video but can’t reach this PC to fetch it.`,
    hairline: false,
    actions: [
      action('allowFirewall', 'Allow through the firewall', true),
      saved
        ? action(
            'resume',
            `Try again from ${hms(snapshot.session.resumePositionSec)}`,
            false,
            blocked,
          )
        : action('cast', 'Try again', false, blocked),
      action('firewallHelp', 'Show me how to do it myself', false),
    ],
  };
}

/** *"about 4 minutes left"* — the founder's own words for a wait, never a countdown clock. */
function remainingLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  if (total < 10) return 'nearly done';
  if (total < 60) return `about ${String(Math.round(total / 5) * 5)} seconds left`;
  if (total < 90) return 'about a minute left';
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `about ${String(minutes)} minutes left`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  const hourWord = `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  return rest === 0 ? `about ${hourWord} left` : `about ${hourWord} ${String(rest)} minutes left`;
}

/**
 * *"about 4 minutes"* — the same coarse ladder as `remainingLabel`, without the *left*.
 *
 * Two different questions get two different sentences, so they get two different endings:
 * *how long until this job is over* ends in "left", and *how long until you can start
 * watching* does not, because nothing is being counted down to its end. The ladder itself
 * is the design system's (§3.5) and is deliberately identical — an estimate that rounded
 * one way here and another way there would be the same number disagreeing with itself.
 */
function approxLabel(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null;
  const total = Math.max(0, Math.round(seconds));
  if (total < 10) return 'a few seconds';
  if (total < 60) return `about ${String(Math.round(total / 5) * 5)} seconds`;
  if (total < 90) return 'about a minute';
  const minutes = Math.round(total / 60);
  if (minutes < 60) return `about ${String(minutes)} minutes`;
  const hours = Math.floor(minutes / 60);
  const rest = Math.round((minutes % 60) / 5) * 5;
  if (rest === 60) return `about ${String(hours + 1)} hours`;
  const hourWord = `${String(hours)} hour${hours === 1 ? '' : 's'}`;
  return rest === 0 ? `about ${hourWord}` : `about ${hourWord} ${String(rest)} minutes`;
}

/**
 * 10a: *"the app said beforehand roughly when watching would start"*.
 *
 * **Not the same number as the one in the progress bar**, and that is the whole point of
 * saying it: `secondsRemaining` is when the conversion is *done*, and this is when the film
 * can be *watched*, which on a two-hour film is twenty minutes earlier. `null` — a
 * repackage, a job too young to have measured a speed, or a film shorter than the head
 * start — means there is nothing honest to say, and nothing is said.
 */
function watchableSentence(seconds: number | null): string | null {
  const label = approxLabel(seconds);
  return label === null ? null : `Watching starts in ${label} — the rest converts while you watch.`;
}

function preparationOf(snapshot: StateSnapshot): PreparationView | null {
  const { preparation } = snapshot;
  if (!preparation.active) return null;
  // **M3b cut 3: no conversion percentage and no second progress bar on the playback
  // screen.** Once the television has the film, the conversion is not a thing the founder
  // is waiting in front of any more — it is machinery behind a film they are watching, and
  // the one number they need from it is *how long* when the picture is held, which the
  // status region gives them. The job carries on; only the bar goes.
  if (snapshot.headStart !== null) return null;
  return {
    headline: preparation.headline ?? 'Preparing…',
    percent: preparation.percent,
    percentLabel: `${String(Math.round(preparation.percent))}%`,
    remainingLabel: remainingLabel(preparation.secondsRemaining),
    fallbackDirectory: preparation.fallbackDirectory,
  };
}

/**
 * A job is running (8a). The status region says what and offers the way out.
 *
 * The **bar** is not here — it is `PreparationView`, rendered in its own panel — because
 * this region is a `role="status"` live region and a percentage inside it would re-announce
 * itself to a screen reader on every tick.
 */
function preparingStatus(snapshot: StateSnapshot): StatusView {
  const fallback = snapshot.preparation.fallbackDirectory;
  // 10a, and it changes what this whole state means: a conversion with a head start ahead
  // of it is no longer a wait for the *job*, it is a wait for the *film*, and those are
  // different lengths. Saying "nothing goes to the television until this has finished"
  // over one of those would be false — the television gets it long before that.
  const watchable = watchableSentence(snapshot.preparation.watchableInSeconds);
  // **Three answers, not two.** Until 2026-08-26 a head-start conversion with no measured
  // speed yet fell through to *"Nothing goes to the television until this has finished"* —
  // which is false for a film that is about to start early, and it was on screen for the
  // first minute of every conversion. The honest third answer is that the wait is not known
  // yet, and the founder chose to be told exactly that rather than shown a number the app
  // might have to take back (2026-08-26).
  const base =
    watchable ??
    (snapshot.preparation.estimatingWait
      ? 'Still working out how long.'
      : 'Nothing goes to the television until this has finished.');
  return {
    stateName: 'Preparing',
    tone: 'working',
    headline: snapshot.preparation.headline ?? 'Preparing…',
    // 9e's sentence, and the one place in the whole product a path is shown: the founder
    // cannot go and find the file without it.
    sub:
      fallback === null
        ? base
        : `${base} The film’s own folder can’t be written to, so the prepared copy is going to ${fallback}.`,
    // **No hairline: this wait has a bar.** §10 gives a transient state a pulsing dot plus
    // *"a hairline **or** a determinate bar"*, and §3 splits them by whether the end can be
    // measured. Preparation renders a `PreparationPanel` with a real percentage and a real
    // estimate, so a sliding hairline 40 px above it says *we cannot tell you how long*
    // directly over a bar saying *34 %, about six minutes* — two contradictory claims about
    // the same wait, on the two most-looked-at screens in the product. The dot stays.
    hairline: false,
    actions: [action('cancelPreparation', 'Cancel', false)],
  };
}

/**
 * 7f: the 20-minute confirmation, **a state and never a dialog**.
 *
 * The three sentences are the engine's, because the engine holds the numbers — a screen
 * that formatted its own would be a second place for the estimate to be rounded differently.
 */
function confirmStatus(confirmation: {
  startsWatching: string;
  diskUse: string;
  cancelWarning: string;
}): StatusView {
  return {
    stateName: 'ConfirmPreparation',
    // **Steady, not `needsYou`** — §10 names this state specifically: *"It is a decision,
    // and it must not be dressed as a warning."* `--error` belongs to exactly seven states
    // and this is not one of them; a red-bordered panel on a raised surface is the app's
    // language for *something has gone wrong and cannot proceed*, and nothing has. It is
    // the same reading the closing question already got, arrived at late.
    tone: 'info',
    headline: 'This is a long job',
    sub: `${confirmation.startsWatching} ${confirmation.diskUse} ${confirmation.cancelWarning}`,
    hairline: false,
    actions: [
      action('confirmPreparation', 'Start preparing', true),
      action('declinePreparation', 'Not now', false),
    ],
  };
}

/**
 * A file that needs work before it can be cast — Tier 2 or Tier 3 (7a).
 *
 * The headline is the classifier's own: *Ready in about 40 seconds* · *Needs converting —
 * about 25 minutes*. Nothing here rewords it, because two places writing the same sentence
 * is two places for it to drift.
 *
 * **The button ends in an ellipsis when a further step follows** (7f). That is the whole of
 * the visible difference between a press that starts gigabytes of work and one that opens a
 * question first, and it costs one character.
 */
function needsPreparationStatus(
  verdict: FileVerdictSnapshot,
  hasDevice: boolean,
  name: string,
): StatusView {
  const label = verdict.requiresConfirmation ? 'Prepare and cast…' : `Prepare and cast to ${name}`;
  return {
    stateName: verdict.kind === 'remux' ? 'NeedsRepackaging' : 'NeedsConverting',
    tone: 'info',
    headline: verdict.headline,
    sub: verdict.reason,
    hairline: false,
    actions: [action('cast', label, true, hasDevice ? null : 'No device to cast to yet')],
  };
}

function readyStatus(snapshot: StateSnapshot, hasDevice: boolean, name: string): StatusView {
  if (hasDevice) {
    const verdict = snapshot.file?.verdict ?? null;
    return {
      stateName: 'Ready',
      tone: 'info',
      headline: 'Ready to cast',
      // M3a: *Ready to cast* can finally make a compatibility claim that is true, so the
      // classifier's own reason is preferred — *"It was prepared last time, so there is
      // nothing to wait for"* (7c). With no verdict at all, nothing has checked this file
      // against this device and the sub-line names the destination and stops there, which
      // is exactly what M1 did and is still the honest answer on a machine with no ffmpeg.
      sub: verdict?.reason ?? `Pressing Cast sends it to ${name}.`,
      hairline: false,
      actions: [action('cast', `Cast to ${name}`, true)],
    };
  }
  const anyDevices = snapshot.discovery.devices.length > 0;
  return {
    stateName: 'ReadyNoDevice',
    tone: 'info',
    headline: 'Nowhere to cast to yet',
    sub: anyDevices
      ? 'Your video is chosen. Pick which device it goes to.'
      : 'Your video is chosen. CastGood is still looking for a device on your network.',
    hairline: false,
    actions: [
      action('cast', 'Cast', true, anyDevices ? 'Choose a device first' : 'No device found yet'),
    ],
  };
}

function statusOf(snapshot: StateSnapshot): StatusView {
  const { session, notice, file, discovery } = snapshot;
  const name = deviceName(snapshot);
  const hasDevice = findDevice(snapshot, discovery.selectedDeviceId) !== null;

  // Somebody else has the television. This is the explanation for everything else on the
  // screen, so it comes before any notice — and it is not a failure, so it must not be
  // allowed to fall through into the failure screen and pick up its styling.
  if (session.flags.yielded) return yieldedStatus(snapshot, hasDevice, heldDeviceName(snapshot));

  // 11d: this PC, not the television. Nothing can be cast until it comes back, and saying
  // anything else — "Reconnecting to \<name\>" — would blame the wrong machine.
  if (session.flags.networkDown && (isLive(session.state) || file !== null)) {
    return offlineStatus(snapshot);
  }

  // 11c: ~30 s of failed reconnection, and only now. The name goes back into the sentence
  // here because the screen knows which television it means; the engine's notice does not.
  if (notice !== null && hasFailed(snapshot) && notice.kind === 'lost-connection') {
    return lostConnectionStatus(snapshot, heldDeviceName(snapshot));
  }

  // Two problems know exactly what they are and exactly what to offer, so they are
  // answered before the generic failure screen gets a chance to guess.
  if (notice !== null && hasFailed(snapshot) && notice.kind === 'source-missing') {
    return sourceMissingStatus(snapshot);
  }
  if (notice !== null && hasFailed(snapshot) && notice.kind === 'firewall-blocked') {
    return firewallStatus(snapshot, hasDevice, name);
  }

  // A genuine failure owns the status region until it is dealt with.
  if (notice !== null && hasFailed(snapshot)) {
    // The engine's notice wording is final and founder-facing ("Couldn't reach Living
    // Room TV", "Couldn't play this file"), so it is shown verbatim rather than being
    // reworded here. Two ways out, as every "needs you" state must have — and the second
    // real route is the device list itself, which stays live.
    const canRetry = file !== null && hasDevice;
    return {
      stateName: 'Failed',
      tone: 'needsYou',
      headline: notice.message,
      sub: null,
      hairline: false,
      actions: canRetry
        ? [
            action('cast', notice.actionLabel ?? 'Try again', true),
            action('pick', 'Choose a different video', false),
          ]
        : [
            action('rescan', 'Search again', true),
            action('pick', 'Choose a different video', false),
          ],
    };
  }

  if (isLive(session.state)) {
    const override = flagOverride(snapshot, name);
    if (override !== null) return override;

    // 10i. It sits *below* the recovery flags on purpose — a film nobody can reach is not
    // a film the converter is holding — and *above* the session state, because while the
    // guard holds, the device is paused and "Paused" would credit the founder with a press
    // they never made.
    const hold = holdStatus(snapshot, name);
    if (hold !== null) return hold;

    switch (session.state) {
      case 'connecting':
        return {
          stateName: 'Connecting',
          tone: 'working',
          headline: `Connecting to ${name}…`,
          // Retries are silent: "attempt 2 of 3" makes a working recovery look like a
          // struggle, and criterion 3b forbids a retry counter outright. **This one
          // headline covers the whole of reaching the television** — the handshake and
          // every silent re-send of the LAUNCH that wakes its receiver, which on the
          // founder's hardware is 6–14 s of it.
          sub: null,
          hairline: true,
          actions: [action('stop', 'Cancel', false)],
        };
      case 'loading':
        return {
          stateName: 'Loading',
          tone: 'working',
          headline: `Starting on ${name}…`,
          // True when it is said: the session reaches `loading` only once the television's
          // own receiver has answered, never on the bare socket. Saying it earlier meant
          // "the TV has been reached" could be followed by "Couldn't reach <name>".
          sub: 'The TV has been reached — the video is on its way.',
          hairline: true,
          actions: [action('stop', 'Cancel', false)],
        };
      case 'buffering':
        return {
          stateName: 'Buffering',
          tone: 'working',
          headline: 'Buffering…',
          sub: null,
          hairline: true,
          actions: [],
        };
      case 'seeking':
        return {
          stateName: 'Seeking',
          tone: 'working',
          headline: 'Seeking…',
          sub: null,
          hairline: true,
          actions: [],
        };
      case 'paused':
        return {
          stateName: 'Paused',
          tone: 'info',
          headline: 'Paused',
          sub: `Your place is held on ${name}.`,
          hairline: false,
          actions: [],
        };
      case 'playing':
      default:
        return {
          stateName: 'Playing',
          tone: 'info',
          headline: `Playing on ${name}`,
          sub: null,
          hairline: false,
          actions: [],
        };
    }
  }

  // 7a: a check is running. It has its own field rather than a verdict kind, because it
  // describes a file that is **not yet the selection** — see `CheckSnapshot`. Nothing is
  // offered: choosing another file is how a check is cancelled, and that button is already
  // on screen in the file panel.
  if (snapshot.check !== null) {
    return {
      stateName: 'Checking',
      tone: 'working',
      headline: snapshot.check.headline,
      sub: `Looking at ${snapshot.check.name}. Nothing is sent to a television by looking at a file.`,
      hairline: true,
      actions: [],
    };
  }

  // A job is running. It outranks the verdict that started it — the founder is watching a
  // bar, not deciding anything.
  if (snapshot.preparation.active) return preparingStatus(snapshot);

  if (file === null) {
    const stateName =
      discovery.phase === 'none'
        ? 'IdleNoDevices'
        : discovery.devices.length > 0
          ? 'IdleDevices'
          : 'IdleSearching';
    return {
      stateName,
      tone: 'info',
      headline: 'Nothing chosen yet',
      // The single primary button for this state lives in the FilePanel, so the status
      // region carries no action of its own: one primary per screen.
      sub: 'Pick a video from this PC. Choosing one doesn’t start anything — you press Cast when you’re ready.',
      hairline: false,
      actions: [],
    };
  }

  // 7d: decided **during the check, before the founder commits to anything**, and never
  // discovered mid-cast. One sentence a person can act on, and a way out.
  if (file.verdict !== null && file.verdict.kind === 'impossible') {
    return {
      stateName: 'Impossible',
      tone: 'needsYou',
      headline: file.verdict.headline,
      sub: file.verdict.reason,
      hairline: false,
      actions: [action('pick', 'Choose another video', true)],
    };
  }

  // 7f: the confirmation is a state, and it outranks the verdict that opened it — it *is*
  // the founder's press, part-way through being honoured.
  if (file.verdict?.confirmation != null) return confirmStatus(file.verdict.confirmation);

  // 7a's other two verdicts: a wait the founder is told about before they commit to it.
  if (file.verdict !== null && (file.verdict.kind === 'remux' || file.verdict.kind === 'convert')) {
    return needsPreparationStatus(file.verdict, hasDevice, name);
  }

  // 16a, superseded 2026-09-03: a film that plays out returns the app to the screen it
  // opens on — same film still selected, *Cast to <TV>* naming where it will go. The old
  // *Finished* screen parked here on the reasoning that silence reads as a crash; the
  // founder's ruling is that the opening screen is not silence, it is the app at rest.
  if (session.state === 'ended') return readyStatus(snapshot, hasDevice, name);
  if (session.state === 'stopped') return stoppedStatus(snapshot, hasDevice, name);
  return readyStatus(snapshot, hasDevice, name);
}

/**
 * 10d: the two sentences the unconverted region owes the founder.
 *
 * The **standing** one is permanent while that region exists, because the limit is a fact
 * about the film and not an event — and because the founder can watch it travel to the
 * right, which is what turns a limit into a mechanism rather than a fault. The **sharper**
 * one replaces it when a jump actually ran into the limit, which the engine reports as
 * `seek.clamped: 'frontier'`.
 *
 * Neither is an error, and neither is timed by the renderer: the sharper sentence lasts
 * exactly as long as the engine keeps the clamped seek on the snapshot. A four-second
 * timer here would be the renderer deciding how long something is true.
 */
function frontierNote(limitSec: number, clamped: boolean): string {
  const limit = hms(limitSec);
  return clamped
    ? `That part isn’t ready yet — it went as far as ${limit}. The limit moves as it goes.`
    : `You can jump ahead to ${limit} for now — the rest is still converting. This moves as it goes.`;
}

function transportOf(snapshot: StateSnapshot, name: string): TransportView | null {
  const { session, file } = snapshot;
  const live = TRANSPORT_LIVE.includes(session.state);
  // *Stopped* keeps its row: a saved position is a thing the row is about. *ended* does
  // not, because the screen it now draws is the one the app opens on, and that screen has
  // no transport row on it.
  const idle = session.state === 'stopped' && file !== null;
  if (!live && !idle) return null;

  const durationSec = session.durationSec > 0 ? session.durationSec : (file?.durationSec ?? 0);
  // Stopped released the device, so the row shows the file's shape, not a live position;
  // the saved position is stated in words in the status region instead.
  const positionSec = live ? session.positionSec : 0;

  const { flags, seek } = session;
  const blocked = flags.networkDown
    ? 'This PC is offline'
    : flags.reconnecting
      ? `Waiting for ${name}`
      : flags.reattaching
        ? 'Picking the session up again'
        : flags.yielded
          ? 'In use by another app'
          : null;

  // The play/pause toggle. Held during a drag-seek because the film is between two places
  // and "Pause" would be a promise about which one — but never held silently.
  const seeking = session.state === 'seeking';
  // 10i: while the guard holds, the pause belongs to the guard. Play would be the founder
  // overruling a protection they cannot see the reason for — and the film comes back on
  // its own, so the button would only ever take the picture *into* the unconverted region.
  const holding = (snapshot.headStart?.hold ?? null) !== null;
  const controlsDisabled = !live || blocked !== null || holding || seeking;
  const disabledReason = !live
    ? 'Nothing is playing'
    : (blocked ??
      (holding ? 'It starts again by itself' : seeking ? 'Waiting for the jump to land' : null));
  // Stop is the way out of everything, including a jump that is taking too long — and
  // including a hold, which is 10f's whole answer to a conversion that cannot catch up.
  const stopDisabledReason = !live ? 'Nothing is playing' : blocked;

  // 6k: jumping away is the best escape from a bad buffer, so the skips stay live through
  // Buffering — and so does Stop, which is the other way out of one.
  const skipsHidden = !live;
  const skipReason = blocked ?? (live ? null : 'Nothing is playing');
  // Back is a real escape from a hold and resolves it instantly — jumping backwards is
  // what puts the margin back — so it stays live. Forward is precisely the thing that
  // cannot work: everything ahead of the playhead during a hold is inside the margin the
  // guard is defending, so a forward jump would clamp *backwards*, into film the founder
  // has already watched. A press that moves the film the wrong way is worse than one that
  // says no.
  const skips: SkipView[] = [
    {
      id: 'skipBack',
      label: 'Back 30s',
      deltaSec: -30,
      hidden: skipsHidden,
      disabledReason: skipReason,
    },
    {
      id: 'skipForward',
      label: 'Forward 30s',
      deltaSec: 30,
      hidden: skipsHidden,
      disabledReason: skipReason ?? (holding ? 'Still preparing' : null),
    },
  ];

  // 6i: state the real distance moved rather than leaving a dead button. The clamp wins
  // over the running total — "+0:30" beside a playhead that did not move 30 seconds is the
  // very thing the criterion exists to prevent.
  const seekNote =
    seek === null
      ? null
      : seek.clamped === 'start'
        ? 'Back to the start'
        : seek.clamped === 'end'
          ? 'That’s the end of the film.'
          : // 10d's clamp is answered *under the scrubber*, where the limit already has a
            // permanent line of its own, and the chip stays silent rather than showing a
            // `+0:30` the film did not move. 6i forbids exactly that: a delta beside a
            // playhead that went a shorter distance is the thing the criterion exists to
            // prevent, and the origin of the jump is not on the snapshot to subtract from.
            seek.clamped === 'frontier'
            ? null
            : seek.pendingDeltaSec !== null && seek.pendingDeltaSec !== 0
              ? signedDelta(seek.pendingDeltaSec)
              : null;

  // 10d. Only while film is genuinely missing: a finished conversion has nothing left to
  // draw as unavailable, even though the television is still reading our segments (10g).
  const headStart = snapshot.headStart;
  const growing = headStart !== null && !headStart.conversionComplete && durationSec > 0;
  // The engine's limit is the frontier less the guard's margin; the end of the film is a
  // limit too, and near the end of a conversion it is the smaller of the two.
  // Capped in the engine against the film's own length, so this reads it rather than
  // re-deriving it: two places computing one limit is two places to disagree.
  const seekLimitSec = growing ? headStart.seekLimitSec : null;

  return {
    positionLabel: hms(positionSec),
    durationLabel: hms(durationSec),
    positionSec,
    durationSec,
    percent: percentOf(positionSec, durationSec),
    // With nothing playing, the resting control is Play — a disabled *Pause* beside a
    // live "Play again" would read as though the app thought it was still going.
    toggle:
      !live || session.state === 'paused'
        ? { id: 'play', label: 'Play' }
        : { id: 'pause', label: 'Pause' },
    controlsDisabled,
    disabledReason,
    stopDisabledReason,
    subtitleLabel: snapshot.session.subtitleLabel,
    volume: volumeView(snapshot, live),
    dimmed: !live,
    // A scrubber that invites a drag it cannot honour is worse than one that plainly
    // cannot be dragged, so this follows the engine's own `canSeek` rather than guessing.
    canDrag: session.canSeek && durationSec > 0,
    dragDisabledReason:
      session.canSeek || !live
        ? blocked
        : session.state === 'buffering'
          ? 'Use the skip buttons while it buffers'
          : blocked,
    skips,
    seekNote,
    seeking: seek !== null,
    // Drawn against the **true full duration**, which is our own probe's answer and never
    // the receiver's — both the Ultra and the `AI PONT` report `-1` for the whole session
    // (10c). `durationSec` above prefers the session's, which the engine seeds from that
    // probe, and falls back to the file's; neither is ever the device's.
    frontierPercent: growing ? percentOf(headStart.frontierSec, durationSec) : null,
    limitPercent: seekLimitSec === null ? null : percentOf(seekLimitSec, durationSec),
    seekLimitSec,
    frontierNote:
      seekLimitSec === null ? null : frontierNote(seekLimitSec, seek?.clamped === 'frontier'),
  };
}

function devicesOf(snapshot: StateSnapshot): DevicePanelView {
  const { devices, phase, selectedDeviceId } = snapshot.discovery;
  // One device at a time in M1: switching mid-session is not a thing the engine can do,
  // so the rows say so rather than looking pressable and doing nothing. A failure unlocks
  // them again immediately — criterion 3b: every other device stays selectable.
  // 11d: the list **dims rather than empties**. The televisions have not gone anywhere;
  // this PC has, and a list that emptied itself would have the founder hunting for a
  // device problem that does not exist.
  const offline = snapshot.session.flags.networkDown;
  const locked = offline || (isLive(snapshot.session.state) && !hasFailed(snapshot));
  const beforePicture = !HAS_PICTURE.includes(snapshot.session.state);
  const disabledReason = offline
    ? 'This PC has no network connection'
    : locked
      ? beforePicture
        ? 'Cancel first to choose a different device'
        : 'Stop playing to cast somewhere else'
      : null;

  const rows = devices.map<DeviceRowView>((device) => ({
    id: device.id,
    name: device.friendlyName,
    meta: device.available ? device.model : `${device.model} · not responding`,
    selected: device.id === selectedDeviceId,
    disabled: locked,
  }));

  const statusLabel =
    devices.length > 0
      ? `${String(devices.length)} found`
      : phase === 'none'
        ? 'None found'
        : 'Looking…';

  return {
    statusLabel,
    rows,
    // The "no devices" checklist clears itself the moment a device answers — nothing to
    // dismiss, nothing to click (criterion 1d).
    empty: rows.length > 0 ? null : phase === 'none' ? 'none-found' : 'searching',
    disabledReason,
    canRescan: !locked,
  };
}

function pickOf(snapshot: StateSnapshot, picker: PickerState): PickView {
  const chosen = snapshot.file !== null;
  const label = picker.busy ? 'Choosing…' : chosen ? 'Choose a different video…' : 'Choose video…';

  if (!picker.available) {
    return { label, disabledReason: 'The file picker isn’t available in this build' };
  }
  if (picker.busy) return { label, disabledReason: 'The file picker is open' };
  if (snapshot.preparation.active) {
    return { label, disabledReason: 'Choosing another file would cancel this' };
  }
  if (picker.error !== null) return { label, disabledReason: picker.error };
  return { label, disabledReason: null };
}

/**
 * The subtitle control, as words — 18a's list and 19a's *Off*.
 *
 * **`selectedId === null` is Off**, straight from the snapshot, and this function invents no
 * second way to say it. `CHOOSE_FILE_ID` is a sentinel row rather than a source: pressing it
 * opens a dialog, which is not something the engine can be asked for with a `subtitles.select`.
 */
function subtitlesOf(snapshot: StateSnapshot, picker: SubtitlePickerState): SubtitlesView | null {
  if (snapshot.file === null) return null;
  const { subtitles } = snapshot;
  const chosen = subtitles.selectedId;

  // A chosen source that is in no list is a picked file — the only kind that can be.
  const picked =
    chosen !== null && !subtitles.options.some((option) => option.id === chosen) ? chosen : null;

  const choices: SubtitleChoiceView[] = [
    // 19a: Off is a real row and it is selected on every film, every time — never a blank
    // entry at the top of a list, and never implied by nothing else being ticked.
    { id: OFF_ID, label: 'Off', selected: chosen === null },
    ...subtitles.options.map((option) => ({
      id: option.id,
      label: option.label,
      selected: option.id === chosen,
    })),
    // **A picked file gets a row of its own, ticked.** It is deliberately not in `options` —
    // it lives wherever the founder pointed at it (18c) and belongs to no film's list — but
    // without a row for it, opening the menu while a picked subtitle is on shows *nothing*
    // selected, while the closed control reads its name. The screen would be disagreeing
    // with itself about whether subtitles are on, which is the one thing 19a's "Off is a
    // state, not the absence of one" exists to prevent.
    ...(picked === null
      ? []
      : [{ id: picked, label: subtitles.selectedLabel ?? 'Chosen file', selected: true }]),
    { id: CHOOSE_FILE_ID, label: 'Choose a file…', selected: false },
  ];

  return {
    choices,
    summary: subtitles.selectedLabel ?? 'Off',
    unavailable: subtitles.unavailable,
    // The engine owns the sentence everywhere else in this file; this one is the screen's
    // because the snapshot carries a boolean, and 18d names the step in words.
    preparingLabel: subtitles.preparing ? 'Preparing subtitles…' : null,
    problem: subtitles.problem,
    canRetry: subtitles.canRetry,
    timing:
      chosen === null
        ? null
        : {
            // 20f: *"Timing: +0.6 s, as you set it last time"*, with Reset beside it —
            // which `canReset` already puts there for any non-zero offset. The clause is
            // added rather than the sentence rewritten, so the reading a founder knows is
            // still the reading they get, with its provenance after it.
            label: `Timing: ${subtitles.timing}${
              subtitles.timingRemembered ? ', as you set it last time' : ''
            }`,
            canGoEarlier: subtitles.canGoEarlier,
            canGoLater: subtitles.canGoLater,
            canReset: subtitles.offsetMs !== 0,
            reloadingLabel: subtitles.reloading ? 'Moving the subtitles…' : null,
          },
    chooseDisabledReason: !picker.available
      ? 'The file picker isn’t available in this build'
      : picker.busy
        ? 'The file picker is open'
        : picker.error,
  };
}

/**
 * Everything that is not the question, made **visibly** inert while the question is up.
 *
 * The founder's ruling of 2026-08-30 made the rest of the window inert, and `main` enforces
 * it by dropping intents. **That guard was invisible**, and on 2026-09-03 the founder found
 * both halves of what that costs: *"the stop button does not work during this period of
 * time"*, and *"trying to change the film prompts to select a file, but after selecting the
 * file, nothing happens."*
 *
 * A control that looks pressable and silently does nothing is worse than a disabled one —
 * and the file picker was worse again, because it opened a Windows dialog, took a real
 * decision from the founder and threw it away. Inert has to be **stated**, in the same
 * `disabledReason` fields every other blocked control in this product already uses, and the
 * host channels have to refuse to open a dialog at all (`main.ts` now guards them too).
 */
const INERT_WHILE_ASKING = 'Answer the question above first';

function inertPick(pick: PickView): PickView {
  return { ...pick, disabledReason: INERT_WHILE_ASKING };
}

function inertDevices(devices: DevicePanelView): DevicePanelView {
  return {
    ...devices,
    rows: devices.rows.map((row) => ({ ...row, disabled: true })),
    disabledReason: INERT_WHILE_ASKING,
    canRescan: false,
  };
}

function inertSubtitles(subtitles: SubtitlesView | null): SubtitlesView | null {
  if (subtitles === null) return null;
  return {
    ...subtitles,
    canRetry: false,
    chooseDisabledReason: INERT_WHILE_ASKING,
    timing:
      subtitles.timing === null
        ? null
        : { ...subtitles.timing, canGoEarlier: false, canGoLater: false, canReset: false },
  };
}

function inertTransport(transport: TransportView | null): TransportView | null {
  if (transport === null) return null;
  return {
    ...transport,
    controlsDisabled: true,
    disabledReason: INERT_WHILE_ASKING,
    // Stop has its own field precisely because it is normally always available. While the
    // question is up it is not, and this is the sentence that says so instead of a dead press.
    stopDisabledReason: INERT_WHILE_ASKING,
    canDrag: false,
    dragDisabledReason: INERT_WHILE_ASKING,
    skips: transport.skips.map((skip) => ({ ...skip, disabledReason: INERT_WHILE_ASKING })),
  };
}

export function buildViewModel(
  snapshot: StateSnapshot,
  picker: PickerState,
  subtitlePicker: SubtitlePickerState = { available: false, busy: false, error: null },
  hostQuestion: HostQuestion | null = null,
): ViewModel {
  const name = deviceName(snapshot);
  const asking = hostQuestion !== null;
  const status = hostQuestion === null ? statusOf(snapshot) : statusOfQuestion(hostQuestion);
  const { preparation, notice } = snapshot;

  // The status region is the only place the app speaks, so a notice that isn't a failure
  // ("Living Room TV is now playing YouTube") is folded into it rather than getting a
  // banner of its own. It never displaces a message the state already had to say.
  const sub =
    hostQuestion !== null
      ? // A question outranks every notice. Folding "Living Room TV is now playing YouTube"
        // in underneath *"Closing stops the film you are watching"* would answer it wrongly.
        status.sub
      : (status.sub ?? (notice !== null && notice.severity !== 'error' ? notice.message : null));

  return {
    stateName: status.stateName,
    // A minimised app still reports itself in the taskbar, and a preparation is the one
    // thing in this product worth watching from there — it is the state the founder is most
    // likely to go and do something else during. **Once the film is on the television the
    // percentage goes**, for M3b cut 3's reason: a conversion that is feeding a film
    // somebody is already watching is machinery, not a wait, and a taskbar entry counting
    // it up is a live view of the encoder nobody asked for.
    documentTitle:
      preparation.active && snapshot.headStart === null
        ? `CastGood — Preparing ${String(Math.round(preparation.percent))}%`
        : 'CastGood',
    tone: status.tone,
    headline: status.headline,
    sub,
    hairline: status.hairline,
    actions: status.actions,
    file:
      snapshot.file === null
        ? null
        : {
            name: snapshot.file.name,
            durationLabel: hmsOrNull(snapshot.file.durationSec),
            subtitleNotice: snapshot.file.verdict?.subtitleNotice ?? null,
          },
    pick: asking ? inertPick(pickOf(snapshot, picker)) : pickOf(snapshot, picker),
    subtitles: asking
      ? inertSubtitles(subtitlesOf(snapshot, subtitlePicker))
      : subtitlesOf(snapshot, subtitlePicker),
    transport: asking ? inertTransport(transportOf(snapshot, name)) : transportOf(snapshot, name),
    devices: asking ? inertDevices(devicesOf(snapshot)) : devicesOf(snapshot),
    preparation: preparationOf(snapshot),
    questionPending: hostQuestion !== null,
    // ⚠️ Built unconditionally, with no reference to `snapshot` or `asking`. That is not an
    // oversight to tidy up later: the moment this depends on a state, it acquires a state in
    // which it is missing, and 25a exists because those are precisely the states it is for.
    diagnostics: {
      label: 'Save a report…',
      note: 'Names, your Windows username and network addresses are replaced before it is saved. CastGood never sends it anywhere — you choose who sees it.',
    },
  };
}

/**
 * The closing question, rendered as an ordinary state in the StatusRegion.
 *
 * **Tone is `info`, deliberately — not `needsYou`.** Nothing has failed: the founder
 * pressed a button and is being asked what they meant by it. The 2026-08-30 ruling
 * reserves the error treatment for genuine failures, and a question that colours itself
 * like a fault is the exact thing that ruling forbids.
 *
 * The words are the host's and are not rewritten here. `answers[0]` is always the safe
 * one and is the primary button, matching the index contract in `quit.ts` — the same
 * contract the old dialog's `defaultId: 0` and `cancelId: 0` encoded.
 */
function statusOfQuestion(question: HostQuestion): StatusView {
  const [safe, other] = question.answers;
  return {
    stateName: 'ClosingQuestion',
    tone: 'info',
    headline: question.headline,
    sub: question.detail,
    // No hairline: nothing is in progress. The app is waiting on a person, not on itself.
    hairline: false,
    actions: [
      { id: 'quitAnswerSafe', label: safe ?? 'Cancel', primary: true, disabledReason: null },
      { id: 'quitAnswerOther', label: other ?? 'Close', primary: false, disabledReason: null },
    ],
  };
}
