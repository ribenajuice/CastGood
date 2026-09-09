import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEngine, type Engine } from '../index.js';
import { tlsTransportFactory, type CastTransport, type TransportFactory } from '../cast/index.js';
import type { CastMessage } from '../cast/castv2/proto.js';
import type { Mdns } from '../discovery/index.js';
import type { StateSnapshot } from '../protocol/index.js';
import type { SessionState } from '../types.js';
import { resolveAppPaths, type AppPaths } from '../paths.js';
import {
  combineSinks,
  createFileSink,
  createMemorySink,
  systemClock,
  type Clock,
  type LogRecord,
  type LogSink,
} from '../logging/index.js';
import type { InterfaceSource } from '../discovery/interfaces.js';
import { formatDuration } from '../media/probe.js';
import { modelProfile } from '../prepare/device-profiles.js';
import { CAST, PREPARATION, SELFTEST, SKIP, TIMING } from '../config.js';
import { assertion, holdsTheTelevision, observation, SelftestAbort } from './kit.js';
import {
  scenarioCheck,
  scenarioConvert,
  scenarioPrepFail,
  scenarioPrepared,
  scenarioRemux,
} from './m3.js';
import { scenarioSubtitles } from './m3c.js';
import { scenarioVolume } from './m5a.js';
import { scenarioHeadStart } from './m3b.js';
import type { Assertion } from './kit.js';

// The grading vocabulary lives in `./kit.js` so that `./m3.js` can use it without importing
// this file — see that file's header. Re-exported here because every existing caller, and
// `test/engine/selftest*.test.ts`, imports it from the selftest's front door.
export { assertion, observation, SelftestAbort, compare } from './kit.js';
export type { Assertion, AssertionKind, Comparison } from './kit.js';

/**
 * The headless selftest — the only automated way to check *real* casting behaviour.
 *
 * Its entire reason to exist is stated in the PRD: "it must be impossible for the
 * selftest to report success without a real device having played real video." Three
 * rules follow from that and none of them may be softened:
 *
 *  1. **It drives the same engine the app drives, through the same intents.** Nothing in
 *     here reaches past `engine.dispatch()` into the cast client. A selftest that
 *     exercises a parallel code path proves nothing about the app.
 *  2. **Exit 2 is not a failure, it is "this did not happen".** Device not found within
 *     30 s, file missing, port unavailable: the run could not take place, and saying so
 *     is the honest answer. A run that never reached a device can never exit 0.
 *  3. **Every assertion carries its target *and* its measured value.** "Passed" without
 *     a number is the thing this exists to replace.
 *
 * Latency is never measured from our own optimistic display. Where a number describes
 * what the device did — pause latency, position accuracy — it is read from the device's
 * own status arrivals in the engine log, which are stamped monotonically on arrival.
 */

/**
 * `m2` exists now, and it did not before.
 *
 * It was deliberately absent while `recover`, `reattach` and `takeover` were unbuilt: an
 * aggregate that ran only the scenarios that existed would have exited 0 and been read as
 * "M2 passed", which is the one kind of pass this harness exists to make impossible. All
 * three exist as of the reliability third, so `m2` now runs the whole list the PRD names —
 * and `test/engine/selftest-honesty.test.ts` is what holds it to that.
 *
 * `m1` is unchanged and still has to pass.
 */
export const SCENARIOS = [
  'discovery',
  'cast',
  'transport',
  'position',
  'seek',
  'skip',
  'recover',
  'reattach',
  'takeover',
  'sourcegone',
  'finish',
  'resume',
  'check',
  'remux',
  'prepared',
  'convert',
  'headstart',
  'prepfail',
  'subtitles',
  'volume',
  'm1',
  'm2',
  'm3',
  'm3c',
  'm5',
] as const;

/**
 * Which kind of outage the `recover` scenario produces.
 *
 * `socket` and `heartbeat` are ours to produce: we kill our own socket, or stop believing
 * the device's PONGs. **`cable` is not.** It is a person walking to the PC and pulling the
 * Ethernet out, and nothing in this file can make that happen — which is exactly why it
 * exists. Every automated outage here severs a connection *cleanly and locally*, so the
 * app learns instantly (1 ms on hardware). A real cable pull is silent: nothing closes,
 * things simply stop answering, and detection has to run on the heartbeat and the
 * interface watcher instead. That path has never met a real network.
 *
 * **`network` is defect D2's outage, and it exists because the first two cannot express
 * it.** `socket` and `heartbeat` kill *our own* connection to the television while this
 * PC's media server stays reachable throughout — so the *device's* byte connection is
 * never broken, and the failure the founder met on 2026-08-27 (the control channel
 * recovering in 243 ms while the film starved on a reset byte connection, never asking
 * this PC for another byte) **cannot happen in either**. `network` takes both away and
 * gives both back: the control socket dies and refuses to reconnect, and the media server
 * destroys every connection the television has to it and refuses new ones, which is what
 * a route disappearing looks like from the far end. It needs nobody in the room, so
 * unlike `cable` it can run in an aggregate and in CI's own fake-receiver tests.
 */
export const OUTAGES = ['socket', 'heartbeat', 'network', 'cable'] as const;
export type OutageKind = (typeof OUTAGES)[number];

/**
 * The outages a human has to perform, and the fact that makes `cable` safe to add.
 *
 * A list rather than a convention, because two rules depend on it and both are the kind
 * that quietly stop being true: a human outage may only be asked of `recover`, and it may
 * **never** run inside an aggregate. `m2` is unattended — it passed 107/107 on a real
 * television without anybody in the room — and an aggregate that silently waited two
 * minutes for a person who was not there, then exited 2, would destroy that.
 */
export const HUMAN_OUTAGES: readonly OutageKind[] = ['cable'];

export function isHumanOutage(kind: OutageKind): boolean {
  return HUMAN_OUTAGES.includes(kind);
}

/**
 * Why this scenario may not be asked for this outage — or `null` when it may.
 *
 * One function, called in two places on purpose: the command line refuses the combination
 * before a device is even looked for, and `runSelftest` refuses it again before anything
 * is cast, so nothing that bypasses argument parsing (a test, an IPC caller, a future
 * menu item) can reach the waiting-for-a-human path inside an unattended run.
 */
/**
 * Why `--rate` may not be asked of this scenario — or `null` when it may.
 *
 * The same shape as `refuseOutage`, and for the same reason: a flag that changes what the
 * product *does* must be refused loudly rather than quietly ignored. A `--rate` on an
 * aggregate would slow every conversion in it to a crawl and turn a twenty-minute `m3` into
 * an overnight one; a `--rate` on `convert` would make 8b's honesty clause meaningless.
 */
export function refuseRate(
  scenario: ScenarioName,
  rate: number | undefined,
  rateAfterGate?: number | undefined,
): string | null {
  // Two throttles that mean opposite things — one keeps the gate shut, the other requires it
  // to open — and a run given both would be a verdict about neither.
  if (rate !== undefined && rateAfterGate !== undefined) {
    return '--rate and --rate-after-gate are opposite runs: one proves the gate stays shut on a slow conversion, the other proves the guard holds a film once it has opened. Ask for one';
  }
  const asked = rate ?? rateAfterGate;
  if (asked === undefined) return null;
  if (scenario === 'headstart') return null;
  const flag = rate === undefined ? '--rate-after-gate' : '--rate';
  return `${flag} only applies to \`--scenario headstart\`, where it produces the case story 10 exists to prevent; \`--scenario ${scenario}\` would just run slowly`;
}

/**
 * `--timing` is `subtitles`' story-20 run, and it means nothing anywhere else.
 *
 * Refused rather than ignored, for `refuseRate`'s reason: an operator who asked for the
 * timing run and silently got the ordinary one would read a green verdict as evidence that
 * a nudge reached a television, which it would not be.
 */
export function refuseTiming(scenario: ScenarioName, timing: boolean): string | null {
  if (!timing || scenario === 'subtitles') return null;
  // `m3c` gets its own sentence, because "has no subtitle to move" would be simply untrue
  // of it and would read as a bug in the refusal rather than an answer. It runs all three
  // subtitle runs as legs, so asking for one of them beside it is ambiguous — and silently
  // ignoring the flag would leave an operator believing they had asked for something.
  if (scenario === 'm3c') {
    return '--timing is one of the three runs `--scenario m3c` already makes for you (plain, --timing, --broken). Ask for `--scenario m3c` on its own, or `--scenario subtitles --timing` for that run alone';
  }
  return `--timing only applies to \`--scenario subtitles\`, where it measures story 20's nudge on a real television; \`--scenario ${scenario}\` has no subtitle to move`;
}

/**
 * `--watch` is `headstart`'s full-film run, and it means nothing anywhere else.
 *
 * Refused rather than ignored, for `refuseRate`'s reason: an operator who asked for a
 * 130-minute run and silently got a three-minute one would read the verdict as the full-film
 * evidence 10b requires. It also refuses to combine with the two throttles — a full film is
 * about a conversion that keeps its lead the whole way, and a starved or falling-behind
 * conversion is a different claim with its own criteria.
 */
/**
 * `--broken` is the `subtitles` scenario's **refusal** run, and it means nothing elsewhere.
 *
 * Refused rather than ignored, for `refuseTiming`'s reason: an operator who asked for the
 * refusal run and silently got the ordinary one would read a green verdict as evidence that
 * an unreadable file was refused and that a film survived a subtitle that never loaded —
 * neither of which would have been tested at all.
 *
 * It also refuses to combine with `--timing`. They are two runs in the PRD's own table and
 * they want opposite things from the same session: one nudges a track that is working, the
 * other declares one the television cannot fetch. A run that tried to be both would grade
 * story 20 against a track that was never there.
 */
export function refuseBroken(
  scenario: ScenarioName,
  broken: boolean,
  timing: boolean,
): string | null {
  if (!broken) return null;
  if (scenario === 'm3c') {
    // See `refuseTiming`: `m3c` runs this very run as its third leg.
    return '--broken is one of the three runs `--scenario m3c` already makes for you (plain, --timing, --broken). Ask for `--scenario m3c` on its own, or `--scenario subtitles --broken` for that run alone';
  }
  if (scenario !== 'subtitles') {
    return `--broken only applies to \`--scenario subtitles\`, where it is the refusal run for criteria 18j-18l; \`--scenario ${scenario}\` has no subtitle to refuse`;
  }
  if (timing) {
    return '--broken and --timing are two different runs of `subtitles`: one nudges a track that works, the other declares one the television cannot fetch. Ask for one';
  }
  return null;
}

export function refuseWatch(
  scenario: ScenarioName,
  watchMs: number | undefined,
  rate?: number | undefined,
  rateAfterGate?: number | undefined,
): string | null {
  if (watchMs === undefined) return null;
  if (scenario !== 'headstart') {
    return `--watch only applies to \`--scenario headstart\`, where it is the full-film run PRD 10b calls the only evidence that counts; \`--scenario ${scenario}\` has no film to watch`;
  }
  if (rate !== undefined || rateAfterGate !== undefined) {
    return '--watch is the full-film run and asks for a conversion that keeps its lead all the way; --rate and --rate-after-gate deliberately break that. Ask for one';
  }
  return null;
}

export function refuseOutage(scenario: ScenarioName, outage: OutageKind): string | null {
  if (!isHumanOutage(outage)) return null;
  if (scenario === 'recover') return null;
  return `--outage ${outage} needs somebody standing at the PC, so it only runs as \`--scenario recover\`; \`--scenario ${scenario}\` is unattended and would wait for a human who is not there`;
}

/** Below this many samples, "is the error trending upwards?" has no honest answer. */
const TREND_MINIMUM_SAMPLES = 10;
export type ScenarioName = (typeof SCENARIOS)[number];

/**
 * The four aggregates, and everything that is not one.
 *
 * Named rather than spelled `Exclude<ScenarioName, 'm1' | 'm2'>` at six call sites, which is
 * how `m3` would otherwise have had to be added to each of them one at a time — and the one
 * that got missed would have compiled.
 */
export const AGGREGATES = ['m1', 'm2', 'm3', 'm3c', 'm5'] as const;
export type Aggregate = (typeof AGGREGATES)[number];
export type AggregateMember = Exclude<ScenarioName, Aggregate>;

/**
 * One leg of an aggregate: a scenario **and the run of it** that is being asked for.
 *
 * Every aggregate before `m3c` ran each of its scenarios once, so a leg was just a name.
 * `m3c` runs `subtitles` three times — plain, `--timing` and `--broken` — which are three
 * different runs of one scenario asserting different things, so a name is no longer enough
 * to say what happened. The `label` is what the verdict prefixes this leg's assertions
 * with, and it is why `subtitles-broken.filmStillPlayingAfterTryAgain` can be read without
 * re-running anything.
 */
export interface AggregateLeg {
  readonly scenario: AggregateMember;
  /** How this leg's assertions are named in the verdict. Unique within an aggregate. */
  readonly label: string;
  readonly subtitleTiming: boolean;
  readonly subtitleBroken: boolean;
}

/** Exported for its own test: the three states in which no television is being held. */
export { holdsTheTelevision };

export type SelftestOutcome = 'passed' | 'failed' | 'could-not-run';

/**
 * What the founder is being told, beside the words themselves.
 *
 * The words are for a person standing next to a television; the stage is for anything
 * that has to *react* to them — which in practice is the test that plays the founder. It
 * matches on the stage rather than on the prose, so the instructions can be rewritten for
 * clarity without breaking the tests that prove the scenario waits for the right things.
 */
export type SelftestPromptStage =
  /** Go and do the physical thing. */
  | 'unplug'
  | 'replug'
  /** The world changed as asked; here is what to watch while it stays that way. */
  | 'offline'
  | 'online'
  /** A countdown tick, so two minutes of waiting is never two minutes of silence. */
  | 'progress'
  /** Anything else worth saying out loud — including why a run is about to stop. */
  | 'note';

export interface SelftestVerdict {
  readonly schemaVersion: 1;
  readonly scenario: ScenarioName;
  /**
   * Which *run* of that scenario this was, when a scenario has more than one.
   *
   * `headstart` has three, and two of them assert opposite things: the ordinary run requires
   * the gate to open, `starved` requires it to stay shut, and `falls-behind` requires it to
   * open and then the guard to take the picture. Read literally, a `starved` pass is 10j's
   * own *fails if* — *"`headstart` can reach exit 0 on a run where the gate never opened"* —
   * so the verdict has to say which question it answered. `null` for a scenario with one run.
   */
  readonly variant: string | null;
  readonly device: string;
  readonly file: string;
  readonly startedAt: string;
  readonly durationMs: number;
  readonly outcome: SelftestOutcome;
  readonly exitCode: 0 | 1 | 2;
  /** Set only when the run could not happen. Plain language, no stack traces. */
  readonly reason: string | null;
  /**
   * Promises only: every one carries a target, a comparison and a measured value, and any
   * of them can fail the run (13b). Nothing without a target ever appears here — a number
   * we do not control is not an assertion, and putting it here would mean either an
   * ungradeable entry or a `passed: true` that measured nothing.
   */
  readonly assertions: readonly Assertion[];
  /**
   * Measured, named, and never graded: the television's own receiver boot time, and the
   * founder-visible totals it dominates. Kept out of `assertions` so the exit code cannot
   * turn on something no amount of work on our side would change.
   */
  readonly observations: readonly Assertion[];
  readonly environment: {
    readonly platform: string;
    readonly nodeVersion: string;
    readonly mediaServerPort: number | null;
    readonly logDir: string;
    /**
     * Where this object was saved, or `null` if it could not be. Never claim a file
     * exists that does not: the founder's run said "written next to the engine log" and
     * wrote nothing, which is worse than saying nothing at all.
     */
    readonly verdictFile: string | null;
    /**
     * `tls` is a run against a real device. `test-harness` means the run was given a
     * scripted receiver, which the command line cannot do — it exists so this file's own
     * tests can exercise it, and it is printed so a faked pass can never be mistaken for
     * a real one.
     */
    readonly transport: 'tls' | 'test-harness';
  };
}

export interface SelftestOptions {
  readonly deviceName: string;
  readonly filePath: string;
  readonly scenario: ScenarioName;
  /** How long the `position` scenario samples for. PRD default: 10 minutes. */
  readonly positionDurationMs?: number;
  /**
   * Which outage the `recover` scenario produces (11a vs 11f).
   *
   * `socket` destroys this process's own TLS socket to the device — the film keeps playing
   * on a real television throughout, which is the whole point. `heartbeat` stops our side
   * believing the PONGs, so the keep-alive give-up path runs against a device that is
   * perfectly healthy. Neither touches the network, so neither can be confused with a real
   * wifi drop; that is human checklist items 1–3 and nothing here claims otherwise.
   */
  readonly outage?: OutageKind;
  /**
   * `--timing`: run story 20's half of the `subtitles` scenario (that scenario only).
   *
   * The ordinary run proves a track reaches a television (18d, 18e, 19a). This one presses
   * *later* and *Reset* on a film that is playing and measures what reaches the wire: how
   * long the swap took, that four presses cost one message, and that the film never stopped.
   * A separate run because it is a separate promise, and because a verdict that folded the
   * two together could not say which half had failed.
   */
  readonly subtitleTiming?: boolean;
  /** `--broken`: run `subtitles`' refusal paths instead of its ordinary run — 18j-18l. */
  readonly subtitleBroken?: boolean;
  /**
   * `--rate`: run the conversion at this multiple of real time (`headstart` only).
   *
   * **The starved case, produced through the product.** A conversion at 0.7× cannot keep
   * ahead of playback, which is the condition that produced 46 seconds of frozen picture on
   * 2026-08-21 — and until now the only way to produce it was a spike republishing a fixture
   * on a timer, which proves something about the fixture. With this, the real pipeline runs
   * that slowly and the gate has to refuse it.
   */
  readonly conversionReadRate?: number;
  /**
   * `--rate-after-gate`: full speed until the gate opens, then this multiple of real time.
   *
   * **The only route to a guard hold on a real television.** `--rate` starves the conversion
   * *before* the gate, so nothing loads and there is no film to hold; an unthrottled run
   * opens at ≥1.5× and the margin only ever grows. This one produces the 2026-08-21
   * condition — a conversion that falls behind **mid-film** — through the product, with the
   * guard in place, which is what 10i and 10f's mid-film half need to be graded at all.
   */
  readonly conversionReadRateAfterGate?: number;
  readonly headStartWatchMs?: number;
  /**
   * Where the founder's instructions go while a human outage is being performed.
   *
   * **stderr in the app**, never stdout: stdout carries the verdict JSON and has to stay
   * machine-readable. Injected so a test can play the part of the founder — it is told to
   * unplug the cable, and it does, by changing the interface table the engine is watching.
   */
  readonly instructions?: (stage: SelftestPromptStage, text: string) => void;
  /**
   * The three waits `--outage cable` is made of, so a test can exercise the scenario in
   * seconds instead of the minutes a person needs. Defaults are in `SELFTEST`.
   */
  readonly humanOutage?: {
    /** How long the founder gets to reach the cable, in each direction. */
    readonly waitMs?: number;
    /** How long the cable stays out. Must exceed the 30 s give-up deadline to prove 11d. */
    readonly holdMs?: number;
    /** How long the app gets to work out that the missing address is *this PC's* problem. */
    readonly noticeGraceMs?: number;
    /** How often the countdown speaks. */
    readonly progressEveryMs?: number;
  };
  readonly paths?: AppPaths;
  readonly clock?: Clock;
  /** Overrides the log sink; the CLI leaves this alone so the run lands in the log dir. */
  readonly logSink?: LogSink;
  /** How long to wait for the named device before giving up with exit 2. */
  readonly deviceWaitMs?: number;
  /**
   * Scripted stand-ins for multicast and TLS, so this harness can be tested headlessly.
   * **The command line cannot set these**, and any verdict produced with them says
   * `transport: "test-harness"` — a run against a fake can never be read as a real pass.
   */
  readonly unsafeTestOverrides?: {
    readonly transport?: TransportFactory;
    readonly mdns?: Mdns;
    /**
     * The interface table the engine's network watcher reads, so a test can unplug a
     * cable. There is no other way to produce 11d headlessly — on a real machine this is
     * `os.networkInterfaces` and the only thing that changes it is somebody pulling
     * something out of the back of the PC.
     */
    readonly networkInterfaces?: InterfaceSource;
  };
}

/**
 * Set while a run owns a device, so an interrupt can still release it (13e).
 * A selftest that leaves a TV playing is a selftest nobody will run twice.
 */
let activeCleanup: (() => Promise<void>) | null = null;

/** Called by the CLI's signal handlers. Safe to call when nothing is running. */
export async function abortActiveSelftest(): Promise<void> {
  const cleanup = activeCleanup;
  activeCleanup = null;
  if (cleanup !== null) await cleanup();
}

/**
 * Which run of a scenario this is, for the verdict's own `variant` field.
 *
 * Named from the options rather than decided inside the scenario, so a verdict that never
 * reached the scenario at all — exit 2 on a missing file — still says which run was asked
 * for. There is no default beyond `null`: a scenario with one run has nothing to qualify.
 */
function runVariant(options: SelftestOptions): string | null {
  if (options.scenario === 'subtitles') {
    if (options.subtitleBroken === true) return 'broken';
    return options.subtitleTiming === true ? 'timing' : null;
  }
  if (options.scenario !== 'headstart') return null;
  if (options.conversionReadRateAfterGate !== undefined) return 'falls-behind';
  if (options.conversionReadRate !== undefined) return 'starved';
  // Named so a full-film verdict can never be read as an ordinary three-minute one — the
  // reason `variant` exists at all.
  if (options.headStartWatchMs !== undefined) return 'full-film';
  return null;
}

/** The run could not take place. Distinct from a failed assertion, and it exits 2. */
class WaitTimeout extends Error {
  constructor(description: string, timeoutMs: number) {
    super(`timed out after ${String(timeoutMs)} ms waiting for ${description}`);
    this.name = 'WaitTimeout';
  }
}

interface Harness {
  readonly engine: Engine;
  readonly clock: Clock;
  mono(): number;
  snapshot(): StateSnapshot;
  records(): LogRecord[];
  /** Log records of one event, in arrival order, optionally after a monotonic instant. */
  samples(event: string, afterMono?: number): LogRecord[];
  waitFor(
    description: string,
    timeoutMs: number,
    predicate: (snapshot: StateSnapshot) => boolean,
  ): Promise<number>;
  waitForState(state: SessionState, timeoutMs: number): Promise<number>;
  sleep(ms: number): Promise<void>;
}

function createHarness(
  engine: Engine,
  clock: Clock,
  sink: ReturnType<typeof createMemorySink>,
): Harness {
  const parse = (): LogRecord[] =>
    sink.lines.flatMap((line) => {
      try {
        return [JSON.parse(line) as LogRecord];
      } catch {
        return [];
      }
    });

  const harness: Harness = {
    engine,
    clock,
    mono: () => clock.monoMs(),
    snapshot: () => engine.snapshot(),
    records: parse,
    samples(event, afterMono) {
      return parse().filter((record) => {
        if (record.event !== event) return false;
        if (afterMono === undefined) return true;
        const mono = record['monoMs'];
        return typeof mono === 'number' ? mono >= afterMono : record.mono >= afterMono;
      });
    },
    waitFor(description, timeoutMs, predicate) {
      return new Promise<number>((resolve, reject) => {
        let unsubscribe = (): void => undefined;
        const timer = setTimeout(() => {
          unsubscribe();
          reject(new WaitTimeout(description, timeoutMs));
        }, timeoutMs);
        timer.unref?.();
        unsubscribe = engine.subscribe((snapshot) => {
          if (!predicate(snapshot)) return;
          clearTimeout(timer);
          // Defer so the unsubscribe handle exists even if the first snapshot matches.
          queueMicrotask(() => unsubscribe());
          resolve(clock.monoMs());
        });
      });
    },
    waitForState(state, timeoutMs) {
      return harness.waitFor(
        `session state ${state}`,
        timeoutMs,
        (snapshot) => snapshot.session.state === state,
      );
    },
    sleep(ms) {
      return new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      });
    },
  };
  return harness;
}

