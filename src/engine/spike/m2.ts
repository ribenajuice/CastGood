import fsp from 'node:fs/promises';
import path from 'node:path';
import { CAST, MEDIA_SERVER } from '../config.js';
import { tlsTransportFactory, type TransportFactory } from '../cast/index.js';
import type { CastMessage } from '../cast/castv2/client.js';
import { contentTypeFor, createMediaServer, type MediaServer } from '../media-server/index.js';
import {
  combineSinks,
  createFileSink,
  createLogger,
  createMemorySink,
  systemClock,
  type Logger,
  type LogRecord,
} from '../logging/index.js';
import { resolveAppPaths } from '../paths.js';

/**
 * ============================================================================
 *  SPIKE-2 — THROWAWAY. DELETE THIS DIRECTORY WHEN M2'S SUPERVISOR IS BUILT.
 * ============================================================================
 *
 * This is not product code and nothing in `src/engine/` or `src/main/` imports it. It is
 * not in `npm test` and not in CI. Its whole job is to find out **what a real television
 * actually does** before M2's behaviour is designed around a guess, as required by the
 * PRD's build order (step 1) and its "Assumptions about real devices" table.
 *
 * It talks CASTV2 at the raw level on purpose — a hand-rolled request/response over
 * `tlsTransportFactory` — because the questions are about the *device*, not about our
 * client, and half of them (kill our socket without saying goodbye; join a session we
 * never launched; ask for a status without knowing the media session id) are things the
 * production client deliberately cannot do yet. Every frame in both directions is written
 * to the engine's JSONL log as `spike.wire`, so the evidence survives the run.
 *
 * It reuses exactly two pieces of the real engine: the TLS transport and the media
 * server. Those are the two things that must behave identically to the app, and both are
 * already proven on this hardware.
 *
 * WHAT IT WILL NOT DO
 *  - It never claims a pass. A spike has findings, not promises. Exit 0 means "it ran and
 *    recorded"; exit 2 means "it could not run". There is no exit 1.
 *  - It always releases the television on the way out, including on Ctrl-C — except for
 *    `reattach-start`, whose entire purpose is to leave the TV playing.
 *
 * Run it from WSL with `scripts/spike-m2.sh`; it only works on Windows.
 */

// --- Options -----------------------------------------------------------------

export const PROBES = ['socket', 'takeover', 'reattach-start', 'reattach-join', 'seek'] as const;
export type ProbeName = (typeof PROBES)[number];

export interface SpikeOptions {
  /** The device's LAN address. Discovery is not used: this is about one known TV. */
  readonly address: string;
  readonly port: number;
  /** Windows path to the video the TV will play. */
  readonly filePath: string;
  readonly probes: readonly ProbeName[];
  /** Where the JSONL log and the report land. Defaults to the app's own log directory. */
  readonly logDir?: string;
  /**
   * The app to launch as "someone else took the TV". `null` means wait for a human to
   * cast from their phone instead — which is the honest fallback if a programmatic
   * takeover turns out not to look like a real one.
   */
  readonly takeoverAppId?: string | null;
  /** How long to wait for a human to do the physical thing. */
  readonly humanWaitMs?: number;
  /** How long our socket stays dead in the `socket` probe. */
  readonly outageMs?: number;
  /**
   * A scripted stand-in for TLS, so this throwaway code can be smoke-tested against the
   * fake receiver before it is ever pointed at the founder's television — a spike that
   * crashes on a typo costs an afternoon of someone else's evening.
   *
   * **The CLI cannot set it.** A run that uses it is stamped `transport: "test-harness"`
   * in the report, because findings from a fake receiver say nothing about a device: the
   * fake was kinder than reality four separate times in M1.
   */
  readonly unsafeTestTransport?: TransportFactory;
}

// --- Small, suspicious readers of anything that arrived from the LAN ---------
// A TV is not trusted input. Nothing here throws on a surprising payload; it returns null
// and the finding says "the device did not report one", which is itself a result.

type Json = Record<string, unknown>;

function asObject(value: unknown): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function round(value: number | null, places = 3): number | null {
  if (value === null) return null;
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

// --- The raw CASTV2 session --------------------------------------------------

export const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
export const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
export const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
export const NS_MEDIA = 'urn:x-cast:com.google.cast.media';
export const PLATFORM_RECEIVER = 'receiver-0';

export interface Wire {
  readonly dir: 'in' | 'out';
  readonly atMono: number;
  readonly namespace: string;
  readonly peer: string;
  readonly type: string | null;
  readonly data: string;
}

export interface Session {
  readonly label: string;
  readonly localAddress: string;
  /** Everything seen on this socket, both directions, in order. */
  readonly wire: readonly Wire[];
  send(namespace: string, destination: string, payload: Json): void;
  request(namespace: string, destination: string, payload: Json, timeoutMs?: number): Promise<Json>;
  /** Inbound frames since a monotonic mark. */
  since(mark: number): Wire[];
  /** Destroys the TCP socket without a CASTV2 CLOSE: what a crash or a dead wifi looks like. */
  killSocket(): void;
  /** Says goodbye properly, then destroys it: what a well-behaved sender does. */
  closePolitely(): void;
  readonly closed: boolean;
  readonly closeReason: string | null;
}

export interface SessionDeps {
  readonly address: string;
  readonly port: number;
  readonly logger: Logger;
  readonly label: string;
  readonly transport: TransportFactory;
}

export async function openSession(deps: SessionDeps): Promise<Session> {
  const logger = deps.logger.child({ socket: deps.label });
  const wire: Wire[] = [];
  let heartbeat: NodeJS.Timeout | null = null;
  const pending = new Map<
    number,
    { resolve: (payload: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout }
  >();
  let nextRequestId = 1;
  let closed = false;
  let closeReason: string | null = null;

  const record = (entry: Wire): void => {
    wire.push(entry);
    logger.info('spike.wire', {
      dir: entry.dir,
      namespace: entry.namespace.replace('urn:x-cast:com.google.cast.', ''),
      peer: entry.peer,
      type: entry.type,
      // The raw payload, untouched — this is the point of the whole exercise.
      data: entry.data.length > 4_000 ? `${entry.data.slice(0, 4_000)}…[truncated]` : entry.data,
    });
  };

  const transport = await deps.transport(
    { host: deps.address, port: deps.port, timeoutMs: CAST.connectTimeoutMs },
    {
      onMessage(message: CastMessage) {
        // A television is not trusted input: an unparseable frame is an empty payload and
        // a recorded line, never a throw in the middle of a probe.
        const payload = parseJson(message.data);
        record({
          dir: 'in',
          atMono: systemClock.monoMs(),
          namespace: message.namespace,
          peer: message.sourceId,
          type: str(payload['type']),
          data: message.data,
        });

        if (message.namespace === NS_HEARTBEAT && payload['type'] === 'PING') {
          send(NS_HEARTBEAT, message.sourceId, { type: 'PONG' });
          return;
        }
        const id = num(payload['requestId']);
        if (id !== null && id !== 0) {
          const waiting = pending.get(id);
          if (waiting !== undefined) {
            clearTimeout(waiting.timer);
            pending.delete(id);
            waiting.resolve(payload);
          }
        }
      },
      onClose(reason: string) {
        if (closed) return;
        closed = true;
        closeReason = reason;
        if (heartbeat !== null) clearInterval(heartbeat);
        logger.info('spike.socket_closed', { reason });
        for (const [, waiting] of pending) {
          clearTimeout(waiting.timer);
          waiting.reject(new Error(`socket closed: ${reason}`));
        }
        pending.clear();
      },
    },
  );

  function send(namespace: string, destination: string, payload: Json): void {
    if (closed) return;
    const data = JSON.stringify(payload);
    record({
      dir: 'out',
      atMono: systemClock.monoMs(),
      namespace,
      peer: destination,
      type: str(payload['type']),
      data,
    });
    transport.send({ sourceId: 'sender-0', destinationId: destination, namespace, data });
  }

  // Our own keep-alive. Without it the receiver drops an idle sender, which would
  // contaminate every "did the connection survive?" answer in here.
  heartbeat = setInterval(() => {
    if (!closed) send(NS_HEARTBEAT, PLATFORM_RECEIVER, { type: 'PING' });
  }, 5_000);
  heartbeat.unref?.();

  logger.info('spike.socket_open', {
    address: deps.address,
    port: deps.port,
    localAddress: transport.localAddress,
  });
  send(NS_CONNECTION, PLATFORM_RECEIVER, { type: 'CONNECT', userAgent: 'CastGood-spike' });

  return {
    label: deps.label,
    localAddress: transport.localAddress,
    wire,
    send,
    request(namespace, destination, payload, timeoutMs = CAST.requestTimeoutMs) {
      if (closed) return Promise.reject(new Error(`socket already closed: ${closeReason ?? '?'}`));
      const id = nextRequestId++;
      return new Promise<Json>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(
            new Error(`no answer to ${String(payload['type'])} after ${String(timeoutMs)} ms`),
          );
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, reject, timer });
        send(namespace, destination, { ...payload, requestId: id });
      });
    },
    since: (mark) => wire.filter((entry) => entry.dir === 'in' && entry.atMono >= mark),
    killSocket() {
      logger.warn('spike.socket_killed', { note: 'TCP destroyed with no CASTV2 CLOSE' });
      transport.close();
    },
    closePolitely() {
      send(NS_CONNECTION, PLATFORM_RECEIVER, { type: 'CLOSE' });
      transport.close();
    },
    get closed() {
      return closed;
    },
    get closeReason() {
      return closeReason;
    },
  };
}

