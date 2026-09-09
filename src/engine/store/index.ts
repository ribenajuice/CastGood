import fsp from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import type { DeviceId, SessionToken } from '../types.js';
import type { CapabilityDowngrade } from '../prepare/device-profiles.js';
import type { Logger } from '../logging/index.js';
import type { AppPaths } from '../paths.js';

/**
 * The settings store: **one** small JSON document under `%LOCALAPPDATA%\CastGood`,
 * written atomically (temp file + rename) and carrying a `schemaVersion`.
 *
 * No SQLite, no native modules — that would drag node-gyp/electron-rebuild into the
 * WSL↔Windows split for a few hundred bytes.
 *
 * ## Why this exists at all, and why it holds so little
 *
 * `docs/ARCHITECTURE.md` says sessions are not persisted, because "reattach re-derives
 * everything from the device's own status, which is more trustworthy than our memory of
 * it". The first half of that is still true and the second half is still how the position,
 * the player state and the media session id are recovered. What it missed is the **URL**:
 * when CastGood closes, the media server closes with it, and the television is left
 * fetching an address that has stopped answering. SPIKE-2 (2026-08-17) confirmed the
 * consequence directly — a second process rejoined a running session in 86 ms, and it only
 * worked because it re-published the *identical* URL: same port, same token. Both were
 * random per run, so nothing could have republished them.
 *
 * So this file holds exactly what story 12 cannot work without and **nothing else**:
 *
 *  - the media server port, so the URL can be rebuilt;
 *  - the session token, for the same reason;
 *  - and enough to know *which* session it was — device, file, media session id and the
 *    last position we saw — so a reattach can be told apart from a television that has
 *    moved on to something else entirely (12b).
 *
 * M3a adds the two things the founder's 2026-08-15 ruling put here, and no more:
 *
 *  - **The last-used device** (9f), so the app opens with a television already selected.
 *  - **What a television has been observed to refuse** (7e), which the capability model
 *    calls layer 3 and requires to be *permanent* — a device that could not play a file we
 *    called *Ready to cast* must never be told the same thing again, including tomorrow.
 *
 * **Prepared-file memory is deliberately still not here**, and that is not an omission. The
 * 2026-08-19 sibling ADR makes the prepared file its own record: it is discovered by name
 * beside the source and believed only after `ffprobe` and the classifier agree about it, so
 * story 9 survives a reinstall, a moved film, and this file being deleted. The ADR allows an
 * `artifacts.json` **cache** to skip the two probes; it is not built, because it buys
 * milliseconds against a 500 ms budget one local probe already meets, and a cache that can
 * disagree with the disk is a second source of truth for the exact question the 2026-08-20
 * ADR just finished making single-sourced.
 *
 * A corrupt file is a recoverable condition, not a crash: log it, move it aside next to
 * itself so it can still be looked at, and start from defaults.
 */

/**
 * Bumped to 2 by M3a, which added `lastDeviceId` and `devices`.
 *
 * Both are additions, so a version-1 file is a perfectly good version-2 file with two
 * fields missing — and `migrate` says exactly that rather than the file being discarded.
 * Throwing away a v1 file would cost the founder a live reattach across the upgrade (12a):
 * they would close CastGood mid-film on one build and reopen on the next to a television
 * still playing and an app that had forgotten about it.
 *
 * **Bumped to 3 by M3c step 5**, which added `subtitleOffsets` (20f) and one optional field
 * inside `session` (18h). Both are additions again, and the same reasoning holds twice over:
 * a version-2 file read by this build is a version-3 file with no remembered corrections in
 * it, which is exactly what a founder who has never nudged anything has.
 */
export const SCHEMA_VERSION = 3;

/**
 * The one thing worth remembering between runs: a session that was live when we went away.
 *
 * Cleared the moment a session ends for any reason, so reopening after a clean stop is
 * *Idle* with no reattach screen at all (12b). "Recovery that isn't needed is silent."
 */
