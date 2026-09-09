/**
 * Every tunable number in the product, in one file, with the PRD line it comes from.
 * Nothing else in the engine is allowed to hardcode a timeout or a threshold.
 */

export const TIMING = {
  /** CASTV2 heartbeat. Two missed PONGs (10 s) declares the socket dead. */
  pingIntervalMs: 5_000,
  pingMissesBeforeDead: 2,
  /** PRD: optimistic UI reconciles with device truth within 2 s. */
  optimisticWindowMs: 2_000,
  /** Local position extrapolation rate for a smooth readout. */
  positionTickHz: 4,
  /** PRD: the readout is within 1 s of device truth. Beyond that we snap to the device. */
  positionToleranceSec: 1,
  /**
   * How far *behind* what we already knew a device's final position may be and still be
   * believed. Stopping cannot move the playhead backwards, so a report from well before
   * where we were is not a position — it is a device that has already reset itself.
   * The founder's TV answers a stop at 402.678 s with `currentTime: 0`. Generous enough to
   * accept a status that is simply a little stale (releases measured 386–843 ms).
   */
  finalPositionToleranceSec: 2,
  /** Explicit GET_STATUS re-anchor interval — this is what kills drift over 2 h. */
  statusReanchorMs: 1_000,
  /**
   * How long we wait for a device to acknowledge STOP before moving on.
   *
   * The message is always *sent* — this only bounds how long we wait to hear back, so a
   * wedged TV cannot hold the next cast hostage for the full request timeout. Comfortably
   * inside the 5 s cast budget.
   */
  releaseTimeoutMs: 2_000,
  /**
   * How long a position change waits for another one before it is sent to the device.
   *
   * PRD 6g names 400 ms for the ±30 s taps: four taps inside the window are one two-minute
   * jump and one round trip, not four. Drag-releases go through the **same** coalescer
   * rather than a second mechanism, which is what makes 6d — five rapid seeks issuing only
   * the final position — true by construction instead of by a separate rule. The founder
   * never waits on it: the readout jumps to the destination the instant they let go, and
   * this only delays the wire message.
   */
  seekSettleMs: 400,
  /**
   * How long a seek may go unconfirmed before we retry it once (PRD 6e).
   *
   * Deliberately the same 2 s as the optimistic window for play/pause: it is the same
   * promise — the display may lead the device this far and no further.
   */
  seekConfirmMs: 2_000,
  /** How close the device must land to the requested position to count as confirmed (6a). */
  seekToleranceSec: 1,
  /**
   * M5a, 23d: how long a `SET_VOLUME` may go unanswered before it is retried **once**.
   *
   * **It is 4a's existing play/pause budget, not a new promise about volume** — the PRD is
   * explicit that no new timing constant enters the product for M5a, and this is a deadline
   * for a retry rather than a throttle. **The throttle is the device's own round trip**: one
   * command is on the wire at a time and the next goes when the echo arrives, which is why
   * a drag can never flood the socket carrying the film however fast a finger moves.
   *
   * Measured against real hardware before it was written down (SPIKE-5, 2026-09-07): the
   * founder's `AI PONT` answered every in-range level in **85–222 ms**, median 140. So this
   * deadline sits comfortably past what the house actually does, and a retry means
   * something went wrong rather than something was slow.
   *
   * ⚠️ It is measured **from the command being sent**, never from the founder's press. A
   * settle timer would spend the budget on purpose and make the number unmeetable — 23a's
   * own "fails if".
   */
  volumeEchoMs: 500,
  /**
   * PRD 17a: the budget the **firewall diagnosis** is measured against, from the Cast press.
   *
   * It was 3b's budget too until the founder's 2026-08-18 ruling ("keep trying, tell me
   * later"); "couldn't reach the device at all" now has its own, longer bound below. So
   * this budget is 17a's alone, and raising it loosens no other promise.
   *
   * **Founder's ruling, 2026-09-09: 15 s → 22 s**, after checklist item 6 was walked on
   * real hardware and the diagnosis measured **16.52 s** — over a budget the comment on
   * `firewallDiagnosisMs` below had already worked out was unmeetable, and said so in
   * writing ("16.5–21 s after the press, against a criterion that says 15") without the
   * criterion ever being changed. That is the whole reason this constant moved: the
   * arithmetic was right, it was recorded, and nothing acted on it for three weeks.
   *
   * **22 s, not 20 s, and the extra two seconds are the point.** The founder first said
   * 20; 20 covers the 16.52 s measured that day but not the 21 s worst case the same
   * arithmetic predicts, because a television spends 6.4–10.6 s booting its own receiver
   * before the load even happens. A budget that fits the good night and fails the slow one
   * would have to be re-argued after another evening on real hardware.
   *
   * ⚠️ This is a **promise about how long the founder stares at a spinner**, so it may not
   * drift upward to accommodate a slow diagnosis. If a measurement ever exceeds it again,
   * the thing to fix is the wait — starting with the ~2 s spent on a stop a blocked
   * television can never answer (`session.stop_timed_out`) — not this number.
   */
  castFailureBudgetMs: 22_000,
  /**
   * The hard wall between pressing Cast and "Couldn't reach \<name\>".
   *
   * **Founder's ruling, 2026-08-18**: asked what should happen when the television is slow
   * to wake, they chose *"keep trying, tell me later"* — a cast that succeeds at 20 s beats
   * a failure at 15 s — and accepted waiting around 25–30 s before being told, on the
   * understanding that the wait stays bounded and the sentence, when it comes, is the same
   * one: "Couldn't reach \<name\>", with *Try again*, and every other device still
   * selectable.
   *
   * 28 s is that ruling with the worst case arithmetic inside it: a connect (0.2 s
   * observed), a full 14 s LAUNCH that goes unanswered, and one silent retry of it. The
   * device that is simply **switched off** is unaffected and still reported in ~13 s —
   * `connectRetries` never reaches this wall, because a TCP connect to a dead address
   * fails or times out at 4 s, three times over.
   */
  castUnreachableBudgetMs: 28_000,
  /**
   * The most we will wait, after a device accepts a LOAD, for it to fetch a single byte
   * before naming the likeliest cause (PRD 17a).
   *
   * This is a ceiling, not the wait itself: the real wait is whatever is left of
   * `castFailureBudgetMs` when the load is accepted. A firewall blocks *inbound* to the
   * media server, so LAUNCH and LOAD both complete at full price — and the founder's own
   * hardware spends 6.4–10.6 s of the budget booting its receiver app before the load even
   * happens. Counting 10 s from the load put the diagnosis at 16.5–21 s after the press,
   * against a criterion that says 15.
   */
  firewallDiagnosisMs: 10_000,
  /**
   * …and the least we will wait, however little of the budget is left.
   *
   * A television that took 14 s to boot has spent the budget, but accusing it of being
   * firewalled before it has had a moment to ask for the first byte would be a confident
   * wrong answer. Being a second or two late beats being wrong.
   */
  firewallDiagnosisMinMs: 2_500,
  /**
   * How far inside the budget the diagnosis aims.
   *
   * "Within 15 s" is a promise, and a timer armed to fire at exactly 15,000 ms keeps it
   * only if nothing else on the machine wants the CPU first — measured at 15,001 ms, which
   * is a broken promise for no reason anyone would care about. Aiming half a second early
   * costs nothing and makes the criterion hold with room.
   */
  firewallDiagnosisMarginMs: 500,
  /** PRD: reconnect for 30 s before the founder is told anything. */
  reconnectBudgetMs: 30_000,
  reconnectBackoffMs: [500, 1_000, 2_000, 4_000] as const,
  reconnectBackoffMaxMs: 4_000,
  /**
   * How long an **orderly** close is held before it is called "the founder stopped it on
   * the TV".
   *
   * SPIKE-2 on the founder's hardware, 2026-08-17: a takeover sends `CLOSE` on the
   * connection namespace **first**, and the `RECEIVER_STATUS` naming the other appId
   * arrives only afterwards — 4,300 ms later (YouTube: CLOSE at 2,028 ms, status at
   * 6,328 ms) and 11,329 ms later (Prime Video: 48,691 ms → 60,021 ms). The socket does
   * not close in either case. For that whole window a takeover and a genuine stop from
   * the TV's own remote are byte-identical: both are an empty `applications` list followed
   * by a CLOSE.
   *
   * So the information to tell them apart does not exist yet, and 15 s is the worst
   * measured gap plus ~30% headroom. Concluding sooner shows the founder *Stopped, your
   * place is saved* and then corrects itself to *someone took the TV* seconds later, which
   * is the wrong story told twice.
   *
   * The wait is not dead time: the supervisor reconnects (126 ms measured) and re-probes
   * the receiver throughout it, so a close that was neither a stop nor a takeover — a
   * spurious CLOSE, a socket the TV dropped — recovers inside the first second instead of
   * ending the evening.
   */
  takeoverGraceMs: 15_000,
  /**
   * How often the receiver is re-probed while a recovery is deciding what happened.
   *
   * One probe is not enough: the television is idle for the first several seconds of a
   * takeover and only names the new app later.
   */
  recoveryProbeMs: 1_000,
  /**
   * PRD M2, "Numbers M2 adds for testability only": reattach after reopening the app ≤ 5 s.
   * The approved mockup labels the reattach screen "Transient (≤5s)". SPIKE-2 measured a
   * brand-new process rejoining a running session in **86 ms**.
   */
  reattachBudgetMs: 5_000,
  /**
   * PRD 11e: *Buffering* that has not resolved in this long becomes a recovery attempt
   * rather than an indefinite spinner. Restated in "Numbers M2 adds for testability only".
   *
   * Applies only once a session has actually played — a cast that never produced a picture
   * belongs to the firewall diagnosis (17a) and to "couldn't play this file" (3c).
   */
  bufferingRecoveryMs: 10_000,
  /**
   * **How long the television gets to come back for the film's bytes by itself, after a
   * recovery, before we hand it the film again** (defect D2).
   *
   * A control channel that reconnects is not a film that is playing. When the outage broke
   * the *device's* byte connection — a pulled cable does exactly that, `ECONNRESET`
   * six seconds in, 2026-08-27 — the Default Media Receiver never asks for another byte:
   * it plays out what it had buffered and starves. So the media path is repaired with a
   * fresh LOAD at the position the television itself reports.
   *
   * Two seconds, and both directions are argued. Longer and 11b's *"playing again within
   * 10 s of the network returning"* stops fitting a rejoin, a wait and a load. Shorter and
   * a well-behaved receiver that would have re-requested on its own gets a reload it never
   * needed — which is why this is a wait at all rather than an immediate reload.
   */
  mediaRepairGraceMs: 2_000,
  /**
   * **How long after a rejoin a byte delivery dying still belongs to that outage** — the
   * 229 ms race, `AI PONT`, 2026-08-28.
   *
   * The check above runs once, when the control channel comes back. That evening it looked
   * at a delivery that was still counted as in flight — a black-holed socket is one neither
   * end has been told about yet — and stood down. `media.delivery_interrupted` was recorded
   * **229 ms later**, with nothing left watching, and the film did not play again for
   * another 38 seconds: 41.96 s against 11b's ten.
   *
   * **When a dead socket becomes observable is the OS's business, not ours.** It surfaced
   * six seconds *into* the outage on 2026-08-27 and 2.4 s *after the rejoin* on 2026-08-28.
   * A longer grace would only trade one arbitrary number for another and would slow every
   * healthy recovery down with it, so instead the interruption is **listened for** while
   * this window is open, and looked at the moment it arrives.
   *
   * **Six seconds, and it is 11b's own arithmetic rather than a guess.** The whole promise
   * is ten seconds from the network returning; a repair costs `mediaRepairGraceMs` (2 s) of
   * standing back plus the LOAD and the television's own fetch — 1.4 s on the `AI PONT`,
   * measured. Six leaves that fitting inside ten with room for a rejoin. An interruption
   * that surfaces later than this is past saving inside 11b whatever we do, and falls to
   * 11e's stall route exactly as it does today.
   */
  mediaRepairWatchMs: 6_000,
  /**
   * **The hard ceiling on how long a LOAD of our own may make the session deaf to `IDLE`.**
   *
   * A LOAD issued on a session that is already playing replaces media the television is
   * still holding, and the set answers with `IDLE`/`INTERRUPTED` for the media session it
   * has just superseded — which is not the film stopping (defect D2, 2026-08-28). The
   * reducer therefore ignores a non-`FINISHED` `IDLE` while one of our LOADs is in flight,
   * and the flight is ended by the LOAD settling, whether it succeeded or threw.
   *
   * This is the belt for the case where it never settles at all. A LOAD's own worst case is
   * a launch (`launchTimeoutMs` × `launchRetries` + 1) plus `loadTimeoutMs` — under a
   * minute — and by then 11c's thirty seconds has long since spoken. **A window that never
   * closed would swallow a television genuinely abandoning a film, which is worse than the
   * bug it exists to prevent**, so it closes itself.
   */
  liveLoadIdleWindowMs: 60_000,
  /** Network interface change polling, for a laptop that changed IP while asleep. */
  interfaceWatchMs: 2_000,
  /**
   * PRD 11d: after 30 s of the PC being offline — **and not before** — a button appears
   * that opens Windows' network settings. Before that, a blip is a hiccup to be ignored,
   * and offering a settings page for it would make one look like a problem.
   */
  offlineHelpAfterMs: 30_000,
  /**
   * How often a live session's position is written to the settings file.
   *
   * Story 12 re-derives the position from the device itself on reattach, which SPIKE-2
   * measured as accurate to 0.031 s — so this number only has to be good enough for the
   * log and for the case where the device cannot be asked. Once a second would be a disk
   * write per second for a fact nothing reads.
   */
  sessionPersistMs: 10_000,
} as const;

