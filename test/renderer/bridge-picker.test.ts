import { afterEach, describe, expect, it, vi } from 'vitest';
import { pickVideoFile } from '../../src/renderer/bridge.js';

/**
 * The file picker's argument, and its failure path.
 *
 * Both of these are here because of one bug that reached the founder's installed build:
 * `<FilePanel onPick={openPicker} />` passed the handler bare, React called it with the
 * MouseEvent, and the event travelled all the way to `ipcRenderer.invoke`, which cannot
 * structured-clone a SyntheticEvent and threw. The preload caught that and returned
 * `null`, which means *cancelled* — so **Choose video… did nothing at all**: no dialog,
 * no message beside the button, and not one line in the engine log on either side of the
 * IPC boundary. The only visible symptom was a button that looked fine and wasn't.
 *
 * Two rules come out of it, and this file holds both:
 *  1. a `startIn` that is not a string never reaches the bridge, whatever the caller does;
 *  2. a picker that genuinely failed reads as *failed*, never as *cancelled*.
 */

interface CastGoodWindow {
  castgood?: { pickVideoFile?: (startIn?: string) => Promise<string | null> };
}

const host = globalThis as unknown as { window?: CastGoodWindow };

function withPicker(pick: (startIn?: string) => Promise<string | null>): void {
  host.window = { castgood: { pickVideoFile: pick } };
}

afterEach(() => {
  delete host.window;
});

describe('pickVideoFile', () => {
  it('never forwards a click event as the folder to open', async () => {
    const pick = vi.fn(async () => Promise.resolve(['C:\\Videos\\Bluey.mp4']));
    withPicker(pick);

    // What React actually hands a bare `onClick={handler}`: an object with DOM nodes and
    // methods on it, which is precisely what IPC cannot serialise.
    const clickEvent = {
      type: 'click',
      target: { nodeName: 'BUTTON' },
      nativeEvent: { isTrusted: true },
      preventDefault: () => undefined,
    };

    const outcome = await pickVideoFile(clickEvent);

    expect(pick).toHaveBeenCalledWith(undefined);
    expect(outcome).toEqual({
      kind: 'selected',
      path: 'C:\\Videos\\Bluey.mp4',
      paths: ['C:\\Videos\\Bluey.mp4'],
    });
  });

  it('still opens where the file used to be when given a real path (15b)', async () => {
    const pick = vi.fn(async () => Promise.resolve(['C:\\Videos\\Bluey.mp4']));
    withPicker(pick);

    await pickVideoFile('C:\\Videos\\Bluey.mp4');

    expect(pick).toHaveBeenCalledWith('C:\\Videos\\Bluey.mp4');
  });

  it('reads a picker that threw as failed, not as cancelled', async () => {
    withPicker(() => Promise.reject(new Error('An object could not be cloned.')));

    // `cancelled` would leave the founder with a button that silently does nothing.
    await expect(pickVideoFile()).resolves.toEqual({ kind: 'failed' });
  });

  it('reads a real cancel as cancelled, so the previous selection stands (2b)', async () => {
    // 24a: a cancel is an EMPTY ARRAY now, not null. 2b is unchanged.
    withPicker(() => Promise.resolve([]));

    await expect(pickVideoFile()).resolves.toEqual({ kind: 'cancelled' });
  });

  it('says so rather than pretending when the build has no picker at all', async () => {
    host.window = { castgood: {} };

    await expect(pickVideoFile()).resolves.toEqual({ kind: 'unavailable' });
  });
});
