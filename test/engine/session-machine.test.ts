import { describe, expect, it } from 'vitest';
import { INITIAL_SESSION, reduce } from '../../src/engine/session/machine.js';
import type {
  SessionEffect,
  SessionEvent,
  SessionModel,
} from '../../src/engine/session/machine.js';
import type { PlaybackPosition } from '../../src/engine/types.js';
import { TIMING } from '../../src/engine/config.js';

/**
 * The reducer is where "the app never shows a state it merely assumes" is decided, so it
 * is tested as a rule rather than as a screen. Every transition here maps to a row in the
 * PRD's state tables.
 */

function position(sec: number): PlaybackPosition {
  return { reportedSec: sec, reportedAtMono: sec * 1_000, durationSec: 3_600 };
}

function run(
  model: SessionModel,
  events: SessionEvent[],
): { model: SessionModel; effects: SessionEffect[] } {
  let current = model;
  const effects: SessionEffect[] = [];
  for (const event of events) {
    const transition = reduce(current, event);
    current = transition.model;
    effects.push(...transition.effects);
  }
  return { model: current, effects };
}

const casting: SessionEvent[] = [
  { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
  { type: 'device.connected' },
  // The socket is up; the television is not. `loading` — *Starting on \<name\>…* —
  // begins only once the receiver has really been woken, which is what keeps a silently
  // retried LAUNCH inside one continuous *Connecting to \<name\>…* (3b).
  { type: 'device.launched' },
  { type: 'device.loaded' },
  {
    type: 'device.status',
    playerState: 'BUFFERING',
    position: position(0),
    monoMs: 0 * 1_000,
    seekHeld: false,
  },
  {
    type: 'device.status',
    playerState: 'PLAYING',
    position: position(1),
    monoMs: 1 * 1_000,
    seekHeld: false,
  },
];

describe('casting', () => {
  it('walks connecting → loading → buffering → playing, asking for a connection and a load', () => {
    const states: string[] = [];
    let model = INITIAL_SESSION;
    const effects: SessionEffect[] = [];
    for (const event of casting) {
      const transition = reduce(model, event);
      model = transition.model;
      effects.push(...transition.effects);
      states.push(model.state);
    }
    expect(states).toEqual([
      'connecting',
      'connecting',
      'loading',
      'loading',
      'buffering',
      'playing',
    ]);
    // `seek.release_hold` leads every session boundary: a new cast must never inherit a
    // held playhead from the last one.
    // `recover.cancel` rides along on every cast: *Take it back* (14c) and *Reconnect*
    // (11c) both arrive here, and a recovery loop still probing the old connection would
    // fight the new one for the same television.
    expect(effects.map((effect) => effect.type)).toEqual([
      'seek.release_hold',
      'recover.cancel',
      'connect',
      'load',
    ]);
  });

  it('reports an unreachable device without losing the device selection', () => {
    const { model, effects } = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      {
        type: 'device.connect_failed',
        reason: 'ECONNREFUSED',
        userMessage: "Couldn't reach Family room TV",
      },
    ]);
    expect(model.state).toBe('idle');
    expect(model.deviceId).toBe('tv-1');
    expect(model.error).toEqual({
      userMessage: "Couldn't reach Family room TV",
      actionLabel: 'Try again',
      kind: 'generic',
    });
    expect(effects.some((effect) => effect.type === 'release')).toBe(true);
  });

  it('returns to ready with a plain-language message when the device refuses the file', () => {
    const { model } = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      { type: 'device.connected' },
      { type: 'device.launched' },
      { type: 'device.load_rejected', detail: 'LOAD_FAILED' },
    ]);
    expect(model.state).toBe('idle');
    expect(model.error?.userMessage).toBe("Couldn't play this file");
    // Nothing technical leaks into what the founder is shown.
    expect(model.error?.userMessage).not.toContain('LOAD_FAILED');
  });

  it('treats an IDLE/ERROR arriving during load as a refused file', () => {
    const { model } = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      { type: 'device.connected' },
      { type: 'device.launched' },
      { type: 'device.idle', idleReason: 'ERROR', positionSec: null },
    ]);
    expect(model.error?.userMessage).toBe("Couldn't play this file");
  });
});

