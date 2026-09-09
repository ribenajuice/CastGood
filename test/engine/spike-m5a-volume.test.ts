import { describe, expect, it } from 'vitest';
import {
  classifyEcho,
  describeLadder,
  inferStep,
  ladderFor,
  readReceiverVolume,
  readStreamVolume,
} from '../../src/engine/spike/m5a.js';
import { describeSeen } from '../../src/engine/spike/device.js';

/**
 * SPIKE-5's **pure** half, checked in WSL against captured payloads.
 *
 * A spike asserts nothing about a television, but the arithmetic it uses to describe one
 * is ordinary code and can be wrong in ordinary ways. Getting `classifyEcho` backwards
 * would not fail loudly on hardware — it would produce a **confident, wrong sentence**
 * about the founder's main set, which is exactly the kind of finding M5a's build order
 * exists to prevent. So the parsing and the classifying are pinned here, where they cost
 * nothing, and the television is left to answer only what a television can.
 */

describe('readReceiverVolume — question 1, what the volume object actually contains', () => {
  it('reads a full object and keeps the raw JSON, because the unexpected fields are the point', () => {
    const volume = readReceiverVolume({
      status: {
        volume: { level: 0.37, muted: false, controlType: 'attenuation', stepInterval: 0.02 },
      },
    });
    expect(volume).toMatchObject({
      level: 0.37,
      muted: false,
      controlType: 'attenuation',
      stepInterval: 0.02,
    });
    expect(JSON.parse(volume.raw)).toMatchObject({ controlType: 'attenuation' });
  });

  it('says ABSENT rather than guessing when a set omits controlType and stepInterval', () => {
    const volume = readReceiverVolume({ status: { volume: { level: 0.5, muted: true } } });
    expect(volume.controlType).toBeNull();
    expect(volume.stepInterval).toBeNull();
    expect(volume.muted).toBe(true);
  });

  it('survives a payload with no status, no volume, or the wrong types entirely', () => {
    for (const payload of [
      null,
      undefined,
      42,
      'nonsense',
      {},
      { status: {} },
      { status: { volume: 'loud' } },
    ]) {
      const volume = readReceiverVolume(payload);
      expect(volume.level).toBeNull();
      expect(volume.muted).toBeNull();
    }
  });

  it('treats a non-finite level as absent — NaN is not a volume', () => {
    expect(readReceiverVolume({ status: { volume: { level: Number.NaN } } }).level).toBeNull();
  });
});

describe('readStreamVolume — question 3, is there a second number at all', () => {
  it('returns null when the media status carries no volume object, which is the "only one number" answer', () => {
    expect(readStreamVolume({ status: [{ playerState: 'PLAYING' }] })).toBeNull();
  });

  it('reads the stream volume off the first media status when there is one', () => {
    const volume = readStreamVolume({ status: [{ volume: { level: 0.8, muted: false } }] });
    expect(volume?.level).toBe(0.8);
    expect(volume?.muted).toBe(false);
  });

  it('returns null for a media status that is not an array', () => {
    expect(readStreamVolume({ status: { volume: { level: 0.8 } } })).toBeNull();
  });
});

describe('classifyEcho — the four wrong answers are four different products', () => {
  it('calls an echo at the asked level exact', () => {
    expect(classifyEcho(0.3, 0.3, 0.1)).toBe('exact');
  });

  it('calls a set that did not move at all IGNORED, which is 23h and not 23a', () => {
    expect(classifyEcho(0.3, 0.1, 0.1)).toBe('ignored');
  });

  it('calls an echo at a nearby-but-different level QUANTISED, which the app renders rather than retries', () => {
    expect(classifyEcho(0.37, 0.35, 0.1)).toBe('quantised');
  });

  it('reports a clamp at each end', () => {
    expect(classifyEcho(-0.25, 0, 0.3)).toBe('clamped-low');
    expect(classifyEcho(1.5, 1, 0.3)).toBe('clamped-high');
  });

  it('calls no echo at all NOT-ECHOED — worse than any of the others, because 4c has nothing to render', () => {
    expect(classifyEcho(0.3, null, 0.1)).toBe('not-echoed');
  });

  it('does NOT call it ignored when the set was already at the asked level', () => {
    // The set standing still is only evidence of refusal if it was asked to move. This is
    // the same trap the `volume` scenario exits 2 for: a leg that began at its own target
    // demonstrated nothing either way.
    expect(classifyEcho(0.3, 0.3, 0.3)).toBe('exact');
  });

  it('cannot tell ignored from exact with no previous level, and prefers the honest reading', () => {
    expect(classifyEcho(0.3, 0.3, null)).toBe('exact');
  });
});

describe('inferStep — what the set DID, which outranks what it claims', () => {
  it('finds the smallest gap actually observed', () => {
    expect(inferStep([0.1, 0.15, 0.2, 0.35])).toBeCloseTo(0.05, 6);
  });

  it('returns null when there is nothing to compare', () => {
    expect(inferStep([])).toBeNull();
    expect(inferStep([0.4])).toBeNull();
    expect(inferStep([0.4, 0.4, 0.4])).toBeNull();
  });
});

describe('ladderFor — a spike that shouts is a spike the household bans', () => {
  it('asks for nothing above the cap', () => {
    const rungs = ladderFor(0.2, false);
    expect(rungs.filter((level) => level > 0.2)).toEqual([]);
  });

  it('always probes the low clamp, which is free and silent', () => {
    expect(ladderFor(0.5, false)).toContain(-0.25);
  });

  it('probes the upper clamp only when explicitly opted in, because it can set the room to maximum', () => {
    expect(ladderFor(1, false)).not.toContain(1.5);
    expect(ladderFor(1, true)).toContain(1.5);
  });

  it('keeps the off-grid rungs, which are the instrument that catches quantisation', () => {
    const rungs = ladderFor(0.5, false);
    expect(rungs).toContain(0.37);
    expect(rungs).toContain(0.055);
  });
});

describe('describeLadder — a sentence a future session can quote', () => {
  it('says plainly that nothing was measured rather than printing an empty summary', () => {
    expect(describeLadder([])).toMatch(/nothing was measured/);
  });

  it('names the round trip and the observed step when rungs exist', () => {
    const summary = describeLadder([
      {
        requested: 0.1,
        echoed: 0.1,
        previous: 0.3,
        roundTripMs: 120,
        settledLevel: 0.1,
        kind: 'exact',
      },
      {
        requested: 0.2,
        echoed: 0.2,
        previous: 0.1,
        roundTripMs: 140,
        settledLevel: 0.2,
        kind: 'exact',
      },
    ]);
    expect(summary).toContain('2× exact');
    expect(summary).toMatch(/round trip 120–140 ms/);
    expect(summary).toMatch(/smallest observed step 0\.1000/);
  });

  it('reports "no round trip was measured" rather than inventing a median from nothing', () => {
    const summary = describeLadder([
      {
        requested: 0.1,
        echoed: null,
        previous: 0.3,
        roundTripMs: null,
        settledLevel: null,
        kind: 'not-echoed',
      },
    ]);
    expect(summary).toMatch(/no round trip was measured/);
    expect(summary).toContain('1× not-echoed');
  });
});

describe('describeSeen — the message a founder reads at 9pm when a spike will not run', () => {
  it('distinguishes "nothing answered" from "the name is wrong", because they need different actions', () => {
    expect(describeSeen([])).toMatch(/nothing answered mDNS at all/);
    expect(
      describeSeen([{ friendlyName: 'Family room TV' }, { friendlyName: 'Home Theatre TV' }]),
    ).toBe('2 device(s) answered: "Family room TV", "Home Theatre TV"');
  });
});
