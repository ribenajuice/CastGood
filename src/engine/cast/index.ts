import { z } from 'zod';
import type { Device } from '../types.js';
import type { Clock, Logger } from '../logging/index.js';
import { systemClock } from '../logging/index.js';
import { CAST, TIMING } from '../config.js';
import { EngineError } from '../errors.js';
import { tlsTransportFactory, type CastTransport, type TransportFactory } from './castv2/client.js';
import type { CastMessage } from './castv2/proto.js';

/**
 * The Cast client — one TLS connection per device on port 8009, speaking CASTV2.
 *
 * Layering:
 *   cast/castv2/   frame codec + TLS socket + `localAddress`   (protocol only)
 *   cast/          receiver + media namespace client            (this file)
 *
 * Three things here are load-bearing for the rest of the product:
 *  - `localAddress` is read from the live socket after connect. That, and never an
 *    interface enumeration, is the IP we put in media URLs.
 *  - every MEDIA_STATUS is stamped with a *monotonic* timestamp on arrival, because
 *    position accuracy is measured against that stamp and not the wall clock, which
 *    jumps when the PC resumes from sleep mid-film.
 *  - everything arriving on the socket is parsed with a schema before it is believed.
 *    A TV on the LAN is not trusted input; a surprising firmware payload must produce
 *    a logged warning, not an exception in the middle of playback.
 */

export type PlayerState = 'IDLE' | 'BUFFERING' | 'PLAYING' | 'PAUSED';

export interface MediaStatus {
  readonly mediaSessionId: number;
  readonly playerState: PlayerState;
  /**
   * `null` when the device did not report one — which is not the same as zero, and the
   * difference is a whole film. A Default Media Receiver announces the end of media as
   * `{playerState: "IDLE", idleReason: "FINISHED"}` with **no** `currentTime` field at
   * all; coercing that to 0 told the founder their place was saved at 0:00:00.
   */
  readonly currentTimeSec: number | null;
  readonly durationSec: number | null;
  /** Present on the device's own report; `ERROR` in the first seconds means a rejected load. */
  readonly idleReason: string | null;
  /**
   * The URL the device is playing, when it says.
   *
   * This is how CastGood recognises its own content on a television it did not just start
   * (PRD 12a/12b): the token in the URL is unguessable and ours. Like `duration`, real
   * receivers only carry it on the LOAD reply and on an explicit `GET_STATUS`, not on
   * every unsolicited status — so it is cached rather than expected each time.
   */
  readonly contentId: string | null;
  /** Monotonic ms at which this status was received. The anchor for extrapolation. */
  readonly receivedAtMono: number;
}

export interface ReceiverStatus {
  /**
   * `CC1AD845` is ours. Anything else means someone took the TV and we yield.
   *
   * **`null` is the signal that the TV went back to its own home screen** — the receiver
   * reports no running application — which is what criterion 4b is actually about.
   */
  readonly appId: string | null;
  /**
   * The running app's own display name — "YouTube", "Prime Video", "Default Media
   * Receiver". Criterion 14a states the takeover as a **fact**: "\<name\> is now playing
   * \<other app\>", and this is the only place that second name can come from.
   */
  readonly appName: string | null;
  /**
   * **`null` means the television said nothing about its volume, and that is not `0`.**
   *
   * These were `number`/`boolean` defaulting to `0`/`false` until M5a, which was harmless
   * only because nothing read them. It stops being harmless the moment a level reaches a
   * screen: 23b promises the app displays *the last level a receiver status reported, and
   * nothing else*, and a silent `0` is a level nobody reported. SPIKE-5 met the same trap
   * from the other side — a set that is not casting reports a real `0` which is **not** its
   * volume — so absent and zero must stay tellable apart.
   */
  readonly volumeLevel: number | null;
  readonly muted: boolean | null;
  /**
   * How this set says its volume may be driven. **`'fixed'` is the refusal 23h exists for.**
   * An unrecognised value becomes `'other'` rather than `null`, because *the set answered
   * with something we do not know* and *the set did not answer* are different facts.
   */
  readonly volumeControlType: VolumeControlType | null;
  /** The set's own granularity. Per-device: 0.01 on an `AI PONT`, 0.05 on a dongle. */
  readonly volumeStepInterval: number | null;
  /** Monotonic ms at which this status was received. Stamped on arrival, never re-derived. */
  readonly receivedAtMono: number;
}

/**
 * What a fresh connection found already running on the device.
 *
 * This is the *non-destructive* probe, and the distinction matters: `LAUNCH` would **take
 * the television**. SPIKE-2 watched a LAUNCH of `CC1AD845` evict YouTube from the device,
 * which is precisely what criterion 14b forbids ("CastGood yields immediately and sends
 * nothing further to it"). So recovery, takeover detection and reattach all ask
 * `GET_STATUS` and act on the answer; only a founder pressing a button ever launches.
 */
/**
 * Is this another app *having* the television, or the television sitting idle?
 *
 * The two are not the same and were treated as the same: any appId that was not our own
 * counted as a takeover, so a Chromecast that had dropped into its Backdrop screensaver
 * after the founder stopped playback reported "\<name\> is now playing Backdrop"
 * with an offer to take it back from a slideshow.
 */
