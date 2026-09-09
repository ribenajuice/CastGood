import { describe, expect, it } from 'vitest';
import { currentRun, redact } from '../../src/engine/diagnostics/redact.js';

/**
 * Story 25 — what an exported log gives away, and what it must still be able to say.
 *
 * The founder ruled on 2026-09-09 (question 45) that everything identifying is redacted.
 * **These tests exist because the obvious implementation of that ruling is useless**: a log
 * where every film is `<film>` and every set is `<device>` cannot say *"the same film failed
 * twice"* or *"device-2 is the one that dropped"*, and those sentences are frequently the
 * whole diagnosis.
 */

const SUBJECTS = {
  username: 'Darren',
  deviceNames: ['Family room TV', 'Home Theatre TV'],
  fileNames: ['Cars.mp4', 'Cars 2.mp4'],
};

describe('redaction removes the person and keeps the shape', () => {
  it('replaces the username everywhere, including inside file paths', () => {
    // 249 of 249 occurrences in a real log were inside `C:\Users\<name>\…`. A replacement
    // that only matched a "user" field would leave every one of them and report success.
    const log = [
      '{"event":"file.selected","path":"C:\\\\Users\\\\Darren\\\\Videos\\\\Cars.mp4"}',
      '{"event":"engine.start","user":"Darren"}',
      '{"event":"note","msg":"Darren pressed Cast"}',
    ].join('\n');

    const { text } = redact(log, SUBJECTS);

    expect(text, 'the username survived somewhere').not.toMatch(/Darren/i);
    expect(text).toContain('<user-1>');
  });

  it('gives the same film the same placeholder every time, and different films different ones', () => {
    // ⚠️ This is the criterion that separates a useful redaction from a useless one.
    const log = [
      '{"file":"Cars.mp4","event":"cast"}',
      '{"file":"Cars.mp4","event":"failed"}',
      '{"file":"Cars 2.mp4","event":"cast"}',
    ].join('\n');

    const { text } = redact(log, SUBJECTS);
    const first = text.split('\n')[0] ?? '';
    const second = text.split('\n')[1] ?? '';
    const third = text.split('\n')[2] ?? '';

    const filmOf = (line: string): string => /<film-\d+>/.exec(line)?.[0] ?? '';
    expect(filmOf(first), 'a film must keep one identity across the whole log').toBe(
      filmOf(second),
    );
    expect(filmOf(third), 'two different films must not collapse into one').not.toBe(filmOf(first));
    expect(filmOf(first)).not.toBe('');
  });

  it('keeps the extension, because a container is often the fault and .mkv identifies nobody', () => {
    const { text } = redact('{"file":"Cars.mp4"}', SUBJECTS);
    expect(text).toMatch(/<film-\d+>\.mp4/);
  });

  it('does not half-replace a longer name with a shorter one that is its prefix', () => {
    // "Cars" is a prefix of "Cars 2". Replacing the short one first would leave "<film-1> 2".
    const { text } = redact('{"file":"Cars 2.mp4"}', SUBJECTS);
    expect(text, 'the longer film name was chewed by the shorter one').not.toMatch(/> 2/);
  });

  it('replaces televisions and addresses, and keeps loopback', () => {
    const log = '{"friendlyName":"Family room TV","address":"10.1.1.168","local":"127.0.0.1"}';
    const { text, counts } = redact(log, SUBJECTS);

    expect(text).not.toContain('Family room TV');
    expect(text).not.toContain('10.1.1.168');
    // Loopback is not a household detail, and removing it removes the ability to tell a
    // local media server from a television.
    expect(text, 'loopback is not identifying and is worth keeping').toContain('127.0.0.1');
    expect(counts.device).toBe(1);
    expect(counts.ip).toBe(1);
  });
});

describe('the exported slice is this run, and says when it is short', () => {
  it('starts at the most recent engine.start, not the first', () => {
    const lines = [
      '{"event":"engine.start"} old run',
      '{"event":"note"} old',
      '{"event":"engine.start"} this run',
      '{"event":"note"} new',
    ];
    const out = currentRun(lines, 100);
    expect(out).toHaveLength(2);
    expect(out[0]).toContain('this run');
  });

  it('says how many lines it dropped rather than truncating silently', () => {
    // A person who cannot see that lines are missing will not mention it, and the missing
    // ones will be the ones that were asked for.
    const lines = [
      '{"event":"engine.start"}',
      ...Array.from({ length: 50 }, (_, i) => `{"n":${String(i)}}`),
    ];
    const out = currentRun(lines, 10);

    expect(out).toHaveLength(11);
    expect(out[0], 'a capped export must state the cap').toMatch(/41 earlier lines .* dropped/);
    expect(out.at(-1)).toContain('"n":49');
  });

  it('returns the run untouched when it fits', () => {
    const lines = ['{"event":"engine.start"}', '{"n":1}'];
    expect(currentRun(lines, 100)).toHaveLength(2);
  });
});
