import type { PlaybackPosition, SessionFlags, SessionState } from '../types.js';
import type { PlayerState } from '../cast/index.js';
import { PREPARATION, TIMING } from '../config.js';
import type { NoticeKind } from '../protocol/snapshot.js';

/**
 * The session state machine: one enum, one reducer, exhaustive transitions.
 *
 * It is a pure function of (model, event) on purpose. The rules that decide whether
 * this product is trustworthy — *never show a state the device did not confirm*, and
 * *optimistic paint expires after 2 seconds and retries once* — are decided here, so
 * they are provable in milliseconds against a fake receiver instead of by watching a
 * television and hoping.
 *
 * State names mirror the PRD's state tables 1:1 so QA can map a screen to a state
 * without interpretation. Do not add a state here that has no row in the PRD.
 *
 * M1 scope: connect → load → play/pause/stop, plus the two failure exits the PRD names
 * (couldn't reach the device, couldn't play this file).
 *
 * M2 adds, here: seeking by drag and by ±30 s tap (6a–6k), loading at a position so
 * *Resume from 0:32:10* works (16b/16c), and the two problems that are stated rather than
 * thrown — the source file vanishing (15a/15b) and a device that accepted the video but
 * never came back for the bytes (17a).
 *
 * M2's reliability third adds **recovery**, and it is one mechanism serving four criteria.
 * A session that is interrupted — by a dead socket (11a/11f), by an orderly close from the
 * device (14a), by a buffer that never resolved (11e), or by this PC dropping off the
 * network (11d) — enters `recovery` with the flag the founder can see and **nothing else
 * about the screen changing**: same file, same position, same scrubber. The supervisor then
 * reconnects and asks the television what is actually running, and exactly one of four
 * things is true:
 *
 *  - our app, still playing → carry on, and the founder saw a status line change (11a);
 *  - a **different** app → yield, state it as a fact, offer *Take it back* (14a–14c);
 *  - nothing, and the close was orderly → the founder stopped it on the TV: *Stopped*;
 *  - nothing, and we lost it → after ~30 s, *Lost connection* with the place saved (11c).
 *
 * **The third and fourth cannot be told apart quickly, and that is a hardware fact, not an
 * oversight.** SPIKE-2 measured a takeover sending `CLOSE` first and naming the other app
 * 4.3–11.3 s later; for that whole window it is byte-identical to a stop from the TV's own
 * remote. `TIMING.takeoverGraceMs` is how long we wait rather than guess — see its comment.
 *
 * Frontier events remain M3.
 */

export type SessionEvent =
  | {
      readonly type: 'intent.cast';
      readonly deviceId: string;
      /** Non-zero only for *Resume from \<position\>* (16c). A fresh cast starts at 0. */
      readonly startPositionSec: number;
    }
  | { readonly type: 'intent.play'; readonly monoMs: number }
  | { readonly type: 'intent.pause'; readonly monoMs: number }
  | {
      readonly type: 'intent.stop';
      /**
       * The position on screen when Stop was pressed.
       *
       * Same reason as `intent.skip`'s `fromSec`: the model holds the device's last
       * *report*, which is up to a poll behind the readout. The device's own final word
       * corrects this a moment later through `device.idle` — this is what the founder sees
       * in the meantime, and it is right rather than up to a second stale.
       */
      readonly atSec: number;
    }
  /** Drag released. One destination, emitted once — never during the drag (6b). */
  | { readonly type: 'intent.seek'; readonly positionSec: number; readonly monoMs: number }
  /** One press of Back 30s / Forward 30s. Taps accumulate; the wire sees one jump (6g). */
  | {
      readonly type: 'intent.skip';
      readonly deltaSec: number;
      /**
       * The position on screen at the moment of the tap.
       *
       * Supplied rather than derived because "30 seconds forward" means 30 seconds from
       * what the founder is looking at, and the model only holds the device's last
       * *report* — up to a second behind the smoothly extrapolated readout. Measuring from
       * the report made a 30-second tap land 29.8 seconds on, which is a criterion that
       * says "exactly 30" failing for a reason nobody could see.
       */
      readonly fromSec: number;
      readonly monoMs: number;
    }
  /** The coalescing window closed: whatever the target is now, send it. */
  | { readonly type: 'timer.seek_settled'; readonly monoMs: number }
  | {
      /** The source file is no longer where it was (15a/15b). */
      readonly type: 'source.missing';
      /**
       * How we found out, which is the whole of the difference between 15a and 15b.
       *
       * `checked` — we looked, after playback ended, and it was gone. Playback was never
       * affected, so nothing was said at the time and nothing needs stopping now.
       *
       * `fetch-failed` — **the device came back for bytes and got a 404**. That is 15b's
       * "playback is affected", and it is the moment to end the session ourselves. Waiting
       * for the television to volunteer an IDLE leaves the founder on *Buffering…* for as
       * long as that device feels like it — possibly forever.
       */
      readonly reason: 'checked' | 'fetch-failed';
      /**
       * The position on screen, for the same reason `intent.stop` carries one: the model
       * holds the device's last *report*, which after a fresh load is still 0. Saving that
       * would hand the founder a 0:00:00 for a film they had been watching for ten minutes.
       */
      readonly atSec: number;
    }
  /** A *different* file was chosen, so the remembered position belongs to nothing. */
  | { readonly type: 'file.changed' }
  /**
   * The **same** film was chosen again from a new folder — *Find it again* (15b).
   *
   * Deliberately not `file.changed`: the problem is over, but the founder's place is not
   * void. It was the same film all along; only its address changed.
   */
  | { readonly type: 'file.relocated' }
  /** The device accepted the video and never asked this PC for a byte of it (17a). */
  | { readonly type: 'media.not_fetched' }
  | { readonly type: 'device.connected' }
  /**
   * The television's own receiver application is up and addressable.
   *
   * Split from `device.connected` on 2026-08-18. A TCP+TLS handshake takes ~0.2 s; waking
   * the receiver takes 6–14 s and is the exchange that is retried. Moving to *Starting on
   * \<name\>…* on the handshake put "The TV has been reached — the video is on its way"
   * on screen while we were still waiting for the television to wake, and then contradicted
   * it with "Couldn't reach \<name\>". Everything up to here is one continuous *Connecting
   * to \<name\>…* (3b), retries included.
   */
  | { readonly type: 'device.launched' }
  | {
      readonly type: 'device.connect_failed';
      readonly reason: string;
      readonly userMessage: string;
    }
  | { readonly type: 'device.loaded' }
  | {
      readonly type: 'device.disconnected';
      readonly reason: string;
      readonly userMessage: string;
      readonly monoMs: number;
    }
  /** The device closed the session in an orderly way — stopped from the TV, or taken over. */
  | {
      readonly type: 'device.ended_session';
      readonly reason: string;
      readonly monoMs: number;
      /**
       * The position on screen at the close, which is the one shown on *Stopped* — and the
       * one that has to survive a correction to "somebody took the television".
       */
      readonly atSec: number;
    }
  | {
      readonly type: 'device.status';
      readonly playerState: PlayerState;
      readonly position: PlaybackPosition;
      /**
       * When this status **arrived**, which is not `position.reportedAtMono`.
       *
       * That one is the last *anchor* time, and a status carrying no `currentTime` does
       * not re-anchor — so against a device that reports no position it can be arbitrarily
       * far in the past. 11e's stopwatch was seeded from it, which started the ten-second
       * patience in the past and tore down a healthy connection during an ordinary
       * rebuffer. Arrival time is the only honest answer to "how long has this been
       * buffering?".
       */
      readonly monoMs: number;
      /**
       * True when a seek is in flight and this report still describes where the film *was*.
       * The reducer must not adopt it: PRD 6e forbids the readout snapping back to the old
       * position while we are still waiting for the jump we asked for.
       */
      readonly seekHeld: boolean;
    }
  | {
      readonly type: 'device.idle';
      readonly idleReason: string | null;
      /** The device's own final position, when it reported one. Null when it did not. */
      readonly positionSec: number | null;
    }
  | { readonly type: 'device.load_rejected'; readonly detail: string }
  /**
   * **We are handing a playing television the film again** — a repair (D2) or a subtitle
   * reload (19b/20b). Raised synchronously *before* the LOAD goes on the wire, exactly as
   * `intent.stop` moves the model before the device's reply can arrive, so the `IDLE` the
   * receiver sends for the media session it is superseding cannot be read as the film
   * stopping. See `LiveLoadModel`.
   */
  | {
      readonly type: 'session.live_load_started';
      readonly why: 'repair' | 'subtitle';
      readonly monoMs: number;
    }
  /**
   * That LOAD is over — loaded, refused or thrown, all three the same here. Raised from a
   * `finally`, so the window this closes cannot be left open by a failure.
   */
  | { readonly type: 'session.live_load_settled' }
  /**
   * How far the conversion feeding this session has got, or `null` for an ordinary file.
   *
   * Only 10d turns on it: a jump into video that does not exist yet is refused here rather
   * than sent and hoped for. The *live* guard that pauses a film approaching the frontier
   * lives in the engine, because it needs the conversion's speed as well as its position.
   */
  | { readonly type: 'frontier.changed'; readonly frontierSec: number | null }
  /**
   * The engine has turned a refused load into a plan (7e). Clears the error and nothing else.
   *
   * *"The founder sees preparation start, **not an error**"* is the whole of criterion 7e,
   * and without this the app would say both things at once: *Needs converting — about 25
   * minutes* over the top of *Couldn't play this file*. It is deliberately **not**
   * `file.changed`, which also wipes the resume position — the film has not changed, only
   * what we now know about the television.
   */
  | { readonly type: 'file.replanned' }
  /**
   * A second process — or this one after being reopened — found the session still running
   * on the device and adopted it (12a). The device's own status arrives right behind this.
   */
  | { readonly type: 'session.reattaching'; readonly deviceId: string }
  | { readonly type: 'session.reattached'; readonly playerState: PlayerState }
  /** Nothing of ours was on that television after all. Silent, straight to Idle (12b). */
  | { readonly type: 'session.reattach_failed'; readonly reason: string }
  /** The supervisor is about to try the connection again. Only bumps the attempt count. */
  | { readonly type: 'recovery.attempt'; readonly monoMs: number }
  /** A new connection found our session still running and adopted it (11a, 11f). */
  | {
      readonly type: 'recovery.rejoined';
      readonly monoMs: number;
      /**
       * What the television says it is doing.
       *
       * Only load-bearing for one case, and it is the one the founder's ruling of
       * 2026-08-18 created: an orderly close already put *Stopped* on screen, and the
       * probe has just found our own receiver still playing our own film. The close was a
       * hiccup, so the screen has to come back — and this is what it comes back *to*.
       */
      readonly playerState: PlayerState;
    }
  /** Something else is on the television now. We yield; we never fight for it (14a). */
  | {
      readonly type: 'recovery.yielded';
      readonly appId: string;
      /** "YouTube", "Prime Video". Null when the device named an id and nothing else. */
      readonly appName: string | null;
      readonly atSec: number;
    }
  /** The wait is over and the television is not ours. What that means depends on `cause`. */
  | { readonly type: 'recovery.gave_up'; readonly atSec: number }
  /**
   * This PC's own network came or went (11d).
   *
   * Distinct from a dead socket on purpose: they look identical from the socket and need
   * opposite screens. There is nothing to reconnect *over* while the adapter is down, so
   * the give-up clock is suspended for as long as it is.
   */
  | { readonly type: 'network.changed'; readonly online: boolean; readonly monoMs: number }
  | { readonly type: 'timer.tick'; readonly monoMs: number };

