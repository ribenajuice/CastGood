import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink } from '../../src/engine/logging/index.js';
import type { LogRecord } from '../../src/engine/logging/index.js';
import { TIMING } from '../../src/engine/config.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * Milestone 2's acceptance criteria, driven through the whole engine.
 *
 * Everything here is **[logic]**. It runs headless in WSL against a scripted receiver over
 * a real socket, with the real media server serving a real file, and it proves the engine's
 * rules. It proves nothing whatsoever about a Chromecast: whether a real device lands where
 * it was asked to, how it reports a seek in progress, and how fast it gets there are the
 * `seek` and `skip` selftest scenarios and the founder's eyes.
 *
 * The criteria covered here are the ones that do **not** depend on SPIKE-2: seeking and
 * skipping (6a–6k), the source file vanishing (15a/15b), Finished and Resume (16a–16c), and
 * the firewall diagnosis (17a). Reconnection, takeover and reattach are absent on purpose —
 * their *shape* is decided by what a real television reports when a session is interrupted,
 * which has not been measured yet.
 */

interface FakeMdns extends Mdns {
  up(service: MdnsService): void;
}

function createFakeMdns(): FakeMdns {
  const active = new Set<MdnsHandlers>();
  const seen: MdnsService[] = [];
  return {
    browse(handlers) {
      active.add(handlers);
      for (const service of seen) handlers.onUp(service);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
    up(service) {
      seen.push(service);
      for (const handlers of [...active]) handlers.onUp(service);
    },
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

/** A 2-hour MP4 with its moov at the end — long enough for a 20-minute jump to mean something. */
function fixtureMp4(): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(7_200_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 7)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

const DURATION_SEC = 7_200;

let receiver: FakeReceiver;
let engine: Engine;
let mdns: FakeMdns;
let sink: ReturnType<typeof createMemorySink>;
let directory: string;
let filePath: string;

function records(): LogRecord[] {
  return sink.lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as LogRecord];
    } catch {
      return [];
    }
  });
}

function eventsOf(name: string): LogRecord[] {
  return records().filter((record) => record.event === name);
}

function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  timeoutMs = 10_000,
): Promise<StateSnapshot> {
  return new Promise((resolve, reject) => {
    if (predicate(engine.snapshot())) {
      resolve(engine.snapshot());
      return;
    }
    let unsubscribe = (): void => undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      reject(new Error('timed out waiting for a snapshot'));
    }, timeoutMs);
    unsubscribe = engine.subscribe((snapshot) => {
      if (!predicate(snapshot)) return;
      clearTimeout(timer);
      queueMicrotask(() => unsubscribe());
      resolve(snapshot);
    });
  });
}

const waitForState = (state: SessionState, timeoutMs = 10_000): Promise<StateSnapshot> =>
  waitFor((snapshot) => snapshot.session.state === state, timeoutMs);

/** Polls something about the receiver, which changes without the engine pushing anything. */
function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (predicate()) {
        clearInterval(poll);
        resolve();
        return;
      }
      if (Date.now() > deadline) {
        clearInterval(poll);
        reject(new Error('timed out waiting for the receiver'));
      }
    }, 5);
  });
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** Long enough for the coalescing window to close and the reply to come back. */
const settled = (): Promise<void> => sleep(TIMING.seekSettleMs + 250);

async function castAndPlay(): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filePath });
  await waitFor((snapshot) => snapshot.file !== null);
  engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
  engine.dispatch({ type: 'cast.start' });
  await waitForState('playing');
  // Wait for a duration to arrive: everything about clamping needs one, and it rides on
  // the LOAD response rather than on every status.
  await waitFor((snapshot) => snapshot.session.durationSec > 0);
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: DURATION_SEC, startupMs: 10 });
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-m2-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, fixtureMp4());

  mdns = createFakeMdns();
  sink = createMemorySink();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
    logSink: sink,
    logLevel: 'debug',
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
  });
  await engine.start();
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fs.rm(directory, { recursive: true, force: true });
});

// --- Seeking by drag — story 6 ----------------------------------------------