export const PREPARATION = {
  /** PRD: cast begins only when ≥ 10 minutes are prepared… */
  headStartSeconds: 600,
  /** …and conversion is running faster than 1.5× real time. */
  headStartMinSpeed: 1.5,
  /** PRD: the playhead never comes within 2 minutes of the conversion frontier. */
  frontierMarginSeconds: 120,
  /**
   * …and the margin the live guard **releases** at (M3b, 2026-08-21).
   *
   * Hysteresis, and it is the whole reason the guard cannot flap: firing and releasing on
   * the same number would hold the picture, resume it a second later, hold it again — which
   * is worse than the stall it is preventing, because a stall at least holds still.
   */
  frontierReleaseMarginSeconds: 180,
  /**
   * How often the playhead is compared against the frontier, **for the whole session**.
   *
   * An opening check is what 2026-08-21 disproved: the starved run's worst freeze (25.5 s)
   * arrived 199.9 s in, long after any gate would have opened. The frontier updates about
   * once a second and the device's position about once a second, so 2 s samples nothing
   * twice and misses nothing.
   */
  frontierSampleMs: 2_000,
  /**
   * The window the head-start gate's speed is measured over, and it is not a taste.
   *
   * A clip-length reading over-states this machine by about a third (SPIKE-4, 2026-08-20:
   * 362 Mpx/s over 60 seconds of a film that sustained 258–299 over its whole length), and
   * **an over-stated speed opens the gate on a conversion that cannot hold it** — which is
   * the 2026-08-21 starved run, arrived at by arithmetic instead of by `--rate 0.7`.
   */
  headStartSpeedWindowMs: 60_000,
  /**
   * The window the *guard's* estimate is measured over, which is a different question.
   *
   * The gate asks "can this conversion be trusted for the next hour"; the guard asks "how
   * long until the margin is back", and the honest answer to that is about what the
   * conversion is doing **now**. Long enough not to be one noisy ffmpeg report, short
   * enough that the wait restates itself as conditions change (10f).
   */
  frontierSpeedWindowMs: 10_000,
  /** HLS segment length; also the receiver's playlist reload interval. */
  hlsSegmentSeconds: 4,
  /**
   * A stall: the device's own reported position failing to advance for this long while the
   * app believes the film is playing and nothing was pressed (10b, restated 2026-08-21).
   *
   * 10b had no definition until then, so nothing could count them — which is how a run with
   * 46 seconds of frozen picture reported two assumptions "confirmed".
   */
  stallSeconds: 2,
  /**
   * How little the position may move and still count as frozen.
   *
   * Not zero: `currentTime` is a float the receiver derives from its own decoder, and two
   * reports of a genuinely stopped picture came back 0.065 s apart on the founder's own
   * hardware. A quarter of a second is far below anything a person would call movement and
   * far above the noise.
   */
  stallToleranceSec: 0.25,
  /** Estimated output size × this, checked against free disk before starting. */
  diskHeadroomFactor: 1.15,
  /**
   * PRD 7f (`LONG_PREP`): over 20 minutes of estimated preparation, one confirmation stands
   * between the press and the work. At or under, preparation is one press and no
   * confirmation ever appears.
   */
  longPrepSeconds: 1_200,
  /**
   * Above this many **text** subtitle tracks in one film, preparation keeps English only
   * (founder decision, 2026-08-21).
   *
   * Every text track becomes a `.vtt` file in the founder's own film folder, and *All Quiet
   * On The Western Front* carries **41** of them — German ×3, Spanish ×3, Chinese, Turkish
   * ×2 and the rest. Forty-one files beside one film is not preservation, it is mess, and
   * nobody imagined it when 8e was written.
   *
   * Six because PRD question 17 already takes six language tracks as the top of normal
   * ("a film with six language tracks — how much of a chooser does the founder want?"). At
   * or under it nothing changes and every track is still carried; the cap only ever fires
   * on the pathological file it was written for.
   *
   * **This costs the founder no choice.** 18f reads subtitles from the *source* file, never
   * from the prepared copy, so when M3c lands all 41 languages are still selectable. The
   * cap decides only what survives the day the source is deleted — and 8e's sentence says
   * so before a button is pressed.
   */
  subtitleTrackCap: 6,
  /**
   * PRD 7a: the whole check — spawn ffprobe, parse it, classify it — completes within 3 s.
   *
   * It is a promise about the *check*, not about ffprobe, which is why the two numbers
   * below are separate. Only one of the three steps can take measurable time.
   */
  checkBudgetMs: 3_000,
  /**
   * What one ffprobe run is given before it is killed and the check reports that it could
   * not finish.
   *
   * Deliberately **inside** `checkBudgetMs` rather than equal to it: spawning the process,
   * parsing its JSON and classifying the result all happen after ffprobe answers, and a
   * probe timeout set at the full budget would let the check itself miss the promise it is
   * made of. ffprobe reads headers, not the file — a local film answers in tens of
   * milliseconds, and 2.5 s is a drive that has gone to sleep, not a big film.
   */
  probeTimeoutMs: 2_500,
  /**
   * How much stdout we will accept from ffprobe before killing it.
   *
   * Its output is untrusted input from another process (see `media/ffprobe.ts`). A real
   * report for a file with dozens of streams is tens of kilobytes; 4 MiB is three orders of
   * magnitude of headroom and still a bound.
   */
  probeStdoutLimitBytes: 4_194_304,
  /**
   * How long a killed ffmpeg is given to actually exit before we answer anyway.
   *
   * **This exists because of Windows, and it was found on hardware** (2026-08-20). Killing a
   * process and resolving in the same breath means the caller deletes the staging file while
   * ffmpeg still holds it open — `unlink` on an open file is fine on Linux and is `EBUSY` on
   * Windows, so every WSL test passed and a `.partial` was left beside the founder's film.
   * Well inside 8d's 2 s, because it is the *first* half of that budget; the retrying delete
   * below is the second.
   */
  cancelExitWaitMs: 500,
  /**
   * How hard we try to delete something we wrote, and how long between attempts.
   *
   * The same Windows fact from the other end. A handle can linger for a moment after a
   * process exits — an antivirus scanner reading the file we just closed is the common
   * case — and `fs.rm`'s own retry options exist for exactly this. 8 × 100 ms is 0.8 s,
   * which with `cancelExitWaitMs` keeps the whole of 8d's *"stops within 2 s and leaves
   * nothing behind"* inside its budget with 700 ms to spare.
   */
  cleanupRetries: 8,
  cleanupRetryDelayMs: 100,
  /**
   * The floor on any estimate we state.
   *
   * Nothing finishes instantly, and "Ready in about 0 seconds" is a sentence that makes the
   * app look broken rather than fast.
   */
  minimumEstimateSeconds: 2,
  /**
   * How far a prepared sibling's duration may sit from its source and still be the same film
   * (ADR 2026-08-19). It is what tells the film apart from a trailer, a different cut or
   * another language — and ±1 s is the PRD's own tolerance for "same duration" in 8c.
   */
  artifactDurationToleranceSec: 1,
  /**
   * **Seeds, not measurements.** The classifier's estimate is a pure function of the file
   * and these numbers, and they are replaced by what this PC actually does the first time a
   * job runs on it (criterion 8b: the number the founder is shown is the honest one, and a
   * 3-minute job is never announced as 20 seconds).
   *
   * `remuxBytesPerSecond` is deliberately not disk speed: a `+faststart` MP4 is written and
   * then rewritten to move its index to the front, so the job moves roughly twice the file.
   * 80 MB/s effective puts a 4 GB two-hour film at ~50 s, inside the PRD's 60 s target with
   * very little to spare — which is the honest place for a seed to sit, because a seed that
   * flatters the machine turns into a founder-visible overrun on the first real film.
   *
   * **The two conversion numbers are in different units, and that is the point** (SPIKE-4,
   * 2026-08-20). Re-encoding only the sound leaves the picture a stream copy, and audio
   * encoding really is bound by the *length* of the film — so it stays a multiple of real
   * time. Re-encoding the **picture** is bound by **pixels**, and expressing it as a
   * multiple of real time was not merely inaccurate, it was the wrong shape: measured on the
   * founder's PC, `libx264 -preset veryfast` ran at **24.3× real time** for a 1280×528 film
   * and **7.96×** for a 1080p one — a threefold spread — while the same two runs came out at
   * **393.5** and **412.8 megapixels per second**, five per cent apart. One number in
   * pixels covers every resolution; one number in real time cannot cover two.
   */
  throughput: {
    remuxBytesPerSecond: 80_000_000,
    audioConvertSpeed: 20,
    /**
     * Megapixels of output per second, re-encoding the picture with `libx264 -preset
     * veryfast`.
     *
     * **250, and it is a *sustained* figure, which is the whole lesson here.**
     *
     * SPIKE-4 first measured 60-second clips and got **393–413 Mpx/s**, so this was seeded at
     * 350 — a 15% margin that felt cautious. Then the founder converted a real 113-minute
     * film and it ran at **258.8 and 298.8 Mpx/s** across two runs, making the app announce
     * 15 minutes for a job that took 21. Announcing *shorter* than reality is the one
     * direction criterion 8b forbids.
     *
     * A 60-second clip of that same film measured **362 Mpx/s**, so the source codec is not
     * the cause — the cause is **length**. A short clip enjoys burst clocks, a cold-and-idle
     * machine and warm caches; a twenty-minute encode has none of those. Clip measurements
     * overstate sustained throughput by roughly a third, and no margin taken off a clip
     * figure is trustworthy. 250 is ~3% below the slowest full-length run observed.
     *
     * Hardware encoding would roughly double it — `h264_nvenc` measured 713–781 Mpx/s on
     * clips and works since the founder's driver reached 610.88 — and is **not adopted**
     * pending a quality comparison at matched settings (2026-08-20 ADR). If it ever is, this
     * number cannot simply be scaled: NVENC's throughput is *not* flat across resolutions
     * the way libx264's is, so it needs a seed of its own.
     */
    videoMegapixelsPerSecond: 250,
    /**
     * …and the same figure with NVIDIA's encoder, which M3b adopted on 2026-08-20.
     *
     * **700 against 809.3 measured over a whole 113-minute film**, a ~13% margin in the only
     * direction 8b allows. Sustained, not a clip — and note that the correction runs the
     * *opposite* way from the software path: libx264 falls from 362 Mpx/s on a clip to
     * 258–299 sustained because a CPU encode throttles, while NVENC rises from 714 to 809
     * because a fixed-function block does not and a short run is dominated by its own
     * startup. The lesson that clips overstate is true of one encoder and false of the other,
     * which is why each carries its own measured number rather than a shared rule of thumb.
     */
    videoMegapixelsPerSecondNvenc: 700,
  },
} as const;