describe('transport', () => {
  it('paints Paused immediately and sends one PAUSE', () => {
    const started = run(INITIAL_SESSION, casting);
    const { model, effects } = run(started.model, [{ type: 'intent.pause', monoMs: 10_000 }]);
    expect(model.state).toBe('paused');
    expect(model.confirmedState).toBe('playing');
    expect(model.optimisticUntilMono).toBe(10_000 + TIMING.optimisticWindowMs);
    expect(effects).toEqual([{ type: 'send.pause' }]);
  });

  it('clears the optimistic window once the device agrees', () => {
    const started = run(INITIAL_SESSION, casting);
    const { model } = run(started.model, [
      { type: 'intent.pause', monoMs: 10_000 },
      {
        type: 'device.status',
        playerState: 'PAUSED',
        position: position(1),
        monoMs: 1 * 1_000,
        seekHeld: false,
      },
    ]);
    expect(model.state).toBe('paused');
    expect(model.confirmedState).toBe('paused');
    expect(model.optimisticUntilMono).toBeNull();
    expect(model.pending).toBeNull();
  });

  it('reverts the display and retries once when the device never confirms (4d)', () => {
    const started = run(INITIAL_SESSION, casting);
    const paused = run(started.model, [{ type: 'intent.pause', monoMs: 10_000 }]);

    // Inside the window the display holds, even though the device still says PLAYING.
    const holding = run(paused.model, [
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(2),
        monoMs: 2 * 1_000,
        seekHeld: false,
      },
      { type: 'timer.tick', monoMs: 11_000 },
    ]);
    expect(holding.model.state).toBe('paused');

    // At 2 s it reverts to what the device reports, and sends the command again.
    const expired = run(holding.model, [{ type: 'timer.tick', monoMs: 12_000 }]);
    expect(expired.model.state).toBe('playing');
    expect(expired.effects.filter((effect) => effect.type === 'send.pause')).toHaveLength(1);
    expect(expired.model.pending?.retried).toBe(true);

    // And only once: a second expiry gives up rather than hammering the device.
    const again = run(expired.model, [{ type: 'timer.tick', monoMs: 20_000 }]);
    expect(again.effects.filter((effect) => effect.type === 'send.pause')).toHaveLength(0);
  });

  it('follows a state the device reports without being asked (4c)', () => {
    const started = run(INITIAL_SESSION, casting);
    const { model } = run(started.model, [
      {
        type: 'device.status',
        playerState: 'PAUSED',
        position: position(30),
        monoMs: 30 * 1_000,
        seekHeld: false,
      },
    ]);
    expect(model.state).toBe('paused');
    expect(model.position?.reportedSec).toBe(30);
  });

  it('ignores play and pause while there is nothing playing', () => {
    expect(reduce(INITIAL_SESSION, { type: 'intent.pause', monoMs: 1 }).effects).toEqual([]);
    expect(reduce(INITIAL_SESSION, { type: 'intent.play', monoMs: 1 }).effects).toEqual([]);
  });

  it('resumes from the paused position, not from zero', () => {
    const started = run(INITIAL_SESSION, casting);
    const { model } = run(started.model, [
      {
        type: 'device.status',
        playerState: 'PAUSED',
        position: position(600),
        monoMs: 600 * 1_000,
        seekHeld: false,
      },
      { type: 'intent.play', monoMs: 5_000 },
    ]);
    expect(model.state).toBe('playing');
    expect(model.resumePositionSec).toBe(600);
  });
});