describe('6a–6e — dragging the progress bar', () => {
  it('lands within a second of the requested position and returns to Playing', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 3_600 });

    // 6b: the readout shows the *destination* the moment the drag is released, before
    // anything has reached the device.
    expect(engine.snapshot().session.seek?.targetSec).toBe(3_600);
    expect(engine.snapshot().session.positionSec).toBeCloseTo(3_600, 1);

    await waitFor(
      (snapshot) => snapshot.session.seek === null && snapshot.session.state === 'playing',
    );
    expect(Math.abs(engine.snapshot().session.positionSec - 3_600)).toBeLessThanOrEqual(1);
  });

  it('sends exactly one SEEK per drag, and nothing at all during it', async () => {
    await castAndPlay();
    const before = receiver.countOf('SEEK');
    engine.dispatch({ type: 'playback.seek', positionSec: 1_200 });
    await settled();
    expect(receiver.countOf('SEEK') - before).toBe(1);
  });

  it('issues only the final position when five seeks arrive in a burst (6d)', async () => {
    await castAndPlay();
    const before = receiver.countOf('SEEK');
    for (const target of [600, 1_200, 1_800, 2_400, 3_000]) {
      engine.dispatch({ type: 'playback.seek', positionSec: target });
    }
    await settled();
    // One command, for the last destination asked for — not five, and not the first.
    expect(receiver.countOf('SEEK') - before).toBe(1);
    const issued = eventsOf('session.seek_issued');
    expect(issued).toHaveLength(1);
    expect(issued[0]?.['targetSec']).toBe(3_000);
    await waitFor((snapshot) => snapshot.session.seek === null);
    expect(Math.abs(engine.snapshot().session.positionSec - 3_000)).toBeLessThanOrEqual(1);
  });

  it('travels backwards as reliably as forwards, at 20 minutes of range', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 3_600 });
    await waitFor((snapshot) => snapshot.session.seek === null);
    engine.dispatch({ type: 'playback.seek', positionSec: 2_400 });
    await waitFor((snapshot) => snapshot.session.seek === null);
    expect(Math.abs(engine.snapshot().session.positionSec - 2_400)).toBeLessThanOrEqual(1);
  });

  it('stays paused when the founder seeks a paused film (6c)', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.pause' });
    await waitForState('paused');

    engine.dispatch({ type: 'playback.seek', positionSec: 1_800 });
    await waitFor((snapshot) => snapshot.session.seek === null);

    // The film moved. It did not start playing because it was nudged.
    expect(engine.snapshot().session.state).toBe('paused');
    expect(Math.abs(engine.snapshot().session.positionSec - 1_800)).toBeLessThanOrEqual(1);
    expect(receiver.playerState).toBe('PAUSED');
  });

  it('holds the requested position through statuses that still describe the old one', async () => {
    // The heart of 6e. Two statuses after the SEEK still report where the film was — which
    // is what a real receiver does — and the readout must not snap back to it and then
    // jump forward again.
    receiver.setSeekBehaviour({ lagStatuses: 2 });
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 5_400 });
    await settled();

    const held = eventsOf('position.sample').filter((record) => record['heldForSeek'] === true);
    expect(held.length).toBeGreaterThan(0);
    // Through all of it, the readout stayed on the destination.
    expect(Math.abs(engine.snapshot().session.positionSec - 5_400)).toBeLessThanOrEqual(1);
  });

  it('retries a swallowed seek once, then reconciles rather than lying about it', async () => {
    await castAndPlay();
    receiver.swallow('SEEK');
    engine.dispatch({ type: 'playback.seek', positionSec: 4_000 });

    await waitUntil(() => eventsOf('session.seek_retried').length === 1, 8_000);
    // It has not given up yet, and it has not snapped back either: the founder still sees
    // where they asked to be.
    expect(Math.abs(engine.snapshot().session.positionSec - 4_000)).toBeLessThanOrEqual(1);

    await waitUntil(() => eventsOf('session.seek_unconfirmed').length === 1, 8_000);
    expect(receiver.countOf('SEEK')).toBe(2);
    // And a seek that failed is never left on screen as one that worked: once we give up,
    // the device's own position wins the display back.
    await waitFor((snapshot) => snapshot.session.seek === null);
    await waitUntil(() => Math.abs(engine.snapshot().session.positionSec - 4_000) > 1, 5_000);
  }, 20_000);
});

// --- The ±30 s skip controls — story 6b -------------------------------------