// --- Scenario building blocks ------------------------------------------------

export interface Context extends Harness {
  readonly deviceName: string;
  readonly filePath: string;
  readonly deviceId: string;
  /** The device's address, for the second connection the `takeover` scenario opens. */
  readonly deviceAddress: string;
  readonly devicePort: number;
  /**
   * How the `takeover` scenario opens its **own** connection to the television — the one
   * that plays the part of the phone.
   *
   * It is not the engine's transport and it is deliberately not the severable wrapper:
   * nothing about this connection is under test. It was `tlsTransportFactory`, hardcoded,
   * which meant the scripted receiver could never be taken over and the whole scenario was
   * unreachable by any headless test. A real run still gets real TLS; a run given a
   * scripted receiver still stamps itself `test-harness`.
   */
  readonly secondConnection: TransportFactory;
  readonly outage: OutageKind;
  /** `--timing`: run story 20's half of the `subtitles` scenario as well as 18's. */
  readonly subtitleTiming: boolean;
  /** `--broken`: run the refusal paths instead of the ordinary run — 18j-18l. */
  readonly subtitleBroken: boolean;
  /**
   * **Harness only: declare text tracks at a URL this PC does not answer on** — 18l.
   *
   * The only way an automated run can produce *"the television accepted the film and never
   * fetched the track"* against a real set, which always tries. The film's own URL is
   * untouched throughout, so what is taken away is the words and nothing else.
   */
  withholdTracks(on: boolean): void;
  /** Talks to the founder while a human outage is being performed. Never on stdout. */
  instruct(stage: SelftestPromptStage, text: string): void;
  /** The waits `--outage cable` is made of, already resolved against their defaults. */
  readonly human: {
    readonly waitMs: number;
    readonly holdMs: number;
    readonly noticeGraceMs: number;
    readonly progressEveryMs: number;
  };
  /**
   * Kills this process's own TLS socket to the device, without touching the network.
   *
   * The film keeps playing on the television throughout — SPIKE-2 measured the position
   * error at 0.003 s across a 15-second outage — so this exercises exactly what 11a is
   * about and **nothing** about a real wifi drop, which is human checklist items 1–3.
   */
  sever(): number;
  /** Stops our side believing the device's PONGs, so 11f's give-up path runs. */
  deafenHeartbeat(deaf: boolean): void;
  /**
   * **Takes the television's route to this PC away, and gives it back** — `--outage
   * network`, and defect D2's whole reason for existing.
   *
   * Both halves at once, because a network does not take them one at a time: the control
   * socket is cut *and refused*, and every connection the television has to this PC's
   * media server is destroyed while new ones are refused. Returns how many byte
   * connections were taken away, which is the number that says whether this run was
   * capable of producing the defect at all — none means the television was not fetching
   * anything from us, and the run exits 2 rather than passing.
   */
  cutTheRoute(on: boolean): { readonly control: number; readonly media: number };
  /**
   * Shuts the current engine down as though the window had been closed — leaving the
   * television playing — and starts a **second engine** against the same data directory.
   *
   * Honestly: a second engine *instance* in this process, not a second OS process. What
   * that does and does not prove is stated on the `reattach` assertions themselves.
   */
  restart(): Promise<void>;
  readonly startedAtMono: number;
  /** When the named device first appeared in the snapshot. */
  readonly deviceFoundAtMono: number;
  /** When the first device of any kind appeared. */
  readonly firstDeviceAtMono: number;
  readonly positionDurationMs: number;
  /**
   * `--rate`, or `null` for an ordinary run.
   *
   * The `headstart` scenario reads it to know **which run it is**: without it the gate is
   * expected to open and a run where it never did is exit 2; with it the gate is expected to
   * stay **shut**, and a run where it opened is exit 2 for the same reason — the condition
   * the scenario exists to test was not produced.
   */
  readonly conversionReadRate: number | null;
  /**
   * `--rate-after-gate`, or `null`. The head-start run **happens** in this mode — the gate
   * must open — and then the conversion falls behind and the guard has to take the picture.
   */
  readonly conversionReadRateAfterGate: number | null;
  readonly headStartWatchMs: number | null;
}

async function selectFileAndDevice(context: Context): Promise<Assertion[]> {
  context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });

  // Clear first, so `fileReadMs` measures a real read every time. Without this, every
  // scenario after the first re-selects a file that is already on screen and "measures"
  // a value that was true before it started.
  context.engine.dispatch({ type: 'file.clear' });
  await context.waitFor('the previous file to clear', 5_000, (snapshot) => snapshot.file === null);

  const before = context.mono();
  context.engine.dispatch({ type: 'file.select', path: context.filePath });
  let readMs: number | null = null;
  try {
    readMs =
      (await context.waitFor('the file to be read', 5_000, (snapshot) => snapshot.file !== null)) -
      before;
  } catch {
    // A file that was never read leaves `readMs` null, which fails its assertion below.
  }
  const file = context.snapshot().file;

  // "Nothing has been sent to any device" (2a). The session state alone cannot say that:
  // it is `stopped`, not `idle`, in every scenario after the first, which used to fail
  // `m1` against perfectly healthy hardware. What actually proves it is that no device
  // contact was logged between choosing the file and pressing Cast — a connection or a
  // load would each have written one — *and* that no session is live.
  const state = context.snapshot().session.state;
  const live = holdsTheTelevision(state);
  const contacts =
    context.samples('session.connected', before).length +
    context.samples('session.loading', before).length;
  const quiet = !live && contacts === 0;

  return [
    assertion(
      'fileReadMs',
      'lte',
      2_000,
      readMs,
      'ms',
      'PRD 2a: name and duration shown within 2 s',
    ),
    assertion(
      'fileDurationSec',
      'gte',
      1,
      file?.durationSec ?? null,
      's',
      'M1 reads duration only — this is not a compatibility judgement',
    ),
    assertion(
      'nothingSentBeforeCast',
      'eq',
      'nothing sent',
      quiet ? 'nothing sent' : `session ${state}, ${String(contacts)} device contact(s)`,
      'check',
      'PRD 2a: choosing a file sends nothing to any device',
    ),
  ];
}

async function castToPicture(
  context: Context,
  label: string,
): Promise<{ assertions: Assertion[]; ok: boolean }> {
  const start = context.mono();
  context.engine.dispatch({ type: 'cast.start' });
  let playingMs: number | null = null;
  try {
    playingMs = (await context.waitForState('playing', SELFTEST.stateWaitMs)) - start;
  } catch {
    // Never reached Playing: null measurement, failed assertion, and the state
    // sequence we did reach is reported instead so the verdict says where it stopped.
  }
  const states = context
    .samples('session.state_changed')
    .map((record) => String(record['to']))
    .join(' → ');

  // The whole of a cast, split at the one seam that matters: everything before
  // `cast.receiver_launched` that follows `session.loading` is the television booting its
  // own receiver app, and nothing we write makes that faster.
  const at = (event: string): number | null => {
    const record = context.samples(event, start)[0];
    if (record === undefined) return null;
    const mono = record['monoMs'];
    return typeof mono === 'number' ? mono : record.mono;
  };
  const launchRequestedAt = at('session.loading');
  const launchedAt = at('cast.receiver_launched');
  const receiverBootMs =
    launchRequestedAt === null || launchedAt === null
      ? null
      : Math.round(launchedAt - launchRequestedAt);
  const ourWorkMs =
    playingMs === null || receiverBootMs === null ? null : Math.round(playingMs - receiverBootMs);

  return {
    ok: playingMs !== null,
    assertions: [
      // **Founder's ruling, 2026-08-18: cast speed is not a reliability promise.** "Three
      // seconds is nothing... it would take me longer than that to get from my computer to
      // my TV anyway." What is graded is therefore what the founder actually experiences —
      // the whole wait, below — and not this, which is an engineering sub-measure that
      // appears nowhere in *What "reliable" means*. It was graded at 3 s and duly failed a
      // 2026-08-18 run that met the product promise with 4 s to spare, on a slower
      // television. Crying wolf costs more than it catches.
      //
      // Still measured, precisely, because a real regression must stay visible: this is the
      // number that moved 883 → 1,395 → 3,664 ms across three runs. A human reads the trend;
      // the exit code does not.
      observation(
        `${label}CastWithoutReceiverBootMs`,
        ourWorkMs,
        'ms',
        'our share of the cast: connect, load and buffer, with the receiver boot removed. Not graded — see the 2026-08-18 ADR. Compare against previous runs rather than a target',
      ),
      observation(
        `${label}ReceiverBootMs`,
        receiverBootMs,
        'ms',
        'the TV booting the Default Media Receiver — 6.42–10.59 s observed, outside our control, never graded',
      ),
      // **The margin, printed on every run.** The number above had been recorded all along
      // and is the only reason 2026-08-18's cold-cast failure was diagnosable at all — but
      // it says nothing on its own about how close the television came to the timeout that
      // abandons the cast. A boot of 7,986 ms reads as healthy; against the old 10,000 ms
      // launch timeout it was two seconds from an evening lost. Printed as a headroom so
      // the erosion is visible without arithmetic, and left ungraded because it is the
      // television's time, not ours.
      observation(
        `${label}LaunchHeadroomMs`,
        receiverBootMs === null ? null : CAST.launchTimeoutMs - receiverBootMs,
        'ms',
        `how much of the ${String(CAST.launchTimeoutMs)} ms launch timeout the television did not need. A run that drops towards zero is a cast about to be abandoned on a working TV — which is exactly what happened on 2026-08-18 at the old 10,000 ms`,
      ),
      // How many LAUNCHes it actually took. 1 on a healthy evening; anything more is a
      // silent retry doing its job, invisible to the founder and worth knowing here.
      observation(
        `${label}LaunchAttempts`,
        context.samples('session.launch_attempt', start).length,
        'attempts',
        'LAUNCHes sent for this cast. 1 is normal; more means the television did not answer and the retry (PRD 3b) covered for it',
      ),
      // The founder-facing promise from *What "reliable" means* is 10 s, and that is the
      // expectation to design to — but it cannot be the pass/fail line, because the receiver
      // boot alone has been observed at 10.59 s and it is the television's time, not ours.
      // 15 s is the project's existing notion of "we have waited too long" (it is the
      // unreachable-device budget), and with the worst observed boot it still fails if our
      // own share exceeds ~4.4 s. So a genuine regression is caught and a slow evening on a
      // Chromecast is not called a defect.
      assertion(
        `${label}CastToPictureMs`,
        'lte',
        15_000,
        playingMs,
        'ms',
        `what the founder actually waits, and the only cast-speed promise: the PRD expects 10 s, graded at 15 s because up to 10.59 s of it can be the television booting its own receiver. A cast that never produces a picture at all still fails ${label}StateSequence within ${String(SELFTEST.stateWaitMs / 1000)} s.`,
      ),
      assertion(
        `${label}StateSequence`,
        'eq',
        'reached playing',
        playingMs === null ? states : 'reached playing',
        'states',
        'the cast reached Playing at all — this is what fails if a picture never arrives',
      ),
    ],
  };
}

async function stopAndRelease(context: Context, label: string): Promise<Assertion[]> {
  const start = context.mono();
  context.engine.dispatch({ type: 'cast.stop' });

  // Criterion 4b is about the **TV**, not about our own screen: the app reaches `stopped`
  // synchronously inside the reducer, so timing that measures a function call and nothing
  // else. The device-side evidence is a receiver status reporting no running application —
  // the TV is back on its own home screen and another app could take it. Note the media
  // namespace is no help here: a receiver answers STOP with an *empty* MEDIA_STATUS.
  const released = (): boolean =>
    context.samples('session.receiver_status', start).some((r) => r['appId'] === null);
  try {
    await context.waitFor('the device to report it was released', 10_000, released);
  } catch {
    // Null measurement below; the assertion fails rather than the run throwing.
  }
  const evidence = context
    .samples('session.receiver_status', start)
    .find((r) => r['appId'] === null);

  // Where the device says it stopped — but only if the engine believed it.
  //
  // The founder's TV answers a stop at 598 s with `currentTime: 0`. The engine rejects
  // that (stopping cannot rewind the playhead) and keeps its own figure, which was right
  // to within 0.724 s. The measurement then adopted the very 0 the engine had just thrown
  // out and reported a 598-second error against a ≤1 s target — grading the product
  // against a number we had already decided was a lie. So this follows the engine's own
  // decision, taken from the same log line: `acceptedSec` when it believed the device,
  // and otherwise the last position reported while playing, carried forward by the time
  // that elapsed before the stop — which is where the device must have got to.
  const idleSample = context
    .samples('position.sample', start)
    .find((r) => r['playerState'] === 'IDLE');
  const acceptedSec =
    idleSample !== undefined && typeof idleSample['acceptedSec'] === 'number'
      ? Number(idleSample['acceptedSec'])
      : null;
  // What the *engine* held to be true at the instant the device went idle. It is on the
  // same log line, and it is the engine's own belief rather than anything this scenario
  // re-derives — which is the whole point of preferring it.
  const knownSec =
    idleSample !== undefined && typeof idleSample['knownSec'] === 'number'
      ? Number(idleSample['knownSec'])
      : null;

  const lastPlayingSample = [...context.samples('position.sample')]
    .reverse()
    .find((r) => r['playerState'] === 'PLAYING' && typeof r['deviceSec'] === 'number');
  const carriedForwardSec =
    lastPlayingSample === undefined
      ? null
      : Number(lastPlayingSample['deviceSec']) +
        Math.max(0, start - Number(lastPlayingSample['monoMs'])) / 1000;

  // Three references, in order of how much they know — and the middle one is new.
  //
  // The founder's TV answers a stop at 1560 s with `currentTime: 0`; the engine rejects
  // that (stopping cannot rewind the playhead) and keeps its own figure. This measurement
  // used to fall straight through to `carriedForwardSec`, which advances the *last PLAYING
  // sample* by the elapsed time — an assumption that the playhead only ever moves forward
  // at 1× and one that was true right up until seeking existed. In the `seek` scenario the
  // last PLAYING sample was ~2700 s, the film was then seeked back to 1560 and paused, and
  // this reported an error of 1142.986 s against a product that was exactly right.
  //
  // `knownSec` is the engine saying where it believed the film was, on the same line where
  // it recorded rejecting the device. Trusting it turns that 1142.986 into 0.
  const reference = acceptedSec ?? knownSec ?? carriedForwardSec;
  const referenceNote =
    acceptedSec !== null
      ? 'measured against the position the device reported when it stopped'
      : knownSec !== null
        ? "measured against the engine's own position when the device went idle — the device's final report was rejected as untrustworthy, or it sent none"
        : 'measured against the last position reported while playing, carried forward to the stop — the device never went idle at all';
  const snapshot = context.snapshot();

  return [
    assertion(
      `${label}StopToDeviceReleasedMs`,
      'lte',
      2_000,
      evidence === undefined ? null : Math.round(Number(evidence['monoMs']) - start),
      'ms',
      'PRD 4b: the device reports no app running — the TV is back on its own home screen',
    ),
    assertion(
      `${label}StoppedPositionErrorSec`,
      'lte',
      1,
      reference === null
        ? null
        : Math.round(Math.abs(snapshot.session.positionSec - reference) * 1000) / 1000,
      's',
      `PRD 4b: Stopped shows the position it stopped at — ${referenceNote}`,
    ),
    assertion(
      `${label}FileStillSelectedAfterStop`,
      'eq',
      'yes',
      snapshot.file === null ? 'no' : 'yes',
      'bool',
      'PRD 2c: the same file is still selected',
    ),
  ];
}

// --- Scenarios ---------------------------------------------------------------

async function scenarioDiscovery(context: Context): Promise<Assertion[]> {
  // Everything this scenario measures happened during the preamble, before it was
  // called: discovery starts with the engine and nothing pressed a button.
  const found = context.samples('discovery.device_found');
  const lastNewAtMono = found.reduce((latest, record) => Math.max(latest, record.mono), 0);
  const rescans = context.samples('discovery.rescan').length;

  return [
    assertion(
      'firstDeviceMs',
      'lte',
      3_000,
      context.firstDeviceAtMono - context.startedAtMono,
      'ms',
      'PRD: app launch → first device listed',
    ),
    assertion(
      'listCompleteMs',
      'lte',
      5_000,
      Math.round(lastNewAtMono - context.startedAtMono),
      'ms',
      'PRD: app launch → device list complete (last new device seen)',
    ),
    assertion(
      'namedDeviceFoundMs',
      'lte',
      SELFTEST.deviceWaitMs,
      context.deviceFoundAtMono - context.startedAtMono,
      'ms',
      `the device named "${context.deviceName}" appeared by its friendly name`,
    ),
    assertion(
      'manualRescans',
      'eq',
      0,
      rescans,
      'presses',
      'PRD 1a: no button was pressed to start the search',
    ),
  ];
}

async function scenarioCast(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (cast.ok) {
    assertions.push(
      assertion(
        'reportedDurationSec',
        'gte',
        1,
        Math.round(context.snapshot().session.durationSec * 100) / 100,
        's',
        'the device reported a duration for the media it is playing',
      ),
    );
  }
  if (cast.ok) {
    assertions.push(...(await stopAndRelease(context, 'first')));
  } else {
    // Nothing ever played, so there are no stop timings to measure — waiting for them
    // would only add null assertions and half a minute to an already-failed run. The
    // device is released by the engine's own failure path and again by `shutdown()`.
    context.engine.dispatch({ type: 'cast.stop' });
  }
  return assertions;
}

async function scenarioTransport(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return assertions;

  // Let it actually play, so a pause has somewhere to come from.
  await context.sleep(3_000);

  // Pause. The number that matters is when the *device* said PAUSED, never when our own
  // optimistic paint did — that would measure nothing but our own confidence.
  const pauseSentAt = context.mono();
  context.engine.dispatch({ type: 'playback.pause' });
  try {
    await context.waitFor('the device to confirm PAUSED', 10_000, () =>
      context.samples('position.sample', pauseSentAt).some((r) => r['playerState'] === 'PAUSED'),
    );
  } catch {
    // Falls through to a null measurement below.
  }
  const pausedSample = context
    .samples('position.sample', pauseSentAt)
    .find((r) => r['playerState'] === 'PAUSED');
  const pauseLatencyMs =
    pausedSample === undefined ? null : Math.round(Number(pausedSample['monoMs']) - pauseSentAt);
  const pausedAtSec = pausedSample === undefined ? null : Number(pausedSample['deviceSec']);
  assertions.push(
    assertion(
      'pauseLatencyMs',
      'lte',
      500,
      pauseLatencyMs,
      'ms',
      'PRD 4a: device paused and shown within 500 ms',
    ),
    assertion('appShowsPaused', 'eq', 'paused', context.snapshot().session.state, 'state'),
  );

  // Frozen readout while paused (5c).
  const frozenBefore = context.snapshot().session.positionSec;
  await context.sleep(3_000);
  const frozenAfter = context.snapshot().session.positionSec;
  assertions.push(
    assertion(
      'pausedReadoutDriftSec',
      'lte',
      1,
      Math.round(Math.abs(frozenAfter - frozenBefore) * 1000) / 1000,
      's',
      'PRD 5c: paused readout is frozen',
    ),
  );

  // Resume, and check it came back where it stopped.
  const playSentAt = context.mono();
  context.engine.dispatch({ type: 'playback.play' });
  try {
    await context.waitFor('the device to confirm PLAYING', 10_000, () =>
      context.samples('position.sample', playSentAt).some((r) => r['playerState'] === 'PLAYING'),
    );
  } catch {
    // Falls through to a null measurement below.
  }
  const playingSample = context
    .samples('position.sample', playSentAt)
    .find((r) => r['playerState'] === 'PLAYING');
  assertions.push(
    assertion(
      'resumeLatencyMs',
      'lte',
      1_000,
      playingSample === undefined ? null : Math.round(Number(playingSample['monoMs']) - playSentAt),
      'ms',
      'PRD 4a: play resumes within 1 s',
    ),
    assertion(
      'resumePositionErrorSec',
      'lte',
      1,
      playingSample === undefined || pausedAtSec === null
        ? null
        : Math.round(Math.abs(Number(playingSample['deviceSec']) - pausedAtSec) * 1000) / 1000,
      's',
      'PRD 4a: play resumes from the exact paused position',
    ),
  );

  assertions.push(...(await stopAndRelease(context, 'first')));

  // PRD 2c: casting the same file again is one click — and it is also the proof that
  // Stop really released the device, because a device we still held could not be
  // launched into a second time. Every assertion from here carries the `second` label:
  // a verdict with the same assertion name twice is unreadable as evidence.
  await context.sleep(1_000);
  const again = await castToPicture(context, 'second');
  assertions.push(...again.assertions);
  if (again.ok) assertions.push(...(await stopAndRelease(context, 'second')));
  return assertions;
}

async function scenarioPosition(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return assertions;

  // **A film shorter than the watch window cannot grade this scenario, and saying so is
  // exit 2, not exit 1.**
  //
  // This scenario watches for a fixed wall-clock window and then stops the film, and its
  // sample-count target is derived from that same window. A film that ends first fails
  // three assertions at once — the sample count, the stop, and the stopped position — and
  // every one of them reads as a broken promise about the product.
  //
  // Measured on 2026-09-04 on the `Chromecast Ultra`: a 36-second clip scored **76 samples
  // against 480**, `firstStopToDeviceReleasedMs` came back **null** and
  // `firstStoppedPositionErrorSec` **2.507 s**, because the film reached its end before
  // the stop was ever issued — *"the device never went idle at all"*, as the note says.
  // Three red lines, one cause, and the cause was the file.
  if (context.snapshot().session.durationSec < positionNeedsSec(context.positionDurationMs))
    throw new SelftestAbort(
      `the position scenario watches for ${String(Math.round(context.positionDurationMs / 1000))} s ` +
        `and then stops the film, so it needs a file of at least ` +
        `${String(Math.round(positionNeedsSec(context.positionDurationMs) / 60))} minutes; this one is ` +
        `${String(Math.round(context.snapshot().session.durationSec / 60))}`,
    );

  const startedAt = context.mono();
  const deadline = startedAt + context.positionDurationMs;
  const displayErrors: number[] = [];

  while (context.mono() < deadline) {
    await context.sleep(
      Math.min(SELFTEST.positionSampleMs, Math.max(0, deadline - context.mono())),
    );
    const state = context.snapshot().session.state;
    if (state !== 'playing' && state !== 'buffering') break;
  }

  const samples = context
    .samples('position.sample', startedAt)
    .filter((r) => r['playerState'] === 'PLAYING');
  for (const sample of samples) {
    const divergence = sample['divergenceSec'];
    if (typeof divergence === 'number') displayErrors.push(divergence);
  }

  // Gaps between consecutive device statuses, plus the wait for the very first one, so a
  // run that produced too few samples to compare still measures *something* honest rather
  // than reporting null.
  const gaps: number[] = [];
  const firstSampleMono = samples[0] === undefined ? null : Number(samples[0]['monoMs']);
  if (firstSampleMono !== null) gaps.push(firstSampleMono - startedAt);
  for (let index = 1; index < samples.length; index += 1) {
    gaps.push(Number(samples[index]?.['monoMs']) - Number(samples[index - 1]?.['monoMs']));
  }

  const half = Math.floor(displayErrors.length / 2);
  const mean = (values: number[]): number | null =>
    values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
  const firstHalfMean = mean(displayErrors.slice(0, half));
  const secondHalfMean = mean(displayErrors.slice(half));

  assertions.push(
    assertion(
      'positionSamples',
      'gte',
      // One per device status, which arrive at the re-anchor rate — about one a second,
      // not one per 10-second sampling tick. Targeting the tick rate meant nine in ten
      // device statuses could go missing and this would still pass.
      Math.max(1, Math.floor((context.positionDurationMs / TIMING.statusReanchorMs) * 0.8)),
      samples.length,
      'samples',
      'the device kept reporting its position throughout, at about 1 Hz',
    ),
    assertion(
      'maxDivergenceSec',
      'lte',
      1,
      displayErrors.length === 0 ? null : Math.round(Math.max(...displayErrors) * 1000) / 1000,
      's',
      'PRD 5a: the displayed position is within 1 s of the device at every sample',
    ),
    assertion(
      'maxReanchorGapMs',
      'lte',
      TIMING.statusReanchorMs * 2,
      gaps.length === 0 ? null : Math.round(Math.max(...gaps)),
      'ms',
      'the display is re-anchored to device truth at least this often',
    ),
  );

  // A trend needs enough samples to be a trend. Below that this is noise dressed as a
  // measurement, so it is left out of the verdict rather than reported as a pass — the
  // PRD's 5b run (`--duration 10m`, the default) always has hundreds.
  if (
    displayErrors.length >= TREND_MINIMUM_SAMPLES &&
    firstHalfMean !== null &&
    secondHalfMean !== null
  ) {
    assertions.push(
      assertion(
        'divergenceTrendSec',
        'lte',
        0.1,
        Math.round((secondHalfMean - firstHalfMean) * 1000) / 1000,
        's',
        'PRD 5b: accuracy late in the file is as good as early — no upward trend',
      ),
    );
  }

  assertions.push(...(await stopAndRelease(context, 'first')));
  return assertions;
}

