import { z } from 'zod';
import { resolveAppPaths } from '../paths.js';
import { SELFTEST } from '../config.js';
import {
  abortActiveSelftest,
  OUTAGES,
  refuseOutage,
  refuseRate,
  refuseBroken,
  refuseTiming,
  runSelftest,
  SCENARIOS,
  type OutageKind,
  type ScenarioName,
  type SelftestVerdict,
  refuseWatch,
} from './index.js';

/**
 * The selftest's command line: argument parsing, the verdict summary, and the run.
 *
 * Kept separate from `cli.ts` — which is the entry point that *executes* — so all of this
 * can be imported by tests without a process exiting underneath them.
 *
 * Argument parsing is a boundary like any other, so it is schema-validated rather than
 * trusted: a typo in `--scenario` must produce a usage message and exit 2 ("this did not
 * happen"), never a run that silently does something else and exits 0.
 *
 * `--device` and `--file` are required and have no defaults. The founder's own values
 * are not hardcoded here until they have been confirmed against real hardware; a
 * default that quietly points at the wrong TV would be worse than typing the name.
 */

export const USAGE = `CastGood selftest — proves real casting against a real device.

  npm run selftest -- --device "<name>" --file "<path>" [--scenario <name>] [--duration <time>]

  --device    <name>   exact device name, as shown in the Google Home app (required)
  --file      <path>   a video file the device plays natively (required)
  --scenario  <name>   ${SCENARIOS.join(' | ')} (default: m1)
  --duration  <time>   how long the position scenario samples for, e.g. 90s, 10m (default: 10m)
  --rate      <n>      \`headstart\` only: run the conversion at this multiple of real time.
                       0.7 is the starved case — a conversion that cannot keep ahead of
                       playback — produced through the product rather than a spike. The gate
                       must refuse it; a run in which it opened anyway exits 2.
  --rate-after-gate <n>
                       \`headstart\` only, and the opposite run: full speed until the gate
                       opens and the film is playing, then this multiple of real time, so the
                       conversion **falls behind mid-film**. This is the only way to make the
                       margin guard fire on a real television — it produces the 2026-08-21
                       condition with the guard in place. Try 0.5.
  --watch     <time>   \`headstart\` only: watch the film for this long instead of the usual
                       three minutes, stopping early if it ends first, e.g. 130m. This is the
                       full-film run PRD 10b calls "the only evidence that counts" — it
                       presses nothing, makes no jump and grades every freeze across the
                       whole film. Zero stalls is the promise the product is built on.
  --broken             \`subtitles\` only: the refusal paths. Chooses four subtitle files that
                       cannot be read — an empty one, a binary, an HTML page saved as .srt
                       and an undecodable encoding — and checks each is refused **before**
                       Cast in one sentence with no file path in it; then declares a track
                       the television cannot fetch and checks the film plays on with
                       *Subtitles didn't load* said about it. Criteria 18j–18l. Takes no
                       value, and does not combine with --timing: they are two runs.
  --timing             \`subtitles\` only: story 20's run. Presses *later* on a film that is
                       already playing and measures what reaches the wire — how long the
                       track swap took, that four presses inside 400 ms cost exactly one
                       message, and that the film never stopped. Takes no value.
  --outage    <kind>   ${OUTAGES.join(' | ')} — which interruption \`recover\` produces (default: socket)
                       socket/heartbeat kill OUR connection and leave this PC's media
                       server reachable, so the television keeps getting the film's bytes
                       throughout; \`network\` takes the television's route to this PC away
                       as well — control channel and bytes — and gives it back, which is
                       the only automated outage that can produce defect D2; \`cable\` needs
                       YOU, at the PC, with the Ethernet cable — it prints what to do and
                       watches this PC's network for you doing it, and it is
                       \`--scenario recover\` only, never part of \`m1\` or \`m2\`.
  --data-dir  <path>   where logs and the verdict are written (default: %LOCALAPPDATA%\\CastGood)

Aggregates: \`m1\` and \`m2\` are unchanged and both still have to pass. \`m3\` runs the six
preparation scenarios in order — including \`headstart\`, which needs a film of at least
fifteen minutes that this television cannot play natively — and ends with \`prepfail\`, which
the PRD expects may not be able to finish on every machine.

\`m3c\` is the subtitle aggregate and the one command M3c is signed off on. It runs
\`subtitles\`, then \`subtitles --timing\`, then \`subtitles --broken\` — the refusal run last,
for the reason \`takeover\` is last in \`m2\`: it is the one whose abort is anticipated, and
last it strands nothing behind it. Every assertion is named after the leg it came from
(\`subtitles-timing.trackSwapMs\`). It needs a film with a subtitle — an embedded text track
or a matching .srt/.vtt beside it — and says so **before casting anything** when there is
none. \`--timing\` and \`--broken\` are refused beside it: it already runs both.

\`headstart\` exits **2**, never 0, when the gate never opened or the film was too short to
head-start: a run that quietly became something easier is not a pass.

M3a's scenarios build their own fixtures with the bundled ffmpeg — a Matroska copy for
\`remux\`, a 10-bit clip for \`convert\` — from the file you pass. They write into a scratch
folder and remove it afterwards; your own films folder is never written to. **A scenario
that cannot produce the condition it exists to test exits 2**, never 0.

Exit codes: 0 every assertion passed · 1 an assertion failed · 2 the run could not happen.`;