// --- What we read back out of the device's own messages ----------------------

export interface MediaSnapshot {
  readonly atMono: number;
  readonly mediaSessionId: number | null;
  readonly playerState: string | null;
  readonly currentTime: number | null;
  readonly duration: number | null;
  readonly contentId: string | null;
  readonly idleReason: string | null;
}

export function readMedia(payload: Json, atMono: number): MediaSnapshot | null {
  const entry = asObject(asArray(payload['status'])[0]);
  if (Object.keys(entry).length === 0) return null;
  const media = asObject(entry['media']);
  return {
    atMono,
    mediaSessionId: num(entry['mediaSessionId']),
    playerState: str(entry['playerState']),
    currentTime: num(entry['currentTime']),
    duration: num(media['duration']),
    contentId: str(media['contentId']),
    idleReason: str(entry['idleReason']),
  };
}

export interface ReceiverSnapshot {
  readonly atMono: number;
  readonly appId: string | null;
  readonly displayName: string | null;
  readonly sessionId: string | null;
  readonly transportId: string | null;
  readonly applicationCount: number;
}

export function readReceiver(payload: Json, atMono: number): ReceiverSnapshot {
  const applications = asArray(asObject(payload['status'])['applications']);
  const first = asObject(applications[0]);
  return {
    atMono,
    appId: str(first['appId']),
    displayName: str(first['displayName']),
    sessionId: str(first['sessionId']),
    transportId: str(first['transportId']),
    applicationCount: applications.length,
  };
}

// --- Report shapes -----------------------------------------------------------

export interface Finding {
  readonly question: string;
  readonly answer: string;
  readonly detail: Json;
}

export interface AssumptionVerdict {
  readonly assumption: number;
  readonly claim: string;
  readonly verdict: 'confirmed' | 'contradicted' | 'inconclusive';
  readonly because: string;
}

export interface ProbeReport {
  readonly probe: ProbeName;
  readonly ran: boolean;
  readonly note: string | null;
  readonly findings: readonly Finding[];
  readonly assumptions: readonly AssumptionVerdict[];
  readonly wire: readonly Wire[];
}

export interface SpikeReport {
  readonly schemaVersion: 1;
  readonly spike: 'SPIKE-2';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly device: { readonly address: string; readonly port: number };
  readonly file: string;
  readonly platform: string;
  readonly logDir: string;
  readonly reportFile: string | null;
  /**
   * `tls` is a run against a real device. `test-harness` means it was given a scripted
   * receiver, which the command line cannot do — so findings from a fake can never be
   * mistaken for what a television did.
   */
  readonly transport: 'tls' | 'test-harness';
  readonly probes: readonly ProbeReport[];
}

export function finding(question: string, answer: string, detail: Json = {}): Finding {
  return { question, answer, detail };
}

export function verdict(
  assumption: number,
  claim: string,
  result: AssumptionVerdict['verdict'],
  because: string,
): AssumptionVerdict {
  return { assumption, claim, verdict: result, because };
}

/** The run could not happen. There is no "failed": a spike only has findings. */
export class SpikeAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SpikeAbort';
  }
}

// --- Shared machinery for the probes ----------------------------------------

interface ResolvedOptions {
  readonly address: string;
  readonly port: number;
  readonly filePath: string;
  readonly probes: readonly ProbeName[];
  readonly logDir: string;
  readonly takeoverAppId: string | null;
  readonly humanWaitMs: number;
  readonly outageMs: number;
}

interface Context {
  readonly options: ResolvedOptions;
  /** Real TLS unless a smoke test injected the fake receiver. */
  readonly transport: TransportFactory;
  readonly logger: Logger;
  readonly media: MediaServer;
  readonly records: () => LogRecord[];
  readonly stateFile: string;
  sleep(ms: number): Promise<void>;
  mono(): number;
}

interface Cast {
  readonly session: Session;
  readonly transportId: string;
  readonly appSessionId: string | null;
  readonly mediaSessionId: number;
  readonly contentUrl: string;
  readonly token: string;
  readonly loadedAtMono: number;
  readonly first: MediaSnapshot;
}