// --- M2 scenarios ------------------------------------------------------------

/** Seconds of travel a long seek covers. 20 minutes, per the PRD's assumption 4. */
const LONG_SEEK_SEC = 1_200;

/** How far into a film the M2 scenarios start working, so a jump has room either side. */
const WORKING_POSITION_SEC = 1_500;

/**
 * Where the device says it is, from its own status arrivals — never from our display.
 *
 * The whole point of the position hold (6e) is that our readout leads the device through a
 * seek, so grading a seek against our own screen would measure nothing but our confidence.
 */
function lastDeviceSec(context: Context, afterMono: number): number | null {
  const sample = [...context.samples('position.sample', afterMono)]
    .reverse()
    .find((record) => typeof record['deviceSec'] === 'number' && record['heldForSeek'] !== true);
  return sample === undefined ? null : Number(sample['deviceSec']);
}

/** Waits for the device to actually report a position near `targetSec`. */
async function waitForDeviceAt(
  context: Context,
  targetSec: number,
  toleranceSec: number,
  timeoutMs: number,
): Promise<number | null> {
  const start = context.mono();
  try {
    await context.waitFor(
      `the device to report ${String(Math.round(targetSec))} s`,
      timeoutMs,
      () => {
        const at = lastDeviceSec(context, start);
        return at !== null && Math.abs(at - targetSec) <= toleranceSec;
      },
    );
  } catch {
    return null;
  }
  return context.mono() - start;
}

/**
 * Waits for a log record to exist before a measurement is read out of it.
 *
 * The third lying instrument of 2026-08-17 was `finishedReleaseMs`, which read the
 * evidence 85 ms before it arrived and reported `null` for a television that was well
 * inside target. This is the same mistake in general form: an intent is dispatched and
 * the line it produces is looked for in the same tick. Reading a log the engine has not
 * written yet measures nothing and grades it anyway.
 */
async function waitForSample(
  context: Context,
  event: string,
  afterMono: number,
  timeoutMs: number,
): Promise<LogRecord | null> {
  const deadline = context.mono() + timeoutMs;
  for (;;) {
    const found = context.samples(event, afterMono)[0];
    if (found !== undefined) return found;
    if (context.mono() >= deadline) return null;
    await context.sleep(50);
  }
}

/**
 * **11b's resume error, asked of a media session that still exists.**
 *
 * `divergenceSec` is how far our display had got from what the television said, at the
 * instant of a status. After an outage the honest instant is *"the first report once the
 * film is running again"* — but a repair issues a **new LOAD**, and statuses from the
 * session it supersedes are still arriving while it lands. Those describe a television that
 * is sitting starved at the position its buffer ran dry at, against a display that has
 * carried on: a divergence of several seconds that is real, transient, and **not what 11b
 * promises about**.
 *
 * Grading whichever of the two arrived first made this a coin flip. It failed CI on
 * 2026-08-30 at **6.203 s** against a 2 s target on a run whose every other number —
 * bytes flowing again, film playing again, resumed — matched a passing local run to within
 * 5 ms, and it has blocked PR #28 since 2026-08-28 and PR #35 since 2026-08-30.
 *
 * So the floor is the repair's own `cast.loaded` when a repair happened, and the rejoin
 * when none did. **The no-repair path — 11h's television that mends its own byte
 * connection — is graded exactly as strictly as before.**
 *
 * **What this number is worth after a repair, said plainly:** a repair resumes at
 * `tracker.positionAt(...)`, our own extrapolated position, so the television is loaded
 * *at* our display and the divergence that follows is near zero by construction. It is a
 * check that the repair landed where it aimed, not independent evidence that the film came
 * back in the right place. **`networkOutageFilmPlayingAgainMs` is the guard that has teeth
 * there** — it is read off the television and it is the number 11b was written about.
 */
async function resumeDivergenceSec(
  context: Context,
  rejoinedAtMono: number | null,
  outageStart: number,
  timeoutMs: number,
): Promise<number | null> {
  if (rejoinedAtMono === null) return null;
  const repaired = context.samples('media.path_repairing', outageStart)[0];
  let floorMono = rejoinedAtMono;
  if (repaired !== undefined) {
    const repairedAt = Number(repaired['monoMs'] ?? repaired.mono);
    const loaded = context.samples('cast.loaded', repairedAt)[0];
    // A repair still in flight leaves the floor at the rejoin rather than inventing one:
    // the wait below simply finds nothing and the measurement reports `null`, which is the
    // honest answer and is graded as a miss.
    if (loaded !== undefined)
      floorMono = Math.max(floorMono, Number(loaded['monoMs'] ?? loaded.mono));
  }
  const deadline = context.mono() + timeoutMs;
  for (;;) {
    const found = context
      .samples('position.sample', floorMono)
      .find((record) => typeof record['divergenceSec'] === 'number');
    if (found !== undefined) {
      return Math.round(Math.abs(Number(found['divergenceSec'])) * 1000) / 1000;
    }
    if (context.mono() >= deadline) return null;
    await context.sleep(100);
  }
}

/** Puts the film somewhere with room to jump in both directions. */
async function settleAtWorkingPosition(context: Context): Promise<boolean> {
  context.engine.dispatch({ type: 'playback.seek', positionSec: WORKING_POSITION_SEC });
  const reached = await waitForDeviceAt(
    context,
    WORKING_POSITION_SEC,
    TIMING.seekToleranceSec,
    SELFTEST.stateWaitMs,
  );
  return reached !== null;
}

/**
 * How long this television is given to be running again after one tap — 6a's promise.
 *
 * **Two numbers, because the promise turned out to be about two different televisions.**
 * On 2026-08-25 the Master bedroom set — a plain `chromecast` — was measured five times:
 * **2334, 457, 2688, 756 and 2278 ms** against a flat 2000 ms bound. Bimodal, breaching
 * three times in five, and identical on `main`, so it is neither noise nor a regression:
 * this device class is simply slower to resume than the sets the founder watches. `m2`'s
 * 107/107 was scored on the Home Theatre and Family room televisions, which meet 2 s; this
 * Chromecast had never run `m2` until that day, which is why nobody had seen it.
 *
 * **Founder decision, 2026-08-25**, asked as a product question and answered as one: *"2
 * seconds is nothing in the grand scheme of a movie."* So the promise says what is true of
 * each television instead of holding one to a figure it has never met.
 *
 * **It is still a bound that can fail.** 3000 ms sits ~310 ms above the worst of the five,
 * so a device that got materially slower still goes red — and every other profile keeps
 * 2000 ms, so a regression on the televisions that do meet it is caught as it always was.
 * Loosening this everywhere would have been the easy fix and would have blinded exactly the
 * devices the promise matters most on.
 *
 * Aborts rather than guesses, for `channelLimitFor`'s reason: grading a real television
 * against an invented bound is worse than not grading it.
 */
export function seekToPlayingBoundMs(
  devices: readonly { readonly id: string; readonly model: string | null }[],
  deviceId: string,
): number {
  const device = devices.find((candidate) => candidate.id === deviceId);
  if (device === undefined) {
    throw new SelftestAbort(
      `could not determine which television "${deviceId}" is, so 6a's seek bound would be a guess`,
    );
  }
  return modelProfile(device.model).id === 'chromecast' ? 3_000 : 2_000;
}

async function scenarioSeek(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return assertions;

  // Resolved before the first measurement so an unknown television aborts the run rather
  // than being graded against a guessed bound.
  const seekBoundMs = seekToPlayingBoundMs(context.snapshot().discovery.devices, context.deviceId);

  const durationSec = context.snapshot().session.durationSec;
  if (durationSec < LONG_SEEK_SEC * 2 + 120) {
    // Not a failure of the product: this file is too short for the criterion to mean
    // anything, and grading a 20-minute jump inside a 5-minute file would be theatre.
    throw new SelftestAbort(
      `the seek scenario needs a file of at least ${String(
        Math.round((LONG_SEEK_SEC * 2 + 120) / 60),
      )} minutes; this one is ${String(Math.round(durationSec / 60))}`,
    );
  }

  if (!(await settleAtWorkingPosition(context))) {
    assertions.push(
      assertion(
        'seekReachedWorkingPosition',
        'eq',
        'yes',
        'no',
        'bool',
        'the first seek never landed',
      ),
    );
    assertions.push(...(await stopAndRelease(context, 'first')));
    return assertions;
  }

  // --- 6a and 6d, forwards, at long range ---
  const forwardTarget = WORKING_POSITION_SEC + LONG_SEEK_SEC;
  const forwardStart = context.mono();
  context.engine.dispatch({ type: 'playback.seek', positionSec: forwardTarget });
  const forwardMs = await waitForDeviceAt(
    context,
    forwardTarget,
    TIMING.seekToleranceSec,
    SELFTEST.stateWaitMs,
  );
  let backToPlayingMs: number | null = null;
  try {
    backToPlayingMs =
      (await context.waitFor(
        'playback to be running again after the seek',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.state === 'playing' && snapshot.session.seek === null,
      )) - forwardStart;
  } catch {
    // Null measurement below.
  }
  const forwardErrorSec =
    forwardMs === null
      ? null
      : Math.round(Math.abs((lastDeviceSec(context, forwardStart) ?? 0) - forwardTarget) * 1000) /
        1000;

  assertions.push(
    assertion(
      'seekToPlayingMs',
      'lte',
      seekBoundMs,
      backToPlayingMs,
      'ms',
      `PRD 6a: running at the new point within ${String(seekBoundMs / 1000)} s of release. See seekToPlayingBoundMs — a plain Chromecast is graded at 3 s on the founder's 2026-08-25 decision, every other television at 2 s`,
    ),
    observation(
      'seekBoundAppliedMs',
      seekBoundMs,
      'ms',
      "which of 6a's two bounds this television was held to, so a reader can see the grade was not loosened for a set that meets 2 s",
    ),
    assertion(
      'seekPositionErrorS',
      'lte',
      TIMING.seekToleranceSec,
      forwardErrorSec,
      's',
      `PRD 6a: within 1 s of the requested position, measured on a ${String(
        LONG_SEEK_SEC / 60,
      )}-minute forward jump`,
    ),
  );

  // --- 6d, backwards, at the same range ---
  const backTarget = WORKING_POSITION_SEC;
  const backStart = context.mono();
  context.engine.dispatch({ type: 'playback.seek', positionSec: backTarget });
  const backMs = await waitForDeviceAt(
    context,
    backTarget,
    TIMING.seekToleranceSec,
    SELFTEST.stateWaitMs,
  );
  const backErrorSec =
    backMs === null
      ? null
      : Math.round(Math.abs((lastDeviceSec(context, backStart) ?? 0) - backTarget) * 1000) / 1000;
  assertions.push(
    assertion(
      'seekBackwardPositionErrorS',
      'lte',
      TIMING.seekToleranceSec,
      backErrorSec,
      's',
      'PRD 6d: backwards seeks land as reliably as forwards ones, at the same long range',
    ),
    observation(
      'seekBackwardMs',
      backMs === null ? null : Math.round(backMs),
      'ms',
      'how long the device took to serve a long backward jump — its business, and the media server’s, not a promise',
    ),
  );

  // --- 6d, a burst: only the final position is issued ---
  const burstStart = context.mono();
  const burstTargets = [
    WORKING_POSITION_SEC + 120,
    WORKING_POSITION_SEC + 240,
    WORKING_POSITION_SEC + 360,
    WORKING_POSITION_SEC + 480,
    WORKING_POSITION_SEC + 600,
  ];
  for (const target of burstTargets) {
    context.engine.dispatch({ type: 'playback.seek', positionSec: target });
  }
  const finalTarget = burstTargets[burstTargets.length - 1] ?? 0;
  const burstMs = await waitForDeviceAt(
    context,
    finalTarget,
    TIMING.seekToleranceSec,
    SELFTEST.stateWaitMs,
  );
  const burstCommands = context.samples('session.seek_issued', burstStart).length;
  assertions.push(
    assertion(
      'burstSeekCommandsSent',
      'eq',
      1,
      burstCommands,
      'commands',
      'PRD 6d: five seeks in rapid succession issue only the final requested position',
    ),
    assertion(
      'burstSeekPositionErrorS',
      'lte',
      TIMING.seekToleranceSec,
      burstMs === null
        ? null
        : Math.round(Math.abs((lastDeviceSec(context, burstStart) ?? 0) - finalTarget) * 1000) /
            1000,
      's',
      'PRD 6d: playback ends at the final requested position',
    ),
  );

  // --- 6c: a seek while paused does not start the film ---
  context.engine.dispatch({ type: 'playback.pause' });
  try {
    await context.waitForState('paused', SELFTEST.stateWaitMs);
  } catch {
    // The assertion below reports whatever state we are actually in.
  }
  const pausedSeekTarget = WORKING_POSITION_SEC + 60;
  context.engine.dispatch({ type: 'playback.seek', positionSec: pausedSeekTarget });
  const pausedSeekStart = context.mono();
  await waitForDeviceAt(context, pausedSeekTarget, TIMING.seekToleranceSec, SELFTEST.stateWaitMs);
  // Give any spurious PLAYING a chance to show itself before believing the state.
  await context.sleep(1_500);
  const pausedSample = [...context.samples('position.sample', pausedSeekStart)]
    .reverse()
    .find((record) => typeof record['playerState'] === 'string');
  assertions.push(
    assertion(
      'seekWhilePausedStaysPaused',
      'eq',
      'PAUSED',
      pausedSample === undefined ? null : String(pausedSample['playerState']),
      'state',
      'PRD 6c: the film does not start playing because it was nudged',
    ),
    assertion(
      'seekWhilePausedAppState',
      'eq',
      'paused',
      context.snapshot().session.state,
      'state',
      'PRD 6c: and the app agrees with it',
    ),
  );

  assertions.push(...(await stopAndRelease(context, 'first')));
  return assertions;
}

async function scenarioSkip(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return assertions;
  if (!(await settleAtWorkingPosition(context))) {
    assertions.push(
      assertion(
        'skipReachedWorkingPosition',
        'eq',
        'yes',
        'no',
        'bool',
        'the first seek never landed',
      ),
    );
    assertions.push(...(await stopAndRelease(context, 'first')));
    return assertions;
  }

  // --- 6f: one tap, exactly 30 s, state unchanged ---
  //
  // Split into two questions the criterion actually asks, because measuring "where the
  // device was before" against "where it is after" answers neither of them cleanly: the
  // film keeps playing between the two samples, so a full second of ordinary playback and
  // the 400 ms coalescing window both land inside a ±1 s tolerance around 30. It passed on
  // the founder's hardware; it would have passed just as happily on an engine that skipped
  // from a stale base, and it would have gone red on a slow poll.
  const oneStart = context.mono();
  // **Every state the session passes through from here, not just the one it happens to be
  // in when the device first reports the new position.** See the note on
  // `singleSkipStateUnchanged` below: that instant is the worst possible moment to read,
  // because a television publishes the position it jumped to and the fact that it is
  // buffering at it in the same message.
  const statesPassedThrough: SessionState[] = [context.snapshot().session.state];
  const unwatchStates = context.engine.subscribe((snapshot) => {
    if (statesPassedThrough[statesPassedThrough.length - 1] !== snapshot.session.state) {
      statesPassedThrough.push(snapshot.session.state);
    }
  });
  context.engine.dispatch({ type: 'playback.skip', deltaSec: SKIP.stepSeconds });
  // …and then **wait for the line before reading it**. This was read in the same tick as
  // the dispatch, so all three of this section's measurements came back null and the
  // scenario exited 1 against a product that had done exactly the right thing.
  const requested = await waitForSample(context, 'session.seek_requested', oneStart, 5_000);
  // What the engine asked for, against what the founder was looking at when they tapped.
  // `requestedSec - deltaSec` is the readout at the instant of the tap, which is exactly
  // the number 6f means by "the position moves by 30 seconds".
  const askedDeltaSec =
    requested === null ||
    typeof requested['targetSec'] !== 'number' ||
    typeof requested['requestedSec'] !== 'number' ||
    typeof requested['deltaSec'] !== 'number'
      ? null
      : Math.round(
          (Number(requested['targetSec']) -
            (Number(requested['requestedSec']) - Number(requested['deltaSec']))) *
            1000,
        ) / 1000;
  const oneTarget =
    requested === null || typeof requested['targetSec'] !== 'number'
      ? null
      : Number(requested['targetSec']);
  const oneMs =
    oneTarget === null
      ? null
      : await waitForDeviceAt(context, oneTarget, TIMING.seekToleranceSec, SELFTEST.stateWaitMs);
  const landedErrorSec =
    oneMs === null || oneTarget === null
      ? null
      : Math.round(Math.abs((lastDeviceSec(context, oneStart) ?? 0) - oneTarget) * 1000) / 1000;

  // **The film running again, which is what 6f means and is not the same instant as the
  // film arriving.** A jump means new bytes: SPIKE-2 watched a real television answer a
  // 25-minute seek with a fresh range request, and every television in the house reports
  // BUFFERING at the new position while it fetches them. So this waits for the picture to
  // be running before it reads the state — and if it never runs again, the state it reads
  // is whatever the tap left behind, which is red.
  let backToPlayingMs: number | null = null;
  try {
    backToPlayingMs =
      (await context.waitFor(
        'the film to be running again after one tap',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.state === 'playing',
      )) - oneStart;
  } catch {
    // Left null and reported as such; the state assertion below is what goes red.
  }
  unwatchStates();
  // 6f's "playing stays playing" and 6h's "the status line does not flip to Seeking per
  // tap", read over the whole window. `buffering` is the one other state a tap may
  // legitimately produce — 6k is written on the assumption that it does — and everything
  // else is the tap having changed what the film was doing.
  const forbidden = [...new Set(statesPassedThrough)].filter(
    (state) => state !== 'playing' && state !== 'buffering',
  );
  assertions.push(
    assertion(
      'singleSkipRequestedDeltaSec',
      'eq',
      SKIP.stepSeconds,
      askedDeltaSec,
      's',
      `PRD 6f: one tap asks for exactly ${String(SKIP.stepSeconds)} s on from what the founder was looking at`,
    ),
    assertion(
      'singleSkipLandedErrorS',
      'lte',
      TIMING.seekToleranceSec,
      landedErrorSec,
      's',
      'PRD 6f: and the device really went there — its own report against the position we asked for',
    ),
    // **6f, measured over the window rather than at an instant.**
    //
    // This read `session.state` in the tick `waitForDeviceAt` returned — the tick the
    // device first reported the new position — and a receiver reports the new position and
    // `BUFFERING` together, because it has to fetch the region it jumped to. So the old
    // form was a race between two facts that arrive in the same message. It won that race
    // on the Family room and Home Theatre sets, which are the only two televisions `m2` had
    // ever run against; the Master bedroom Chromecast lost it three times out of three on
    // 2026-08-25, on `main` (D1, no M3b) as well as on `feat/m3b-head-start`. Nothing in
    // the product had changed: those same three runs measured that set taking 2.33 s,
    // 0.46 s and 2.69 s to come back to PLAYING after a drag, against two televisions that
    // had never made it wait.
    //
    // **What is given up:** the claim that a single tap never even momentarily shows
    // *Buffering*. That claim was never in 6f, it is contradicted by 6k — which is written
    // about the app *being* Buffering with the skip buttons still live — and 6a spends a
    // whole criterion allowing a drag two seconds to get the picture back.
    //
    // **What is still forbidden**, and what a tap that broke 6f would still be caught by:
    // a tap that pauses the film, stops it, ends it, drops it back to idle, connecting or
    // loading, or flips the status line to *Seeking* (6h) is a state in `forbidden` and is
    // red; and a
    // tap that leaves the film stuck buffering never reaches `playing`, so the settled
    // state is not `playing` and that is red too. **How fast** it comes back is 6a's
    // promise and is graded in `seek` as `seekToPlayingMs`; it is deliberately not
    // restated here as a second threshold to argue about.
    assertion(
      'singleSkipStateUnchanged',
      'eq',
      'playing',
      context.snapshot().session.state,
      'state',
      'PRD 6f: playing stays playing — the state the film settled at after one tap, read once the picture is running again rather than in the tick the device first reported the new position',
    ),
    assertion(
      'singleSkipNeverStoppedPlaying',
      'eq',
      'none',
      forbidden.length === 0 ? 'none' : forbidden.join(' '),
      'states',
      'PRD 6f/6h: one tap may not pause the film, stop it, end it or flip the status line to Seeking. Every state the session passed through between the tap and the picture running again, not only the one it settled at',
    ),
    observation(
      'singleSkipStatesPassedThrough',
      statesPassedThrough.join(' → '),
      'states',
      'the whole route one tap took. A television that fetches the region it jumped to shows `playing → buffering → playing`; anything else is worth reading before the verdict is believed',
    ),
    observation(
      'singleSkipBackToPlayingMs',
      backToPlayingMs === null ? null : Math.round(backToPlayingMs),
      'ms',
      'how long this television took to be running again after one tap. Reported, not graded: 6a is where the 2 s promise lives and `seek.seekToPlayingMs` is where it is asserted. This number is here so two televisions can be compared without loosening anything',
    ),
  );

  // --- 6g: four taps inside the window are one command ---
  await context.sleep(1_500);
  const burstStart = context.mono();
  const fromSec = lastDeviceSec(context, 0) ?? 0;
  for (let tap = 0; tap < 4; tap += 1) {
    context.engine.dispatch({ type: 'playback.skip', deltaSec: SKIP.stepSeconds });
    await context.sleep(Math.round(TIMING.seekSettleMs / 4));
  }
  // **The command is sent 400 ms after the last tap — so it cannot be counted before
  // then.** This counted immediately after the final tap, which is 400 ms *early* by
  // construction: `seekCommandsSent` measured 0 against a target of 1, and the two
  // assertions that read the issued target measured null. Three red lines, on the
  // criterion the whole coalescing rule exists for, from a product that sent exactly the
  // one command it promised. So: wait for the command, then keep watching for as long
  // again, because "exactly one" is a claim about a window and not about an instant.
  await waitForSample(
    context,
    'session.seek_issued',
    burstStart,
    TIMING.seekSettleMs + SELFTEST.stateWaitMs,
  );
  await context.sleep(TIMING.seekSettleMs * 2);
  const issued = context.samples('session.seek_issued', burstStart);
  const commands = issued.length;
  // Where the founder's readout was when the *first* tap landed — the engine's own number
  // for it, off the same line the single-tap assertion above reads. Subtracting a device
  // position sampled before the taps instead made the travel 120.4 s against a target of
  // exactly 120: four hundred milliseconds of ordinary playback, graded as a skip that
  // overshot.
  const firstOfBurst = context.samples('session.seek_requested', burstStart)[0];
  const tappedFromSec =
    firstOfBurst === undefined ||
    typeof firstOfBurst['requestedSec'] !== 'number' ||
    typeof firstOfBurst['deltaSec'] !== 'number'
      ? fromSec
      : Number(firstOfBurst['requestedSec']) - Number(firstOfBurst['deltaSec']);
  // The one command that went out, and the position it named. Grading against
  // `fromSec + 120` needed a 3-second fudge to absorb the film playing on while the taps
  // arrived; grading against what was actually asked for needs none, and it is the number
  // the criterion is about — "one jump, for the summed target".
  const summedTarget =
    issued[0] !== undefined && typeof issued[0]['targetSec'] === 'number'
      ? Number(issued[0]['targetSec'])
      : null;
  if (summedTarget !== null) {
    await waitForDeviceAt(context, summedTarget, TIMING.seekToleranceSec, SELFTEST.stateWaitMs);
  }
  assertions.push(
    assertion(
      'seekCommandsSent',
      'eq',
      1,
      commands,
      'commands',
      'PRD 6g: four taps are one two-minute jump and one round trip',
    ),
    assertion(
      'coalescedSkipRequestedTravelSec',
      'eq',
      SKIP.stepSeconds * 4,
      summedTarget === null ? null : Math.round((summedTarget - tappedFromSec) * 10) / 10,
      's',
      'PRD 6g: the one command asks for the summed jump — four taps, two minutes, measured from what the founder was looking at when the first tap landed',
    ),
    assertion(
      'coalescedSkipPositionErrorS',
      'lte',
      TIMING.seekToleranceSec,
      summedTarget === null
        ? null
        : Math.round(Math.abs((lastDeviceSec(context, burstStart) ?? 0) - summedTarget) * 1000) /
            1000,
      's',
      'PRD 6g: and the device lands on the position that command named',
    ),
  );

  // --- 6i: the clamps state the real distance moved ---
  context.engine.dispatch({ type: 'playback.seek', positionSec: 5 });
  await waitForDeviceAt(context, 5, TIMING.seekToleranceSec + 1, SELFTEST.stateWaitMs);
  context.engine.dispatch({ type: 'playback.skip', deltaSec: -SKIP.stepSeconds });
  const clampedStart = context.snapshot().session.seek?.clamped ?? null;
  await waitForDeviceAt(context, 0, TIMING.seekToleranceSec + 1, SELFTEST.stateWaitMs);
  assertions.push(
    assertion(
      'skipBeforeStartClamps',
      'eq',
      'start',
      clampedStart,
      'clamp',
      'PRD 6i: under 30 s in, Back 30s lands at 0:00 and says so — never a dead button',
    ),
    assertion(
      'skipBeforeStartLandedSec',
      'lte',
      TIMING.seekToleranceSec,
      Math.round(Math.abs(lastDeviceSec(context, 0) ?? 999) * 1000) / 1000,
      's',
      'PRD 6i: and the device really is at the start',
    ),
  );

  assertions.push(...(await stopAndRelease(context, 'first')));
  return assertions;
}