const DURATION = /^(\d+)(ms|s|m|h)?$/i;

export function parseDuration(text: string): number | null {
  const match = DURATION.exec(text.trim());
  if (match === null) return null;
  const value = Number(match[1]);
  switch ((match[2] ?? 'ms').toLowerCase()) {
    case 's':
      return value * 1_000;
    case 'm':
      return value * 60_000;
    case 'h':
      return value * 3_600_000;
    default:
      return value;
  }
}

const argsSchema = z.object({
  device: z.string().trim().min(1, 'a device name is required'),
  file: z.string().trim().min(1, 'a file path is required'),
  scenario: z.enum(SCENARIOS).default('m1'),
  duration: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const ms = parseDuration(value);
      if (ms === null || ms <= 0) {
        ctx.addIssue({ code: 'custom', message: `not a duration: "${value}" (try 90s or 10m)` });
        return z.NEVER;
      }
      return ms;
    }),
  watch: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const ms = parseDuration(value);
      if (ms === null || ms <= 0) {
        ctx.addIssue({ code: 'custom', message: `not a duration: "${value}" (try 130m)` });
        return z.NEVER;
      }
      return ms;
    }),
  outage: z.enum(OUTAGES).default('socket'),
  'rate-after-gate': z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const rate = Number(value);
      // Below 1 or it is not "falling behind" at all: at or above real time the frontier
      // keeps its lead and the guard has nothing to do.
      if (!Number.isFinite(rate) || rate <= 0 || rate >= 1) {
        ctx.addIssue({
          code: 'custom',
          message: `not a rate below real time: "${value}" (try 0.5 — at 1× or faster the conversion never falls behind and the guard cannot fire)`,
        });
        return z.NEVER;
      }
      return rate;
    }),
  rate: z
    .string()
    .optional()
    .transform((value, ctx) => {
      if (value === undefined) return undefined;
      const rate = Number(value);
      // Bounded on both sides: 0 is a conversion that never produces a frame, and anything
      // above 1 is not a starved case at all — it is an ordinary run with a slower machine.
      if (!Number.isFinite(rate) || rate <= 0 || rate > 4) {
        ctx.addIssue({ code: 'custom', message: `not a rate: "${value}" (try 0.7)` });
        return z.NEVER;
      }
      return rate;
    }),
  'data-dir': z.string().trim().min(1).optional(),
});

export interface ParsedArgs {
  readonly deviceName: string;
  readonly filePath: string;
  readonly scenario: ScenarioName;
  readonly positionDurationMs: number;
  readonly outage: OutageKind;
  /** `--rate`, for `headstart`'s starved case. */
  readonly conversionReadRate: number | undefined;
  /** `--rate-after-gate`: the conversion falls behind once the film is playing. */
  readonly conversionReadRateAfterGate: number | undefined;
  readonly headStartWatchMs: number | undefined;
  /** `--timing`, for `subtitles`' story-20 run. */
  readonly subtitleTiming: boolean;
  /** `--broken`, for `subtitles`' refusal run — 18j–18l. */
  readonly subtitleBroken: boolean;
  readonly dataDir: string | undefined;
  readonly help: boolean;
}

export type ArgsResult = { ok: true; args: ParsedArgs } | { ok: false; reason: string };

