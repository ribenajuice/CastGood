import path from 'node:path';
import { existsSync } from 'node:fs';
import fsp from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron';
import { createEngine, MEDIA_SERVER, parseIntent, resolveAppPaths } from '../engine/index.js';
import type { Engine } from '../engine/index.js';
import { FIREWALL_RULES, IPC_CHANNELS, SUBTITLE_EXTENSIONS, VIDEO_EXTENSIONS } from './ipc.js';
import { choiceFromButton, questionFor, quitPromptFor, safeChoiceFor } from './quit.js';
import type { QuitChoice, QuitPromptKind } from './quit.js';
import type { FirewallOutcome, HostQuestion } from './ipc.js';
import { DIAGNOSTIC_MENU_LABEL } from './diagnostics-menu.js';

/**
 * The Electron main process: a thin host, and nothing else.
 *
 * It owns the window, the IPC bridge and the OS integrations the engine is not
 * allowed to know about (dialogs, power events). All behaviour lives in the engine.
 * If you find yourself writing casting logic in this file, it belongs in `src/engine/`.
 *
 * Startup order matters and mirrors the PRD's targets: the engine (and, from M1,
 * discovery) starts on `whenReady()` *before* the window is created, so devices are
 * already arriving by the time the window paints.
 */

const isDev = !app.isPackaged;
const devServerUrl = process.env['VITE_DEV_SERVER_URL'];

let engine: Engine | null = null;
let mainWindow: BrowserWindow | null = null;

/**
 * The closing question, in flight (founder's ruling, 2026-08-30: *"make it in-window, no
 * modals"*).
 *
 * It lives at module scope because two unrelated Electron events need it — `close` on the
 * window, which is where the X actually arrives, and `before-quit`, which is where an
 * `app.quit()` arrives — and because the reply comes back on IPC, wired in `wireIpc`.
 *
 * `paintTimer` is the guarantee that a broken renderer cannot make the app unclosable: if
 * the question is not acknowledged as painted within `PAINT_ACK_MS`, it resolves itself
 * with the safe answer. There is deliberately **no** timeout on the *answer* — a question
 * that has been seen waits as long as the founder does. A deadline that closed the app
 * under a playing film because nobody clicked would be a worse failure than the one it
 * prevents.
 */
interface PendingQuestion {
  readonly id: string;
  readonly kind: QuitPromptKind;
  readonly question: HostQuestion;
  readonly resolve: (choice: QuitChoice) => void;
  /** Monotonic ms when the question went up — see `SECOND_X_GUARD_MS`. */
  readonly askedAtMs: number;
  paintTimer: NodeJS.Timeout | null;
  shown: boolean;
}

/**
 * How long a second X is treated as part of the first press rather than an answer.
 *
 * The founder's ruling of 2026-09-03 makes a second X mean *stop the cast and close*. That
 * is a decisive answer, and **double-clicking a window's X is an ordinary human slip** —
 * fast enough that both presses land before the question has been read. Swallowing the
 * ones inside this window costs a deliberate double-press nothing (press again, it works)
 * and stops an accidental one ending a film. Deliberately shorter than a paint
 * acknowledgement, so it can never outlive the question it guards.
 */
const SECOND_X_GUARD_MS = 700;

let pendingQuestion: PendingQuestion | null = null;

/**
 * The answer already given, waiting for `before-quit` to pick it up.
 *
 * The X takes a long way round: `close` → (we veto, ask, then call `close()` again) →
 * `closed` → `window-all-closed` → `app.quit()` → `before-quit`. Without this, the second
 * leg would ask the same question again.
 */
let decided: QuitChoice | null = null;

/** How long a question waits to be acknowledged as painted before it answers itself. */
const PAINT_ACK_MS = 2000;

let questionCounter = 0;

/**
 * The window icon, in development only. Packaged on Windows the icon comes from the
 * .exe itself, so this would be redundant there — and `build/` is deliberately outside
 * the `files` whitelist, so the file genuinely is not present in a packaged app.
 * Returns nothing at all if the icon is missing: a decoration must never be able to
 * stop the window opening.
 */