async function scenarioFinish(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return assertions;

  const durationSec = context.snapshot().session.durationSec;
  if (durationSec <= 30)
    throw new SelftestAbort('the finish scenario needs a file longer than 30 s');

  // The PRD calls for "a short file played to its end". Seeking to just before the end is
  // how a two-hour film becomes one — and it exercises the same ending, on the same device,
  // without asking anyone to sit through it. What it does *not* prove is a film that ran
  // its whole length, and nothing here claims otherwise.
  const runInSec = 8;
  context.engine.dispatch({ type: 'playback.seek', positionSec: durationSec - runInSec });
  const endStart = context.mono();
  let endedMs: number | null = null;
  try {
    endedMs =
      (await context.waitForState('ended', runInSec * 1_000 + SELFTEST.stateWaitMs)) - endStart;
  } catch {
    // Null measurement; the assertion below names the state we actually reached.
  }

  // Wait for the evidence before reading it. `stopAndRelease` has always done this; this
  // scenario computed the measurement the instant `ended` was reached and reported `null`
  // for a television that was back on its home screen **85 ms later**, well inside target.
  if (endedMs !== null) {
    try {
      await context.waitFor('the device to report it was released', 10_000, () =>
        context.samples('session.receiver_status', endStart).some((r) => r['appId'] === null),
      );
    } catch {
      // Still null below, and the assertion fails — which is the honest outcome for a TV
      // that really did not go back to its own home screen.
    }
  }
  const released = context
    .samples('session.receiver_status', endStart)
    .find((record) => record['appId'] === null);
  // From the *end of the film* to the TV reporting no app running — not from the seek, or
  // the eight seconds of playing out would be counted as a slow release.
  const releaseMs =
    released === undefined || endedMs === null
      ? null
      : Math.round(Number(released['monoMs']) - (endStart + endedMs));

  assertions.push(
    assertion(
      'reachedFinished',
      'eq',
      'ended',
      endedMs === null ? context.snapshot().session.state : 'ended',
      'state',
      'PRD 16a: a file that plays out reaches Finished, not Stopped',
    ),
    assertion(
      'finishedReleaseMs',
      'lte',
      2_000,
      releaseMs,
      'ms',
      'PRD 16a: the TV really is on its own home screen within 2 s of the end',
    ),
    assertion(
      'nothingPlayedNext',
      'eq',
      0,
      context.samples('session.loading', endStart).length,
      'loads',
      'PRD 16a: nothing plays next automatically',
    ),
    assertion(
      'finishedFileStillSelected',
      'eq',
      'yes',
      context.snapshot().file === null ? 'no' : 'yes',
      'bool',
      'PRD 16a: the same file is still selected, for Play again',
    ),
    observation(
      'finishedRunInSec',
      runInSec,
      's',
      'how much of the film was actually played out to reach the end — a seek got us there, not a full playthrough',
    ),
  );
  return assertions;
}

async function scenarioResume(context: Context): Promise<Assertion[]> {
  const assertions = await selectFileAndDevice(context);
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return assertions;
  if (!(await settleAtWorkingPosition(context))) {
    assertions.push(
      assertion(
        'resumeReachedWorkingPosition',
        'eq',
        'yes',
        'no',
        'bool',
        'the first seek never landed',
      ),
    );
    assertions.push(...(await stopAndRelease(context, 'first')));
    return assertions;
  }

  assertions.push(...(await stopAndRelease(context, 'first')));
  const savedSec = context.snapshot().session.resumePositionSec;

  // --- 16c: Resume loads *at* the position ---
  const resumeStart = context.mono();
  context.engine.dispatch({ type: 'cast.resume' });
  let resumeMs: number | null = null;
  try {
    resumeMs = (await context.waitForState('playing', SELFTEST.stateWaitMs)) - resumeStart;
  } catch {
    // Null measurement below.
  }

  // Every position the device reported **while playing** during the resume. If any of them
  // is near zero, the film played from the beginning first — which 16c rules out in as
  // many words.
  //
  // `playerState === 'PLAYING'` is the fix, and it is not a loosening. A freshly launched
  // receiver reports `IDLE dev=0` before anything is loaded and `BUFFERING dev=0` before
  // playback starts; neither is a playback position, and counting them made a resume that
  // landed dead on 1500.001 s report a minimum of 0 against a target of 1470. A film that
  // genuinely starts at 0:00 and jumps still fails this, because it plays from there.
  const reported = context
    .samples('position.sample', resumeStart)
    .filter(
      (record) => record['playerState'] === 'PLAYING' && typeof record['deviceSec'] === 'number',
    )
    .map((record) => Number(record['deviceSec']));
  const lowest = reported.length === 0 ? null : Math.min(...reported);
  const landedSec = lastDeviceSec(context, resumeStart);

  assertions.push(
    assertion(
      'resumePositionErrorS',
      'lte',
      TIMING.seekToleranceSec,
      landedSec === null ? null : Math.round(Math.abs(landedSec - savedSec) * 1000) / 1000,
      's',
      `PRD 16c: the film loads already at the saved position (${String(Math.round(savedSec))} s)`,
    ),
    assertion(
      'resumeNeverPlayedFromZero',
      'gte',
      savedSec - 30,
      lowest,
      's',
      'PRD 16c: the lowest position the device reported during the resume — it never plays from 0:00 first',
    ),
    assertion(
      'resumeSeeksIssued',
      'eq',
      0,
      context.samples('session.seek_issued', resumeStart).length,
      'commands',
      'PRD 16c: the position rides on the LOAD, so no seek was needed to get there',
    ),
    observation(
      'resumeToPictureMs',
      resumeMs,
      'ms',
      'what the founder waits for a Resume — dominated by the receiver boot, exactly as a fresh cast is',
    ),
  );

  assertions.push(...(await stopAndRelease(context, 'second')));
  return assertions;
}

/**
 * A transport that hands every frame straight through, and can be interfered with.
 *
 * Two interferences, both of which happen **on our side of the wire** and neither of which
 * touches the network:
 *
 *  - `sever()` destroys the live socket. The television does not notice and keeps playing —
 *    SPIKE-2 measured a position error of 0.003 s across a 15-second outage — which is
 *    exactly the condition 11a describes and nothing at all like a wifi drop.
 *  - `deafenHeartbeat(true)` swallows inbound `PONG`s, so our keep-alive runs out of
 *    patience against a device that is answering perfectly well. That is the only way
 *    11f's give-up path can be made to run on demand.
 *
 * It is **not** a fake receiver and it is not a parallel code path: the engine underneath
 * still speaks real TLS to a real device, so a verdict produced through it is still `tls`.
 */
interface SeverableTransport {
  readonly factory: TransportFactory;
  /** Destroys every live socket. Returns how many there were. */
  sever(): number;
  deafenHeartbeat(deaf: boolean): void;
  /**
   * **There is no route to the television at all**: live sockets die and new ones are
   * refused, until it is given back.
   *
   * The difference from `sever()` is the whole of `--outage network`. A severed socket is
   * reconnected within milliseconds, which is the one thing a real outage never allows —
   * and it is why every recovery this harness has ever produced succeeded on its first
   * attempt.
   */
  partition(on: boolean): number;
}

const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';

function createSeverableTransport(inner: TransportFactory): SeverableTransport {
  const live = new Set<CastTransport>();
  let deaf = false;
  let cut = false;

  return {
    factory: async (options, handlers) => {
      if (cut) throw new Error('EHOSTUNREACH: this PC has no route to the television');
      const transport = await inner(options, {
        onMessage: (message: CastMessage) => {
          // Recorded as delivered, then dropped: to the engine this is indistinguishable
          // from a television that has stopped answering its keep-alive.
          if (deaf && message.namespace === NS_HEARTBEAT) return;
          handlers.onMessage(message);
        },
        onClose: (reason) => handlers.onClose(reason),
      });
      live.add(transport);
      return {
        get localAddress() {
          return transport.localAddress;
        },
        get closed() {
          return transport.closed;
        },
        send: (message) => transport.send(message),
        close: () => {
          live.delete(transport);
          transport.close();
        },
      };
    },
    sever() {
      const count = live.size;
      for (const transport of live) transport.close();
      live.clear();
      return count;
    },
    deafenHeartbeat(next) {
      deaf = next;
    },
    partition(on) {
      cut = on;
      if (!on) return 0;
      const count = live.size;
      for (const transport of live) transport.close();
      live.clear();
      return count;
    },
  };
}

/**
 * Puts a film on the television and lets it settle, for the scenarios whose subject is
 * what happens *to* a running session rather than how it started.
 */
async function playing(context: Context, assertions: Assertion[]): Promise<boolean> {
  assertions.push(...(await selectFileAndDevice(context)));
  const cast = await castToPicture(context, 'first');
  assertions.push(...cast.assertions);
  if (!cast.ok) return false;
  // A few seconds of real playback, so there is a position to lose and a buffer to survive
  // on. A film interrupted in its first half-second proves nothing about an evening.
  await context.sleep(5_000);
  return true;
}

/**
 * 11a and 11f: the connection dies and the film does not.
 *
 * What this proves: the app notices, says "Reconnecting…" rather than anything alarming,
 * gets back in without the founder doing anything, and lands within a second of where the
 * television actually is. What it deliberately does **not** claim to prove is a real wifi
 * drop — that is human checklist items 1–3, and no headless run can stand in for it.
 */
async function scenarioRecover(context: Context): Promise<Assertion[]> {
  // `cable` is a different scenario wearing the same name: the interruption is a person
  // rather than this process, and nothing below could produce it. Dispatched here so the
  // founder still types the one command the PRD names (`--scenario recover`), and so the
  // refusal rules have exactly one scenario to guard.
  if (context.outage === 'cable') return await scenarioCableOutage(context);
  // D2's outage. Same reason as `cable`: the interruption is a different one, and none of
  // what follows could produce it.
  if (context.outage === 'network') return await scenarioNetworkOutage(context);

  const assertions: Assertion[] = [];
  if (!(await playing(context, assertions))) return assertions;

  const beforeSec = lastDeviceSec(context, 0) ?? 0;
  const outageStart = context.mono();

  if (context.outage === 'heartbeat') {
    context.deafenHeartbeat(true);
  } else if (context.sever() === 0) {
    throw new SelftestAbort('there was no live socket to sever — the run cannot mean anything');
  }

  /**
   * How long the app is allowed to take to *notice*, and why the two outages differ.
   *
   * A dead socket announces itself: the close arrives and recovery starts in the same
   * tick. A television that stops answering PINGs does not — the give-up needs two missed
   * PONGs, and the deafness can begin the instant after a PING was answered, so a whole
   * further interval passes before the first unanswered one goes out. The honest bound is
   * therefore three intervals, not two.
   *
   * This was graded at two intervals for both, which made the heartbeat case a coin toss:
   * it measured 14,950 ms against a 12,000 ms target here, and would have passed on any
   * run where the deafness happened to land just before a beat. A flapping assertion
   * teaches everyone to shrug at a red line, which is most of the way to no test at all.
   */
  const noticeBudgetMs =
    (context.outage === 'heartbeat'
      ? TIMING.pingIntervalMs * (TIMING.pingMissesBeforeDead + 1)
      : TIMING.pingIntervalMs * TIMING.pingMissesBeforeDead) + 2_000;

  // 11a: the founder is shown a status line and nothing else changes.
  let noticedMs: number | null = null;
  try {
    noticedMs =
      (await context.waitFor(
        'the app to start reconnecting',
        noticeBudgetMs + SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.flags.reconnecting,
      )) - outageStart;
  } catch {
    // Null measurement below.
  }
  const heldSnapshot = context.snapshot();
  // The heartbeat case has to stop being deaf once the give-up has run, or the *new*
  // connection would be starved in exactly the same way and never recover.
  if (context.outage === 'heartbeat') context.deafenHeartbeat(false);

  let backMs: number | null = null;
  try {
    backMs =
      (await context.waitFor(
        'playback to be running again with no recovery in progress',
        TIMING.reconnectBudgetMs + SELFTEST.stateWaitMs,
        (snapshot) =>
          !snapshot.session.flags.reconnecting &&
          (snapshot.session.state === 'playing' || snapshot.session.state === 'paused'),
      )) - outageStart;
  } catch {
    // Null measurement below.
  }

  // How far our display was from the device on the first status after we got back in.
  // This is 11a's "within 2 s of the position it dropped at", measured against the
  // television's own report rather than against our own confidence.
  const rejoinedAt = await waitForSample(
    context,
    'session.recovery_rejoined',
    outageStart,
    SELFTEST.stateWaitMs,
  );
  const rejoinedAtMono =
    rejoinedAt === null ? null : Number(rejoinedAt['monoMs'] ?? rejoinedAt.mono);
  // **Wait for the device's first report after rejoining before grading against it.**
  // Sampling is on a timer, so reading in the same tick as the reconnection measured
  // `null` about half the time — a flapping red line on a recovery that had worked.
  const resumeErrorSec = await resumeDivergenceSec(
    context,
    rejoinedAtMono,
    outageStart,
    SELFTEST.stateWaitMs,
  );

  const startedRecords = context.samples('session.recovery_started', outageStart);
  const cause = startedRecords[0] === undefined ? null : String(startedRecords[0]['cause']);
  /**
   * 11b's clock starts when the connection is known to be gone, not when it went deaf.
   *
   * "Within 10 s of the network returning" is a promise about getting back in. Measuring
   * it from the outage folds the *detection* time into it, and for `--outage heartbeat`
   * detection alone is up to 15 s — so the assertion was arithmetically unpassable there
   * however fast the reconnection was. `recoveryNoticedMs` above grades the detection, on
   * its own budget; this grades what happens afterwards.
   */
  const recoveryStartedMono =
    startedRecords[0] === undefined
      ? outageStart
      : Number(startedRecords[0]['monoMs'] ?? startedRecords[0].mono);
  const rejoinDelayMs =
    backMs === null ? null : Math.round(outageStart + backMs - recoveryStartedMono);

  assertions.push(
    assertion(
      'recoveryNoticedMs',
      'lte',
      noticeBudgetMs,
      noticedMs === null ? null : Math.round(noticedMs),
      'ms',
      context.outage === 'heartbeat'
        ? 'PRD 11f: missed PONGs declare the connection dead and recovery starts — the give-up path runs'
        : 'PRD 11a: a dead socket is noticed and reconnection begins',
    ),
    assertion(
      'recoveryGiveUpPathRan',
      'eq',
      'lost',
      cause,
      'cause',
      'PRD 11f: the connection was declared lost rather than a live session hanging on a socket that stopped answering',
    ),
    assertion(
      'recoveryShowedNoError',
      'eq',
      'no error',
      heldSnapshot.notice === null ? 'no error' : `said "${heldSnapshot.notice.message}"`,
      'check',
      'PRD 11a: the founder sees "Reconnecting…", not an error — nothing turns red and no dialog opens',
    ),
    assertion(
      'recoveryKeptTheFile',
      'eq',
      'yes',
      heldSnapshot.file === null ? 'no' : 'yes',
      'bool',
      'PRD 11a: the file, position and scrubber stay exactly where they were — only the status line changes',
    ),
    assertion(
      'recoveryResumedMs',
      'lte',
      10_000,
      rejoinDelayMs,
      'ms',
      'PRD 11b: playing again within 10 s of the connection being declared lost — nothing here takes a network away, so that declaration is this run’s "the network returned"',
    ),
    assertion(
      'resumePositionErrorS',
      'lte',
      2,
      resumeErrorSec,
      's',
      "PRD 11a: within 2 s of where the film actually is — our display against the device's own first report after rejoining",
    ),
    assertion(
      'recoveryFounderPressedNothing',
      'eq',
      0,
      context.samples('intent.received', outageStart).length,
      'presses',
      'PRD 11a: it reconnects without any founder action',
    ),
    observation(
      'recoveryPositionAtOutageSec',
      Math.round(beforeSec * 1000) / 1000,
      's',
      'where the device said it was when the connection died',
    ),
    observation(
      'recoveryOutageToPlayingMs',
      backMs === null ? null : Math.round(backMs),
      'ms',
      'the whole interruption end to end, detection included — the founder-visible number, reported and never graded',
    ),
    observation(
      'recoveryDeviceReachableAgainMs',
      backMs === null || noticedMs === null ? null : Math.round(backMs - noticedMs),
      'ms',
      'how long the *device* took to be usable again once we started trying — its business, measured and never graded',
    ),
  );

  assertions.push(...(await stopAndRelease(context, 'first')));
  return assertions;
}

/**
 * **`--outage network`: the film's own route goes away, and comes back** — defect D2.
 *
 * Every other automated outage in this file kills *our* connection to the television and
 * leaves this PC's media server reachable throughout, so the device's byte connection is
 * never broken. On 2026-08-27 the founder pulled the Ethernet cable and met the failure
 * that hides in the gap: the control channel rejoined in **243 ms**, and the television —
 * whose byte connection had been reset six seconds into the outage — **never asked this PC
 * for another byte**. It played out its buffer and starved. The app then rejoined and
 * dropped ~75 times in a minute, restarting the 30 s deadline every time, so it never told
 * the founder anything at all.
 *
 * So this scenario takes **both** halves of the route away and gives both back, and grades
 * the two things that were wrong:
 *
 *  1. **the film comes back**, not just our connection to it — measured as the television
 *     asking this PC for bytes again, which is the number that was zero in the house;
 *  2. **the recovery does not thrash and the deadline is not restarted** — counted, so
 *     fault 2 cannot come back silently.
 *
 * **It refuses to pass on a run that could not have failed.** If the television had no
 * byte connection to this PC when the route was cut, there was nothing to break: exit 2,
 * naming it. That is the rule this project has had to learn nine times.
 */
