import { describe, expect, it } from 'vitest';
import {
  buildViewModel,
  scrubberReadout,
  type PickerState,
} from '../../src/renderer/state/view-model.js';
import { hms, hmsOrNull, percentOf } from '../../src/renderer/lib/format.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';

/**
 * What the founder actually sees, tested as a pure function.
 *
 * `buildViewModel` decides every word, every enabled button and every disabled reason in
 * the window, and until now nothing tested it — so the acceptance criteria that are about
 * *what is on screen* (1d's self-clearing checklist, 2a's `H:MM:SS`, 3b's "every other
 * device stays selectable", 4b's saved position, 5a's readout) had no coverage at all.
 *
 * These go through the public interface — snapshot in, view model out — so they survive a
 * component refactor. They prove the presentation rules and nothing about a television.
 */

const IDLE_PICKER: PickerState = { available: true, busy: false, error: null };

function snapshot(overrides: {
  discovery?: Partial<StateSnapshot['discovery']>;
  session?: Partial<StateSnapshot['session']>;
  file?: StateSnapshot['file'];
  notice?: StateSnapshot['notice'];
  check?: StateSnapshot['check'];
  preparation?: Partial<StateSnapshot['preparation']>;
  headStart?: Partial<NonNullable<StateSnapshot['headStart']>> | null;
}): StateSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    discovery: { ...EMPTY_SNAPSHOT.discovery, ...overrides.discovery },
    session: { ...EMPTY_SNAPSHOT.session, ...overrides.session },
    file: overrides.file ?? null,
    notice: overrides.notice ?? null,
    check: overrides.check ?? null,
    preparation: { ...EMPTY_SNAPSHOT.preparation, ...overrides.preparation },
    headStart:
      overrides.headStart === undefined || overrides.headStart === null
        ? null
        : {
            frontierSec: 1_800,
            seekLimitSec: 1_680,
            hold: null,
            conversionComplete: false,
            ...overrides.headStart,
          },
  };
}

/** A verdict as the engine builds one. The strings are the classifier's, final. */
function verdict(
  overrides: Partial<NonNullable<StateSnapshot['file']>['verdict']> = {},
): NonNullable<NonNullable<StateSnapshot['file']>['verdict']> {
  return {
    kind: 'remux',
    tier: 2,
    headline: 'Ready in about 50 seconds',
    reason: 'Nothing is re-encoded, so the picture and sound are untouched.',
    subtitleNotice: null,
    requiresConfirmation: false,
    estimateSeconds: 50,
    confirmation: null,
    message: '',
    ...overrides,
  };
}

const livingRoom = {
  id: 'tv-1',
  friendlyName: 'Living Room TV',
  model: 'Chromecast Ultra',
  available: true,
};
const kitchen = { id: 'tv-2', friendlyName: 'Kitchen TV', model: 'Chromecast', available: true };

const chosenFile: StateSnapshot['file'] = {
  path: 'C:/videos/Bluey - The Sign.mp4',
  name: 'Bluey - The Sign.mp4',
  durationSec: 4_215,
  verdict: null,
};

function view(s: StateSnapshot, picker: PickerState = IDLE_PICKER) {
  return buildViewModel(s, picker);
}

describe('H:MM:SS, written out in full (2a, 5a)', () => {
  it('always carries the hours field, even below an hour', () => {
    expect(hms(0)).toBe('0:00:00');
    expect(hms(59)).toBe('0:00:59');
    expect(hms(732)).toBe('0:12:12');
    expect(hms(4_215)).toBe('1:10:15');
    expect(hms(7_200)).toBe('2:00:00');
  });

  it('floors rather than rounding, so the readout never reads ahead of the device', () => {
    expect(hms(1.999)).toBe('0:00:01');
  });

  it('refuses to invent a duration it does not have', () => {
    expect(hmsOrNull(null)).toBeNull();
    expect(hmsOrNull(0)).toBe('0:00:00');
  });

  it('survives the values a broken device could report', () => {
    expect(hms(-5)).toBe('0:00:00');
    expect(hms(Number.NaN)).toBe('0:00:00');
    expect(hms(Number.POSITIVE_INFINITY)).toBe('0:00:00');
    expect(percentOf(10, 0)).toBe(0);
    expect(percentOf(10, Number.NaN)).toBe(0);
    expect(percentOf(500, 100)).toBe(100);
    expect(percentOf(-5, 100)).toBe(0);
  });
});

describe('criterion 1d — the "no devices" message clears itself', () => {
  it('shows the checklist and Search again once the search has had its five seconds', () => {
    const vm = view(snapshot({ discovery: { phase: 'none', devices: [] } }));
    expect(vm.devices.empty).toBe('none-found');
    expect(vm.devices.statusLabel).toBe('None found');
    expect(vm.devices.canRescan).toBe(true);
    expect(vm.stateName).toBe('IdleNoDevices');
  });

  it('says it is still looking before those five seconds, not that it found nothing', () => {
    const vm = view(snapshot({ discovery: { phase: 'searching', devices: [] } }));
    expect(vm.devices.empty).toBe('searching');
    expect(vm.devices.statusLabel).toBe('Looking…');
  });

  it('replaces the whole message with the list the moment a device answers', () => {
    // The same view model, one device later, with nothing clicked in between: the
    // criterion is that the message disappears by itself.
    const before = view(snapshot({ discovery: { phase: 'none', devices: [] } }));
    const after = view(
      snapshot({ discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' } }),
    );
    expect(before.devices.empty).toBe('none-found');
    expect(after.devices.empty).toBeNull();
    expect(after.devices.rows.map((row) => row.name)).toEqual(['Living Room TV']);
    expect(after.devices.statusLabel).toBe('1 found');
  });
});

describe('criterion 1c — devices are named, never numbered', () => {
  it('shows the friendly name as the row label and the model only as the sub-line', () => {
    const vm = view(
      snapshot({
        discovery: { phase: 'found', devices: [livingRoom, kitchen], selectedDeviceId: 'tv-2' },
      }),
    );
    expect(vm.devices.rows.map((row) => row.name)).toEqual(['Living Room TV', 'Kitchen TV']);
    expect(vm.devices.rows[0]?.meta).toBe('Chromecast Ultra');
    expect(vm.devices.rows.map((row) => row.selected)).toEqual([false, true]);
  });

  it('never leaves a hole where a device name should be', () => {
    const vm = view(snapshot({ file: chosenFile, discovery: { phase: 'searching' } }));
    expect(vm.headline).not.toContain('undefined');
    expect(vm.sub ?? '').not.toContain('undefined');
  });
});

describe('criterion 2a — a chosen file, and nothing sent anywhere', () => {
  it('states the name, the duration in H:MM:SS and Ready to cast', () => {
    const vm = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
      }),
    );
    expect(vm.file).toEqual({
      name: 'Bluey - The Sign.mp4',
      durationLabel: '1:10:15',
      // 8e: nothing would be lost, so nothing is said. Not an empty string, not a row with
      // a dash in it — nothing.
      subtitleNotice: null,
    });
    expect(vm.headline).toBe('Ready to cast');
    expect(vm.stateName).toBe('Ready');
    // The single primary action is the only thing that can reach a TV.
    expect(vm.actions.map((a) => [a.id, a.primary, a.disabledReason])).toEqual([
      ['cast', true, null],
    ]);
    expect(vm.transport).toBeNull();
  });

  it('makes no compatibility claim when nothing has checked the file', () => {
    // `verdict: null` means *no claim has been made about this file* — no device selected
    // yet, or no ffmpeg on this machine. M3a made *Ready to cast* able to mean something,
    // and this is the case where it still must not: naming the destination is the whole of
    // what can honestly be said.
    const vm = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
      }),
    );
    expect(vm.sub).toBe('Pressing Cast sends it to Living Room TV.');
    expect(vm.sub).not.toMatch(/exactly as it is|can play this/i);
  });

  it('disables Cast with a reason when there is nowhere to send it', () => {
    const noDevices = view(snapshot({ file: chosenFile, discovery: { phase: 'none' } }));
    expect(noDevices.actions[0]?.disabledReason).toBe('No device found yet');

    const unselected = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: null },
      }),
    );
    expect(unselected.actions[0]?.disabledReason).toBe('Choose a device first');
  });
});

