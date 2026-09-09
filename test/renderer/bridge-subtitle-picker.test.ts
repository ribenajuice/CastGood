import { afterEach, describe, expect, it, vi } from 'vitest';
import { canPickSubtitleFile, pickSubtitleFile } from '../../src/renderer/bridge.js';

/**
 * The **subtitle** picker's argument and its failure path — 18c.
 *
 * The same two rules `bridge-picker.test.ts` holds for the video picker, and they are here
 * rather than assumed because this is a *second* picker written to the shape of the first:
 * the bug that made *Choose video…* silently do nothing (React's MouseEvent travelling to
 * `ipcRenderer.invoke`, which cannot structured-clone it, caught in preload and returned as
 * `null` — indistinguishable from a cancel) is exactly the bug a copied function inherits.
 *
 *  1. a `startIn` that is not a string never reaches the bridge, whatever the caller does;
 *  2. a picker that genuinely failed reads as *failed*, never as *cancelled* — because
 *     cancelled means "the film stays as it was, without subtitles" and a founder whose
 *     dialog broke would be told nothing at all.
 */

interface CastGoodWindow {
  castgood?: { pickSubtitleFile?: (startIn?: string) => Promise<string | null> };
}

const host = globalThis as unknown as { window?: CastGoodWindow };

function withPicker(pick: (startIn?: string) => Promise<string | null>): void {
  host.window = { castgood: { pickSubtitleFile: pick } };
}

afterEach(() => {
  delete host.window;
});

describe('pickSubtitleFile', () => {
  it('never forwards a click event as the folder to open', async () => {
    const pick = vi.fn(async () => Promise.resolve('D:\\Films\\Cars.en.srt'));
    withPicker(pick);

    const clickEvent = { nativeEvent: {}, target: {}, preventDefault: () => undefined };
    const outcome = await pickSubtitleFile(clickEvent);

    expect(outcome).toEqual({ kind: 'selected', path: 'D:\\Films\\Cars.en.srt' });
    expect(pick).toHaveBeenCalledWith(undefined);
  });

  it('opens beside the film when given the film’s path', async () => {
    const pick = vi.fn(async () => Promise.resolve('D:\\Films\\Cars.en.srt'));
    withPicker(pick);

    await pickSubtitleFile('D:\\Films\\Cars.mkv');

    expect(pick).toHaveBeenCalledWith('D:\\Films\\Cars.mkv');
  });

  it('reads a genuine failure as failed, never as cancelled', async () => {
    withPicker(() => Promise.reject(new Error('could not be cloned')));

    expect(await pickSubtitleFile()).toEqual({ kind: 'failed' });
  });

  it('reads a cancel as cancelled, so the film is left exactly as it was', async () => {
    withPicker(async () => Promise.resolve(null));

    expect(await pickSubtitleFile()).toEqual({ kind: 'cancelled' });
  });

  it('says the picker is unavailable rather than pretending, when this build has none', async () => {
    host.window = { castgood: {} };

    expect(canPickSubtitleFile()).toBe(false);
    expect(await pickSubtitleFile()).toEqual({ kind: 'unavailable' });
  });
});