async function scenarioNetworkOutage(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  if (!(await playing(context, assertions))) return assertions;

  /**
   * **Wait until the television is actually fetching the film, and refuse the run if it
   * never does** — criterion 13h, and the reason this scenario exited 2 on three of four
   * hardware attempts.
   *
   * The cause is established rather than guessed, and it is in the founder's own log from
   * 2026-08-28. Playback reached `playing` at `05:25:13.883`; the set then made small setup
   * requests, including a **15 KB tail read** of the MP4 index; and the delivery that
   * matters — `bytes=3506176-`, **627,686,497 bytes**, held open for the evening — did not
   * open until `05:25:31.289`, **~18 s later**. The scenario cut the route at ~5.8 s,
   * squarely in that gap, so `media.blackout` counted `deliveries: 0` and there was nothing
   * to break.
   *
   * **The dwell is the half that makes it honest.** A setup request is a delivery too, and
   * it is over in milliseconds; one that has been open for a second is the film. And a run
   * where no such delivery ever appears **still exits 2** — that refusal is correct and it
   * is the whole reason this instrument can be trusted at all.
   */
  const readyAt = context.mono();
  let deliveryAfterMs: number | null = null;
  const deliveryDeadline = readyAt + SELFTEST.networkDeliveryWaitMs;
  while (context.mono() < deliveryDeadline) {
    const flight = context.engine.unsafeMediaDeliveries();
    if (flight.count > 0 && flight.oldestForMs >= SELFTEST.networkDeliveryDwellMs) {
      deliveryAfterMs = Math.round(context.mono() - readyAt);
      break;
    }
    await context.sleep(200);
  }
  if (deliveryAfterMs === null) {
    throw new SelftestAbort(
      'the television never opened a byte delivery this PC could take away: ' +
        `nothing was in flight for ${String(SELFTEST.networkDeliveryDwellMs)} ms in the ` +
        `${String(Math.round(SELFTEST.networkDeliveryWaitMs / 1000))} s after playback started, so ` +
        'cutting the route would have broken nothing and this run could not have produced ' +
        'defect D2 whatever the app did. A television fetching a progressive film holds one ' +
        'response open for the whole evening — if this keeps happening, the set is playing ' +
        'something other than this media server’s bytes.',
    );
  }

  const beforeSec = lastDeviceSec(context, 0) ?? 0;
  const episodeStart = context.mono();

  /** Every notice the founder could have seen, across the whole episode (11a). */
  const noticesSeen: string[] = [];
  let fileLost = false;
  /**
   * **Every session state the founder's screen passed through**, so *Stopped* cannot flash
   * past between two polls and go unrecorded. On 2026-08-28 the screen went to `stopped`
   * 101 ms after the repair LOAD and back to playing a second later; a snapshot read at the
   * end of the episode would have shown a film playing perfectly happily.
   */
  const statesSeen: string[] = [];
  const watching = context.engine.subscribe((snapshot) => {
    const message = snapshot.notice?.message ?? null;
    if (message !== null && !noticesSeen.includes(message)) noticesSeen.push(message);
    if (snapshot.file === null) fileLost = true;
    if (statesSeen.at(-1) !== snapshot.session.state) statesSeen.push(snapshot.session.state);
  });

  try {
    const outageStart = context.mono();
    const cut = context.cutTheRoute(true);

    // **The honesty gate.** No byte connection means the television was not fetching from
    // this PC — a film played entirely out of its own buffer, a device that had finished
    // the file — and there was nothing for this outage to break. A run that cannot produce
    // the condition it exists to test is a run that did not happen.
    if (cut.media === 0) {
      context.cutTheRoute(false);
      throw new SelftestAbort(
        'the television had no byte connection to this PC when the route was cut, so there was ' +
          'nothing to break: this run could not have produced defect D2 whatever the app did. ' +
          'A film that is being fetched from this PC holds at least one connection open — if ' +
          'this keeps happening, the device is playing something other than our media server’s bytes.',
      );
    }

    // 11a: the app notices and says "Reconnecting…", not an error.
    let noticedMs: number | null = null;
    try {
      noticedMs =
        (await context.waitFor(
          'the app to start reconnecting',
          TIMING.pingIntervalMs * TIMING.pingMissesBeforeDead + 5_000,
          (snapshot) => snapshot.session.flags.reconnecting,
        )) - outageStart;
    } catch {
      // Null measurement below.
    }
    const heldSnapshot = context.snapshot();

    // Held long enough that the reconnection cannot be a formality, and short enough that a
    // television with a healthy buffer is still playing when the route returns — which is
    // the case 11b is written about ("the network is away for ≤ 30 s").
    await context.sleep(SELFTEST.networkOutageHoldMs);

    const restoredAt = context.mono();
    context.cutTheRoute(false);

    /**
     * **The measurement the house made and this harness never could: did the television
     * come back for the film?**
     *
     * `media.first_request` is logged at `info` for every mount, once — the line SPIKE-3's
     * "0 fetches" lesson put there. A repair publishes a **new** mount, so a first request
     * logged after the route returned is the television fetching bytes from this PC again,
     * which is exactly the event that never happened on 2026-08-27.
     */
    let flowedAtMono: number | null = null;
    const flowDeadline = context.mono() + TIMING.reconnectBudgetMs;
    while (context.mono() < flowDeadline) {
      // **Either shape of the film coming back.** A repair publishes a *new* mount, so its
      // bytes arrive as a `media.first_request`. A television that mended its own byte
      // connection comes back to the mount it already had, which is `media.delivery_resumed`
      // — and 11h says that set must be left alone, so a scenario that could only see the
      // first would report *"the film never came back"* about a film that never left.
      const record =
        context.samples('media.first_request', restoredAt)[0] ??
        context.samples('media.delivery_resumed', restoredAt)[0];
      if (record !== undefined) {
        flowedAtMono = Number(record['monoMs'] ?? record.mono);
        break;
      }
      await context.sleep(100);
    }
    const fetchedAgainMs = flowedAtMono === null ? null : Math.round(flowedAtMono - restoredAt);

    /**
     * **11b's own number, and it is read off the television.**
     *
     * *Playing again within ten seconds of the network returning.* Two things have to be
     * true of the instant it names, and neither is enough alone: the bytes are flowing from
     * this PC again, **and** the set reports `PLAYING` at or after that. A device reports
     * `PLAYING` all the way through an outage while it empties its own buffer — on
     * 2026-08-27 it played on for 23 seconds after the cable came out — so a player state
     * on its own would pass on the defect itself.
     *
     * Measured from the route **returning**, never from our rejoin. The founder's ten
     * seconds start when their network comes back; on 2026-08-28 the rejoin was 171 ms in
     * and the film was 41.96 s away.
     */
    let playingAgainMs: number | null = null;
    if (flowedAtMono !== null) {
      const playingDeadline = context.mono() + TIMING.reconnectBudgetMs;
      while (context.mono() < playingDeadline) {
        const sample = context
          .samples('position.sample', flowedAtMono)
          .find((record) => record['playerState'] === 'PLAYING');
        if (sample !== undefined) {
          playingAgainMs = Math.round(Number(sample['monoMs'] ?? sample.mono) - restoredAt);
          break;
        }
        await context.sleep(100);
      }
    }

    let backMs: number | null = null;
    try {
      backMs =
        (await context.waitFor(
          'playback to be running again with no recovery in progress',
          TIMING.reconnectBudgetMs,
          (snapshot) =>
            !snapshot.session.flags.reconnecting &&
            (snapshot.session.state === 'playing' || snapshot.session.state === 'paused'),
        )) - restoredAt;
    } catch {
      // Null measurement below.
    }

    // Our display against the television's own first report after rejoining — 11b's
    // "within 2 s of the lost position", asked of the device rather than of our confidence.
    const rejoined = await waitForSample(
      context,
      'session.recovery_rejoined',
      outageStart,
      SELFTEST.stateWaitMs,
    );
    const rejoinedAtMono = rejoined === null ? null : Number(rejoined['monoMs'] ?? rejoined.mono);
    const resumeErrorSec = await resumeDivergenceSec(
      context,
      rejoinedAtMono,
      outageStart,
      SELFTEST.stateWaitMs,
    );

    /**
     * **Fault 2, counted.** Every `session.recovery_started` of this episode carries how
     * much of the run's deadline was left when it began. On 2026-08-27 every one of ~75
     * cycles carried the full 30,000 ms, because each attempt started its own; a run that
     * shares one deadline can only count down.
     */
    const started = context.samples('session.recovery_started', episodeStart);
    const remaining = started.map((record) => Number(record['deadlineInMs']));
    const restarted = remaining.some(
      (value, index) => index > 0 && !(value < Number(remaining[index - 1])),
    );
    const repairs = context.samples('media.path_repairing', outageStart).length;
    /**
     * **The repair's own LOAD, read as the television abandoning the film** — the defect
     * that voided the 2026-08-28 run, and the reason these two assertions exist.
     *
     * That run met every promise it was set: bytes flowed again 160 ms after the repair,
     * `cast.loaded` reported `PLAYING` a second later. It scored **0/18**, because 101 ms
     * after the repair LOAD the set reported `IDLE`/`INTERRUPTED` for the media session the
     * repair had just superseded, the session called that a refusal, and 13g's guard —
     * rightly — refused to count anything measured on a television that had quit. The guard
     * was right; what it was told was wrong.
     *
     * `withRefusalGuard` would catch a repeat of it, but only as a mystery. These two name
     * it: **no refusal is written across a repair, and the session never reaches an
     * over-state while the founder is watching an interruption.**
     */
    const refusals = context.samples(REFUSED_MID_PLAY, episodeStart);
    const overStates = statesSeen.filter((state) => ['stopped', 'idle', 'ended'].includes(state));
    const ignoredIdles = context.samples('session.idle_ignored_during_live_load', outageStart);

    assertions.push(
      assertion(
        'networkOutageBytesFlowedAgainMs',
        'lte',
        10_000,
        fetchedAgainMs,
        'ms',
        'PRD 11b/D2-1: the **television** asked this PC for the film again within 10 s of the route ' +
          'returning. This is the number that was zero for the whole minute after the cable went ' +
          'back in on 2026-08-27 — our own connection recovering is not the film coming back.',
      ),
      assertion(
        'networkOutageFilmPlayingAgainMs',
        'lte',
        10_000,
        playingAgainMs,
        'ms',
        'PRD 11b, the whole promise and the number that was missed: from **the network ' +
          'returning** to the film running again, ≤ 10 s. Read off the television — bytes ' +
          'flowing from this PC again, and the set reporting PLAYING at or after that — because ' +
          'a device plays on out of its own buffer through an outage and both our session state ' +
          'and its player state would pass on the defect. It measured **41.96 s** on the ' +
          '`AI PONT` on 2026-08-28, on a recovery that was otherwise perfect: the repair ' +
          'was told about the dead delivery 229 ms after it had stood down, and waited for the ' +
          'buffer to run dry instead.',
      ),
      assertion(
        'networkOutageResumedMs',
        'lte',
        10_000,
        backMs === null ? null : Math.round(backMs),
        'ms',
        'PRD 11b: playback is running again within 10 s of the route returning, with the founder ' +
          'doing nothing.',
      ),
      assertion(
        'networkOutageResumePositionErrorS',
        'lte',
        2,
        resumeErrorSec,
        's',
        "PRD 11b: within 2 s of the lost position — our display against the television's own first " +
          'report after rejoining.',
      ),
      assertion(
        'networkOutageRecoveryAttempts',
        'lte',
        5,
        started.length,
        'attempts',
        'D2-3: the app must not thrash. The founder’s log had ~75 rejoin-then-drop cycles in twenty ' +
          'seconds — 2.5 a second — because a rejoin that landed back in *Buffering* inherited a ' +
          'stopwatch already past 11e’s ten seconds. One attempt per ten seconds of unresolved ' +
          'buffer is the honest rate.',
      ),
      assertion(
        'networkOutageDeadlineNotRestarted',
        'eq',
        'not restarted',
        restarted ? 'restarted' : 'not restarted',
        'check',
        'D2-4: a run of failing recoveries shares **one** deadline, measured from the first failure. ' +
          'Every attempt after the first must show less of it left than the attempt before. This is ' +
          'the assertion that stops 11c becoming unreachable again; it can only fail when more than ' +
          'one attempt happened, and `networkOutageRecoveryAttempts` states how many did.',
      ),
      assertion(
        'networkOutageNoticedItWasAnInterruption',
        'lte',
        TIMING.pingIntervalMs * TIMING.pingMissesBeforeDead + 5_000,
        noticedMs === null ? null : Math.round(noticedMs),
        'ms',
        'PRD 11a: the route going away is noticed and reconnection begins.',
      ),
      assertion(
        'networkOutageShowedNoError',
        'eq',
        'no error',
        noticesSeen.length === 0 ? 'no error' : `said "${noticesSeen.join('" / "')}"`,
        'check',
        'PRD 11a/11b: nothing turns red, no dialog opens and the founder is never shown an error — ' +
          'judged across every snapshot of the episode, not the one at the end.',
      ),
      assertion(
        'networkOutageRepairIsNotARefusal',
        'eq',
        'no refusal',
        refusals.length === 0
          ? 'no refusal'
          : `wrote ${String(refusals.length)} × session.refused_mid_play (${refusals
              .map((record) => String(record['idleReason']))
              .join(', ')})`,
        'check',
        'PRD 13g / D2: the repair hands the television the film again with a LOAD, and a receiver ' +
          'answers a LOAD by ending the media session it is superseding — `IDLE`/`INTERRUPTED`. ' +
          'That is our own LOAD being acknowledged, not the set abandoning the film, and calling it ' +
          'a refusal voids the whole run through 13g’s guard (0/18 on 2026-08-28, on a repair that ' +
          'had worked). A genuine mid-play refusal must still be caught — it is what this line ' +
          'measures — so the session is deaf only while a LOAD of its own is in flight.',
      ),
      assertion(
        'networkOutageNeverSaidStopped',
        'eq',
        'never stopped',
        overStates.length === 0 ? 'never stopped' : `showed ${[...new Set(overStates)].join(', ')}`,
        'check',
        'PRD 11a: through an interruption only the status line changes. *Stopped* is not a status ' +
          'line — it is the end of the evening, and it flashed past mid-recovery in the house. Read ' +
          'from every snapshot pushed during the episode, because it was on screen for about a ' +
          'second and a snapshot taken at the end would have shown a film playing happily.',
      ),
      assertion(
        'networkOutageKeptTheFile',
        'eq',
        'held',
        fileLost || heldSnapshot.file === null ? 'lost the film' : 'held',
        'bool',
        'PRD 11a: the file, position and scrubber stay exactly where they were — only the status ' +
          'line changes.',
      ),
      assertion(
        'networkOutageFounderPressedNothing',
        'eq',
        0,
        context.samples('intent.received', episodeStart).length,
        'presses',
        'PRD 11b: it comes back without any founder action, across the whole episode.',
      ),
      observation(
        'networkOutageByteConnectionsCut',
        cut.media,
        'connections',
        'how many connections the television had to this PC’s media server when the route was taken ' +
          'away — zero would have been a run that could not fail, and this scenario exits 2 on it',
      ),
      observation(
        'networkOutageMediaPathRepaired',
        repairs,
        'repairs',
        'how many times the film had to be handed back to the television. **Zero is not a failure**: ' +
          'a receiver that goes back for the bytes by itself needs no repair, and reloading a film ' +
          'that was coming back anyway would be a stutter nobody asked for',
      ),
      observation(
        'networkOutageSupersededIdlesIgnored',
        ignoredIdles.length,
        'reports',
        'how many times the television answered a LOAD of ours by ending the media session it was ' +
          'superseding, and was correctly not believed to be quitting. **Zero is not a failure** — ' +
          'not every receiver announces it — but on the `AI PONT` it is 1 per repair, and a 0 here ' +
          'beside a repair means this set says nothing and `networkOutageRepairIsNotARefusal` is ' +
          'passing for free',
      ),
      observation(
        'networkOutageWaitedForDeliveryMs',
        deliveryAfterMs,
        'ms',
        'how long this run had to wait, after playback settled, before the television had a byte ' +
          'delivery open long enough to be the film rather than a setup request. **The route is ' +
          'not cut until it does**, and a run where it never does exits 2. **Zero is not a ' +
          'failure** — it means one was already in flight when the scenario looked. On the ' +
          '`AI PONT` on 2026-08-28 the real delivery (`bytes=3506176-`, 627 MB) did not open ' +
          'until ~18 s after playback started, and cutting on a timer at ~5.8 s broke nothing on ' +
          'three of four attempts',
      ),
      observation(
        'networkOutageHeldMs',
        SELFTEST.networkOutageHoldMs,
        'ms',
        'how long the route was away — deliberately inside 11b’s 30 s, so a television with a healthy ' +
          'buffer may still be playing when it returns',
      ),
      observation(
        'networkOutagePositionAtOutageSec',
        Math.round(beforeSec * 1000) / 1000,
        's',
        'where the device said it was when the route went away',
      ),
      observation(
        'networkOutageToPlayingMs',
        backMs === null ? null : Math.round(context.mono() - outageStart),
        'ms',
        'the whole interruption end to end, detection included — the founder-visible number, ' +
          'reported and never graded',
      ),
    );
  } finally {
    watching();
    // Whatever happened, the route goes back. A run that aborted holding the media server
    // shut would leave the founder's television unable to fetch anything at all.
    context.cutTheRoute(false);
  }

  assertions.push(...(await stopAndRelease(context, 'first')));
  return assertions;
}

// --- `--outage cable`: the one outage a person has to perform ----------------

interface NetworkChange {
  readonly monoMs: number;
  readonly up: boolean;
  readonly addresses: readonly string[];
  readonly allAddresses: readonly string[];
  readonly lost: readonly string[];
  readonly gained: readonly string[];
}

/**
 * What the *interface table* did, as opposed to what the app made of it.
 *
 * Every clock in the cable scenario is anchored to one of these rather than to our own
 * flags, and deliberately: "playback is running again within 10 s of the network
 * returning" is a promise measured against the world, and measuring it from the moment we
 * noticed the world would quietly grade us on our own reaction time.
 */
function networkChanges(context: Context, afterMono: number): NetworkChange[] {
  const strings = (value: unknown): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
  return context.samples('network.changed', afterMono).map((record) => ({
    monoMs: Number(record['monoMs'] ?? record.mono),
    up: record['up'] === true,
    addresses: strings(record['addresses']),
    allAddresses: strings(record['allAddresses']),
    lost: strings(record['lost']),
    gained: strings(record['gained']),
  }));
}

/** A block of founder-facing text, framed so it cannot be lost in the log noise. */
function block(lines: readonly string[]): string {
  const rule = '─'.repeat(74);
  return ['', rule, ...lines, rule].join('\n');
}

function seconds(ms: number): string {
  return `${String(Math.round(ms / 1000))} s`;
}

/**
 * Waits for something only the world can do, and says so out loud while it waits.
 *
 * Returns the monotonic instant the condition first held, or `null` if it never did.
 * Silence for two minutes is not an option: the founder is standing at a PC with a cable
 * in their hand and has no other way to tell a run that is watching from one that hung.
 */
async function waitForTheWorld(
  context: Context,
  what: string,
  timeoutMs: number,
  ready: () => boolean,
): Promise<number | null> {
  const startedAt = context.mono();
  const deadline = startedAt + timeoutMs;
  let speakAt = startedAt + context.human.progressEveryMs;
  for (;;) {
    if (ready()) return context.mono();
    const now = context.mono();
    if (now >= deadline) return null;
    if (now >= speakAt) {
      context.instruct(
        'progress',
        `  … waiting for ${what} — ${seconds(deadline - now)} left before this run gives up`,
      );
      speakAt = now + context.human.progressEveryMs;
    }
    await context.sleep(200);
  }
}

/**
 * 11b and 11d, the halves no automated outage can reach: **a real cable pull.**
 *
 * Every other outage this harness produces severs a connection cleanly and locally, so
 * the app learns instantly — `recoveryNoticedMs` measured **1 ms** on hardware, honestly.
 * A cable coming out of the back of a PC is nothing like that. Nothing closes. Things
 * simply stop answering, and the app has to work it out from the heartbeat and the
 * interface table. That is the path 11d describes and it has never met a real network.
 *
 * **The founder's physical action is the trigger.** There is no keypress to read and no
 * prompt to answer: the scenario prints what to do and then watches the interface table
 * for the world to change. If the world never changes, this is a run that could not
 * happen — exit 2, naming the intervention that did not arrive — never a failed promise.
 */
