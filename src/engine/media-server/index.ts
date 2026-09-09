import http from 'node:http';
import type net from 'node:net';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import type { Clock, Logger } from '../logging/index.js';
import { systemClock } from '../logging/index.js';
import { EngineError } from '../errors.js';
import { MEDIA_SERVER } from '../config.js';
import {
  contentRangeHeader,
  parseRangeHeader,
  unsatisfiableContentRangeHeader,
  type ByteRange,
} from './range.js';
import {
  buildPlaylist,
  existingSegments,
  parseHlsIndex,
  HLS_PUBLISHED_PLAYLIST,
  HLS_SOURCE_PLAYLIST,
  type HlsSegment,
} from './hls.js';
import { shiftCues, toWebVtt, clampOffsetMs, type Cue } from '../subtitles/cues.js';

/**
 * The media server — `node:http` on 0.0.0.0, serving files to the TV.
 *
 * The TV pulls the bytes; we never push them. Everything the Default Media Receiver
 * needs from us is here, and every one of these is a requirement, not a nicety:
 *  - byte ranges: single, open-ended (`bytes=1234-`), suffix; 206 with `Content-Range`;
 *    416 when unsatisfiable; `Accept-Ranges: bytes`.
 *  - `HEAD` must work.
 *  - correct `Content-Type` and accurate `Content-Length`.
 *  - CORS on everything, echoing back the request `Origin`.
 *  - absolute URLs only, no redirects (a documented Default Media Receiver bug).
 *  - plain HTTP. Self-signed HTTPS is worse: devices reject untrusted certificates.
 *
 * Bytes are streamed straight off disk with a positioned read; the file is never read
 * into memory. A 347 MB file whose `moov` index is at the end — the founder's own
 * reference file — is answered from the tail in one seek, which is what keeps the
 * five-second cast target reachable.
 *
 * The URL token is not decoration: without it, anything on the LAN could ask this
 * server for a path. With it, a URL is only useful to whoever we handed it to.
 */

/**
 * What shape of thing is behind a token.
 *
 * `file` is everything M1–M3a served: one file, byte ranges, the receiver's `<video>`
 * element fetching it directly. `hls` is **the second, stricter path** M3b adds — a
 * directory of segments plus a playlist we re-emit on every request — and the 2026-08-19
 * serving-shape ADR is a list of the ways it differs. `directory` is the plain form of the
 * same directory, used by nothing today and kept because the mount API has always had it.
 */
export type MountKind = 'file' | 'directory' | 'hls' | 'subtitles';

export interface MediaMount {
  /** Unguessable per-session token; also how we recognise our own content on reattach. */
  readonly token: string;
  /**
   * File (mp4) or directory (hls artifact).
   *
   * **`''` for a `subtitles` mount**, which has nothing behind it on disk — see
   * `SubtitleMountDescriptor`. Not an omission: a derived mount is the one kind whose
   * content exists only in memory, and giving it a path would invite something to stat it.
   */
  readonly path: string;
  readonly kind: MountKind;
  /** Last URL segment. Cosmetic for the receiver, but it is what sets the content type. */
  readonly name: string;
}

/** Everything M1–M3b served: bytes off a disk, addressed by path. */
export interface PathMountDescriptor {
  readonly kind: 'file' | 'directory' | 'hls';
  readonly path: string;
  readonly token?: string;
}

/**
 * **A subtitle track, and every timing-shifted version of it, from one mount.**
 *
 * The third kind of response this server has (`docs/ARCHITECTURE.md`), and the only one
 * that is computed rather than read: the cues are held here, and each rung of story 20's
 * ladder is the URL `/m/<token>/sub/<offsetMs>.vtt`, answered by shifting this list by the
 * offset **named in its own URL**.
 *
 * That URL shape is the whole design. Distinct content always has a distinct URL, so there
 * is no cache to invalidate — which matters, because SPIKE-3 measured a television serving a
 * *rewritten* file from its own cache and never showing the new words. And there is nothing
 * to clean up: no thirteen files, no thirteen mounts, no `.vtt` anywhere on the founder's
 * machine at all (20g).
 */
export interface SubtitleMountDescriptor {
  readonly kind: 'subtitles';
  /** Parsed once, when the founder chose the source. Never empty — 18j refuses that. */
  readonly cues: readonly Cue[];
  /** What the URL ends in for the unshifted rung. Cosmetic; the offset is what matters. */
  readonly name: string;
  readonly token?: string;
}

export type MountDescriptor = PathMountDescriptor | SubtitleMountDescriptor;

export interface MediaServerAddress {
  readonly port: number;
}

