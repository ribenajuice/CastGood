import path from 'node:path';
import { CAST } from '../config.js';
import { tlsTransportFactory } from '../cast/index.js';
import { contentTypeFor, createMediaServer, type MediaServer } from '../media-server/index.js';
import {
  NS_CONNECTION,
  NS_MEDIA,
  NS_RECEIVER,
  PLATFORM_RECEIVER,
  SpikeAbort,
  finding,
  openSession,
  readMedia,
  readReceiver,
  type Finding,
  type MediaSnapshot,
  type Session,
  type Wire,
} from './m2.js';
import type { Json } from './m3.js';
import {
  combineSinks,
  createFileSink,
  createLogger,
  createMemorySink,
  systemClock,
  type Logger,
} from '../logging/index.js';
import { resolveAppPaths } from '../paths.js';

/**
 * SPIKE-5 — **whose volume is it, and does the television actually move it?**
 * THROWAWAY, like everything else in this directory.
 *
 * ⚠️ **This is an observation tool, not a test.** It asserts nothing and promises nothing.
 * It records what one television did, in that television's own numbers, with the wire trace
 * beside them. It has no pass, so it does **not** use the selftest's pass/fail exit-code
 * contract (`scripts/win-test.sh`) — see the exit codes below, which are only ever about
 * whether a reading was *taken*.
 *
 * M5a's build order puts it at step 0, before any feature code, because story 23's whole
 * premise — *"volume is native to the Cast protocol"* — is true of the protocol and not
 * necessarily of a television. The founder's main set is an **`AI PONT`**, a television with
 * Cast built in, which may route volume through its own amplifier or HDMI-CEC and may
 * refuse, clamp or quantise what we send. Six questions, from the PRD:
 *
 *  1. What does this set's `volume` object actually contain — `controlType`
 *     (`attenuation` / `fixed` / `master`) and `stepInterval`, and what are they?
 *  2. Does a **receiver-namespace** `SET_VOLUME` change what the set outputs, and is the
 *     echoed level the one we asked for, **clamped**, or **quantised**?
 *  3. Is there a separate **media-namespace stream volume**, do the two interact — and
 *     **which of the two does the television's own remote move?**
 *  4. **Round trip**, per device: command → echoed status, measured. This is what turns
 *     story 23's 500 ms into a target, or into a different number.
 *  5. Does an **external** change arrive as an unsolicited status within 2 s, or only on a
 *     poll? This one decides whether 23c is buildable at all.
 *  6. Is **mute independent of level**, and does unmute restore the room by itself? 23f's
 *     "we remember nothing" rests entirely on yes.
 *
 * ⚠️ **THE VOLUME BELONGS TO THE TELEVISION, NOT TO US.** Whatever level and mute this
 * spike finds are put back on **every** exit path, including a Ctrl-C — see
 * `restoreFoundVolume`. A level we changed outlives our process, and the founder's
 * household has to live with it.
 *
 * **Never report a measurement that did not happen.** A set that refuses a volume, a leg
 * with no human in the room, a film that would not play: each is named in `unmeasured` and
 * the exit code says so.
 *
 * EXIT CODES (see `m5a-cli.ts`)
 *   0  every leg asked for produced its reading
 *   2  the run could not happen at all — wrong OS, no such device, unplayable file
 *   3  it ran, but at least one leg could not be measured; `unmeasured` names each one
 */

// --- What a `volume` object is, read rather than assumed -----------------------