async function scenarioCableOutage(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  if (!(await playing(context, assertions))) return assertions;

  const beforeSec = lastDeviceSec(context, 0) ?? 0;
  const episodeStart = context.mono();

  /**
   * **The whole snapshot stream, not the end state.**
   *
   * 12b passed a hardware run this morning while flashing three wrong screens on the way,
   * because its selftest sampled only where things settled. An error the founder saw for
   * half a second is an error the founder saw, so every snapshot from before the cable
   * comes out until after the film is back is inspected, not the last one.
   */
  const noticesSeen: string[] = [];
  let devicesEmptied = false;
  let devicesDimmed = false;
  let fileLost = false;
  let sessionDropped = false;
  /**
   * Every state the session passed through while this PC was away.
   *
   * Purely diagnostic, and it exists because of the one thing about this scenario that is
   * out of everybody's hands: a television plays through a short outage out of its own
   * buffer (SPIKE-2 measured *zero* range requests across 15 s), but the cable is out for
   * longer than that here, and a device whose buffer runs dry will stall or give up
   * through no fault of ours. If that ever turns a promise red, this line says so at a
   * glance instead of costing an evening.
   */
  const statesWhileOffline = new Set<SessionState>();
  let helpOfferedTooEarly: boolean | null = null;

  const watching = context.engine.subscribe((snapshot) => {
    const message = snapshot.notice?.message ?? null;
    if (message !== null && !noticesSeen.includes(message)) noticesSeen.push(message);
    if (!snapshot.session.flags.networkDown) return;
    // 11d, only while this PC is the one that is away.
    if (helpOfferedTooEarly === null) helpOfferedTooEarly = snapshot.session.offlineHelp;
    if (snapshot.discovery.devices.length === 0) devicesEmptied = true;
    else if (snapshot.discovery.devices.every((device) => !device.available)) devicesDimmed = true;
    if (snapshot.file === null) fileLost = true;
    statesWhileOffline.add(snapshot.session.state);
    if (!holdsTheTelevision(snapshot.session.state)) sessionDropped = true;
  });

  try {
    // --- 1. Ask, and then watch. Nothing here reads a key. ---
    context.instruct(
      'unplug',
      block([
        '  YOUR TURN — go and unplug this PC’s network cable, now.',
        '',
        `  "${context.deviceName}" is playing at ${formatDuration(Math.round(beforeSec))}.`,
        '  Pull the Ethernet cable out of the back of this PC. That is the whole job.',
        '',
        '  There is nothing to press here and nothing to type. This run is watching this',
        '  PC’s own network and will carry on by itself the moment it sees it go.',
        '',
        `  It will wait up to ${seconds(context.human.waitMs)}. If nothing happens by then it stops and`,
        '  says the cable never came out — it will not pretend that it did.',
        '',
        '  If this PC has wifi as well as Ethernet, Windows may simply keep it online',
        '  through the wifi. That is not a fault and this run will tell you if it happens;',
        '  you would then disable the adapter in Windows instead of pulling the cable.',
      ]),
    );

    const askedAt = context.mono();

    /**
     * **The world's event, not ours.** The cable coming out is the interface table losing
     * an address; the app saying so is a separate thing that may lag it, and may — this is
     * the whole point of the scenario — not happen at all.
     *
     * Anchoring on our own flag would have conflated the two, and the way it would have
     * failed is not hypothetical: the defect fixed on 2026-08-18 left a PC with the cable
     * out looking perfectly online, because `vEthernet (WSL)` still had an address. A run
     * that waited only for the flag would have reported "nobody unplugged anything" about
     * a founder standing there holding the cable.
     */
    const changedAt = await waitForTheWorld(
      context,
      'this PC to lose its network',
      context.human.waitMs,
      () =>
        context.snapshot().session.flags.networkDown ||
        networkChanges(context, askedAt).some((change) => change.lost.length > 0),
    );

    /**
     * Where the film *actually* was when the cable came out.
     *
     * Read **here**, not at the top of the scenario. `beforeSec` is captured the moment
     * playback starts, which is right for the sentence the founder is shown ("playing at
     * 0:02" — true when they are asked) and wrong for the observation, which claims to say
     * where the television was when the cable came out. On the first hardware run the
     * founder took **18 s** to walk to the PC, so the observation reported **2.384 s** for a
     * film that was really ~21.8 s in. It is the gap between asking and acting, and it is
     * as long as the walk.
     *
     * Nothing was graded on it — it is an observation, and `cableResumePositionErrorS`
     * compares our display against the device's own report rather than against this. But
     * this is the fifth measurement this milestone to describe something other than what its
     * name claims, and the standing rule from `docs/STATUS.md` applies: prefer a value read
     * at the moment it describes over one carried forward from an earlier one.
     */
    const outageSec = changedAt === null ? beforeSec : (lastDeviceSec(context, 0) ?? beforeSec);

    if (changedAt === null) {
      // Exit 2: the intervention did not arrive. Which one, and what to do about it.
      const recoveries = context.samples('session.recovery_started', askedAt).length;
      if (recoveries > 0) {
        throw new SelftestAbort(
          'something interrupted the connection to the television, but this PC’s own network never ' +
            'changed — so whatever came out, it was not this PC’s network cable. That is what ' +
            '--outage socket already covers. The intervention this run needed did not arrive.',
        );
      }
      throw new SelftestAbort(
        `the network cable was never unplugged: this PC’s network did not change at all in the ` +
          `${seconds(context.human.waitMs)} after you were asked. This is the intervention that did not ` +
          'arrive, not a promise the app broke — nothing was proved either way.',
      );
    }

    /**
     * The address went. Did the app work out that it was *this PC*?
     *
     * Two detectors race on a silent outage — the 2 s interface poll and the keep-alive
     * giving up — so the grace covers the slower of them. What happens at the end of it is
     * the difference between a run that could not happen and a promise that was broken:
     *
     *  - **the film is still playing and nothing is reconnecting** → Windows failed over to
     *    another adapter and this PC never left the network. Nothing to grade; exit 2 with
     *    the instruction that actually helps, which is to disable the adapter.
     *  - **the app is reconnecting, or has given up** → the cable pull *did* happen and the
     *    app is blaming the television for it. That is 11d failing, and it is graded as
     *    such below rather than excused as a missed intervention.
     */
    const noticedAt = await waitForTheWorld(
      context,
      'the app to say that THIS PC has lost its network',
      context.human.noticeGraceMs,
      () => context.snapshot().session.flags.networkDown,
    );

    if (noticedAt === null) {
      const changes = networkChanges(context, askedAt);
      const lost = [...new Set(changes.flatMap((change) => change.lost))];
      const latest = changes.at(-1);
      const now = context.snapshot();
      const undisturbed =
        !now.session.flags.reconnecting &&
        (now.session.state === 'playing' || now.session.state === 'paused') &&
        context.samples('session.recovery_started', askedAt).length === 0;
      if (undisturbed) {
        throw new SelftestAbort(
          `this PC never went offline. Its addresses did change — ${lost.join(', ') || 'something went away'} — ` +
            `but ${(latest?.addresses ?? []).join(', ') || 'another adapter'} carried on and the film never ` +
            'faltered, so Windows kept this PC on the network through a second adapter (wifi, most likely) ' +
            'and the outage 11d is about never happened. Disable that adapter in Windows’ network settings, ' +
            'or turn the wifi off, and run this again. Nothing was proved and nothing is broken.',
        );
      }
      context.instruct(
        'note',
        block([
          '  Careful — this is worth reading.',
          '',
          '  This PC’s network address went away, and the connection to the television has',
          '  been disturbed, but CastGood has NOT said that this PC is the one with the',
          '  problem. That is the defect 11d exists to prevent, so this run is carrying on',
          '  and will grade it rather than excusing it. Leave the cable out; the run will',
          '  ask for it back as usual.',
        ]),
      );
    }

    const offlineAt = noticedAt ?? changedAt;
    const firstRecovery = context.samples('session.recovery_started', askedAt)[0] ?? null;
    const changesAtOutage = networkChanges(context, askedAt);
    const wentAway = [...new Set(changesAtOutage.flatMap((change) => change.lost))];
    const interfaceChangedAt = changesAtOutage[0]?.monoMs ?? null;
    const addressesWhileOffline = changesAtOutage.at(-1)?.allAddresses ?? [];

    context.instruct(
      'offline',
      block(
        [
          noticedAt === null
            ? `  Seen: this PC’s network address went away ${seconds(changedAt - askedAt)} after you were asked.`
            : `  Seen: this PC went offline ${seconds(offlineAt - askedAt)} after you were asked.`,
          wentAway.length > 0 ? `  The address that went away: ${wentAway.join(', ')}.` : null,
          '',
          `  LEAVE THE CABLE OUT for the next ${seconds(context.human.holdMs)}.`,
          '',
          '  Look at CastGood while you wait. It should say that THIS PC has lost its network',
          `  connection — not that "${context.deviceName}" is at fault, and not "Lost connection".`,
          '  The film’s place should still be on screen and the television should still be',
          '  listed, greyed rather than gone.',
          '',
          `  After 30 s a button offering Windows’ network settings should appear, and not`,
          '  before. This run is timing that too. Do not press anything.',
        ].filter((line): line is string => line !== null),
      ),
    );

    // --- 2. Hold the outage past the give-up deadline, on purpose. ---
    const holdUntil = offlineAt + context.human.holdMs;
    let speakAt = context.mono() + context.human.progressEveryMs;
    while (context.mono() < holdUntil) {
      // Only meaningful if the app ever said this PC was offline. If it never did, the
      // flag being false is the defect being graded, not the network coming back.
      if (noticedAt !== null && !context.snapshot().session.flags.networkDown) {
        throw new SelftestAbort(
          `this PC came back on to the network by itself after ${seconds(context.mono() - offlineAt)}, ` +
            'with the cable still out — Windows failed over to another adapter. The outage 11d is about ' +
            'never really happened, so there is nothing here to grade. Disable the other adapter (wifi, ' +
            'most likely) and run this again.',
        );
      }
      const now = context.mono();
      if (now >= speakAt) {
        context.instruct(
          'progress',
          `  … ${seconds(holdUntil - now)} to go — leave the cable out, press nothing`,
        );
        speakAt = now + context.human.progressEveryMs;
      }
      await context.sleep(200);
    }

    // One beat before reading the outcome. The give-up deadline is enforced on a timer
    // tick, so sampling "did it give up?" in the same instant the deadline passed measures
    // a race rather than a behaviour — and a race is exactly what a flaky red line is made
    // of. A second costs nothing next to an outage held for more than thirty.
    await context.sleep(TIMING.recoveryProbeMs);

    const offlineForMs = Math.round(context.mono() - offlineAt);
    const heldSnapshot = context.snapshot();
    const gaveUp = context.samples('session.connection_lost', offlineAt).length;
    const helpOffered = context.samples('session.offline_help_offered', offlineAt).length > 0;
    const pastDeadline = offlineForMs >= TIMING.reconnectBudgetMs;

    // --- 3. Ask for it back, and anchor 11b to the interface table. ---
    context.instruct(
      'replug',
      block([
        '  PLUG THE NETWORK CABLE BACK IN NOW.',
        '',
        '  Then stand back and press nothing at all. The film should come back by itself',
        '  within about ten seconds of this PC having an address again, and that is exactly',
        '  what is being timed. Touching the app would end the measurement, not help it.',
        '',
        `  Waiting up to ${seconds(context.human.waitMs)} for this PC’s address to return.`,
      ]),
    );

    const replugAskedAt = context.mono();
    const restored = (): NetworkChange | undefined =>
      networkChanges(context, replugAskedAt).find(
        (change) =>
          change.gained.length > 0 ||
          change.allAddresses.some((address) => !addressesWhileOffline.includes(address)),
      );
    const sawRestore = await waitForTheWorld(
      context,
      'this PC’s network address to come back',
      context.human.waitMs,
      () => restored() !== undefined || !context.snapshot().session.flags.networkDown,
    );

    const restoredChange = restored();
    if (sawRestore === null) {
      throw new SelftestAbort(
        `the network cable was never plugged back in: nothing came back to this PC’s interface table ` +
          `in the ${seconds(context.human.waitMs)} after you were asked. This is the intervention that ` +
          'did not arrive, not a promise the app broke. **Plug it back in**: the film is still on the ' +
          'television and this run cannot reach it to stop it until this PC is on the network again — ' +
          'if it is still playing a minute from now, stop it from the app or from the TV’s own remote.',
      );
    }
    // The world's own instant, not ours. If the address came back without the watcher
    // logging it — it should not, but a measurement that throws is worse than one that
    // degrades — fall back to when we saw the flag clear.
    const networkBackAt = restoredChange?.monoMs ?? sawRestore;

    context.instruct(
      'online',
      block([
        '  The network is back. Nothing more for you to do — press nothing.',
        '  The run is timing the film coming back, and will stop playback and hand the',
        '  television back when it has finished.',
      ]),
    );

    const backAt = await waitForTheWorld(
      context,
      'the film to be playing again with nothing left to recover',
      TIMING.reconnectBudgetMs + SELFTEST.stateWaitMs,
      () => {
        const snapshot = context.snapshot();
        return (
          !snapshot.session.flags.reconnecting &&
          !snapshot.session.flags.networkDown &&
          (snapshot.session.state === 'playing' || snapshot.session.state === 'paused')
        );
      },
    );
    const resumedMs = backAt === null ? null : Math.round(backAt - networkBackAt);

    // Our display against the television's own first report after rejoining — the same
    // measurement `recover` makes, for the same reason: 11a's "within 2 s" is about where
    // the film actually is, not about how confident we are.
    const rejoined = await waitForSample(
      context,
      'session.recovery_rejoined',
      offlineAt,
      SELFTEST.stateWaitMs,
    );
    const rejoinedAtMono = rejoined === null ? null : Number(rejoined['monoMs'] ?? rejoined.mono);
    const resumeErrorSec = await resumeDivergenceSec(
      context,
      rejoinedAtMono,
      offlineAt,
      SELFTEST.stateWaitMs,
    );

    const afterSec = lastDeviceSec(context, networkBackAt);
    const presses = context.samples('intent.received', episodeStart).length;

    assertions.push(
      // --- 11d: this PC, and it is this PC that gets named ---
      assertion(
        'cableBlamedThisPc',
        'eq',
        'this PC is offline',
        heldSnapshot.session.flags.networkDown ? 'this PC is offline' : 'said nothing of the sort',
        'check',
        'PRD 11d: the app says *this PC* has lost its network. The screen builds that sentence from ' +
          'this flag alone, so the flag is what the engine can honestly be held to here.',
      ),
      assertion(
        'cableNeverBlamedTheTelevision',
        'eq',
        'never said it',
        gaveUp === 0 &&
          !noticesSeen.some((message) => message.toLowerCase().includes('lost connection'))
          ? 'never said it'
          : `said "${noticesSeen.join('" / "') || 'lost connection'}"`,
        'check',
        'PRD 11d: an unplugged cable was reported as "Lost connection to <name>" on the founder’s own ' +
          'PC once already — the exact defect fixed on 2026-08-18. Judged across every snapshot of the ' +
          'episode, not the one at the end.',
      ),
      assertion(
        'cableDeviceListDimmedNotEmptied',
        'eq',
        'dimmed',
        devicesEmptied ? 'emptied' : devicesDimmed ? 'dimmed' : 'never seen',
        'check',
        'PRD 11d: the device list dims rather than empties — the televisions have not gone anywhere.',
      ),
      assertion(
        'cablePositionAndFileHeld',
        'eq',
        'held',
        fileLost || sessionDropped ? 'lost the film' : 'held',
        'check',
        'PRD 11d: the position is held through the outage and the session is not torn down.',
      ),
      assertion(
        'cableGiveUpClockSuspended',
        'eq',
        'suspended',
        !pastDeadline
          ? `the outage lasted only ${seconds(offlineForMs)} — too short to prove anything about a ${seconds(
              TIMING.reconnectBudgetMs,
            )} deadline`
          : gaveUp > 0
            ? 'gave up while this PC was still offline'
            : 'suspended',
        'check',
        `PRD 11d: the ${seconds(TIMING.reconnectBudgetMs)} give-up clock is suspended while this PC has no ` +
          'network — there is nothing to reconnect over. This outage was deliberately held past that ' +
          'deadline so the assertion could not pass by being short.',
      ),
      assertion(
        'cableNetworkSettingsOfferedAfter30s',
        'eq',
        'offered',
        !pastDeadline
          ? `the outage lasted only ${seconds(offlineForMs)}`
          : helpOffered
            ? 'offered'
            : 'never offered',
        'check',
        `PRD 11d: after ${seconds(TIMING.offlineHelpAfterMs)} of outage — and not before — a button appears ` +
          'that opens Windows’ network settings.',
      ),
      assertion(
        'cableNoNetworkSettingsButtonAtFirst',
        'eq',
        'not yet',
        helpOfferedTooEarly === null
          ? 'never said this PC was offline at all'
          : helpOfferedTooEarly
            ? 'offered immediately'
            : 'not yet',
        'check',
        'PRD 11d: "and not before" — a blip the founder could ignore must not be dressed up as ' +
          'something they have to go and fix. Read at the instant this PC was first seen to be offline.',
      ),
      // --- 11b: the film comes back by itself ---
      assertion(
        'cableResumedMs',
        'lte',
        10_000,
        resumedMs,
        'ms',
        'PRD 11b: playback is running again within 10 s of the network returning — timed from this PC’s ' +
          'address reappearing in the interface table, which is the world’s event rather than ours.',
      ),
      assertion(
        'cableResumePositionErrorS',
        'lte',
        2,
        resumeErrorSec,
        's',
        'PRD 11b: within 2 s of the lost position — our display against the television’s own first ' +
          'report after rejoining.',
      ),
      assertion(
        'cableFounderPressedNothing',
        'eq',
        0,
        presses,
        'presses',
        'PRD 11b: the founder did nothing, across the whole episode — not one intent reached the engine.',
      ),
      assertion(
        'cableNeverShowedAnError',
        'eq',
        'no error',
        noticesSeen.length === 0 ? 'no error' : `said "${noticesSeen.join('" / "')}"`,
        'check',
        'PRD 11b: and was never shown an error. Every snapshot from before the cable came out to after ' +
          'the film came back, because sampling the end state is how a wrong screen passed 12b this ' +
          'morning.',
      ),
      // --- The television's business and the operating system's, never graded ---
      observation(
        'cableWhatNoticedIt',
        firstRecovery === null ? null : String(firstRecovery['reason'] ?? firstRecovery['cause']),
        'reason',
        'which of our two detectors got there first — the interface watcher ("this PC went offline") ' +
          'or the keep-alive giving up on a socket that stopped answering. On a silent outage they ' +
          'race, and which one wins on a real network is a thing we have never seen',
      ),
      observation(
        'cableNoticedFromInterfaceChangeMs',
        interfaceChangedAt === null ? null : Math.round(offlineAt - interfaceChangedAt),
        'ms',
        'from this PC’s interface table changing to the app knowing — bounded below by the 2 s ' +
          'interface poll, and nothing like the 1 ms a severed socket reports',
      ),
      observation(
        'cableNoticedFromAskingMs',
        Math.round(offlineAt - askedAt),
        'ms',
        'from the instruction being printed to this PC being offline — mostly the walk to the PC',
      ),
      observation(
        'cableAddressRestoredMs',
        Math.round(networkBackAt - replugAskedAt),
        'ms',
        'from asking for the cable back to Windows having an address again — the operating system’s ' +
          'business and the founder’s walking speed, never ours',
      ),
      observation(
        'cableTotalOutageMs',
        Math.round(networkBackAt - offlineAt),
        'ms',
        'how long this PC was actually off the network',
      ),
      observation(
        'cableOutageToPlayingMs',
        backAt === null ? null : Math.round(backAt - offlineAt),
        'ms',
        'the whole interruption end to end — the founder-visible number, reported and never graded',
      ),
      observation(
        'cableStatesWhileOffline',
        [...statesWhileOffline].join(', ') || 'none',
        'states',
        'what the session looked like while this PC was away — a television that runs out of buffer ' +
          'will stall or give up on its own, which is the device’s doing and not a promise of ours',
      ),
      observation(
        'cablePositionAtOutageSec',
        Math.round(outageSec * 1000) / 1000,
        's',
        'where the television said it was when the cable came out — read at the outage, not at ' +
          'the start of the scenario, which is the walk to the PC and can be twenty seconds of film',
      ),
      observation(
        'cablePositionOnReturnSec',
        afterSec === null ? null : Math.round(afterSec * 1000) / 1000,
        's',
        'where it was when the film came back — a television that played on through the outage lands ' +
          'ahead of where it dropped, and that is the device’s doing, not ours',
      ),
    );
  } finally {
    watching();
  }

  assertions.push(...(await stopAndRelease(context, 'first')));
  return assertions;
}

/**
 * 12a and 12b: the app is closed mid-film and reopened.
 *
 * **Honestly stated**: this is a second engine *instance* in this process, not a second OS
 * process. What it genuinely exercises is everything that matters — the media server is
 * closed and rebound, the URL the television is still fetching has to be republished from
 * the settings file, and the session is re-derived from the device rather than remembered.
 * What it does not exercise is anything process-level, and there is nothing process-level
 * here to exercise.
 */
async function scenarioReattach(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  if (!(await playing(context, assertions))) return assertions;

  const beforeSec = lastDeviceSec(context, 0) ?? 0;
  const fileName = context.snapshot().file?.name ?? null;
  // The port the television is fetching from *right now*. Everything below turns on the
  // reopened app binding this same number: a different one 404s every request the TV
  // makes, and it does so silently, minutes later, when the buffer it is playing out of
  // finally runs dry.
  const portBefore = context.engine.mediaServerPort;
  // The unguessable segment of that same URL. Read from the log rather than the snapshot:
  // the token is deliberately not part of what the UI knows.
  const tokenBefore =
    context
      .records()
      .filter((record) => record.event === 'media.mounted')
      .map((record) => record['token'])
      .filter((value): value is string => typeof value === 'string')
      .at(-1) ?? null;
  const closedAt = context.mono();

  await context.restart();

  let reattachedMs: number | null = null;
  try {
    reattachedMs =
      (await context.waitFor(
        'the reopened app to land in Playing',
        TIMING.reattachBudgetMs + SELFTEST.stateWaitMs,
        (snapshot) =>
          !snapshot.session.flags.reattaching &&
          (snapshot.session.state === 'playing' || snapshot.session.state === 'paused'),
      )) - closedAt;
  } catch {
    // Null measurement below.
  }
  const after = context.snapshot();
  const landedSec = lastDeviceSec(context, closedAt);

  assertions.push(
    assertion(
      'reattachMs',
      'lte',
      TIMING.reattachBudgetMs,
      reattachedMs === null ? null : Math.round(reattachedMs),
      'ms',
      'PRD 12a: reattaches within 5 s — the approved mockup\'s "Transient (≤5s)" label',
    ),
    assertion(
      'reattachState',
      'eq',
      'playing',
      after.session.state,
      'state',
      'PRD 12a: it lands in Playing with working controls',
    ),
    assertion(
      'reattachDidNotRestartTheFilm',
      'eq',
      0,
      context.samples('session.loading', closedAt).length,
      'loads',
      'PRD 12a: **it does not start the film again** — a reattach issues no LOAD at all',
    ),
    assertion(
      'reattachPositionErrorS',
      'lte',
      2,
      landedSec === null ? null : Math.round(Math.abs(landedSec - beforeSec) * 1000) / 1000,
      's',
      'PRD 12a: with the correct position — against where the device was when the app closed, so a film that kept playing shows the few seconds it really moved',
    ),
    assertion(
      'reattachFileName',
      'eq',
      fileName,
      after.file?.name ?? null,
      'name',
      'PRD 12a: and the correct file name',
    ),
    observation(
      'reattachSecondEngine',
      'instance, not process',
      'kind',
      'a second engine instance in this process: the media server really is closed and rebound and the URL really is republished from the settings file, but nothing process-level is exercised',
    ),
  );

  // --- The half of 12a that had nothing watching it ---
  //
  // SPIKE-2 proved a reattach works *only* because the second process republished an
  // identical URL — same port **and** same token. The token half was asserted; the port
  // half was not, and neither was the thing both exist for: that the television actually
  // comes back to this PC for bytes. It cannot be inferred from the state, because a
  // Chromecast plays on out of its own buffer — SPIKE-2 measured **zero** range requests
  // across a 15-second outage — so a reattach onto the wrong port looks perfect for as
  // long as the buffer lasts and then stalls the film a minute later, which is precisely
  // the evening this milestone exists to prevent.
  const portAfter = context.engine.mediaServerPort;
  assertions.push(
    assertion(
      'reattachRepublishedOnTheRememberedPort',
      'eq',
      portBefore,
      portAfter,
      'port',
      'PRD 12a / SPIKE-2 finding 3: the reopened app rebinds the port the television is still fetching from. A different one 404s every request it makes.',
    ),
  );

  // A jump is how a device is made to ask for bytes it does not already hold. Nothing is
  // graded about the jump itself — `seek` owns that — it is here to force the request the
  // assertion below is about, and a long one is used because a short hop can land inside
  // the buffer the television already has.
  const durationSec = after.session.durationSec;
  const fetchWatchFrom = closedAt;
  const nudgeTarget = Math.max(
    0,
    Math.min(Math.max(0, durationSec - 30), (landedSec ?? beforeSec) + LONG_SEEK_SEC),
  );
  context.engine.dispatch({ type: 'playback.seek', positionSec: nudgeTarget });

  const fetchDeadline = context.mono() + SELFTEST.stateWaitMs;
  while (
    context.samples('media.first_request', fetchWatchFrom).length === 0 &&
    context.mono() < fetchDeadline
  ) {
    await context.sleep(200);
  }
  const fetches = context.samples('media.first_request', fetchWatchFrom);
  const firstFetch = fetches[0];
  assertions.push(
    assertion(
      'reattachDeviceCameBackForBytes',
      'gte',
      1,
      fetches.length,
      'requests',
      'PRD 12a: the television really did fetch from the reopened media server. Without this the scenario passes while the TV plays out its buffer and stalls a minute later.',
    ),
    assertion(
      'reattachFetchedOnTheRememberedToken',
      'eq',
      tokenBefore,
      firstFetch === undefined ? null : String(firstFetch['token']),
      'token',
      'PRD 12a: and it fetched the URL it was already holding — same token as well as same port',
    ),
    observation(
      'reattachFirstByteRequestMs',
      firstFetch === undefined ? null : Math.round(Number(firstFetch['monoMs']) - fetchWatchFrom),
      'ms',
      'how long after the app closed the television next asked this PC for bytes — its buffer, its business',
    ),
  );

  // --- 12b: reopened onto a television that is *not* playing our content ---
  await stopAndReleaseInto(assertions, context, 'first');
  await context.sleep(1_000);
  const secondOpenAt = context.mono();
  await context.restart();
  await context.sleep(TIMING.reattachBudgetMs);
  const idle = context.snapshot();
  assertions.push(
    assertion(
      'reattachWhenNotOursIsSilent',
      'eq',
      'silent',
      idle.notice === null && !idle.session.flags.reattaching
        ? 'silent'
        : `said "${idle.notice?.message ?? 'still reattaching'}"`,
      'check',
      "PRD 12b: no reattach screen and no error — recovery that isn't needed is silent",
    ),
    assertion(
      'reattachWhenNotOursSendsNothing',
      'eq',
      0,
      context.samples('session.loading', secondOpenAt).length +
        context.samples('cast.receiver_launched', secondOpenAt).length,
      'commands',
      'PRD 12b: and it opens straight into Idle without touching the television',
    ),
  );
  return assertions;
}

/** `stopAndRelease` mid-scenario, without ending it. */
async function stopAndReleaseInto(
  assertions: Assertion[],
  context: Context,
  label: string,
): Promise<void> {
  assertions.push(...(await stopAndRelease(context, label)));
}

/**
 * 14a–14c: somebody takes the television.
 *
 * Attempted programmatically — a second connection launches a different receiver app,
 * which is what a phone does — and **falls back to the human checklist**. PRD: "whether
 * this behaves like a phone taking the TV is an assumption to be proven, not a fact". If
 * the device will not be taken this way, that is a run that could not happen: **exit 2**,
 * naming checklist item 4. It is never a failed promise, because nothing was promised.
 */
async function scenarioTakeover(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  if (context.deviceAddress === '') {
    throw new SelftestAbort(
      'the device address was never logged, so no second connection could be opened — run human checklist item 4 instead',
    );
  }
  if (!(await playing(context, assertions))) return assertions;

  const beforeSec = lastDeviceSec(context, 0) ?? 0;
  const takenAt = context.mono();
  let launched: boolean;
  try {
    launched = await launchOtherApp(
      context.deviceAddress,
      context.devicePort,
      context.secondConnection,
    );
  } catch {
    launched = false;
  }
  if (!launched) {
    throw new SelftestAbort(
      `this device would not launch ${CAST.takeoverProbeAppId} from a second connection, so the takeover could not be produced — run human checklist item 4 (cast YouTube to the TV from a phone) instead`,
    );
  }

  let yieldedMs: number | null;
  try {
    yieldedMs =
      (await context.waitFor(
        'the app to yield the television',
        TIMING.takeoverGraceMs + SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.flags.yielded,
      )) - takenAt;
  } catch {
    throw new SelftestAbort(
      'the television was launched into by a second connection but our session never saw a takeover — this device does not report one the way a phone does; run human checklist item 4 instead',
    );
  }

  const yieldedSnapshot = context.snapshot();
  const yieldedAtMono = context.mono();

  // 14b, and it is a performance requirement as much as a courtesy: SPIKE-2 found the old
  // media session stops answering entirely, so a poll that kept running would burn a full
  // 5 s request timeout on every tick. Nothing may go to that television from here.
  await context.sleep(5_000);
  context.engine.dispatch({ type: 'playback.skip', deltaSec: SKIP.stepSeconds });
  await context.sleep(1_000);
  const commandsAfter =
    context.samples('session.loading', yieldedAtMono).length +
    context.samples('session.seek_issued', yieldedAtMono).length +
    context.samples('cast.receiver_launched', yieldedAtMono).length +
    context.samples('session.connected', yieldedAtMono).length;

  assertions.push(
    assertion(
      'takeoverNoticedMs',
      'lte',
      TIMING.takeoverGraceMs + 2_000,
      Math.round(yieldedMs),
      'ms',
      'PRD 14a: the app states it once the device has said which app has it — SPIKE-2 measured that arriving 4.3–11.3 s after the close',
    ),
    assertion(
      'takeoverNamesTheOtherApp',
      'eq',
      'named',
      yieldedSnapshot.session.yieldedToApp === null ? 'not named' : 'named',
      'check',
      'PRD 14a: "<name> is now playing <other app>" — stated as a fact, so the other app has to be named',
    ),
    assertion(
      'takeoverRememberedPositionS',
      'lte',
      2,
      Math.round(Math.abs(yieldedSnapshot.session.resumePositionSec - beforeSec) * 1000) / 1000,
      's',
      'PRD 14a: the position is remembered',
    ),
    assertion(
      'takeoverCommandsSentAfterYield',
      'eq',
      0,
      commandsAfter,
      'commands',
      'PRD 14b: zero further load, play or seek commands — including a skip pressed after the yield, which must be refused rather than queued',
    ),
    assertion(
      'takeoverRefusedTheSkip',
      'gte',
      1,
      context.samples('session.seek_refused', yieldedAtMono).length,
      'refusals',
      'PRD 6j/14b: a jump we cannot send is refused, never queued',
    ),
    observation(
      'takeoverOtherApp',
      yieldedSnapshot.session.yieldedToApp,
      'app',
      'what the television said had taken it',
    ),
  );

  // --- 14c: Take it back ---
  const savedSec = yieldedSnapshot.session.resumePositionSec;
  const backAt = context.mono();
  context.engine.dispatch({ type: 'cast.resume' });
  let backMs: number | null = null;
  try {
    backMs = (await context.waitForState('playing', SELFTEST.stateWaitMs)) - backAt;
  } catch {
    // Null measurement below.
  }
  const landedSec = lastDeviceSec(context, backAt);
  assertions.push(
    assertion(
      'takeBackPositionErrorS',
      'lte',
      TIMING.seekToleranceSec,
      landedSec === null ? null : Math.round(Math.abs(landedSec - savedSec) * 1000) / 1000,
      's',
      'PRD 14c: it resumes at the remembered position, within 1 s of it',
    ),
    observation(
      'takeBackMs',
      backMs === null ? null : Math.round(backMs),
      'ms',
      'what the founder waits for a take-back — dominated by the receiver boot, exactly as a fresh cast is. SPIKE-2 measured 5,714 ms and 7,908 ms',
    ),
  );

  assertions.push(...(await stopAndRelease(context, 'second')));
  return assertions;
}