describe('criterion 3b — every other device stays selectable after a failure', () => {
  const failed = snapshot({
    file: chosenFile,
    discovery: { phase: 'found', devices: [livingRoom, kitchen], selectedDeviceId: 'tv-2' },
    session: { state: 'idle', deviceId: 'tv-2' },
    notice: {
      kind: 'generic',
      severity: 'error',
      message: "Couldn't reach Kitchen TV",
      actionLabel: 'Try again',
    },
  });

  it('leaves every row pressable and the panel unlocked', () => {
    const vm = view(failed);
    expect(vm.devices.rows.every((row) => !row.disabled)).toBe(true);
    expect(vm.devices.disabledReason).toBeNull();
    expect(vm.devices.canRescan).toBe(true);
  });

  it('shows the engine wording verbatim and offers Try again', () => {
    const vm = view(failed);
    expect(vm.headline).toBe("Couldn't reach Kitchen TV");
    expect(vm.tone).toBe('needsYou');
    expect(vm.actions.map((a) => a.id)).toEqual(['cast', 'pick']);
    expect(vm.actions[0]?.label).toBe('Try again');
  });

  it('never shows a retry counter', () => {
    const connecting = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'connecting', deviceId: 'tv-1' },
      }),
    );
    expect(connecting.headline).toBe('Connecting to Living Room TV…');
    expect(`${connecting.headline} ${connecting.sub ?? ''}`).not.toMatch(
      /attempt|retry|retrying|\b[123] of [123]\b/i,
    );
  });

  it('locks the list only while a session is genuinely live, and says why', () => {
    const playing = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom, kitchen], selectedDeviceId: 'tv-1' },
        session: { state: 'playing', deviceId: 'tv-1', durationSec: 4_215, positionSec: 10 },
      }),
    );
    expect(playing.devices.rows.every((row) => row.disabled)).toBe(true);
    expect(playing.devices.disabledReason).toBe('Stop playing to cast somewhere else');
  });
});

describe('criteria 3a and 5a — the states between the press and the picture', () => {
  const base = {
    file: chosenFile,
    discovery: { phase: 'found' as const, devices: [livingRoom], selectedDeviceId: 'tv-1' },
  };

  it('names each step rather than showing a bare spinner', () => {
    const named: [SessionState, string, string][] = [
      ['connecting', 'Connecting', 'Connecting to Living Room TV…'],
      ['loading', 'Loading', 'Starting on Living Room TV…'],
      ['buffering', 'Buffering', 'Buffering…'],
      ['playing', 'Playing', 'Playing on Living Room TV'],
      ['paused', 'Paused', 'Paused'],
    ];
    for (const [state, stateName, headline] of named) {
      const vm = view(snapshot({ ...base, session: { state, deviceId: 'tv-1' } }));
      expect(vm.stateName, state).toBe(stateName);
      expect(vm.headline, state).toBe(headline);
    }
  });

  it('shows position and duration together, both in H:MM:SS, while playing', () => {
    const vm = view(
      snapshot({
        ...base,
        session: { state: 'playing', deviceId: 'tv-1', positionSec: 1_930, durationSec: 4_215 },
      }),
    );
    expect(vm.transport?.positionLabel).toBe('0:32:10');
    expect(vm.transport?.durationLabel).toBe('1:10:15');
    expect(vm.transport?.controlsDisabled).toBe(false);
    expect(vm.transport?.toggle).toEqual({ id: 'pause', label: 'Pause' });
  });

  it('offers Play, not Pause, while paused (5c)', () => {
    const vm = view(
      snapshot({
        ...base,
        session: { state: 'paused', deviceId: 'tv-1', positionSec: 1_930, durationSec: 4_215 },
      }),
    );
    expect(vm.transport?.toggle).toEqual({ id: 'play', label: 'Play' });
    expect(vm.transport?.positionLabel).toBe('0:32:10');
    expect(vm.transport?.controlsDisabled).toBe(false);
  });

  it('renders no skip buttons and no seekable scrubber in M1', () => {
    const vm = view(
      snapshot({
        ...base,
        session: {
          state: 'playing',
          deviceId: 'tv-1',
          positionSec: 100,
          durationSec: 4_215,
          canSeek: false,
        },
      }),
    );
    expect(vm.actions.map((a) => a.id)).not.toContain('play');
    expect(Object.keys(vm.transport ?? {})).not.toContain('skipBack');
    expect(vm.transport?.percent).toBeCloseTo((100 / 4_215) * 100, 6);
  });

  it('lets a picture outrank a stale error notice rather than blacking out the film', () => {
    const vm = view(
      snapshot({
        ...base,
        session: { state: 'playing', deviceId: 'tv-1', positionSec: 5, durationSec: 4_215 },
        notice: {
          kind: 'generic',
          severity: 'error',
          message: 'Something went wrong earlier',
          actionLabel: null,
        },
      }),
    );
    expect(vm.stateName).toBe('Playing');
  });
});

describe('criteria 4b, 2c and 16b — Stopped keeps the place, the file, and offers it back', () => {
  const stopped = snapshot({
    file: chosenFile,
    discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
    session: {
      state: 'stopped',
      deviceId: 'tv-1',
      positionSec: 1_930,
      durationSec: 4_215,
      // The Stopped screen reads the *remembered* position, not the live one. They agree
      // after an ordinary stop; they do not after a cast that failed on its way back, and
      // the remembered one is the number that survives.
      resumePositionSec: 1_930,
    },
  });

  it('states the saved position in words and offers it back as the primary action', () => {
    const vm = view(stopped);
    expect(vm.stateName).toBe('Stopped');
    expect(vm.headline).toBe('Stopped');
    expect(vm.sub).toContain('Your place is saved at 0:32:10');
    // 16b: Resume is primary, starting over is secondary, and the saved position is not
    // adjustable — there is no control here that edits it (founder ruling, 2026-08-14).
    expect(vm.actions.map((a) => [a.id, a.label])).toEqual([
      ['resume', 'Resume from 0:32:10'],
      ['cast', 'Start from the beginning'],
      ['pick', 'Choose another video'],
    ]);
    expect(vm.file?.name).toBe('Bluey - The Sign.mp4');
  });

  /**
   * **The founder's own report, 2026-09-03**, and it is worth quoting because it describes
   * the failure better than a criterion would: *"I hit the stop button and then selected
   * the Family Room TV. From here, there was no obvious button that felt safe to click to
   * start the casting here instead. The UI implied that it was going to start casting
   * again on the master bedroom TV."*
   *
   * The **behaviour** was never wrong — `startCast` casts to `selectedDeviceId`, so
   * *Resume* would have gone to the newly picked television. The **words** were wrong, and
   * that is worse than it sounds: a correct action that nobody dares press is a broken
   * one. `deviceName()` preferred `session.deviceId` — the set the finished session was
   * on — over the set the founder had just chosen, and nothing anywhere on the screen
   * named the new television.
   */
  it('names the television the founder just picked, not the one it was stopped on', () => {
    const vm = view(
      snapshot({
        file: chosenFile,
        discovery: {
          phase: 'found',
          devices: [livingRoom, kitchen],
          // Stopped on tv-1; the founder has since picked tv-2.
          selectedDeviceId: 'tv-2',
        },
        session: {
          state: 'stopped',
          deviceId: 'tv-1',
          durationSec: 4_215,
          resumePositionSec: 1_930,
        },
      }),
    );
    expect(vm.sub).toContain('Kitchen TV');
    expect(vm.sub).not.toContain('Living Room TV');
  });

  /**
   * **The same rule at the end of a film, and it changed direction between two PRs that
   * never conflicted.** When this test was first written it asserted the opposite: the
   * Finished screen said *"<name> is back on its own home screen"*, a fact about the set
   * that just played, and pointing it at a newly selected television would have told a lie.
   *
   * The founder's ruling of 2026-09-03 deleted that sentence — a film that plays out now
   * draws the screen the app opens on, whose sentence is *"Pressing Cast sends it to
   * <name>"*. That is a statement about **where the film goes next**, so the stale name
   * became the founder's original bug again, on the one screen it had just been fixed off.
   *
   * Git merged the two changes without a murmur. This test is the thing that caught it, so
   * it is left pointing at the interaction rather than quietly deleted.
   */
  it('names the newly picked television at the end of a film too', () => {
    const vm = view(
      snapshot({
        file: chosenFile,
        discovery: {
          phase: 'found',
          devices: [livingRoom, kitchen],
          // The film played out on tv-1; the founder has since picked tv-2.
          selectedDeviceId: 'tv-2',
        },
        session: { state: 'ended', deviceId: 'tv-1', durationSec: 4_215 },
      }),
    );
    expect(vm.sub).toBe('Pressing Cast sends it to Kitchen TV.');
    expect(vm.actions.map((a) => a.label)).toEqual(['Cast to Kitchen TV']);
    expect(vm.sub).not.toContain('Living Room TV');
  });

  it('offers no Resume for a film stopped in its opening second', () => {
    // Two buttons for one action. `Resume from 0:00:00` beside `Start from the beginning`
    // is a choice with no difference in it.
    const vm = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'stopped', deviceId: 'tv-1', durationSec: 4_215, resumePositionSec: 0.4 },
      }),
    );
    expect(vm.actions.map((a) => [a.id, a.label])).toEqual([
      ['cast', 'Play again'],
      ['pick', 'Choose another video'],
    ]);
  });

  it('dims the transport row instead of letting it vanish, and says why it is dead', () => {
    const vm = view(stopped);
    expect(vm.transport?.dimmed).toBe(true);
    expect(vm.transport?.controlsDisabled).toBe(true);
    expect(vm.transport?.disabledReason).toBe('Nothing is playing');
    expect(vm.transport?.toggle.id).toBe('play');
  });
});

