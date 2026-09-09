/**
 * The IPC contract, in one file so both sides of the bridge cannot drift.
 *
 * Direction is fixed and deliberate:
 *   main → renderer   state snapshots (the renderer's entire knowledge of the world)
 *   renderer → main   intents (validated with zod before the engine ever sees them)
 *
 * The renderer is a browser context. It is untrusted input, and it never gets a
 * handle to the engine, the network, or the filesystem.
 */

export const IPC_CHANNELS = {
  /** main → renderer: a full StateSnapshot. */
  snapshot: 'castgood:snapshot',
  /** renderer → main: one Intent. */
  intent: 'castgood:intent',
  /** renderer → main: "I just mounted, send me the current snapshot". */
  hello: 'castgood:hello',
  /**
   * renderer → main → renderer: open the OS file picker and return the chosen path.
   *
   * A renderer cannot open an OS dialog, and there is deliberately no "open the picker"
   * intent — intents describe what the *engine* should do. So main owns the dialog and
   * hands back a path, which the renderer then sends as a normal `file.select` intent
   * and which main revalidates before the engine sees it.
   *
   * Cancelling resolves `null`: nothing is sent, and the previous selection stands (2b).
   *
   * An optional `startIn` path opens the dialog where the founder was last looking. That
   * is what makes *Find it again* (15b) land in the folder the file used to be in rather
   * than wherever Windows feels like.
   */
  pickVideoFile: 'castgood:pick-video-file',
  /**
   * renderer → main → renderer: open the OS picker for a **subtitle** file (18c).
   *
   * A second channel rather than a parameter on `pickVideoFile`, for the reason the two
   * preparation intents are separate: the two pickers filter differently and land in
   * different intents, and a boolean deciding which is one typo away from offering the
   * founder a film where a subtitle belongs.
   *
   * *"The chosen file is used wherever it lives, and choosing it moves, copies and renames
   * nothing"* — so this returns a path and does nothing else. Cancelling resolves `null`
   * and the film stays exactly as it was, without subtitles.
   */
  pickSubtitleFile: 'castgood:pick-subtitle-file',
  /**
   * renderer → main → renderer: add CastGood's Windows Firewall rule, with elevation.
   *
   * Deliberately **not** an intent. Intents describe what the *engine* should do, and the
   * engine has no business shelling out to `netsh` — nor could it, being a plain Node
   * library that must run headless in WSL. Main owns the OS, so main owns this.
   */
  allowFirewall: 'castgood:allow-firewall',
  /**
   * renderer → main: open Windows' own network settings (PRD 11d).
   *
   * Not an intent, for the same reason the firewall command is not: the engine is a plain
   * Node library that has to run headless in WSL, and opening a Windows settings page is
   * the opposite of that. It is offered only after 30 s offline, and only ever *opens* a
   * page — it changes nothing and needs no elevation.
   */
  openNetworkSettings: 'castgood:open-network-settings',
  /**
   * renderer → main: the answer to the closing question, or an acknowledgement that it
   * has been painted (founder's ruling, 2026-08-30 — the question is a surface, not a
   * modal).
   *
   * Deliberately **not** an intent, for the same reason the firewall command is not:
   * intents describe what the *engine* should do, and whether this process exits is not
   * the engine's business. The engine never learns that closing exists.
   *
   * Carries the question's `id` so a reply to a question that has already been resolved —
   * by a paint timeout, by a shutdown, by a second close — is discarded rather than
   * answering the next one.
   */
  questionReply: 'castgood:question-reply',
} as const;

export type IpcChannel = (typeof IPC_CHANNELS)[keyof typeof IPC_CHANNELS];

/**
 * What happened when the founder pressed *Allow through the firewall*.
 *
 * `declined` is not a failure: Windows asked for administrator rights and they said no,
 * which is a decision, not an error. The screen keeps the manual instructions and changes
 * nothing else (17b).
 */
export type FirewallOutcome = 'allowed' | 'declined' | 'failed' | 'unsupported';

