import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { CAST } from '../config.js';
import { tlsTransportFactory, type TransportFactory } from '../cast/index.js';
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
  verdict,
  type AssumptionVerdict,
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
 * SPIKE-3 — **can a Chromecast be given subtitles, and can they be changed while the film
 * keeps playing?** THROWAWAY, like everything else in this directory.
 *
 * M3c's build order puts this at step 0, *before any feature code*, for the same reason
 * SPIKE-1 and SPIKE-2 came first: five assumptions decide the shape of the milestone and
 * **not one of them is knowable from documentation**. This project's fake receiver has now
 * been kinder than a real television five times, so nothing here is asserted — every probe
 * records what the device actually did and the report says so in the device's own numbers.
 *
 * The one that matters most is **assumption 5**. If a text track can be swapped for a
 * differently-timed one mid-film, without the picture breaking and inside a couple of
 * seconds, then story 20's timing control is **nudge buttons** the founder taps from the
 * sofa. If it cannot, it is **set-then-Apply** — a different control, a different feel, and
 * a change the founder is owed *before* it is built rather than after.
 *
 * There is no exit 1 here. A television behaving unexpectedly is the finding.
 */

// --- The two tracks we serve -------------------------------------------------

/**
 * Two WebVTT files that say **which one is on screen**, and are offset from each other.
 *
 * The words are the instrument. A swap that silently keeps serving the old track looks
 * identical to a swap that worked, unless the cues themselves name the file — so cue one of
 * `A` reads "TRACK A" and cue one of `B` reads "TRACK B", and the founder reading the
 * television is the check that no code can do.
 *
 * The offset is 6 seconds, deliberately larger than the ~2 s swap budget: if the founder
 * cannot see the difference, the measurement is not telling us anything about nudging.
 */
export function vttBody(label: string, offsetSec: number): string {
  const stamp = (sec: number): string => {
    const s = Math.max(0, sec);
    const hh = String(Math.floor(s / 3600)).padStart(2, '0');
    const mm = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const ss = String(Math.floor(s % 60)).padStart(2, '0');
    return `${hh}:${mm}:${ss}.000`;
  };
  const lines = ['WEBVTT', ''];
  // One cue every 5 s for half an hour: long enough that a seek lands on a cue rather than
  // in a gap, which would read as "subtitles broke" when it is only silence.
  for (let i = 0; i < 360; i += 1) {
    const at = i * 5 + offsetSec;
    lines.push(
      String(i + 1),
      `${stamp(at)} --> ${stamp(at + 4)}`,
      `${label} — cue ${String(i + 1)} at ${stamp(at)}`,
      '',
    );
  }
  return lines.join('\n');
}

export interface TrackFixture {
  readonly dir: string;
  readonly a: string;
  readonly b: string;
}

export async function writeTrackFixture(): Promise<TrackFixture> {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-spike3-'));
  const a = path.join(dir, 'track-a.vtt');
  const b = path.join(dir, 'track-b.vtt');
  await fsp.writeFile(a, vttBody('TRACK A', 0), 'utf8');
  await fsp.writeFile(b, vttBody('TRACK B', 6), 'utf8');
  return { dir, a, b };
}

// --- A track server we can make deliberately wrong ---------------------------

export interface TrackRequest {
  readonly atMono: number;
  readonly url: string;
  readonly status: number;
  readonly contentType: string;
  readonly origin: string | null;
  readonly corsSent: boolean;
}

export interface TrackServer {
  readonly port: number;
  /** Every fetch the television made, in order. This is the evidence for assumptions 1–3. */
  readonly requests: readonly TrackRequest[];
  urlFor(name: 'a' | 'b', options?: { readonly cors?: boolean; readonly bust?: string }): string;
  /** Rewrite what a name serves, WITHOUT changing its URL. Probe 7's whole mechanism. */
  setBody(name: 'a' | 'b', text: string): void;
  close(): Promise<void>;
}

