import { describe, expect, it } from 'vitest';
import { seekToPlayingBoundMs } from '../../src/engine/selftest/index.js';
import { SelftestAbort } from '../../src/engine/selftest/kit.js';

/**
 * 6a's seek promise, after the founder's 2026-08-25 decision.
 *
 * The Master bedroom Chromecast was measured five times — 2334, 457, 2688, 756, 2278 ms —
 * against a flat 2000 ms bound, breaching three times in five and doing it on `main` too.
 * Not noise and not a regression: `m2`'s 107/107 was scored on the Home Theatre and Family
 * room sets, and this device class had never run `m2` before that day.
 *
 * The founder was asked as a product question and answered as one: two seconds is nothing
 * in the grand scheme of a film. So the bound says what is true of each television — and
 * these tests exist to stop that becoming a blanket loosening, which is the easy version of
 * this change and the one that would blind the televisions the promise matters most on.
 */
describe("6a's seek bound is per-television, not loosened everywhere", () => {
  const device = (model: string | null) => [{ id: 'tv-1', model }];

  it('holds a plain Chromecast to 3 s, the decision the founder actually made', () => {
    expect(seekToPlayingBoundMs(device('Chromecast'), 'tv-1')).toBe(3_000);
  });

  it('still holds every other television to 2 s', () => {
    // The sets the founder watches meet 2 s and are still graded on it, so a regression
    // there is caught exactly as it was before. This is the assertion that makes the change
    // a correction rather than a weakening.
    expect(seekToPlayingBoundMs(device('Chromecast Ultra'), 'tv-1')).toBe(2_000);
    expect(seekToPlayingBoundMs(device('AI PONT'), 'tv-1')).toBe(2_000);
    expect(seekToPlayingBoundMs(device('Google TV Streamer'), 'tv-1')).toBe(2_000);
    expect(seekToPlayingBoundMs(device('Nest Hub'), 'tv-1')).toBe(2_000);
    // An unrecognised television falls to the baseline and keeps the tighter promise: a
    // device nobody has measured is not handed the slower one on the strength of a guess.
    expect(seekToPlayingBoundMs(device('Some Other Telly'), 'tv-1')).toBe(2_000);
    expect(seekToPlayingBoundMs(device(null), 'tv-1')).toBe(2_000);
  });

  it('leaves the loosened bound able to fail — it is a bound, not a rubber stamp', () => {
    // The worst of the five measurements was 2688 ms. 3000 keeps ~310 ms of headroom, so a
    // device that got materially slower still goes red. If this ever stops being true the
    // assertion has stopped measuring anything.
    const bound = seekToPlayingBoundMs(device('Chromecast'), 'tv-1');
    expect(bound).toBeGreaterThan(2_688);
    expect(bound).toBeLessThan(4_000);
  });

  it('aborts rather than guessing when the television is not in the snapshot', () => {
    // channelLimitFor's lesson, and the reason it throws: an instrument that invents a
    // bound condemns a run somebody then spends an evening debugging. Not knowing which
    // television this is means the measurement could not be taken — exit 2, never a grade.
    expect(() => seekToPlayingBoundMs(device('Chromecast'), 'tv-missing')).toThrow(SelftestAbort);
  });
});