function devWindowIcon(): { icon?: string } {
  if (!isDev) return {};
  const iconPath = path.join(__dirname, '../../build/icon.png');
  return existsSync(iconPath) ? { icon: iconPath } : {};
}

/**
 * Broadcast the current world to every window, with any host question stapled on.
 *
 * Assigned in `wireIpc`. It is reached from the `close` handler, which is created before
 * `wireIpc` runs on the very first window, so it starts as a no-op rather than being
 * asserted non-null — a missed repaint is not worth a crash on the quit path.
 */
let broadcastToWindows: () => void = () => {};

/** Resolve a pending question and clear it. Safe to call twice. */
function settleQuestion(choice: QuitChoice): void {
  const pending = pendingQuestion;
  if (pending === null) return;
  pendingQuestion = null;
  if (pending.paintTimer !== null) clearTimeout(pending.paintTimer);
  broadcastToWindows();
  pending.resolve(choice);
}

/**
 * Put the closing question on screen and wait for an answer.
 *
 * The window is restored and focused first. A minimised or buried window would otherwise
 * hold the close open behind a question nobody can see, which reads as the app refusing to
 * close — the one property the modal had that a surface does not get for free.
 */
function askInWindow(current: Engine, kind: QuitPromptKind): Promise<QuitChoice> {
  const window = mainWindow;
  if (window === null || window.isDestroyed()) {
    // Nothing to ask in. This is the shutdown and the `app.quit()`-with-no-window path;
    // the safe answer is the whole point of `safeChoiceFor`.
    current.logger.info('app.quit_unasked', { kind, why: 'no-window' });
    return Promise.resolve(safeChoiceFor(kind));
  }

  questionCounter += 1;
  const id = `q${String(questionCounter)}`;
  const asked = questionFor(current.snapshot(), kind);

  return new Promise<QuitChoice>((resolve) => {
    pendingQuestion = {
      id,
      kind,
      askedAtMs: Date.now(),
      question: {
        id,
        kind: asked.kind,
        headline: asked.headline,
        detail: asked.detail,
        answers: asked.answers,
        safeIndex: 0,
      },
      resolve,
      paintTimer: null,
      shown: false,
    };

    if (window.isMinimized()) window.restore();
    if (!window.isVisible()) window.show();
    window.focus();

    current.logger.info('app.quit_question_shown', { kind, id });
    broadcastToWindows();

    const pending = pendingQuestion;
    pending.paintTimer = setTimeout(() => {
      if (pendingQuestion === null || pendingQuestion.id !== id || pendingQuestion.shown) return;
      // The renderer never told us it painted. It may be crashed, hung, or still loading.
      // Whatever the cause, the founder cannot answer a question they cannot see, and an
      // app that will not close is worse than one that takes its safest option.
      current.logger.warn('app.quit_question_unpainted', { kind, id, afterMs: PAINT_ACK_MS });
      settleQuestion(safeChoiceFor(kind));
    }, PAINT_ACK_MS);
  });
}

/**
 * The single place that decides what closing does.
 *
 * `quitPromptFor` returning null is an ordinary quit with nothing on the television, and
 * it stays completely silent — the 2026-08-18 ruling is explicit that a question on every
 * close is how a question stops being read.
 */
async function decideQuit(current: Engine): Promise<QuitChoice> {
  const kind = quitPromptFor(current.snapshot());
  if (kind === null) return { quit: true, keepPlaying: false };
  return askInWindow(current, kind);
}

