import type { DeviceId, SessionFlags, SessionState, Tier } from '../types.js';

/**
 * The snapshot is the *whole* of what the UI knows.
 *
 * The renderer holds no playback state of its own: it renders the latest snapshot
 * and sends intents back. That is what makes "the app always shows what the device
 * actually reported" true by construction rather than by discipline.
 *
 * Shape is expected to grow through M1–M3. `revision` increments on every push so a
 * late-arriving snapshot can never overwrite a newer one.
 */

export interface DeviceSnapshot {
  readonly id: DeviceId;
  readonly friendlyName: string;
  readonly model: string;
  /** False once mDNS says it went away — except for a device we are actively using. */
  readonly available: boolean;
}

export type DiscoveryPhase = 'searching' | 'found' | 'none';

export interface DiscoverySnapshot {
  readonly phase: DiscoveryPhase;
  readonly devices: readonly DeviceSnapshot[];
  readonly selectedDeviceId: DeviceId | null;
}

/**
 * What the file panel is showing — **not** the same question as the classifier's verdict.
 *
 * M1 shipped `checking | ready | prepare | impossible` here, and `src/engine/prepare/
 * classify.ts` shipped `ready | remux | convert | impossible` in M3a step 1. Two types, one
 * word, and they were never the same question, which is why `src/engine/index.ts` exports
 * the classifier's by name rather than with `export *`. Reconciled here, deliberately:
 *
 *  - **The classifier's four are criterion 7a's four verdicts about a file and a
 *    television.** `remux` and `convert` are two of them, with two different headlines
 *    ("Ready in about 40 seconds" · "Needs converting — about 25 minutes") and two very
 *    different meanings to a person deciding whether to start something. M1's `prepare`
 *    collapsed them into one, which the PRD's own list of four does not allow.
 *  - **`checking` is not a verdict; it is the absence of one.** The check is I/O — spawning
 *    ffprobe on a file that may be on a sleeping external drive — so there is a real
 *    interval where the honest answer is "we are looking". It has its own field,
 *    `StateSnapshot.check`, because it describes a file that is *not yet* the selection;
 *    see `CheckSnapshot`. **The engine never puts `checking` in a `FileVerdictSnapshot`**,
 *    and the member survives in this union only to keep M1's status region compiling until
 *    the file panel is rebuilt. Build against `snapshot.check`, and this member and
 *    `FileVerdictSnapshot.message` can both be deleted in the same change.
 *
 * So a verdict on screen is one of the classifier's four and the mapping is the identity.
 * Nothing translates a verdict into different words on the way to the screen: the
 * founder-facing strings below are the classifier's own, final, and the frontend renders
 * them rather than composing its own.
 */
export type VerdictKind = 'checking' | 'ready' | 'remux' | 'convert' | 'impossible';

/**
 * A file the founder has just chosen, whose check has not finished — `StateSnapshot.check`.
 *
 * It is **beside** `file` rather than inside it because `file` means "a file that has been
 * checked": everything downstream — Cast, Resume, the media server — reads it, and a
 * half-inspected entry appearing there for the few hundred milliseconds of a probe is a race
 * every one of those readers would have to learn about. So the panel shows this while the
 * check runs, and `file` changes in one step when the answer arrives.
 *
 * While this is set, the check is running and is **cancellable** — choosing another file, or
 * clearing the selection, kills the probe (7a).
 */
export interface CheckSnapshot {
  /** The film's name, so the panel names the file it is looking at. Never the path. */
  readonly name: string;
  /** Final wording. */
  readonly headline: string;
}

/**
 * The 20-minute confirmation (7f), as three finished sentences.
 *
 * Non-null **exactly when the confirmation state is on screen** — it is a state, never a
 * dialog, and it is on screen because the founder pressed the primary button on a job over
 * `LONG_PREP`. The strings are the engine's, for the same reason every other verdict string
 * is: the engine holds the numbers.
 */
export interface ConfirmationSnapshot {
  readonly startsWatching: string;
  readonly diskUse: string;
  readonly cancelWarning: string;
}

/**
 * The verdict, as the screen may have it.
 *
 * **What is deliberately not here**: no codec name, no profile, no level, no resolution, no
 * container name, no file path, no ffmpeg or ffprobe output, no estimate arithmetic. PRD 7a
 * forbids all of it on screen, and the cheapest way to guarantee a thing never appears on a
 * screen is for the renderer never to receive it. Every one of those facts is in the JSONL
 * log instead, on the `file.checked` record, where it is worth reading and nobody is
 * watching a film.
 */