async function launchAndLoad(
  context: Context,
  session: Session,
  startPositionSec: number,
  token?: string,
): Promise<Cast> {
  const launch = await session.request(
    NS_RECEIVER,
    PLATFORM_RECEIVER,
    { type: 'LAUNCH', appId: CAST.defaultReceiverAppId },
    CAST.launchTimeoutMs,
  );
  const receiver = readReceiver(launch, context.mono());
  if (receiver.transportId === null) {
    throw new SpikeAbort('the device did not launch the Default Media Receiver');
  }
  session.send(NS_CONNECTION, receiver.transportId, {
    type: 'CONNECT',
    userAgent: 'CastGood-spike',
  });

  const mount = context.media.mount({
    path: context.options.filePath,
    kind: 'file',
    ...(token === undefined ? {} : { token }),
  });
  const contentUrl = context.media.urlFor(mount, session.localAddress);

  const loadedAtMono = context.mono();
  const response = await session.request(
    NS_MEDIA,
    receiver.transportId,
    {
      type: 'LOAD',
      ...(receiver.sessionId === null ? {} : { sessionId: receiver.sessionId }),
      media: {
        contentId: contentUrl,
        contentType: contentTypeFor(context.options.filePath),
        streamType: 'BUFFERED',
        metadata: { metadataType: 0, title: path.basename(context.options.filePath) },
      },
      autoplay: true,
      currentTime: startPositionSec,
    },
    CAST.launchTimeoutMs,
  );
  const first = readMedia(response, context.mono());
  if (first === null || first.mediaSessionId === null) {
    throw new SpikeAbort('the device refused the LOAD (no media session came back)');
  }
  context.logger.info('spike.loaded', {
    mediaSessionId: first.mediaSessionId,
    contentUrl,
    startPositionSec,
  });
  const cast: Cast = {
    session,
    transportId: receiver.transportId,
    appSessionId: receiver.sessionId,
    mediaSessionId: first.mediaSessionId,
    contentUrl,
    token: mount.token,
    loadedAtMono,
    first,
  };
  activeRelease = () => release(session, cast);
  return cast;
}

async function status(
  context: Context,
  session: Session,
  transportId: string,
  mediaSessionId?: number,
): Promise<MediaSnapshot | null> {
  const response = await session.request(NS_MEDIA, transportId, {
    type: 'GET_STATUS',
    ...(mediaSessionId === undefined ? {} : { mediaSessionId }),
  });
  return readMedia(response, context.mono());
}

/** Polls GET_STATUS until `predicate` holds, recording every answer. */
async function waitForStatus(
  context: Context,
  session: Session,
  transportId: string,
  mediaSessionId: number | undefined,
  timeoutMs: number,
  predicate: (snapshot: MediaSnapshot) => boolean,
): Promise<{ matched: MediaSnapshot | null; samples: MediaSnapshot[]; elapsedMs: number }> {
  const started = context.mono();
  const samples: MediaSnapshot[] = [];
  while (context.mono() - started < timeoutMs) {
    let snapshot: MediaSnapshot | null = null;
    try {
      snapshot = await status(context, session, transportId, mediaSessionId);
    } catch (error) {
      context.logger.warn('spike.status_failed', { error });
      if (session.closed) break;
    }
    if (snapshot !== null) {
      samples.push(snapshot);
      if (predicate(snapshot)) {
        return { matched: snapshot, samples, elapsedMs: Math.round(context.mono() - started) };
      }
    }
    await context.sleep(250);
  }
  return { matched: null, samples, elapsedMs: Math.round(context.mono() - started) };
}

async function playing(
  context: Context,
  session: Session,
  cast: Cast,
  timeoutMs = 30_000,
): Promise<MediaSnapshot | null> {
  const result = await waitForStatus(
    context,
    session,
    cast.transportId,
    cast.mediaSessionId,
    timeoutMs,
    (snapshot) => snapshot.playerState === 'PLAYING',
  );
  return result.matched;
}

/** Every byte range the TV asked us for in a window, straight out of the log. */
function mediaRequests(context: Context, fromMono: number, toMono: number): Json {
  const rows = context
    .records()
    .filter((record) => record.event === 'media.request')
    .filter((record) => record.mono >= fromMono && record.mono <= toMono);
  const starts = rows.map((record) => num(record['start']) ?? 0);
  return {
    count: rows.length,
    firstStartByte: starts[0] ?? null,
    lastStartByte: starts.length === 0 ? null : starts[starts.length - 1],
    firstAtMonoOffsetMs: rows[0] === undefined ? null : Math.round(rows[0].mono - fromMono),
  };
}

/**
 * Set while a probe holds a television, so Ctrl-C still hands it back. The selftest has
 * the same rule (13e) and it is the reason anyone is willing to run either of them twice.
 */
let activeRelease: (() => Promise<void>) | null = null;

/** Called by the CLI's signal handlers. Safe when nothing is running. */
export async function abortActiveSpike(): Promise<void> {
  const pending = activeRelease;
  activeRelease = null;
  if (pending !== null) await pending();
}

async function release(session: Session, cast: Cast | null): Promise<void> {
  activeRelease = null;
  try {
    if (cast !== null && !session.closed) {
      await session
        .request(NS_MEDIA, cast.transportId, {
          type: 'STOP',
          mediaSessionId: cast.mediaSessionId,
        })
        .catch(() => undefined);
      if (cast.appSessionId !== null) {
        await session
          .request(NS_RECEIVER, PLATFORM_RECEIVER, { type: 'STOP', sessionId: cast.appSessionId })
          .catch(() => undefined);
      }
    }
  } finally {
    if (!session.closed) session.closePolitely();
  }
}

/**
 * The last word on releasing the television, run after every probe that is not
 * `reattach-start`.
 *
 * The per-probe release goes through the socket that started the session, and half of
 * these probes exist *because* that socket can die — so a probe that aborts partway
 * through can leave a TV sitting on the Cast backdrop with our video loaded, which is
 * exactly the M1 defect QA found. This opens a fresh connection, asks what is running,
 * and stops it if it is ours. It is idempotent: if the TV is already home, it does
 * nothing and says so.
 */
async function forceRelease(context: Context): Promise<void> {
  let session: Session | null = null;
  try {
    session = await openSession({ ...sessionDeps(context), label: 'release' });
    const receiver = readReceiver(
      await session.request(NS_RECEIVER, PLATFORM_RECEIVER, { type: 'GET_STATUS' }),
      context.mono(),
    );
    if (receiver.appId === CAST.defaultReceiverAppId && receiver.sessionId !== null) {
      await session.request(NS_RECEIVER, PLATFORM_RECEIVER, {
        type: 'STOP',
        sessionId: receiver.sessionId,
      });
      context.logger.info('spike.force_released', { sessionId: receiver.sessionId });
    } else {
      context.logger.info('spike.nothing_to_release', { appId: receiver.appId });
    }
  } catch (error) {
    context.logger.warn('spike.force_release_failed', { error });
  } finally {
    if (session !== null && !session.closed) session.closePolitely();
  }
}

// --- Probe 1: our socket dies while the film is playing ----------------------

