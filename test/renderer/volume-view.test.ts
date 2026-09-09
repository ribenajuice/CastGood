import { describe, expect, it } from 'vitest';
import { buildViewModel } from '../../src/renderer/state/view-model.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';

/**
 * What the founder actually sees of the volume — M5a, §11, as a pure function.
 *
 * Snapshot in, view model out. Every rule the control obeys is decided here rather than in
 * the component, so these are the tests that would catch the milestone's central defect:
 * **a handle that follows the finger instead of the television.**
 */

const IDLE_PICKER = { available: true, busy: false, error: null };

function snapshot(session: Partial<StateSnapshot['session']>): StateSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    discovery: {
      ...EMPTY_SNAPSHOT.discovery,
      phase: 'found',
      selectedDeviceId: 'tv-1',
      devices: [{ id: 'tv-1', friendlyName: 'Family room TV', model: 'AI PONT', available: true }],
    },
    session: {
      ...EMPTY_SNAPSHOT.session,
      state: 'playing' as SessionState,
      deviceId: 'tv-1',
      durationSec: 3_600,
      positionSec: 120,
      ...session,
    },
  };
}

const volumeOf = (session: Partial<StateSnapshot['session']>) =>
  buildViewModel(snapshot(session), IDLE_PICKER).transport?.volume ?? null;

const reported = (over: Partial<NonNullable<StateSnapshot['session']>['volume']> = {}) => ({
  level: 0.37,
  muted: false,
  stepInterval: 0.01,
  controllable: true,
  pending: null,
  ...over,
});

describe('§11 — what the control is told to draw', () => {
  it('positions the handle on the reported level and reads it out as a percentage', () => {
    const volume = volumeOf({ volume: reported() });
    expect(volume?.percent).toBe(37);
    expect(volume?.readout).toBe('37%');
    expect(volume?.valueText).toBe('37%');
    expect(volume?.disabled).toBe(false);
  });

  it('keeps the ask separate from the level, so an ignored command is visible', () => {
    // The whole honesty mechanism: the founder pointed at 62%, the television has said
    // nothing, and the *level* is still 37%. A design that folded these together would
    // look identical on a working set and on one that ignored us.
    const volume = volumeOf({ volume: reported({ pending: 0.62 }) });
    expect(volume?.percent).toBe(37);
    expect(volume?.pendingPercent).toBe(62);
    expect(volume?.readout).toBe('37%');
    expect(volume?.valueText).toBe('37%, asking for 62%');
  });

  it('never falls back to the ask when no level has been reported', () => {
    // ⚠️ The defect this test exists for: showing the pending value as the level would
    // make a television that has said nothing look like one that answered instantly.
    const volume = volumeOf({ volume: reported({ level: null, pending: 0.5 }) });
    expect(volume?.percent).toBeNull();
    expect(volume?.readout).toBe('—');
    expect(volume?.valueText).toBe('Not reported yet');
  });

  it('says Muted without losing the level the television is still holding', () => {
    const volume = volumeOf({ volume: reported({ muted: true }) });
    expect(volume?.readout).toBe('Muted');
    expect(volume?.percent).toBe(37);
    expect(volume?.valueText).toBe('Muted, 37%');
  });
});

describe("§11 — granularity is the television's, not ours", () => {
  it('draws a step ladder on a 20-step Chromecast, where the positions are countable', () => {
    const volume = volumeOf({ volume: reported({ stepInterval: 0.05 }) });
    expect(volume?.steps).toBe(20);
    // One keypress asks for the next position the founder can actually see.
    expect(volume?.stepPercent).toBe(5);
  });

  it('draws a continuous bar on the AI PONT, where 1% is 1.6px and not countable', () => {
    const volume = volumeOf({ volume: reported({ stepInterval: 0.01 }) });
    expect(volume?.steps).toBeNull();
    expect(volume?.stepPercent).toBe(5);
  });

  it('has no opinion at all when the set does not say', () => {
    const volume = volumeOf({ volume: reported({ stepInterval: null }) });
    expect(volume?.steps).toBeNull();
  });
});

describe('23h and 23i — the two ways it is unavailable', () => {
  it('names the television in the one sentence M5a adds, and only there', () => {
    const volume = volumeOf({ volume: reported({ controllable: false }) });
    expect(volume?.disabled).toBe(true);
    expect(volume?.unavailableReason).toBe('Family room TV keeps its own volume.');
    expect(volume?.valueText).toBe('Not available');
  });

  it('is disabled but still drawn while reconnecting, holding its last reported level', () => {
    // §4: recovery keeps the screen still. The level does not clear to signal a problem.
    const volume = volumeOf({
      volume: reported(),
      flags: { ...EMPTY_SNAPSHOT.session.flags, reconnecting: true },
    });
    expect(volume?.disabled).toBe(true);
    expect(volume?.percent).toBe(37);
    expect(volume?.unavailableReason).toBeNull();
  });

  it('is not rendered at all when the television has been released', () => {
    // Absent, not greyed — and the engine is what decides it, by publishing no volume.
    expect(volumeOf({ state: 'stopped' as SessionState, volume: null })).toBeNull();
  });

  it('shows no ask mark while disabled, because nothing is going anywhere', () => {
    const volume = volumeOf({
      volume: reported({ pending: 0.9 }),
      flags: { ...EMPTY_SNAPSHOT.session.flags, yielded: true },
    });
    expect(volume?.disabled).toBe(true);
  });
});