function createWindow(current: Engine): BrowserWindow {
  const window = new BrowserWindow({
    width: 1100,
    // **900, because 720 was below the floor on the line below it.** Electron clamps an
    // initial size up to the minimum, so nobody ever saw a wrong window — but the number
    // said one thing and `minHeight` said another, and the next person to read it would
    // have believed the app opens at 720. Found in the v1 documentation pass, which is a
    // fair place to find it: a document is somebody reading the code carefully.
    height: 900,
    minWidth: 880,
    // **800, not 720, and the number is computed rather than chosen** (founder, 2026-09-04).
    //
    // The tallest state the app can hold *persistently* is a film playing with the subtitle
    // panel closed: FilePanel 137 + StatusRegion 184 + TransportPanel 284 + SubtitlesPanel
    // 130, plus 16 px of column padding either side and three 14 px gaps — **735 px of
    // content**. At the old 720 that clipped, in the state the founder is in most of the
    // time. 800 clears it with 33 px to spare once the native title bar is taken off.
    //
    // The bar and the transport row never appear together — `preparationOf` returns null
    // once the head start begins — so `Converting` is not the tall case; `Playing` is.
    //
    // **This is what makes the 1080p requirement enforced rather than merely documented.**
    // A display requirement does not stop anyone dragging a window smaller; a floor does.
    // Criterion 22b is satisfied here, by construction, rather than by a measurement no
    // instrument in this repo can take. If a panel is ever added to the main column, this
    // number is owed the same arithmetic again.
    minHeight: 800,
    show: false,
    // `--bg` from src/renderer/tokens.css, and the pairing with `body { background }`
    // there is checked by test/design/tokens.test.ts rather than remembered. Equal or the
    // window flashes a different ground before first paint.
    backgroundColor: '#100e0a',
    title: 'CastGood',
    // Packaged, Windows takes the icon from the .exe, which electron-builder stamps
    // from build/icon.png — build/ is not in the `files` whitelist, so it is not in
    // the asar and must not be looked for there at runtime. This only dresses the
    // dev window, and a missing file must never stop the app opening.
    ...devWindowIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  });

  // Paint as soon as there is something to paint: the PRD wants the window
  // interactive within 2 s and it must never wait on discovery.
  window.once('ready-to-show', () => {
    window.show();
    current.logger.info('window.shown', {});
  });

  // A closed BrowserWindow is a destroyed native object: every method on it throws
  // afterwards. `second-instance` can fire in the gap between the window closing and the
  // quit finishing — the app is still running, so the single-instance lock is still held —
  // and `isMinimized()` on the corpse takes the process down with it. The reference goes
  // the moment the window does. Story 12 (reopen while the TV is still playing) walks
  // straight through this gap.
  /**
   * **This, not `before-quit`, is where the X arrives.**
   *
   * Clicking the X closes the `BrowserWindow` first; `closed` then nulls `mainWindow`,
   * `window-all-closed` calls `app.quit()`, and only then does `before-quit` run — by
   * which time the window is destroyed. A modal could be raised with no window and this is
   * why `decideQuit` used to have a parentless branch. **An in-window question cannot**,
   * so the veto has to be here, while there is still a window to ask in.
   */
  window.on('close', (event) => {
    const current = engine;
    if (current === null) return;
    // Already answered: this is the second `close()`, the one we call ourselves below.
    if (decided !== null) return;
    // **A second X is an answer: stop the cast and close** (founder's ruling, 2026-09-03,
    // after finding that it did nothing). Pressing the X twice is somebody saying they mean
    // it, and the app taking that as "stop it and close" is the reading that matches the
    // press — in all three variants, because a second X is not a request to keep anything
    // running.
    //
    // Never a second question stacked on the first: one of them would be unanswerable.
    //
    // The one exception is a **double-click**, which is an ordinary slip on a window's X and
    // would otherwise end a film nobody meant to end. Presses inside `SECOND_X_GUARD_MS` of
    // the question going up are treated as part of the first click and only re-raise the
    // window — which is also the honest thing to do, since the question cannot have been
    // read yet.
    if (pendingQuestion !== null) {
      event.preventDefault();
      const sinceAsked = Date.now() - pendingQuestion.askedAtMs;
      if (sinceAsked < SECOND_X_GUARD_MS) {
        current.logger.info('app.quit_second_x_ignored', { sinceAsked });
        if (window.isMinimized()) window.restore();
        window.focus();
        return;
      }
      current.logger.info('app.quit_second_x', { sinceAsked });
      settleQuestion({ quit: true, keepPlaying: false });
      return;
    }
    if (quitPromptFor(current.snapshot()) === null) return;

    event.preventDefault();
    void decideQuit(current)
      .then((choice) => {
        if (!choice.quit) {
          // Stayed. Nothing is remembered: the next X asks again.
          current.logger.info('app.quit_declined', {});
          return;
        }
        decided = choice;
        window.close();
      })
      .catch((error: unknown) => {
        current.logger.warn('app.quit_question_failed', { error });
        // Never trap the app: a question that threw takes the answer that cannot end an
        // evening by accident, and the close goes through.
        decided = safeChoiceFor(quitPromptFor(current.snapshot()) ?? 'playing');
        window.close();
      });
  });

  /**
   * Windows is shutting down or logging off. There is no time to ask and nowhere to show a
   * question, so anything in flight takes its safe answer at once.
   *
   * `keepPlaying: false` regardless of kind: leaving a film playing is only a kindness
   * while the founder still has a machine to reopen CastGood on, and here they do not.
   *
   * It is a **window** event rather than an app one — that is where Electron puts it.
   */
  window.on('session-end', () => {
    current.logger.warn('app.session_end', {});
    decided = { quit: true, keepPlaying: false };
    settleQuestion({ quit: true, keepPlaying: false });
  });

  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null;
  });

  window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    current.logger.error('window.load_failed', { errorCode, errorDescription, validatedURL });
  });

  // Nothing in this app navigates or opens windows. Anything that tries is a bug or an attack.
  window.webContents.setWindowOpenHandler(({ url }) => {
    current.logger.warn('window.open_blocked', { url });
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (devServerUrl !== undefined && url.startsWith(devServerUrl)) return;
    event.preventDefault();
    current.logger.warn('window.navigation_blocked', { url });
  });

  if (devServerUrl !== undefined && devServerUrl !== '') {
    void window.loadURL(devServerUrl);
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  return window;
}

