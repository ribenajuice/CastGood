import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import {
  allowFirewall,
  answerHostQuestion,
  canAllowFirewall,
  canPickFile,
  canPickSubtitleFile,
  openNetworkSettings,
  pickSubtitleFile,
  pickVideoFile,
  reportHostQuestionShown,
  sendIntent,
  subscribeToSnapshots,
  type WindowSnapshot,
} from './bridge.js';
import { AppWindow } from './components/AppWindow.js';
import { DevicePanel } from './components/DevicePanel.js';
import { FilePanel } from './components/FilePanel.js';
import { StatusRegion } from './components/StatusRegion.js';
import { FirewallPanel } from './components/FirewallPanel.js';
import { PreparationPanel } from './components/PreparationPanel.js';
import { SubtitlesPanel } from './components/SubtitlesPanel.js';
import { TransportPanel } from './components/TransportPanel.js';
import { INITIAL_SNAPSHOT } from './state/initial-snapshot.js';
import {
  buildViewModel,
  CHOOSE_FILE_ID,
  OFF_ID,
  type ActionId,
  type PickerState,
} from './state/view-model.js';

/**
 * The renderer's whole job: hold the latest snapshot, render it, send intents back.
 *
 * It holds no playback state of its own — not a position, not a device, not "we probably
 * paused". That is what makes "the app always shows what the device actually reported"
 * true by construction rather than by discipline. The only local state here is about the
 * file dialog, which is a window concern and not a fact about the TV.
 */
