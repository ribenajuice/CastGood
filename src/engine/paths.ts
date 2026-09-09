import path from 'node:path';
import os from 'node:os';

/**
 * Where CastGood keeps its data.
 *
 * On Windows — the only platform the product runs on — everything lives under
 * `%LOCALAPPDATA%\CastGood`, which is what the architecture specifies and what a
 * WSL session reads back at `/mnt/c/Users/<user>/AppData/Local/CastGood`.
 * The Windows user name is never hardcoded: it comes from the environment.
 *
 * On Linux (WSL dev, CI) there is no `%LOCALAPPDATA%`, so we fall back to the XDG
 * data dir. Tests always pass an explicit dir, or set CASTGOOD_DATA_DIR.
 */

export interface AppPaths {
  /** Root of everything CastGood owns on disk. */
  readonly dataDir: string;
  /** Structured JSONL logs — "the eyes" for a session that cannot see the Windows screen. */
  readonly logDir: string;
  /** Prepared artifacts, one directory per artifact key. */
  readonly preparedDir: string;
  /**
   * Where ffmpeg writes when a subtitle has to be extracted or converted — M3c.
   *
   * **Never beside the founder's film**, which is 20g's rule and it starts here. Since
   * 2026-08-27 it holds almost nothing: a finished track is a **cue list in memory** and
   * every rung of story 20's ladder is derived from it per request, so no `.vtt` is written
   * at all. What still passes through is ffmpeg's own output on the two routes that need it
   * — a text stream inside a container, and an `.ass` sidecar — read back and removed inside
   * the same call, with the folder emptied at startup in case a run was killed between the
   * two. The founder's own subtitle file is never moved, copied over, renamed or written to.
   */
  readonly subtitlesDir: string;
  readonly settingsFile: string;
  readonly devicesFile: string;
  readonly artifactsFile: string;
}

export interface ResolvePathsOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly homedir?: () => string;
}

export const APP_DIR_NAME = 'CastGood';

/** Escape hatch used by tests and by the headless selftest. Always wins. */
export const DATA_DIR_ENV = 'CASTGOOD_DATA_DIR';

export function resolveDataDir(options: ResolvePathsOptions = {}): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const homedir = options.homedir ?? os.homedir;

  const override = env[DATA_DIR_ENV];
  if (override !== undefined && override.trim() !== '') {
    return path.resolve(override);
  }

  if (platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'];
    if (localAppData !== undefined && localAppData.trim() !== '') {
      return path.join(localAppData, APP_DIR_NAME);
    }
    const userProfile = env['USERPROFILE'];
    if (userProfile !== undefined && userProfile.trim() !== '') {
      return path.join(userProfile, 'AppData', 'Local', APP_DIR_NAME);
    }
    return path.join(homedir(), 'AppData', 'Local', APP_DIR_NAME);
  }

  const xdg = env['XDG_DATA_HOME'];
  if (xdg !== undefined && xdg.trim() !== '') {
    return path.join(xdg, APP_DIR_NAME);
  }
  return path.join(homedir(), '.local', 'share', APP_DIR_NAME);
}

export function resolveAppPaths(options: ResolvePathsOptions = {}): AppPaths {
  const dataDir = resolveDataDir(options);
  return {
    dataDir,
    logDir: path.join(dataDir, 'logs'),
    preparedDir: path.join(dataDir, 'prepared'),
    subtitlesDir: path.join(dataDir, 'subtitles'),
    settingsFile: path.join(dataDir, 'settings.json'),
    devicesFile: path.join(dataDir, 'devices.json'),
    artifactsFile: path.join(dataDir, 'artifacts.json'),
  };
}
