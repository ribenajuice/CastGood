import { LEGS, restoreFoundVolume, runSpikeM5a, summariseM5a, type LegName } from './m5a.js';
import { SpikeAbort } from './m2.js';
import { resolveDeviceByName } from './device.js';
import { CAST } from '../config.js';
import {
  combineSinks,
  createFileSink,
  createLogger,
  createMemorySink,
  systemClock,
} from '../logging/index.js';
import { resolveAppPaths } from '../paths.js';

/**
 * SPIKE-5's process entry point — THROWAWAY, like everything else in this directory.
 * `scripts/spike-m5a.mjs` bundles this file. See `m5a.ts` for what it is for.
 *
 * The same shape as `m3-cli.ts` and `m3c-cli.ts`: stdout is the JSON report and nothing
 * else, the readable summary goes to stderr, and a run in WSL refuses immediately.
 *
 * Three exit codes rather than two, for the reason spelled out in `m5b-cli.ts`:
 *
 *   0  every leg asked for produced its reading
 *   2  the run could not happen at all — wrong OS, no such device, a film it refused
 *   3  it ran and recorded, but at least one leg could not be measured. **A television
 *      that will not take a volume lands here**: that is a real and important finding
 *      about the set, printed in full — and it also means the round trip, the clamping
 *      and the quantisation were never measured, so nobody may quote a number for them.
 *
 * ⚠️ **The volume belongs to the television.** Ctrl-C restores what this spike found
 * before it exits; so does a crash. See `restoreFoundVolume`.
 */

const COULD_NOT_RUN = 2;
const SOMETHING_UNMEASURED = 3;

function usage(): string {
  return `
  spike-m5a (SPIKE-5) — whose volume is it, and does the television actually move it?
                        M5a, before any feature code. Six questions, one script.

    --device <name>       the television, exactly as named in Google Home (required)
    --address <ip>        skip discovery and go straight to an address (optional escape hatch)
    --port <n>            default ${String(CAST.port)}
    --device-wait <ms>    how long to wait for that name to answer mDNS (default 30000)

    --file <path>         a film this set plays NATIVELY (required — question 2 is answered
                          by an ear, and an ear needs sound)
    --max-level <0..1>    nothing louder than this is ever asked for (default 0.5)
    --upper-clamp         also ask for 1.5, to see the upper clamp.
                          ⚠️ THIS CAN SET THE ROOM TO MAXIMUM. Off by default, and the
                          report says the reading was skipped rather than pretending.
    --external-wait <ms>  how long to listen, WITHOUT polling, for a change made from a
                          second connection (default 15000)
    --remote-wait <ms>    how long to wait for a person with the television's own remote
                          (default 45000; 0 skips that leg and the report says so)
    --settle <ms>         how long the film plays before anything is touched (default 12000)
    --leg <name>          repeatable; one of: ${LEGS.join(', ')}
                          (default: all of them)

  IT IS AN OBSERVATION TOOL, NOT A TEST. It asserts nothing.

  **BE IN THE ROOM.** Two of the six questions cannot be answered by any instrument in this
  project: whether the SOUND changed when the number did, and which volume the television's
  OWN REMOTE moves. The spike prompts you when it needs you.

  ⚠️ **It puts the level and the mute back on every exit path, Ctrl-C included.** If the
  summary says the restore was NOT CONFIRMED, check that television by hand.
`;
}

export interface ParsedM5a {
  readonly deviceName: string;
  readonly address: string | null;
  readonly port: number;
  readonly deviceWaitMs: number;
  readonly filePath: string;
  readonly maxLevel: number;
  readonly testUpperClamp: boolean;
  readonly externalWaitMs: number;
  readonly remoteWaitMs: number;
  readonly settleMs: number;
  readonly legs: readonly LegName[];
}