describe('the picker never looks pressable when it is not', () => {
  it('explains itself when the dialog is already open, unavailable, or just failed', () => {
    const s = snapshot({ discovery: { phase: 'found', devices: [livingRoom] } });
    expect(view(s, { available: false, busy: false, error: null }).pick.disabledReason).toBe(
      'The file picker isn’t available in this build',
    );
    expect(view(s, { available: true, busy: true, error: null }).pick).toEqual({
      label: 'Choosing…',
      disabledReason: 'The file picker is open',
    });
    expect(view(s, { available: true, busy: false, error: 'boom' }).pick.disabledReason).toBe(
      'boom',
    );
  });

  it('changes its own label once something is chosen', () => {
    expect(view(snapshot({})).pick.label).toBe('Choose video…');
    expect(view(snapshot({ file: chosenFile })).pick.label).toBe('Choose a different video…');
  });
});

describe('nothing chosen yet', () => {
  it('says choosing a file starts nothing, and offers no action of its own', () => {
    const vm = view(snapshot({ discovery: { phase: 'found', devices: [livingRoom] } }));
    expect(vm.stateName).toBe('IdleDevices');
    expect(vm.headline).toBe('Nothing chosen yet');
    expect(vm.sub).toContain('doesn’t start anything');
    expect(vm.actions).toEqual([]);
    expect(vm.transport).toBeNull();
  });

  it('never shows more than one primary action anywhere in M1', () => {
    const states: SessionState[] = [
      'idle',
      'connecting',
      'loading',
      'buffering',
      'playing',
      'paused',
      'stopped',
    ];
    for (const state of states) {
      for (const file of [null, chosenFile]) {
        for (const notice of [
          null,
          {
            kind: 'generic' as const,
            severity: 'error' as const,
            message: "Couldn't reach Living Room TV",
            actionLabel: null,
          },
        ]) {
          const vm = view(
            snapshot({
              file,
              notice,
              discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
              session: { state, deviceId: 'tv-1' },
            }),
          );
          expect(
            vm.actions.filter((a) => a.primary).length,
            `${state} ${String(file)}`,
          ).toBeLessThanOrEqual(1);
        }
      }
    }
  });
});

// --- Milestone 2 -------------------------------------------------------------

describe('criterion 16a, superseded — a film that plays out returns to the opening screen', () => {
  const finished = snapshot({
    file: chosenFile,
    discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
    session: { state: 'ended', deviceId: 'tv-1', durationSec: 4_215, resumePositionSec: 4_215 },
  });

  // Founder ruling, 2026-09-03: *"The Finished screen should just default back to what the
  // application looks like when it just opens."* The old screen said where the television
  // went and offered *Play again*, and said nothing about where *Play again* would send
  // the film — which is the defect that prompted the question.
  it('draws the screen the app opens on, with the same film still in hand', () => {
    const vm = view(finished);
    expect(vm.stateName).toBe('Ready');
    expect(vm.headline).toBe('Ready to cast');
    // The sentence names the destination, which is the thing *Finished* never did.
    expect(vm.sub).toBe('Pressing Cast sends it to Living Room TV.');
    expect(vm.actions.map((a) => [a.id, a.label])).toEqual([['cast', 'Cast to Living Room TV']]);
    expect(vm.file?.name).toBe('Bluey - The Sign.mp4');
  });

  it('is byte-for-byte the screen a freshly opened app would draw for the same film', () => {
    // The whole point of the ruling: not *like* the opening screen, the opening screen.
    // If these two ever diverge, the end of a film has grown a state again.
    const justOpened = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'idle', deviceId: null, durationSec: 0, resumePositionSec: 0 },
      }),
    );
    const { file: _f, ...ended } = view(finished);
    const { file: _g, ...opened } = justOpened;
    expect(ended).toEqual(opened);
  });

  it('starts nothing by itself — the button is an offer, not an action', () => {
    // Unchanged from 16a and still load-bearing: the ruling changed what the screen says,
    // never that the end of a film is quiet until the founder presses something. The
    // engine's own `nothingPlayedNext` assertion guards the other half of this.
    const vm = view(finished);
    expect(vm.actions.every((a) => a.id !== 'resume')).toBe(true);
    expect(vm.actions).toHaveLength(1);
  });

  it('carries no transport row, because the opening screen has none', () => {
    expect(view(finished).transport).toBeNull();
  });
});

describe('criterion 6k — where the ±30 s controls are, and are not', () => {
  const playing = (session: Partial<StateSnapshot['session']>) =>
    view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { deviceId: 'tv-1', durationSec: 4_215, ...session },
      }),
    );

  it('renders both controls, live, while a film is playing', () => {
    const vm = playing({ state: 'playing', positionSec: 100, canSeek: true });
    expect(vm.transport?.skips.map((s) => [s.label, s.hidden, s.disabledReason])).toEqual([
      ['Back 30s', false, null],
      ['Forward 30s', false, null],
    ]);
    expect(vm.transport?.canDrag).toBe(true);
  });

  it('keeps the skips live through Buffering, and greys the drag instead', () => {
    // Jumping away is the best escape from a bad buffer, so the one control that gets you
    // out of one stays live. Dragging needs a position to drag from, and there isn't one.
    const vm = playing({ state: 'buffering', positionSec: 100, canSeek: false });
    expect(vm.transport?.skips.every((s) => !s.hidden && s.disabledReason === null)).toBe(true);
    expect(vm.transport?.canDrag).toBe(false);
    expect(vm.transport?.dragDisabledReason).toBe('Use the skip buttons while it buffers');
  });

  it('hides them outright once the TV has been released', () => {
    // Hidden, not greyed: there is nothing to skip *inside* a session that is over, and a
    // permanently dead control is worse than an absent one.
    const vm = playing({ state: 'stopped', resumePositionSec: 1_930 });
    expect(vm.transport?.skips.every((s) => s.hidden)).toBe(true);
    expect(vm.transport?.canDrag).toBe(false);
    // *ended* used to be graded here beside *stopped*. Since 2026-09-03 it draws the
    // opening screen, which has no transport row to hide anything on.
    expect(playing({ state: 'ended', resumePositionSec: 1_930 }).transport).toBeNull();
  });
});

describe('criteria 6h and 6i — what the readout says about a jump in progress', () => {
  const withSeek = (seek: StateSnapshot['session']['seek']) =>
    view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: {
          state: 'playing',
          deviceId: 'tv-1',
          positionSec: 220,
          durationSec: 4_215,
          canSeek: true,
          seek,
        },
      }),
    );

  it('shows a running total while taps accumulate, and never says Seeking (6h)', () => {
    const vm = withSeek({
      targetSec: 310,
      pendingDeltaSec: 90,
      clamped: null,
      source: 'skip',
      inFlight: false,
    });
    expect(vm.transport?.seekNote).toBe('+1:30');
    // The status line stays on the film, not on the mechanism.
    expect(vm.stateName).toBe('Playing');
    expect(vm.headline).toBe('Playing on Living Room TV');
  });

  it('signs a backward total, so it cannot be read as a position', () => {
    const vm = withSeek({
      targetSec: 130,
      pendingDeltaSec: -90,
      clamped: null,
      source: 'skip',
      inFlight: false,
    });
    expect(vm.transport?.seekNote).toBe('−1:30');
  });

  it('states the real distance moved when the jump hit an end of the film (6i)', () => {
    // "+0:30" beside a playhead that did not move 30 seconds is exactly what the criterion
    // exists to prevent, so the clamp outranks the total.
    expect(
      withSeek({
        targetSec: 0,
        pendingDeltaSec: -30,
        clamped: 'start',
        source: 'skip',
        inFlight: false,
      })?.transport?.seekNote,
    ).toBe('Back to the start');
    expect(
      withSeek({
        targetSec: 4_215,
        pendingDeltaSec: 30,
        clamped: 'end',
        source: 'skip',
        inFlight: false,
      })?.transport?.seekNote,
    ).toBe('That’s the end of the film.');
  });

  it('says nothing at all when the playhead is simply where the device put it', () => {
    expect(withSeek(null).transport?.seekNote).toBeNull();
  });
});

