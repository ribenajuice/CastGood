import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import path from 'node:path';
import { networkInterfaces } from 'node:os';
import { CAST } from '../config.js';
import type { Logger } from '../logging/index.js';
import type { TransportFactory } from '../cast/index.js';
import { buildPlaylist } from '../media-server/hls.js';
import { contentTypeFor } from '../media-server/index.js';
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
  type Session,
} from './m2.js';

/**
 * ============================================================================
 *  SPIKE-4 — the queue's one real unknown, measured before any queue exists
 * ============================================================================
 *
 * M5b step 0. **No feature code**, and nothing here ships.
 *
 * The PRD asks two questions. This answers the first, which is the genuinely
 * unknown one:
 *
 *   **"A second `LOAD` into a session we are already running starts the next
 *   film without relaunching the receiver — no home screen between films, and
 *   a gap inside the existing 10 s budget."**
 *
 * ⚠️ **Why it matters more than it sounds.** If it does not hold, criterion
 * 24m becomes *"the television returns to its home screen briefly between
 * films"* — slower, visibly different, and something the founder should see
 * before a queue is built on the opposite assumption rather than after.
 *
 * **The second question is deliberately not asked here.** *"The end of a film
 * is distinguishable from every other way a session can end"* is answered by
 * 13g, which already ships and is already re-observed by the `finish` leg
 * inside `m2` on every television. Re-implementing it here would be a second
 * instrument measuring a shipped guarantee, and a spike that disagreed with
 * `m2` would tell us nothing about televisions and everything about the spike.
 * **Run `--scenario m2` on each set for that one.**
 *
 * ## What "without relaunching" actually means on the wire
 *
 * Three things have to be true together, and only one of them is the gap:
 *
 *   1. **`transportId` does not change.** A relaunch mints a new one. This is
 *      the strongest single signal and it cannot be faked by timing.
 *   2. **No `LAUNCH` is sent, and no `RECEIVER_STATUS` shows the app going
 *      away and coming back.** `applicationCount` dropping to 0 between the
 *      films is the home screen, which is exactly what 24m promises not to
 *      show.
 *   3. **The gap is inside the 10 s cast budget** — measured from the second
 *      `LOAD` leaving to the second film reporting `PLAYING`.
 *
 * ⚠️ **A receiver answers a LOAD by ending the media session it supersedes** —
 * `IDLE`/`INTERRUPTED` for the outgoing film. That is our own LOAD being
 * acknowledged, **not** the set abandoning the film, and 13g already draws
 * that line for the running product. This spike records it rather than
 * treating it as a fault, because a queue will see it between every pair of
 * films and the first person to read a between-films log will otherwise file
 * it as a bug.
 *
 * ## Both load kinds, and why a pass on one proves nothing about the other
 *
 * 24y makes the second film a **head-start load** whenever its conversion is
 * unfinished — a *growing* HLS playlist rather than a finished MP4. A receiver
 * already playing a film is not a state SPIKE-1 ever handed a playlist to.
 *
 * So this measures **MP4 → MP4** and **MP4 → growing HLS**, and it will not
 * report the assumption as holding unless **both** were observed. A spike that
 * tested the easy half and reported a verdict about the whole is the lying
 * instrument this project keeps finding; the exit-code contract exists for it.
 */

/** How long to let the first film establish itself before loading the second over it. */
const SETTLE_MS = 8_000;

/** The PRD's own budget for a cast reaching a picture — the gap is graded against it. */
const GAP_BUDGET_MS = 10_000;

/** A growing playlist publishes one segment at a time, at roughly this cadence. */
const SEGMENT_PUBLISH_MS = 1_500;

export interface SpikeM5bOptions {
  readonly address: string;
  readonly port: number;
  readonly firstFile: string;
  readonly secondFile: string;
  /** Segment files for the growing-playlist leg, in order. Omit to skip that leg. */
  readonly hlsSegments?: readonly string[];
  /**
   * Per-segment durations, in seconds, in the same order as `hlsSegments`.
   *
   * ⚠️ **Not a formality, and guessing it is how the first run failed.** The playlist
   * declared `EXTINF:4.0` and `TARGETDURATION:4` for segments that were really 10.43 s
   * each. HLS requires `TARGETDURATION` to be at least the longest segment, so the
   * playlist was malformed and the `Chromecast Ultra` answered `LOAD_FAILED` — correctly.
   * The television was right and the instrument was wrong.
   */
  readonly hlsDurations?: readonly number[];
  /**
   * Load the growing playlist as the **first** load on a fresh session, instead of over a
   * running film.
   *
   * ⚠️ **This is the control, and without it the HLS result cannot be read.** On 2026-09-09
   * the `Chromecast Ultra` answered the handover playlist with `LOAD_FAILED` after fetching
   * it three times. Two readings fit that equally well: **these segments are bad**, or **a
   * receiver refuses HLS into a session that is already playing** — and the second would
   * reshape 24y. One run of this flag separates them.
   */
  readonly hlsFirst?: boolean;
  readonly logger: Logger;
  readonly transport: TransportFactory;
}