export interface MediaServer {
  /**
   * `preferredPort` overrides the configured default for this start only.
   *
   * It exists for one thing: story 12. A reopened app has to republish the URL the
   * television is still fetching, and that URL names a port — so the port the *previous*
   * run bound is remembered and asked for again. Anything else scans upward from
   * `MEDIA_SERVER.defaultPort` as before.
   */
  start(preferredPort?: number): Promise<MediaServerAddress>;
  stop(): Promise<void>;
  /**
   * Publishes content and returns the token to embed in the URL.
   *
   * The token is random unless one is supplied. Supplying one exists for a single
   * situation: re-publishing a URL a device is *already* fetching, after the process that
   * first published it went away — reattaching to a session that outlived the app (PRD
   * story 12). Nothing else may pass one; a predictable token is a URL anything on the LAN
   * can guess.
   */
  mount(mount: MountDescriptor): MediaMount;
  unmount(token: string): void;
  /**
   * Builds the absolute URL for a mount. `localAddress` must be the address read from
   * the live Cast socket — never a guess from the interface list.
   */
  urlFor(mount: MediaMount, localAddress: string): string;
  /**
   * The URL for **one rung of the ladder** — the same track, shifted by `offsetMs`.
   *
   * A separate call rather than a parameter on `urlFor` because the two answer different
   * questions: `urlFor` names the one thing a mount holds, and a subtitle mount holds an
   * unbounded family of them. Every rung declared in a LOAD is one of these.
   */
  subtitleUrlFor(mount: MediaMount, localAddress: string, offsetMs: number): string;
  /** True once the device has actually fetched something: the firewall diagnostic hangs off this. */
  hasServedRequest(token: string): boolean;
  /**
   * **Is the television still getting the film's bytes?** (defect D2)
   *
   * A progressive MP4 is one open-ended range request that stays open for the whole film:
   * the receiver asks once and then reads slowly, so *"no new request"* is the healthy
   * case and there is nothing in a request count that can tell a working evening from a
   * dead one. What separates them is whether that one delivery **ended with bytes still
   * owed** — which is exactly what a cable pull does to it (`ECONNRESET`, 2026-08-27) —
   * and whether anything has replaced it since.
   *
   * Read by the session supervisor after a recovery, and by nothing else. `null` when the
   * token names no mount.
   */
  deliveryFor(token: string): MediaDelivery | null;
  /**
   * **Every byte delivery in flight right now, across every mount, and how old the oldest
   * of them is.**
   *
   * Written for the selftest, and for one question it had no way to ask: *is the television
   * actually fetching the film at this moment?* `--scenario recover --outage network` cut
   * the route on a timer and exited 2 on three of four hardware attempts because the
   * `AI PONT` had not opened its real delivery yet — it reached `playing` at `05:25:13.883`
   * and did not open `bytes=3506176-` until `05:25:31.289`, **~18 s later**, while the
   * scenario cut at ~5.8 s.
   *
   * **The age is the half that matters.** The setup requests a television makes first — a
   * header read, a 15 KB tail read of the `moov` index — are deliveries too, and they are
   * over in milliseconds. One that has been open for a second is the film.
   */
  deliveriesInFlight(): { readonly count: number; readonly oldestForMs: number };
  /**
   * **Harness only: make this PC unreachable to the television, without touching the
   * interface table.**
   *
   * Every live connection is destroyed and every new one is refused while this is on, so
   * the receiver sees precisely what a pulled cable gives it — a reset mid-stream and then
   * a route that is simply not there. It exists because defect D2 cannot occur unless the
   * *device's* byte connection breaks, and no automated outage this project had could
   * break one: `--outage socket` and `--outage heartbeat` kill our own socket while this
   * server stays reachable throughout.
   *
   * The app never calls this. It is reached only by `selftest --outage network`, in the
   * same family as `unsafeConversionReadRate`, and it is a harness verb rather than a
   * product one.
   *
   * Returns how many connections were destroyed. **That number is the honesty gate**: none
   * means the television was not fetching anything from this PC, so nothing was taken away
   * and the run could not have produced the defect it exists to test.
   */
  unsafeBlackout(on: boolean): number;
  /**
   * **Harness only: declare text tracks at a URL this PC does not answer on** — 18l.
   *
   * *"The television accepted the film but never fetched the subtitle track"* is a real
   * failure a real set produces — a track URL it cannot reach — and nothing automated could
   * produce it against a real television, because a real television always tries. So while
   * this is on, `subtitleUrlFor` names a **closed port** on this PC: the film's own URL is
   * untouched and keeps flowing, and the track is genuinely, observably never fetched.
   *
   * **It fakes nothing about the measurement.** The condition is produced, not simulated:
   * the mount is real, the ladder is real, and `hasServedRequest` answers `false` because
   * no request ever arrived — which is exactly what it would answer on the founder's own
   * hardware behind a rule that blocked it.
   *
   * The app never calls this. It is reached only by `selftest --scenario subtitles
   * --broken`, in the same family as `unsafeBlackout`.
   */
  unsafeWithholdTracks(on: boolean): void;
  readonly port: number | null;
}

/**
 * What has become of the television's byte connection to one mount.
 *
 * Times are monotonic milliseconds from the engine's own clock, so they compare directly
 * with everything the session supervisor holds.
 */
