import { describe, expect, it } from 'vitest';
import { refuseWatch } from '../../src/engine/selftest/index.js';
import { parseArgs } from '../../src/engine/selftest/args.js';

/**
 * `--watch`: `headstart`'s full-film run, which 10b calls *"the only evidence that counts"*.
 *
 * Until 2026-08-25 the scenario watched for a hardcoded three minutes and there was no way
 * to ask it for more, so **the milestone's headline criterion had no instrument at all** —
 * M3b could not have been closed by any run this harness could produce. That is the gap
 * these tests exist to keep closed.
 */
describe('--watch is refused anywhere it would be misread', () => {
  it('only applies to headstart', () => {
    // Silently ignoring it is the dangerous version: an operator who asked for 130 minutes
    // and got a three-minute run would file the verdict as 10b's evidence.
    expect(refuseWatch('position', 7_800_000)).toContain('only applies');
    expect(refuseWatch('m3', 7_800_000)).toContain('only applies');
    expect(refuseWatch('headstart', 7_800_000)).toBeNull();
  });

  it('is refused alongside either throttle, because they are different claims', () => {
    // A full film is about a conversion that keeps its lead the whole way. `--rate` keeps
    // the gate shut and `--rate-after-gate` deliberately makes the conversion fall behind;
    // either one combined with `--watch` would be a verdict about neither.
    expect(refuseWatch('headstart', 7_800_000, 0.7, undefined)).toContain('Ask for one');
    expect(refuseWatch('headstart', 7_800_000, undefined, 0.5)).toContain('Ask for one');
  });

  it('is absent by default, so the ordinary run is unchanged', () => {
    expect(refuseWatch('headstart', undefined)).toBeNull();
    expect(refuseWatch('position', undefined)).toBeNull();
  });
});

describe('--watch parses the way --duration does', () => {
  const base = ['--device', 'Family room TV', '--file', 'C:\\f.mkv', '--scenario', 'headstart'];

  it('accepts a duration and hands it on in milliseconds', () => {
    const result = parseArgs([...base, '--watch', '130m']);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.headStartWatchMs).toBe(130 * 60_000);
  });

  it('leaves it undefined when not asked for', () => {
    const result = parseArgs(base);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.args.headStartWatchMs).toBeUndefined();
  });

  it('refuses a value that is not a duration rather than guessing one', () => {
    const result = parseArgs([...base, '--watch', 'ages']);
    expect(result.ok).toBe(false);
  });

  it('refuses the combination at the command line, not just in the helper', () => {
    // The refusal has to bite where an operator actually types, or it is decoration.
    const result = parseArgs([...base, '--watch', '130m', '--rate-after-gate', '0.5']);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('Ask for one');
  });
});