describe('criterion 15b — the source file went away', () => {
  const vanished = view(
    snapshot({
      file: chosenFile,
      discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
      session: { state: 'stopped', deviceId: 'tv-1', resumePositionSec: 1_930 },
      notice: {
        kind: 'source-missing',
        severity: 'warning',
        message: 'The original file is no longer where it was',
        actionLabel: 'Find it again',
      },
    }),
  );

  it('states it plainly, offers the way to fix it, and leaks no path or errno', () => {
    expect(vanished.stateName).toBe('SourceMissing');
    expect(vanished.headline).toBe('The original file is no longer where it was');
    expect(vanished.actions.map((a) => [a.id, a.label])).toEqual([
      ['relocate', 'Find it again'],
      ['pick', 'Choose another video'],
    ]);
    const spoken = `${vanished.headline} ${vanished.sub ?? ''}`;
    expect(spoken).not.toMatch(/ENOENT|C:\\|\/tmp\//);
  });

  it('keeps the place they got to, so finding the file does not cost them the evening', () => {
    expect(vanished.sub).toContain('0:32:10');
  });
});

describe('criterion 17a — a device that never came back for the video', () => {
  const blocked = view(
    snapshot({
      file: chosenFile,
      discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
      session: { state: 'idle', deviceId: 'tv-1' },
      notice: {
        kind: 'firewall-blocked',
        severity: 'error',
        message: 'Windows Firewall is blocking CastGood',
        actionLabel: 'Allow through the firewall',
      },
    }),
  );

  it('names the cause and offers two ways out, one of which needs no admin rights', () => {
    expect(blocked.stateName).toBe('FirewallBlocked');
    expect(blocked.headline).toBe('Windows Firewall is blocking CastGood');
    expect(blocked.sub).toBe(
      'Living Room TV accepted the video but can’t reach this PC to fetch it.',
    );
    expect(blocked.actions.map((a) => [a.id, a.label])).toEqual([
      ['allowFirewall', 'Allow through the firewall'],
      ['cast', 'Try again'],
      ['firewallHelp', 'Show me how to do it myself'],
    ]);
  });

  /**
   * Checklist item 6, 2026-08-19. The elevated command worked, the rules genuinely landed,
   * and the app said *"The rule was added. Press Cast to try again."* — on a screen with no
   * Cast button on it. The founder was told to press a control that did not exist, and the
   * manual route through Windows' own settings ended with the same sentence, so it stranded
   * them too. A "needs you" state with no way out is the one thing this screen exists to
   * prevent, and it had become one.
   */
  it('offers a way forward, because the manual route ends with the founder coming back here', () => {
    const tryAgain = blocked.actions.find((a) => a.id === 'cast');
    expect(tryAgain?.disabledReason).toBeNull();
  });

  it('says why Try again cannot be pressed rather than being a dead button', () => {
    const noFile = view(
      snapshot({
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'idle', deviceId: 'tv-1' },
        notice: {
          kind: 'firewall-blocked',
          severity: 'error',
          message: 'Windows Firewall is blocking CastGood',
          actionLabel: 'Allow through the firewall',
        },
      }),
    );
    expect(noFile.actions.find((a) => a.id === 'cast')?.disabledReason).toBe('No video chosen');
  });

  /**
   * A firewall block can interrupt a *Resume from 0:32:10* as easily as a fresh cast, and
   * `media.not_fetched` keeps the saved position through it on purpose. Offering plain
   * *Cast* here would restart the film at 0:00 **and overwrite the position on the way**,
   * turning "the firewall stopped my film" into "my film started again from the beginning".
   */
  it('offers the way back from where the film was, not from the beginning', () => {
    const interrupted = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'idle', deviceId: 'tv-1', resumePositionSec: 1_930 },
        notice: {
          kind: 'firewall-blocked',
          severity: 'error',
          message: 'Windows Firewall is blocking CastGood',
          actionLabel: 'Allow through the firewall',
        },
      }),
    );
    expect(interrupted.actions.map((a) => [a.id, a.label])).toEqual([
      ['allowFirewall', 'Allow through the firewall'],
      ['resume', 'Try again from 0:32:10'],
      ['firewallHelp', 'Show me how to do it myself'],
    ]);
  });

  it('never leaves this as a bare spinner', () => {
    expect(blocked.tone).toBe('needsYou');
    expect(blocked.hairline).toBe(false);
    expect(blocked.actions.length).toBeGreaterThan(0);
  });
});

describe('QA-17-08 — Stop is the way out of every live state', () => {
  const seeking = view(
    snapshot({
      file: chosenFile,
      discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
      session: {
        state: 'seeking',
        deviceId: 'tv-1',
        positionSec: 1_800,
        durationSec: 4_215,
        canSeek: true,
        seek: {
          targetSec: 1_800,
          pendingDeltaSec: null,
          clamped: null,
          source: 'drag',
          inFlight: true,
        },
      },
    }),
  );

  it('leaves Stop live during a jump, and says why Play/Pause is not', () => {
    // A drag can occupy up to 4.4 s (settle, confirm, retry). The state model requires
    // anything that can outlast 2 s to be escapable, and requires a disabled control to
    // say why — this managed neither: Stop was dead and the reason line was empty.
    expect(seeking.transport?.stopDisabledReason).toBeNull();
    expect(seeking.transport?.controlsDisabled).toBe(true);
    expect(seeking.transport?.disabledReason).toBe('Waiting for the jump to land');
  });

  it('tells the founder to stop rather than to cancel, because there is no Cancel', () => {
    // `seeking` used not to count as "there is a picture on the TV", so the device list
    // offered "Cancel first to choose a different device" for a state that has no Cancel.
    expect(seeking.devices.disabledReason).toBe('Stop playing to cast somewhere else');
  });

  it('does not let an old error notice black out a film that is mid-jump', () => {
    const vm = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'seeking', deviceId: 'tv-1', durationSec: 4_215 },
        notice: {
          kind: 'generic',
          severity: 'error',
          message: 'Something went wrong earlier',
          actionLabel: null,
        },
      }),
    );
    expect(vm.stateName).toBe('Seeking');
  });

  it('still disables Stop when there is no television to let go of', () => {
    const stopped = view(
      snapshot({
        file: chosenFile,
        discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
        session: { state: 'stopped', deviceId: 'tv-1', resumePositionSec: 1_930 },
      }),
    );
    expect(stopped.transport?.stopDisabledReason).toBe('Nothing is playing');
  });
});

describe('somebody else has the television (14a)', () => {
  /**
   * Naming the other app is a **bonus, never a promise** — founder ruling, 2026-08-19.
   *
   * Checklist item 4 measured a real television taking **45.9 s** to name the app a phone
   * had cast to it, against a 15 s grace. So `yieldedToApp: null` is the ordinary case, and
   * the sentence it produces has to stand on its own rather than read as a gap where a name
   * should have been — which "Living Room TV is now playing another app" did.
   */
  const takenOver = (yieldedToApp: string | null) =>
    snapshot({
      file: chosenFile,
      discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
      session: {
        state: 'stopped',
        deviceId: 'tv-1',
        resumePositionSec: 70,
        yieldedToApp,
        flags: { ...EMPTY_SNAPSHOT.session.flags, yielded: true },
      },
    });

  it('states a fact about the television when nobody can name the thief', () => {
    const vm = view(takenOver(null));
    expect(vm.headline).toBe('Living Room TV is playing something else');
    expect(vm.sub).toContain('0:01:10');
    expect(vm.tone).toBe('info');
  });

  it('upgrades the sentence when the device does volunteer a name', () => {
    expect(view(takenOver('YouTube')).headline).toBe('Living Room TV is now playing YouTube');
  });

  it('offers the way back and never blames anyone', () => {
    const vm = view(takenOver(null));
    expect(vm.actions.map((a) => a.label)).toEqual(['Take it back', 'Use a different device']);
    // 14a in as many words: no error styling, no warning icon.
    expect(vm.tone).not.toBe('needsYou');
  });
});

