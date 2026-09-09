import fsp from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { createFileSink, createLogger, systemClock } from './logging/index.js';
import type { Clock, Logger, LogLevel, LogSink } from './logging/index.js';
import { exportDiagnostics } from './diagnostics/export.js';
import { resolveAppPaths, type AppPaths } from './paths.js';
import { EMPTY_SNAPSHOT, type Intent, type StateSnapshot } from './protocol/index.js';
import type {
  CheckSnapshot,
  DeviceSnapshot,
  DiscoveryPhase,
  FileVerdictSnapshot,
  NoticeSnapshot,
  SelectedFileSnapshot,
  SubtitlesSnapshot,
  VolumeSnapshot,
} from './protocol/index.js';
import { createDiscovery, type Discovery, type Mdns } from './discovery/index.js';
import { createMediaServer, type MediaServer } from './media-server/index.js';
import { createCastClient, type CastClient, type TransportFactory } from './cast/index.js';
import {
  createSessionSupervisor,
  type SessionSubtitle,
  type SessionSupervisor,
} from './session/index.js';
import { createStore, type SessionSubtitleRecord, type Store } from './store/index.js';
import { createNetworkWatcher, type NetworkWatcher } from './network/index.js';
import type { InterfaceSource } from './discovery/interfaces.js';
import { inspectSource, type SourceInspection } from './media/inspection.js';
import type { FfprobeRunner } from './media/inspection.js';
import { createFfprobeRunner } from './media/ffprobe-runner.js';
import { describeFfmpeg, resolveFfmpeg } from './media/ffmpeg.js';
import { classify, confirmationFor, type Verdict, type VerdictKind } from './prepare/classify.js';
import { narrowAfterRefusal, resolveDeviceProfile } from './prepare/device-profiles.js';
import {
  canCatchUp,
  createPreparationPipeline,
  detectVideoEncoder,
  guardStep,
  recordFrontier,
  forecastGate,
  secondsUntilRelease,
  seekLimitSec,
  stillPreparingMessage,
  sustainedSpeed,
  willPlayWhenReadyMessage,
  INITIAL_GUARD,
  type FrontierSample,
  type GateVerdict,
  type GuardState,
  type HeadStartServe,
  type VideoEncoder,
  type PreparationFailure,
  type PreparationPipeline,
  type PreparationProgress,
  type PreparedArtifact,
} from './prepare/index.js';
import type { FfmpegBinaries } from './media/ffmpeg.js';
import type { SpawnLike } from './media/ffprobe-runner.js';
import {
  subtitleChoices,
  subtitleOriginFromId,
  type SubtitleChoices,
  type SubtitleSource,
} from './subtitles/sources.js';
import { clampOffsetMs, describeOffset } from './subtitles/cues.js';
import { subtitleFingerprint, subtitleOffsetKey } from './subtitles/offsets.js';
import { LADDER_STEP_MS, nudged } from './subtitles/ladder.js';
import {
  prepareSubtitle,
  type PreparedSubtitle,
  type SubtitleFailure,
} from './subtitles/prepare.js';
import { DISCOVERY, PREPARATION, TIMING } from './config.js';
import { isEngineError } from './errors.js';
import type { Device, DeviceId, DeviceProfile } from './types.js';

/**
 * The engine: everything CastGood actually does, as a plain Node library.
 *
 * **This module and everything under `src/engine/` imports nothing from Electron.**
 * That is not a style preference — it is what lets the whole of the reliability
 * behaviour run headless under vitest in WSL and in CI, against a fake receiver, and
 * what lets the selftest drive the *same* engine the app drives, through the same
 * intents. `test/architecture/engine-boundary.test.ts` fails the build if anyone
 * breaks it.
 *
 * Milestone 1 wired: continuous discovery, the media server, the Cast client and the
 * session supervisor. **Milestone 2 adds two more**, and both exist for one story each:
 * the settings store, because rejoining a session the television is still playing needs
 * the *same* media URL republished (story 12), and the network watcher, because "this PC
 * dropped off the network" and "the TV went quiet" look identical from a dead socket and
 * need opposite screens (11d). Preparation (M3) is still a typed seam.
 */

/**
 * How the margin guard's 2-second tick is produced — the one timer in the engine that a
 * test has to be able to *drive* rather than wait for.
 *
 * Everything else the guard is made of is already deterministic: `guardStep` is a pure
 * function and its unit tests advance nothing but numbers. What was not deterministic was
 * the wiring, and it showed: the integration test for a held film escaping needs three
 * consecutive ticks — hold, escape, hold again — which is six seconds of wall clock before
 * any scheduling overhead, and under the full suite a contended box slipped past the
 * deadline and turned the test that guards 10b red for reasons that had nothing to do with
 * the guard. **A check that passes or fails on machine load teaches everyone to shrug at
 * it**, which is the same corrosion as a check that cannot fail at all.
 *
 * So the tick is injected like every other piece of I/O in this engine. The shipping default
 * is `setInterval` at `PREPARATION.frontierSampleMs` and nothing about it changed.
 */
export interface GuardTicker {
  /** Begin ticking. Returns the function that stops it. */
  start(intervalMs: number, tick: () => void): () => void;
}

export const realGuardTicker: GuardTicker = {
  start(intervalMs, tick) {
    const timer = setInterval(tick, intervalMs);
    // Unref'd for the same reason every other engine timer is: a guard that is merely
    // waiting must never be the reason a process refuses to exit.
    timer.unref?.();
    return () => clearInterval(timer);
  },
};

export interface EngineOptions {
  readonly paths?: AppPaths;
  readonly logLevel?: LogLevel;
  readonly clock?: Clock;
  /** Supply a sink to capture logs (tests, selftest). Defaults to the daily JSONL file. */
  readonly logSink?: LogSink;
  /** Reported in the first log line so a log can be tied to a build. */
  readonly appVersion?: string;
  /**
   * Injected by the headless integration tests: a scripted mDNS responder and a plain-TCP
   * transport. The app and the selftest always get real multicast and real TLS.
   */
  readonly transport?: TransportFactory;
  readonly mdns?: Mdns;
  /** 0 asks the OS for any free port. The app uses the configured default. */
  readonly mediaPort?: number;
  /**
   * Show a file to the person — story 25, criterion 25b.
   *
   * ⚠️ **The engine writes the file; the host reveals it.** Revealing means Explorer, which
   * means Electron, which the engine may never import (`engine-boundary.test.ts`). So the
   * host passes this in and the engine calls it. Absent — in tests and the selftest —
   * nothing is revealed and the export still happens, which is why the return value carries
   * the path rather than relying on a folder having opened.
   *
   * 25b asks for the file to be **selected**, not for a path in a sentence. A path is a
   * thing to retype; a highlighted file is a thing to drag into a message.
   */
  readonly revealFile?: (filePath: string) => void;
  /** Scripted interface list, so 11d's "this PC went offline" is testable in WSL. */
  readonly networkInterfaces?: InterfaceSource;
  /**
   * Overridden only by tests: how long one LAUNCH attempt waits before it is retried.
   *
   * The shipping number is `CAST.launchTimeoutMs` (14 s), and three attempts of it is
   * three quarters of a minute of sleeping in the suite for assertions that are about the
   * *count* of attempts and what the founder sees between them.
   */
  readonly launchTimeoutMs?: number;
  /**
   * True in the installed app, false everywhere else. `src/main/` passes `app.isPackaged`.
   *
   * It buys exactly one thing: in a packaged install the bundled ffmpeg is **always**
   * present, so its absence means the installation is damaged and the founder is told
   * (2026-08-20, devops). In WSL, in the tests and in a dev tree that has not fetched the
   * binaries, having no ffmpeg is an ordinary condition and nothing is said about it.
   */
  readonly packaged?: boolean;
  /**
   * Run conversions at this multiple of real time instead of as fast as the machine can.
   *
   * **Only the selftest sets this**, and only for `--scenario headstart --rate <n>`: it is
   * how the starved case — a conversion that cannot keep ahead of playback — is produced
   * *through the product* rather than through a spike script republishing a fixture on a
   * timer. The app never passes it, no intent carries it, and there is no setting for it.
   * `unsafe` in the name for the same reason `unsafeTestOverrides` carries it: a value that
   * makes the product behave unlike itself must be obvious at every call site.
   */
  readonly unsafeConversionReadRate?: number;
  /**
   * The margin guard's tick, so a test can advance it deterministically. See `GuardTicker`.
   *
   * The app and the selftest leave it alone and get a real 2-second interval.
   */
  readonly guardTicker?: GuardTicker;
  /**
   * Seconds converted at full speed before `unsafeConversionReadRate` engages.
   *
   * Only `--scenario headstart --rate-after-gate <n>` sets it, and it is the only way to
   * produce **a conversion that falls behind mid-film on a real television**: burst past the
   * head-start gate, then run below real time so the frontier closes on the playhead.
   */
  readonly unsafeConversionReadRateBurstSec?: number;
  /**
   * How much room is left on a volume. The app never passes it; `freeBytesOn` is used.
   *
   * A seam for tests only, so a suite's result does not depend on how full the machine
   * running it happens to be. See `PreparationDeps.freeBytes` for what that cost this
   * branch.
   */
  readonly freeBytes?: (target: string) => Promise<number | null>;
  /**
   * The ffprobe runner. Injected by tests and by anything that wants a scripted probe;
   * the app and the selftest let the engine build one from `resolveFfmpeg()`.
   *
   * `null` states positively that this machine has none — which is what every engine test
   * in WSL is — and is not the same as leaving it undefined.
   */
  readonly ffprobe?: FfprobeRunner | null;
  /**
   * Where ffmpeg and ffprobe are. Injected by tests, exactly as `ffprobe` is and for the
   * same reason: `resolveFfmpeg()` answers from the disk, and under vitest the honest
   * answer is *nowhere* — the binaries in `resources/bin` are Windows executables a Linux
   * process cannot start, and the locator will not offer them.
   *
   * `null` states positively that this machine has none, which is what makes the whole
   * preparation half of the engine inert rather than half-working.
   */
  readonly ffmpeg?: FfmpegBinaries | null;
  /**
   * Which video encoder this machine has, stated rather than discovered.
   *
   * Same rule as `ffprobe` and `ffmpeg`: an engine test says what its environment is instead
   * of letting the engine find out. Detection **opens a real encoder**, so leaving it
   * undefined in a test spawns a child process the test did not ask for — which is exactly
   * how a scripted `spawn` ends up counting a probe as the job under test.
   */
  readonly videoEncoder?: VideoEncoder;
  /**
   * How child processes are started. Injected by tests so a preparation can be exercised
   * end to end — progress, cancel, retry, cleanup — without a Windows binary in WSL.
   *
   * It is **not** a way to run a different ffmpeg: the binaries still come from
   * `resolveFfmpeg()`, which has no PATH lookup, deliberately.
   */
  readonly spawn?: SpawnLike;
}

export type SnapshotListener = (snapshot: StateSnapshot) => void;

export interface Engine {
  readonly paths: AppPaths;
  readonly logger: Logger;
  /** `null` until the media server is listening; the selftest treats null as "cannot run". */
  readonly mediaServerPort: number | null;
  start(): Promise<void>;
  /**
   * `keepPlaying` leaves the television playing and keeps the reattach record — which is
   * what closing the window mid-film means (story 12). Everything else stops the cast.
   */
  stop(options?: { readonly keepPlaying?: boolean }): Promise<void>;
  /** Intents are validated at the IPC boundary before they reach here. */
  dispatch(intent: Intent): void;
  snapshot(): StateSnapshot;
  subscribe(listener: SnapshotListener): () => void;
  /**
   * **Harness only** — `selftest --outage network`, and defect D2's whole reason for
   * existing.
   *
   * Takes the television's route to this PC's media server away and gives it back, without
   * touching the interface table or needing anybody to stand at the PC. See
   * `MediaServer.unsafeBlackout`. The app never calls this and the renderer cannot reach
   * it: it is not an intent, and the IPC surface does not carry it.
   */
  unsafeMediaBlackout(on: boolean): number;
  /**
   * **Harness only** — `selftest --scenario subtitles --broken`, and 18l's only route to a
   * real television.
   *
   * Declares text tracks at a port this PC does not answer on, so the set genuinely cannot
   * fetch them while the film keeps arriving normally. See
   * `MediaServer.unsafeWithholdTracks`. Not an intent, and the IPC surface does not carry
   * it.
   */
  unsafeWithholdSubtitleTracks(on: boolean): void;
  /**
   * **Harness only** — is the television fetching the film *right now*, and for how long?
   *
   * `selftest --outage network` has to cut the route while a delivery is in flight, or it
   * has broken nothing and its verdict is worth nothing. It used to cut on a timer and
   * exited 2 on three of four hardware attempts: the `AI PONT` reached `playing` at
   * `05:25:13.883` and did not open the delivery that matters until `05:25:31.289`, **~18 s
   * later**, while the scenario cut at ~5.8 s. Reading this instead is the difference
   * between a scenario that can produce its own condition and one that races the
   * television's fetch pattern.
   *
   * `oldestForMs` separates the film's delivery from the short setup requests a receiver
   * makes first — a header read and a 15 KB tail read of the index, both over in
   * milliseconds. The app never calls this and the renderer cannot reach it.
   */
  unsafeMediaDeliveries(): { readonly count: number; readonly oldestForMs: number };
}