/**
 * Launches a *different* receiver app from a second connection, the way a phone does.
 *
 * Nothing of the engine's is used to do it, because the engine deliberately has no way to
 * launch anything but the Default Media Receiver — 14b turns on it never doing this. The
 * app it launches queues no video: it takes the television and shows its own idle screen,
 * which is all the scenario needs and the least it can do to a family's TV.
 */
function launchOtherApp(
  address: string,
  port: number,
  connect: TransportFactory,
): Promise<boolean> {
  const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
  const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (result: boolean, transport?: CastTransport): void => {
      if (settled) return;
      settled = true;
      transport?.close();
      resolve(result);
    };
    void connect(
      { host: address, port, timeoutMs: CAST.connectTimeoutMs },
      {
        onMessage: () => undefined,
        onClose: () => finish(false),
      },
    ).then(
      (transport) => {
        const timer = setTimeout(() => finish(false, transport), CAST.launchTimeoutMs);
        timer.unref?.();
        const send = (namespace: string, payload: Record<string, unknown>): void => {
          transport.send({
            sourceId: 'sender-takeover',
            destinationId: 'receiver-0',
            namespace,
            data: JSON.stringify(payload),
          });
        };
        send(NS_CONNECTION, { type: 'CONNECT', userAgent: 'CastGood-selftest', origin: {} });
        send(NS_RECEIVER, { type: 'LAUNCH', appId: CAST.takeoverProbeAppId, requestId: 1 });
        // The launch either takes or it does not, and either way the engine's own session
        // is what is under test — so this waits out the launch budget and then gets out of
        // the way rather than parsing a reply it does not need.
        const done = setTimeout(() => {
          clearTimeout(timer);
          finish(true, transport);
        }, CAST.launchTimeoutMs / 2);
        done.unref?.();
      },
      () => finish(false),
    );
  });
}

async function scenarioSourceGone(context: Context): Promise<Assertion[]> {
  // **A copy, never the founder's own file.** This scenario deletes what it is playing, and
  // doing that to the file they passed on the command line would be unforgivable — a
  // selftest that can lose your video is a selftest nobody runs twice.
  const copy = path.join(
    os.tmpdir(),
    `castgood-sourcegone-${String(Date.now())}${path.extname(context.filePath)}`,
  );
  try {
    await fsp.copyFile(context.filePath, copy);
  } catch (error) {
    // Out of disk, or a temp directory we cannot write to. That is a run that could not
    // happen (exit 2), not a promise the product failed to keep (exit 1).
    throw new SelftestAbort(
      `could not copy the video to a scratch file this scenario is allowed to delete: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  const assertions: Assertion[] = [];
  try {
    context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });
    context.engine.dispatch({ type: 'file.clear' });
    await context.waitFor(
      'the previous file to clear',
      5_000,
      (snapshot) => snapshot.file === null,
    );
    context.engine.dispatch({ type: 'file.select', path: copy });
    await context.waitFor('the copy to be read', 10_000, (snapshot) => snapshot.file !== null);

    const cast = await castToPicture(context, 'first');
    assertions.push(...cast.assertions);
    if (!cast.ok) return assertions;

    // Let it get a buffer, then pull the file out from under it.
    await context.sleep(4_000);
    const removedAt = context.mono();
    await fsp.rm(copy);

    // --- 15a: silence, for as long as playback is unaffected ---
    //
    // Sampled *throughout* rather than only at the end. Looking once, six seconds later,
    // would pass a notice that appeared and then cleared itself — and "nothing is said" is
    // a statement about the whole window, not about one instant of it.
    // ⚠️ **15a can only be graded while playback really is unaffected**, and whether it is
    // depends on how far ahead the television buffered — which this scenario neither
    // controls nor can read. **Four seconds of playback is not a promise of six seconds of
    // buffer.** On 2026-09-09 a `Chromecast Ultra` starved 6.2 s after the source was
    // removed at position 4.2 s, and this leg graded CastGood's entirely correct 15b
    // sentence as a broken 15a promise: 107/108, exit 1, against a product that had done
    // the right thing (issue #68).
    //
    // So the window is abandoned the moment the film stops. **A leg that cannot be graded
    // is exit 2, never exit 1** — PR #46's rule ("a film too short is a run that could not
    // happen, not a promise broken"), applied to a buffer instead of a duration. A false
    // red here is as corrosive as a false green: it is the one criterion whose whole point
    // is that the app says *nothing*.
    const STARVED: readonly string[] = ['stopped', 'idle', 'ended'];
    let spoke: string | null = null;
    let starvedAfterMs: number | null = null;
    const silenceDeadline = context.mono() + 6_000;
    while (context.mono() < silenceDeadline) {
      const snapshot = context.snapshot();
      const said = snapshot.notice;
      if (said !== null && spoke === null) spoke = said.message;
      // Order matters: if the app spoke *first*, that is a real 15a failure and must be
      // reported as one. Only a film that stopped while the app was still silent means the
      // window never existed.
      if (spoke === null && STARVED.includes(snapshot.session.state)) {
        starvedAfterMs = context.mono() - removedAt;
        break;
      }
      await context.sleep(100);
    }
    if (spoke === null && starvedAfterMs !== null) {
      throw new SelftestAbort(
        `the television ran out of buffer ${(starvedAfterMs / 1000).toFixed(1)} s after the source was removed, so 15a's "playback unaffected" window never existed and this leg could not be graded — 15b, not 15a. Re-run with a film this device buffers further ahead, or give it longer to buffer before the file is removed`,
      );
    }
    const spokeTooSoon = spoke !== null || context.snapshot().notice !== null;
    assertions.push(
      assertion(
        'silentWhilePlaybackUnaffected',
        'eq',
        'silent',
        spokeTooSoon ? `said "${spoke ?? context.snapshot().notice?.message ?? ''}"` : 'silent',
        'check',
        'PRD 15a: nothing is said while the film is playing perfectly well',
      ),
      observation(
        'stateSixSecondsAfterRemoval',
        context.snapshot().session.state,
        'state',
        'whether this device kept playing from its own buffer or came back for bytes — its behaviour, not ours',
      ),
    );

    // --- 15b: the sentence, once it matters ---
    context.engine.dispatch({ type: 'cast.stop' });
    try {
      await context.waitFor(
        'the app to state that the file has gone',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.notice?.kind === 'source-missing',
      );
    } catch {
      // Falls through to the assertion below, which reports what was actually said.
    }
    const notice = context.snapshot().notice;
    assertions.push(
      assertion(
        'sourceGoneMessage',
        'eq',
        'The original file is no longer where it was',
        notice?.message ?? null,
        'message',
        'PRD 15b: the same plain sentence, with no raw path and no ENOENT',
      ),
      assertion(
        'sourceGoneAction',
        'eq',
        'Find it again',
        notice?.actionLabel ?? null,
        'label',
        'PRD 15b: and a way out of it',
      ),
      assertion(
        'sourceGonePositionKept',
        'gte',
        1,
        Math.round(context.snapshot().session.resumePositionSec * 1000) / 1000,
        's',
        'PRD 15b: the position is remembered through it',
      ),
      observation(
        'secondsBetweenRemovalAndMessage',
        Math.round((context.mono() - removedAt) / 100) / 10,
        's',
        'how long the founder went on watching before anything was said',
      ),
    );
    return assertions;
  } finally {
    // 13e in spirit: leave nothing behind, on pass, fail or interrupt.
    await fsp.rm(copy, { force: true }).catch(() => undefined);
  }
}

const RUNNERS: Record<AggregateMember, (context: Context) => Promise<Assertion[]>> = {
  discovery: scenarioDiscovery,
  cast: scenarioCast,
  transport: scenarioTransport,
  position: scenarioPosition,
  seek: scenarioSeek,
  skip: scenarioSkip,
  recover: scenarioRecover,
  reattach: scenarioReattach,
  takeover: scenarioTakeover,
  sourcegone: scenarioSourceGone,
  finish: scenarioFinish,
  resume: scenarioResume,
  check: scenarioCheck,
  remux: scenarioRemux,
  prepared: scenarioPrepared,
  convert: scenarioConvert,
  headstart: scenarioHeadStart,
  prepfail: scenarioPrepFail,
  subtitles: scenarioSubtitles,
  volume: scenarioVolume,
};

/**
 * The order `m2` runs in, and **why `takeover` is last**. Exported so it can be pinned.
 *
 * A `SelftestAbort` ends the whole run at exit 2 — that is the contract, and it is right:
 * "this did not happen" is not a promise that failed. But in an aggregate it also means
 * every scenario *after* the aborting one never runs, and its silence is indistinguishable
 * in the verdict from a promise nobody made.
 *
 * `takeover` is the one scenario the PRD **expects** to abort: "whether this behaves like
 * a phone taking the TV is an assumption to be proven, not a fact — if it doesn't, this
 * becomes checklist item 4 and the scenario exits 2". With it fifth of eight, a television
 * that will not be taken programmatically silently cost the run `sourcegone`, `finish` and
 * `resume`: three scenarios, eleven criteria, no measurements, and a verdict that named
 * only the takeover. Last, an anticipated abort strands nothing — every other scenario has
 * already measured and its assertions are in the published verdict.
 *
 * The exit code is **unchanged and unweakened**: that run still exits 2, and `m2` still
 * only reaches 0 when every scenario in this list ran and every promise held.
 */
/**
 * What `m3` runs, and in this order.
 *
 * **`headstart` is here as of M3b**, where it was deliberately absent through M3a: an `m3`
 * that included a head-start scenario before the feature existed would have been an
 * aggregate reporting on something that had not been built. It costs the aggregate a
 * condition — the film passed on the command line now has to be **long enough to head-start**
 * — and `preflight` states that before the first scenario rather than discovering it four
 * scenarios in.
 *
 * `check` first because it is the cheapest and needs nothing prepared. `headstart` after
 * `convert`, because it is the longest by far and everything before it is measured by the
 * time it starts. `prepfail` last for the same reason `takeover` is last in `m2`: it is the
 * scenario the PRD **expects** to be unable to finish, and an anticipated abort must not
 * strand the scenarios behind it.
 */
export const M3_ORDER: readonly AggregateMember[] = [
  'check',
  'remux',
  'prepared',
  'convert',
  'headstart',
  'prepfail',
];

export const M2_ORDER: readonly AggregateMember[] = [
  'seek',
  'skip',
  'recover',
  'reattach',
  'sourcegone',
  'finish',
  'resume',
  'takeover',
];

/**
 * **What `m3c` runs, and why in this order.** The one command the founder cares about.
 *
 * Three runs of one scenario, because that is what the PRD's own table names: `subtitles`,
 * `subtitles --timing` and `subtitles --broken` are three separate runs asserting different
 * promises, and outside an aggregate the two flags are refused *beside each other* for
 * exactly that reason. Inside `m3c` they stop being flags and become legs — which is why
 * `--timing` or `--broken` passed **alongside** `--scenario m3c` is refused rather than
 * silently ignored: it would be asking for one leg of a run that already runs all three.
 *
 * **This aggregate adds no coverage of its own.** Each leg is the run that already exists,
 * unchanged, asserting exactly what it asserted alone.
 *
 * **`--broken` is last, for the reason `takeover` is last in `m2` and `prepfail` in `m3`.**
 * A `SelftestAbort` ends the whole run at exit 2 — correctly, "this did not happen" is not
 * a promise that failed — but it also means every leg *behind* the aborting one never runs,
 * and silence in a verdict is indistinguishable from a promise nobody made. The broken run
 * is the one whose abort is anticipated and outside our control: it exits 2 when *the
 * television fetched the withheld track anyway*, which is a thing a receiver decides, not
 * us. Last, that costs nothing else — the plain and timing legs have already measured and
 * their assertions are in the published verdict.
 *
 * Plain before timing is the other half of it: the timing leg is the plain run **plus**
 * story 20's blocks, so a fault in the shared part is named by the cheaper leg first.
 *
 * **13e across the legs.** Each leg resets the correction it set — the survival block ends
 * at *in sync*, and 20f's block ends on *Reset*, which is the one thing that forgets a
 * remembered offset — so no leg inherits the previous leg's timing, and the run leaves
 * nothing on the founder's PC. The aggregate adds no state of its own between them.
 */
export const M3C_ORDER: readonly AggregateLeg[] = [
  { scenario: 'subtitles', label: 'subtitles', subtitleTiming: false, subtitleBroken: false },
  {
    scenario: 'subtitles',
    label: 'subtitles-timing',
    subtitleTiming: true,
    subtitleBroken: false,
  },
  {
    scenario: 'subtitles',
    label: 'subtitles-broken',
    subtitleTiming: false,
    subtitleBroken: true,
  },
];

/**
 * `m5` — M5a's `volume`, and M5b's `queue*` when they exist.
 *
 * **A new aggregate rather than a leg added to an existing one, deliberately.** `m1`, `m2`,
 * `m3` and `m3c` are the regression baseline criterion 23j is graded by: they must all
 * still exit 0 with **no assertion edited**, which is only meaningful while they are
 * untouched by the feature. An aggregate that grows to cover the feature it is a control
 * for stops being one — 21j's reasoning, applied again.
 *
 * It is runnable with `volume` alone, before M5b exists, which is what lets M5a ship first.
 */
export const M5_ORDER: readonly AggregateLeg[] = [
  { scenario: 'volume', label: 'volume', subtitleTiming: false, subtitleBroken: false },
];

/** A scenario run once, as itself: what every leg of `m1`, `m2` and `m3` is. */
function plainLeg(scenario: AggregateMember): AggregateLeg {
  return { scenario, label: scenario, subtitleTiming: false, subtitleBroken: false };
}

/**
 * How long a film each scenario needs before its promises mean anything.
 *
 * These are the conditions the scenarios themselves abort on, hoisted so an aggregate
 * discovers them **before** it starts rather than four scenarios in. A 28-minute file
 * cannot grade a 20-minute jump in both directions, and finding that out after `seek` has
 * already cast is what turns "this file is too short" into "and nothing else ran either".
 */
/**
 * What `position` needs, as a function of the window it was asked to watch.
 *
 * Every other entry below is a constant; this one is not, because `--position-duration`
 * moves it. The tail is the film still playing when the window closes, so the stop has
 * something to stop.
 */
const POSITION_TAIL_SEC = 60;
function positionNeedsSec(positionDurationMs: number): number {
  return positionDurationMs / 1000 + POSITION_TAIL_SEC;
}

const DURATION_NEEDED_SEC: Partial<Record<AggregateMember, number>> = {
  seek: LONG_SEEK_SEC * 2 + 120,
  resume: WORKING_POSITION_SEC + 60,
  finish: 31,
  // M3b: the gate will not open until ten minutes of video exist, and a film that only just
  // clears that bar finishes converting moments later — leaving no live frontier to watch.
  // Stated here so an `m3` on a short film says so **before** it converts anything.
  headstart: PREPARATION.headStartSeconds + 300,
};

/**
 * The checks an aggregate makes before its first scenario, so that nothing it *can* know
 * in advance is discovered halfway through and takes the rest of the run with it.
 *
 * Two things are knowable: how long the film is (the picker probes it, no device needed),
 * and whether `sourcegone` will have somewhere to put the throwaway copy it deletes. Both
 * are exit 2 either way — this only moves *when* they are found, from "after four
 * scenarios have run and been thrown away" to "before anything started".
 *
 * What it cannot pre-empt is named in the audit above `M2_ORDER` and in `docs/STATUS.md`:
 * a machine that runs out of disk mid-run, and a socket that vanishes between casting and
 * the moment `recover` tries to sever it. Neither can be known in advance, and neither is
 * anticipated the way a television refusing a takeover is.
 */
async function preflight(context: Context, order: readonly AggregateLeg[]): Promise<void> {
  const members = order.map((leg) => leg.scenario);
  const needed = members
    .map((name) =>
      // `position` is the one member whose requirement is not a constant — it follows the
      // window the run was asked to watch. Without it here, `m1` cast four times on a film
      // too short to grade and reported three broken promises, which is the exact outcome
      // this whole function exists to prevent.
      name === 'position'
        ? positionNeedsSec(context.positionDurationMs)
        : (DURATION_NEEDED_SEC[name] ?? 0),
    )
    .reduce((a, b) => Math.max(a, b), 0);
  if (needed > 0) {
    context.engine.dispatch({ type: 'file.select', path: context.filePath });
    try {
      await context.waitFor(
        'the file to be read',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.file !== null,
      );
    } catch {
      throw new SelftestAbort(`the file could not be read: ${context.filePath}`);
    }
    const durationSec = context.snapshot().file?.durationSec ?? 0;
    if (durationSec < needed) {
      throw new SelftestAbort(
        `this run needs a file of at least ${String(Math.round(needed / 60))} minutes; this one is ${String(
          Math.round(durationSec / 60),
        )} — nothing was cast`,
      );
    }
  }

  if (members.includes('headstart')) {
    // **The other thing `m3` can know about the film before it converts anything**, and the
    // one that cost two whole hardware runs on 2026-08-28.
    //
    // `headstart` needs a film **this television cannot play natively** — otherwise there is
    // no growing conversion to run ahead of. Every other leg in `m3` now builds its own
    // fixtures and no longer cares what film it was handed, so this is the aggregate's only
    // remaining requirement of `--file` beyond its length — and discovering it fifth of six,
    // after forty minutes of preparing and casting, is the difference between "pass a
    // different film" and "come back after dinner".
    //
    // Exit 2 either way. This only moves *when* it is found.
    context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });
    context.engine.dispatch({ type: 'file.clear' });
    await context.waitFor(
      'the previous file to clear',
      5_000,
      (snapshot) => snapshot.file === null,
    );
    context.engine.dispatch({ type: 'file.select', path: context.filePath });
    try {
      await context.waitFor(
        'the check to produce a verdict',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.check === null && snapshot.file !== null,
      );
    } catch {
      throw new SelftestAbort(`the file could not be checked: ${context.filePath}`);
    }
    const kind = context.snapshot().file?.verdict?.kind ?? 'nothing';
    if (kind !== 'convert') {
      throw new SelftestAbort(
        `this run includes the head-start scenario, which only applies to a film this television has to convert; CastGood judged "${path.basename(
          context.filePath,
        )}" "${kind}", so there would be no growing conversion to watch — pass a film this device cannot play natively. Nothing was cast`,
      );
    }
  }

  // **`m3c`'s own precondition, hoisted for `M3_ORDER`'s reason.** Every one of the three
  // subtitle legs aborts on the same fact — a film with no text track inside it and no
  // subtitle file beside it has nothing to send, nothing to nudge and nothing to withhold —
  // and each of them finds it out only after it has cast. Asked here, the answer costs one
  // check and no television at all, so an `m3c` pointed at the wrong film says so in seconds
  // rather than after the first leg has driven a set to `playing`.
  if (members.includes('subtitles')) await requireASubtitleSource(context);

  if (members.includes('sourcegone')) {
    // `sourcegone` deletes what it is playing, so it plays a copy — and a temp directory
    // it cannot write to would abort it mid-run. A few bytes now answers that.
    const probe = path.join(os.tmpdir(), `castgood-preflight-${String(Date.now())}.tmp`);
    try {
      await fsp.writeFile(probe, 'castgood');
    } catch (error) {
      throw new SelftestAbort(
        `there is nowhere to put the scratch copy the sourcegone scenario deletes: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    } finally {
      await fsp.rm(probe, { force: true }).catch(() => undefined);
    }
  }
}

/**
 * **The fact all three of `m3c`'s legs stand on: is there a subtitle to send at all?**
 *
 * The `subtitles` scenario exits 2 on a film with no text track inside it and no `.srt`/
 * `.vtt` beside it, and so does the `--broken` run — correctly, because a subtitle test
 * that quietly became an ordinary cast and went green is, in the PRD's words, the most
 * expensive lie available in this milestone. But each of them discovers it **after** casting,
 * so an `m3c` pointed at a film with no words would drive a television to `playing` three
 * times over to say the same thing three times.
 *
 * It is knowable without a device: the check the app already runs produces the list (18a
 * rides inside it), so this selects the file, waits for the check to settle, and reads the
 * list. Nothing is cast, and the answer is the same one the leg would have given.
 */
async function requireASubtitleSource(context: Context): Promise<void> {
  context.engine.dispatch({ type: 'device.select', deviceId: context.deviceId });
  context.engine.dispatch({ type: 'file.select', path: context.filePath });
  try {
    await context.waitFor(
      'the check and the subtitle list',
      SELFTEST.stateWaitMs,
      // The same predicate `chooseAndCheck` waits on: the engine holds *Checking…* until a
      // verdict exists, and the subtitle list is rebuilt inside that check.
      (snapshot) => snapshot.check === null && snapshot.file !== null,
    );
  } catch {
    throw new SelftestAbort(`the file could not be read: ${context.filePath}`);
  }
  const listed = context.snapshot().subtitles;
  if (listed.options.length === 0) {
    throw new SelftestAbort(
      `“${path.basename(context.filePath)}” has no text subtitle track inside it and no subtitle file beside it, ` +
        `so not one of this run's three subtitle legs could produce the condition it exists to test. ` +
        `Pass a film with an embedded text track (SubRip, ASS or mov_text) or one with a matching .srt/.vtt ` +
        `sibling — nothing was cast. ${String(listed.unavailable.length)} picture-only track(s) were listed and refused (18k).`,
    );
  }
}

/**
 * The log event a television abandoning a film writes (criterion 13g, `session/machine.ts`).
 */
const REFUSED_MID_PLAY = 'session.refused_mid_play';