describe('Milestone 3a on screen — the check, the verdicts, and the job', () => {
  const withDevice = { phase: 'found' as const, devices: [livingRoom], selectedDeviceId: 'tv-1' };

  it('says it is looking, and names the file it is looking at (7a)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        check: { name: 'Cars.mkv', headline: 'Checking what this file needs…' },
      }),
    );
    expect(vm.stateName).toBe('Checking');
    expect(vm.headline).toBe('Checking what this file needs…');
    expect(vm.sub).toContain('Cars.mkv');
    // Nothing is sent to a television by looking at a file (7b), and the founder is told so.
    expect(vm.sub).toContain('Nothing is sent');
    // No action of its own: choosing another file is how a check is cancelled, and that
    // button is already on screen in the file panel.
    expect(vm.actions).toEqual([]);
  });

  it('renders the classifier’s own sentence for a wait, never its own (7a)', () => {
    const vm = view(
      snapshot({ discovery: withDevice, file: { ...chosenFile, verdict: verdict() } }),
    );
    expect(vm.stateName).toBe('NeedsRepackaging');
    expect(vm.headline).toBe('Ready in about 50 seconds');
    expect(vm.sub).toBe('Nothing is re-encoded, so the picture and sound are untouched.');
    expect(vm.actions.map((a) => [a.id, a.label])).toEqual([
      ['cast', 'Prepare and cast to Living Room TV'],
    ]);
  });

  it('ends the button in an ellipsis when a further step follows (7f)', () => {
    // One character, and it is the whole visible difference between a press that starts
    // gigabytes of work and one that opens a question first.
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: {
          ...chosenFile,
          verdict: verdict({
            kind: 'convert',
            tier: 3,
            headline: 'Needs converting — about 1 hour 20 minutes',
            requiresConfirmation: true,
            estimateSeconds: 4_800,
          }),
        },
      }),
    );
    expect(vm.stateName).toBe('NeedsConverting');
    expect(vm.actions[0]?.label).toBe('Prepare and cast…');
  });

  it('states the three things the confirmation owes the founder (7f)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: {
          ...chosenFile,
          verdict: verdict({
            kind: 'convert',
            requiresConfirmation: true,
            confirmation: {
              startsWatching: 'Watching can start in about 25 minutes.',
              diskUse: 'It will write about 4.1 GB next to the original file.',
              cancelWarning:
                'If you cancel part-way, it starts again from the beginning next time.',
            },
          }),
        },
      }),
    );
    expect(vm.stateName).toBe('ConfirmPreparation');
    expect(vm.sub).toContain('Watching can start');
    expect(vm.sub).toContain('4.1 GB');
    expect(vm.sub).toContain('starts again');
    // Two ways out, as every "needs you" state must have, and the destructive one is not
    // the default-looking button.
    expect(vm.actions.map((a) => [a.id, a.primary])).toEqual([
      ['confirmPreparation', true],
      ['declinePreparation', false],
    ]);
  });

  it('shows the job, a bar, and a way to stop it (8a, 8d)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: { ...chosenFile, verdict: verdict() },
        preparation: {
          active: true,
          percent: 42.4,
          secondsRemaining: 260,
          frontierSec: 900,
          headline: 'Repackaging Cars.mkv…',
          cancellable: true,
        },
      }),
    );
    expect(vm.stateName).toBe('Preparing');
    expect(vm.headline).toBe('Repackaging Cars.mkv…');
    expect(vm.actions.map((a) => a.id)).toEqual(['cancelPreparation']);
    // The number lives on the panel, not in the `role="status"` live region, so it does not
    // re-announce itself to a screen reader every tick.
    expect(vm.preparation?.percentLabel).toBe('42%');
    expect(vm.preparation?.remainingLabel).toBe('about 4 minutes left');
    // And the taskbar says so, because this is the state a founder leaves the room during.
    expect(vm.documentTitle).toBe('CastGood — Preparing 42%');
  });

  it('shows no estimate until the job has measured itself (8b)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: { ...chosenFile, verdict: verdict() },
        preparation: {
          active: true,
          percent: 2,
          secondsRemaining: null,
          headline: 'Converting Cars.mkv…',
          cancellable: true,
        },
      }),
    );
    // A number invented in the first second would be the flattering one 8b forbids. No
    // estimate is honest; a wrong one is not.
    expect(vm.preparation?.remainingLabel).toBeNull();
  });

  it('names the folder only when the prepared copy is not going beside the film (9e)', () => {
    const beside = view(
      snapshot({
        discovery: withDevice,
        file: { ...chosenFile, verdict: verdict() },
        preparation: { active: true, percent: 10, headline: 'Repackaging Cars.mkv…' },
      }),
    );
    expect(beside.sub).toBe('Nothing goes to the television until this has finished.');

    const elsewhere = view(
      snapshot({
        discovery: withDevice,
        file: { ...chosenFile, verdict: verdict() },
        preparation: {
          active: true,
          percent: 10,
          headline: 'Repackaging Cars.mkv…',
          fallbackDirectory: 'C:\\Users\\Darren\\AppData\\Local\\CastGood\\prepared',
        },
      }),
    );
    // The one path the founder is ever shown, and it is shown because the sentence is
    // useless without it — they have to be able to go and find the file.
    expect(elsewhere.sub).toContain('CastGood\\prepared');
  });

  it('says why there is no wait, rather than leaving the founder guessing (7c)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: {
          ...chosenFile,
          verdict: verdict({
            kind: 'ready',
            tier: 1,
            headline: 'Ready to cast',
            reason: 'It was prepared last time, so there is nothing to wait for.',
            estimateSeconds: 0,
          }),
        },
      }),
    );
    expect(vm.stateName).toBe('Ready');
    expect(vm.sub).toBe('It was prepared last time, so there is nothing to wait for.');
  });

  it('refuses a file at the check, with one sentence and a way out (7d)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: {
          ...chosenFile,
          verdict: verdict({
            kind: 'impossible',
            tier: null,
            headline: "This file can't be cast",
            reason: 'There’s no video in this file.',
            estimateSeconds: null,
          }),
        },
      }),
    );
    expect(vm.stateName).toBe('Impossible');
    expect(vm.headline).toBe("This file can't be cast");
    expect(vm.sub).toBe('There’s no video in this file.');
    expect(vm.actions.map((a) => a.id)).toEqual(['pick']);
  });

  it('carries 8e’s sentence on the file, where it survives every state on the way', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: {
          ...chosenFile,
          verdict: verdict({
            subtitleNotice:
              'One subtitle track (English) is pictures rather than text, so it can’t be carried into the prepared copy.',
          }),
        },
      }),
    );
    expect(vm.file?.subtitleNotice).toContain('pictures rather than text');
    // And no codec name anywhere near it (7a).
    expect(vm.file?.subtitleNotice).not.toMatch(/pgs|vobsub|dvd_subtitle/i);
  });

  it('never puts a codec, a level or a path in front of the founder (7a)', () => {
    const vm = view(
      snapshot({
        discovery: withDevice,
        file: { ...chosenFile, verdict: verdict() },
      }),
    );
    const words = [vm.headline, vm.sub ?? '', ...vm.actions.map((a) => a.label)].join(' ');
    for (const forbidden of ['h264', 'aac', 'matroska', 'ffmpeg', 'C:/videos']) {
      expect(words.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });
});

/**
 * **Criterion 13g's founder-visible half**: a film that died at 0.232 s must never be
 * dressed as one that finished.
 *
 * The trap is specific and it is in `stoppedStatus`: a film stopped in its opening second
 * has nothing worth resuming to, so that screen drops *Resume from 0:00:00* and offers
 * **Play again** as its primary — the exact words the criterion forbids, arrived at by a
 * rule that is perfectly reasonable for the case it was written for. What keeps the two
 * apart is the engine's own sentence about the failure, and this pins that it is enough.
 */
describe('criterion 13g — a film that died is not offered as one that finished', () => {
  const diedAtStart = snapshot({
    file: chosenFile,
    discovery: { phase: 'found', devices: [livingRoom], selectedDeviceId: 'tv-1' },
    // What the reducer leaves behind after `IDLE`/`ERROR` 81 ms in: `stopped`, with the
    // position it never got past, and the engine's sentence about what happened.
    session: { state: 'stopped', deviceId: 'tv-1', durationSec: 6_780, resumePositionSec: 0.232 },
    notice: {
      kind: 'generic',
      severity: 'error',
      message: 'The TV stopped playing this file',
      actionLabel: 'Try again',
    },
  });

  it('says the television stopped playing it, and never *Finished*', () => {
    const vm = view(diedAtStart);
    expect(vm.stateName).toBe('Failed');
    expect(vm.headline).toBe('The TV stopped playing this file');
    expect(vm.stateName).not.toBe('Finished');
  });

  it('offers *Try again*, never *Play again*', () => {
    // *Play again* is a promise that there was a first time. There was not: the television
    // showed one frame of a 113-minute film and quit.
    const labels = view(diedAtStart).actions.map((action) => action.label);
    expect(labels).toEqual(['Try again', 'Choose a different video']);
    expect(labels).not.toContain('Play again');
  });

  it('is exactly the screen a plain Stop is not — same state, different sentence', () => {
    // The contrast that shows the failure notice is load-bearing rather than decorative.
    // Strip it and the identical session reads as a clean exit the founder chose, with
    // *Play again* on it, which is what the app did before this criterion.
    const stoppedCleanly = { ...diedAtStart, notice: null };
    const vm = view(stoppedCleanly);
    expect(vm.stateName).toBe('Stopped');
    expect(vm.actions.map((action) => action.label)).toContain('Play again');
  });
});

/**
 * Milestone 3b on screen — you don't wait.
 *
 * A Tier 3 film can now start playing while it is still being converted, and these are the
 * three things that changes for the founder: they are told **when watching starts** while
 * the conversion runs (10a), the scrubber says which part of the film does not exist yet
 * and how far ahead a jump may go (10d), and when the converter falls behind, the picture
 * is **held with a sentence** rather than freezing (10i, 10f).
 *
 * All of it is pure view logic. **None of it is evidence that a television did anything** —
 * these prove the words, the enabled controls and the arithmetic of the track, and nothing
 * beyond a person watching a real film on a real TV can prove the rest.
 */
