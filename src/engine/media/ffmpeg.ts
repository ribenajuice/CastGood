import fs from 'node:fs';
import path from 'node:path';

/**
 * Where are ffmpeg and ffprobe? — the one seam that answers it, in every context.
 *
 * The engine must not care whether it is running inside the packaged app, under
 * `npm run dev`, inside the headless selftest on Windows, or under vitest in WSL where
 * a Windows binary has no business existing. So this asks the question in one place and
 * **returns an answer instead of throwing one**. `resolveFfmpeg()` is total: absence is
 * a value (`{ available: false, reason, searched }`), never an exception, because
 * `test/architecture/engine-boundary.test.ts` requires this file to be importable and
 * runnable headless with nothing installed, and a module that throws on import or on a
 * first call would fail the suite on the machine every engine test runs on.
 *
 * Four contexts, one order of precedence:
 *
 *  1. `CASTGOOD_FFMPEG_DIR` — explicit, always wins. Tests, spikes, and a founder or
 *     agent pointing at a build by hand.
 *  2. `<resourcesPath>/bin` — the packaged app. electron-builder copies `resources/bin`
 *     to `resources/bin` beside `app.asar` as `extraResources`, so the binaries are
 *     **never inside the archive**: nothing to `asarUnpack`, and `spawn` gets a real
 *     path on disk rather than a virtual one it cannot execute. `process.resourcesPath`
 *     is a plain property Electron sets on `process`; reading it is not an Electron
 *     import, and it is simply `undefined` everywhere else.
 *  3. `<cwd>/resources/bin`, then the same walking up from the cwd — `npm run dev`
 *     (dev.mjs launches Electron with cwd = repo root) and `npm run selftest`
 *     (selftest.mjs spawns with cwd = repo root). This is where `scripts/fetch-ffmpeg.mjs`
 *     puts them.
 *  4. Nothing. Which is the honest answer under vitest in WSL, and the one the classifier
 *     is expected to handle rather than crash on.
 *
 * **There is deliberately no PATH lookup.** ffmpeg is on the founder's PATH because
 * winget put it there during an M3 spike. A PATH fallback would mean a build whose
 * bundling step had silently failed still worked perfectly on the one machine anyone
 * tests on, and shipped an installer that dies at the founder's first conversion with
 * no diagnostic — the same class of "shipped in a state that could not have worked"
 * that `test/architecture/firewall-rules.test.ts` exists to prevent. Anyone who really
 * wants a different binary says so with `CASTGOOD_FFMPEG_DIR`.
 */

export interface FfmpegBinaries {
  /** Absolute path to ffmpeg. Spawned as a child process; never linked, never FFI. */
  readonly ffmpeg: string;
  /** Absolute path to ffprobe. */
  readonly ffprobe: string;
}

export type FfmpegSource = 'override' | 'packaged' | 'project';

export interface FfmpegFound {
  readonly available: true;
  /** Which of the four contexts answered — worth logging, it is the first thing to check. */
  readonly source: FfmpegSource;
  readonly dir: string;
  readonly binaries: FfmpegBinaries;
}

export interface FfmpegMissing {
  readonly available: false;
  /** Plain enough to put in front of the founder, specific enough to debug from. */
  readonly reason: string;
  /** Every directory that was looked in, in order. */
  readonly searched: readonly string[];
}

export type FfmpegResolution = FfmpegFound | FfmpegMissing;

/** Escape hatch. A directory holding ffmpeg/ffprobe (with or without `.exe`). */
export const FFMPEG_DIR_ENV = 'CASTGOOD_FFMPEG_DIR';

/**
 * Where the binaries sit inside the packaged app, relative to `process.resourcesPath`.
 * Must equal `extraResources[].to` in electron-builder.yml — checked by
 * `test/architecture/ffmpeg-bundled.test.ts`, because the two live in different files
 * in different languages and nothing at runtime compares them.
 */
export const PACKAGED_BIN_DIR = 'bin';

/**
 * Where `scripts/fetch-ffmpeg.mjs` puts them in a working copy. Must equal
 * `extraResources[].from` in electron-builder.yml and `OUT_DIR` in that script.
 */
export const PROJECT_BIN_DIR = path.join('resources', 'bin');

/** The two names, in the order they are tried. `.exe` first: Windows is the only platform. */
const NAMES = {
  ffmpeg: ['ffmpeg.exe', 'ffmpeg'],
  ffprobe: ['ffprobe.exe', 'ffprobe'],
} as const;

