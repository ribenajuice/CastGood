import type { Intent, StateSnapshot } from '../engine/protocol/index.js';
import { INITIAL_SNAPSHOT } from './state/initial-snapshot.js';

/**
 * The renderer's only connection to the rest of the app.
 *
 * `window.castgood` is installed by the preload script. Everything the UI knows
 * arrives as a snapshot; everything it wants arrives back as an intent. There is no
 * other data path — no fetch, no sockets, no filesystem — and there never will be.
 *
 * Types from `src/engine/protocol` are imported **as types only**. Importing a value
 * would pull engine runtime code (and zod) into the renderer bundle, which is a known
 * architecture problem here.
 */

declare global {
  interface Window {
    castgood?: {
      onSnapshot(listener: (snapshot: unknown) => void): () => void;
      send(intent: unknown): void;
      requestSnapshot(): void;
      /**
       * Opens the native file dialog in the main process and resolves to the chosen
       * path, or `null` if the founder cancelled.
       *
       * Optional on purpose: the renderer cannot open a dialog itself, and until the
       * main process exposes this the Choose video button renders disabled with its
       * reason beside it rather than looking pressable and doing nothing.
       */
      pickVideoFile?: (startIn?: string) => Promise<string[]>;
      /**
       * Opens the native picker filtered to subtitle files (18c), resolving to the chosen
       * path or `null` if the founder cancelled.
       *
       * Optional for the same reason as the video picker: until main exposes it, *Choose a
       * file…* renders disabled with its reason beside it rather than looking pressable and
       * doing nothing.
       */
      pickSubtitleFile?: (startIn?: string) => Promise<string | null>;
      /**
       * Adds CastGood's Windows Firewall rule, with Windows' own elevation prompt.
       *
       * Optional for the same reason as the picker: until main exposes it, the button
       * renders disabled with its reason beside it rather than looking pressable and
       * doing nothing. Outside Electron it simply is not there.
       */
      allowFirewall?: () => Promise<'allowed' | 'declined' | 'failed' | 'unsupported'>;
      /**
       * Opens Windows' own network settings (11d). Optional for the same reason as the
       * other two: outside Electron it simply is not there, and the button says so.
       */
      openNetworkSettings?: () => Promise<boolean>;
      /**
       * Answers the closing question (founder's ruling, 2026-08-30 — it is a surface, not
       * a modal). Optional for the same reason as the rest: outside Electron there is
       * nothing to close, so there is never a question to answer.
       */
      answerQuestion?: (id: string, index: number) => void;
      /** Tells main the question is on screen, so it stops waiting on a paint. */
      questionShown?: (id: string) => void;
    };
  }
}

/**
 * A question the **host** needs answered — today, only the closing question.
 *
 * It arrives on the snapshot rather than on a channel of its own, so it can never
 * describe a world that has already moved on. It is not an engine state and never
 * appears in the engine's enum: `src/engine/` does not know that closing exists.
 */
export interface HostQuestion {
  readonly id: string;
  readonly kind: string;
  readonly headline: string;
  readonly detail: string;
  readonly answers: readonly string[];
  readonly safeIndex: number;
}

/** What the renderer actually receives: the engine's snapshot plus anything the host asks. */
export type WindowSnapshot = StateSnapshot & { readonly hostQuestion: HostQuestion | null };

export function subscribeToSnapshots(listener: (snapshot: WindowSnapshot) => void): () => void {
  const bridge = window.castgood;
  if (bridge === undefined) {
    // Renderer opened outside Electron (e.g. `vite` alone in a browser). Render the
    // empty state rather than throwing, so the UI is still developable in isolation.
    listener({ ...INITIAL_SNAPSHOT, hostQuestion: null });
    return () => undefined;
  }
  const unsubscribe = bridge.onSnapshot((snapshot) => {
    // `hostQuestion` is absent from anything the engine produces on its own, so it is
    // normalised here rather than being trusted to exist.
    const received = snapshot as StateSnapshot & { hostQuestion?: HostQuestion | null };
    listener({ ...received, hostQuestion: received.hostQuestion ?? null });
  });
  bridge.requestSnapshot();
  return unsubscribe;
}

/** Answer the closing question. `index` is into `HostQuestion.answers`; 0 is always safe. */
export function answerHostQuestion(id: string, index: number): void {
  window.castgood?.answerQuestion?.(id, index);
}

