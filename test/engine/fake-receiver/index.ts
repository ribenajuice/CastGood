import net from 'node:net';
import http from 'node:http';
import type { Device } from '../../../src/engine/types.js';
import { createFrameReader, encodeFrame } from '../../../src/engine/cast/castv2/packet-stream.js';
import { decodeCastMessage, encodeCastMessage } from '../../../src/engine/cast/castv2/proto.js';

/**
 * A scripted fake Chromecast.
 *
 * It speaks the **real** CASTV2 framing and the real namespaces — this is the engine's
 * own codec on both ends of the socket — and it can be told to misbehave in exactly the
 * ways the PRD's unhappy paths describe: swallow a command, refuse a LOAD, report a
 * state nobody asked for (a TV remote), skew its clock, or drop the socket.
 *
 * It runs over plain TCP rather than TLS, and that is the one deliberate difference from
 * a real device. The alternative is a private key checked into the repository, and TLS is
 * not where the risk lives: the framing, the namespaces, the request correlation and every
 * reconciliation rule above them are identical. TLS itself is only ever proved by the
 * selftest against real hardware.
 *
 * The architecture doc calls this `test/fake-receiver/`; it lives under `test/engine/`
 * because that is the directory this milestone's tests own.
 */

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';
/** The app CastGood itself launches. Anything else on the television is somebody else. */
const DEFAULT_MEDIA_RECEIVER_APP_ID = 'CC1AD845';

/**
 * A playhead advances with **elapsed time**, not with the calendar.
 *
 * This fake used to move its position with `Date.now()`, and the WSL2 machine this suite
 * runs on steps its wall clock backwards by ~2.4 s every 30 s. That put a two-second jump
 * into the position it reported, roughly once in four full runs, and failed the
 * position-accuracy assertions — which grade a **1 s** promise — for a reason that has
 * nothing to do with any product code: the engine itself reads `process.hrtime` and was
 * never affected. A television's playhead does not jump when the PC's clock is corrected,
 * so this is the more faithful model as well as the stable one.
 */
function monoNowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

export type FakePlayerState = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';

export interface ReceivedMessage {
  readonly namespace: string;
  readonly type: string;
  readonly payload: Record<string, unknown>;
  /**
   * The message exactly as it arrived on the wire, before `JSON.parse` touched it.
   *
   * **Key order is part of the bytes**, and 19a is a promise about bytes: *"the LOAD
   * message is byte-for-byte what it would have been before M3c existed"*. A parsed object
   * cannot express that — `{a,b}` and `{b,a}` are the same object and different messages —
   * so the golden in `m3c-load-golden.test.ts` compares this string and nothing else.
   */
  readonly raw: string;
}

export interface FakeReceiverOptions {
  readonly durationSec?: number;
  /**
   * What the device *says* the film's length is, when that is not the truth.
   *
   * Every television in the founder's house answers a growing playlist with `duration: -1`
   * — the Ultra, the `AI PONT` and the bedroom Chromecast, for a whole session — and
   * criterion 10c is the rule that follows: **CastGood owns the clock**. A fake that always
   * reports the real length cannot tell a scrubber fed by our own probe from one fed by the
   * device, because both read the same number. Defaults to the truth, so nothing else in
   * the suite changes.
   */
  readonly reportsDurationSec?: number;
  /** Milliseconds between LOAD and the unsolicited PLAYING that follows it. */
  readonly startupMs?: number;
  /**
   * How long this device takes to answer LAUNCH — booting its own receiver application.
   *
   * **Zero is a lie.** The founder's hardware takes 6.4–10.6 s, and every budget measured
   * from the Cast press spends that first. A fake that launches in microseconds hid the
   * firewall diagnosis arriving 6 s past the deadline it promises.
   */
  readonly launchDelayMs?: number;
  /**
   * The level this set starts at. Defaults to 1, which is what it always reported.
   *
   * ⚠️ **A fake that starts at 1 cannot fail 23a.** Every level a test asks for is *below*
   * it, so a fake stuck at 1 and a fake that took the change look identical on the way
   * down only if nobody checks the number — and the selftest's own exit-2 list names this
   * trap from the other side ("the device's level was already at the target, so no change
   * was demonstrable").
   */
  readonly volumeLevel?: number;
  readonly volumeMuted?: boolean;
  /**
   * How this set says its volume may be driven. **`'fixed'` means it owns its own volume
   * and ignores every level we send** — 23h's television, and the one the founder's house
   * does not contain: SPIKE-5 found `master` on the `AI PONT` and `attenuation` on both
   * dongles, so this path exists **only** here and would otherwise be untestable.
   */
  readonly volumeControlType?: 'attenuation' | 'fixed' | 'master';
  /**
   * The set's own granularity — it rounds every level to a multiple of this.
   *
   * Measured 2026-09-07: **0.01** on the `AI PONT`, **0.05** on both Chromecast dongles. A
   * fake that echoes the exact number it was handed is kinder than every television in the
   * house, and 23d's *"a level that moved to something other than what was asked for is the
   * device's answer, accepted permanently and never retried"* cannot be reached against it.
   * Defaults to 0 — no quantisation — so nothing already in the suite changes.
   */
  readonly volumeStepInterval?: number;
  /**
   * Report the level with a tiny float wobble, the way a real Chromecast Ultra does.
   *
   * ⚠️ **This exists because the fake was kinder than the house and hid a real defect.**
   * On 2026-09-08 the founder's `Home Theatre TV` reported one unchanged level as
   * `0.10000000149011612` and then `0.09999999403953552`. The engine compared levels with
   * an exact `!==`, read that jitter as *"the set answered with a level of its own"* — 23d's
   * clamp case, accepted permanently — and **never fired the retry it promises** for a
   * command the television had actually ignored.
   *
   * This fake could not express that: `answerFor` rounds to 1e-6 on purpose, so no test in
   * the suite could ever have caught it. Set this to a value like `1e-8` to make the set
   * wobble without moving. Defaults to 0, so nothing already in the suite changes.
   */
  readonly volumeReportJitter?: number;
  /** Nothing louder than this is ever accepted: the clamp 23d's fixtures need. */
  readonly volumeMaxLevel?: number;
}