export interface MediaDelivery {
  /** Deliveries in flight right now. One is the healthy state for a progressive film. */
  readonly live: number;
  /** When this mount was last asked for anything at all. */
  readonly lastRequestAtMono: number | null;
  /**
   * When a delivery last ended with bytes still owed — the receiver's connection died, or
   * it walked away mid-response. `null` if that has never happened.
   *
   * **Not by itself a fault.** A seek abandons a response mid-flight every time, and a
   * receiver that comes straight back for a new range is healthy. It is only evidence when
   * nothing replaced it.
   */
  readonly interruptedAtMono: number | null;
  /** How many times that has happened, for the log rather than for a decision. */
  readonly interruptions: number;
}

export interface MediaServerDeps {
  logger: Logger;
  /** The engine's clock, so delivery times compare with the session supervisor's own. */
  clock?: Clock;
  preferredPort?: number;
  /**
   * The device came back for bytes and the file was not there any more (PRD 15b).
   *
   * This is the *only* moment the app can know a source vanished while it mattered: a
   * receiver playing out of its own buffer asks for nothing, so a file deleted mid-film is
   * genuinely invisible until the next range request. The session decides what, if
   * anything, to say about it — this only reports the fact.
   */
  onSourceMissing?(token: string): void;
  /**
   * **A byte delivery just ended with bytes still owed** — and the session is told the
   * moment it happens rather than the next time somebody thinks to look.
   *
   * This is the 229 ms race, 2026-08-28. The post-rejoin check read `deliveryFor` once, saw
   * a delivery still counted as in flight — a black-holed socket is one neither end has
   * been told about yet — and stood down; the interruption was recorded 229 ms later and
   * nothing was watching. Whether a dead socket surfaces before or after the network
   * returns is the OS's business, so the session listens for it instead of sampling.
   *
   * **Not by itself a fault**: a seek ends a delivery every time. It is the session that
   * decides, and only inside a window after a recovery — see `noteDeliveryInterrupted`.
   */
  onDeliveryInterrupted?(token: string): void;
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.mov': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  // `application/vnd.apple.mpegurl`, not `application/x-mpegurl`: it is what SPIKE-1's
  // successful loads actually declared on the wire, on both device classes, and the LOAD
  // metadata and the response header have to agree — the receiver trusts the metadata and
  // a disagreement is another way to reach a diagnostic-free refusal.
  '.m3u8': 'application/vnd.apple.mpegurl',
  '.ts': 'video/mp2t',
  // M3c: the second content type this server has ever carried, and the receiver's own
  // JavaScript fetches it rather than its media pipeline — the same shape as HLS, which is
  // where the 2026-08-19 CORS finding applied the first time.
  //
  // **Without this line a track would go out as `application/octet-stream`.** SPIKE-3
  // measured what that looks like on all three televisions (2026-08-26) and every one of
  // them accepted the switch and kept playing — which is exactly the diagnostic-free
  // failure this project keeps being bitten by. Declared correctly rather than left to be
  // discovered on a Tuesday.
  '.vtt': 'text/vtt',
};

export function contentTypeFor(filePath: string): string {
  return CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
}

function corsHeaders(origin: string | undefined): Record<string, string> {
  return {
    // Google warns that a wildcard is rejected on some paths, so echo the caller's
    // Origin when there is one and only fall back to `*` when there is not.
    'Access-Control-Allow-Origin': origin !== undefined && origin !== '' ? origin : '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Accept-Encoding, Range',
    'Access-Control-Expose-Headers':
      'Content-Length, Content-Range, Accept-Ranges, Date, Server, Transfer-Encoding',
  };
}

/**
 * The path segment every derived subtitle sits under: `/m/<token>/sub/<offsetMs>.vtt`.
 *
 * It is there so a URL in a log or a wire trace says what it is without being decoded.
 * `docs/ARCHITECTURE.md` writes this shape with a track key between the two — dropped here
 * because a mount token already names exactly one track, so the segment would be a constant
 * carrying no information (2026-08-27 ADR).
 */
const SUBTITLE_PREFIX = 'sub';

/**
 * Read the offset out of a rung's URL, or refuse it.
 *
 * **Refuse, rather than clamp.** Clamping would answer two different URLs with identical
 * bytes, which is the one property this shape is built on — distinct content, distinct URL.
 * Nothing outside the range is ever handed out, so anything asking for one is either a
 * mistake of ours or something on the LAN guessing, and both deserve the same 404.
 */
function subtitleOffsetOf(rest: readonly string[]): number | null {
  if (rest.length !== 2 || rest[0] !== SUBTITLE_PREFIX) return null;
  const match = /^(-?\d{1,7})\.vtt$/.exec(rest[1] ?? '');
  if (match === null) return null;
  const offsetMs = Number(match[1]);
  return clampOffsetMs(offsetMs) === offsetMs ? offsetMs : null;
}

/**
 * How many times a television may re-read a playlist without fetching one segment before we
 * say so in the log.
 *
 * Three, because one or two can be innocent: the receiver fetches the list before it decides
 * anything, and a reload cadence of one target duration means the second read can arrive
 * before the first segment request on a slow start. Three is a pattern.
 */
