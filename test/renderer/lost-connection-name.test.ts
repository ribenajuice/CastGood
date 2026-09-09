import { describe, expect, it } from 'vitest';
import { buildViewModel } from '../../src/renderer/state/view-model.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/protocol/index.js';

/**
 * **Issue #66 — the app named the wrong television, and it was a healthy one in the room.**
 *
 * Found on hardware 2026-09-09. Mains power was pulled from the set playing a film, and the
 * screen said *"Lost connection to Home Theatre TV"* — a different television, sitting
 * there working. The engine was entirely correct: it recorded five reconnect attempts, kept
 * the position, and dropped only the set that had actually gone.
 *
 * **Two independent faults produced it, and each of these tests holds one of them down.**
 *
 * 1. A lost connection ends in `stopped`, and the rule for `stopped` deliberately prefers
 *    the **selected** device — because *Stopped* answers *"where will Cast send it next?"*
 *    (the founder's ruling of 2026-09-03, which is right and is unchanged). The bug was
 *    letting that rule answer a different question.
 * 2. The name was resolved out of `discovery.devices`, and **a television that loses power
 *    leaves that list** — which is precisely the situation being described.
 *
 * ⚠️ **Both faults are invisible in ordinary use**, because the selected device usually
 * *is* the one that was playing. These fixtures make the two differ on purpose. That is
 * why nothing caught this: it needs a device removed from discovery while a session still
 * points at it, and the selection pointed somewhere else.
 */

const IDLE_PICKER = { available: true, busy: false, error: null };

/** A chosen film, so the screens under test are reachable at all. */
const FILE: NonNullable<StateSnapshot['file']> = {
  path: 'D:\\films\\a-film.mp4',
  name: 'a-film.mp4',
  durationSec: 6990,
  verdict: null,
};

const PLAYING = { id: 'tv-playing', friendlyName: 'The set that was playing', model: 'AI PONT' };
const OTHER = { id: 'tv-other', friendlyName: 'A different, healthy set', model: 'Chromecast' };

/** The television that was holding the film has vanished; another is selected. */
function afterPowerCut(overrides: Partial<StateSnapshot['session']> = {}): StateSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    discovery: {
      ...EMPTY_SNAPSHOT.discovery,
      phase: 'found',
      // The set that was playing is GONE from the list — this is the whole point.
      devices: [{ ...OTHER, available: true }],
      selectedDeviceId: OTHER.id,
    },
    session: {
      ...EMPTY_SNAPSHOT.session,
      state: 'stopped',
      deviceId: PLAYING.id,
      deviceName: PLAYING.friendlyName,
      positionSec: 176.073,
      resumePositionSec: 176.073,
      ...overrides,
    },
    file: FILE,
    notice: {
      kind: 'lost-connection',
      severity: 'error',
      message: 'Lost connection',
      actionLabel: null,
    } as NonNullable<StateSnapshot['notice']>,
  };
}

describe('the television a message is about is the one that was holding the film (#66)', () => {
  it('names the set that was playing, not the one that is merely selected', () => {
    const vm = buildViewModel(afterPowerCut(), IDLE_PICKER);
    const said = `${vm.headline} ${vm.sub ?? ''}`;

    expect(said, 'the sentence must name the television that was actually lost').toContain(
      PLAYING.friendlyName,
    );
    // The real defect, stated as its own expectation: a healthy set in the room was named.
    expect(
      said,
      'a different, working television was named as the one that was lost',
    ).not.toContain(OTHER.friendlyName);
  });

  it('still names it when the engine remembered nothing, rather than saying nothing', () => {
    // A session that predates the remembered name falls back to the lookup, and when that
    // also fails the sentence must not have a hole in it (criterion 1c).
    const vm = buildViewModel(afterPowerCut({ deviceName: null }), IDLE_PICKER);
    expect(vm.headline).not.toMatch(/\s{2,}|undefined|null/);
    expect(vm.headline.length).toBeGreaterThan(0);
  });

  it('does not disturb the 2026-09-03 ruling: Stopped still names where Cast would go next', () => {
    // Nothing was lost here. The session simply ended, and the founder has since selected a
    // different television — so the app must name THAT one, which is the opposite answer to
    // the test above and the reason these are two functions rather than one.
    const stopped: StateSnapshot = {
      ...EMPTY_SNAPSHOT,
      discovery: {
        ...EMPTY_SNAPSHOT.discovery,
        phase: 'found',
        devices: [
          { ...PLAYING, available: true },
          { ...OTHER, available: true },
        ],
        selectedDeviceId: OTHER.id,
      },
      file: FILE,
      session: {
        ...EMPTY_SNAPSHOT.session,
        state: 'stopped',
        deviceId: PLAYING.id,
        deviceName: PLAYING.friendlyName,
      },
    };
    const vm = buildViewModel(stopped, IDLE_PICKER);
    const said = `${vm.headline} ${vm.sub ?? ''}`;
    expect(said, 'Stopped answers "where will Cast send it", so it names the selection').toContain(
      OTHER.friendlyName,
    );
  });
});
