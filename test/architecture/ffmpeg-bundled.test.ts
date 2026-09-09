import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGED_BIN_DIR, PROJECT_BIN_DIR, resolveFfmpeg } from '../../src/engine/media/ffmpeg.js';

/**
 * The installer must not be able to ship without ffmpeg.
 *
 * This is the same class of guard as `firewall-rules.test.ts`, and it exists for the same
 * reason: *Allow through the firewall* shipped in a state that could not have worked and
 * nothing noticed. An installer with no encoder inside it is worse — it installs, opens,
 * finds the televisions, and then dies at the founder's first conversion with an error
 * they cannot act on, on a machine nobody can attach a debugger to.
 *
 * Four separate files have to agree for the binaries to reach the packaged app, they are
 * written in four different languages, and nothing at runtime compares them:
 *
 *   build/ffmpeg-pin.json                 which build, and its SHA-256
 *   scripts/fetch-ffmpeg.mjs              puts it in resources/bin/
 *   electron-builder.yml                  copies resources/bin -> resources/bin in the app
 *   src/engine/media/ffmpeg.ts            looks for it at <resourcesPath>/bin
 *
 * So this compares them, on every commit, in WSL, with no binaries present. The *other*
 * half of the guarantee — that the files are really there in a real build — is
 * `scripts/verify-ffmpeg-packaged.cjs`, which runs inside packaging as electron-builder's
 * `afterPack` hook and again as a plain command at the end of `npm run build:win`.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '../..');

const read = (relative: string): string => fs.readFileSync(path.join(root, relative), 'utf8');

const builderConfig = read('electron-builder.yml');
const packageJson = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
const fetchScript = read('scripts/fetch-ffmpeg.mjs');
const winSync = read('scripts/win-sync.sh');
const gitignore = read('.gitignore');

interface Pin {
  version: string;
  license: string;
  upstreamSource: string;
  archive: { url: string; sha256: string; bytes: number; rootDir: string };
  files: { from: string; to: string; sha256?: string; bytes?: number }[];
}
const pin = JSON.parse(read('build/ffmpeg-pin.json')) as Pin;

/** electron-builder.yml with its comment lines removed — the comments quote the config. */
const builderCode = builderConfig
  .split('\n')
  .filter((line) => !/^\s*#/.test(line))
  .join('\n');

const SHA256 = /^[0-9a-f]{64}$/;

describe('the ffmpeg build is pinned, not floating', () => {
  it('names one exact version, and a URL that contains it', () => {
    expect(pin.version).toMatch(/^\d+\.\d+(\.\d+)?$/);
    expect(pin.archive.url).toContain(pin.version);
  });

  it('uses no floating alias anywhere', () => {
    // Every publisher of Windows ffmpeg builds offers one of these, and each hands you a
    // different encoder on Tuesday than on Monday for the same commit of this repo.
    for (const alias of ['release-essentials', 'release-full', 'master-latest', '/latest/']) {
      expect(pin.archive.url).not.toContain(alias);
    }
  });

  it('records a SHA-256 for the archive and for both executables', () => {
    expect(pin.archive.sha256).toMatch(SHA256);
    for (const name of ['ffmpeg.exe', 'ffprobe.exe']) {
      const entry = pin.files.find((file) => file.to === name);
      expect(entry, `${name} is not in the pin`).toBeDefined();
      expect(entry?.sha256).toMatch(SHA256);
      // A "binary" of a few kilobytes is an HTML error page that was saved with the
      // right name. The byte count is the cheapest way to notice.
      expect(entry?.bytes ?? 0).toBeGreaterThan(10 * 1024 * 1024);
    }
  });

  it('ships the GPL licence text and names the exact upstream source', () => {
    // 2026-08-13 ADR: prebuilt ffmpeg for Windows is GPL, and we redistribute it. The
    // obligation is satisfied by shipping the licence and linking the source revision.
    expect(pin.license).toContain('GPL');
    expect(pin.files.some((file) => /LICENSE/i.test(file.to))).toBe(true);
    expect(pin.upstreamSource).toMatch(/^https:\/\//);
  });

  it('is the only place the fetch script gets a URL or a hash from', () => {
    expect(fetchScript).toContain('ffmpeg-pin.json');
    // No second source of truth hiding in the script itself.
    const code = fetchScript
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(code).not.toMatch(/https?:\/\/\S*ffmpeg\S*\.(zip|7z|tar)/i);
  });
});

describe('the packaged app really gets the binaries', () => {
  it('copies resources/bin into the app as extraResources', () => {
    expect(builderCode).toMatch(/extraResources:/);
    expect(builderCode).toMatch(/from:\s*resources\/bin/);
    expect(builderCode).toMatch(/to:\s*bin\b/);
  });

  it('uses the same two directory names the engine looks in', () => {
    // `to:` is what src/engine/media/ffmpeg.ts joins onto process.resourcesPath, and
    // `from:` is where scripts/fetch-ffmpeg.mjs writes. A silent disagreement here is an
    // app that cannot find an encoder that is sitting right next to it.
    expect(builderCode).toContain(`to: ${PACKAGED_BIN_DIR}`);
    expect(builderCode).toContain(`from: ${PROJECT_BIN_DIR.split(path.sep).join('/')}`);
  });

  it('filters in exactly the files the pin says are shipped', () => {
    for (const file of pin.files) {
      expect(builderCode, `${file.to} is fetched but never packaged`).toContain(file.to);
    }
  });

  it('never puts them inside the asar, where they could not be spawned', () => {
    // extraResources lands beside app.asar, so there is nothing to unpack. If anyone ever
    // moves them into `files:` they must add asarUnpack — and this is the reminder.
    // Only the top-level `files:` list is examined; `extraResources` legitimately mentions
    // the same directory two blocks below it.
    const lines = builderCode.split('\n');
    const start = lines.findIndex((line) => /^files:/.test(line));
    expect(start).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, index) => index > start && /^\S/.test(line));
    const filesBlock = lines.slice(start, end === -1 ? undefined : end).join('\n');
    expect(filesBlock).not.toContain('resources/bin');
    expect(builderCode).not.toContain('asarUnpack');
  });

  it('fails the build when they are missing, before NSIS ever packs an .exe', () => {
    expect(builderCode).toContain('afterPack: ./scripts/verify-ffmpeg-packaged.cjs');
    expect(fs.existsSync(path.join(root, 'scripts/verify-ffmpeg-packaged.cjs'))).toBe(true);
  });

  it('fetches before packaging and verifies after, in the one build command', () => {
    const buildWin = packageJson.scripts['build:win'] ?? '';
    const fetchAt = buildWin.indexOf('fetch-ffmpeg.mjs');
    const builderAt = buildWin.indexOf('electron-builder');
    const verifyAt = buildWin.indexOf('verify-ffmpeg-packaged.cjs');
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(fetchAt).toBeLessThan(builderAt);
    // The afterPack hook cannot report its own absence — a config typo or an
    // electron-builder change would take the guarantee with it silently. The command-line
    // run at the end of the same script is the check that cannot be skipped quietly.
    expect(verifyAt).toBeGreaterThan(builderAt);
  });
});