export const MEDIA_SERVER = {
  /** Persisted; scans upward if taken. */
  defaultPort: 8010,
  portScanAttempts: 20,
  /** Bound on all interfaces so an IP change does not require a rebind. */
  bindAddress: '0.0.0.0',
} as const;

export const CAST = {
  /**
   * How far apart two reported volume levels must be before the set has actually **moved**.
   *
   * ⚠️ **Measured on a `Chromecast Ultra`, 2026-09-08.**
   * That set reports one unchanged level as two different floats —
   * `0.10000000149011612` and then `0.09999999403953552` — roughly 100 ms apart, with
   * nothing having happened in between. An exact `!==` reads that as a change.
   *
   * What it actually cost was noise rather than a broken promise, and that distinction is
   * worth keeping straight: every wobble published a fresh snapshot to the renderer and
   * wrote a `session.volume_reported` line for a level that had not moved. It also fed
   * `volumeMovedSince`, where "did the television move" is the gate on 23d's single retry —
   * so an exact comparison makes that judgement on float noise. **23d's retry is triggered
   * by a non-answer, so no retry was actually missed on that set** (the Ultra answered in
   * 98 ms; it simply answered with the level it was already on, which 23b requires the app
   * to show). This constant makes the "did it move" question mean what it says.
   *
   * 0.005 is half a step of the coarsest control any of the three sets reports
   * (`stepInterval` 0.05 on a `Chromecast`), so it can never mask a real
   * single-step change while swallowing float noise several orders of magnitude smaller.
   * The selftest's own `SAME` uses the same number for the same reason.
   */
  volumeSameLevel: 0.005,
  /** Google's Default Media Receiver. No developer account, no hosted receiver, no cloud. */
  defaultReceiverAppId: 'CC1AD845',
  /**
   * The app the `takeover` selftest scenario launches to take the television away from us.
   *
   * YouTube's universal id, chosen because SPIKE-2 watched a phone do exactly this and the
   * device reported `appId: 2C6A6E3D, universalAppId: 233637DE, displayName: "YouTube"` —
   * so it is the takeover the criterion was written about, and it is present on every
   * Chromecast. Launched with nothing queued, so it takes the screen and plays nothing.
   *
   * **Only ever used by the selftest.** The engine has no way to launch any app but the
   * Default Media Receiver, and criterion 14b depends on it staying that way.
   */
  takeoverProbeAppId: '233637DE',
  /**
   * Apps that mean **nothing is on the television**, not "somebody has taken it".
   *
   * `E8C28D3C` is Backdrop, the ambient screensaver a Chromecast runs when it is idle —
   * photographs, weather, the time. A device sitting on it is a device on its home screen,
   * and treating it as a takeover made every stop from a TV remote report "\<name\>
   * is now playing Backdrop", with a *Take it back* button for a screensaver.
   *
   * Matched by display name as well, because the ambient app's id has changed before and
   * a device that reports `displayName: "Backdrop"` is telling us the same thing whatever
   * id it uses.
   */
  idleAppIds: ['E8C28D3C', 'E8C28D3D', '84912283'] as readonly string[],
  idleAppNamePattern: /^(backdrop|ambient|screensaver)/i,
  port: 8009,
  serviceType: 'googlecast',
  /** One TCP+TLS handshake. Three of these plus overhead must fit the 15 s unreachable budget. */
  connectTimeoutMs: 4_000,
  /** PRD: two *silent* retries before the founder is told anything. */
  connectRetries: 2,
  /** Gap between connection attempts — long enough to matter, short enough to stay in budget. */
  connectRetryDelayMs: 500,
  /** A request the device never answers. Deliberately short: reconciliation, not the promise, drives the UI. */
  requestTimeoutMs: 5_000,
  /**
   * LAUNCH wakes an app on the TV and is the slowest exchange in the protocol.
   *
   * **14 s, and the number comes from measurement rather than taste.** Every hardware run
   * this milestone recorded the round trip from `session.loading` to
   * `cast.receiver_launched` on the founder's own televisions:
   * **6,172 / 6,191 / 6,235 / 6,288 / 7,931 / 7,986 ms** warm, and a worst-ever
   * observation of **10,590 ms**. At the old 10,000 ms that left roughly **2 s of
   * headroom** on a warm device and none at all on a cold one — and on 2026-08-18 a
   * television that had been idle 56 minutes crossed it: `cast.connected` at +181 ms, then
   * ten seconds of silence, then "Couldn't reach \<name\>" about a television that
   * was working perfectly.
   *
   * 14 s is the worst observation plus ~32%, and the worst *warm* one plus ~75%. It is
   * deliberately not larger: `launchRetries` covers the case a single long wait cannot,
   * and `TIMING.castUnreachableBudgetMs` is what actually bounds the founder's wait.
   */
  launchTimeoutMs: 14_000,
  /**
   * How many times a LAUNCH that goes unanswered is re-sent, silently (PRD 3b).
   *
   * Until 2026-08-18 the PRD's "two silent retries" covered only `connectRetries` — the
   * TCP/TLS handshake, which is the fastest and most reliable step in the sequence. The
   * *slowest* one got exactly one chance. This is the ceiling; the deadline below is the
   * promise, and at 14 s an attempt the founder's real wait usually allows two attempts.
   */
  launchRetries: 2,
  /**
   * Don't start another LAUNCH attempt with less than this left of the founder's wait.
   *
   * A retry that cannot outlast the fastest boot ever measured (6,172 ms) is a retry that
   * cannot succeed, and spending the last of the budget on it only delays the sentence the
   * founder is owed. Clamped to the launch timeout itself, so a test that shortens the
   * timeout does not accidentally disable retries.
   */
  launchMinAttemptMs: 8_000,
  /**
   * LOAD: handing the device a URL it has already got a receiver for.
   *
   * Split out of `launchTimeoutMs` on 2026-08-18. The two used to share a number, so
   * widening the launch would have silently widened this as well — and LOAD is not the
   * slow exchange. A device that accepts the LOAD and then never fetches a byte is 17a's
   * firewall diagnosis, not this timeout.
   */
  loadTimeoutMs: 10_000,
  /** …and the least a LOAD gets, however little of the founder's wait is left. */
  loadMinTimeoutMs: 2_000,
  /**
   * How long the non-destructive "what is already running?" probe waits.
   *
   * Deliberately shorter than `requestTimeoutMs`: SPIKE-2 measured a rejoin at **86–126 ms**
   * on real hardware, and after a takeover the *old* media session never answers at all —
   * a 5 s wait there would eat a third of the takeover grace for information that is not
   * coming.
   */
  rejoinTimeoutMs: 2_000,
} as const;