const PLAYLIST_READS_BEFORE_SUSPICION = 3;

interface MountEntry extends MediaMount {
  /** The cue list a `subtitles` mount derives every rung from. `null` for every other kind. */
  cues: readonly Cue[] | null;
  served: boolean;
  /**
   * The absolute URL prefix segments are published under, recorded when `urlFor` built the
   * URL we handed the television.
   *
   * Recorded rather than derived from the request's `Host` header, which is untrusted input
   * from the LAN. `urlFor` is given the address read off the live Cast socket — the OS's own
   * answer to "which interface reaches this device" — so this is correct by construction on
   * a multi-homed machine, which is the classic failure of local casting apps.
   */
  baseUrl: string | null;
  /**
   * How many playlists and how many segments this mount has answered.
   *
   * **The only diagnostic this serving shape has.** A refused HLS load says nothing on the
   * wire — SPIKE-1 met the same bare `LOAD_FAILED` for relative URLs, for missing CORS
   * headers and for an untrue `TARGETDURATION` — so *playlist served ≥ 1, segments
   * requested 0* is how we tell "the television could not use what we sent" from "the
   * television never asked". It is logged; it never teaches the capability table, because
   * a serving fault is a fact about us, not about what the device can decode.
   */
  playlistsServed: number;
  segmentsServed: number;
  /** Byte deliveries in flight. See `MediaDelivery` — this is the film's own lifeline. */
  liveDeliveries: number;
  lastRequestAtMono: number | null;
  interruptedAtMono: number | null;
  interruptions: number;
}

/**
 * The port a withheld track URL names — see `unsafeWithholdTracks`.
 *
 * Port 1 is reserved and nothing serves media on it, so a request to it fails at the
 * connection rather than being answered by something unrelated on this machine.
 */
const DEAD_TRACK_PORT = 1;

