import type { StateSnapshot } from '../../engine/protocol/index.js';

/**
 * What the UI knows before the first snapshot arrives: nothing, and it says so.
 *
 * The engine exports an identical `EMPTY_SNAPSHOT`, but importing it here would pull
 * engine *runtime* code into the renderer bundle (the protocol module also exports zod
 * schemas). The renderer imports the protocol as **types only**; this is the four lines
 * that costs. If `StateSnapshot` grows a field, TypeScript fails here first.
 *
 * `revision: 0` matters: the engine's first push may also be revision 0, so App accepts
 * an equal revision and only ever discards a strictly *older* one.
 */
export const INITIAL_SNAPSHOT: StateSnapshot = {
  revision: 0,
  discovery: { phase: 'searching', devices: [], selectedDeviceId: null },
  file: null,
  check: null,
  preparation: {
    active: false,
    percent: 0,
    secondsRemaining: null,
    frontierSec: null,
    headline: null,
    fallbackDirectory: null,
    cancellable: false,
    watchableInSeconds: null,
    playsOnCompletion: false,
    estimatingWait: false,
  },
  // M3b: non-null only while a television is playing a conversion that is still running.
  headStart: null,
  session: {
    state: 'idle',
    flags: { reconnecting: false, reattaching: false, yielded: false, networkDown: false },
    deviceId: null,
    deviceName: null,
    positionSec: 0,
    durationSec: 0,
    canSeek: false,
    seek: null,
    resumePositionSec: 0,
    yieldedToApp: null,
    offlineHelp: false,
    subtitleLabel: null,
    // 23i: nothing is playing before the first snapshot arrives, so there is no control.
    volume: null,
  },
  // M3c: the subtitle control, **Off** on every film until the founder says otherwise (19a).
  queue: { items: [], selectedId: null, playingId: null },
  subtitles: {
    options: [],
    unavailable: [],
    selectedId: null,
    selectedLabel: null,
    preparing: false,
    problem: null,
    timing: 'in sync',
    offsetMs: 0,
    timingRemembered: false,
    canGoEarlier: true,
    canGoLater: true,
    reloading: false,
    canRetry: false,
  },
  notice: null,
};