describe('6f–6j — the ±30 s controls', () => {
  it('moves exactly 30 seconds and leaves the playback state alone (6f)', async () => {
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.2);
    const before = engine.snapshot().session.positionSec;

    engine.dispatch({ type: 'playback.skip', deltaSec: 30 });
    const target = engine.snapshot().session.seek?.targetSec ?? 0;
    expect(target - before).toBeCloseTo(30, 1);
    // 6h: a tap does not flip the status line to Seeking.
    expect(engine.snapshot().session.state).toBe('playing');

    await waitFor((snapshot) => snapshot.session.seek === null);
    expect(engine.snapshot().session.state).toBe('playing');
  });

  it('turns four taps inside the window into one command for the summed jump (6g)', async () => {
    await castAndPlay();
    const before = receiver.countOf('SEEK');
    const from = engine.snapshot().session.positionSec;

    for (let tap = 0; tap < 4; tap += 1) {
      engine.dispatch({ type: 'playback.skip', deltaSec: 30 });
      await sleep(40);
    }
    // 6h: the readout shows the destination and a running total while they accumulate.
    expect(engine.snapshot().session.seek?.pendingDeltaSec).toBe(120);
    expect(engine.snapshot().session.state).toBe('playing');

    await settled();
    // Four taps are one two-minute jump and one round trip.
    expect(receiver.countOf('SEEK') - before).toBe(1);
    const issued = eventsOf('session.seek_issued');
    expect(issued).toHaveLength(1);
    expect(Number(issued[0]?.['targetSec']) - from).toBeGreaterThanOrEqual(119);
    expect(Number(issued[0]?.['targetSec']) - from).toBeLessThanOrEqual(122);
  });

  it('starts a fresh target rather than queueing when a tap lands mid-seek (6h)', async () => {
    await castAndPlay();
    const before = receiver.countOf('SEEK');
    engine.dispatch({ type: 'playback.seek', positionSec: 1_000 });
    await settled();
    expect(receiver.countOf('SEEK') - before).toBe(1);

    engine.dispatch({ type: 'playback.skip', deltaSec: -30 });
    expect(engine.snapshot().session.seek?.pendingDeltaSec).toBe(-30);
    expect(engine.snapshot().session.seek?.inFlight).toBe(false);
    await settled();
    expect(receiver.countOf('SEEK') - before).toBe(2);
  });

  it('lands at the start rather than refusing, when there is less than 30 s behind (6i)', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.skip', deltaSec: -30 });

    const seek = engine.snapshot().session.seek;
    expect(seek?.targetSec).toBe(0);
    // The app states the real distance moved. `clamped` is what the wording hangs off.
    expect(seek?.clamped).toBe('start');
    await waitFor((snapshot) => snapshot.session.seek === null);
    expect(engine.snapshot().session.positionSec).toBeLessThan(2);
  });

  it('lands at the end rather than refusing, within 30 s of it (6i)', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: DURATION_SEC - 5 });
    await waitFor((snapshot) => snapshot.session.seek === null);

    engine.dispatch({ type: 'playback.skip', deltaSec: 30 });
    const seek = engine.snapshot().session.seek;
    expect(seek?.targetSec).toBe(DURATION_SEC);
    expect(seek?.clamped).toBe('end');
  });

  it('refuses a skip with no session, and never queues it for later (6j)', async () => {
    // No cast at all: there is nothing to jump inside.
    engine.dispatch({ type: 'playback.skip', deltaSec: 30 });
    await sleep(20);
    expect(eventsOf('session.seek_refused')).toHaveLength(1);
    expect(engine.snapshot().session.seek).toBeNull();

    // And the refusal really was a refusal: casting afterwards does not apply it.
    await castAndPlay();
    await settled();
    expect(receiver.countOf('SEEK')).toBe(0);
  });
});

// --- The source file vanishing — story 15 -----------------------------------

