import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  refuseOutage,
  runSelftest,
  type Assertion,
  type SelftestPromptStage,
  type SelftestVerdict,
} from '../../src/engine/selftest/index.js';
import { parseArgs } from '../../src/engine/selftest/args.js';
import {
  tcpTransportFactory,
  type CastTransport,
  type TransportFactory,
} from '../../src/engine/cast/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import { systemClock, type Clock } from '../../src/engine/logging/index.js';
import { TIMING } from '../../src/engine/config.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * **`--outage cable`: the instrument for the one thing only a person can do.**
 *
 * Every other outage this harness produces severs a connection cleanly and locally, so
 * the app learns instantly — `recoveryNoticedMs` measured 1 ms against a real television.
 * A cable coming out of the back of a PC is nothing like that: nothing closes, things
 * simply stop answering, and the app has to work it out from the heartbeat and the
 * interface table. That is the path 11d describes and it has never met a real network.
 *
 * The founder is going to stand up and walk to their PC to run this. Before they do, the
 * instrument itself has to be known to work, because the failure that costs an evening is
 * not a red line — it is a run that hangs, or aborts on its own confusion, or reports a
 * pass for an intervention that never happened. So this file drives the whole scenario
 * three times against a scripted television and a scripted interface table:
 *
 *  1. the founder does exactly as asked;
 *  2. the founder never gets there — which must be exit **2**, naming the intervention;
 *  3. the founder pulls the cable and Windows fails over to wifi, so the PC never goes
 *     offline at all — also exit 2, and with a *different* instruction, because the
 *     answer is to disable the adapter rather than to pull harder.
 *
 * Nothing here waits real minutes: the three human waits are injected, and the 30 s
 * deadlines 11d turns on are reached by shifting the engine's monotonic clock, the same
 * way the recovery tests reach them.
 */

function ipv4(address: string, internal = false): os.NetworkInterfaceInfo {
  return {
    address,
    netmask: '255.255.255.0',
    family: 'IPv4',
    mac: '00:00:00:00:00:00',
    internal,
    cidr: `${address}/24`,
  };
}

/**
 * The founder's own machine, and the trap in the middle of it.
 *
 * `vEthernet (WSL)` keeps 172.24.16.1 whether or not the Ethernet is plugged in, so
 * "some interface still has an address" is never the question — the question is whether
 * the address the OS chose to reach *this* television is still here. In a headless run
 * the television is on loopback, so loopback plays the part of the Ethernet address.
 */
function plugged(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return {
    Ethernet: [ipv4('10.1.1.42')],
    'vEthernet (WSL)': [ipv4('172.24.16.1')],
    'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)],
  };
}

/** The cable is out: the address we were serving from has gone, and one address remains. */
function unplugged(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return { 'vEthernet (WSL)': [ipv4('172.24.16.1')] };
}

/**
 * The cable is out and Windows shrugged: it has wifi, the serving address survives, and
 * this PC never goes offline. A legitimate "could not run", and a different instruction.
 */
function failedOverToWifi(): NodeJS.Dict<os.NetworkInterfaceInfo[]> {
  return {
    'Wi-Fi': [ipv4('10.1.1.77')],
    'vEthernet (WSL)': [ipv4('172.24.16.1')],
    'Loopback Pseudo-Interface 1': [ipv4('127.0.0.1', true)],
  };
}

/**
 * A network that can be taken away **silently**, which is the whole difference.
 *
 * `sever()` — what `--outage socket` does — destroys the socket, and the close arrives in
 * the same tick. A cable pull closes nothing: the socket stays up, frames stop arriving in
 * both directions, and new connections simply fail. That is what this models, so the
 * scenario is exercised against the detection path it exists to prove rather than against
 * an instant local close.
 */
interface Partition {
  readonly factory: TransportFactory;
  unplug(): void;
  replug(): void;
}