export function createMediaServer(deps: MediaServerDeps): MediaServer {
  const logger = deps.logger.child({ component: 'media-server' });
  const clock = deps.clock ?? systemClock;
  const preferredPort = deps.preferredPort ?? MEDIA_SERVER.defaultPort;
  const mounts = new Map<string, MountEntry>();
  /** Harness only: text tracks are declared at a port nothing is listening on. See below. */
  let withholdTracks = false;
  let server: http.Server | null = null;
  let boundPort: number | null = null;
  /**
   * Every accepted connection, so a blackout can destroy them. Sockets remove themselves.
   *
   * Held for the harness verb alone (`unsafeBlackout`); nothing in the product reads it.
   */
  const sockets = new Set<net.Socket>();
  let blackout = false;
  /**
   * Every delivery in flight right now, each holding when it opened.
   *
   * A ticket per response rather than a counter, so *"how long has the oldest one been
   * open?"* is answerable — which is the difference between a television fetching the film
   * and one making the setup requests it makes first. See `deliveriesInFlight`.
   */
  const inFlight = new Set<{ readonly startedAtMono: number }>();

  /** Resolves a request path to a real file inside the mount, or null if it escapes it. */
  function resolveTarget(entry: MountEntry, rest: string[]): string | null {
    if (entry.kind === 'file') return entry.path;
    let relative: string;
    try {
      // `%` on its own throws. This server is reachable by anything on the LAN, so a
      // malformed escape must read as "no such file", not as a 500 that logs as if the
      // server itself had broken.
      relative = rest.map((segment) => decodeURIComponent(segment)).join('/');
    } catch {
      return null;
    }
    const resolved = path.resolve(entry.path, relative);
    const root = path.resolve(entry.path);
    return resolved === root || resolved.startsWith(root + path.sep) ? resolved : null;
  }

  /**
   * The playlist, re-emitted from what is on the disk **right now**.
   *
   * Read on every request rather than cached, because the whole point is that it grows:
   * `Cache-Control: no-store` is on the response for the same reason, and a cached playlist
   * is a film that stops at whatever length it was when the receiver first asked.
   *
   * Two reads, and both are cheap next to what they prevent: ffmpeg's own list (for the
   * measured `#EXTINF` of each segment) and the directory (so a name we publish is a name
   * that exists). Neither is trusted alone.
   */
  async function readPlaylist(
    entry: MountEntry,
    baseUrl: string,
  ): Promise<{ body: string; segments: readonly HlsSegment[]; ended: boolean } | null> {
    let text: string;
    try {
      text = await fsp.readFile(path.join(entry.path, HLS_SOURCE_PLAYLIST), 'utf8');
    } catch {
      // The conversion has not written its first segment yet, or the directory has been
      // tidied away underneath us. Either way there is no playlist, and a 404 with the CORS
      // headers on it is the honest answer.
      return null;
    }
    const index = parseHlsIndex(text);
    let present: ReadonlySet<string>;
    try {
      present = new Set(await fsp.readdir(entry.path));
    } catch {
      return null;
    }
    const segments = existingSegments(index.segments, present);
    return {
      body: buildPlaylist({ segments, baseUrl, ended: index.ended }),
      segments,
      ended: index.ended,
    };
  }

  function send(
    response: http.ServerResponse,
    status: number,
    headers: Record<string, string>,
    body?: string,
  ): void {
    response.writeHead(status, headers);
    response.end(body);
  }

  async function handle(
    request: http.IncomingMessage,
    response: http.ServerResponse,
  ): Promise<void> {
    const cors = corsHeaders(request.headers.origin);
    const method = request.method ?? 'GET';

    if (method === 'OPTIONS') {
      send(response, 204, { ...cors, 'Content-Length': '0' });
      return;
    }
    if (method !== 'GET' && method !== 'HEAD') {
      send(response, 405, { ...cors, Allow: 'GET, HEAD, OPTIONS' });
      return;
    }

    const url = new URL(request.url ?? '/', 'http://localhost');
    const segments = url.pathname.split('/').filter((segment) => segment.length > 0);
    if (segments[0] !== 'm' || segments[1] === undefined) {
      send(response, 404, cors);
      return;
    }
    const entry = mounts.get(segments[1]);
    if (entry === undefined) {
      // Deliberately identical to "no such file": an unknown token learns nothing.
      logger.warn('media.unknown_token', { path: url.pathname });
      send(response, 404, cors);
      return;
    }

    // **The growing playlist, and it is answered before anything touches a file.** Serving
    // ffmpeg's own `index.m3u8` off the disk would publish a `TARGETDURATION` it did not
    // keep and segment names the receiver cannot resolve — the two faults that cost SPIKE-1
    // two refused runs, each arriving as a bare `LOAD_FAILED` with no reason attached.
    if (entry.kind === 'hls' && segments.length === 3 && segments[2] === HLS_PUBLISHED_PLAYLIST) {
      const baseUrl = entry.baseUrl ?? `/m/${entry.token}/`;
      const playlist = await readPlaylist(entry, baseUrl);
      if (playlist === null) {
        logger.warn('media.playlist_missing', { token: entry.token, dir: entry.path });
        send(response, 404, cors);
        return;
      }
      const headers = {
        ...cors,
        'Content-Type': contentTypeFor(HLS_PUBLISHED_PLAYLIST),
        // A cached playlist never grows, so this is not a nicety either.
        'Cache-Control': 'no-store',
        'Content-Length': String(Buffer.byteLength(playlist.body)),
      };
      if (!entry.served) {
        logger.info('media.first_request', {
          token: entry.token,
          port: boundPort,
          rangeHeader: null,
          start: 0,
        });
      }
      entry.served = true;
      // **Playlist served ≥ 1, segments requested 0** is the signature of a television that
      // read the list and could not use it — a *serving* fault, and the only diagnostic
      // there is, because the wire says nothing. Counted here so the log can show it.
      entry.playlistsServed += 1;
      logger.debug('media.playlist_served', {
        token: entry.token,
        segments: playlist.segments.length,
        ended: playlist.ended,
        playlistsServed: entry.playlistsServed,
        segmentsServed: entry.segmentsServed,
      });
      // **The one diagnostic this shape has, and it is said out loud exactly once.** A
      // television that has read the list three times and never asked for a segment has
      // read it and could not use it — a CORS fault, an unreachable segment URL, an
      // untrue target duration. All three arrive on the wire as the same bare
      // `LOAD_FAILED` with nothing attached, which is why this line exists at all.
      //
      // It says nothing about what the device can *decode*, and it never teaches the
      // capability table: that would narrow a television's profile on the strength of a
      // missing header of our own (2026-08-19 serving-shape ADR).
      if (entry.playlistsServed === PLAYLIST_READS_BEFORE_SUSPICION && entry.segmentsServed === 0) {
        logger.warn('media.playlist_unused', {
          token: entry.token,
          playlistsServed: entry.playlistsServed,
          segmentsServed: 0,
          segments: playlist.segments.length,
          why: 'the television read the playlist and asked for no segments — a serving fault, not a capability one',
        });
      }
      // A HEAD is the same status and the same headers with the body left off. The receiver
      // issues them, so this is not theoretical.
      send(response, 200, headers, method === 'HEAD' ? undefined : playlist.body);
      return;
    }

    // **The derived response, and it never touches a disk.** One mount holds the cue list;
    // every rung of story 20's ladder is this route with a different number in it, shifted
    // at request time. `no-store` and a URL that changes with the content are belt and
    // braces on the same measurement: SPIKE-3 watched a television serve a *rewritten* file
    // out of its own cache and show the founder the old words.
    if (entry.kind === 'subtitles') {
      const offsetMs = subtitleOffsetOf(segments.slice(2));
      if (offsetMs === null || entry.cues === null) {
        logger.warn('media.subtitle_not_offered', { token: entry.token, path: url.pathname });
        send(response, 404, cors);
        return;
      }
      const body = toWebVtt(shiftCues(entry.cues, offsetMs));
      const headers = {
        ...cors,
        // Named through `contentTypeFor` like every other response, so the one table
        // decides. `entry.name` ends in `.vtt`; the bare extension would not — `extname`
        // reads a leading dot as a dotfile and answers `''`, which would have gone out as
        // `application/octet-stream`. SPIKE-3 measured what that looks like: all three
        // televisions accept it and keep playing, and the words never appear.
        'Content-Type': contentTypeFor(entry.name),
        'Cache-Control': 'no-store',
        // Exact, and computed from the bytes rather than the characters: a cue with an
        // accent in it is longer than its length in `String`, and a television handed a
        // short `Content-Length` stops reading mid-word.
        'Content-Length': String(Buffer.byteLength(body, 'utf8')),
      };
      if (!entry.served) {
        logger.info('media.first_request', {
          token: entry.token,
          port: boundPort,
          rangeHeader: null,
          start: 0,
        });
      }
      entry.served = true;
      logger.debug('media.subtitle_served', {
        token: entry.token,
        offsetMs,
        cues: entry.cues.length,
        bytes: headers['Content-Length'],
      });
      // No `Accept-Ranges`: there is no file to seek in, the whole track is a few tens of
      // kilobytes, and a receiver's JavaScript fetches it in one go.
      send(response, 200, headers, method === 'HEAD' ? undefined : body);
      return;
    }

    const target = resolveTarget(entry, segments.slice(2));
    if (target === null) {
      logger.warn('media.path_escape_blocked', { path: url.pathname });
      send(response, 404, cors);
      return;
    }

    let size: number;
    try {
      const stat = await fsp.stat(target);
      if (!stat.isFile()) {
        send(response, 404, cors);
        return;
      }
      size = stat.size;
    } catch (error) {
      // The source moved or was deleted. The founder gets a plain-language state from
      // the session supervisor; the device gets an honest 404 and stops asking.
      logger.warn('media.source_missing', { error, token: entry.token });
      deps.onSourceMissing?.(entry.token);
      send(response, 404, cors);
      return;
    }

    const parsed = parseRangeHeader(request.headers.range, size);
    const headers: Record<string, string> = {
      ...cors,
      'Accept-Ranges': 'bytes',
      'Content-Type': contentTypeFor(target),
      'Cache-Control': 'no-store',
    };

    if (parsed.kind === 'unsatisfiable') {
      logger.debug('media.range_unsatisfiable', { range: request.headers.range, size });
      send(response, 416, { ...headers, 'Content-Range': unsatisfiableContentRangeHeader(size) });
      return;
    }

    const range: ByteRange =
      parsed.kind === 'satisfiable' ? parsed.range : { start: 0, end: Math.max(0, size - 1) };
    const length = size === 0 ? 0 : range.end - range.start + 1;
    const status = parsed.kind === 'satisfiable' ? 206 : 200;
    if (parsed.kind === 'satisfiable') {
      headers['Content-Range'] = contentRangeHeader(range, size);
    }
    headers['Content-Length'] = String(length);

    // **The first request for a mount is evidence, not noise.** "The television came
    // back for bytes" is the one thing that separates a session the device is really
    // watching from one it is playing out of its own buffer — SPIKE-2 measured zero range
    // requests across a 15-second outage — and it is what the `reattach` scenario had no
    // way to assert. One info line per mount says it; everything after it stays debug.
    if (!entry.served) {
      logger.info('media.first_request', {
        token: entry.token,
        port: boundPort,
        rangeHeader: request.headers.range ?? null,
        start: range.start,
      });
    } else if (
      entry.interruptedAtMono !== null &&
      entry.liveDeliveries === 0 &&
      (entry.lastRequestAtMono ?? 0) <= entry.interruptedAtMono
    ) {
      // **The television went back for the film by itself**, after a delivery that ended
      // owing bytes — the *healthy* recovery, and the one a repair must leave alone (11h).
      //
      // Info, and the mirror of `media.first_request`, because on a mount that has already
      // been served there is otherwise no line at all above `debug` that says the bytes
      // started flowing again. Without it "the film came back" could only be graded on a
      // repair having published a **new** mount, so a set that mended itself read as a set
      // that never came back.
      logger.info('media.delivery_resumed', {
        token: entry.token,
        rangeHeader: request.headers.range ?? null,
        start: range.start,
        sinceInterruptionMs: Math.round(clock.monoMs() - entry.interruptedAtMono),
      });
    }
    entry.served = true;
    // **The film's own lifeline, timestamped.** Every request for bytes counts, whether or
    // not it is the first: after an outage this is how the session tells a television that
    // came back for the film by itself from one that never will (D2).
    entry.lastRequestAtMono = clock.monoMs();
    if (entry.kind === 'hls') entry.segmentsServed += 1;
    // Debug, not info: on a 347 MB file this fires often. When the 5-second target is
    // measured on real hardware, this log is what says whether the time went on range
    // requests or somewhere else.
    logger.debug('media.request', {
      method,
      token: entry.token,
      status,
      rangeHeader: request.headers.range ?? null,
      start: range.start,
      end: range.end,
      bytes: length,
      size,
    });

    if (method === 'HEAD' || length === 0) {
      send(response, status, headers);
      return;
    }

    response.writeHead(status, headers);
    const stream = fs.createReadStream(target, { start: range.start, end: range.end });
    stream.on('error', (error: Error) => {
      logger.warn('media.stream_error', { error, token: entry.token });
      response.destroy();
    });
    // **One delivery, watched to its end.** A progressive film is a single open-ended
    // response that stays open for the whole evening, so "in flight" and "ended owing
    // bytes" are the only two facts about it worth having — and the second is the one a
    // pulled cable produces (D2).
    entry.liveDeliveries += 1;
    const ticket = { startedAtMono: clock.monoMs() };
    inFlight.add(ticket);
    let completed = false;
    response.on('finish', () => {
      completed = true;
    });
    // A receiver that seeks abandons the previous response mid-flight. That is normal,
    // not an error: close the file handle and say nothing.
    response.on('close', () => {
      stream.destroy();
      entry.liveDeliveries = Math.max(0, entry.liveDeliveries - 1);
      inFlight.delete(ticket);
      if (completed) return;
      entry.interruptedAtMono = clock.monoMs();
      entry.interruptions += 1;
      // Debug, because it is normal: every seek makes one. It is only evidence when
      // nothing replaces it, and that judgement belongs to the session supervisor.
      logger.debug('media.delivery_interrupted', {
        token: entry.token,
        interruptions: entry.interruptions,
        start: range.start,
        end: range.end,
      });
      // **Told, rather than left to be noticed.** The bookkeeping above was already right
      // on 2026-08-28 and the film still froze for fourteen seconds, because the only
      // reader of it had looked 229 ms too early. Announced *after* the record is written,
      // so whatever the session reads next is this delivery's death and not the state
      // before it.
      deps.onDeliveryInterrupted?.(entry.token);
    });
    stream.pipe(response);
  }

  function listen(port: number): Promise<number> {
    return new Promise<number>((resolve, reject) => {
      const current = server;
      if (current === null) {
        reject(new EngineError('MEDIA_SERVER_FAILED', 'server not created'));
        return;
      }
      const onError = (error: NodeJS.ErrnoException): void => {
        current.removeListener('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        current.removeListener('error', onError);
        const address = current.address();
        resolve(typeof address === 'object' && address !== null ? address.port : port);
      };
      current.once('error', onError);
      current.once('listening', onListening);
      current.listen(port, MEDIA_SERVER.bindAddress);
    });
  }

  return {
    get port() {
      return boundPort;
    },

    async start(requestedPort?: number): Promise<MediaServerAddress> {
      if (boundPort !== null) return { port: boundPort };
      const firstPort = requestedPort ?? preferredPort;
      server = http.createServer((request, response) => {
        handle(request, response).catch((error: unknown) => {
          logger.error('media.handler_failed', { error });
          if (!response.headersSent) response.writeHead(500);
          response.end();
        });
      });
      server.on('clientError', (error: Error, socket) => {
        logger.debug('media.client_error', { error });
        socket.destroy();
      });
      // Held only so `unsafeBlackout` can take them away. See the note on that method:
      // this is the harness's cable, and nothing in the product pulls it.
      server.on('connection', (socket) => {
        if (blackout) {
          socket.destroy();
          return;
        }
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
      });

      let lastError: unknown = null;
      for (let attempt = 0; attempt < MEDIA_SERVER.portScanAttempts; attempt += 1) {
        // Port 0 means "any free port" and must not be scanned upward from: 1, 2, 3 are
        // privileged and every one of them would fail.
        const candidate = firstPort === 0 ? 0 : firstPort + attempt;
        try {
          boundPort = await listen(candidate);
          logger.info('media.listening', { port: boundPort, bind: MEDIA_SERVER.bindAddress });
          return { port: boundPort };
        } catch (error) {
          lastError = error;
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'EADDRINUSE' && code !== 'EACCES') break;
        }
      }
      server.close();
      server = null;
      throw new EngineError(
        'MEDIA_SERVER_FAILED',
        `no free port in ${String(firstPort)}..${String(firstPort + MEDIA_SERVER.portScanAttempts - 1)}`,
        {
          userMessage: 'CastGood could not open the port it needs to send video to your TV.',
          context: { preferredPort: firstPort, lastError },
        },
      );
    },

    async stop(): Promise<void> {
      const current = server;
      server = null;
      boundPort = null;
      mounts.clear();
      if (current === null) return;
      sockets.clear();
      await new Promise<void>((resolve) => {
        current.close(() => resolve());
        // Any half-open receiver connection would otherwise hold the process open.
        current.closeAllConnections();
      });
      logger.info('media.stopped', {});
    },

    mount(descriptor) {
      // Random by default, and long enough that a URL is only useful to whoever we handed
      // it to. A caller-supplied token is only for re-publishing a URL that a device is
      // still fetching (see the interface).
      const token = descriptor.token ?? crypto.randomBytes(16).toString('hex');
      const derived = descriptor.kind === 'subtitles';
      const entry: MountEntry = {
        token,
        // Nothing on disk stands behind a derived mount, and saying so with `''` keeps that
        // true of the record as well as of the response.
        path: derived ? '' : descriptor.path,
        kind: descriptor.kind,
        cues: derived ? descriptor.cues : null,
        // A growing conversion is a directory, and the name a directory would give is the
        // name of a folder. What the television is handed is the playlist inside it.
        name: derived
          ? descriptor.name
          : descriptor.kind === 'hls'
            ? HLS_PUBLISHED_PLAYLIST
            : path.basename(descriptor.path),
        served: false,
        baseUrl: null,
        playlistsServed: 0,
        segmentsServed: 0,
        liveDeliveries: 0,
        lastRequestAtMono: null,
        interruptedAtMono: null,
        interruptions: 0,
      };
      mounts.set(token, entry);
      logger.info('media.mounted', { token, kind: entry.kind, name: entry.name });
      return entry;
    },

    unmount(token) {
      if (mounts.delete(token)) logger.info('media.unmounted', { token });
    },

    urlFor(mount, localAddress) {
      if (boundPort === null) {
        throw new EngineError('MEDIA_SERVER_FAILED', 'media server is not listening');
      }
      // Absolute, IP literal, no redirect: all three are Default Media Receiver rules.
      const base = `http://${localAddress}:${String(boundPort)}/m/${mount.token}/`;
      // Remembered, because every segment line of a growing playlist is this prefix plus a
      // name — and the receiver must be given absolute URLs (SPIKE-1's first refused run).
      const entry = mounts.get(mount.token);
      if (entry !== undefined) entry.baseUrl = base;
      return `${base}${encodeURIComponent(mount.name)}`;
    },

    subtitleUrlFor(mount, localAddress, offsetMs) {
      if (boundPort === null) {
        throw new EngineError('MEDIA_SERVER_FAILED', 'media server is not listening');
      }
      // Clamped through the same function the displayed number goes through, so a URL can
      // never name an offset the control could not have reached — and the route refuses
      // anything outside that range, which would otherwise be a silent 404 mid-film.
      const offset = clampOffsetMs(offsetMs);
      // The harness's 18l run, and the film's own URL is deliberately not affected: the
      // television keeps getting the picture from the port it was given and cannot reach
      // the words at all. See `unsafeWithholdTracks`.
      const port = withholdTracks ? DEAD_TRACK_PORT : boundPort;
      return (
        `http://${localAddress}:${String(port)}/m/${mount.token}/` +
        `${SUBTITLE_PREFIX}/${String(offset)}.vtt`
      );
    },

    hasServedRequest: (token) => mounts.get(token)?.served ?? false,

    deliveryFor(token) {
      const entry = mounts.get(token);
      if (entry === undefined) return null;
      return {
        live: entry.liveDeliveries,
        lastRequestAtMono: entry.lastRequestAtMono,
        interruptedAtMono: entry.interruptedAtMono,
        interruptions: entry.interruptions,
      };
    },

    deliveriesInFlight() {
      let oldest: number | null = null;
      for (const ticket of inFlight) {
        if (oldest === null || ticket.startedAtMono < oldest) oldest = ticket.startedAtMono;
      }
      return {
        count: inFlight.size,
        oldestForMs: oldest === null ? 0 : Math.max(0, Math.round(clock.monoMs() - oldest)),
      };
    },

    unsafeWithholdTracks(on) {
      if (withholdTracks === on) return;
      withholdTracks = on;
      logger.warn('media.tracks_withheld', {
        on,
        port: DEAD_TRACK_PORT,
        why: 'the selftest is declaring text tracks at a port this PC does not answer on, and only the selftest can',
      });
    },

    unsafeBlackout(on) {
      if (blackout === on) return 0;
      blackout = on;
      // **Deliveries, not sockets**, and the difference is the honesty gate. A socket may
      // be sitting in an HTTP keep-alive pool having finished its work; a *delivery* is
      // content on its way to the television right now, which is the only thing an outage
      // can take away from it. Counted before anything is destroyed.
      let deliveries = 0;
      for (const entry of mounts.values()) deliveries += entry.liveDeliveries;
      let destroyed = 0;
      if (on) {
        for (const socket of sockets) {
          socket.destroy();
          destroyed += 1;
        }
        sockets.clear();
      }
      logger.warn('media.blackout', {
        on,
        destroyed,
        deliveries,
        why: 'the selftest is taking the television’s route to this PC away, and only the selftest can',
      });
      return on ? deliveries : destroyed;
    },
  };
}

export {
  buildPlaylist,
  existingSegments,
  parseHlsIndex,
  publishedSeconds,
  targetDurationFor,
  HLS_PUBLISHED_PLAYLIST,
  HLS_SOURCE_PLAYLIST,
  type HlsIndex,
  type HlsSegment,
} from './hls.js';
export {
  parseRangeHeader,
  contentRangeHeader,
  unsatisfiableContentRangeHeader,
  type ByteRange,
  type RangeParseResult,
} from './range.js';