export interface SpikeM5bReport {
  readonly findings: readonly Finding[];
  readonly verdicts: readonly AssumptionVerdict[];
}

interface Handover {
  readonly kind: 'mp4' | 'hls-growing';
  readonly transportIdChanged: boolean;
  readonly launchesDuringHandover: number;
  readonly wentToHomeScreen: boolean;
  readonly gapMs: number | null;
  readonly outgoingIdleReason: string | null;
}

function localAddressFor(target: string): string {
  const families = Object.values(networkInterfaces()).flat();
  const usable = families.filter(
    (nic): nic is NonNullable<typeof nic> =>
      nic !== undefined && nic.family === 'IPv4' && !nic.internal,
  );
  const sameSubnet = usable.find((nic) => {
    const a = nic.address.split('.').slice(0, 3).join('.');
    return a === target.split('.').slice(0, 3).join('.');
  });
  const chosen = sameSubnet ?? usable[0];
  if (chosen === undefined) {
    throw new SpikeAbort('this PC has no non-internal IPv4 address, so no film could be served');
  }
  return chosen.address;
}

/**
 * Serves both films, and a playlist that grows while the television reads it.
 *
 * **CORS is not optional for the HLS leg.** A progressive MP4 is fetched by the
 * receiver's `<video>` element and needs none; a playlist is parsed in
 * JavaScript and fed through Media Source Extensions, so every segment fetch is
 * an XHR. The 2026-08-19 finding is that its absence fails with no diagnostic
 * at all, which is the worst way for a spike to be wrong.
 */
function serve(
  options: SpikeM5bOptions,
  published: { count: number },
  // Filled in once the socket has a port: the playlist names segments absolutely, so it
  // cannot be written until we know the address the television will be told to use.
  origin: { base: string },
) {
  const files = new Map<string, string>([
    ['first.mp4', options.firstFile],
    ['second.mp4', options.secondFile],
  ]);
  (options.hlsSegments ?? []).forEach((segment, index) => {
    files.set(`seg${String(index)}.ts`, segment);
  });

  const server = http.createServer((request, response) => {
    const url = (request.url ?? '/').split('?')[0] ?? '/';
    const name = path.basename(url);
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Headers', '*');

    if (name === 'second.m3u8') {
      // **The growing playlist**: only the segments published so far, and NO
      // `#EXT-X-ENDLIST` until they all are. That absence is what tells the
      // receiver the film is still arriving, and it is the whole point of the leg.
      const count = Math.min(published.count, (options.hlsSegments ?? []).length);
      const durations = options.hlsDurations ?? [];
      // ⚠️ **The engine's own serializer, not a second one written here.**
      //
      // The hand-rolled version this replaces was refused by the `Chromecast Ultra` twice.
      // It declared `TARGETDURATION:4` for 10.43 s segments — malformed — and it omitted
      // `#EXT-X-PLAYLIST-TYPE:EVENT`, whose absence tells a receiver the list is finished
      // when it is still growing. `buildPlaylist` gets both right and is the code that
      // actually serves head-start films to these televisions today, so a spike that
      // reimplements it is measuring a playlist the product never sends.
      const body = buildPlaylist({
        baseUrl: `${origin.base}/`,
        segments: Array.from({ length: count }, (_, i) => ({
          name: `seg${String(i)}.ts`,
          durationSec: durations[i] ?? 1,
        })),
        ended: count === (options.hlsSegments ?? []).length,
      });
      response.writeHead(200, {
        'Content-Type': 'application/vnd.apple.mpegurl',
        'Content-Length': Buffer.byteLength(body),
      });
      response.end(body);
      options.logger.info('spike.playlist_served', { published: count });
      return;
    }

    const file = files.get(name);
    if (file === undefined) {
      response.writeHead(404).end();
      return;
    }
    const size = statSync(file).size;
    const range = request.headers.range;
    if (typeof range === 'string' && range.startsWith('bytes=')) {
      const [rawStart, rawEnd] = range.slice(6).split('-');
      const start = Number(rawStart ?? 0);
      const end = rawEnd !== undefined && rawEnd !== '' ? Number(rawEnd) : size - 1;
      response.writeHead(206, {
        // ⚠️ **`.ts` is `video/mp2t`, not `video/mp4`.** This served every segment as MP4,
        // and a receiver that cannot parse what it was handed answers `LOAD_FAILED` — which
        // is what the Ultra did, from cold and over a running film alike. The engine has had
        // the right table all along; asking it is the fix, writing a fourth one was the bug.
        'Content-Type': contentTypeFor(file),
        'Content-Length': end - start + 1,
        'Content-Range': `bytes ${String(start)}-${String(end)}/${String(size)}`,
        'Accept-Ranges': 'bytes',
      });
      createReadStream(file, { start, end }).pipe(response);
      return;
    }
    response.writeHead(200, {
      'Content-Type': contentTypeFor(file),
      'Content-Length': size,
      'Accept-Ranges': 'bytes',
    });
    createReadStream(file).pipe(response);
  });
  return server;
}