/** Accepts `--flag value` and `--flag=value`; anything else is an error, not a guess. */
export function parseArgs(argv: readonly string[]): ArgsResult {
  const raw: Record<string, string> = {};
  let help = false;
  let timing = false;
  let broken = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] as string;
    if (token === '--help' || token === '-h') {
      help = true;
      continue;
    }
    // A flag that takes no value, like `--help`. Everything else needs one, and a bare flag
    // that swallowed the next token would silently run a different scenario.
    if (token === '--timing') {
      timing = true;
      continue;
    }
    if (token === '--broken') {
      broken = true;
      continue;
    }
    if (!token.startsWith('--')) return { ok: false, reason: `unexpected argument: ${token}` };
    const equals = token.indexOf('=');
    if (equals !== -1) {
      raw[token.slice(2, equals)] = token.slice(equals + 1);
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      return { ok: false, reason: `${token} needs a value` };
    }
    raw[token.slice(2)] = value;
    index += 1;
  }

  if (help) {
    return {
      ok: true,
      args: {
        deviceName: '',
        filePath: '',
        scenario: 'm1',
        positionDurationMs: SELFTEST.positionDefaultDurationMs,
        outage: 'socket',
        conversionReadRate: undefined,
        conversionReadRateAfterGate: undefined,
        headStartWatchMs: undefined,
        subtitleTiming: false,
        subtitleBroken: false,
        dataDir: undefined,
        help: true,
      },
    };
  }

  const parsed = argsSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, reason: z.prettifyError(parsed.error) };

  // An outage a person has to perform, asked of a scenario that runs unattended. Refused
  // rather than quietly demoted to `socket`: a run that reported a pass for an outage it
  // never produced is the exact dishonesty this harness exists to prevent.
  const refusal = refuseOutage(parsed.data.scenario, parsed.data.outage);
  if (refusal !== null) return { ok: false, reason: refusal };
  // Same rule, second flag: a `--rate` that silently applied to the wrong scenario would
  // produce a slow run reported as an ordinary one.
  const rateRefusal = refuseRate(
    parsed.data.scenario,
    parsed.data.rate,
    parsed.data['rate-after-gate'],
  );
  if (rateRefusal !== null) return { ok: false, reason: rateRefusal };
  // Third flag, same rule: a full-film run asked for and silently not given would be read as
  // 10b's evidence.
  const watchRefusal = refuseWatch(
    parsed.data.scenario,
    parsed.data.watch,
    parsed.data.rate,
    parsed.data['rate-after-gate'],
  );
  if (watchRefusal !== null) return { ok: false, reason: watchRefusal };
  const timingRefusal = refuseTiming(parsed.data.scenario, timing);
  if (timingRefusal !== null) return { ok: false, reason: timingRefusal };
  // Fifth flag, the same rule again: an operator who asked for the refusal run and silently
  // got the ordinary one would read a green verdict as evidence that a television survived a
  // subtitle failure — which it would not be.
  const brokenRefusal = refuseBroken(parsed.data.scenario, broken, timing);
  if (brokenRefusal !== null) return { ok: false, reason: brokenRefusal };

  return {
    ok: true,
    args: {
      deviceName: parsed.data.device,
      filePath: parsed.data.file,
      scenario: parsed.data.scenario,
      positionDurationMs: parsed.data.duration ?? SELFTEST.positionDefaultDurationMs,
      outage: parsed.data.outage,
      conversionReadRate: parsed.data.rate,
      conversionReadRateAfterGate: parsed.data['rate-after-gate'],
      headStartWatchMs: parsed.data.watch,
      subtitleTiming: timing,
      subtitleBroken: broken,
      dataDir: parsed.data['data-dir'],
      help: false,
    },
  };
}

export interface CliIo {
  out(text: string): void;
  err(text: string): void;
}

const defaultIo: CliIo = {
  out: (text) => void process.stdout.write(text + '\n'),
  err: (text) => void process.stderr.write(text + '\n'),
};

