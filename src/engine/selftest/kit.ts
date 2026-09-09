/**
 * The selftest's grading vocabulary, in one dependency-free file.
 *
 * It was inside `index.ts` until M3a needed a second scenario module. Extracting it is not
 * tidying: a `m3.ts` that imported these from `index.ts` while `index.ts` imported its
 * scenarios back would be a **circular module graph inside the one tool that decides whether
 * this product works**, and the failure mode of a temporal-dead-zone bug there is a harness
 * that throws before it can report anything. This file imports nothing, so it cannot take
 * part in a cycle.
 *
 * Nothing about the rules changed. `promise` still gates the exit code and `observation`
 * still cannot fail, for the reason written on `AssertionKind`.
 *
 * The one import is a **type**, which is erased before anything runs — so the claim above
 * is still true of the module graph.
 */

import type { SessionState } from '../types.js';

/**
 * Is there a session holding a television right now?
 *
 * Three states mean there is not, and all three matter. *Idle* is the first scenario of a
 * run. *Stopped* is every scenario after one that stopped. And **`ended`** is a film that
 * played out: the device went back to its own home screen and nothing has been sent to it
 * since.
 *
 * It lived in `index.ts`, which meant the M3 scenarios could not use it and each of them
 * spelled the question out by hand as `state === 'stopped' || state === 'idle'` — eight
 * times, and all eight missing `ended`. On 2026-08-25 that cost the `m3` aggregate its
 * whole `headstart` leg: the 10d jump landed at the end of the film, the film finished, the
 * engine released the television by itself at 07:18:17Z, and the scenario then spent 20 s
 * waiting for a release that had already happened before giving up and taking every
 * assertion behind it down with it. The verdict said `runCompleted: no`, about a run in
 * which the product had done exactly what 13e asks.
 *
 * So it lives here, where every scenario file can reach it without a cycle, and the
 * question is asked once.
 */
export function holdsTheTelevision(state: SessionState): boolean {
  return state !== 'idle' && state !== 'stopped' && state !== 'ended';
}

export type Comparison = 'lte' | 'gte' | 'eq' | 'observed';

/**
 * `promise` — something we said we would do. It has a target, it can fail, and it gates
 * the exit code. Only put a number here if a regression in *our* code would move it.
 *
 * `observation` — a number worth knowing that we do not control. It is measured, named and
 * printed, and it never fails a run. The Default Media Receiver's boot time is the case
 * that forced the distinction: 6.42–10.59 s across runs, three seconds of spread, entirely
 * the television's business — and gating on it meant roughly one run in eight going red for
 * nothing. A flapping assertion is nearly as corrosive as one that always fails, because
 * both teach everyone to shrug at a red line.
 */
export type AssertionKind = 'promise' | 'observation';

export interface Assertion {
  readonly name: string;
  readonly kind: AssertionKind;
  readonly target: number | string | null;
  readonly comparison: Comparison;
  readonly measured: number | string | null;
  readonly unit: string;
  /** Always true for an observation: it has nothing to fail against. */
  readonly passed: boolean;
  readonly note?: string;
}

/**
 * The run could not take place. Exit 2, and never exit 1.
 *
 * "This did not happen" is not "a promise was broken", and M3 adds a case of its own: a
 * scenario that could not produce the condition it exists to test — no small volume for a
 * disk-full test, no ffmpeg, a film too short to head-start — exits 2. *"A preparation test
 * that silently degraded into a Tier 1 cast and went green would be the most expensive lie
 * this project could tell itself."*
 */
export class SelftestAbort extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SelftestAbort';
  }
}

export function compare(
  comparison: Comparison,
  measured: number | string | null,
  target: number | string | null,
): boolean {
  if (measured === null || target === null) return false;
  if (comparison === 'eq') return measured === target;
  // `observed` never reaches here — an observation's `passed` is true by construction —
  // and it is deliberately not given a branch of its own, so this stays the same function
  // it was inside `index.ts` rather than growing an untested path during a move.
  if (typeof measured !== 'number' || typeof target !== 'number') return false;
  return comparison === 'lte' ? measured <= target : measured >= target;
}

export function assertion(
  name: string,
  comparison: Comparison,
  target: number | string | null,
  measured: number | string | null,
  unit: string,
  note?: string,
): Assertion {
  return {
    name,
    kind: 'promise',
    target,
    comparison,
    measured,
    unit,
    passed: compare(comparison, measured, target),
    ...(note === undefined ? {} : { note }),
  };
}

/** A measured number with no target. Reported, never graded. */
export function observation(
  name: string,
  measured: number | string | null,
  unit: string,
  note: string,
): Assertion {
  return {
    name,
    kind: 'observation',
    target: null,
    comparison: 'observed',
    measured,
    unit,
    passed: true,
    note,
  };
}