describe('15a/15b — the file moves out from under a session', () => {
  it('says nothing at all while playback is unaffected (15a)', async () => {
    await castAndPlay();
    await fs.rm(filePath);
    await sleep(200);

    // The film is playing perfectly well out of the device's buffer. Interrupting it to
    // report a problem that is not biting is exactly the noise this app exists to remove.
    expect(engine.snapshot().notice).toBeNull();
    expect(engine.snapshot().session.state).toBe('playing');
  });

  it('states it in plain language once playback ends, with a way to fix it', async () => {
    await castAndPlay();
    await fs.rm(filePath);
    await sleep(100);

    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    await waitFor((snapshot) => snapshot.notice !== null, 5_000);

    const notice = engine.snapshot().notice;
    expect(notice?.message).toBe('The original file is no longer where it was');
    expect(notice?.actionLabel).toBe('Find it again');
    expect(notice?.kind).toBe('source-missing');
    // No raw path, no errno, no stack.
    expect(notice?.message).not.toMatch(/ENOENT|[A-Z]:\\|\/tmp\//);
  });

  it('notices when the device comes back for bytes and finds nothing (15b)', async () => {
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    await fs.rm(filePath);

    // The receiver asks for more, the way one does when its buffer runs low.
    await receiver.refetch();
    await waitUntil(() => eventsOf('session.source_missing').length > 0, 5_000);

    // The device was told the truth — an honest 404, so it stops asking.
    expect(receiver.fetchStatuses.at(-1)).toBe(404);
    // And the position survived it.
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    expect(engine.snapshot().session.resumePositionSec).toBeGreaterThan(0);
  });

  /**
   * *Find it again* — the half of 15b that nothing tested, and it was broken.
   *
   * Found by the founder walking human checklist item 5 on 2026-08-19: the file moved, the
   * app said the right sentence, the dialog opened, they found the film — and their place
   * was gone. The cause was the identity test. "Is this the same film?" compared **paths**,
   * and *Find it again* exists precisely because the path changed, so it answered "a
   * different film" every single time the button was used and cleared the position it was
   * built to preserve.
   */
  it('keeps the saved position when the film is found again somewhere else (15b)', async () => {
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    await fs.rm(filePath);
    await receiver.refetch();
    await waitUntil(() => eventsOf('session.source_missing').length > 0, 5_000);
    await waitForState('stopped');
    const saved = engine.snapshot().session.resumePositionSec;
    expect(saved).toBeGreaterThan(0);

    // The founder finds it in a different folder — which is the only place it can be.
    const movedTo = path.join(directory, 'moved', 'Bluey - The Sign.mp4');
    await fs.mkdir(path.dirname(movedTo), { recursive: true });
    await fs.writeFile(movedTo, fixtureMp4());
    engine.dispatch({ type: 'file.select', path: movedTo });
    await waitFor((snapshot) => snapshot.file?.path === movedTo, 5_000);

    expect(engine.snapshot().session.resumePositionSec).toBe(saved);
    // The sentence goes when the problem does.
    expect(engine.snapshot().notice).toBeNull();
  });

  /**
   * The file can go missing and come back **at the address it always had**.
   *
   * `onSourceMissing` fires on any `stat` failure the media server hits, and
   * `checkSourceStillThere` on any failed `access` — so an external drive that blinked, a
   * NAS that dropped, or a transient lock all raise it without anything having moved. Found
   * by review on 2026-08-19: the relocate only fired when the *path* differed, so choosing
   * the same file back left the founder on a screen that never cleared, with *Find it again*
   * looping and *Choose another video* throwing their place away.
   */
  it('clears the sentence when the film comes back at the path it never left (15b)', async () => {
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    await fs.rm(filePath);
    await receiver.refetch();
    await waitUntil(() => eventsOf('session.source_missing').length > 0, 5_000);
    await waitForState('stopped');
    const saved = engine.snapshot().session.resumePositionSec;
    expect(engine.snapshot().notice?.kind).toBe('source-missing');

    // The drive comes back. Same folder, same name, same everything.
    await fs.writeFile(filePath, fixtureMp4());
    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.notice === null, 5_000);

    expect(engine.snapshot().session.resumePositionSec).toBe(saved);
  });

  it('still forgets the position when a genuinely different film is chosen (16b)', async () => {
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    expect(engine.snapshot().session.resumePositionSec).toBeGreaterThan(0);

    const other = path.join(directory, 'A Different Film.mp4');
    await fs.writeFile(other, Buffer.concat([fixtureMp4(), Buffer.alloc(64)]));
    engine.dispatch({ type: 'file.select', path: other });
    await waitFor((snapshot) => snapshot.file?.path === other, 5_000);

    expect(engine.snapshot().session.resumePositionSec).toBe(0);
  });
});

// --- Finished and Resume — stories 16, 17 -----------------------------------