export interface PendingCommand {
  readonly command: 'play' | 'pause';
  /** The state the device must reach for the optimistic paint to have been right. */
  readonly expected: Extract<SessionState, 'playing' | 'paused'>;
  readonly retried: boolean;
}

export interface SessionErrorModel {
  readonly userMessage: string;
  readonly actionLabel: string | null;
  /** Decides which way out the screen offers. See `NoticeKind`. */
  readonly kind: NoticeKind;
}

/**
 * A position change the founder has asked for, on its way to the device.
 *
 * It has two lives. Before `issuedAtMono` it is a *target being accumulated* — taps are
 * still arriving and nothing has gone on the wire. After it, it is a *command awaiting
 * confirmation*, and the display holds the requested position until the device agrees or
 * we give up on it.
 */
/**
 * Where a jump was shortened to, when it was.
 *
 * `frontier` is M3b's: the founder dragged into film that has not been converted yet, and
 * the app says how far ahead it can go rather than refusing with an error (10d). It is not
 * a failure and it is not the end of the film.
 */
export type SeekClamp = 'start' | 'end' | 'frontier' | null;

export interface PendingSeek {
  /** Already clamped to the file. This is the number the readout shows. */
  readonly targetSec: number;
  /** Running total of the taps not yet sent, for the `+1:30` readout. `null` for a drag. */
  readonly deltaSec: number | null;
  /** Which end of the film the jump ran into, so the app can state what really happened. */
  readonly clamped: SeekClamp;
  /** A drag shows *Seeking…*; a tap must not — 6h forbids the status line flipping per tap. */
  readonly source: 'drag' | 'skip';
  /** Null while taps are still accumulating; set when SEEK goes on the wire. */
  readonly issuedAtMono: number | null;
  readonly retried: boolean;
}

/**
 * An interruption being worked on, and the whole of what the give-up looks like.
 *
 * `cause` is the only thing that distinguishes the two endings, and it has to be recorded
 * at the moment the interruption arrives: half a minute later, "the founder stopped it on
 * the TV" and "we lost the connection" are indistinguishable from the model alone, and
 * they are the difference between a silent *Stopped* and "Lost connection to \<name\>".
 */
export interface RecoveryModel {
  /**
   * `orderly` — the device closed the virtual connection: a stop from the TV's own
   * controls, or a takeover. Waits `takeoverGraceMs` and then calls it a stop.
   *
   * `lost` — the socket died, or the heartbeat ran out of patience. Waits
   * `reconnectBudgetMs` and then says so (11c).
   *
   * `stalled` — *Buffering* that never resolved (11e). Treated as a lost connection,
   * because that is what an indefinite buffer nearly always is.
   */
  readonly cause: 'orderly' | 'lost' | 'stalled';
  readonly startedAtMono: number;
  readonly attempts: number;
}

/**
 * **One of our own LOADs is in flight on a session that is already playing.**
 *
 * A television takes a new LOAD by ending the media session it is holding and saying so:
 * `IDLE` with `idleReason: "INTERRUPTED"`, addressed to the media session we have just
 * superseded. It is not the film stopping — it is the receiver acknowledging that the film
 * we asked it to play is no longer the one it was playing.
 *
 * **Why this has to exist in the model at all.** `endOfSessionLog` documents an invariant:
 * a stop the app itself asked for never reaches `session.refused_mid_play`, *by
 * construction* — `intent.stop` moves the model to `stopped` synchronously, so the device's
 * own reply lands in the `!ACTIVE_STATES` branch and returns. Defect D2's repair broke it:
 * the repair issues a LOAD while the model is still `playing`, so the superseded session's
 * `IDLE` arrived at a model with nothing to distinguish it from a television abandoning the
 * film. On the founder's set, **101 ms** after the repair LOAD, that produced
 * `playing → stopped`, a `session.refused_mid_play`, and — because 13g's guard believed it —
 * a selftest verdict of 0/18 on a run where the film really was playing again a second
 * later.
 *
 * So the LOAD is made **as self-evident to the reducer as `intent.stop` is**: it is recorded
 * on the way out and cleared when it settles, and while it is set a non-`FINISHED` `IDLE` is
 * a report about media we have already replaced. This is the same ruling as
 * `session.idle_ignored_while_loading` — *"ending the session here showed the founder
 * 'Stopped' a fraction of a second after a load that was going perfectly well"* — extended
 * from the first LOAD of a session to the ones issued underneath a playing film.
 *
 * **Deliberately not keyed off `idleReason === 'INTERRUPTED'`.** That would be wrong in both
 * directions, for the reason the same comment already gives: a reason is what the device
 * chose to say, and our own stops report `CANCELLED`, as does another sender taking the
 * television. What is knowable for certain is whether *we* have just replaced the media.
 */
export interface LiveLoadModel {
  /**
   * Why the film is being handed over again. Logged, never branched on — the two are
   * treated identically, and a third would be too.
   *
   * `repair` — defect D2: the television's byte connection died and it never came back.
   * `subtitle` — a track chosen mid-film, or an offset past the ladder (19b/20b).
   */
  readonly why: 'repair' | 'subtitle';
  readonly sinceMono: number;
}