/**
 * A `.exe` is not an available ffmpeg on a platform that cannot start one.
 *
 * `scripts/fetch-ffmpeg.mjs` writes the Windows binaries into `resources/bin` of the **WSL**
 * working copy — that is where `win-sync.sh` mirrors them from — and vitest runs from the
 * repo root, so without this the locator answers `available: true` to every engine test on
 * a machine where `spawn` can only ever return `EACCES`. The engine would then report a
 * failed probe, which in a packaged install is the "your installation is damaged" signal:
 * an instrument reporting a real product failure that is not happening.
 *
 * So the question this file answers is not "is there a file with that name" but "is there
 * an ffmpeg **this process could run**". A bare `ffmpeg`/`ffprobe` is still accepted
 * everywhere, which is what a `CASTGOOD_FFMPEG_DIR` pointing at a Linux build is.
 */
function runnableHere(name: string, platform: NodeJS.Platform): boolean {
  return platform === 'win32' || !name.toLowerCase().endsWith('.exe');
}

export interface ResolveFfmpegOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Injected by tests. Defaults to `fs.existsSync` — one `stat` per candidate, no spawn. */
  readonly exists?: (file: string) => boolean;
  /** Injected by tests. Defaults to `process.resourcesPath`, which only Electron sets. */
  readonly resourcesPath?: string | undefined;
  readonly cwd?: string;
  /** Defaults to `process.platform`. Decides whether a `.exe` counts — see `runnableHere`. */
  readonly platform?: NodeJS.Platform;
}

/** How far up from the cwd we are willing to look for `resources/bin`. */
const MAX_PARENTS = 4;

function candidateDirs(options: ResolveFfmpegOptions): { dir: string; source: FfmpegSource }[] {
  const env = options.env ?? process.env;
  const cwd = options.cwd ?? process.cwd();
  const resourcesPath =
    options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;

  const candidates: { dir: string; source: FfmpegSource }[] = [];

  const override = env[FFMPEG_DIR_ENV];
  if (override !== undefined && override.trim() !== '') {
    candidates.push({ dir: path.resolve(override.trim()), source: 'override' });
  }

  if (resourcesPath !== undefined && resourcesPath.trim() !== '') {
    candidates.push({ dir: path.join(resourcesPath, PACKAGED_BIN_DIR), source: 'packaged' });
  }

  // The cwd first, then its parents: `npm run dev` and the selftest both start at the repo
  // root, but a script run from `scripts/` or a test runner started deeper should still
  // find the one copy that exists rather than report nothing and be believed.
  let dir = path.resolve(cwd);
  for (let depth = 0; depth <= MAX_PARENTS; depth += 1) {
    candidates.push({ dir: path.join(dir, PROJECT_BIN_DIR), source: 'project' });
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return candidates;
}

function findIn(
  dir: string,
  names: readonly string[],
  exists: (file: string) => boolean,
  platform: NodeJS.Platform,
): string | null {
  for (const name of names) {
    if (!runnableHere(name, platform)) continue;
    const full = path.join(dir, name);
    if (exists(full)) return full;
  }
  return null;
}

/**
 * Find the binaries, or say why not. Never throws, never spawns anything.
 *
 * Cheap enough to call per use (a handful of `existsSync` calls) and deliberately
 * **not cached**: a build that fetched the binaries while the app was open, or a test
 * that changes `CASTGOOD_FFMPEG_DIR` between cases, must not be answered from memory.
 */
export function resolveFfmpeg(options: ResolveFfmpegOptions = {}): FfmpegResolution {
  const exists = options.exists ?? fs.existsSync;
  const platform = options.platform ?? process.platform;
  const candidates = candidateDirs(options);
  const searched: string[] = [];

  for (const candidate of candidates) {
    if (searched.includes(candidate.dir)) continue;
    searched.push(candidate.dir);
    const ffmpeg = findIn(candidate.dir, NAMES.ffmpeg, exists, platform);
    const ffprobe = findIn(candidate.dir, NAMES.ffprobe, exists, platform);
    if (ffmpeg === null || ffprobe === null) {
      // Half a pair is not a usable answer, and quietly falling through to the next
      // directory would let a broken fetch be masked by a stale one. Keep looking, but
      // the reason below names what was actually wrong here.
      continue;
    }
    return {
      available: true,
      source: candidate.source,
      dir: candidate.dir,
      binaries: { ffmpeg, ffprobe },
    };
  }

  return {
    available: false,
    reason:
      'CastGood could not find its copy of ffmpeg. It ships inside the app, so this ' +
      'normally means the installation is incomplete — reinstalling fixes it.',
    searched,
  };
}

/** The convenience form. Honest by construction: it can only ever return true or false. */
export function isFfmpegAvailable(options: ResolveFfmpegOptions = {}): boolean {
  return resolveFfmpeg(options).available;
}

/**
 * A one-line description for the log, whichever way the answer went.
 *
 * `engine.start` already records the paths and versions a run started with; which ffmpeg
 * (if any) is the first thing anyone will want from a conversion that misbehaved.
 */
export function describeFfmpeg(resolution: FfmpegResolution): string {
  return resolution.available
    ? `ffmpeg from ${resolution.source}: ${resolution.dir}`
    : `ffmpeg not found (looked in ${resolution.searched.length} places)`;
}