/**
 * **No scenario reports a pass gathered from a television that had already quit.**
 *
 * The night this became a rule: a `--scenario cast` run against the Chromecast Ultra scored
 * **9/9** on a 113-minute 5.1 film that reached `PLAYING` at position 0 and went
 * `IDLE`/`ERROR` **81 ms** later. `firstStateSequence: reached playing` was true — the
 * device really did say `PLAYING` — and it was true about a film that was already dead. The
 * verdict was then written into the PRD as a *measurement of a television decoding 5.1
 * audio*. Two hours later a two-minute run said the opposite and the claim was retracted.
 *
 * That is the fourth finding of 2026-08-24 biting for real, and it is why 13g's failure
 * clause is *"if any verdict prints passing assertions collected after the event"*. The same
 * shape appears in 10k, about `headstart`: three of run 1's ten assertions were *"the
 * scenario talking to a corpse for three minutes"*.
 *
 * **What this does, and why it is deliberately blunt.** Every promise the scenario produced
 * stops counting as a pass, and a failing `televisionRefusedMidPlay` is added naming the
 * reason and the position. Not only the assertions measured *after* the event, because an
 * `Assertion` carries no timestamp and inventing one would put a clock inside `kit.ts`,
 * which imports nothing on purpose. Erring the other way — grading the ones that plausibly
 * came first — is exactly the mistake being corrected: on 2026-08-24 all nine came "first",
 * because the film died 81 ms in and the scenario went on talking for twenty seconds.
 *
 * Nothing is deleted or hidden. Each measurement stays printed with its target and its
 * value, and gains a note saying why it is not evidence, so the verdict is still the whole
 * of what was seen — it just no longer claims any of it proves something.
 *
 * **Observations are left alone**: they have no target, cannot pass and never touch the exit
 * code, so demoting them would remove information and buy nothing.
 *
 * **A deliberate stop never gets here.** `session.refused_mid_play` is not written for our
 * own `cast.stop` — the reducer has already moved the session to `stopped` when the
 * device's `IDLE`/`CANCELLED` reply lands — and every scenario in this file ends with one.
 */
function withRefusalGuard(
  produced: readonly Assertion[],
  refusals: readonly LogRecord[],
): Assertion[] {
  if (refusals.length === 0) return [...produced];

  const describe = (record: LogRecord): string => {
    const reason = typeof record['idleReason'] === 'string' ? record['idleReason'] : 'no reason';
    const at = typeof record['positionSec'] === 'number' ? record['positionSec'] : null;
    const believed =
      typeof record['believedState'] === 'string' ? record['believedState'] : 'playing';
    return `IDLE/${reason} at ${at === null ? 'an unknown position' : `${String(at)} s`} while we believed the film was ${believed}`;
  };
  const what = refusals.map(describe).join('; ');
  const note = `not evidence (13g): the television abandoned this session — ${what} — so nothing measured in this scenario proves anything`;

  return [
    ...produced.map((item) =>
      item.kind === 'promise' && item.passed
        ? {
            ...item,
            passed: false,
            note: item.note === undefined ? note : `${note} · ${item.note}`,
          }
        : item,
    ),
    assertion(
      'televisionRefusedMidPlay',
      'eq',
      'no',
      'yes',
      'bool',
      `PRD 13g: ${what}. A run that continues past this is measuring a corpse; the assertions above are printed but not counted.`,
    ),
  ];
}

// --- The runner --------------------------------------------------------------

export async function runSelftest(options: SelftestOptions): Promise<SelftestVerdict> {
  const clock = options.clock ?? systemClock;
  const paths = options.paths ?? resolveAppPaths();
  const startedWall = new Date(clock.wallMs());
  // Two sinks where possible: the engine's own JSONL log next to the verdict (13a), and an
  // in-memory copy this run reads its measurements back out of. A log directory we cannot
  // create is not a reason to refuse to run — it is a reason to say so in the verdict.
  const memory = createMemorySink();
  let sink: LogSink = memory;
  try {
    await fsp.mkdir(paths.logDir, { recursive: true });
    sink = combineSinks(options.logSink ?? createFileSink(paths.logDir, clock), memory);
  } catch {
    if (options.logSink !== undefined) sink = combineSinks(options.logSink, memory);
  }

  const verdict = (
    outcome: SelftestOutcome,
    exitCode: 0 | 1 | 2,
    produced: readonly Assertion[],
    reason: string | null,
    engine: Engine | null,
    startedMono: number,
  ): SelftestVerdict => ({
    schemaVersion: 1,
    scenario: options.scenario,
    variant: runVariant(options),
    device: options.deviceName,
    file: options.filePath,
    startedAt: startedWall.toISOString(),
    durationMs: Math.round(clock.monoMs() - startedMono),
    outcome,
    exitCode,
    reason,
    assertions: produced.filter((item) => item.kind === 'promise'),
    observations: produced.filter((item) => item.kind === 'observation'),
    environment: {
      platform: process.platform,
      nodeVersion: process.versions.node,
      mediaServerPort: engine?.mediaServerPort ?? null,
      logDir: paths.logDir,
      verdictFile: null,
      transport: options.unsafeTestOverrides === undefined ? 'tls' : 'test-harness',
    },
  });

  const startedMono = clock.monoMs();
  const outage: OutageKind = options.outage ?? 'socket';
  /**
   * Founder-facing instructions go to **stderr**, exactly like the summary: stdout is the
   * verdict JSON and a wrapper script parses it.
   */
  const instruct = (stage: SelftestPromptStage, text: string): void => {
    if (options.instructions !== undefined) options.instructions(stage, text);
    else process.stderr.write(text + '\n');
  };

  /**
   * An outage that needs a person, asked of a run that has nobody in the room.
   *
   * Refused here as well as at the command line, and before the file is even looked at:
   * this is the check that makes it *structurally* impossible for `m2` — which passed
   * 107/107 unattended — to stand waiting two minutes for a cable nobody is going to pull
   * and then exit 2 with seven scenarios unmeasured.
   */
  const refusal = refuseOutage(options.scenario, outage);
  if (refusal !== null) {
    return await publish(paths, verdict('could-not-run', 2, [], refusal, null, startedMono));
  }
  // Refused here as well as at the command line, so nothing that bypasses argument parsing
  // can ask for a run whose two halves contradict each other.
  const rateRefusal = refuseRate(
    options.scenario,
    options.conversionReadRate,
    options.conversionReadRateAfterGate,
  );
  if (rateRefusal !== null) {
    return await publish(paths, verdict('could-not-run', 2, [], rateRefusal, null, startedMono));
  }
  // And the two subtitle run-variants, for the same reason a third time. Inside `m3c` these
  // are legs rather than flags, so one asked for *beside* it would be quietly overwritten by
  // the running order — an operator told nothing, and a verdict that answered a question
  // they did not ask.
  const variantRefusal =
    refuseTiming(options.scenario, options.subtitleTiming === true) ??
    refuseBroken(
      options.scenario,
      options.subtitleBroken === true,
      options.subtitleTiming === true,
    );
  if (variantRefusal !== null) {
    return await publish(paths, verdict('could-not-run', 2, [], variantRefusal, null, startedMono));
  }

  // "Could not run" checks happen before anything is started, so a missing file never
  // costs the founder a launched receiver.
  try {
    const stat = await fsp.stat(options.filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    // This exit used to be the one that skipped `writeVerdict` — on the very path where a
    // saved verdict is most useful, because there is nothing else to look at afterwards.
    return await publish(
      paths,
      verdict('could-not-run', 2, [], fileNotFound(options.filePath), null, startedMono),
    );
  }

  const overrides = options.unsafeTestOverrides;
  // The transport is wrapped whatever it is, and the wrapper is *observation only*: it
  // hands every frame straight through and keeps a handle on the live socket. That is what
  // lets `recover` kill this process's own connection (11a) and stop believing the device's
  // PONGs (11f) without inventing a second code path — the engine still talks real TLS to
  // a real television, and the verdict still stamps itself `tls`.
  const severable = createSeverableTransport(overrides?.transport ?? tlsTransportFactory);

  /**
   * True once this run has bound a media port, which is the moment the harness stops
   * being allowed to ask for another one.
   *
   * **This is the whole of story 12 in one flag.** A real run never passes `mediaPort` at
   * all, so a reopened engine falls through to the port it remembered and republishes the
   * *identical* URL — the only reason SPIKE-2's reattach worked. The scripted harness has
   * to take any free port for its first engine (a fixed 8010 would collide with a real
   * app, or with the previous test file), and it used to pass `mediaPort: 0` to **every**
   * engine it made. `createEngine` resolves `options.mediaPort ?? store.settings.mediaPort`,
   * so that explicit 0 beat the remembered port and the reopened server bound a random
   * one. The television would have been left fetching a URL nobody was answering, and
   * every reattach assertion passed anyway. So: the first engine may choose, and no
   * engine after it may.
   */
  let portChosen = false;

  const makeEngine = (): Engine =>
    createEngine({
      paths,
      logSink: sink,
      logLevel: 'info',
      clock,
      transport: severable.factory,
      ...(overrides?.mdns === undefined ? {} : { mdns: overrides.mdns }),
      ...(overrides?.networkInterfaces === undefined
        ? {}
        : { networkInterfaces: overrides.networkInterfaces }),
      // A real run uses the configured media port, so "port unavailable" is a condition it
      // can actually hit and report as exit 2. Only the scripted harness takes any port,
      // and only for the engine that opens the run.
      ...(overrides === undefined || portChosen ? {} : { mediaPort: 0 }),
      // Only ever set by `--rate`, and `refuseRate` has already refused it for every
      // scenario but `headstart`.
      ...(options.conversionReadRate === undefined
        ? {}
        : { unsafeConversionReadRate: options.conversionReadRate }),
      ...(options.conversionReadRateAfterGate === undefined
        ? {}
        : {
            unsafeConversionReadRate: options.conversionReadRateAfterGate,
            // Enough film converted at full speed to satisfy both halves of the gate, and no
            // more: every extra second here is a second of margin the run has to spend
            // before the guard can fire.
            unsafeConversionReadRateBurstSec: PREPARATION.headStartSeconds + 60,
          }),
    });

  let engine = makeEngine();
  let harness = createHarness(engine, clock, memory);
  activeCleanup = () => shutdown(engine);

  let assertions: Assertion[] = [];
  try {
    await engine.start();
    const engineStartedMono = clock.monoMs();

    if (engine.mediaServerPort === null) {
      throw new SelftestAbort('the media server could not open a port on this machine');
    }

    // Wait for the named device. Never finding it is exit 2, and this is the single
    // check that makes "reported success without a real device" impossible.
    const deviceWaitMs = options.deviceWaitMs ?? SELFTEST.deviceWaitMs;
    const wanted = options.deviceName.trim().toLowerCase();
    const matches = (snapshot: StateSnapshot): boolean =>
      snapshot.discovery.devices.some(
        (device) => device.friendlyName.trim().toLowerCase() === wanted,
      );

    let firstDeviceAtMono = 0;
    const firstDevicePromise = harness
      .waitFor('any device', deviceWaitMs, (snapshot) => snapshot.discovery.devices.length > 0)
      .then((at) => {
        firstDeviceAtMono = at;
        return at;
      })
      .catch(() => 0);

    let deviceFoundAtMono: number;
    try {
      deviceFoundAtMono = await harness.waitFor(
        `device "${options.deviceName}"`,
        deviceWaitMs,
        matches,
      );
    } catch {
      throw new SelftestAbort(
        `no device named "${options.deviceName}" answered within ${String(deviceWaitMs / 1000)} s`,
      );
    }
    await firstDevicePromise;
    if (firstDeviceAtMono === 0) firstDeviceAtMono = deviceFoundAtMono;

    const device = engine
      .snapshot()
      .discovery.devices.find(
        (candidate) => candidate.friendlyName.trim().toLowerCase() === wanted,
      );
    if (device === undefined)
      throw new SelftestAbort('the named device disappeared before the run started');

    // Read out of the engine's own log rather than the snapshot: the address a device
    // lives at is deliberately not part of what the UI knows, and the scenarios that need
    // it — `takeover` and 23c — open a second connection of their own.
    //
    // ⚠️ **Matched to the device under test by id, never "the last one discovered".**
    // Until 2026-09-08 this took `.at(-1)` of every `discovery.device_found`, which in a
    // household with three Chromecasts is whichever set answered mDNS last. 23c's second
    // sender therefore opened its connection to **a different television**: it moved that
    // set's volume, correctly confirmed that set had moved, and returned success — while
    // the app, watching the set under test, correctly reported no change. The run was
    // graded as the app failing 23c on both televisions on 2026-09-08 when the app was
    // innocent both times, and an unrelated set was left at whatever level the leg chose.
    // `discovery.device_updated` is read as well, because a device's address can change
    // after it was first found; only `device_found` carries a port.
    const forDevice = harness
      .records()
      .filter(
        (record) =>
          (record.event === 'discovery.device_found' ||
            record.event === 'discovery.device_updated') &&
          record['deviceId'] === device.id,
      );
    const found = forDevice.at(-1);
    const address = typeof found?.['address'] === 'string' ? found['address'] : undefined;
    // 8009 on every real device; a scripted receiver takes whatever port it was given.
    const portRecord = forDevice.filter((record) => typeof record['port'] === 'number').at(-1);
    const devicePort =
      typeof portRecord?.['port'] === 'number' ? portRecord['port'] : CAST.port;

    // Which run of the scenario is in progress. Outside an aggregate this is whatever the
    // command line asked for and never changes; inside `m3c` each leg sets it.
    let legTiming = options.subtitleTiming === true;
    let legBroken = options.subtitleBroken === true;

    const context: Context = {
      ...harness,
      // `harness` is reassigned by `restart()`, so every method has to go through the
      // current one rather than the one captured when this object was built — and that
      // includes the engine itself. As a plain property it captured the *first* engine,
      // so every `context.engine.dispatch()` after a reattach went to the instance that
      // had just been shut down: `stopAndRelease` stopped nothing, and the television was
      // left playing into the next scenario.
      get engine() {
        return harness.engine;
      },
      mono: () => harness.mono(),
      snapshot: () => harness.snapshot(),
      records: () => harness.records(),
      samples: (event, afterMono) => harness.samples(event, afterMono),
      waitFor: (description, timeoutMs, predicate) =>
        harness.waitFor(description, timeoutMs, predicate),
      waitForState: (state, timeoutMs) => harness.waitForState(state, timeoutMs),
      sleep: (ms) => harness.sleep(ms),
      deviceName: options.deviceName,
      filePath: options.filePath,
      deviceId: device.id,
      deviceAddress: address ?? '',
      devicePort,
      secondConnection: overrides?.transport ?? tlsTransportFactory,
      outage,
      // **Getters, because in an aggregate these change between legs.** `m3c` runs
      // `subtitles` three times — plain, `--timing`, `--broken` — and the scenario reads
      // which run it is from here. As plain properties they would have frozen the value the
      // command line asked for, and all three legs would have run the same (plain) run
      // while the verdict named three: an aggregate reporting a pass for two promises it
      // never tested, which is the exact failure the PRD warns about.
      get subtitleTiming() {
        return legTiming;
      },
      get subtitleBroken() {
        return legBroken;
      },
      withholdTracks: (on) => {
        engine.unsafeWithholdSubtitleTracks(on);
      },
      instruct,
      human: {
        waitMs: options.humanOutage?.waitMs ?? SELFTEST.humanInterventionWaitMs,
        holdMs: options.humanOutage?.holdMs ?? SELFTEST.cableOutageHoldMs,
        // Both detectors get their chance: the 2 s interface poll and the keep-alive,
        // which needs three ping intervals in the worst case because the outage can begin
        // the instant after a PING was answered.
        noticeGraceMs:
          options.humanOutage?.noticeGraceMs ??
          TIMING.pingIntervalMs * (TIMING.pingMissesBeforeDead + 1) +
            TIMING.interfaceWatchMs +
            2_000,
        progressEveryMs: options.humanOutage?.progressEveryMs ?? SELFTEST.cableProgressEveryMs,
      },
      startedAtMono: engineStartedMono,
      deviceFoundAtMono,
      firstDeviceAtMono,
      positionDurationMs: options.positionDurationMs ?? SELFTEST.positionDefaultDurationMs,
      conversionReadRate: options.conversionReadRate ?? null,
      conversionReadRateAfterGate: options.conversionReadRateAfterGate ?? null,
      headStartWatchMs: options.headStartWatchMs ?? null,
      sever: () => severable.sever(),
      deafenHeartbeat: (deaf) => severable.deafenHeartbeat(deaf),
      cutTheRoute(on) {
        // The media server first when taking it away, so the television's byte connection
        // dies while we can still be sure whose it was; last when giving it back, so a
        // reconnecting control channel never finds a route to bytes that is not there yet.
        if (on) {
          const media = engine.unsafeMediaBlackout(true);
          return { control: severable.partition(true), media };
        }
        const control = severable.partition(false);
        return { control, media: engine.unsafeMediaBlackout(false) };
      },
      async restart() {
        // The founder closes the window mid-film. The television keeps playing, the media
        // server dies with the app, and the only thing that survives is the settings file.
        await engine.stop({ keepPlaying: true });
        portChosen = true;
        engine = makeEngine();
        harness = createHarness(engine, clock, memory);
        activeCleanup = () => shutdown(engine);
        await engine.start();
      },
    };

    const order: readonly AggregateLeg[] =
      options.scenario === 'm1'
        ? ['discovery', 'cast', 'transport', 'position'].map((name) =>
            plainLeg(name as AggregateMember),
          )
        : options.scenario === 'm2'
          ? M2_ORDER.map(plainLeg)
          : options.scenario === 'm3'
            ? M3_ORDER.map(plainLeg)
            : options.scenario === 'm3c'
              ? M3C_ORDER
              : options.scenario === 'm5'
                ? M5_ORDER
                : // **A scenario asked for on its own is the run the command line asked for**,
                  // flags and all — `plainLeg` would hard-code both variants to false and turn
                  // `--scenario subtitles --timing` back into the plain run. It did exactly that
                  // for one commit, and the two standalone subtitle tests were the only thing
                  // that noticed: a variant degrading silently into the ordinary run is the same
                  // class of false green this aggregate exists to prevent.
                  [
                    {
                      scenario: options.scenario,
                      label: options.scenario,
                      subtitleTiming: options.subtitleTiming === true,
                      subtitleBroken: options.subtitleBroken === true,
                    },
                  ];
    const aggregate = AGGREGATES.includes(options.scenario as Aggregate);

    // Everything an aggregate could abort *inside* is checked here, before the first
    // scenario runs. See `preflight`.
    if (aggregate) await preflight(context, order);

    /**
     * Which legs actually produced a promise, so that a leg cannot go missing in silence.
     *
     * **This is the structural half of the exit-code contract.** A leg that aborts already
     * takes the whole run to exit 2, so it cannot be skipped quietly — but a leg that ran
     * and measured *nothing* would simply not appear, and an aggregate whose verdict is
     * every promise the legs that ran happened to make is the shape the PRD warns about:
     * an `m2` "that ran only the scenarios that existed would have exited 0 and been read
     * as" a pass. Checked after the loop, so reaching 0 requires every leg named in the
     * order to have been run and to have promised something.
     */
    const legsThatPromised = new Set<string>();

    for (const leg of order) {
      legTiming = leg.subtitleTiming;
      legBroken = leg.subtitleBroken;
      const runner = RUNNERS[leg.scenario];
      // 13g. Counted **before** the scenario so a refusal left behind by the previous leg
      // of an aggregate cannot condemn this one: each leg answers for its own corpse.
      const refusalsBefore = context.samples(REFUSED_MID_PLAY).length;
      const produced = await runner(context);
      const guarded = withRefusalGuard(
        produced,
        context.samples(REFUSED_MID_PLAY).slice(refusalsBefore),
      );
      if (guarded.some((item) => item.kind === 'promise')) legsThatPromised.add(leg.label);
      assertions = assertions.concat(
        aggregate
          ? guarded.map((item) => ({ ...item, name: `${leg.label}.${item.name}` }))
          : guarded,
      );
    }

    if (aggregate) {
      for (const leg of order) {
        if (legsThatPromised.has(leg.label)) continue;
        assertions = assertions.concat(
          assertion(
            `${leg.label}.scenarioRanAndPromisedSomething`,
            'eq',
            'ran',
            'promised nothing',
            'scenario',
            `PRD 13: this aggregate is only a pass when every scenario in it ran and kept its promises. “${leg.label}” produced no promise at all, so there is nothing here that could have passed — and a verdict made of the legs that happened to speak up would be read as the whole run`,
          ),
        );
      }
    }
  } catch (error) {
    if (error instanceof SelftestAbort) {
      activeCleanup = null;
      await shutdown(engine);
      return await publish(
        paths,
        verdict('could-not-run', 2, assertions, error.message, engine, startedMono),
      );
    }
    activeCleanup = null;
    await shutdown(engine);
    return await publish(
      paths,
      verdict(
        'failed',
        1,
        assertions.concat(
          assertion(
            'runCompleted',
            'eq',
            'yes',
            'no',
            'bool',
            error instanceof Error ? error.message : String(error),
          ),
        ),
        null,
        engine,
        startedMono,
      ),
    );
  }

  // 13e: whatever happened, the TV is not left playing.
  activeCleanup = null;
  await shutdown(engine);
  // Observations are reported, not graded: only promises decide the exit code.
  const promises = assertions.filter((item) => item.kind === 'promise');
  const passed = promises.length > 0 && promises.every((item) => item.passed);
  return await publish(
    paths,
    verdict(passed ? 'passed' : 'failed', passed ? 0 : 1, assertions, null, engine, startedMono),
  );
}

async function shutdown(engine: Engine): Promise<void> {
  try {
    // 13e: a stop goes out whatever happened, and the socket is held open long enough for
    // it to reach the television — a selftest that leaves a TV playing is one nobody runs
    // twice. **Unless nothing was ever cast.** A run that aborted before it reached a
    // device has an idle session and no television to release, and the two seconds it used
    // to spend waiting for the answer to a message it never sent were pure delay: on every
    // exit-2 path, and fourteen times over in the suite's own "no device, no pass" sweep.
    const live = engine.snapshot().session.state !== 'idle';
    engine.dispatch({ type: 'cast.stop' });
    if (live) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, TIMING.optimisticWindowMs);
        timer.unref?.();
      });
    }
    await engine.stop();
  } catch {
    // Shutdown must not change the verdict. The stop intent has already been sent.
  }
}

/**
 * Saves the verdict next to the engine log (13a) and records in the verdict itself whether
 * that worked. Every exit from `runSelftest` goes through here — including the ones that
 * could not run, which are exactly the runs with nothing else left behind to read. The
 * missing-file exit used to return without ever calling this, so the founder was told a
 * file had been written next to the engine log when nothing had.
 */
async function publish(paths: AppPaths, result: SelftestVerdict): Promise<SelftestVerdict> {
  const stamp = result.startedAt.replace(/[:.]/g, '-');
  // The variant is in the file name as well as inside the file: a folder of verdicts is read
  // by eye far more often than by machine, and two `headstart` runs that assert opposite
  // things must not look like two attempts at the same one.
  const name = result.variant === null ? result.scenario : `${result.scenario}-${result.variant}`;
  const file = path.join(paths.logDir, `selftest-${name}-${stamp}.json`);
  const withPath: SelftestVerdict = {
    ...result,
    environment: { ...result.environment, verdictFile: file },
  };
  try {
    await fsp.mkdir(paths.logDir, { recursive: true });
    await fsp.writeFile(file, JSON.stringify(withPath, null, 2) + '\n', 'utf8');
    return withPath;
  } catch {
    // The verdict still goes to stdout; a log directory we cannot write to is not a reason
    // to lose the run's result. But it must not then claim the file is there.
    return { ...result, environment: { ...result.environment, verdictFile: null } };
  }
}

/** Names the likeliest cause rather than restating the path back at whoever typed it. */
function fileNotFound(filePath: string): string {
  const looksLikeWsl = filePath.startsWith('/mnt/') || filePath.startsWith('/home/');
  const hint =
    looksLikeWsl && process.platform === 'win32'
      ? ' — that is a WSL path and the selftest runs on Windows, so pass the Windows form of it (C:\\Users\\...)'
      : '';
  return `file not found: ${filePath}${hint}`;
}
