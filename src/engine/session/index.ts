import fsp from 'node:fs/promises';
import type { Clock, Logger } from '../logging/index.js';
import { isTakeoverApp } from '../cast/index.js';
import type {
  CastClient,
  CastConnection,
  LoadTrack,
  MediaStatus,
  ReceiverStatus,
  VolumeChange,
  VolumeControlType,
} from '../cast/index.js';
import { contentTypeFor, type MediaMount, type MediaServer } from '../media-server/index.js';
import type { Device } from '../types.js';
import { CAST, TIMING } from '../config.js';
import { EngineError, isEngineError } from '../errors.js';
import { clampOffsetMs, type Cue } from '../subtitles/cues.js';
import { buildLadder, ladderCentreFor, rungFor, rungLabel } from '../subtitles/ladder.js';
import { createPositionTracker, type PositionTracker } from './position.js';
import { INITIAL_SESSION, reduce, type SessionEffect, type SessionModel } from './machine.js';

/**
 * The most `SET_VOLUME`s that may be outstanding against a television at once.
 *
 * **Not a timing constant and not tunable** — it is 23a and 23d written as a number. 23a
 * allows exactly one command in flight; 23d mandates exactly one retry when the set answers
 * nothing. Two is the smallest value that can satisfy both, and any larger value is the
 * defect it was added to stop: a drag against a silent television growing the outstanding
 * set once per 500 ms for as long as the founder keeps moving.
 */
const VOLUME_MAX_UNANSWERED = 2;

/**
 * The session supervisor: owns one playback session end to end.
 *
 * It drives the pure reducer in `machine.ts`, performs the effects the reducer asks
 * for, and is the only place allowed to talk to the cast client and the media server
 * during playback.
 *
 * Two loops run while a session is alive, and they do different jobs:
 *  - **the poll** asks the device for its status once a second. That is what re-anchors
 *    the position (no drift) and what makes a pause from a TV remote appear here within
 *    2 seconds without anyone telling us.
 *  - **the tick** runs at 4 Hz purely so the readout moves smoothly and so an optimistic
 *    paint can expire on time.
 *
 * **Recovery** (M2's stories 11, 12 and 14) is the third loop, and it only runs when
 * something has gone wrong. It reconnects and then *asks* the television what is running —
 * `GET_STATUS`, never `LAUNCH`, because a LAUNCH would take the device back from whoever
 * has it, which is exactly what 14b forbids. SPIKE-2 measured every number it is built on:
 * a rejoin in 86–126 ms, an unchanged media session, a position error of 0.003 s after a
 * 15-second outage, and pause/resume working on a session this process never started.
 *
 * Two more timers arrive with M2's seeking, and both are bounded on purpose:
 *  - **the settle timer** collapses a burst of taps or drags into one wire message
 *    (`TIMING.seekSettleMs`).
 *  - **the fetch watchdog** notices a device that accepted a LOAD and never came back for
 *    the bytes (`TIMING.firewallDiagnosisMs`), which on Windows is nearly always the
 *    firewall — and is otherwise a spinner that never ends.
 */

export interface SessionSource {
  readonly path: string;
  readonly name: string;
  /**
   * Present when `path` is a **directory of segments still being written** rather than a
   * film — M3b's head start.
   *
   * It changes three things and nothing else: the mount is `hls`, the URL names the playlist
   * we re-emit rather than a file, and a refused LOAD is **never** allowed to teach the
   * capability table. That last one is the 2026-08-19 serving-shape ADR: a CORS fault, an
   * untrue `TARGETDURATION` and a genuine codec refusal are byte-for-byte the same message
   * on the wire, so an HLS refusal would narrow a device's profile with a fact about our
   * own server.
   */
  readonly hls?: { readonly playlistName: string };
  /**
   * The film's true length, from **our own** probe.
   *
   * 10c, and it is not an optimisation: both the Ultra and the `AI PONT` report
   * `media.duration: -1` for the entire session — before *and* after `ENDLIST` — so a
   * growing conversion has no duration unless we supply one. Left undefined for a
   * progressive file, where the device's own report is better than our memory of it.
   */
  readonly durationSec?: number;
  /**
   * **The subtitle the founder chose, already converted and waiting** (18e).
   *
   * Absent on every cast until somebody turns subtitles on, and its absence is what makes
   * 19a's *"byte-for-byte what it would have been before M3c existed"* true: no mount, no
   * URL, no `tracks` key.
   *
   * What it changes is deliberately small — one extra `file` mount and two keys on the
   * LOAD. 18e: *"the video sent is unchanged"*. The film's mount, `contentId`,
   * `contentType`, `streamType` and `currentTime` are the same bytes whether this is here
   * or not, because choosing a subtitle is not a fact about the film.
   */
  readonly subtitle?: SessionSubtitle;
}

/**
 * **The founder's subtitle, as the wire needs it** — the words, and where in time they sit.
 *
 * Not a file. Since 2026-08-27 a subtitle is a cue list held in memory and the media server
 * derives every rung of story 20's ladder from it per request, so what travels here is the
 * words themselves and the offset the founder has nudged to.
 */
export interface SessionSubtitle {
  /**
   * Which source this is — the id the founder's choice carries.
   *
   * It is **identity, not decoration**: a television only accepts text tracks in a LOAD, so
   * the session has to know whether the ladder already on the set is a ladder for *this*
   * source. Same key means a nudge is a track switch; a different key means one reload.
   */
  readonly key: string;
  /** The words. Never empty — 18j refuses a zero-cue track long before it reaches here. */
  readonly cues: readonly Cue[];
  /** What the television shows in its own track menu. The founder's own label. */
  readonly name: string;
  /** The language the film named, or `''`. */
  readonly language: string;
  /** Which rung is showing, in integer milliseconds. `0` is *in sync*. */
  readonly offsetMs: number;
}

/**
 * Everything a *different process* would need to rejoin this session (story 12).
 *
 * Not a memory of what the device is doing — the device is asked for that, and SPIKE-2
 * showed it answers accurately to 0.031 s. This is the part the device cannot supply: the
 * URL it is fetching from a media server that died with the app.
 */
export interface LiveSessionInfo {
  readonly deviceId: string;
  readonly filePath: string;
  readonly fileName: string;
  readonly token: string;
  readonly mediaPort: number;
  readonly mediaSessionId: number | null;
  readonly positionSec: number;
  /**
   * **The track the television is actually holding**, or `null` for a film with none (18h).
   *
   * Taken from what was *declared* rather than from what anyone currently wants: the
   * television only ever accepted tracks in the LOAD, so the ladder on the set belongs to
   * that message, and a reopened app has to come back to the same one. The token is this
   * session's subtitle mount — the thirteen URLs the set already holds all name it.
   */
  readonly subtitle: LiveSubtitleInfo | null;
}

/** What a reopened app needs to put the same words back in the same place (18h). */
export interface LiveSubtitleInfo {
  readonly sourceId: string;
  readonly label: string;
  readonly language: string;
  readonly offsetMs: number;
  readonly token: string;
}

/** What a previous run left behind, handed back to `reattach()`. */
export interface ReattachTarget {
  readonly token: string;
  readonly mediaSessionId: number | null;
  readonly positionSec: number;
}

export interface ReattachOptions {
  /**
   * When to stop trying, on the monotonic clock.
   *
   * 12a promises the reattach lands "within 5 s", and every step here can outlive that on
   * its own: a connect timeout is 5 s by itself. Without a deadline carried in, the budget
   * bounded only the wait for the device to appear — the part of the operation that is not
   * the operation.
   */
  readonly deadlineMono?: number;
}

export interface SessionSupervisorDeps {
  logger: Logger;
  clock: Clock;
  cast: CastClient;
  mediaServer: MediaServer;
  /** Called on every model or position change; the engine turns it into a snapshot. */
  onChanged(): void;
  /** Discovery keeps the device we are using on the list even if it goes quiet. */
  onDeviceInUse?(deviceId: string | null): void;
  /**
   * A live session began, moved on, or ended. `null` means there is nothing to come back
   * to and the record should be forgotten — which is what makes 12b silent.
   */
  onSessionChanged?(info: LiveSessionInfo | null): void;
  /**
   * A television refused the file we handed it — criterion 7e's trigger.
   *
   * The session's own job is unchanged and finishes first: back to Ready, device released,
   * *Couldn't play this file*. This hook is what lets the **engine** overrule that outcome
   * with something better — record what this device cannot play, re-plan the file as a
   * repackage or a conversion, and show the founder preparation starting rather than an
   * error. Nothing here knows about the capability model; it only reports the fact.
   *
   * **Only progressive-MP4 loads may reach this**, per the 2026-08-19 HLS ADR: a CORS
   * fault, an invalid `TARGETDURATION` and a genuine codec refusal are byte-for-byte the
   * same message on the wire, so an HLS failure must never teach the capability table.
   * M3a serves nothing but progressive MP4, which is why that is a comment today and a
   * condition the day M3b lands.
   *
   * **And only a *refused load* may reach it, which is not the same thing as a film that
   * died** (criterion 13g, 2026-08-24). A device that accepted the LOAD, reported `PLAYING`
   * and then went `IDLE`/`ERROR` a fraction of a second later is a different fact: it is
   * recorded by `session.refused_mid_play` and it deliberately does **not** come through
   * here. The ADR's argument applies with more force there, not less — by the time a stream
   * is playing, our own media server has had every opportunity to be the thing that broke —
   * and narrowing a television's profile on it would teach the capability table about a
   * defect of ours. Extending 7e's ladder to reach that event is a real question with real
   * evidence behind it (the bedroom Chromecast's own failure mode is invisible to 7e for
   * exactly this reason), and it is an architect's call, not a comment's.
   */
  onLoadRejected?(detail: string): void;
  /**
   * Overridden only by tests, so the retry *arithmetic* around a 14-second exchange is
   * checked in a second rather than in three quarters of a minute.
   *
   * Exactly the seam `heartbeatIntervalMs` is in the cast client, and for the same reason:
   * what is under test is the number of attempts and what the founder sees while they
   * happen, not how long a `setTimeout` sleeps. The shipping path never sets it.
   */
  launchTimeoutMs?: number;
}

export interface CastOptions {
  /** Where to start. Non-zero only for *Resume from \<position\>* (PRD 16c). */
  readonly startPositionSec?: number;
}

/** What the television last said about its own volume. Nothing derived, nothing kept. */
export interface ReportedVolume {
  readonly level: number | null;
  readonly muted: boolean | null;
  readonly controlType: VolumeControlType | null;
  readonly stepInterval: number | null;
}

export interface SessionSupervisor {
  readonly model: SessionModel;
  /** The smooth, displayable position right now. */
  positionSec(): number;
  durationSec(): number;
  /**
   * The last volume a receiver status reported, or `null` if none has (M5a, 23b).
   *
   * **Deliberately not part of `SessionModel`.** A volume is a control's value, not a
   * state: 23k forbids it an entry in §2's vocabulary, so it must not become one here
   * either. It is device-reported truth held beside the model, the way the media session
   * id is, and it is republished rather than reduced.
   */
  reportedVolume(): ReportedVolume | null;
  /**
   * Ask the television for a level or a mute — M5a, 23a.
   *
   * Returns nothing on purpose: **there is no outcome for a caller to paint.** Whether the
   * set took the level, quantised it, clamped it or ignored it is learned the same way a
   * change made by anybody else is learned — a receiver status arrives and the readout
   * follows it. A method that resolved with "the new level" would hand the renderer a
   * number to trust, which is exactly what 23b forbids.
   */
  setVolume(change: VolumeChange): void;
  /**
   * The level the founder has asked for and the television has not answered yet — or
   * `null`, which is almost always.
   *
   * **This is a request, not a level, and the distinction is the whole of 23b.** It never
   * positions the handle and it is never shown as a value; §11 draws it as a separate tick
   * with a hatched gap to the reported level, so *asked for* and *confirmed* cannot be
   * confused on screen. It exists because 23a already requires the engine to hold exactly
   * one outstanding ask — this exposes that one, and creates no second copy of anything.
   *
   * A set that ignores us leaves this standing and the handle where it was, which is the
   * behaviour a control with no ask mark could not show at all.
   */
  pendingVolumeLevel(): number | null;
  /** The device currently owning the session, if any. */
  readonly device: Device | null;
  cast(device: Device, source: SessionSource, options?: CastOptions): Promise<void>;
  /**
   * Adopt a session this process did not start (PRD 12a).
   *
   * Resolves `true` when the television really was still playing our content. `false` is
   * the ordinary outcome, not a failure: the founder stopped it, or somebody else is
   * watching something, and the app opens straight into Idle with nothing said (12b).
   */
  reattach(
    device: Device,
    source: SessionSource,
    target: ReattachTarget,
    options?: ReattachOptions,
  ): Promise<boolean>;
  /** The set of usable local addresses changed. Decides `networkDown` (11d). */
  /**
   * The machine's addresses changed.
   *
   * `usable` is the outward-facing set the discovery filter accepts — no usable address at
   * all means plainly offline. `all` is every IPv4 address including loopback, and it is
   * what the serving address is checked against; see `src/engine/network/index.ts`.
   */
  noteNetwork(usable: readonly string[], all: readonly string[]): void;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** A drag release: one destination, sent once the coalescing window closes. */
  seek(positionSec: number): Promise<void>;
  /** One ±30 s tap. Accumulates with any others inside the window. */
  skip(deltaSec: number): Promise<void>;
  /**
   * **What the founder wants their subtitles to be, right now** — 19b, 20b, 20c.
   *
   * One call for all of it: off (`null`), on, a different source, a different offset. The
   * session works out the cheapest way to get the television there, because it is the only
   * thing that knows what the last LOAD declared — everything inside ±3 s of a track already
   * on the set is a track switch, and everything else is one reload at the founder's place.
   *
   * **Presses are coalesced, not queued** (20c): a call replaces any window already open, so
   * four presses in 400 ms produce one message on the wire for the summed offset. The number
   * on the screen is the caller's to move on every press — that has nothing to wait for.
   */
  setSubtitle(wanted: SessionSubtitle | null): void;
  /**
   * **Take back a ladder this process never declared** — 18h, and only ever a reattach.
   *
   * A reopened app rejoins a film that is still playing and issues no LOAD at all (12a), so
   * the thirteen text tracks on that television belong to the run that closed. They are
   * perfectly good — the set is holding them — but their URLs point at a media server that
   * died, and this process believes nothing is declared, so the founder's next press would
   * be answered by **reloading the film**: the one thing a reattach is not allowed to do.
   *
   * This says: those are ours, the words are these, the rung showing is that one. It
   * republishes the track's mount under the **same token**, which is the same argument
   * SPIKE-2 made about the film's own URL — the address the television is holding has to
   * start answering again — and restores exactly the state a LOAD would have left, so the
   * next nudge is a track switch of 11–36 ms rather than a reload.
   *
   * Refused unless there is a live session with nothing declared, because it is not a way to
   * put subtitles on a television: it can only ever re-describe words that are already there.
   */
  adoptSubtitle(subtitle: SessionSubtitle, token: string): boolean;
  /** True while a subtitle change is costing a reload — 19b's *stated*, not hidden. */
  readonly subtitleReloading: boolean;
  /**
   * **The television took the track and never fetched it** — 18l.
   *
   * A fact for the founder's subtitle control and for nothing else: while it is true the
   * film is still playing, still at their place, and still exactly as it was. False again
   * the moment a new declaration replaces it or the words are turned off.
   */
  readonly subtitleNotLoaded: boolean;
  /**
   * *Try again* — 18l's way out, and the only one a television will accept.
   *
   * SPIKE-3 settled that text tracks are taken **only in a LOAD**, so re-offering a track
   * the set never fetched means handing it the film again at the founder's own place —
   * exactly the stated reload 19b was amended for, on a press the founder made. Returns
   * `false` when there is nothing to retry, so the caller can say so rather than appear to
   * work.
   */
  retrySubtitle(): boolean;
  /**
   * How far the conversion has got, or `null` when nothing is being converted (10d).
   *
   * The engine knows this from ffmpeg's own progress; the session needs it because it is
   * what a seek is clamped against. **Two independent guards, one pair of braces**: this is
   * ours, and the receiver's three-target-duration rule is its own — and on the `AI PONT`
   * the receiver's limit runs *ahead* of the playhead on a schedule of its own, so anything
   * computing that horizon from a formula rather than from the reported value would be
   * wrong on the founder's own television.
   */
  noteFrontier(frontierSec: number | null): void;
  /**
   * A television asked this media server for bytes that were not there.
   *
   * **The token is the whole of the signal, and discarding it was a defect waiting for a
   * second mount.** Until M3c exactly one file was ever published, so "something went
   * missing" and "the film went missing" were the same fact and the token could be ignored.
   * A subtitle track is a second mount, and a `.vtt` that vanishes must never raise 15b —
   * *"the original file is no longer where it was"* would stop a film that is playing
   * perfectly well and blame the film for it. So 15b is raised **only** for the token the
   * film itself is mounted under, and everything else is logged and left alone.
   */
  noteSourceMissing(token: string): void;
  /**
   * **A byte delivery to this session's mount just ended owing bytes** (defect D2, 11b).
   *
   * Called by the media server the instant it happens, and ignored outside the window a
   * recovery opens — see `armMediaPathWatch`. A seek ends a delivery every time and a
   * healthy film's own interruptions are nobody's business but the receiver's.
   */
  noteDeliveryInterrupted(token: string): void;
  /** A different file was chosen: the remembered position no longer describes anything. */
  noteFileChanged(): void;
  /**
   * The **same** film was found again somewhere else — *Find it again* (15b).
   *
   * Clears the "no longer where it was" sentence and keeps the saved position. The
   * distinction from `noteFileChanged` is the whole of the fix for checklist item 5.
   */
  noteFileRelocated(): void;
  /**
   * A refused load has been turned into a preparation plan (7e). Clears *Couldn't play this
   * file* and leaves everything else — including the founder's place — alone.
   */
  noteReplanned(): void;
  stop(): Promise<void>;
  /**
   * Shut the supervisor down.
   *
   * `keepPlaying` is the **app being closed mid-film** (story 12): let go of the socket
   * and leave the television playing, keeping the reattach record so a reopened app can
   * take the controls back. Without it — the default, and what every failure path and the
   * selftest use — the device is stopped and released as it always was, because a harness
   * that left a TV playing is a harness nobody runs twice (13e).
   */
  dispose(options?: { readonly keepPlaying?: boolean }): Promise<void>;
}

