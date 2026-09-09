import { describe, expect, it } from 'vitest';
import { buildViewModel } from '../../src/renderer/state/view-model.js';
import { EMPTY_SNAPSHOT, type StateSnapshot } from '../../src/engine/protocol/index.js';
import type { SessionState } from '../../src/engine/types.js';

/**
 * Story 25, criterion 25a — **the control is present in every state, including the broken ones.**
 *
 * ⚠️ Those are the only states anybody will ever press it in. A diagnostic that needs a
 * working app is a diagnostic that is absent exactly when it is wanted, so this enumerates
 * the state union rather than spot-checking a few: a state added later is caught by the
 * type, not by somebody remembering to extend a list.
 */

const IDLE_PICKER = { available: true, busy: false, error: null };

const ALL_STATES: readonly SessionState[] = [
  'idle',
  'connecting',
  'loading',
  'buffering',
  'playing',
  'paused',
  'seeking',
  'ended',
  'stopped',
];

/** Every way the session can be broken on top of a state. */
const FLAG_SETS = [
  { reconnecting: false, reattaching: false, yielded: false, networkDown: false },
  { reconnecting: true, reattaching: false, yielded: false, networkDown: false },
  { reconnecting: false, reattaching: false, yielded: true, networkDown: false },
  { reconnecting: false, reattaching: false, yielded: false, networkDown: true },
] as const;

function snapshotIn(state: SessionState, flags: (typeof FLAG_SETS)[number]): StateSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    session: { ...EMPTY_SNAPSHOT.session, state, flags },
  };
}

describe('the report control is there when everything else is not (25a)', () => {
  it('is present in every session state', () => {
    for (const state of ALL_STATES) {
      const vm = buildViewModel(snapshotIn(state, FLAG_SETS[0]), IDLE_PICKER);
      expect(vm.diagnostics.label, `missing in ${state}`).toBeTruthy();
    }
  });

  it('is present with every failure flag raised — reconnecting, yielded, PC offline', () => {
    for (const flags of FLAG_SETS) {
      for (const state of ALL_STATES) {
        const vm = buildViewModel(snapshotIn(state, flags), IDLE_PICKER);
        const which = `${state} ${JSON.stringify(flags)}`;
        expect(vm.diagnostics.label, `missing in ${which}`).toBeTruthy();
      }
    }
  });

  it('is present while a modal question is open, when everything else goes inert', () => {
    // Every other control is deliberately made inert while a question is pending. This one
    // is not: a person stuck on a question they do not understand is exactly who needs it.
    const vm = buildViewModel(snapshotIn('playing', FLAG_SETS[0]), IDLE_PICKER, undefined, {
      id: 'quit-mid-job',
      kind: 'quit',
      headline: 'Still converting',
      detail: 'A conversion is running.',
      answers: ['Quit anyway', 'Keep going'],
      safeIndex: 1,
    });

    expect(vm.questionPending).toBe(true);
    expect(vm.diagnostics.label).toBeTruthy();
  });

  it('says what it removes and that nothing is sent, before it is pressed (25i)', () => {
    const vm = buildViewModel(snapshotIn('idle', FLAG_SETS[0]), IDLE_PICKER);
    // Silence here would be the app deciding something private on somebody's behalf.
    expect(vm.diagnostics.note).toMatch(/replaced/i);
    expect(vm.diagnostics.note).toMatch(/never sends/i);
  });
});