async function probeSocket(context: Context): Promise<ProbeReport> {
  const findings: Finding[] = [];
  const assumptions: AssumptionVerdict[] = [];
  const wire: Wire[] = [];

  const first = await openSession({ ...sessionDeps(context), label: 'A' });
  let second: Session | null = null;
  try {
    const cast = await launchAndLoad(context, first, 0);
    const started = await playing(context, first, cast);
    if (started === null) throw new SpikeAbort('the device never reached PLAYING');
    await context.sleep(15_000);

    const before = await status(context, first, cast.transportId, cast.mediaSessionId);
    const killAtMono = context.mono();
    first.killSocket();
    findings.push(
      finding(
        'What does our side see when we destroy the socket?',
        `close reason: ${first.closeReason ?? 'none reported'}`,
        {
          positionAtKillSec: round(before?.currentTime ?? null),
          mediaSessionId: cast.mediaSessionId,
        },
      ),
    );

    // The film should carry on without us. The TV asking for more bytes during the outage
    // is the strongest evidence available from here that it did.
    await context.sleep(context.options.outageMs);
    const outageBytes = mediaRequests(context, killAtMono, context.mono());
    findings.push(
      finding(
        'Did the TV keep fetching video while we were gone?',
        `${String(outageBytes['count'])} range request(s) during the ${String(
          Math.round(context.options.outageMs / 1000),
        )} s outage`,
        outageBytes,
      ),
    );

    // Rejoin. Note what is *not* sent: no LAUNCH. If joining requires a LAUNCH, that is
    // itself the finding, and story 11 has to be re-shaped around it.
    const rejoinStart = context.mono();
    second = await openSession({ ...sessionDeps(context), label: 'B' });
    const receiverStatus = readReceiver(
      await second.request(NS_RECEIVER, PLATFORM_RECEIVER, { type: 'GET_STATUS' }),
      context.mono(),
    );
    const receiverMs = Math.round(context.mono() - rejoinStart);
    findings.push(
      finding(
        'After the socket died, is our receiver app still running on the device?',
        receiverStatus.appId === CAST.defaultReceiverAppId
          ? `yes — ${CAST.defaultReceiverAppId}, session ${receiverStatus.sessionId ?? '?'}`
          : `no — appId is ${receiverStatus.appId ?? 'null (home screen)'}`,
        {
          appId: receiverStatus.appId,
          sameAppSessionId: receiverStatus.sessionId === cast.appSessionId,
          previousAppSessionId: cast.appSessionId,
          transportId: receiverStatus.transportId,
          sameTransportId: receiverStatus.transportId === cast.transportId,
          receiverStatusMs: receiverMs,
        },
      ),
    );

    let rejoined: MediaSnapshot | null = null;
    let rejoinMs: number | null = null;
    if (receiverStatus.transportId !== null) {
      second.send(NS_CONNECTION, receiverStatus.transportId, {
        type: 'CONNECT',
        userAgent: 'CastGood-spike',
      });
      // Deliberately without a mediaSessionId: on a fresh connection we do not yet know it,
      // and whether the device volunteers it is exactly what story 11 turns on.
      rejoined = await status(context, second, receiverStatus.transportId);
      rejoinMs = Math.round(context.mono() - rejoinStart);
    }

    const elapsedSec = (context.mono() - killAtMono) / 1000;
    const positionAtKillSec = before === null ? null : before.currentTime;
    const expectedSec = positionAtKillSec === null ? null : positionAtKillSec + elapsedSec;
    const reportedSec = rejoined === null ? null : rejoined.currentTime;
    const positionErrorSec =
      expectedSec === null || reportedSec === null ? null : Math.abs(reportedSec - expectedSec);

    findings.push(
      finding(
        'Can a new connection rejoin the same media session, and is the position right?',
        rejoined === null
          ? 'no status came back at all'
          : `mediaSessionId ${String(rejoined.mediaSessionId)} (${
              rejoined.mediaSessionId === cast.mediaSessionId ? 'same' : 'DIFFERENT'
            }), ${rejoined.playerState ?? '?'} at ${String(round(rejoined.currentTime))} s`,
        {
          rejoinMs,
          sameMediaSessionId: rejoined?.mediaSessionId === cast.mediaSessionId,
          playerState: rejoined?.playerState ?? null,
          reportedPositionSec: round(reportedSec),
          expectedPositionSec: round(expectedSec),
          positionErrorSec: round(positionErrorSec),
          outageSec: round(elapsedSec),
          contentIdMatches: rejoined?.contentId === cast.contentUrl,
        },
      ),
    );

    // Rejoining is only useful if the session can then be *driven*. Story 11 has to pause,
    // resume and seek on a session it did not start.
    let controlNote = 'not attempted';
    const rejoinedTransportId = receiverStatus.transportId;
    const rejoinedSessionId = rejoined === null ? null : rejoined.mediaSessionId;
    if (rejoinedTransportId !== null && rejoinedSessionId !== null) {
      const sessionId = rejoinedSessionId;
      const pauseAt = context.mono();
      try {
        await second.request(NS_MEDIA, rejoinedTransportId, {
          type: 'PAUSE',
          mediaSessionId: sessionId,
        });
        const paused = await waitForStatus(
          context,
          second,
          rejoinedTransportId,
          sessionId,
          5_000,
          (snapshot) => snapshot.playerState === 'PAUSED',
        );
        await second.request(NS_MEDIA, rejoinedTransportId, {
          type: 'PLAY',
          mediaSessionId: sessionId,
        });
        const resumed = await waitForStatus(
          context,
          second,
          rejoinedTransportId,
          sessionId,
          5_000,
          (snapshot) => snapshot.playerState === 'PLAYING',
        );
        controlNote =
          paused.matched !== null && resumed.matched !== null
            ? `yes — paused in ${String(paused.elapsedMs)} ms and resumed in ${String(resumed.elapsedMs)} ms, ${String(Math.round(context.mono() - pauseAt))} ms round trip`
            : 'commands were accepted but the state did not follow';
      } catch (error) {
        controlNote = `no — ${error instanceof Error ? error.message : String(error)}`;
      }
    }
    findings.push(
      finding('Can we control the session we rejoined?', controlNote, {
        note: 'story 11 must pause, resume and seek on a session it did not start',
      }),
    );

    const joinedSame = rejoined !== null && rejoined.mediaSessionId === cast.mediaSessionId;
    const stillPlaying = rejoined?.playerState === 'PLAYING';
    assumptions.push(
      verdict(
        1,
        'A Chromecast keeps playing when our sender socket dies, and a new connection can join the running session and read an accurate position',
        joinedSame && stillPlaying && (positionErrorSec ?? 99) <= 2
          ? 'confirmed'
          : rejoined === null
            ? 'contradicted'
            : 'inconclusive',
        rejoined === null
          ? 'a fresh connection got no media status back at all — story 11 must reconnect and re-LOAD at the remembered position'
          : `same media session: ${String(joinedSame)}; player state ${rejoined.playerState ?? '?'}; position error ${String(round(positionErrorSec))} s; rejoin took ${String(rejoinMs)} ms`,
      ),
    );

    wire.push(...first.wire, ...second.wire);
    await release(second, {
      ...cast,
      transportId: rejoinedTransportId ?? cast.transportId,
      ...(rejoinedSessionId === null ? {} : { mediaSessionId: rejoinedSessionId }),
    });
    return { probe: 'socket', ran: true, note: null, findings, assumptions, wire };
  } finally {
    if (!first.closed) first.closePolitely();
    if (second !== null && !second.closed) second.closePolitely();
  }
}

// --- Probe 2: someone else takes the television ------------------------------