describe('16a–16c — the end of a film, and the way back into one', () => {
  it('parks on Finished and releases the TV, playing nothing next (16a)', async () => {
    await castAndPlay();
    receiver.finish();
    await waitForState('ended');

    // The receiver STOP is what actually returns the TV to its own home screen.
    await waitUntil(() => !receiver.launched, 5_000);
    expect(engine.snapshot().session.state).toBe('ended');
    // Nothing started by itself.
    expect(receiver.playerState).toBe('IDLE');
  });

  it('resumes by loading *at* the position, never from the beginning first (16c)', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 1_930 });
    await waitFor((snapshot) => snapshot.session.seek === null);
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');

    const saved = engine.snapshot().session.resumePositionSec;
    expect(Math.abs(saved - 1_930)).toBeLessThanOrEqual(2);

    const loadsBefore = receiver.countOf('LOAD');
    engine.dispatch({ type: 'cast.resume' });
    await waitForState('playing');
    expect(receiver.countOf('LOAD') - loadsBefore).toBe(1);

    // The position rode on the LOAD itself — this is the assertion the fake receiver used
    // to be unable to make, because it started every load at zero whatever it was asked.
    const load = receiver.received.filter((message) => message.type === 'LOAD').at(-1);
    expect(Number(load?.payload['currentTime'])).toBeCloseTo(saved, 0);
    expect(Math.abs(engine.snapshot().session.positionSec - saved)).toBeLessThanOrEqual(2);
    // And no SEEK was needed to get there: loading at 0 and jumping would have shown the
    // founder the opening of the film first.
    expect(receiver.countOf('SEEK')).toBe(1);
  });

  it('starts from the beginning when that is what was asked for', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 1_930 });
    await waitFor((snapshot) => snapshot.session.seek === null);
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');

    engine.dispatch({ type: 'cast.start' });
    await waitForState('playing');
    const load = receiver.received.filter((message) => message.type === 'LOAD').at(-1);
    expect(Number(load?.payload['currentTime'])).toBe(0);
  });

  it('does not offer one film’s position to a different film', async () => {
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 1_930 });
    await waitFor((snapshot) => snapshot.session.seek === null);
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    expect(engine.snapshot().session.resumePositionSec).toBeGreaterThan(1_900);

    const other = path.join(directory, 'Something Else.mp4');
    await fs.writeFile(other, fixtureMp4());
    engine.dispatch({ type: 'file.select', path: other });
    await waitFor((snapshot) => snapshot.file?.name === 'Something Else.mp4');
    await sleep(20);

    // Resuming a film you have not watched, at a place from one you have, is the defect
    // this guards. Re-choosing the *same* file keeps its position; a different one does not.
    expect(engine.snapshot().session.resumePositionSec).toBe(0);
  });
});

describe('17a — a device that took the video and never came back for it', () => {
  it('names the firewall rather than spinning forever', async () => {
    // A television that accepts a LOAD and never issues a single range request is exactly
    // what a firewall between it and this PC looks like from here.
    receiver.setFetchesMedia(false);

    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });

    await waitFor(
      (snapshot) => snapshot.notice?.kind === 'firewall-blocked',
      TIMING.firewallDiagnosisMs + 8_000,
    );
    const notice = engine.snapshot().notice;
    expect(notice?.message).toBe('Windows Firewall is blocking CastGood');
    expect(notice?.actionLabel).toBe('Allow through the firewall');
    // It let the TV go rather than leaving it on the Cast backdrop.
    await waitUntil(() => !receiver.launched, 5_000);
  }, 30_000);

  it('says nothing about the firewall when the device does fetch the video', async () => {
    await castAndPlay();
    await sleep(TIMING.firewallDiagnosisMs + 500);
    expect(engine.snapshot().notice).toBeNull();
    expect(eventsOf('session.firewall_suspected')).toHaveLength(0);
  }, 30_000);
});

// --- Regressions found by the QA review on 2026-08-17 -------------------------
//
// One test per finding. Each was written against the defect and watched to fail
// before the fix went in — which is the only thing that makes a regression test
// worth having.