describe('stopping and ending', () => {
  it('stops, remembers the position and releases the device', () => {
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(1_930),
        monoMs: 1_930 * 1_000,
        seekHeld: false,
      },
    ]);
    // `atSec` is the readout at the instant Stop was pressed — which is what the founder
    // saw, and what the Stopped screen must show them.
    const { model, effects } = run(started.model, [{ type: 'intent.stop', atSec: 1_930 }]);
    expect(model.state).toBe('stopped');
    expect(model.resumePositionSec).toBe(1_930);
    expect(effects.map((effect) => effect.type)).toEqual([
      'seek.release_hold',
      'recover.cancel',
      'send.stop',
      'release',
    ]);
  });

  it('saves the position the device reported when it stopped, not the one we extrapolated', () => {
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(598.562),
        monoMs: 598.562 * 1_000,
        seekHeld: false,
      },
    ]);
    // The founder presses Stop; the device answers a moment later with where it got to.
    const stopped = run(started.model, [{ type: 'intent.stop', atSec: 598.562 }]);
    const { model } = run(stopped.model, [
      { type: 'device.idle', idleReason: 'CANCELLED', positionSec: 599.081 },
    ]);
    expect(model.resumePositionSec).toBeCloseTo(599.081, 3);
  });

  it('keeps the position it had when the device reports a final one it cannot trust', () => {
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(402.311),
        monoMs: 402.311 * 1_000,
        seekHeld: false,
      },
    ]);
    const stopped = run(started.model, [{ type: 'intent.stop', atSec: 402.311 }]);
    // The supervisor rejected the device's claim, so it passes null rather than a figure
    // it does not believe. The saved position must survive that untouched.
    const { model } = run(stopped.model, [
      { type: 'device.idle', idleReason: 'CANCELLED', positionSec: null },
    ]);
    expect(model.resumePositionSec).toBeCloseTo(402.311, 3);
  });

  it('reaches `ended`, not `stopped`, when the file plays out — and remembers the end', () => {
    const started = run(INITIAL_SESSION, casting);
    const { model, effects } = run(started.model, [
      { type: 'device.idle', idleReason: 'FINISHED', positionSec: null },
    ]);
    // Two different rows in the PRD's state table, and two different things the founder is
    // told: a film that reached its end, versus a place they saved.
    expect(model.state).toBe('ended');
    expect(model.resumePositionSec).toBe(3_600);
    expect(effects.map((effect) => effect.type)).toEqual([
      'seek.release_hold',
      'recover.cancel',
      'send.stop',
      'release',
      'log',
    ]);
  });

  it('ignores an IDLE with no reason while loading, instead of ending a good session', () => {
    const loading = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      { type: 'device.connected' },
      { type: 'device.launched' },
    ]);
    expect(loading.model.state).toBe('loading');

    // A status poll landing between LAUNCH and the first PLAYING reports exactly this.
    for (const idleReason of [null, 'CANCELLED', 'INTERRUPTED']) {
      const { model, effects } = run(loading.model, [
        { type: 'device.idle', idleReason, positionSec: null },
      ]);
      expect(model.state, `idleReason ${String(idleReason)}`).toBe('loading');
      expect(effects.some((effect) => effect.type === 'release')).toBe(false);
      expect(effects.map((effect) => effect.type)).toEqual(['log']);
    }
  });

  it('still treats an IDLE/ERROR while loading as a refused file', () => {
    const loading = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      { type: 'device.connected' },
      { type: 'device.launched' },
    ]);
    const { model } = run(loading.model, [
      { type: 'device.idle', idleReason: 'ERROR', positionSec: null },
    ]);
    expect(model.error?.userMessage).toBe("Couldn't play this file");
  });

  it('does not resurrect a finished session from a late status', () => {
    const ended = run(INITIAL_SESSION, [
      ...casting,
      { type: 'device.idle', idleReason: 'FINISHED', positionSec: null },
    ]);
    const { model } = run(ended.model, [
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(5),
        monoMs: 5 * 1_000,
        seekHeld: false,
      },
    ]);
    expect(model.state).toBe('ended');
  });

  it('does not stop or re-release a session that already ended', () => {
    const ended = run(INITIAL_SESSION, [
      ...casting,
      { type: 'device.idle', idleReason: 'FINISHED', positionSec: null },
    ]);
    expect(run(ended.model, [{ type: 'intent.stop', atSec: 0 }]).effects).toEqual([]);
    expect(
      run(ended.model, [
        {
          type: 'device.disconnected',
          reason: 'socket closed',
          userMessage: 'Lost connection',
          monoMs: 0,
        },
      ]).effects,
    ).toEqual([]);
  });

  it('starts recovering on a disconnect rather than ending the session (11a)', () => {
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(120),
        monoMs: 120 * 1_000,
        seekHeld: false,
      },
    ]);
    const { model, effects } = run(started.model, [
      {
        type: 'device.disconnected',
        reason: 'socket closed',
        userMessage: 'Lost connection to Family room TV',
        monoMs: 1_000,
      },
    ]);
    // 11a: "the file, position and scrubber all stay exactly where they were — only the
    // status line changes". M1 ended the session here; M2 keeps it and reconnects.
    expect(model.state).toBe('playing');
    expect(model.flags.reconnecting).toBe(true);
    expect(model.resumePositionSec).toBe(120);
    expect(model.error).toBeNull();
    expect(effects.map((effect) => effect.type)).toEqual(['seek.release_hold', 'recover', 'log']);
  });

  it('says "Lost connection" only after the reconnect budget, with the place saved (11c)', () => {
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(120),
        monoMs: 120 * 1_000,
        seekHeld: false,
      },
    ]);
    const dropped = run(started.model, [
      {
        type: 'device.disconnected',
        reason: 'socket closed',
        userMessage: 'Lost connection to Family room TV',
        monoMs: 1_000,
      },
    ]);

    // One second short of the budget the founder is still told nothing but "Reconnecting".
    const early = run(dropped.model, [
      { type: 'timer.tick', monoMs: 1_000 + TIMING.reconnectBudgetMs - 1_000 },
    ]);
    expect(early.model.error).toBeNull();
    expect(early.model.flags.reconnecting).toBe(true);

    const late = run(dropped.model, [
      { type: 'timer.tick', monoMs: 1_000 + TIMING.reconnectBudgetMs },
    ]);
    expect(late.model.state).toBe('stopped');
    expect(late.model.error?.kind).toBe('lost-connection');
    expect(late.model.error?.actionLabel).toBe('Reconnect');
    expect(late.model.resumePositionSec).toBe(120);
  });

  it('does not let a stale takeover destroy the session that replaced it', () => {
    const playing = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(1_930),
        monoMs: 1_930 * 1_000,
        seekHeld: false,
      },
    ]);

    // The founder pressed Stop. The place they got to is saved, honestly, at 1,930 s.
    const stopped = run(playing.model, [{ type: 'intent.stop', atSec: 1_930 }]);
    expect(stopped.model.resumePositionSec).toBe(1_930);

    // An old recovery loop now finishes closing its probe and reports what it found. It is
    // an answer to a question nobody is asking any more: it must not overwrite the saved
    // position, and it must not claim a television is playing YouTube.
    const late = run(stopped.model, [
      { type: 'recovery.yielded', appId: '233637DE', appName: 'YouTube', atSec: 0 },
    ]);
    expect(late.model.resumePositionSec).toBe(1_930);
    expect(late.model.flags.yielded).toBe(false);
    expect(late.model.yieldedTo).toBeNull();
    expect(late.effects.map((effect) => effect.type)).toEqual(['log']);

    // The same event while a *new* cast is connecting — which is what a real Chromecast
    // broadcasts on its way to launching our receiver, and what 14c's *Take it back* is.
    const connecting = run(stopped.model, [
      { type: 'intent.cast', deviceId: 'tv-2', startPositionSec: 0 },
    ]);
    const during = run(connecting.model, [
      { type: 'recovery.yielded', appId: '233637DE', appName: 'YouTube', atSec: 0 },
    ]);
    expect(during.model.state).toBe('connecting');
    expect(during.model.flags.yielded).toBe(false);
  });

  it('starts 11e\u2019s ten-second patience when the buffer began, not when the anchor was set', () => {
    // The defect this replaces: `bufferingSinceMono` was seeded from
    // `position.reportedAtMono`, which is the last time the device reported a *position*.
    // A device that reports no `currentTime` never re-anchors, so on a film 20 minutes in
    // the stopwatch started 20 minutes in the past and 11e fired on the first buffering
    // status \u2014 tearing down a healthy connection during an ordinary rebuffer.
    const stale: PlaybackPosition = {
      reportedSec: 1_200,
      reportedAtMono: 10_000,
      durationSec: 3_600,
    };
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: stale,
        monoMs: 10_000,
        seekHeld: false,
      },
    ]);

    // Twenty minutes later the device says BUFFERING and carries the same old anchor.
    const buffering = run(started.model, [
      {
        type: 'device.status',
        playerState: 'BUFFERING',
        position: stale,
        monoMs: 1_210_000,
        seekHeld: false,
      },
    ]);
    expect(buffering.model.state).toBe('buffering');
    expect(buffering.model.bufferingSinceMono).toBe(1_210_000);

    // One second in, this is an ordinary rebuffer and nothing happens to it.
    const patient = run(buffering.model, [{ type: 'timer.tick', monoMs: 1_211_000 }]);
    expect(patient.model.recovery).toBeNull();
    expect(patient.model.flags.reconnecting).toBe(false);

    // Ten seconds in \u2014 measured from the buffer, which is what 11e says \u2014 it becomes a
    // recovery attempt rather than an indefinite spinner.
    const late = run(buffering.model, [
      { type: 'timer.tick', monoMs: 1_210_000 + TIMING.bufferingRecoveryMs },
    ]);
    expect(late.model.recovery?.cause).toBe('stalled');
    expect(late.model.flags.reconnecting).toBe(true);
  });

  it('ignores a status that arrives after the session ended', () => {
    const stopped = run(INITIAL_SESSION, [...casting, { type: 'intent.stop', atSec: 0 }]);
    const { model } = run(stopped.model, [
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(99),
        monoMs: 99 * 1_000,
        seekHeld: false,
      },
    ]);
    expect(model.state).toBe('stopped');
  });

  it('starts a completely fresh session when Cast is pressed again', () => {
    const stopped = run(INITIAL_SESSION, [...casting, { type: 'intent.stop', atSec: 0 }]);
    const { model } = run(stopped.model, [
      { type: 'intent.cast', deviceId: 'tv-2', startPositionSec: 0 },
    ]);
    expect(model.state).toBe('connecting');
    expect(model.deviceId).toBe('tv-2');
    expect(model.error).toBeNull();
    expect(model.position).toBeNull();
  });
});

