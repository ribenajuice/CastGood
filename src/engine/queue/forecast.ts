import { LOOKAHEAD } from '../config.js';
import { describeApproxSeconds } from '../prepare/classify.js';

/**
 * **Which items will run back to back, and which will not** — M5b, criteria 24w and 24x.
 *
 * There is one limit no engineering removes: if film 1 is shorter than film 2's conversion
 * needs, film 2 is not ready when film 1 ends. The founder's answer to that is *forecast it,
 * then wait if it happens* — never auto-reordering, never a prompt mid-evening.
 *
 * ⚠️ **No new estimation machinery, and this file is where that promise is kept.** Every
 * number in here came from somewhere else: `estimateSeconds` is story 7's verdict, already
 * shown on the row as *"needs converting — about 6 minutes"*, and `durationSec` is the
 * film's own length from our probe. This is arithmetic over two things the app already has,
 * and 24w fails *"if it is produced by anything but story 7's existing estimate"*.
 *
 * ## The arithmetic, and the one subtraction that is not obvious
 *
 * Item N's preparation runs while item N−1 plays, so its budget is item N−1's **duration**
 * — less the minute look-ahead waits before it starts (`LOOKAHEAD.cleanPlayBeforeStartMs`).
 * That minute is not a fudge factor: it is a rule of this milestone, it is spent every time,
 * and a forecast that ignored it would promise *back to back* for a five-minute item whose
 * next film needs four and a half. Forecasting the wait and then having it happen anyway is
 * the one outcome 24w exists to prevent.
 *
 * **Waits do not accumulate.** A wait before item N does not buy item N+1 any extra time,
 * because only one job runs at a time and item N+1's cannot start until item N is playing.
 * So each row's forecast depends on exactly one pair — its own estimate and its predecessor's
 * length — which is also why a reorder recomputes cleanly rather than needing history.
 *
 * ## The first item is never forecast
 *
 * Nothing precedes it, so a first item that needs converting means the founder waits exactly
 * as they wait today for a single film. *"Continuous playback"* is a promise about the joins
 * in an evening and must not be read as covering its start — so item 0 gets no sentence,
 * because it has no wait that look-ahead could ever have removed.
 */

export interface ForecastItem {
  readonly id: string;
  /** What the row is called. The sentence names the film. */
  readonly name: string;
  /**
   * Story 7's estimate of the preparation this item needs, in seconds. `null` means there
   * is nothing to prepare — already Tier 1, or a prepared sibling is already on disk.
   */
  readonly estimateSeconds: number | null;
  /** The film's own length, from our probe. `null` when nothing could read it. */
  readonly durationSec: number | null;
}

export interface ItemForecast {
  readonly id: string;
  /** True when this item will be ready the moment the one before it ends. */
  readonly backToBack: boolean;
  /**
   * How long the founder will wait between the two films, rounded seconds. `0` for a join
   * with no wait, and `null` when there is nothing honest to say — see `unknown`.
   */
  readonly waitSeconds: number | null;
  /**
   * The row's own sentence, or `null` when there is nothing to say.
   *
   * **A forecast wait is not a failure** (24x): no error styling, no new vocabulary, and it
   * never causes a stall, drops an item or reorders anything. It is one plain sentence
   * stating a wait the founder would otherwise meet without warning.
   */
  readonly message: string | null;
  /**
   * The forecast could not be made — a film whose length nothing could read.
   *
   * Stated rather than guessed. 8b's honesty clause runs through the whole product: a
   * number invented here would be the flattering direction, and the founder would find out
   * it was wrong by sitting in front of a television.
   */
  readonly unknown: boolean;
}

/**
 * Forecast every join in the queue.
 *
 * A pure function of the list — hand it the same rows and it answers the same thing, which
 * is what makes 24w's *"a forecast never survives a reorder unrecomputed"* a property of the
 * caller calling it again rather than of anything remembered in here.
 */
export function forecastQueue(items: readonly ForecastItem[]): readonly ItemForecast[] {
  const settleSeconds = LOOKAHEAD.cleanPlayBeforeStartMs / 1_000;

  return items.map((item, index) => {
    const previous = index === 0 ? null : items[index - 1];
    const nothingToPrepare = item.estimateSeconds === null || item.estimateSeconds <= 0;

    // The first item, and every item with nothing to prepare: no join to forecast.
    if (previous === undefined || previous === null || nothingToPrepare) {
      return { id: item.id, backToBack: true, waitSeconds: 0, message: null, unknown: false };
    }

    if (previous.durationSec === null) {
      return { id: item.id, backToBack: false, waitSeconds: null, message: null, unknown: true };
    }

    const budgetSeconds = Math.max(0, previous.durationSec - settleSeconds);
    const waitSeconds = Math.round((item.estimateSeconds ?? 0) - budgetSeconds);

    if (waitSeconds <= 0) {
      return { id: item.id, backToBack: true, waitSeconds: 0, message: null, unknown: false };
    }

    return {
      id: item.id,
      backToBack: false,
      waitSeconds,
      // The wording is the founder's own from the PRD, and the duration phrase is the one
      // `describeApproxSeconds` already puts on every verdict — *no new vocabulary* (24x).
      message: `${item.name} needs about ${describeApproxSeconds(waitSeconds)} before it starts`,
      unknown: false,
    };
  });
}