export interface FakeReceiver {
  readonly port: number;
  readonly device: Device;
  readonly received: readonly ReceivedMessage[];
  countOf(type: string): number;
  readonly launched: boolean;
  readonly playerState: FakePlayerState;
  readonly loadedUrl: string | null;
  /** What this television currently says its volume is. */
  readonly volume: { readonly level: number; readonly muted: boolean };
  /**
   * **Somebody else moves the volume** — a phone, another sender, the set's own remote.
   *
   * Pushes an unsolicited `RECEIVER_STATUS` carrying the new level to every connected
   * sender, which is the only route by which 23c's number can ever change. It deliberately
   * does **not** go through the command path: a device-side change that our own engine
   * dispatched to itself would prove nothing, and 23c's "fails if" names exactly that.
   *
   * ⚠️ SPIKE-5 found the founder's `AI PONT` **never** volunteers one of these — 15 s of
   * silence after a second sender moved the level, then a poll read it in 8 ms. So the
   * announcement here is the *kinder* of the two worlds, and 23c must also pass with
   * `broadcastsReceiverStatus: false`, where the poll is the only thing that can see it.
   */
  changeVolumeExternally(level: number, muted?: boolean): void;
  /** Commands in this set are received and recorded, then ignored entirely. */
  swallow(type: string): void;
  unswallow(type: string): void;
  /**
   * Ignore the next `count` messages of this type (default 1), then answer normally again.
   *
   * `swallow('LAUNCH')` is a television that never wakes; this is a television that is
   * merely **asleep**, which is the one the founder actually owns. On 2026-08-18 a set
   * idle for 56 minutes took longer than 10 s to answer its first LAUNCH and the cast was
   * abandoned — so "silent once, then normal" is the exact shape of the defect, and a fake
   * that can only be permanently deaf cannot express it.
   */
  swallowNext(type: string, count?: number): void;
  /**
   * **Answer the next `count` receiver statuses as though no app were running**, while the
   * film in fact plays on.
   *
   * A television briefly forgetting its own `applications` list is not a hypothetical: the
   * engine already treats an empty list as *"the device ended the session"*, and until M5a
   * only an **unsolicited** broadcast could deliver one. The volume poll now asks for a
   * receiver status **once a second**, which turns a single odd answer into a state change
   * the founder would read as *"the film just stopped and will not come back"*.
   *
   * Every other stingy knob here exists because a fake was kinder than the house. This one
   * exists because the fake could not express the case at all: `applications` was empty only
   * when the fake genuinely had nothing running, so no test could ever have caught it.
   */
  forgetAppsOnce(count?: number): void;
  rejectNextLoad(): void;
  /** Makes the device report a position this far from the truth. */
  setClockSkewSec(seconds: number): void;
  /**
   * Holds back the receiver's answer to a receiver-namespace STOP, the way a real TV does:
   * the founder's hardware took 386–843 ms to report the app gone. Anything the engine
   * extrapolates across that window is a position error nobody can see on loopback.
   */
  setReleaseDelayMs(ms: number): void;
  /**
   * Makes the device answer a stop with `currentTime: 0`, which the founder's own TV does —
   * it reported 0 for a film stopped at 402.678 s. Believing that put 0:00:00 on the
   * Stopped screen, so the engine has to survive a device whose last word is wrong.
   */
  setIdleReportsZero(reports: boolean): void;
  /**
   * Makes the device report `currentTime: 0` while it is **buffering**, whatever position
   * it was asked to start at.
   *
   * The founder's own television does this: a LOAD carrying `currentTime: 1500` is
   * answered with BUFFERING at 0 until playback actually starts, and a freshly launched
   * receiver reports IDLE at 0 before anything is loaded. Neither is a playback position —
   * but a measurement that counted them reported *Resume from 0:32:10* (16c) as having
   * played from the beginning when it had landed dead on 1500.001 s.
   *
   * Off by default, exactly like `setIdleReportsZero`, because it is a specific device's
   * unhelpfulness rather than the shape of the protocol.
   */
  setBufferingReportsZero(reports: boolean): void;
  /**
   * Makes the device answer a SEEK by moving somewhere *near* the target rather than to
   * it, or by taking its time getting there.
   *
   * A real receiver seeks to the nearest keyframe, so it lands tens or hundreds of
   * milliseconds off what was asked for — and reports the *old* position on the status or
   * two that are already in flight when the SEEK arrives. Both are why the display holds
   * the requested position instead of following every report (6e); neither is visible
   * against a fake that teleports exactly and instantly.
   *
   * `lagStatuses` is how many status replies still describe the pre-seek position.
   */
  setSeekBehaviour(behaviour: {
    errorSec?: number;
    lagStatuses?: number;
    /** How long the device buffers after a jump before it plays again. */
    bufferMs?: number;
  }): void;
  /**
   * Stops the device reporting a position at all, on every status rather than only at the
   * end of a file. Firmware does this; a readout that treats "no position" as zero rewinds
   * the film on screen.
   */
  setReportsPosition(reports: boolean): void;
  /**
   * Whether this device actually goes and fetches the video it was handed.
   *
   * **On by default, because a real device always does**, and a fake that accepts a LOAD
   * and never asks for a byte looks exactly like a television behind a firewall — which
   * is the condition 17a exists to name. Turning it off is how that condition is tested;
   * leaving it off everywhere else would have the diagnosis fire in every session.
   */
  setFetchesMedia(fetches: boolean): void;
  /** Ask for more bytes, the way a receiver does when its buffer runs low. */
  refetch(): Promise<void>;
  /**
   * **Stream the film the way a real receiver does: one open-ended request, held open for
   * the whole evening** — and starve when it dies.
   *
   * Off by default, because most tests only care that the bytes were asked for once. It is
   * on for defect D2, and without it that defect cannot exist in this suite at all:
   *
   *  - the ordinary `fetchMedia()` reads a few kilobytes and hangs up, so there is never a
   *    delivery in flight for an outage to break;
   *  - and this fake's position advanced on wall-clock time whatever happened to the
   *    bytes, so a television whose byte connection had been reset went on "playing"
   *    perfectly happily. That is a fixture kinder than the house, and D2 is the ninth.
   *
   * With it on: the receiver holds the response open and reads nothing (a real one reads
   * slowly; the effect on the server is the same — a delivery in flight). If that
   * connection dies it does **not** go back for more, which is what the Default Media
   * Receiver actually does; it plays out `bufferSec` of film and then sits in BUFFERING
   * for ever. A new LOAD is the only thing that starts it again.
   */
  setStreamsFilm(
    on: boolean,
    options?: {
      bufferSec?: number;
      /**
       * **How many short setup requests come before the film's real delivery**, and how
       * long after the LOAD that delivery opens.
       *
       * Read off the founder's own log on 2026-08-28 and it is the eleventh time this
       * fake was kinder than the house. The `AI PONT` reached `playing` at `05:25:13.883`,
       * made small setup requests including a **15 KB tail read of the MP4 index**, and did
       * not open the delivery that matters — `bytes=3506176-`, 627,686,497 bytes — until
       * `05:25:31.289`, **~18 s later**. A fake that opens its delivery the instant the
       * LOAD lands cannot express defect 13h at all: the selftest cut the route at ~5.8 s,
       * squarely inside that gap, and exited 2 on three of four hardware attempts because
       * there was no delivery to break.
       */
      setupRequests?: number;
      deliveryDelayMs?: number;
    },
  ): void;
  /**
   * **The route goes away without the socket knowing yet** — the 229 ms race, 2026-08-28.
   *
   * A pulled cable does not politely close the television's connection. Packets simply
   * stop arriving; both ends go on holding a socket they believe in, and the reset only
   * becomes observable when the OS or the network says so — **six seconds into** the
   * outage on 2026-08-27, and **2.4 s after the route came back** on 2026-08-28. So this
   * stops reading the film without destroying anything: the media server still counts a
   * delivery in flight, exactly as it did in the house while the check looked at it.
   */
  stallFilmStream(): void;
  /**
   * And now the reset surfaces: the film's byte connection dies, counted as a break.
   *
   * Called by a test at the moment of its choosing, which is how "the interruption is
   * recorded 229 ms after the post-rejoin check had already looked" becomes reproducible.
   */
  breakFilmStreamNow(): void;
  /**
   * Make the device go back for the bytes by itself after its stream breaks.
   *
   * The *kind* television, and off by default for that reason. It exists so a test can
   * prove the repair path stays quiet for a set that mends itself, rather than reloading a
   * film that was going to come back on its own.
   */
  setRefetchesAfterStreamBreak(on: boolean): void;
  /** Is the film's byte connection open right now? */
  readonly filmStreamAlive: boolean;
  /** How many times it has died without this device asking for it back. */
  readonly filmStreamBreaks: number;
  /** How many times this device has opened one. A repair LOAD produces one more. */
  readonly filmStreamAttempts: number;
  /**
   * **How many times a LOAD has landed on a film this device was already playing, and been
   * answered the way a real receiver answers it** — `IDLE`/`INTERRUPTED` for the media
   * session being superseded, before the new one starts.
   *
   * A test about "a repair is not a refusal" that never provokes one of these has proved
   * nothing, so it is counted and asserted rather than assumed.
   */
  readonly supersededIdles: number;
  /**
   * The film dies on the device: IDLE with `idleReason: ERROR`, mid-playback.
   *
   * A real receiver does this when its source stops answering, when it hits a corrupt
   * region, or when it simply gives up. Without it the only ways this fake could ever
   * finish were "played to the end" and "someone stopped it" — both tidy — so the failure
   * path was untestable and a film that died silently reported *Stopped*.
   */
  failMedia(): void;
  /** HTTP statuses this device has had back from the media server, in order. */
  readonly fetchStatuses: readonly number[];
  /**
   * **Which text tracks are showing right now**, as this device believes it.
   *
   * A real television is the only thing that knows this, and it is the answer 19b and 20b
   * are actually about. Empty means no words on the screen.
   */
  readonly activeTrackIds: readonly number[];
  /**
   * Every subtitle URL this device has fetched, in order.
   *
   * SPIKE-3 measured that **every declared track is fetched**, even ones that are not
   * active — which is why declaring is not free and why `activeTrackIds: []` in a LOAD is
   * not "off". This fake does the same, so a test can count what a ladder really costs.
   */
  readonly trackFetches: readonly string[];
  /**
   * What the media server answered each of those fetches with, in the same order.
   *
   * `200` for a track that was there. **`404` is the one this exists for**: a URL the
   * television is still holding, on a mount that was never republished. Story 12 taught
   * this lesson once already about the film's own URL — the failure is silent, it arrives
   * minutes later, and nothing on screen says a word about it.
   */
  readonly trackFetchStatuses: readonly number[];
  /**
   * Whether switching to a track sends this device back for the words.
   *
   * On by default, which is the **stingier** of the two truths: a set that answers a
   * switch out of its own cache can never notice a dead track URL, so a fake that did the
   * same would hide exactly the defect 18h is about. Off models the cached set.
   */
  setRefetchesTrackOnSwitch(refetches: boolean): void;
  /**
   * How many `EDIT_TRACKS_INFO` messages have arrived.
   *
   * **The number 20c is scored on**: four presses inside 400 ms must produce exactly one.
   */
  readonly editTracksCount: number;
  /**
   * Stop fetching declared text tracks while still fetching the film.
   *
   * 18l is unreachable otherwise: *"the television accepted the film but never fetched the
   * subtitle track"* is a real failure a real set produces, and a fake that always fetches
   * is kinder than reality in the one way that criterion exists to catch.
   */
  setFetchesTracks(fetches: boolean): void;
  /**
   * Broadcasts the receiver's current state unsolicited, as a real device does when
   * anything about it changes. Before a launch that means an empty `applications` list —
   * a perfectly ordinary message that must not be mistaken for the founder stopping
   * something that was never started.
   */
  announceReceiverStatus(): void;
  setPositionSec(seconds: number): void;
  /**
   * Where the film is on the device right now.
   *
   * A read-only companion to `setPositionSec`, and the only way a test can say "the
   * television played on through the outage" — which is what a real one does, and what
   * the `--outage cable` scenario has to be measured against.
   */
  readonly positionSec: number;
  /** A pause from a TV remote: the state changes and the device announces it. */
  remoteSet(state: FakePlayerState): void;
  finish(): void;
  /**
   * What a real TV does when someone stops playback on the TV itself: quit the app,
   * announce that nothing is running, and close the virtual connection. Orderly — not a
   * dropped socket, and not something the founder should be told they lost.
   *
   * `closeConnection: false` models the devices that quit the app but leave the socket up.
   */
  stopFromTv(options?: { closeConnection?: boolean }): void;
  /**
   * Somebody takes the television, **in the order SPIKE-2 watched it happen**.
   *
   * This is the sequence, and every part of it is load-bearing:
   *
   *  1. an empty `applications` RECEIVER_STATUS and a `CLOSE` on the connection
   *     namespace, together — indistinguishable from a stop on the TV's own remote;
   *  2. the socket **stays up** (`socketClosed: false` in both spike runs);
   *  3. the old media session goes silent — a `GET_STATUS` to it got no answer at all,
   *     timing out at the full 5,000 ms;
   *  4. and only after `gapMs` does a RECEIVER_STATUS name the app that took it.
   *
   * The measured gaps were **4,300 ms** (YouTube) and **11,329 ms** (Prime Video), which
   * is where `TIMING.takeoverGraceMs` comes from. A fake that named the new app
   * immediately would make the grace period untestable and hide the entire problem.
   */
  takeover(options?: { appId?: string; appName?: string; gapMs?: number }): void;
  /**
   * The television stops answering **without closing the socket**.
   *
   * Not the same as `dropConnections()`, which is a reset. A TV that has crashed, gone to
   * sleep, or lost its own wifi leaves a socket that looks perfectly healthy and answers
   * nothing — including PINGs. This is the only way the heartbeat give-up path (11f) can
   * run, and `docs/DECISIONS.md` records the fake always closing the socket as the fourth
   * time it was kinder than a real device.
   *
   * **Distinct from `setAnswersPings(false)`**, and the distinction is criterion 11f's:
   * "the heartbeat misses its replies" is a device that has stopped answering the
   * *keep-alive* while everything else about it still works, which is what a busy or
   * half-crashed receiver looks like. This one answers nothing at all, so the reconnection
   * that follows fails too and the session ends in "Lost connection" (11c). Conflating
   * them meant only one of the two paths could ever be tested — and neither was.
   */
  goSilent(): void;
  /**
   * Stop answering PINGs, and nothing else. The socket stays up and every other request
   * is answered normally, so this is exactly the keep-alive give-up path (11f) and
   * nothing more.
   */
  setAnswersPings(answers: boolean): void;
  /**
   * Real Chromecasts **broadcast** receiver status whenever the receiver's state changes —
   * to every connected sender, unsolicited, not only as the answer to a GET_STATUS. This
   * fake only ever answered questions, which hid a whole class of defect: a broadcast
   * arriving between our CONNECT and our LAUNCH turned a perfectly ordinary Cast (and
   * *Take it back*, 14c) into "the TV is now playing YouTube".
   */
  setBroadcastsReceiverStatus(broadcasts: boolean): void;
  /**
   * Put another app on the television without the takeover sequence — the state a device
   * is in when somebody was already watching YouTube before CastGood was opened.
   */
  setOtherApp(app: { appId: string; appName: string } | null): void;
  dropConnections(): void;
  close(): Promise<void>;
}