function partitionable(inner: TransportFactory): Partition {
  let cut = false;
  const live = new Set<CastTransport>();
  return {
    factory: async (options, handlers) => {
      if (cut) throw new Error('EHOSTUNREACH: this PC has no route to the television');
      const transport = await inner(options, {
        onMessage: (message) => {
          if (!cut) handlers.onMessage(message);
        },
        onClose: (reason) => handlers.onClose(reason),
      });
      live.add(transport);
      return {
        get localAddress() {
          return transport.localAddress;
        },
        get closed() {
          return transport.closed;
        },
        // Sent into the void: to this end of it the socket looks perfectly healthy.
        send: (message) => {
          if (!cut) transport.send(message);
        },
        close: () => {
          live.delete(transport);
          transport.close();
        },
      };
    },
    unplug() {
      cut = true;
    },
    replug() {
      cut = false;
    },
  };
}

interface ShiftingClock extends Clock {
  shift(ms: number): void;
}

function createShiftingClock(): ShiftingClock {
  let offset = 0;
  return {
    wallMs: () => Date.now() + offset,
    monoMs: () => systemClock.monoMs() + offset,
    shift(ms) {
      offset += ms;
    },
  };
}

function createFakeMdns(service: MdnsService): Mdns {
  const active = new Set<MdnsHandlers>();
  return {
    browse(handlers) {
      active.add(handlers);
      setTimeout(() => handlers.onUp(service), 5);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
  };
}

function box(type: string, content: Buffer): Buffer {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(content.length + 8, 0);
  header.write(type, 4, 'latin1');
  return Buffer.concat([header, content]);
}

function fixtureMp4(durationSec: number): Buffer {
  const mvhd = Buffer.alloc(100);
  mvhd.writeUInt32BE(1_000, 12);
  mvhd.writeUInt32BE(durationSec * 1_000, 16);
  return Buffer.concat([
    box('ftyp', Buffer.from('isom')),
    box('mdat', Buffer.alloc(4_096, 3)),
    box('moov', box('mvhd', mvhd)),
  ]);
}

/** How long the cable is out. Past the 30 s give-up deadline, exactly as the app ships. */
const HOLD_MS = 40_000;
/** Left as real time after the clock jump, so the engine's own timers get to run. */
const REAL_TAIL_MS = 3_000;

interface CableRun {
  readonly verdict: SelftestVerdict;
  readonly prompts: readonly SelftestPromptStage[];
  readonly said: readonly string[];
}

/**
 * One `--outage cable` run, with a scripted television, a scripted interface table, and a
 * `founder` who reacts to the printed instructions — which is precisely what the scenario
 * claims to be driven by. Nothing reads a key here, because nothing reads a key there.
 */
async function runCable(
  founder: {
    onUnplug?: (world: World) => void;
    onOffline?: (world: World) => void;
    onReplug?: (world: World) => void;
    onOnline?: (world: World) => void;
  },
  /**
   * How long the app gets to work out that the missing address is *this PC's* problem.
   *
   * Short by default here, because in every run but one the interface table answers it
   * inside a poll. The exception is the run where the app has nothing to go on but a
   * socket that stopped answering: the keep-alive needs its 10–15 s, and that is real
   * time on a real timer — the one wait in this file that cannot be shortened honestly.
   */
  noticeGraceMs = 4_000,
): Promise<CableRun> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-cable-'));
  const filePath = path.join(directory, 'Cars.mp4');
  await fs.writeFile(filePath, fixtureMp4(3_000));
  const receiver = await startFakeReceiver({ durationSec: 3_000 });
  const partition = partitionable(tcpTransportFactory);
  const clock = createShiftingClock();
  let interfaces = plugged();
  let hurrying: NodeJS.Timeout | null = null;
  const world: World = {
    receiver,
    clock,
    partition,
    set: (next) => {
      interfaces = next;
    },
    hurry: () => {
      hurrying ??= setInterval(() => clock.shift(20_000), 200);
    },
  };

  const prompts: SelftestPromptStage[] = [];
  const said: string[] = [];

  try {
    const verdict = await runSelftest({
      deviceName: 'Family room TV',
      filePath,
      scenario: 'recover',
      outage: 'cable',
      clock,
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } }),
      deviceWaitMs: 5_000,
      humanOutage: {
        waitMs: 8_000,
        holdMs: HOLD_MS,
        noticeGraceMs,
        progressEveryMs: 1_000,
      },
      instructions: (stage, text) => {
        prompts.push(stage);
        said.push(text);
        if (stage === 'unplug') founder.onUnplug?.(world);
        if (stage === 'offline') founder.onOffline?.(world);
        if (stage === 'replug') founder.onReplug?.(world);
        if (stage === 'online') founder.onOnline?.(world);
      },
      unsafeTestOverrides: {
        transport: partition.factory,
        networkInterfaces: () => interfaces,
        mdns: createFakeMdns({
          id: receiver.device.id,
          friendlyName: 'Family room TV',
          model: 'Chromecast',
          address: '127.0.0.1',
          port: receiver.port,
        }),
      },
    });
    return { verdict, prompts, said };
  } finally {
    if (hurrying !== null) clearInterval(hurrying);
    await receiver.close();
    await fs.rm(directory, { recursive: true, force: true });
  }
}