export interface VolumeObject {
  readonly level: number | null;
  readonly muted: boolean | null;
  /** `attenuation`, `fixed`, `master` — or `null` when the set does not say. */
  readonly controlType: string | null;
  readonly stepInterval: number | null;
  /** The object exactly as it came off the wire. The deliverable, not a debugging aid. */
  readonly raw: string;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * The `volume` object out of a **receiver** status payload.
 *
 * Pure, and exported so the parsing is checked in WSL against captured payloads instead of
 * being discovered to be wrong on a sofa. `raw` is kept verbatim: question 1 asks what the
 * object *contains*, and a parser that only picks out four fields cannot answer that — the
 * fields nobody expected are exactly the interesting ones.
 */
export function readReceiverVolume(payload: unknown): VolumeObject {
  const volume = asRecord(asRecord(asRecord(payload)['status'])['volume']);
  return {
    level: numberOrNull(volume['level']),
    muted: typeof volume['muted'] === 'boolean' ? volume['muted'] : null,
    controlType: typeof volume['controlType'] === 'string' ? volume['controlType'] : null,
    stepInterval: numberOrNull(volume['stepInterval']),
    raw: JSON.stringify(volume),
  };
}

/** The `volume` object out of a **media** status payload — the stream volume, if it exists. */
export function readStreamVolume(payload: unknown): VolumeObject | null {
  const statuses = asRecord(payload)['status'];
  const first = Array.isArray(statuses) ? asRecord(statuses[0]) : {};
  if (!('volume' in first)) return null;
  const volume = asRecord(first['volume']);
  return {
    level: numberOrNull(volume['level']),
    muted: typeof volume['muted'] === 'boolean' ? volume['muted'] : null,
    controlType: typeof volume['controlType'] === 'string' ? volume['controlType'] : null,
    stepInterval: numberOrNull(volume['stepInterval']),
    raw: JSON.stringify(volume),
  };
}

// --- What came back when we asked for a level ---------------------------------

export type EchoKind =
  'exact' | 'quantised' | 'clamped-low' | 'clamped-high' | 'ignored' | 'not-echoed';

export interface LadderStep {
  readonly requested: number;
  readonly echoed: number | null;
  /** What the set was at before this rung — how "ignored" is told from "exact". */
  readonly previous: number | null;
  /** Command → echoed status, in ms. Question 4, and the number 500 ms becomes or does not. */
  readonly roundTripMs: number | null;
  /** The level a second and a half later: a set that ramps settles somewhere else. */
  readonly settledLevel: number | null;
  readonly kind: EchoKind;
}

/**
 * **Was the level we got the level we asked for?** Pure, and the heart of question 2.
 *
 * The four wrong answers are all different products: a set that *ignores* us needs story
 * 23h's disabled control; one that *clamps* needs a bounded slider; one that *quantises*
 * needs a slider the mockup shows snapping; one that never echoes at all leaves 4c with
 * nothing to render, which is worse than any of them.
 */
export function classifyEcho(
  requested: number,
  echoed: number | null,
  previous: number | null,
  tolerance = 0.005,
): EchoKind {
  if (echoed === null) return 'not-echoed';
  const wanted = Math.min(1, Math.max(0, requested));
  if (
    previous !== null &&
    Math.abs(echoed - previous) <= tolerance &&
    Math.abs(wanted - previous) > tolerance
  ) {
    return 'ignored';
  }
  if (requested < 0 && echoed <= tolerance) return 'clamped-low';
  if (requested > 1 && echoed >= 1 - tolerance) return 'clamped-high';
  if (Math.abs(echoed - wanted) <= tolerance) return 'exact';
  return 'quantised';
}

/**
 * The smallest step this television was ever seen to move in.
 *
 * `stepInterval` is what the set *claims*; this is what it *did*. They have no obligation
 * to agree, and where they disagree the mockup follows this one.
 */
export function inferStep(levels: readonly number[], tolerance = 0.0005): number | null {
  const distinct = [...new Set(levels.map((level) => Math.round(level * 10_000) / 10_000))].sort(
    (a, b) => a - b,
  );
  if (distinct.length < 2) return null;
  let smallest: number | null = null;
  for (let index = 1; index < distinct.length; index += 1) {
    const a = distinct[index];
    const b = distinct[index - 1];
    if (a === undefined || b === undefined) continue;
    const gap = a - b;
    if (gap > tolerance && (smallest === null || gap < smallest)) smallest = gap;
  }
  return smallest;
}

/** One sentence a future session can quote about how this set answers a level. */
export function describeLadder(steps: readonly LadderStep[]): string {
  if (steps.length === 0) return 'no rung of the ladder was sent — nothing was measured';
  const kinds = steps.reduce<Record<string, number>>((counts, step) => {
    counts[step.kind] = (counts[step.kind] ?? 0) + 1;
    return counts;
  }, {});
  const trips = steps
    .map((step) => step.roundTripMs)
    .filter((value): value is number => value !== null);
  const step = inferStep(
    steps.map((entry) => entry.echoed).filter((value): value is number => value !== null),
  );
  const roundTrip =
    trips.length === 0
      ? 'no round trip was measured'
      : `round trip ${String(Math.round(Math.min(...trips)))}–${String(Math.round(Math.max(...trips)))} ms (median ${String(
          Math.round([...trips].sort((a, b) => a - b)[Math.floor(trips.length / 2)] ?? 0),
        )} ms) over ${String(trips.length)} rung(s)`;
  return `${Object.entries(kinds)
    .map(([kind, count]) => `${String(count)}× ${kind}`)
    .join(
      ', ',
    )} · ${roundTrip} · smallest observed step ${step === null ? 'not determinable from these rungs' : step.toFixed(4)}`;
}

// --- The run's shape ----------------------------------------------------------

export const LEGS = [
  'volume-object',
  'set-level',
  'stream-volume',
  'external',
  'remote',
  'mute',
] as const;
export type LegName = (typeof LEGS)[number];

export interface LegResult {
  readonly leg: string;
  readonly ran: boolean;
  readonly note: string | null;
  readonly findings: readonly Finding[];
}

export interface SpikeM5aOptions {
  readonly address: string;
  readonly port: number;
  /** A film this set plays natively. Sound is the point: question 2 is answered by an ear. */
  readonly filePath: string;
  /** Nothing louder than this is ever asked for. The founder's household hears the ladder. */
  readonly maxLevel: number;
  /** Opt in to asking for a level ABOVE 1.0. It can set the room to maximum. */
  readonly testUpperClamp: boolean;
  /** How long to watch, without polling, for a change made from a second connection. */
  readonly externalWaitMs: number;
  /** How long to wait for a person with the television's own remote. 0 skips that leg. */
  readonly remoteWaitMs: number;
  readonly settleMs: number;
  readonly legs: readonly LegName[];
  readonly logger: Logger;
  /** Injected by tests; the default writes the human prompts to stderr. */
  readonly prompt?: (text: string) => void;
}

export interface ExternalReading {
  readonly changedTo: number | null;
  /** How long until an UNSOLICITED receiver status carrying the new level arrived. */
  readonly unsolicitedAfterMs: number | null;
  /** What a poll saw after the window closed, when nothing was announced. */
  readonly pollSawLevel: number | null;
  readonly pollAfterMs: number | null;
  readonly note: string;
}

export interface RemoteReading {
  readonly asked: boolean;
  readonly receiverLevelBefore: number | null;
  readonly receiverLevelAfter: number | null;
  readonly streamLevelBefore: number | null;
  readonly streamLevelAfter: number | null;
  readonly unsolicitedAfterMs: number | null;
  readonly moved: 'receiver' | 'stream' | 'both' | 'neither' | 'unknown';
  readonly note: string;
}

export interface MuteReading {
  readonly levelBefore: number | null;
  readonly mutedEchoed: boolean | null;
  readonly levelWhileMuted: number | null;
  readonly muteRoundTripMs: number | null;
  readonly unmutedEchoed: boolean | null;
  readonly levelAfterUnmute: number | null;
  readonly unmuteRoundTripMs: number | null;
  readonly independent: boolean | null;
}

export interface RestoreOutcome {
  readonly attempted: boolean;
  readonly restored: boolean;
  readonly askedLevel: number | null;
  readonly askedMuted: boolean | null;
  readonly echoedLevel: number | null;
  readonly echoedMuted: boolean | null;
  readonly note: string;
}

export interface SpikeM5aReport {
  readonly legs: readonly LegResult[];
  readonly volumeAtStart: VolumeObject | null;
  readonly ladder: readonly LadderStep[];
  readonly streamVolume: {
    readonly exists: boolean;
    readonly beforeRaw: string | null;
    readonly afterRaw: string | null;
    readonly receiverLevelAfterStreamSet: number | null;
    readonly requested: number | null;
    readonly echoed: number | null;
    readonly roundTripMs: number | null;
  } | null;
  readonly external: ExternalReading | null;
  readonly remote: RemoteReading | null;
  readonly mute: MuteReading | null;
  readonly playback: {
    readonly advancedSecDuringLadder: number | null;
    readonly bufferingSamples: number;
    readonly states: Record<string, number>;
  } | null;
  readonly restore: RestoreOutcome;
  readonly unmeasured: readonly string[];
  readonly wire: readonly Wire[];
}

// --- Putting the television back where we found it -----------------------------

interface PendingRestore {
  session: Session;
  readonly level: number | null;
  readonly muted: boolean | null;
  readonly logger: Logger;
  readonly address: string;
  readonly port: number;
}

let pendingRestore: PendingRestore | null = null;

/**
 * **Put the level and the mute back, on every exit path there is.**
 *
 * Called from the run's `finally` and from the CLI's signal handlers. Idempotent, because
 * both will fire when a founder presses Ctrl-C during a normal run.
 *
 * If our socket has died in the meantime it opens a **fresh one** rather than shrugging: a
 * spike that leaves a television at 10% because its own connection dropped has changed the
 * founder's house, and no finding is worth that.
 */
export async function restoreFoundVolume(): Promise<RestoreOutcome> {
  const target = pendingRestore;
  pendingRestore = null;
  if (target === null) {
    return {
      attempted: false,
      restored: false,
      askedLevel: null,
      askedMuted: null,
      echoedLevel: null,
      echoedMuted: null,
      note: 'nothing to restore — the run never read a starting volume, so it never changed one',
    };
  }
  const { level, muted } = target;
  try {
    let session = target.session;
    if (session.closed) {
      session = await openSession({
        address: target.address,
        port: target.port,
        logger: target.logger,
        label: 'spike5-restore',
        transport: tlsTransportFactory,
      });
    }
    const volume: Json = {
      ...(level === null ? {} : { level }),
      ...(muted === null ? {} : { muted }),
    };
    const response = await session.request(
      NS_RECEIVER,
      PLATFORM_RECEIVER,
      { type: 'SET_VOLUME', volume },
      CAST.requestTimeoutMs,
    );
    const echoed = readReceiverVolume(response);
    const levelOk =
      level === null || (echoed.level !== null && Math.abs(echoed.level - level) <= 0.02);
    const mutedOk = muted === null || echoed.muted === muted;
    return {
      attempted: true,
      restored: levelOk && mutedOk,
      askedLevel: level,
      askedMuted: muted,
      echoedLevel: echoed.level,
      echoedMuted: echoed.muted,
      note:
        levelOk && mutedOk
          ? 'the television is back at the level and mute this spike found it at'
          : '⚠️ THE TELEVISION DID NOT CONFIRM THE RESTORE. Check the set by hand — its volume may not be where this spike found it.',
    };
  } catch (error) {
    return {
      attempted: true,
      restored: false,
      askedLevel: level,
      askedMuted: muted,
      echoedLevel: null,
      echoedMuted: null,
      note:
        '⚠️ THE RESTORE FAILED: ' +
        (error instanceof Error ? error.message : String(error)) +
        '. Check the television by hand — its volume may not be where this spike found it.',
    };
  }
}

// --- Small helpers -------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mono(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function receiverVolume(session: Session): Promise<VolumeObject> {
  const response = await session.request(
    NS_RECEIVER,
    PLATFORM_RECEIVER,
    { type: 'GET_STATUS' },
    CAST.requestTimeoutMs,
  );
  return readReceiverVolume(response);
}

