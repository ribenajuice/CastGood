import http from 'node:http';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { CAST, PREPARATION } from '../config.js';
import { tlsTransportFactory } from '../cast/index.js';
import {
  combineSinks,
  createFileSink,
  createLogger,
  createMemorySink,
  systemClock,
  type Logger,
} from '../logging/index.js';
import { resolveAppPaths } from '../paths.js';
import { detectStalls, type ExcludedWindow, type PositionSample } from '../selftest/stalls.js';
import {
  NS_CONNECTION,
  NS_MEDIA,
  NS_RECEIVER,
  PLATFORM_RECEIVER,
  openSession,
  readMedia,
  readReceiver,
  SpikeAbort,
  finding,
  verdict,
  type Finding,
  type AssumptionVerdict,
  type MediaSnapshot,
  type Session,
  type Wire,
} from './m2.js';

/**
 * ============================================================================
 *  SPIKE-1 — THROWAWAY, AND **NOT YET**. See the note under this banner.
 * ============================================================================
 *
 * **Why this file still exists now that M3b's pipeline is built** (2026-08-21). The header
 * said to delete it with `src/engine/spike/` when M3 was built, and the honest reading of
 * the PRD is that it has one job left: *"the bedroom Chromecast passes the head-start check
 * before M3b ships"*, run as `scripts/spike-m3.sh --address <bedroom>` — step 0 of M3b's
 * build order, half an hour, no code. Deleting it would remove the tool that check is made
 * of, this week. It goes when that television has answered.
 *
 * **What was corrected rather than left in place.** A variable here was called `noStalls`
 * and it counted **segment 404s**. That one word is why the 2026-08-21 starved run — 46
 * seconds of frozen picture in 343 — reported both assumptions "confirmed". It is renamed
 * to what it measures, its verdict is now conditional on the playhead having actually
 * approached the frontier (a verdict that cannot fail is not a verdict), and a **third
 * assumption counts stalls from the device's own status frames**, through the same
 * `detectStalls` the `headstart` scenario uses — which is calibrated against this very run
 * in `test/engine/stall-detector.test.ts` and reports it dirty. The durable home for stall
 * assertions is that scenario; this is the lie removed from the throwaway on its way out.
 *
 * **The riskiest requirement in the product, and the only one still resting on a document
 * rather than on a television.**
 *
 * PRD story 10 says a film that is still being converted can be watched now. The
 * 2026-08-13 ADR decided how: serve HLS as an EVENT playlist that keeps growing, and let
 * the receiver refuse to seek past the part that does not exist yet. That ADR says, in as
 * many words, **"This decision is confirmed by documentation, not by observation"** — and
 * the documentation is Google's, about Google's receiver.
 *
 * Two things make that worth an evening. First, 2026-08-19 cost this project two
 * assumptions marked CONFIRMED that turned out to have been confirmed against something
 * easier than the real thing (a fake receiver, and a programmatic takeover standing in for
 * a phone). Second, **the founder's main television is not a Google device** — discovery
 * reports its friendly name with model `AI PONT`. Whatever Google documents about their
 * player is not a fact about that box.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO
 *
 * It does not convert anything, and it does not need ffmpeg at run time. The risk here is
 * entirely about **the receiver**: does it re-read a playlist that is still growing, does
 * it stay inside the published region, and does it ever ask for a segment we have not
 * written? None of that requires the conversion pipeline to exist. So the segments are a
 * **fixture** — made once, by hand, with ffmpeg — and this spike republishes them on a
 * timer exactly as a running conversion would. If the answer is no, we learn it now,
 * before ffmpeg, the classifier, the tier planner or the progress UI are built on top.
 *
 * WHAT IT ANSWERS
 *
 *   1. Does the receiver keep playing past the segments that existed when it started —
 *      i.e. does it re-read the playlist at all?
 *   2. Does it ever request a segment that has not been published? (A single 404 is the
 *      whole risk: it is the stall the PRD forbids.)
 *   3. Can the founder pause a still-growing stream, and does resuming work?
 *   4. Can they seek backwards inside the published region?
 *   5. What does it do when asked to seek *past* the frontier — refuse, clamp, or stall?
 *   6. What duration does it report while the playlist is still open, and what does it
 *      report once ENDLIST is written?
 *
 * Exit codes match SPIKE-2 exactly: **0** it ran and recorded, **2** it could not run.
 * There is no exit 1 — a television behaving unexpectedly is the point, not a failure.
 */

type Json = Record<string, unknown>;