/**
 * **The subtitle that was on the television when the app closed** — 18h, story 12's half.
 *
 * *"When the session is interrupted and recovered — a reattach after reopening the app —
 * then the subtitles come back with the film, from the same source, still in time, and with
 * any timing correction still applied."* A reattach never issues a LOAD (12a), so the ladder
 * the television is holding is the one the **previous** run declared: the words themselves
 * are the founder's choice re-read from disk, and the token is what makes the thirteen URLs
 * that ladder names answer again — the same argument, and the same fix, as the film's URL.
 *
 * It carries no cues. A cue list is a few thousand lines of the founder's own film and has
 * no business in a settings file; it is re-derived from `sourceId` in well under a second,
 * exactly as the prepared-artifact rule re-derives rather than remembers.
 */
export interface SessionSubtitleRecord {
  /** The source's own id — `embedded:3`, `sidecar:<path>`, `picked:<path>` (18a's list). */
  readonly sourceId: string;
  /** What the founder reads, and what the television's own track menu was given. */
  readonly label: string;
  /** The language code the film named, or `''`. */
  readonly language: string;
  /** The rung that was showing, in integer milliseconds. `0` is *in sync*. */
  readonly offsetMs: number;
  /** The mount token in all thirteen declared track URLs. Republished, never regenerated. */
  readonly token: string;
}

export interface SessionRecord {
  readonly deviceId: DeviceId;
  /** The source on disk. Re-mounted under the same token so the old URL answers again. */
  readonly filePath: string;
  readonly fileName: string;
  /** The unguessable path segment in the URL the television is still fetching. */
  readonly token: SessionToken;
  /** The port that URL names. A different one 404s every request the TV makes. */
  readonly mediaPort: number;
  /** What the device called the media session, when we knew. Confirmation, not identity. */
  readonly mediaSessionId: number | null;
  /** Where we last saw the playhead. The device's own answer wins on reattach. */
  readonly positionSec: number;
  /** Wall clock, for the log — never for arithmetic; the monotonic clock died with us. */
  readonly savedAtWall: number;
  /**
   * 18h: the subtitle that was on when we went away, or `null` — which is every session
   * until somebody turns subtitles on, and every session after they turn them off again.
   */
  readonly subtitle?: SessionSubtitleRecord | null;
}

/**
 * **One remembered timing correction** — criterion 20f, and the only *data* in this file.
 *
 * Everything else here is a cache of something that can be looked up again: a port can be
 * rebound, a device rediscovered, a refusal re-observed. An offset cannot. The 2026-08-19
 * ADR says so plainly — *"an offset cannot be re-derived from the file the way a prepared
 * artifact can be re-probed"* — which is why losing this file costs the founder a re-nudge,
 * and why the applied correction has to be **stated on screen** rather than applied
 * silently. It is the one thing CastGood knows that nothing else could tell it.
 */
export interface SubtitleOffsetRecord {
  /** Integer milliseconds, always inside 20e's ±30 s. `0` is never stored — see below. */
  readonly offsetMs: number;
  /** The cue list this was set against; a correction for other words is not applied. */
  readonly fingerprint: string;
  /** Wall clock, for the log and for deciding which corrections to drop when trimming. */
  readonly savedAtWall: number;
}

/**
 * How many corrections are kept. Past it, the least recently set are dropped.
 *
 * Not a memory concern — a few hundred bytes each — but a settings file has to stay a
 * settings file. A founder who watches a subtitled film every night for four years is the
 * one this bound is for, and the loss when it fires is the oldest re-nudge in the house.
 */
export const MAX_REMEMBERED_OFFSETS = 500;

/**
 * What we have learned about one television by watching it (7e), keyed by device id.
 *
 * `downgrades` is append-only and **permanent**: narrowing is monotone, the capability ADR
 * requires the fact to outlive the session, and a device that "recovers" between runs would
 * put the founder back in front of the failure the safety net exists to remove.
 */
export interface DeviceRecord {
  readonly friendlyName: string;
  readonly model: string;
  readonly downgrades: readonly CapabilityDowngrade[];
}

