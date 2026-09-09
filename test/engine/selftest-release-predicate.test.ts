import fsSync from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { holdsTheTelevision } from '../../src/engine/selftest/kit.js';
import type { SessionState } from '../../src/engine/types.js';

/**
 * **"Waiting for the television to be released" has to mean every way it can be released.**
 *
 * `m2` learned this in August and put the answer in one place: `holdsTheTelevision`, which
 * counts `ended` — a film that played out — as a television nobody is holding. The M3
 * scenarios could not reach that helper, because it lived in `index.ts` and importing it
 * from `m3.ts` would have closed a module cycle, so each of them spelled the question out
 * by hand: `state === 'stopped' || state === 'idle'`. Eight times, and all eight wrong in
 * the same way.
 *
 * It cost the `m3` aggregate its whole `headstart` leg on 2026-08-25. The 10d jump landed
 * at the end of the film, the film finished, the engine let the television go by itself at
 * 07:18:17.452Z (`cast.disconnected`, `media.unmounted`, `session.reached_end`), and the
 * scenario then waited 20 s for a release that had happened 21 s *before* it asked. The
 * verdict printed `runCompleted: no — timed out after 20000 ms waiting for the television
 * to be released`, and every assertion the leg had gathered was thrown away with the
 * exception. The product had done exactly what criterion 13e asks of it.
 *
 * The helper now lives in `kit.ts`, which imports nothing at runtime and so cannot take
 * part in a cycle. This file holds that arrangement in place from both ends: the helper's
 * own answer, and the absence of any hand-rolled copy of the question.
 */

const SESSION_STATES: readonly SessionState[] = [
  'idle',
  'connecting',
  'loading',
  'buffering',
  'playing',
  'paused',
  'seeking',
  'ended',
  'stopped',
];

const SCENARIO_FILES = ['index.ts', 'm3.ts', 'm3b.ts'] as const;

function sourceOf(name: string): string {
  return fsSync.readFileSync(
    fileURLToPath(new URL(`../../src/engine/selftest/${name}`, import.meta.url)),
    'utf8',
  );
}

describe('a released television is recognised the same way everywhere', () => {
  it('a film that played out is not holding the television, and neither is idle or stopped', () => {
    expect(holdsTheTelevision('ended')).toBe(false);
    expect(holdsTheTelevision('idle')).toBe(false);
    expect(holdsTheTelevision('stopped')).toBe(false);
    // …and every other state is, so the helper is not simply always false. The list is
    // the whole `SessionState` union — a state added to the product and not to this list
    // is a state nobody here has decided about, which is why it is spelled out rather
    // than derived from the helper it is testing.
    for (const state of SESSION_STATES) {
      if (state === 'ended' || state === 'idle' || state === 'stopped') continue;
      expect(holdsTheTelevision(state), state).toBe(true);
    }
  });

  it('no scenario asks the question by hand any more', () => {
    // The exact shape of the eight copies, matched loosely enough that a reordered or
    // reformatted one is still caught. A scenario that goes back to spelling it out is a
    // scenario that will hang for 20 s on a film that finished.
    const byHand =
      /session\.state\s*===\s*'(?:stopped|idle)'\s*\|\|\s*snapshot\.session\.state\s*===\s*'(?:stopped|idle)'/;
    for (const name of SCENARIO_FILES) {
      const source = sourceOf(name);
      expect(byHand.test(source), `${name} still decides "released" by hand`).toBe(false);
    }
  });

  it('and every wait for a release goes through the helper', () => {
    // The other half: the phrase must still be attached to something. A file that simply
    // deleted its release waits would pass the case above.
    let waits = 0;
    for (const name of SCENARIO_FILES) {
      const source = sourceOf(name);
      const occurrences = source.split('the television to be released').length - 1;
      waits += occurrences;
      if (occurrences > 0) {
        expect(source, `${name} waits for a release without using the helper`).toContain(
          '!holdsTheTelevision(snapshot.session.state)',
        );
      }
    }
    expect(waits, 'nothing waits for a television to be released any more').toBeGreaterThan(0);
  });
});