/**
 * The exact rule names the NSIS installer creates (`build/installer.nsh`).
 *
 * *Allow through the firewall* must add **these**, not rules of its own invention. A
 * differently named rule would leave `scripts/win-firewall.sh` reporting the real ones
 * absent, leave the uninstaller unable to remove what the app added, and open a broader
 * hole than the installer ever asked for. If these strings change, change them there too —
 * `test/architecture/firewall-rules.test.ts` fails the build if they drift.
 */
export const FIREWALL_RULES = {
  mdns: 'CastGood (mDNS discovery)',
  media: 'CastGood (media server)',
} as const;

/**
 * A question **main** needs answered before it can act, carried on the snapshot.
 *
 * Today there is exactly one: the closing question. It lives here rather than in the
 * engine because "this process is about to exit" is an Electron fact, and `src/engine/`
 * is a plain Node library with no Electron in it — a rule `test/architecture/engine-
 * boundary.test.ts` enforces.
 *
 * It rides on the **same message** as the state it describes rather than on a channel of
 * its own. That is the whole point: a separate channel could deliver *"closing stops the
 * film you are watching"* a frame after the film ended. Stapled to the snapshot, the
 * question and the world it describes cannot disagree.
 *
 * `answers[0]` is always the safe answer — see `safeChoiceFor` in `quit.ts`.
 */
export interface HostQuestion {
  readonly id: string;
  readonly kind: string;
  readonly headline: string;
  readonly detail: string;
  readonly answers: readonly string[];
  /** Always 0. Present so the renderer never has to know which index is safe. */
  readonly safeIndex: number;
}

/**
 * What the renderer actually receives: the engine's snapshot plus anything the host needs
 * to ask. The renderer stays a pure view of one object arriving on one channel.
 */
export type WindowSnapshot = { readonly hostQuestion: HostQuestion | null };

/** The API the preload script exposes on `window.castgood`. */
export interface CastGoodBridge {
  /** Returns an unsubscribe function. */
  onSnapshot(listener: (snapshot: unknown) => void): () => void;
  send(intent: unknown): void;
  requestSnapshot(): void;
  /** Resolves the chosen absolute path, or `null` if the founder cancelled. Never rejects. */
  pickVideoFile(startIn?: string): Promise<string | null>;
  /** Resolves the chosen subtitle path, or `null` if the founder cancelled. Never rejects for a cancel. */
  pickSubtitleFile(startIn?: string): Promise<string | null>;
  allowFirewall(): Promise<FirewallOutcome>;
  /** Resolves true when a settings page was actually opened. Never rejects. */
  openNetworkSettings(): Promise<boolean>;
  /** Answer the closing question. `index` is into `HostQuestion.answers`. */
  answerQuestion(id: string, index: number): void;
  /**
   * "The question is on screen." Main holds the close until this arrives, so a renderer
   * that has crashed or never painted cannot leave the app unclosable.
   */
  questionShown(id: string): void;
}

/**
 * File types the picker offers.
 *
 * A filter, not a verdict: M1 does no compatibility checking, and a file this list lets
 * through may still fail at cast time with "Couldn't play this file" (3c). The picker
 * must never become a back-door compatibility check.
 */
export const VIDEO_EXTENSIONS = ['mp4', 'm4v', 'mov', 'mkv', 'webm', 'avi', 'wmv', 'ts'] as const;

/**
 * Subtitle types the picker offers (18c: *"a picker opens filtered to subtitle files"*).
 *
 * The same four the engine can actually turn into WebVTT — `.srt` and `.vtt` are read
 * directly, `.ass` and `.ssa` go through ffmpeg. **`.sub` is deliberately absent**: it is
 * normally the binary half of a VobSub pair, which is pictures, and 18k refuses picture
 * subtitles in as many words. Offering a file the app must then refuse reads as broken.
 *
 * A filter, not a verdict — exactly as `VIDEO_EXTENSIONS` is. A file this list lets
 * through may still be refused when it is read (18j), and that refusal is the engine's.
 */
export const SUBTITLE_EXTENSIONS = ['srt', 'vtt', 'ass', 'ssa'] as const;