interface World {
  readonly receiver: FakeReceiver;
  readonly clock: ShiftingClock;
  readonly partition: Partition;
  set(interfaces: NodeJS.Dict<os.NetworkInterfaceInfo[]>): void;
  /**
   * Run the rest of the run's clocks fast.
   *
   * Only ever used once nothing is coming back — a session the app has already given up
   * on — where the remaining waits are budgets counting down against a television that
   * will not answer. Real time would add a minute to the suite and prove nothing that is
   * not already decided.
   */
  hurry(): void;
}

function must(verdict: SelftestVerdict, name: string): Assertion {
  const found = [...verdict.assertions, ...verdict.observations].find((item) => item.name === name);
  expect(
    found,
    `no assertion called "${name}"; the run reported: ${verdict.assertions
      .map((item) => item.name)
      .join(', ')}`,
  ).toBeDefined();
  return found as Assertion;
}

describe.concurrent('--outage cable — the human-driven half of 11b and 11d', () => {
  it.concurrent(
    'is driven by the founder pulling the cable, and grades what happens either side of it',
    async () => {
      const { verdict, prompts } = await runCable({
        // The cable comes out. Nothing closes: the socket stays up and stops answering,
        // and the address the OS was serving from leaves the interface table.
        onUnplug: (world) => {
          world.partition.unplug();
          world.set(unplugged());
        },
        // The outage is held past the 30 s give-up deadline. The clock jump is how that
        // is reached in seconds; the television played on through it, so its playhead
        // moves with it — a real one does exactly that out of its own buffer.
        onOffline: (world) => {
          world.receiver.setPositionSec(
            world.receiver.positionSec + (HOLD_MS - REAL_TAIL_MS) / 1000,
          );
          world.clock.shift(HOLD_MS - REAL_TAIL_MS);
        },
        onReplug: (world) => {
          world.set(plugged());
          world.partition.replug();
        },
      });

      // It ran: no abort, and it asked for both physical actions in the right order.
      expect(verdict.reason, `aborted: ${verdict.reason ?? ''}`).toBeNull();
      expect(prompts.filter((stage) => stage !== 'progress')).toEqual([
        'unplug',
        'offline',
        'replug',
        'online',
      ]);

      // 13b: nothing may pass on a number it never took. This is the failure mode that
      // cost two hardware evenings, and a scenario nobody has ever run is where it lives.
      for (const item of verdict.assertions) {
        expect(item.measured, `${item.name} measured nothing`).not.toBeNull();
        expect(item.target, item.name).not.toBeNull();
        expect(['lte', 'gte', 'eq'], item.name).toContain(item.comparison);
      }

      // 11d, clause by clause. This PC is blamed, not the television.
      expect(must(verdict, 'cableBlamedThisPc').passed).toBe(true);
      expect(
        must(verdict, 'cableNeverBlamedTheTelevision').passed,
        JSON.stringify(verdict.assertions),
      ).toBe(true);
      expect(must(verdict, 'cableDeviceListDimmedNotEmptied').measured).toBe('dimmed');
      expect(must(verdict, 'cablePositionAndFileHeld').measured).toBe('held');

      // The give-up clock is suspended rather than running down — and the assertion
      // cannot pass by the outage being short, which is why the hold exceeds the deadline.
      expect(must(verdict, 'cableGiveUpClockSuspended').measured).toBe('suspended');
      expect(Number(must(verdict, 'cableTotalOutageMs').measured)).toBeGreaterThan(
        TIMING.reconnectBudgetMs,
      );
      // …and after 30 s, and not before, the way out is offered.
      expect(must(verdict, 'cableNetworkSettingsOfferedAfter30s').measured).toBe('offered');
      expect(must(verdict, 'cableNoNetworkSettingsButtonAtFirst').measured).toBe('not yet');

      // 11b: it came back by itself, in time, and nothing was ever said in red.
      expect(must(verdict, 'cableResumedMs').passed, JSON.stringify(verdict.assertions)).toBe(true);
      expect(must(verdict, 'cableFounderPressedNothing').measured).toBe(0);
      expect(must(verdict, 'cableNeverShowedAnError').measured).toBe('no error');
      expect(must(verdict, 'cableResumePositionErrorS').passed).toBe(true);

      // The numbers that are the OS's business and the television's are reported and
      // never graded — including the one that is the entire point of this scenario: how
      // long a *silent* outage took to notice, as against 1 ms for a severed socket.
      expect(must(verdict, 'cableNoticedFromInterfaceChangeMs').kind).toBe('observation');
      expect(must(verdict, 'cableAddressRestoredMs').kind).toBe('observation');
      expect(must(verdict, 'cableTotalOutageMs').kind).toBe('observation');

      expect(verdict.exitCode, JSON.stringify(verdict.assertions)).toBe(0);
    },
    120_000,
  );

  it.concurrent(
    'reports where the film was when the cable came out, not where it was when it asked',
    async () => {
      /**
       * The gap between asking and acting is as long as the walk to the PC.
       *
       * On the first hardware run of this scenario the founder took **18 s** to get there,
       * and `cablePositionAtOutageSec` reported **2.384 s** for a film that the engine log
       * shows was really ~21.8 s in. The measurement was captured at the top of the
       * scenario, where it is right for the sentence the founder is *shown* ("playing at
       * 0:02" — true when they are asked) and wrong for an observation that claims to say
       * where the television was when the cable came out.
       *
       * Nothing was graded on it, and `cableResumePositionErrorS` compares our display
       * against the device's own report rather than against this — so no promise was ever
       * corrupted. But it is the fifth measurement this milestone to describe something
       * other than its name, and the previous four cost two hardware evenings between them.
       * This is the test that was missing: the fix passes with or without it otherwise.
       */
      const WALK_SEC = 25;
      const { verdict } = await runCable({
        onUnplug: (world) => {
          // The film plays on while the founder walks. A real television does this by
          // itself; here it is set, because the fake's playhead is ours to move.
          world.receiver.setPositionSec(world.receiver.positionSec + WALK_SEC);
          // …and the cable comes out only *after* the engine has had a poll to see the new
          // position. That delay is the whole test: it is what makes this about *when* the
          // measurement is read rather than what it is read from.
          setTimeout(() => {
            world.partition.unplug();
            world.set(unplugged());
          }, 1_500);
        },
        onOffline: (world) => {
          world.receiver.setPositionSec(
            world.receiver.positionSec + (HOLD_MS - REAL_TAIL_MS) / 1000,
          );
          world.clock.shift(HOLD_MS - REAL_TAIL_MS);
        },
        onReplug: (world) => {
          world.set(plugged());
          world.partition.replug();
        },
      });

      expect(verdict.reason, `aborted: ${verdict.reason ?? ''}`).toBeNull();

      // The observation must have moved with the walk. Read at the top of the scenario it
      // is ~0; read at the outage it is at least the walk.
      const atOutage = Number(must(verdict, 'cablePositionAtOutageSec').measured);
      expect(
        atOutage,
        'the position at the outage is still the position when the founder was asked',
      ).toBeGreaterThanOrEqual(WALK_SEC);

      // And it stays consistent with the other end: a television that plays on through the
      // outage lands ahead of where it dropped, never behind it.
      const onReturn = Number(must(verdict, 'cablePositionOnReturnSec').measured);
      expect(onReturn).toBeGreaterThan(atOutage);
    },
    120_000,
  );

  it.concurrent(
    'is a run that could not happen — never a failure — when nobody pulls the cable',
    async () => {
      // The founder was called away. The PRD is explicit: a scenario needing a human
      // intervention which never arrived exits 2, because a missed intervention is not a
      // broken promise. Exit 1 here would put a red line against an app that did nothing
      // wrong, and exit 0 would be a lie about a cable that never moved.
      const { verdict, prompts } = await runCable({});

      expect(verdict.exitCode).toBe(2);
      expect(verdict.outcome).toBe('could-not-run');
      expect(verdict.reason ?? '').toContain('never unplugged');
      // It says which intervention was missed, in words a product manager can act on.
      expect(verdict.reason ?? '').toContain('did not');
      // And it asked before it gave up, rather than waiting in silence.
      expect(prompts).toContain('unplug');
      expect(prompts).toContain('progress');
      // Nothing about the app was measured, so nothing about the app is claimed.
      expect(verdict.assertions.every((item) => item.passed)).toBe(true);
    },
    120_000,
  );

  it.concurrent(
    'says so plainly when Windows fails over to wifi instead of going offline',
    async () => {
      // The founder pulls the cable on a laptop with wifi. Windows keeps the machine on
      // the network, so the outage 11d is about never happens. That is not a failure and
      // it is not the founder being slow: it is a different instruction — disable the
      // adapter — and hanging or failing obscurely would send them looking for a defect.
      const { verdict } = await runCable({
        onUnplug: (world) => world.set(failedOverToWifi()),
      });

      expect(verdict.exitCode).toBe(2);
      expect(verdict.outcome).toBe('could-not-run');
      const reason = verdict.reason ?? '';
      expect(reason).toContain('never went offline');
      // It names the address that went away and the one that carried on, so the founder
      // can see which adapter to disable rather than guessing.
      expect(reason).toContain('10.1.1.42');
      expect(reason).toContain('10.1.1.77');
      expect(reason.toLowerCase()).toContain('disable');
    },
    120_000,
  );
  it.concurrent(
    'grades the app — it does not excuse it — when the cable comes out and this PC is never blamed',
    async () => {
      /**
       * The defect this whole scenario exists to catch, in the shape it actually had.
       *
       * On 2026-08-18 an unplugged Ethernet cable was reported as *"Lost connection to
       * Family room TV"*: the serving address had been cleared before the check that
       * needed it, and `vEthernet (WSL)` still had an address, so the PC looked online
       * while nothing could reach the television. Every clause of 11d failed.
       *
       * A run must never mistake that for a missed intervention. The cable *did* come
       * out — the interface table says so — so this is a promise the app broke, and it
       * has to come back as **exit 1 with measurements**, not exit 2 with an excuse.
       */
      const { verdict, said } = await runCable(
        {
          onUnplug: (world) => {
            // The address the app is serving from survives, exactly as `vEthernet (WSL)`
            // did, so the app has nothing to go on but a socket that stopped answering.
            world.partition.unplug();
            world.set(failedOverToWifi());
          },
          // Far enough past the give-up deadline that the app, which believes it is only
          // the television that has gone quiet, runs its 30 s down and says so.
          onOffline: (world) => world.clock.shift(TIMING.reconnectBudgetMs + 5_000),
          onReplug: (world) => {
            world.set(plugged());
            world.partition.replug();
          },
          // The session was given up on, so nothing is coming back by itself: every wait
          // left is a budget counting down against a television nobody is talking to.
          onOnline: (world) => world.hurry(),
        },
        // Long enough for the keep-alive to give up, because in this run nothing else can
        // tell the app anything at all — which is the condition being reproduced.
        16_000,
      );

      // Not "could not run": the intervention arrived and the app got it wrong.
      expect(verdict.reason).toBeNull();
      expect(verdict.exitCode).toBe(1);
      expect(must(verdict, 'cableBlamedThisPc').passed).toBe(false);
      expect(must(verdict, 'cableNeverBlamedTheTelevision').passed).toBe(false);
      expect(must(verdict, 'cableGiveUpClockSuspended').passed).toBe(false);
      // And it said out loud, while the founder was still standing there, that what it
      // was watching was the defect rather than the founder being slow.
      expect(said.join('\n')).toContain('has NOT said that this PC');
    },
    120_000,
  );
});

