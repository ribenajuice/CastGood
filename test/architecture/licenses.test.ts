import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * The installer must not be able to ship without the licences it is obliged to carry.
 *
 * Same shape of guard as `ffmpeg-bundled.test.ts`, for the same reason: several files in
 * different languages have to agree, and nothing at runtime compares them.
 *
 *   LICENSE                        CastGood's own terms (MIT)
 *   package.json "license"         the machine-readable claim, which must match
 *   THIRD-PARTY-NOTICES.txt        generated attribution for everything redistributed
 *   scripts/generate-notices.mjs   generates it from the production dependency tree
 *   electron-builder.yml           copies both beside the executable
 *   scripts/verify-ffmpeg-packaged.cjs  fails a real build if they did not arrive
 *
 * The obligation is not CastGood's own MIT — that costs nothing to satisfy. It is the
 * **GPL-3.0 ffmpeg binary the installer redistributes**, and the MIT/BSD packages inside
 * app.asar whose licences require the notice to travel with the code. A missing notices
 * file is a green build and a non-compliant installer, which is exactly the failure mode
 * this project keeps finding: an instrument that reads source cannot see what was packaged.
 *
 * These tests run in WSL with no binaries and no packaged app present.
 */
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

describe('licensing — what CastGood claims and what it ships', () => {
  it('has a LICENSE file, and package.json agrees with it', () => {
    const licence = read('LICENSE');
    expect(licence).toContain('MIT License');
    expect(licence).toMatch(/Copyright \(c\) \d{4}/);

    const pkg = JSON.parse(read('package.json')) as { license?: string };
    expect(pkg.license).toBe('MIT');
  });

  it('says plainly that ffmpeg is GPL and not covered by the MIT grant', () => {
    // The single most misleading thing this repo could ship is an MIT licence with no
    // mention of the GPL binary sitting next to the executable.
    const licence = read('LICENSE');
    expect(licence).toContain('GPL-3.0-or-later');
    expect(licence).toMatch(/not\s+covered by the licence above/i);
  });

  it('records the arm’s-length arrangement the MIT grant depends on', () => {
    // If ffmpeg were ever linked rather than spawned, CastGood's own licence would be the
    // first thing to change. Naming it here means a future reader cannot miss why.
    const licence = read('LICENSE');
    expect(licence).toMatch(/separate program/i);
    expect(licence).toMatch(/never linked/i);
  });

  it('ships a notices file covering every production dependency', () => {
    const notices = read('THIRD-PARTY-NOTICES.txt');
    const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };

    for (const name of Object.keys(pkg.dependencies ?? {})) {
      expect(notices, `${name} is redistributed but not attributed`).toContain(name);
    }
    // Electron is a devDependency by npm's reckoning and the runtime by everyone else's.
    expect(notices).toContain('electron@');
  });

  it('keeps ffmpeg out of the npm notices file, where it would be a lie', () => {
    // The notices file is headed as npm packages under permissive terms. Folding a
    // GPL-3.0 text into it would misdescribe both. ffmpeg's licence ships beside the
    // binary instead, which is also where anyone would look for it.
    const notices = read('THIRD-PARTY-NOTICES.txt');
    expect(notices).not.toMatch(/^\s*ffmpeg@/m);
    expect(notices).toContain('LICENSE.ffmpeg.txt');
  });

  it('is regenerated, never hand-edited — the checked-in file is current', () => {
    // A stale notices file is worse than none: it makes a specific, checkable claim about
    // what is inside the installer, and a dependency bump silently falsifies it.
    expect(() => {
      execFileSync('node', ['scripts/generate-notices.mjs', '--check'], {
        cwd: root,
        encoding: 'utf8',
      });
    }).not.toThrow();
  });

  it('copies both licence files into the packaged app', () => {
    const builder = read('electron-builder.yml');
    expect(builder).toMatch(/from:\s*LICENSE\b/);
    expect(builder).toMatch(/from:\s*THIRD-PARTY-NOTICES\.txt/);
  });

  it('fails a real build if the licences did not arrive', () => {
    // The packaging-time half of the guarantee. This test can only check that the guard
    // still names the files; the guard itself runs inside `npm run build:win`.
    const verifier = read('scripts/verify-ffmpeg-packaged.cjs');
    expect(verifier).toContain('LICENCE_FILES');
    expect(verifier).toContain("'LICENSE.txt'");
    expect(verifier).toContain("'THIRD-PARTY-NOTICES.txt'");
  });

  it('regenerates the notices as part of the packaged build', () => {
    // If this drops out of build:win, the notices file goes stale exactly when it matters
    // — at the moment an installer is produced for somebody else to download.
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['build:win']).toContain('generate-notices.mjs');
  });
});
