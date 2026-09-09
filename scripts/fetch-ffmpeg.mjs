#!/usr/bin/env node
/**
 * Put the pinned ffmpeg.exe and ffprobe.exe where the app can find them.
 *
 *   node scripts/fetch-ffmpeg.mjs            fetch if needed, verify, exit 0
 *   node scripts/fetch-ffmpeg.mjs --check    verify only; never downloads
 *   node scripts/fetch-ffmpeg.mjs --force    re-extract even if they look right
 *
 * WHAT IS PINNED, AND WHY IT IS PINNED THAT HARD
 * ----------------------------------------------
 * `build/ffmpeg-pin.json` names one version, one URL and one SHA-256 per file. The
 * floating aliases the same publishers offer — `ffmpeg-release-essentials.zip`,
 * BtbN's `latest` tag — hand you a different encoder on Tuesday than on Monday for
 * the same commit of this repo, which is a conversion the founder cannot reproduce
 * and a bug report nobody can act on. Everything here is verified by hash, so a
 * substituted or truncated download fails loudly at build time rather than quietly
 * at the founder's first conversion.
 *
 * WHY NOT AN npm postinstall
 * --------------------------
 * Decided 2026-08-13 ("Bundle ffmpeg and ffprobe as pinned binaries"): a postinstall
 * download runs on every `npm ci`, including the Linux CI job that has no use for a
 * Windows binary, and it hides the fetch inside a step nobody reads. This runs as the
 * first line of `npm run build:win`, where it is visible and where failing stops the
 * installer being built at all.
 *
 * WHY THE DOWNLOAD IS CACHED OUTSIDE THE REPO
 * -------------------------------------------
 * `scripts/win-sync.sh` mirrors the tree to C:\CastGood with `rsync --delete` on every
 * `win-run.sh`. A 110 MB archive and 200 MB of extracted binaries inside the tree would
 * cross that link on every dev loop, and `--delete` would remove anything the Windows
 * side had fetched for itself. So:
 *   - the archive lives in a per-user cache **outside** the tree (%LOCALAPPDATA% on
 *     Windows, $XDG_CACHE_HOME on Linux), which no sync can see or delete;
 *   - the extracted binaries live in `resources/bin/`, which is gitignored *and*
 *     excluded from the rsync, so each side keeps its own copy and neither is copied
 *     over the boundary. `test/architecture/ffmpeg-bundled.test.ts` checks both.
 *
 * WHY THERE IS NO PATH FALLBACK ANYWHERE IN THIS FEATURE
 * -----------------------------------------------------
 * ffmpeg was installed on the founder's PC by winget during an M3 spike. If anything
 * here silently fell back to that copy, a broken fetch would work perfectly on the one
 * machine we test on and ship an installer with no encoder in it — the exact
 * ship-it-broken-and-notice-later failure `test/architecture/firewall-rules.test.ts`
 * exists because of. The only escape hatch is the explicit `CASTGOOD_FFMPEG_DIR`.
 *
 * The zip is read with a small inflate-only reader rather than an external tool,
 * because `unzip` is not on a stock Windows PATH, `tar.exe` only reads zips on
 * Windows 10+, and neither failure would be obvious on a CI runner.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const PIN_FILE = path.join(root, 'build', 'ffmpeg-pin.json');

/**
 * Where the extracted binaries go. Must stay identical to `PROJECT_BIN_DIR` in
 * `src/engine/media/ffmpeg.ts` and to `extraResources.from` in electron-builder.yml —
 * three files that have to agree, so a test compares them.
 */
const OUT_DIR = path.join(root, 'resources', 'bin');

const args = process.argv.slice(2);
const checkOnly = args.includes('--check');
const force = args.includes('--force');

const log = (message) => process.stderr.write(`[fetch-ffmpeg] ${message}\n`);

function fail(message) {
  process.stderr.write(`\n[fetch-ffmpeg] FAILED: ${message}\n\n`);
  process.exit(1);
}

// --- the pin ------------------------------------------------------------------
let pin;
try {
  pin = JSON.parse(await fsp.readFile(PIN_FILE, 'utf8'));
} catch (error) {
  fail(`could not read ${path.relative(root, PIN_FILE)}: ${String(error)}`);
}