export function isTakeoverApp(appId: string | null, appName: string | null = null): boolean {
  if (appId === null) return false;
  if (appId === CAST.defaultReceiverAppId) return false;
  if (CAST.idleAppIds.includes(appId)) return false;
  if (appName !== null && CAST.idleAppNamePattern.test(appName)) return false;
  return true;
}

export interface RejoinResult {
  readonly appId: string | null;
  readonly appName: string | null;
  /** True when the app running on the device is the Default Media Receiver — ours. */
  readonly ours: boolean;
  /**
   * The running media session, when our app is the one running and it answered.
   *
   * `null` when the app is not ours, when the device is on its home screen, or — the case
   * SPIKE-2 measured after a takeover — when the old media session simply stops answering.
   */
  readonly media: MediaStatus | null;
}

/**
 * One text track, in the shape the Default Media Receiver accepts — **measured, not read**.
 *
 * Every field below was on the wire of a LOAD that put words on all three of the founder's
 * televisions on 2026-08-26 (SPIKE-3). `trackContentType` in particular is not optional:
 * without it the track goes out as `application/octet-stream`, and all three sets accepted
 * that and showed nothing — a diagnostic-free failure of exactly the shape this project
 * keeps being bitten by.
 */
export interface LoadTrack {
  readonly trackId: number;
  readonly type: 'TEXT';
  /** Absolute URL of the `.vtt` on CastGood's own media server. */
  readonly trackContentId: string;
  readonly trackContentType: string;
  readonly subtype: 'SUBTITLES';
  /** What the television shows in its own track menu. The founder's own label. */
  readonly name: string;
  /** The language the film named, or `''` when it named none. */
  readonly language: string;
}

export interface LoadRequest {
  /** Absolute URL, IP literal, never redirected — the Default Media Receiver requires all three. */
  readonly contentUrl: string;
  /**
   * Must be exactly what the media server will answer with. The receiver trusts this
   * metadata over the response header, so announcing `video/mp4` for a WebM the device
   * plays perfectly well earns a spurious "Couldn't play this file".
   */
  readonly contentType: string;
  readonly streamType: 'BUFFERED' | 'LIVE';
  readonly startPositionSec: number;
  readonly autoplay: boolean;
  /** Shown on the TV's own idle/loading card. The file name, nothing else. */
  readonly title?: string;
  /**
   * Text tracks to declare — **absent, not empty, when there are none** (19a).
   *
   * `undefined` means the LOAD carries no `tracks` key at all, which is what makes
   * subtitles-off *"byte-for-byte what it would have been before M3c existed"*. It is also
   * the only correct way to say "off": SPIKE-3 measured that declaring four tracks with
   * `activeTrackIds: []` caused **all four to be fetched anyway** on all three televisions,
   * so an empty array is not off — it is four downloads and a promise broken quietly.
   */
  readonly tracks?: readonly LoadTrack[];
  /**
   * Which of the declared tracks the television should show. Absent when `tracks` is.
   *
   * A track can only ever be *declared* in a LOAD — re-declaring one later is accepted and
   * ignored on all three device classes (SPIKE-3) — which is why this rides along with the
   * load rather than being a command of its own.
   */
  readonly activeTrackIds?: readonly number[];
}

/**
 * Why a connection ended. The difference is the difference between an error message and a
 * plain statement of fact: a founder who presses stop on the TV itself has not suffered a
 * failure, and telling them "Lost connection" for something they just did on purpose is
 * both wrong and alarming.
 */
export interface DisconnectInfo {
  readonly reason: string;
  /**
   * True when the *device* ended the session in an orderly way — it closed the virtual
   * connection, or its receiver reported our app was no longer running. False for a socket
   * error, a reset, or a heartbeat that ran out of patience.
   */
  readonly deviceInitiated: boolean;
}

export type VolumeControlType = 'attenuation' | 'fixed' | 'master' | 'other';

/**
 * One volume change: a level, or a mute, never both in the same message.
 *
 * A union rather than two optional fields, so *set the level* and *mute* cannot be
 * conflated at a call site. 23f forbids mute being implemented as a level of zero — the
 * founder ruled it its own control (question 42) — and a shape that cannot carry both at
 * once is a cheaper guarantee of that than a comment.
 */
export type VolumeChange = { readonly level: number } | { readonly muted: boolean };

export interface CastConnectionEvents {
  onMediaStatus(status: MediaStatus): void;
  onReceiverStatus(status: ReceiverStatus): void;
  /** The connection ended, cleanly or otherwise. See `DisconnectInfo`. */
  onDisconnected(info: DisconnectInfo): void;
}

