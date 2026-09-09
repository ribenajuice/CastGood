#!/usr/bin/env node
/**
 * Dev loop: Vite dev server for the renderer + esbuild watch for main + Electron.
 *
 * IMPORTANT: this only ever runs on **Windows**. Discovery is mDNS multicast and the
 * TV has to open a TCP connection back to this machine — both fight WSL2's NAT. From
 * WSL, run `scripts/win-run.sh`, which syncs to C:\CastGood and starts this there.
 *
 * Renderer edits hot-reload. Main-process edits rebuild but need Electron restarting
 * (Ctrl-C, run again) — deliberately simple; an auto-restarter can come later if the
 * loop turns out to hurt.
 */
import { spawn } from 'node:child_process';
import process from 'node:process';
import { createServer } from 'vite';
import esbuild from 'esbuild';
import electronPath from 'electron';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));

const buildContext = await esbuild.context({
  entryPoints: {
    main: path.join(root, 'src/main/main.ts'),
    preload: path.join(root, 'src/main/preload.ts'),
  },
  outdir: path.join(root, 'dist/main'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  sourcemap: true,
  external: ['electron', ...Object.keys(pkg.dependencies ?? {})],
  define: { 'process.env.NODE_ENV': JSON.stringify('development') },
  logLevel: 'info',
});
await buildContext.rebuild();
await buildContext.watch();

const server = await createServer({ configFile: path.join(root, 'vite.config.ts') });
await server.listen();
const url = server.resolvedUrls?.local?.[0];
if (!url) {
  throw new Error('dev: Vite did not report a local URL');
}
server.printUrls();

const child = spawn(electronPath, ['.'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, VITE_DEV_SERVER_URL: url, NODE_ENV: 'development' },
});

let childExited = false;

const shutdown = async (code) => {
  // Kill Electron first. Without this, a SIGTERM from a non-interactive caller
  // (`timeout 60 scripts/win-run.sh`, a closed terminal) kills this process and
  // leaves electron.exe running with a window on the Windows desktop — the exact
  // mess scripts/win-stop.sh exists to clean up.
  if (!childExited) {
    child.kill();
  }
  await buildContext.dispose();
  await server.close();
  process.exit(code ?? 0);
};

child.on('exit', (code) => {
  childExited = true;
  void shutdown(code ?? 0);
});

process.on('SIGINT', () => void shutdown(0));
process.on('SIGTERM', () => void shutdown(0));