describe('Milestone 3b — watching before the conversion finishes', () => {
  const withDevice = { devices: [livingRoom], selectedDeviceId: livingRoom.id };
  /** A two-hour film, so "when the job ends" and "when watching starts" are far apart. */
  const film: StateSnapshot['file'] = {
    path: 'C:/videos/Dune.mkv',
    name: 'Dune.mkv',
    durationSec: 6_990,
    verdict: null,
  };

  function converting(overrides: Partial<StateSnapshot['preparation']> = {}) {
    return {
      active: true,
      percent: 12,
      secondsRemaining: 1_500,
      frontierSec: 900,
      headline: 'Converting Dune.mkv…',
      cancellable: true,
      watchableInSeconds: 240,
      ...overrides,
    };
  }

  /** A film on the television, from a conversion that is still running. */
  function watching(
    headStart: Partial<NonNullable<StateSnapshot['headStart']>>,
    session: Partial<StateSnapshot['session']> = {},
  ) {
    return snapshot({
      discovery: withDevice,
      file: film,
      preparation: converting(),
      headStart,
      session: {
        state: 'playing',
        deviceId: livingRoom.id,
        positionSec: 1_500,
        durationSec: 6_990,
        canSeek: true,
        ...session,
      },
    });
  }

  describe('criterion 10a — the app says beforehand when watching starts', () => {
    it('says when the film starts, not only when the job ends', () => {
      const vm = view(snapshot({ discovery: withDevice, file: film, preparation: converting() }));
      expect(vm.stateName).toBe('Preparing');
      // The two numbers are different questions and both are answered: the headline and
      // the bar are about the job, this sentence is about the film.
      expect(vm.sub).toBe(
        'Watching starts in about 4 minutes — the rest converts while you watch.',
      );
      expect(vm.preparation?.remainingLabel).toBe('about 25 minutes left');
      // Never "starting soon…": the estimate is a number in words, coarse and specific.
      expect(vm.sub).not.toContain('soon');
    });

    it('keeps saying it as the estimate falls, and keeps it coarse', () => {
      const ladder: [number, string][] = [
        [4, 'Watching starts in a few seconds — the rest converts while you watch.'],
        [22, 'Watching starts in about 20 seconds — the rest converts while you watch.'],
        [75, 'Watching starts in about a minute — the rest converts while you watch.'],
        [600, 'Watching starts in about 10 minutes — the rest converts while you watch.'],
        [4_500, 'Watching starts in about 1 hour 15 minutes — the rest converts while you watch.'],
      ];
      for (const [seconds, sentence] of ladder) {
        const vm = view(
          snapshot({
            discovery: withDevice,
            file: film,
            preparation: converting({ watchableInSeconds: seconds }),
          }),
        );
        expect(vm.sub).toBe(sentence);
        // Estimates are words, never a clock: `4:37 remaining` is the thing §3.5 forbids.
        expect(vm.sub).not.toMatch(/\d:\d\d/);
      }
    });

    it('says nothing at all when there is no head start to promise', () => {
      // A repackage or a film shorter than the head start: nothing is going early, so M3a's
      // sentence is the true one. `estimatingWait` is what keeps this case apart from a
      // young conversion — only `forecastGate` sets it, and a repackage is never asked.
      const vm = view(
        snapshot({
          discovery: withDevice,
          file: film,
          preparation: converting({ watchableInSeconds: null, estimatingWait: false }),
        }),
      );
      expect(vm.sub).toBe('Nothing goes to the television until this has finished.');
    });

    it('says it is still working the wait out, rather than a sentence that is false', () => {
      // **The first minute of every conversion, and it used to lie.** With no sustained
      // speed yet the screen fell through to "Nothing goes to the television until this has
      // finished" — said over a film that was about to start early, which is the opposite of
      // what happens. The founder chose this wording on 2026-08-26, asked as a product
      // question: say it is still working it out rather than show a number we might take
      // back. See `forecastGate` for the 23-seconds-for-a-202-second-wait run behind it.
      const vm = view(
        snapshot({
          discovery: withDevice,
          file: film,
          preparation: converting({ watchableInSeconds: null, estimatingWait: true }),
        }),
      );
      expect(vm.sub).toBe('Still working out how long.');
      // It is a statement about not knowing yet, not a countdown: no number, no clock.
      expect(vm.sub).not.toMatch(/\d/);
      // And it is still cancellable — the wait being unknown is not a reason to trap anyone.
      expect(vm.actions.map((a) => a.id)).toContain('cancelPreparation');
    });

    it('still names the folder the prepared copy is going to (9e), without losing 10a', () => {
      const vm = view(
        snapshot({
          discovery: withDevice,
          file: film,
          preparation: converting({
            fallbackDirectory: 'C:\\Users\\Darren\\AppData\\Local\\CastGood\\prepared',
          }),
        }),
      );
      expect(vm.sub).toContain('Watching starts in about 4 minutes');
      expect(vm.sub).toContain('CastGood\\prepared');
    });
  });

  describe('criterion 10i — the guard holds the picture, and says so', () => {
    // The engine sends one nullable object: **its presence is the hold**, and it always
    // carries the sentence — there is no combination that says "holding, with nothing to
    // show for it", which is what the flat booleans used to allow.
    const holding = {
      hold: {
        message: 'Still preparing — back in about 40 seconds',
        waitingForCompletion: false,
      },
      frontierSec: 1_560,
      seekLimitSec: 1_440,
    };

    it('renders the engine’s sentence verbatim, and never the word Buffering', () => {
      const vm = view(watching(holding, { state: 'paused' }));
      expect(vm.stateName).toBe('FrontierHold');
      expect(vm.headline).toBe('Still preparing — back in about 40 seconds');
      // 11e turns a *Buffering* over 10 s into a reconnection attempt, and a hold is
      // routinely longer than that. The word must not appear anywhere on the screen.
      const words = [vm.headline, vm.sub ?? '', ...vm.actions.map((a) => a.label)].join(' ');
      expect(words.toLowerCase()).not.toContain('buffer');
      // Not "Paused" either: the founder pressed nothing, and crediting them with a press
      // they never made is how a protection reads as a fault.
      expect(vm.headline).not.toContain('Paused');
    });

    it('restates the wait as it changes rather than freezing on the first estimate', () => {
      const first = view(watching(holding, { state: 'paused' }));
      const later = view(
        watching(
          {
            ...holding,
            hold: { ...holding.hold, message: 'Still preparing — back in about 15 seconds' },
          },
          { state: 'paused' },
        ),
      );
      expect(first.headline).not.toBe(later.headline);
      expect(later.headline).toBe('Still preparing — back in about 15 seconds');
    });

    it('holds the position readout exactly where it was', () => {
      const vm = view(watching(holding, { state: 'paused', positionSec: 1_500 }));
      expect(vm.transport?.positionLabel).toBe('0:25:00');
      expect(vm.transport?.positionSec).toBe(1_500);
      // And the sentence beside it states that number, which §4 asks of every wait.
      expect(vm.sub).toContain('0:25:00');
    });

    it('leaves Stop live and adds no button of its own', () => {
      const vm = view(watching(holding, { state: 'paused' }));
      // M3b cut 2: no new control. The film comes back by itself.
      expect(vm.actions).toEqual([]);
      expect(vm.transport?.stopDisabledReason).toBeNull();
      // Play would be the founder overruling a guard they cannot see, straight into the
      // part of the film that does not exist yet. It says why rather than going quiet.
      expect(vm.transport?.controlsDisabled).toBe(true);
      expect(vm.transport?.disabledReason).toBe('It starts again by itself');
    });

    it('keeps Back 30s live — it is the real escape — and refuses Forward 30s', () => {
      const vm = view(watching(holding, { state: 'paused' }));
      const skips = Object.fromEntries(
        (vm.transport?.skips ?? []).map((skip) => [skip.id, skip.disabledReason]),
      );
      expect(skips.skipBack).toBeNull();
      expect(skips.skipForward).toBe('Still preparing');
      expect(vm.transport?.skips.every((skip) => !skip.hidden)).toBe(true);
    });

    it('goes back to Playing by itself when the guard releases — no error, nothing pressed', () => {
      const released = view(watching({ hold: null, frontierSec: 1_800 }, { state: 'playing' }));
      expect(released.stateName).toBe('Playing');
      expect(released.headline).toBe('Playing on Living Room TV');
      expect(released.tone).toBe('info');
      expect(released.actions).toEqual([]);
      expect(released.transport?.controlsDisabled).toBe(false);
    });

    it('lets a lost connection outrank the hold — a film nobody can reach is not being held', () => {
      const vm = view(
        watching(holding, {
          state: 'playing',
          flags: {
            reconnecting: true,
            reattaching: false,
            yielded: false,
            networkDown: false,
          },
        }),
      );
      expect(vm.stateName).toBe('Reconnecting');
    });
  });

  describe('criterion 10f — the conversion that cannot catch up', () => {
    const stranded = {
      hold: {
        waitingForCompletion: true,
        message:
          'Still preparing — this film will play when the conversion is done, in about 12 minutes',
      },
      frontierSec: 1_560,
      seekLimitSec: 1_440,
    };

    it('says plainly that the film plays when the job is done, with a live estimate', () => {
      const vm = view(watching(stranded, { state: 'paused' }));
      expect(vm.stateName).toBe('WaitingForConversion');
      expect(vm.headline).toBe(stranded.hold.message);
      // Never an indefinite "starting soon…" — the criterion names that phrase as the
      // failure, and the estimate is in the sentence the engine sent.
      expect(vm.headline).toContain('about 12 minutes');
      expect(vm.headline.toLowerCase()).not.toContain('soon');
    });

    it('keeps the place, keeps Stop live, and offers no third loading path', () => {
      const vm = view(watching(stranded, { state: 'paused', positionSec: 1_500 }));
      expect(vm.sub).toBe(
        'Your place is held at 0:25:00. Stop keeps it, and Resume picks it up from there.',
      );
      expect(vm.transport?.stopDisabledReason).toBeNull();
      // The way out is the two presses M2 already built, so this screen adds nothing.
      expect(vm.actions).toEqual([]);
    });
  });

  describe('criterion 10d — the scrubber tells the truth about what exists', () => {
    it('draws the unconverted part as unavailable, against the film’s true length', () => {
      const vm = view(watching({ frontierSec: 1_800, seekLimitSec: 1_680 }));
      // 1800 of 6990 seconds prepared; the limit is two minutes behind that.
      expect(vm.transport?.frontierPercent).toBeCloseTo((1_800 / 6_990) * 100, 6);
      expect(vm.transport?.limitPercent).toBeCloseTo((1_680 / 6_990) * 100, 6);
      expect(vm.transport?.seekLimitSec).toBe(1_680);
    });

    it('says how far ahead a jump can go, permanently, while the region exists', () => {
      const vm = view(watching({ frontierSec: 1_800, seekLimitSec: 1_680 }));
      expect(vm.transport?.frontierNote).toBe(
        'You can jump ahead to 0:28:00 for now — the rest is still converting. This moves as it goes.',
      );
    });

    it('sharpens that line when a jump actually ran into the limit', () => {
      const vm = view(
        watching(
          { frontierSec: 1_800, seekLimitSec: 1_680 },
          {
            state: 'seeking',
            seek: {
              targetSec: 1_680,
              pendingDeltaSec: 30,
              clamped: 'frontier',
              source: 'skip',
              inFlight: false,
            },
          },
        ),
      );
      expect(vm.transport?.frontierNote).toBe(
        'That part isn’t ready yet — it went as far as 0:28:00. The limit moves as it goes.',
      );
      // 6i: no `+0:30` beside a playhead that moved a shorter distance. The line under the
      // scrubber is the explanation; the chip stays silent rather than lying.
      expect(vm.transport?.seekNote).toBeNull();
      // And it is not an error — the state region carries no failure tone.
      expect(vm.tone).not.toBe('needsYou');
    });

    it('never limits a jump past the end of the film once the conversion has finished', () => {
      const vm = view(
        watching({ frontierSec: 6_990, seekLimitSec: 6_870, conversionComplete: true }),
      );
      // 10g: the television is still reading our segments, but nothing is missing any
      // more, so nothing is drawn as missing and there is no line to read.
      expect(vm.transport?.frontierPercent).toBeNull();
      expect(vm.transport?.limitPercent).toBeNull();
      expect(vm.transport?.seekLimitSec).toBeNull();
      expect(vm.transport?.frontierNote).toBeNull();
    });

    it('renders the engine’s limit rather than working out a second one', () => {
      // `frontier − 2 min` can exceed the film's own length in the last minutes of a job,
      // and the engine caps it there — the same minimum its own seek clamp takes. The
      // screen renders that number. Two places computing one limit is two places to
      // disagree, and the one the founder's drag is measured against is the engine's.
      const vm = view(watching({ frontierSec: 6_990, seekLimitSec: 6_870 }));
      expect(vm.transport?.seekLimitSec).toBe(6_870);
      expect(vm.transport?.frontierNote).toContain('1:54:30');
      const late = view(watching({ frontierSec: 7_110, seekLimitSec: 6_990 }));
      expect(late.transport?.seekLimitSec).toBe(6_990);
      expect(late.transport?.limitPercent).toBe(100);
    });

    it('leaves seeking inside the prepared part exactly as story 6 left it', () => {
      const vm = view(
        watching(
          { frontierSec: 1_800, seekLimitSec: 1_680 },
          {
            state: 'seeking',
            seek: {
              targetSec: 900,
              pendingDeltaSec: 60,
              clamped: null,
              source: 'skip',
              inFlight: false,
            },
          },
        ),
      );
      expect(vm.transport?.canDrag).toBe(true);
      expect(vm.transport?.seekNote).toBe('+1:00');
      expect(vm.transport?.skips.map((skip) => skip.disabledReason)).toEqual([null, null]);
    });
  });

  describe('criterion 10c — the duration is ours, never the device’s', () => {
    it('falls back to our own probe when the device reports nothing usable', () => {
      // Both the Ultra and the `AI PONT` report `-1` for the whole session, which reaches
      // the renderer as a session duration of 0. The film's length is still known.
      const vm = view(
        watching({ frontierSec: 1_800, seekLimitSec: 1_680 }, { durationSec: 0, positionSec: 600 }),
      );
      expect(vm.transport?.durationSec).toBe(6_990);
      expect(vm.transport?.durationLabel).toBe('1:56:30');
      // And everything drawn on the track is drawn against that number, not the frontier —
      // a scrubber that ended at the frontier would make a two-hour film look ten minutes
      // long and grow as it played.
      expect(vm.transport?.percent).toBeCloseTo((600 / 6_990) * 100, 6);
      expect(vm.transport?.frontierPercent).toBeCloseTo((1_800 / 6_990) * 100, 6);
    });
  });

  describe('M3b cut 3 — no second progress bar in front of a film', () => {
    it('drops the conversion bar once the television has the film', () => {
      const vm = view(watching({ frontierSec: 1_800, seekLimitSec: 1_680 }));
      expect(vm.stateName).toBe('Playing');
      // The job is still running — the picker still says so — but the founder watching a
      // film needs one number when the picture is held, not a live view of the encoder.
      expect(vm.preparation).toBeNull();
      expect(vm.documentTitle).toBe('CastGood');
      expect(vm.pick.disabledReason).toBe('Choosing another file would cancel this');
    });

    it('keeps the bar while the founder is still waiting in front of it', () => {
      const vm = view(snapshot({ discovery: withDevice, file: film, preparation: converting() }));
      expect(vm.preparation?.percentLabel).toBe('12%');
      expect(vm.documentTitle).toBe('CastGood — Preparing 12%');
    });
  });
});