export interface HeadStartOptions {
  readonly address: string;
  readonly port: number;
  /** A directory of `.ts` segments plus a `source.m3u8` naming them, made by ffmpeg. */
  readonly fixtureDir: string;
  /** How many segments exist before the television is told anything. The "head start". */
  readonly headStartSegments: number;
  /**
   * How fast the imaginary conversion runs, relative to playback.
   *
   * `1.0` publishes one segment's worth of video per segment's worth of wall clock — a
   * conversion running at exactly playback speed, where the playhead never gains and never
   * loses. **Below 1.0 is the interesting case**: the frontier creeps toward the playhead,
   * which is what the PRD's 2-minute margin exists for and the only way to find out what
   * this receiver does when it runs out of published video.
   */
  readonly publishRate: number;
  /** How long to watch before writing ENDLIST and finishing. */
  readonly watchMs: number;
  readonly logger: Logger;
}

/** One request the television made of us, and what it got. */
interface ServedRequest {
  readonly atMono: number;
  readonly url: string;
  readonly status: number;
  /** True when the TV asked for a segment the imaginary conversion had not reached. */
  readonly pastFrontier: boolean;
}

interface Fixture {
  readonly targetDurationSec: number;
  readonly segments: readonly { readonly name: string; readonly durationSec: number }[];
}

/**
 * Seconds of film in the first `count` segments — **summed, never multiplied**.
 *
 * A stream-copied fixture cannot have even segments: ffmpeg can only cut at keyframes, so
 * `-hls_time 4` against a real film produces anything from 0.96 s to 12.26 s. Treating
 * `TARGETDURATION` (the *ceiling*, 12) as the segment length would have made this spike
 * report a conversion running at 1.5× playback while it actually crawled at 0.55× — the
 * frontier starving the playhead, every "how far did it get" number wrong, and a stall
 * blamed on the television that we had caused ourselves. That is precisely the lying
 * instrument this project has already paid for twice, and it was caught by looking at what
 * ffmpeg really wrote rather than at what it was asked for.
 */
export function secondsIn(fixture: Fixture, count: number): number {
  return fixture.segments
    .slice(0, Math.max(0, count))
    .reduce((total, segment) => total + segment.durationSec, 0);
}

/** How many whole segments fit in `seconds` of published video. The inverse of the above. */
export function segmentsWithin(fixture: Fixture, seconds: number): number {
  let total = 0;
  let count = 0;
  for (const segment of fixture.segments) {
    if (total + segment.durationSec > seconds) break;
    total += segment.durationSec;
    count += 1;
  }
  return count;
}

/**
 * Read what ffmpeg produced, so the spike republishes *real* segment durations.
 *
 * Inventing them would be the fake-receiver mistake in a new place: a playlist whose
 * `#EXTINF` values do not match its segments is a playlist no receiver has ever seen, and
 * findings from it would describe our arithmetic rather than the television.
 */
export function parsePlaylist(text: string): Fixture {
  const lines = text.split(/\r?\n/);
  const segments: { name: string; durationSec: number }[] = [];
  let targetDurationSec = 0;
  let pending: number | null = null;
  for (const line of lines) {
    const target = /^#EXT-X-TARGETDURATION:(\d+(?:\.\d+)?)/.exec(line);
    if (target?.[1] !== undefined) {
      targetDurationSec = Number(target[1]);
      continue;
    }
    const inf = /^#EXTINF:(\d+(?:\.\d+)?)/.exec(line);
    if (inf?.[1] !== undefined) {
      pending = Number(inf[1]);
      continue;
    }
    if (line.startsWith('#') || line.trim() === '') continue;
    segments.push({ name: line.trim(), durationSec: pending ?? targetDurationSec });
    pending = null;
  }
  if (segments.length === 0) throw new SpikeAbort('the fixture playlist names no segments');
  if (targetDurationSec === 0) {
    targetDurationSec = Math.ceil(Math.max(...segments.map((s) => s.durationSec)));
  }
  return { targetDurationSec, segments };
}

/**
 * The playlist as it would look after `published` segments have been written.
 *
 * `EXT-X-PLAYLIST-TYPE:EVENT` and the **absence of `EXT-X-ENDLIST`** are the two lines the
 * whole ADR turns on: Google documents that its player decides live-vs-VOD solely by
 * ENDLIST's presence. Whether *this* television agrees is the question.
 */
