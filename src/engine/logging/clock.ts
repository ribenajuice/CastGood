/**
 * Two clocks, deliberately separated.
 *
 * `wallMs` is for humans reading a log line. It can jump: NTP corrections, DST,
 * and — the one that actually bites us — resuming from sleep mid-film.
 *
 * `monoMs` never jumps and never goes backwards. Every duration, timeout,
 * heartbeat and position extrapolation in the engine measures with this one.
 */

export interface Clock {
  /** Wall-clock milliseconds since the Unix epoch. */
  wallMs(): number;
  /** Milliseconds since an arbitrary fixed point. Monotonic. */
  monoMs(): number;
}

const origin = process.hrtime.bigint();

export const systemClock: Clock = {
  wallMs: () => Date.now(),
  monoMs: () => Number(process.hrtime.bigint() - origin) / 1e6,
};

/** Deterministic clock for tests. Both hands are advanced explicitly. */
export function createTestClock(
  startWallMs = 0,
  startMonoMs = 0,
): Clock & {
  advance(ms: number): void;
  setWall(ms: number): void;
} {
  let wall = startWallMs;
  let mono = startMonoMs;
  return {
    wallMs: () => wall,
    monoMs: () => mono,
    advance(ms: number) {
      wall += ms;
      mono += ms;
    },
    setWall(ms: number) {
      wall = ms;
    },
  };
}