async function waitForPlaying(
  session: Session,
  transportId: string,
  mark: number,
  timeoutMs: number,
): Promise<number | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await session
      .request(NS_MEDIA, transportId, { type: 'GET_STATUS' }, 5_000)
      .catch(() => null);
    const media = status === null ? null : readMedia(status, 0);
    if (media?.playerState === 'PLAYING') return Date.now() - mark;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Load a film **over a session that is already playing one**, and record what
 * the receiver did about it. This is the whole spike.
 */
async function handOver(
  session: Session,
  transportIdBefore: string,
  media: { readonly contentId: string; readonly contentType: string },
  kind: Handover['kind'],
  logger: Logger,
): Promise<Handover> {
  const beforeMark = session.wire.length;
  const mark = Date.now();

  await session.request(
    NS_MEDIA,
    transportIdBefore,
    {
      type: 'LOAD',
      autoplay: true,
      currentTime: 0,
      media: { contentId: media.contentId, streamType: 'BUFFERED', contentType: media.contentType },
    },
    30_000,
  );

  // ⚠️ **A REFUSED LOAD IS A RUN THAT COULD NOT HAPPEN, NEVER A FINDING.**
  //
  // The first version of this spike lacked this guard and it cost a false verdict on the
  // very first run: the `Chromecast Ultra` answered the growing playlist with `LOAD_FAILED`
  // twice, the leg recorded "never reached PLAYING", and the report declared assumption 1
  // **CONTRADICTED** — a verdict about a handover the television had never once attempted.
  // That is exactly what `m3.ts` warns about in the same words, having been bitten by it in
  // SPIKE-1, and it is worse here: a false CONTRADICTED would reword 24m and slow the queue
  // between every pair of films, on the strength of a bug in the test.
  //
  // **The refusal does not arrive as the reply.** `LOAD_FAILED` carries the LOAD's own
  // requestId but reaches us *after* an unsolicited `MEDIA_STATUS` has already resolved the
  // request, so checking the returned payload catches nothing. The socket's own record is
  // the only honest place to look.
  await new Promise((resolve) => setTimeout(resolve, 4_000));
  const refusal = session.wire
    .slice(beforeMark)
    .find((f) => f.dir === 'in' && (f.type === 'LOAD_FAILED' || f.type === 'LOAD_CANCELLED'));
  if (refusal !== undefined) {
    throw new SpikeAbort(
      `the television refused the ${kind} load (${String(refusal.type)}). Nothing about a ` +
        `${kind} handover was measured — this is a run that could not happen, not a finding. ` +
        'The wire trace in the engine log has the exact frames.',
    );
  }

  const gapMs = await waitForPlaying(session, transportIdBefore, mark, 30_000);

  // What the receiver said about itself across the handover.
  const receiverStatus = await session
    .request(NS_RECEIVER, PLATFORM_RECEIVER, { type: 'GET_STATUS' }, 5_000)
    .catch(() => null);
  const receiver = receiverStatus === null ? null : readReceiver(receiverStatus, 0);

  const framesSince = session.wire.slice(beforeMark);
  const launches = framesSince.filter((f) => f.dir === 'out' && f.type === 'LAUNCH').length;
  // `applicationCount` reaching 0 at any point IS the home screen — the thing
  // 24m promises the founder will not see between two films.
  const wentHome = framesSince.some(
    (f) =>
      f.dir === 'in' && f.type === 'RECEIVER_STATUS' && /"applications"\s*:\s*\[\s*\]/.test(f.data),
  );
  // The outgoing film's own ending: expected to be IDLE/INTERRUPTED, which is
  // our LOAD being acknowledged rather than the set abandoning anything (13g).
  const idle = framesSince.find((f) => f.dir === 'in' && /"idleReason"/.test(f.data));
  const outgoing =
    idle === undefined ? null : (/"idleReason"\s*:\s*"([A-Z_]+)"/.exec(idle.data)?.[1] ?? null);

  logger.info('spike.handover', {
    kind,
    gapMs,
    launches,
    wentHome,
    transportBefore: transportIdBefore,
    transportAfter: receiver?.transportId ?? null,
    outgoingIdleReason: outgoing,
  });

  return {
    kind,
    transportIdChanged: receiver?.transportId != null && receiver.transportId !== transportIdBefore,
    launchesDuringHandover: launches,
    wentToHomeScreen: wentHome,
    gapMs,
    outgoingIdleReason: outgoing,
  };
}