export interface FileVerdictSnapshot {
  readonly kind: VerdictKind;
  /** 1, 2 or 3 for a decided verdict; `null` while checking and for a file we cannot cast. */
  readonly tier: Tier | null;
  /** The one sentence the founder reads. Final wording — render it, never compose it. */
  readonly headline: string;
  /** One plain line under the headline, or `null` when there is nothing to add. */
  readonly reason: string | null;
  /**
   * 8e: what preparation would throw away, said before the founder commits. `null` — the
   * common case — means nothing would be lost, and **nothing is said**. Never a warning
   * icon, never an empty row: when there is nothing here, there is nothing here.
   */
  readonly subtitleNotice: string | null;
  /**
   * 7f: the estimate is over `LONG_PREP`, so the primary button ends in an ellipsis and
   * pressing it opens the confirmation instead of starting work. `false` is 7h — one press,
   * no confirmation, ever.
   */
  readonly requiresConfirmation: boolean;
  /** Seconds of preparation. `0` for a file that needs none, `null` while checking and for an impossible one. */
  readonly estimateSeconds: number | null;
  /**
   * Non-null only while the confirmation state is up. Its presence *is* the state: there is
   * no separate boolean to disagree with it.
   */
  readonly confirmation: ConfirmationSnapshot | null;
  /**
   * The M1 field, kept only so the status region that still reads it keeps compiling until
   * the file panel is rebuilt against this shape.
   *
   * @deprecated Use `headline` and `reason`. Nothing new may read this.
   */
  readonly message: string;
}

export interface SelectedFileSnapshot {
  readonly path: string;
  readonly name: string;
  readonly durationSec: number | null;
  /**
   * `null` means **no claim has been made about this file**, and the frontend must not
   * imply one. Three ways to get here, all of them honest: no device is selected yet so
   * there is nothing to check against; this machine has no ffprobe (every WSL session and
   * every engine test, where the file panel still shows a name and a duration); or the
   * check could not finish, in which case `notice` says so.
   */
  readonly verdict: FileVerdictSnapshot | null;
}

export interface PreparationSnapshot {
  readonly active: boolean;
  readonly percent: number;
  readonly secondsRemaining: number | null;
  /** Seconds of media converted so far — the frontier the playhead must not approach. */
  readonly frontierSec: number | null;
  /**
   * What is happening, in the founder's words. `null` when nothing is being prepared.
   *
   * Two sentences and not one, because a repackage and a conversion are different waits:
   * *Repackaging Cars.mkv…* finishes in under a minute and *Converting Cars.mkv…* may take
   * twenty. Naming the file matters as much as naming the job — this is a state the founder
   * may leave the room during, and coming back to a progress bar with no subject on it is
   * the moment they wonder what the app is doing to their disk.
   */
  readonly headline: string | null;
  /**
   * Where the prepared file is being written, **only when it is not beside the source**.
   *
   * 9e: a read-only or full source folder sends the artifact to CastGood's own working
   * folder *"and the app says where it went"*. This is the only place a path is allowed on
   * screen in the whole product, and it is allowed because the sentence is useless without
   * it — the founder has to be able to go and find the file.
   */
  readonly fallbackDirectory: string | null;
  /** Every state over 2 s is cancellable, and this one writes gigabytes (8d). */
  readonly cancellable: boolean;
  /**
   * Roughly how long until watching can start — 10a's *"the app said beforehand"*.
   *
   * Only ever set while a **conversion** is running with a head start ahead of it, and
   * `null` whenever there is nothing honest to say: a repackage (which has no head start), a
   * job too young to have measured a speed, or a film shorter than the head start, which
   * casts when the conversion finishes and whose wait is `secondsRemaining`.
   *
   * It is deliberately not the same number as `secondsRemaining`: one is when the film can
   * be *watched*, the other is when the conversion is *done*, and on a two-hour film they
   * are twenty minutes apart.
   */
  readonly watchableInSeconds: number | null;
  /**
   * **The wait is still being worked out** — no sustained speed exists yet.
   *
   * The gate needs a minute of measured speed before it will trust one, and so does the
   * countdown, for the same reason: on 2026-08-26 a 4K conversion's opening burst told the
   * founder *"about 23 seconds"* for a wait that ran **202**. This says so out loud instead,
   * and only a head-start conversion can set it — a repackage has no head start to wait for.
   */
  readonly estimatingWait: boolean;
  /**
   * 10f: **this film will not start early — it plays when the conversion is done.**
   *
   * True for a film shorter than the head start, and for a conversion whose sustained speed
   * is below the gate. `watchableInSeconds` is `null` whenever this is true, and that pairing
   * is the point: a countdown to a moment that will not arrive is the failure this project
   * has now corrected seven times, and it was in this very field until 2026-08-21.
   *
   * The live estimate to show alongside it is `secondsRemaining` — the conversion's own —
   * so there is one clock on screen rather than two that can disagree. It may go back to
   * `false` if the conversion speeds up past the gate, which is 10f's *"restated as it
   * changes"* and not a glitch.
   */
  readonly playsOnCompletion: boolean;
}