describe('QA-17-08 — the seek hold cannot outlive the seek', () => {
  it('puts the readout back when a jump is given up on, even from a silent device', async () => {
    // The firmware case the PRD explicitly tells the fake to model: a device that reports
    // no position at all. With one, "give up and let the next status correct us" never
    // corrects, so the readout stayed on a place the film never reached — permanently, and
    // it flowed into the saved position. 6e: a seek that failed is never displayed as one
    // that worked.
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    const before = engine.snapshot().session.positionSec;

    receiver.setReportsPosition(false);
    receiver.swallow('SEEK');
    engine.dispatch({ type: 'playback.seek', positionSec: 6_000 });

    await waitUntil(() => eventsOf('session.seek_unconfirmed').length === 1, 20_000);
    await sleep(300);

    const after = engine.snapshot().session.positionSec;
    expect(engine.snapshot().session.seek).toBeNull();
    // Back where the film really is — not 6000, and not rewound to zero either.
    expect(after).toBeLessThan(60);
    expect(after).toBeGreaterThanOrEqual(before - 0.5);
  }, 30_000);

  it('does not save a place the film never reached when Stop lands mid-window', async () => {
    // Tap +10 minutes, press Stop inside the 400 ms window: nothing was ever sent, so the
    // TV never left where it was. Offering "Resume from 0:10:00" would state a fact that is
    // false — and M1's own "devices lie about their final position" guard then defends the
    // fiction against the device's honest answer.
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);

    engine.dispatch({ type: 'playback.skip', deltaSec: 600 });
    expect(engine.snapshot().session.seek?.targetSec).toBeGreaterThan(590);
    engine.dispatch({ type: 'cast.stop' });
    await waitForState('stopped');
    await sleep(300);

    expect(receiver.countOf('SEEK')).toBe(0);
    expect(engine.snapshot().session.resumePositionSec).toBeLessThan(60);
  });
});

describe('QA-17-08 — 15b actually stops playback', () => {
  it('ends the session itself when the device is told the file has gone', async () => {
    // Previously this only recorded a flag and waited for the television to volunteer an
    // IDLE. A receiver that stalls in BUFFERING instead leaves the founder watching
    // *Buffering…* forever — and the give-up-on-a-stuck-buffer rule (11e) is in the half
    // that waits on the spike, so nothing else would have rescued them.
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    await fs.rm(filePath);

    await receiver.refetch();
    await waitFor((snapshot) => snapshot.notice !== null, 10_000);

    expect(engine.snapshot().session.state).toBe('stopped');
    expect(engine.snapshot().notice?.kind).toBe('source-missing');
    expect(engine.snapshot().notice?.message).toBe('The original file is no longer where it was');
    // The place they got to survived it.
    expect(engine.snapshot().session.resumePositionSec).toBeGreaterThan(0);
    // And the TV was handed back rather than left on a dead session.
    await waitUntil(() => !receiver.launched, 5_000);
  });

  it('still says nothing when the file is gone but the device never asks again (15a)', async () => {
    await castAndPlay();
    await fs.rm(filePath);
    await sleep(400);
    expect(engine.snapshot().notice).toBeNull();
    expect(engine.snapshot().session.state).toBe('playing');
  });

  it('explains a film that dies on the device rather than calling it a clean stop', async () => {
    // IDLE/ERROR mid-playback with the file present used to reach `stopped` with no error
    // at all, so a film that fell over read as "Stopped — your place is saved", exactly as
    // though the founder had chosen it.
    await castAndPlay();
    await waitFor((snapshot) => snapshot.session.positionSec > 0.3);
    receiver.failMedia();

    await waitFor((snapshot) => snapshot.notice !== null, 10_000);
    expect(engine.snapshot().notice?.message).toBe('The TV stopped playing this file');
    expect(engine.snapshot().session.state).toBe('stopped');
  });
});