export function playlistFor(
  fixture: Fixture,
  published: number,
  ended: boolean,
  baseUrl = '',
): string {
  // **TARGETDURATION is a ceiling, and it must actually hold.** ffmpeg declares it from
  // what it *asked* for, then stream-copies at keyframes and overshoots: the founder's own
  // film produced `#EXT-X-TARGETDURATION:12` next to a 12.26 s segment, which is invalid
  // HLS and grounds for a strict receiver to refuse the whole playlist. Recomputed from
  // what is really there rather than copied from the fixture.
  const longest = fixture.segments.reduce((max, s) => Math.max(max, s.durationSec), 0);
  const lines = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${String(Math.ceil(longest))}`,
    '#EXT-X-MEDIA-SEQUENCE:0',
    '#EXT-X-PLAYLIST-TYPE:EVENT',
  ];
  for (const segment of fixture.segments.slice(0, published)) {
    // Absolute URLs, as the 2026-08-13 ADR requires in as many words ("absolute URLs, no
    // redirects"). A relative name *should* resolve against the playlist URL, and the first
    // run of this spike used one — which is one of the two candidate reasons the television
    // refused the load. Following the ADR removes the variable.
    lines.push(`#EXTINF:${segment.durationSec.toFixed(6)},`, `${baseUrl}${segment.name}`);
  }
  if (ended) lines.push('#EXT-X-ENDLIST');
  return lines.join('\n') + '\n';
}

/** The address the television must come back to. Never guessed — asked of the OS. */
function localAddressFor(deviceAddress: string): string {
  const families = Object.values(networkInterfaces()).flatMap((list) => list ?? []);
  const candidates = families.filter((entry) => entry.family === 'IPv4' && !entry.internal);
  const prefix = deviceAddress.split('.').slice(0, 3).join('.');
  const sameSubnet = candidates.find((entry) => entry.address.startsWith(prefix + '.'));
  const chosen = sameSubnet ?? candidates[0];
  if (chosen === undefined) throw new SpikeAbort('this PC has no usable IPv4 address');
  return chosen.address;
}

interface GrowingServer {
  readonly port: number;
  readonly requests: readonly ServedRequest[];
  /** Where the television should fetch segments from. Set once the port is known. */
  setBaseUrl(url: string): void;
  /** How many segments the imaginary conversion has finished. */
  published(): number;
  publish(count: number): void;
  end(): void;
  close(): Promise<void>;
}

/**
 * Serves the fixture as if it were being converted right now.
 *
 * Deliberately its own tiny server rather than the engine's: the engine's media server
 * serves *one file per token*, and an HLS directory is the second serving shape the ADR
 * describes and M3 has to build. Proving the receiver's behaviour must not wait on that.
 */