/**
 * The guard holding the picture (10i), as one object that is either there or not.
 *
 * It was three flat fields — `holding`, `holdingMessage`, `waitingForCompletion` — which
 * typechecked into combinations that cannot happen (`holding: true` with no message) and
 * made the renderer carry a fallback sentence duplicating the engine's copy. One nullable
 * object cannot express any of that: **its presence is the hold**.
 */
export interface HoldSnapshot {
  /**
   * The sentence, final and founder-chosen: *Still preparing — back in about 40 seconds*.
   *
   * **Never the word *Buffering***: criterion 11e turns a *Buffering* longer than 10 s into a
   * reconnection attempt, and three of the freezes in the 2026-08-21 starved run would each
   * have torn down a healthy connection to fix a problem that was never the network's. It
   * restates itself as the estimate changes (10f), so a wait that stops updating is a bug
   * rather than a rounding. Render it; never compose it.
   */
  readonly message: string;
  /**
   * The conversion cannot catch up at all, so the film will play when it is finished (10f).
   *
   * The sentence in `message` already says so; this is for the screen that wants to *look*
   * different for a wait of minutes than for one of seconds. The way out is unchanged and
   * there is deliberately **no new control**: *Stop*, then *Resume from \<position\>*, both
   * of which stay live throughout.
   */
  readonly waitingForCompletion: boolean;
}

/**
 * **M3b: the film is playing while the conversion is still running.**
 *
 * Non-null exactly when a television has been given a growing playlist — which is the one
 * situation in the product where the film on screen and the file on disk are not the same
 * length. It is separate from `preparation` on purpose: `preparation` is a progress bar the
 * founder is waiting in front of, and this is a film they are watching. M3b cut 3 says the
 * playback screen shows **no conversion percentage and no second progress bar**: what a
 * founder watching a film needs is one number when the picture is held — how long — not a
 * live view of the encoder. Nothing here is that view.
 */
export interface HeadStartSnapshot {
  /**
   * Seconds of film that exist so far. The scrubber draws everything past this as
   * unavailable, against `session.durationSec`, which is **our own** probe's answer (10c).
   */
  readonly frontierSec: number;
  /**
   * The furthest a drag may land: the frontier less the two-minute margin (10d).
   *
   * **Capped at the film's own length**, so it can never exceed `session.durationSec` in the
   * last minutes of a conversion — the engine's seek clamp takes the same minimum, and two
   * places computing the same limit is two places to disagree.
   *
   * The engine refuses anything past it and reports the clamp as `seek.clamped: 'frontier'`,
   * so the screen can say how far ahead the founder can go. The receiver clamps
   * independently at its own live edge — two belts, one pair of braces — and a seek's
   * landing position is always read back from the next status, never assumed.
   */
  readonly seekLimitSec: number;
  /**
   * The guard is holding the picture (10i) — **and its presence *is* the hold.**
   *
   * While it is set: the position readout stays exactly where it was, *Stop* stays live, and
   * nothing else changes. It is not a new screen; it is a sentence on the one the founder is
   * already looking at.
   */
  readonly hold: HoldSnapshot | null;
  /**
   * ffmpeg has finished: the playlist is closed and the film is no longer growing.
   *
   * The guard stands down here and seeking opens up to the whole film. The prepared MP4 is
   * beside the source by now; the segments the television is still reading go when it lets
   * the television go (10g).
   */
  readonly conversionComplete: boolean;
}

/**
 * A position change the founder has asked for and the device has not confirmed yet.
 *
 * Its whole job is to let the readout show the **destination** rather than where the film
 * still is (PRD 6b, 6h) without the renderer inventing anything: the engine states where
 * it is taking the playhead, and the renderer reads it out.
 */
