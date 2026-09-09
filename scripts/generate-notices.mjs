#!/usr/bin/env node
/**
 * Builds THIRD-PARTY-NOTICES.txt from the *production* dependency tree.
 *
 * Why this exists: CastGood is MIT, but the installer redistributes other people's
 * code — every production dependency ends up inside `app.asar`, and Electron itself
 * ships beside it. MIT and BSD both require the copyright notice to travel with the
 * binary, so an installer with no notices file is not compliant, however permissive
 * every licence in it happens to be.
 *
 * Deliberately production-only. Devtools (vitest, eslint, electron-builder) are not
 * redistributed and listing them would pad the file with software the founder never
 * ships. `npm ls --prod --all` is the authority on which is which.
 *
 * ⚠️ ffmpeg is NOT here and must not be added. It is GPL-3.0-or-later, it is not an
 * npm package, and it ships its own full licence text next to the binary
 * (resources/bin/LICENSE.ffmpeg.txt). Folding a GPL text into a list headed "the
 * following MIT packages" is how a compliance file starts lying.
 *
 *   node scripts/generate-notices.mjs            write THIRD-PARTY-NOTICES.txt
 *   node scripts/generate-notices.mjs --check    fail if it is out of date
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(root, 'THIRD-PARTY-NOTICES.txt');
const CHECK = process.argv.includes('--check');

const log = (m) => process.stdout.write(`\x1b[36m[notices]\x1b[0m ${m}\n`);
const fail = (m) => {
  process.stderr.write(`\x1b[31m[notices] ${m}\x1b[0m\n`);
  process.exit(1);
};

/** Every package that actually ships, plus Electron, which is a devDependency but is the runtime. */
function shippedPackages() {
  let out;
  try {
    out = execFileSync('npm', ['ls', '--omit=dev', '--all', '--parseable'], {
      cwd: root,
      encoding: 'utf8',
    });
  } catch (error) {
    // `npm ls` exits non-zero on peer-dep warnings while still printing a usable tree.
    out = error.stdout ?? '';
  }
  const dirs = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.includes(`${path.sep}node_modules${path.sep}`));

  // Electron is a devDependency by necessity — electron-builder consumes it at package
  // time — but its runtime is the largest single thing the founder installs. Omitting it
  // because of which npm field it sits in would be a technicality, not an argument.
  dirs.push(path.join(root, 'node_modules', 'electron'));

  return [...new Set(dirs)].sort();
}

function readPackage(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!fs.existsSync(manifest)) return null;
  const pkg = JSON.parse(fs.readFileSync(manifest, 'utf8'));

  const candidates = fs
    .readdirSync(dir)
    .filter((f) => /^(licen[cs]e|copying)/i.test(f))
    .sort();
  const text =
    candidates.length > 0 ? fs.readFileSync(path.join(dir, candidates[0]), 'utf8').trim() : null;

  return {
    name: pkg.name,
    version: pkg.version,
    license: typeof pkg.license === 'string' ? pkg.license : (pkg.license?.type ?? 'UNKNOWN'),
    homepage: pkg.homepage ?? pkg.repository?.url ?? null,
    text,
  };
}

const packages = shippedPackages()
  .map(readPackage)
  .filter((p) => p !== null)
  .sort((a, b) => a.name.localeCompare(b.name));

if (packages.length === 0) fail('found no shipped packages — run `npm install` first');

const missing = packages.filter((p) => p.text === null);
if (missing.length > 0) {
  // A package whose licence text we cannot find is the one case worth stopping for: we
  // would be shipping its code while claiming attribution we did not actually include.
  fail(
    `no licence text found for:\n${missing.map((p) => `    - ${p.name}@${p.version}`).join('\n')}`,
  );
}

const header = `CastGood — third-party notices
${'='.repeat(70)}

CastGood itself is MIT licensed; see LICENSE.

The software below is redistributed inside this installer under its own terms.
Generated from the production dependency tree by scripts/generate-notices.mjs —
edit that script, never this file.

⚠️ ffmpeg and ffprobe are NOT listed here. They are GPL-3.0-or-later, they are not
npm packages, and they are invoked as separate programs rather than linked. Their
full licence, build configuration and upstream commit ship beside the binaries in
resources/bin/ — see LICENSE.ffmpeg.txt, BUILD.ffmpeg.txt and ffmpeg-build.json.

Chromium and Node.js are redistributed as part of Electron, which carries their
licences in its own LICENSES.chromium.html beside the executable.

${'='.repeat(70)}

Summary — ${packages.length} package${packages.length === 1 ? '' : 's'}:

${packages.map((p) => `  ${p.name}@${p.version} — ${p.license}`).join('\n')}

`;

const body = packages
  .map(
    (p) =>
      `${'-'.repeat(70)}\n${p.name}@${p.version} (${p.license})\n` +
      `${p.homepage === null ? '' : `${p.homepage}\n`}${'-'.repeat(70)}\n\n${p.text}\n`,
  )
  .join('\n');

const content = `${header}${body}`;

if (CHECK) {
  const current = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8') : '';
  if (current !== content) {
    fail('THIRD-PARTY-NOTICES.txt is out of date — run `npm run notices`');
  }
  log(`up to date (${packages.length} packages)`);
} else {
  fs.writeFileSync(OUT, content);
  log(`wrote ${path.relative(root, OUT)} (${packages.length} packages)`);
}
