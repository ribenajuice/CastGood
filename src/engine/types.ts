/**
 * Domain types shared across the engine.
 *
 * These are the vocabulary of the whole product: what a device is, what a session
 * is doing, what a file needs before it can be cast. Behaviour lands in later
 * milestones; the shapes are what the modules agree on now.
 */

/** Stable device identity — the mDNS TXT `id=` field, not the address. */
export type DeviceId = string;

/** Identifies a capability profile, and is part of an artifact's cache key. */
export type ProfileId = string;

/** Opaque per-session token that appears in every media URL we hand a device. */
export type SessionToken = string;

export interface Device {
  readonly id: DeviceId;
  /** mDNS TXT `fn=` — the name the founder gave the TV. */
  readonly friendlyName: string;
  /** mDNS TXT `md=` — model string, e.g. "Chromecast Ultra". Unknown models get the baseline profile. */
  readonly model: string;
  /** IPv4 literal from the A record. Never a `.local` name: receivers fail to resolve those. */
  readonly address: string;
  /** SRV port, always 8009 in practice. */
  readonly port: number;
  readonly lastSeenAt: number;
}

// --- Capability model -------------------------------------------------------

export type VideoCodec = 'h264' | 'hevc' | 'vp8' | 'vp9' | 'av1';
export type AudioCodec = 'aac' | 'mp3' | 'opus' | 'vorbis' | 'flac' | 'ac3' | 'eac3';
export type Container = 'mp4' | 'webm' | 'mkv' | 'hls';

export interface VideoCapability {
  readonly codec: VideoCodec;
  /** H.264 profile name as ffprobe reports it, e.g. "High". Undefined = any. */
  readonly maxProfile?: string;
  /** Level × 10, as ffprobe reports it: 41 = L4.1. */
  readonly maxLevel?: number;
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly maxFramerate: number;
}

export interface DeviceProfile {
  readonly id: ProfileId;
  readonly video: readonly VideoCapability[];
  readonly audio: readonly AudioCodec[];
  readonly containers: readonly Container[];
  /**
   * How many audio channels this television can actually decode — **defect D1's whole fix**.
   *
   * `audio` above is a list of codec *names*, which described a stereo-only receiver and a
   * 5.1-capable one identically for the whole of M3a. On 2026-08-24 that cost a film: a
   * plain Chromecast was sent 6-channel AAC, played one frame, and gave up. The sound the
   * device cannot decode is a property of the *stream*, not of the codec, and `ffprobe` has
   * captured `channels` since M1.
   *
   * **Required, and deliberately so.** An optional field with a `?? 2` at the call site is
   * the same defect wearing a different hat: it puts the answer somewhere other than the
   * profile, where the next profile added can quietly miss it. A device whose limit nobody
   * has decided must not be constructible (criterion 7j).
   *
   * One number per profile rather than one per codec: no device anyone has met decodes 5.1
   * in one format and stereo in another, and the table would double for a case that does
   * not exist. Read in exactly one place — `audioSupported()` in `prepare/classify.ts` —
   * because two places that decide the same thing are two places that drift apart.
   */
  readonly maxAudioChannels: number;
}

// --- Media / preparation ----------------------------------------------------

export type Tier = 1 | 2 | 3;

export interface SourceFile {
  readonly path: string;
  readonly sizeBytes: number;
  readonly mtimeMs: number;
}

export type ArtifactKind = 'source' | 'mp4' | 'hls';
export type ArtifactStatus = 'complete' | 'growing' | 'failed';

export interface Artifact {
  /** sha256(sourcePath + size + mtime + profileId) — a changed source yields a different key. */
  readonly key: string;
  readonly source: SourceFile;
  readonly profileId: ProfileId;
  readonly tier: Tier;
  readonly kind: ArtifactKind;
  /** Absolute path to the file (mp4) or directory (hls). For `source`, the source path. */
  readonly path: string;
  readonly durationSec: number;
  readonly status: ArtifactStatus;
  readonly bytes: number;
  readonly createdAt: number;
}

// --- Playback ---------------------------------------------------------------

/**
 * The session state machine, mirroring the PRD's state tables 1:1 so QA can map
 * a screen to a state without interpretation.
 */
export type SessionState =
  | 'idle'
  | 'connecting'
  | 'loading'
  | 'buffering'
  | 'playing'
  | 'paused'
  | 'seeking'
  | 'ended'
  | 'stopped';

/**
 * Orthogonal conditions that can overlay any state above.
 *
 * They are flags rather than states on purpose: a film that is *Playing* and whose
 * connection has just died is still a film at 0:32:10 with a scrubber and a file name.
 * Criterion 11a says so in as many words — "the file, position and scrubber all stay
 * exactly where they were; only the status line changes" — and a separate `Reconnecting`
 * state would have thrown all of that away and rebuilt it.
 */
export interface SessionFlags {
  readonly reconnecting: boolean;
  /**
   * The app was reopened onto a session still running on the television, and is adopting
   * it (story 12). Distinct from `reconnecting` because the founder is told a different
   * thing: "Picking up where you left off" is not "something went wrong".
   */
  readonly reattaching: boolean;
  /** Another app or person took the device. We yield; we never fight for it. */
  readonly yielded: boolean;
  readonly networkDown: boolean;
}

export interface PlaybackPosition {
  /** Seconds into the media, as last reported by the device. */
  readonly reportedSec: number;
  /** Monotonic timestamp of that report — extrapolation anchors on this, never on wall clock. */
  readonly reportedAtMono: number;
  readonly durationSec: number;
  /**
   * Seconds of media prepared so far, for a still-converting Tier 3 artifact.
   * `undefined` means the whole file is available.
   */
  readonly frontierSec?: number;
}