export interface SeekSnapshot {
  /** Where the founder asked to land. The readout shows this while it is set. */
  readonly targetSec: number;
  /**
   * The running total of taps not yet sent, for the `+1:30` readout. `null` for a drag,
   * which has no total to accumulate — it is one destination, not a sum.
   */
  readonly pendingDeltaSec: number | null;
  /**
   * Which end the jump ran into, so the app can state the real distance moved (6i).
   *
   * `frontier` is M3b's third answer: the drag went into film that has not been converted
   * yet, so it landed at the furthest safe point instead (10d). It is a sentence about how
   * far ahead the founder can go, never an error.
   */
  readonly clamped: 'start' | 'end' | 'frontier' | null;
  /**
   * Whether this came from dragging the scrubber or from a ±30 s tap.
   *
   * Added for M3b's frontier clamp (10d): *"dragging into it is refused with one line saying
   * how far ahead it can go"* is a different sentence from a tap that ran into the same
   * limit, and the design system wants both. It is a read-only projection of state the
   * session model has always carried — nothing new is remembered for it.
   *
   * **What is deliberately *not* here is `fromSec`**, the position the jump was measured
   * from, which is what the `+18s` rather than `+30s` readout of criterion **6i** needs. It
   * is not derivable here — `session.positionSec` is the *destination* while a seek is in
   * flight — and supplying it means keeping new state inside the seek coalescer, which is
   * the code 6d, 6g and 6h all turn on. That is M2 work with its own tests, not something to
   * do inside the milestone whose one untouchable promise is 10b.
   */
  readonly source: 'drag' | 'skip';
  /** True once the command is on the wire and we are waiting for the device (6e). */
  readonly inFlight: boolean;
}

/**
 * One thing the subtitle control can offer. **Off is not in this list** — see
 * `SubtitlesSnapshot.selectedId`, where `null` *is* Off.
 */
export interface SubtitleOptionSnapshot {
  /** Opaque to the screen. It is what a `subtitles.select` intent names back to us. */
  readonly id: string;
  /**
   * What the founder reads: the language the film names, *Track 2* when it names none, or
   * the sidecar's own filename. 18a: **no codec names, no stream indices, no file paths.**
   */
  readonly label: string;
}

/**
 * **The subtitle control** — 18a, 18b, 18k, 19a.
 *
 * Rebuilt on every check, which is what makes 7b's *"the check re-runs against the new
 * device"* extend to this list for free. Building it costs a directory listing and nothing
 * else: 18b is explicit that *"nothing beside the film is read until the founder chooses
 * it"*, so a folder of forty `.srt`s is forty string comparisons, not forty file reads.
 */
export interface SubtitlesSnapshot {
  /** Every track in the film and every sidecar beside it, in that order (18a). */
  readonly options: readonly SubtitleOptionSnapshot[];
  /**
   * Tracks that are pictures rather than words (18k), each with its own finished sentence.
   *
   * Listed rather than hidden on purpose: *"hiding them entirely reads as CastGood having
   * missed the subtitles the founder can see in the file."*
   */
  readonly unavailable: readonly { readonly label: string; readonly why: string }[];
  /**
   * The chosen source, or `null` for **Off** — which is the state on every film, every
   * time (19a). There is no separate boolean: `null` is Off and nothing else can be.
   */
  readonly selectedId: string | null;
  /** The chosen source's label, so the control can name it without looking it up. */
  readonly selectedLabel: string | null;
  /**
   * 18d's named step: *Preparing subtitles…*, with a Cancel, rather than an unexplained
   * delay before the picture. Extraction runs when the source is chosen, never on Cast.
   */
  readonly preparing: boolean;
  /**
   * One line, when a chosen source could not be used (18f, 18j) — and the selection is back
   * at Off when it is set, because the film still casts without them.
   *
   * Never parser output, never a file path. `null` is the common case, and when there is
   * nothing here there is nothing here.
   */
  readonly problem: string | null;
  /**
   * **The timing correction, as the founder reads it** — 20a.
   *
   * *"At zero it reads **Timing: in sync** — never `+0.0 s` — so a film nobody has touched
   * never looks adjusted."* The engine's own words, rendered verbatim: no frame rates, no
   * milliseconds, no cue counts. Only meaningful while a source is chosen; **Off** has
   * nothing to correct.
   */
  readonly timing: string;
  /** The same number for the machine — what Reset returns to zero and 20e clamps at ±30 s. */
  readonly offsetMs: number;
  /**
   * **This correction is one the founder set on an earlier evening** — 20f.
   *
   * *"…then the correction is applied **and stated**: Timing: +0.6 s, as you set it last
   * time, with Reset beside it."* The statement is the condition the whole memory was
   * accepted under: an offset is real data rather than a cache, so the one number on this
   * screen the founder did not just choose has to say where it came from.
   *
   * False the moment they press anything, because from then on it is theirs again — and
   * false at *in sync*, where there is nothing to have been remembered.
   */
  readonly timingRemembered: boolean;
  /**
   * 20e: at the clamp, *earlier* and *later* stop being offered rather than *"reading as a
   * dead button"*. One of the two is always still available, so a founder who has nudged
   * themselves into a mess is never stuck.
   */
  readonly canGoEarlier: boolean;
  readonly canGoLater: boolean;
  /**
   * A subtitle change is costing **one reload at your place**, and it is happening now.
   *
   * The founder accepted this cost on 2026-08-26 **on the condition that it is stated
   * rather than hidden** (19b, as amended). It is true only for the two changes that cannot
   * be handed to a television any other way: a source chosen while the film is playing, and
   * an offset past the ±3 s the declared ladder covers.
   */
  readonly reloading: boolean;
  /**
   * **The television took the track and never came for it** — 18l's *Try again*.
   *
   * True only in that one situation: the film is playing, the words are not there, and the
   * sentence in `problem` says so. Everything else in this control that can go wrong is
   * answered by choosing again (18j), which is a press the founder already has.
   */
  readonly canRetry: boolean;
}