export function createSessionSupervisor(deps: SessionSupervisorDeps): SessionSupervisor {
  const logger = deps.logger.child({ component: 'session' });
  const clock = deps.clock;
  const tracker: PositionTracker = createPositionTracker();

  let model: SessionModel = INITIAL_SESSION;
  let device: Device | null = null;
  let source: SessionSource | null = null;
  let connection: CastConnection | null = null;
  let mount: MediaMount | null = null;
  /**
   * The text track's own mount — a **second** published thing, and the first there has ever
   * been. `null` on every cast where subtitles are off, which is every cast until the
   * founder turns them on.
   */
  let subtitleMount: MediaMount | null = null;
  /**
   * **What the last LOAD actually declared**, and which rung of it is showing.
   *
   * The whole of story 20 turns on this pair. A television takes text tracks only in a LOAD
   * (SPIKE-3, 2026-08-26), so whether the founder's next press costs 11 ms or a reload is
   * decided by comparing what they want against what is already on the set — never by
   * re-sending and hoping.
   */
  let declaredSubtitle: SessionSubtitle | null = null;
  /**
   * Where the declared ladder is hung — `0` for a film nobody has adjusted.
   *
   * A ladder reaches ±3 s and 20e promises ±30 s, so a founder who has nudged past the end
   * gets a **new** ladder around where they have got to. That is what makes the reload cost
   * once per journey rather than once per press.
   */
  let declaredCentreMs = 0;
  let activeOffsetMs = 0;
  let subtitlesActive = false;
  /** What the founder wants, as of their last press. Reaches the device when SETTLE closes. */
  let wantedSubtitle: SessionSubtitle | null = null;
  /**
   * The coalescing window for subtitle changes — **`TIMING.seekSettleMs`, 20c's own 400 ms**.
   *
   * Its own timer rather than the reducer's `settleTimer`, and the distinction is real: the
   * reducer's window collapses taps into one *position*, which is a playback state the
   * founder is watching. An offset is not a playback state — nothing about *Playing* changes
   * because the words moved half a second — so routing it through the state machine would
   * add events to it that no screen reads. What 20c asks for is *"the same 400 ms window and
   * the same coalescing mechanism"*, and the mechanism is the rule, not the variable: **one
   * window is ever open, and a new press replaces it rather than queueing behind it**.
   */
  let subtitleSettleTimer: NodeJS.Timeout | null = null;
  /** A reload is in flight for a subtitle change — 19b's *stated*, not hidden, reload. */
  let subtitleReloading = false;
  let pollTimer: NodeJS.Timeout | null = null;
  let tickTimer: NodeJS.Timeout | null = null;
  /** The coalescing window. At most one is ever armed; a new tap replaces it. */
  let settleTimer: NodeJS.Timeout | null = null;
  /** Watches for a device that accepted the video and never fetched a byte of it. */
  let fetchWatchdog: NodeJS.Timeout | null = null;
  /**
   * The same question, asked about the **text track** — 18l.
   *
   * A television that took a LOAD with thirteen rungs on it and never fetched one of them is
   * a television that will show no words, and nothing else about the evening is wrong: the
   * picture and the sound are arriving from the same media server perfectly well. So this
   * watch says a sentence and touches nothing — it never stops, reloads or re-LOADs a film
   * that is playing, and it never reaches the state machine at all.
   */
  let subtitleFetchWatchdog: NodeJS.Timeout | null = null;
  /** True from the moment that watch expires unanswered until something replaces it. */
  let subtitleNotLoaded = false;
  /**
   * Waits, after a rejoin, to see whether the television comes back for the film itself.
   *
   * Defect D2: the control channel recovered in 243 ms and the film still died, because
   * the *device's* byte connection had been reset by the outage and the Default Media
   * Receiver never asks again. See `checkMediaPathAfterRecovery`.
   */
  let mediaRepairTimer: NodeJS.Timeout | null = null;
  /**
   * When the film was last re-handed to the television to repair its byte path.
   *
   * The guard against a repair loop, and it is a comparison rather than a counter: a
   * second repair happens only if the byte connection has been interrupted **again since**
   * this one — a repair that the television never even reached leaves nothing newer behind
   * it, so it cannot ask for another.
   */
  let mediaRepairedAtMono: number | null = null;
  /**
   * **Until when a delivery dying still belongs to the outage we have just come back from.**
   *
   * `null` outside a recovery, which is most of a film. The window is what makes the check
   * below a *watch* rather than a single glance — see `armMediaPathWatch` and the 229 ms
   * race it exists for.
   */
  let mediaPathWatchUntilMono: number | null = null;
  /** Whose recovery opened the window: a stale generation's watch is nobody's. */
  let mediaPathWatchGeneration = -1;
  /** When the rejoin that opened it happened, so the log can say how late the death was. */
  let mediaPathWatchFromMono: number | null = null;
  let queue: Promise<void> = Promise.resolve();
  /** Guards against a status from a previous connection landing in a new session. */
  let generation = 0;
  /** When Cast was pressed. Every cast-failure budget in the PRD is measured from here. */
  let castPressedAtMono: number | null = null;
  /**
   * Ticks the reducer while there is no connection to poll.
   *
   * The ordinary tick lives on the connection's generation and dies with it, but the
   * recovery deadlines — the takeover grace, the 30 s reconnect budget, the 30 s before
   * Windows' network settings are offered — all need a clock precisely when there is no
   * connection. This is that clock, and it stops the moment recovery ends.
   */
  let recoveryTicker: NodeJS.Timeout | null = null;
  /**
   * The recovery loop's own abort token, and the reason it is not a boolean.
   *
   * It used to be `let recovering = false`, and `release()` — a *third* function — set it
   * back to false. A loop sitting inside `await sleep(4_000)` knew nothing about that, so
   * a second loop could start, both could pass the `model.recovery === null` check and
   * both could assign `connection = established`. The first was never closed: a live TLS
   * socket with live handlers on the *current* generation, which later fired a spurious
   * `device.disconnected` and started a reconnection nobody needed.
   *
   * A cancelled run is cancelled for good. The loop re-checks its own token after every
   * await and closes anything it has established since.
   */
  interface RecoveryRun {
    cancelled: boolean;
  }
  let recoveryRun: RecoveryRun | null = null;
  /** Refreshes the reattach record's position, at a rate that is not a disk write a second. */
  let persistTimer: NodeJS.Timeout | null = null;
  /** The local address the media server is being reached on, from the live Cast socket. */
  let servingAddress: string | null = null;
  /**
   * Every usable IPv4 address on this machine, as the network watcher last saw them.
   *
   * `null` means nobody has told us yet — which is the case in every headless test that
   * does not care about the network. It must not read as "there are none", or a test with
   * no watcher would find every session declared offline the moment it connected.
   */
  let localAddresses: readonly string[] | null = null;
  /** Every address on the machine, loopback included — see `noteNetwork`. */
  let allLocalAddresses: readonly string[] = [];
  /** The device's own id for the running media session, for the reattach record. */
  let lastMediaSessionId: number | null = null;
  /**
   * M5a, 23b: the last volume a receiver status reported — the app's only source for the
   * number it shows. Cleared with the session, because 23i gives the control no life of
   * its own and 23g forbids a level surviving a reconnect.
   */
  let reportedVolume: ReportedVolume | null = null;

  /**
   * The one `SET_VOLUME` on the wire, and the one value waiting behind it — 23a.
   *
   * **A slot, not a queue, and the distinction is the criterion.** A 30-step drag produces
   * thirty asks and at most two of them ever exist here: the one the television is
   * answering, and the latest one the founder has reached. Everything in between is
   * overwritten, because a level nobody is asking for any more is not worth a message on
   * the socket that is carrying the film.
   */
  let volumeInFlight: {
    readonly seq: number;
    /** Which send this is for that `seq`: 1 is the command, 2 is 23d's single retry. */
    readonly attempt: number;
    readonly change: VolumeChange;
    /** What the set last reported *before* this command — 23d compares against this. */
    readonly reportedBefore: ReportedVolume | null;
    retried: boolean;
  } | null = null;
  let volumePending: VolumeChange | null = null;
  /** A mute press waiting behind an in-flight command. Its own slot — see `requestVolume`. */
  let pendingMute: VolumeChange | null = null;
  let volumeRetryTimer: NodeJS.Timeout | null = null;
  let volumeSeq = 0;
  /**
   * How many `SET_VOLUME`s have gone out since the television last answered anything.
   *
   * **23a's ceiling, made countable.** Without it the retry timer's "send the newer value
   * instead of the retry" branch issued a *fresh* command — new `seq`, new deadline, and so
   * a new timer that would substitute again 500 ms later. Against a set that answers, the
   * echo clears the slot and none of that happens. Against one that answers nothing, a
   * three-second drag put **seven** commands on the socket carrying the film, every one of
   * them still outstanding against the 5 s request timeout, which is precisely what 23a's
   * *"never two on the wire at once"* forbids.
   */
  let volumeUnanswered = 0;

  /**
   * Is there a film on this television right now whose volume the founder can see?
   *
   * **The same states the snapshot draws the control in, and never a yielded one** — which
   * is four, not the three this once listed. `buffering` was missing while `TRANSPORT_LIVE`
   * in the view model enabled the control there, so the founder saw a live slider whose
   * number could not follow anybody else's change. On the founder's own set that is not a
   * narrow window: **no television in this household announces a volume change** (SPIKE-5,
   * all three), so the poll is the only route 23c has, and a starving film can sit in
   * `buffering` indefinitely — that is defect D2's whole shape.
   */
  function volumeWorthPolling(): boolean {
    const state = model.state;
    if (model.flags.yielded) return false;
    return (
      state === 'playing' || state === 'paused' || state === 'seeking' || state === 'buffering'
    );
  }

  function clearVolumeRetry(): void {
    if (volumeRetryTimer === null) return;
    clearTimeout(volumeRetryTimer);
    volumeRetryTimer = null;
  }

  /**
   * **Did the television answer this command by moving?** 23d's whole distinction.
   *
   * A level that arrived somewhere *other* than what was asked for — clamped to 0, snapped
   * to the set's own 0.05 grid — **is the device's answer**, accepted permanently and never
   * retried. Only a set that did not move **at all** is a set that may not have heard, and
   * that is the only case worth one more message. Comparing against the *requested* level
   * instead would start a retry loop against every quantising television in the house, and
   * two of the founder's three quantise.
   */
  function volumeMovedSince(before: ReportedVolume | null, change: VolumeChange): boolean {
    const now = reportedVolume;
    if (now === null) return false;
    if ('muted' in change) return before === null || now.muted !== before.muted;
    // **Epsilon, not `!==`.** The Ultra reports one unchanged level as two different floats
    // (0.10000000149011612, then 0.09999999403953552), so an exact comparison decides "the
    // television moved" on float noise. See `CAST.volumeSameLevel` for what that did and,
    // equally, what it did not do — no 23d retry was missed, because that retry is triggered
    // by a non-answer and this set answers.
    if (before === null) return true;
    if (now.level === null || before.level === null) return now.level !== before.level;
    return Math.abs(now.level - before.level) > CAST.volumeSameLevel;
  }

  /**
   * One exchange is over. Send whatever the founder reached in the meantime.
   *
   * ⚠️ **`attempt` matters, and getting it wrong put two `SET_VOLUME`s on the wire.** The
   * retry deliberately keeps the original's `seq` — it is the same logical command — but
   * the original request is *still outstanding* against a 5 s timeout when the retry goes.
   * Settling on `seq` alone meant the original's eventual rejection cleared the **retry's**
   * record and immediately released the pending value, while the retry was still in flight.
   * That is the exact invariant 23a calls structural. Only the attempt that is currently
   * the live one may settle it.
   */
  function settleVolume(seq: number, attempt: number): void {
    if (volumeInFlight === null || volumeInFlight.seq !== seq) return;
    if (volumeInFlight.attempt !== attempt) return;
    volumeInFlight = null;
    // The television answered, so the wire is clear and the budget starts again.
    volumeUnanswered = 0;
    clearVolumeRetry();
    // The tick is cleared by the device's *answer*, not by the answer *matching* — so the
    // snapshot has to be republished when the exchange ends, whatever it ended as.
    deps.onChanged();
    // A mute goes first when both are waiting: it is a press of a distinct control, while
    // a pending level is the tail of a gesture the founder has already stopped making.
    const next = pendingMute ?? volumePending;
    if (pendingMute !== null) pendingMute = null;
    else volumePending = null;
    // The pending value is sent when the echo arrives, which is what makes the device's
    // own round trip the throttle. Nothing here is on a timer.
    if (next !== null) void issueVolume(next, { retry: false });
  }

  /**
   * Ask the television to change its volume — the **only** message M5a sends.
   *
   * Nothing here paints anything. The level on screen moves when a receiver status brings
   * a new one, and the echo of this command is exactly such a status, arriving by exactly
   * the same route as a change made from somebody's phone. That is 23b made structural:
   * there is no branch in this function that could show the founder a number we invented.
   */
  function requestVolume(change: VolumeChange): void {
    if (connection === null) {
      // 23i: no session to send over. A device somebody else is using never receives a
      // volume command from us (14b), and a control that is really `disabled` should
      // never have produced this call in the first place.
      logger.info('session.volume_ignored_no_connection', { change });
      return;
    }
    // **14b, and the engine is the only place it can be enforced.** The renderer's disabled
    // control is one IPC snapshot behind the takeover, and SPIKE-2 confirmed the socket
    // stays open through one — so `connection` is non-null while somebody else is watching.
    // The poll was already guarded against exactly this; the command was not.
    if (model.flags.yielded) {
      logger.info('session.volume_ignored_yielded', { change });
      return;
    }
    // **Push, so the ask actually reaches the screen.** §11's tick is the mark that says
    // *"asked, not yet answered"*, and it lives in the snapshot — so without a push here it
    // was only ever drawn if the position tick happened to fire inside the round trip. On a
    // set that answers in 4 ms it would essentially never have appeared, which would have
    // quietly deleted the feedback the whole control is shaped around.
    deps.onChanged();
    if (volumeInFlight !== null) {
      // **Two slots, not one, and not a queue either.** 23a's rule is that a change
      // replaces rather than queues, and it is written about *levels* — thirty drag steps
      // where only the last one matters. A mute is a different control (question 42), and
      // letting a later drag step overwrite it means a press that produced no message, no
      // sound and no feedback. Each kind holds at most one value; neither ever grows.
      if ('muted' in change) pendingMute = change;
      else volumePending = change;
      return;
    }
    void issueVolume(change, { retry: false });
  }

  async function issueVolume(change: VolumeChange, options: { retry: boolean }): Promise<void> {
    const active = connection;
    if (active === null) return;
    // **14b again, and here rather than only at the entry point.** `requestVolume` checks
    // `yielded`, but this function is also reached from `settleVolume` and from the retry
    // timer — two paths that fire *later*, after a takeover may have arrived. Today a null
    // `connection` usually catches it first, and that is timing rather than structure:
    // SPIKE-2 established that the socket **stays open** through a takeover, which is the
    // one arrival route where the backstop does not exist. A volume is never sent to a
    // television somebody else is watching.
    if (model.flags.yielded) {
      logger.info('session.volume_ignored_yielded', { change, deferred: true });
      return;
    }
    const seq = options.retry && volumeInFlight !== null ? volumeInFlight.seq : (volumeSeq += 1);
    const reportedBefore =
      options.retry && volumeInFlight !== null ? volumeInFlight.reportedBefore : reportedVolume;
    const attempt = (volumeInFlight?.seq === seq ? volumeInFlight.attempt : 0) + 1;
    volumeInFlight = { seq, attempt, change, reportedBefore, retried: options.retry };
    volumeUnanswered += 1;
    clearVolumeRetry();
    // **A deadline for every command that is not itself a retry**, which includes a newer
    // value substituted *for* a retry. That case used to be sent with `retry: true` and so
    // skipped the timer entirely — a level asked for at the worst possible moment was the
    // one level with none of 23d's protection, and if it was lost too, nothing re-sent it.
    if (!volumeInFlight.retried) {
      volumeRetryTimer = setTimeout(() => {
        volumeRetryTimer = null;
        const current = volumeInFlight;
        if (current === null || current.seq !== seq || current.retried) return;
        // **The ceiling, checked before anything is taken out of a pending slot** so that
        // bailing here strands nothing: whatever is waiting stays waiting, and `settleVolume`
        // sends it the moment an echo arrives. That is 23a's actual rule — *"the pending
        // value is sent when the echo arrives"* — and a television that has answered nothing
        // has not earned a third message. `VOLUME_MAX_UNANSWERED` is 2 because 23d mandates
        // exactly one retry, so two is the smallest number that can honour both criteria.
        if (volumeUnanswered >= VOLUME_MAX_UNANSWERED) return;
        // A newer value the founder has already reached beats re-asking for an older one:
        // 23d says the newer value is sent **instead of** the retry.
        const newer = pendingMute ?? volumePending;
        if (newer !== null) {
          if (pendingMute !== null) pendingMute = null;
          else volumePending = null;
          // Sent as its own command — same slot, its own deadline. 23d's "exactly one
          // retry" is about re-asking for a value the set ignored, and this is not that.
          void issueVolume(newer, { retry: false });
          return;
        }
        if (volumeMovedSince(current.reportedBefore, current.change)) {
          // It answered by moving. Whatever it landed on is its answer, and asking again
          // would be chasing a number this set will never report.
          return;
        }
        current.retried = true;
        logger.info('session.volume_retry', { change: current.change });
        void issueVolume(current.change, { retry: true });
      }, TIMING.volumeEchoMs);
      volumeRetryTimer.unref?.();
    }
    // **Logged as it leaves, not as it is asked for**, and that distinction is the whole
    // instrument: 23a's budget is measured from the command being sent, and the `volume`
    // scenario counts these to prove a thirty-step drag did not put thirty messages on the
    // socket carrying the film. A line emitted at the intent would count presses instead.
    const sentAtMono = clock.monoMs();
    // ⚠️ **`volumeLevel` and `commandSeq`, never `level` and `seq`.** Both of those are
    // names the logger stamps on every record itself, and a payload that uses one is
    // silently replaced rather than rejected. This line carried both: the level asked for
    // was overwritten by the severity `"info"`, and this command's sequence by the
    // logger's own line counter. `LogFields` now bans the names outright.
    logger.info('session.volume_sent', {
      ...('level' in change ? { volumeLevel: change.level } : { muted: change.muted }),
      retry: options.retry,
      commandSeq: seq,
    });
    try {
      // The answer is announced through `onReceiverStatus` like any other receiver status,
      // so `noteVolume` updates the screen. Nothing is read off the return value here for
      // display — only to know the exchange is over.
      await active.setVolume(change);
      logger.info('session.volume_echoed', {
        commandSeq: seq,
        elapsedMs: Math.round(clock.monoMs() - sentAtMono),
        ...('level' in change ? { asked: change.level } : { askedMuted: change.muted }),
        reportedLevel: reportedVolume?.level ?? null,
        reportedMuted: reportedVolume?.muted ?? null,
      });
    } catch (error) {
      logger.warn('session.volume_failed', {
        change,
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      settleVolume(seq, attempt);
    }
  }

  /**
   * **Forget everything about this television's volume, because the session is over.**
   *
   * 23g: nothing about a volume is persisted, and a level shown after a reconnect is read
   * fresh from the device rather than restored from anything CastGood kept. Without this
   * the last set's level survives into the next session — cast to one television at 20%,
   * stop, cast to another, and the app draws a handle at 20% on a set that never said so,
   * for as long as it takes the first poll to arrive. The comment beside `reportedVolume`
   * claimed this happened before it did.
   *
   * The command state goes with it for a sharper reason: a `volumeInFlight` left over from
   * a torn-down session makes the **next** session's first press sit unsent in the pending
   * slot until a dead request's 5 s timeout expires.
   */
  function forgetVolume(): void {
    reportedVolume = null;
    volumeInFlight = null;
    volumePending = null;
    // **`pendingMute` too, and leaving it out was a real defect.** It is the one piece of
    // volume state that lives outside `volumePending`, so a docstring promising "the command
    // state goes with it" was false for exactly one slot. A mute parked behind a command the
    // television never answered outlived `release()`, and the next session's first settled
    // level released it: a film muted with no press behind it, on a different set, possibly
    // on a different evening. 23g says nothing about volume survives a reconnect and 23f says
    // CastGood remembers nothing to mute with — this remembered the press itself.
    pendingMute = null;
    volumeUnanswered = 0;
    clearVolumeRetry();
  }

  /**
   * Is this the same level, treating "no level at all" as its own value?
   *
   * Two nulls are the same; a null beside a number never is, however small the number.
   */
  function sameLevel(before: number | null, now: number | null): boolean {
    if (before === null || now === null) return before === now;
    return Math.abs(before - now) <= CAST.volumeSameLevel;
  }

  function noteVolume(status: ReceiverStatus): void {
    const next: ReportedVolume = {
      level: status.volumeLevel,
      muted: status.muted,
      controlType: status.volumeControlType,
      stepInterval: status.volumeStepInterval,
    };
    const previous = reportedVolume;
    const same =
      previous !== null &&
      // Same epsilon, same reason: without it this set's float jitter publishes a fresh
      // snapshot and a `session.volume_reported` line for a level that did not move.
      //
      // **`null` and `0` are compared as the different things they are.** `?? 0` on both
      // sides graded *"the set stopped reporting a level"* and *"the set is reporting
      // silence"* as the same reading, and the readout then kept a stale number. `cast/`
      // goes out of its way to keep absent and zero apart — an absent `volume` object
      // yields nulls, never zeros — and this was the one place that undid it.
      sameLevel(previous.level, next.level) &&
      previous.muted === next.muted &&
      previous.controlType === next.controlType &&
      previous.stepInterval === next.stepInterval;
    if (same) return;
    reportedVolume = next;
    // **`volumeLevel`, not `level`.** The logger writes its own identity last so a payload
    // cannot rename the line it sits on — a key called `event` once made
    // `session.state_changed` vanish entirely. `level` is on that same reserved list, and it
    // is also the most natural name for a volume, so this call silently logged the *severity*
    // in its place: every M5a record read `"level":"info"` and the one number the milestone is
    // about never reached the log at all. Found on 2026-09-08 trying to corroborate human
    // checklist item 3 from the log, which is one of the three ways anything here is verified.
    // `LogFields` now rejects the reserved names outright, so this cannot come back quietly.
    logger.info('session.volume_reported', {
      volumeLevel: next.level,
      muted: next.muted,
      controlType: next.controlType,
      stepInterval: next.stepInterval,
    });
    deps.onChanged();
  }

  function clearSettle(): void {
    if (settleTimer !== null) clearTimeout(settleTimer);
    settleTimer = null;
  }

  function clearFetchWatchdog(): void {
    if (fetchWatchdog !== null) clearTimeout(fetchWatchdog);
    fetchWatchdog = null;
  }

  /**
   * Stop watching for a track the television never came back for, and forget that it didn't.
   *
   * Called wherever the declaration itself stops being true — a new LOAD, the words being
   * turned off, the session ending — because the sentence is about *this* declaration and
   * nothing else. A founder who turns subtitles off has answered the question themselves.
   */
  function clearSubtitleFetchWatch(): void {
    if (subtitleFetchWatchdog !== null) clearTimeout(subtitleFetchWatchdog);
    subtitleFetchWatchdog = null;
    if (subtitleNotLoaded) {
      subtitleNotLoaded = false;
      deps.onChanged();
    }
  }

  function clearMediaRepairTimer(): void {
    if (mediaRepairTimer !== null) clearTimeout(mediaRepairTimer);
    mediaRepairTimer = null;
  }

  function closeMediaPathWatch(): void {
    mediaPathWatchUntilMono = null;
    mediaPathWatchFromMono = null;
  }

  function stopRecoveryTicker(): void {
    if (recoveryTicker !== null) clearInterval(recoveryTicker);
    recoveryTicker = null;
  }

  function stopPersistTimer(): void {
    if (persistTimer !== null) clearInterval(persistTimer);
    persistTimer = null;
  }

  function stopTimers(): void {
    if (pollTimer !== null) clearInterval(pollTimer);
    if (tickTimer !== null) clearInterval(tickTimer);
    pollTimer = null;
    tickTimer = null;
    clearSettle();
    clearFetchWatchdog();
    clearMediaRepairTimer();
  }

  /**
   * Drop the socket and keep the session.
   *
   * The difference from `release()` is the whole of story 11: the file stays mounted (the
   * television is still fetching from it), the device stays ours, and the position tracker
   * keeps running — because SPIKE-2 confirmed the film really does keep playing on the TV
   * while our socket is dead, to within 0.003 s over a 15-second outage. Freezing the
   * readout would show a stopped clock and then jump fifteen seconds on reconnect.
   */
  async function closeConnectionOnly(): Promise<void> {
    generation += 1;
    stopTimers();
    const current = connection;
    connection = null;
    // **`servingAddress` deliberately survives this.** It is the *only* signal that works
    // on the founder's own machine (see `src/engine/network/index.ts`), and recovery calls
    // this before its first probe — so clearing it here meant the signal was gone from the
    // instant an interruption began, exactly when 11d needs it. Their PC keeps
    // `vEthernet (WSL) 172.24.16.1` when the Ethernet is unplugged, so "some interface has
    // an address" said *online*, the give-up clock was never suspended, and at 30 s the
    // television was blamed for an unplugged cable. The address is replaced by the next
    // connection and cleared by `release()`, where the session really is over.
    if (current !== null) {
      await current
        .close()
        .catch((error: unknown) => logger.warn('session.close_failed', { error }));
    }
  }

  /**
   * Let go of the text track's mount, if there is one.
   *
   * Called from `release()` and from the top of every load: a reconnect-and-resume issues a
   * second LOAD, and a mount left behind from the first would be a URL nobody is fetching
   * kept alive for the rest of the session.
   */
  function unmountSubtitle(): void {
    if (subtitleMount === null) return;
    deps.mediaServer.unmount(subtitleMount.token);
    subtitleMount = null;
  }

  /** Nothing is declared on the television any more, so nothing can be switched to. */
  function forgetDeclaredSubtitle(): void {
    declaredSubtitle = null;
    declaredCentreMs = 0;
    subtitlesActive = false;
    activeOffsetMs = 0;
    // 18l's sentence is about a declaration, so it goes when the declaration does. Every
    // LOAD passes through here on its way to declaring a new ladder, which is what makes a
    // retry — and an ordinary reload — start the question again rather than inherit an
    // answer given about a track that is no longer on the set.
    clearSubtitleFetchWatch();
  }

  function clearSubtitleSettle(): void {
    if (subtitleSettleTimer !== null) clearTimeout(subtitleSettleTimer);
    subtitleSettleTimer = null;
  }

  async function release(): Promise<void> {
    generation += 1;
    stopTimers();
    forgetVolume();
    stopPersistTimer();
    cancelRecovery();
    // The session is over: the readout must stop moving. The device will send no further
    // corrections, so an un-frozen tracker would extrapolate forever from the last
    // "PLAYING" it heard and the Stopped screen would show a position that keeps rising.
    tracker.freeze(clock.monoMs());
    const current = connection;
    connection = null;
    if (current !== null) {
      await current
        .close()
        .catch((error: unknown) => logger.warn('session.close_failed', { error }));
    }
    if (mount !== null) {
      deps.mediaServer.unmount(mount.token);
      mount = null;
    }
    unmountSubtitle();
    forgetDeclaredSubtitle();
    clearSubtitleSettle();
    clearMediaRepairTimer();
    closeMediaPathWatch();
    mediaRepairedAtMono = null;
    wantedSubtitle = null;
    subtitleReloading = false;
    deps.onDeviceInUse?.(null);
    device = null;
    servingAddress = null;
    // Nothing to come back to. Story 12b's silence is this line: a reopened app with no
    // record does not show a reattach screen, an error, or anything at all.
    deps.onSessionChanged?.(null);
  }

  /**
   * Is this PC still on the network it is serving from? (11d)
   *
   * Re-asked whenever either half of the question changes: the address set (the watcher)
   * or the address we are serving on (a new connection, possibly on a different adapter).
   */
  function reviewNetwork(): void {
    const addresses = localAddresses;
    if (addresses === null) return;
    const serving = servingAddress;
    // The serving address is checked against the **unfiltered** set. It comes from the live
    // Cast socket, and the OS is entitled to have chosen an address the discovery filter
    // excludes — loopback, when the receiver is on this machine. Asking the filtered list
    // declared the PC offline mid-stream and refused every seek with "this PC is offline".
    const online =
      addresses.length > 0 && (serving === null || allLocalAddresses.includes(serving));
    // Nothing changed, so nothing is dispatched — a no-op event would still push a
    // snapshot, and a snapshot pushed for nothing is a revision number that lies about
    // how much the world moved.
    if (online === !model.flags.networkDown) return;
    dispatch({ type: 'network.changed', online, monoMs: clock.monoMs() });
  }

  function handleStatus(status: MediaStatus, forGeneration: number): void {
    if (forGeneration !== generation) return;
    lastMediaSessionId = status.mediaSessionId;

    // An IDLE status is the device's last word on a session, and the last chance to learn
    // where it actually stopped. But "the device said so" is not the same as "the device
    // knew": the founder's TV answers a stop at 402.678 s with `currentTime: 0`, and
    // believing that put 0:00:00 on the Stopped screen of a film they had watched for
    // seven minutes. Stopping cannot move the playhead backwards, so a position from well
    // behind where we already were is a device resetting itself, not a measurement.
    //
    // In order of how much the device really told us:
    //  1. FINISHED — the file played out, so the place it stopped is the end of it.
    //  2. A position that is not implausibly behind what we knew — believe it, and resume
    //     from it. Note this accepts a genuine 0 at the very start of a file.
    //  3. Anything else — keep what we had and stop the clock, rather than carry on
    //     extrapolating for a device that has plainly stopped playing.
    if (status.playerState === 'IDLE') {
      const knownSec = tracker.positionAt(status.receivedAtMono);
      const reported = status.currentTimeSec;
      const finished = status.idleReason === 'FINISHED' && tracker.durationSec > 0;
      const believable =
        reported !== null && reported >= knownSec - TIMING.finalPositionToleranceSec;

      let acceptedSec: number | null = null;
      if (finished) {
        acceptedSec = tracker.durationSec;
      } else if (believable) {
        acceptedSec = reported;
      }

      if (acceptedSec !== null) {
        tracker.anchor({
          reportedSec: acceptedSec,
          receivedAtMono: status.receivedAtMono,
          durationSec: status.durationSec,
          playing: false,
        });
      } else {
        tracker.freeze(status.receivedAtMono);
      }

      logger.info('position.sample', {
        playerState: status.playerState,
        // Logged even though it is usually the last line about this session: without it
        // there was no way to tell from a real run whether the device reports a final
        // position at all — and the answer turned out to be "yes, and it is wrong".
        deviceSec: reported === null ? null : Math.round(reported * 1000) / 1000,
        acceptedSec: acceptedSec === null ? null : Math.round(acceptedSec * 1000) / 1000,
        rejectedDeviceSec: reported !== null && acceptedSec !== reported,
        knownSec: Math.round(knownSec * 1000) / 1000,
        divergenceSec: null,
        snapped: false,
        idleReason: status.idleReason,
        durationSec: status.durationSec,
        monoMs: Math.round(status.receivedAtMono),
      });
      dispatch({
        type: 'device.idle',
        idleReason: status.idleReason,
        positionSec: acceptedSec,
      });
      return;
    }

    const reportedSec = status.currentTimeSec;
    const anchored =
      reportedSec === null
        ? null
        : tracker.anchor({
            reportedSec,
            receivedAtMono: status.receivedAtMono,
            durationSec: status.durationSec,
            playing: status.playerState === 'PLAYING',
          });

    // The line the selftest's position scenario reads its numbers from: what the device
    // said, and how far our display had got from it at that instant. A status without a
    // position reports `null` rather than a number nobody sent.
    //
    // `heldForSeek` is what the `seek` scenario reads: it is the difference between a
    // device that has not answered a jump yet and one that has answered it wrongly.
    logger.info('position.sample', {
      playerState: status.playerState,
      deviceSec: reportedSec === null ? null : Math.round(reportedSec * 1000) / 1000,
      divergenceSec:
        anchored?.divergenceSec == null ? null : Math.round(anchored.divergenceSec * 1000) / 1000,
      snapped: anchored?.snapped ?? false,
      heldForSeek: anchored?.heldForSeek ?? false,
      seekConfirmed: anchored?.seekConfirmed ?? false,
      seekTargetSec: tracker.seekTargetSec,
      durationSec: status.durationSec,
      monoMs: Math.round(status.receivedAtMono),
    });

    const position = tracker.position;
    if (position === null) return;
    dispatch({
      type: 'device.status',
      playerState: status.playerState,
      position,
      // When the status arrived, not the anchor inside it. A device that reports no
      // position never re-anchors, so `position.reportedAtMono` can be minutes old.
      monoMs: status.receivedAtMono,
      // A status that arrived with no position at all tells us nothing about whether the
      // jump landed, so it must not be read as confirmation of one.
      seekHeld: anchored === null ? tracker.seekTargetSec !== null : anchored.heldForSeek,
    });
  }

  function startLoops(forGeneration: number): void {
    stopTimers();
    pollTimer = setInterval(() => {
      if (forGeneration !== generation || connection === null) return;
      void connection
        .getStatus()
        .then((status) => {
          if (status !== null) handleStatus(status, forGeneration);
        })
        .catch((error: unknown) => {
          logger.debug('session.poll_failed', { error });
        });
      // **M5a, 23c: ask the receiver too, and only while a film is actually on.**
      //
      // This is the one thing SPIKE-5 found that the spec had costed but not located. The
      // PRD reasoned that a poll-only television is nearly free because "the supervisor
      // already runs an explicit GET_STATUS every second" — but that poll is on the
      // **media** namespace, and a volume lives on the **receiver**. The founder's own
      // `AI PONT` never volunteers a receiver status at all (15 s of silence after a second
      // sender moved the level, then a poll read it in 8 ms), so without this line a change
      // made from a phone could never reach the screen and 23c would be unbuildable on
      // their main television.
      //
      // **Bounded to a live film on purpose**, and the bound is doing real work:
      //  · 23i — a volume exists only where a session does, so there is nothing to ask
      //    about anywhere else.
      //  · 14b — a television somebody else has taken is asked nothing further, ever.
      //  · and the release probe's own silence after a session ends is unchanged, which is
      //    a promise `cast-session.test.ts` already grades on the wire.
      if (!volumeWorthPolling()) return;
      void connection.getReceiverStatus().catch((error: unknown) => {
        logger.debug('session.volume_poll_failed', { error });
      });
    }, TIMING.statusReanchorMs);
    pollTimer.unref?.();

    tickTimer = setInterval(
      () => {
        if (forGeneration !== generation) return;
        dispatch({ type: 'timer.tick', monoMs: clock.monoMs() });
        deps.onChanged();
      },
      Math.round(1000 / TIMING.positionTickHz),
    );
    tickTimer.unref?.();
  }

  /**
   * One connection attempt, with the handlers every session uses.
   *
   * Shared by the first cast, by recovery and by reattach on purpose: three code paths
   * with three copies of "what does a device status mean" is three chances for them to
   * disagree about who ended a session, which is the one distinction M2 rests on.
   */
  function establish(target: Device, forGeneration: number): Promise<CastConnection> {
    return deps.cast.connect(target, {
      onMediaStatus: (status) => handleStatus(status, forGeneration),
      onReceiverStatus: (status) => {
        // `appId: null` means the TV is back on its own home screen. It is the only
        // device-side evidence that Stop released it, so it is logged every time —
        // the selftest measures criterion 4b from this line.
        logger.info('session.receiver_status', {
          appId: status.appId,
          appName: status.appName,
          monoMs: Math.round(status.receivedAtMono),
          // **What the poll actually read**, which until 2026-09-08 this line did not say.
          // 23c rests entirely on this poll — the founder's sets never announce a volume
          // change, they only answer when asked — and `noteVolume` below logs only when the
          // level *moves*. So a window of polls that saw nothing and a window of polls that
          // were never told anything produced identical logs, and the difference between
          // "the app missed a change" and "no change ever reached this television" could
          // not be read back. That distinction cost a debugging session on the night 23c
          // was found to have been measured against the wrong set entirely.
          // `volumeLevel`, not `level`: the logger's reserved names would silently replace it.
          volumeLevel: status.volumeLevel,
          volumeMuted: status.muted,
        });
        // M5a: the volume this handler used to drop on the floor. Held beside the model,
        // never reduced into it (23k), and republished only when it actually moved —
        // this arrives on every poll, and a snapshot pushed for nothing is a revision
        // number that lies about how much the world moved.
        if (forGeneration === generation) noteVolume(status);
        // The same question the recovery probe asks, asked the same way: a television on
        // its Backdrop screensaver has not been taken over by anybody.
        if (isTakeoverApp(status.appId, status.appName)) {
          logger.info('session.other_app_on_device', {
            appId: status.appId,
            appName: status.appName,
          });
          if (forGeneration !== generation) return;
          // A takeover announced on a socket that is still up. SPIKE-2 saw the socket stay
          // open through a takeover (`socketClosed: false`), so this is a real arrival
          // route and not only a thing recovery discovers — and it is the *fastest* one,
          // which is what keeps 14a inside "≤2 s of the device reporting it".
          dispatch({
            type: 'recovery.yielded',
            appId: status.appId ?? 'unknown',
            appName: status.appName,
            atSec: savedPositionSec(),
          });
        }
      },
      onDisconnected: (info) => {
        if (forGeneration !== generation) return;
        if (info.deviceInitiated) {
          // The device closed the session in an orderly way. **Which** orderly reason —
          // the founder stopping it on the TV, or somebody taking the television — is not
          // knowable yet; see `device.ended_session` in the reducer.
          dispatch({
            type: 'device.ended_session',
            reason: info.reason,
            monoMs: clock.monoMs(),
            // The position on screen at the close. It goes on the *Stopped* screen the
            // founder's 2026-08-18 ruling puts up immediately, and it has to survive if
            // that screen is later corrected to a takeover.
            atSec: savedPositionSec(),
          });
          return;
        }
        dispatch({
          type: 'device.disconnected',
          reason: info.reason,
          userMessage: `Lost connection to ${target.friendlyName}`,
          monoMs: clock.monoMs(),
        });
      },
    });
  }

  async function connectWithRetries(deviceId: string): Promise<void> {
    const target = device;
    if (target === null || target.id !== deviceId) {
      throw new EngineError('INTERNAL', 'no device selected for this session');
    }
    const forGeneration = generation;
    let lastError: unknown = null;

    // PRD 3b: two *silent* retries. The founder never sees a retry counter — the whole
    // sequence is one "Connecting to <name>…" and must fit inside 15 seconds.
    for (let attempt = 0; attempt <= CAST.connectRetries; attempt += 1) {
      if (forGeneration !== generation) return;
      try {
        const established = await establish(target, forGeneration);
        if (forGeneration !== generation) {
          await established.close({ announce: false });
          return;
        }
        connection = established;
        servingAddress = established.localAddress;
        reviewNetwork();
        logger.info('session.connected', {
          deviceId,
          attempt,
          localAddress: established.localAddress,
        });
        startLoops(forGeneration);
        dispatch({ type: 'device.connected' });
        return;
      } catch (error) {
        lastError = error;
        logger.warn('session.connect_attempt_failed', { deviceId, attempt, error });
        if (attempt < CAST.connectRetries) {
          await new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, CAST.connectRetryDelayMs);
            timer.unref?.();
          });
        }
      }
    }

    dispatch({
      type: 'device.connect_failed',
      reason: lastError instanceof Error ? lastError.message : String(lastError),
      userMessage: `Couldn't reach ${target.friendlyName}`,
    });
  }

  /**
   * The ceiling on one LAUNCH attempt. `CAST.launchTimeoutMs` unless a test shortened it.
   */
  const launchCeilingMs = deps.launchTimeoutMs ?? CAST.launchTimeoutMs;

  /**
   * What is left of the founder's wait for a picture, on the monotonic clock.
   *
   * Measured from the Cast press, because that is when the founder started waiting — the
   * same anchor the firewall diagnosis uses. Negative means the budget is spent.
   */
  function remainingCastBudgetMs(): number {
    const pressedAt = castPressedAtMono;
    if (pressedAt === null) return TIMING.castUnreachableBudgetMs;
    return pressedAt + TIMING.castUnreachableBudgetMs - clock.monoMs();
  }

  /**
   * Wake the television's receiver, retrying silently when it does not answer (PRD 3b).
   *
   * **This is the retry the PRD promised and did not have.** `connectWithRetries` covers
   * the TCP/TLS handshake — 181 ms on the founder's hardware, and the step least likely to
   * fail — while the LAUNCH that follows it, the slowest exchange in the protocol at
   * 6–14 s, had exactly one chance. On 2026-08-18 a television idle for 56 minutes did not
   * answer inside 10 s and the founder was told "Couldn't reach \<name\>" about a
   * working television, with no retry attempted at all.
   *
   * **On the same connection, deliberately.** The socket was demonstrably alive through the
   * whole failure — it was answering the keep-alive, and a dead one is the heartbeat's job
   * (11f), not this. A second LAUNCH of `CC1AD845` is also the one exchange that is safe to
   * repeat: a real receiver answers a LAUNCH of an app it is already running with that
   * app's status, immediately, so a first attempt that landed late costs the retry nothing
   * and leaves no second receiver behind. Re-connecting instead would throw away a healthy
   * socket, and closing it means bumping the generation — which would abandon the very cast
   * this is trying to rescue.
   *
   * Nothing here is dispatched, so nothing here is visible: the founder stays on one
   * continuous *Connecting to \<name\>…* for the whole sequence, with no counter.
   */
  async function launchWithRetries(
    current: CastConnection,
    forGeneration: number,
  ): Promise<'launched' | 'abandoned'> {
    // A retry that cannot outlast the fastest boot ever measured cannot succeed. Clamped
    // to the ceiling so a shortened timeout does not silently disable retrying.
    const minAttemptMs = Math.min(CAST.launchMinAttemptMs, launchCeilingMs);
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= CAST.launchRetries; attempt += 1) {
      if (forGeneration !== generation) return 'abandoned';
      // The first attempt always gets the full timeout: the founder has waited ~0.2 s at
      // this point, and a budget that looks spent already is a clock fault, not a slow TV.
      const timeoutMs =
        attempt === 0 ? launchCeilingMs : Math.min(launchCeilingMs, remainingCastBudgetMs());
      if (attempt > 0 && timeoutMs < minAttemptMs) {
        logger.warn('session.launch_budget_spent', {
          attempt,
          remainingMs: Math.round(remainingCastBudgetMs()),
        });
        break;
      }
      logger.info('session.launch_attempt', { attempt, timeoutMs: Math.round(timeoutMs) });
      try {
        await current.launchDefaultReceiver(timeoutMs);
        if (forGeneration !== generation) return 'abandoned';
        if (attempt > 0) logger.info('session.launch_retry_succeeded', { attempt });
        return 'launched';
      } catch (error) {
        if (forGeneration !== generation) return 'abandoned';
        // Only "the device did not answer" is retried. A refusal is an answer, and
        // repeating a question that was answered is how an app fights a television.
        if (!isEngineError(error) || error.code !== 'DEVICE_UNREACHABLE') throw error;
        lastError = error;
        logger.warn('session.launch_attempt_failed', {
          attempt,
          timeoutMs: Math.round(timeoutMs),
          error,
        });
      }
    }

    throw (
      lastError ??
      new EngineError('DEVICE_UNREACHABLE', 'device did not answer LAUNCH', {
        userMessage: `Couldn't reach ${device?.friendlyName ?? 'the device'}`,
      })
    );
  }

  /**
   * Can the founder's wish be granted with a message, or does it cost a load?
   *
   * Two things have to be true: the ladder on the television has to be a ladder for **this
   * source** — a different subtitle was never declared, and cannot be handed over now — and
   * the offset has to be a rung that ladder actually holds. Anything else is a reload.
   */
  function reachableBySwitch(wanted: SessionSubtitle): boolean {
    return (
      declaredSubtitle !== null &&
      declaredSubtitle.key === wanted.key &&
      rungFor(wanted.offsetMs, declaredCentreMs) !== null
    );
  }

  /**
   * Put the television where the founder's last press asked for — **19b and 20b**.
   *
   * Three outcomes, and which one happens is the whole of what SPIKE-3 bought:
   *
   *  - **Off** — one `EDIT_TRACKS_INFO` with no active track. The words stop and the film
   *    does not flinch. 19b's promise, kept exactly as written.
   *  - **A rung of the ladder already on the set** — one `EDIT_TRACKS_INFO` naming it. This
   *    is every nudge inside ±3 s, and it is the case the ladder exists to make cheap.
   *  - **Anything else** — a subtitle chosen mid-film, or an offset past the ladder — **one
   *    reload at the remembered position**, on the live session. Stated to the founder
   *    rather than hidden, which is the condition they accepted it under.
   *
   * **The reload must never restart the session.** `cast()` calls `release()`, `release()`
   * reaches `stopped`, and `stopped` discards a head start — so a reload that went the
   * obvious way would delete a conversion the founder is watching. It goes through
   * `loadCurrentSource` on the connection that is already open, which is also why it costs
   * 2–2.5 s rather than the 4–5 s a receiver reboot costs.
   */
  async function applySubtitle(): Promise<void> {
    const current = connection;
    // No television in the room. The wish is not lost — the next LOAD carries it, which is
    // the ordinary case of choosing subtitles before pressing Cast, and it costs nothing.
    if (current === null) return;
    const wanted = wantedSubtitle;

    if (wanted === null) {
      // The founder answered 18l's question themselves. Nothing is showing, so there is
      // nothing left to report as not having loaded.
      clearSubtitleFetchWatch();
      if (!subtitlesActive) return;
      subtitlesActive = false;
      logger.info('subtitle.deactivated', {});
      await current.setActiveTracks([]).catch((error: unknown) => {
        logger.warn('subtitle.deactivate_failed', { error });
      });
      return;
    }

    if (reachableBySwitch(wanted)) {
      const rung = rungFor(wanted.offsetMs, declaredCentreMs);
      if (rung === null) return;
      if (subtitlesActive && activeOffsetMs === rung.offsetMs) return;
      subtitlesActive = true;
      activeOffsetMs = rung.offsetMs;
      // **The rung the founder moved to belongs to the source, not just to this
      // connection.** `loadCurrentSource` hangs its ladder around `source.subtitle.offsetMs`
      // — *"not around zero"*, in its own words — and `liveSessionInfo` writes that same
      // number into the record a reopened app reattaches from. A switch that updated
      // neither left both still describing the offset of the **last LOAD**, so anything
      // that re-declared the ladder afterwards put the words back at *in sync* and threw
      // the founder's correction away without a word on screen.
      //
      // Found on the `Chromecast`, 2026-09-02: a media repair three seconds after a
      // nudge re-loaded at 0 and the reattach that followed restored 0. The repair path is
      // the common way in, but every re-LOAD shares it — this is the invariant, kept where
      // the rung actually changes rather than patched at each place that reads it.
      if (source !== null && source.subtitle !== undefined) {
        source = { ...source, subtitle: { ...source.subtitle, offsetMs: rung.offsetMs } };
      }
      const began = clock.monoMs();
      await current.setActiveTracks([rung.trackId]).catch((error: unknown) => {
        logger.warn('subtitle.switch_failed', { error });
      });
      // **The number 20b is measured against**, and it is measured here rather than
      // inferred: SPIKE-3 saw 11–36 ms on hardware and the criterion promises 2 s.
      logger.info('subtitle.switched', {
        trackId: rung.trackId,
        offsetMs: rung.offsetMs,
        elapsedMs: Math.round(clock.monoMs() - began),
      });
      // Written down on the press, for the same reason the offset store is (20f): the
      // founder's evening can end in a way no shutdown path sees, and the ten-second
      // persist timer is a ten-second window in which this correction does not exist.
      persistSession();
      return;
    }

    const file = source;
    if (file === null) return;
    // Where the founder actually is, so the reload lands there and not at the opening
    // titles — measured at 0 s error on all three televisions on 2026-08-26.
    const resumeAt = tracker.positionAt(clock.monoMs());
    subtitleReloading = true;
    deps.onChanged();
    logger.info('subtitle.reloading', {
      why:
        declaredSubtitle === null || declaredSubtitle.key !== wanted.key
          ? 'new-track'
          : 'off-ladder',
      offsetMs: wanted.offsetMs,
      positionSec: Math.round(resumeAt * 1000) / 1000,
    });
    source = { ...file, subtitle: wanted };
    try {
      await loadCurrentSource(resumeAt, { supersedes: 'subtitle' });
    } finally {
      subtitleReloading = false;
      deps.onChanged();
    }
  }

  /**
   * **What this LOAD is replacing on a television that is already playing a film.**
   *
   * Absent for the first LOAD of a session, which replaces nothing. Present for the two
   * that land underneath a playing film — a media path being mended (D2) and a subtitle
   * chosen mid-film or nudged past the ladder (19b/20b) — and it does two things.
   *
   * **It tells the reducer the LOAD is ours.** A receiver takes a new LOAD by ending the
   * media session it is holding and reporting it as `IDLE`/`INTERRUPTED`; without that
   * being knowable the session reads it as the television abandoning the film, stops, and —
   * on 2026-08-28, on the founder's own set, 101 ms after a repair that worked — writes a
   * `session.refused_mid_play` that voids the whole run through 13g. See `LiveLoadModel`.
   *
   * **And `repair` changes what a failure may put on the screen.** A repair the television
   * refuses is an interruption still in progress, not a film that cannot be played — 11a
   * promises nothing turns red during a blip, and 11c promises the founder hears *"Lost
   * connection"* after ~30 s rather than a *"Couldn't play this file"* the moment a
   * half-returned network refuses a LOAD. The recovery deadline is the thing that speaks;
   * this stays quiet and lets it.
   */
  interface LoadOptions {
    readonly supersedes?: 'repair' | 'subtitle';
  }

  async function loadCurrentSource(
    startPositionSec: number,
    options: LoadOptions = {},
  ): Promise<void> {
    const current = connection;
    const file = source;
    const target = device;
    if (current === null || file === null || target === null) return;
    const forGeneration = generation;
    // **Kept, not dropped.** A LOAD issued on a live session — a subtitle chosen mid-film,
    // an offset past the ladder — replaces this without a `release()` in between, and a
    // mount overwritten rather than unmounted is a URL nobody is fetching kept alive for the
    // rest of the evening. It is let go *after* the new one is published, so the television
    // is never between two working URLs.
    const previousMount = mount;
    // **Before a byte of it goes out**, exactly as `intent.stop` moves the model before the
    // device's reply can arrive. The television's answer to this LOAD — an `IDLE` for the
    // media session it is superseding — can be back in 101 ms, and by then the reducer has
    // to already know whose it is.
    const supersedes = options.supersedes;
    if (supersedes !== undefined) {
      dispatch({ type: 'session.live_load_started', why: supersedes, monoMs: clock.monoMs() });
    }

    try {
      await deps.mediaServer.start();
      mount = deps.mediaServer.mount({
        path: file.path,
        kind: file.hls === undefined ? 'file' : 'hls',
      });
      const url = deps.mediaServer.urlFor(mount, current.localAddress);
      // **The track is published beside the film, and it changes nothing about the film.**
      // Same mount, same URL, same content type, same start position, with or without it
      // (18e). One derived mount is all a text track costs — and all thirteen rungs of it.
      unmountSubtitle();
      forgetDeclaredSubtitle();
      const subtitle = file.subtitle;
      let tracks: readonly LoadTrack[] | undefined;
      let activeTrackId: number | null = null;
      if (subtitle !== undefined) {
        // **The ladder, declared in full, because a television will not take one later.**
        // Thirteen rungs at 0.5 s spacing across ±3 s, each a URL that names its own offset,
        // all shifted from one cue list held in memory. The cost is thirteen small fetches
        // at load; what it buys is a nudge that costs a track switch — 11–36 ms, measured on
        // all three sets — instead of stopping the film (2026-08-26 ADR).
        subtitleMount = deps.mediaServer.mount({
          kind: 'subtitles',
          cues: subtitle.cues,
          name: `${subtitle.name}.vtt`,
        });
        const publishedMount = subtitleMount;
        // Hung around what the founder has actually nudged to, not around zero: a reload
        // that landed them back at *in sync* would undo the very adjustment that caused it.
        const centreMs = ladderCentreFor(subtitle.offsetMs);
        tracks = buildLadder(centreMs).map((rung) => ({
          trackId: rung.trackId,
          type: 'TEXT',
          trackContentId: deps.mediaServer.subtitleUrlFor(
            publishedMount,
            current.localAddress,
            rung.offsetMs,
          ),
          trackContentType: 'text/vtt',
          subtype: 'SUBTITLES',
          // The set's *own* track menu lists all thirteen. Naming them by their offset is
          // what keeps that menu readable instead of thirteen rows reading "English".
          name: rungLabel(subtitle.name, rung.offsetMs),
          language: subtitle.language,
        }));
        // The centre is chosen so the founder's own offset is always one of the rungs, at
        // every offset 20e allows — so this never falls back and never silently shows them
        // a correction they did not ask for.
        activeTrackId = rungFor(subtitle.offsetMs, centreMs)?.trackId ?? null;
        declaredCentreMs = centreMs;
      }
      // **CastGood owns the clock** (10c). Seeded before the LOAD, so the scrubber has a
      // length from the first frame rather than after the first status — the device will
      // never supply one for this shape, and a scrubber with no duration cannot be dragged.
      if (file.durationSec !== undefined && file.durationSec > 0) {
        tracker.seedDuration(file.durationSec);
      }
      logger.info('session.loading', {
        url,
        deviceId: target.id,
        file: file.name,
        startPositionSec: Math.round(startPositionSec * 1000) / 1000,
      });

      if ((await launchWithRetries(current, forGeneration)) === 'abandoned') return;
      if (forGeneration !== generation) return;
      // The receiver really is up now, so *Starting on \<name\>… — the TV has been
      // reached* is true when it is said, and everything before it was one *Connecting…*.
      dispatch({ type: 'device.launched' });

      // Clamped to what is left of the founder's wait, so a LOAD that hangs after a slow
      // LAUNCH cannot push the whole cast past the bound the ruling put on it.
      const loadTimeoutMs = Math.min(
        CAST.loadTimeoutMs,
        Math.max(CAST.loadMinTimeoutMs, remainingCastBudgetMs()),
      );
      const status = await current.load(
        {
          contentUrl: url,
          // Exactly what the media server will answer with for this file. Hardcoding
          // `video/mp4` made the receiver refuse a WebM it plays perfectly well, because it
          // trusts the LOAD metadata over the response header — which is why a growing
          // conversion declares the playlist's type and not the directory's.
          contentType: contentTypeFor(file.hls === undefined ? file.path : mount.name),
          streamType: 'BUFFERED',
          // 16c: a Resume lands *at* the position. Loading at 0 and seeking afterwards would
          // show the founder the opening of the film before jumping — which the criterion
          // rules out in as many words.
          startPositionSec,
          autoplay: true,
          title: file.name,
          // Absent, never empty. `activeTrackIds: []` is not "off": SPIKE-3 measured four
          // declared tracks being fetched anyway on all three televisions when it was sent.
          ...(tracks === undefined || activeTrackId === null
            ? {}
            : { tracks, activeTrackIds: [activeTrackId] }),
        },
        loadTimeoutMs,
      );
      if (forGeneration !== generation) return;
      if (subtitle !== undefined && activeTrackId !== null) {
        declaredSubtitle = subtitle;
        // What is on the television is now also what the founder wants, so a later press
        // is compared against the truth rather than against whatever `release()` left here.
        wantedSubtitle = subtitle;
        subtitlesActive = true;
        activeOffsetMs = clampOffsetMs(subtitle.offsetMs);
      }
      // The television is fetching the new URL now; the old one has nothing left to answer.
      if (previousMount !== null && previousMount.token !== mount.token) {
        deps.mediaServer.unmount(previousMount.token);
      }
      // **Not on a repair.** 17a's diagnosis is about a cast the founder has just pressed:
      // *"the television took the video and never came back for it, and on Windows that is
      // nearly always the firewall"*. A repair is issued into an interruption that is
      // already in progress, where the true answer is 11c's *"Lost connection"* after the
      // deadline — accusing the founder's firewall of a network that has not finished
      // coming back would be a wrong, alarming sentence at the worst moment. It also ends
      // the session, which would take the recovery with it.
      if (supersedes !== 'repair') armFetchWatchdog(forGeneration);
      // 18l, and it rides on the same rule for the same reason: a repair is issued into an
      // interruption that is still in progress, and a sentence about subtitles during one
      // would be noise on top of 11a's promise that nothing turns red during a blip. The
      // repair's own LOAD re-declares the ladder, and the next ordinary load asks again.
      if (supersedes !== 'repair' && subtitle !== undefined && activeTrackId !== null) {
        armSubtitleFetchWatch(forGeneration);
      }
      dispatch({ type: 'device.loaded' });
      handleStatus(status, forGeneration);
    } catch (error) {
      if (forGeneration !== generation) return;
      if (supersedes === 'repair') {
        // The interruption is not over. Nothing is said, nothing turns red, and the
        // recovery deadline — one deadline for the whole run of failures — is what
        // eventually tells the founder the truth (11c).
        logger.warn('media.repair_load_failed', {
          error,
          why: 'the film could not be handed back to the television; the recovery deadline decides what is said',
        });
        return;
      }
      if (isEngineError(error) && error.code === 'LOAD_REJECTED') {
        dispatch({ type: 'device.load_rejected', detail: error.message });
        return;
      }
      logger.error('session.load_failed', { error });
      dispatch({
        type: 'device.connect_failed',
        reason: error instanceof Error ? error.message : String(error),
        userMessage: `Couldn't reach ${target.friendlyName}`,
      });
    } finally {
      // Loaded, refused or thrown — all three end the flight, and it is ended from here so
      // that a LOAD which failed cannot leave the session deaf to a television that really
      // does quit. (`timer.tick` closes a window whose LOAD never returned at all.)
      if (supersedes !== undefined) dispatch({ type: 'session.live_load_settled' });
    }
  }

  /**
   * The device said yes to the video. Did it ever come and get it?
   *
   * A Chromecast that accepts a LOAD and then never issues a single range request is not
   * a device with a slow evening — it is a device that cannot reach this PC, and on
   * Windows that is nearly always the firewall. The alternative to naming it is the
   * spinner that never ends, which is the one outcome PRD 17a refuses to ship.
   */
  function armFetchWatchdog(forGeneration: number): void {
    clearFetchWatchdog();
    const token = mount?.token;
    if (token === undefined) return;
    // 17a promises the diagnosis **within 15 s of pressing Cast**, so the clock that
    // matters started at the press — not here. Whatever the television spent booting its
    // own receiver app comes out of the same budget, and on the founder's hardware that is
    // 6.4–10.6 s of it. What is left is the wait, floored so a slow boot cannot turn into a
    // confident wrong accusation and capped so a fast one does not wait all day.
    const pressedAtMono = castPressedAtMono;
    const remainingMs =
      pressedAtMono === null
        ? TIMING.firewallDiagnosisMs
        : pressedAtMono +
          TIMING.castFailureBudgetMs -
          TIMING.firewallDiagnosisMarginMs -
          clock.monoMs();
    const waitMs = Math.min(
      TIMING.firewallDiagnosisMs,
      Math.max(TIMING.firewallDiagnosisMinMs, remainingMs),
    );
    logger.debug('session.fetch_watchdog_armed', {
      waitMs: Math.round(waitMs),
      remainingBudgetMs: Math.round(remainingMs),
      sinceCastPressMs: pressedAtMono === null ? null : Math.round(clock.monoMs() - pressedAtMono),
    });
    fetchWatchdog = setTimeout(() => {
      fetchWatchdog = null;
      if (forGeneration !== generation) return;
      if (deps.mediaServer.hasServedRequest(token)) return;
      logger.warn('session.media_never_fetched', {
        token,
        afterMs: Math.round(waitMs),
        // What the selftest grades 17a against: the founder pressed Cast this long ago.
        sinceCastPressMs:
          pressedAtMono === null ? null : Math.round(clock.monoMs() - pressedAtMono),
      });
      dispatch({ type: 'media.not_fetched' });
    }, waitMs);
    fetchWatchdog.unref?.();
  }

  /**
   * **The set took the ladder and never came for the words** — PRD 18l.
   *
   * The same question `armFetchWatchdog` asks about the film, asked about the track, and
   * deliberately answered in a completely different way. A film nobody fetched is a cast
   * that failed and the founder is told so; **a track nobody fetched is a film that is
   * playing perfectly well with no words on it**, so this says one sentence into the
   * subtitle control and does nothing else at all: no LOAD, no unmount, no dispatch, and
   * nothing that could reach defect D2's media-path repair — that repair exists for the
   * film's own bytes, and a track that was never fetched is not a delivery that died.
   *
   * **`TIMING.firewallDiagnosisMs`, reused rather than reinvented.** The PRD's own line is
   * *"the same window as the firewall diagnosis (17a)"*. The anchor differs, and it has to:
   * 17a measures from the Cast press because that is when the founder started waiting for a
   * picture, while a track can be declared by a LOAD the founder asked for mid-film, long
   * after any press. So the window runs from the declaration — the instant the television
   * was given something to fetch.
   */
  function armSubtitleFetchWatch(forGeneration: number): void {
    clearSubtitleFetchWatch();
    const token = subtitleMount?.token;
    if (token === undefined) return;
    const waitMs = TIMING.firewallDiagnosisMs;
    logger.debug('subtitle.fetch_watch_armed', { token, waitMs });
    subtitleFetchWatchdog = setTimeout(() => {
      subtitleFetchWatchdog = null;
      if (forGeneration !== generation) return;
      // It came and got it. Nothing to say, and saying something would be crying wolf about
      // a television that behaved.
      if (deps.mediaServer.hasServedRequest(token)) return;
      // Declared, then turned off before the window closed: there are no words on the
      // screen because the founder asked for none.
      if (declaredSubtitle === null || !subtitlesActive) return;
      subtitleNotLoaded = true;
      logger.warn('subtitle.never_fetched', {
        token,
        afterMs: waitMs,
        source: declaredSubtitle.key,
        offsetMs: activeOffsetMs,
        why: 'the television accepted the film and never fetched the text track; the film is untouched',
      });
      deps.onChanged();
    }, waitMs);
    subtitleFetchWatchdog.unref?.();
  }

  /** The record a *reopened* app would need to find this session again (story 12). */
  function liveSessionInfo(): LiveSessionInfo | null {
    const target = device;
    const file = source;
    const current = mount;
    const port = deps.mediaServer.port;
    if (target === null || file === null || current === null || port === null) return null;
    // **What the television has, not what anyone has asked for.** A press that has not
    // settled yet has not reached the set, and writing down a rung the set was never given
    // would have a reopened app come back holding a correction nobody can see.
    const declared = declaredSubtitle;
    const track = subtitleMount;
    return {
      deviceId: target.id,
      filePath: file.path,
      fileName: file.name,
      token: current.token,
      mediaPort: port,
      mediaSessionId: lastMediaSessionId,
      positionSec: Math.round(displayedPositionSec() * 1000) / 1000,
      subtitle:
        // **`subtitlesActive` is part of the question, not an extra check.** A founder who
        // turned the words off mid-film left a ladder declared on the television and no
        // words on the screen; coming back and putting them on would be subtitles arriving
        // by themselves, which is the one thing 19a's ruling forbids outright.
        declared === null || track === null || !subtitlesActive
          ? null
          : {
              sourceId: declared.key,
              label: declared.name,
              language: declared.language,
              offsetMs: activeOffsetMs,
              token: track.token,
            },
    };
  }

  function persistSession(): void {
    const info = liveSessionInfo();
    if (info !== null) deps.onSessionChanged?.(info);
  }

  function startPersisting(): void {
    stopPersistTimer();
    persistSession();
    persistTimer = setInterval(persistSession, TIMING.sessionPersistMs);
    persistTimer.unref?.();
  }

  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      timer.unref?.();
    });

  function backoffFor(attempt: number): number {
    const ladder = TIMING.reconnectBackoffMs;
    return ladder[Math.min(attempt, ladder.length - 1)] ?? TIMING.reconnectBackoffMaxMs;
  }

  /**
   * Reconnect, then ask the television what is actually running.
   *
   * The order is the point. Every earlier version of this in the industry *reloads* at a
   * remembered position, which rewinds the film by the length of the outage and costs a
   * receiver boot. SPIKE-2 proved that is unnecessary on real hardware: the session is
   * still there, the position is still right, and a new connection can drive it.
   *
   * The loop ends exactly one of four ways, all of them in the reducer:
   * `recovery.rejoined`, `recovery.yielded`, `recovery.gave_up` (whose deadline the
   * recovery ticker enforces), or the founder pressing something.
   */
  async function runRecovery(run: RecoveryRun): Promise<void> {
    let attempt = 0;
    /** Cancelled, or overtaken by a newer session. Either way this loop is finished. */
    const finished = (): boolean => run.cancelled || model.recovery === null;
    // The socket that brought us here is finished with. The file stays mounted and the
    // device stays ours: the television is still fetching from one and still playing on
    // the other.
    await closeConnectionOnly();

    while (!finished()) {
      const target = device;
      if (target === null) return;

      if (model.flags.networkDown) {
        // Nothing to try. 11d suspends the give-up clock too, so this is a genuine wait
        // rather than a countdown the founder cannot win.
        await sleep(TIMING.recoveryProbeMs);
        continue;
      }

      dispatch({ type: 'recovery.attempt', monoMs: clock.monoMs() });
      const forGeneration = generation;
      let established: CastConnection;
      try {
        established = await establish(target, forGeneration);
      } catch (error) {
        logger.debug('session.recovery_connect_failed', { attempt, error });
        await sleep(backoffFor(attempt));
        attempt += 1;
        continue;
      }

      // Anything established *after* this run was cancelled belongs to nobody: closed
      // here, never assigned. This is the socket that used to leak.
      if (finished() || forGeneration !== generation) {
        await established.close({ announce: false }).catch(() => undefined);
        return;
      }

      let found: Awaited<ReturnType<CastConnection['rejoin']>>;
      try {
        found = await established.rejoin();
      } catch (error) {
        logger.debug('session.recovery_probe_failed', { attempt, error });
        await established.close({ announce: false }).catch(() => undefined);
        await sleep(backoffFor(attempt));
        attempt += 1;
        continue;
      }
      if (finished() || forGeneration !== generation) {
        await established.close({ announce: false }).catch(() => undefined);
        return;
      }

      // Somebody else has the television (14a). Yield — and note we have sent it nothing
      // but a `GET_STATUS`: no LAUNCH, no media command, and from here nothing at all.
      if (!found.ours && found.appId !== null) {
        await established.close({ announce: false }).catch(() => undefined);
        // The generation check the fast path has always had. Closing the probe is an
        // `await`, and the founder can press *Take it back* or pick another device inside
        // it — after which this answer is about a session that no longer exists, and
        // dispatching it tore the *new* cast down to *Stopped* and named a television the
        // new one was never on.
        if (finished() || forGeneration !== generation) return;
        dispatch({
          type: 'recovery.yielded',
          appId: found.appId,
          appName: found.appName,
          atSec: savedPositionSec(),
        });
        return;
      }

      // Our app, with a media session that is still going: adopt it and carry on. This is
      // 11a, and on the founder's hardware it takes 126 ms.
      //
      // One exception, and it belongs to the 2026-08-18 ruling: while *Stopped* is already
      // on screen after an orderly close, our own receiver sitting there with an IDLE
      // media session is **confirmation of the stop**, not something to come back to.
      // Adopting it would end the grace early and take the takeover correction with it.
      const idleAfterStop =
        model.state === 'stopped' && (found.media?.playerState ?? 'IDLE') === 'IDLE';
      if (found.ours && found.media !== null && !idleAfterStop) {
        if (finished() || forGeneration !== generation) {
          await established.close({ announce: false }).catch(() => undefined);
          return;
        }
        connection = established;
        servingAddress = established.localAddress;
        reviewNetwork();
        stopRecoveryTicker();
        startLoops(forGeneration);
        // **Our connection is back; the film's may not be** (D2). Armed before the rejoin
        // is announced so nothing that reads the snapshot can see a session declared well
        // while the television is silently starving.
        armMediaPathWatch(forGeneration);
        checkMediaPathAfterRecovery(forGeneration, 'rejoin');
        dispatch({
          type: 'recovery.rejoined',
          monoMs: clock.monoMs(),
          playerState: found.media.playerState,
        });
        // The device's own status decides what state we land in — including an IDLE that
        // means the film finished while we were away, which reaches *Finished* from here
        // exactly as it would have done on a healthy connection.
        handleStatus(found.media, forGeneration);
        startPersisting();
        return;
      }

      // The television is on its home screen, or our receiver is running with nothing in
      // it. Either could still become a takeover — SPIKE-2 watched one stay exactly like
      // this for 11.3 seconds before naming Prime Video — so keep asking until the grace
      // runs out and the reducer decides.
      await established.close({ announce: false }).catch(() => undefined);
      await sleep(TIMING.recoveryProbeMs);
      attempt += 1;
    }
  }

  /**
   * **Did the television's route to the film survive the outage?** — defect D2.
   *
   * Found on hardware on 2026-08-27 by pulling the Ethernet cable out of the founder's PC
   * for 24 seconds. The control channel came back perfectly: `cast.rejoined` **243 ms**
   * after the address returned, the device reporting `PLAYING` at 119.0 s. And the film
   * died anyway — because six seconds into the outage the television's own byte connection
   * had been reset (`ECONNRESET`), and **the Default Media Receiver does not come back for
   * more on its own**. It played out the ~23 s it had buffered and starved. Between the
   * network returning and the founder pressing stop a minute later, the television asked
   * this PC for **zero** bytes.
   *
   * Nothing on our side was broken, and that is the point worth writing down: the media
   * server is bound to `0.0.0.0`, so its listening socket is not tied to any address and
   * survives an interface going and coming back; the mount was never let go of; and
   * `network.changed` never reached the media server in the first place, because there is
   * nothing there for it to do. **The only thing that was broken was on the television**,
   * and the only thing that mends it is handing it the film again.
   *
   * So, after a rejoin: if the television has **no delivery in flight**, and the last one
   * ended owing bytes with nothing asked for since, wait `mediaRepairGraceMs` for the
   * receiver to prove us wrong — a seek abandons a delivery every time and a healthy set
   * comes straight back — and then re-issue the LOAD at the position the television itself
   * reports.
   *
   * **Silent when there is nothing wrong**, which is most of the time. An outage that only
   * killed *our* socket leaves the device's delivery in flight throughout (SPIKE-2
   * measured zero range requests across a 15 s outage, and the film never stopped), so
   * `live > 0` answers it and no LOAD is issued — 12a's *"no LOAD on a reattach"* and the
   * `--outage socket` runs are untouched.
   *
   * **What it deliberately does not do is time the interruption.** A cable pull kills the
   * byte connection and the control connection within a moment of each other and in
   * whichever order the network chooses — on 2026-08-27 the socket died *six seconds after*
   * the interface went, and on a silent outage detected by the keep-alive it would be
   * fifteen seconds the other way. Any window drawn around "during the outage" is a guess
   * about which symptom arrives first. The question that does not need one is simply:
   * *is anything fetching the film right now, and if not, did the last attempt end
   * unfinished?* If we are wrong the founder pays one two-second reload during an
   * interruption they are already watching. If we do not ask, they pay the evening.
   *
   * **And it is asked more than once, because once was 229 ms too early** (2026-08-28, and
   * the reason `armMediaPathWatch` exists). A glance at the rejoin cannot be the whole of
   * it: whether a black-holed socket has been declared dead yet is the OS's business, not
   * ours. So this same question is asked again, unchanged, the moment a delivery dies
   * inside the window a rejoin opens.
   */
  function checkMediaPathAfterRecovery(
    forGeneration: number,
    trigger: 'rejoin' | 'interruption',
  ): void {
    clearMediaRepairTimer();
    const token = mount?.token;
    if (token === undefined) return;
    const delivery = deps.mediaServer.deliveryFor(token);
    if (delivery === null) return;
    const interruptedAt = delivery.interruptedAtMono;
    // Something is being delivered right now, or the last delivery finished honestly, or
    // the television has been back since. Nothing to mend.
    if (interruptedAt === null) return;
    if (delivery.live > 0 || (delivery.lastRequestAtMono ?? 0) > interruptedAt) return;
    // A repair already answered this interruption. Only a *newer* one may ask for another,
    // which is what stops a television we cannot reach turning into a reload loop.
    if (mediaRepairedAtMono !== null && interruptedAt <= mediaRepairedAtMono) return;
    logger.info('media.path_suspect', {
      token,
      interruptions: delivery.interruptions,
      live: delivery.live,
      graceMs: TIMING.mediaRepairGraceMs,
      // **Which of the two ways this was noticed**, and it is worth a word in the log: the
      // difference between them was 32 seconds of frozen picture in the house, and the
      // finished repair looks identical from the outside either way.
      trigger,
      afterRejoinMs:
        mediaPathWatchFromMono === null
          ? null
          : Math.round(clock.monoMs() - mediaPathWatchFromMono),
      why: "the television's byte connection died during the outage and nothing has replaced it",
    });
    mediaRepairTimer = setTimeout(() => {
      mediaRepairTimer = null;
      if (forGeneration !== generation) return;
      const now = deps.mediaServer.deliveryFor(token);
      if (now === null) return;
      // It came back by itself: either it is reading a response right now, or it has asked
      // for one since the interruption. Nothing to repair, and saying so is worth a line —
      // it is the difference between a television that recovers and one that cannot.
      if (now.live > 0 || (now.lastRequestAtMono ?? 0) > interruptedAt) {
        logger.info('media.path_recovered', {
          token,
          live: now.live,
          why: 'the television came back for the film by itself',
        });
        return;
      }
      queue = queue
        .then(() => repairMediaPath(forGeneration, token))
        .catch((error: unknown) => logger.warn('media.repair_failed', { error }));
    }, TIMING.mediaRepairGraceMs);
    mediaRepairTimer.unref?.();
  }

  /**
   * **Keep listening for a moment: the delivery may not have been declared dead yet.**
   *
   * The 229 ms race, `AI PONT`, 2026-08-28. The route came back at `05:27:08.876`,
   * the control channel rejoined 171 ms later, and the check above looked at the film's
   * byte path and saw a delivery still counted as **in flight** — because a black-holed
   * socket is one that neither end has been told about yet. `media.delivery_interrupted`
   * was recorded at `05:27:11.276`, and by then nothing was watching. The film did not play
   * again until `05:27:50.835`: **41.96 s** against 11b's ten, and about fourteen seconds of
   * frozen picture the founder sat through.
   *
   * **A longer grace is not the answer, and the evidence says so.** The same reset surfaced
   * *six seconds into* the outage on 2026-08-27 and *2.4 s after the rejoin* on 2026-08-28.
   * When a dead socket becomes observable depends on the OS and on the network; picking a
   * bigger number would only be a different guess, and it would slow every healthy recovery
   * down to the size of the worst one.
   *
   * So a rejoin opens a window instead. While it is open, a delivery **dying** is looked at
   * the instant it dies — by exactly the same question, with exactly the same grace behind
   * it. **It cannot fire on a healthy film**, and each of these is load-bearing:
   *
   *  1. it is armed **only** by a recovery rejoining, and closes itself
   *     `TIMING.mediaRepairWatchMs` later — no window is open during an ordinary evening;
   *  2. it reacts to an interruption **arriving**, so one that predates the outage cannot
   *     re-arrive and ask for anything;
   *  3. the question it then asks is the unchanged one: anything in flight, or anything
   *     requested since, and it stands down;
   *  4. and the two-second grace still runs, so a television that goes back for the bytes
   *     itself is met with `media.path_recovered` and no LOAD at all (11h).
   */
  function armMediaPathWatch(forGeneration: number): void {
    mediaPathWatchGeneration = forGeneration;
    mediaPathWatchFromMono = clock.monoMs();
    mediaPathWatchUntilMono = mediaPathWatchFromMono + TIMING.mediaRepairWatchMs;
    logger.info('media.path_watch', {
      token: mount?.token ?? null,
      windowMs: TIMING.mediaRepairWatchMs,
      why: 'a delivery that dies in the next few seconds died of this outage, however late the socket says so',
    });
  }

  /**
   * Hand the television the film again, at the place it says it is.
   *
   * A LOAD on the connection that is already open — never a fresh cast, which would
   * `release()` the session and take a head-start conversion down with it (the trap the
   * 2026-08-26 ADR named). It is the same route a subtitle chosen mid-film takes, which is
   * why 18h comes with it for nothing: `loadCurrentSource` re-declares the ladder around
   * the correction the founder had set, and declares nothing at all when subtitles were
   * never turned on (19a).
   */
  async function repairMediaPath(forGeneration: number, token: string): Promise<void> {
    if (forGeneration !== generation) return;
    if (connection === null || source === null || device === null) return;
    // Where the television says it is — it played on through the outage out of its own
    // buffer, and rewinding it to where the cable came out would be a visible fault of its
    // own (11b: within 2 s of the lost position, and the lost position has moved).
    const resumeAt = tracker.positionAt(clock.monoMs());
    mediaRepairedAtMono = clock.monoMs();
    // **This outage has had its answer.** The LOAD supersedes the media the television was
    // holding, so deliveries will end all around it — the old mount's, and the receiver's
    // own reshuffling — and none of them is a second thing to mend. A repair that did not
    // work is 11c's business (*"Lost connection"* after ~30 s), never a second reload.
    closeMediaPathWatch();
    logger.warn('media.path_repairing', {
      token,
      positionSec: Math.round(resumeAt * 1000) / 1000,
      subtitle: source.subtitle === undefined ? null : source.subtitle.key,
      subtitleOffsetMs: source.subtitle?.offsetMs ?? null,
      why: 'the television never came back for the film after the outage',
    });
    await loadCurrentSource(resumeAt, { supersedes: 'repair' });
  }

  function startRecovery(): void {
    if (recoveryRun !== null) return;
    const run: RecoveryRun = { cancelled: false };
    recoveryRun = run;
    stopPersistTimer();
    stopRecoveryTicker();
    // The only clock left while there is no connection. It carries the deadlines *and*
    // keeps the readout moving, because the film has not stopped — it is still playing on
    // the television, which is the whole finding SPIKE-2 came back with.
    recoveryTicker = setInterval(
      () => {
        if (model.recovery === null) return;
        dispatch({ type: 'timer.tick', monoMs: clock.monoMs() });
        deps.onChanged();
      },
      Math.round(1000 / TIMING.positionTickHz),
    );
    recoveryTicker.unref?.();
    void runRecovery(run)
      .catch((error: unknown) => {
        logger.error('session.recovery_failed', { error });
      })
      .finally(() => {
        // Only if it is still *this* run's slot. A cancelled run must not clear a token
        // belonging to the loop that replaced it.
        if (recoveryRun === run) recoveryRun = null;
      });
  }

  /**
   * Stop recovering, for good.
   *
   * The token is marked cancelled *and* the slot released, so a new interruption may start
   * a fresh loop immediately while the old one is still unwinding out of a 4-second
   * backoff. The old loop cannot do any damage on its way out: every await is followed by
   * a check of its own token, and anything it has connected is closed rather than adopted.
   */
  function cancelRecovery(): void {
    stopRecoveryTicker();
    if (recoveryRun === null) return;
    recoveryRun.cancelled = true;
    recoveryRun = null;
  }

  /**
   * Once a session is over, is the file the founder chose still where they chose it from?
   *
   * Asked here rather than while playing on purpose (15a): a film that is playing
   * perfectly well out of the device's own buffer is not a problem, and interrupting it to
   * say so is exactly the noise this app exists to remove.
   */
  function checkSourceStillThere(): void {
    const file = source;
    if (file === null || model.sourceMissing) return;
    void fsp.access(file.path).catch(() => {
      dispatch({ type: 'source.missing', reason: 'checked', atSec: savedPositionSec() });
    });
  }

  async function runEffect(effect: SessionEffect): Promise<void> {
    switch (effect.type) {
      case 'connect':
        await connectWithRetries(effect.deviceId);
        return;
      case 'load':
        await loadCurrentSource(effect.startPositionSec);
        return;
      // Play and pause are deliberately *not* awaited. A device that never answers must
      // not hold up the next thing the founder presses, and the promise is not how we
      // find out a command was ignored — the 2-second reconciliation is.
      case 'send.play':
        void connection
          ?.play()
          .catch((error: unknown) => logger.warn('session.play_failed', { error }));
        return;
      case 'send.pause':
        void connection
          ?.pause()
          .catch((error: unknown) => logger.warn('session.pause_failed', { error }));
        return;
      // Not awaited, for the same reason play and pause are not: a device that never
      // answers must not hold up the next thing the founder presses. Whether the jump
      // landed is decided by the reconciliation in `machine.ts`, never by this promise.
      case 'send.seek':
        void connection
          ?.seek(effect.positionSec)
          .catch((error: unknown) => logger.warn('session.seek_failed', { error }));
        return;
      case 'seek.hold':
        // The readout moves to the destination now — before anything reaches the device —
        // which is what makes the scrubber feel attached to the founder's finger (6b).
        tracker.holdForSeek(effect.positionSec, clock.monoMs());
        return;
      case 'seek.release_hold':
        tracker.releaseSeekHold(clock.monoMs(), effect.restore);
        return;
      case 'position.freeze':
        tracker.freeze(clock.monoMs());
        return;
      case 'seek.schedule': {
        // Exactly one window is ever open. A new tap replaces it rather than queueing a
        // second command behind it (6h) — which is the whole of 6g's "four taps, one jump".
        clearSettle();
        const forGeneration = generation;
        settleTimer = setTimeout(() => {
          settleTimer = null;
          if (forGeneration !== generation) return;
          dispatch({ type: 'timer.seek_settled', monoMs: clock.monoMs() });
        }, effect.delayMs);
        settleTimer.unref?.();
        return;
      }
      case 'send.stop': {
        // Freeze *before* sending. The device stops within a round trip of this, but the
        // tracker would happily go on extrapolating for the whole of the release — on real
        // hardware that put the saved position 1.003 s past where the device actually
        // stopped, and the error grew with anything that slowed the release down. A final
        // status carrying a real position will correct this a moment later; this is the
        // upper bound in the meantime.
        tracker.freeze(clock.monoMs());
        const current = connection;
        if (current === null) return;
        // Bounded, and the bound must not outlive the thing it is bounding. `stop()` ends
        // the media session *and* the receiver session — the second is what puts the TV
        // back on its own home screen — but a device that never answers must not delay the
        // release, or the next cast, by the full request timeout.
        //
        // The timer is cleared when the stop wins. It used to be left running: on real
        // hardware the stop completed in 243 ms and this still logged
        // `session.stop_timed_out` two seconds later, on every single stop, describing a
        // wait that had never happened. An instrument that lies is worse than no instrument.
        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
          timer = setTimeout(() => resolve('timeout'), TIMING.releaseTimeoutMs);
          timer.unref?.();
        });
        try {
          const outcome = await Promise.race([
            current
              .stop()
              .then(() => 'stopped' as const)
              .catch((error: unknown) => {
                logger.warn('session.stop_failed', { error });
                return 'stopped' as const;
              }),
            timeout,
          ]);
          if (outcome === 'timeout') {
            logger.warn('session.stop_timed_out', { afterMs: TIMING.releaseTimeoutMs });
          }
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
        return;
      }
      case 'recover':
        startRecovery();
        return;
      case 'recover.cancel':
        cancelRecovery();
        return;
      case 'release':
        await release();
        return;
      case 'log':
        logger.info(effect.event, effect.fields ?? {});
        return;
    }
  }

  /**
   * The position the founder is looking at.
   *
   * A pending seek target wins, and it wins *synchronously* — before the `seek.hold`
   * effect has run off the queue. That one-tick difference is invisible in a window but
   * very visible in a test, and getting it from the model rather than the tracker is what
   * makes "the readout shows the destination the moment you let go" (6b) true by
   * construction instead of by timing.
   */
  function displayedPositionSec(): number {
    return model.seek?.targetSec ?? tracker.positionAt(clock.monoMs());
  }

  /**
   * The position to *save*, which is not always the position on screen.
   *
   * A jump still inside its coalescing window has not been sent to anything: the film is
   * exactly where it was, so remembering the destination would offer a *Resume from
   * 0:10:00* for a place the television never reached. A jump already on the wire is a
   * different matter — we asked for it, and the honest claim is that it is happening.
   */
  function savedPositionSec(): number {
    const seek = model.seek;
    if (seek !== null && seek.issuedAtMono === null) {
      tracker.releaseSeekHold(clock.monoMs(), true);
      return tracker.positionAt(clock.monoMs());
    }
    return displayedPositionSec();
  }

  const OVER: readonly string[] = ['stopped', 'ended'];

  function dispatch(event: Parameters<typeof reduce>[1]): void {
    const before = model.state;
    const transition = reduce(model, event);
    // Reported from here rather than from the two places that raise it, so a third one
    // added later cannot forget to. Fired **after** the reducer has run, so the engine's
    // re-plan sees the session already back at Ready rather than racing it.
    // **Only a progressive-MP4 load may teach the capability table**, and this is the line
    // that makes the 2026-08-19 ADR true in code rather than in a comment. An HLS load
    // refused for a *serving* reason arrives as the very same bare `LOAD_FAILED`, so
    // treating it as evidence would permanently narrow a television's profile on the
    // strength of a missing header of our own.
    if (event.type === 'device.load_rejected') {
      if (source?.hls === undefined) deps.onLoadRejected?.(event.detail);
      else {
        logger.warn('session.hls_load_refused', {
          detail: event.detail,
          why: 'a serving fault, never a capability fact — the device profile is unchanged',
        });
      }
    }
    model = transition.model;
    if (model.state !== before) {
      // The session just ended. This is the moment 15a has been waiting for: if the file
      // went away while it was playing, now is when the founder is told.
      if (OVER.includes(model.state) && !OVER.includes(before)) checkSourceStillThere();
      logger.info('session.state_changed', {
        from: before,
        to: model.state,
        // Not `event`: that is the log record's own name, and using it here renamed
        // every state transition after itself, hiding `session.state_changed` from the log.
        trigger: event.type,
        deviceId: model.deviceId,
        positionSec: Math.round(tracker.positionAt(clock.monoMs()) * 1000) / 1000,
      });
    }
    for (const effect of transition.effects) {
      queue = queue
        .then(() => runEffect(effect))
        .catch((error: unknown) => {
          logger.error('session.effect_failed', { effect: effect.type, error });
        });
    }
    deps.onChanged();
  }

  function drain(): Promise<void> {
    // Effects can enqueue further effects (connect → load), so settle the chain twice.
    return queue.then(() => queue).then(() => undefined);
  }

  return {
    get model() {
      return model;
    },
    get device() {
      return device;
    },

    positionSec: displayedPositionSec,
    durationSec: () => tracker.durationSec,
    reportedVolume: () => reportedVolume,
    setVolume: requestVolume,
    pendingVolumeLevel: () => {
      // The newest ask wins: a pending value has already replaced the one in flight in
      // everything but the sending, so it is the one the founder is currently pointing at.
      const newest = volumePending ?? volumeInFlight?.change ?? null;
      if (newest === null || !('level' in newest)) return null;
      return newest.level;
    },

    async cast(target, file, options) {
      // Take ownership in two halves, and the split is the whole point.
      //
      // **Now, synchronously:** invalidate the old session so nothing still in flight from
      // it can reach the reducer or the position tracker, and dispatch, so the founder sees
      // *Connecting…* on the press rather than after the previous session has finished
      // tidying up.
      //
      // **On the queue:** take the device. `release()` used to be called directly from here,
      // which let the previous stop's queued `release` run *afterwards* and set `device` to
      // null underneath the new session — `connect` then threw, the throw was swallowed, and
      // the app sat in *Connecting…* forever with only Cancel to escape (criterion 2c).
      // Queueing it means the old session's STOP is always sent and acknowledged first, so
      // the fix cannot leave a TV un-released; `TIMING.releaseTimeoutMs` bounds the wait.
      //
      // **The volume is forgotten here as well as in `release()`, and it must be both.**
      // `release()` runs on that queue, so a new cast can begin before the old session's
      // teardown has drained — and in that window the snapshot would publish the *previous*
      // television's level against the new session, drawing a handle on a set that has said
      // nothing yet. Forgetting it synchronously here makes 23g's "read fresh from the
      // device" true regardless of what order the queue settles in.
      forgetVolume();
      generation += 1;
      stopTimers();
      tracker.reset();
      castPressedAtMono = clock.monoMs();

      queue = queue
        .then(async () => {
          await release();
          device = target;
          source = file;
          deps.onDeviceInUse?.(target.id);
        })
        .catch((error: unknown) => {
          logger.error('session.takeover_failed', { error });
        });

      dispatch({
        type: 'intent.cast',
        deviceId: target.id,
        startPositionSec: Math.max(0, options?.startPositionSec ?? 0),
      });
      await drain();
      startPersisting();
    },

    async reattach(target, file, wanted, options) {
      generation += 1;
      stopTimers();
      cancelRecovery();
      tracker.reset();
      dispatch({ type: 'session.reattaching', deviceId: target.id });
      await drain();

      const forGeneration = generation;
      const give = (reason: string): boolean => {
        dispatch({ type: 'session.reattach_failed', reason });
        return false;
      };

      const deadlineMono = options?.deadlineMono ?? null;
      const remainingMs = (): number =>
        deadlineMono === null ? Number.POSITIVE_INFINITY : deadlineMono - clock.monoMs();
      /**
       * Race a step against what is left of the budget.
       *
       * A step that arrives late is not merely ignored: whatever it produced is disposed
       * of, because an abandoned Cast connection is a live socket with live handlers.
       */
      async function withinBudget<T>(
        work: Promise<T>,
        dispose: (value: T) => void,
      ): Promise<{ ok: true; value: T } | { ok: false }> {
        const ms = remainingMs();
        if (ms === Number.POSITIVE_INFINITY) return { ok: true, value: await work };
        const late = (value: T): void => {
          dispose(value);
        };
        if (ms <= 0) {
          void work.then(late, () => undefined);
          return { ok: false };
        }
        let timer: NodeJS.Timeout | undefined;
        const expired = new Promise<'expired'>((resolve) => {
          timer = setTimeout(() => resolve('expired'), ms);
          timer.unref?.();
        });
        try {
          const outcome = await Promise.race([work.then((value) => ({ value }) as const), expired]);
          if (outcome === 'expired') {
            void work.then(late, () => undefined);
            return { ok: false };
          }
          return { ok: true, value: outcome.value };
        } finally {
          if (timer !== undefined) clearTimeout(timer);
        }
      }

      device = target;
      source = file;
      deps.onDeviceInUse?.(target.id);

      // **The file is re-published before anything else happens**, under the token the
      // previous run used. The television has been asking a URL that stopped answering
      // since the app closed; every millisecond it spends 404ing is buffer it is burning.
      // SPIKE-2: this only worked because the second process republished the identical
      // URL — same port, same token. Both were random per run until the store existed.
      try {
        await deps.mediaServer.start();
        mount = deps.mediaServer.mount({ path: file.path, kind: 'file', token: wanted.token });
      } catch (error) {
        logger.warn('session.reattach_mount_failed', { error });
        return give('the media server could not republish the file');
      }

      let established: CastConnection;
      try {
        const connecting = await withinBudget(establish(target, forGeneration), (connection) => {
          void connection.close({ announce: false }).catch(() => undefined);
        });
        if (!connecting.ok) {
          logger.info('session.reattach_too_slow', { step: 'connect' });
          return give('the device did not answer in time');
        }
        established = connecting.value;
      } catch (error) {
        logger.info('session.reattach_unreachable', { error });
        return give('the device did not answer');
      }
      if (forGeneration !== generation) {
        await established.close({ announce: false }).catch(() => undefined);
        return false;
      }

      let found: Awaited<ReturnType<CastConnection['rejoin']>>;
      try {
        const probing = await withinBudget(established.rejoin(), () => undefined);
        if (!probing.ok) {
          generation += 1;
          await established.close({ announce: false }).catch(() => undefined);
          logger.info('session.reattach_too_slow', { step: 'probe' });
          return give('the device did not say what it was doing in time');
        }
        found = probing.value;
      } catch (error) {
        generation += 1;
        await established.close({ announce: false }).catch(() => undefined);
        logger.info('session.reattach_probe_failed', { error });
        return give('the device did not say what it was doing');
      }

      // 12b: is this *our* content? The token in the URL is unguessable and ours, so it is
      // the answer — and matching on the token rather than the whole URL means a PC whose
      // IP changed while the app was closed still recognises its own film.
      const ours =
        found.ours &&
        found.media !== null &&
        found.media.playerState !== 'IDLE' &&
        (found.media.contentId ?? '').includes(`/m/${wanted.token}/`);

      if (!ours || found.media === null) {
        // **Bump the generation before closing.** This probe's handlers are still armed on
        // the generation the reattach captured, so any last word from it — a `CLOSE`, a
        // socket ending, a receiver status — would reach the reducer at `connecting` with
        // no recovery in progress and start a *Reconnecting to \<name\>…* for a
        // television we had already decided to walk away from. 12b is silence.
        generation += 1;
        await established.close({ announce: false }).catch(() => undefined);
        logger.info('session.reattach_not_ours', {
          appId: found.appId,
          playerState: found.media?.playerState ?? null,
          contentId: found.media?.contentId ?? null,
        });
        return give('the device is not playing CastGood content');
      }

      connection = established;
      servingAddress = established.localAddress;
      reviewNetwork();
      startLoops(forGeneration);
      dispatch({ type: 'session.reattached', playerState: found.media.playerState });
      handleStatus(found.media, forGeneration);
      await drain();
      startPersisting();
      return true;
    },

    noteNetwork(usable, all) {
      // Two signals, and the second is the one that works on a machine with virtual
      // adapters: is there any network at all, and is the address this session is actually
      // being served on still there? See `src/engine/network/index.ts`.
      localAddresses = usable;
      allLocalAddresses = all;
      reviewNetwork();
    },

    async play() {
      dispatch({ type: 'intent.play', monoMs: clock.monoMs() });
      await drain();
    },

    async pause() {
      dispatch({ type: 'intent.pause', monoMs: clock.monoMs() });
      await drain();
    },

    async seek(positionSec) {
      dispatch({ type: 'intent.seek', positionSec, monoMs: clock.monoMs() });
      await drain();
    },

    async skip(deltaSec) {
      const monoMs = clock.monoMs();
      dispatch({ type: 'intent.skip', deltaSec, fromSec: displayedPositionSec(), monoMs });
      await drain();
    },

    setSubtitle(wanted) {
      wantedSubtitle = wanted;
      // Exactly one window is ever open, and a new press replaces it rather than queueing a
      // second message behind it. That is 6g's rule for taps, applied to presses — and it is
      // what makes 20c's *"the displayed number moves on every press; the wire does not"*
      // true without anything here knowing what is on the screen.
      clearSubtitleSettle();
      const forGeneration = generation;
      subtitleSettleTimer = setTimeout(() => {
        subtitleSettleTimer = null;
        if (forGeneration !== generation) return;
        // On the queue, behind whatever else is in flight: a reload is a LOAD, and two LOADs
        // racing each other over one connection is the fault this queue exists to prevent.
        queue = queue
          .then(() => applySubtitle())
          .catch((error: unknown) => logger.warn('subtitle.apply_failed', { error }));
      }, TIMING.seekSettleMs);
      subtitleSettleTimer.unref?.();
    },

    adoptSubtitle(subtitle, token) {
      // A session that is not live has no ladder on any television, and one that already
      // has a declared track is not a reattach. Both are refusals rather than surprises:
      // this must never be a second way for words to arrive.
      if (connection === null || device === null || source === null) {
        logger.warn('subtitle.adopt_ignored', { why: 'no live session' });
        return false;
      }
      if (declaredSubtitle !== null) {
        logger.warn('subtitle.adopt_ignored', { why: 'a track is already declared' });
        return false;
      }
      const offsetMs = clampOffsetMs(subtitle.offsetMs);
      // The centre is derived the way the LOAD derived it, from the offset alone, so the
      // rung numbering this process now believes in is the numbering that television was
      // actually given. Anything else and a nudge would name a `trackId` that means a
      // different offset on the set than it does here.
      const centreMs = ladderCentreFor(offsetMs);
      if (rungFor(offsetMs, centreMs) === null) {
        logger.warn('subtitle.adopt_ignored', { why: 'the offset is not a rung', offsetMs });
        return false;
      }
      unmountSubtitle();
      subtitleMount = deps.mediaServer.mount({
        kind: 'subtitles',
        cues: subtitle.cues,
        name: `${subtitle.name}.vtt`,
        // **The same token, for the same reason the film's URL keeps its own.** Every one
        // of the thirteen rung URLs the television is holding names it.
        token,
      });
      const adopted: SessionSubtitle = { ...subtitle, offsetMs };
      source = { ...source, subtitle: adopted };
      declaredSubtitle = adopted;
      declaredCentreMs = centreMs;
      wantedSubtitle = adopted;
      subtitlesActive = true;
      activeOffsetMs = offsetMs;
      logger.info('subtitle.adopted', {
        sourceId: adopted.key,
        offsetMs,
        cues: adopted.cues.length,
        token,
      });
      // Written down again straight away: a second reopen must find the same words, and the
      // record that brought us here was the *previous* run's.
      persistSession();
      deps.onChanged();
      return true;
    },

    get subtitleReloading() {
      return subtitleReloading;
    },

    get subtitleNotLoaded() {
      return subtitleNotLoaded;
    },

    retrySubtitle() {
      const wanted = wantedSubtitle;
      if (connection === null || wanted === null) {
        logger.warn('intent.ignored', { intent: 'subtitles.retry', why: 'nothing is declared' });
        return false;
      }
      logger.info('subtitle.retrying', { source: wanted.key, offsetMs: wanted.offsetMs });
      // **Forgotten first, so this cannot become a track switch.** The rungs on that set
      // are the ones it never fetched; switching between them would send a message about
      // words the television does not have. `forgetDeclaredSubtitle` also stands the watch
      // down, and the reload arms a fresh one — so a second failure says so again.
      forgetDeclaredSubtitle();
      queue = queue
        .then(() => applySubtitle())
        .catch((error: unknown) => logger.warn('subtitle.retry_failed', { error }));
      deps.onChanged();
      return true;
    },

    noteFrontier(frontierSec) {
      dispatch({ type: 'frontier.changed', frontierSec });
    },

    noteSourceMissing(token) {
      // Only ever called by the media server, and only when a device asked for bytes that
      // were not there. That is 15b, not 15a — playback is affected.
      //
      // **And only for the film.** A text track that goes missing must not take a working
      // film down with it: the picture and the sound are still arriving from a mount that
      // is still there, so the film keeps playing and 15b is never raised. The founder's
      // sentence about a track that failed is 18l's, and it belongs to the subtitle
      // control rather than to the film.
      if (subtitleMount !== null && token === subtitleMount.token) {
        logger.warn('session.subtitle_missing', { token });
        return;
      }
      if (mount === null || token !== mount.token) {
        // A mount we have already let go of, or one we never made. Nothing is playing off
        // it, so there is nothing to say about it.
        logger.debug('session.stale_mount_missing', { token });
        return;
      }
      dispatch({ type: 'source.missing', reason: 'fetch-failed', atSec: savedPositionSec() });
    },

    noteDeliveryInterrupted(token) {
      // **Only the film's own mount.** A `.vtt` fetch that was cut off is not a reason to
      // hand the television a whole film again — the same rule `noteSourceMissing` keeps,
      // for the same reason.
      if (mount === null || token !== mount.token) return;
      const until = mediaPathWatchUntilMono;
      // **No recovery just happened, so this is a healthy film's own business.** A seek
      // ends a delivery every time. Outside the window this is not looked at at all, which
      // is what makes it impossible for a repair to fire on a film that is playing well.
      if (until === null) return;
      if (mediaPathWatchGeneration !== generation || clock.monoMs() > until) {
        closeMediaPathWatch();
        return;
      }
      // A repair is already waiting out its grace for an earlier interruption. Restarting
      // that wait on a second death would postpone the very thing this window is for.
      if (mediaRepairTimer !== null) return;
      checkMediaPathAfterRecovery(generation, 'interruption');
    },

    noteFileChanged() {
      dispatch({ type: 'file.changed' });
    },

    noteFileRelocated() {
      // *Find it again* found the same film somewhere else (15b). The problem is over; the
      // founder's place is not.
      dispatch({ type: 'file.relocated' });
    },

    noteReplanned() {
      dispatch({ type: 'file.replanned' });
    },

    async stop() {
      dispatch({ type: 'intent.stop', atSec: savedPositionSec() });
      await drain();
    },

    async dispose(options) {
      const over = model.state === 'idle' || model.state === 'stopped' || model.state === 'ended';
      const keepPlaying = options?.keepPlaying === true && !over;

      if (!over && !keepPlaying) {
        dispatch({ type: 'intent.stop', atSec: savedPositionSec() });
      }
      await drain();

      if (keepPlaying) {
        // Story 12's precondition. The founder closed the window; they did not press Stop,
        // and the PRD's own state table assumes the film is still going when they come
        // back ("On reopen: the session is reattached with correct position"). So the last
        // position is written down and the socket is simply dropped — no media STOP, no
        // receiver STOP, and above all **the record is not forgotten**, because the URL in
        // it is the only thing a reopened app cannot re-derive from the device.
        persistSession();
        stopTimers();
        stopPersistTimer();
        cancelRecovery();
        generation += 1;
        const current = connection;
        connection = null;
        if (current !== null) {
          await current
            .close()
            .catch((error: unknown) => logger.warn('session.close_failed', { error }));
        }
        logger.info('session.left_playing', { deviceId: model.deviceId });
        return;
      }

      await release();
      stopTimers();
    },
  };
}

export {
  INITIAL_SESSION,
  reduce,
  type SessionModel,
  type SessionEvent,
  type SessionEffect,
  type SessionTransition,
  type PendingCommand,
  type PendingSeek,
  type SessionErrorModel,
} from './machine.js';
export { createPositionTracker, type PositionTracker, type PositionReport } from './position.js';