export interface Settings {
  readonly schemaVersion: number;
  /** The port the media server actually bound last time. `null` before the first run. */
  readonly mediaPort: number | null;
  readonly session: SessionRecord | null;
  /**
   * 9f: the television the founder last cast to, preselected on the next launch.
   *
   * An id, not a name — names change when somebody renames a TV, and the id is what mDNS
   * will hand us again. A remembered device that is not on the network is simply not
   * selected; nothing is said about it, because a television that is off is not a problem.
   */
  readonly lastDeviceId: DeviceId | null;
  readonly devices: Readonly<Record<string, DeviceRecord>>;
  /**
   * 20f: what the founder has corrected, keyed by **subtitle source** — see
   * `src/engine/subtitles/offsets.ts`, which is the only thing that decides what a key is.
   *
   * It does not weaken the 2026-08-19 ruling that subtitles never come on by themselves.
   * Nothing in here is ever read while deciding *whether* a film has subtitles: it is read
   * only after the founder has deliberately chosen a source, which is why an entry can
   * change a number on the screen and can never put words on a television.
   */
  readonly subtitleOffsets: Readonly<Record<string, SubtitleOffsetRecord>>;
}

export const DEFAULT_SETTINGS: Settings = {
  schemaVersion: SCHEMA_VERSION,
  mediaPort: null,
  session: null,
  lastDeviceId: null,
  devices: {},
  subtitleOffsets: {},
};

/**
 * A file on disk is not trusted input either.
 *
 * It can be hand-edited, half-written by a power cut, or left behind by a future version.
 * Anything that does not parse is treated as absent rather than believed.
 */
/**
 * The token regex is the film's, deliberately: both are `crypto.randomBytes` hex from the
 * same media server, and a token that is not one could only ever name a mount we did not
 * make. Everything else is bounded to what the thing it describes can actually be — the
 * stream index inside `sourceId` is re-checked by `subtitleOriginFromId` before it can
 * reach ffmpeg, because a bound on length is not a bound on meaning.
 */
const sessionSubtitleSchema = z.object({
  sourceId: z.string().min(3).max(4096),
  label: z.string().min(1).max(1024),
  language: z.string().max(64),
  offsetMs: z.number().int().min(-60_000).max(60_000),
  token: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-f0-9]+$/i),
});

const subtitleOffsetSchema = z.object({
  // Bounded well outside 20e's ±30 s rather than exactly at it: a file written by a build
  // with a wider clamp is still readable, and `clampOffsetMs` — the one function that
  // decides what an offset may be — narrows it on the way to the screen and to the cues.
  offsetMs: z.number().int().min(-60_000).max(60_000),
  fingerprint: z.string().max(128),
  savedAtWall: z.number().finite().min(0),
});

const sessionRecordSchema = z.object({
  deviceId: z.string().min(1).max(256),
  filePath: z.string().min(1).max(4096),
  fileName: z.string().min(1).max(1024),
  token: z
    .string()
    .min(8)
    .max(128)
    .regex(/^[a-f0-9]+$/i),
  mediaPort: z.number().int().min(1).max(65_535),
  mediaSessionId: z.number().int().nullable(),
  positionSec: z.number().finite().min(0),
  savedAtWall: z.number().finite().min(0),
  // Absent in every file written before M3c step 5, and absent in every session where the
  // founder never turned subtitles on — which is most of them.
  subtitle: sessionSubtitleSchema.nullable().default(null),
});

/**
 * A narrowing step, parsed rather than trusted.
 *
 * This is the one part of the file that changes what CastGood *does* with a television, so
 * a hand-edited or half-written entry must not be able to widen a profile or invent a codec
 * name. The union mirrors `NarrowingStep` exactly; anything else is dropped with the file.
 */
const narrowingStepSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('drop-container'), container: z.enum(['mp4', 'webm', 'mkv', 'hls']) }),
  z.object({
    kind: z.literal('drop-video-codec'),
    codec: z.enum(['h264', 'hevc', 'vp8', 'vp9', 'av1']),
  }),
  z.object({
    kind: z.literal('drop-audio-codec'),
    codec: z.enum(['aac', 'mp3', 'ac3', 'eac3', 'opus', 'vorbis', 'flac']),
  }),
  z.object({
    kind: z.literal('cap-audio-channels'),
    // Bounded above by the widest layout ffmpeg will name and below by stereo, which is the
    // floor the ladder rests at. A hand-edited `1` would make every film unplayable on that
    // television and there is no receiver it would be true of.
    maxChannels: z.number().int().min(2).max(8),
  }),
  z.object({
    kind: z.literal('cap-resolution'),
    maxWidth: z.number().int().positive(),
    maxHeight: z.number().int().positive(),
  }),
  z.object({ kind: z.literal('cap-framerate'), maxFramerate: z.number().positive() }),
  z.object({
    kind: z.literal('cap-level'),
    codec: z.enum(['h264', 'hevc', 'vp8', 'vp9', 'av1']),
    maxLevel: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal('cap-profile'),
    codec: z.enum(['h264', 'hevc', 'vp8', 'vp9', 'av1']),
    maxProfile: z.string().min(1).max(64),
  }),
]);