export async function startFakeReceiver(options: FakeReceiverOptions = {}): Promise<FakeReceiver> {
  const durationSec = options.durationSec ?? 3600;
  const reportedDurationSec = options.reportsDurationSec ?? durationSec;
  const startupMs = options.startupMs ?? 30;
  const launchDelayMs = options.launchDelayMs ?? 0;
  const volumeControlType = options.volumeControlType ?? 'attenuation';
  const volumeStepInterval = options.volumeStepInterval ?? 0;
  const volumeMaxLevel = options.volumeMaxLevel ?? 1;
  let volumeLevel = options.volumeLevel ?? 1;
  const volumeReportJitter = options.volumeReportJitter ?? 0;
  /** Flips each time, so consecutive statuses differ the way the Ultra's do. */
  let jitterSign = 1;
  /**
   * The level as this television *reports* it — not necessarily the level it is on.
   * A real set's status can wobble in the last few decimal places without anything moving.
   */
  const reportedVolumeLevel = (): number => {
    if (volumeReportJitter === 0) return volumeLevel;
    jitterSign = -jitterSign;
    return volumeLevel + jitterSign * volumeReportJitter;
  };
  let volumeMuted = options.volumeMuted ?? false;

  /**
   * What this television would answer if asked for `level` — **clamped, then quantised**.
   *
   * In that order, and it matters: a set that quantises to 0.05 and is asked for 1.5 must
   * answer 1, not 1.5 rounded. Both are real behaviours — the `AI PONT` clamped -0.25 to
   * exactly 0 on 2026-09-07 — and 23d grades them differently: a clamp and a quantisation
   * are the device's answer and are never retried, while no answer at all is retried once.
   */
  const answerFor = (asked: number): number => {
    const clamped = Math.min(volumeMaxLevel, Math.max(0, asked));
    if (volumeStepInterval <= 0) return clamped;
    const stepped = Math.round(clamped / volumeStepInterval) * volumeStepInterval;
    // Float noise here would look exactly like a television quantising, which is the one
    // thing this fake exists to be able to say honestly.
    return Math.round(Math.min(volumeMaxLevel, stepped) * 1_000_000) / 1_000_000;
  };

  const received: ReceivedMessage[] = [];
  const swallowed = new Set<string>();
  /** Types with a countdown of answers still to be withheld. See `swallowNext`. */
  const swallowedNext = new Map<string, number>();
  const sockets = new Set<net.Socket>();
  const timers = new Set<NodeJS.Timeout>();

  let launched = false;
  let sessionId: string | null = null;
  let transportId: string | null = null;
  let mediaSessionId: number | null = null;
  let playerState: FakePlayerState = 'IDLE';
  let idleReason: string | null = null;
  let loadedUrl: string | null = null;
  let positionSec = 0;
  let positionAtMs = monoNowMs();
  let skewSec = 0;
  let rejectLoad = false;
  let releaseDelayMs = 0;
  let idleReportsZero = false;
  /** The device reports 0 until playback really starts. See `setBufferingReportsZero`. */
  let bufferingReportsZero = false;
  let seekErrorSec = 0;
  let seekLagStatuses = 0;
  let seekBufferMs = 0;
  /** Counts down the statuses that still describe where the film was before a SEEK. */
  let lagRemaining = 0;
  let preSeekPositionSec = 0;
  let reportsPositionAtAll = true;
  let fetchesMedia = true;
  /** Set when another app has the device; the receiver reports it instead of ours. */
  let otherApp: { appId: string; displayName: string } | null = null;
  /** See `forgetAppsOnce`: how many more statuses claim nothing is running. */
  let hideAppsFor = 0;
  /**
   * The media session is gone and does not answer. SPIKE-2: after a takeover a
   * `GET_STATUS` to the old session timed out at 5,000 ms rather than returning an empty
   * status — so answering *anything* here is a kindness a real device does not extend.
   */
  let mediaSilent = false;
  /** The device is up, the socket is fine, and it has stopped talking. */
  let silent = false;
  /** The keep-alive alone has stopped being answered. See `setAnswersPings`. */
  let answersPings = true;
  /** Whether receiver state changes are announced to every sender, as real devices do. */
  let broadcastsReceiverStatus = false;
  const fetchStatuses: number[] = [];
  /** Declared text tracks from the last LOAD, by id, and the URL each one names. */
  let declaredTracks: { trackId: number; url: string }[] = [];
  let activeTrackIds: number[] = [];
  const trackFetches: string[] = [];
  const trackFetchStatuses: number[] = [];
  let editTracksCount = 0;
  let fetchesTracks = true;
  let refetchesTrackOnSwitch = true;
  /** See `setStreamsFilm`: one open-ended request, held open, and starvation when it dies. */
  let streamsFilm = false;
  let bufferSec = 3;
  let refetchesAfterStreamBreak = false;
  /** See `setStreamsFilm`: the setup requests, and the delivery that only opens later. */
  let setupRequests = 2;
  let deliveryDelayMs = 1_500;
  let deliveryTimer: NodeJS.Timeout | null = null;
  /** True while the film's bytes are being black-holed rather than refused. */
  let filmStreamStalled = false;
  let filmStream: http.ClientRequest | null = null;
  let filmResponse: http.IncomingMessage | null = null;
  let filmStreamBreaks = 0;
  let filmStreamAttempts = 0;
  let supersededIdles = 0;
  let starveTimer: NodeJS.Timeout | null = null;

  /**
   * Go and get the video, like a real receiver: one open-ended range request, **read to
   * the end**.
   *
   * It used to read a few kilobytes and hang up, and that had to change with defect D2.
   * A delivery that ends with bytes still owed is now a *signal* — it is what a pulled
   * cable does to a television's byte connection, and the session repairs the media path
   * when nothing replaces it. A fake that abandoned every response left every headless
   * session looking permanently broken, which is the same fault as a fixture that can
   * never fail, pointing the other way.
   *
   * The fixtures here are a few kilobytes, so reading one to its end is what a real
   * receiver does with a film it can hold entirely: it asks once, gets everything, and the
   * response completes. `setStreamsFilm` is the shape a real film takes — a delivery that
   * stays open for the whole evening — and that is where D2 lives.
   */
  function fetchMedia(): Promise<void> {
    const url = loadedUrl;
    if (!fetchesMedia || url === null) return Promise.resolve();
    return new Promise<void>((resolve) => {
      const request = http.get(url, { headers: { Range: 'bytes=0-' } }, (response) => {
        fetchStatuses.push(response.statusCode ?? 0);
        response.resume();
        response.on('end', () => resolve());
        response.on('close', () => resolve());
        response.on('error', () => resolve());
      });
      request.on('error', () => resolve());
      request.end();
    });
  }
  function stopStarveTimer(): void {
    if (starveTimer !== null) clearTimeout(starveTimer);
    starveTimer = null;
  }

  /** Let go of the film's byte connection without counting it as a break — we did it. */
  function abandonFilmStream(): void {
    stopStarveTimer();
    const request = filmStream;
    const response = filmResponse;
    filmStream = null;
    filmResponse = null;
    response?.destroy();
    request?.destroy();
  }

  /**
   * The buffer runs out. A television that cannot get bytes stops playing and says so —
   * BUFFERING, for ever, which is exactly what the founder watched on 2026-08-27.
   */
  function starve(): void {
    stopStarveTimer();
    if (playerState !== 'PLAYING') return;
    setState('BUFFERING');
    announce();
  }

  /**
   * One open-ended range request, read **slowly**, and held open for the whole film.
   *
   * A real receiver reads at about playback speed, so the response is in flight for two
   * hours; a fake that drained it would finish a small fixture in a millisecond and leave
   * nothing for an outage to interrupt. So it takes one chunk every `CHUNK_PAUSE_MS` and
   * pauses in between.
   *
   * **It pauses between chunks rather than never reading at all**, and that detail cost an
   * hour: a response that is paused for good pauses its socket, and a paused socket does
   * not notice the far end being destroyed — the television would have gone on believing
   * it had a live connection to a PC that had vanished. Reading in bursts is both more
   * faithful and observable.
   */
  const CHUNK_PAUSE_MS = 150;

  /**
   * A short request that completes — the header read, the tail read of the `moov` index.
   *
   * These are what the television does *first*, and they are not deliveries an outage can
   * break: they are answered and over in milliseconds. Counting them as "the film is being
   * fetched" is exactly the mistake that made `--outage network` exit 2 three times.
   */
  function fetchSetupRange(range: string): void {
    const url = loadedUrl;
    if (url === null) return;
    const request = http.get(url, { headers: { Range: range } }, (response) => {
      fetchStatuses.push(response.statusCode ?? 0);
      response.on('data', () => {
        // **The picture comes up on these**, and that is the fact the harness was missing.
        // On the `AI PONT` on 2026-08-28 playback reached `playing` at `05:25:13.883` and
        // the film's own delivery did not open until `05:25:31.289` — **~18 s of "playing"
        // with nothing in flight to break**, which is precisely the gap the scenario used
        // to cut the route in. Bytes are still what start it: a set that fetches nothing at
        // all still never plays (17a).
        if (playerState !== 'PLAYING') {
          setState('PLAYING');
          announce();
        }
      });
      response.resume();
    });
    request.on('error', () => undefined);
    request.end();
  }

  function cancelDeliveryTimer(): void {
    if (deliveryTimer !== null) clearTimeout(deliveryTimer);
    deliveryTimer = null;
  }

  /**
   * The real shape, in order: **setup requests now, the delivery that matters later.**
   *
   * See `setStreamsFilm` for where the shape and the eighteen seconds come from.
   */
  function beginFilmFetch(): void {
    cancelDeliveryTimer();
    if (!streamsFilm || !fetchesMedia || loadedUrl === null) return;
    if (setupRequests > 0) fetchSetupRange('bytes=0-1023');
    if (setupRequests > 1) fetchSetupRange('bytes=-15360');
    if (deliveryDelayMs <= 0) {
      openFilmStream();
      return;
    }
    const opening = setTimeout(() => {
      deliveryTimer = null;
      openFilmStream();
    }, deliveryDelayMs);
    opening.unref?.();
    deliveryTimer = opening;
    timers.add(opening);
  }

  function retryFilmStream(): void {
    const retry = setTimeout(() => openFilmStream(), 200);
    retry.unref?.();
    timers.add(retry);
  }

  function openFilmStream(): void {
    const url = loadedUrl;
    if (!streamsFilm || !fetchesMedia || url === null) return;
    abandonFilmStream();
    filmStreamStalled = false;
    filmStreamAttempts += 1;
    const request = http.get(url, { headers: { Range: 'bytes=0-' } }, (response) => {
      fetchStatuses.push(response.statusCode ?? 0);
      filmResponse = response;
      response.on('data', () => {
        if (filmResponse !== response) return;
        // **Bytes are what make a television play.** A LOAD it accepted and could not fetch
        // leaves it in BUFFERING, which is what the founder watched on 2026-08-27 and what
        // a repair issued into a network that has not come back must still look like.
        // Reaching PLAYING on the strength of the LOAD alone would be this fake being
        // kinder than reality for the tenth time.
        if (playerState !== 'PLAYING') {
          setState('PLAYING');
          announce();
        }
        response.pause();
        const resume = setTimeout(() => {
          // **A stalled stream reads nothing and closes nothing.** That is what a
          // black-holed route looks like from both ends, and it is why the media server
          // still counted a delivery in flight while the app's post-rejoin check looked
          // at it (2026-08-28, the 229 ms race).
          if (filmResponse === response && !filmStreamStalled) response.resume();
        }, CHUNK_PAUSE_MS);
        resume.unref?.();
        timers.add(resume);
      });
      const broken = (): void => {
        if (filmResponse !== response) return;
        filmResponse = null;
        filmStream = null;
        filmStreamBreaks += 1;
        // **It does not go back for more.** The Default Media Receiver does not, and that
        // single fact is the whole of defect D2.
        if (refetchesAfterStreamBreak) {
          retryFilmStream();
          return;
        }
        stopStarveTimer();
        starveTimer = setTimeout(starve, bufferSec * 1000);
        starveTimer.unref?.();
      };
      response.on('close', broken);
      response.on('error', broken);
    });
    filmStream = request;
    request.on('error', () => {
      // The route to the PC is gone: nothing answered at all. Same consequence.
      if (filmStream !== request) return;
      filmStream = null;
      filmStreamBreaks += 1;
      // A television that mends itself keeps asking while the route is away, rather than
      // giving up on the first refusal — otherwise "the kind receiver" is only kind once,
      // which is indistinguishable from the unkind one and proves nothing.
      if (refetchesAfterStreamBreak) {
        retryFilmStream();
        return;
      }
      stopStarveTimer();
      starveTimer = setTimeout(starve, bufferSec * 1000);
      starveTimer.unref?.();
    });
    request.end();
  }

  /**
   * Go and get **every** declared text track, the way SPIKE-3 watched three televisions do.
   *
   * Not only the active one: that measurement is the reason `activeTrackIds: []` in a LOAD
   * is not "off", and a fake that fetched only what was showing would hide the cost of a
   * thirteen-rung ladder entirely.
   */
  function fetchTrack(track: { trackId: number; url: string }): Promise<void> {
    return new Promise<void>((resolve) => {
      const request = http.get(track.url, (response) => {
        trackFetches.push(track.url);
        // **The status, not just the fact.** A track URL that 404s is fetched exactly as
        // hard as one that works, and the difference is the whole of what a republished
        // mount buys — see `trackFetchStatuses`.
        trackFetchStatuses.push(response.statusCode ?? 0);
        response.on('data', () => undefined);
        response.on('close', () => resolve());
        response.on('error', () => resolve());
      });
      request.on('error', () => resolve());
      request.end();
    });
  }

  function fetchTracks(): Promise<void> {
    if (!fetchesTracks || declaredTracks.length === 0) return Promise.resolve();
    return Promise.all(declaredTracks.map((track) => fetchTrack(track))).then(() => undefined);
  }

  /** Go back for the words of whatever is showing now — see `EDIT_TRACKS_INFO`. */
  function fetchActiveTracks(): Promise<void> {
    if (!fetchesTracks || !refetchesTrackOnSwitch) return Promise.resolve();
    const showing = declaredTracks.filter((track) => activeTrackIds.includes(track.trackId));
    return Promise.all(showing.map((track) => fetchTrack(track))).then(() => undefined);
  }

  /** The virtual connection we answer unsolicited statuses on. */
  let senderId = 'sender-0';
  /**
   * Which sender id each socket introduced itself with.
   *
   * A television talks to more than one sender at a time — that is the whole of a
   * takeover — and a single `senderId` addressed every frame to whoever connected last.
   * With the `takeover` selftest scenario opening a second connection of its own, that
   * meant the eviction notice went to the app doing the evicting.
   */
  const senderOf = new Map<net.Socket, string>();
  let current: net.Socket | null = null;

  function currentPositionSec(): number {
    const advanced = playerState === 'PLAYING' ? (monoNowMs() - positionAtMs) / 1000 : 0;
    return Math.min(durationSec, positionSec + advanced);
  }

  function setState(next: FakePlayerState): void {
    positionSec = currentPositionSec();
    positionAtMs = monoNowMs();
    playerState = next;
  }

  /**
   * Deliberately no more helpful than a real Default Media Receiver:
   *
   *  - **`currentTime` is omitted on IDLE/FINISHED.** A real device announces the end of
   *    media with no position at all. Reporting one here hid a defect that told the founder
   *    their place was saved at 0:00:00 after finishing a film.
   *  - **`media` (duration, contentId) rides only on the LOAD response.** Real unsolicited
   *    status updates leave it out, so a sender that does not cache the duration loses it.
   *
   * Every generosity here is a defect the headless suite cannot see.
   */
  function mediaStatusPayload(
    requestId?: number,
    options: { withMedia?: boolean } = {},
  ): Record<string, unknown> {
    const reportsPosition =
      reportsPositionAtAll && !(playerState === 'IDLE' && idleReason === 'FINISHED');
    // A status still in flight when the SEEK arrived describes where the film *was*. Real
    // receivers send one or two of these; a fake that never does hides the whole of 6e.
    const lagging = lagRemaining > 0;
    if (lagging) lagRemaining -= 1;
    const base = lagging ? preSeekPositionSec : currentPositionSec();
    const startingUp = playerState === 'BUFFERING' || playerState === 'IDLE';
    const reportedTime =
      (playerState === 'IDLE' && idleReportsZero) || (startingUp && bufferingReportsZero)
        ? 0
        : Math.max(0, base + skewSec);
    const status =
      mediaSessionId === null
        ? []
        : [
            {
              mediaSessionId,
              playerState,
              ...(reportsPosition ? { currentTime: reportedTime } : {}),
              idleReason,
              ...(options.withMedia === true
                ? { media: { duration: reportedDurationSec, contentId: loadedUrl } }
                : {}),
            },
          ];
    return { type: 'MEDIA_STATUS', status, ...(requestId === undefined ? {} : { requestId }) };
  }

  function send(socket: net.Socket, namespace: string, source: string, payload: unknown): void {
    if (socket.destroyed) return;
    socket.write(
      encodeFrame(
        encodeCastMessage({
          sourceId: source,
          destinationId: senderOf.get(socket) ?? senderId,
          namespace,
          data: JSON.stringify(payload),
        }),
      ),
    );
  }

  function announce(): void {
    if (current === null) return;
    send(current, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload());
  }

  function receiverStatusPayload(requestId?: number): Record<string, unknown> {
    // A television that has momentarily lost track of what it is running. It is still
    // playing — `launched`, `sessionId` and `transportId` are all untouched — it simply
    // says otherwise for this one answer.
    if (hideAppsFor > 0) {
      hideAppsFor -= 1;
      return {
        type: 'RECEIVER_STATUS',
        status: {
          applications: [],
          volume: {
            level: reportedVolumeLevel(),
            muted: volumeMuted,
            controlType: volumeControlType,
            ...(volumeStepInterval > 0 ? { stepInterval: volumeStepInterval } : {}),
          },
        },
        ...(requestId === undefined ? {} : { requestId }),
      };
    }
    const applications =
      otherApp !== null
        ? [
            {
              appId: otherApp.appId,
              displayName: otherApp.displayName,
              sessionId: 'other-session-1',
              transportId: 'other-transport-1',
              statusText: `Casting ${otherApp.displayName}`,
            },
          ]
        : launched && sessionId !== null && transportId !== null
          ? [
              {
                appId: DEFAULT_MEDIA_RECEIVER_APP_ID,
                displayName: 'Default Media Receiver',
                sessionId,
                transportId,
                statusText: 'Ready To Cast',
              },
            ]
          : [];
    return {
      type: 'RECEIVER_STATUS',
      status: {
        applications,
        volume: {
          level: reportedVolumeLevel(),
          muted: volumeMuted,
          controlType: volumeControlType,
          ...(volumeStepInterval > 0 ? { stepInterval: volumeStepInterval } : {}),
        },
      },
      ...(requestId === undefined ? {} : { requestId }),
    };
  }

  /**
   * Somebody else takes the television, in the order SPIKE-2 measured it.
   *
   * `except` is the connection that *did* the taking — a phone, or the selftest's own
   * second connection — which is told what it asked for and is not sent the eviction
   * notice meant for everybody else.
   */
  function performTakeover(
    options: { appId?: string; appName?: string; gapMs?: number } = {},
    except?: net.Socket,
  ): void {
    const gapMs = options.gapMs ?? 4_300;
    const appId = options.appId ?? '2C6A6E3D';
    const displayName = options.appName ?? 'YouTube';
    // Step 1 and 2: our app is gone and the connection is closed, but the socket is not.
    launched = false;
    sessionId = null;
    transportId = null;
    mediaSessionId = null;
    mediaSilent = true;
    setState('IDLE');
    idleReason = 'CANCELLED';
    const evicted = (): net.Socket[] =>
      [...sockets].filter((socket) => socket !== except && !socket.destroyed);
    for (const socket of evicted()) {
      send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
      send(socket, NS_CONNECTION, 'receiver-0', { type: 'CLOSE' });
    }
    // Step 4: the other app, once it has finished booting. Until this fires, a takeover
    // and a stop from the TV's own remote are the same bytes on the wire.
    const naming = setTimeout(() => {
      otherApp = { appId, displayName };
      for (const socket of evicted()) {
        send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
      }
    }, gapMs);
    naming.unref?.();
    timers.add(naming);
  }

  function handle(socket: net.Socket, namespace: string, source: string, raw: string): void {
    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return;
    }
    const type = String(payload['type'] ?? '');
    const requestId = typeof payload['requestId'] === 'number' ? payload['requestId'] : undefined;
    received.push({ namespace, type, payload, raw });

    // Recorded, then ignored: a silent television still receives everything sent to it,
    // and a test asserting "we sent it nothing" must be able to see that we did not.
    if (silent) return;

    if (namespace === NS_CONNECTION) {
      if (type === 'CONNECT') {
        senderId = source;
        senderOf.set(socket, source);
        // A real device tells a sender what it is running the moment it connects, without
        // being asked. That announcement is the one that used to be read as a takeover.
        if (broadcastsReceiverStatus) {
          send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
        }
      }
      return;
    }
    if (swallowed.has(type)) return;
    const owed = swallowedNext.get(type) ?? 0;
    if (owed > 0) {
      swallowedNext.set(type, owed - 1);
      return;
    }
    if (namespace === NS_HEARTBEAT) {
      if (type === 'PING' && answersPings) {
        send(socket, NS_HEARTBEAT, 'receiver-0', { type: 'PONG' });
      }
      return;
    }

    if (namespace === NS_RECEIVER) {
      if (type === 'LAUNCH') {
        // **A LAUNCH of somebody else's app is a takeover**, and it is how one really
        // arrives: a second connection asks for a different `appId`. The fake used to
        // launch its own Default Media Receiver whatever it was asked for, so the
        // `takeover` selftest scenario — which opens exactly such a connection — could
        // only ever abort against it, and the one automated path to criteria 14a–14c
        // could not be exercised anywhere.
        const wanted = String(payload['appId'] ?? DEFAULT_MEDIA_RECEIVER_APP_ID);
        if (wanted !== DEFAULT_MEDIA_RECEIVER_APP_ID) {
          performTakeover({ appId: wanted, appName: `App ${wanted}` }, socket);
          send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload(requestId));
          return;
        }
        // A LAUNCH **evicts whoever has the television**, exactly as a real one does —
        // SPIKE-2 watched `LAUNCH CC1AD845` throw YouTube off the device. Modelling it is
        // what makes criterion 14b's "sends nothing further to it" a test that can fail.
        otherApp = null;
        mediaSilent = false;
        launched = true;
        sessionId = 'session-1';
        transportId = 'transport-1';
        if (launchDelayMs > 0) {
          // Booting the receiver application, at the pace real hardware does it.
          const booting = setTimeout(() => {
            send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload(requestId));
          }, launchDelayMs);
          booting.unref?.();
          timers.add(booting);
          return;
        }
      }
      if (type === 'SET_VOLUME') {
        const volume = (payload['volume'] ?? {}) as { level?: unknown; muted?: unknown };
        // **A `fixed` television takes nothing and says so by not moving.** It still answers
        // — that is what makes it different from a swallowed command — so the app learns
        // the refusal from the level standing still, exactly as 23h describes.
        if (volumeControlType !== 'fixed') {
          if (typeof volume.level === 'number') volumeLevel = answerFor(volume.level);
          // Mute is its own flag and **never zeroes the level** (23f, and measured on the
          // `AI PONT`). A fake that muted by setting 0 would make "CastGood remembers
          // nothing" untestable, because there would be nothing for the set to restore.
          if (typeof volume.muted === 'boolean') volumeMuted = volume.muted;
          // Setting a level while muted unmutes — 23f's last sentence.
          if (typeof volume.level === 'number' && volumeMuted) volumeMuted = false;
        }
      }
      if (type === 'STOP') {
        launched = false;
        sessionId = null;
        transportId = null;
        mediaSessionId = null;
        setState('IDLE');
        idleReason = 'CANCELLED';
      }
      if (type === 'STOP' && releaseDelayMs > 0) {
        const timer = setTimeout(() => {
          send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload(requestId));
        }, releaseDelayMs);
        timer.unref?.();
        timers.add(timer);
        return;
      }
      send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload(requestId));
      // ...and, because the receiver's state just changed, to everybody else as well.
      if (broadcastsReceiverStatus && (type === 'LAUNCH' || type === 'STOP')) {
        send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
      }
      return;
    }

    if (namespace !== NS_MEDIA) return;
    // The media session this message is addressed to no longer exists. A real receiver
    // does not answer at all — it does not even say so.
    if (mediaSilent) return;

    switch (type) {
      case 'LOAD': {
        if (rejectLoad) {
          rejectLoad = false;
          send(socket, NS_MEDIA, transportId ?? 'receiver-0', {
            type: 'LOAD_FAILED',
            ...(requestId === undefined ? {} : { requestId }),
          });
          return;
        }
        const media = payload['media'] as
          | { contentId?: string; tracks?: { trackId?: number; trackContentId?: string }[] }
          | undefined;
        loadedUrl = media?.contentId ?? null;
        // **A LOAD is the only place a television takes text tracks** (SPIKE-3), so this is
        // the only place this fake learns about them — and a LOAD with no `tracks` key
        // clears what the last one declared, exactly as a real receiver's new session does.
        declaredTracks = (media?.tracks ?? []).flatMap((track) =>
          typeof track.trackId === 'number' && typeof track.trackContentId === 'string'
            ? [{ trackId: track.trackId, url: track.trackContentId }]
            : [],
        );
        const requestedActive = payload['activeTrackIds'];
        activeTrackIds = Array.isArray(requestedActive)
          ? requestedActive.filter((id): id is number => typeof id === 'number')
          : [];
        // **The kindness this fake got away with for ten builds.**
        //
        // A real receiver takes a LOAD over a film it is already playing by *ending the
        // media session it is holding first, and saying so*: `IDLE` with
        // `idleReason: "INTERRUPTED"`, carrying the id of the session being superseded and
        // the position it had reached. The founder's `AI PONT` sent exactly that **101 ms**
        // after a D2 repair LOAD on 2026-08-28, and the app read it as the television
        // abandoning the film — *Stopped* mid-recovery, and a verdict of 0/18 on a run
        // where the film was playing again a second later.
        //
        // This fake went straight to the new session, so every LOAD-under-a-playing-film
        // path in the repository — the repair, and every mid-film subtitle reload — was
        // being graded against a television more forgiving than any real one.
        if (mediaSessionId !== null && playerState !== 'IDLE') {
          supersededIdles += 1;
          setState('IDLE');
          idleReason = 'INTERRUPTED';
          send(socket, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload());
        }
        mediaSessionId = (mediaSessionId ?? 0) + 1;
        // **Honour `currentTime`.** This fake used to start every load at 0 whatever it was
        // asked for, which is the fifth time it has been kinder than a real device — and
        // the most dangerous, because *Resume from 0:32:10* (16c) and *Take it back* (14c)
        // would both have reported a confident pass while landing at the opening titles.
        const requestedStart = payload['currentTime'];
        positionSec =
          typeof requestedStart === 'number' && Number.isFinite(requestedStart)
            ? Math.max(0, Math.min(durationSec, requestedStart))
            : 0;
        positionAtMs = monoNowMs();
        lagRemaining = 0;
        idleReason = null;
        setState('BUFFERING');
        send(
          socket,
          NS_MEDIA,
          transportId ?? 'receiver-0',
          mediaStatusPayload(requestId, { withMedia: true }),
        );
        // A real receiver fetches before it plays. Doing it here, off the LOAD, is what
        // makes the media server's byte-range path part of every session test.
        //
        // A LOAD is also the one thing that mends a television whose byte connection died:
        // it is a new media element, and it goes and gets the film again (D2).
        if (streamsFilm) beginFilmFetch();
        else void fetchMedia();
        // And it fetches every declared track, active or not — measured, not assumed.
        void fetchTracks();
        // **A device that cannot get the bytes never starts playing.** It sits in
        // BUFFERING, which is exactly what a television behind a firewall does and exactly
        // what the diagnosis in 17a is looking at. Reaching PLAYING anyway would be this
        // fake being kinder than reality for the sixth time.
        if (!fetchesMedia) return;
        // While it is streaming the film, the **first chunk** is what starts playback —
        // see `openFilmStream`. Nothing here may promote it on a timer.
        if (streamsFilm) return;
        const timer = setTimeout(() => {
          setState('PLAYING');
          announce();
        }, startupMs);
        timer.unref?.();
        timers.add(timer);
        return;
      }
      case 'EDIT_TRACKS_INFO': {
        // **The one thing a television will accept mid-film about subtitles.** It names
        // tracks the LOAD already declared and nothing else: an id that was never declared
        // is ignored rather than fetched, which is what makes "point a declared track at a
        // new URL" the dead end SPIKE-3 found it to be.
        editTracksCount += 1;
        const requested = payload['activeTrackIds'];
        activeTrackIds = Array.isArray(requested)
          ? requested.filter(
              (id): id is number =>
                typeof id === 'number' && declaredTracks.some((track) => track.trackId === id),
            )
          : [];
        // No buffering and no reload: the tracks are already on the device, which is the
        // whole reason a switch costs 11–36 ms and a reload costs seconds.
        //
        // **But it does go back for the words** (M3c step 5, and this is the ninth
        // kindness this fake has had taken off it). A set that switched to a rung purely
        // out of its own memory could never notice a track URL that had stopped
        // answering — so a reattach that forgot to republish the subtitle mount would
        // pass every headless test in this repository and fail on a Tuesday, silently,
        // with the words simply not changing. Fetching on the switch makes that a 404 a
        // test can see. Turn it off with `setRefetchesTrackOnSwitch(false)` to model the
        // set that answers from cache.
        void fetchActiveTracks();
        send(socket, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload(requestId));
        return;
      }
      case 'PAUSE':
        setState('PAUSED');
        send(socket, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload(requestId));
        return;
      case 'PLAY':
        setState('PLAYING');
        send(socket, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload(requestId));
        return;
      case 'SEEK': {
        const target = payload['currentTime'];
        if (typeof target === 'number') {
          preSeekPositionSec = currentPositionSec();
          lagRemaining = seekLagStatuses;
          // Not exactly where it was asked to go: a real receiver lands on the nearest
          // keyframe. `seekToleranceSec` is what decides whether that counts as arrived.
          positionSec = Math.max(0, Math.min(durationSec, target + seekErrorSec));
          positionAtMs = monoNowMs();
        }
        // A real receiver has to go and fetch the new region, so it buffers before it plays
        // again. Answering a SEEK with the previous player state made every jump look
        // instantaneous, which is the one thing a 20-minute jump is not.
        // **A jump means new bytes.** SPIKE-2 watched a real television answer a
        // 25-minute forward seek with exactly one range request, first byte
        // 301,694,976 — the region it jumped to was not in the buffer it held, so it had
        // to come back to the PC for it. A fake that seeks without fetching is kinder
        // than reality in the fifth way, and it is the kindness that hides a reattach
        // republishing its URL on a port nobody is listening on.
        void fetchMedia();
        const wasPlaying = playerState === 'PLAYING';
        if (wasPlaying && seekBufferMs > 0) {
          setState('BUFFERING');
          const resuming = setTimeout(() => {
            setState('PLAYING');
            announce();
          }, seekBufferMs);
          resuming.unref?.();
          timers.add(resuming);
        }
        send(socket, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload(requestId));
        return;
      }
      case 'STOP':
        // A real receiver reports where it stopped: the founder's TV sent an
        // IDLE/CANCELLED status entry, and the position in it is the only trustworthy
        // answer to "where did it get to?". Emptying the session *before* answering, as
        // this fake used to, threw that answer away and hid the defect.
        setState('IDLE');
        idleReason = 'CANCELLED';
        send(socket, NS_MEDIA, transportId ?? 'receiver-0', mediaStatusPayload(requestId));
        mediaSessionId = null;
        return;
      case 'GET_STATUS':
        // **An explicit GET_STATUS carries the `media` block**, including `contentId` and
        // `duration`, exactly as the founder's own television does — the SPIKE-2 wire
        // trace shows a full `media` object on every GET_STATUS reply and none at all on
        // the unsolicited updates. The distinction is not cosmetic: `contentId` is how
        // story 12b tells CastGood's own content from anything else on the TV, and a fake
        // that withheld it here would make every reattach fail for a reason no real device
        // would produce.
        send(
          socket,
          NS_MEDIA,
          transportId ?? 'receiver-0',
          mediaStatusPayload(requestId, { withMedia: true }),
        );
        return;
      default:
        return;
    }
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    current = socket;
    socket.on('error', () => undefined);
    socket.on('close', () => {
      sockets.delete(socket);
      senderOf.delete(socket);
      if (current === socket) current = null;
    });
    const reader = createFrameReader();
    socket.on('data', (chunk: Buffer) => {
      for (const frame of reader.push(chunk)) {
        const message = decodeCastMessage(frame);
        handle(socket, message.namespace, message.sourceId, message.data);
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;

  return {
    port,
    device: {
      id: 'fake-device-1',
      friendlyName: 'Fake TV',
      model: 'Chromecast',
      address: '127.0.0.1',
      port,
      lastSeenAt: 0,
    },
    received,
    countOf: (type) => received.filter((message) => message.type === type).length,
    get launched() {
      return launched;
    },
    get playerState() {
      return playerState;
    },
    get loadedUrl() {
      return loadedUrl;
    },
    get volume() {
      return { level: volumeLevel, muted: volumeMuted };
    },
    changeVolumeExternally: (level, muted) => {
      volumeLevel = answerFor(level);
      if (muted !== undefined) volumeMuted = muted;
      // Announced to everybody, because this is somebody else's change and we are one of
      // the "everybody". A set with `broadcastsReceiverStatus: false` announces nothing
      // and the new level is then only ever found by a poll — which is the founder's own
      // `AI PONT`, measured, and the harder of the two worlds to satisfy.
      if (broadcastsReceiverStatus) {
        for (const socket of sockets)
          send(socket, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
      }
    },
    swallow: (type) => void swallowed.add(type),
    unswallow: (type) => void swallowed.delete(type),
    swallowNext: (type, count) => void swallowedNext.set(type, count ?? 1),
    forgetAppsOnce: (count = 1) => {
      hideAppsFor += count;
    },
    rejectNextLoad: () => {
      rejectLoad = true;
    },
    setClockSkewSec: (seconds) => {
      skewSec = seconds;
    },
    setReleaseDelayMs: (ms) => {
      releaseDelayMs = ms;
    },
    setIdleReportsZero: (reports) => {
      idleReportsZero = reports;
    },
    setBufferingReportsZero: (reports) => {
      bufferingReportsZero = reports;
    },
    setSeekBehaviour: (behaviour) => {
      seekErrorSec = behaviour.errorSec ?? 0;
      seekLagStatuses = behaviour.lagStatuses ?? 0;
      seekBufferMs = behaviour.bufferMs ?? 0;
    },
    setReportsPosition: (reports) => {
      reportsPositionAtAll = reports;
    },
    setFetchesMedia: (fetches) => {
      fetchesMedia = fetches;
    },
    setFetchesTracks: (fetches) => {
      fetchesTracks = fetches;
    },
    setRefetchesTrackOnSwitch(refetches) {
      refetchesTrackOnSwitch = refetches;
    },
    get trackFetchStatuses() {
      return [...trackFetchStatuses];
    },
    get activeTrackIds() {
      return [...activeTrackIds];
    },
    trackFetches,
    get editTracksCount() {
      return editTracksCount;
    },
    refetch: () => fetchMedia(),
    setStreamsFilm(on, options) {
      streamsFilm = on;
      if (options?.bufferSec !== undefined) bufferSec = options.bufferSec;
      if (options?.setupRequests !== undefined) setupRequests = options.setupRequests;
      if (options?.deliveryDelayMs !== undefined) deliveryDelayMs = options.deliveryDelayMs;
      if (!on) {
        cancelDeliveryTimer();
        abandonFilmStream();
      } else if (loadedUrl !== null) beginFilmFetch();
    },
    stallFilmStream() {
      filmStreamStalled = true;
      stopStarveTimer();
      // It stops playing because no bytes are arriving — not because anything told it so.
      starveTimer = setTimeout(starve, bufferSec * 1000);
      starveTimer.unref?.();
      timers.add(starveTimer);
    },
    breakFilmStreamNow() {
      const response = filmResponse;
      if (response === null) return;
      filmStreamStalled = false;
      // Destroyed the way a reset arrives: the response dies, `broken()` runs, this
      // television does **not** go back for the bytes, and the media server records
      // `media.delivery_interrupted` at this instant and not a moment earlier.
      //
      // The request goes with it. A paused response holds a socket that a `destroy()` on
      // the message alone can leave open for a tick, and "the delivery died at *this*
      // moment" is the whole point of this verb.
      response.destroy();
      filmStream?.destroy();
    },
    setRefetchesAfterStreamBreak(on) {
      refetchesAfterStreamBreak = on;
    },
    get filmStreamAlive() {
      return filmResponse !== null;
    },
    get filmStreamBreaks() {
      return filmStreamBreaks;
    },
    get filmStreamAttempts() {
      return filmStreamAttempts;
    },
    get supersededIdles() {
      return supersededIdles;
    },
    fetchStatuses,
    failMedia: () => {
      setState('IDLE');
      idleReason = 'ERROR';
      announce();
    },
    announceReceiverStatus: () => {
      if (current !== null) send(current, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
    },
    setPositionSec: (seconds) => {
      positionSec = seconds;
      positionAtMs = monoNowMs();
    },
    get positionSec() {
      return currentPositionSec();
    },
    remoteSet: (state) => {
      setState(state);
      announce();
    },
    finish: () => {
      // The device really is at the end; it simply does not report a position when it
      // says FINISHED, which is the whole point of this fake being unhelpful here.
      setState('IDLE');
      idleReason = 'FINISHED';
      positionSec = durationSec;
      announce();
    },
    takeover: (options = {}) => performTakeover(options),
    goSilent: () => {
      silent = true;
      answersPings = false;
    },
    setAnswersPings: (answers) => {
      answersPings = answers;
    },
    setBroadcastsReceiverStatus: (broadcasts) => {
      broadcastsReceiverStatus = broadcasts;
    },
    setOtherApp: (app) => {
      otherApp = app === null ? null : { appId: app.appId, displayName: app.appName };
      if (app !== null) {
        launched = false;
        sessionId = null;
        transportId = null;
        mediaSessionId = null;
        mediaSilent = true;
      }
      if (broadcastsReceiverStatus && current !== null) {
        send(current, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
      }
    },
    stopFromTv: (options = {}) => {
      launched = false;
      sessionId = null;
      transportId = null;
      mediaSessionId = null;
      mediaSilent = true;
      setState('IDLE');
      idleReason = 'CANCELLED';
      if (current !== null) {
        send(current, NS_RECEIVER, 'receiver-0', receiverStatusPayload());
        // Not every device closes the socket when its app quits; some just say the app is
        // gone and leave the connection up. Both are real, and the engine has to get the
        // "who ended this?" answer right either way.
        if (options.closeConnection !== false) {
          send(current, NS_CONNECTION, 'receiver-0', { type: 'CLOSE' });
        }
      }
    },
    dropConnections: () => {
      for (const socket of sockets) socket.destroy();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of timers) clearTimeout(timer);
        // A held film stream would otherwise keep this process — and the media server's
        // own response — alive after the test that opened it has finished.
        streamsFilm = false;
        abandonFilmStream();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