export async function startGrowingServer(
  fixture: Fixture,
  fixtureDir: string,
  logger: Logger,
  clock: () => number,
): Promise<GrowingServer> {
  const requests: ServedRequest[] = [];
  let published = 0;
  let ended = false;
  // Filled in once the socket has a port. The playlist names segments absolutely, so it
  // cannot be written until we know the address the television will be told to use.
  let baseUrl = '';

  const server = http.createServer((request, response) => {
    const url = request.url ?? '/';
    const name = path.basename(url.split('?')[0] ?? '');
    const record = (status: number, pastFrontier = false): void => {
      requests.push({ atMono: clock(), url, status, pastFrontier });
      logger.info('spike.http', { url, status, published, pastFrontier });
    };

    // **CORS, and it is not optional for HLS.**
    //
    // A progressive MP4 is fetched by the receiver's <video> element, which needs no CORS.
    // HLS is not: the receiver parses the playlist in JavaScript and feeds segments through
    // Media Source Extensions, so every fetch is an XHR subject to the browser's
    // same-origin rules. Without `Access-Control-Allow-Origin` the receiver can read
    // nothing, and what the sender sees is a bare `LOAD_FAILED` with **no reason attached**
    // — which is exactly what this spike hit twice against a Chromecast Ultra: the playlist
    // fetched 200 OK four times, not one segment ever requested, and the load refused.
    //
    // This is a finding about M3's media server, not about the spike: the second serving
    // shape the 2026-08-13 ADR describes needs headers the first one never did.
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range');
    response.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    if (request.method === 'OPTIONS') {
      response.writeHead(204).end();
      record(204);
      return;
    }

    if (name === 'stream.m3u8') {
      const body = playlistFor(fixture, published, ended, baseUrl);
      response.writeHead(200, {
        'content-type': 'application/vnd.apple.mpegurl',
        'content-length': Buffer.byteLength(body),
        // A cached playlist would never grow, and the whole point is that it grows.
        'cache-control': 'no-cache, no-store, must-revalidate',
      });
      response.end(body);
      record(200);
      return;
    }

    const index = fixture.segments.findIndex((segment) => segment.name === name);
    if (index === -1) {
      response.writeHead(404).end();
      record(404);
      return;
    }
    // **The finding this spike exists for.** A request for a segment beyond what we have
    // "converted" is the receiver reading past the frontier — the stall the PRD forbids.
    // It is answered honestly with a 404, because that is what a real conversion would do.
    if (index >= published) {
      response.writeHead(404).end();
      record(404, true);
      return;
    }
    response.writeHead(200, { 'content-type': 'video/mp2t' });
    createReadStream(path.join(fixtureDir, name)).pipe(response);
    record(200);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new SpikeAbort('the spike server did not get a port');
  }

  return {
    port: address.port,
    requests,
    setBaseUrl(url: string) {
      baseUrl = url;
    },
    published: () => published,
    publish(count) {
      published = Math.min(count, fixture.segments.length);
    },
    end() {
      ended = true;
      published = fixture.segments.length;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

async function loadHls(session: Session, url: string, transportId: string): Promise<number> {
  session.send(NS_CONNECTION, transportId, { type: 'CONNECT', userAgent: 'CastGood-spike' });
  const loaded = await session.request(
    NS_MEDIA,
    transportId,
    {
      type: 'LOAD',
      autoplay: true,
      currentTime: 0,
      media: {
        contentId: url,
        // What we would send for a film. The ADR's claim is that the receiver decides
        // live-vs-VOD from ENDLIST regardless of what we say here, so this is deliberately
        // the *VOD* answer: if the claim is wrong, the disagreement shows up here.
        streamType: 'BUFFERED',
        contentType: 'application/vnd.apple.mpegurl',
      },
    },
    30_000,
  );
  // **A rejected load is a run that could not happen, never a finding.**
  //
  // The first version of this spike missed `LOAD_FAILED` entirely: the television refused
  // the playlist in 3.5 s, every later question answered "no status at all", and the report
  // then declared the growing-playlist assumption **CONTRADICTED** — a verdict about
  // behaviour it had never once observed. That is the same lying instrument that cost this
  // project M1's phantom stop delay and M2's three bad selftest numbers, and it is worse
  // here, because a false CONTRADICTED would have cancelled story 10 on the strength of a
  // bug in the test. The exit-code contract exists for exactly this: exit 2, not a finding.
  // **The refusal does not arrive as the reply.** `LOAD_FAILED` carries the LOAD's own
  // requestId but reaches us *after* an unsolicited `MEDIA_STATUS` has already resolved the
  // request — so checking the returned payload catches nothing, which is why the first
  // version of this guard sat there looking correct while the spike went on to report a
  // verdict about a film that never played. The socket's own record is the only honest
  // place to look, so we wait a beat and read it.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const refusal = session.wire.find(
    (frame) =>
      frame.dir === 'in' && (frame.type === 'LOAD_FAILED' || frame.type === 'LOAD_CANCELLED'),
  );
  const type = refusal?.type ?? String(loaded['type'] ?? '');
  if (type === 'LOAD_FAILED' || type === 'LOAD_CANCELLED') {
    throw new SpikeAbort(
      `the television refused the playlist (${type}). Nothing about a growing playlist was ` +
        'tested — this is a run that could not happen, not a finding. The wire trace in the ' +
        'engine log has the exact frames.',
    );
  }
  const media = readMedia(loaded, 0);
  if (media === null || media.mediaSessionId === null) {
    throw new SpikeAbort('the device accepted no media session for the playlist');
  }
  return media.mediaSessionId;
}

export interface HeadStartReport {
  readonly findings: readonly Finding[];
  readonly assumptions: readonly AssumptionVerdict[];
  readonly samples: readonly MediaSnapshot[];
  readonly requests: readonly ServedRequest[];
  readonly wire: readonly Wire[];
}

/**
 * Cast a growing playlist and watch what the television does with it.
 *
 * Every question is answered from what was *observed*, and where nothing was observed the
 * answer says so rather than reporting a default. A spike that quietly reports zeros is
 * the lying instrument this project has already paid for twice.
 */
export async function probeHeadStart(options: HeadStartOptions): Promise<HeadStartReport> {
  const started = Date.now();
  const mono = (): number => Date.now() - started;
  const { logger } = options;

  const playlistPath = path.join(options.fixtureDir, 'source.m3u8');
  let fixtureText: string;
  try {
    fixtureText = await fsp.readFile(playlistPath, 'utf8');
  } catch {
    throw new SpikeAbort(
      `no fixture at ${playlistPath}. Make one once with ffmpeg — see scripts/spike-m3.sh --help`,
    );
  }
  const fixture = parsePlaylist(fixtureText);
  const totalSec = fixture.segments.reduce((sum, segment) => sum + segment.durationSec, 0);

  const server = await startGrowingServer(fixture, options.fixtureDir, logger, mono);
  const local = localAddressFor(options.address);
  const url = `http://${local}:${String(server.port)}/stream.m3u8`;
  server.setBaseUrl(`http://${local}:${String(server.port)}/`);
  server.publish(options.headStartSegments);
  logger.info('spike.fixture', {
    segments: fixture.segments.length,
    totalSec: Math.round(totalSec),
    targetDurationSec: fixture.targetDurationSec,
    headStartSegments: options.headStartSegments,
    publishRate: options.publishRate,
    url,
  });

  const session = await openSession({
    address: options.address,
    port: options.port,
    logger,
    label: 'headstart',
    transport: tlsTransportFactory,
  });

  const findings: Finding[] = [];
  const samples: MediaSnapshot[] = [];
  let publisher: NodeJS.Timeout | null = null;

  try {
    const launch = await session.request(
      NS_RECEIVER,
      PLATFORM_RECEIVER,
      { type: 'LAUNCH', appId: CAST.defaultReceiverAppId },
      CAST.launchTimeoutMs,
    );
    const receiver = readReceiver(launch, mono());
    if (receiver.transportId === null) {
      throw new SpikeAbort('the device did not launch the Default Media Receiver');
    }
    const mediaSessionId = await loadHls(session, url, receiver.transportId);
    const transportId = receiver.transportId;

    // The imaginary conversion starts running the moment the film is on screen.
    //
    // Driven by **elapsed wall time against real cumulative segment durations**, not by a
    // fixed tick: at `t` seconds the conversion has produced `headStart + t × rate` seconds
    // of video, and we publish however many whole segments fit inside that. With segments
    // ranging 0.96–12.26 s, a fixed tick would mean the requested rate and the actual rate
    // had nothing to do with each other.
    const headStartSec = secondsIn(fixture, options.headStartSegments);
    const conversionStartedAt = mono();
    publisher = setInterval(() => {
      const elapsedSec = (mono() - conversionStartedAt) / 1000;
      const producedSec = headStartSec + elapsedSec * options.publishRate;
      server.publish(Math.max(options.headStartSegments, segmentsWithin(fixture, producedSec)));
    }, 500);

    const ask = async (): Promise<MediaSnapshot | null> => {
      const reply = await session.request(
        NS_MEDIA,
        transportId,
        { type: 'GET_STATUS', mediaSessionId },
        10_000,
      );
      const snapshot = readMedia(reply, mono());
      if (snapshot !== null) samples.push(snapshot);
      return snapshot;
    };

    const first = await ask();
    findings.push(
      finding(
        'What does the television report about a playlist that is still growing?',
        first === null
          ? 'no status at all'
          : `playerState ${first.playerState ?? 'null'}, duration ${
              first.duration === null ? 'null' : first.duration.toFixed(1) + ' s'
            } against a fixture of ${totalSec.toFixed(1)} s`,
        {
          reportedDurationSec: first?.duration ?? null,
          fixtureTotalSec: Number(totalSec.toFixed(3)),
          publishedAtLoad: options.headStartSegments,
        },
      ),
    );

    // --- Watch it play past the head start ---------------------------------
    const deadline = mono() + options.watchMs;
    let furthest = 0;
    /**
     * The smallest gap ever seen between the playhead and the conversion frontier.
     *
     * **This is what makes assumption 2 able to fail.** SPIKE-1's own post-mortem: with the
     * frontier fleeing the playhead all evening the receiver was never once in a position to
     * ask for a segment that did not exist, so *"none past the frontier"* was true and
     * proved nothing — the identical verdict was printed by two runs in which the television
     * played nothing at all. Measured now, so the verdict can say "not tested" instead.
     */
    let closestApproachSec: number | null = null;
    while (mono() < deadline) {
      const snapshot = await ask();
      if (snapshot?.currentTime !== null && snapshot !== null) {
        furthest = Math.max(furthest, snapshot.currentTime ?? 0);
        const gap = secondsIn(fixture, server.published()) - (snapshot.currentTime ?? 0);
        closestApproachSec = closestApproachSec === null ? gap : Math.min(closestApproachSec, gap);
      }
      if (snapshot?.idleReason !== null && snapshot?.idleReason !== undefined) break;
      await new Promise((resolve) => setTimeout(resolve, 5_000));
    }
    // "Approached the edge" is the PRD's own two-minute margin: closer than that and the
    // receiver really was in a position to ask for something that did not exist.
    const approachedTheEdge =
      closestApproachSec !== null && closestApproachSec <= PREPARATION.frontierMarginSeconds;

    findings.push(
      finding(
        'Does it keep playing past the segments that existed when it started — does it re-read the playlist?',
        furthest > headStartSec
          ? `yes — reached ${furthest.toFixed(1)} s, past the ${headStartSec.toFixed(1)} s that existed at load`
          : `NO — stopped at ${furthest.toFixed(1)} s against a head start of ${headStartSec.toFixed(1)} s`,
        {
          furthestSec: Number(furthest.toFixed(3)),
          headStartSec,
          publishedNow: server.published(),
        },
      ),
    );

    const pastFrontier = server.requests.filter((request) => request.pastFrontier);
    findings.push(
      finding(
        'Did it ever ask for a segment the conversion had not reached?',
        pastFrontier.length === 0
          ? 'no — not once'
          : `YES — ${String(pastFrontier.length)} request(s), the first at ${String(
              Math.round((pastFrontier[0]?.atMono ?? 0) / 1000),
            )} s`,
        {
          pastFrontierRequests: pastFrontier.length,
          totalRequests: server.requests.length,
          playlistReloads: server.requests.filter((r) => r.url.includes('.m3u8')).length,
        },
      ),
    );

    // --- Pause and resume, mid-conversion -----------------------------------
    // **`request`, never `send`.** Every media command needs a `requestId`, and only
    // `request()` attaches one — `send()` produces a frame the receiver answers with
    // `INVALID_REQUEST / INVALID_REQUEST_ID` and otherwise ignores. The first run that got
    // this far used `send`, so pause and both seeks did precisely nothing while playback
    // rolled on underneath them, and the report would have said this television refuses to
    // pause a growing stream. It says no such thing; it never received the command.
    await session.request(NS_MEDIA, transportId, { type: 'PAUSE', mediaSessionId }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const paused = await ask();
    await session.request(NS_MEDIA, transportId, { type: 'PLAY', mediaSessionId }, 10_000);
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const resumed = await ask();
    const rejected = session.wire.filter(
      (frame) => frame.dir === 'in' && frame.type === 'INVALID_REQUEST',
    );
    if (rejected.length > 0) {
      throw new SpikeAbort(
        `the television rejected ${String(rejected.length)} media command(s) as malformed ` +
          `(${rejected[0]?.data ?? ''}). Nothing about pausing or seeking a growing playlist ` +
          'was tested — this is a broken instrument, not a finding.',
      );
    }

    findings.push(
      finding(
        'Can a still-growing stream be paused and resumed?',
        `paused → ${paused?.playerState ?? 'no answer'}; resumed → ${
          resumed?.playerState ?? 'no answer'
        }`,
        { pausedAtSec: paused?.currentTime ?? null, resumedAtSec: resumed?.currentTime ?? null },
      ),
    );

    // --- A long jump backwards, inside the published region -----------------
    const back = Math.max(0, (resumed?.currentTime ?? headStartSec) - 30);
    await session.request(
      NS_MEDIA,
      transportId,
      { type: 'SEEK', mediaSessionId, currentTime: back },
      15_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    const afterBack = await ask();
    findings.push(
      finding(
        'Can the founder jump backwards inside the part that has been converted?',
        afterBack?.currentTime === null || afterBack === null
          ? 'no answer'
          : `asked for ${back.toFixed(1)} s, landed at ${afterBack.currentTime.toFixed(1)} s`,
        {
          requestedSec: Number(back.toFixed(3)),
          landedSec: afterBack?.currentTime ?? null,
          playerState: afterBack?.playerState ?? null,
        },
      ),
    );

    // --- And forwards, past the frontier ------------------------------------
    const frontierSec = secondsIn(fixture, server.published());
    const beyond = frontierSec + 120;
    await session
      .request(NS_MEDIA, transportId, { type: 'SEEK', mediaSessionId, currentTime: beyond }, 15_000)
      .catch(() => {
        // A refusal is a legitimate answer to "seek past the frontier" and must not end the
        // run — it is one of the outcomes this question is asking about.
      });
    await new Promise((resolve) => setTimeout(resolve, 8_000));
    const afterForward = await ask();
    const frontierRequestsAfter = server.requests.filter(
      (request) => request.pastFrontier && request.atMono > (afterBack?.atMono ?? 0),
    );
    findings.push(
      finding(
        'What happens when it is asked to seek PAST the conversion frontier?',
        afterForward === null
          ? 'no answer'
          : `asked for ${beyond.toFixed(1)} s (frontier ${frontierSec.toFixed(1)} s), landed at ${
              afterForward.currentTime?.toFixed(1) ?? 'null'
            } s in state ${afterForward.playerState ?? 'null'}${
              afterForward.idleReason === null ? '' : ` (idleReason ${afterForward.idleReason})`
            }`,
        {
          frontierSec: Number(frontierSec.toFixed(3)),
          requestedSec: Number(beyond.toFixed(3)),
          landedSec: afterForward?.currentTime ?? null,
          playerState: afterForward?.playerState ?? null,
          idleReason: afterForward?.idleReason ?? null,
          requestsPastFrontierAfterSeek: frontierRequestsAfter.length,
        },
      ),
    );

    // --- ENDLIST: the same artifact becomes an ordinary film -----------------
    server.end();
    await new Promise((resolve) => setTimeout(resolve, 6_000));
    const afterEnd = await ask();
    findings.push(
      finding(
        'Once ENDLIST is written, does it report the whole film?',
        afterEnd === null
          ? 'no answer'
          : `duration ${afterEnd.duration?.toFixed(1) ?? 'null'} s against a fixture of ${totalSec.toFixed(1)} s`,
        {
          reportedDurationSec: afterEnd?.duration ?? null,
          fixtureTotalSec: Number(totalSec.toFixed(3)),
        },
      ),
    );

    // **`noStalls` used to be this variable's name, and it counted segment 404s.**
    //
    // That one word is why a run with 46 seconds of frozen picture reported both assumptions
    // "confirmed" on 2026-08-21. A 404 is one way a growing playlist can fail; the founder's
    // picture stopping is the *other*, it is the one story 10 exists to prevent, and this
    // spike had no assertion about it at all. Renamed, and joined below by the count it was
    // pretending to be.
    const noneAskedPastFrontier = pastFrontier.length === 0;
    const keptReading = furthest > headStartSec;

    // Every status the television volunteered, not only the ones we asked for: the polls are
    // seconds apart and a freeze between two of them is invisible to them.
    const wireSamples: PositionSample[] = session.wire
      .filter((entry) => entry.dir === 'in' && entry.type === 'MEDIA_STATUS')
      .flatMap((entry) => {
        let snapshot: MediaSnapshot | null;
        try {
          snapshot = readMedia(JSON.parse(entry.data) as Json, entry.atMono);
        } catch {
          // Another process's output, parsed defensively: a frame we cannot read is one we
          // do not count, never one that throws in the middle of a verdict.
          return [];
        }
        return snapshot === null
          ? []
          : [
              {
                monoMs: entry.atMono,
                positionSec: snapshot.currentTime,
                playerState: snapshot.playerState,
              },
            ];
      });
    // The spike presses things — a pause, a resume, two seeks — and a picture that stops
    // because we stopped it is not a stall.
    const commanded: ExcludedWindow[] = session.wire
      .filter(
        (entry) =>
          entry.dir === 'out' &&
          entry.type !== null &&
          ['PAUSE', 'PLAY', 'SEEK', 'STOP'].includes(entry.type),
      )
      .map((entry) => ({
        fromMs: entry.atMono - 500,
        toMs: entry.atMono + 8_000,
        why: 'commanded' as const,
      }));
    const stalls = detectStalls(wireSamples, { excluded: commanded });

    findings.push(
      finding(
        'Did the picture ever freeze — and for how long?',
        stalls.samples === 0
          ? 'no device status was recorded, so this run says nothing about stalling'
          : `${String(stalls.count)} stall(s) of ${String(PREPARATION.stallSeconds)} s or more, ${stalls.totalSeconds.toFixed(
              1,
            )} s of frozen picture in total, the worst ${stalls.longestSeconds.toFixed(1)} s`,
        {
          stalls: stalls.count,
          totalStalledSec: stalls.totalSeconds,
          longestStallSec: stalls.longestSeconds,
          // *Read the histogram, never the verdict.*
          playerStates: stalls.playerStates,
          samples: stalls.samples,
          stallsAt: stalls.stalls.map((stall) => stall.atSec),
        },
      ),
    );

    const assumptions: AssumptionVerdict[] = [
      verdict(
        1,
        'A receiver plays a growing EVENT playlist, re-reading it as segments are added',
        keptReading ? 'confirmed' : 'contradicted',
        keptReading
          ? `played to ${furthest.toFixed(1)} s past a ${headStartSec.toFixed(1)} s head start`
          : `never got past ${furthest.toFixed(1)} s of a ${headStartSec.toFixed(1)} s head start`,
      ),
      verdict(
        2,
        'The receiver stays inside the published region without our help — no segment 404s',
        // **Conditional on the playhead having actually approached the edge**, which is what
        // SPIKE-1's own post-mortem demanded: with the frontier fleeing the playhead all
        // evening the receiver was never once in a position to ask for a segment that did not
        // exist, and the identical "confirmed" was printed by two runs in which the
        // television played nothing at all. A verdict that cannot fail is not a verdict.
        !approachedTheEdge ? 'inconclusive' : noneAskedPastFrontier ? 'confirmed' : 'contradicted',
        !approachedTheEdge
          ? `the playhead never came within ${String(PREPARATION.frontierMarginSeconds)} s of the frontier, so nothing here tested it (closest: ${closestApproachSec === null ? 'never measured' : closestApproachSec.toFixed(1) + ' s'})`
          : noneAskedPastFrontier
            ? `${String(server.requests.length)} requests, none past the frontier, and the playhead came within ${(closestApproachSec ?? 0).toFixed(1)} s of it`
            : `${String(pastFrontier.length)} request(s) past the frontier`,
      ),
      verdict(
        3,
        'The picture never freezes: the founder watches without a stall',
        stalls.samples === 0 ? 'inconclusive' : stalls.count === 0 ? 'confirmed' : 'contradicted',
        stalls.samples === 0
          ? 'no device status was recorded'
          : `${String(stalls.count)} stall(s), ${stalls.totalSeconds.toFixed(1)} s frozen, worst ${stalls.longestSeconds.toFixed(1)} s, from ${String(stalls.samples)} device reports`,
      ),
    ];

    return { findings, assumptions, samples, requests: server.requests, wire: session.wire };
  } finally {
    if (publisher !== null) clearInterval(publisher);
    // A spike that leaves a television playing is a spike nobody runs twice.
    try {
      session.send(NS_RECEIVER, PLATFORM_RECEIVER, { type: 'STOP' });
    } catch {
      /* the socket may already be gone; the television is what matters, not this line */
    }
    session.closePolitely();
    await server.close();
  }
}

export interface SpikeM3Report {
  readonly schemaVersion: 1;
  readonly spike: 'SPIKE-1';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly device: { readonly address: string; readonly port: number };
  readonly fixtureDir: string;
  readonly platform: string;
  readonly logDir: string;
  readonly findings: readonly Finding[];
  readonly assumptions: readonly AssumptionVerdict[];
  readonly samples: readonly MediaSnapshot[];
  readonly requests: readonly ServedRequest[];
  readonly wire: readonly Wire[];
}

export async function runSpikeM3(
  options: Omit<HeadStartOptions, 'logger'>,
): Promise<SpikeM3Report> {
  const paths = resolveAppPaths();
  const memory = createMemorySink();
  const logger = createLogger({
    sink: combineSinks(createFileSink(paths.logDir, systemClock), memory),
    clock: systemClock,
    level: 'debug',
    bindings: { component: 'spike-m3' },
  });
  const startedAt = new Date().toISOString();
  const began = Date.now();
  const report = await probeHeadStart({ ...options, logger });
  return {
    schemaVersion: 1,
    spike: 'SPIKE-1',
    startedAt,
    durationMs: Date.now() - began,
    device: { address: options.address, port: options.port },
    fixtureDir: options.fixtureDir,
    platform: process.platform,
    logDir: paths.logDir,
    ...report,
  };
}

export function summariseM3(report: SpikeM3Report): string {
  const lines = [
    '',
    '================ SPIKE-1 findings ================',
    `device ${report.device.address}:${String(report.device.port)}   fixture ${report.fixtureDir}`,
    `${String(Math.round(report.durationMs / 1000))} s   log: ${report.logDir}`,
    '',
  ];
  for (const item of report.findings) {
    lines.push(`  Q ${item.question}`, `  A ${item.answer}`, '');
  }
  for (const item of report.assumptions) {
    lines.push(`  >> ${item.verdict.toUpperCase()}: ${item.claim}`, `     ${item.because}`, '');
  }
  lines.push('A spike has findings, not a pass. Exit 0 only means it ran.', '');
  return lines.join('\n');
}

export type { Json };