/**
 * Tell main the question is on screen.
 *
 * Main holds the close open for a short moment waiting for this. Without it, a renderer
 * that has crashed or never painted would leave the app unclosable — so this is the
 * acknowledgement that turns a deadline into an open-ended wait.
 */
export function reportHostQuestionShown(id: string): void {
  window.castgood?.questionShown?.(id);
}

export function sendIntent(intent: Intent): void {
  window.castgood?.send(intent);
}

/** False ⇒ no file dialog exists in this build; the UI must say so, not pretend. */
export function canPickFile(): boolean {
  return typeof window.castgood?.pickVideoFile === 'function';
}

export type PickOutcome =
  | {
      readonly kind: 'selected';
      /** The first file — the v1 path, unchanged (24b). */
      readonly path: string;
      /** Every file chosen, in dialog order. 24z sorts them; this does not. */
      readonly paths: readonly string[];
    }
  /** Cancelling leaves the previous selection untouched (criterion 2b). */
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'unavailable' }
  | { readonly kind: 'failed' };

/**
 * Opens the file dialog. `startIn` is a file path whose *folder* the dialog opens in —
 * which is what *Find it again* needs after a source has moved (15b).
 */
export async function pickVideoFile(startIn?: unknown): Promise<PickOutcome> {
  const pick = window.castgood?.pickVideoFile;
  if (pick === undefined) return { kind: 'unavailable' };
  // `startIn` is typed but not trusted, because a click handler passed bare to `onClick`
  // receives React's MouseEvent — and that is exactly how this call once came to be handed
  // an object IPC cannot serialise, killing the picker silently. Anything that is not a
  // string means "no starting folder"; it can never reach the bridge.
  const from = typeof startIn === 'string' ? startIn : undefined;
  try {
    const paths = (await pick(from)).filter((p) => typeof p === 'string' && p !== '');
    const first = paths[0];
    if (first === undefined) return { kind: 'cancelled' };
    return { kind: 'selected', path: first, paths };
  } catch {
    // The reason belongs in the engine log, not on screen: the founder gets a plain
    // sentence beside the button and can press it again.
    return { kind: 'failed' };
  }
}

/** False ⇒ no subtitle picker exists in this build; the UI must say so, not pretend. */
export function canPickSubtitleFile(): boolean {
  return typeof window.castgood?.pickSubtitleFile === 'function';
}

/**
 * Opens the subtitle picker. `startIn` is the **film's** path, whose folder the dialog
 * opens in — a subtitle is nearly always beside the film it belongs to.
 *
 * Reuses `PickOutcome` because the four outcomes are exactly the same four, and a second
 * near-identical union would be a second place for *cancelled* to stop meaning "change
 * nothing".
 */
export async function pickSubtitleFile(startIn?: unknown): Promise<PickOutcome> {
  const pick = window.castgood?.pickSubtitleFile;
  if (pick === undefined) return { kind: 'unavailable' };
  // Not trusted, for the reason recorded on `pickVideoFile`: a handler passed bare to
  // `onClick` receives React's MouseEvent, which IPC cannot serialise.
  const from = typeof startIn === 'string' ? startIn : undefined;
  try {
    const path = await pick(from);
    if (path === null || path === '') return { kind: 'cancelled' };
    // A subtitle is always one file — 18c picks a single track, never a batch. It reports
    // `paths` for the shared shape's sake and it is always exactly one.
    return { kind: 'selected', path, paths: [path] };
  } catch {
    return { kind: 'failed' };
  }
}

export type FirewallOutcome = 'allowed' | 'declined' | 'failed' | 'unsupported';

/** False ⇒ this build cannot add the rule; the button says so rather than pretending. */
export function canAllowFirewall(): boolean {
  return typeof window.castgood?.allowFirewall === 'function';
}

/** False ⇒ this build cannot open the settings page; the button says so rather than lying. */
export function canOpenNetworkSettings(): boolean {
  return typeof window.castgood?.openNetworkSettings === 'function';
}

export async function openNetworkSettings(): Promise<boolean> {
  const open = window.castgood?.openNetworkSettings;
  if (open === undefined) return false;
  try {
    return await open();
  } catch {
    return false;
  }
}

export async function allowFirewall(): Promise<FirewallOutcome> {
  const allow = window.castgood?.allowFirewall;
  if (allow === undefined) return 'unsupported';
  try {
    return await allow();
  } catch {
    return 'failed';
  }
}
