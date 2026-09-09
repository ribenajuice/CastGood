import { contextBridge, ipcRenderer } from 'electron';
import { IPC_CHANNELS } from './ipc.js';
import type { CastGoodBridge, FirewallOutcome } from './ipc.js';

/**
 * The only hole in the wall between the renderer and the rest of the app.
 *
 * Three functions, no `ipcRenderer` handed out, no node APIs, no remote module.
 * Anything the UI can do to the outside world, it does through here.
 */

const bridge: CastGoodBridge = {
  onSnapshot(listener) {
    const handler = (_event: Electron.IpcRendererEvent, snapshot: unknown): void => {
      listener(snapshot);
    };
    ipcRenderer.on(IPC_CHANNELS.snapshot, handler);
    return () => {
      ipcRenderer.removeListener(IPC_CHANNELS.snapshot, handler);
    };
  },
  send(intent) {
    ipcRenderer.send(IPC_CHANNELS.intent, intent);
  },
  requestSnapshot() {
    ipcRenderer.send(IPC_CHANNELS.hello);
  },
  async pickVideoFile(startIn) {
    // Cancelling resolves null — main returns null and never throws for a cancel, so PRD
    // 2b (a cancelled picker leaves the previous selection untouched) is honoured without
    // catching anything here.
    //
    // **A genuine failure is deliberately allowed to reject.** This used to be caught and
    // turned into `null`, which the renderer reads as "cancelled" — so an `invoke` that
    // could not even serialise its argument looked exactly like the founder changing their
    // mind: the button did nothing, said nothing, and logged nothing on either side. The
    // renderer already has a sentence for a picker that failed; swallowing the error here
    // is what made it unreachable. `bridge.ts` catches this and shows it.
    return (await ipcRenderer.invoke(IPC_CHANNELS.pickVideoFile, startIn ?? null)) as string | null;
  },
  async pickSubtitleFile(startIn) {
    // Same contract as `pickVideoFile` above, and for the same reason a genuine failure is
    // allowed to reject: swallowing it here would make a broken picker indistinguishable
    // from the founder changing their mind. `bridge.ts` catches it and says so.
    return (await ipcRenderer.invoke(IPC_CHANNELS.pickSubtitleFile, startIn ?? null)) as
      string | null;
  },
  async openNetworkSettings() {
    try {
      return (await ipcRenderer.invoke(IPC_CHANNELS.openNetworkSettings)) as boolean;
    } catch {
      return false;
    }
  },
  answerQuestion(id, index) {
    // Fire-and-forget, like `send`. There is nothing to await: the answer either ends the
    // process or dismisses the question, and both arrive back as a new snapshot.
    ipcRenderer.send(IPC_CHANNELS.questionReply, { id, reply: index });
  },
  questionShown(id) {
    ipcRenderer.send(IPC_CHANNELS.questionReply, { id, reply: 'shown' });
  },
  async allowFirewall() {
    // Same rule: a bridge call that throws would put a stack trace in front of the founder
    // where a sentence belongs. Main logs the detail; this reports the outcome.
    try {
      return (await ipcRenderer.invoke(IPC_CHANNELS.allowFirewall)) as FirewallOutcome;
    } catch {
      return 'failed';
    }
  },
};

contextBridge.exposeInMainWorld('castgood', bridge);