async function probeTakeover(context: Context): Promise<ProbeReport> {
  const findings: Finding[] = [];
  const assumptions: AssumptionVerdict[] = [];
  const ours = await openSession({ ...sessionDeps(context), label: 'ours' });
  let thief: Session | null = null;
  let cast: Cast | null = null;

  try {
    cast = await launchAndLoad(context, ours, 0);
    const started = await playing(context, ours, cast);
    if (started === null) throw new SpikeAbort('the device never reached PLAYING');
    await context.sleep(10_000);

    const before = await status(context, ours, cast.transportId, cast.mediaSessionId);
    const mark = context.mono();
    let how: string;

    if (context.options.takeoverAppId === null) {
      how = 'a human casting from a phone';
      process.stderr.write(
        `\n  >>> NOW: cast YouTube (or anything) to this TV from your phone. Waiting ${String(
          Math.round(context.options.humanWaitMs / 1000),
        )} s… <<<\n\n`,
      );
    } else {
      how = `LAUNCH ${context.options.takeoverAppId} from a second connection`;
      thief = await openSession({ ...sessionDeps(context), label: 'thief' });
      try {
        const launched = await thief.request(
          NS_RECEIVER,
          PLATFORM_RECEIVER,
          { type: 'LAUNCH', appId: context.options.takeoverAppId },
          CAST.launchTimeoutMs,
        );
        const thiefApp = readReceiver(launched, context.mono());
        findings.push(
          finding(
            'Did launching another app from a second connection work at all?',
            `yes — the device now reports appId ${thiefApp.appId ?? 'null'} (${thiefApp.displayName ?? 'no display name'})`,
            { appId: thiefApp.appId, displayName: thiefApp.displayName, raw: launched },
          ),
        );
      } catch (error) {
        findings.push(
          finding(
            'Did launching another app from a second connection work at all?',
            `no — ${error instanceof Error ? error.message : String(error)}`,
            {
              consequence:
                'a programmatic takeover is not available; criterion 14a becomes human checklist item 4',
            },
          ),
        );
      }
    }

    // Watch our own connection and say precisely what arrived, in order, with timings.
    const watchMs = context.options.takeoverAppId === null ? context.options.humanWaitMs : 20_000;
    const deadline = context.mono() + watchMs;
    while (context.mono() < deadline) {
      if (ours.closed) break;
      const seen = ours.since(mark);
      const differentApp = seen.some(
        (entry) =>
          entry.namespace === NS_RECEIVER &&
          entry.data.includes('"appId"') &&
          !entry.data.includes(CAST.defaultReceiverAppId),
      );
      if (differentApp) break;
      await context.sleep(250);
    }

    const seen = ours.since(mark);
    const firstAt = (match: (entry: Wire) => boolean): number | null => {
      const entry = seen.find(match);
      return entry === undefined ? null : Math.round(entry.atMono - mark);
    };
    const closeMs = firstAt((entry) => entry.namespace === NS_CONNECTION && entry.type === 'CLOSE');
    const otherAppMs = firstAt(
      (entry) =>
        entry.namespace === NS_RECEIVER &&
        entry.data.includes('"appId"') &&
        !entry.data.includes(CAST.defaultReceiverAppId),
    );
    const emptyAppsMs = firstAt(
      (entry) => entry.namespace === NS_RECEIVER && entry.data.includes('"applications":[]'),
    );

    findings.push(
      finding(
        `What does our connection receive when the TV is taken (${how})?`,
        [
          otherAppMs === null
            ? null
            : `RECEIVER_STATUS with a different appId after ${String(otherAppMs)} ms`,
          emptyAppsMs === null
            ? null
            : `RECEIVER_STATUS with no applications after ${String(emptyAppsMs)} ms`,
          closeMs === null ? null : `CLOSE on the connection namespace after ${String(closeMs)} ms`,
          ours.closed ? `our socket closed: ${ours.closeReason ?? '?'}` : null,
        ]
          .filter((line) => line !== null)
          .join('; ') || 'NOTHING AT ALL — no status, no CLOSE, no socket close',
        {
          receiverStatusWithOtherAppIdMs: otherAppMs,
          receiverStatusWithNoApplicationsMs: emptyAppsMs,
          connectionCloseMs: closeMs,
          socketClosed: ours.closed,
          socketCloseReason: ours.closeReason,
          inboundFrames: seen.length,
          namespaces: [...new Set(seen.map((entry) => entry.namespace))],
        },
      ),
    );

    // Can we still talk to the old media session? "Yielding immediately" (14b) needs us to
    // know we have lost it, not to discover it through a timeout.
    let stale = 'not attempted';
    try {
      const after = await status(context, ours, cast.transportId, cast.mediaSessionId);
      stale =
        after === null
          ? 'the device answered with an empty status'
          : `the device still answered: ${after.playerState ?? '?'} at ${String(round(after.currentTime))} s`;
    } catch (error) {
      stale = `no answer — ${error instanceof Error ? error.message : String(error)}`;
    }
    findings.push(
      finding('After the takeover, does the old media session still answer?', stale, {
        positionBeforeTakeoverSec: round(before?.currentTime ?? null),
      }),
    );

    assumptions.push(
      verdict(
        2,
        'A takeover is distinguishable from a disconnect — the device reports a different appId rather than simply dropping us',
        otherAppMs !== null
          ? 'confirmed'
          : ours.closed || closeMs !== null
            ? 'contradicted'
            : 'inconclusive',
        otherAppMs !== null
          ? `a RECEIVER_STATUS naming another appId arrived ${String(otherAppMs)} ms after the takeover${closeMs === null ? ' and no CLOSE followed' : `, followed by a CLOSE at ${String(closeMs)} ms`}`
          : ours.closed || closeMs !== null
            ? 'all we received was a close — on the wire this is identical to losing the connection, so the app cannot tell the two apart from the session alone'
            : 'nothing arrived within the watch window; either the takeover did not happen or the device says nothing about it',
      ),
    );

    // Take it back — criterion 14c, and it needs to work from a connection that lost.
    const takeBackAt = context.mono();
    const resumeFrom = before?.currentTime ?? 0;
    let takeBack: Cast | null = null;
    try {
      const fresh = ours.closed
        ? await openSession({ ...sessionDeps(context), label: 'takeback' })
        : ours;
      takeBack = await launchAndLoad(context, fresh, resumeFrom);
      const back = await playing(context, fresh, takeBack);
      findings.push(
        finding(
          'Can we take the television back, at the remembered position?',
          back === null
            ? 'no — it never reached PLAYING again'
            : `yes — playing at ${String(round(back.currentTime))} s, ${String(Math.round(context.mono() - takeBackAt))} ms after asking`,
          {
            takeBackMs: Math.round(context.mono() - takeBackAt),
            askedForSec: round(resumeFrom),
            landedAtSec: round(back?.currentTime ?? null),
            errorSec: round(
              back?.currentTime === undefined
                ? null
                : Math.abs((back.currentTime ?? 0) - resumeFrom),
            ),
          },
        ),
      );
      await release(fresh, takeBack);
    } catch (error) {
      findings.push(
        finding(
          'Can we take the television back, at the remembered position?',
          `no — ${error instanceof Error ? error.message : String(error)}`,
        ),
      );
    }

    return {
      probe: 'takeover',
      ran: true,
      note: null,
      findings,
      assumptions,
      wire: [...ours.wire, ...(thief?.wire ?? [])],
    };
  } finally {
    if (!ours.closed) await release(ours, cast);
    if (thief !== null && !thief.closed) thief.closePolitely();
  }
}

// --- Probe 3: our process exits and comes back -------------------------------

interface ReattachState {
  readonly savedAtWall: number;
  readonly mediaSessionId: number;
  readonly appSessionId: string | null;
  readonly transportId: string;
  readonly contentUrl: string;
  readonly token: string;
  readonly mediaPort: number;
  readonly positionSec: number | null;
}

