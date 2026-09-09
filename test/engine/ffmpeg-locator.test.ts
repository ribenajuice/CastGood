import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describeFfmpeg,
  FFMPEG_DIR_ENV,
  isFfmpegAvailable,
  PACKAGED_BIN_DIR,
  PROJECT_BIN_DIR,
  resolveFfmpeg,
} from '../../src/engine/media/ffmpeg.js';

/**
 * The seam that answers "where is ffmpeg?" in all four contexts.
 *
 * These run in WSL, where the answer is legitimately *nowhere* — which is the case that
 * matters most, because the whole engine test suite runs on a machine with no Windows
 * binaries on it and the classifier has to be able to ask without being thrown at.
 *
 * The filesystem is injected (`exists`), so every context below is exercised here rather
 * than only on the founder's PC.
 */

const win = (...parts: string[]): string => path.join(...parts);

/** A fake filesystem: the listed paths exist, nothing else does. */
function only(...files: string[]): (file: string) => boolean {
  const set = new Set(files.map((file) => path.resolve(file)));
  return (file) => set.has(path.resolve(file));
}

describe('resolveFfmpeg', () => {
  it('finds the packaged copy beside app.asar', () => {
    const resources = win('/opt/CastGood', 'resources');
    const resolution = resolveFfmpeg({
      env: {},
      platform: 'win32',
      cwd: '/nowhere',
      resourcesPath: resources,
      exists: only(
        win(resources, PACKAGED_BIN_DIR, 'ffmpeg.exe'),
        win(resources, PACKAGED_BIN_DIR, 'ffprobe.exe'),
      ),
    });

    expect(resolution.available).toBe(true);
    if (resolution.available) {
      expect(resolution.source).toBe('packaged');
      expect(resolution.binaries.ffprobe).toBe(win(resources, 'bin', 'ffprobe.exe'));
    }
  });

  it('finds the working-copy fetch under npm run dev and under the selftest', () => {
    // dev.mjs and selftest.mjs both spawn with cwd = repo root, which is where
    // scripts/fetch-ffmpeg.mjs writes.
    const repo = '/home/dev/CastGood';
    const resolution = resolveFfmpeg({
      env: {},
      platform: 'win32',
      cwd: repo,
      resourcesPath: undefined,
      exists: only(
        win(repo, PROJECT_BIN_DIR, 'ffmpeg.exe'),
        win(repo, PROJECT_BIN_DIR, 'ffprobe.exe'),
      ),
    });

    expect(resolution.available).toBe(true);
    if (resolution.available) {
      expect(resolution.source).toBe('project');
      expect(resolution.dir).toBe(win(repo, PROJECT_BIN_DIR));
    }
  });

  it('still finds it when the process was started from a subdirectory', () => {
    const repo = '/home/dev/CastGood';
    const resolution = resolveFfmpeg({
      env: {},
      platform: 'win32',
      cwd: win(repo, 'scripts'),
      resourcesPath: undefined,
      exists: only(
        win(repo, PROJECT_BIN_DIR, 'ffmpeg.exe'),
        win(repo, PROJECT_BIN_DIR, 'ffprobe.exe'),
      ),
    });
    expect(resolution.available).toBe(true);
  });

  it('lets CASTGOOD_FFMPEG_DIR win over the packaged copy', () => {
    // The one escape hatch, and it has to outrank everything: it is how a spike, a test or
    // a founder points at a specific build without editing anything.
    const resources = win('/opt/CastGood', 'resources');
    const custom = '/tmp/ffmpeg-8.1.2';
    const resolution = resolveFfmpeg({
      env: { [FFMPEG_DIR_ENV]: custom },
      platform: 'win32',
      cwd: '/nowhere',
      resourcesPath: resources,
      exists: only(
        win(custom, 'ffmpeg'),
        win(custom, 'ffprobe'),
        win(resources, PACKAGED_BIN_DIR, 'ffmpeg.exe'),
        win(resources, PACKAGED_BIN_DIR, 'ffprobe.exe'),
      ),
    });

    expect(resolution.available).toBe(true);
    if (resolution.available) {
      expect(resolution.source).toBe('override');
      // No `.exe` required: an override may point at a Linux build for a WSL experiment.
      expect(resolution.binaries.ffmpeg).toBe(win(custom, 'ffmpeg'));
    }
  });

  it('ignores an empty or whitespace override rather than searching an empty path', () => {
    const repo = '/home/dev/CastGood';
    const resolution = resolveFfmpeg({
      env: { [FFMPEG_DIR_ENV]: '   ' },
      platform: 'win32',
      cwd: repo,
      resourcesPath: undefined,
      exists: only(
        win(repo, PROJECT_BIN_DIR, 'ffmpeg.exe'),
        win(repo, PROJECT_BIN_DIR, 'ffprobe.exe'),
      ),
    });
    expect(resolution.available).toBe(true);
  });

  it('refuses half a pair', () => {
    // ffprobe without ffmpeg would classify a file and then fail to convert it, halfway
    // through a job the founder had already been given an estimate for.
    const repo = '/home/dev/CastGood';
    const resolution = resolveFfmpeg({
      env: {},
      platform: 'win32',
      cwd: repo,
      resourcesPath: undefined,
      exists: only(win(repo, PROJECT_BIN_DIR, 'ffprobe.exe')),
    });
    expect(resolution.available).toBe(false);
  });

  it('is a value, not an exception, when there is nothing to find', () => {
    // The vitest-in-WSL case, and the whole reason this function exists.
    const resolution = resolveFfmpeg({
      env: {},
      platform: 'win32',
      cwd: '/home/dev/CastGood',
      exists: () => false,
    });
    expect(resolution.available).toBe(false);
    if (!resolution.available) {
      expect(resolution.searched.length).toBeGreaterThan(0);
      // Founder-facing: no paths, no codes, no stack.
      expect(resolution.reason).toMatch(/ffmpeg/i);
      expect(resolution.reason).not.toMatch(/[/\\]resources[/\\]bin/);
    }
  });

  it('lists each directory once, in the order they were tried', () => {
    const resolution = resolveFfmpeg({
      env: { [FFMPEG_DIR_ENV]: '/custom' },
      platform: 'win32',
      cwd: '/home/dev/CastGood',
      resourcesPath: '/opt/CastGood/resources',
      exists: () => false,
    });
    expect(resolution.available).toBe(false);
    if (!resolution.available) {
      expect(new Set(resolution.searched).size).toBe(resolution.searched.length);
      expect(resolution.searched[0]).toBe(path.resolve('/custom'));
      expect(resolution.searched[1]).toBe(win('/opt/CastGood/resources', PACKAGED_BIN_DIR));
    }
  });

  it('does not offer a Windows binary to a process that could never start one', () => {
    // This is not hypothetical, and it is why this test exists. `fetch-ffmpeg.mjs` writes
    // `ffmpeg.exe` and `ffprobe.exe` into `resources/bin` of the **WSL** working copy —
    // that is the directory `win-sync.sh` mirrors — and vitest runs from the repo root.
    // Before the platform guard, every engine test on this machine resolved those two
    // files, spawned them, got `EACCES`, and recorded a failed probe: in a packaged
    // install, the signal for a damaged installation. A test suite reporting a product
    // failure that is not happening is the exact instrument problem this project keeps
    // being caught by.
    const repo = '/home/dev/CastGood';
    const exists = only(
      win(repo, PROJECT_BIN_DIR, 'ffmpeg.exe'),
      win(repo, PROJECT_BIN_DIR, 'ffprobe.exe'),
    );

    expect(resolveFfmpeg({ env: {}, platform: 'linux', cwd: repo, exists }).available).toBe(false);
    expect(resolveFfmpeg({ env: {}, platform: 'win32', cwd: repo, exists }).available).toBe(true);
  });

  it('still accepts an extension-less build on Linux, which is what a WSL experiment is', () => {
    // The guard is about what can be *run*, not about the platform having an opinion on
    // ffmpeg. A native build put there by hand, or pointed at with CASTGOOD_FFMPEG_DIR,
    // is a perfectly good answer on Linux.
    const repo = '/home/dev/CastGood';
    const resolution = resolveFfmpeg({
      env: {},
      platform: 'linux',
      cwd: repo,
      exists: only(win(repo, PROJECT_BIN_DIR, 'ffmpeg'), win(repo, PROJECT_BIN_DIR, 'ffprobe')),
    });
    expect(resolution.available).toBe(true);
    if (resolution.available) {
      expect(resolution.binaries.ffprobe).toBe(win(repo, PROJECT_BIN_DIR, 'ffprobe'));
    }
  });

  it('answers the same question the same way through isFfmpegAvailable', () => {
    expect(
      isFfmpegAvailable({
        env: {},
        platform: 'win32',
        cwd: '/home/dev/CastGood',
        exists: () => false,
      }),
    ).toBe(false);
  });
});

describe('describeFfmpeg', () => {
  it('says which context answered, because that is the first thing to check', () => {
    const repo = '/home/dev/CastGood';
    const found = resolveFfmpeg({
      env: {},
      platform: 'win32',
      cwd: repo,
      exists: only(
        win(repo, PROJECT_BIN_DIR, 'ffmpeg.exe'),
        win(repo, PROJECT_BIN_DIR, 'ffprobe.exe'),
      ),
    });
    expect(describeFfmpeg(found)).toContain('project');

    const missing = resolveFfmpeg({ env: {}, platform: 'win32', cwd: repo, exists: () => false });
    expect(describeFfmpeg(missing)).toContain('not found');
  });
});