/**
 * **Criterion 13g — an ending and a refusal are different facts.**
 *
 * The evidence, from `docs/STATUS.md` 2026-08-24: a 113-minute film cast to the Chromecast
 * Ultra reached `PLAYING` at `deviceSec 0` and went `IDLE` with `idleReason: ERROR` **81 ms**
 * later, `trigger: device.idle` — the television quit on its own, nobody having pressed
 * stop. The engine logged `session.reached_end`, the selftest's `firstStateSequence: reached
 * playing` went green on the strength of it, the run scored 9/9, and *that verdict was
 * written into the PRD as a measurement of a television decoding 5.1 audio*. It had measured
 * a corpse. This is the first time a misleading log line in this project has cost a wrong
 * fact in a live decision rather than a confusing evening.
 *
 * Every case below was watched red against the pre-13g reducer, where the single
 * `session.reached_end` effect was emitted for every `idleReason` there is.
 */
describe('13g — a film that dies is not a film that finished', () => {
  const logsOf = (effects: SessionEffect[]): { event: string; fields: Record<string, unknown> }[] =>
    effects.flatMap((effect) =>
      effect.type === 'log' ? [{ event: effect.event, fields: effect.fields ?? {} }] : [],
    );

  it('logs the 81 ms death as a refusal carrying the position and the reason', () => {
    const started = run(INITIAL_SESSION, casting);
    expect(started.model.state).toBe('playing');

    // The television's own numbers: it had reported position 0 and gave up 81 ms later.
    const { model, effects } = run(started.model, [
      { type: 'device.idle', idleReason: 'ERROR', positionSec: 0.232 },
    ]);

    const logs = logsOf(effects);
    expect(logs.map((entry) => entry.event)).toEqual(['session.refused_mid_play']);
    expect(logs[0]?.fields).toEqual({
      idleReason: 'ERROR',
      positionSec: 0.232,
      durationSec: 3_600,
      // The "while CastGood believes a film is playing" half of the criterion, recorded
      // rather than inferred: a reader of the log can see we were not expecting this.
      believedState: 'playing',
    });
    // Everything else about the transition is unchanged — the session is over, the device
    // is handed back, and the founder is told what happened rather than "your place is saved".
    expect(model.state).toBe('stopped');
    expect(model.error?.userMessage).toBe('The TV stopped playing this file');
    expect(effects.map((effect) => effect.type)).toEqual([
      'seek.release_hold',
      'recover.cancel',
      'send.stop',
      'release',
      'log',
    ]);
  });

  it('never writes `session.reached_end` for any `idleReason` but `FINISHED`', () => {
    // The criterion's failure clause, swept rather than sampled. `INTERRUPTED` and a
    // missing reason are in here too: a device that stops reporting one is not a device
    // that reached the credits, and "we could not tell" must never round up to "it ended".
    const started = run(INITIAL_SESSION, casting);
    for (const idleReason of ['ERROR', 'CANCELLED', 'INTERRUPTED', 'error', null]) {
      const { effects } = run(started.model, [
        { type: 'device.idle', idleReason, positionSec: 12.5 },
      ]);
      const events = logsOf(effects).map((entry) => entry.event);
      expect(events, `idleReason ${String(idleReason)}`).toEqual(['session.refused_mid_play']);
    }

    // …and the one reason that is an ending still is one, with no refusal beside it.
    const finished = run(started.model, [
      { type: 'device.idle', idleReason: 'FINISHED', positionSec: null },
    ]);
    expect(logsOf(finished.effects)).toEqual([
      { event: 'session.reached_end', fields: { idleReason: 'FINISHED' } },
    ]);
    expect(finished.model.state).toBe('ended');
  });

  it('keeps a deliberate stop looking like a deliberate stop', () => {
    // **The rule that stops 13g eating every ordinary evening.** A real television answers
    // our own STOP with `IDLE`/`idleReason: CANCELLED`, which is byte-for-byte a reason that
    // is not `FINISHED` — tonight's logs are full of them, two per scenario. What separates
    // them is not the reason but *who asked*: `intent.stop` moves the model to `stopped`
    // before the reply can arrive, so the device's last word lands in the already-over
    // branch and updates the saved position without logging anything at all.
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(402.678),
        monoMs: 402.678 * 1_000,
        seekHeld: false,
      },
    ]);
    const stopped = run(started.model, [{ type: 'intent.stop', atSec: 402.678 }]);
    const { model, effects } = run(stopped.model, [
      { type: 'device.idle', idleReason: 'CANCELLED', positionSec: 402.9 },
    ]);

    expect(logsOf(effects)).toEqual([]);
    expect(model.state).toBe('stopped');
    expect(model.resumePositionSec).toBeCloseTo(402.9, 3);
    // No sentence about a television that stopped playing: nothing went wrong here.
    expect(model.error).toBeNull();
  });

  it('reports the last position we knew when the device will not say where it got to', () => {
    // The founder's own set answers a stop at 402.678 s with `currentTime: 0`, and the
    // supervisor passes `null` rather than a figure it does not believe. A refusal that
    // logged 0 in that case would say "it died in the opening second" of a film somebody
    // had been watching for seven minutes — which is the same class of lie 13g exists for.
    const started = run(INITIAL_SESSION, [
      ...casting,
      {
        type: 'device.status',
        playerState: 'PLAYING',
        position: position(1_284.5),
        monoMs: 1_284.5 * 1_000,
        seekHeld: false,
      },
    ]);
    const { effects } = run(started.model, [
      { type: 'device.idle', idleReason: 'ERROR', positionSec: null },
    ]);
    const fields = logsOf(effects)[0]?.fields;
    expect(fields?.['idleReason']).toBe('ERROR');
    expect(fields?.['positionSec']).toBeCloseTo(1_284.5, 1);
  });

  it('does not narrow a capability from a mid-play refusal — ADR 2026-08-19 stands', () => {
    // 7e hangs off `device.load_rejected`, and a mid-play death must not reach it. A load
    // the device *accepted* and then abandoned is not the same evidence as a load it
    // refused: on an HLS stream the identical bytes are produced by a CORS fault or an
    // invalid `TARGETDURATION` in our **own** media server, so narrowing the television's
    // profile from it would teach the capability table about a defect of ours. The rung
    // that would fire is `cap-audio-channels`, and it staying unfired here is deliberate.
    const started = run(INITIAL_SESSION, casting);
    const { effects } = run(started.model, [
      { type: 'device.idle', idleReason: 'ERROR', positionSec: 0.232 },
    ]);
    expect(logsOf(effects).map((entry) => entry.event)).not.toContain('session.load_rejected');
    // A refusal *before* the film ever played is the other case, and it is untouched: that
    // one does route into 7e, because a load the device never accepted is exactly the fact
    // the ladder is built on.
    const loading = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      { type: 'device.connected' },
      { type: 'device.launched' },
    ]);
    const rejected = run(loading.model, [
      { type: 'device.idle', idleReason: 'ERROR', positionSec: null },
    ]);
    expect(logsOf(rejected.effects).map((entry) => entry.event)).toEqual(['session.load_rejected']);
  });
});

