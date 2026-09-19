import { describe, expect, it } from 'vitest';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import { LOOKAHEAD } from '../../src/engine/config.js';
import {
  createLookaheadRunner,
  type LookaheadTarget,
} from '../../src/engine/queue/lookahead-runner.js';
import type { PlaybackObservation } from '../../src/engine/queue/lookahead.js';
import type {
  PreparationPipeline,
  PreparationResult,
  PrepareRequest,
} from '../../src/engine/prepare/index.js';
import type { SessionFlags } from '../../src/engine/types.js';
import { probeOf, report } from './fixtures/ffprobe.js';

/**
 * **One job, and never two** — criteria 24f, 24g and 24ac's abandonment half.
 *
 * The rules are proved next door in `queue-lookahead.test.ts`; this is the machinery around
 * them. The pipeline is a stub whose jobs resolve when the test says so, because the whole
 * of what is under test here is *when the slot is occupied* — and a pipeline that resolved
 * on its own would make the interesting window (a job that has been told to stop and has not
 * finished stopping) unobservable.
 */

const NO_FLAGS: SessionFlags = {
  reconnecting: false,
  reattaching: false,
  yielded: false,
  networkDown: false,
};

interface StubJob {
  readonly request: PrepareRequest;
  readonly signal: AbortSignal;
  finish(result: PreparationResult): void;
}

function stubPipeline(): { pipeline: PreparationPipeline; jobs: StubJob[] } {
  const jobs: StubJob[] = [];
  const pipeline: PreparationPipeline = {
    findPrepared: () => Promise.resolve(null),
    prepare: (request, _events, signal) =>
      new Promise<PreparationResult>((resolve) => {
        jobs.push({ request, signal, finish: resolve });
      }),
    prepareWithHeadStart: () => {
      throw new Error(
        'look-ahead must never take the head-start path: it would sweep the segment folder ' +
          'the television is playing from',
      );
    },
  };
  return { pipeline, jobs };
}

function requestFor(name: string): PrepareRequest {
  const probe = probeOf(report({ durationSec: 1_200, sizeBytes: 1_000 }));
  return {
    source: { path: `/films/${name}.mkv`, name: `${name}.mkv`, sizeBytes: 1_000, mtimeMs: 1 },
    sourceProbe: probe,
    verdict: {
      kind: 'convert',
      tier: 3,
      plan: {
        kind: 'transcode',
        container: 'mp4',
        video: 'h264',
        audio: 'aac',
        subtitleTracks: [],
      },
      estimateSeconds: 300,
      estimatedBytes: 1_000,
      headline: 'Needs converting — about 5 minutes',
      reason: null,
      subtitleNotice: null,
      requiresConfirmation: false,
      detail: {
        profileId: 'test',
        container: 'mp4',
        durationSec: 1_200,
        sizeBytes: 1_000,
        video: null,
        audio: [],
        subtitles: [],
        reasonCode: null,
      },
    },
    deviceProfile: {
      id: 'test',
      video: [],
      audio: [],
      containers: ['mp4'],
      maxAudioChannels: 2,
    },
  };
}

