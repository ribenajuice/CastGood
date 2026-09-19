import { LOOKAHEAD } from '../config.js';
import type { Logger } from '../logging/index.js';
import type {
  PreparationFailure,
  PreparationPipeline,
  PreparationProgress,
  PreparedArtifact,
  PrepareRequest,
} from '../prepare/index.js';
import {
  abandonDeadline,
  decide,
  watchPlayback,
  NO_WATCH,
  type LookaheadBlock,
  type LookaheadWatch,
  type PlaybackObservation,
} from './lookahead.js';

/**
 * **The one look-ahead job** — M5b step 2, criteria 24f, 24g, 24i, 24j and 24l.
 *
 * The rules live next door in `lookahead.ts` and are pure. This is the machinery around
 * them: one `AbortController`, one promise, and the accounting that makes *"one item ahead
 * and no more"* true by construction rather than by care.
 *
 * ## Why there is exactly one slot, and why it is not cleared on `abort()`
 *
 * 24g fails *"if more than one look-ahead job exists at any moment"*, and 24f fails *"if a
 * second look-ahead job is started before the first has stopped"*. Aborting is asynchronous
 * — ffmpeg has to be killed and the staging files removed — so a slot cleared at the abort
 * would allow a second job to start while the first was still exiting. The slot is therefore
 * held until the pipeline has **resolved**, which is after the kill and after the cleanup.
 * A job being torn down still occupies the slot, and nothing else can begin.
 *
 * ## Why it runs `prepare()` and never `prepareWithHeadStart()`
 *
 * ⚠️ **A head-start conversion writes its segments into one fixed folder** —
 * `prepare/index.ts`'s `HEAD_START_DIR`, a deliberate ADR: *"a folder that is already there
 * belongs to a run that died, and removing it before starting is the whole of the sweep"*.
 * That is safe while there is only ever one conversion **and one film**. It is not safe with
 * a queue: 10g keeps serving those segments to the television until the session is let go,
 * which is **after** the conversion has exited — so a look-ahead that 24k(a) says is now
 * allowed to start would sweep the folder the picture is currently coming out of.
 *
 * So look-ahead prepares the way M3a's Cast does: one job, one staging file beside the
 * source, one atomic rename. That is also the closest reading of 24l — *"it writes exactly
 * what pressing Cast on that film would write, one prepared file beside its source"* — and
 * it shares no directory with anything the television is reading.
 *
 * **The consequence is stated rather than hidden**: an item prepared this way cannot be
 * started part-way through, because there is no growing playlist to start from. That is a
 * live question for 24y and it is named in the report rather than settled here.
 *
 * ## 24j, by construction
 *
 * The only dependency here is a `PreparationPipeline`. There is no cast client, no device,
 * no media server and no session — so *"it sends nothing to any television, opens no
 * connection to one, and takes nothing from the media server"* is not a rule this file
 * observes, it is a thing this file has no way to do.
 */

/** The next item, and everything the pipeline needs to prepare it. */
export interface LookaheadTarget {
  readonly itemId: string;
  readonly request: PrepareRequest;
}

/** 24ac: what that item's own row shows while it is being prepared ahead. */
export interface LookaheadJobView {
  readonly itemId: string;
  readonly percent: number;
  readonly secondsRemaining: number | null;
  readonly startedAtMono: number;
}

/**
 * A job handed over to the caller — 24y and 24k(b).
 *
 * When the queue makes the next item **current** (film 1 reporting `FINISHED`), its
 * conversion stops being look-ahead and becomes the current film's own. It is the same job:
 * abandoning and restarting it at the join would throw away everything look-ahead exists to
 * have done.
 */
export interface AdoptedLookaheadJob {
  readonly itemId: string;
  readonly request: PrepareRequest;
  readonly abort: AbortController;
  readonly startedAtMono: number;
  /** Resolves when the job ends, with whatever the pipeline made of it. */
  readonly done: Promise<LookaheadOutcome>;
}

export type LookaheadOutcome =
  | { readonly ok: true; readonly artifact: PreparedArtifact }
  | { readonly ok: false; readonly failure: PreparationFailure };

export interface LookaheadRunnerDeps {
  readonly logger: Logger;
  readonly clock: { monoMs(): number };
  /** Asked per job, exactly as the engine's own check asks. `null` with no ffmpeg. */
  readonly pipeline: () => PreparationPipeline | null;
  /** The row's progress moved, or a job started or ended: push a snapshot. */
  readonly onChanged: () => void;
  /** A finished look-ahead. The item is ready, and it came up with no wait — the milestone. */
  readonly onPrepared: (itemId: string, artifact: PreparedArtifact) => void;
}