interface SetVolumeOutcome {
  readonly echoed: VolumeObject;
  readonly roundTripMs: number;
}

async function setReceiverVolume(session: Session, volume: Json): Promise<SetVolumeOutcome> {
  const began = mono();
  const response = await session.request(
    NS_RECEIVER,
    PLATFORM_RECEIVER,
    { type: 'SET_VOLUME', volume },
    CAST.requestTimeoutMs,
  );
  return { echoed: readReceiverVolume(response), roundTripMs: mono() - began };
}

/**
 * Levels to ask for, and **why each one is in the list**.
 *
 * Bounded by `maxLevel` because a spike that shouts is a spike the household bans. The odd
 * values are the instrument: `0.37` and `0.055` are nowhere near any plausible grid, so a
 * set that quantises has to reveal it.
 */
export function ladderFor(maxLevel: number, testUpperClamp: boolean): number[] {
  const rungs = [0.1, 0.2, 0.3, 0.37, 0.055, 0.25].filter((level) => level <= maxLevel);
  // The low clamp is free and silent. The high one is not, so it is opt-in.
  rungs.push(-0.25);
  if (testUpperClamp) rungs.push(1.5);
  return rungs;
}

// --- The run -------------------------------------------------------------------

export async function probeVolume(options: SpikeM5aOptions): Promise<SpikeM5aReport> {
  const { logger } = options;
  const prompt = options.prompt ?? ((text: string) => process.stderr.write(text));
  const legs: LegResult[] = [];
  const unmeasured: string[] = [];
  const media: MediaServer = createMediaServer({ logger });
  await media.start();

  let session: Session | null = null;
  let volumeAtStart: VolumeObject | null;
  const ladder: LadderStep[] = [];
  let streamVolume: SpikeM5aReport['streamVolume'] = null;
  let external: ExternalReading | null = null;
  let remote: RemoteReading | null;
  let muteReading: MuteReading | null = null;
  let playback: SpikeM5aReport['playback'] = null;

  try {
    session = await openSession({
      address: options.address,
      port: options.port,
      logger,
      label: 'spike5',
      transport: tlsTransportFactory,
    });
    const live = session;
    const local = live.localAddress;

    // ---- Question 1: what the volume object actually contains ---------------
    // Read FIRST, before anything is launched or loaded, and remembered for the restore.
    volumeAtStart = await receiverVolume(live);
    pendingRestore = {
      session: live,
      level: volumeAtStart.level,
      muted: volumeAtStart.muted,
      logger,
      address: options.address,
      port: options.port,
    };
    logger.info('spike5.volume_at_start', {
      raw: volumeAtStart.raw,
      controlType: volumeAtStart.controlType,
      stepInterval: volumeAtStart.stepInterval,
    });
    legs.push({
      leg: 'volume-object',
      ran: true,
      note: null,
      findings: [
        finding(
          "What does this television's `volume` object actually contain? (question 1)",
          `level ${volumeAtStart.level === null ? 'absent' : volumeAtStart.level.toFixed(4)}, ` +
            `muted ${volumeAtStart.muted === null ? 'absent' : String(volumeAtStart.muted)}, ` +
            `controlType ${volumeAtStart.controlType ?? 'ABSENT — the set does not say'}, ` +
            `stepInterval ${volumeAtStart.stepInterval === null ? 'ABSENT' : volumeAtStart.stepInterval.toFixed(4)}. ` +
            `Raw: ${volumeAtStart.raw}` +
            (volumeAtStart.controlType === 'fixed'
              ? ' ⚠️ **`fixed` means the television owns its volume and we may not set it.** This is the case story 23h exists for, and the founder must see it before any feature code.'
              : ''),
          {
            raw: volumeAtStart.raw,
            level: volumeAtStart.level,
            muted: volumeAtStart.muted,
            controlType: volumeAtStart.controlType,
            stepInterval: volumeAtStart.stepInterval,
          },
        ),
      ],
    });
    if (volumeAtStart.level === null) {
      unmeasured.push(
        'volume-object: the television reported no level at all, so every later number here is about a control we cannot even read',
      );
    }

    // ---- A film, because sound is what question 2 is really about ------------
    const receiver = await (async () => {
      const launch = await live.request(
        NS_RECEIVER,
        PLATFORM_RECEIVER,
        { type: 'LAUNCH', appId: CAST.defaultReceiverAppId },
        CAST.launchTimeoutMs,
      );
      return readReceiver(launch, mono());
    })();
    if (receiver.transportId === null) {
      throw new SpikeAbort('the device did not launch the Default Media Receiver');
    }
    const transportId = receiver.transportId;
    live.send(NS_CONNECTION, transportId, { type: 'CONNECT', userAgent: 'CastGood-spike5' });

    const mount = media.mount({ path: options.filePath, kind: 'file' });
    const url = media.urlFor(mount, local);
    const loadResponse = await live.request(
      NS_MEDIA,
      transportId,
      {
        type: 'LOAD',
        ...(receiver.sessionId === null ? {} : { sessionId: receiver.sessionId }),
        media: {
          contentId: url,
          contentType: contentTypeFor(options.filePath),
          streamType: 'BUFFERED',
          metadata: { metadataType: 0, title: path.basename(options.filePath) },
        },
        autoplay: true,
        currentTime: 0,
      },
      CAST.launchTimeoutMs,
    );
    const loaded = readMedia(loadResponse, mono());
    if (loaded === null || loaded.mediaSessionId === null) {
      throw new SpikeAbort(
        'the television refused the film (no media session came back). Volume with nothing playing ' +
          'is a different question from the one M5a asks — pass a film this set plays natively.',
      );
    }
    const mediaSessionId = loaded.mediaSessionId;

    const mediaStatus = async (): Promise<{
      snapshot: MediaSnapshot | null;
      stream: VolumeObject | null;
    }> => {
      const response = await live.request(
        NS_MEDIA,
        transportId,
        { type: 'GET_STATUS', mediaSessionId },
        10_000,
      );
      return { snapshot: readMedia(response, mono()), stream: readStreamVolume(response) };
    };

    // The film must actually be playing, or nothing below is about sound in a room.
    const settleDeadline = mono() + options.settleMs;
    const states: Record<string, number> = {};
    let firstSample: MediaSnapshot | null = null;
    while (mono() < settleDeadline) {
      const { snapshot } = await mediaStatus();
      if (snapshot !== null) {
        firstSample ??= snapshot;
        states[snapshot.playerState ?? 'UNKNOWN'] =
          (states[snapshot.playerState ?? 'UNKNOWN'] ?? 0) + 1;
      }
      await sleep(1_000);
    }
    if ((states['PLAYING'] ?? 0) === 0) {
      throw new SpikeAbort(
        `the television reported ${JSON.stringify(states)} and never PLAYING — there is no sound in ` +
          'the room, so nothing here could be a fact about volume.',
      );
    }
    prompt(
      "\n  >>> LISTEN NOW. The next half-minute moves this television's volume up and down.\n" +
        '      Only your ears can answer question 2: did the SOUND change, not just the number? <<<\n\n',
    );

    // ---- Questions 2 and 4: a ladder of levels, and the round trip -----------
    if (options.legs.includes('set-level')) {
      const before = await mediaStatus();
      const rungs = ladderFor(options.maxLevel, options.testUpperClamp);
      // Sampled DURING the ladder, not before it: 23e is about what twenty volume changes
      // do to a running film, and states collected while the film was settling would be an
      // instrument answering a question nobody asked.
      const ladderStates: Record<string, number> = {};
      let previous = volumeAtStart.level;
      for (const requested of rungs) {
        let echoed: VolumeObject | null = null;
        let roundTripMs: number | null = null;
        try {
          const outcome = await setReceiverVolume(live, { level: requested });
          echoed = outcome.echoed;
          roundTripMs = outcome.roundTripMs;
        } catch (error) {
          logger.warn('spike5.set_volume_failed', {
            requested,
            message: error instanceof Error ? error.message : String(error),
          });
        }
        // A set that ramps answers immediately and arrives later. Both are recorded.
        await sleep(1_500);
        const during = await mediaStatus().catch(() => null);
        const state = during?.snapshot?.playerState ?? 'UNREADABLE';
        ladderStates[state] = (ladderStates[state] ?? 0) + 1;
        const settled = await receiverVolume(live).catch(() => null);
        const step: LadderStep = {
          requested,
          echoed: echoed?.level ?? null,
          previous,
          roundTripMs,
          settledLevel: settled?.level ?? null,
          kind: classifyEcho(requested, echoed?.level ?? null, previous),
        };
        ladder.push(step);
        logger.info('spike5.ladder', { ...step });
        previous = settled?.level ?? echoed?.level ?? previous;
      }

      const after = await mediaStatus();
      playback = {
        advancedSecDuringLadder:
          before.snapshot?.currentTime == null || after.snapshot?.currentTime == null
            ? null
            : after.snapshot.currentTime - before.snapshot.currentTime,
        bufferingSamples: ladderStates['BUFFERING'] ?? 0,
        states: ladderStates,
      };

      const refused = ladder.every((step) => step.kind === 'ignored' || step.kind === 'not-echoed');
      legs.push({
        leg: 'set-level',
        ran: true,
        note: null,
        findings: [
          finding(
            'Does a receiver-namespace SET_VOLUME change this set, and is the echoed level ours, clamped, or quantised? (questions 2 and 4)',
            refused
              ? '**THIS TELEVISION WILL NOT TAKE A VOLUME FROM US.** Every rung was ignored or never echoed: ' +
                  describeLadder(ladder) +
                  " — story 23h's disabled control is this set's product, and the founder must see that before feature code."
              : describeLadder(ladder),
            { ladder: ladder.map((step) => ({ ...step })), refused },
          ),
          finding(
            'Did moving the volume disturb the film? (23e, observed rather than promised)',
            playback.advancedSecDuringLadder === null
              ? 'not measurable — the television reported no position on one side of the ladder'
              : `the position advanced ${playback.advancedSecDuringLadder.toFixed(1)} s across ${String(ladder.length)} volume changes; ` +
                  `${String(playback.bufferingSamples)} BUFFERING sample(s) during them; states ${JSON.stringify(ladderStates)}`,
            {
              advancedSec: playback.advancedSecDuringLadder,
              bufferingSamples: playback.bufferingSamples,
              statesDuringLadder: ladderStates,
              statesWhileSettling: states,
            },
          ),
        ],
      });
      if (refused) {
        unmeasured.push(
          'set-level: this television did not take a level from us, so the round trip, the clamping and the quantisation could not be measured at all (this is a finding about the set — see the summary — not a broken run)',
        );
      }
      if (!options.testUpperClamp) {
        unmeasured.push(
          'set-level: the UPPER clamp was not tested, deliberately — asking for 1.5 can set the room to maximum. Re-run with --upper-clamp if that reading is wanted.',
        );
      }
    } else {
      legs.push({
        leg: 'set-level',
        ran: false,
        note: 'not asked for',
        findings: [],
      });
      unmeasured.push('set-level: not asked for on this run');
    }

    // ---- Question 3a: is there a stream volume, and do the two interact? -----
    if (options.legs.includes('stream-volume')) {
      const before = await mediaStatus();
      if (before.stream === null) {
        legs.push({
          leg: 'stream-volume',
          ran: true,
          note: null,
          findings: [
            finding(
              'Is there a separate media-namespace stream volume? (question 3)',
              "NO — this television's media status carries no `volume` object at all, so there is only one number to control and it is the receiver's.",
              { mediaStatusHasVolume: false },
            ),
          ],
        });
        streamVolume = {
          exists: false,
          beforeRaw: null,
          afterRaw: null,
          receiverLevelAfterStreamSet: null,
          requested: null,
          echoed: null,
          roundTripMs: null,
        };
      } else {
        const receiverBefore = await receiverVolume(live);
        const requested = Math.min(options.maxLevel, 0.6);
        const began = mono();
        let echoedStream: VolumeObject | null = null;
        try {
          const response = await live.request(
            NS_MEDIA,
            transportId,
            {
              type: 'VOLUME',
              mediaSessionId,
              volume: { level: requested, muted: false },
            },
            CAST.requestTimeoutMs,
          );
          echoedStream = readStreamVolume(response);
        } catch (error) {
          logger.warn('spike5.stream_volume_failed', {
            message: error instanceof Error ? error.message : String(error),
          });
        }
        const roundTripMs = mono() - began;
        await sleep(1_500);
        const after = await mediaStatus();
        const receiverAfter = await receiverVolume(live);
        streamVolume = {
          exists: true,
          beforeRaw: before.stream.raw,
          afterRaw: after.stream?.raw ?? null,
          receiverLevelAfterStreamSet: receiverAfter.level,
          requested,
          echoed: echoedStream?.level ?? after.stream?.level ?? null,
          roundTripMs: echoedStream === null ? null : roundTripMs,
        };
        const receiverMoved =
          receiverBefore.level !== null &&
          receiverAfter.level !== null &&
          Math.abs(receiverAfter.level - receiverBefore.level) > 0.005;
        legs.push({
          leg: 'stream-volume',
          ran: true,
          note: null,
          findings: [
            finding(
              'Is there a separate media-namespace stream volume, and do the two interact? (question 3)',
              `YES — the media status carries ${before.stream.raw}. Asked it for ${requested.toFixed(2)}: ` +
                `it echoed ${streamVolume.echoed === null ? 'nothing' : streamVolume.echoed.toFixed(4)} in ` +
                `${streamVolume.roundTripMs === null ? 'n/a' : String(Math.round(streamVolume.roundTripMs)) + ' ms'}; ` +
                `the RECEIVER level went ${receiverBefore.level?.toFixed(4) ?? 'null'} → ${receiverAfter.level?.toFixed(4) ?? 'null'} ` +
                `(${receiverMoved ? 'the two are linked' : 'they are independent numbers'}).`,
              {
                streamBefore: before.stream.raw,
                streamAfter: after.stream?.raw ?? null,
                receiverBefore: receiverBefore.level,
                receiverAfter: receiverAfter.level,
                linked: receiverMoved,
              },
            ),
          ],
        });
      }
    } else {
      legs.push({ leg: 'stream-volume', ran: false, note: 'not asked for', findings: [] });
      unmeasured.push('stream-volume: not asked for on this run');
    }

    // ---- Question 5: does an external change ARRIVE, or must we poll? --------
    if (options.legs.includes('external')) {
      const beforeLevel = (await receiverVolume(live)).level;
      const target =
        beforeLevel === null
          ? Math.min(0.2, options.maxLevel)
          : Math.min(options.maxLevel, Math.max(0.05, beforeLevel > 0.2 ? 0.1 : 0.3));
      const thief = await openSession({
        address: options.address,
        port: options.port,
        logger,
        label: 'spike5-second-connection',
        transport: tlsTransportFactory,
      });
      try {
        const mark = mono();
        await thief
          .request(
            NS_RECEIVER,
            PLATFORM_RECEIVER,
            { type: 'SET_VOLUME', volume: { level: target } },
            CAST.requestTimeoutMs,
          )
          .catch(() => undefined);

        // **Not one poll in this window.** The whole question is whether the television
        // tells us without being asked; a GET_STATUS here would answer our own question
        // with our own request and 23c would be built on it.
        await sleep(options.externalWaitMs);
        const announced = live
          .since(mark)
          .filter((frame) => frame.namespace === NS_RECEIVER && frame.data.includes('"volume"'))
          .find((frame) => {
            const level = readReceiverVolume(JSON.parse(frame.data) as unknown).level;
            return level !== null && Math.abs(level - target) <= 0.02;
          });
        const pollBegan = mono();
        const polled = await receiverVolume(live);
        external = {
          changedTo: target,
          unsolicitedAfterMs: announced === undefined ? null : announced.atMono - mark,
          pollSawLevel: polled.level,
          pollAfterMs: mono() - pollBegan,
          note:
            announced === undefined
              ? `nothing was announced in ${String(Math.round(options.externalWaitMs / 1000))} s — on this set 23c is POLL-ONLY, which the PRD costs at near zero while a film is playing (the supervisor already polls every second) and question 43 covers when nothing is playing`
              : 'the television announced the change without being asked — 23c is buildable as a pure subscription on this set',
        };
        legs.push({
          leg: 'external',
          ran: true,
          note: null,
          findings: [
            finding(
              'Does a change made by somebody else arrive unsolicited, or only on a poll? (question 5 — it decides whether 23c is buildable)',
              `a second connection set ${target.toFixed(2)}: ` +
                (external.unsolicitedAfterMs === null
                  ? `NOTHING arrived on our socket within ${String(options.externalWaitMs)} ms`
                  : `an unsolicited receiver status carrying it arrived after ${String(Math.round(external.unsolicitedAfterMs))} ms`) +
                `; a poll straight afterwards read ${external.pollSawLevel?.toFixed(4) ?? 'null'} in ${String(Math.round(external.pollAfterMs ?? 0))} ms. ${external.note}`,
              { ...external },
            ),
          ],
        });
      } finally {
        thief.closePolitely();
      }
    } else {
      legs.push({ leg: 'external', ran: false, note: 'not asked for', findings: [] });
      unmeasured.push('external: not asked for on this run');
    }

    // ---- Question 3b: which number does the television's OWN REMOTE move? ----
    if (options.legs.includes('remote') && options.remoteWaitMs > 0) {
      const receiverBefore = await receiverVolume(live);
      const streamBefore = (await mediaStatus()).stream;
      const mark = mono();
      prompt(
        `\n  >>> NOW: pick up THIS TELEVISION'S OWN REMOTE and change the volume — up a few, down a few.\n` +
          `      Waiting ${String(Math.round(options.remoteWaitMs / 1000))} s. Nothing is polled while you do it. <<<\n\n`,
      );
      await sleep(options.remoteWaitMs);
      const announced = live
        .since(mark)
        .filter((frame) => frame.namespace === NS_RECEIVER && frame.data.includes('"volume"'))
        .at(0);
      const receiverAfter = await receiverVolume(live);
      const streamAfter = (await mediaStatus()).stream;
      const receiverMoved =
        receiverBefore.level !== null &&
        receiverAfter.level !== null &&
        Math.abs(receiverAfter.level - receiverBefore.level) > 0.005;
      const streamMoved =
        streamBefore?.level != null &&
        streamAfter?.level != null &&
        Math.abs(streamAfter.level - streamBefore.level) > 0.005;
      const moved: RemoteReading['moved'] = receiverMoved
        ? streamMoved
          ? 'both'
          : 'receiver'
        : streamMoved
          ? 'stream'
          : 'neither';
      remote = {
        asked: true,
        receiverLevelBefore: receiverBefore.level,
        receiverLevelAfter: receiverAfter.level,
        streamLevelBefore: streamBefore?.level ?? null,
        streamLevelAfter: streamAfter?.level ?? null,
        unsolicitedAfterMs: announced === undefined ? null : announced.atMono - mark,
        moved,
        note:
          moved === 'neither'
            ? "⚠️ NEITHER NUMBER MOVED. Either nobody touched the remote, or this set's remote changes its own amplifier and tells Cast nothing — and those two are NOT the same answer. Re-run this leg with somebody definitely pressing the button before quoting it."
            : `the remote moved the ${moved} volume, so that is the number 23c is graded against on this set`,
      };
      legs.push({
        leg: 'remote',
        ran: moved !== 'neither',
        note:
          moved === 'neither'
            ? 'nothing moved — see the note; this reading cannot be quoted'
            : null,
        findings: [
          finding(
            "Which volume does the television's own remote move? (question 3, the half only a human can answer)",
            `receiver ${receiverBefore.level?.toFixed(4) ?? 'null'} → ${receiverAfter.level?.toFixed(4) ?? 'null'}; ` +
              `stream ${remote.streamLevelBefore?.toFixed(4) ?? 'absent'} → ${remote.streamLevelAfter?.toFixed(4) ?? 'absent'}; ` +
              `unsolicited status ${remote.unsolicitedAfterMs === null ? 'never arrived' : `arrived after ${String(Math.round(remote.unsolicitedAfterMs))} ms`}. ${remote.note}`,
            { ...remote },
          ),
        ],
      });
      if (moved === 'neither') {
        unmeasured.push(
          "remote: neither the receiver nor the stream volume moved, so which one the television's own remote drives is UNKNOWN on this set",
        );
      }
    } else {
      remote = {
        asked: false,
        receiverLevelBefore: null,
        receiverLevelAfter: null,
        streamLevelBefore: null,
        streamLevelAfter: null,
        unsolicitedAfterMs: null,
        moved: 'unknown',
        note: "not run: --remote-wait 0, or the leg was not asked for. Question 3 needs a person with the set's own remote and nothing can substitute for it.",
      };
      legs.push({ leg: 'remote', ran: false, note: remote.note, findings: [] });
      unmeasured.push(
        "remote: which volume the television's own remote moves was NOT observed (needs a person in the room)",
      );
    }

    // ---- Question 6: is mute independent of level? --------------------------
    if (options.legs.includes('mute')) {
      const before = await receiverVolume(live);
      let muteRoundTripMs: number | null = null;
      let mutedEchoed: boolean | null = null;
      let levelWhileMuted: number | null = null;
      try {
        const outcome = await setReceiverVolume(live, { muted: true });
        muteRoundTripMs = outcome.roundTripMs;
        mutedEchoed = outcome.echoed.muted;
        levelWhileMuted = outcome.echoed.level;
      } catch (error) {
        logger.warn('spike5.mute_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      await sleep(2_000);
      const whileMuted = await receiverVolume(live).catch(() => null);
      let unmuteRoundTripMs: number | null = null;
      let unmutedEchoed: boolean | null = null;
      let levelAfterUnmute: number | null = null;
      try {
        // **Nothing but `muted: false` is sent.** 23f's "we remember nothing" is only true
        // if the television puts the room back by itself; sending a level here would be the
        // spike doing the remembering and the answer would be ours, not the set's.
        const outcome = await setReceiverVolume(live, { muted: false });
        unmuteRoundTripMs = outcome.roundTripMs;
        unmutedEchoed = outcome.echoed.muted;
        levelAfterUnmute = outcome.echoed.level;
      } catch (error) {
        logger.warn('spike5.unmute_failed', {
          message: error instanceof Error ? error.message : String(error),
        });
      }
      const settledLevel = levelWhileMuted ?? whileMuted?.level ?? null;
      const independent =
        before.level === null || levelAfterUnmute === null
          ? null
          : Math.abs(levelAfterUnmute - before.level) <= 0.005 &&
            (settledLevel === null || Math.abs(settledLevel - before.level) <= 0.005);
      muteReading = {
        levelBefore: before.level,
        mutedEchoed,
        levelWhileMuted: settledLevel,
        muteRoundTripMs,
        unmutedEchoed,
        levelAfterUnmute,
        unmuteRoundTripMs,
        independent,
      };
      legs.push({
        leg: 'mute',
        ran: mutedEchoed !== null || unmutedEchoed !== null,
        note:
          mutedEchoed === null && unmutedEchoed === null
            ? 'the television answered neither the mute nor the unmute'
            : null,
        findings: [
          finding(
            'Is mute independent of level, and does unmute restore the room by itself? (question 6 — 23f rests on yes)',
            `level before ${before.level?.toFixed(4) ?? 'null'}; muted echoed ${String(mutedEchoed)} in ` +
              `${muteRoundTripMs === null ? 'n/a' : String(Math.round(muteRoundTripMs)) + ' ms'}; level while muted ` +
              `${settledLevel?.toFixed(4) ?? 'null'}; after an unmute that carried NO level, the set reported ` +
              `${levelAfterUnmute?.toFixed(4) ?? 'null'} in ${unmuteRoundTripMs === null ? 'n/a' : String(Math.round(unmuteRoundTripMs)) + ' ms'}. ` +
              (independent === null
                ? 'Not enough was echoed to say whether they are independent.'
                : independent
                  ? 'Independent: the television put the room back by itself, so CastGood can remember nothing (23f).'
                  : '⚠️ NOT independent — the level moved across a mute, so 23f\'s "we remember nothing" is false on this set.'),
            { ...muteReading },
          ),
        ],
      });
      if (mutedEchoed === null && unmutedEchoed === null) {
        unmeasured.push('mute: the television answered neither the mute nor the unmute');
      }
    } else {
      legs.push({ leg: 'mute', ran: false, note: 'not asked for', findings: [] });
      unmeasured.push('mute: not asked for on this run');
    }

    // Hand the television back: stop the film, then the restore below puts the level back.
    await live
      .request(NS_MEDIA, transportId, { type: 'STOP', mediaSessionId }, CAST.requestTimeoutMs)
      .catch(() => undefined);

    const restore = await restoreFoundVolume();
    if (!restore.restored) {
      unmeasured.push(`restore: ${restore.note}`);
    }

    return {
      legs,
      volumeAtStart,
      ladder,
      streamVolume,
      external,
      remote,
      mute: muteReading,
      playback,
      restore,
      unmeasured,
      wire: live.wire,
    };
  } finally {
    // Belt and braces: if the run threw anywhere above, the television still goes back to
    // the level it was found at before this process is allowed to end.
    const late = await restoreFoundVolume();
    if (late.attempted && !late.restored) {
      logger.warn('spike5.restore_failed', { note: late.note });
    }
    if (session !== null && !session.closed) session.closePolitely();
    await media.stop().catch(() => undefined);
  }
}

// --- Entry point ---------------------------------------------------------------

export interface SpikeM5aFullReport extends SpikeM5aReport {
  readonly schemaVersion: 1;
  readonly spike: 'SPIKE-5';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly device: {
    readonly name: string;
    readonly model: string;
    readonly address: string;
    readonly port: number;
  };
  readonly filePath: string;
  readonly legsAsked: readonly LegName[];
  readonly platform: string;
  readonly logDir: string;
}

export interface RunSpikeM5aOptions extends Omit<SpikeM5aOptions, 'logger'> {
  readonly deviceName: string;
  readonly model: string;
}

export async function runSpikeM5a(options: RunSpikeM5aOptions): Promise<SpikeM5aFullReport> {
  const paths = resolveAppPaths();
  const logger = createLogger({
    sink: combineSinks(createFileSink(paths.logDir, systemClock), createMemorySink()),
    clock: systemClock,
    level: 'debug',
    bindings: { component: 'spike-m5a' },
  });
  const startedAt = new Date().toISOString();
  const began = Date.now();
  const report = await probeVolume({ ...options, logger });
  return {
    schemaVersion: 1,
    spike: 'SPIKE-5',
    startedAt,
    durationMs: Date.now() - began,
    device: {
      name: options.deviceName,
      model: options.model,
      address: options.address,
      port: options.port,
    },
    filePath: options.filePath,
    legsAsked: options.legs,
    platform: process.platform,
    logDir: paths.logDir,
    ...report,
  };
}

export function summariseM5a(report: SpikeM5aFullReport): string {
  const lines = [
    '',
    '================ SPIKE-5 — whose volume is it? ================',
    `device "${report.device.name}" (${report.device.model}) at ${report.device.address}:${String(report.device.port)}`,
    `film   ${report.filePath}`,
    `${String(Math.round(report.durationMs / 1000))} s   log: ${report.logDir}`,
    '',
    'An OBSERVATION TOOL, not a test. Nothing here passes or fails; it records what this one',
    'television did with its own volume, so story 23 can be built against facts.',
    '',
    `  volume as found: ${report.volumeAtStart?.raw ?? '(never read)'}`,
    '',
  ];

  for (const leg of report.legs) {
    if (!leg.ran && leg.findings.length === 0) {
      lines.push(`  -- ${leg.leg}: NOT MEASURED — ${leg.note ?? 'no reason recorded'}`, '');
      continue;
    }
    for (const item of leg.findings) {
      lines.push(`  Q ${item.question}`, `  A ${item.answer}`, '');
    }
  }

  if (report.ladder.length > 0) {
    lines.push('  -- every rung, as asked and as answered ---------------------------');
    lines.push('     requested   echoed     settled    round trip   verdict');
    for (const step of report.ladder) {
      lines.push(
        `     ${step.requested.toFixed(3).padStart(9)}   ${(step.echoed?.toFixed(4) ?? 'none').padStart(8)}   ` +
          `${(step.settledLevel?.toFixed(4) ?? 'none').padStart(8)}   ` +
          `${(step.roundTripMs === null ? 'n/a' : `${String(Math.round(step.roundTripMs))} ms`).padStart(9)}    ${step.kind}`,
      );
    }
    lines.push('');
  }

  lines.push(
    `  -- the television was put back to ${report.restore.askedLevel?.toFixed(4) ?? 'its level'}` +
      `${report.restore.askedMuted === null ? '' : `, muted ${String(report.restore.askedMuted)}`}: ` +
      `${report.restore.restored ? 'CONFIRMED' : 'NOT CONFIRMED'}`,
    `     ${report.restore.note}`,
    '',
  );

  if (report.unmeasured.length > 0) {
    lines.push('  ⚠️  READINGS THIS RUN DID NOT TAKE — do not quote a number for these:');
    for (const item of report.unmeasured) lines.push(`     · ${item}`);
    lines.push('');
  }

  lines.push(
    '  ONLY YOUR EARS ANSWER QUESTION 2. This spike can read levels, echoes and round trips;',
    "  whether the SOUND IN THE ROOM changed is story 23's real promise and no instrument here",
    '  can measure it. If the number moved and the room did not, that is the finding.',
    '',
    report.unmeasured.length === 0
      ? 'Every leg asked for produced its reading. A spike has findings, not a pass.'
      : 'SOME READINGS WERE NOT TAKEN (listed above). The exit code says so.',
    '',
  );
  return lines.join('\n');
}