function wireIpc(current: Engine): void {
  const broadcast = (): void => {
    // The host question rides on the same message as the state it describes. A channel of
    // its own could deliver "closing stops the film you are watching" a frame after the
    // film ended; stapled here, the two cannot disagree.
    const snapshot = {
      ...current.snapshot(),
      hostQuestion: pendingQuestion === null ? null : pendingQuestion.question,
    };
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send(IPC_CHANNELS.snapshot, snapshot);
    }
  };

  broadcastToWindows = broadcast;
  current.subscribe(broadcast);

  ipcMain.on(IPC_CHANNELS.hello, broadcast);

  /**
   * The founder's answer to the closing question, or the renderer saying it has painted it.
   *
   * Everything here is untrusted: it arrives from a browser context. A reply naming a
   * question that is not the one in flight is discarded rather than applied to the next
   * one, which is what the id is for.
   */
  ipcMain.on(IPC_CHANNELS.questionReply, (_event, payload: unknown) => {
    const pending = pendingQuestion;
    if (pending === null) return;
    if (typeof payload !== 'object' || payload === null) return;
    const { id, reply } = payload as { id?: unknown; reply?: unknown };
    if (typeof id !== 'string' || id !== pending.id) return;

    if (reply === 'shown') {
      // Painted. The paint deadline is cancelled and the question now waits as long as the
      // founder does — deliberately without a deadline of its own.
      pending.shown = true;
      if (pending.paintTimer !== null) {
        clearTimeout(pending.paintTimer);
        pending.paintTimer = null;
      }
      return;
    }

    if (typeof reply !== 'number' || !Number.isInteger(reply)) return;
    const choice = choiceFromButton(reply, pending.kind);
    current.logger.info('app.quit_choice', { kind: pending.kind, ...choice });
    settleQuestion(choice);
  });

  /**
   * Nothing may open an OS dialog or a settings page while the closing question is up.
   *
   * The intent channel was already guarded. **These four were not**, and they are not
   * intents — they are host channels, so the question's inertness did not reach them. The
   * founder found the consequence on 2026-09-03: *"trying to change the film prompts to
   * select a file, but after selecting the file, nothing happens."* A Windows file dialog
   * opened over the question, took a real decision, and the `file.select` intent that came
   * back was then dropped by the guard below. **Refusing to open the dialog at all is the
   * honest version of inert**; the renderer also greys these controls and says why, so this
   * is the backstop rather than the only defence.
   */
  const refusedWhileAsking = (channel: string): boolean => {
    if (pendingQuestion === null) return false;
    current.logger.warn('host.ignored_during_question', { channel, id: pendingQuestion.id });
    return true;
  };

  // Opening a file dialog is an OS integration, so it lives in main and not in the
  // engine. The renderer gets the path back and sends a normal `file.select` intent,
  // which is revalidated below like anything else arriving from a browser context.
  ipcMain.handle(IPC_CHANNELS.pickVideoFile, async (event, startIn): Promise<string | null> => {
    if (refusedWhileAsking('pickVideoFile')) return null;
    // *Find it again* (15b) opens where the file used to be. Anything else arriving here
    // is ignored rather than trusted: the renderer is a browser context, and a dialog is
    // not a place to open an arbitrary path a compromised one asked for.
    const folder =
      typeof startIn === 'string' && path.isAbsolute(startIn) ? path.dirname(startIn) : null;
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a video',
      properties: ['openFile'],
      ...(folder === null ? {} : { defaultPath: folder }),
      filters: [
        { name: 'Video', extensions: [...VIDEO_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      const result =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);
      const chosen = result.canceled ? undefined : result.filePaths[0];
      if (chosen === undefined) {
        // PRD 2b: cancelling leaves the previous selection exactly as it was.
        current.logger.info('file.picker_cancelled', {});
        return null;
      }
      current.logger.info('file.picked', { name: path.basename(chosen) });
      return chosen;
    } catch (error) {
      // A dialog that fails to open must read as "nothing was chosen", never as a crash.
      current.logger.error('file.picker_failed', { error });
      return null;
    }
  });

  /**
   * *Choose a file…* for a subtitle (18c).
   *
   * The same shape as the video picker above and for the same reasons: a renderer cannot
   * open an OS dialog, so main owns it and hands back a path the renderer sends as a normal
   * `subtitles.chooseFile` intent, revalidated below like anything else from a browser
   * context.
   *
   * **It reads nothing and writes nothing.** 18c: *"the chosen file is used wherever it
   * lives, and choosing it moves, copies and renames nothing"* — so this returns a path and
   * the engine decides whether it can be used. Whether the file parses is 18j's answer, not
   * a filter's.
   */
  ipcMain.handle(IPC_CHANNELS.pickSubtitleFile, async (event, startIn): Promise<string | null> => {
    if (refusedWhileAsking('pickSubtitleFile')) return null;
    // Opens beside the film when we know where it is — the folder a founder looking for a
    // subtitle almost always wants. Anything else arriving here is ignored rather than
    // trusted, exactly as the video picker ignores it.
    const folder =
      typeof startIn === 'string' && path.isAbsolute(startIn) ? path.dirname(startIn) : null;
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a subtitle file',
      properties: ['openFile'],
      ...(folder === null ? {} : { defaultPath: folder }),
      filters: [
        { name: 'Subtitles', extensions: [...SUBTITLE_EXTENSIONS] },
        { name: 'All files', extensions: ['*'] },
      ],
    };
    try {
      const window = BrowserWindow.fromWebContents(event.sender);
      const result =
        window === null
          ? await dialog.showOpenDialog(options)
          : await dialog.showOpenDialog(window, options);
      const chosen = result.canceled ? undefined : result.filePaths[0];
      if (chosen === undefined) {
        // Cancelling leaves the film exactly as it was, without subtitles.
        current.logger.info('subtitles.picker_cancelled', {});
        return null;
      }
      // The basename, never the path — the same rule the video picker follows.
      current.logger.info('subtitles.picked', { name: path.basename(chosen) });
      return chosen;
    } catch (error) {
      current.logger.error('subtitles.picker_failed', { error });
      return null;
    }
  });

  /**
   * *Allow through the firewall* (17b).
   *
   * The installer already adds these rules; this exists for the install where they were
   * removed, refused, or never applied — which is exactly what the diagnosis in 17a has
   * just named. It must add **the same two rules the installer does**, or `win-firewall.sh`
   * will report them absent, the uninstaller will not remove them, and the app will have
   * opened something nobody accounted for.
   *
   * Three things here are load-bearing and were each wrong first time round:
   *  - **The commands go in a `.cmd` file**, not on a command line. `cmd.exe` does not
   *    treat `'` as a quote, so a single-quoted `program='C:\Program Files\...'` splits at
   *    the space and netsh rejects it; and `;` is not a cmd separator, so a second command
   *    after one becomes arguments to the first. A file sidesteps both.
   *  - **The exit code is read.** `Start-Process -Wait` alone tells you the process
   *    finished, never what it returned — so the app said "The rule was added" whatever
   *    happened, and the founder pressed Cast into the identical failure having been told
   *    the problem was fixed. `-PassThru` is what makes the answer real.
   *  - **Delete before add**, as the installer does, so pressing this twice replaces the
   *    rules rather than piling up duplicates.
   *
   * Not in the engine and not reachable as an intent: the engine is a plain Node library
   * that has to run headless in WSL, and shelling out to `netsh` is the opposite of that.
   */
  ipcMain.handle(IPC_CHANNELS.allowFirewall, async (): Promise<FirewallOutcome> => {
    if (refusedWhileAsking('allowFirewall')) return 'unsupported';
    if (process.platform !== 'win32') {
      current.logger.warn('firewall.unsupported_platform', { platform: process.platform });
      return 'unsupported';
    }

    // Derived, never retyped: the media server scans upward from its default port, and a
    // rule that covers a different range than the server can bind is a rule that does
    // nothing on the day the first port is busy.
    const firstPort = MEDIA_SERVER.defaultPort;
    const lastPort = firstPort + MEDIA_SERVER.portScanAttempts - 1;
    const exe = process.execPath;
    const script = [
      '@echo off',
      // A missing rule makes netsh return 1, which is expected here, so discard it.
      `netsh advfirewall firewall delete rule name="${FIREWALL_RULES.mdns}" >nul 2>&1`,
      `netsh advfirewall firewall delete rule name="${FIREWALL_RULES.media}" >nul 2>&1`,
      // **Windows' own block rule has to go, or none of the above matters.**
      //
      // Checklist item 6, 2026-08-19, on the founder's machine. When CastGood first binds
      // its media port Windows shows its "allow this app?" alert, and **both** ways of not
      // saying yes — Cancel *and* the X — write a Block rule named after the executable.
      // Windows Firewall resolves Block before Allow, so the rules added below were added
      // correctly, reported honestly, and did precisely nothing: three full add-and-retry
      // cycles were logged, all blocked, until the founder deleted Windows' entry by hand.
      // The one founder who needs this button is the founder who dismissed that dialog, so
      // it must clear what dismissing it created.
      //
      // **Only the rules that block, and only for our own executable.** `netsh delete rule
      // ... program=` cannot filter on the action, so it would take a founder's *working*
      // allow rule with it — Windows writes one per profile, and a home network classified
      // Public, or a Public box ticked in Windows' own dialog, would be deleted here and
      // replaced by the private-only pair below. That turns a button labelled "Allow
      // through the firewall" into one that revokes permission. PowerShell can filter, so
      // it does.
      //
      // The path travels in an environment variable rather than inside the quoted command:
      // `cmd.exe`'s `set "VAR=value"` swallows spaces, apostrophes and parentheses alike,
      // and a founder whose Windows account is "O'Brien" is exactly the case that has bitten
      // this command once already.
      `set "CASTGOOD_EXE=${exe}"`,
      'powershell -NoProfile -NonInteractive -Command "Get-NetFirewallApplicationFilter |' +
        ' Where-Object { $_.Program -eq $env:CASTGOOD_EXE } | Get-NetFirewallRule |' +
        " Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } |" +
        ' Remove-NetFirewallRule" >nul 2>&1',
      `netsh advfirewall firewall add rule name="${FIREWALL_RULES.mdns}" dir=in action=allow program="${exe}" enable=yes profile=private protocol=UDP localport=5353 remoteip=LocalSubnet description="Lets CastGood find Chromecast devices on your home network." || exit /b 1`,
      `netsh advfirewall firewall add rule name="${FIREWALL_RULES.media}" dir=in action=allow program="${exe}" enable=yes profile=private protocol=TCP localport=${String(firstPort)}-${String(lastPort)} remoteip=LocalSubnet description="Lets your TV play video files from this PC." || exit /b 1`,
      'exit /b 0',
      '',
    ].join('\r\n');

    const scriptPath = path.join(
      app.getPath('temp'),
      `castgood-firewall-${String(Date.now())}.cmd`,
    );
    try {
      await fsp.writeFile(scriptPath, script, 'utf8');
    } catch (error) {
      current.logger.error('firewall.script_write_failed', { error });
      return 'failed';
    }

    try {
      return await new Promise<FirewallOutcome>((resolve) => {
        // `-PassThru -Wait` gives back the process so its exit code can be read. A declined
        // elevation prompt throws inside PowerShell, which is caught there and turned into
        // exit 5 — a decision, not a failure, and the screen says so differently.
        const command = [
          '$ErrorActionPreference = "Stop"',
          'try {',
          `  $p = Start-Process -FilePath "$env:ComSpec" -ArgumentList '/c', '"${scriptPath}"' -Verb RunAs -WindowStyle Hidden -Wait -PassThru`,
          '  exit $p.ExitCode',
          '} catch { exit 5 }',
        ].join('; ');

        execFile(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', command],
          { windowsHide: true, timeout: 120_000 },
          (error) => {
            const code = error === null ? 0 : ((error as { code?: number }).code ?? -1);
            if (code === 0) {
              current.logger.info('firewall.rules_added', {
                rules: [FIREWALL_RULES.mdns, FIREWALL_RULES.media],
                mediaPorts: `${String(firstPort)}-${String(lastPort)}`,
              });
              resolve('allowed');
              return;
            }
            current.logger.warn('firewall.rules_not_added', { exitCode: code, error });
            resolve(code === 5 ? 'declined' : 'failed');
          },
        );
      });
    } finally {
      await fsp.rm(scriptPath, { force: true }).catch(() => undefined);
    }
  });

  /**
   * *Open network settings* (11d).
   *
   * Offered only after 30 s of this PC being offline, and it opens a page — it does not
   * change a setting, need elevation, or touch the network itself. `ms-settings:` is
   * Windows' own scheme; anywhere else there is nothing sensible to open, and the honest
   * answer is `false` so the UI can say the button is not available in this build.
   */
  ipcMain.handle(IPC_CHANNELS.openNetworkSettings, async (): Promise<boolean> => {
    if (refusedWhileAsking('openNetworkSettings')) return false;
    if (process.platform !== 'win32') {
      current.logger.warn('network.settings_unsupported', { platform: process.platform });
      return false;
    }
    try {
      await shell.openExternal('ms-settings:network');
      current.logger.info('network.settings_opened', {});
      return true;
    } catch (error) {
      current.logger.warn('network.settings_open_failed', { error });
      return false;
    }
  });

  ipcMain.on(IPC_CHANNELS.intent, (_event, payload: unknown) => {
    // While the closing question is up, the rest of the screen is inert. It is a decision,
    // and an intent arriving from a panel behind it is either a stale click or a bug — and
    // acting on one would let the founder change the very state the question describes
    // while they are being asked about it.
    if (pendingQuestion !== null) {
      current.logger.warn('intent.ignored_during_question', { id: pendingQuestion.id });
      return;
    }
    const result = parseIntent(payload);
    if (!result.ok) {
      // Log the detail; the renderer gets nothing back. A malformed intent is a bug
      // in our own UI, not something the founder should ever see a schema error for.
      current.logger.warn('intent.rejected', { reason: result.reason });
      return;
    }
    current.dispatch(result.intent);
  });
}