export interface SessionModel {
  readonly state: SessionState;
  readonly flags: SessionFlags;
  readonly deviceId: string | null;
  readonly position: PlaybackPosition | null;
  /**
   * Seconds of film that exist so far, when this session is being fed by a live conversion.
   *
   * `null` — the ordinary case — means the whole film is there and nothing is clamped.
   */
  readonly frontierSec: number | null;
  /** Set when we paint optimistically; if the device has not confirmed by then, we revert. */
  readonly optimisticUntilMono: number | null;
  /** The remembered place to resume from. Never lost, never reset to 0 by a failure. */
  readonly resumePositionSec: number;
  /** Where this session was asked to *start*. Non-zero only for a Resume (16c). */
  readonly startPositionSec: number;
  /** The last state the *device* reported. The display may lead it, never contradict it. */
  readonly confirmedState: SessionState;
  readonly pending: PendingCommand | null;
  readonly seek: PendingSeek | null;
  /**
   * The source file has gone. Held silently while a film is playing perfectly well (15a)
   * and only spoken once the session is over.
   */
  readonly sourceMissing: boolean;
  /** Non-null while an interruption is being worked on. See `RecoveryModel`. */
  readonly recovery: RecoveryModel | null;
  /**
   * **When the trouble started — the clock 11c's thirty seconds is actually measured on.**
   *
   * `recovery.startedAtMono` is per *attempt*, and defect D2 is what happens when the
   * deadline hangs off it: a film starving on a dead byte connection rejoined its control
   * channel in 243 ms, went straight back to buffering, and started another recovery — 76
   * of them in twenty seconds, each logging a fresh `deadlineMs: 30000`. The deadline
   * never expired, so *"Lost connection to \<name\>"* never appeared and the founder was
   * left with a spinner until they pressed stop.
   *
   * So a **run** of failing recoveries shares one deadline, measured from the first of
   * them. Set by the first `beginRecovery` and kept across every one after it. Cleared by
   * one thing only: the television actually playing (or paused) again with nothing left to
   * recover — see `device.status`. A rejoin that lands back in *Buffering* is another lap
   * of the same failure, not a recovery, and it must not buy another thirty seconds.
   */
  readonly troubleSinceMono: number | null;
  /**
   * True once the device has actually reported PLAYING in this session.
   *
   * 11e turns a stuck *Buffering* into a recovery attempt, and this is what stops it
   * firing on a cast that never produced a picture — that belongs to the firewall
   * diagnosis (17a) and to "couldn't play this file" (3c), which say something useful.
   */
  readonly everPlayed: boolean;
  /** When the device last entered BUFFERING, for 11e's 10-second patience. */
  readonly bufferingSinceMono: number | null;
  /**
   * **A LOAD of ours is in flight on a session that is already playing** — see
   * `LiveLoadModel`, and it is the reason `endOfSessionLog`'s invariant survives D2.
   */
  readonly liveLoad: LiveLoadModel | null;
  /** The app that has the television, named, for 14a's statement of fact. */
  readonly yieldedTo: string | null;
  /** When this PC went offline, for 11d's "after 30 s — and not before" button. */
  readonly offlineSinceMono: number | null;
  /** 11d: the founder has been offline long enough to be offered Windows' own settings. */
  readonly offlineHelp: boolean;
  readonly error: SessionErrorModel | null;
}

/** Side effects the supervisor should perform. The reducer itself does no I/O. */
export type SessionEffect =
  | { readonly type: 'connect'; readonly deviceId: string }
  | { readonly type: 'load'; readonly startPositionSec: number }
  | { readonly type: 'send.play' }
  | { readonly type: 'send.pause' }
  | { readonly type: 'send.stop' }
  | { readonly type: 'send.seek'; readonly positionSec: number }
  /** Put the readout on the requested position now, before anything reaches the device. */
  | { readonly type: 'seek.hold'; readonly positionSec: number }
  /**
   * Stop holding: believe the device again, whatever it says.
   *
   * `restore` additionally puts the readout back where the film really is. Set it when the
   * jump was abandoned — never sent, or given up on — because the film never went there.
   * Left off at a session boundary, where the position is being saved explicitly and the
   * tracker is about to be frozen or reset anyway.
   */
  | { readonly type: 'seek.release_hold'; readonly restore: boolean }
  /** (Re)arm the coalescing window. Replaces any window already running. */
  | { readonly type: 'seek.schedule'; readonly delayMs: number }
  /**
   * Stop the readout where it is, without ending anything else.
   *
   * `release` does this on its way out, and during an ordinary reconnection the clock is
   * deliberately left running because the film really is still playing. An orderly close
   * is the third case: the film has stopped, the screen says *Stopped*, and the connection
   * is kept alive only so a late takeover can still be heard. A running clock there would
   * creep the saved position upwards for a film nobody is watching.
   */
  | { readonly type: 'position.freeze' }
  /** Close the connection, unmount the file, release the TV. */
  | { readonly type: 'release' }
  /**
   * Start reconnecting and asking the television what is running.
   *
   * Deliberately **not** "reload at the remembered position": SPIKE-2 confirmed a
   * Chromecast keeps playing when our socket dies and a new connection rejoins the same
   * media session in 126 ms with a position error of 0.003 s. Re-loading would rewind the
   * film by the length of the outage and cost the founder a receiver boot for nothing.
   */
  | { readonly type: 'recover' }
  /** Stop trying. The reducer has decided; the supervisor tidies up. */
  | { readonly type: 'recover.cancel' }
  | { readonly type: 'log'; readonly event: string; readonly fields?: Record<string, unknown> };

export interface SessionTransition {
  readonly model: SessionModel;
  readonly effects: readonly SessionEffect[];
}

const NO_FLAGS: SessionFlags = {
  reconnecting: false,
  reattaching: false,
  yielded: false,
  networkDown: false,
};

export const INITIAL_SESSION: SessionModel = {
  state: 'idle',
  flags: NO_FLAGS,
  deviceId: null,
  position: null,
  frontierSec: null,
  optimisticUntilMono: null,
  resumePositionSec: 0,
  startPositionSec: 0,
  confirmedState: 'idle',
  pending: null,
  seek: null,
  sourceMissing: false,
  recovery: null,
  troubleSinceMono: null,
  everPlayed: false,
  bufferingSinceMono: null,
  liveLoad: null,
  yieldedTo: null,
  offlineSinceMono: null,
  offlineHelp: false,
  error: null,
};

const ACTIVE_STATES: readonly SessionState[] = ['buffering', 'playing', 'paused', 'seeking'];

/**
 * States in which a position change makes sense at all.
 *
 * `buffering` is in the list on purpose (6k): jumping away is the best escape from a bad
 * buffer, so the skip controls stay live there even though dragging does not.
 */
const SEEKABLE_STATES: readonly SessionState[] = ['playing', 'paused', 'buffering', 'seeking'];

/**
 * Where the playhead is, as far as the founder is concerned.
 *
 * A pending seek target wins over the device's last report: it is what is on screen, what
 * the next jump is measured from, and what a Stop in the middle of a seek should save.
 * Saving the position the film had already left would lose the jump they just made.
 */
function positionSec(model: SessionModel): number {
  return model.seek?.targetSec ?? model.position?.reportedSec ?? model.resumePositionSec;
}

function durationSec(model: SessionModel): number {
  return model.position?.durationSec ?? 0;
}

/**
 * The furthest a jump may land: the end of the film, or — while a conversion is still
 * running — the frontier less the two-minute margin the guard defends (10d).
 *
 * Refusing at the frontier itself would let the founder land exactly where the guard is
 * about to hold the picture, which is a jump into a frozen frame: correct, and useless.
 */
function seekCeilingSec(model: SessionModel): number | null {
  const duration = durationSec(model);
  const limits: number[] = [];
  if (duration > 0) limits.push(duration);
  if (model.frontierSec !== null) {
    limits.push(Math.max(0, model.frontierSec - PREPARATION.frontierMarginSeconds));
  }
  return limits.length === 0 ? null : Math.min(...limits);
}

/**
 * Why a jump may not be made right now.
 *
 * 6j: with no working connection a skip is **refused, never queued** — a jump we cannot
 * send is never promised, and one that arrives silently five seconds later is worse than
 * one that was declined.
 */
function seekRefusal(model: SessionModel): string | null {
  if (model.flags.networkDown) return 'this PC is offline';
  if (model.flags.reconnecting) return 'the connection is being re-established';
  if (model.flags.reattaching) return 'the session is being picked up again';
  if (model.flags.yielded) return 'another app has the device';
  if (!SEEKABLE_STATES.includes(model.state)) return `nothing is playing (${model.state})`;
  if (model.position === null) return 'the device has not reported a position yet';
  return null;
}

/**
 * Sets the destination and starts (or restarts) the coalescing window.
 *
 * Both a drag release and a tap land here, and that is the point: PRD 6d ("five seeks in
 * rapid succession issue only the final position") and 6g ("four taps are one command")
 * are the same requirement, so they get the same mechanism rather than two rules that can
 * disagree. The readout moves to the destination immediately via `seek.hold`; only the
 * wire message waits.
 */
function aimAt(
  model: SessionModel,
  requestedSec: number,
  deltaSec: number | null,
  source: 'drag' | 'skip',
): SessionTransition {
  const duration = durationSec(model);
  const ceiling = seekCeilingSec(model);
  const clampedSec = Math.max(0, ceiling === null ? requestedSec : Math.min(requestedSec, ceiling));
  // Three ways a jump can be shortened, and the founder is owed a different sentence for
  // each: the start of the film, the end of it, and *the end of what has been prepared* —
  // which is 10d's "one line saying how far ahead it can go" and is not an error.
  const clamped: SeekClamp =
    requestedSec < 0
      ? 'start'
      : duration > 0 && requestedSec > duration
        ? 'end'
        : ceiling !== null && requestedSec > ceiling
          ? 'frontier'
          : null;

  return {
    model: {
      ...model,
      seek: {
        targetSec: clampedSec,
        deltaSec,
        clamped,
        source,
        // A tap arriving while a seek is already in flight starts a *fresh* target and
        // restarts the window rather than queueing a second command (6h).
        issuedAtMono: null,
        retried: false,
      },
      // A jump cancels an outstanding play/pause paint: the position is what is moving now.
      optimisticUntilMono: null,
      pending: null,
      error: null,
    },
    effects: [
      { type: 'seek.hold', positionSec: clampedSec },
      { type: 'seek.schedule', delayMs: TIMING.seekSettleMs },
      {
        type: 'log',
        event: 'session.seek_requested',
        fields: {
          source,
          requestedSec: Math.round(requestedSec * 1000) / 1000,
          targetSec: Math.round(clampedSec * 1000) / 1000,
          deltaSec,
          clamped,
        },
      },
    ],
  };
}