export interface CastConnection {
  /** The local IP the OS chose to reach this device. Goes straight into the media URL. */
  readonly localAddress: string;
  /**
   * Wake the Default Media Receiver on the television.
   *
   * `timeoutMs` is supplied by the caller rather than read from `CAST` here because the
   * *session* is the only thing that knows how much of the founder's wait is left — this
   * exchange is retried, and each attempt gets whatever the budget can still afford
   * (`CAST.launchTimeoutMs` by default).
   */
  launchDefaultReceiver(timeoutMs?: number): Promise<void>;
  load(request: LoadRequest, timeoutMs?: number): Promise<MediaStatus>;
  play(): Promise<void>;
  pause(): Promise<void>;
  /** Ends the media session *and* returns the TV to its own home screen. */
  stop(): Promise<void>;
  seek(positionSec: number): Promise<void>;
  /**
   * Turn declared text tracks on, off, or swap which one is showing — **19b and 20b**.
   *
   * `EDIT_TRACKS_INFO` is the only thing a television will accept mid-film on the subject of
   * subtitles, and it can only ever name tracks that were declared in the LOAD. SPIKE-3
   * measured the three routes on all three sets on 2026-08-26: a new URL is accepted and
   * ignored, a rewritten file is served from cache, and **switching between pre-declared
   * tracks works in 11–36 ms with no buffering**. That last one is this call.
   *
   * An empty array is *off*, and here it means exactly that — unlike in a LOAD, where the
   * same value caused all four declared tracks to be fetched anyway.
   */
  setActiveTracks(trackIds: readonly number[]): Promise<void>;
  getStatus(): Promise<MediaStatus | null>;
  getReceiverStatus(): Promise<ReceiverStatus>;
  /**
   * Move the television's own volume — M5a, and **the only message this milestone sends**.
   *
   * **The receiver namespace, and that was measured rather than assumed.** SPIKE-5 found
   * a media-namespace stream volume on the founder's `AI PONT` and asked it for 0.5: it
   * echoed 1.0 and moved nothing, while the receiver volume took every level exactly and
   * agreed with Google Home's own slider. So the receiver's is the number that reaches the
   * room, and the media namespace is not touched — which is also what makes 23e's *zero
   * media messages* true by construction rather than by care.
   *
   * **Level and mute go separately, because the television holds them separately.** A mute
   * does not zero the level (measured: muted at 0.30, unmuted, back to 0.30 with no level
   * ever sent), which is the whole reason 23f can promise CastGood remembers nothing.
   *
   * **Deliberately not quiet.** The `RECEIVER_STATUS` that answers this is announced through
   * `onReceiverStatus` exactly like any other, so the readout updates through the *same*
   * path whether the change came from us, from a phone, or from somebody's remote. That is
   * 23b made structural: there is no code path by which our own ask can paint the screen.
   */
  setVolume(change: VolumeChange, timeoutMs?: number): Promise<ReceiverStatus>;
  /**
   * Asks what is already running and adopts it if it is ours. Launches nothing.
   *
   * On success against our own receiver this connection is left addressed to the running
   * session — `play()`, `pause()`, `seek()` and `getStatus()` work on a media session this
   * process never started, which SPIKE-2 confirmed on hardware (pause 81 ms, resume 74 ms).
   */
  rejoin(): Promise<RejoinResult>;
  /**
   * Hang up.
   *
   * `announce: false` suppresses the `onDisconnected` event — **not** the teardown, which
   * always happens. Use it for a connection this process opened, used and closed on
   * purpose: a recovery probe, or the reattach probe that found somebody else's film. The
   * caller already knows it closed, and publishing "the device disconnected" for our own
   * hang-up put a spurious *Reconnecting to \<name\>…* on screen in the middle of an
   * app that was opening straight into Idle (12b).
   */
  close(options?: { readonly announce?: boolean }): Promise<void>;
}

export interface CastClientDeps {
  logger: Logger;
  clock?: Clock;
  /** Swapped for plain TCP by the headless fake receiver. The app always uses TLS. */
  transport?: TransportFactory;
  /** Overridden only by tests, so the 10-second death of a silent socket takes 200 ms. */
  heartbeatIntervalMs?: number;
}

export interface CastClient {
  connect(device: Device, events: CastConnectionEvents): Promise<CastConnection>;
}

const NS_CONNECTION = 'urn:x-cast:com.google.cast.tp.connection';
const NS_HEARTBEAT = 'urn:x-cast:com.google.cast.tp.heartbeat';
const NS_RECEIVER = 'urn:x-cast:com.google.cast.receiver';
const NS_MEDIA = 'urn:x-cast:com.google.cast.media';

const PLATFORM_RECEIVER = 'receiver-0';
const SENDER_ID = 'sender-0';

// --- What we are willing to believe from the wire -----------------------------

const envelopeSchema = z.object({
  type: z.string().optional(),
  requestId: z.number().optional(),
});

const mediaEntrySchema = z.object({
  mediaSessionId: z.number().optional(),
  playerState: z.string().optional(),
  currentTime: z.number().optional(),
  idleReason: z.string().nullish(),
  media: z
    .object({
      duration: z.number().nullish(),
      contentId: z.string().optional(),
    })
    .optional(),
});

const mediaStatusSchema = z.object({
  status: z.array(mediaEntrySchema).optional(),
});

