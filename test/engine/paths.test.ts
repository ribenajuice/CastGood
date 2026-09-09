import { describe, expect, it } from 'vitest';
import { resolveAppPaths, resolveDataDir } from '../../src/engine/paths.js';

/**
 * The Windows user name is never hardcoded anywhere in the codebase: the data
 * directory is derived from the environment. A WSL session reads the same files at
 * /mnt/c/Users/<user>/AppData/Local/CastGood, but that mapping belongs in
 * scripts/win-logs.sh, not in the engine.
 */

describe('resolveDataDir', () => {
  it('uses %LOCALAPPDATA% on Windows', () => {
    const dir = resolveDataDir({
      platform: 'win32',
      env: { LOCALAPPDATA: 'C:\\Users\\Darren\\AppData\\Local' },
    });
    expect(dir).toContain('CastGood');
    expect(dir).toContain('AppData');
  });

  it('falls back to %USERPROFILE% when LOCALAPPDATA is missing', () => {
    const dir = resolveDataDir({
      platform: 'win32',
      env: { USERPROFILE: 'C:\\Users\\Darren' },
    });
    expect(dir).toContain('AppData');
    expect(dir).toContain('Local');
    expect(dir).toContain('CastGood');
  });

  it('uses the XDG data dir on Linux, so tests and CI have somewhere to write', () => {
    const dir = resolveDataDir({
      platform: 'linux',
      env: { XDG_DATA_HOME: '/home/darren/.local/share' },
    });
    expect(dir).toBe('/home/darren/.local/share/CastGood');
  });

  it('lets CASTGOOD_DATA_DIR override everything', () => {
    const dir = resolveDataDir({
      platform: 'win32',
      env: {
        CASTGOOD_DATA_DIR: '/tmp/castgood-test',
        LOCALAPPDATA: 'C:\\Users\\Darren\\AppData\\Local',
      },
    });
    expect(dir).toBe('/tmp/castgood-test');
  });
});

describe('resolveAppPaths', () => {
  it('places logs, prepared artifacts, subtitle working copies and the three JSON documents under the data dir', () => {
    const paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: '/tmp/cg' } });
    expect(paths).toEqual({
      dataDir: '/tmp/cg',
      logDir: '/tmp/cg/logs',
      preparedDir: '/tmp/cg/prepared',
      subtitlesDir: '/tmp/cg/subtitles',
      settingsFile: '/tmp/cg/settings.json',
      devicesFile: '/tmp/cg/devices.json',
      artifactsFile: '/tmp/cg/artifacts.json',
    });
  });
});