const refusedSignatureSchema = z.object({
  container: z.enum(['mp4', 'webm', 'mkv', 'hls', 'other']),
  videoCodec: z.string().max(64).nullable(),
  videoProfile: z.string().max(64).nullable(),
  videoLevel: z.number().finite().nullable(),
  width: z.number().finite().nullable(),
  height: z.number().finite().nullable(),
  frameRate: z.number().finite().nullable(),
  audioCodecs: z.array(z.string().max(64)).max(32),
});

const deviceRecordSchema = z.object({
  friendlyName: z.string().max(256),
  model: z.string().max(256),
  downgrades: z
    .array(
      z.object({
        at: z.number().finite().min(0),
        // Evidence for the log, never rendered — but it is still parsed to its real shape
        // rather than waved through as a bag of unknowns, because a `Record<string,
        // unknown>` here is a `RefusedSignature` everywhere it is read.
        signature: refusedSignatureSchema,
        steps: z.array(narrowingStepSchema).max(32),
      }),
    )
    .max(32),
});

const settingsSchema = z.object({
  schemaVersion: z.number().int().min(1),
  mediaPort: z.number().int().min(1).max(65_535).nullable(),
  session: sessionRecordSchema.nullable(),
  // Absent in a version-1 file, which is the whole reason these have defaults rather than
  // making the parse fail: see `SCHEMA_VERSION`.
  lastDeviceId: z.string().min(1).max(256).nullable().default(null),
  devices: z.record(z.string(), deviceRecordSchema).default({}),
  // Absent in a version-2 file, which is a version-3 file belonging to a founder who has
  // never nudged anything. The count is bounded after the parse rather than in it — see
  // `trimOffsets` — because a file with 10,000 entries is a file to trim, not to throw away.
  subtitleOffsets: z.record(z.string().max(4_200), subtitleOffsetSchema).default({}),
});

export interface Store {
  /** Reads the file. Never throws: an unreadable or unparseable file yields defaults. */
  load(): Promise<void>;
  readonly settings: Settings;
  setMediaPort(port: number): Promise<void>;
  rememberSession(record: SessionRecord): Promise<void>;
  forgetSession(): Promise<void>;
  /** 9f. Written when the founder picks a television, not when one is merely discovered. */
  rememberDevice(deviceId: DeviceId, friendlyName: string, model: string): Promise<void>;
  /**
   * 7e: this television refused a file. Permanent, and append-only.
   *
   * Returns the downgrades now on record for it, so the caller can re-plan immediately
   * rather than reading them back out of a write that has not landed yet.
   */
  recordDowngrade(
    deviceId: DeviceId,
    downgrade: CapabilityDowngrade,
  ): Promise<readonly CapabilityDowngrade[]>;
  /** What we have been told this device cannot do. Empty for one we have never seen fail. */
  downgradesFor(deviceId: DeviceId): readonly CapabilityDowngrade[];
  /**
   * 20f: this subtitle source is out by this much, and the founder said so.
   *
   * **An offset of `0` forgets rather than stores it**, and that is the product rule rather
   * than tidiness: *Reset* is the founder saying *"these words are in time"*, so next week
   * that file must arrive at *in sync* with nothing said about it. A stored zero would be
   * indistinguishable from a correction of nothing.
   */
  rememberSubtitleOffset(key: string, record: SubtitleOffsetRecord): Promise<void>;
  /** What was set for this source, or `null` for one nobody has ever corrected. */
  subtitleOffsetFor(key: string): SubtitleOffsetRecord | null;
  /**
   * Resolves once every write asked for so far has landed.
   *
   * Shutdown awaits it. Without that, a fire-and-forget write can still be renaming a temp
   * file after the process believes it has finished — which in tests showed up as a data
   * directory that refused to delete, and in the app would be the reattach record for the
   * session that just ended arriving *after* the one that ended it.
   */
  flush(): Promise<void>;
}

