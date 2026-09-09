/**
 * Formatting the founder reads. Pure functions, no React, no snapshot knowledge.
 *
 * `H:MM:SS` is written out in full — hours included even for a 12-minute file —
 * because the PRD's acceptance criteria (2a, 5a) say `H:MM:SS` and QA verifies them
 * literally. The mockup drops the hours field below an hour; that is the one place
 * this file deliberately differs from it.
 */

/** Seconds → `H:MM:SS`. Negative and non-finite values floor to `0:00:00`. */
export function hms(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return `${String(hours)}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

/** A duration the engine has not read yet is `null`, never a guess of zero. */
export function hmsOrNull(seconds: number | null): string | null {
  return seconds === null ? null : hms(seconds);
}

/** 0–100, safe against a duration of zero (before a file is probed). */
export function percentOf(positionSec: number, durationSec: number): number {
  if (!Number.isFinite(durationSec) || durationSec <= 0) return 0;
  return Math.min(100, Math.max(0, (positionSec / durationSec) * 100));
}

/**
 * A jump, as the founder reads it while it is still accumulating: `+1:30`, `−0:30`.
 *
 * Minutes and seconds only, and never hours — a running total of ±30 s taps that reached
 * an hour would be a founder holding the button down, and `+60:00` is more legible than
 * `+1:00:00` at that point. The sign is always shown: this is a *change*, not a position,
 * and `1:30` alone would read as one.
 */
export function signedDelta(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.round(seconds) : 0;
  const magnitude = Math.abs(total);
  const minutes = Math.floor(magnitude / 60);
  const secs = magnitude % 60;
  // A true minus sign, not a hyphen: it sits on the same optical line as the plus.
  const sign = total < 0 ? '−' : '+';
  return `${sign}${String(minutes)}:${String(secs).padStart(2, '0')}`;
}