/**
 * **A LOAD of our own is not the television abandoning the film** — defect D2, second half,
 * found on hardware on 2026-08-28.
 *
 * The D2 repair hands a starved television the film again with a LOAD on the connection
 * that is already open. A receiver takes that LOAD by ending the media session it is
 * holding and reporting it: `IDLE` with `idleReason: "INTERRUPTED"`, for media we have just
 * replaced. On the `Family room TV` that arrived **101 ms** after the repair, and the
 * reducer — which had nothing to tell it apart from a set that had quit — moved the session
 * to `stopped` and wrote `session.refused_mid_play`. The repair had worked: bytes flowed
 * again 60 ms later and the film was `PLAYING` a second after that. 13g's guard read the
 * refusal, correctly demoted every assertion in the run, and reported **0/18**.
 *
 * `endOfSessionLog` states the invariant this restores: *"a deliberate stop never reaches
 * here, and that is by construction rather than by a test on the reason"*. `intent.stop`
 * moves the model before the device's reply can arrive; so, now, does a LOAD we issue
 * underneath a playing film.
 */
describe('D2 — a LOAD we issued is not a refusal', () => {
  const logsOf = (effects: SessionEffect[]): { event: string; fields: Record<string, unknown> }[] =>
    effects.flatMap((effect) =>
      effect.type === 'log' ? [{ event: effect.event, fields: effect.fields ?? {} }] : [],
    );

  const playing = (): SessionModel => run(INITIAL_SESSION, casting).model;

  const repairing = (atMono = 10_000): SessionModel =>
    run(playing(), [{ type: 'session.live_load_started', why: 'repair', monoMs: atMono }]).model;

  it('ignores the superseded media session’s IDLE while the repair LOAD is in flight', () => {
    // The founder's own line, replayed: IDLE/INTERRUPTED at 21.961 s while we believed the
    // film was playing, 101 ms after the repair went out.
    const { model, effects } = run(repairing(), [
      { type: 'device.idle', idleReason: 'INTERRUPTED', positionSec: 21.961 },
    ]);

    expect(model.state).toBe('playing');
    expect(logsOf(effects).map((entry) => entry.event)).toEqual([
      'session.idle_ignored_during_live_load',
    ]);
    expect(logsOf(effects)[0]?.fields['why']).toBe('repair');
    // Nothing is sent, nothing is released, and no error is put on screen: the interruption
    // is still in progress and 11c's deadline is what speaks about it.
    expect(effects.map((effect) => effect.type)).toEqual(['log']);
    expect(model.error).toBeNull();
  });

  it('is deaf for exactly as long as the LOAD is in flight, and no longer', () => {
    // **The direction that matters more.** 13g exists because a run once scored 9/9 against
    // a film that had been dead for twenty seconds; a fix that stopped trusting `IDLE`
    // would be worse than the bug. The window closes when the LOAD settles — and a
    // television that abandons the film a moment later, still inside the recovery, is
    // caught exactly as it was before.
    const settled = run(repairing(), [{ type: 'session.live_load_settled' }]).model;
    expect(settled.liveLoad).toBeNull();

    const { model, effects } = run(settled, [
      { type: 'device.idle', idleReason: 'INTERRUPTED', positionSec: 30 },
    ]);
    expect(logsOf(effects).map((entry) => entry.event)).toEqual(['session.refused_mid_play']);
    expect(model.state).toBe('stopped');
  });

  it('closes a window whose LOAD never came back at all', () => {
    // The belt, and it is the one that stops this being worse than the bug: a LOAD that
    // never settles would otherwise leave the session permanently deaf to a set that had
    // genuinely quit. `session.live_load_settled` is raised from a `finally`, so this can
    // only fire when a LOAD hung — by which time 11c's thirty seconds has long since
    // spoken.
    const stuck = repairing(1_000);
    const early = run(stuck, [{ type: 'timer.tick', monoMs: 1_000 + 5_000 }]);
    expect(early.model.liveLoad).not.toBeNull();

    const expired = run(stuck, [
      { type: 'timer.tick', monoMs: 1_000 + TIMING.liveLoadIdleWindowMs },
    ]);
    expect(expired.model.liveLoad).toBeNull();
    expect(logsOf(expired.effects).map((entry) => entry.event)).toEqual([
      'session.live_load_window_expired',
    ]);
    // And the very next refusal is heard.
    const { model, effects } = run(expired.model, [
      { type: 'device.idle', idleReason: 'ERROR', positionSec: 44 },
    ]);
    expect(logsOf(effects).map((entry) => entry.event)).toEqual(['session.refused_mid_play']);
    expect(model.state).toBe('stopped');
  });

  it('still hears a film that genuinely reached its end', () => {
    // `FINISHED` is the one reason no receiver gives for media it is superseding, and the
    // one an ending is made of. Swallowing it would turn 13g's other half — *Finished* and
    // *Play again* — into a film that never ends.
    const { model, effects } = run(repairing(), [
      { type: 'device.idle', idleReason: 'FINISHED', positionSec: null },
    ]);
    expect(logsOf(effects).map((entry) => entry.event)).toEqual(['session.reached_end']);
    expect(model.state).toBe('ended');
  });

  it('opens no window for the first LOAD of a session, which supersedes nothing', () => {
    // A LOAD onto a session that is not playing replaces nothing on the television, so
    // there is no `IDLE` of ours to expect and no reason to stop listening for anybody
    // else's. `session.idle_ignored_while_loading` already covers the poll that lands
    // between LAUNCH and the first PLAYING, and it is untouched.
    const connecting = run(INITIAL_SESSION, [
      { type: 'intent.cast', deviceId: 'tv-1', startPositionSec: 0 },
      { type: 'device.connected' },
      { type: 'session.live_load_started', why: 'subtitle', monoMs: 500 },
    ]);
    expect(connecting.model.liveLoad).toBeNull();
  });

  it('leaves a deliberate stop alone even mid-repair', () => {
    // The founder pressing Stop while a repair is in flight is still a stop: the model is
    // already `stopped` when the device's `CANCELLED` arrives, so it lands in the
    // already-over branch, saves the place, and logs nothing — exactly as it did before
    // this window existed.
    const stopped = run(repairing(), [{ type: 'intent.stop', atSec: 21.9 }]);
    const { model, effects } = run(stopped.model, [
      { type: 'device.idle', idleReason: 'CANCELLED', positionSec: 22.1 },
    ]);
    expect(logsOf(effects)).toEqual([]);
    expect(model.state).toBe('stopped');
    expect(model.resumePositionSec).toBeCloseTo(22.1, 3);
  });
});