export const DISCOVERY = {
  /** How often we check that the devices we know about are still there. */
  sweepIntervalMs: 8_000,
  /** How long a refresh browse listens for new devices before it stops. */
  sweepWindowMs: 4_000,
  /**
   * How long to wait for a device to accept a TCP connection on its Cast port before
   * calling that probe a miss. Two real casts connected in 0.11 s and 0.09 s, so this is
   * two orders of magnitude of headroom.
   */
  probeTimeoutMs: 2_000,
  /**
   * Consecutive missed probes before a device leaves the list. Two misses at an 8 s sweep
   * is ~16–24 s, inside the PRD's 30 s budget for a device that was switched off, while
   * still surviving a single dropped packet.
   */
  probeMissesBeforeLost: 2,
  /**
   * Last-resort expiry for a device we have heard nothing from *and* never managed to
   * probe. It has to sit comfortably above the devices' own re-announcement interval,
   * measured at 60–120 s on the founder's network: at the old 25 s every device left the
   * list on a metronome and came back on the next announcement, which is the flapping the
   * founder saw. Liveness is the probe's job; this is only a safety net.
   */
  deviceExpiryMs: 180_000,
  /** Registry housekeeping tick. */
  expiryCheckMs: 1_000,
  /** PRD: "No devices found" is shown once the search has had 5 s and found nothing. */
  emptyAfterMs: 5_000,
} as const;

