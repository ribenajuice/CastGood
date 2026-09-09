#!/usr/bin/env node
/**
 * `npm run selftest` — the entry point for the headless selftest (PRD story 13).
 *
 *   npm run selftest -- --device "<name>" --file <path> --scenario <name>
 *
 * From WSL, do not call this directly: `scripts/win-test.sh` runs it on the
 * Windows side, which is the only place a Chromecast is reachable.
 *
 * What this wrapper does, and nothing more:
 *   1. refuses to run anywhere but Windows (exit 2). A selftest that "passed" in
 *      WSL or on a CI runner would be a lie — no device, no multicast, no proof.
 *   2. bundles the selftest entry point out of src/engine/ with esbuild, exactly
 *      the way scripts/build-main.mjs bundles the main process, because Node
 *      cannot run TypeScript that imports './x.js' from './x.ts'.
 *   3. runs it with the arguments it was given, untouched.
 *   4. propagates the child's exit code faithfully.
 *
 * EXIT CODES ARE THE CONTRACT (PRD 13c)
 *   0  every assertion passed
 *   1  an assertion failed
 *   2  the run could not happen at all
 * Everything this wrapper can fail at — wrong platform, missing entry point,
 * broken bundle, a child killed by a signal — is a run that could not happen,
 * so it exits 2. A failure to reach a device must never look like a pass.
 *
 * STDOUT IS THE VERDICT. One JSON object, nothing else — so
 * `npm run --silent selftest -- … > verdict.json` is a valid file. Everything
 * this wrapper says goes to stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

/** Could not run. The only exit code this wrapper is allowed to invent. */
const COULD_NOT_RUN = 2;

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);

function note(message) {
  process.stderr.write(`[selftest] ${message}\n`);
}

function cannotRun(message) {
  process.stderr.write(`\n[selftest] cannot run: ${message}\n`);
  process.exit(COULD_NOT_RUN);
}

// --- 1. Windows only ---------------------------------------------------------
// mDNS is multicast and the TV opens a TCP connection back to the PC; both fight
// WSL2's NAT (CLAUDE.md). No CI runner has a Chromecast either. Refusing here is
// what makes it impossible to report success without real hardware.
if (process.platform !== 'win32' && process.env.CASTGOOD_ALLOW_NON_WINDOWS !== '1') {
  cannotRun(
    `the selftest only runs on Windows (this is ${process.platform}).
  From WSL:  scripts/win-test.sh --device "<name>" --file "<C:\\path\\to.mp4>" --scenario m1
  Discovery is mDNS multicast and the device connects back to the PC — neither
  works through WSL2's NAT, so a verdict from here would prove nothing.`,
  );
}

// --- 2. Find the selftest entry point ---------------------------------------
// The engine owns the selftest (PRD 13f: it must drive the same engine through
// the same intents). Set CASTGOOD_SELFTEST_ENTRY to point somewhere else.
const CANDIDATES = [
  'src/engine/selftest/cli.ts',
  'src/engine/selftest/main.ts',
  'src/engine/selftest/index.ts',
  'src/engine/selftest.ts',
];

const override = process.env.CASTGOOD_SELFTEST_ENTRY;
const entry = override
  ? path.resolve(root, override)
  : CANDIDATES.map((candidate) => path.join(root, candidate)).find((file) => existsSync(file));

if (!entry || !existsSync(entry)) {
  cannotRun(
    `no selftest entry point found. Looked for:
${CANDIDATES.map((candidate) => `    ${candidate}`).join('\n')}
  Set CASTGOOD_SELFTEST_ENTRY to override.
  Arguments that would have been passed: ${JSON.stringify(args)}`,
  );
}

// --- 3. Bundle it ------------------------------------------------------------
// Same rules as scripts/build-main.mjs: CJS, node target, runtime dependencies
// left external so bonjour-service's dynamic requires keep working.
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const outfile = path.join(root, 'dist/selftest/selftest.cjs');

try {
  await esbuild.build({
    entryPoints: [entry],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node22',
    sourcemap: true,
    external: ['electron', ...Object.keys(pkg.dependencies ?? {})],
    // esbuild writes to stderr, but keep stdout clean under any future change.
    logLevel: 'silent',
    define: {
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    },
  });
} catch (error) {
  const detail = (error?.errors ?? [])
    .map((e) => `    ${e.location?.file ?? '?'}:${e.location?.line ?? '?'} ${e.text}`)
    .join('\n');
  cannotRun(`the selftest did not build.\n${detail || `    ${String(error)}`}`);
}

note(`${path.relative(root, entry)} -> ${path.relative(root, outfile)}`);
// Printed every run: it is the only place a WSL session can see what survived the
// hop through cmd.exe — a device name with spaces is easy to mangle and hard to
// notice, because a mangled name looks exactly like a device that was not found.
note(`args: ${JSON.stringify(args)}`);

// --- 4. Run it, and hand back its exit code untouched ------------------------
// stdout is captured only so the guard below can look at it; it is written out
// byte for byte either way. stdin and stderr are the child's.
const child = spawnSync(process.execPath, ['--enable-source-maps', outfile, ...args], {
  cwd: root,
  stdio: ['inherit', 'pipe', 'inherit'],
  maxBuffer: 64 * 1024 * 1024,
});

const stdout = child.stdout ? child.stdout.toString() : '';
if (stdout) process.stdout.write(stdout);

if (child.error) {
  cannotRun(`could not start the selftest: ${child.error.message}`);
}

if (child.signal) {
  // Ctrl-C or a kill is not a verdict. PRD 13e still expects the scenario's own
  // cleanup to have released the device on the way out.
  cannotRun(`the selftest was killed by ${child.signal} before it reached a verdict.`);
}

/** PRD 13a: the verdict is one JSON object on stdout. No object, no verdict. */
function containsVerdict(text) {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const attempts = [trimmed, ...trimmed.split('\n').reverse()];
  for (const attempt of attempts) {
    const candidate = attempt.trim();
    if (!candidate.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object') return true;
    } catch {
      /* keep looking */
    }
  }
  return false;
}

const status = child.status ?? COULD_NOT_RUN;

// The one thing worse than a failure is a silent pass. Exit 0 with no verdict on
// stdout means the entry point ran and asserted nothing — a library imported
// instead of a CLI, or a scenario that returned without printing. Not a pass.
if (status === 0 && !containsVerdict(stdout)) {
  cannotRun(
    `the selftest exited 0 but printed no JSON verdict.
  Entry point: ${path.relative(root, entry)}
  It must print exactly one JSON object to stdout and exit 0/1/2 (PRD 13a, 13c).
  Nothing was proved, so this is reported as "could not run", never as a pass.`,
  );
}

process.exit(status);