export interface LookaheadRunner {
  /** The job on the one slot, for that item's own row (24ac). `null` most of the time. */
  readonly job: LookaheadJobView | null;
  /** Why nothing is running. For the log and for nothing on screen — 24ac: never announced. */
  readonly block: LookaheadBlock | null;
  /**
   * One observation of the film on screen, and the next item as it stands right now.
   *
   * Called on every device status, every session change and every change to the queue.
   * **Everything this class does is decided here** — there is no timer of its own, because
   * a hesitation is a fact that arrives with a device report and a rule that waited for its
   * own tick would be measuring its own latency rather than the device's.
   */
  observe(obs: PlaybackObservation, target: LookaheadTarget | null): void;
  /**
   * Give up the job for a stated reason, and remove its partial work (24d, 24f).
   *
   * Resolves when there is nothing left of it — which is what makes *"a second job is never
   * started before the first has stopped"* checkable rather than hoped for.
   */
  abandon(why: string): Promise<void>;
  /** 24y: hand the running job to the caller as the current film's own. */
  handOver(itemId: string): AdoptedLookaheadJob | null;
  /** Shutting down. P6: no conversion survives the app. */
  dispose(): Promise<void>;
}

interface Job {
  readonly itemId: string;
  readonly request: PrepareRequest;
  readonly abort: AbortController;
  readonly startedAtMono: number;
  percent: number;
  secondsRemaining: number | null;
  /** Set the moment we decide to stop it, so a late progress report cannot revive the row. */
  abandoned: boolean;
  /** Filled in the instant the pipeline has been asked. See `begin`. */
  done: Promise<LookaheadOutcome>;
}