function build() {
  const sink = createMemorySink();
  const { pipeline, jobs } = stubPipeline();
  let now = 1_000;
  const prepared: string[] = [];
  let pushes = 0;
  const runner = createLookaheadRunner({
    logger: createLogger({ sink, bindings: {} }),
    clock: { monoMs: () => now },
    pipeline: () => pipeline,
    onChanged: () => {
      pushes += 1;
    },
    onPrepared: (itemId) => prepared.push(itemId),
  });

  const target = (itemId: string): LookaheadTarget => ({ itemId, request: requestFor(itemId) });

  /** Where the device says the film has got to. Moved by `playCleanly`, held by `freeze`. */
  let positionSec = 0;

  function playing(): PlaybackObservation {
    return {
      monoMs: now,
      state: 'playing',
      flags: NO_FLAGS,
      heldByGuard: false,
      currentConversionOpen: false,
      commanded: false,
      report: { monoMs: now, playerState: 'PLAYING', positionSec },
    };
  }

  function look(item: string | null): void {
    runner.observe(playing(), item === null ? null : target(item));
  }

  /** One device report a second, each showing the picture a second further on. */
  function playCleanly(seconds: number, item: string | null): void {
    for (let tick = 0; tick < seconds; tick += 1) {
      now += 1_000;
      positionSec += 1;
      look(item);
    }
  }

  /**
   * The device goes on reporting, on the same cadence, at the same position.
   *
   * The meanest hesitation there is: `playerState` stays PLAYING and only the number that
   * matters stops moving, so the rule has to *measure* the trouble rather than be told.
   */
  function freeze(reports: number, item: string | null): void {
    for (let tick = 0; tick < reports; tick += 1) {
      now += 1_000;
      look(item);
    }
  }

  return {
    runner,
    jobs,
    prepared,
    target,
    look,
    playCleanly,
    freeze,
    get pushes() {
      return pushes;
    },
    advance(ms: number) {
      now += ms;
    },
    get now() {
      return now;
    },
    /** Finish the job the pipeline is holding, as a cancelled one — the abandonment case. */
    finishCancelled(index = 0) {
      kitJobs(jobs, index).finish({ ok: false, failure: { kind: 'cancelled' } });
    },
    lines: () => sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

function kitJobs(jobs: readonly StubJob[], index: number): StubJob {
  const job = jobs[index];
  if (job === undefined) throw new Error(`no job at ${String(index)}`);
  return job;
}

const SETTLE_SEC = LOOKAHEAD.cleanPlayBeforeStartMs / 1_000;

describe('one job, one item ahead, and never a second (24g)', () => {
  it('starts exactly one job however often it is looked at', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    expect(kit.jobs).toHaveLength(1);
    expect(kit.jobs[0]?.request.source.name).toBe('two.mkv');
    // Twenty more looks at a film that is still playing perfectly well.
    kit.playCleanly(20, 'two');
    expect(kit.jobs).toHaveLength(1);
    kit.finishCancelled();
    await kit.runner.dispose();
  });

  it('will not start a second job while the first is still stopping', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    expect(kit.jobs).toHaveLength(1);

    // The picture freezes. The job is told to stop — and the pipeline has **not** resolved,
    // which is the real window: ffmpeg is being killed and the staging file removed.
    kit.freeze(1, 'two');
    expect(kit.jobs[0]?.signal.aborted).toBe(true);

    // The film recovers and plays cleanly for another minute while the first job is still
    // exiting. **Nothing may start.**
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    expect(kit.jobs).toHaveLength(1);

    // Only once it has really gone does the slot free up.
    kit.finishCancelled();
    await kit.runner.abandon('the test is waiting for the slot');
    kit.playCleanly(2, 'two');
    expect(kit.jobs).toHaveLength(2);
    kit.finishCancelled(1);
    await kit.runner.dispose();
  });
});

