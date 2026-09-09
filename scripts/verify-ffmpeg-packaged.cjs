/**
 * Fail the build if the packaged app does not actually contain ffmpeg.
 *
 * WHY THIS EXISTS
 * ---------------
 * *Allow through the firewall* shipped in a state that could not have worked, and nothing
 * noticed until a human tried it (see test/architecture/firewall-rules.test.ts). An
 * installer without ffmpeg is the same shape of defect with a worse ending: everything
 * installs, the app opens, devices appear, and the founder's first conversion dies with a
 * diagnostic-free error on a machine they cannot debug. A fetch step that quietly no-ops,
 * a `filter:` that stops matching, an `extraResources` block someone comments out while
 * debugging — all of those produce a green build and a broken product.
 *
 * So the binaries are checked where they will actually live, twice:
 *
 *   1. as electron-builder's `afterPack` hook — after the app directory is laid out and
 *      *before* NSIS compresses it, so a bad build never reaches an .exe at all;
 *   2. as a plain CLI at the end of `npm run build:win`:
 *        node scripts/verify-ffmpeg-packaged.cjs --packaged [dir]
 *      because a hook that silently stops being called (a config typo, an
 *      electron-builder change) would take the guarantee with it, and a hook cannot
 *      report its own absence.
 *
 * CommonJS on purpose: package.json is `"type": "module"`, and electron-builder loads
 * hooks by path. `.cjs` is the one extension that is unambiguous to both loaders.
 */
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const pin = JSON.parse(fs.readFileSync(path.join(root, 'build', 'ffmpeg-pin.json'), 'utf8'));

/** Must equal `extraResources[].to` in electron-builder.yml and PACKAGED_BIN_DIR in the engine. */
const PACKAGED_BIN_DIR = 'bin';

/**
 * Licence files that must sit in the packaged `resources/`, named by their `to:` in
 * electron-builder.yml. ffmpeg's own GPL text is not here — it lives under `bin/` and is
 * covered by the pin loop above, which checks its SHA-256 as well as its presence.
 */
const LICENCE_FILES = ['LICENSE.txt', 'THIRD-PARTY-NOTICES.txt'];

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * @param {string} resourcesDir the packaged `resources/` directory
 * @param {string} where human-readable description of what was checked, for the message
 */
function verifyResources(resourcesDir, where) {
  const binDir = path.join(resourcesDir, PACKAGED_BIN_DIR);
  const problems = [];

  if (!fs.existsSync(binDir)) {
    problems.push(`${binDir} does not exist — nothing was copied by extraResources`);
  } else {
    for (const entry of pin.files) {
      const target = path.join(binDir, entry.to);
      if (!fs.existsSync(target)) {
        problems.push(`${entry.to} is missing from ${binDir}`);
        continue;
      }
      const size = fs.statSync(target).size;
      if (entry.bytes !== undefined && size !== entry.bytes) {
        problems.push(`${entry.to} is ${size} bytes, expected ${entry.bytes}`);
        continue;
      }
      // The hash is what makes this a check on *the pinned build* rather than on any file
      // of roughly the right size sitting in the right place.
      if (entry.sha256 !== undefined) {
        const digest = sha256(target);
        if (digest !== entry.sha256) {
          problems.push(`${entry.to} is SHA-256 ${digest}, expected ${entry.sha256}`);
        }
      }
    }
  }

  // The licence files are checked in the same pass and thrown as the same error, because
  // they fail the same way: an `extraResources` entry that stops matching produces a green
  // build and a non-compliant installer. Shipping a GPL binary without its licence text is
  // not a cosmetic miss — it is the one obligation the 2026-08-13 ffmpeg ADR took on.
  for (const entry of LICENCE_FILES) {
    const target = path.join(resourcesDir, entry);
    if (!fs.existsSync(target)) {
      problems.push(`${entry} is missing from ${resourcesDir} — the installer is not compliant`);
    } else if (fs.statSync(target).size === 0) {
      problems.push(`${entry} is empty`);
    }
  }

  if (problems.length > 0) {
    throw new Error(
      `\n\nCastGood would have shipped without a working ffmpeg, or without the licences it\n` +
        `must carry.\n` +
        `  Checked: ${where}\n` +
        problems.map((problem) => `    - ${problem}`).join('\n') +
        `\n\n  Fix it with:  node scripts/fetch-ffmpeg.mjs` +
        `  (licences: node scripts/generate-notices.mjs)\n` +
        `  Then rebuild. The binaries are pinned in build/ffmpeg-pin.json (ffmpeg ` +
        `${pin.version}); nothing here falls back to an ffmpeg that happens to be on this\n` +
        `  machine, because that is how an installer ships broken and passes anyway.\n`,
    );
  }

  const bytes = pin.files.reduce((total, entry) => total + (entry.bytes ?? 0), 0);
  process.stdout.write(
    `  • ffmpeg ${pin.version} (${pin.license}) verified in ${where} ` +
      `— ${(bytes / 1024 / 1024).toFixed(0)} MB across ${pin.files.length} files\n`,
  );
  process.stdout.write(
    `  • licences verified in ${where} — ${LICENCE_FILES.join(', ')}, ` +
      `plus ffmpeg's own GPL text in ${PACKAGED_BIN_DIR}/\n`,
  );
}

/** electron-builder's afterPack hook. `context.appOutDir` is the unpacked app directory. */
async function afterPack(context) {
  verifyResources(
    path.join(context.appOutDir, 'resources'),
    path.relative(root, context.appOutDir),
  );
}

// electron-builder resolves the hook as `module[name] || module.default || module`, and the
// same file is run directly from npm. All three shapes point at the same function so that
// none of those paths can quietly resolve to something that checks nothing.
module.exports = afterPack;
module.exports.default = afterPack;
module.exports.afterPack = afterPack;

if (require.main === module) {
  const args = process.argv.slice(2);
  const explicit = args.find((arg) => !arg.startsWith('--'));
  const appOutDir = explicit
    ? path.resolve(explicit)
    : path.join(root, 'dist', 'installer', 'win-unpacked');
  if (!fs.existsSync(appOutDir)) {
    process.stderr.write(
      `\n[verify-ffmpeg] no packaged app at ${appOutDir}.\n` +
        `  Run this after electron-builder, or pass the unpacked directory as an argument.\n`,
    );
    process.exit(1);
  }
  try {
    verifyResources(path.join(appOutDir, 'resources'), path.relative(root, appOutDir));
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}