export function createLookaheadRunner(deps: LookaheadRunnerDeps): LookaheadRunner {
  const logger = deps.logger.child({ component: 'lookahead' });
  let watch: LookaheadWatch = NO_WATCH;
  let job: Job | null = null;
  let block: LookaheadBlock | null = null;
  /** Resolves when the slot is free again. Awaited by `abandon` and by `dispose`. */
  let settling: Promise<void> = Promise.resolve();

  function begin(target: LookaheadTarget, obs: PlaybackObservation): void {
    const pipeline = deps.pipeline();
    if (pipeline === null) {
      // No ffmpeg on this machine. Nothing is said to anybody: a look-ahead that cannot run
      // is a film that will be prepared when it comes up, which is the v1 product.
      logger.debug('lookahead.no_pipeline', { itemId: target.itemId });
      return;
    }
    const started = deps.clock.monoMs();
    const abort = new AbortController();
    // **The record exists before the promise does**, because the progress callback inside
    // the job has to be able to ask *"am I still the job on the slot?"* — the one question
    // that stops a report from a job we gave up on repainting a row that has already gone
    // back to its plain verdict (24ac). `done` is replaced four lines below, before any
    // caller can reach it and before ffmpeg can have said anything.
    const record: Job = {
      itemId: target.itemId,
      request: target.request,
      abort,
      startedAtMono: started,
      percent: 0,
      secondsRemaining: target.request.verdict.estimateSeconds,
      abandoned: false,
      done: Promise.resolve<LookaheadOutcome>({ ok: false, failure: { kind: 'cancelled' } }),
    };

    const run = pipeline
      .prepare(
        target.request,
        {
          onProgress: (progress: PreparationProgress) => {
            if (job !== record || record.abandoned) return;
            record.percent = progress.percent;
            record.secondsRemaining = progress.secondsRemaining;
            deps.onChanged();
          },
        },
        abort.signal,
      )
      .then((result): LookaheadOutcome =>
        result.ok
          ? { ok: true, artifact: result.artifact }
          : { ok: false, failure: result.failure },
      )
      .catch((error: unknown): LookaheadOutcome => {
        logger.error('lookahead.crashed', { error, itemId: target.itemId });
        return { ok: false, failure: { kind: 'failed', attempts: 0 } };
      });

    record.done = run;
    job = record;
    block = null;

    logger.info('lookahead.started', {
      itemId: record.itemId,
      name: target.request.source.name,
      kind: target.request.verdict.kind,
      estimateSeconds: target.request.verdict.estimateSeconds,
      // The two facts 24g's verdict is built from: this began while a film was playing, and
      // it began after the film had been clean for a minute.
      cleanForMs: watch.cleanSinceMono === null ? null : obs.monoMs - watch.cleanSinceMono,
      playerState: obs.report?.playerState ?? null,
    });
    deps.onChanged();

    settling = run.then((outcome) => {
      if (job !== record) return;
      job = null;
      const elapsedMs = deps.clock.monoMs() - record.startedAtMono;
      if (outcome.ok) {
        logger.info('lookahead.prepared', {
          itemId: record.itemId,
          elapsedMs,
          artifact: outcome.artifact.path,
        });
        deps.onPrepared(record.itemId, outcome.artifact);
      } else if (!record.abandoned) {
        // 24x and 24ac: a look-ahead that failed on its own costs nothing but the wait. The
        // row keeps its plain verdict, the founder is told nothing, and the item is prepared
        // again the ordinary way when it comes up.
        logger.warn('lookahead.failed', {
          itemId: record.itemId,
          failure: outcome.failure.kind,
          elapsedMs,
        });
      }
      deps.onChanged();
    });
  }

  /**
   * Stop the job. **The abort is synchronous; the slot is freed only when it has resolved.**
   *
   * `sinceMono` is the moment 24i's five seconds are counted from — the device's own first
   * missed sample where there is one. If the budget is missed, the log says so with the
   * measured number rather than the promise being quietly untrue.
   */
  function stop(why: string, sinceMono: number, detail: Record<string, unknown> = {}): void {
    const record = job;
    if (record === null || record.abandoned) return;
    record.abandoned = true;
    record.abort.abort();
    logger.info('lookahead.abandoning', { itemId: record.itemId, why, ...detail });
    deps.onChanged();

    settling = record.done.then(() => {
      const finishedAt = deps.clock.monoMs();
      const sinceHesitationMs = finishedAt - sinceMono;
      logger.info('lookahead.abandoned', {
        itemId: record.itemId,
        why,
        // Both numbers, because they are different facts: one is what the founder's picture
        // experienced, the other is how quickly we reacted once we could see it.
        sinceHesitationMs,
        budgetMs: LOOKAHEAD.abandonWithinMs,
        withinBudget: finishedAt <= abandonDeadline(sinceMono),
      });
      if (finishedAt > abandonDeadline(sinceMono)) {
        // Said loudly. A number that cannot be met is worth a warning in the log, not a
        // comment admitting it.
        logger.warn('lookahead.abandon_slow', {
          itemId: record.itemId,
          sinceHesitationMs,
          budgetMs: LOOKAHEAD.abandonWithinMs,
        });
      }
      if (job === record) job = null;
      deps.onChanged();
    });
  }

  return {
    get job(): LookaheadJobView | null {
      if (job === null || job.abandoned) return null;
      return {
        itemId: job.itemId,
        percent: job.percent,
        secondsRemaining: job.secondsRemaining,
        startedAtMono: job.startedAtMono,
      };
    },
    get block(): LookaheadBlock | null {
      return block;
    },

    observe(obs, target) {
      watch = watchPlayback(watch, obs);

      // 24f: the item being prepared ahead is no longer the next one. The finished work of a
      // *completed* preparation is a real file and survives any reorder; an **in-flight** job
      // for an item that has moved is abandoned and its partial work removed, and the founder
      // is told about neither.
      if (job !== null && !job.abandoned && job.itemId !== target?.itemId) {
        stop('the item is no longer next', obs.monoMs, { nowNext: target?.itemId ?? null });
      }

      const action = decide(watch, obs, {
        hasJob: job !== null,
        hasWork: target !== null,
      });

      switch (action.kind) {
        case 'start':
          if (target !== null) begin(target, obs);
          return;
        case 'abandon':
          stop(action.why, action.sinceMono, {
            hesitation: action.reason,
            deadlineMono: action.deadlineMono,
          });
          block = action.why;
          return;
        case 'wait':
          block = action.why;
          return;
        case 'continue':
          block = null;
          return;
      }
    },

    async abandon(why) {
      stop(why, deps.clock.monoMs());
      await settling;
    },

    handOver(itemId) {
      const record = job;
      if (record === null || record.abandoned || record.itemId !== itemId) return null;
      // Out of the slot without being aborted: from this moment it is the current item's own
      // conversion (24k(b)), and this runner is free to prepare the item after it — but not
      // until that conversion has fully exited, which is the caller's `currentConversionOpen`.
      job = null;
      logger.info('lookahead.handed_over', {
        itemId,
        elapsedMs: deps.clock.monoMs() - record.startedAtMono,
      });
      deps.onChanged();
      return {
        itemId: record.itemId,
        request: record.request,
        abort: record.abort,
        startedAtMono: record.startedAtMono,
        done: record.done,
      };
    },

    async dispose() {
      stop('the app is closing', deps.clock.monoMs());
      await settling;
    },
  };
}