export const SKIP = {
  /** PRD story 6b: the ±30 s controls of the approved design. */
  stepSeconds: 30,
} as const;

/**
 * M3c's subtitle numbers. **Engineering numbers, not product decisions** — the PRD says so,
 * and says changing one costs nothing.
 */
export const SUBTITLES = {
  /**
   * One nudge, in seconds. PRD: *"big enough to feel across a room, small enough that two
   * presses cover the usual release mismatch. Finer than 0.25 s is below what anyone can
   * judge on a television from a sofa."*
   *
   * **The first number to revise after one real evening**, in the PRD's own words.
   */
  nudgeStepSeconds: 0.5,
  /**
   * How far either side of *in sync* the **ladder** reaches — the range a press crosses
   * instantly, because every offset inside it is already declared on the television.
   *
   * ±3 s, confirmed by the founder on 2026-08-26 in the same exchange that chose the step.
   * With the step above it makes **13 rungs**, which is what the LOAD declares. Beyond it,
   * up to `maxOffsetSeconds`, an offset costs one reload at the remembered position.
   */
  ladderSpanSeconds: 3,
  /**
   * 20e's clamp: ten times the worst release mismatch anyone here has seen, and a bound the
   * selftest can assert rather than a feeling.
   */
  maxOffsetSeconds: 30,
  /**
   * How long extracting and converting **one** track may take on a 2-hour film before it
   * has to appear as its own named step with a Cancel (18d) rather than an unexplained wait.
   */
  prepareBudgetMs: 5_000,
  /**
   * The `trackId` of the **first rung of the ladder** — the one shifted furthest early.
   *
   * Step 3 declared one track and this was it. Step 4 added the other twelve beside it, in
   * ascending order of offset, so this is now where the numbering starts rather than the
   * only number there is: *in sync* is the rung in the middle, and `subtitles/ladder.ts`
   * is the one place that knows which. The LOAD's `tracks` array was built variable-length
   * from the beginning so that this step added rungs rather than reshaping the message.
   */
  firstTrackId: 1,
} as const;