export function createEngine(options: EngineOptions = {}): Engine {
  const paths = options.paths ?? resolveAppPaths();
  const clock = options.clock ?? systemClock;
  const sink = options.logSink ?? createFileSink(paths.logDir, clock);
  const logger = createLogger({
    sink,
    clock,
    ...(options.logLevel === undefined ? {} : { level: options.logLevel }),
    bindings: { component: 'engine' },
  });

  const listeners = new Set<SnapshotListener>();
  let snapshot: StateSnapshot = EMPTY_SNAPSHOT;
  let started = false;
  let startedAtMono = 0;

  let devices: readonly Device[] = [];
  let selectedDeviceId: DeviceId | null = null;
  let file: SourceInspection | null = null;
  /**
   * The file being checked right now, which is **not** the selection until the check
   * finishes. See `CheckSnapshot`: everything downstream reads `file`, and a half-inspected
   * entry there would be a race every one of those readers had to know about.
   */
  let checking: CheckSnapshot | null = null;
  /**
   * Cancels the check in flight (7a). Choosing another file, clearing the selection and
   * stopping the engine all abort it, which kills the ffprobe child process.
   */
  let checkAbort: AbortController | null = null;
  /**
   * Which selection a resolving check belongs to. A probe that finishes after the founder
   * has already chosen something else must not overwrite the newer answer.
   */
  let selectionSeq = 0;
  let verdict: Verdict | null = null;
  /** 7f: the confirmation is a **state**, and this is it. Nothing is on disk while it is up. */
  let confirming = false;
  /** `undefined` = not looked yet; `null` = looked, and this machine has no ffprobe. */
  let resolvedProbeRunner: FfprobeRunner | null | undefined;
  let resolvedBinaries: FfmpegBinaries | null | undefined;
  let resolvedPipeline: PreparationPipeline | null | undefined;
  /**
   * Which encoder this PC can actually open (2026-08-20). **`libx264` until proven
   * otherwise**, and that default is the safe one in both directions: it is the encoder
   * that always exists, and it is the *slower* of the two, so an estimate made before the
   * probe answers over-states the wait rather than under-stating it — which is the only
   * direction criterion 8b allows.
   */
  let videoEncoder: VideoEncoder = options.videoEncoder ?? 'libx264';
  /** Spreadable, so `exactOptionalPropertyTypes` never sees an explicit `undefined`. */
  const spawnOption = options.spawn === undefined ? {} : { spawn: options.spawn };
  /**
   * The prepared file this television can play, when one already exists (7c, 9a).
   *
   * Found during the check, by name and then by probe, and it is what `startCast` hands the
   * television instead of the source. Cleared by anything that changes the question — a new
   * file, a different device — because it is an answer about a *pair*.
   */
  let prepared: PreparedArtifact | null = null;
  /** What we last handed a television. 7e narrows on what the device actually saw. */
  let lastCastPath: string | null = null;
  /**
   * **The subtitle control** — 18a's list, rebuilt on every check.
   *
   * A directory listing and the probe we already ran, and nothing else: 18b requires that
   * *"nothing beside the film is read until the founder chooses it"*, so building this
   * opens no files at all.
   */
  let choices: SubtitleChoices = { sources: [], unavailable: [] };
  /**
   * What the founder chose, or `null` for **Off** — the state on every new film (19a).
   *
   * A `SubtitleSource` rather than an id, because a *Choose a file…* pick is not in
   * `choices` at all: it is a file from anywhere, used where it lives (18c).
   */
  let subtitleChoice: SubtitleSource | null = null;
  /** The cues, once there are some. Never zero of them — that is refused (18j). */
  let subtitleTrack: PreparedSubtitle | null = null;
  /**
   * The last thing this film prepared, **kept across an Off**.
   *
   * 19b: *"Turning them back on restores them just as fast."* Without this, Off throws the
   * cues away and turning subtitles back on mid-film re-runs the extraction — up to five
   * seconds of ffmpeg for a track the founder had on screen a moment ago, and a promise the
   * criterion makes in as many words would be broken by the tidiest possible code. Dropped
   * when the film changes, which is where everything else about a choice is dropped too.
   */
  let preparedCache: PreparedSubtitle | null = null;
  let subtitlePreparing = false;
  /** One line, and the selection is back at Off whenever it is set (18f, 18j). */
  let subtitleProblem: string | null = null;
  /** Cancels the extraction in flight: choosing another source, or clearing, kills it. */
  let subtitleAbort: AbortController | null = null;
  /**
   * The extraction in flight, as a promise, so shutting down can **wait for it to be over**.
   *
   * The same discipline `preparationTask` uses and for the same reason: a promise nobody
   * holds is a child process that may still be writing a file after the founder's window
   * has closed, and the tidy-up below would then remove a file that had not been written
   * yet. Resolved when nothing is running.
   */
  let subtitleTask: Promise<void> = Promise.resolve();
  /** Which choice a resolving extraction belongs to, so a stale answer cannot land. */
  let subtitleSeq = 0;
  /**
   * **The timing correction, in integer milliseconds** — story 20, and it is founder state.
   *
   * It lives here rather than in the session because the founder can nudge before Cast as
   * well as during a film: with no television in the room the number simply moves, and the
   * first LOAD declares the rung it lands on. `0` is *in sync*, which is what every film
   * starts at and what **Reset** returns to in one press (20e).
   *
   * Cleared with the choice, by `clearSubtitle`: an offset is a correction to a *file*, and
   * a file nobody has chosen has nothing to correct.
   */
  let subtitleOffsetMs = 0;
  /**
   * **True when the offset on screen is one the founder set on some earlier evening** — 20f.
   *
   * *"…the correction is applied **and stated**: Timing: +0.6 s, as you set it last time."*
   * The whole reason the criterion asks for a statement is that this is the one number in
   * the product the founder did not just choose, so the screen has to say where it came
   * from. Cleared by the next press, because from then on it is theirs again.
   */
  let subtitleOffsetRemembered = false;
  /** What actually went out on the last LOAD. 18g's label reads this, not the choice. */
  let castSubtitle: { readonly label: string } | null = null;
  /** The job in flight, and the handle that cancels it (8d, P6). */
  let preparation: PreparationRun | null = null;
  /** The same job as a promise, so shutting down can wait for it to be over. */
  let preparationTask: Promise<void> = Promise.resolve();
  /** Segment removals, chained so two of them cannot race each other over one folder. */
  let segmentCleanup: Promise<void> = Promise.resolve();
  /** How the guard's 2 s tick is produced, and how it is stopped. See `GuardTicker`. */
  const guardTicker = options.guardTicker ?? realGuardTicker;
  let stopGuardTicker: (() => void) | null = null;
  /**
   * M3b: the film being watched while its conversion is still running.
   *
   * Outlives `preparation` on purpose. The conversion finishes, the progress bar goes, the
   * prepared MP4 is beside the source — and the television is *still* playing the segments,
   * because interrupting a film to hand it an identical file would be the tidy-up disturbing
   * the film in progress, which 10g forbids in as many words.
   */
  let headStart: HeadStartState | null = null;
  let notice: NoticeSnapshot | null = null;
  let mediaServerPort: number | null = null;
  let emptyTimer: NodeJS.Timeout | null = null;
  /** The device a live session owns, which is never dimmed or unpinned underneath it. */
  let inUseDeviceId: DeviceId | null = null;
  /**
   * True once the founder has touched anything that a reattach would overwrite.
   *
   * Story 12's reattach runs in the background while the window is already interactive —
   * that is deliberate, because holding the launch for it would trade criterion 1a away.
   * The cost is a race it used to lose silently: the remembered television turns up at
   * t=4 s, the founder chose a different film and pressed Cast at t=3 s, and the reattach
   * then replaced their file, their device and their cast with the previous evening's.
   *
   * A *selection* is not enough to set this — discovery preselects the first device found,
   * and nobody chose that. Only an intent the founder can have sent does.
   */
  let founderActed = false;

  /** A listener that throws is a bug in the UI. It must not take the engine with it. */
  /**
   * A preparation the founder is sitting in front of.
   *
   * There is one of these at most, ever. *"One conversion at a time. No queue, no worker
   * pool"* is an architecture rule, and it is also what makes cancelling and progress mean
   * anything — the 2026-08-19 ruling says preparing is always *"I want to watch this now"*.
   */
  interface PreparationRun {
    readonly abort: AbortController;
    readonly headline: string;
    readonly startPositionSec: number;
    /** The path the job is writing to, for the log and for the cast that follows. */
    readonly sourcePath: string;
    percent: number;
    secondsRemaining: number | null;
    frontierSec: number | null;
    fallbackDirectory: string | null;
    /** 10a: when watching can start, which is not the same question as when the job ends. */
    watchableInSeconds: number | null;
    /** 10f: this film will not start early; it plays when the conversion is done. */
    playsOnCompletion: boolean;
    estimatingWait: boolean;
  }

  /**
   * Everything M3b needs to know while a growing conversion is on a television.
   *
   * The guard's own state is `GuardState` and is stepped by a pure function; this is the
   * I/O around it — the timer, the frontier, the sentence, and the handle that removes the
   * segments when the television is finally let go.
   */
  interface HeadStartState {
    /** Where the segments are, so the tidy-up knows what it is removing. */
    discardSegments: () => Promise<void>;
    /** True once the television has actually been given the playlist. */
    serving: boolean;
    frontierSec: number;
    conversionComplete: boolean;
    guard: GuardState;
    /** Frontier history, for the guard's *"back in about…"* rather than for the gate. */
    samples: FrontierSample[];
    holdingMessage: string | null;
    waitingForCompletion: boolean;
    /** The last gate decision, so the founder can be told when watching starts (10a). */
    gate: GateVerdict | null;
    /** Set when the guard paused the film, so a founder's own pause is never resumed for them. */
    pausedByGuard: boolean;
    /**
     * True once the session has actually left `idle` for this head start.
     *
     * Without it, "the session is over, so the segments may go" fires **before the cast has
     * begun** — the session is `idle` in the moment between publishing the playlist and the
     * connection opening, and the tidy-up would delete the segments the television is about
     * to ask for.
     */
    sessionLive: boolean;
  }

  /**
   * Story 25 — write a redacted report of this run and show it to the person.
   *
   * ⚠️ **The subjects come from what the engine has actually seen**, never from guessing at
   * the shape of a path. Device names come from discovery, film names from the file that was
   * chosen, and the username from the data directory this process was given — which is where
   * all 249 occurrences measured on 2026-09-09 actually were.
   */
  async function exportReport(): Promise<void> {
    // `C:\Users\<name>\AppData\Local\CastGood` — the segment after `Users`.
    const parts = paths.dataDir.split(/[\\/]/);
    const afterUsers = parts.findIndex((part) => part.toLowerCase() === 'users');
    const username = afterUsers >= 0 ? (parts[afterUsers + 1] ?? null) : null;

    const outcome = await exportDiagnostics({
      logDir: paths.logDir,
      // Beside the data directory, never inside logDir (25g).
      destinationDir: join(paths.dataDir, 'reports'),
      subjects: {
        username,
        deviceNames: discovery.devices().map((device) => device.friendlyName),
        fileNames: file === null ? [] : [basename(file.path)],
      },
    }).catch((error: unknown) => {
      logger.error('diagnostics.export_failed', { error });
      return null;
    });

    if (outcome === null) return;
    if (outcome.kind === 'nothing-to-send') {
      logger.info('diagnostics.nothing_to_send', { why: outcome.why });
      return;
    }
    logger.info('diagnostics.exported', {
      lines: outcome.lines,
      bytes: outcome.bytes,
      // ⚠️ The path is logged; its CONTENTS are not. A log line quoting the report would
      // put the very thing that was just redacted back into the file it came from.
      filePath: outcome.filePath,
    });
    options.revealFile?.(outcome.filePath);
  }

  function notify(listener: SnapshotListener): void {
    try {
      listener(snapshot);
    } catch (error) {
      logger.error('snapshot.listener_failed', { error });
    }
  }

  function discoveryPhase(): DiscoveryPhase {
    if (devices.length > 0) return 'found';
    const elapsed = clock.monoMs() - startedAtMono;
    // "No devices found" only after the search has had its 5 seconds — before that the
    // honest answer is that we are still looking.
    return started && elapsed >= DISCOVERY.emptyAfterMs ? 'none' : 'searching';
  }

  /**
   * A file ffprobe ran on and could make nothing of.
   *
   * It is 7d's verdict and not a notice, because it is a fact about the file that is settled
   * **during the check, before the founder commits to anything** — and it needs no device to
   * be true, which is why it is built here rather than by the classifier. The sentence is
   * deliberately the classifier's own words for the same situation, so the app has one
   * vocabulary for "there is nothing in this file" rather than two.
   */
  const UNREADABLE_VERDICT: FileVerdictSnapshot = {
    kind: 'impossible',
    tier: null,
    headline: "This file can't be cast",
    reason: 'There is nothing readable in this file.',
    subtitleNotice: null,
    requiresConfirmation: false,
    estimateSeconds: null,
    confirmation: null,
    message: 'There is nothing readable in this file.',
  };

  function verdictSnapshot(): FileVerdictSnapshot | null {
    if (file === null) return null;
    if (file.failure === 'unreadable') return UNREADABLE_VERDICT;
    if (verdict === null) return null;
    return {
      kind: verdict.kind,
      tier: verdict.tier,
      headline: verdict.headline,
      reason: verdict.reason,
      subtitleNotice: verdict.subtitleNotice,
      requiresConfirmation: verdict.requiresConfirmation,
      estimateSeconds: verdict.estimateSeconds,
      confirmation: confirming ? confirmationFor(verdict) : null,
      // The M1 field. Everything new reads `headline` and `reason`.
      message: verdict.reason ?? '',
    };
  }

  function fileSnapshot(): SelectedFileSnapshot | null {
    if (file === null) return null;
    return {
      path: file.path,
      name: file.name,
      durationSec: file.durationSec,
      verdict: verdictSnapshot(),
    };
  }

  // --- Subtitles (M3c) -------------------------------------------------------

  /**
   * One finished sentence for each way a chosen source can fail to become a track.
   *
   * Every one of them ends the same way in practice: the selection goes back to **Off** and
   * *"the film still casts without them"* (18f). None of them is parser output, a codec
   * name or a file path — 18j is explicit about all three.
   */
  function subtitleProblemFor(failure: SubtitleFailure): string | null {
    switch (failure) {
      case 'source-missing':
        return 'Those subtitles are no longer where they were.';
      case 'unreadable':
        return 'CastGood couldn’t read that subtitle file.';
      case 'no-cues':
        return 'There are no subtitles in that file.';
      case 'extract-failed':
        return 'CastGood couldn’t get those subtitles out of this film.';
      case 'cancelled':
        // The founder chose something else. Nothing to say, and saying something would be
        // reporting their own action back to them as a problem.
        return null;
    }
  }

  /**
   * **18l's sentence, and it is the criterion's own words.**
   *
   * *"the app says 'Subtitles didn't load' with Try again"* — said about the words and never
   * about the film, because the film is still playing and nothing about it has changed. No
   * URL, no token, no mention of a fetch: what happened is CastGood's business, and what the
   * founder needs is one press.
   */
  const SUBTITLES_DID_NOT_LOAD = 'Subtitles didn’t load.';

  /**
   * The television's volume, for the one screen that may show it — M5a.
   *
   * **Two rules decide this whole function and neither is the renderer's to apply.**
   *
   * 23i: there is no control at all unless a session exists to send a command over, so a
   * state with nothing playing publishes `null` and the renderer draws nothing. The states
   * that *have* a session but cannot be sent to — reconnecting, lost, network down,
   * yielded — still publish the reading, and the control is drawn really `disabled`: a
   * device somebody else is using never receives a volume command from us (14b).
   *
   * 23b: every field is the device's own last word. There is no pending value here and no
   * place to put one, so the readout physically cannot move on a command the television
   * never confirmed.
   */
  function volumeSnapshot(): VolumeSnapshot | null {
    // ⚠️ **Every state that has let go of the television, not just `idle`.** §11 is explicit
    // — *"Ended, Stopped, SourceGone, and every idle and verdict state: not rendered"* — and
    // this asked about `idle` alone, so the control was drawn on the Stopped screen, which
    // keeps its transport row. The renderer test that covered this handed in `volume: null`
    // itself, so it proved the renderer's half of a value the engine never produced. 23i is
    // the engine's answer to give.
    const state = session.model.state;
    if (state === 'idle' || state === 'stopped' || state === 'ended') return null;
    const reported = session.reportedVolume();
    if (reported === null) return null;
    return {
      level: reported.level,
      muted: reported.muted,
      stepInterval: reported.stepInterval,
      // Only an explicit `fixed` is a refusal. An absent control type is a set that did
      // not say, and a set that did not say is not a set that said no — SPIKE-5 found
      // `master` and `attenuation` in the house and no `fixed` anywhere, so treating
      // silence as refusal would disable a control on every television that works.
      controllable: reported.controlType !== 'fixed',
      pending: session.pendingVolumeLevel(),
    };
  }

  function subtitlesSnapshot(): SubtitlesSnapshot {
    const offsetMs = clampOffsetMs(subtitleOffsetMs);
    // 18l outranks a refusal that has already been read: it is about the track that is on
    // the television right now, and a refusal (18j) has already put the control back at Off.
    const notLoaded = session.subtitleNotLoaded;
    return {
      options: choices.sources.map((source) => ({ id: source.id, label: source.label })),
      unavailable: choices.unavailable.map((entry) => ({ label: entry.label, why: entry.why })),
      selectedId: subtitleChoice?.id ?? null,
      selectedLabel: subtitleChoice?.label ?? null,
      preparing: subtitlePreparing,
      problem: notLoaded ? SUBTITLES_DID_NOT_LOAD : subtitleProblem,
      timing: describeOffset(offsetMs),
      offsetMs,
      // 20f: true only while the number on screen is one the founder set on an earlier
      // evening and has not touched since. The screen turns it into *"as you set it last
      // time"*; the criterion requires it to be **stated** rather than applied silently.
      timingRemembered: subtitleOffsetRemembered && offsetMs !== 0,
      // 20e's clamp, said by the control going quiet rather than by a button that moves
      // nothing. Compared against the *nudged* value so the two can never disagree about
      // where the edge is — one function decides both.
      canGoEarlier: nudged(offsetMs, -1) !== offsetMs,
      canGoLater: nudged(offsetMs, 1) !== offsetMs,
      reloading: session.subtitleReloading,
      // The only problem in this control with a way out that is not “choose another”: the
      // track is right, the words are right, and the television simply never came for them.
      canRetry: notLoaded,
    };
  }

  /**
   * **What the founder wants their subtitles to be, right now**, in the shape the wire needs.
   *
   * `null` is Off, and it is Off for two reasons that look the same from here: nothing is
   * chosen, or something is chosen and still being read. Neither can be handed to a
   * television, and both mean the same thing on screen.
   */
  function wantedSubtitle(): SessionSubtitle | null {
    const track = subtitleTrack;
    if (subtitleChoice === null || track === null) return null;
    return {
      key: track.sourceId,
      cues: track.cues,
      name: track.label,
      language: track.language,
      offsetMs: clampOffsetMs(subtitleOffsetMs),
    };
  }

  /**
   * Tell the session what the founder wants, and push the new number to the screen.
   *
   * **The two halves happen at different speeds, and that is 20c.** The screen moves now,
   * on the press; the wire moves 400 ms after the last press, because the session coalesces.
   * Nothing here waits for a television.
   */
  function publishSubtitle(): void {
    session.setSubtitle(wantedSubtitle());
    push();
  }

  /**
   * One press of **earlier** or **later** (20b), or **Reset** (20e).
   *
   * The arithmetic and the clamp are the engine's, exactly as the ±30 s skips' are: the
   * renderer holds no offset of its own to add half a second to, so it cannot disagree with
   * what is on the wire. A press at the clamp returns the clamp and nothing is sent.
   */
  function setSubtitleOffset(next: number, why: 'nudge' | 'reset'): void {
    if (subtitleChoice === null) {
      logger.warn('intent.ignored', { intent: `subtitles.${why}`, why: 'subtitles are off' });
      return;
    }
    if (next === subtitleOffsetMs) {
      push();
      return;
    }
    subtitleOffsetMs = next;
    // Whatever the number was before this press, it is the founder's own from here on, so
    // the screen stops crediting it to last week (20f).
    subtitleOffsetRemembered = false;
    logger.info('subtitle.offset_changed', { offsetMs: next, stepMs: LADDER_STEP_MS, why });
    // **Written down on the press, not at the end of the film.** 20f is a fact about a
    // file, and the founder's evening can end in a way no shutdown path sees — a power cut,
    // a forced restart. The store serialises and coalesces its own writes; this is a few
    // hundred bytes behind a nudge that is already 400 ms from the wire.
    rememberOffsetForCurrentChoice();
    publishSubtitle();
  }

  function nudgeSubtitle(steps: number): void {
    setSubtitleOffset(nudged(subtitleOffsetMs, steps), 'nudge');
  }

  /**
   * The key this film-and-source pair is remembered under, or `null` when there is no pair.
   *
   * All the thinking is in `subtitles/offsets.ts` and is pure; this is the lookup of the two
   * things it needs. `null` for a source chosen with no film, which cannot happen from the
   * UI — `chooseSubtitle` refuses it — and is checked here rather than assumed.
   */
  function offsetKeyFor(source: SubtitleSource | null): string | null {
    const film = file;
    if (film === null || source === null) return null;
    return subtitleOffsetKey({ filmPath: film.path, source });
  }

  /**
   * **Write the correction down against the source** — 20f, on every press.
   *
   * Nothing is stored until the words exist, because a correction is remembered against a
   * cue list it can be checked against later (`subtitleFingerprint`), and a founder who
   * pressed *later* while the file was still being read has not yet got one. That press is
   * not lost: the offset is theirs on screen already, and it is written the moment the track
   * lands, in `onSubtitleReady`.
   */
  function rememberOffsetForCurrentChoice(): void {
    const track = subtitleTrack;
    const key = offsetKeyFor(subtitleChoice);
    if (key === null || track === null) return;
    void store.rememberSubtitleOffset(key, {
      offsetMs: clampOffsetMs(subtitleOffsetMs),
      fingerprint: subtitleFingerprint(track.cues),
      savedAtWall: clock.wallMs(),
    });
  }

  /**
   * **The founder chose this source again, so their correction comes back** — 20f.
   *
   * *"…next week, after reopening the app, after restarting the PC."* Two things make this
   * safe against the 2026-08-19 ruling it might look like it contradicts: it runs **only**
   * after a source has been deliberately chosen, so it can never turn subtitles on; and it
   * is **stated on screen** rather than applied silently, which is the condition the PRD
   * attaches to it in as many words.
   *
   * The correction is dropped when the words are not the words it was set against — the
   * founder has replaced that `.srt` with one cut for the release they actually own, which
   * is the single most likely reason anyone ever touches a subtitle file twice.
   */
  function applyRememberedOffset(source: SubtitleSource, track: PreparedSubtitle): void {
    const key = offsetKeyFor(source);
    const remembered = key === null ? null : store.subtitleOffsetFor(key);
    if (remembered === null) {
      subtitleOffsetMs = 0;
      subtitleOffsetRemembered = false;
      return;
    }
    const fingerprint = subtitleFingerprint(track.cues);
    if (remembered.fingerprint !== fingerprint) {
      logger.info('subtitle.offset_not_reapplied', {
        sourceId: source.id,
        why: 'these are different words from the ones that were corrected',
        wasOffsetMs: remembered.offsetMs,
      });
      subtitleOffsetMs = 0;
      subtitleOffsetRemembered = false;
      return;
    }
    subtitleOffsetMs = clampOffsetMs(remembered.offsetMs);
    subtitleOffsetRemembered = subtitleOffsetMs !== 0;
    logger.info('subtitle.offset_remembered', {
      sourceId: source.id,
      offsetMs: subtitleOffsetMs,
      savedAtWall: remembered.savedAtWall,
    });
  }

  /**
   * Rebuild 18a's list — one `readdir`, and **the probe the check already ran**.
   *
   * Probing twice would put this outside 7a's ≤3 s budget instead of inside it, which 18a
   * asks for in as many words: *"inside the same ≤3 s budget as 7a, not on top of it"*.
   *
   * It also **re-validates the founder's choice** rather than dropping it. A different
   * television is a different verdict about the *film* (7b) and says nothing at all about
   * which subtitles exist, so a device change keeps the choice — founder's decision. A new
   * *film* is where Off comes back, and that is `clearSubtitle`'s job in `selectFile`.
   */
  async function refreshSubtitleChoices(inspection: SourceInspection | null): Promise<void> {
    if (inspection === null) {
      choices = { sources: [], unavailable: [] };
      return;
    }
    let entries: string[] = [];
    // **"Could not look" is not "there is nothing there."** A folder we cannot list still
    // offers no sidecars — the film's own tracks are unaffected and nothing is said about
    // the listing — but the difference matters one block below, where a chosen sidecar that
    // has fallen out of the list is cleared. `readdir` fails for reasons that have nothing
    // to do with the founder's file: a NAS share that dropped, a USB drive spun down, a
    // folder locked for a moment by something else. Treating that as "your subtitle is gone"
    // would discard a deliberate choice on the strength of an error we decided not to
    // report — and 7b re-runs this on every device change, so it would happen mid-evening.
    let listed = true;
    try {
      entries = await fsp.readdir(dirname(inspection.path));
    } catch (error) {
      listed = false;
      logger.debug('subtitle.folder_unreadable', { error });
    }
    choices = subtitleChoices({
      filmPath: inspection.path,
      probe: inspection.probe,
      folderEntries: entries,
    });
    logger.debug('subtitle.listed', {
      name: inspection.name,
      sources: choices.sources.length,
      unavailable: choices.unavailable.length,
    });

    // A choice the founder made must survive a device change; one that no longer exists
    // must not. A *picked* file is not in the list and never was — it lives wherever the
    // founder pointed at it (18c) — so it is kept regardless.
    const current = subtitleChoice;
    if (current === null || current.origin.kind === 'picked') return;
    if (choices.sources.some((source) => source.id === current.id)) return;
    // A sidecar missing from a folder we could not read is missing from nothing. Keep the
    // choice; if the file has genuinely gone, preparing it says so in one line (18j) at the
    // moment that matters, rather than the control snapping back to Off in silence.
    if (!listed && current.origin.kind === 'sidecar') {
      logger.info('subtitle.choice_kept_unlistable_folder', { sourceId: current.id });
      return;
    }
    logger.info('subtitle.choice_no_longer_offered', { sourceId: current.id });
    clearSubtitle('it is no longer offered for this film');
  }

  /**
   * Back to **Off**, and the timing correction goes with it.
   *
   * 19a's *"whatever was chosen for the previous film"* is enforced here: `selectFile` calls
   * this before anything else, so a new film cannot inherit a choice.
   */
  function clearSubtitle(why: string): void {
    subtitleSeq += 1;
    subtitleAbort?.abort();
    subtitleAbort = null;
    if (subtitleChoice !== null || subtitleTrack !== null) {
      logger.info('subtitle.cleared', { why, sourceId: subtitleChoice?.id ?? null });
    }
    subtitleChoice = null;
    subtitleTrack = null;
    subtitlePreparing = false;
    subtitleProblem = null;
    // An offset corrects one subtitle file for one release. Carrying it onto the next
    // choice would apply a stranger's correction to a file that never needed it — and 20f,
    // where a correction *does* come back, is explicit that it is remembered against the
    // **source**, never against the film, the device or the session.
    //
    // **Nothing is forgotten on disk here, and that distinction is 20f's.** Turning
    // subtitles off says nothing about whether that file is out of time; only *Reset* does,
    // and that is `setSubtitleOffset(0, 'reset')` writing a zero. Choosing this source again
    // — tonight, or next week — gets the correction back.
    subtitleOffsetMs = 0;
    subtitleOffsetRemembered = false;
    // 19b's other half: a film that is playing has to be told the words stop. One
    // `EDIT_TRACKS_INFO`, no reload, no lost position, nothing to re-buffer.
    session.setSubtitle(null);
  }

  /**
   * A choice that is **putting a session's words back**, not making a new one (18h).
   *
   * Only ever produced by a reattach, from the record the previous run left behind: the rung
   * that television is showing, and the mount token its thirteen track URLs name.
   */
  interface SubtitleRestore {
    readonly offsetMs: number;
    readonly token: string;
  }

  /**
   * **The words exist. Where does the timing come from?** — three answers, in this order.
   *
   *  1. **A reattach** (18h) says it: the rung the television is already showing, taken back
   *     with the ladder rather than re-decided. Nothing is sent — the set is already there.
   *  2. **The founder pressed something while the file was being read**: their press stands,
   *     and it is written down now that there is a cue list to key it against.
   *  3. **Otherwise**, the correction they set for this source on an earlier evening (20f),
   *     applied and stated — or *in sync*, which is where every other subtitle starts.
   */
  function onSubtitleReady(
    source: SubtitleSource,
    track: PreparedSubtitle,
    restore?: SubtitleRestore,
  ): void {
    if (restore !== undefined) {
      subtitleOffsetMs = clampOffsetMs(restore.offsetMs);
      // Not "as you set it last time": this is the same evening and the same session, and
      // the correction never went away — it came back with the film, which is 18h itself.
      subtitleOffsetRemembered = false;
      const wanted = wantedSubtitle();
      const adopted = wanted !== null && session.adoptSubtitle(wanted, restore.token);
      logger.info('subtitle.restored', {
        sourceId: source.id,
        offsetMs: subtitleOffsetMs,
        adopted,
      });
      // A television that would not have the ladder back — the session ended underneath us
      // while the words were being read — must not be left showing a choice that is not on
      // it. Off is the honest answer and the founder is one press from on.
      if (!adopted) clearSubtitle('the session ended before its subtitles came back');
      push();
      return;
    }
    if (subtitleOffsetMs !== 0) {
      rememberOffsetForCurrentChoice();
    } else {
      applyRememberedOffset(source, track);
    }
    publishSubtitle();
  }

  /**
   * The founder chose a source — **and this is where the one extraction happens** (18d).
   *
   * *"Given a source is chosen, then only that one is read, extracted and converted"*, which
   * is the whole answer to a film with six language tracks. Nothing runs on Cast; by the
   * time the founder presses it, the track is a file that already exists.
   */
  function chooseSubtitle(source: SubtitleSource, restore?: SubtitleRestore): void {
    const film = file;
    if (film === null) {
      logger.warn('intent.ignored', { intent: 'subtitles.select', why: 'no film is chosen' });
      return;
    }
    const seq = (subtitleSeq += 1);
    subtitleAbort?.abort();
    const abort = new AbortController();
    subtitleAbort = abort;
    // **A different source starts from zero, always.** An offset belongs to the words it
    // was measured against (20f keys on the source), so carrying the last file's correction
    // onto this one would apply a stranger's fix to a file that never needed it. The
    // remembered correction for *this* source, if there is one, arrives in `onSubtitleReady`.
    if (subtitleChoice === null || subtitleChoice.id !== source.id) {
      subtitleOffsetMs = 0;
      subtitleOffsetRemembered = false;
    }
    subtitleChoice = source;
    subtitleTrack = null;
    subtitlePreparing = true;
    subtitleProblem = null;
    logger.info('subtitle.chosen', {
      sourceId: source.id,
      origin: source.origin.kind,
      restoring: restore !== undefined,
    });

    // **Already read once for this film? Then it is on screen again immediately.** 19b's
    // *"turning them back on restores them just as fast"* is only true if Off does not throw
    // the words away, and choosing the same source twice is the same question asked twice.
    const cached = preparedCache;
    if (cached !== null && cached.sourceId === source.id) {
      subtitleTrack = cached;
      subtitlePreparing = false;
      subtitleAbort = null;
      logger.info('subtitle.reused', { sourceId: source.id, cues: cached.cueCount });
      onSubtitleReady(source, cached, restore);
      return;
    }
    push();

    subtitleTask = (async () => {
      const result = await prepareSubtitle(
        {
          // **The source film, never the prepared sibling** (18f). A film prepared before
          // M3c existed, or one whose preparation could not carry its subtitles, still gets
          // them, because the words are read from what the founder actually chose.
          filmPath: film.path,
          source,
          language: source.language ?? '',
          workingDir: paths.subtitlesDir,
        },
        {
          logger,
          binaries: resolveBinaries(),
          signal: abort.signal,
          ...spawnOption,
        },
      );
      if (seq !== subtitleSeq) return;
      subtitlePreparing = false;
      subtitleAbort = null;
      if (result.ok) {
        subtitleTrack = result.track;
        preparedCache = result.track;
        onSubtitleReady(source, result.track, restore);
        return;
      }
      // 18j: refused **at the moment it is chosen, before Cast**, and the film stays
      // exactly as ready as it was — without subtitles, and choosing another is one press.
      subtitleChoice = null;
      subtitleProblem = subtitleProblemFor(result.failure);
      push();
    })().catch((error: unknown) => {
      logger.error('subtitle.prepare_crashed', { error });
      // **A crash must land in the same place a failure does**, or the founder is left
      // reading 18d's *Preparing subtitles…* forever with only Cancel as a way out — a
      // spinner that never ends, which is the one outcome this product refuses to ship.
      // Anything that escapes `prepareSubtitle`'s own try/catches reaches here: a binary
      // that vanished between resolution and spawn, a sink that threw. It is still "that
      // subtitle could not be used", and it is said in exactly those words.
      if (seq !== subtitleSeq) return;
      subtitlePreparing = false;
      subtitleAbort = null;
      subtitleChoice = null;
      subtitleProblem = subtitleProblemFor('unreadable');
      push();
    });
  }

  /**
   * Empty CastGood's subtitle working folder at startup — P6's *nothing is left behind*.
   *
   * Since 2026-08-27 a subtitle is cues in memory and nothing on disk, so in the ordinary
   * case this folder is already empty. What it can still hold is **ffmpeg's own scratch
   * file** from a run that was killed between the spawn and the read — the same hazard the
   * head start folder has, closed the same way: one fixed location, emptied before the next
   * run rather than tracked by the run that made it. Bounded to our own working directory;
   * the founder's folders are not touched by this or anything near it.
   */
  async function sweepSubtitleWorkingDir(): Promise<void> {
    await fsp
      .rm(paths.subtitlesDir, { recursive: true, force: true })
      .catch((error: unknown) => logger.warn('subtitle.sweep_failed', { error }));
  }

  /**
   * The check, criterion 7a: `(this file, this television) -> one of four verdicts`.
   *
   * Everything expensive has already happened by the time this runs — the probe is the I/O,
   * and it is done once per file. Classifying is arithmetic over the probe, so **re-running
   * the check for a different television costs nothing and re-reads nothing**: 7b's "the
   * check re-runs against the new device and the verdict may change" is this function called
   * again with a different profile, not a second look at the file. The file has not changed;
   * only the question has.
   *
   * A verdict is only ever produced from an ffprobe result. A file read from container
   * headers — every WSL session, every engine test — has no `probe` and therefore gets no
   * verdict at all, which is the 2026-08-20 source-of-truth ADR made enforceable: header
   * bytes cannot answer a codec question, and a verdict invented from them would be the
   * exact defect that ruling exists to prevent.
   */
  /**
   * The capability profile for a television, all three layers of it.
   *
   * Layer 1 is the conservative baseline, layer 2 the model table keyed on `md=`, and
   * **layer 3 is what this device has been observed to refuse** — read from the store,
   * because the 2026-08-13 ADR requires that fact to be permanent. `downgradesFor` reads the
   * *queued* value rather than the landed one, so a refusal recorded a moment ago narrows
   * the very next plan (7e) instead of the one after it.
   */
  function profileFor(device: Device): DeviceProfile {
    return resolveDeviceProfile(device.model, store.downgradesFor(device.id));
  }

  function runCheck(trigger: string, startedAtMono: number = clock.monoMs()): void {
    void runCheckAsync(trigger, startedAtMono);
  }

  async function runCheckAsync(trigger: string, startedAtMono: number): Promise<void> {
    const inspection = file;
    const previousKind = verdict?.kind ?? null;
    const seq = selectionSeq;
    verdict = null;
    prepared = null;
    // The numbers a confirmation states are the numbers of the verdict that opened it. A
    // new check means new numbers, so the confirmation goes rather than going stale.
    confirming = false;
    // 18a, and it rides **inside** this check rather than beside it: the probe is already
    // in hand, so the list costs one directory listing and no second look at the film.
    await refreshSubtitleChoices(inspection);
    if (seq !== selectionSeq) return;
    if (inspection === null || inspection.probe === null) {
      // A file with no probe still has sidecars, and a founder with no ffmpeg still gets a
      // list. The verdict is what is unavailable here, not the subtitles.
      push();
      return;
    }
    const device = devices.find((candidate) => candidate.id === selectedDeviceId);
    if (device === undefined) {
      push();
      return;
    }

    const profile = profileFor(device);
    let decided = classify(inspection.probe, profile, { throughput: throughputNow() });

    // 7c and 9a: is there already a prepared file this television can play? The answer
    // costs one probe of a local file, and the whole of story 9 rests on asking it rather
    // than on remembering an answer. It is asked **only when the source is not already
    // Tier 1** — a film the device can play untouched has nothing to gain from a sibling,
    // and looking would be one wasted probe on the common path.
    const pipeline = decided.plan.kind === 'none' ? null : preparationPipeline();
    if (pipeline !== null) {
      const artifact = await pipeline.findPrepared(inspection.path, inspection.probe, profile);
      if (seq !== selectionSeq) {
        logger.debug('file.check_superseded', { at: 'findPrepared', name: inspection.name });
        return;
      }
      if (artifact !== null) {
        prepared = artifact;
        // The verdict is re-derived from the **artifact's own probe**, not patched onto the
        // source's. That is what makes 7c's "says it is already prepared" true rather than
        // decorative: the sentence describes the file we are actually going to cast.
        decided = classify(artifact.probe, profile, {
          alreadyPrepared: true,
          throughput: throughputNow(),
        });
      }
    }

    if (seq !== selectionSeq) return;
    verdict = decided;

    const elapsedMs = clock.monoMs() - startedAtMono;
    logger.info('file.checked', {
      trigger,
      name: inspection.name,
      deviceId: device.id,
      // The evidence — codecs, profile, level, resolution, subtitle forms — lives here and
      // **only** here. PRD 7a forbids every one of these on screen, and the snapshot the
      // renderer receives carries none of them.
      detail: decided.detail,
      kind: decided.kind,
      tier: decided.tier,
      encoder: videoEncoder,
      estimateSeconds: decided.estimateSeconds,
      estimatedBytes: decided.estimatedBytes,
      requiresConfirmation: decided.requiresConfirmation,
      subtitleNoticeShown: decided.subtitleNotice !== null,
      preparedPath: prepared?.path ?? null,
      changedFrom: previousKind,
      elapsedMs,
    });
    if (elapsedMs > PREPARATION.checkBudgetMs) {
      // 7a promises 3 s. If this ever fires, the log says so rather than the promise being
      // quietly untrue.
      logger.warn('file.check_slow', { elapsedMs, budgetMs: PREPARATION.checkBudgetMs });
    }
    push();
  }

  /**
   * The friendly name of a device id, remembered across it leaving the device list.
   *
   * ⚠️ **The whole point is the last line.** Resolving a name out of `discovery.devices()`
   * works right up until the moment it matters: a television that has lost power is gone
   * from that list, and "Lost connection to <name>" is a sentence about exactly that
   * television. Issue #66 — the app named a different, healthy set in the room.
   */
  let lastDeviceName: { readonly id: string; readonly name: string } | null = null;
  function rememberedDeviceName(id: string | null): string | null {
    if (id === null) return null;
    const found = discovery.devices().find((device) => device.id === id);
    if (found !== undefined) {
      lastDeviceName = { id, name: found.friendlyName };
      return found.friendlyName;
    }
    return lastDeviceName?.id === id ? lastDeviceName.name : null;
  }

  function push(): void {
    const model = session.model;
    const sessionNotice: NoticeSnapshot | null =
      model.error === null
        ? notice
        : {
            kind: model.error.kind,
            // A file that has moved is a fact about this PC, not a failure of the cast:
            // the film played, and the founder is being told where their copy went. The
            // red-alert treatment belongs to the things that actually broke.
            severity: model.error.kind === 'source-missing' ? 'warning' : 'error',
            message: model.error.userMessage,
            actionLabel: model.error.actionLabel,
          };

    const deviceSnapshots: DeviceSnapshot[] = devices.map((device) => ({
      id: device.id,
      friendlyName: device.friendlyName,
      model: device.model,
      // 11d: a device we cannot currently reach because *this PC* is offline is dimmed,
      // not removed. It is still there; we are the ones who went away.
      available: !model.flags.networkDown,
    }));

    snapshot = {
      revision: snapshot.revision + 1,
      discovery: {
        phase: discoveryPhase(),
        devices: deviceSnapshots,
        selectedDeviceId,
      },
      file: fileSnapshot(),
      check: checking,
      preparation:
        preparation === null
          ? EMPTY_SNAPSHOT.preparation
          : {
              active: true,
              percent: preparation.percent,
              secondsRemaining: preparation.secondsRemaining,
              frontierSec: preparation.frontierSec,
              headline: preparation.headline,
              fallbackDirectory: preparation.fallbackDirectory,
              cancellable: true,
              watchableInSeconds: preparation.watchableInSeconds,
              playsOnCompletion: preparation.playsOnCompletion,
              estimatingWait: preparation.estimatingWait,
            },
      headStart:
        headStart === null || !headStart.serving
          ? null
          : {
              frontierSec: headStart.frontierSec,
              // Capped at the film's own length, exactly as the session's own seek ceiling
              // is: near the end of a conversion the frontier runs past the useful part of
              // the scrubber, and two places computing this limit is two places to disagree.
              seekLimitSec: Math.min(
                seekLimitSec(headStart.frontierSec),
                session.durationSec() > 0 ? session.durationSec() : Number.POSITIVE_INFINITY,
              ),
              // The presence of this object **is** the hold: there is no combination of
              // fields that can say "holding, with nothing to show for it".
              hold:
                headStart.holdingMessage === null
                  ? null
                  : {
                      message: headStart.holdingMessage,
                      waitingForCompletion: headStart.waitingForCompletion,
                    },
              conversionComplete: headStart.conversionComplete,
            },
      session: {
        state: model.state,
        flags: model.flags,
        deviceId: model.deviceId,
        // Remembered, never looked up at read time. See SessionSnapshot.deviceName: a
        // television that loses power leaves the discovery list, and that is exactly when
        // the app has to name it.
        deviceName: rememberedDeviceName(model.deviceId),
        positionSec: session.positionSec(),
        durationSec: session.durationSec(),
        // Dragging needs a device that is playing, a duration to drag along, and a
        // connection to send the result down. The ±30 s taps are less demanding — see
        // `canSkip` in the view model, which keeps them live through Buffering (6k).
        canSeek:
          session.durationSec() > 0 &&
          (model.state === 'playing' || model.state === 'paused' || model.state === 'seeking') &&
          !model.flags.reconnecting &&
          !model.flags.reattaching &&
          !model.flags.yielded &&
          !model.flags.networkDown,
        seek:
          model.seek === null
            ? null
            : {
                targetSec: model.seek.targetSec,
                pendingDeltaSec: model.seek.deltaSec,
                clamped: model.seek.clamped,
                source: model.seek.source,
                inFlight: model.seek.issuedAtMono !== null,
              },
        resumePositionSec: model.resumePositionSec,
        yieldedToApp: model.yieldedTo,
        offlineHelp: model.offlineHelp,
        // What went out on the LOAD, not what has been chosen since: a track can only be
        // declared in a load, so a choice made mid-film is not on this television.
        subtitleLabel:
          model.state === 'idle' || castSubtitle === null
            ? null
            : `Subtitles: ${castSubtitle.label}`,
        // M5a. `null` unless there is a session to send a volume over — 23i, the founder's
        // ruling on question 43: the control lives with the session and goes with it, and
        // CastGood never puts its hand on a television it is not using. Everything inside
        // came off a receiver status; nothing here is computed (23b).
        volume: volumeSnapshot(),
      },
      subtitles: subtitlesSnapshot(),
      notice: sessionNotice,
    };
    for (const listener of listeners) notify(listener);
  }

  const discovery: Discovery = createDiscovery({
    logger,
    clock,
    ...(options.mdns === undefined ? {} : { mdns: options.mdns }),
    events: {
      onDeviceFound(device) {
        devices = discovery.devices();
        // 9f: **the last-used device is already selected.** Two cases and they are not the
        // same. If nothing is selected yet, this device takes the slot — the first
        // television to answer is better than none, and it is also the first moment a file
        // chosen before any device appeared has something to be checked against. If the
        // remembered television then turns up a second later, it takes the slot back —
        // devices arrive in whatever order mDNS answers, so "remembered" cannot mean
        // "first". Neither ever overrules the founder: `founderActed` is what a deliberate
        // choice sets, and after that the selection only changes on purpose (2b).
        const remembered = store.settings.lastDeviceId;
        const takesOver =
          !founderActed && remembered === device.id && selectedDeviceId !== device.id;
        if (selectedDeviceId === null || takesOver) {
          selectedDeviceId = device.id;
          if (takesOver) logger.info('device.remembered_selected', { deviceId: device.id });
          runCheck('device.found');
        }
        push();
      },
      onDeviceUpdated() {
        devices = discovery.devices();
        push();
      },
      onDeviceLost(deviceId) {
        devices = discovery.devices();
        if (selectedDeviceId === deviceId) {
          selectedDeviceId = devices[0]?.id ?? null;
          runCheck('device.lost');
        }
        push();
      },
      onError(error) {
        logger.error('discovery.failed', { error });
      },
    },
  });

  const mediaServer: MediaServer = createMediaServer({
    logger,
    // Shared with the session supervisor, so "when did the television's byte connection
    // die?" and "when did we start recovering?" are two readings of the same clock (D2).
    clock,
    ...(options.mediaPort === undefined ? {} : { preferredPort: options.mediaPort }),
    // Declared before `session` exists but only ever called long afterwards, from a live
    // HTTP request. The alternative — an event emitter between the two — buys nothing.
    // **The token is passed on rather than discarded**, and it has to be from M3c onward:
    // a text track is a second mount, and a `.vtt` that vanishes must never raise 15b and
    // stop a film that is playing perfectly well. The session decides, because only it
    // knows which token is the film's.
    onSourceMissing: (token) => {
      session.noteSourceMissing(token);
    },
    // Defect D2's 229 ms race, 2026-08-28: the session used to *look* for this once, when
    // the control channel came back, and the delivery was not declared dead until a quarter
    // of a second after it had looked. Being told is the difference between a repair at
    // 4 seconds and one at 42. The session ignores it outside a recovery.
    onDeliveryInterrupted: (token) => {
      session.noteDeliveryInterrupted(token);
    },
  });

  const cast: CastClient = createCastClient({
    logger,
    clock,
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });

  const store: Store = createStore({ logger, paths });

  const session: SessionSupervisor = createSessionSupervisor({
    logger,
    clock,
    cast,
    mediaServer,
    ...(options.launchTimeoutMs === undefined ? {} : { launchTimeoutMs: options.launchTimeoutMs }),
    onChanged: () => {
      // A film that played out, or a session that ended any other way, has let the
      // television go — so the segments may go with it (10g). Reading the state here rather
      // than adding an event keeps "the session is over" in one place.
      const state = session.model.state;
      if (headStart !== null && headStart.serving) {
        const over = state === 'ended' || state === 'stopped';
        // `idle` needs the `sessionLive` guard and the other two do not: there is an instant
        // between publishing the playlist and the connection opening in which the session is
        // still idle, and tidying up there would delete the segments the television is about
        // to ask for.
        if (state !== 'idle') headStart.sessionLive = true;
        if (over || (state === 'idle' && headStart.sessionLive)) {
          discardHeadStart(`the session is ${state}`);
        }
      }
      push();
    },
    onDeviceInUse: (deviceId) => {
      // The device being cast to is never dropped from the list, however quiet mDNS goes.
      for (const device of devices) discovery.unpin(device.id);
      if (deviceId !== null) discovery.pin(deviceId);
      inUseDeviceId = deviceId;
    },
    // 7e. Declared before `onLoadRejected` exists as a binding, and only ever called from
    // a live television — the same shape as `onSourceMissing` above it.
    onLoadRejected: (detail) => {
      onLoadRejected(detail);
    },
    // Story 12's whole dependency on disk: the URL a reopened app has to republish.
    onSessionChanged: (info) => {
      void (info === null
        ? store.forgetSession()
        : store.rememberSession({ ...info, savedAtWall: clock.wallMs() }));
    },
  });

  const network: NetworkWatcher = createNetworkWatcher({
    logger,
    ...(options.networkInterfaces === undefined ? {} : { interfaces: options.networkInterfaces }),
    onChanged: (state) => {
      session.noteNetwork(state.addresses, state.allAddresses);
      // 11d: the device list **dims rather than empties**. Pinning holds every known
      // device on the list through an outage, so the founder's TVs do not vanish one by
      // one on the liveness sweep and come back a minute later — which is exactly the
      // flapping the 2026-08-14 discovery work removed.
      for (const device of devices) {
        if (state.up || device.id === inUseDeviceId) continue;
        discovery.pin(device.id);
      }
      if (state.up) {
        for (const device of devices) {
          if (device.id !== inUseDeviceId) discovery.unpin(device.id);
        }
      }
      push();
    },
  });

  /**
   * Is this the film that was already chosen — even though it has moved?
   *
   * **Identity cannot be the path here, and 15b is the reason.** *Find it again* exists
   * precisely because the file is no longer where it was, so its new path is guaranteed to
   * differ from the old one; a path comparison answers "different film" every single time
   * the button is used, wipes the saved position, and hands the founder back a film with
   * no *Resume from* on it. That is what checklist item 5 caught on 2026-08-19: the file
   * was found, the message cleared, and the place — 0:00:30 — was gone.
   *
   * Name and size, and deliberately **not** mtime. A move preserves all three, but a
   * re-download or a restore from a backup preserves only the first two — and the two
   * mistakes are not symmetrical. Calling one film "the same" wrongly costs the founder a
   * resume offset inside a film they chose on purpose; calling it "different" wrongly
   * throws away the place they were up to, which is the whole defect this exists to stop.
   * So the test is biased toward keeping the position, and mtime only ever added false
   * negatives. Two genuinely different videos sharing a name *and* an exact byte count is
   * not a case worth designing against.
   */
  function isSameSource(previous: SourceInspection, chosen: SourceInspection): boolean {
    if (previous.path === chosen.path) return true;
    return previous.name === chosen.name && previous.sizeBytes === chosen.sizeBytes;
  }

  /**
   * The ffprobe runner for this machine, resolved once and remembered.
   *
   * `resolveFfmpeg()` **returns absence as a value**, so there is no throw to handle here:
   * no binaries means the engine holds `null`, `inspectSource` reads container headers
   * instead, and no file gets a verdict. That is the ordinary state of affairs in WSL and
   * under vitest.
   *
   * In a **packaged** install it is not ordinary. The binaries ship inside the app and three
   * separate build gates exist to stop an installer being made without them, so if they are
   * missing on the founder's PC the installation is damaged — and the founder is told that
   * (2026-08-20, devops) rather than left with an app that has quietly stopped saying what
   * their files need. Falling back silently there would be the same class of failure as a
   * missing firewall rule: an app that looks like it is working and is not.
   */
  function resolveBinaries(): FfmpegBinaries | null {
    if (options.ffmpeg !== undefined) return options.ffmpeg;
    if (resolvedBinaries !== undefined) return resolvedBinaries;
    const resolution = resolveFfmpeg();
    logger.info('ffmpeg.resolved', {
      available: resolution.available,
      description: describeFfmpeg(resolution),
      ...(resolution.available
        ? { source: resolution.source, dir: resolution.dir }
        : { searched: resolution.searched }),
    });
    if (!resolution.available) {
      resolvedBinaries = null;
      if (options.packaged === true) {
        logger.error('ffmpeg.missing_from_install', { searched: resolution.searched });
      }
      return null;
    }
    resolvedBinaries = resolution.binaries;
    return resolvedBinaries;
  }

  function ffprobeRunner(): FfprobeRunner | null {
    if (options.ffprobe !== undefined) return options.ffprobe;
    if (resolvedProbeRunner !== undefined) return resolvedProbeRunner;
    const binaries = resolveBinaries();
    resolvedProbeRunner =
      binaries === null ? null : createFfprobeRunner({ binaries, logger, ...spawnOption });
    return resolvedProbeRunner;
  }

  /**
   * The preparation pipeline, built the first time anything needs it.
   *
   * `null` on a machine with no ffmpeg, which is every WSL session and every engine test
   * that has not been handed a scripted one — and that is not a degraded mode, it is the
   * honest one: with no binaries nothing can be probed, so nothing gets a verdict, so
   * nothing can be prepared. The three states line up rather than needing to be kept in
   * step.
   *
   * The runner it is given is `ffprobeRunner()`, deliberately the **same one** the check
   * uses. The 2026-08-20 source-of-truth ADR says one reader per file; a pipeline with its
   * own probe would be a second reader that could disagree with the first about the very
   * file it had just written.
   */
  /**
   * The throughput the estimate is built from, for the encoder that will actually run.
   *
   * Two measured numbers rather than one, because they are properties of different silicon:
   * 250 Mpx/s sustained for `libx264 -preset veryfast`, 700 for NVENC. Sharing one would
   * make every estimate wrong on one of the two machines this product might be on.
   */
  function throughputNow() {
    return {
      ...PREPARATION.throughput,
      videoMegapixelsPerSecond:
        videoEncoder === 'h264_nvenc'
          ? PREPARATION.throughput.videoMegapixelsPerSecondNvenc
          : PREPARATION.throughput.videoMegapixelsPerSecond,
    };
  }

  /**
   * Find out what this machine's encoder situation is, once, by trying it.
   *
   * Deliberately **not awaited by anything**: it runs a quarter-second encode at startup and
   * the answer only changes an estimate. Everything works before it lands, on the software
   * path, which is the honest default.
   */
  function detectEncoderOnce(): void {
    // Stated by the caller: nothing to find out, and nothing to spawn.
    if (options.videoEncoder !== undefined) return;
    const binaries = resolveBinaries();
    if (binaries === null) return;
    void detectVideoEncoder({ logger, binaries, ...spawnOption }).then((found) => {
      videoEncoder = found;
      // The verdict on screen was built from the other seed, so it is now stale by up to a
      // factor of three. Re-check rather than leave the founder reading a number we no
      // longer believe.
      if (file !== null) runCheck('encoder.detected');
    });
  }

  function preparationPipeline(): PreparationPipeline | null {
    if (resolvedPipeline !== undefined) return resolvedPipeline;
    const binaries = resolveBinaries();
    const runFfprobe = ffprobeRunner();
    if (binaries === null || runFfprobe === null) {
      resolvedPipeline = null;
      return null;
    }
    resolvedPipeline = createPreparationPipeline({
      logger,
      binaries,
      runFfprobe,
      workingDir: paths.preparedDir,
      videoEncoder: () => videoEncoder,
      // The gate's sustained-speed window is measured on the **engine's** monotonic clock
      // rather than `Date.now`, for the same reason every other duration in the engine is:
      // a wall clock jumps when the PC resumes from sleep, and a jump of an hour would
      // read as a conversion that produced nothing for an hour.
      now: () => clock.monoMs(),
      ...(options.unsafeConversionReadRate === undefined
        ? {}
        : { conversionReadRate: options.unsafeConversionReadRate }),
      ...(options.unsafeConversionReadRateBurstSec === undefined
        ? {}
        : { conversionReadRateBurstSec: options.unsafeConversionReadRateBurstSec }),
      ...(options.freeBytes === undefined ? {} : { freeBytes: options.freeBytes }),
      ...spawnOption,
    });
    return resolvedPipeline;
  }

  async function selectFile(path: string): Promise<void> {
    const previous = file;
    const seq = (selectionSeq += 1);
    // 7a: the check is cancellable, and choosing another file is the commonest way anyone
    // cancels one. The previous probe's child process is killed rather than left to finish
    // into a snapshot nobody is waiting for.
    checkAbort?.abort();
    const abort = new AbortController();
    checkAbort = abort;
    const startedAtMono = clock.monoMs();
    // **19a, and this is the line it rests on**: *"whatever was chosen for the previous
    // film, whatever this film contains, and whatever was chosen the last time this film
    // was cast"* — Off, every time, before anything about the new file is even known.
    preparedCache = null;
    clearSubtitle('a film was chosen');
    checking = { name: basename(path), headline: 'Checking what this file needs…' };
    push();

    try {
      // **One reader per file** (2026-08-20 ADR): `inspectSource` is the only place that
      // chooses between ffprobe and the container headers, and it never consults both.
      const inspected = await inspectSource(path, ffprobeRunner(), { signal: abort.signal });
      if (seq !== selectionSeq) {
        // A newer selection owns the screen. This answer is about a file the founder has
        // already moved on from, and applying it would undo their choice.
        logger.debug('file.check_superseded', { name: inspected.name });
        return;
      }
      // Re-choosing the *same* film — which is exactly what *Find it again* does — keeps
      // the place it was saved at. A different film does not inherit it (16b).
      if (previous !== null) {
        if (!isSameSource(previous, inspected)) session.noteFileChanged();
        // The same film, wherever it turned up: the problem is over, the place survives
        // (15b). **Not conditional on the path having changed** — a file can go missing
        // and come back at the address it always had. `onSourceMissing` fires on any
        // `stat` failure the media server hits and `checkSourceStillThere` on any failed
        // `access`, so an external drive that blinked, a NAS that dropped, or a transient
        // lock all raise it without anything moving. Re-choosing the same file then left
        // *Find it again* looping on a screen that never cleared.
        else session.noteFileRelocated();
      }
      file = inspected;
      notice = noticeForProbeFailure(inspected);
      logger.info('file.selected', {
        name: inspected.name,
        sizeBytes: inspected.sizeBytes,
        durationSec: inspected.durationSec,
        origin: inspected.origin,
        probeFailure: inspected.failure,
      });
      // **Awaited, so the panel never shows a file with no verdict on it.** The check runs
      // on past the probe — a prepared sibling costs a second probe of a local file — and
      // clearing the checking state at the probe would put a film on screen for a few
      // hundred milliseconds with nothing said about it. 7a's four verdicts are what the
      // founder is owed at the end of a check, and *Checking…* is the honest state until
      // one of them exists.
      await runCheckAsync('file.select', startedAtMono);
      if (seq !== selectionSeq) return;
      checking = null;
    } catch (error) {
      if (seq !== selectionSeq) return;
      checking = null;
      logger.warn('file.select_failed', { error });
      notice = {
        kind: 'generic',
        severity: 'error',
        message: isEngineError(error) ? error.userMessage : 'That file could not be opened.',
        actionLabel: 'Choose another video',
      };
    } finally {
      if (seq === selectionSeq) {
        checking = null;
        checkAbort = null;
      }
    }
    push();
  }

  /**
   * What the founder is told when the probe did not produce a result.
   *
   * Only two of the four failures reach a person, and they are different facts. **A file
   * ffprobe could not read** is a verdict, not a notice — 7d, decided in the check and shown
   * as *This file can't be cast* — so nothing is said here. **A check that ran out of time**
   * is a fact about this PC (a drive that has spun down, a share that went away) and must
   * never be dressed up as a judgement of the film, so it is said plainly and the founder
   * can try again. A cancelled check belongs to a selection nobody is looking at.
   */
  function noticeForProbeFailure(inspected: SourceInspection): NoticeSnapshot | null {
    if (
      options.packaged === true &&
      (inspected.origin === 'headers' || inspected.failure === 'ffprobe-failed')
    ) {
      // The header reader answering **in a packaged install** is the damaged-installation
      // signal itself: the binaries ship inside the app, so nothing else can put us here.
      return {
        kind: 'installation-damaged',
        severity: 'error',
        message:
          'Some of CastGood’s own files are missing, so it can’t work out what a video ' +
          'needs. Reinstalling CastGood fixes it.',
        actionLabel: null,
      };
    }
    if (inspected.failure === 'timeout') {
      return {
        kind: 'generic',
        severity: 'warning',
        message: 'CastGood couldn’t check that file in time. The drive it is on may be asleep.',
        actionLabel: 'Try again',
      };
    }
    return null;
  }

  /**
   * Story 12: was the app closed while something was still playing?
   *
   * The whole of the founder-visible promise is "it does not start the film again". So
   * this never casts and never launches anything — it republishes the URL the television
   * was already fetching, asks the device what is running, and adopts it only if the
   * answer carries our own token. Anything else is 12b: **silence**, straight to Idle.
   *
   * Bounded by `TIMING.reattachBudgetMs`, which is the mockup's "Transient (≤5 s)" label.
   * SPIKE-2 measured the rejoin itself at 86 ms and discovery at 0.22–0.26 s, so the
   * budget is spent almost entirely waiting for the device to appear.
   */
  async function attemptReattach(): Promise<void> {
    const record = store.settings.session;
    if (record === null) return;

    // **The budget bounds the whole operation, not just the wait.** It used to be spent
    // entirely on waiting for the device to appear, so 12a's "reattaches within 5 s" had
    // nothing at all bounding the part that actually reattaches. The deadline is carried
    // all the way into the supervisor.
    const deadline = clock.monoMs() + TIMING.reattachBudgetMs;
    logger.info('session.reattach_considering', {
      deviceId: record.deviceId,
      token: record.token,
      savedAtWall: record.savedAtWall,
      positionSec: record.positionSec,
    });

    /**
     * Has the founder started doing something of their own?
     *
     * Checked at every step, because each one is an `await` the founder can act inside.
     * Losing this race is not a cosmetic problem: it swaps the film they chose and
     * destroys the cast they pressed.
     */
    const founderIsBusy = (): boolean =>
      founderActed || session.model.state !== 'idle' || file !== null;

    if (founderIsBusy()) {
      logger.info('session.reattach_abandoned', { why: 'the founder was already casting' });
      return;
    }

    // Wait for the remembered device to turn up, but never past the budget.
    let target = devices.find((candidate) => candidate.id === record.deviceId);
    while (target === undefined && clock.monoMs() < deadline) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 100);
        timer.unref?.();
      });
      if (founderIsBusy()) {
        logger.info('session.reattach_abandoned', { why: 'the founder chose while we waited' });
        return;
      }
      target = devices.find((candidate) => candidate.id === record.deviceId);
    }
    if (target === undefined) {
      logger.info('session.reattach_device_absent', { deviceId: record.deviceId });
      void store.forgetSession();
      return;
    }

    // The file name and duration are part of what 12a promises to show, so the same
    // probe the picker does runs here — and a source that has since moved simply means
    // there is nothing to reattach to.
    await selectFile(record.filePath);
    if (file === null || file.path !== record.filePath) {
      logger.info('session.reattach_file_gone', { path: record.filePath });
      void store.forgetSession();
      push();
      return;
    }

    // Last chance: `selectFile` awaited a probe, and a founder who pressed Cast inside it
    // now owns a session this must not reset to `connecting`.
    if (session.model.state !== 'idle' || founderActed) {
      logger.info('session.reattach_abandoned', { why: 'the founder cast while we probed' });
      return;
    }

    selectedDeviceId = target.id;
    const adopted = await session.reattach(
      target,
      { path: file.path, name: file.name },
      {
        token: record.token,
        mediaSessionId: record.mediaSessionId,
        positionSec: record.positionSec,
      },
      // Whatever is left of the 5 s. The supervisor gives up inside it rather than sitting
      // on a connect timeout that outlives the promise the criterion makes.
      { deadlineMono: deadline },
    );
    if (!adopted) {
      // 12b: "Recovery that isn't needed is silent." The record goes, the notice stays
      // empty, and the founder sees the ordinary Ready screen with their file on it.
      void store.forgetSession();
      notice = null;
      push();
      return;
    }
    // **18h: the subtitles come back with the film.** Deliberately *after* the adoption and
    // outside its budget — 12a promises a reattach inside 5 s, and re-reading an embedded
    // track can legitimately take several of them (18d allows five). The television is
    // playing with the words already on it throughout; what this restores is CastGood's own
    // knowledge of them, so the next press is a track switch instead of a reload.
    restoreSessionSubtitle(record.subtitle ?? null);
    push();
  }

  /**
   * Put back the subtitle the closed run had on the television — 18h's reattach half.
   *
   * The record names a **source**, not a track: the words are read again from the founder's
   * own file or from the film, exactly as choosing it did the first time, because a cue list
   * has no business in a settings file and is a second under a second to re-derive.
   *
   * It cannot turn subtitles on where they were not on. The record only exists for a session
   * that had words showing when the app closed — `liveSessionInfo` refuses to write one
   * otherwise — so 19a is untouched: nothing here runs for a film the founder cast without
   * subtitles, and nothing here runs on an ordinary launch.
   */
  function restoreSessionSubtitle(record: SessionSubtitleRecord | null): void {
    if (record === null) return;
    const origin = subtitleOriginFromId(record.sourceId);
    if (origin === null) {
      // A hand-edited or future-shaped id. The film is playing and its words are on the
      // screen; what is lost is the ability to nudge them without a reload, which is worth
      // a line in the log and nothing on screen.
      logger.warn('subtitle.restore_unrecognised_source', { sourceId: record.sourceId });
      return;
    }
    logger.info('subtitle.restoring', { sourceId: record.sourceId, offsetMs: record.offsetMs });
    chooseSubtitle(
      {
        id: record.sourceId,
        label: record.label,
        language: record.language === '' ? null : record.language,
        origin,
      },
      { offsetMs: record.offsetMs, token: record.token },
    );
  }

  /**
   * The primary button, obeying the verdict the founder was shown (7d, 7f, 7h).
   *
   * Three outcomes and no fourth. **A file the check refused is never cast** — 7d's whole
   * point is that this is settled before the founder commits, so the press is refused here
   * rather than discovered by a television. **A job over `LONG_PREP` opens the confirmation
   * state**, and nothing is written while it is up (7f, 7g). **Anything else acts at once**:
   * one press, no confirmation, which is 7h.
   */
  function pressPrimary(startPositionSec: number): void {
    const shown = verdictSnapshot();
    if (shown?.kind === 'impossible') {
      logger.warn('cast.refused_impossible', { name: file?.name ?? null, reason: shown.reason });
      return;
    }
    const decided = verdict;
    if (decided !== null && decided.plan.kind !== 'none') {
      if (decided.requiresConfirmation && !confirming) {
        // 7f: a **state**, not a dialog. Still nothing on disk.
        confirming = true;
        logger.info('preparation.confirmation_shown', {
          kind: decided.kind,
          estimateSeconds: decided.estimateSeconds,
          estimatedBytes: decided.estimatedBytes,
        });
        push();
        return;
      }
      beginPreparation(startPositionSec);
      return;
    }
    // No verdict (no ffprobe on this machine, or no device yet) or a Tier 1 verdict: the
    // file is cast exactly as it is, which is what every milestone before this one did.
    void startCast(startPositionSec);
  }

  /**
   * Where preparation starts — the seam the rest of M3a fills in.
   *
   * It is deliberately the *only* path from a press to any work on disk, so that "nothing
   * is written until the founder has confirmed" is a property of one call site rather than
   * a rule several of them observe. `startPositionSec` is carried through because a film
   * prepared and then cast has to land where the founder left it.
   */
  function beginPreparation(startPositionSec: number): void {
    confirming = false;
    // Held rather than fired and forgotten, so `stop()` can **wait for the job to have
    // finished stopping**. P6 promises there is no conversion running after the app is
    // gone, and a promise nobody holds is a process that may still be deleting a folder
    // after the founder's window has closed.
    preparationTask = runPreparation(startPositionSec).catch((error: unknown) => {
      logger.error('preparation.crashed', { error });
    });
  }

  /** The headline over the progress bar. Two waits, two sentences — see `PreparationSnapshot`. */
  function preparationHeadline(kind: VerdictKind, name: string): string {
    return kind === 'remux' ? `Repackaging ${name}…` : `Converting ${name}…`;
  }

  /**
   * One preparation, start to finish, and then the cast it exists for.
   *
   * **This is the only path from a press to any work on disk**, so "nothing is written until
   * the founder has confirmed" is a property of one call site rather than a rule several of
   * them observe.
   *
   * The shape of the whole of M3a is in the last few lines: the job runs **to completion**,
   * and only then is anything sent to a television. That is what makes the product's
   * defining promise trivially true in half A — nothing can be converted underneath
   * playback if playback has not started. M3b is the milestone that makes this harder.
   */
  async function runPreparation(startPositionSec: number): Promise<void> {
    const source = file;
    const decided = verdict;
    const device = devices.find((candidate) => candidate.id === selectedDeviceId);
    if (source === null || source.probe === null || decided === null || device === undefined) {
      logger.warn('preparation.ignored', {
        hasFile: source !== null,
        hasVerdict: decided !== null,
        hasDevice: device !== undefined,
      });
      return;
    }
    if (preparation !== null) {
      // One job at a time, and the founder is sitting in front of it. A second press while
      // one is running is a press on a button that is showing progress, not a queue.
      logger.warn('preparation.already_running', { name: source.name });
      return;
    }
    const pipeline = preparationPipeline();
    if (pipeline === null) {
      notice = installationDamagedNotice();
      push();
      return;
    }

    const run: PreparationRun = {
      abort: new AbortController(),
      headline: preparationHeadline(decided.kind, source.name),
      startPositionSec,
      sourcePath: source.path,
      percent: 0,
      secondsRemaining: decided.estimateSeconds,
      frontierSec: null,
      fallbackDirectory: null,
      watchableInSeconds: null,
      playsOnCompletion: false,
      estimatingWait: false,
    };
    preparation = run;
    notice = null;
    logger.info('preparation.started', {
      name: source.name,
      kind: decided.kind,
      tier: decided.tier,
      deviceId: device.id,
      estimateSeconds: decided.estimateSeconds,
      estimatedBytes: decided.estimatedBytes,
      startPositionSec,
    });
    push();

    const startedAtMono = clock.monoMs();

    // **M3b: a conversion is published as it goes, and a gate decides when a television may
    // be told about it.** A repackage is seconds of work and takes the plain path; so does
    // everything else. `runHeadStart` still finishes with one MP4 beside the source, so from
    // the folder's point of view nothing about this branch is visible at all.
    if (decided.plan.kind === 'transcode') {
      await runHeadStart(run, decided, source, device, startedAtMono);
      return;
    }

    const result = await pipeline.prepare(
      {
        source: { ...source, name: source.name },
        sourceProbe: source.probe,
        verdict: decided,
        deviceProfile: profileFor(device),
      },
      {
        onProgress: (progress: PreparationProgress) => {
          if (preparation !== run) return;
          run.percent = progress.percent;
          run.secondsRemaining = progress.secondsRemaining;
          run.frontierSec = progress.frontierSec;
          push();
        },
        onLocationChosen: (directory: string, isFallback: boolean) => {
          if (preparation !== run) return;
          // 9e: said as soon as it is known, not at the end. The founder should learn
          // where their file is going before it is four gigabytes into going there.
          run.fallbackDirectory = isFallback ? directory : null;
          push();
        },
      },
      run.abort.signal,
    );

    if (preparation !== run) return;
    preparation = null;
    const elapsedMs = clock.monoMs() - startedAtMono;

    if (!result.ok) {
      // A cancel is not a failure and is told to nobody: the founder pressed the button,
      // and 8d's promise is that the folder is exactly as it was, which the pipeline has
      // already seen to. Everything else gets a sentence.
      notice =
        result.failure.kind === 'cancelled' ? null : preparationNotice(result.failure, source.name);
      logger.warn('preparation.finished', {
        name: source.name,
        ok: false,
        failure: result.failure.kind,
        elapsedMs,
      });
      push();
      return;
    }

    prepared = result.artifact;
    logger.info('preparation.finished', {
      name: source.name,
      ok: true,
      elapsedMs,
      estimateSeconds: decided.estimateSeconds,
      // 8b's honesty clause, measured rather than asserted: how far the number the founder
      // was shown sat from the wait they actually had. Nothing branches on it — it is here
      // so the seeds in `config.ts` can be replaced by what this PC really does.
      estimateErrorPct:
        decided.estimateSeconds === null || decided.estimateSeconds <= 0
          ? null
          : Math.round(
              ((elapsedMs / 1_000 - decided.estimateSeconds) / decided.estimateSeconds) * 100,
            ),
      bytes: result.artifact.bytes,
      estimatedBytes: decided.estimatedBytes,
      artifact: result.artifact.path,
    });

    // 8a: **casting begins automatically on completion with no second press.** The founder
    // pressed one button and ends up watching a film.
    void startCast(run.startPositionSec);
  }

  /**
   * One Tier 3 conversion, published as it goes — the whole of M3b's happy path (10a–10j).
   *
   * The order of what happens here is the criteria in order, and the ordering is the
   * product: **nothing reaches a television before the gate opens**, the guard runs from the
   * moment it does until the conversion is finished, and the folder of segments outlives the
   * conversion because the founder is still watching it.
   *
   * Two ways this ends, and they are different casts. If the gate opened, the film is
   * already playing and the finished MP4 is simply there for next time — swapping the
   * television onto it would interrupt a film to hand it an identical one. If it never
   * opened — a short film, or a conversion that never sustained 1.5× — this is M3a exactly:
   * the job finished, and *then* the founder gets a picture.
   */
  async function runHeadStart(
    run: PreparationRun,
    decided: Verdict,
    source: NonNullable<typeof file>,
    device: Device,
    startedAtMono: number,
  ): Promise<void> {
    const pipeline = preparationPipeline();
    if (pipeline === null || source.probe === null) return;

    const state: HeadStartState = {
      discardSegments: () => Promise.resolve(),
      serving: false,
      frontierSec: 0,
      conversionComplete: false,
      guard: INITIAL_GUARD,
      samples: [],
      holdingMessage: null,
      waitingForCompletion: false,
      gate: null,
      pausedByGuard: false,
      sessionLive: false,
    };
    headStart = state;

    const started = await pipeline.prepareWithHeadStart(
      {
        source: { ...source, name: source.name },
        sourceProbe: source.probe,
        verdict: decided,
        deviceProfile: profileFor(device),
      },
      {
        onProgress: (progress: PreparationProgress) => {
          if (preparation !== run && !state.serving) return;
          run.percent = progress.percent;
          run.secondsRemaining = progress.secondsRemaining;
          run.frontierSec = progress.frontierSec;
          state.frontierSec = progress.frontierSec;
          state.samples = recordFrontier(state.samples, {
            atMs: clock.monoMs(),
            frontierSec: progress.frontierSec,
          });
          // 10d: what the session will clamp a jump against. Told rather than asked, because
          // the session has no idea a conversion exists.
          if (state.serving) session.noteFrontier(progress.frontierSec);
          push();
        },
        onLocationChosen: (directory: string, isFallback: boolean) => {
          if (preparation !== run) return;
          run.fallbackDirectory = isFallback ? directory : null;
          push();
        },
        onGateChecked: (verdict) => {
          state.gate = verdict;
          if (preparation !== run) return;
          // 10a: *"the app said beforehand roughly when watching would start"*. `null` until
          // there is a measured speed to say it with — an invented number here would be the
          // flattering direction, which is the one 8b's honesty clause forbids.
          const forecast = forecastGate({
            preparedSec: verdict.preparedSec,
            sustainedSpeed: verdict.sustainedSpeed,
            conversionComplete: false,
            filmDurationSec: source.durationSec,
          });
          run.watchableInSeconds = forecast.watchableInSeconds;
          // The first minute of a conversion, said out loud instead of falling through to a
          // sentence that is false for a film about to start early.
          run.estimatingWait = forecast.estimatingWait;
          // 10f: **a film that cannot start early says so**, rather than counting down to a
          // moment that will never arrive. The live estimate for this case is
          // `secondsRemaining`, already on the same snapshot — one clock, not two.
          run.playsOnCompletion = forecast.playsOnCompletion;
          // Pushed here rather than left to the next progress report: `onProgress` fires
          // *before* the gate is asked, so a snapshot pushed there always carries the
          // previous answer. One report stale is one report too many for a countdown.
          push();
        },
        onGateOpen: (serve: HeadStartServe) => {
          if (preparation !== run) return;
          void startHeadStartCast(serve, run.startPositionSec, source.durationSec);
        },
        onConversionComplete: () => {
          state.conversionComplete = true;
          // The playlist is closed: the whole film exists, so nothing is clamped any more
          // and the guard has nothing left to protect. It releases on its next sample.
          if (state.serving) session.noteFrontier(null);
          push();
        },
      },
      run.abort.signal,
    );

    state.discardSegments = started.discardSegments;
    const result = started.result;

    if (preparation !== run) {
      // Cancelled, or superseded. `cancelPreparation` has already discarded the segments.
      return;
    }
    preparation = null;
    const elapsedMs = clock.monoMs() - startedAtMono;

    if (!result.ok) {
      notice =
        result.failure.kind === 'cancelled' ? null : preparationNotice(result.failure, source.name);
      logger.warn('preparation.finished', {
        name: source.name,
        ok: false,
        failure: result.failure.kind,
        elapsedMs,
        headStartServed: state.serving,
      });
      discardHeadStart(`the conversion ended: ${result.failure.kind}`);
      push();
      return;
    }

    prepared = result.artifact;
    logger.info('preparation.finished', {
      name: source.name,
      ok: true,
      elapsedMs,
      estimateSeconds: decided.estimateSeconds,
      estimateErrorPct:
        decided.estimateSeconds === null || decided.estimateSeconds <= 0
          ? null
          : Math.round(
              ((elapsedMs / 1_000 - decided.estimateSeconds) / decided.estimateSeconds) * 100,
            ),
      bytes: result.artifact.bytes,
      estimatedBytes: decided.estimatedBytes,
      artifact: result.artifact.path,
      headStartServed: state.serving,
      guardHolds: state.guard.holds,
      guardHeldTotalSec: Math.round(state.guard.heldTotalSec),
    });

    if (!state.serving) {
      // The gate never opened: a film shorter than the head start, or a conversion that
      // never sustained the speed. This is M3a's ending, and the segments are of no further
      // use to anybody.
      discardHeadStart('the gate never opened, so the finished file is what plays');
      void startCast(run.startPositionSec);
      return;
    }
    // 10g: the film in progress is **not disturbed**. The MP4 is beside the source for next
    // time; the segments go when the television is let go, in `releaseHeadStart`.
    push();
  }

  /**
   * What the founder is told when a preparation did not produce a file.
   *
   * One sentence each, no codec names and no ffmpeg output — P3 puts the detail in the log
   * and keeps it off the screen. The two situations that are not really about the film get
   * their own words, because *"Couldn't prepare Cars.mkv"* would be a wrong answer for both.
   */
  function preparationNotice(failure: PreparationFailure, name: string): NoticeSnapshot {
    switch (failure.kind) {
      case 'disk-space':
        return {
          kind: 'generic',
          severity: 'error',
          // P1/P2's plain amount. Nothing is deleted to make room, ever.
          message: failure.room.message ?? 'There isn’t enough room on that drive.',
          actionLabel: 'Try again',
        };
      case 'source-missing':
        // P7: M2's existing sentence, deliberately. No new vocabulary for a failure the
        // founder has already met, and *Find it again* is the button they already know.
        return {
          kind: 'source-missing',
          severity: 'warning',
          message: 'The original file is no longer where it was.',
          actionLabel: 'Find it again',
        };
      case 'ffmpeg-missing':
        return installationDamagedNotice();
      default:
        return {
          kind: 'generic',
          severity: 'error',
          message: `Couldn’t prepare ${name}.`,
          actionLabel: 'Try again',
        };
    }
  }

  function installationDamagedNotice(): NoticeSnapshot {
    return {
      kind: 'installation-damaged',
      severity: 'error',
      message:
        'Some of CastGood’s own files are missing, so it can’t prepare videos. ' +
        'Reinstalling CastGood fixes it.',
      actionLabel: null,
    };
  }

  /**
   * 8d, and P6 when the app is closing: stop within 2 s and leave nothing behind.
   *
   * The stop is immediate — aborting kills the ffmpeg process — and the staging file is
   * removed by the pipeline on its way out, so there is never a partial file beside the
   * founder's source to tidy up by hand.
   */
  function cancelPreparation(why: string): void {
    if (preparation === null) {
      // A head start outlives its conversion: the film can still be playing from segments
      // when there is no job left to cancel, and closing the app has to take those with it.
      discardHeadStart(why);
      return;
    }
    logger.info('preparation.cancelled', { why, percent: preparation.percent });
    preparation.abort.abort();
    preparation = null;
    // 8d, P6: the partial work goes, and for a head start the partial work includes the
    // folder of segments. There is no television left watching them — a cancel stops the
    // film too, and the founder was told so before they answered the prompt.
    discardHeadStart(why);
  }

  // --- M3b: the head start, and the guard that protects it ---------------------

  /**
   * Give the television the growing playlist. **The only call site**, and it is reachable
   * only from the pipeline's `onGateOpen` — which is what makes 10h's *"nothing is loaded
   * until both halves of the gate are true"* a property of one path rather than a rule
   * several of them observe.
   */
  async function startHeadStartCast(
    serve: HeadStartServe,
    startPositionSec: number,
    durationSec: number | null,
  ): Promise<void> {
    const device = devices.find((candidate) => candidate.id === selectedDeviceId);
    const current = file;
    if (device === undefined || current === null || headStart === null) {
      logger.warn('cast.head_start_ignored', {
        hasDevice: device !== undefined,
        hasFile: current !== null,
      });
      return;
    }
    notice = null;
    headStart.serving = true;
    lastCastPath = serve.dir;
    logger.info('cast.head_start_serving', {
      name: current.name,
      dir: serve.dir,
      // **Both numbers, at the moment of the LOAD.** 10h fails on an absent one, and this
      // record is what the `headstart` scenario and the wire trace are read against.
      preparedSec: Math.round(serve.preparedSec),
      sustainedSpeed: serve.sustainedSpeed,
      durationSec,
      startPositionSec,
    });
    startGuard();
    const track = wantedSubtitle();
    castSubtitle = track === null ? null : { label: track.name };
    await session.cast(
      device,
      {
        path: serve.dir,
        name: current.name,
        hls: { playlistName: serve.playlistName },
        // A growing playlist takes a text track exactly as a file does: the track is its
        // own mount and its own URLs, and nothing about the playlist changes for it.
        ...(track === null ? {} : { subtitle: track }),
        // 10c: our own probe's duration, for the whole session, because the device reports
        // `-1` for the whole session — measured on both device classes.
        ...(durationSec === null ? {} : { durationSec }),
      },
      { startPositionSec },
    );
  }

  /**
   * The live guard (10i): compare playhead against frontier every 2 s, for the whole session.
   *
   * The comparison itself is `guardStep`, a pure function, and everything here is the I/O
   * around it — which is the shape the whole milestone is arranged in, because a guard that
   * could only be tested against a television could not be tested at all.
   *
   * **An opening check is what 2026-08-21 disproved**: the worst freeze of that run (25.5 s)
   * arrived 199.9 s in, on a conversion that had been fine for three minutes.
   */
  function startGuard(): void {
    stopGuard();
    if (headStart === null) return;
    // The tick is injected (see `GuardTicker`): the shipping default is a 2 s interval and
    // a test drives it a tick at a time, so the sequence a held film can go through —
    // hold, escape, hold again — is asserted rather than waited for.
    stopGuardTicker = guardTicker.start(PREPARATION.frontierSampleMs, () => {
      sampleFrontier();
    });
  }

  function stopGuard(): void {
    stopGuardTicker?.();
    stopGuardTicker = null;
  }

  /** One sample: the whole of the guard, and it must be cheap enough to run every 2 s. */
  function sampleFrontier(): void {
    const state = headStart;
    if (state === null || !state.serving) return;
    const model = session.model;
    // A session that is over has no picture to hold. The guard stops rather than pausing a
    // television that has already been let go.
    if (model.state === 'idle' || model.state === 'stopped' || model.state === 'ended') {
      stopGuard();
      return;
    }

    // **Re-stated on every sample, and that is not belt and braces.** `intent.cast` resets
    // the session model — it has to, a cast is a fresh session — so a frontier told to the
    // supervisor before the load is wiped by the load. Told here, the clamp is correct from
    // the first sample after the picture appears, which is before the founder's hand can
    // reach the scrubber.
    if (!state.conversionComplete) session.noteFrontier(state.frontierSec);

    const atMs = clock.monoMs();
    const step = guardStep(state.guard, {
      atMs,
      // The device's own reported position, extrapolated — never our opinion of it.
      positionSec: session.positionSec(),
      frontierSec: state.frontierSec,
      conversionComplete: state.conversionComplete,
      playing: model.state === 'playing',
    });
    const wasHeld = state.guard.held;
    state.guard = step.state;

    // The estimate is measured over a short window rather than the gate's minute: the
    // founder is being told when the picture comes back, and that is a question about what
    // the conversion is doing now.
    const speedNow = sustainedSpeed(state.samples, PREPARATION.frontierSpeedWindowMs);
    state.waitingForCompletion = state.guard.held && !canCatchUp(speedNow);

    if (step.action === 'hold') {
      logger.info('headstart.guard_hold', {
        marginSec: Math.round(step.marginSec),
        atSec: Math.round(session.positionSec()),
        frontierSec: Math.round(state.frontierSec),
        speedNow,
        holds: state.guard.holds,
        // True when the film had escaped a hold and is being taken back — something other
        // than this app started it playing again (the Google Home app, a phone), or our own
        // PAUSE went unanswered inside the optimistic window.
        reasserted: wasHeld,
      });
      state.pausedByGuard = true;
      // 10i: the pause must reach the device within 5 s of the margin crossing. Nothing is
      // awaited here — the supervisor does not await play/pause either, because a device
      // that never answers must not hold up the next thing anyone presses.
      void session.pause();
    } else if (step.action === 'release' && wasHeld) {
      logger.info('headstart.guard_release', {
        marginSec: Math.round(step.marginSec),
        heldForSec: Math.round(state.guard.heldTotalSec),
        conversionComplete: state.conversionComplete,
      });
      // *"Resumes by itself, at the frame it held, with nothing pressed and no error."* The
      // frame is the device's own: it was paused, so it is exactly where the guard left it.
      //
      // **Only if it is still paused.** A hold the film escaped — somebody pressed Play on a
      // phone — releases here too, and sending PLAY to a television that is already playing
      // would be the app pressing a button nobody asked it to press.
      if (state.pausedByGuard && model.state !== 'playing') void session.play();
      state.pausedByGuard = false;
    }

    // 10f: the wait **restates itself as it changes**, which is why the sentence is rebuilt
    // on every sample rather than composed once when the hold began.
    //
    // A held film always has a sentence — `stillPreparingMessage(null)` is *Still preparing…*
    // and never nothing — which is what lets the snapshot carry one nullable object instead
    // of a boolean and a message that can disagree with it.
    state.holdingMessage = !state.guard.held
      ? null
      : state.waitingForCompletion
        ? willPlayWhenReadyMessage(remainingConversionSeconds(state, speedNow))
        : stillPreparingMessage(secondsUntilRelease(step.marginSec, speedNow));

    if (state.guard.held || wasHeld || step.action !== 'none') push();
  }

  /** How long the whole conversion still has, for the sentence 10f asks for. */
  function remainingConversionSeconds(state: HeadStartState, speed: number | null): number | null {
    const total = file?.durationSec ?? null;
    if (total === null || speed === null || speed <= 0) return null;
    return Math.max(0, (total - state.frontierSec) / speed);
  }

  /**
   * The segments go, and only once the television has been let go (10g).
   *
   * Called from every way a session can end — Stop, the end of the film, a cancel, the app
   * closing — rather than from the moment ffmpeg exits, because at that moment the founder
   * is still watching the very segments this removes.
   */
  function discardHeadStart(why: string): void {
    const state = headStart;
    if (state === null) return;
    stopGuard();
    headStart = null;
    session.noteFrontier(null);
    logger.info('headstart.segments_discarded', { why, holds: state.guard.holds });
    segmentCleanup = segmentCleanup.then(() => state.discardSegments());
  }

  async function startCast(startPositionSec: number): Promise<void> {
    const device = devices.find((candidate) => candidate.id === selectedDeviceId);
    const current = file;
    if (device === undefined || current === null) {
      logger.warn('cast.start_ignored', {
        hasDevice: device !== undefined,
        hasFile: current !== null,
      });
      return;
    }
    notice = null;
    // **The prepared file is what goes to the television, when there is one.** The founder's
    // name for the film is still the founder's — the panel says *Cars.mkv*, because that is
    // the film they chose, and `Cars (CastGood).mp4` is our bookkeeping. Only the path
    // changes.
    const servePath = prepared?.path ?? current.path;
    lastCastPath = servePath;
    // 18e: **the video sent is unchanged.** The same file, the same mount, the same
    // content type — a subtitle adds one more mount and two keys, and takes nothing away.
    const track = wantedSubtitle();
    castSubtitle = track === null ? null : { label: track.name };
    logger.info('cast.serving', {
      name: current.name,
      prepared: prepared !== null,
      path: servePath,
      subtitleCues: track?.cues.length ?? null,
      subtitleOffsetMs: track?.offsetMs ?? null,
    });
    await session.cast(
      device,
      {
        path: servePath,
        name: current.name,
        ...(track === null ? {} : { subtitle: track }),
      },
      { startPositionSec },
    );
  }

  /**
   * A television refused the file we told the founder it could play — criterion 7e.
   *
   * The safety net for the `AI PONT` and every other television we have never met. Three
   * things happen and the order matters: **record** what this device would not play, so the
   * fact is permanent and this cannot recur; **re-plan** against the narrowed profile, which
   * `narrowAfterRefusal` guarantees will no longer say *Ready to cast* for this exact file;
   * and **start preparing**, so what the founder sees is a wait rather than an error.
   *
   * It only ever fires for a load we believed would work. A refusal of a file we had already
   * decided needed converting is a fact about the television or about our own output, and
   * narrowing further on that basis would be guessing — the session's own *Couldn't play
   * this file* stands.
   */
  function onLoadRejected(detail: string): void {
    const device = devices.find((candidate) => candidate.id === selectedDeviceId);
    const source = file;
    if (device === undefined || source === null || source.probe === null) return;
    // The probe of what we actually sent: the artifact when we served one, the source
    // otherwise. Narrowing on the source's properties after serving a converted copy would
    // teach the device table about a file the television never saw.
    const servedProbe =
      prepared !== null && lastCastPath === prepared.path ? prepared.probe : source.probe;
    if (verdict?.kind !== 'ready') {
      logger.info('capability.refusal_not_learned', {
        deviceId: device.id,
        // We only learn from a load we predicted would succeed. Anything else and we would
        // be narrowing a profile on the strength of our own encoder's output.
        why: 'the verdict was not ready',
        kind: verdict?.kind ?? null,
        detail,
      });
      return;
    }

    const narrowing = narrowAfterRefusal(profileFor(device), servedProbe, clock.wallMs());
    if (narrowing.steps.length === 0) {
      // Already at the floor: a television that will not play a baseline file. That is a
      // fact about the file or about the device, not something a further narrowing fixes,
      // and the session has already said so.
      logger.warn('capability.cannot_narrow_further', { deviceId: device.id, detail });
      return;
    }

    logger.warn('capability.downgraded', {
      deviceId: device.id,
      model: device.model,
      steps: narrowing.steps,
      signature: narrowing.signature,
      detail,
    });
    void (async () => {
      await store.recordDowngrade(device.id, narrowing);
      // Re-check against the profile we have just narrowed, and **await it**: the verdict
      // this re-plan depends on is not there until the check has finished. It cannot come
      // back `ready` for this file — that is the property `narrowAfterRefusal` is written
      // to guarantee — so this lands on a repackage or a conversion, and the founder sees
      // preparation start where the error was.
      prepared = null;
      await runCheckAsync('device.refused', clock.monoMs());
      if (verdict === null || verdict.plan.kind === 'none') {
        // Nothing to re-plan into. The session's *Couldn't play this file* stands, because
        // it is the truth and we have nothing better to offer.
        push();
        return;
      }
      // 7e: **preparation start, not an error.** The sentence the session raised belongs to
      // an outcome we have just replaced, and leaving it up would show the founder a
      // failure and a plan at the same time.
      session.noteReplanned();
      // The founder's press has not been honoured yet, so it carries on being honoured —
      // through 7f's confirmation when the re-plan turns out to be a long job. Opening the
      // confirmation *is* preparation starting from where the founder sits: it is the step
      // before the first byte, and 7f does not stop applying because the plan arrived by a
      // different route.
      if (verdict.requiresConfirmation) {
        confirming = true;
        logger.info('preparation.confirmation_shown', {
          why: 're-planned after a refusal',
          kind: verdict.kind,
          estimateSeconds: verdict.estimateSeconds,
        });
        push();
        return;
      }
      beginPreparation(0);
    })();
  }

  return {
    paths,
    logger,

    get mediaServerPort() {
      return mediaServerPort;
    },

    async start() {
      if (started) return;
      started = true;
      startedAtMono = clock.monoMs();
      logger.info('engine.start', {
        appVersion: options.appVersion ?? null,
        platform: process.platform,
        nodeVersion: process.versions.node,
        dataDir: paths.dataDir,
        logDir: paths.logDir,
      });

      // Discovery first and unconditionally: no button starts it, and it must be
      // running before the window paints so devices are already arriving.
      discovery.start();

      // "No devices found" is a state nothing else would ever push: if the house is
      // silent there is no event to react to. So the 5-second mark is scheduled, and
      // the message disappears by itself the moment a device answers (PRD 1d).
      emptyTimer = setTimeout(() => push(), DISCOVERY.emptyAfterMs);
      emptyTimer.unref?.();

      await store.load();
      // Before anything can put something there, and not awaited for its own sake — a
      // folder that cannot be removed is a warning in the log, never a failure to start.
      void sweepSubtitleWorkingDir();

      try {
        // The remembered port comes first, and only for story 12: the television may still
        // be fetching a URL that names it, and a different port 404s every request it
        // makes. An explicit option (tests, the selftest) still wins.
        const address = await mediaServer.start(
          options.mediaPort ?? store.settings.mediaPort ?? undefined,
        );
        mediaServerPort = address.port;
        void store.setMediaPort(address.port);
      } catch (error) {
        // The app is still useful (discovery works, the founder can look around) but a
        // cast will fail, so say so once, in plain language, rather than at cast time.
        logger.error('media.start_failed', { error });
        notice = {
          kind: 'generic',
          severity: 'error',
          message: isEngineError(error)
            ? error.userMessage
            : 'CastGood could not open the port it needs to send video to your TV.',
          actionLabel: null,
        };
      }

      network.start();
      session.noteNetwork(network.state.addresses, network.state.allAddresses);
      // Runs in the background; nothing waits for it. See `detectEncoderOnce`.
      detectEncoderOnce();
      push();

      // Story 12, and it runs *after* the window is already interactive: a reattach that
      // held up the launch would trade criterion 1a for it.
      void attemptReattach();
    },

    async stop(options) {
      if (!started) return;
      started = false;
      if (emptyTimer !== null) clearTimeout(emptyTimer);
      emptyTimer = null;
      // A probe still running when the engine stops is killed, not waited for.
      selectionSeq += 1;
      checkAbort?.abort();
      checkAbort = null;
      checking = null;
      // P6: **there is no conversion running after the app is gone.** The window asks the
      // founder first — that is `src/main/`'s job and the same prompt a film mid-play gets
      // — and by the time we are here the answer was yes, so the job stops and its partial
      // work goes with it.
      cancelPreparation('engine stopping');
      // An extraction in flight is killed for the same reason a probe is. Nothing it would
      // have produced outlives the run: since 2026-08-27 a finished track is cues in memory
      // and there is no file to take away with it (20g).
      clearSubtitle('engine stopping');
      // **Waited for, not hoped for.** The job's own cleanup — the staging file, the folder
      // of segments — runs after the kill, and a stop that returned before it was done would
      // leave the founder's disk being tidied by a process they think has gone.
      await preparationTask;
      await subtitleTask;
      await segmentCleanup;
      logger.info('engine.stop', {});
      network.stop();
      await session.dispose(options);
      // Every write asked for, on disk, before the process is allowed to believe it has
      // stopped — the reattach record is the last thing written and the first thing the
      // next run reads.
      await store.flush();
      await discovery.stop();
      await mediaServer.stop();
      mediaServerPort = null;
      await logger.flush();
      await logger.close();
    },

    dispatch(intent: Intent) {
      logger.info('intent.received', { intent: intent.type });
      switch (intent.type) {
        case 'discovery.rescan':
          discovery.rescan();
          push();
          return;
        case 'device.select': {
          const device = devices.find((candidate) => candidate.id === intent.deviceId);
          if (device === undefined) {
            logger.warn('intent.unknown_device', { deviceId: intent.deviceId });
            return;
          }
          selectedDeviceId = device.id;
          founderActed = true;
          // 9f: remembered on the founder's own choice, never on a device merely being
          // discovered — otherwise whichever television answered mDNS first would quietly
          // become "the one you used last".
          void store.rememberDevice(device.id, device.friendlyName, device.model);
          // 7b: the verdict is about a file **and** a television, so a different television
          // is a different question and may well be a different answer.
          runCheck('device.select');
          push();
          return;
        }
        case 'file.select':
          founderActed = true;
          void selectFile(intent.path);
          return;
        case 'file.clear':
          // Cancels a check in flight as well as dropping the selection (7a).
          selectionSeq += 1;
          checkAbort?.abort();
          checkAbort = null;
          checking = null;
          file = null;
          verdict = null;
          confirming = false;
          notice = null;
          preparedCache = null;
          clearSubtitle('the film was cleared');
          choices = { sources: [], unavailable: [] };
          founderActed = true;
          session.noteFileChanged();
          push();
          return;
        case 'cast.start':
          founderActed = true;
          pressPrimary(0);
          return;
        case 'cast.resume':
          // *Resume from 0:32:10* (16c). The remembered position is the session's own, not
          // a number the renderer sent us — a position that arrived over IPC could be
          // anything, and the founder was shown this one.
          founderActed = true;
          pressPrimary(session.model.resumePositionSec);
          return;
        case 'cast.stop':
          // 10g, and it is the moment the tidy-up is finally allowed to happen: the
          // television has been let go, so the fragments it was reading can go too. The
          // prepared MP4 beside the source is already there and is what plays next time.
          void session.stop();
          discardHeadStart('the founder stopped the film');
          return;
        case 'playback.play':
          void session.play();
          return;
        case 'playback.pause':
          void session.pause();
          return;
        case 'playback.seek':
          void session.seek(intent.positionSec);
          return;
        case 'playback.skip':
          void session.skip(intent.deltaSec);
          return;
        case 'volume.set':
          // Nothing is dispatched to the state machine: a volume is a control's value, not
          // a state (23k), so there is no event here for any screen to read.
          session.setVolume({ level: intent.level });
          return;
        case 'volume.mute':
          // The same slot as a level: one command on the wire and one value behind it, so
          // a mute pressed mid-drag cannot race the level it arrived with.
          session.setVolume({ muted: intent.muted });
          return;
        case 'preparation.confirm':
          // 7f: the founder read the three sentences and said yes.
          founderActed = true;
          if (!confirming) {
            logger.warn('intent.ignored', { intent: intent.type, why: 'nothing to confirm' });
            return;
          }
          beginPreparation(0);
          return;
        case 'preparation.decline':
          // 7g: *Not now*. The file stays chosen, the verdict stays on screen, and **nothing
          // has been written** — there was never anything to undo, because the confirmation
          // is the state that comes *before* the first byte.
          founderActed = true;
          confirming = false;
          logger.info('preparation.declined', { name: file?.name ?? null });
          push();
          return;
        case 'subtitles.select': {
          founderActed = true;
          const source = choices.sources.find((candidate) => candidate.id === intent.sourceId);
          if (source === undefined) {
            // A well-formed id that names nothing we are offering. The boundary checked the
            // shape; this is the only place that knows the list, so this is where it is
            // refused — and it is refused silently, because nobody can have pressed it.
            logger.warn('intent.unknown_subtitle_source', { sourceId: intent.sourceId });
            return;
          }
          chooseSubtitle(source);
          return;
        }
        case 'subtitles.chooseFile':
          founderActed = true;
          // 18c: **used where it lives.** Nothing is moved, copied or renamed, and the id
          // carries the path rather than the label so two files with the same name in
          // different folders are two different choices.
          chooseSubtitle({
            id: `picked:${intent.path}`,
            label: basename(intent.path),
            language: null,
            origin: { kind: 'picked', filePath: intent.path },
          });
          return;
        case 'subtitles.clear':
          founderActed = true;
          clearSubtitle('the founder turned subtitles off');
          push();
          return;
        case 'diagnostics.export':
          // Deliberately NOT `founderActed = true`. That flag means the person did
          // something to the film; saving a report touches nothing on any television, and
          // 25a's whole point is that this works when the session is already broken.
          void exportReport();
          return;
        case 'subtitles.nudge':
          founderActed = true;
          nudgeSubtitle(intent.steps);
          return;
        case 'subtitles.retry':
          founderActed = true;
          // 18l. The session owns what this costs — a television takes text tracks only in
          // a LOAD, so it is the same stated reload at the founder's place that choosing a
          // subtitle mid-film costs (19b, as amended). The film keeps playing throughout.
          if (!session.retrySubtitle()) {
            logger.warn('intent.ignored', { intent: 'subtitles.retry', why: 'nothing to retry' });
          }
          push();
          return;
        case 'subtitles.resetTiming':
          founderActed = true;
          // 20e: *"one press and one swap"* — and it is one swap because *in sync* is a rung
          // of the ladder like any other, so getting back to it is the same track switch
          // every nudge is. A founder who has nudged themselves into a mess is always one
          // press from where they started.
          setSubtitleOffset(0, 'reset');
          return;
        case 'preparation.cancel':
          // 8d: stops within 2 s and leaves nothing behind. The founder is back at the
          // verdict with the file still chosen and the folder exactly as it was.
          founderActed = true;
          cancelPreparation('founder cancelled');
          push();
          return;
      }
    },

    snapshot: () => snapshot,

    subscribe(listener) {
      listeners.add(listener);
      notify(listener);
      return () => listeners.delete(listener);
    },

    unsafeMediaBlackout: (on) => mediaServer.unsafeBlackout(on),
    unsafeWithholdSubtitleTracks: (on) => {
      mediaServer.unsafeWithholdTracks(on);
    },
    unsafeMediaDeliveries: () => mediaServer.deliveriesInFlight(),
  };
}