/**
 * The handle clamp — criterion 10d's *"dragging into it is refused"*, as arithmetic.
 *
 * This is the one piece of M3b that used to live inside the scrubber component, where the
 * project's headless suite could not reach it. It decides where the handle and the played
 * fill are drawn and what a screen reader is told, on every frame of a drag.
 */
describe('criterion 10d — where the handle goes while the founder drags', () => {
  const film = {
    percent: 20,
    durationSec: 6_990,
    positionLabel: '0:23:18',
    durationLabel: '1:56:30',
  };

  it('leaves the handle free when the whole film exists', () => {
    const readout = scrubberReadout({
      ...film,
      dragPercent: 92,
      limitPercent: null,
      seekLimitSec: null,
    });
    expect(readout.handlePercent).toBe(92);
    expect(readout.pinnedToLimit).toBe(false);
    // Every M3a session and every finished conversion: no limit, so nothing is said about
    // one. An empty clause on every film would be noise in every readout.
    expect(readout.valueText).toBe('1:47:10 of 1:56:30');
  });

  it('pins a drag into the unconverted part at the limit, and no further', () => {
    const readout = scrubberReadout({
      ...film,
      dragPercent: 92,
      limitPercent: 24,
      seekLimitSec: 1_680,
    });
    expect(readout.handlePercent).toBe(24);
    expect(readout.pinnedToLimit).toBe(true);
    // The handle is showing the founder where this will land before they let go, so the
    // readout names that place rather than the one they pointed at.
    expect(readout.valueText).toBe('0:27:57 of 1:56:30. Converted up to 0:28:00');
  });

  it('leaves a drag inside the prepared part completely alone', () => {
    const readout = scrubberReadout({
      ...film,
      dragPercent: 12,
      limitPercent: 24,
      seekLimitSec: 1_680,
    });
    expect(readout.handlePercent).toBe(12);
    expect(readout.pinnedToLimit).toBe(false);
  });

  it('releases the handle as the limit travels to the right', () => {
    // The same gesture, twice, either side of one minute of conversion. That the limit
    // *moves* is what turns it from a fault into a mechanism, so it must actually move.
    const early = scrubberReadout({
      ...film,
      dragPercent: 28,
      limitPercent: 24,
      seekLimitSec: 1_680,
    });
    const later = scrubberReadout({
      ...film,
      dragPercent: 28,
      limitPercent: 30,
      seekLimitSec: 2_100,
    });
    expect(early.handlePercent).toBe(24);
    expect(later.handlePercent).toBe(28);
    expect(later.pinnedToLimit).toBe(false);
  });

  it('never claws the handle back from where the film actually is', () => {
    // A guard hold puts the playhead **past** the limit by definition — the margin fell
    // under two minutes, which is exactly what `frontier − 2 min` subtracts. Clamping a
    // resting handle would drag it and the played fill backwards to the tick, and a film
    // that appears to have jumped back is a worse lie than the one being prevented.
    const readout = scrubberReadout({
      ...film,
      percent: 26,
      dragPercent: null,
      limitPercent: 24,
      seekLimitSec: 1_680,
    });
    expect(readout.handlePercent).toBe(26);
    expect(readout.pinnedToLimit).toBe(false);
    // And at rest the readout is the snapshot's own position, not one derived from a
    // percentage — the engine's number is the one the founder is owed.
    expect(readout.valueText).toBe('0:23:18 of 1:56:30. Converted up to 0:28:00');
  });

  it('names the limit exactly when there is one, and never otherwise', () => {
    const withLimit = scrubberReadout({
      ...film,
      dragPercent: null,
      limitPercent: 24,
      seekLimitSec: 1_680,
    });
    const without = scrubberReadout({
      ...film,
      dragPercent: null,
      limitPercent: null,
      seekLimitSec: null,
    });
    expect(withLimit.valueText).toContain('. Converted up to 0:28:00');
    expect(without.valueText).not.toContain('Converted up to');
    expect(without.valueText).toBe('0:23:18 of 1:56:30');
  });

  it('sends the founder’s real target on release, and reads back what the engine allowed', () => {
    // **The handle clamps; the value does not.** The release tells the engine where the
    // founder actually pointed, the engine refuses anything past the limit and reports it
    // (`test/engine/m3b-criteria.test.ts` asserts that refusal: 3000 s requested, 580 s
    // allowed, playback continuing) — and *this* is what the founder is then told. Two
    // places clamping to two numbers is how a scrubber and a device end up disagreeing.
    const vm = view(
      snapshot({
        discovery: { devices: [livingRoom], selectedDeviceId: livingRoom.id },
        file: { path: 'C:/videos/Dune.mkv', name: 'Dune.mkv', durationSec: 6_990, verdict: null },
        preparation: { active: true, percent: 12, headline: 'Converting Dune.mkv…' },
        headStart: { frontierSec: 1_800, seekLimitSec: 1_680 },
        session: {
          state: 'seeking',
          deviceId: livingRoom.id,
          positionSec: 1_680,
          durationSec: 6_990,
          canSeek: true,
          seek: {
            targetSec: 1_680,
            pendingDeltaSec: null,
            clamped: 'frontier',
            source: 'drag',
            inFlight: true,
          },
        },
      }),
    );
    // The readout holds the position the engine allowed — never the one that was refused.
    expect(vm.transport?.positionLabel).toBe('0:28:00');
    expect(vm.transport?.frontierNote).toContain('it went as far as 0:28:00');
    // The film did not stop: the way out of a jump is still live, and this is not a fault.
    expect(vm.transport?.stopDisabledReason).toBeNull();
    expect(vm.tone).not.toBe('needsYou');
    // And the handle sits on the tick rather than out in film that does not exist.
    const readout = scrubberReadout({
      percent: vm.transport?.percent ?? 0,
      dragPercent: 92,
      durationSec: vm.transport?.durationSec ?? 0,
      positionLabel: vm.transport?.positionLabel ?? '',
      durationLabel: vm.transport?.durationLabel ?? '',
      limitPercent: vm.transport?.limitPercent ?? null,
      seekLimitSec: vm.transport?.seekLimitSec ?? null,
    });
    expect(readout.handlePercent).toBeCloseTo((1_680 / 6_990) * 100, 6);
    expect(readout.pinnedToLimit).toBe(true);
  });
});

