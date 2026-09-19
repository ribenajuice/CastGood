import { describe, expect, it } from 'vitest';
import { LOOKAHEAD } from '../../src/engine/config.js';
import { forecastQueue, type ForecastItem } from '../../src/engine/queue/forecast.js';
import { describeApproxSeconds } from '../../src/engine/prepare/classify.js';

/**
 * **Which items will run back to back, and which will not** — criteria 24w and 24x.
 *
 * The forecast is arithmetic over two things the app already has: story 7's estimate and
 * each film's known duration. So is this file — the wording comes from
 * `describeApproxSeconds`, which is the same function every verdict on screen already uses,
 * and the settle time comes from `LOOKAHEAD`. Neither is retyped here, because a forecast
 * test that spelled out *"12 minutes"* by hand would go on passing after somebody changed
 * the sentence the founder actually reads.
 */

const HOUR = 3_600;

function item(over: Partial<ForecastItem> & { id: string }): ForecastItem {
  return { name: over.id, estimateSeconds: null, durationSec: HOUR, ...over };
}

describe('the ordinary evening: a season that runs back to back (24w)', () => {
  it('says nothing at all when every conversion fits inside the film before it', () => {
    // The measured case on this machine: 14.76× real time, so a 45-minute episode needs
    // about three minutes against 45 of budget.
    const forecasts = forecastQueue([
      item({ id: 'S01E01', estimateSeconds: 180, durationSec: 2_700 }),
      item({ id: 'S01E02', estimateSeconds: 180, durationSec: 2_700 }),
      item({ id: 'S01E03', estimateSeconds: 180, durationSec: 2_700 }),
    ]);
    expect(forecasts.every((entry) => entry.backToBack)).toBe(true);
    expect(forecasts.every((entry) => entry.message === null)).toBe(true);
  });

  it('never forecasts the first item, because nothing precedes it', () => {
    // *"Continuous playback"* is a promise about the joins in an evening, not about its
    // start. A first item that needs converting is the wait the founder has today.
    const [first] = forecastQueue([
      item({ id: 'Film One', estimateSeconds: 40 * 60, durationSec: 600 }),
      item({ id: 'Film Two', estimateSeconds: 60, durationSec: HOUR }),
    ]);
    expect(first?.message).toBeNull();
    expect(first?.backToBack).toBe(true);
  });

  it('says nothing about an item with nothing to prepare', () => {
    const [, ready] = forecastQueue([
      item({ id: 'Film One', durationSec: 120 }),
      item({ id: 'Film Two', estimateSeconds: null, durationSec: HOUR }),
    ]);
    expect(ready?.message).toBeNull();
    expect(ready?.backToBack).toBe(true);
  });
});

describe('the gap no engineering removes (24w)', () => {
  it('states the wait on that item’s own row, in the words the founder already reads', () => {
    // A 22-minute comedy in front of a feature film: the case the PRD names as the one that
    // really narrows the margin.
    const [, second] = forecastQueue([
      item({ id: 'Comedy', durationSec: 22 * 60 }),
      item({ id: 'Feature', estimateSeconds: 34 * 60, durationSec: 2 * HOUR }),
    ]);
    expect(second?.backToBack).toBe(false);
    // Not a hand-typed sentence: the same humaniser every verdict uses, over the wait this
    // function computed.
    const wait = second?.waitSeconds ?? 0;
    expect(second?.message).toBe(
      `Feature needs about ${describeApproxSeconds(wait)} before it starts`,
    );
    expect(second?.message).toMatch(/^Feature needs about .+ before it starts$/);
  });

  it('spends the minute look-ahead waits before it starts, rather than pretending it is free', () => {
    // A five-minute film in front of a job that needs four and a half. Ignoring the settle
    // rule would forecast *back to back* and then make the founder wait anyway — which is
    // the one outcome the forecast exists to prevent.
    const settle = LOOKAHEAD.cleanPlayBeforeStartMs / 1_000;
    const [, second] = forecastQueue([
      item({ id: 'Short', durationSec: 300 }),
      item({ id: 'Next', estimateSeconds: 300 - settle + 30, durationSec: HOUR }),
    ]);
    expect(second?.backToBack).toBe(false);
    expect(second?.waitSeconds).toBe(30);
  });

  it('does not let a wait before one item pay for the next one', () => {
    // Only one job runs at a time, and item 3's cannot start until item 2 is playing. A
    // forecast that carried the surplus forward would promise a join it cannot make.
    const [, second, third] = forecastQueue([
      item({ id: 'One', durationSec: 4 * HOUR }),
      item({ id: 'Two', estimateSeconds: 60, durationSec: 120 }),
      item({ id: 'Three', estimateSeconds: 30 * 60, durationSec: HOUR }),
    ]);
    expect(second?.backToBack).toBe(true);
    expect(third?.backToBack).toBe(false);
  });
});

describe('a forecast is never invented (8b’s honesty clause)', () => {
  it('says it does not know when the film before it has no readable length', () => {
    const [, second] = forecastQueue([
      item({ id: 'Mystery', durationSec: null }),
      item({ id: 'Next', estimateSeconds: 600, durationSec: HOUR }),
    ]);
    expect(second?.unknown).toBe(true);
    expect(second?.waitSeconds).toBeNull();
    expect(second?.message).toBeNull();
  });
});

describe('a reorder is a different forecast, and a removal is too (24w)', () => {
  const short = item({ id: 'Short', durationSec: 300 });
  const long = item({ id: 'Long', durationSec: 2 * HOUR });
  const needsWork = item({ id: 'Heavy', estimateSeconds: 20 * 60, durationSec: HOUR });

  it('forecasts a wait behind the short film and none behind the long one', () => {
    const behindShort = forecastQueue([short, needsWork]);
    const behindLong = forecastQueue([long, needsWork]);
    expect(behindShort[1]?.backToBack).toBe(false);
    expect(behindLong[1]?.backToBack).toBe(true);
    // The same rows, a different order, a different answer — recomputed rather than
    // remembered, because this function keeps nothing between calls.
    expect(behindShort[1]?.message).not.toBe(behindLong[1]?.message);
  });

  it('drops the wait when the item that caused it is removed', () => {
    const before = forecastQueue([long, short, needsWork]);
    expect(before[2]?.backToBack).toBe(false);
    const after = forecastQueue([long, needsWork]);
    expect(after[1]?.backToBack).toBe(true);
    expect(after[1]?.message).toBeNull();
  });
});