export interface StoreDeps {
  logger: Logger;
  paths: AppPaths;
}

/**
 * Hold the remembered corrections to `MAX_REMEMBERED_OFFSETS`, newest kept.
 *
 * Applied on the way *in* (a file that arrived over-full is trimmed as it is read) and on
 * the way *out* (a write that would exceed the bound drops the oldest), so the bound is a
 * property of the store rather than of the caller that happened to remember it.
 */
function trimOffsets(
  offsets: Readonly<Record<string, SubtitleOffsetRecord>>,
): Record<string, SubtitleOffsetRecord> {
  const entries = Object.entries(offsets);
  if (entries.length <= MAX_REMEMBERED_OFFSETS) return Object.fromEntries(entries);
  entries.sort((a, b) => b[1].savedAtWall - a[1].savedAtWall);
  return Object.fromEntries(entries.slice(0, MAX_REMEMBERED_OFFSETS));
}

export function createStore(deps: StoreDeps): Store {
  const logger = deps.logger.child({ component: 'store' });
  const file = deps.paths.settingsFile;
  let settings: Settings = DEFAULT_SETTINGS;
  /**
   * What the *last write asked for*, which is not the same as what is in effect.
   *
   * Writes are queued and applied when their turn comes, so for a few milliseconds after
   * `rememberSession()` the in-memory `settings` still say there is no session. Every
   * decision about what to write next has to be taken against this rather than against
   * `settings`, and two of them were not:
   *
   *  - `forgetSession()` short-circuited on "there is no session anyway" and did nothing,
   *    so a stop that landed while the remember was still queued left **the record for the
   *    session that had just ended sitting on disk**. The next launch then tried to pick
   *    up a film the founder had deliberately stopped. That is the precise hazard
   *    `flush()` was written for, defeated by the guard above it.
   *  - `rememberSession()` and `setMediaPort()` each spread `...settings`, so whichever
   *    was queued second silently threw away the other's change.
   */
  let queued: Settings = settings;
  /** Writes are serialised: two of these racing would interleave a temp file rename. */
  let queue: Promise<void> = Promise.resolve();

  async function writeNow(next: Settings): Promise<void> {
    settings = next;
    const temporary = `${file}.${String(process.pid)}.tmp`;
    try {
      await fsp.mkdir(path.dirname(file), { recursive: true });
      await fsp.writeFile(temporary, JSON.stringify(next, null, 2) + '\n', 'utf8');
      // Atomic on the same filesystem: a reader sees the old file or the new one, never
      // half of either. A crash mid-write leaves a stray `.tmp`, which nothing reads.
      await fsp.rename(temporary, file);
    } catch (error) {
      // Losing a setting must never take the session with it: the in-memory value stands,
      // and the only cost is that this run's reattach information does not survive a
      // restart. That is worth a warning, not an exception in the middle of playback.
      logger.warn('store.write_failed', { error, file });
      await fsp.rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  function write(next: Settings): Promise<void> {
    queued = next;
    queue = queue.then(() => writeNow(next));
    return queue;
  }

  /** A file we cannot make sense of is moved aside, not deleted: it is still evidence. */
  async function quarantine(reason: string): Promise<void> {
    const aside = `${file}.corrupt`;
    logger.warn('store.corrupt', { reason, file, movedTo: aside });
    await fsp.rename(file, aside).catch(() => undefined);
    settings = DEFAULT_SETTINGS;
    queued = settings;
  }

  return {
    async load() {
      let raw: string;
      try {
        raw = await fsp.readFile(file, 'utf8');
      } catch {
        // No file yet is the ordinary first-run case, not a problem to report.
        settings = DEFAULT_SETTINGS;
        queued = settings;
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(raw) as unknown;
      } catch {
        await quarantine('unparseable');
        return;
      }

      const result = settingsSchema.safeParse(parsed);
      if (!result.success) {
        await quarantine('unrecognised shape');
        return;
      }
      if (result.data.schemaVersion > SCHEMA_VERSION) {
        // A file written by a **newer** CastGood. Its fields may mean something we do not
        // know, so nothing in it is worth guessing at, and the cost of starting fresh is
        // one lost reattach. An *older* file is not this case: every version so far has
        // only added optional fields, so it parses above with defaults and is migrated
        // forward on the next write rather than thrown away.
        logger.info('store.schema_from_the_future', {
          found: result.data.schemaVersion,
          expected: SCHEMA_VERSION,
        });
        settings = DEFAULT_SETTINGS;
        queued = settings;
        return;
      }
      settings = {
        ...result.data,
        schemaVersion: SCHEMA_VERSION,
        subtitleOffsets: trimOffsets(result.data.subtitleOffsets),
      } as Settings;
      queued = settings;
      logger.info('store.loaded', {
        mediaPort: settings.mediaPort,
        hasSession: settings.session !== null,
        // 18h: whether the session we are about to try to rejoin had words on it.
        sessionHadSubtitles: (settings.session?.subtitle ?? null) !== null,
        lastDeviceId: settings.lastDeviceId,
        knownDevices: Object.keys(settings.devices).length,
        // 20f. A count, never a key: a key contains one of the founder's own file paths.
        rememberedSubtitleOffsets: Object.keys(settings.subtitleOffsets).length,
        migratedFrom:
          result.data.schemaVersion === SCHEMA_VERSION ? null : result.data.schemaVersion,
      });
    },

    get settings() {
      return settings;
    },

    setMediaPort(port) {
      if (queued.mediaPort === port) return Promise.resolve();
      return write({ ...queued, mediaPort: port });
    },

    rememberSession(record) {
      return write({ ...queued, session: record });
    },

    forgetSession() {
      if (queued.session === null) return Promise.resolve();
      return write({ ...queued, session: null });
    },

    rememberDevice(deviceId, friendlyName, model) {
      const existing = queued.devices[deviceId];
      if (queued.lastDeviceId === deviceId && existing?.friendlyName === friendlyName) {
        return Promise.resolve();
      }
      return write({
        ...queued,
        lastDeviceId: deviceId,
        devices: {
          ...queued.devices,
          // The downgrades survive a rename: they are a fact about the hardware, and the
          // founder calling the television something else changes nothing about it.
          [deviceId]: { friendlyName, model, downgrades: existing?.downgrades ?? [] },
        },
      });
    },

    async recordDowngrade(deviceId, downgrade) {
      const existing = queued.devices[deviceId];
      const downgrades = [...(existing?.downgrades ?? []), downgrade];
      await write({
        ...queued,
        devices: {
          ...queued.devices,
          [deviceId]: {
            friendlyName: existing?.friendlyName ?? '',
            model: existing?.model ?? '',
            downgrades,
          },
        },
      });
      return downgrades;
    },

    rememberSubtitleOffset(key, record) {
      const existing = queued.subtitleOffsets[key];
      if (record.offsetMs === 0) {
        // *Reset*, or a nudge back to the middle. Both mean the same thing about the file.
        if (existing === undefined) return Promise.resolve();
        const { [key]: _removed, ...rest } = queued.subtitleOffsets;
        logger.info('store.subtitle_offset_forgotten', { was: existing.offsetMs });
        return write({ ...queued, subtitleOffsets: rest });
      }
      if (existing?.offsetMs === record.offsetMs && existing.fingerprint === record.fingerprint) {
        return Promise.resolve();
      }
      return write({
        ...queued,
        subtitleOffsets: trimOffsets({ ...queued.subtitleOffsets, [key]: record }),
      });
    },

    subtitleOffsetFor(key) {
      // Read from `queued` for the same reason `downgradesFor` does: a correction the
      // founder set half a second ago must be the one that answers, whether or not the
      // write behind it has landed. Choosing the same source twice in one evening is not
      // an exotic case — it is what turning subtitles off and on again does.
      return queued.subtitleOffsets[key] ?? null;
    },

    downgradesFor(deviceId) {
      // Read from `queued` rather than `settings`: a refusal that has just been recorded
      // must narrow the very next plan, and the write behind it may still be in flight.
      // Reading the landed value here is the same defect `forgetSession` was fixed for.
      return queued.devices[deviceId]?.downgrades ?? [];
    },

    flush() {
      return queue;
    },
  };
}