/**
 * The closing question, on screen rather than in a box (founder's ruling, 2026-08-30:
 * *"make it in-window, no modals"*).
 *
 * These prove the presentation rules only. Whether the app actually closes is the main
 * process's job and cannot be tested here — or anywhere headless, since the selftest never
 * starts Electron.
 */
describe('the closing question as a surface', () => {
  const QUESTION = {
    id: 'q1',
    kind: 'playing',
    headline: 'Leave the film playing on the TV?',
    detail: 'CastGood is what sends the video.',
    answers: ['Leave it playing', 'Stop it and close'],
    safeIndex: 0,
  } as const;

  it('says the host’s words and offers exactly its two answers', () => {
    const vm = buildViewModel(EMPTY_SNAPSHOT, IDLE_PICKER, undefined, QUESTION);
    expect(vm.headline).toBe(QUESTION.headline);
    expect(vm.sub).toBe(QUESTION.detail);
    expect(vm.actions.map((a) => a.label)).toEqual([...QUESTION.answers]);
    expect(vm.questionPending).toBe(true);
  });

  it('is not styled as a failure', () => {
    // Nothing has gone wrong: the founder pressed a button and is being asked what they
    // meant by it. The 2026-08-30 ruling reserves the error treatment for real failures,
    // and a question that colours itself like a fault is exactly what that forbids.
    const vm = buildViewModel(EMPTY_SNAPSHOT, IDLE_PICKER, undefined, QUESTION);
    expect(vm.tone).not.toBe('needsYou');
    // Nothing is in progress either — the app is waiting on a person, not on itself.
    expect(vm.hairline).toBe(false);
  });

  it('makes the safe answer the primary one, for all three questions', () => {
    // Index 0 is the safe answer everywhere — the contract `safeChoiceFor` enforces and
    // the old dialog encoded as `defaultId: 0` / `cancelId: 0`.
    for (const kind of ['playing', 'preparing', 'head-start']) {
      const vm = buildViewModel(EMPTY_SNAPSHOT, IDLE_PICKER, undefined, { ...QUESTION, kind });
      expect(vm.actions[0]?.primary, kind).toBe(true);
      expect(vm.actions[0]?.id, kind).toBe('quitAnswerSafe');
      expect(vm.actions[1]?.primary, kind).toBe(false);
      expect(
        vm.actions.every((a) => a.disabledReason === null),
        kind,
      ).toBe(true);
    }
  });

  it('outranks a notice, which would otherwise answer the question for the founder', () => {
    const withNotice = {
      ...EMPTY_SNAPSHOT,
      notice: {
        kind: 'generic' as const,
        severity: 'info' as const,
        message: 'Living Room TV is now playing YouTube',
        actionLabel: null,
      },
    };
    const vm = buildViewModel(withNotice, IDLE_PICKER, undefined, QUESTION);
    expect(vm.sub).toBe(QUESTION.detail);
  });

  it('leaves the screen exactly as it was when there is no question', () => {
    const withQuestion = buildViewModel(EMPTY_SNAPSHOT, IDLE_PICKER, undefined, null);
    const without = buildViewModel(EMPTY_SNAPSHOT, IDLE_PICKER);
    expect(withQuestion).toEqual(without);
    expect(without.questionPending).toBe(false);
  });

  /**
   * **The founder, 2026-09-03, driving the real app**: *"the stop button does not work
   * during this period of time"*, and *"trying to change the film prompts to select a file,
   * but after selecting the file, nothing happens."*
   *
   * The window being inert was the 2026-08-30 decision working as designed. **Being
   * silently inert was not.** `main` dropped the intents and said nothing, so every control
   * looked live and did nothing — and the file picker was worse than dead, because it opened
   * a Windows dialog, took a real decision and discarded it.
   */
  describe('while the question is up, the rest of the window is visibly inert', () => {
    const playing = {
      ...EMPTY_SNAPSHOT,
      file: chosenFile,
      discovery: {
        phase: 'found' as const,
        devices: [livingRoom, kitchen],
        selectedDeviceId: 'tv-1',
      },
      session: {
        ...EMPTY_SNAPSHOT.session,
        state: 'playing' as const,
        deviceId: 'tv-1',
        positionSec: 100,
        durationSec: 4_215,
        canSeek: true,
      },
    };

    const asked = () => buildViewModel(playing, IDLE_PICKER, undefined, QUESTION);
    const REASON = 'Answer the question above first';

    it('says why Stop cannot be pressed instead of ignoring the press', () => {
      // `stopDisabledReason` is its own field precisely because Stop is normally always
      // available. This is the one time it is not, and it has to say so.
      const vm = asked();
      expect(vm.transport?.stopDisabledReason).toBe(REASON);
      expect(vm.transport?.controlsDisabled).toBe(true);
      expect(vm.transport?.disabledReason).toBe(REASON);
      expect(vm.transport?.canDrag).toBe(false);
      expect(vm.transport?.skips.every((s) => s.disabledReason === REASON)).toBe(true);
    });

    it('greys the file picker rather than opening a dialog it will ignore', () => {
      expect(asked().pick.disabledReason).toBe(REASON);
    });

    it('locks the device list and the rescan', () => {
      const vm = asked();
      expect(vm.devices.disabledReason).toBe(REASON);
      expect(vm.devices.rows.every((r) => r.disabled)).toBe(true);
      expect(vm.devices.canRescan).toBe(false);
    });

    it('locks the subtitle control, including the timing nudges', () => {
      const vm = asked();
      expect(vm.subtitles?.chooseDisabledReason).toBe(REASON);
      expect(vm.subtitles?.canRetry).toBe(false);
    });

    it('still lets the question itself be answered', () => {
      // The one thing that must stay live. An inert window that swallowed its own answer
      // would be the trap this whole design exists to avoid.
      expect(asked().actions.every((a) => a.disabledReason === null)).toBe(true);
    });

    it('changes nothing at all when no question is up', () => {
      const vm = buildViewModel(playing, IDLE_PICKER, undefined, null);
      expect(vm.transport?.stopDisabledReason).not.toBe(REASON);
      expect(vm.pick.disabledReason).not.toBe(REASON);
      // A live session already locks the device list for its own reason (one device at a
      // time). The point here is that the reason is **that one**, not the question's.
      expect(vm.devices.disabledReason).toBe('Stop playing to cast somewhere else');
    });
  });
});