/**
 * The tracks are served by **us**, not by the app's media server, for one reason: probe 6
 * has to serve a track **without** CORS headers, and the real server always sends them —
 * correctly, and it must go on doing so.
 *
 * The film still goes through the real media server. The variable under test is the track.
 */
export async function startTrackServer(
  fixture: TrackFixture,
  logger: Logger,
  localAddressHint: () => string,
): Promise<TrackServer> {
  const requests: TrackRequest[] = [];
  const bodies = new Map<string, Buffer>([
    ['a', await fsp.readFile(fixture.a)],
    ['b', await fsp.readFile(fixture.b)],
  ]);

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://placeholder');
    const which = url.pathname.includes('track-b') ? 'b' : 'a';
    const body = bodies.get(which);
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : null;
    // `?cors=0` is probe 6: the same file, the same everything, minus the headers.
    const cors = url.searchParams.get('cors') !== '0';
    // `?type=bin` is probe 7: `.vtt` is **not** in the app media server's content-type table
    // today, so a track served by it would go out as `application/octet-stream`. Whether a
    // receiver cares is a fact, not an opinion, and M3c has to know before it serves one.
    const contentType =
      url.searchParams.get('type') === 'bin' ? 'application/octet-stream' : 'text/vtt';

    if (body === undefined) {
      res.writeHead(404).end();
      return;
    }
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Content-Length': String(body.byteLength),
      'Cache-Control': 'no-store',
    };
    if (cors) {
      headers['Access-Control-Allow-Origin'] = origin !== null && origin !== '' ? origin : '*';
      headers['Access-Control-Allow-Methods'] = 'GET, HEAD, OPTIONS';
      headers['Access-Control-Allow-Headers'] = 'Content-Type, Accept-Encoding, Range';
    }
    requests.push({
      atMono: Number(process.hrtime.bigint() / 1_000_000n),
      url: req.url ?? '',
      status: 200,
      contentType,
      origin,
      corsSent: cors,
    });
    logger.info('spike3.track_request', {
      url: req.url ?? '',
      origin,
      corsSent: cors,
      contentType,
    });
    if (req.method === 'HEAD') {
      res.writeHead(200, headers).end();
      return;
    }
    res.writeHead(200, headers).end(body);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, '0.0.0.0', resolve);
  });
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  if (port === 0) throw new SpikeAbort('the track server could not take a port');

  return {
    port,
    requests,
    setBody(name, text): void {
      bodies.set(name, Buffer.from(text, 'utf8'));
    },
    urlFor(name, options): string {
      const params = new URLSearchParams();
      if (options?.cors === false) params.set('cors', '0');
      if (options?.bust !== undefined) params.set('v', options.bust);
      const query = params.toString();
      return `http://${localAddressHint()}:${String(port)}/track-${name}.vtt${
        query === '' ? '' : `?${query}`
      }`;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

// --- The probes --------------------------------------------------------------

export interface SpikeM3cOptions {
  readonly address: string;
  readonly port: number;
  /** A film this television plays natively — the track is what is under test, not the film. */
  readonly filePath: string;
  /** How long to let the film run before the first toggle. */
  readonly settleMs: number;
  readonly logger: Logger;
  readonly transport?: TransportFactory;
}

interface Cast {
  readonly session: Session;
  readonly transportId: string;
  readonly mediaSessionId: number;
}

const TRACK_ID_A = 1;
const TRACK_ID_B = 2;
/**
 * Two more tracks, declared up front and never re-declared — **because re-declaring does
 * not work.**
 *
 * The AI PONT, 2026-08-26: `EDIT_TRACKS_INFO` carrying a new `tracks` array was
 * answered in 91 ms and the receiver then **fetched nothing**. It accepts the message and
 * ignores the URLs. That silently invalidated the first version of the octet-stream and
 * no-CORS probes, which both rode that path and therefore tested nothing — 0 fetches
 * reached the server, and a reader could easily have filed "0 fetches" as a CORS finding.
 *
 * So the deliberately-wrong tracks are declared in the LOAD, like the good ones, and
 * selected with `activeTrackIds` — the one mechanism this receiver honours.
 */
const TRACK_ID_BIN = 3;
const TRACK_ID_NOCORS = 4;

/** A sidecar WebVTT track, in the shape the LOAD message declares them. */
function trackDeclaration(id: number, url: string, name: string, language: string): Json {
  return {
    trackId: id,
    type: 'TEXT',
    trackContentId: url,
    trackContentType: 'text/vtt',
    subtype: 'SUBTITLES',
    name,
    language,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mono(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

async function statusOf(cast: Cast): Promise<MediaSnapshot | null> {
  const response = await cast.session.request(NS_MEDIA, cast.transportId, {
    type: 'GET_STATUS',
    mediaSessionId: cast.mediaSessionId,
  });
  return readMedia(response, mono());
}

/**
 * Watch the film for `forMs`, sampling position and state.
 *
 * **This is how "without interrupting playback" is measured** rather than asserted: a swap
 * that stalls the picture shows up as a position that stops advancing or a `BUFFERING` in
 * the histogram, and both are in the report whatever the answer turns out to be.
 */
async function watch(
  cast: Cast,
  forMs: number,
  everyMs = 500,
): Promise<{ samples: MediaSnapshot[]; states: Record<string, number> }> {
  const samples: MediaSnapshot[] = [];
  const states: Record<string, number> = {};
  const until = mono() + forMs;
  while (mono() < until) {
    const snapshot = await statusOf(cast);
    if (snapshot !== null) {
      samples.push(snapshot);
      const state = snapshot.playerState ?? 'UNKNOWN';
      states[state] = (states[state] ?? 0) + 1;
    }
    await sleep(everyMs);
  }
  return { samples, states };
}

function advanced(samples: readonly MediaSnapshot[]): number {
  const first = samples.at(0)?.currentTime ?? null;
  const last = samples.at(-1)?.currentTime ?? null;
  if (first === null || last === null) return 0;
  return last - first;
}

/**
 * Ask the receiver to change which declared tracks are active, and **time the answer**.
 *
 * `EDIT_TRACKS_INFO` is the only documented way to turn a declared track on or off without
 * touching the media session. Whether it will also accept a **new `tracks` array** — a
 * different URL, mid-film — is assumption 5, and the answer decides story 20's control.
 */
async function editTracks(
  cast: Cast,
  payload: Json,
  timeoutMs: number,
): Promise<{ ok: boolean; elapsedMs: number; response: Json | string }> {
  const began = mono();
  try {
    const response = await cast.session.request(
      NS_MEDIA,
      cast.transportId,
      { type: 'EDIT_TRACKS_INFO', mediaSessionId: cast.mediaSessionId, ...(payload as object) },
      timeoutMs,
    );
    return { ok: true, elapsedMs: mono() - began, response };
  } catch (error) {
    return { ok: false, elapsedMs: mono() - began, response: String(error) };
  }
}

export interface SpikeM3cReport {
  readonly findings: readonly Finding[];
  readonly assumptions: readonly AssumptionVerdict[];
  readonly trackRequests: readonly TrackRequest[];
  readonly wire: readonly Wire[];
}

export async function probeSubtitles(options: SpikeM3cOptions): Promise<SpikeM3cReport> {
  const { logger } = options;
  const findings: Finding[] = [];
  const assumptions: AssumptionVerdict[] = [];
  const fixture = await writeTrackFixture();
  const media: MediaServer = createMediaServer({ logger });
  await media.start();

  let session: Session | null = null;
  let tracks: TrackServer | null = null;
  try {
    session = await openSession({
      address: options.address,
      port: options.port,
      logger,
      label: 'spike3',
      transport: options.transport ?? tlsTransportFactory,
    });
    const local = session.localAddress;
    tracks = await startTrackServer(fixture, logger, () => local);

    // --- LAUNCH and LOAD, with one track declared and NOTHING active -------------------
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
    session.send(NS_CONNECTION, receiver.transportId, {
      type: 'CONNECT',
      userAgent: 'CastGood-spike3',
    });

    const mount = media.mount({ path: options.filePath, kind: 'file' });
    const contentUrl = media.urlFor(mount, local);
    const urlA = tracks.urlFor('a');
    const urlB = tracks.urlFor('b');
    const urlBin = `${tracks.urlFor('b')}?type=bin`;
    const urlNoCors = tracks.urlFor('a', { cors: false });

    const loadResponse = await session.request(
      NS_MEDIA,
      receiver.transportId,
      {
        type: 'LOAD',
        ...(receiver.sessionId === null ? {} : { sessionId: receiver.sessionId }),
        media: {
          contentId: contentUrl,
          contentType: contentTypeFor(options.filePath),
          streamType: 'BUFFERED',
          metadata: { metadataType: 0, title: path.basename(options.filePath) },
          tracks: [
            trackDeclaration(TRACK_ID_A, urlA, 'Track A', 'en'),
            trackDeclaration(TRACK_ID_B, urlB, 'Track B', 'en'),
            trackDeclaration(TRACK_ID_BIN, urlBin, 'Track B as octet-stream', 'en'),
            trackDeclaration(TRACK_ID_NOCORS, urlNoCors, 'Track A with no CORS', 'en'),
          ],
          textTrackStyle: { backgroundColor: '#00000000', foregroundColor: '#FFFFFFFF' },
        },
        autoplay: true,
        currentTime: 0,
        // **19a's whole ruling, on the wire**: declared, and not one of them switched on.
        activeTrackIds: [],
      },
      CAST.launchTimeoutMs,
    );
    const first = readMedia(loadResponse, mono());
    if (first === null || first.mediaSessionId === null) {
      throw new SpikeAbort('the device refused the LOAD (no media session came back)');
    }
    const cast: Cast = {
      session,
      transportId: receiver.transportId,
      mediaSessionId: first.mediaSessionId,
    };

    // **The film has to actually be playing, or nothing below means anything.**
    //
    // Chromecast, 2026-08-26: the receiver answered the LOAD, took a media session,
    // fetched all four tracks — and then refused the film with `detailedErrorCode: 104`
    // (MEDIA_SRC_NOT_SUPPORTED), after which every GET_STATUS came back
    // `INVALID_MEDIA_SESSION_ID`. The watch loop read **zero** samples, `advanced()` returned
    // 0 from an empty list, and the report said *"CONTRADICTED: a declared track can be
    // turned on and off mid-film without interrupting playback — 0.0 s of film in 6 s"*.
    //
    // That verdict was about a television that was not playing anything. A spike that
    // reports a device fact from an absent measurement is worse than one that does not run,
    // so this refuses instead: **exit 2, nothing observed**, which is the rule the selftest
    // has followed since M1.
    const settle = await watch(cast, options.settleMs);
    if (settle.samples.length === 0) {
      const errors = session.wire
        .filter((frame) => frame.dir === 'in' && (frame.type ?? '').includes('ERROR'))
        .map((frame) => frame.data)
        .slice(0, 3);
      throw new SpikeAbort(
        `the television never reported a playing film — ${String(settle.samples.length)} status samples in ${String(options.settleMs)} ms. ` +
          `It answered the LOAD and then refused the media. Frames: ${errors.join(' ')} ` +
          `Pass a film THIS television plays natively: a prepared copy made for another set may keep sound this one cannot decode (D1).`,
      );
    }
    if ((settle.states['PLAYING'] ?? 0) === 0) {
      throw new SpikeAbort(
        `the television reported ${JSON.stringify(settle.states)} and never PLAYING — the film is not running, so nothing below would be a fact about subtitles.`,
      );
    }
    const fetchedWhileOff = tracks.requests.length;
    findings.push(
      finding(
        'Does a track declared but not activated get fetched at all?',
        fetchedWhileOff === 0
          ? 'No — the television fetched nothing. Declaring is free, which is what 19a needs.'
          : `Yes — ${String(fetchedWhileOff)} fetch(es) with activeTrackIds: []. 19a's "nothing is served until a choice is made" would be false as written.`,
        { fetches: fetchedWhileOff, urls: tracks.requests.map((r) => r.url) },
      ),
    );

    // --- Probe 2: turn it ON mid-film -------------------------------------------------
    const beforeOn = advanced(settle.samples);
    const on = await editTracks(cast, { activeTrackIds: [TRACK_ID_A] }, CAST.launchTimeoutMs);
    const afterOn = await watch(cast, 6_000);
    const fetchedAfterOn = tracks.requests.length - fetchedWhileOff;
    findings.push(
      finding(
        'Can a declared track be switched on mid-film, and does the picture survive it?',
        on.ok
          ? `EDIT_TRACKS_INFO answered in ${String(Math.round(on.elapsedMs))} ms; ${String(fetchedAfterOn)} track fetch(es) followed; position advanced ${afterOn.samples.length === 0 ? 'unknown' : `${advanced(afterOn.samples).toFixed(1)} s`} over 6 s; states ${JSON.stringify(afterOn.states)}.`
          : `EDIT_TRACKS_INFO failed: ${String(on.response)}`,
        { elapsedMs: on.elapsedMs, fetches: fetchedAfterOn, states: afterOn.states, beforeOn },
      ),
    );
    assumptions.push(
      verdict(
        4,
        'A declared track can be turned on and off mid-film without interrupting playback',
        on.ok && (afterOn.states['BUFFERING'] ?? 0) === 0 && advanced(afterOn.samples) > 3
          ? 'confirmed'
          : 'contradicted',
        on.ok
          ? `switched on in ${String(Math.round(on.elapsedMs))} ms, ${String(afterOn.states['BUFFERING'] ?? 0)} BUFFERING samples, ${advanced(afterOn.samples).toFixed(1)} s of film in 6 s of wall clock`
          : `the receiver refused EDIT_TRACKS_INFO: ${String(on.response)}`,
      ),
    );

    // --- Probe 3: swap it for a differently-timed track, and TIME IT -------------------
    // **The highest-value question in this spike.** Two shapes are tried, cheapest first.
    const swapBySwitch = await editTracks(
      cast,
      { activeTrackIds: [TRACK_ID_B] },
      CAST.launchTimeoutMs,
    );
    const afterSwitch = await watch(cast, 6_000);
    const fetchedB = tracks.requests.filter((r) => r.url.includes('track-b')).length;

    // …and the harder one: a brand-new track list, a URL the receiver has never seen.
    const bustUrl = tracks.urlFor('a', { bust: String(Date.now()) });
    const swapByRedeclare = await editTracks(
      cast,
      {
        activeTrackIds: [TRACK_ID_A],
        tracks: [trackDeclaration(TRACK_ID_A, bustUrl, 'Track A shifted', 'en')],
      },
      CAST.launchTimeoutMs,
    );
    const afterRedeclare = await watch(cast, 6_000);
    const fetchedBust = tracks.requests.filter((r) => r.url.includes('v=')).length;

    findings.push(
      finding(
        'Can the words on screen be changed mid-film — and how fast? (assumption 5, the one that decides story 20)',
        [
          `switching between two PRE-DECLARED tracks: ${swapBySwitch.ok ? `${String(Math.round(swapBySwitch.elapsedMs))} ms, ${String(fetchedB)} fetch(es) of track B, ${String(afterSwitch.states['BUFFERING'] ?? 0)} BUFFERING` : `refused — ${String(swapBySwitch.response)}`}`,
          `RE-DECLARING a track at a new URL: ${swapByRedeclare.ok ? `${String(Math.round(swapByRedeclare.elapsedMs))} ms, ${String(fetchedBust)} fetch(es) of the new URL, ${String(afterRedeclare.states['BUFFERING'] ?? 0)} BUFFERING` : `refused — ${String(swapByRedeclare.response)}`}`,
        ].join('  |  '),
        {
          switchMs: swapBySwitch.elapsedMs,
          switchOk: swapBySwitch.ok,
          fetchedB,
          redeclareMs: swapByRedeclare.elapsedMs,
          redeclareOk: swapByRedeclare.ok,
          fetchedBust,
          states: { afterSwitch: afterSwitch.states, afterRedeclare: afterRedeclare.states },
        },
      ),
    );
    // A nudge is only a nudge if the new words are on screen while the thumb is still moving.
    const nudgeable =
      swapByRedeclare.ok && fetchedBust > 0 && swapByRedeclare.elapsedMs <= 2_000
        ? 'confirmed'
        : swapBySwitch.ok && fetchedB > 0 && swapBySwitch.elapsedMs <= 2_000
          ? 'inconclusive'
          : 'contradicted';
    assumptions.push(
      verdict(
        5,
        'A text track can be REPLACED mid-playback at a new URL, fast enough to nudge against',
        nudgeable,
        nudgeable === 'confirmed'
          ? `re-declared at a new URL in ${String(Math.round(swapByRedeclare.elapsedMs))} ms and the television fetched it — story 20 can be NUDGE BUTTONS`
          : nudgeable === 'inconclusive'
            ? 'only pre-declared tracks could be switched; a new URL was not taken. Story 20 is SET-THEN-APPLY, or a fixed ladder of pre-declared offsets'
            : 'the track could not be changed mid-film at all. Story 20 is SET-THEN-APPLY with a reload at position, and the founder must see that before it is built',
      ),
    );

    // --- Probe 4: seek with subtitles on ----------------------------------------------
    const seekTarget = (afterRedeclare.samples.at(-1)?.currentTime ?? 60) + 120;
    const seekBegan = mono();
    await cast.session.request(NS_MEDIA, cast.transportId, {
      type: 'SEEK',
      mediaSessionId: cast.mediaSessionId,
      currentTime: seekTarget,
    });
    // **Measured before the watch, not after.** The first version subtracted `seekBegan`
    // from a mark taken *after* an 8-second watch and reported 8311 ms as the seek's own
    // latency — an instrument reading its own sampling window and calling it the device.
    const seekAnsweredMs = mono() - seekBegan;
    const beforeSeekFetches = tracks.requests.length;
    const afterSeek = await watch(cast, 8_000);
    findings.push(
      finding(
        'Does a seek with subtitles on keep them on, and keep playing?',
        `sought to ${seekTarget.toFixed(0)} s; the receiver answered in ${String(Math.round(seekAnsweredMs))} ms; states ${JSON.stringify(afterSeek.states)}; ${String(tracks.requests.length - beforeSeekFetches)} track fetch(es) caused by the jump — a re-fetch here means the receiver re-reads the file on a seek.`,
        {
          seekTarget,
          seekAnsweredMs,
          states: afterSeek.states,
          fetchesCausedBySeek: tracks.requests.length - beforeSeekFetches,
        },
      ),
    );

    // --- Probe 7: the same URL, different words — THE ONE STORY 20 TURNS ON ------------
    //
    // Re-declaring a URL does nothing on this receiver, so the obvious way to nudge is out.
    // The way back in: if **activating** a track re-fetches it, then a stable URL whose
    // CONTENT we rewrite gives arbitrary offsets at switch speed — write the shifted cues,
    // switch away, switch back. Two slots, ping-ponged.
    //
    // The AI PONT hinted at this: track B was fetched once at LOAD and again when it
    // was activated. This probe asks it directly, and the words are the evidence — the
    // rewritten Track A is shifted a very visible 12 seconds.
    tracks.setBody('a', vttBody('TRACK A SHIFTED', 12));
    const beforeRewrite = tracks.requests.filter((r) => r.url.includes('track-a')).length;
    await editTracks(cast, { activeTrackIds: [TRACK_ID_B] }, CAST.launchTimeoutMs);
    await sleep(1_500);
    const backBegan = mono();
    const back = await editTracks(cast, { activeTrackIds: [TRACK_ID_A] }, CAST.launchTimeoutMs);
    const backMs = mono() - backBegan;
    const afterBack = await watch(cast, 6_000);
    const refetchedA =
      tracks.requests.filter((r) => r.url.includes('track-a')).length - beforeRewrite;
    findings.push(
      finding(
        'Does ACTIVATING a track re-fetch it? (if yes, a stable URL with rewritten content gives live nudging)',
        `Track A's bytes were rewritten 12 s late without changing its URL, then it was switched away from and back. ${String(refetchedA)} re-fetch(es) of track-a followed; the switch took ${String(Math.round(backMs))} ms; ${String(afterBack.states['BUFFERING'] ?? 0)} BUFFERING. **On the television the words should now read "TRACK A SHIFTED" and run 12 s late — if they still say plain "TRACK A", the receiver cached the file and this route is closed too.**`,
        { refetchedA, backMs, ok: back.ok, states: afterBack.states },
      ),
    );
    assumptions.push(
      verdict(
        5,
        'Story 20 can be live nudge buttons, via two slots at stable URLs whose content is rewritten',
        refetchedA > 0 && backMs <= 2_000 ? 'confirmed' : 'contradicted',
        refetchedA > 0 && backMs <= 2_000
          ? `re-fetched ${String(refetchedA)} time(s) in ${String(Math.round(backMs))} ms — fast enough to nudge against, IF the founder confirms the words actually moved`
          : `${String(refetchedA)} re-fetch(es) in ${String(Math.round(backMs))} ms — the receiver is serving a cached copy, so an offset cannot be changed without a reload. Story 20 is SET-THEN-APPLY.`,
      ),
    );

    // --- Probe 5: the wrong content type ----------------------------------------------
    // Selected, not re-declared: see TRACK_ID_BIN. It was fetched at LOAD like every other
    // declared track, so what is under test here is whether the receiver will RENDER words
    // it was handed as `application/octet-stream`.
    const beforeBin = tracks.requests.length;
    const binSwap = await editTracks(
      cast,
      { activeTrackIds: [TRACK_ID_BIN] },
      CAST.launchTimeoutMs,
    );
    const afterBin = await watch(cast, 6_000);
    findings.push(
      finding(
        'What happens when a track is served as application/octet-stream? (the app media server does NOT know .vtt today)',
        `${binSwap.ok ? `accepted in ${String(Math.round(binSwap.elapsedMs))} ms` : `refused — ${String(binSwap.response)}`}; ${String(tracks.requests.length - beforeBin)} further fetch(es); states ${JSON.stringify(afterBin.states)}. **Whether the WORDS appear is the founder's call, on the television** — this track carries the same text as Track B, six seconds late.`,
        {
          ok: binSwap.ok,
          elapsedMs: binSwap.elapsedMs,
          fetches: tracks.requests.length - beforeBin,
          states: afterBin.states,
        },
      ),
    );

    // --- Probe 6: no CORS headers -----------------------------------------------------
    // Also selected rather than re-declared. The fetch for this one already happened at
    // LOAD — the question is whether the receiver's own JavaScript is allowed to USE it.
    const beforeNoCors = tracks.requests.length;
    const noCors = await editTracks(
      cast,
      { activeTrackIds: [TRACK_ID_NOCORS] },
      CAST.launchTimeoutMs,
    );
    const afterNoCors = await watch(cast, 6_000);
    const noCorsFetches = tracks.requests.filter((r) => r.corsSent === false).length;
    findings.push(
      finding(
        'What does a missing CORS header on a text track look like? (assumption 2)',
        `${noCors.ok ? `the receiver accepted the switch in ${String(Math.round(noCors.elapsedMs))} ms` : `the receiver refused it — ${String(noCors.response)}`}; ${String(noCorsFetches)} fetch(es) of the header-less track reached our server in total; ${String(tracks.requests.length - beforeNoCors)} of them after the switch; states ${JSON.stringify(afterNoCors.states)}. **If the bytes arrived and the words never appear, that is the diagnostic-free failure the 2026-08-19 CORS finding warned about.** These are the same words as Track A, on time.`,
        { fetches: noCorsFetches, ok: noCors.ok, states: afterNoCors.states },
      ),
    );
    assumptions.push(
      verdict(
        2,
        'A text track fetch needs the same CORS headers HLS needed',
        'inconclusive',
        `${String(noCorsFetches)} fetch(es) of the header-less track arrived. Only the television can say whether the words rendered — read the screen and record it against Track A, which is on time and identical.`,
      ),
    );

    assumptions.push(
      verdict(
        1,
        'The Default Media Receiver takes subtitles as sidecar WebVTT declared in the LOAD',
        tracks.requests.length > 0 ? 'confirmed' : 'contradicted',
        tracks.requests.length > 0
          ? `the television fetched the .vtt ${String(tracks.requests.length)} time(s) from a URL we declared on the LOAD — the sidecar shape is the one it uses`
          : 'the television never fetched a declared .vtt at all',
      ),
    );

    await cast.session.request(NS_MEDIA, cast.transportId, {
      type: 'STOP',
      mediaSessionId: cast.mediaSessionId,
    });

    return {
      findings,
      assumptions,
      trackRequests: tracks.requests,
      wire: session.wire,
    };
  } finally {
    if (tracks !== null) await tracks.close();
    if (session !== null && !session.closed) session.closePolitely();
    await media.stop();
    await fsp.rm(fixture.dir, { recursive: true, force: true });
  }
}

// --- Entry point -------------------------------------------------------------

export interface SpikeM3cFullReport extends SpikeM3cReport {
  readonly schemaVersion: 1;
  readonly spike: 'SPIKE-3';
  readonly startedAt: string;
  readonly durationMs: number;
  readonly device: { readonly address: string; readonly port: number };
  readonly filePath: string;
  readonly platform: string;
  readonly logDir: string;
}

export async function runSpikeM3c(
  options: Omit<SpikeM3cOptions, 'logger'>,
): Promise<SpikeM3cFullReport> {
  const paths = resolveAppPaths();
  const memory = createMemorySink();
  const logger = createLogger({
    sink: combineSinks(createFileSink(paths.logDir, systemClock), memory),
    clock: systemClock,
    level: 'debug',
    bindings: { component: 'spike-m3c' },
  });
  const startedAt = new Date().toISOString();
  const began = Date.now();
  const report = await probeSubtitles({ ...options, logger });
  return {
    schemaVersion: 1,
    spike: 'SPIKE-3',
    startedAt,
    durationMs: Date.now() - began,
    device: { address: options.address, port: options.port },
    filePath: options.filePath,
    platform: process.platform,
    logDir: paths.logDir,
    ...report,
  };
}

export function summariseM3c(report: SpikeM3cFullReport): string {
  const lines = [
    '',
    '================ SPIKE-3 findings ================',
    `device ${report.device.address}:${String(report.device.port)}`,
    `${String(Math.round(report.durationMs / 1000))} s   log: ${report.logDir}`,
    '',
  ];
  for (const item of report.findings) {
    lines.push(`  Q ${item.question}`, `  A ${item.answer}`, '');
  }
  for (const item of report.assumptions) {
    lines.push(`  >> ${item.verdict.toUpperCase()}: ${item.claim}`, `     ${item.because}`, '');
  }
  lines.push(
    '  READ THE TELEVISION. This spike can see fetches and states; only a person can see',
    '  whether the WORDS appeared, which track they came from, and whether they were in sync.',
    '',
    'A spike has findings, not a pass. Exit 0 only means it ran.',
    '',
  );
  return lines.join('\n');
}
