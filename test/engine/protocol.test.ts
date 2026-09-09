import { describe, expect, it } from 'vitest';
import { parseIntent } from '../../src/engine/protocol/index.js';

/**
 * Intents cross a trust boundary: the renderer is a browser context and is not
 * trusted input. Everything arriving over IPC is validated before the engine sees it.
 */

describe('parseIntent', () => {
  it('accepts a well-formed intent (happy path)', () => {
    const result = parseIntent({ type: 'playback.seek', positionSec: 42.5 });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.intent).toEqual({ type: 'playback.seek', positionSec: 42.5 });
    }
  });

  it('rejects an unknown intent type', () => {
    const result = parseIntent({ type: 'playback.selfDestruct' });
    expect(result.ok).toBe(false);
  });

  it.each([
    ['a negative seek', { type: 'playback.seek', positionSec: -1 }],
    ['a non-finite seek', { type: 'playback.seek', positionSec: Number.POSITIVE_INFINITY }],
    ['a missing field', { type: 'device.select' }],
    ['an empty file path', { type: 'file.select', path: '' }],
    ['a non-object payload', 'cast.start'],
    ['null', null],
  ])('rejects %s', (_label, payload) => {
    const result = parseIntent(payload);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(typeof result.reason).toBe('string');
      expect(result.reason.length).toBeGreaterThan(0);
    }
  });
});