export default function App(): JSX.Element {
  const [snapshot, setSnapshot] = useState<WindowSnapshot>({
    ...INITIAL_SNAPSHOT,
    hostQuestion: null,
  });
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);
  // The subtitle dialog is a second picker and needs its own flags: the video picker being
  // open must not grey out the subtitle one, or the other way round.
  const [pickingSubtitle, setPickingSubtitle] = useState(false);
  const [subtitlePickError, setSubtitlePickError] = useState<string | null>(null);
  // Two more window concerns, and neither is a fact about the television: whether the
  // manual firewall instructions are on screen, and what the last elevation attempt did.
  const [firewallHelp, setFirewallHelp] = useState(false);
  const [firewallNote, setFirewallNote] = useState<string | null>(null);

  useEffect(
    () =>
      subscribeToSnapshots((next) => {
        // `revision` increments on every push, so a snapshot that arrives late can never
        // overwrite a newer one. Equal revisions are accepted: `requestSnapshot()` replays
        // the current one, and the engine's first push may still be revision 0.
        setSnapshot((previous) => {
          // The closing question must never be dropped by the revision guard: it is
          // stapled on by main and does not move the engine's revision, so a question
          // arriving beside an unchanged snapshot would otherwise be discarded.
          if (next.revision < previous.revision && next.hostQuestion === previous.hostQuestion) {
            return previous;
          }
          return next;
        });
      }),
    [],
  );

  const picker = useMemo<PickerState>(
    () => ({ available: canPickFile(), busy: picking, error: pickError }),
    [picking, pickError],
  );

  const subtitlePicker = useMemo<PickerState>(
    () => ({
      available: canPickSubtitleFile(),
      busy: pickingSubtitle,
      error: subtitlePickError,
    }),
    [pickingSubtitle, subtitlePickError],
  );

  const vm = useMemo(
    () => buildViewModel(snapshot, picker, subtitlePicker, snapshot.hostQuestion),
    [snapshot, picker, subtitlePicker],
  );

  // Tell main the question is actually on screen. Until this arrives it holds the close
  // open on a short deadline and then answers for us — which is what stops a renderer that
  // has crashed or never painted from leaving the app unclosable.
  const questionId = snapshot.hostQuestion?.id ?? null;
  useEffect(() => {
    if (questionId !== null) reportHostQuestionShown(questionId);
  }, [questionId]);

  useEffect(() => {
    document.title = vm.documentTitle;
  }, [vm.documentTitle]);

  const openPicker = useCallback(
    (startIn?: string) => {
      if (picking) return;
      setPicking(true);
      setPickError(null);
      void pickVideoFile(startIn)
        .then((outcome) => {
          switch (outcome.kind) {
            case 'selected':
              // Choosing a file sends nothing to any device; it only tells the engine what
              // is chosen. The Cast press is the only thing that reaches a TV.
              sendIntent({ type: 'file.select', path: outcome.path });
              return;
            case 'cancelled':
              // The previous selection is untouched (criterion 2b): we send nothing at all.
              return;
            case 'unavailable':
              setPickError('The file picker isn’t available in this build');
              return;
            default:
              setPickError('Couldn’t open the file picker. Try again.');
          }
        })
        .finally(() => {
          setPicking(false);
        });
    },
    [picking],
  );

  /**
   * One row of the subtitle menu was pressed — 18a, 18c, 19a.
   *
   * The two sentinel ids are mapped here rather than in the component, so the menu stays a
   * list of pressable things and this stays the only place that knows what a press means.
   * **Off is a `subtitles.clear`**, not a select with a null argument: the intent that turns
   * subtitles off must be impossible to confuse with the one that turns them on, exactly as
   * *Not now* and *Start* are two intents rather than one with a boolean.
   */
  const onSubtitleSelect = useCallback(
    (id: string) => {
      if (id === OFF_ID) {
        sendIntent({ type: 'subtitles.clear' });
        return;
      }
      if (id !== CHOOSE_FILE_ID) {
        sendIntent({ type: 'subtitles.select', sourceId: id });
        return;
      }
      if (pickingSubtitle) return;
      setPickingSubtitle(true);
      setSubtitlePickError(null);
      // Opens beside the film: a subtitle is nearly always in the folder its film is in.
      void pickSubtitleFile(snapshot.file?.path)
        .then((outcome) => {
          switch (outcome.kind) {
            case 'selected':
              sendIntent({ type: 'subtitles.chooseFile', path: outcome.path });
              return;
            case 'cancelled':
              // The film stays exactly as it was, without subtitles. Nothing is sent.
              return;
            case 'unavailable':
              setSubtitlePickError('The file picker isn’t available in this build');
              return;
            default:
              setSubtitlePickError('Couldn’t open the file picker. Try again.');
          }
        })
        .finally(() => {
          setPickingSubtitle(false);
        });
    },
    [pickingSubtitle, snapshot.file?.path],
  );

  const onAction = useCallback(
    (id: ActionId) => {
      switch (id) {
        // The closing question is answered by index, not by meaning: the words belong to
        // the host, which is also the only side that knows what each answer does.
        case 'quitAnswerSafe':
          if (questionId !== null) answerHostQuestion(questionId, 0);
          return;
        case 'quitAnswerOther':
          if (questionId !== null) answerHostQuestion(questionId, 1);
          return;
        case 'pick':
          openPicker();
          return;
        case 'relocate':
          // 15b: the dialog opens in the folder the file used to be in. Choosing the same
          // file back keeps the saved position; choosing a different one clears it.
          openPicker(snapshot.file?.path);
          return;
        case 'cast':
          sendIntent({ type: 'cast.start' });
          return;
        case 'resume':
          sendIntent({ type: 'cast.resume' });
          return;
        case 'stop':
          sendIntent({ type: 'cast.stop' });
          return;
        case 'play':
          sendIntent({ type: 'playback.play' });
          return;
        case 'pause':
          sendIntent({ type: 'playback.pause' });
          return;
        case 'firewallHelp':
          setFirewallHelp(true);
          return;
        case 'chooseDevice':
          // *Use a different device* (14a, 11c). The device list is already on screen and
          // already live, so this moves the founder to it rather than inventing a second
          // way to pick a TV that would then have to be kept in step with the first.
          document
            .querySelector<HTMLElement>('[data-devices] [role="radio"]:not([disabled])')
            ?.focus();
          return;
        case 'networkSettings':
          void openNetworkSettings();
          return;
        case 'confirmPreparation':
          // 7f: the founder read the three sentences and said yes. This is the press that
          // writes the first byte, and it is the only one that does.
          sendIntent({ type: 'preparation.confirm' });
          return;
        case 'declinePreparation':
          sendIntent({ type: 'preparation.decline' });
          return;
        case 'cancelPreparation':
          sendIntent({ type: 'preparation.cancel' });
          return;
        case 'allowFirewall':
          setFirewallNote(null);
          void allowFirewall().then((outcome) => {
            switch (outcome) {
              case 'allowed':
                // 17b in as many words: "casting **continues from where it was** without
                // re-picking the file or the device". So it continues — we do not ask the
                // founder to press anything. This used to set a note reading "The rule was
                // added. Press Cast to try again." on a screen that has no Cast button on
                // it, which is what checklist item 6 caught on 2026-08-19: the permission
                // was genuinely granted, the rules genuinely landed, and the founder was
                // left staring at an instruction they could not follow.
                //
                // The file and the device are still selected — that is the whole reason
                // this can be automatic — so the retry is exactly the Cast they already
                // pressed once. *Try again* is on the screen as well, for the manual route
                // through Windows' own settings, which nothing here can know the end of.
                {
                  // Elevation can sit on a UAC prompt for as long as the founder takes to
                  // answer it, and a television can leave discovery inside that window. An
                  // intent for a device that is no longer there is dropped by the engine,
                  // which would leave this note's ellipsis hanging forever over nothing
                  // happening. So the same guard the *Try again* button carries is checked
                  // here, and when it fails the note names what is missing instead.
                  const device = snapshot.discovery.devices.find(
                    (candidate) => candidate.id === snapshot.discovery.selectedDeviceId,
                  );
                  if (snapshot.file === null) {
                    setFirewallNote('The rule was added. Choose a video and press Cast.');
                    return;
                  }
                  if (device === undefined) {
                    setFirewallNote('The rule was added, but that device is no longer there.');
                    return;
                  }
                  // A firewall block can interrupt a resume, and the saved position survives
                  // it — so continue *from where it was*, which is 17b's actual wording, and
                  // not from the beginning of the film.
                  setFirewallNote('The rule was added — trying again…');
                  sendIntent(
                    snapshot.session.resumePositionSec >= 1
                      ? { type: 'cast.resume' }
                      : { type: 'cast.start' },
                  );
                }
                return;
              case 'declined':
                // A declined prompt is a decision, not a failure. The instructions stay.
                setFirewallHelp(true);
                setFirewallNote('Windows didn’t grant permission, so nothing was changed.');
                return;
              case 'unsupported':
                setFirewallHelp(true);
                setFirewallNote('This build can’t change the firewall for you.');
                return;
              default:
                setFirewallHelp(true);
                setFirewallNote('That didn’t work. The steps below do the same thing.');
            }
          });
          return;
        default:
          sendIntent({ type: 'discovery.rescan' });
      }
    },
    [openPicker, snapshot, questionId],
  );

  const onSeek = useCallback((positionSec: number) => {
    sendIntent({ type: 'playback.seek', positionSec });
  }, []);

  const onSkip = useCallback((deltaSec: number) => {
    sendIntent({ type: 'playback.skip', deltaSec });
  }, []);

  // M5a. Every step of a drag is sent, unlike a seek: an intermediate volume is a level the
  // founder is listening to right now. Nothing is coalesced here — 23a's throttle is the
  // television's own round trip and it lives in the engine, where it can be measured.
  const onSetVolume = useCallback((percent: number) => {
    sendIntent({ type: 'volume.set', level: percent / 100 });
  }, []);

  const onMute = useCallback((muted: boolean) => {
    sendIntent({ type: 'volume.mute', muted });
  }, []);

  // The firewall panel belongs to one state. Leaving it on screen after the founder has
  // moved on would be a stale instruction for a problem that is no longer there.
  useEffect(() => {
    if (vm.stateName === 'FirewallBlocked') return;
    setFirewallHelp(false);
    setFirewallNote(null);
  }, [vm.stateName]);

  const onSelectDevice = useCallback((deviceId: string) => {
    sendIntent({ type: 'device.select', deviceId });
  }, []);

  // Space plays and pauses from anywhere in the window, and is suppressed when a control
  // has focus so it doesn't double-fire. The design system's ± 30 s arrow keys live on the
  // scrubber itself, where they are a seek and not a global shortcut.
  useEffect(() => {
    const transport = vm.transport;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key !== ' ' && event.code !== 'Space') return;
      if (transport === null || transport.controlsDisabled) return;
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('button, a, input, select, textarea, [role="radio"]') !== null
      ) {
        return;
      }
      event.preventDefault();
      onAction(transport.toggle.id);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [vm.transport, onAction]);

  return (
    <AppWindow
      stateName={vm.stateName}
      main={
        <>
          {/*
            Wrapped, never passed bare. `onPick` is declared `() => void`, but React calls
            every click handler with the MouseEvent — so `onPick={openPicker}` handed the
            event to `openPicker(startIn?)`, which forwarded it to the IPC bridge, which
            could not structured-clone a SyntheticEvent and threw. The button did nothing,
            silently, and no other picker route was affected because they all wrap.
            Every other handler in this app wraps for the same reason. Keep it that way.
          */}
          <FilePanel
            file={vm.file}
            pick={vm.pick}
            onPick={() => {
              openPicker();
            }}
          />
          <StatusRegion
            tone={vm.tone}
            headline={vm.headline}
            sub={vm.sub}
            hairline={vm.hairline}
            actions={vm.actions}
            onAction={onAction}
          />
          {vm.preparation !== null && <PreparationPanel preparation={vm.preparation} />}
          {vm.stateName === 'FirewallBlocked' && (
            <FirewallPanel
              note={firewallNote}
              showSteps={firewallHelp}
              canAllow={canAllowFirewall()}
            />
          )}
          {vm.transport !== null && (
            <TransportPanel
              transport={vm.transport}
              onAction={onAction}
              onSeek={onSeek}
              onSkip={onSkip}
              onSetVolume={onSetVolume}
              onMute={onMute}
            />
          )}
          {/* **Below the transport row** (§10), and both approved mockups draw it last.
              It used to sit between the file name and the status region, which pushed the
              one place the app is allowed to speak down the window on every screen with a
              file chosen — and did it worst on the screens where that sentence matters
              most. It is also the biggest single input to 22b, whose approved overflow
              measurement was taken with this panel here. */}
          {vm.subtitles !== null && (
            <SubtitlesPanel
              subtitles={vm.subtitles}
              onSelect={onSubtitleSelect}
              onCancelPreparing={() => {
                sendIntent({ type: 'subtitles.clear' });
              }}
              onRetry={() => {
                sendIntent({ type: 'subtitles.retry' });
              }}
              onNudge={(steps) => {
                sendIntent({ type: 'subtitles.nudge', steps });
              }}
              onResetTiming={() => {
                sendIntent({ type: 'subtitles.resetTiming' });
              }}
            />
          )}
        </>
      }
      devices={
        <DevicePanel
          devices={vm.devices}
          onSelect={onSelectDevice}
          onRescan={() => {
            onAction('rescan');
          }}
        />
      }
    />
  );
}
