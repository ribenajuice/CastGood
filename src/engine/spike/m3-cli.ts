import { runSpikeM3, summariseM3 } from './m3.js';
import { SpikeAbort } from './m2.js';
import { CAST } from '../config.js';

/**
 * SPIKE-1's process entry point — THROWAWAY, like everything else in this directory.
 * `scripts/spike-m3.mjs` bundles this file. See `m3.ts` for what it is for.
 *
 * Deliberately a copy of `cli.ts`'s shape: stdout is the JSON report and nothing else, the
 * readable summary goes to stderr, and the exit codes are **0** it ran and recorded, **2**
 * it could not run. There is no exit 1 — a television behaving unexpectedly is the finding.
 */

const COULD_NOT_RUN = 2;

function usage(): string {
  return `
  spike-m3 — does a real television play a film that is still being converted?

    --address <ip>        the device (required, e.g. 192.0.2.10)
    --port <n>            default ${String(CAST.port)}
    --fixture <dir>       a directory of .ts segments + source.m3u8 (required)
    --head-start <n>      segments published before the TV is told (default 3)
    --rate <n>            conversion speed vs playback (default 1.5; below 1.0 starves it)
    --watch <ms>          how long to watch before writing ENDLIST (default 300000)

  Make the fixture ONCE, on Windows, with ffmpeg:

    ffmpeg -i "C:\\path\\to\\film.mp4" -c copy -f hls -hls_time 4 \\
      -hls_list_size 0 -hls_segment_filename "%%03d.ts" source.m3u8

  The spike never converts anything. It republishes those segments on a timer exactly as a
  running conversion would, which is the only part a receiver can tell apart.
`;
}

interface Parsed {
  readonly address: string;
  readonly port: number;
  readonly fixtureDir: string;
  readonly headStartSegments: number;
  readonly publishRate: number;
  readonly watchMs: number;
}

export function parseArgs(argv: readonly string[]): Parsed {
  let address: string | null = null;
  let fixtureDir: string | null = null;
  let port: number = CAST.port;
  let headStartSegments = 3;
  let publishRate = 1.5;
  let watchMs = 300_000;

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
      case '--fixture':
        fixtureDir = value(index, flag);
        index += 1;
        break;
      case '--head-start':
        headStartSegments = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--rate':
        publishRate = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--watch':
        watchMs = positive(value(index, flag), flag);
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
  if (fixtureDir === null) throw new SpikeAbort(`--fixture is required\n${usage()}`);
  return { address, port, fixtureDir, headStartSegments, publishRate, watchMs };
}

async function main(): Promise<number> {
  // Same rule as every other Windows-side tool here: mDNS multicast and a TV opening a
  // connection back to this PC both fight WSL2's NAT, so a run in WSL would fail for
  // reasons that have nothing to do with the question being asked.
  if (process.platform !== 'win32') {
    process.stderr.write(
      '\n[spike-m3] cannot run: this drives a real Chromecast and only works on Windows.\n' +
        '           Run it from WSL with scripts/spike-m3.sh\n',
    );
    return COULD_NOT_RUN;
  }

  const parsed = parseArgs(process.argv.slice(2));
  const report = await runSpikeM3(parsed);
  process.stderr.write(summariseM3(report));
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
      `\n[spike-m3] cannot run: ${error instanceof Error ? error.message : String(error)}\n`,
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