export async function runSpikeM5b(options: SpikeM5bOptions): Promise<SpikeM5bReport> {
  const findings: Finding[] = [];
  const local = localAddressFor(options.address);
  const published = { count: 1 };
  const origin = { base: '' };
  const server = serve(options, published, origin);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new SpikeAbort('the media server did not take a port');
  }
  const base = `http://${local}:${String(address.port)}`;
  origin.base = base;
  options.logger.info('spike.serving', { base });

  const session = await openSession({
    address: options.address,
    port: options.port,
    logger: options.logger,
    label: 'm5b',
    transport: options.transport,
  });

  let publisher: NodeJS.Timeout | null = null;
  try {
    session.send(NS_CONNECTION, PLATFORM_RECEIVER, {
      type: 'CONNECT',
      userAgent: 'CastGood-spike',
    });
    const launched = await session.request(
      NS_RECEIVER,
      PLATFORM_RECEIVER,
      { type: 'LAUNCH', appId: CAST.defaultReceiverAppId },
      30_000,
    );
    const receiver = readReceiver(launched, 0);
    if (receiver.transportId === null) {
      throw new SpikeAbort('the television launched no receiver, so nothing could be loaded');
    }
    const transportId = receiver.transportId;
    session.send(NS_CONNECTION, transportId, { type: 'CONNECT', userAgent: 'CastGood-spike' });

    // --- the first film, the ordinary way -----------------------------------
    //
    // With `hlsFirst` this is the growing playlist instead, loaded from cold. That is the
    // control for the handover result: same playlist, same segments, no running film.
    const firstIsHls = options.hlsFirst === true && (options.hlsSegments ?? []).length > 0;
    if (firstIsHls) {
      published.count = 1;
      publisher = setInterval(() => {
        if (published.count < (options.hlsSegments ?? []).length) published.count += 1;
      }, SEGMENT_PUBLISH_MS);
    }
    const firstMark = Date.now();
    await session.request(
      NS_MEDIA,
      transportId,
      {
        type: 'LOAD',
        autoplay: true,
        currentTime: 0,
        media: firstIsHls
          ? {
              contentId: `${base}/second.m3u8`,
              streamType: 'BUFFERED',
              contentType: 'application/vnd.apple.mpegurl',
            }
          : {
              contentId: `${base}/first.mp4`,
              streamType: 'BUFFERED',
              contentType: 'video/mp4',
            },
      },
      30_000,
    );
    // A refusal HERE is about the playlist, not about any handover — say so, because that
    // is the entire point of running with this flag.
    if (firstIsHls) {
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      const refusedCold = session.wire.find(
        (f) => f.dir === 'in' && (f.type === 'LOAD_FAILED' || f.type === 'LOAD_CANCELLED'),
      );
      if (refusedCold !== undefined) {
        throw new SpikeAbort(
          `the television refused the growing playlist as a FIRST load (${String(refusedCold.type)}), on a fresh session with nothing playing. ` +
            'So the refusal seen during a handover is about these segments or this playlist, NOT about loading over a running film. ' +
            'The handover question stays open, and the segments are what to fix.',
        );
      }
    }
    const firstGap = await waitForPlaying(session, transportId, firstMark, 30_000);
    if (firstGap === null) {
      throw new SpikeAbort(
        'the first film never reached PLAYING, so there was no running session to load a second one over. Nothing about a handover was tested.',
      );
    }
    if (firstIsHls) {
      if (publisher !== null) {
        clearInterval(publisher);
        publisher = null;
      }
      return {
        findings: [
          finding(
            'Does a GROWING PLAYLIST play at all on this television, loaded from cold?',
            `yes — PLAYING after ${String(firstGap)} ms`,
            { note: 'the control run for the handover result' },
          ),
        ],
        verdicts: [
          verdict(
            1,
            'a second LOAD starts the next film without relaunching the receiver',
            'inconclusive',
            'this was the CONTROL run, not a handover: the playlist was loaded from cold and played, which proves the segments and the playlist are sound. Re-run WITHOUT --hls-first; a refusal there is then a real finding about loading HLS over a running film, and it reshapes 24y.',
          ),
        ],
      };
    }

    findings.push(
      finding(
        'How long did the FIRST film take, loaded the ordinary way?',
        `${String(firstGap)} ms`,
        {
          note: 'the baseline a handover is compared against — it includes the receiver already being up',
        },
      ),
    );
    await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));

    // --- MP4 over a running session ----------------------------------------
    const mp4 = await handOver(
      session,
      transportId,
      { contentId: `${base}/second.mp4`, contentType: 'video/mp4' },
      'mp4',
      options.logger,
    );

    // --- a GROWING playlist over a running session --------------------------
    let hls: Handover | null = null;
    if ((options.hlsSegments ?? []).length > 0) {
      await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
      published.count = 1;
      publisher = setInterval(() => {
        if (published.count < (options.hlsSegments ?? []).length) published.count += 1;
      }, SEGMENT_PUBLISH_MS);
      hls = await handOver(
        session,
        transportId,
        { contentId: `${base}/second.m3u8`, contentType: 'application/vnd.apple.mpegurl' },
        'hls-growing',
        options.logger,
      );
      clearInterval(publisher);
      publisher = null;
    }

    for (const h of [mp4, hls].filter((x): x is Handover => x !== null)) {
      findings.push(
        finding(
          `Did a second LOAD (${h.kind}) relaunch the receiver?`,
          h.transportIdChanged || h.launchesDuringHandover > 0 ? 'YES — it relaunched' : 'no',
          {
            transportIdChanged: h.transportIdChanged,
            launches: h.launchesDuringHandover,
          },
        ),
        finding(
          `Did the television show its home screen between films (${h.kind})?`,
          h.wentToHomeScreen ? 'YES — applications went empty' : 'no',
          {},
        ),
        finding(
          `Gap from the second LOAD to PLAYING (${h.kind})`,
          h.gapMs === null ? 'never reached PLAYING' : `${String(h.gapMs)} ms`,
          { budgetMs: GAP_BUDGET_MS },
        ),
        finding(
          `How did the outgoing film end (${h.kind})?`,
          h.outgoingIdleReason ?? 'no idleReason seen',
          {
            note: 'INTERRUPTED is our own LOAD being acknowledged, not the set abandoning the film — 13g already draws this line, and a queue will see it between every pair of films',
          },
        ),
      );
    }

    // --- the verdict, and it refuses to generalise --------------------------
    const measured = [mp4, hls].filter((x): x is Handover => x !== null);
    const clean = measured.filter(
      (h) =>
        !h.transportIdChanged &&
        h.launchesDuringHandover === 0 &&
        !h.wentToHomeScreen &&
        h.gapMs !== null &&
        h.gapMs <= GAP_BUDGET_MS,
    );

    const verdicts: AssumptionVerdict[] = [];
    if (hls === null) {
      // ⚠️ **Half the question is not the question.** 24y makes the second film
      // a growing playlist whenever its conversion is unfinished, so an MP4-only
      // run cannot say the assumption holds however clean it was.
      verdicts.push(
        verdict(
          1,
          'a second LOAD starts the next film without relaunching the receiver',
          'inconclusive',
          'only the MP4 handover was measured. 24y makes the second film a GROWING HLS PLAYLIST whenever its conversion is unfinished, and a receiver already playing a film is not a state SPIKE-1 ever handed a playlist to. Re-run with --hls-segments before building step 2 on this.',
        ),
      );
    } else {
      verdicts.push(
        verdict(
          1,
          'a second LOAD starts the next film without relaunching the receiver',
          clean.length === measured.length ? 'confirmed' : 'contradicted',
          clean.length === measured.length
            ? `both load kinds handed over on the same transport, with no LAUNCH, no home screen, and gaps of ${measured.map((h) => String(h.gapMs)).join(' / ')} ms against a ${String(GAP_BUDGET_MS)} ms budget`
            : `${String(measured.length - clean.length)} of ${String(measured.length)} handovers relaunched, showed a home screen or missed the budget — 24m needs rewording before a queue is built on it`,
        ),
      );
    }

    return { findings, verdicts };
  } finally {
    if (publisher !== null) clearInterval(publisher);
    session.closePolitely();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