/**
 * How long this interruption gets before we stop waiting and say something.
 *
 * An orderly close is a race against a television booting somebody else's app — measured
 * at 4.3 s and 11.3 s — so it is short and it is about *identification*. A lost socket is a
 * race against the wifi coming back, so it is the PRD's 30 s.
 */
function recoveryDeadlineMs(cause: RecoveryModel['cause']): number {
  return cause === 'orderly' ? TIMING.takeoverGraceMs : TIMING.reconnectBudgetMs;
}

/**
 * Enter recovery: change the status line, change nothing else.
 *
 * A jump that was still inside its coalescing window is dropped and the readout put back —
 * 6j says a jump we cannot send is refused, never queued, and one that arrives silently
 * after the connection returns is worse than one that was declined. A jump already on the
 * wire keeps its target: we asked for it, and the reconnect will tell us the truth.
 */
function beginRecovery(
  model: SessionModel,
  cause: RecoveryModel['cause'],
  monoMs: number,
  reason: string,
): SessionTransition {
  const unsent = model.seek !== null && model.seek.issuedAtMono === null;
  // **The deadline belongs to the run, not to the attempt** (D2, fault 2). An orderly
  // close is the exception and keeps its own clock: it is a race against a television
  // booting somebody else's app, not against a network coming back, and it must not
  // inherit a mark left by an unrelated blip minutes earlier.
  const troubleSinceMono = cause === 'orderly' ? monoMs : (model.troubleSinceMono ?? monoMs);
  const deadlineMs = recoveryDeadlineMs(cause);
  return {
    model: {
      ...model,
      flags: { ...model.flags, reconnecting: true },
      recovery: { cause, startedAtMono: monoMs, attempts: 0 },
      troubleSinceMono,
      // 11e's stopwatch belongs to the buffer this recovery is about to interrupt, and a
      // rejoin that lands back in *Buffering* must start it again rather than inherit a
      // reading that is already past the ten seconds. Leaving it was the other half of
      // D2's thrash: ~2.5 rejoin-then-drop cycles a second, for a minute.
      bufferingSinceMono: null,
      optimisticUntilMono: null,
      pending: null,
      seek: null,
      error: null,
    },
    effects: [
      { type: 'seek.release_hold', restore: unsent },
      { type: 'recover' },
      {
        type: 'log',
        event: 'session.recovery_started',
        fields: {
          cause,
          reason,
          from: model.state,
          deadlineMs,
          // How much of that deadline is actually left. On the first failure of a run
          // these two agree; on the seventy-sixth they must not, and a log that says
          // `deadlineMs: 30000` every time is how D2 hid in plain sight.
          deadlineInMs: Math.max(0, Math.round(troubleSinceMono + deadlineMs - monoMs)),
          troubleForMs: Math.round(monoMs - troubleSinceMono),
        },
      },
    ],
  };
}

function fromPlayerState(playerState: PlayerState): SessionState | null {
  switch (playerState) {
    case 'PLAYING':
      return 'playing';
    case 'PAUSED':
      return 'paused';
    case 'BUFFERING':
      return 'buffering';
    case 'IDLE':
      return null; // Handled by `device.idle`, which carries the reason.
  }
}

/**
 * The one problem that waits its turn.
 *
 * The source file has gone, and the session is over, so now it can be said. While a film
 * was still playing perfectly well this was held in silence (15a) — interrupting a working
 * evening to report a problem that is not biting is exactly the noise this app exists to
 * remove.
 */
function sourceMissingError(model: SessionModel): SessionErrorModel | null {
  if (!model.sourceMissing) return null;
  return {
    userMessage: 'The original file is no longer where it was',
    actionLabel: 'Find it again',
    kind: 'source-missing',
  };
}

/**
 * The single line a session's last `IDLE` writes — and **criterion 13g is the rule that
 * there have to be two of them.**
 *
 * Until 2026-08-24 every ending logged `session.reached_end`, whatever the device gave as
 * its reason. That is a defensible-sounding shorthand ("the session is over either way")
 * and it produced a **false fact in a live decision**: a 113-minute film cast to the
 * Chromecast Ultra reached `PLAYING` at position 0, went `IDLE` with `idleReason: ERROR`
 * **81 ms** later, and the run that watched it happen printed `session.reached_end` and a
 * verdict with nine passing assertions in it. That verdict was written into the PRD as a
 * measurement of a television playing 5.1 audio. It had measured a corpse.
 *
 * So: **an ending and a refusal are different facts and get different lines.**
 *
 *  - `session.reached_end` — the file played out. `idleReason: FINISHED`, and nothing else,
 *    ever. Anything downstream may treat this as "the film was watched".
 *  - `session.refused_mid_play` — the device stopped a film we believed was running, and
 *    told us a reason that is not "it ended". It carries **the last position we knew** and
 *    **the reason**, because those two facts together are the difference between a
 *    television that quit at 0.2 s of a 40-minute film and one that quit at 39 minutes.
 *    `believedState` records what we thought was happening, which is the "while CastGood
 *    believes a film is playing" half of the criterion, observable rather than inferred.
 *
 * **A deliberate stop never reaches here**, and that is by construction rather than by a
 * test on the reason. `intent.stop` moves the model to `stopped` synchronously, so the
 * device's own `IDLE`/`CANCELLED` reply lands in the `!ACTIVE_STATES` branch above and
 * returns before this function is called. Keying off `idleReason` instead would be wrong in
 * both directions: our own stops report `CANCELLED`, and so does another sender taking the
 * television away from us.
 *
 * **Nothing here narrows a capability.** A refusal *after* a successful load is not the
 * same evidence as a refused load, and ADR 2026-08-19 is emphatic that a load failure on an
 * HLS stream can just as easily be our own media server — so `onLoadRejected`, which is
 * where 7e's ladder hangs, is deliberately not reached from this path. See the note on
 * `SessionDeps.onLoadRejected`.
 */
function endOfSessionLog(
  finished: boolean,
  idleReason: string | null,
  positionSec: number,
  model: SessionModel,
): SessionEffect {
  if (finished) {
    return { type: 'log', event: 'session.reached_end', fields: { idleReason } };
  }
  return {
    type: 'log',
    event: 'session.refused_mid_play',
    fields: {
      idleReason,
      positionSec: Math.round(positionSec * 1000) / 1000,
      durationSec: model.position?.durationSec ?? null,
      believedState: model.state,
    },
  };
}

