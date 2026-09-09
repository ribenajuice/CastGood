import { describe, expect, it } from 'vitest';
import { createPositionTracker } from '../../src/engine/session/position.js';

/**
 * Story 5, proved arithmetically: within 1 s of the device, and no drift over two hours.
 *
 * The mechanism under test is that every device report re-anchors the estimate, so the
 * error at 1:55:00 is the same as the error at 0:05:00 — it is one round trip's worth,
 * not an accumulation. That is why this test replays 7,200 seconds and checks the *last*
 * divergence as well as the largest.
 */

describe('position tracker', () => {
  it('extrapolates smoothly between device reports while playing', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 10, receivedAtMono: 1_000, durationSec: 3_600, playing: true });

    expect(tracker.positionAt(1_000)).toBeCloseTo(10, 6);
    expect(tracker.positionAt(1_500)).toBeCloseTo(10.5, 6);
    expect(tracker.positionAt(2_000)).toBeCloseTo(11, 6);
  });

  it('freezes while paused — the readout must not creep', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 42, receivedAtMono: 1_000, durationSec: 3_600, playing: false });
    expect(tracker.positionAt(9_000)).toBeCloseTo(42, 6);
  });

  it('never runs past the end of the file', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 3_599, receivedAtMono: 0, durationSec: 3_600, playing: true });
    expect(tracker.positionAt(60_000)).toBeCloseTo(3_600, 6);
  });

  it('reports the divergence it had just before the device corrected it', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 10, receivedAtMono: 0, durationSec: 3_600, playing: true });
    // A second later the device says 10.4 rather than the 11 we predicted.
    const result = tracker.anchor({
      reportedSec: 10.4,
      receivedAtMono: 1_000,
      durationSec: 3_600,
      playing: true,
    });
    expect(result.divergenceSec).toBeCloseTo(0.6, 6);
    expect(result.snapped).toBe(false);
    expect(tracker.positionAt(1_000)).toBeCloseTo(10.4, 6);
  });

  it('snaps to the device when the divergence exceeds one second', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 10, receivedAtMono: 0, durationSec: 3_600, playing: true });
    const result = tracker.anchor({
      reportedSec: 30,
      receivedAtMono: 1_000,
      durationSec: 3_600,
      playing: true,
    });
    expect(result.snapped).toBe(true);
    expect(tracker.positionAt(1_000)).toBeCloseTo(30, 6);
  });

  it('does not drift across a two-hour file, even with a device whose clock runs fast', () => {
    const tracker = createPositionTracker();
    const divergences: number[] = [];
    // The device advances 0.3% faster than our local clock: over 2 h that is 21 seconds
    // of accumulated error if you extrapolate and never re-anchor.
    for (let second = 0; second <= 7_200; second += 1) {
      const result = tracker.anchor({
        reportedSec: second * 1.003,
        receivedAtMono: second * 1_000,
        durationSec: 7_300,
        playing: true,
      });
      if (result.divergenceSec !== null) divergences.push(result.divergenceSec);
    }

    const max = Math.max(...divergences);
    const last = divergences[divergences.length - 1] as number;
    const first = divergences[0] as number;

    expect(max).toBeLessThanOrEqual(1);
    // The whole point: the error at the end is the same size as at the beginning.
    expect(Math.abs(last - first)).toBeLessThan(0.01);
  });

  it('measures elapsed time monotonically, so a wall-clock jump cannot move the playhead', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 100, receivedAtMono: 5_000, durationSec: 3_600, playing: true });
    // The monotonic clock is the only input; there is no Date.now() to jump.
    expect(tracker.positionAt(5_500)).toBeCloseTo(100.5, 6);
    expect(tracker.position?.reportedAtMono).toBe(5_000);
  });

  it('freezes where it is when the session ends, so a Stopped readout cannot creep', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 100, receivedAtMono: 0, durationSec: 3_600, playing: true });

    tracker.freeze(2_000);
    expect(tracker.positionAt(2_000)).toBeCloseTo(102, 6);
    // No device will correct this again — an un-frozen tracker would go on extrapolating
    // from the last PLAYING it heard and show a rising position for a stopped film.
    expect(tracker.positionAt(60_000)).toBeCloseTo(102, 6);
  });

  it('ignores a freeze before anything was ever reported', () => {
    const tracker = createPositionTracker();
    tracker.freeze(5_000);
    expect(tracker.position).toBeNull();
  });

  it('starts again cleanly for a new session', () => {
    const tracker = createPositionTracker();
    tracker.anchor({ reportedSec: 100, receivedAtMono: 0, durationSec: 3_600, playing: true });
    tracker.reset();
    expect(tracker.position).toBeNull();
    expect(tracker.positionAt(10_000)).toBe(0);
    expect(tracker.durationSec).toBe(0);
  });
});