for (const field of ['version', 'archive', 'files']) {
  if (pin[field] === undefined) fail(`${path.relative(root, PIN_FILE)} has no "${field}"`);
}
if (!pin.archive.url.includes(pin.version)) {
  // A URL that does not name the version it claims to be is an alias, and an alias is
  // how "pinned" quietly becomes "whatever was published last night".
  fail(`the archive URL does not contain the pinned version ${pin.version}: ${pin.archive.url}`);
}

/** Per-user, outside the repo, so `rsync --delete` can never reach it. */
function cacheDir() {
  const override = process.env.CASTGOOD_FFMPEG_CACHE;
  if (override && override.trim() !== '') return path.resolve(override);
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local');
    return path.join(local, 'CastGood', 'build-cache', 'ffmpeg');
  }
  const xdg = process.env.XDG_CACHE_HOME ?? path.join(os.homedir(), '.cache');
  return path.join(xdg, 'castgood', 'ffmpeg');
}

async function sha256(file) {
  const hash = createHash('sha256');
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', resolve);
  });
  return hash.digest('hex');
}

/** Everything the pin says should exist, present and byte-for-byte right. */
async function verifyOutput() {
  const problems = [];
  for (const entry of pin.files) {
    const target = path.join(OUT_DIR, entry.to);
    let stat;
    try {
      stat = await fsp.stat(target);
    } catch {
      problems.push(`${entry.to} is missing`);
      continue;
    }
    if (entry.bytes !== undefined && stat.size !== entry.bytes) {
      problems.push(`${entry.to} is ${stat.size} bytes, expected ${entry.bytes}`);
      continue;
    }
    if (entry.sha256 !== undefined) {
      const actual = await sha256(target);
      if (actual !== entry.sha256) {
        problems.push(`${entry.to} has SHA-256 ${actual}, expected ${entry.sha256}`);
      }
    }
  }
  return problems;
}