/**
 * The television's own volume, as the television last reported it — M5a.
 *
 * **Every field here arrived in a receiver status.** Nothing is computed, remembered or
 * guessed, which is the whole of criterion 23b: *the level and mute the app displays are
 * the last ones a receiver status reported, and nothing else.* There is deliberately no
 * "pending" or "requested" level in this shape — a second copy of the number is exactly
 * the thing 23b forbids, and a shape that cannot hold one cannot leak one.
 *
 * `null` for the whole snapshot means **there is no session to read a volume from**, which
 * is 23i: no control at all when nothing is playing (founder's ruling, question 43).
 */
export interface VolumeSnapshot {
  /** `null` when the set has not said. **Not `0`** — a set that is not casting reports a
   * real `0` which is not its volume, so the two must stay tellable apart (SPIKE-5). */
  readonly level: number | null;
  readonly muted: boolean | null;
  /**
   * The set's own granularity, and it is **per-device, not a constant of ours**: measured
   * 0.01 on the founder's `AI PONT` and 0.05 on both Chromecast dongles. A slider drawn at
   * a fixed hundred steps would snap visibly on two of their three televisions.
   */
  readonly stepInterval: number | null;
  /**
   * False when the television says `controlType: 'fixed'` — it owns its own volume and we
   * may not set it (23h). The control is then really `disabled` with a reason beside it,
   * and **nothing appears in the StatusRegion or the TitleBar**: it is a refusal known
   * ahead, not a failure.
   */
  readonly controllable: boolean;
  /**
   * The level asked for and not yet answered — **a request, never a level**.
   *
   * §11 draws it as a tick with a hatched gap to the handle, borrowing §10's travel band
   * unchanged, and **it never positions the handle**. That separation is what lets the
   * screen show a television ignoring us: the tick stands and the handle does not move.
   * A control with no ask mark could not distinguish that from a press that never happened.
   *
   * `null` whenever nothing is outstanding, which is almost always — the founder's own
   * `AI PONT` answers in 85–222 ms.
   */
  readonly pending: number | null;
}

export interface SessionSnapshot {
  readonly state: SessionState;
  readonly flags: SessionFlags;
  readonly deviceId: DeviceId | null;
  readonly positionSec: number;
  readonly durationSec: number;
  readonly canSeek: boolean;
  /** `null` when the playhead is simply where the device says it is. */
  readonly seek: SeekSnapshot | null;
  /**
   * The place a *Resume* would start from. Survives Stop, the end of a file and a failed
   * cast, and is never reset to 0 by anything except choosing a different file.
   */
  readonly resumePositionSec: number;
  /**
   * What is on the television instead of us, when `flags.yielded` (14a).
   *
   * The app's own display name as the device reported it — "YouTube", "Prime Video" —
   * because the criterion states the fact rather than describing a problem.
   *
   * **`null` is the common case, not the edge case.** Checklist item 4 measured a real
   * television taking **45.9 s** to name the app a phone had cast to it, against a 15 s
   * grace — so most of the time nobody can name the thief, and 14a no longer promises to
   * (founder ruling, 2026-08-19). When this is `null` the screen says "<name> is playing
   * something else" and stops there; naming is an upgrade, never a wait.
   */
  readonly yieldedToApp: string | null;
  /**
   * 11d: 30 s offline and counting, so Windows' own network settings are worth offering.
   *
   * A boolean rather than a timestamp on purpose: the renderer holds no clock, and "has it
   * been thirty seconds?" is a question the engine already knows the answer to.
   */
  readonly offlineHelp: boolean;
  /**
   * *Subtitles: English* — 18g's half that a person on this side of the room can check.
   *
   * **Read-only, and it describes what was declared on the LOAD**, not what the founder has
   * since chosen: a track can only be handed to a television in a LOAD, so a choice made
   * mid-film is not on the screen the founder is watching. `null` whenever no track went
   * out with the film, which is every cast until subtitles are turned on.
   */
  readonly subtitleLabel: string | null;
  /**
   * M5a. `null` whenever there is no session to send a volume over — 23i, and the reason
   * the renderer needs no state of its own to decide whether to draw the control.
   */
  readonly volume: VolumeSnapshot | null;
}