describe('QA-17-08 — 17a fits inside the budget it promises', () => {
  it('names the firewall within 15 s of the Cast press, not of the load', async () => {
    // A firewall blocks *inbound* to the media server, so LAUNCH and LOAD both complete at
    // full price first. This device spends 6 s booting its receiver app — the low end of
    // what the founder's own hardware does — and the diagnosis still has to land inside the
    // 15 s cast-failure budget, measured from the press.
    await receiver.close();
    receiver = await startFakeReceiver({
      durationSec: DURATION_SEC,
      startupMs: 10,
      launchDelayMs: 6_000,
    });
    mdns.up({
      id: receiver.device.id,
      friendlyName: receiver.device.friendlyName,
      model: receiver.device.model,
      address: '127.0.0.1',
      port: receiver.port,
    });
    await waitFor((snapshot) => snapshot.discovery.devices.length > 0);
    receiver.setFetchesMedia(false);

    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });

    const pressedAt = Date.now();
    engine.dispatch({ type: 'cast.start' });
    await waitFor((snapshot) => snapshot.notice?.kind === 'firewall-blocked', 25_000);
    const elapsedMs = Date.now() - pressedAt;

    expect(elapsedMs).toBeLessThanOrEqual(TIMING.castFailureBudgetMs);
    // And it did not fire early either — a device deserves a moment to ask for its bytes.
    const armed = eventsOf('session.media_never_fetched')[0];
    expect(Number(armed?.['sinceCastPressMs'])).toBeGreaterThan(6_000);
  }, 40_000);

  it('never accuses a slow-booting device that does come back for the bytes', async () => {
    // Nine seconds of receiver boot leaves under six of the budget. A device that is merely
    // slow must not be told it is firewalled — and the wait is always clamped into
    // [firewallDiagnosisMinMs, firewallDiagnosisMs], so a television that spends nearly the
    // whole budget booting still gets a moment to ask for its first byte before we accuse
    // it of anything.
    await receiver.close();
    receiver = await startFakeReceiver({
      durationSec: DURATION_SEC,
      startupMs: 10,
      launchDelayMs: 9_000,
    });
    mdns.up({
      id: receiver.device.id,
      friendlyName: receiver.device.friendlyName,
      model: receiver.device.model,
      address: '127.0.0.1',
      port: receiver.port,
    });
    await waitFor((snapshot) => snapshot.discovery.devices.length > 0);

    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });

    await waitForState('playing', 25_000);
    const armed = eventsOf('session.fetch_watchdog_armed')[0];
    const waitMs = Number(armed?.['waitMs']);
    expect(waitMs).toBeGreaterThanOrEqual(TIMING.firewallDiagnosisMinMs);
    expect(waitMs).toBeLessThanOrEqual(TIMING.firewallDiagnosisMs);
    // It fetched perfectly well; it was just slow to start. No accusation, ever.
    await sleep(waitMs + 1_000);
    expect(engine.snapshot().notice).toBeNull();
    expect(eventsOf('session.firewall_suspected')).toHaveLength(0);
  }, 45_000);

  it('casts to a television whose receiver takes longer than ten seconds to boot (3b)', async () => {
    // **The 2026-08-18 defect, at the shipping numbers — nothing injected here.** A
    // "Family room TV" idle for 56 minutes did not answer its LAUNCH inside the old
    // 10,000 ms and the cast was abandoned with "Couldn't reach Family room TV". Warm
    // boots on that same set measure 6,172–7,986 ms, so the margin had always been about
    // two seconds; a cold one crossed it. Eleven seconds is past the old ceiling and
    // inside the new one, and it must simply work — first time, without needing the retry.
    await receiver.close();
    receiver = await startFakeReceiver({
      durationSec: DURATION_SEC,
      startupMs: 10,
      launchDelayMs: 11_000,
    });
    mdns.up({
      id: receiver.device.id,
      friendlyName: receiver.device.friendlyName,
      model: receiver.device.model,
      address: '127.0.0.1',
      port: receiver.port,
    });
    await waitFor((snapshot) => snapshot.discovery.devices.length > 0);

    engine.dispatch({ type: 'file.select', path: filePath });
    await waitFor((snapshot) => snapshot.file !== null);
    engine.dispatch({ type: 'device.select', deviceId: receiver.device.id });
    engine.dispatch({ type: 'cast.start' });

    await waitForState('playing', 25_000);
    expect(receiver.countOf('LAUNCH')).toBe(1);
    expect(engine.snapshot().notice).toBeNull();
  }, 45_000);
});

describe('QA-17-08 — a jump that buffers is still a jump', () => {
  it('survives a device that buffers after a seek before playing again', async () => {
    // Real receivers fetch the new region before they resume; the fake used to answer a
    // SEEK with its previous player state, which made every jump look instantaneous.
    receiver.setSeekBehaviour({ errorSec: 0.4, lagStatuses: 1, bufferMs: 600 });
    await castAndPlay();
    engine.dispatch({ type: 'playback.seek', positionSec: 3_000 });

    await waitFor(
      (snapshot) => snapshot.session.seek === null && snapshot.session.state === 'playing',
      15_000,
    );
    // Landed within the tolerance despite the keyframe error and the buffering pause.
    expect(Math.abs(engine.snapshot().session.positionSec - 3_000)).toBeLessThanOrEqual(2);
  }, 20_000);
});