const receiverStatusSchema = z.object({
  status: z
    .object({
      applications: z
        .array(
          z.object({
            appId: z.string().optional(),
            sessionId: z.string().optional(),
            transportId: z.string().optional(),
            /** "YouTube", "Prime Video" — the name criterion 14a puts on screen. */
            displayName: z.string().optional(),
          }),
        )
        .optional(),
      /**
       * **Read whole, because SPIKE-5 found two of these four fields decide behaviour.**
       * `controlType: 'fixed'` is a television saying it owns its own volume and we may
       * not set it (23h); `stepInterval` is that set's granularity and it is **per-device
       * and not a constant of ours** — measured 2026-09-07 as **0.01** on the founder's
       * `AI PONT` and **0.05** on both Chromecast dongles, a 5× difference the slider has
       * to render honestly.
       */
      volume: z
        .object({
          level: z.number().optional(),
          muted: z.boolean().optional(),
          // **`.catch` on both, because the whole status is gated on `parsed.success`.** A
          // set answering `controlType: 3` or `stepInterval: "0.05"` did not lose its volume
          // fields — it lost the entire receiver status, and with it takeover detection (14a)
          // and the 4b evidence the selftest reads. These two are new in M5a and are the
          // least load-bearing fields on the object; neither is worth a dropped status.
          controlType: z.string().optional().catch(undefined),
          stepInterval: z.number().optional().catch(undefined),
        })
        .optional(),
    })
    .optional(),
});

const VOLUME_CONTROL_TYPES: readonly VolumeControlType[] = ['attenuation', 'fixed', 'master'];

/**
 * One reading of a `volume` object, wherever it came from.
 *
 * Both routes that produce a `ReceiverStatus` — an answered `GET_STATUS`/`SET_VOLUME`, and
 * an unsolicited broadcast — spend this, so they cannot drift apart about what an absent
 * field means. **`null` is not `0`**: a set that is not casting reports a real zero, and
 * the two must stay tellable apart (SPIKE-5, 2026-09-07).
 */
function volumeOf(
  volume:
    | {
        level?: number | undefined;
        muted?: boolean | undefined;
        controlType?: string | undefined;
        stepInterval?: number | undefined;
      }
    | undefined,
): Pick<ReceiverStatus, 'volumeLevel' | 'muted' | 'volumeControlType' | 'volumeStepInterval'> {
  return {
    volumeLevel: volume?.level ?? null,
    muted: volume?.muted ?? null,
    volumeControlType: toVolumeControlType(volume?.controlType),
    volumeStepInterval: volume?.stepInterval ?? null,
  };
}

/**
 * A television's own word for how its volume may be driven.
 *
 * Measured across the founder's three sets on 2026-09-07: the `AI PONT` says `master`,
 * both Chromecast dongles say `attenuation`. Nothing here has yet said `fixed`, which is
 * the one that would disable the control (23h) — so that path is built from the protocol
 * rather than from an observation, and it is written to be provable by the fake receiver.
 *
 * An unrecognised string becomes `'other'`, never `null`: *the set answered with something
 * we do not know* and *the set did not answer* lead to different behaviour, and collapsing
 * them would make an unknown control type indistinguishable from a set that never spoke.
 */
function toVolumeControlType(value: string | undefined): VolumeControlType | null {
  if (value === undefined) return null;
  return VOLUME_CONTROL_TYPES.includes(value as VolumeControlType)
    ? (value as VolumeControlType)
    : 'other';
}

const PLAYER_STATES: readonly PlayerState[] = ['IDLE', 'BUFFERING', 'PLAYING', 'PAUSED'];

function toPlayerState(value: string | undefined): PlayerState {
  return PLAYER_STATES.includes(value as PlayerState) ? (value as PlayerState) : 'IDLE';
}

