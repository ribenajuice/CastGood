import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * **CastGood never sends anything anywhere, and this is what makes that a fact.**
 *
 * The product's whole answer to *"what does it know about me"* is that it has no cloud, no
 * account and no telemetry — the PRD says so, the README says so, and the licensing PR said
 * so to strangers. Until now all three were **prose**.
 *
 * Story 25 is the reason that stopped being enough. It exists so a person can hand a log
 * back after something goes wrong, and **the obvious next step — "why not just upload it?" —
 * is the one thing that must never happen.** It would arrive as a kindness, in a single
 * commit, and nothing in the repository would object. Criterion 25h says the guarantee has to
 * be a test.
 *
 * ## What it checks, and what it deliberately does not
 *
 * It forbids **outbound network machinery** in the engine and the renderer: `fetch`, XHR,
 * WebSocket, `http.request`, `axios`, `node-fetch`, and Electron's `net`.
 *
 * ⚠️ **`src/engine/media-server/` and `src/engine/cast/` are exempt, and the exemption is the
 * interesting part.** CastGood *is* a server — it listens on the LAN so a television can
 * fetch a film from this PC — and it opens a socket to a Chromecast on the same network.
 * Both are inbound-shaped or LAN-local, both are the product working, and neither can send
 * anything to anybody's server. **What is forbidden is a client reaching OUT of the house.**
 *
 * The distinction cannot be enforced by pattern alone, which is why the exempt directories
 * are named here rather than inferred: adding a directory to that list is a decision somebody
 * has to make in this file, in a diff, with this comment above it.
 */

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

/** Where the ban applies. */
const GUARDED = [
  path.join(repoRoot, 'src', 'engine'),
  path.join(repoRoot, 'src', 'renderer'),
  path.join(repoRoot, 'src', 'main'),
];

/** Code that is not shipped, and so is not held to the product's promise. */
const NOT_THE_PRODUCT = [
  // ⚠️ **Spikes are throwaway instruments and are never in the installer.** They exist to
  // ask a television a question before feature code is written, they are deleted when the
  // milestone lands, and `spike/m3c.ts` legitimately fetches its own local server to check
  // what it just served. Holding them to the product's guarantee would either weaken the
  // guarantee or stop the instruments doing their job.
  //
  // This is a separate list from the one below **on purpose**: the reason differs. These are
  // not shipped; those are shipped and talk only to the LAN.
  path.join('src', 'engine', 'spike'),
];

/**
 * Directories that are allowed to open sockets, and why.
 *
 * **Both serve the local network and neither can reach the internet.** A new entry here is a
 * claim that some other part of CastGood needs a socket, and it should be argued in the
 * pull request that adds it.
 */
const LAN_ONLY = [
  path.join('src', 'engine', 'media-server'), // serves the film to a television on this LAN
  path.join('src', 'engine', 'cast'), // CASTV2 to a Chromecast on this LAN
  path.join('src', 'engine', 'discovery'), // mDNS multicast, which never leaves the subnet
  path.join('src', 'engine', 'network'), // reads this PC's own adapters
];

const FORBIDDEN = [
  { pattern: /\bfetch\s*\(/, description: 'fetch(' },
  { pattern: /\bnew\s+XMLHttpRequest\b/, description: 'new XMLHttpRequest' },
  { pattern: /\bnew\s+WebSocket\b/, description: 'new WebSocket' },
  { pattern: /\bhttps?\.request\s*\(/, description: 'http.request( / https.request(' },
  {
    pattern: /from\s+['"](axios|node-fetch|got|undici|superagent)['"]/,
    description: 'an HTTP client package',
  },
  { pattern: /\bnet\.request\s*\(/, description: "Electron's net.request(" },
  { pattern: /navigator\.sendBeacon/, description: 'navigator.sendBeacon' },
];

async function collectSourceFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(
    entries.map(async (entry) => {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) return collectSourceFiles(full);
      return entry.name.endsWith('.ts') || entry.name.endsWith('.tsx') ? [full] : [];
    }),
  );
  return files.flat();
}

/** Comments describe the ban as often as code would break it; only code counts. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

describe('CastGood never sends anything anywhere', () => {
  it('has source files to check', async () => {
    const files = (await Promise.all(GUARDED.map(collectSourceFiles))).flat();
    expect(files.length, 'found no source to check, so this test proves nothing').toBeGreaterThan(
      20,
    );
  });

  it('contains no outbound network client outside the LAN-only directories', async () => {
    const files = (await Promise.all(GUARDED.map(collectSourceFiles))).flat();
    const offences: string[] = [];

    for (const file of files) {
      const relative = path.relative(repoRoot, file);
      if ([...LAN_ONLY, ...NOT_THE_PRODUCT].some((dir) => relative.startsWith(dir))) continue;
      const source = withoutComments(await readFile(file, 'utf8'));
      for (const { pattern, description } of FORBIDDEN) {
        if (pattern.test(source)) offences.push(`${relative} uses ${description}`);
      }
    }

    expect(
      offences,
      'CastGood has no cloud, no account and no telemetry — and story 25 exists precisely ' +
        'so a log can be handed back BY A PERSON. An upload would arrive as a kindness, in ' +
        'one commit, and this is the only thing in the repository that would object:\n  ' +
        offences.join('\n  '),
    ).toEqual([]);
  });

  it('names its exemptions rather than inferring them', () => {
    // If this list is ever derived from a pattern, adding a socket stops being a decision
    // somebody makes in a diff and starts being something that happens quietly.
    expect(LAN_ONLY.length).toBeGreaterThan(0);
    for (const dir of LAN_ONLY) {
      expect(dir.startsWith(path.join('src', 'engine'))).toBe(true);
    }
  });
});