async function probeReattachStart(context: Context): Promise<ProbeReport> {
  const session = await openSession({ ...sessionDeps(context), label: 'first-process' });
  const cast = await launchAndLoad(context, session, 0);
  const started = await playing(context, session, cast);
  if (started === null) throw new SpikeAbort('the device never reached PLAYING');
  await context.sleep(10_000);
  const snapshot = await status(context, session, cast.transportId, cast.mediaSessionId);

  const state: ReattachState = {
    savedAtWall: Date.now(),
    mediaSessionId: cast.mediaSessionId,
    appSessionId: cast.appSessionId,
    transportId: cast.transportId,
    contentUrl: cast.contentUrl,
    token: cast.token,
    mediaPort: context.media.port ?? MEDIA_SERVER.defaultPort,
    positionSec: snapshot?.currentTime ?? null,
  };
  await fsp.writeFile(context.stateFile, JSON.stringify(state, null, 2) + '\n', 'utf8');

  // Deliberately no STOP and no CLOSE: this process is about to vanish the way the app
  // does when the founder closes the window, and the media server vanishes with it. The
  // interrupt-safety release is dropped for the same reason — this probe *means* to leave
  // the television playing, and `reattach-join` is what hands it back.
  activeRelease = null;
  context.logger.warn('spike.leaving_tv_playing', { stateFile: context.stateFile, state });

  return {
    probe: 'reattach-start',
    ran: true,
    note: 'The TV is deliberately still playing, and this process is about to take its media server with it. Run `reattach-join` next.',
    findings: [
      finding(
        'What did we leave behind for the second process?',
        `media session ${String(cast.mediaSessionId)} at ${String(round(snapshot?.currentTime ?? null))} s, serving ${cast.contentUrl}`,
        { ...state } as unknown as Json,
      ),
    ],
    assumptions: [],
    wire: [...session.wire],
  };
}

async function probeReattachJoin(context: Context): Promise<ProbeReport> {
  let raw: string;
  try {
    raw = await fsp.readFile(context.stateFile, 'utf8');
  } catch {
    throw new SpikeAbort(
      `no reattach state at ${context.stateFile} — run --probe reattach-start first, in a separate process`,
    );
  }
  const state = asObject(JSON.parse(raw));
  const mediaSessionId = num(state['mediaSessionId']);
  const contentUrl = str(state['contentUrl']);
  const token = str(state['token']);
  const savedAtWall = num(state['savedAtWall']);
  const savedPositionSec = num(state['positionSec']);
  if (mediaSessionId === null || contentUrl === null || token === null || savedAtWall === null) {
    throw new SpikeAbort(`the reattach state at ${context.stateFile} is not usable`);
  }

  const findings: Finding[] = [];
  const assumptions: AssumptionVerdict[] = [];
  const startedAt = context.mono();

  // Re-publish the *same* URL before saying a word to the device: the TV has been asking
  // an address that stopped answering the moment the first process exited.
  const remount = context.media.mount({ path: context.options.filePath, kind: 'file', token });
  const republished = context.media.urlFor(remount, hostOf(contentUrl) ?? '0.0.0.0');
  findings.push(
    finding(
      'Could the second process re-publish the URL the TV is still fetching?',
      republished === contentUrl
        ? `yes — ${republished}`
        : `NO — republished ${republished} but the TV is asking for ${contentUrl}`,
      {
        sameUrl: republished === contentUrl,
        note: 'a fresh random token, or a different media-server port, would 404 every request the TV makes',
      },
    ),
  );

  const session = await openSession({ ...sessionDeps(context), label: 'second-process' });
  let cast: Cast | null = null;
  try {
    const receiver = readReceiver(
      await session.request(NS_RECEIVER, PLATFORM_RECEIVER, { type: 'GET_STATUS' }),
      context.mono(),
    );
    const gapSec = (Date.now() - savedAtWall) / 1000;
    findings.push(
      finding(
        'Is our receiver still running after the app went away?',
        receiver.appId === CAST.defaultReceiverAppId
          ? `yes, ${String(round(gapSec, 1))} s later — session ${receiver.sessionId ?? '?'}`
          : `no — appId is ${receiver.appId ?? 'null (home screen)'} after ${String(round(gapSec, 1))} s`,
        {
          appId: receiver.appId,
          sameAppSessionId: receiver.sessionId === str(state['appSessionId']),
          sameTransportId: receiver.transportId === str(state['transportId']),
          gapSec: round(gapSec, 1),
        },
      ),
    );

    let rejoined: MediaSnapshot | null = null;
    if (receiver.transportId !== null) {
      session.send(NS_CONNECTION, receiver.transportId, {
        type: 'CONNECT',
        userAgent: 'CastGood-spike',
      });
      rejoined = await status(context, session, receiver.transportId);
    }
    const reattachMs = Math.round(context.mono() - startedAt);
    const expectedSec = savedPositionSec === null ? null : savedPositionSec + gapSec;
    const rejoinedSec = rejoined === null ? null : rejoined.currentTime;
    const errorSec =
      expectedSec === null || rejoinedSec === null ? null : Math.abs(rejoinedSec - expectedSec);

    findings.push(
      finding(
        'Can a brand-new process rejoin the running session, and how long does it take?',
        rejoined === null
          ? 'no — no media status came back'
          : `yes in ${String(reattachMs)} ms — ${rejoined.playerState ?? '?'} at ${String(round(rejoined.currentTime))} s, media session ${String(rejoined.mediaSessionId)} (${rejoined.mediaSessionId === mediaSessionId ? 'same' : 'DIFFERENT'})`,
        {
          reattachMs,
          targetMs: 5_000,
          sameMediaSessionId: rejoined?.mediaSessionId === mediaSessionId,
          playerState: rejoined?.playerState ?? null,
          reportedPositionSec: round(rejoinedSec),
          expectedPositionSec: round(expectedSec),
          positionErrorSec: round(errorSec),
          contentIdMatches: rejoined?.contentId === contentUrl,
          contentId: rejoined?.contentId ?? null,
          note: 'contentId is how story 12b tells CastGood content from anything else on the TV',
        },
      ),
    );

    // Did it start asking us for bytes again once the server came back?
    await context.sleep(10_000);
    const fetched = mediaRequests(context, startedAt, context.mono());
    findings.push(
      finding(
        'Did the TV resume fetching from the re-published URL?',
        `${String(fetched['count'])} range request(s) in the ten seconds after we came back`,
        fetched,
      ),
    );

    const later =
      receiver.transportId === null ? null : await status(context, session, receiver.transportId);
    findings.push(
      finding(
        'Was playback interrupted by any of this?',
        later === null
          ? 'unknown — no status'
          : `${later.playerState ?? '?'} at ${String(round(later.currentTime))} s, ten seconds after rejoining`,
        { playerState: later?.playerState ?? null, idleReason: later?.idleReason ?? null },
      ),
    );

    assumptions.push(
      verdict(
        6,
        'Reattaching resumes rather than restarts',
        rejoined !== null &&
          rejoined.mediaSessionId === mediaSessionId &&
          later?.playerState === 'PLAYING'
          ? 'confirmed'
          : rejoined === null
            ? 'contradicted'
            : 'inconclusive',
        rejoined === null
          ? 'a fresh process could not read the running media session at all'
          : `same media session: ${String(rejoined.mediaSessionId === mediaSessionId)}; still ${later?.playerState ?? '?'} afterwards; rejoin took ${String(reattachMs)} ms against the mockup's 5 s label`,
      ),
    );

    const liveSessionId = rejoined === null ? null : rejoined.mediaSessionId;
    if (receiver.transportId !== null && rejoined !== null && liveSessionId !== null) {
      cast = {
        session,
        transportId: receiver.transportId,
        appSessionId: receiver.sessionId,
        mediaSessionId: liveSessionId,
        contentUrl,
        token,
        loadedAtMono: startedAt,
        first: rejoined,
      };
      const holding = cast;
      activeRelease = () => release(session, holding);
    }
    return {
      probe: 'reattach-join',
      ran: true,
      note: null,
      findings,
      assumptions,
      wire: [...session.wire],
    };
  } finally {
    await release(session, cast);
  }
}