export function reduce(model: SessionModel, event: SessionEvent): SessionTransition {
  switch (event.type) {
    case 'intent.cast': {
      // Casting from anywhere is allowed: it always starts a fresh session. Whatever was
      // playing is released by the supervisor before the new connection is made.
      return {
        model: {
          ...INITIAL_SESSION,
          state: 'connecting',
          deviceId: event.deviceId,
          startPositionSec: event.startPositionSec,
          // A Resume must survive its own connection: if the cast fails, the founder is
          // still owed the place they were resuming from.
          resumePositionSec: event.startPositionSec,
          // Whether the file is still there is a question for the new session, not an
          // answer inherited from the last one.
          sourceMissing: false,
        },
        effects: [
          { type: 'seek.release_hold', restore: false },
          // *Take it back* (14c) and *Reconnect* (11c) both arrive here. Whatever recovery
          // was in flight is over: the founder has decided, and a background loop still
          // probing the old connection would fight the new one for the same television.
          { type: 'recover.cancel' },
          { type: 'connect', deviceId: event.deviceId },
          ...(event.startPositionSec > 0
            ? [
                {
                  type: 'log' as const,
                  event: 'session.resuming',
                  fields: { startPositionSec: Math.round(event.startPositionSec * 1000) / 1000 },
                },
              ]
            : []),
        ],
      };
    }

    case 'device.connected': {
      if (model.state !== 'connecting') return { model, effects: [] };
      // **Deliberately still `connecting`.** The socket is up; the television is not. The
      // `load` effect wakes the receiver first (retrying silently, PRD 3b) and only then
      // loads, and `device.launched` below is what moves the screen on.
      return {
        // 16c: the film loads *already at* the remembered position. It never plays from
        // 0:00 first and is never seeked there afterwards — the position rides on the LOAD.
        model,
        effects: [{ type: 'load', startPositionSec: model.startPositionSec }],
      };
    }

    case 'device.launched': {
      if (model.state !== 'connecting') return { model, effects: [] };
      return { model: { ...model, state: 'loading' }, effects: [] };
    }

    case 'intent.seek': {
      const refusal = seekRefusal(model);
      if (refusal !== null) {
        return {
          model,
          effects: [
            { type: 'log', event: 'session.seek_refused', fields: { source: 'drag', refusal } },
          ],
        };
      }
      return aimAt(model, event.positionSec, null, 'drag');
    }

    case 'intent.skip': {
      const refusal = seekRefusal(model);
      if (refusal !== null) {
        return {
          model,
          effects: [
            {
              type: 'log',
              event: 'session.seek_refused',
              fields: { source: 'skip', deltaSec: event.deltaSec, refusal },
            },
          ],
        };
      }
      // Taps accumulate against the destination, not against where the film currently is:
      // four taps are one two-minute jump (6g), and the second tap must count from the
      // first tap's target or the total is wrong.
      const base = model.seek?.targetSec ?? event.fromSec;
      const total = (model.seek?.deltaSec ?? 0) + event.deltaSec;
      return aimAt(model, base + event.deltaSec, total, 'skip');
    }

    case 'timer.seek_settled': {
      const seek = model.seek;
      // Already sent, or cancelled by whatever else happened in the meantime.
      if (seek === null || seek.issuedAtMono !== null) return { model, effects: [] };
      return {
        model: {
          ...model,
          // A drag says *Seeking…*; a tap deliberately does not (6h). Buffering keeps its
          // own name: it is already the more informative of the two.
          state: seek.source === 'drag' && model.state !== 'buffering' ? 'seeking' : model.state,
          seek: { ...seek, issuedAtMono: event.monoMs, deltaSec: null },
        },
        effects: [
          { type: 'send.seek', positionSec: seek.targetSec },
          {
            type: 'log',
            event: 'session.seek_issued',
            fields: {
              source: seek.source,
              targetSec: Math.round(seek.targetSec * 1000) / 1000,
              clamped: seek.clamped,
            },
          },
        ],
      };
    }

    case 'source.missing': {
      const marked: SessionModel = { ...model, sourceMissing: true };
      const live = ACTIVE_STATES.includes(model.state) || model.state === 'loading';

      // 15b: the device asked this PC for bytes and there were none. Playback is affected,
      // so the session ends here, now, with the position kept and the same plain sentence —
      // rather than sitting on *Buffering…* until a television decides to give up.
      if (event.reason === 'fetch-failed' && live) {
        return {
          model: {
            ...marked,
            state: 'stopped',
            confirmedState: 'stopped',
            optimisticUntilMono: null,
            pending: null,
            seek: null,
            resumePositionSec: Math.max(event.atSec, 0),
            error: sourceMissingError(marked),
          },
          effects: [
            { type: 'seek.release_hold', restore: false },
            { type: 'send.stop' },
            { type: 'release' },
            {
              type: 'log',
              event: 'session.source_missing',
              fields: { reason: event.reason, state: model.state, stoppedPlayback: true },
            },
          ],
        };
      }

      if (model.sourceMissing) return { model, effects: [] };
      // 15a: recorded, not announced. Nothing about the screen changes while a film is
      // playing perfectly well out of the device's own buffer; the sentence arrives when
      // the session ends, from `sourceMissingError`.
      return {
        model: {
          ...marked,
          error: live ? model.error : sourceMissingError(marked),
        },
        effects: [
          {
            type: 'log',
            event: 'session.source_missing',
            fields: { reason: event.reason, state: model.state, stoppedPlayback: false },
          },
        ],
      };
    }

    case 'file.relocated': {
      // Same rule as `file.changed` about a live session: a cast in flight owns the screen.
      if (ACTIVE_STATES.includes(model.state) || model.state === 'loading') {
        return { model, effects: [] };
      }
      // Nothing was missing, so nothing is being found: re-choosing the same file in the
      // ordinary way must not log a recovery that did not happen.
      if (!model.sourceMissing) return { model, effects: [] };
      // The sentence goes when the problem does — and **only** that sentence. Clearing
      // `error` wholesale here would swallow an unrelated failure the founder still needs
      // to see; the file being found again says nothing about a television that would not
      // answer. The position is untouched on purpose: that is the entire point of 15b's
      // *Find it again*, and wiping it is the defect checklist item 5 caught.
      return {
        model: {
          ...model,
          sourceMissing: false,
          error: model.error?.kind === 'source-missing' ? null : model.error,
        },
        effects: [{ type: 'log', event: 'session.source_found', fields: {} }],
      };
    }

    case 'file.replanned': {
      if (model.error === null) return { model, effects: [] };
      return {
        model: { ...model, error: null, sourceMissing: false },
        effects: [{ type: 'log', event: 'session.replanned', fields: {} }],
      };
    }

    case 'file.changed': {
      // Only once the session is over. Choosing a file mid-cast does not stop the cast,
      // and the position on screen still belongs to the film that is actually playing.
      if (ACTIVE_STATES.includes(model.state) || model.state === 'loading') {
        return { model, effects: [] };
      }
      // *Resume from 0:32:10* must never offer to resume a **different** film at the last
      // one's position. The number was true about a file that is no longer chosen.
      return {
        model: {
          ...model,
          resumePositionSec: 0,
          sourceMissing: false,
          error: null,
          seek: null,
          // A different film is not the one somebody took the television for, so the
          // statement about it goes with the position it belonged to.
          flags: { ...model.flags, yielded: false },
          yieldedTo: null,
        },
        effects: [{ type: 'seek.release_hold', restore: false }],
      };
    }

    case 'media.not_fetched': {
      // The device took the video and never came back for it. On Windows that is almost
      // always the firewall standing between the TV and this PC's media server — and a
      // spinner that never ends is the one outcome the PRD refuses to ship (17a).
      if (model.state !== 'loading' && model.state !== 'buffering') return { model, effects: [] };
      return {
        model: {
          ...INITIAL_SESSION,
          deviceId: model.deviceId,
          resumePositionSec: model.resumePositionSec,
          sourceMissing: model.sourceMissing,
          error: {
            userMessage: 'Windows Firewall is blocking CastGood',
            actionLabel: 'Allow through the firewall',
            kind: 'firewall-blocked',
          },
        },
        effects: [
          { type: 'send.stop' },
          { type: 'release' },
          { type: 'log', event: 'session.firewall_suspected', fields: { state: model.state } },
        ],
      };
    }

    case 'device.connect_failed': {
      return {
        model: {
          ...INITIAL_SESSION,
          deviceId: model.deviceId,
          resumePositionSec: model.resumePositionSec,
          sourceMissing: model.sourceMissing,
          error: { userMessage: event.userMessage, actionLabel: 'Try again', kind: 'generic' },
        },
        // `send.stop` before `release` on every exit that can leave the Default Media
        // Receiver running on the TV. Reaching here after a *launch* succeeded but the load
        // failed is exactly that case, and closing the socket alone leaves the founder
        // looking at the Cast backdrop (3c). With no connection it is a no-op.
        effects: [
          { type: 'send.stop' },
          { type: 'release' },
          { type: 'log', event: 'session.connect_failed', fields: { reason: event.reason } },
        ],
      };
    }

    case 'device.loaded': {
      if (model.state !== 'loading') return { model, effects: [] };
      // Still `loading` until the device reports a player state: the PRD's "Starting on
      // the device" ends when the device says BUFFERING or PLAYING, not when we say so.
      return { model, effects: [] };
    }

    case 'frontier.changed': {
      // A fact, not a transition: nothing about the session's state changes because a
      // conversion moved on. It is only read when a jump is being clamped (10d).
      if (model.frontierSec === event.frontierSec) return { model, effects: [] };
      return { model: { ...model, frontierSec: event.frontierSec }, effects: [] };
    }

    case 'device.load_rejected': {
      // PRD 3c: back to Ready with the file and device still selected. No codec on screen.
      return {
        model: {
          ...INITIAL_SESSION,
          deviceId: model.deviceId,
          resumePositionSec: model.resumePositionSec,
          // A file the device refused *and* which has since moved is one problem, not two,
          // and the useful half is the one the founder can act on.
          ...(model.sourceMissing
            ? { sourceMissing: true, error: sourceMissingError({ ...model, sourceMissing: true }) }
            : {
                error: {
                  userMessage: "Couldn't play this file",
                  actionLabel: null,
                  kind: 'generic' as const,
                },
              }),
        },
        // The receiver was launched before the file was refused, so the TV is sitting on
        // the Cast backdrop. "Releases the device" (3c) means the receiver-namespace STOP,
        // not just dropping our socket — and 13e requires it of a failed selftest too.
        effects: [
          { type: 'send.stop' },
          { type: 'release' },
          { type: 'log', event: 'session.load_rejected', fields: { detail: event.detail } },
        ],
      };
    }

    case 'device.status': {
      const reported = fromPlayerState(event.playerState);
      if (reported === null) return { model, effects: [] };
      if (
        model.state === 'idle' ||
        model.state === 'stopped' ||
        model.state === 'ended' ||
        model.state === 'connecting'
      ) {
        // A late status from a session we already ended, or one still arriving from the
        // previous device while we connect to the next. Truth, but not ours any more —
        // and believing it here would paint *Playing* over a connection that has not
        // loaded anything yet, or resurrect a film that has finished.
        return { model, effects: [] };
      }

      const confirmed = reported;
      const optimisticActive = model.optimisticUntilMono !== null;
      const satisfied = model.pending !== null && confirmed === model.pending.expected;

      // A seek is in flight and the device is still describing where the film was. Record
      // that the device is alive and what it thinks, but change nothing the founder can
      // see: the readout stays on the position they asked for (6e). The give-up path is
      // `timer.tick`, not this — a hold that no clock could end would be a lie with no
      // expiry date.
      if (event.seekHeld && model.seek !== null) {
        return {
          model: { ...model, confirmedState: confirmed, position: event.position, error: null },
          effects: [],
        };
      }

      // The device landed on the requested position — or there was no seek to begin with.
      const seekDone = model.seek !== null;

      // The display may lead the device for at most `optimisticWindowMs`, and only for a
      // command we actually sent. Everything else follows the device immediately — which
      // is how a pause from a TV remote shows up here within one poll.
      const state = optimisticActive && !satisfied ? model.state : confirmed;

      return {
        model: {
          ...model,
          state,
          confirmedState: confirmed,
          position: event.position,
          resumePositionSec: event.position.reportedSec,
          optimisticUntilMono: satisfied ? null : model.optimisticUntilMono,
          pending: satisfied ? null : model.pending,
          seek: null,
          everPlayed: model.everPlayed || confirmed === 'playing',
          // 11e's stopwatch. Restarted only on the *transition* into buffering, so a
          // device that reports BUFFERING once a second does not keep resetting it — and
          // started from when this status **arrived**, never from the anchor it carries.
          bufferingSinceMono:
            confirmed === 'buffering' ? (model.bufferingSinceMono ?? event.monoMs) : null,
          // **The one thing that ends a run of failing recoveries** (D2, fault 2): the
          // television is playing, or deliberately paused, and there is nothing left to
          // recover. Anything less — a rejoin that lands back in *Buffering*, a control
          // channel that reconnects while the film starves — is the same failure still
          // going on, and it keeps the deadline it started with.
          troubleSinceMono:
            model.recovery === null && (confirmed === 'playing' || confirmed === 'paused')
              ? null
              : model.troubleSinceMono,
          error: null,
        },
        effects: seekDone
          ? [
              {
                type: 'log',
                event: 'session.seek_confirmed',
                fields: {
                  targetSec: Math.round((model.seek?.targetSec ?? 0) * 1000) / 1000,
                  deviceSec: Math.round(event.position.reportedSec * 1000) / 1000,
                  playerState: event.playerState,
                },
              },
            ]
          : [],
      };
    }

    case 'session.live_load_started': {
      // Only over a film the television is actually holding. A LOAD on a session that is
      // not active supersedes nothing, and a window opened there would be deafness bought
      // for no reason at all.
      if (!ACTIVE_STATES.includes(model.state)) return { model, effects: [] };
      return {
        model: { ...model, liveLoad: { why: event.why, sinceMono: event.monoMs } },
        effects: [],
      };
    }

    case 'session.live_load_settled': {
      if (model.liveLoad === null) return { model, effects: [] };
      return { model: { ...model, liveLoad: null }, effects: [] };
    }

    case 'device.idle': {
      const finished = event.idleReason === 'FINISHED';

      if (model.state === 'loading') {
        if (event.idleReason === 'ERROR') {
          return reduce(model, { type: 'device.load_rejected', detail: 'IDLE/ERROR after LOAD' });
        }
        if (!finished) {
          // The receiver is idle because our media has not started yet — a status poll
          // landing between LAUNCH and the first PLAYING says exactly this, with no reason
          // at all. Ending the session here showed the founder "Stopped" a fraction of a
          // second after a load that was going perfectly well. Wait for a real player state.
          return {
            model,
            effects: [
              {
                type: 'log',
                event: 'session.idle_ignored_while_loading',
                fields: { idleReason: event.idleReason },
              },
            ],
          };
        }
      } else if (!ACTIVE_STATES.includes(model.state)) {
        // Already stopped — usually because the founder pressed Stop and this is the
        // device's reply. The session is over, but the device's last word on where it got
        // to is still the best answer to that question, and it is what a resume will use.
        if (event.positionSec !== null) {
          return { model: { ...model, resumePositionSec: event.positionSec }, effects: [] };
        }
        return { model, effects: [] };
      } else if (model.liveLoad !== null && !finished) {
        // **The television is answering a LOAD of ours, not ending the evening** (D2).
        //
        // A receiver takes a new LOAD by ending the media session it is holding and
        // reporting it — `IDLE`/`INTERRUPTED`, for media we have already replaced. On the
        // founder's own set that arrived **101 ms** after the repair LOAD and moved the
        // session to `stopped`, which flashed *Stopped* mid-recovery and wrote a
        // `session.refused_mid_play` that voided the whole run through 13g's guard.
        //
        // `FINISHED` is deliberately still heard: a film that genuinely played out says
        // so, and no receiver says it about media it is superseding. Everything else waits
        // for the LOAD to settle — and if that LOAD fails, the failure is reported by the
        // load path itself (`device.load_rejected`, or a repair's deliberate silence and
        // 11c's deadline), never by inferring it from a status about the old media.
        return {
          model,
          effects: [
            {
              type: 'log',
              event: 'session.idle_ignored_during_live_load',
              fields: {
                idleReason: event.idleReason,
                why: model.liveLoad.why,
                believedState: model.state,
                // When the LOAD went out, so a reader can line this up against
                // `media.path_repairing` / `subtitle.reloading` in the same log.
                loadIssuedAtMono: Math.round(model.liveLoad.sinceMono),
              },
            },
          ],
        };
      }

      // The device's own report wins; a film that played out lands at its duration; and
      // failing both, the last position we knew about.
      const end =
        event.positionSec ??
        (finished && model.position !== null ? model.position.durationSec : positionSec(model));
      // `ended` and `stopped` are different rows in the PRD's state table and the founder
      // is told different things: a film that reached its end versus a place they saved.
      const state: SessionState = finished ? 'ended' : 'stopped';
      return {
        model: {
          ...model,
          state,
          confirmedState: state,
          flags: { ...model.flags, reconnecting: false, reattaching: false },
          recovery: null,
          troubleSinceMono: null,
          optimisticUntilMono: null,
          pending: null,
          seek: null,
          bufferingSinceMono: null,
          resumePositionSec: end,
          // Playback is over, so a source file that vanished during it can finally be
          // mentioned (15a). If it is still there but the device reported an *error*, the
          // film died on its own — and "Stopped, your place is saved" would read as a clean
          // exit the founder chose. Something has to say what happened.
          error:
            sourceMissingError(model) ??
            (event.idleReason === 'ERROR'
              ? {
                  userMessage: 'The TV stopped playing this file',
                  actionLabel: 'Try again',
                  kind: 'generic' as const,
                }
              : null),
        },
        // The receiver stays running on the TV at the end of a file, so the same STOP that
        // Stop sends is what actually returns it to its own home screen.
        effects: [
          { type: 'seek.release_hold', restore: false },
          { type: 'recover.cancel' },
          { type: 'send.stop' },
          { type: 'release' },
          endOfSessionLog(finished, event.idleReason, end, model),
        ],
      };
    }

    case 'intent.pause': {
      if (model.state !== 'playing' && model.state !== 'buffering') return { model, effects: [] };
      return {
        model: {
          ...model,
          state: 'paused',
          optimisticUntilMono: event.monoMs + TIMING.optimisticWindowMs,
          pending: { command: 'pause', expected: 'paused', retried: false },
        },
        effects: [{ type: 'send.pause' }],
      };
    }

    case 'intent.play': {
      if (model.state !== 'paused') return { model, effects: [] };
      return {
        model: {
          ...model,
          state: 'playing',
          optimisticUntilMono: event.monoMs + TIMING.optimisticWindowMs,
          pending: { command: 'play', expected: 'playing', retried: false },
        },
        effects: [{ type: 'send.play' }],
      };
    }

    case 'intent.stop': {
      // Already over and already released: stopping again would only replace the PRD's
      // *Finished* state with *Stopped* and send a second STOP to a device we let go of.
      if (model.state === 'idle' || model.state === 'ended') return { model, effects: [] };
      // 14b: once we have yielded, **nothing further is sent to that television** — not
      // even a STOP, which on a device now playing YouTube would stop somebody else's
      // video. The screen is already *Stopped* with the place saved; there is nothing to do.
      if (model.flags.yielded) {
        return {
          model,
          effects: [{ type: 'log', event: 'session.stop_ignored_after_yield', fields: {} }],
        };
      }
      return {
        model: {
          ...model,
          state: 'stopped',
          confirmedState: 'stopped',
          flags: { ...model.flags, reconnecting: false, reattaching: false },
          recovery: null,
          troubleSinceMono: null,
          optimisticUntilMono: null,
          pending: null,
          seek: null,
          resumePositionSec: Math.max(event.atSec, 0),
          error: sourceMissingError(model),
        },
        effects: [
          { type: 'seek.release_hold', restore: false },
          { type: 'recover.cancel' },
          { type: 'send.stop' },
          { type: 'release' },
        ],
      };
    }

    case 'device.ended_session': {
      if (model.state === 'idle' || model.state === 'stopped' || model.state === 'ended') {
        return { model, effects: [] };
      }
      if (model.recovery !== null) return { model, effects: [] };
      // **Say *Stopped*, now — and be ready to be wrong about *why*.**
      //
      // SPIKE-2, on the founder's own hardware: a takeover sends this exact orderly CLOSE
      // *first*, and only names the app that took the television 4.3–11.3 s later. For
      // that whole window a stop from the TV's own remote and somebody casting YouTube
      // from a phone are byte-identical.
      //
      // This was built as *Reconnecting to \<name\>…* for the full 15 s grace, which
      // is never wrong and describes a fault that is not happening — on the commonest
      // action in the product. **Founder's ruling, 2026-08-18**: say *Stopped* at once,
      // and correct to "<name> is now playing <app>" if a takeover is revealed inside the
      // grace. The correction only ever runs that way round.
      //
      // Two things this transition must therefore *not* do: it does not release (the
      // connection is what the late `RECEIVER_STATUS` arrives on, so recovery keeps
      // probing for the whole grace), and it does not let the readout keep moving.
      const unsent = model.seek !== null && model.seek.issuedAtMono === null;
      return {
        model: {
          ...model,
          state: 'stopped',
          confirmedState: 'stopped',
          flags: { ...model.flags, reconnecting: false, reattaching: false },
          recovery: { cause: 'orderly', startedAtMono: event.monoMs, attempts: 0 },
          optimisticUntilMono: null,
          pending: null,
          seek: null,
          resumePositionSec: Math.max(event.atSec, 0),
          error: sourceMissingError(model),
        },
        effects: [
          { type: 'seek.release_hold', restore: unsent },
          { type: 'position.freeze' },
          { type: 'recover' },
          {
            type: 'log',
            event: 'session.stopped_by_device',
            fields: {
              reason: event.reason,
              atSec: Math.round(event.atSec * 1000) / 1000,
              graceMs: TIMING.takeoverGraceMs,
            },
          },
        ],
      };
    }

    case 'device.disconnected': {
      if (model.state === 'idle' || model.state === 'stopped' || model.state === 'ended') {
        return { model, effects: [] };
      }
      if (model.recovery !== null) return { model, effects: [] };
      // 11a/11f: the socket died or the heartbeat gave up. Reconnect without the founder
      // doing anything, and tell them nothing beyond "Reconnecting…" until 30 s have gone.
      return beginRecovery(model, 'lost', event.monoMs, event.reason);
    }

    case 'recovery.attempt': {
      if (model.recovery === null) return { model, effects: [] };
      return {
        model: {
          ...model,
          recovery: { ...model.recovery, attempts: model.recovery.attempts + 1 },
        },
        effects: [],
      };
    }

    case 'recovery.rejoined': {
      if (model.recovery === null) return { model, effects: [] };
      // Nothing about the screen changes back except the status line: the device's own
      // status is already on its way and will re-anchor the position within a poll.
      //
      // The exception is an orderly close that turned out to be nothing — a spurious
      // CLOSE from a television that never stopped playing. *Stopped* is already on
      // screen, and the probe has just found our own receiver still running our own film,
      // so the honest thing is to put the film back rather than leave the founder looking
      // at a Stopped screen for something that is playing in front of them.
      const resumed = model.state === 'stopped' ? fromPlayerState(event.playerState) : null;
      return {
        model: {
          ...model,
          ...(resumed === null ? {} : { state: resumed, confirmedState: resumed }),
          flags: { ...model.flags, reconnecting: false, reattaching: false },
          recovery: null,
          error: null,
        },
        effects: [
          {
            type: 'log',
            event: 'session.recovery_rejoined',
            fields: {
              cause: model.recovery.cause,
              attempts: model.recovery.attempts,
              elapsedMs: Math.round(event.monoMs - model.recovery.startedAtMono),
              state: resumed ?? model.state,
              unstopped: resumed !== null,
            },
          },
        ],
      };
    }

    case 'recovery.yielded': {
      // **Whose television is this about?**
      //
      // Two routes lead here: a takeover announced on a socket that is still up (the fast
      // path, while the film is playing), and the recovery probe finding another app on
      // the device. Anything else is a stale answer to a question that no longer exists —
      // an old recovery loop resolving its `close()` after the founder pressed *Take it
      // back* or picked another device, and then tearing down the session that replaced
      // it and naming a television the new one was never on. The same event after Stop
      // overwrote the honest saved position.
      //
      // `connecting` is deliberately not live: a receiver status naming another app while
      // we are casting *to* that device is what a real Chromecast broadcasts on its way to
      // running our receiver, and 14c's *Take it back* is exactly that press.
      // `loading` is not live either, and for the same reason as `connecting`: we have
      // just sent a LAUNCH of our own, and the receiver status describing what the
      // television was doing a moment ago is not somebody taking it from us.
      const live = ACTIVE_STATES.includes(model.state);
      if (!live && model.recovery === null) {
        return {
          model,
          effects: [
            {
              type: 'log',
              event: 'session.yield_ignored',
              fields: { state: model.state, appId: event.appId },
            },
          ],
        };
      }
      // 14a: stated as a **fact**, with no error styling and no retry loop. The position is
      // remembered and *Take it back* is the way in. 14b: from here we send that television
      // nothing at all — `release` closes our socket and unmounts the file, and every
      // control that could reach it is refused by `seekRefusal` and by the state.
      return {
        model: {
          ...model,
          state: 'stopped',
          confirmedState: 'stopped',
          flags: { reconnecting: false, reattaching: false, yielded: true, networkDown: false },
          recovery: null,
          troubleSinceMono: null,
          yieldedTo: event.appName,
          optimisticUntilMono: null,
          pending: null,
          seek: null,
          // **The saved position survives the correction.** When this is correcting a
          // *Stopped* screen that an orderly close put up moments ago, the number on that
          // screen is the honest one — the film stopped then, and everything since has
          // been us asking the television who has it. Re-deriving a position here would
          // hand the founder a *Resume from* for a place the film never reached.
          resumePositionSec:
            model.state === 'stopped' ? model.resumePositionSec : Math.max(event.atSec, 0),
          error: sourceMissingError(model),
        },
        effects: [
          { type: 'seek.release_hold', restore: false },
          { type: 'recover.cancel' },
          { type: 'release' },
          {
            type: 'log',
            event: 'session.yielded',
            fields: {
              appId: event.appId,
              appName: event.appName,
              atSec: Math.round(event.atSec * 1000) / 1000,
              // True when this is the ruling's correction rather than a first statement.
              corrected: model.state === 'stopped',
            },
          },
        ],
      };
    }

    case 'recovery.gave_up': {
      // **A run of failing recoveries, not necessarily an attempt in flight** (D2). Every
      // one of that evening's seventy-six attempts *succeeded* — the control channel came
      // back each time — and the film never played, so between attempts there was no
      // `recovery` to hang a deadline on and the founder was told nothing at all. The run
      // is what has failed, and `troubleSinceMono` is what says so.
      const recovery =
        model.recovery ??
        (model.troubleSinceMono === null
          ? null
          : { cause: 'stalled' as const, startedAtMono: model.troubleSinceMono, attempts: 0 });
      if (recovery === null) return { model, effects: [] };
      // The two endings the wait existed to tell apart.
      //
      // `orderly` — the television closed the session and nothing else ever appeared on
      // it. That is the founder pressing stop on the TV itself: a decision, not a failure,
      // and telling them "Lost connection" for something they did on purpose is both wrong
      // and alarming (the M1 defect this whole distinction was built for). Since the
      // founder's ruling of 2026-08-18 the screen has *already* said *Stopped*; what
      // happens here is that we stop asking who has the television, and let go of it.
      //
      // `lost`/`stalled` — 11c: **only now**, after ~30 s, does the founder hear anything,
      // and it states the saved position as a number and offers a way back in.
      const orderly = recovery.cause === 'orderly';
      return {
        model: {
          ...model,
          state: 'stopped',
          confirmedState: 'stopped',
          flags: { ...model.flags, reconnecting: false, reattaching: false },
          recovery: null,
          // The run is over — it has been spoken about. Whatever happens next is a new
          // problem with a deadline of its own.
          troubleSinceMono: null,
          optimisticUntilMono: null,
          pending: null,
          seek: null,
          // An orderly close already saved the position it stopped at, and this tick's
          // idea of "where the film is" is the device's last *report*, which is older.
          resumePositionSec:
            model.state === 'stopped' ? model.resumePositionSec : Math.max(event.atSec, 0),
          error:
            sourceMissingError(model) ??
            (orderly
              ? null
              : {
                  userMessage: 'Lost connection',
                  actionLabel: 'Reconnect',
                  kind: 'lost-connection' as const,
                }),
        },
        effects: [
          { type: 'seek.release_hold', restore: false },
          { type: 'recover.cancel' },
          { type: 'release' },
          {
            type: 'log',
            event: orderly ? 'session.ended_by_device' : 'session.connection_lost',
            fields: {
              cause: recovery.cause,
              attempts: recovery.attempts,
              atSec: Math.round(event.atSec * 1000) / 1000,
            },
          },
        ],
      };
    }

    case 'network.changed': {
      if (model.flags.networkDown === !event.online) return { model, effects: [] };
      if (!event.online) {
        // 11d: this PC, not the television. Controls grey with the reason and the position
        // is held; there is nothing to reconnect over until the adapter is back.
        const marked: SessionModel = {
          ...model,
          flags: { ...model.flags, networkDown: true },
          offlineSinceMono: event.monoMs,
          offlineHelp: false,
        };
        const live = ACTIVE_STATES.includes(model.state) || model.state === 'loading';
        if (!live || model.recovery !== null) {
          return {
            model: marked,
            effects: [{ type: 'log', event: 'session.pc_offline', fields: { live } }],
          };
        }
        return beginRecovery(marked, 'lost', event.monoMs, 'this PC went offline');
      }
      return {
        model: {
          ...model,
          flags: { ...model.flags, networkDown: false },
          offlineSinceMono: null,
          offlineHelp: false,
          // The clock the founder is judged against starts when the network returns, not
          // when it went: 11b's budget is "within 10 s of the network returning".
          recovery:
            model.recovery === null
              ? null
              : { ...model.recovery, startedAtMono: event.monoMs, attempts: 0 },
          // 11b's budget is "within 10 s of the network returning", so the run's own
          // clock starts there too — including when no attempt happens to be in flight,
          // which is most of a run of recoveries that keep succeeding and keep failing.
          troubleSinceMono: model.troubleSinceMono === null ? null : event.monoMs,
        },
        effects: [{ type: 'log', event: 'session.pc_online', fields: {} }],
      };
    }

    case 'session.reattaching': {
      // The mockup's "Picking up where you left off on <name>…", labelled Transient (≤5 s).
      return {
        model: {
          ...INITIAL_SESSION,
          state: 'connecting',
          deviceId: event.deviceId,
          flags: { ...NO_FLAGS, reattaching: true },
        },
        effects: [
          { type: 'log', event: 'session.reattaching', fields: { deviceId: event.deviceId } },
        ],
      };
    }

    case 'session.reattached': {
      const reported = fromPlayerState(event.playerState) ?? 'buffering';
      return {
        model: {
          ...model,
          state: reported,
          confirmedState: reported,
          flags: { ...model.flags, reattaching: false },
          everPlayed: reported === 'playing' || model.everPlayed,
        },
        effects: [
          { type: 'log', event: 'session.reattached', fields: { playerState: event.playerState } },
        ],
      };
    }

    case 'session.reattach_failed': {
      // 12b: "Recovery that isn't needed is silent." Straight to Idle, no screen, no error.
      return {
        model: { ...INITIAL_SESSION },
        effects: [
          { type: 'release' },
          { type: 'log', event: 'session.reattach_failed', fields: { reason: event.reason } },
        ],
      };
    }

    case 'timer.tick': {
      // **The deaf window closes itself, whatever happened to the LOAD that opened it.**
      //
      // `session.live_load_settled` is raised from a `finally`, so this can only fire if a
      // LOAD never returned at all — and a window left open would go on ignoring `IDLE`
      // from a television that really had abandoned the film, which is a worse failure
      // than the one it prevents. A LOAD's own worst case is well inside this ceiling; by
      // the time it is reached, 11c's thirty seconds has already spoken.
      const inFlight = model.liveLoad;
      if (inFlight !== null && event.monoMs - inFlight.sinceMono >= TIMING.liveLoadIdleWindowMs) {
        return {
          model: { ...model, liveLoad: null },
          effects: [
            {
              type: 'log',
              event: 'session.live_load_window_expired',
              fields: {
                why: inFlight.why,
                afterMs: Math.round(event.monoMs - inFlight.sinceMono),
              },
            },
          ],
        };
      }

      // 11d: the button that opens Windows' own network settings appears after 30 s of
      // outage **and not before**. A blip the founder could ignore must not be dressed up
      // as something they have to go and fix.
      if (
        model.flags.networkDown &&
        !model.offlineHelp &&
        model.offlineSinceMono !== null &&
        event.monoMs - model.offlineSinceMono >= TIMING.offlineHelpAfterMs
      ) {
        return {
          model: { ...model, offlineHelp: true },
          effects: [
            {
              type: 'log',
              event: 'session.offline_help_offered',
              fields: { afterMs: Math.round(event.monoMs - model.offlineSinceMono) },
            },
          ],
        };
      }

      const recovery = model.recovery;
      if (recovery !== null) {
        // While this PC has no network there is nothing to reconnect *over*, so the
        // give-up clock is suspended rather than running out on an outage the founder is
        // still in the middle of. 11d: "when the network returns, playback resumes by
        // itself" — not "unless it took longer than thirty seconds".
        if (model.flags.networkDown) {
          return {
            model: {
              ...model,
              recovery: { ...recovery, startedAtMono: event.monoMs },
              // The run's own clock is suspended with the attempt's, or a PC that was
              // offline for a minute would come back already out of patience.
              troubleSinceMono: event.monoMs,
            },
            effects: [],
          };
        }
        // **Measured from the first failure of this run, not from this attempt** (D2).
        const troubleSince = model.troubleSinceMono ?? recovery.startedAtMono;
        if (event.monoMs - troubleSince >= recoveryDeadlineMs(recovery.cause)) {
          return reduce(model, { type: 'recovery.gave_up', atSec: positionSec(model) });
        }
        // Nothing else in this tick applies while a session is being recovered: there is
        // no connection to retry a seek or a pause down.
        return { model, effects: [] };
      }

      // **The run's deadline, with no attempt in flight.**
      //
      // Defect D2, fault 2: a film starving on a dead byte connection rejoined its control
      // channel every single time, so `model.recovery` was null far more often than not
      // and the check above ran on an attempt that was about to succeed. 11c promises the
      // founder hears *"Lost connection to \<name\>"* after ~30 s of recovery that is not
      // working, and "not working" is a fact about the run, not about an attempt.
      //
      // The mark is only ever cleared by the television actually playing again (see
      // `device.status`), so a non-null one thirty seconds old means exactly that: half a
      // minute since the trouble started and the film has not played since.
      const trouble = model.troubleSinceMono;
      if (
        trouble !== null &&
        !model.flags.networkDown &&
        ACTIVE_STATES.includes(model.state) &&
        event.monoMs - trouble >= TIMING.reconnectBudgetMs
      ) {
        return reduce(model, { type: 'recovery.gave_up', atSec: positionSec(model) });
      }

      // 11e: *Buffering* that has not resolved in 10 s becomes a recovery attempt rather
      // than an indefinite spinner. Only for a film that had actually started — a cast
      // that never produced a picture is 17a's business, and it says something useful.
      if (
        model.state === 'buffering' &&
        model.everPlayed &&
        model.bufferingSinceMono !== null &&
        event.monoMs - model.bufferingSinceMono >= TIMING.bufferingRecoveryMs
      ) {
        return beginRecovery(
          model,
          'stalled',
          event.monoMs,
          `buffering for ${String(Math.round(event.monoMs - model.bufferingSinceMono))} ms`,
        );
      }

      // A seek the device has not acknowledged. Hold the requested position, retry once,
      // and only then let device truth win the display back (6e). A seek that failed is
      // never displayed as one that worked — but nor does the readout snap backwards the
      // instant a device is slow to answer.
      const seek = model.seek;
      if (seek !== null && seek.issuedAtMono !== null) {
        const overdue = event.monoMs - seek.issuedAtMono >= TIMING.seekConfirmMs;
        if (overdue && !seek.retried) {
          return {
            model: { ...model, seek: { ...seek, issuedAtMono: event.monoMs, retried: true } },
            effects: [
              { type: 'send.seek', positionSec: seek.targetSec },
              {
                type: 'log',
                event: 'session.seek_retried',
                fields: { targetSec: Math.round(seek.targetSec * 1000) / 1000 },
              },
            ],
          };
        }
        if (overdue) {
          return {
            model: {
              ...model,
              seek: null,
              state: model.state === 'seeking' ? model.confirmedState : model.state,
            },
            effects: [
              // 6e: "a seek that failed is never displayed as one that worked". Leaving the
              // requested position on screen and waiting for some later status to correct
              // it is fine on a healthy device and permanent on one that reports no
              // position at all — so put the readout back explicitly.
              { type: 'seek.release_hold', restore: true },
              {
                type: 'log',
                event: 'session.seek_unconfirmed',
                fields: {
                  targetSec: Math.round(seek.targetSec * 1000) / 1000,
                  reconciledTo: model.confirmedState,
                },
              },
            ],
          };
        }
      }

      if (model.optimisticUntilMono === null || event.monoMs < model.optimisticUntilMono) {
        return { model, effects: [] };
      }
      const pending = model.pending;
      // The window closed without the device agreeing. Truth wins the display back.
      const reverted: SessionModel = {
        ...model,
        state: model.confirmedState,
        optimisticUntilMono: null,
      };
      if (pending === null || pending.retried) {
        return {
          model: { ...reverted, pending: null },
          effects: [
            {
              type: 'log',
              event: 'session.optimistic_reverted',
              fields: { to: model.confirmedState, retried: pending?.retried ?? false },
            },
          ],
        };
      }
      return {
        model: { ...reverted, pending: { ...pending, retried: true } },
        effects: [
          pending.command === 'pause' ? { type: 'send.pause' } : { type: 'send.play' },
          {
            type: 'log',
            event: 'session.command_retried',
            fields: { command: pending.command, to: model.confirmedState },
          },
        ],
      };
    }
  }
}
