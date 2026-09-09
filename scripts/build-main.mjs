#!/usr/bin/env node
/**
 * Bundles the Electron main process and the preload script.
 *
 * Vite owns the renderer; esbuild owns these two, because they are Node/CJS and
 * Electron loads them directly. Output is `.cjs` on purpose: the package is ESM
 * ("type": "module") and a sandboxed preload must be CommonJS.
 *
 * Runtime dependencies stay external and are shipped as real node_modules by
 * electron-builder — bundling something like bonjour-service would defeat its own
 * dynamic requires for no benefit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import esbuild from 'esbuild';

const root = fileURLToPath(new URL('..', import.meta.url));
const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const external = ['electron', ...Object.keys(pkg.dependencies ?? {})];

const watch = process.argv.includes('--watch');

/** @type {import('esbuild').BuildOptions} */
const options = {
  entryPoints: {
    main: path.join(root, 'src/main/main.ts'),
    preload: path.join(root, 'src/main/preload.ts'),
  },
  outdir: path.join(root, 'dist/main'),
  outExtension: { '.js': '.cjs' },
  bundle: true,
  platform: 'node',
  format: 'cjs',
  // Electron 43.4.0 embeds Node 24 (verified from a real run on Windows — the
  // architecture doc's "Node 22" is out of date). node22 is a deliberate floor.
  target: 'node22',
  sourcemap: true,
  external,
  logLevel: 'info',
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
};

if (watch) {
  const context = await esbuild.context(options);
  await context.watch();
  console.log('[build-main] watching src/main and src/engine');
} else {
  await esbuild.build(options);
}