/** One JSON object to stdout, a human summary to stderr, and the exit code (13a–13c). */
export async function runSelftestCli(
  argv: readonly string[],
  io: CliIo = defaultIo,
): Promise<0 | 1 | 2> {
  const parsed = parseArgs(argv);
  if (!parsed.ok) {
    io.err(`castgood selftest: ${parsed.reason}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.args.help) {
    io.out(USAGE);
    return 2;
  }

  const paths = resolveAppPaths(
    parsed.args.dataDir === undefined ? {} : { env: { CASTGOOD_DATA_DIR: parsed.args.dataDir } },
  );

  const verdict = await runSelftest({
    deviceName: parsed.args.deviceName,
    filePath: parsed.args.filePath,
    scenario: parsed.args.scenario,
    positionDurationMs: parsed.args.positionDurationMs,
    outage: parsed.args.outage,
    ...(parsed.args.conversionReadRate === undefined
      ? {}
      : { conversionReadRate: parsed.args.conversionReadRate }),
    ...(parsed.args.conversionReadRateAfterGate === undefined
      ? {}
      : { conversionReadRateAfterGate: parsed.args.conversionReadRateAfterGate }),
    // **Dropped here until 2026-08-26, and it cost the run it exists for.** `--watch` was
    // parsed, range-checked and guarded by `refuseWatch` — and then never handed to the
    // runner, so `headStartWatchMs` arrived `undefined`, the scenario took its ordinary
    // three-minute watch, `variant` stayed null, `filmReachedEnd` was never asserted, and a
    // 148-minute film reported **PASSED exit 0** after 6.8 minutes. Every guard around this
    // flag worked; the one line that carries it did not exist. That is 10b's evidence
    // fabricating itself, which is the single thing this harness exists to prevent.
    ...(parsed.args.headStartWatchMs === undefined
      ? {}
      : { headStartWatchMs: parsed.args.headStartWatchMs }),
    // Carried explicitly, for the reason directly above: a flag that is parsed, guarded and
    // then dropped produces a run that reports a pass for a promise it never tested.
    subtitleTiming: parsed.args.subtitleTiming,
    subtitleBroken: parsed.args.subtitleBroken,
    // The founder's instructions and the run's summary share one channel, and it is not
    // stdout — stdout carries the verdict JSON and `scripts/win-test.sh` parses it.
    instructions: (_stage, text) => io.err(text),
    paths,
  });

  io.out(JSON.stringify(verdict));
  io.err(summarise(verdict));
  // Say where it went, or say that it did not go anywhere. Telling the founder a file
  // exists when it does not is worse than saying nothing.
  io.err(
    verdict.environment.verdictFile === null
      ? `  the verdict could not be written to ${verdict.environment.logDir} — the JSON above is the only copy`
      : `  verdict written to ${verdict.environment.verdictFile}`,
  );
  return verdict.exitCode;
}

export function summarise(verdict: SelftestVerdict): string {
  const lines = [
    // The variant is printed beside the scenario, never folded into it: a `starved` run and
    // an ordinary one assert opposite things about the gate, and a reader who cannot tell
    // them apart can read a negative as evidence for the feature.
    `scenario ${verdict.scenario}${verdict.variant === null ? '' : ` (${verdict.variant})`} · device "${verdict.device}" · ${verdict.outcome.toUpperCase()} (exit ${String(verdict.exitCode)})`,
  ];
  if (verdict.reason !== null) lines.push(`  could not run: ${verdict.reason}`);
  // A verdict from an older run — or a hand-built one — has no observations. Reading a
  // saved artifact must never throw just because the shape has grown since.
  const observations = verdict.observations ?? [];
  const bare = (unit: string): boolean => unit === 'bool' || unit === 'state' || unit === 'states';
  const measurement = (item: (typeof verdict.assertions)[number]): string =>
    `${String(item.measured)}${bare(item.unit) ? '' : ' ' + item.unit}`;

  for (const item of verdict.assertions) {
    const symbol = item.passed ? 'PASS' : 'FAIL';
    const comparison = item.comparison === 'lte' ? '<=' : item.comparison === 'gte' ? '>=' : '==';
    lines.push(
      `  ${symbol} ${item.name}: measured ${measurement(item)} (target ${comparison} ${String(item.target)})`,
    );
  }

  if (observations.length > 0) {
    // Never PASS or FAIL. An observation has nothing to fail against, and printing it as a
    // pass would quietly turn "the television was slow tonight" into "we met a promise".
    lines.push('  — observed, not promised —');
    for (const item of observations) {
      lines.push(`  •••• ${item.name}: measured ${measurement(item)}`);
    }
  }

  lines.push(
    `  ${String(verdict.assertions.filter((item) => item.passed).length)}/${String(verdict.assertions.length)} promises met · ${String(observations.length)} observations reported`,
  );
  return lines.join('\n');
}

/** Installs interrupt handling so a Ctrl-C still releases the TV (13e). */
export function installSignalHandlers(
  exit: (code: number) => void = (code) => process.exit(code),
): void {
  let handling = false;
  const handler = (signal: string): void => {
    if (handling) return;
    handling = true;
    process.stderr.write(
      `\ncastgood selftest: ${signal} — stopping playback and releasing the device\n`,
    );
    void abortActiveSelftest().finally(() => exit(2));
  };
  process.on('SIGINT', () => handler('SIGINT'));
  process.on('SIGTERM', () => handler('SIGTERM'));
}
