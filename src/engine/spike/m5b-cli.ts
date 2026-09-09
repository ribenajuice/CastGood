#!/usr/bin/env node
// SPIKE-4 — M5b step 0. Does a second LOAD into a running session start the
// next film without relaunching the receiver?
//
//   scripts/spike-m5b.sh --device "<name>" \
//                        --first "C:\path\to\one.mp4" \
//                        --second "C:\path\to\two.mp4"
//
//   --device <name>       the television, by the name it shows (required)
//   --address <ip>        skip discovery and go straight there (e.g. 192.0.2.10)
//   --first <path>        the film that is already playing (required)
//   --second <path>       the film loaded over it (required)
//   --hls-segments <dir>  a directory of .ts segments, published one at a time,
//                         to measure the GROWING-PLAYLIST handover as well
//   --hls-first           THE CONTROL. Load that playlist as the FIRST load on a
//                         fresh session instead of over a running film. If it plays,
//                         the segments are sound and a refusal during a handover is a
//                         real finding about loading HLS over a running film. If it
//                         does not play, the segments are what to fix and the handover
//                         question is still open.
//
// ⚠️ WITHOUT --hls-segments THE VERDICT IS `inconclusive`, AND THAT IS ON PURPOSE.
// 24y makes the second film a growing playlist whenever its conversion is
// unfinished, and a receiver already playing a film is not a state SPIKE-1 ever
// handed a playlist to. An MP4-only run measures the easy half; reporting the
// assumption as holding on the strength of it is the lying instrument this
// project keeps finding.
//
// EXIT CODES
//   0  the run happened and the report was printed
//   2  the run could not happen — no device, missing file, refused load, wrong OS
// There is no exit 1: a spike has findings, not failures.
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tlsTransportFactory } from '../cast/index.js';
import {
  combineSinks,
  createFileSink,
  createLogger,
  createMemorySink,
  systemClock,
} from '../logging/index.js';
import { resolveAppPaths } from '../paths.js';
import { resolveDeviceByName } from './device.js';
import { SpikeAbort } from './m2.js';
import { runSpikeM5b } from './m5b.js';

const COULD_NOT_RUN = 2;

function usage(): string {
  return `\n${String(
    /^(\/\/.*\n)+/m.exec('')?.[0] ?? '',
  )}see the header of src/engine/spike/m5b-cli.ts\n`;
}

function arg(argv: readonly string[], name: string): string | null {
  const i = argv.indexOf(name);
  return i >= 0 && i + 1 < argv.length ? (argv[i + 1] ?? null) : null;
}

async function main(): Promise<number> {
  if (process.argv.includes('--help') || process.argv.includes('-h')) {
    process.stderr.write(usage());
    return COULD_NOT_RUN;
  }
  if (process.platform !== 'win32') {
    process.stderr.write(
      '\n[spike-m5b] cannot run: this drives a real Chromecast and only works on Windows.\n' +
        '            Run it from WSL with scripts/spike-m5b.sh\n',
    );
    return COULD_NOT_RUN;
  }

  const argv = process.argv.slice(2);
  const deviceName = arg(argv, '--device');
  const address = arg(argv, '--address');
  const first = arg(argv, '--first');
  const second = arg(argv, '--second');
  const segmentDir = arg(argv, '--hls-segments');
  const hlsFirst = argv.includes('--hls-first');

  if (deviceName === null && address === null) {
    throw new SpikeAbort('--device (or --address) is required');
  }
  if (first === null || second === null) {
    throw new SpikeAbort('--first and --second are both required: this measures a handover');
  }
  for (const [flag, file] of [
    ['--first', first],
    ['--second', second],
  ] as const) {
    await fsp.stat(file).catch(() => {
      throw new SpikeAbort(`${flag} does not exist: ${file}`);
    });
  }

  let segments: string[] = [];
  let durations: number[] = [];
  if (segmentDir !== null) {
    const names = (await fsp.readdir(segmentDir)).filter((n) => n.endsWith('.ts')).sort();
    // ⚠️ **Read the real durations, never assume them.** ffmpeg writes its own playlist
    // beside the segments; its EXTINF lines are the truth. The first run of this spike
    // declared 4.0 s for segments that were 10.43 s, which is a malformed playlist, and
    // the television refused it — correctly. Guessing here produced a false CONTRADICTED
    // about a handover that was never attempted.
    const own = (await fsp.readdir(segmentDir)).find((n) => n.endsWith('.m3u8'));
    if (own !== undefined) {
      const text = await fsp.readFile(path.join(segmentDir, own), 'utf8');
      durations = [...text.matchAll(/#EXTINF:([0-9.]+)/g)].map((m) => Number(m[1]));
    }
    if (durations.length < names.length) {
      throw new SpikeAbort(
        `could not read a duration for every segment in ${segmentDir} (${String(durations.length)} of ${String(names.length)}). ` +
          'A playlist that declares the wrong duration is refused by the television, and the refusal would be reported as a finding about the queue.',
      );
    }
    if (names.length === 0) {
      throw new SpikeAbort(
        `--hls-segments named a directory with no .ts files in it: ${segmentDir}. ` +
          'A growing playlist with nothing to grow measures nothing.',
      );
    }
    segments = names.map((n) => path.join(segmentDir, n));
  }

  const paths = resolveAppPaths();
  const logger = createLogger({
    sink: combineSinks(createFileSink(paths.logDir, systemClock), createMemorySink()),
    clock: systemClock,
    level: 'debug',
    bindings: { component: 'spike-m5b-cli' },
  });

  const found =
    address === null
      ? await resolveDeviceByName({ name: deviceName ?? '', logger, waitMs: 30_000 })
      : {
          friendlyName: deviceName ?? '(by address)',
          model: '(not discovered)',
          address,
          port: 8009,
        };

  process.stderr.write(
    `\n[spike-m5b] ${found.friendlyName} (${found.model}) at ${found.address}\n` + hlsFirst
      ? '[spike-m5b] CONTROL RUN: the growing playlist is loaded FROM COLD, not over a film\n\n'
      : `[spike-m5b] handovers: mp4${segments.length > 0 ? ' and growing-hls' : ' ONLY — verdict will be inconclusive'}\n\n`,
  );

  const report = await runSpikeM5b({
    address: found.address,
    port: found.port,
    firstFile: first,
    secondFile: second,
    hlsSegments: segments,
    hlsDurations: durations,
    hlsFirst,
    logger,
    transport: tlsTransportFactory,
  });

  for (const f of report.findings) {
    process.stdout.write(`  ${f.question}\n      ${f.answer}\n`);
  }
  process.stdout.write('\n');
  for (const v of report.verdicts) {
    process.stdout.write(`  ASSUMPTION ${String(v.assumption)}: ${v.verdict.toUpperCase()}\n`);
    process.stdout.write(`    ${v.claim}\n    because ${v.because}\n`);
  }
  process.stdout.write(`\n${JSON.stringify(report)}\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`\n[spike-m5b] COULD NOT RUN: ${message}\n`);
    process.exit(COULD_NOT_RUN);
  },
);