interface PendingRequest {
  resolve(payload: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export function createCastClient(deps: CastClientDeps): CastClient {
  const clock = deps.clock ?? systemClock;
  const makeTransport = deps.transport ?? tlsTransportFactory;

  return {
    async connect(device: Device, events: CastConnectionEvents): Promise<CastConnection> {
      const logger = deps.logger.child({ component: 'cast', deviceId: device.id });
      const pending = new Map<number, PendingRequest>();
      let requestId = 1;
      let transport: CastTransport | null = null;
      let closed = false;
      let missedPongs = 0;
      let heartbeat: NodeJS.Timeout | null = null;
      let appSessionId: string | null = null;
      let transportId: string | null = null;
      let mediaSessionId: number | null = null;
      let lastDurationSec: number | null = null;
      /** Cached for the same reason duration is: it rides on LOAD and GET_STATUS only. */
      let lastContentId: string | null = null;
      /**
       * Set when the device ends the session itself: a CLOSE on the connection namespace,
       * or a receiver status saying our app stopped running after we had seen it running.
       * Both are what a TV sends when someone stops playback from the TV's own controls.
       */
      let endedByDevice = false;
      /**
       * True once our app has actually been seen running on this device. An empty
       * `applications` list only means "the founder stopped it" if there was something to
       * stop: a receiver status that arrives *before* the launch says nothing is running
       * because nothing has been started yet, and arming the flag there latched it for the
       * whole session — so a genuine mid-film disconnect would have been reported as a
       * deliberate end, and M2's reconnect would decide the founder meant it.
       */
      let sawOurApp = false;
      /**
       * True once *we* began tearing the session down. The device answers our receiver STOP
       * with the same empty `applications` list the founder's own Stop produces, so without
       * this the two are indistinguishable and every engine-initiated stop was reported as
       * device-initiated.
       */
      let teardownByUs = false;

      const fail = (reason: string, deviceInitiated = false, announce = true): void => {
        if (closed) return;
        closed = true;
        if (heartbeat !== null) clearInterval(heartbeat);
        for (const [, request] of pending) {
          clearTimeout(request.timer);
          request.reject(new EngineError('DEVICE_UNREACHABLE', `cast connection ended: ${reason}`));
        }
        pending.clear();
        transport?.close();
        // Anything we started cannot have been the device's decision, whatever the device
        // said on the way out. `reason: "closed by engine"` with `deviceInitiated: true` is
        // a contradiction, and this is where it is made impossible.
        const clean = (deviceInitiated || endedByDevice) && !teardownByUs;
        logger.info('cast.disconnected', {
          reason,
          deviceInitiated: clean,
          teardownByUs,
          announce,
        });
        if (announce) events.onDisconnected({ reason, deviceInitiated: clean });
      };

      const send = (
        namespace: string,
        destination: string,
        payload: Record<string, unknown>,
      ): void => {
        if (transport === null || closed) return;
        transport.send({
          sourceId: SENDER_ID,
          destinationId: destination,
          namespace,
          data: JSON.stringify(payload),
        });
      };

      /**
       * Request ids whose *receiver* answer must not be published as an event.
       *
       * A `GET_STATUS` we sent is a question, and its answer belongs to the caller that
       * asked it. Publishing it as well made `rejoin()`'s own probe indistinguishable from
       * a television spontaneously announcing that somebody else had taken it — which is
       * how reopening onto a TV playing YouTube came to flash "\<name\> is now
       * playing YouTube" with a *Take it back* button before going quietly Idle (12b).
       */
      const quiet = new Set<number>();

      /**
       * One reading of a receiver payload, used by every route that produces one.
       *
       * `GET_STATUS` and the echo of a `SET_VOLUME` return the identical shape, and M5a is
       * the first milestone where two callers grade the *same* fields. Two parsers would be
       * two chances to disagree about whether an absent level is `null` or `0` — which is
       * precisely the bug this milestone had to fix once already.
       */
      const toReceiverStatus = (response: unknown): ReceiverStatus => {
        const parsed = receiverStatusSchema.safeParse(response);
        const receiver = parsed.success ? parsed.data.status : undefined;
        const first = (receiver?.applications ?? [])[0];
        return {
          appId: first?.appId ?? null,
          appName: first?.displayName ?? null,
          ...volumeOf(receiver?.volume),
          receivedAtMono: clock.monoMs(),
        };
      };

      const request = (
        namespace: string,
        destination: string,
        payload: Record<string, unknown>,
        timeoutMs: number,
        options: { quiet?: boolean } = {},
      ): Promise<unknown> => {
        if (transport === null || closed) {
          return Promise.reject(new EngineError('DEVICE_UNREACHABLE', 'not connected'));
        }
        const id = requestId++;
        if (options.quiet === true) quiet.add(id);
        return new Promise<unknown>((resolve, reject) => {
          const timer = setTimeout(() => {
            pending.delete(id);
            reject(
              new EngineError(
                'DEVICE_UNREACHABLE',
                `device did not answer ${String(payload['type'])}`,
                {
                  context: { requestId: id, type: payload['type'] },
                },
              ),
            );
          }, timeoutMs);
          timer.unref?.();
          pending.set(id, { resolve, reject, timer });
          send(namespace, destination, { ...payload, requestId: id });
        });
      };

      const settle = (id: number, payload: unknown): boolean => {
        const request_ = pending.get(id);
        if (request_ === undefined) return false;
        clearTimeout(request_.timer);
        pending.delete(id);
        request_.resolve(payload);
        return true;
      };

      const toMediaStatus = (entry: z.infer<typeof mediaEntrySchema>): MediaStatus => {
        const duration = entry.media?.duration;
        if (typeof duration === 'number' && Number.isFinite(duration) && duration > 0) {
          lastDurationSec = duration;
        }
        const contentId = entry.media?.contentId;
        if (typeof contentId === 'string' && contentId !== '') lastContentId = contentId;
        if (typeof entry.mediaSessionId === 'number') mediaSessionId = entry.mediaSessionId;
        return {
          mediaSessionId: entry.mediaSessionId ?? mediaSessionId ?? 0,
          playerState: toPlayerState(entry.playerState),
          currentTimeSec: typeof entry.currentTime === 'number' ? entry.currentTime : null,
          durationSec: lastDurationSec,
          idleReason: entry.idleReason ?? null,
          contentId: lastContentId,
          // Stamped here, on arrival, and never re-derived later: this is the anchor
          // every position calculation in the engine hangs off.
          receivedAtMono: clock.monoMs(),
        };
      };

      const handleMessage = (message: CastMessage): void => {
        let payload: unknown;
        try {
          payload = JSON.parse(message.data) as unknown;
        } catch {
          logger.warn('cast.unparseable_payload', { namespace: message.namespace });
          return;
        }
        const envelope = envelopeSchema.safeParse(payload);
        const type = envelope.success ? envelope.data.type : undefined;
        const id = envelope.success ? envelope.data.requestId : undefined;

        if (message.namespace === NS_HEARTBEAT) {
          if (type === 'PING') send(NS_HEARTBEAT, message.sourceId, { type: 'PONG' });
          if (type === 'PONG') missedPongs = 0;
          return;
        }

        if (message.namespace === NS_CONNECTION && type === 'CLOSE') {
          // An orderly close, not a failure. This is what arrives when the founder stops
          // playback from the TV itself.
          fail('device closed the connection', true);
          return;
        }

        if (message.namespace === NS_MEDIA) {
          const parsed = mediaStatusSchema.safeParse(payload);
          const entries = parsed.success ? (parsed.data.status ?? []) : [];
          const first = entries[0];
          const status = first === undefined ? null : toMediaStatus(first);

          // An answered request still carries device truth, so it is settled *and*
          // published as an event. Nothing reaches the UI except through events.
          if (id !== undefined && id !== 0) settle(id, { type, status });
          if (status !== null) {
            logger.debug('cast.media_status', {
              playerState: status.playerState,
              currentTimeSec: status.currentTimeSec,
              idleReason: status.idleReason,
            });
            events.onMediaStatus(status);
          } else if (type === 'MEDIA_STATUS') {
            logger.debug('cast.media_status_empty', {});
          }
          return;
        }

        if (message.namespace === NS_RECEIVER) {
          const parsed = receiverStatusSchema.safeParse(payload);
          if (parsed.success) {
            const applications = parsed.data.status?.applications ?? [];
            const ours = applications.find((app) => app.appId === CAST.defaultReceiverAppId);
            if (ours !== undefined) {
              sawOurApp = true;
              appSessionId = ours.sessionId ?? appSessionId;
              transportId = ours.transportId ?? transportId;
            } else if (applications.length === 0 && (id === undefined || id === 0)) {
              // Our app is no longer running. That only means the *device* ended the
              // session if it had been running in the first place and we did not just ask
              // it to stop; otherwise this is a pre-launch status or the TV simply doing
              // as it was told.
              //
              // **Only when the television volunteered it** — `id === undefined || id === 0`
              // is an unsolicited broadcast, and this whole branch is now restricted to one.
              // An announcement is the set telling us something happened; an answer to a
              // question we asked is a snapshot that can be momentarily wrong, and M5a made
              // us ask **once a second** for the whole of every film. 23c has no other route
              // on any of the founder's three sets, so the poll is not removable — which
              // leaves guarding what its answers are allowed to conclude.
              //
              // Two things went wrong when one odd answer got in here, and both are the
              // founder's evening rather than a log line: a later wifi wobble stopped
              // reading as *Reconnecting* and started reading as *the television ended the
              // session* (11a promises the opposite, and the film does not come back by
              // itself); and the ids below were cleared **mid-film**, pointing every later
              // media command at a transport that no longer existed.
              //
              // Pre-M5a nothing asked for a receiver status during playback, so this branch
              // only ever saw broadcasts. This restores that, deliberately, rather than
              // trusting the poll to always be told the truth.
              if (sawOurApp && !teardownByUs) endedByDevice = true;
              // The app is gone, and so are the ids that addressed it. Keeping the
              // transport id would send a later media STOP into a dead transport and
              // burn the full request timeout waiting for an answer that cannot come.
              appSessionId = null;
              transportId = null;
              mediaSessionId = null;
            }
            const first = applications[0];
            // The answer to a question we asked quietly is returned, never announced.
            if (id === undefined || !quiet.has(id)) {
              events.onReceiverStatus({
                appId: first?.appId ?? null,
                appName: first?.displayName ?? null,
                // The same reader every other route uses. Two parsers of one payload were
                // two chances to disagree about whether an absent level is `null` or `0`,
                // which is the bug this milestone had to fix once already.
                ...volumeOf(parsed.data.status?.volume),
                receivedAtMono: clock.monoMs(),
              });
            }
          }
          if (id !== undefined) quiet.delete(id);
          if (id !== undefined && id !== 0) settle(id, payload);
          return;
        }

        if (id !== undefined && id !== 0) settle(id, payload);
      };

      transport = await makeTransport(
        { host: device.address, port: device.port, timeoutMs: CAST.connectTimeoutMs },
        {
          onMessage: handleMessage,
          onClose: (reason) => fail(reason),
        },
      );

      logger.info('cast.connected', {
        address: device.address,
        port: device.port,
        localAddress: transport.localAddress,
      });

      // Virtual connection to the platform receiver. Without this the device ignores us.
      send(NS_CONNECTION, PLATFORM_RECEIVER, {
        type: 'CONNECT',
        userAgent: 'CastGood',
        origin: {},
      });

      // Check, then count, then send — and send the first one now rather than one
      // interval from now. That makes a dead socket declared exactly
      // `pingIntervalMs × pingMissesBeforeDead` (10 s) after the last PONG, which is what
      // config.ts documents; counting before sending made it 15 s.
      const heartbeatMs = deps.heartbeatIntervalMs ?? TIMING.pingIntervalMs;
      const beat = (): void => {
        if (closed) return;
        if (missedPongs >= TIMING.pingMissesBeforeDead) {
          fail(
            `no PONG after ${String(TIMING.pingMissesBeforeDead)} pings (${String(
              heartbeatMs * TIMING.pingMissesBeforeDead,
            )} ms)`,
          );
          return;
        }
        missedPongs += 1;
        send(NS_HEARTBEAT, PLATFORM_RECEIVER, { type: 'PING' });
      };
      beat();
      heartbeat = setInterval(beat, heartbeatMs);
      heartbeat.unref?.();

      const requireMediaTarget = (): { destination: string; sessionId: number } => {
        if (transportId === null || mediaSessionId === null) {
          throw new EngineError('INTERNAL', 'no media session on this device yet');
        }
        return { destination: transportId, sessionId: mediaSessionId };
      };

      const mediaCommand = async (
        type: string,
        extra: Record<string, unknown> = {},
      ): Promise<void> => {
        const target = requireMediaTarget();
        await request(
          NS_MEDIA,
          target.destination,
          { type, mediaSessionId: target.sessionId, ...extra },
          CAST.requestTimeoutMs,
        );
      };

      return {
        localAddress: transport.localAddress,

        async launchDefaultReceiver(timeoutMs?: number): Promise<void> {
          const status = await request(
            NS_RECEIVER,
            PLATFORM_RECEIVER,
            { type: 'LAUNCH', appId: CAST.defaultReceiverAppId },
            timeoutMs ?? CAST.launchTimeoutMs,
          );
          const parsed = receiverStatusSchema.safeParse(status);
          const applications = parsed.success ? (parsed.data.status?.applications ?? []) : [];
          const ours = applications.find((app) => app.appId === CAST.defaultReceiverAppId);
          if (ours !== undefined) sawOurApp = true;
          if (ours === undefined || ours.transportId === undefined) {
            throw new EngineError(
              'DEVICE_UNREACHABLE',
              'device did not launch the default receiver',
              {
                userMessage: `Couldn't reach ${device.friendlyName}`,
                context: { applications },
              },
            );
          }
          appSessionId = ours.sessionId ?? null;
          transportId = ours.transportId;
          // A second virtual connection, this time to the app itself.
          send(NS_CONNECTION, transportId, { type: 'CONNECT', userAgent: 'CastGood', origin: {} });
          logger.info('cast.receiver_launched', { transportId, sessionId: appSessionId });
        },

        async load(load: LoadRequest, timeoutMs?: number): Promise<MediaStatus> {
          if (transportId === null) {
            throw new EngineError('INTERNAL', 'launchDefaultReceiver() must run before load()');
          }
          lastDurationSec = null;
          const response = (await request(
            NS_MEDIA,
            transportId,
            {
              type: 'LOAD',
              ...(appSessionId === null ? {} : { sessionId: appSessionId }),
              media: {
                contentId: load.contentUrl,
                contentType: load.contentType,
                streamType: load.streamType,
                metadata: {
                  metadataType: 0,
                  title: load.title ?? '',
                },
                // **Spread, so absent means absent** — no key, not an empty array, and the
                // key order of everything above is untouched when there is no track. 19a
                // is a promise about bytes and this is the line that keeps it.
                ...(load.tracks === undefined ? {} : { tracks: load.tracks }),
              },
              autoplay: load.autoplay,
              currentTime: load.startPositionSec,
              ...(load.activeTrackIds === undefined ? {} : { activeTrackIds: load.activeTrackIds }),
            },
            timeoutMs ?? CAST.loadTimeoutMs,
          )) as { type?: string; status?: MediaStatus | null } | undefined;

          const status = response?.status ?? null;
          if (status === null || response?.type !== 'MEDIA_STATUS') {
            throw new EngineError('LOAD_REJECTED', 'the device refused to play this file', {
              userMessage: "Couldn't play this file",
              context: { responseType: response?.type ?? null },
            });
          }
          mediaSessionId = status.mediaSessionId;
          logger.info('cast.loaded', {
            mediaSessionId,
            playerState: status.playerState,
            // Zero on every load before a founder turns subtitles on, which is what makes
            // the JSONL log readable as evidence for 19a on the founder's own machine.
            declaredTracks: load.tracks?.length ?? 0,
          });
          return status;
        },

        play: () => mediaCommand('PLAY'),
        pause: () => mediaCommand('PAUSE'),
        seek: (positionSec: number) => mediaCommand('SEEK', { currentTime: positionSec }),
        setActiveTracks: (trackIds: readonly number[]) =>
          mediaCommand('EDIT_TRACKS_INFO', { activeTrackIds: [...trackIds] }),

        async stop(): Promise<void> {
          // From here on the teardown is ours. The device's compliant "nothing is running"
          // must not read as the founder having stopped it from the TV.
          teardownByUs = true;
          // Two steps, and the second is the one the founder sees: STOP on the media
          // session ends playback, STOP on the receiver puts the TV back on its own
          // home screen and releases it for anything else in the house.
          if (transportId !== null && mediaSessionId !== null) {
            await mediaCommand('STOP').catch((error: unknown) => {
              logger.warn('cast.media_stop_failed', { error });
            });
          }
          if (appSessionId !== null) {
            await request(
              NS_RECEIVER,
              PLATFORM_RECEIVER,
              { type: 'STOP', sessionId: appSessionId },
              CAST.requestTimeoutMs,
            ).catch((error: unknown) => {
              logger.warn('cast.receiver_stop_failed', { error });
            });
          }
          mediaSessionId = null;
          appSessionId = null;
          transportId = null;
        },

        async getStatus(): Promise<MediaStatus | null> {
          if (transportId === null) return null;
          const response = (await request(
            NS_MEDIA,
            transportId,
            {
              type: 'GET_STATUS',
              ...(mediaSessionId === null ? {} : { mediaSessionId }),
            },
            CAST.requestTimeoutMs,
          )) as { status?: MediaStatus | null } | undefined;
          return response?.status ?? null;
        },

        async getReceiverStatus(): Promise<ReceiverStatus> {
          const response = await request(
            NS_RECEIVER,
            PLATFORM_RECEIVER,
            { type: 'GET_STATUS' },
            CAST.requestTimeoutMs,
          );
          return toReceiverStatus(response);
        },

        async setVolume(change: VolumeChange, timeoutMs?: number): Promise<ReceiverStatus> {
          const response = await request(
            NS_RECEIVER,
            PLATFORM_RECEIVER,
            { type: 'SET_VOLUME', volume: { ...change } },
            timeoutMs ?? CAST.requestTimeoutMs,
          );
          return toReceiverStatus(response);
        },

        async rejoin(): Promise<RejoinResult> {
          // Quiet, because the caller is about to act on the answer itself. See `quiet`.
          const response = await request(
            NS_RECEIVER,
            PLATFORM_RECEIVER,
            { type: 'GET_STATUS' },
            CAST.rejoinTimeoutMs,
            { quiet: true },
          );
          const parsed = receiverStatusSchema.safeParse(response);
          const applications = parsed.success ? (parsed.data.status?.applications ?? []) : [];
          const ours = applications.find((app) => app.appId === CAST.defaultReceiverAppId);
          const first = applications[0];
          // Idle rather than taken: Backdrop, ambient, a screensaver. Reported as "nothing
          // is running" so nobody is offered a *Take it back* from a slideshow. The id and
          // the name are still logged either way.
          const takenBy = isTakeoverApp(first?.appId ?? null, first?.displayName ?? null)
            ? (first?.appId ?? null)
            : null;

          if (ours === undefined || ours.transportId === undefined) {
            // Either the television is on its home screen or something else has it. Either
            // way we send it **nothing** — no LAUNCH, no media command, not even a
            // GET_STATUS on a media session that SPIKE-2 watched refuse to answer for the
            // full 5 s request timeout after a takeover. 14b is a performance requirement
            // as much as a courtesy.
            logger.info('cast.rejoin_found_other', {
              appId: first?.appId ?? null,
              appName: first?.displayName ?? null,
              idleScreen: takenBy === null,
            });
            return {
              appId: takenBy,
              appName: takenBy === null ? null : (first?.displayName ?? null),
              ours: false,
              media: null,
            };
          }

          sawOurApp = true;
          appSessionId = ours.sessionId ?? null;
          transportId = ours.transportId;
          // The virtual connection to the app. Without it the device ignores every media
          // message we send, including the GET_STATUS on the next line.
          send(NS_CONNECTION, transportId, { type: 'CONNECT', userAgent: 'CastGood', origin: {} });

          let media: MediaStatus | null = null;
          try {
            const status = (await request(
              NS_MEDIA,
              transportId,
              { type: 'GET_STATUS' },
              CAST.rejoinTimeoutMs,
            )) as { status?: MediaStatus | null } | undefined;
            media = status?.status ?? null;
          } catch (error) {
            // Our app is running but its media session is not answering — a receiver that
            // has been re-launched under us, or one that is between items. Reported as
            // "ours, nothing playing" rather than thrown: the caller decides.
            logger.warn('cast.rejoin_media_silent', { error });
          }
          if (media !== null) mediaSessionId = media.mediaSessionId;
          logger.info('cast.rejoined', {
            transportId,
            sessionId: appSessionId,
            mediaSessionId,
            playerState: media?.playerState ?? null,
            contentId: media?.contentId ?? null,
          });
          return {
            appId: ours.appId ?? CAST.defaultReceiverAppId,
            appName: ours.displayName ?? null,
            ours: true,
            media,
          };
        },

        async close(options = {}): Promise<void> {
          if (closed) return;
          teardownByUs = true;
          if (transportId !== null) send(NS_CONNECTION, transportId, { type: 'CLOSE' });
          send(NS_CONNECTION, PLATFORM_RECEIVER, { type: 'CLOSE' });
          fail('closed by engine', false, options.announce !== false);
          await Promise.resolve();
        },
      };
    },
  };
}

export type { CastTransport, TransportFactory } from './castv2/client.js';
export { tcpTransportFactory, tlsTransportFactory } from './castv2/client.js';
