#!/usr/bin/env node
/**
 * SPIKE-3's Windows-side wrapper — THROWAWAY. Delete this and `src/engine/spike/`
 * when M3c's subtitle pipeline is built.
 *
 *   node scripts/spike-m3c.mjs --address 192.0.2.10 --file "C:\path\to\film.mp4"
 *
 * From WSL, do not call this directly: `scripts/spike-m3c.sh` runs it on the Windows
 * side, which is the only place a Chromecast is reachable.
 *
 * It is a copy of `scripts/spike-m2.mjs`'s shape on purpose — refuse anywhere but
 * Windows, bundle the TypeScript entry point with esbuild, run it, propagate the exit
 * code — because that path is proven and this is not the place to invent a new one.
 * It is deliberately NOT an npm script and NOT in CI: a spike is not part of the build.
 *
 * EXIT CODES
 *   0  it ran and recorded what it saw
 *   2  it could not run
 * There is no 1. A spike has findings, not promises: a device behaving unexpectedly is
 * the point, not a failure.
 *
 * STDOUT IS THE REPORT. One JSON object; everything else goes to stderr.
 */
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const COULD_NOT_RUN = 2;

const root = fileURLToPath(new URL('..', import.meta.url));
const args = process.argv.slice(2);

function cannotRun(message) {
  process.stderr.write(`\n[spike-m3c] cannot run: ${message}\n`);
  process.exit(COULD_NOT_RUN);
}

if (process.platform !== 'win32') {
  cannotRun(
    `SPIKE-3 drives a real Chromecast, and the TV has to open a TCP connection back to
  this machine — neither survives WSL2's NAT (CLAUDE.md). This is ${process.platform}.
  From WSL:  scripts/spike-m3c.sh --address 192.0.2.10 --file "C:\\path\\to\\film.mp4"`,
  );
}

const entry = path.join(root, 'src/engine/spike/m3c-cli.ts');
if (!existsSync(entry)) {
  cannotRun(`no spike entry point at ${path.relative(root, entry)} — has the spike been deleted?`);
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const outfile = path.join(root, 'dist/spike/spike-m3c.cjs');

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
    logLevel: 'silent',
  });
} catch (error) {
  const detail = (error?.errors ?? [])
    .map((e) => `    ${e.location?.file ?? '?'}:${e.location?.line ?? '?'} ${e.text}`)
    .join('\n');
  cannotRun(`the spike did not build.\n${detail || `    ${String(error)}`}`);
}

process.stderr.write(`[spike-m3c] args: ${JSON.stringify(args)}\n`);

const child = spawnSync(process.execPath, ['--enable-source-maps', outfile, ...args], {
  cwd: root,
  stdio: 'inherit',
});

if (child.error) cannotRun(`could not start the spike: ${child.error.message}`);
if (child.signal) cannotRun(`the spike was killed by ${child.signal}.`);

process.exit(child.status ?? COULD_NOT_RUN);