// --- zip reading --------------------------------------------------------------
// Only what a stored-or-deflated zip needs: find the end-of-central-directory, walk
// the central directory, inflate the members we were asked for. No compression method
// other than 0 (stored) and 8 (deflate) is accepted — anything else is not the archive
// we pinned, and guessing would be worse than stopping.
function readZipEntries(buffer) {
  const EOCD_SIG = 0x06054b50;
  let eocd = -1;
  for (let i = buffer.length - 22; i >= 0 && i > buffer.length - 22 - 0xffff; i -= 1) {
    if (buffer.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record — not a zip file');

  const count = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  const entries = new Map();

  for (let n = 0; n < count; n += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`central directory entry ${n} has a bad signature`);
    }
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, { method, compressedSize, uncompressedSize, localOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

function extractEntry(buffer, entry) {
  if (buffer.readUInt32LE(entry.localOffset) !== 0x04034b50) {
    throw new Error('local file header has a bad signature');
  }
  const nameLength = buffer.readUInt16LE(entry.localOffset + 26);
  const extraLength = buffer.readUInt16LE(entry.localOffset + 28);
  const start = entry.localOffset + 30 + nameLength + extraLength;
  const raw = buffer.subarray(start, start + entry.compressedSize);
  if (entry.method === 0) return Buffer.from(raw);
  if (entry.method === 8) return zlib.inflateRawSync(raw, { maxOutputLength: 1 << 30 });
  throw new Error(`unsupported zip compression method ${entry.method}`);
}

// --- download -----------------------------------------------------------------
async function download(url, target) {
  log(`downloading ${url}`);
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  await fsp.mkdir(path.dirname(target), { recursive: true });
  // Write-and-rename: an interrupted download must never look like a cached archive
  // on the next run. Half a zip that gets hashed and rejected is only a wasted
  // download; half a zip that gets extracted is an installer with half an encoder.
  const staging = `${target}.partial`;
  await fsp.writeFile(staging, bytes);
  await fsp.rename(staging, target);
  return bytes;
}

// --- do the work --------------------------------------------------------------
const already = await verifyOutput();
if (already.length === 0 && !force) {
  log(`ffmpeg ${pin.version} already present and verified in ${path.relative(root, OUT_DIR)}`);
  process.exit(0);
}

if (checkOnly) {
  fail(
    `ffmpeg ${pin.version} is not in ${path.relative(root, OUT_DIR)}:\n` +
      already.map((problem) => `    - ${problem}`).join('\n') +
      `\n  Run: node scripts/fetch-ffmpeg.mjs`,
  );
}

log(already.length === 0 ? 'forced re-extract' : `fetching because: ${already.join('; ')}`);

const archivePath = path.join(cacheDir(), path.basename(pin.archive.url));
let archive;

if (fs.existsSync(archivePath) && (await sha256(archivePath)) === pin.archive.sha256) {
  log(`using the cached archive at ${archivePath}`);
  archive = await fsp.readFile(archivePath);
} else {
  try {
    archive = await download(pin.archive.url, archivePath);
  } catch (error) {
    fail(
      `could not download the pinned ffmpeg archive.\n` +
        `    ${pin.archive.url}\n` +
        `    ${String(error)}\n` +
        `  Nothing was changed. If the network is fine and this persists, the publisher may\n` +
        `  have moved the file: that needs a new pin in build/ffmpeg-pin.json and an ADR,\n` +
        `  never a fallback to whatever ffmpeg happens to be on this machine.`,
    );
  }
  const digest = createHash('sha256').update(archive).digest('hex');
  if (digest !== pin.archive.sha256) {
    await fsp.rm(archivePath, { force: true });
    fail(
      `the downloaded archive is not the pinned one.\n` +
        `    expected SHA-256 ${pin.archive.sha256}\n` +
        `    got               ${digest}\n` +
        `  The cached copy has been deleted. This is either a corrupted download or a\n` +
        `  different build wearing the same URL — both are reasons to stop, not to continue.`,
    );
  }
}

let entries;
try {
  entries = readZipEntries(archive);
} catch (error) {
  fail(`the archive did not read as a zip: ${String(error)}`);
}

await fsp.mkdir(OUT_DIR, { recursive: true });

for (const file of pin.files) {
  const member = `${pin.archive.rootDir}/${file.from}`;
  const entry = entries.get(member);
  if (entry === undefined) {
    if (file.required === false) continue;
    fail(`the archive does not contain ${member}`);
  }
  let data;
  try {
    data = extractEntry(archive, entry);
  } catch (error) {
    fail(`could not extract ${member}: ${String(error)}`);
  }
  if (file.bytes !== undefined && data.length !== file.bytes) {
    fail(`${member} extracted to ${data.length} bytes, expected ${file.bytes}`);
  }
  if (file.sha256 !== undefined) {
    const digest = createHash('sha256').update(data).digest('hex');
    if (digest !== file.sha256) {
      fail(`${member} extracted with SHA-256 ${digest}, expected ${file.sha256}`);
    }
  }
  const target = path.join(OUT_DIR, file.to);
  const staging = `${target}.partial`;
  await fsp.writeFile(staging, data);
  await fsp.rename(staging, target);
  log(`${file.to} (${(data.length / 1024 / 1024).toFixed(1)} MB)`);
}

// A record of what is actually sitting in resources/bin, shipped alongside the binaries
// so the question "which ffmpeg is this?" has an answer on the founder's PC as well as
// in the repo. Read by scripts/verify-ffmpeg-packaged.mjs after packaging.
await fsp.writeFile(
  path.join(OUT_DIR, 'ffmpeg-build.json'),
  `${JSON.stringify(
    {
      version: pin.version,
      variant: pin.variant,
      license: pin.license,
      builder: pin.builder,
      upstreamSource: pin.upstreamSource,
      archive: pin.archive.url,
      fetchedAt: new Date().toISOString(),
    },
    null,
    2,
  )}\n`,
);

const remaining = await verifyOutput();
if (remaining.length > 0) {
  fail(
    `extraction finished but verification still fails:\n${remaining.map((p) => `    - ${p}`).join('\n')}`,
  );
}

log(`ffmpeg ${pin.version} (${pin.license}) ready in ${path.relative(root, OUT_DIR)}`);