/**
 * What kind of problem this is, so the screen can offer the right way out.
 *
 * The message itself is already founder-facing and final; this only decides which buttons
 * sit under it. A notice without a kind of its own is `generic` and gets the one action it
 * names.
 */
export type NoticeKind =
  | 'generic'
  | 'source-missing'
  | 'firewall-blocked'
  /**
   * ~30 s of failed reconnection (11c). The engine's message is deliberately generic —
   * the device's *name* belongs to the screen, which already knows it, and a notice that
   * hardcoded one would go stale the moment the founder picked a different TV.
   */
  | 'lost-connection'
  /**
   * The app's own copy of ffmpeg is not there, **in a packaged install**.
   *
   * In WSL, in the tests and under `npm run dev` before `fetch-ffmpeg` has run, having no
   * ffmpeg is entirely normal and nothing is said — the file panel simply makes no claim
   * about what a file needs. In a real installation the binaries are always present, so
   * their absence means the installation is damaged, and the founder is told that rather
   * than left with an app that quietly stopped checking files (devops, 2026-08-20). The
   * only way out is a reinstall, so this notice offers no action of its own.
   */
  | 'installation-damaged';

/** A fact for the founder — "the TV is being used by another app" — not an exception. */
export interface NoticeSnapshot {
  readonly kind: NoticeKind;
  readonly severity: 'info' | 'warning' | 'error';
  readonly message: string;
  readonly actionLabel: string | null;
}

export interface StateSnapshot {
  readonly revision: number;
  readonly discovery: DiscoverySnapshot;
  readonly file: SelectedFileSnapshot | null;
  /** Non-null while a chosen file is being checked. See `CheckSnapshot`. */
  readonly check: CheckSnapshot | null;
  readonly preparation: PreparationSnapshot;
  /** Non-null only while a television is playing a conversion that is still running (M3b). */
  readonly headStart: HeadStartSnapshot | null;
  readonly session: SessionSnapshot;
  /** The subtitle control. Always present; **Off** on every new film (19a). */
  readonly subtitles: SubtitlesSnapshot;
  readonly notice: NoticeSnapshot | null;
}

export const EMPTY_SNAPSHOT: StateSnapshot = {
  revision: 0,
  discovery: { phase: 'searching', devices: [], selectedDeviceId: null },
  file: null,
  check: null,
  preparation: {
    active: false,
    percent: 0,
    secondsRemaining: null,
    frontierSec: null,
    headline: null,
    fallbackDirectory: null,
    cancellable: false,
    watchableInSeconds: null,
    playsOnCompletion: false,
    estimatingWait: false,
  },
  headStart: null,
  session: {
    state: 'idle',
    flags: { reconnecting: false, reattaching: false, yielded: false, networkDown: false },
    deviceId: null,
    positionSec: 0,
    durationSec: 0,
    canSeek: false,
    seek: null,
    resumePositionSec: 0,
    yieldedToApp: null,
    offlineHelp: false,
    subtitleLabel: null,
    // Nothing is playing, so there is no volume to show — 23i, and the same value the
    // engine publishes for every idle and verdict state.
    volume: null,
  },
  subtitles: {
    options: [],
    unavailable: [],
    selectedId: null,
    selectedLabel: null,
    preparing: false,
    problem: null,
    timing: 'in sync',
    offsetMs: 0,
    timingRemembered: false,
    canGoEarlier: true,
    canGoLater: true,
    reloading: false,
    canRetry: false,
  },
  notice: null,
};