// One instance only: two engines would mean two media servers and two Cast connections.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    // Belt and braces with the `closed` handler above: `isDestroyed()` is also true
    // between `close()` and `closed`, and a second launch in that window is exactly the
    // race this guard exists for.
    const window = mainWindow;
    if (window === null || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  /**
   * The application menu, which exists only to carry *Save a diagnostic report…* — story 25.
   *
   * ⚠️ **A menu item is a stronger answer to 25a than a panel was.** A panel had to be built
   * unconditionally and kept out of every inert-while-asking path; this is outside the view
   * model entirely, so there is no state in which it can fail to render.
   *
   * The rest of the template is Electron's own roles, so the standard shortcuts a person
   * expects — copy, paste, close, devtools in a dev build — keep working. Building a menu
   * replaces the default one wholesale, and losing Ctrl+C to add a diagnostic would be a poor
   * trade.
   */
  function installMenu(engine: Engine): void {
    const template: Parameters<typeof Menu.buildFromTemplate>[0] = [
      {
        label: 'File',
        submenu: [
          {
            label: DIAGNOSTIC_MENU_LABEL,
            // No confirmation dialog: the app forbids modals (founder's ruling,
            // 2026-08-30) and `quit-prompt.test.ts` fails any message box, including a new
            // one that has nothing to do with quitting. The sentence 25i asks for is the
            // first thing in the report, read in the window Explorer opens — before
            // anything is sent, which is the moment that criterion was protecting.
            click: () => {
              engine.dispatch({ type: 'diagnostics.export' });
            },
          },
          { type: 'separator' },
          { role: 'quit' },
        ],
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' },
    ];
    Menu.setApplicationMenu(Menu.buildFromTemplate(template));
  }

  app.whenReady().then(
    async () => {
      const current = createEngine({
        paths: resolveAppPaths(),
        appVersion: app.getVersion(),
        // Story 25, criterion 25b. The engine writes the report; revealing it needs
        // Explorer, which needs Electron, which the engine may never import
        // (`engine-boundary.test.ts`). So the host hands the capability in.
        //
        // ⚠️ `showItemInFolder`, not `openPath`. 25b asks for the file to be SELECTED:
        // a path in a sentence is a thing to retype, a highlighted file is a thing to
        // drag into a message — and dragging it is the entire point.
        revealFile: (filePath: string) => {
          shell.showItemInFolder(filePath);
        },
        ...(isDev ? { logLevel: 'debug' as const } : {}),
      });
      engine = current;

      current.logger.info('app.ready', { isDev, packaged: app.isPackaged });
      await current.start();

      wireIpc(current);
      installMenu(current);
      mainWindow = createWindow(current);
    },
    (error: unknown) => {
      process.stderr.write(`castgood: failed to start: ${String(error)}\n`);
      app.exit(1);
    },
  );

  app.on('window-all-closed', () => {
    // Windows-only product: closing the window ends the app.
    app.quit();
  });

  // The log is the only way a WSL session can confirm what the app did on Windows,
  // so quitting has to wait for it to reach disk. `engine.stop()` flushes and closes
  // the write stream; fire-and-forget here would let the process exit mid-drain and
  // silently lose the last events — exactly the ones worth reading.
  let quitting = false;

  /**
   * The backstop, for every close that is **not** the X.
   *
   * `app.quit()` from the taskbar, `window-all-closed` after the X has already been
   * answered, or a shutdown. When the X asked, `decided` is already set and this simply
   * carries it out rather than asking the same question twice.
   */
  app.on('before-quit', (event) => {
    const current = engine;
    if (quitting || current === null) return;
    quitting = true;
    event.preventDefault();

    const already = decided;
    if (already !== null) {
      void finishQuit(current, already);
      return;
    }

    void decideQuit(current)
      .then(async (choice) => {
        if (!choice.quit) {
          // The founder chose to keep working. The quit is abandoned rather than deferred:
          // `quitting` goes back to false so the next close asks again.
          quitting = false;
          return;
        }
        await finishQuit(current, choice);
      })
      .catch((error: unknown) => {
        process.stderr.write(`castgood: quit question failed: ${String(error)}\n`);
        app.exit(0);
      });
  });
}

/**
 * Stop the engine and go, honouring the answer.
 *
 * Stopping cancels any job in flight and takes its partial work with it, which is the
 * second half of P6: there is no conversion running after the app is gone, and nothing
 * left beside the founder's video.
 */
async function finishQuit(current: Engine, choice: QuitChoice): Promise<void> {
  try {
    await current.stop({ keepPlaying: choice.keepPlaying });
  } catch (error) {
    process.stderr.write(`castgood: engine stop failed: ${String(error)}\n`);
  }
  app.exit(0);
}