describe('`cable` can never run inside an unattended aggregate', () => {
  it('is refused for every scenario except `recover`, at the command line', () => {
    // `m2` passed 107/107 on a real television with nobody in the room. An aggregate that
    // silently waited two minutes for a human who was not there, then exited 2, would
    // destroy exactly that. The rule is a function of the two arguments, so it cannot be
    // observed in one place and forgotten in another.
    expect(refuseOutage('recover', 'cable')).toBeNull();
    for (const scenario of ['m1', 'm2', 'cast', 'seek', 'takeover', 'position'] as const) {
      expect(refuseOutage(scenario, 'cable'), scenario).toContain('recover');
    }
    // Nothing changes for the outages that need no one.
    for (const scenario of ['m1', 'm2', 'recover'] as const) {
      expect(refuseOutage(scenario, 'socket')).toBeNull();
      expect(refuseOutage(scenario, 'heartbeat')).toBeNull();
    }

    expect(
      parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm2', '--outage', 'cable']).ok,
    ).toBe(false);
    expect(
      parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'm1', '--outage', 'cable']).ok,
    ).toBe(false);
    // …and the default scenario is `m1`, so asking for a cable pull without naming
    // `recover` must not quietly become an unattended run either.
    expect(parseArgs(['--device', 'TV', '--file', '/x', '--outage', 'cable']).ok).toBe(false);
    expect(
      parseArgs(['--device', 'TV', '--file', '/x', '--scenario', 'recover', '--outage', 'cable'])
        .ok,
    ).toBe(true);
  });

  it('refuses it again inside the runner, before anything is cast', async () => {
    // Not a convention and not only a command-line check: anything that reaches
    // `runSelftest` directly — a test, an IPC caller, a future menu item — is refused
    // here too, and refused *before* the file is read or a television is looked for.
    const verdict = await runSelftest({
      deviceName: 'Family room TV',
      filePath: '/nonexistent/Cars.mp4',
      scenario: 'm2',
      outage: 'cable',
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: os.tmpdir() } }),
    });

    expect(verdict.exitCode).toBe(2);
    expect(verdict.outcome).toBe('could-not-run');
    expect(verdict.reason ?? '').toContain('recover');
    expect(verdict.assertions).toEqual([]);
    // It refused for being unattended, not for the missing file — the point is that the
    // guard runs first, so an `m2` on a perfectly good file cannot slip past it.
    expect(verdict.reason ?? '').not.toContain('file not found');
  }, 30_000);
});
