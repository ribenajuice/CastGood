import { runSpikeM3c, summariseM3c } from './m3c.js';
import { SpikeAbort } from './m2.js';
import { CAST } from '../config.js';

/**
 * SPIKE-3's process entry point — THROWAWAY, like everything else in this directory.
 * `scripts/spike-m3c.mjs` bundles this file. See `m3c.ts` for what it is for.
 *
 * Deliberately the same shape as `m3-cli.ts`: stdout is the JSON report and nothing else,
 * the readable summary goes to stderr, and the exit codes are **0** it ran and recorded,
 * **2** it could not run. There is no exit 1 — a television behaving unexpectedly is the
 * finding, and it is the reason the spike exists.
 */

const COULD_NOT_RUN = 2;

function usage(): string {
  return `
  spike-m3c — can a television be given subtitles, and can they be CHANGED mid-film?

    --address <ip>        the device (required, e.g. 192.0.2.10)
    --port <n>            default ${String(CAST.port)}
    --file <path>         a film this television plays NATIVELY (required)
    --settle <ms>         how long to let the film run before the first toggle (default 8000)

  The film is only a carrier: the track is what is under test, so pass something the
  television plays with no conversion at all — a prepared "(CastGood).mp4" is ideal.
  The two WebVTT tracks are written by the spike itself into a temp folder, so there is
  no fixture to make and nothing of the founder's is read or written.

  IT ANSWERS M3c's FIVE ASSUMPTIONS, and the fifth decides a founder-visible thing:
  whether story 20's timing control is nudge buttons or set-then-Apply.

  **READ THE TELEVISION WHILE IT RUNS.** This spike can see fetches, states and timings;
  only a person can see whether the WORDS appeared, which track they came from, and
  whether they were in sync. Cue one of each track names itself — "TRACK A" or "TRACK B".
`;
}

interface Parsed {
  readonly address: string;
  readonly port: number;
  readonly filePath: string;
  readonly settleMs: number;
}

export function parseArgs(argv: readonly string[]): Parsed {
  let address: string | null = null;
  let filePath: string | null = null;
  let port: number = CAST.port;
  let settleMs = 8_000;

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

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    switch (flag) {
      case '--address':
        address = value(index, flag);
        index += 1;
        break;
      case '--port':
        port = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--file':
        filePath = value(index, flag);
        index += 1;
        break;
      case '--settle':
        settleMs = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--help':
      case '-h':
        throw new SpikeAbort(usage());
      default:
        throw new SpikeAbort(`unknown argument "${String(flag)}"\n${usage()}`);
    }
  }

  if (address === null) throw new SpikeAbort(`--address is required\n${usage()}`);
  if (filePath === null) throw new SpikeAbort(`--file is required\n${usage()}`);
  return { address, port, filePath, settleMs };
}

async function main(): Promise<number> {
  // Same rule as every other Windows-side tool here: mDNS multicast and a TV opening a
  // connection back to this PC both fight WSL2's NAT, so a run in WSL would fail for
  // reasons that have nothing to do with the question being asked.
  if (process.platform !== 'win32') {
    process.stderr.write(
      '\n[spike-m3c] cannot run: this drives a real Chromecast and only works on Windows.\n' +
        '            Run it from WSL with scripts/spike-m3c.sh\n',
    );
    return COULD_NOT_RUN;
  }

  const parsed = parseArgs(process.argv.slice(2));
  const report = await runSpikeM3c(parsed);
  process.stderr.write(summariseM3c(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
    forceExitIfHung(code);
  },
  (error: unknown) => {
    process.stderr.write(
      `\n[spike-m3c] cannot run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = COULD_NOT_RUN;
    forceExitIfHung(COULD_NOT_RUN);
  },
);

/** A spike that never returns is as useless as one that lies. */
function forceExitIfHung(code: number): void {
  const timer = setTimeout(() => process.exit(code), 10_000);
  timer.unref?.();
}