// --- Probe 4: long seeks in both directions ----------------------------------

interface SeekResult {
  readonly label: string;
  readonly fromSec: number | null;
  readonly targetSec: number;
  readonly acceptedMs: number | null;
  readonly playingAtTargetMs: number | null;
  readonly landedSec: number | null;
  readonly landingErrorSec: number | null;
  readonly bufferedOnTheWay: boolean;
  readonly statesSeen: readonly string[];
  readonly reportedOldPositionForMs: number | null;
  readonly byteRequests: Json;
}

async function oneSeek(
  context: Context,
  session: Session,
  cast: Cast,
  label: string,
  targetSec: number,
): Promise<SeekResult> {
  const before = await status(context, session, cast.transportId, cast.mediaSessionId);
  const fromSec = before?.currentTime ?? null;
  const sentAt = context.mono();
  let acceptedMs: number | null = null;
  try {
    await session.request(NS_MEDIA, cast.transportId, {
      type: 'SEEK',
      mediaSessionId: cast.mediaSessionId,
      currentTime: targetSec,
    });
    acceptedMs = Math.round(context.mono() - sentAt);
  } catch (error) {
    context.logger.warn('spike.seek_not_acknowledged', { error, label, targetSec });
  }

  const result = await waitForStatus(
    context,
    session,
    cast.transportId,
    cast.mediaSessionId,
    30_000,
    (snapshot) =>
      snapshot.playerState === 'PLAYING' &&
      snapshot.currentTime !== null &&
      Math.abs(snapshot.currentTime - targetSec) < 3,
  );

  // How long the device went on reporting roughly where it used to be — criterion 6e is
  // about not snapping the readout back to it.
  const stale =
    fromSec === null
      ? []
      : result.samples.filter(
          (sample) => sample.currentTime !== null && Math.abs(sample.currentTime - fromSec) < 2,
        );
  const lastStale = stale[stale.length - 1];
  const landedSec = result.matched === null ? null : result.matched.currentTime;

  return {
    label,
    fromSec: round(fromSec),
    targetSec,
    acceptedMs,
    playingAtTargetMs: result.matched === null ? null : result.elapsedMs,
    landedSec: round(landedSec),
    landingErrorSec: landedSec === null ? null : round(Math.abs(landedSec - targetSec)),
    bufferedOnTheWay: result.samples.some((sample) => sample.playerState === 'BUFFERING'),
    statesSeen: [...new Set(result.samples.map((sample) => sample.playerState ?? '?'))],
    reportedOldPositionForMs:
      lastStale === undefined ? null : Math.round(lastStale.atMono - sentAt),
    byteRequests: mediaRequests(context, sentAt, context.mono()),
  };
}

async function probeSeek(context: Context): Promise<ProbeReport> {
  const findings: Finding[] = [];
  const assumptions: AssumptionVerdict[] = [];
  const session = await openSession({ ...sessionDeps(context), label: 'seek' });
  let cast: Cast | null = null;
  try {
    cast = await launchAndLoad(context, session, 0);
    const started = await playing(context, session, cast);
    if (started === null) throw new SpikeAbort('the device never reached PLAYING');
    await context.sleep(8_000);

    const durationSec = started.duration ?? cast.first.duration;
    if (durationSec === null || durationSec < 600) {
      throw new SpikeAbort(
        `this probe needs a long file; the device reports a duration of ${String(durationSec)} s`,
      );
    }
    findings.push(
      finding('How long does the device think the file is?', `${String(round(durationSec, 1))} s`, {
        durationSec: round(durationSec, 1),
      }),
    );

    // Roughly 20 minutes of travel in each direction, kept away from both ends.
    const far = Math.min(durationSec - 120, 1_500);
    const near = 120;

    const forward = await oneSeek(context, session, cast, 'forward-long', far);
    findings.push(
      finding(
        `Forward seek of ~${String(Math.round((far - (forward.fromSec ?? 0)) / 60))} minutes`,
        forward.playingAtTargetMs === null
          ? 'never reported playing at the target'
          : `playing at the target after ${String(forward.playingAtTargetMs)} ms, landed ${String(forward.landingErrorSec)} s from where we asked`,
        { ...forward } as unknown as Json,
      ),
    );

    await context.sleep(5_000);
    const backward = await oneSeek(context, session, cast, 'backward-long', near);
    findings.push(
      finding(
        `Backward seek of ~${String(Math.round(((backward.fromSec ?? 0) - near) / 60))} minutes`,
        backward.playingAtTargetMs === null
          ? 'never reported playing at the target'
          : `playing at the target after ${String(backward.playingAtTargetMs)} ms, landed ${String(backward.landingErrorSec)} s from where we asked`,
        { ...backward } as unknown as Json,
      ),
    );

    // A seek issued while the device is still buffering the previous one. Criterion 6k
    // (the skip buttons stay live while Buffering) rests entirely on this being tolerated,
    // and criterion 6d — five seeks collapsing to the last one — is the same question.
    const decoy = 900;
    const realTarget = 300;
    await session
      .request(NS_MEDIA, cast.transportId, {
        type: 'SEEK',
        mediaSessionId: cast.mediaSessionId,
        currentTime: decoy,
      })
      .catch(() => undefined);
    await context.sleep(300);
    const duringBuffer = await oneSeek(context, session, cast, 'while-buffering', realTarget);
    findings.push(
      finding(
        'Does the device tolerate a seek issued while it is still buffering the last one?',
        duringBuffer.playingAtTargetMs === null
          ? `no — it never reached ${String(realTarget)} s (states seen: ${duringBuffer.statesSeen.join(', ')})`
          : `yes — reached ${String(realTarget)} s ${String(duringBuffer.playingAtTargetMs)} ms after the second seek, having been sent to ${String(decoy)} s 300 ms earlier`,
        { ...duringBuffer, decoyTargetSec: decoy } as unknown as Json,
      ),
    );

    const both = [forward, backward];
    const landed = both.every((seek) => (seek.landingErrorSec ?? 99) <= 1);
    const quick = both.every((seek) => (seek.playingAtTargetMs ?? 99_999) <= 2_000);
    assumptions.push(
      verdict(
        3,
        'A seek lands within 1 s of the requested position and is reported accurately',
        landed ? 'confirmed' : 'contradicted',
        `forward landed ${String(forward.landingErrorSec)} s out, backward ${String(backward.landingErrorSec)} s out (criterion 6a allows 1 s)`,
      ),
      verdict(
        4,
        'A long forward seek in a large file works over our HTTP media server',
        forward.playingAtTargetMs === null ? 'contradicted' : 'confirmed',
        `${String(forward.byteRequests['count'])} range request(s), first at byte ${String(forward.byteRequests['firstStartByte'])}; playing at the target after ${String(forward.playingAtTargetMs)} ms`,
      ),
      verdict(
        5,
        'The device tolerates a seek while it is buffering',
        duringBuffer.playingAtTargetMs === null ? 'contradicted' : 'confirmed',
        `states seen while it settled: ${duringBuffer.statesSeen.join(', ')}`,
      ),
    );
    findings.push(
      finding(
        'Is 2 s (criterion 6a) a realistic budget from release to playing at the new point?',
        quick
          ? 'yes for both directions'
          : `NO — forward ${String(forward.playingAtTargetMs)} ms, backward ${String(backward.playingAtTargetMs)} ms`,
        {
          forwardMs: forward.playingAtTargetMs,
          backwardMs: backward.playingAtTargetMs,
          budgetMs: 2_000,
          backwardsSlower:
            forward.playingAtTargetMs !== null && backward.playingAtTargetMs !== null
              ? backward.playingAtTargetMs > forward.playingAtTargetMs
              : null,
        },
      ),
    );

    return { probe: 'seek', ran: true, note: null, findings, assumptions, wire: [...session.wire] };
  } finally {
    await release(session, cast);
  }
}