export { resolveAppPaths, resolveDataDir, type AppPaths } from './paths.js';
export * from './protocol/index.js';
export * from './types.js';
export { EngineError, isEngineError, notImplemented, type EngineErrorCode } from './errors.js';
export { CAST, DISCOVERY, LOGGING, MEDIA_SERVER, PREPARATION, SELFTEST, TIMING } from './config.js';
export type { Logger, LogLevel, LogRecord } from './logging/index.js';
export { probeSourceFile, formatDuration, type ProbedSource } from './media/probe.js';
export {
  resolveFfmpeg,
  isFfmpegAvailable,
  describeFfmpeg,
  FFMPEG_DIR_ENV,
  PACKAGED_BIN_DIR,
  PROJECT_BIN_DIR,
  type FfmpegBinaries,
  type FfmpegResolution,
  type FfmpegFound,
  type FfmpegMissing,
  type FfmpegSource,
} from './media/ffmpeg.js';
export {
  inspectSource,
  isClassifiable,
  type FfprobeRunner,
  type ProbeOrigin,
  type SourceInspection,
} from './media/inspection.js';
/**
 * The preparation surface, exported by name rather than `export *`: the classifier's
 * `VerdictKind` (the PRD's four verdicts) and the snapshot's `VerdictKind` (what the screen
 * is showing, including *Checking…*) are different questions with the same word, and a star
 * export would silently make one of them win. Import the classifier's from
 * `engine/prepare/classify.js` where it is needed.
 */
export {
  classify,
  createPreparationPipeline,
  describeApproxSeconds,
  isReusableArtifact,
  applyNarrowingStep,
  BASELINE_PROFILE,
  MODEL_TABLE,
  modelProfile,
  narrowAfterRefusal,
  resolveDeviceProfile,
  signatureOf,
  parseFfprobeReport,
  parseFfprobeStdout,
  primaryVideoStream,
  subtitleStreams,
  type CapabilityDowngrade,
  type ClassifyOptions,
  type ImpossibleReason,
  type ModelProfileEntry,
  type NarrowingStep,
  type PreparationPlan,
  type ProbeResult,
  type ProbeStream,
  type RefusedSignature,
  type SubtitleForm,
  type ThroughputEstimate,
  type Verdict,
  type VerdictDetail,
} from './prepare/index.js';