export const SELFTEST = {
  /**
   * M5a, 23a: the most `SET_VOLUME`s a thirty-step drag may put on the wire.
   *
   * **Bounded by round trips, not by presses.** One command is in flight and one value
   * waits behind it, so a drag costs roughly one message per round trip it spans — measured
   * as **2** on the `AI PONT` (85–222 ms) and **1–2** on the Ultra (3–8 ms). Ten leaves
   * generous room for a slow set while still failing loudly if the slot ever becomes a
   * queue, which grading against "presses − 1" would have let through by one message.
   */
  dragVolumeMessages: 10,
  /** 13c: a device we never found is "could not run" (exit 2), never a pass. */
  deviceWaitMs: 30_000,
  /** PRD 5a: samples every 10 s… */
  positionSampleMs: 10_000,
  /** …for 10 minutes. Override with `--duration`. */
  positionDefaultDurationMs: 600_000,
  /** How long a scenario waits for a state the device should have reached. */
  stateWaitMs: 20_000,
  /**
   * `--outage network`: how long the television's route to this PC is taken away.
   *
   * **Twelve seconds, and both bounds are argued.** Long enough that the reconnection
   * cannot be a formality — the harness's other outages are reconnected in a millisecond,
   * which is why every recovery it has ever produced succeeded on the first attempt — and
   * well inside the *"away for ≤ 30 s"* that 11b makes its promise about. Short enough
   * that a television with a healthy buffer may still be mid-film when the route returns,
   * which is the case the founder actually met: on 2026-08-27 the set had ~23 s of film in
   * hand and the outage lasted 24.1 s.
   */
  networkOutageHoldMs: 12_000,
  /**
   * `--outage network`: how long to wait for the television to actually be **fetching** the
   * film before taking its route away, and how long a delivery must have been open to be
   * the film rather than a setup request.
   *
   * **Thirty seconds, because the house needed eighteen.** On 2026-08-28 the `AI PONT`
   * reached `playing` at `05:25:13.883`, made its small setup requests — a header read and
   * a **15 KB tail read** of the MP4 index — and did not open the delivery that matters
   * (`bytes=3506176-`, 627,686,497 bytes) until `05:25:31.289`. The scenario cut the route
   * at ~5.8 s and exited 2 on three of four attempts, having broken nothing.
   *
   * **One second of dwell**, because a setup request is a delivery too and is over in
   * milliseconds, while the film's is held open for the evening. A run in which nothing
   * ever qualifies **exits 2** — that refusal is the point, not a failure of it.
   */
  networkDeliveryWaitMs: 30_000,
  networkDeliveryDwellMs: 1_000,
  /**
   * `--outage cable`: how long the founder has to walk to the PC and act, each way.
   *
   * Generous on purpose. This is the one scenario whose next step is a person standing
   * up, and a run that gives up while they are still walking would report "the cable was
   * never unplugged" about a founder who unplugged it — which is worse than waiting.
   */
  humanInterventionWaitMs: 120_000,
  /**
   * How long the cable stays out before the founder is asked for it back.
   *
   * **Deliberately past `TIMING.offlineHelpAfterMs` (30 s)**, and that is the whole point:
   * 11d promises that the give-up clock is *suspended* while this PC has no network, and
   * that the "open network settings" button appears after 30 s and not before. Neither can
   * be proved by an outage shorter than the deadline it is meant to survive.
   */
  cableOutageHoldMs: 35_000,
  /** How often the countdown speaks while the founder is standing at the PC. */
  cableProgressEveryMs: 5_000,
} as const;

export const LOGGING = {
  /** Rotation is by day; the file name carries the date. */
  filePrefix: 'engine',
  defaultLevel: 'info',
} as const;