// --- The runner --------------------------------------------------------------

function sessionDeps(context: Context): Omit<SessionDeps, 'label'> {
  return {
    address: context.options.address,
    port: context.options.port,
    logger: context.logger,
    transport: context.transport,
  };
}

const RUNNERS: Record<ProbeName, (context: Context) => Promise<ProbeReport>> = {
  socket: probeSocket,
  takeover: probeTakeover,
  'reattach-start': probeReattachStart,
  'reattach-join': probeReattachJoin,
  seek: probeSeek,
};

export async function runSpike(options: SpikeOptions): Promise<SpikeReport> {
  const paths = resolveAppPaths();
  const logDir = options.logDir ?? paths.logDir;
  await fsp.mkdir(logDir, { recursive: true });

  const memory = createMemorySink();
  const logger = createLogger({
    sink: combineSinks(createFileSink(logDir, systemClock), memory),
    // debug, so the media server's own `media.request` lines land in the log: the byte
    // ranges the TV asks for are half the evidence in here.
    level: 'debug',
    bindings: { component: 'spike-m2' },
  });

  try {
    const stat = await fsp.stat(options.filePath);
    if (!stat.isFile()) throw new Error('not a file');
  } catch {
    throw new SpikeAbort(`file not found: ${options.filePath}`);
  }

  const media = createMediaServer({ logger });
  const started = systemClock.monoMs();
  const startedWall = new Date();
  const context: Context = {
    options: {
      address: options.address,
      port: options.port,
      filePath: options.filePath,
      probes: options.probes,
      logDir,
      takeoverAppId: options.takeoverAppId === undefined ? '233637DE' : options.takeoverAppId,
      humanWaitMs: options.humanWaitMs ?? 90_000,
      outageMs: options.outageMs ?? 15_000,
    },
    transport: options.unsafeTestTransport ?? tlsTransportFactory,
    logger,
    media,
    records: () => memory.lines.flatMap((line) => safeParse(line)),
    stateFile: path.join(logDir, 'spike-m2-reattach-state.json'),
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        timer.unref?.();
      }),
    mono: () => systemClock.monoMs(),
  };

  logger.info('spike.start', {
    address: options.address,
    port: options.port,
    file: options.filePath,
    probes: options.probes,
    warning: 'SPIKE-2 is throwaway code and drives a real television',
  });

  const address = await media.start();
  logger.info('spike.media_listening', { port: address.port });

  const probes: ProbeReport[] = [];
  try {
    for (const name of options.probes) {
      process.stderr.write(`\n[spike-m2] --- probe: ${name} ---\n`);
      try {
        probes.push(await RUNNERS[name](context));
      } catch (error) {
        if (error instanceof SpikeAbort) throw error;
        probes.push({
          probe: name,
          ran: false,
          note: `the probe threw: ${error instanceof Error ? error.message : String(error)}`,
          findings: [],
          assumptions: [],
          wire: [],
        });
        logger.error('spike.probe_failed', { probe: name, error });
      }
    }
  } finally {
    // `reattach-start` is the one probe that means to leave the TV playing; it also means
    // to take the media server with it, which is what the next process has to survive.
    // Every other exit — including a probe that aborted halfway — hands the TV back.
    if (!options.probes.includes('reattach-start')) await forceRelease(context);
    await media.stop();
    await logger.flush();
  }

  const report: SpikeReport = {
    schemaVersion: 1,
    spike: 'SPIKE-2',
    startedAt: startedWall.toISOString(),
    durationMs: Math.round(systemClock.monoMs() - started),
    device: { address: options.address, port: options.port },
    file: options.filePath,
    platform: process.platform,
    logDir,
    reportFile: null,
    transport: options.unsafeTestTransport === undefined ? 'tls' : 'test-harness',
    probes,
  };

  const file = path.join(
    logDir,
    `spike-m2-${startedWall.toISOString().replace(/[:.]/g, '-')}.json`,
  );
  const saved: SpikeReport = { ...report, reportFile: file };
  try {
    await fsp.writeFile(file, JSON.stringify(saved, null, 2) + '\n', 'utf8');
  } catch {
    return report;
  }
  await logger.flush();
  await logger.close();
  return saved;
}

function parseJson(data: string): Json {
  try {
    return asObject(JSON.parse(data));
  } catch {
    return {};
  }
}

/** The host out of a URL we wrote ourselves — but it has been through a file since. */
function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function safeParse(line: string): LogRecord[] {
  try {
    return [JSON.parse(line) as LogRecord];
  } catch {
    return [];
  }
}

/** The human-readable half. stdout carries the JSON; this goes to stderr. */
export function summarise(report: SpikeReport): string {
  const lines: string[] = [
    '',
    '================ SPIKE-2 findings ================',
    `device ${report.device.address}:${String(report.device.port)}   file ${path.basename(report.file)}   transport ${report.transport}`,
    report.transport === 'tls'
      ? ''
      : '*** SCRIPTED RECEIVER, NOT A TELEVISION — these findings prove nothing about a device ***',
    `${String(Math.round(report.durationMs / 1000))} s   log: ${report.logDir}`,
    '',
  ];
  for (const probe of report.probes) {
    lines.push(`--- ${probe.probe} ${probe.ran ? '' : '(DID NOT RUN)'}`);
    if (probe.note !== null) lines.push(`    note: ${probe.note}`);
    for (const item of probe.findings) {
      lines.push(`  Q ${item.question}`);
      lines.push(`  A ${item.answer}`);
    }
    for (const item of probe.assumptions) {
      lines.push(`  >> PRD assumption ${String(item.assumption)}: ${item.verdict.toUpperCase()}`);
      lines.push(`     ${item.claim}`);
      lines.push(`     ${item.because}`);
    }
    lines.push('');
  }
  const contradicted = report.probes.flatMap((probe) =>
    probe.assumptions.filter((item) => item.verdict === 'contradicted'),
  );
  lines.push(
    contradicted.length === 0
      ? 'No PRD assumption was contradicted by this run.'
      : `${String(contradicted.length)} PRD ASSUMPTION(S) CONTRADICTED: ${contradicted
          .map((item) => String(item.assumption))
          .join(', ')} — read the PRD's M2 assumptions table before building anything on them.`,
  );
  lines.push('A spike has findings, not a pass. Exit 0 only means it ran.', '');
  return lines.join('\n');
}