describe('the binaries stay out of git and out of the rsync', () => {
  it('is gitignored', () => {
    expect(gitignore).toContain('resources/bin/');
  });

  it('is excluded from the WSL -> Windows mirror', () => {
    // win-sync.sh mirrors with --delete on every win-run.sh. Without this exclusion the
    // dev loop pushes ~200 MB each time, and a Windows-side fetch is deleted by the next
    // sync — which is an installer built with no encoder in it.
    expect(winSync).toContain("--exclude 'resources/bin/'");
  });
});

describe('the engine seam is honest when the binaries are absent', () => {
  it('returns an answer rather than throwing, which is what WSL and CI need', () => {
    const resolution = resolveFfmpeg({ env: {}, exists: () => false, cwd: root });
    expect(resolution.available).toBe(false);
    if (!resolution.available) {
      expect(resolution.searched.length).toBeGreaterThan(0);
      expect(resolution.reason).not.toContain('Error');
    }
  });

  it('never falls back to whatever ffmpeg is on PATH', () => {
    // ffmpeg is on the founder's PATH because winget put it there for an M3 spike. A PATH
    // fallback would let a broken bundling step work perfectly on the only machine anyone
    // tests on, and ship an installer that dies on first use.
    const seam = read('src/engine/media/ffmpeg.ts')
      .split('\n')
      .filter((line) => !/^\s*(\*|\/\/|\/\*)/.test(line))
      .join('\n');
    expect(seam).not.toMatch(/\bPATH\b/);
    expect(seam).not.toContain('delimiter');
    expect(seam).not.toContain('which');
  });
});

/**
 * When the binaries *are* present — a Windows working copy, or CI after `build:win` —
 * check them properly. A half-finished fetch is otherwise invisible until packaging.
 * Skipped in WSL and on the Linux CI runner, where their absence is legitimate.
 */
describe('the fetched copy, when there is one', () => {
  const binDir = path.join(root, PROJECT_BIN_DIR);
  const present = fs.existsSync(binDir);

  it.runIf(present)('matches the pin, byte for byte', () => {
    for (const file of pin.files) {
      const target = path.join(binDir, file.to);
      expect(fs.existsSync(target), `${file.to} missing from ${PROJECT_BIN_DIR}`).toBe(true);
      if (file.bytes !== undefined) {
        expect(fs.statSync(target).size, `${file.to} size`).toBe(file.bytes);
      }
      if (file.sha256 !== undefined) {
        const digest = createHash('sha256').update(fs.readFileSync(target)).digest('hex');
        expect(digest, `${file.to} SHA-256`).toBe(file.sha256);
      }
    }
  });
});
