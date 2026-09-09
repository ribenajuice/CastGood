import {
  abortActiveSpike,
  PROBES,
  runSpike,
  SpikeAbort,
  summarise,
  type ProbeName,
  type SpikeOptions,
} from './m2.js';
import { CAST } from '../config.js';

/**
 * SPIKE-2's process entry point — THROWAWAY, like everything else in this directory.
 * `scripts/spike-m2.mjs` bundles this file. See `m2.ts` for what it is for.
 *
 * stdout is the JSON report and nothing else; the readable summary goes to stderr, so
 * `… > findings.json` is a valid file and a WSL session can read the summary live.
 *
 * Exit codes: **0** it ran and recorded what it saw; **2** it could not run. There is no
 * exit 1 — a spike has findings, not promises, and a device behaving unexpectedly is a
 * successful run, not a failure.
 */

const COULD_NOT_RUN = 2;

interface Parsed {
  readonly options: SpikeOptions;
}

function usage(): string {
  return `
  spike-m2 — a throwaway probe of what a real Chromecast does (PRD M2, build order step 1)

    --address <ip>        the device (required, e.g. 192.0.2.10)
    --port <n>            default ${String(CAST.port)}
    --file <path>         Windows path to a long video (required)
    --probe <name>        repeatable; one of: ${PROBES.join(', ')}
                          default: socket, seek
    --takeover-app <id>   app to launch as the thief (default 233637DE, YouTube)
    --takeover-human      wait for a person to cast from a phone instead
    --human-wait <ms>     how long to wait for that person (default 90000)
    --outage <ms>         how long our socket stays dead (default 15000)

  reattach is two runs, in two processes, on purpose:
    --probe reattach-start     leaves the TV playing and exits
    --probe reattach-join      a fresh process rejoins it
`;
}

export function parseArgs(argv: readonly string[]): Parsed {
  let address: string | null = null;
  let filePath: string | null = null;
  let port: number = CAST.port;
  const probes: ProbeName[] = [];
  let takeoverAppId: string | null | undefined = undefined;
  let humanWaitMs: number | undefined;
  let outageMs: number | undefined;

  const value = (index: number, flag: string): string => {
    const next = argv[index + 1];
    if (next === undefined || next.startsWith('--')) {
      throw new SpikeAbort(`${flag} needs a value`);
    }
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
      case '--probe': {
        const name = value(index, flag);
        if (!(PROBES as readonly string[]).includes(name)) {
          throw new SpikeAbort(`unknown probe "${name}" — one of: ${PROBES.join(', ')}`);
        }
        probes.push(name as ProbeName);
        index += 1;
        break;
      }
      case '--takeover-app':
        takeoverAppId = value(index, flag);
        index += 1;
        break;
      case '--takeover-human':
        takeoverAppId = null;
        break;
      case '--human-wait':
        humanWaitMs = positive(value(index, flag), flag);
        index += 1;
        break;
      case '--outage':
        outageMs = positive(value(index, flag), flag);
        index += 1;
        break;
      case '-h':
      case '--help':
        throw new SpikeAbort(usage());
      default:
        throw new SpikeAbort(`unknown argument "${String(flag)}"\n${usage()}`);
    }
  }

  if (address === null) throw new SpikeAbort(`--address is required\n${usage()}`);
  if (filePath === null) throw new SpikeAbort(`--file is required\n${usage()}`);

  return {
    options: {
      address,
      port,
      filePath,
      // Two probes that need no human and leave the TV released: the safe default.
      probes: probes.length > 0 ? probes : ['socket', 'seek'],
      ...(takeoverAppId === undefined ? {} : { takeoverAppId }),
      ...(humanWaitMs === undefined ? {} : { humanWaitMs }),
      ...(outageMs === undefined ? {} : { outageMs }),
    },
  };
}

async function main(): Promise<number> {
  // Readable from anywhere, including WSL: someone deciding which probe to run should
  // not have to be on Windows to see the list.
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(usage());
    return COULD_NOT_RUN;
  }

  // The app never runs in WSL and neither does this: mDNS is not used here, but the TV
  // still has to open a TCP connection back to this machine to fetch the video.
  if (process.platform !== 'win32') {
    process.stderr.write(
      '\n[spike-m2] cannot run: this drives a real Chromecast and only works on Windows.\n' +
        '  From WSL:  scripts/spike-m2.sh --address <device-ip> --file "C:\\path\\to.mp4"\n',
    );
    return COULD_NOT_RUN;
  }

  const parsed = parseArgs(process.argv.slice(2));
  const report = await runSpike(parsed.options);
  process.stderr.write(summarise(report));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  return 0;
}

// Ctrl-C still hands the television back. A spike that leaves a TV playing is a spike
// nobody runs twice.
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    process.stderr.write(`\n[spike-m2] ${signal} — releasing the device…\n`);
    void abortActiveSpike().finally(() => process.exit(COULD_NOT_RUN));
  });
}

main().then(
  (code) => {
    process.exitCode = code;
    forceExitIfHung(code);
  },
  (error: unknown) => {
    process.stderr.write(
      `\n[spike-m2] cannot run: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = COULD_NOT_RUN;
    forceExitIfHung(COULD_NOT_RUN);
  },
);

/** A spike that never returns is as useless as one that lies. Unreferenced on purpose. */
function forceExitIfHung(code: number): void {
  const timer = setTimeout(() => process.exit(code), 10_000);
  timer.unref?.();
}