export function parseArgs(argv: readonly string[]): ParsedM5a {
  let deviceName: string | null = null;
  let address: string | null = null;
  let port: number = CAST.port;
  let deviceWaitMs = 30_000;
  let filePath: string | null = null;
  let maxLevel = 0.5;
  let testUpperClamp = false;
  let externalWaitMs = 15_000;
  let remoteWaitMs = 45_000;
  let settleMs = 12_000;
  const legs: LegName[] = [];

  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) throw new SpikeAbort(`${flag} needs a value`);
    return next;
  };
  const positive = (raw: string, flag: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new SpikeAbort(`${flag} must be a number`);
    return parsed;
  };
  /** `--remote-wait 0` is meaningful: it means "nobody is in the room tonight". */
  const zeroOrMore = (raw: string, flag: string): number => {
    const parsed = Number(raw);
    if (!Number.isFinite(parsed) || parsed < 0) {
      throw new SpikeAbort(`${flag} must be a number of milliseconds, 0 or more`);
    }
    return parsed;
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--device':
        deviceName = value(index, flag);
        index += 1;
        break;
      case '--address':
        address = value(index, flag);
        index += 1;
        break;
      case '--port':
        port = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--device-wait':
        deviceWaitMs = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--file':
        filePath = value(index, flag);
        index += 1;
        break;
      case '--max-level': {
        const parsed = Number(value(index, flag));
        // A cap above 1.0 would silently defeat the whole point of having a cap, and a
        // television at maximum is a household problem rather than a finding.
        if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
          throw new SpikeAbort('--max-level must be a number greater than 0 and at most 1');
        }
        maxLevel = parsed;
        index += 1;
        break;
      }
      case '--upper-clamp':
        testUpperClamp = true;
        break;
      case '--external-wait':
        externalWaitMs = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--remote-wait':
        remoteWaitMs = zeroOrMore(value(index, flag), flag);
        index += 1;
        break;
      case '--settle':
        settleMs = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--leg': {
        const name = value(index, flag);
        if (!(LEGS as readonly string[]).includes(name)) {
          throw new SpikeAbort(`unknown leg "${name}" — one of: ${LEGS.join(', ')}`);
        }
        legs.push(name as LegName);
        index += 1;
        break;
      }
      case '-h':
      case '--help':
        throw new SpikeAbort(usage());
      default:
        throw new SpikeAbort(`unknown argument "${String(flag)}"\n${usage()}`);
    }
  }

  if (deviceName === null && address === null) {
    throw new SpikeAbort(`--device is required (or --address, as an escape hatch)\n${usage()}`);
  }
  if (filePath === null) throw new SpikeAbort(`--file is required\n${usage()}`);

  return {
    deviceName: deviceName ?? `(address ${address ?? '?'})`,
    address,
    port,
    deviceWaitMs,
    filePath,
    maxLevel,
    testUpperClamp,
    externalWaitMs,
    remoteWaitMs,
    settleMs,
    legs: legs.length > 0 ? legs : [...LEGS],
  };
}

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(usage());
    return COULD_NOT_RUN;
  }

  if (process.platform !== 'win32') {
    process.stderr.write(
      '\n[spike-m5a] cannot run: this drives a real Chromecast and only works on Windows.\n' +
        '            Run it from WSL with scripts/spike-m5a.sh --device "AI PONT" --file "…"\n',
    );
    return COULD_NOT_RUN;
  }

  const parsed = parseArgs(process.argv.slice(2));
  const paths = resolveAppPaths();
  const logger = createLogger({
    sink: combineSinks(createFileSink(paths.logDir, systemClock), createMemorySink()),
    clock: systemClock,
    level: 'debug',
    bindings: { component: 'spike-m5a-cli' },
  });

  const found =
    parsed.address === null
      ? await resolveDeviceByName({
          name: parsed.deviceName,
          logger,
          waitMs: parsed.deviceWaitMs,
        })
      : {
          friendlyName: parsed.deviceName,
          model: '(not discovered — --address was given)',
          address: parsed.address,
          port: parsed.port,
        };

  const report = await runSpikeM5a({
    deviceName: found.friendlyName,
    model: found.model,
    address: found.address,
    port: parsed.address === null ? found.port : parsed.port,
    filePath: parsed.filePath,
    maxLevel: parsed.maxLevel,
    testUpperClamp: parsed.testUpperClamp,
    externalWaitMs: parsed.externalWaitMs,
    remoteWaitMs: parsed.remoteWaitMs,
    settleMs: parsed.settleMs,
    legs: parsed.legs,
  });

  process.stderr.write(summariseM5a(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return report.unmeasured.length === 0 ? 0 : SOMETHING_UNMEASURED;
}

// **A volume belongs to the founder's television and outlives our process.** Ctrl-C is the
// most likely way this run ends early — a person watching the ladder and deciding they have
// seen enough — so the interrupt path is the one that most needs to put the set back.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stderr.write(
      `\n[spike-m5a] ${signal} — putting this television's volume back before exiting…\n`,
    );
    void restoreFoundVolume()
      .then((outcome) => {
        process.stderr.write(`[spike-m5a] ${outcome.note}\n`);
      })
      .finally(() => process.exit(COULD_NOT_RUN));
  });
}

main().then(
  (code) => {
    process.exitCode = code;
    forceExitIfHung(code);
  },
  (error: unknown) => {
    process.stderr.write(
      `\n[spike-m5a] cannot run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    // Even a failure puts the television back: the run may have thrown after the first rung.
    void restoreFoundVolume().then((outcome) => {
      if (outcome.attempted) process.stderr.write(`[spike-m5a] ${outcome.note}\n`);
      process.exitCode = COULD_NOT_RUN;
      forceExitIfHung(COULD_NOT_RUN);
    });
  },
);

/** A spike that never returns is as useless as one that lies. */
function forceExitIfHung(code: number): void {
  const timer = setTimeout(() => process.exit(code), 10_000);
  timer.unref?.();
}