describe('abandoning (24i, 24d, 24f)', () => {
  it('aborts the job and takes the row’s progress with it, saying nothing', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    expect(kit.runner.job?.itemId).toBe('two');

    kit.freeze(1, 'two');
    // 24ac: **no ghost of the abandoned percentage.** The row is back to its plain verdict
    // the instant we give up, not when the process finally exits.
    expect(kit.runner.job).toBeNull();
    expect(kit.jobs[0]?.signal.aborted).toBe(true);

    kit.finishCancelled();
    await kit.runner.abandon('settling');
    // Nothing about an abandonment is announced — it is a log line and no more.
    expect(kit.lines().map((line) => line['event'])).toContain('lookahead.abandoned');
  });

  it('measures the five seconds from the device’s own first missed sample', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    // The last report in which the picture actually moved. The freeze begins here, and is
    // only **visible** on the next report a second later.
    const lastMovedAtMono = kit.now;
    kit.freeze(1, 'two');
    expect(kit.now).toBe(lastMovedAtMono + 1_000);

    kit.finishCancelled();
    await kit.runner.abandon('settling');

    const abandoned = kit.lines().find((line) => line['event'] === 'lookahead.abandoned');
    expect(abandoned?.['sinceHesitationMs']).toBe(kit.now - lastMovedAtMono);
    expect(abandoned?.['withinBudget']).toBe(true);
    expect(abandoned?.['budgetMs']).toBe(LOOKAHEAD.abandonWithinMs);
  });

  it('says so loudly when the budget is missed, rather than in a comment', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    kit.freeze(1, 'two');
    // A wedged encoder: the kill is not answered for half a minute.
    kit.advance(30_000);
    kit.finishCancelled();
    await kit.runner.abandon('settling');

    const slow = kit.lines().find((line) => line['event'] === 'lookahead.abandon_slow');
    expect(slow).toBeDefined();
    expect(slow?.['level']).toBe('warn');
    expect(slow?.['sinceHesitationMs']).toBeGreaterThan(LOOKAHEAD.abandonWithinMs);
  });

  it('abandons a job for an item that is no longer next (24f)', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    expect(kit.jobs).toHaveLength(1);

    // The founder reorders: item three is next now.
    kit.advance(1_000);
    kit.look('three');
    expect(kit.jobs[0]?.signal.aborted).toBe(true);
    expect(kit.runner.job).toBeNull();
    // **And no second job before the first has stopped**, even though there is now work.
    kit.playCleanly(SETTLE_SEC + 10, 'three');
    expect(kit.jobs).toHaveLength(1);

    kit.finishCancelled();
    await kit.runner.abandon('the test is waiting for the slot');
    kit.playCleanly(2, 'three');
    expect(kit.jobs).toHaveLength(2);
    expect(kit.jobs[1]?.request.source.name).toBe('three.mkv');
    kit.finishCancelled(1);
    await kit.runner.dispose();
  });

  it('does not re-run a preparation that already finished (24f)', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    kit.jobs[0]?.finish({
      ok: true,
      artifact: {
        path: '/films/two (CastGood).mp4',
        probe: probeOf(report({ durationSec: 1_200, sizeBytes: 1_000 })),
        bytes: 1_000,
        tier: 3,
        fallbackDirectory: null,
      },
    });
    await kit.runner.abandon('waiting for the job to land');
    expect(kit.prepared).toEqual(['two']);

    // The engine stops offering that item as work once it is prepared — which is what
    // `lookaheadTarget` does with `findPrepared`'s answer. Offering `null` here is that.
    kit.playCleanly(SETTLE_SEC + 10, null);
    expect(kit.jobs).toHaveLength(1);
  });
});

describe('handing the job over when the item becomes current (24y, 24k(b))', () => {
  it('takes it out of the slot without killing it', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    const adopted = kit.runner.handOver('two');
    expect(adopted?.itemId).toBe('two');
    // The same job, still running. Abandoning and restarting it at the join would throw
    // away everything look-ahead exists to have done.
    expect(kit.jobs[0]?.signal.aborted).toBe(false);
    expect(kit.runner.job).toBeNull();
    kit.finishCancelled();
    await adopted?.done;
    await kit.runner.dispose();
  });

  it('refuses to hand over a job for a different item', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    expect(kit.runner.handOver('three')).toBeNull();
    expect(kit.runner.job?.itemId).toBe('two');
    kit.finishCancelled();
    await kit.runner.dispose();
  });
});

describe('the app closing (P6)', () => {
  it('stops the job and waits for it to have stopped', async () => {
    const kit = build();
    kit.playCleanly(SETTLE_SEC + 10, 'two');
    let settled = false;
    const closing = kit.runner.dispose().then(() => {
      settled = true;
    });
    expect(kit.jobs[0]?.signal.aborted).toBe(true);
    await Promise.resolve();
    expect(settled).toBe(false);
    kit.finishCancelled();
    await closing;
    expect(settled).toBe(true);
  });
});
