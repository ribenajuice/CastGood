# Design system

*Owned by the ui-designer agent; law for the frontend-developer.*

> **Sections 1–9 define how the app behaves and what it says. Section 10 defines how it looks** — filled in by the M4 visual pass on 2026-08-30, against the direction the user chose that day ("dark surface · warm accent · big type"). Visual design was deliberately deferred until the app genuinely cast (see `docs/DECISIONS.md`, 2026-08-13); it no longer is. **Sections 1–9 did not move in that pass**, and section 10 changes no behaviour and no copy.
>
> **Sections 1, 2, 7 and 8 did move on 2026-08-30, in M4's step 0** — a separate pass, before the restyle rather than inside it, which is what the visual pass's own flag asked for. It added **eight subtitle rows to §2** (M3c shipped surfaces this file had never named) and **corrected §1's window sizing** against what `main.ts` has always enforced. It adds **no behaviour and no copy**: every sentence in the new rows is already on screen today, and every number in the corrected table is either read from the code or is the user's decision of that day. §7 and §8 changed only where they referred to the retired 840 px breakpoint.
>
> **Step 0b, the same day**, closed the last of it: the user ruled that a film with no subtitles says **nothing at all**, which turned §2's one open flag into a decision; and the two designs still missing a screen — `WaitingForConversion` and the **closing question** — were drawn in the state map. Drawing the second surfaced a contradiction this file has carried since 2026-08-18 and cannot settle on its own: **the app has exactly one modal, and §1, §7 and §10 all say it has none.** It is flagged in §1 for the user and nothing was changed to hide it.
>
> **Section 11 was added on 2026-09-07** for M5a's volume control — the first component this file has gained since M4. It adds **no state, no vocabulary, no sentence in the StatusRegion and no token**: volume is a control's *value*, not a thing the app says (criterion 23k). §7 gains two rows and §11 is their entry; **nothing in §§1–10 moved.**
>
> **The clickable state map is the reference implementation of everything below:** `docs/mockups/state-map.html`. If the doc and the mockup disagree, the mockup is a bug report against one of them.

---

## 1. What the app is made of

One window. No modals, no dialogs, no toasts, no notification stack. Everything the user needs to know appears in one of four regions, always in the same place.

```
┌─ TitleBar ──────────────────────────────────────────────┐
│ CastGood — Converting 34%                        – ▫ ✕  │
├──────────────────────────────────────┬──────────────────┤
│ FilePanel        (what's chosen)     │  DevicePanel     │
│                                      │  (where it goes) │
│ StatusRegion     (what's happening)  │                  │
│                                      │                  │
│ TransportPanel   (what you can do)   │                  │
└──────────────────────────────────────┴──────────────────┘
```

**Window sizing** *(corrected 2026-08-30 — see the correction note below)*

| | Value |
|---|---|
| Minimum | **880 × 720** — enforced by `BrowserWindow.minWidth/minHeight` |
| Default on first run | **1100 × 720** |
| Layout breakpoint | **None.** The DevicePanel is a 240 px rail at every size the app can be |
| Remembered | Size and position persist in `settings.json` |

880 × 720 is the point at which the device rail, a status message at the M4 type scale and the transport row all still fit without truncation. Below that we would have to hide something, and the one thing this app must never do is hide the state it's in.

**Correction, 2026-08-30 — this table said three things the app has never done.** It is corrected rather than quietly overwritten, because a reader has to be able to see that it moved and why.

| Was | Is | Why it changed |
|---|---|---|
| Minimum **760 × 560** | Minimum **880 × 720** | **880 is not a decision, it is a reading.** `src/main/main.ts` has enforced `minWidth: 880` for as long as the window has existed; 760 was never true. **720 is the decision.** The user's approved StatusRegion floor is **184 px** at the M4 type scale, and it does not sit comfortably in 560 px of window alongside the FilePanel and the transport row. Story 22 is *"readable from the sofa"*, and §10's direction buys legibility with size: **room is never bought by shrinking type.** So the floor rises to the height the app already opens at. The founder settled the cost the same day — *"modern day monitors shouldn't be a concern with this, I would expect a minimum available display of 1080p"* — and on a 1080p display 720 px leaves roughly 300 px of headroom. The floor costs nobody anything. |
| Default **1000 × 680** | Default **1100 × 720** | `main.ts` opens at 1100 × 720 and always has. The doc was describing a window nobody has ever seen. |
| Layout breakpoint below **840 px** | **Retired — it was unreachable** | The stacked layout is implemented (`AppWindow.tsx`, `max-[840px]:flex-col`) but **no founder can reach it by resizing**, because `minWidth` is 880. It has been dead code since the minimum went to 880. The device column is a 240 px rail at every size the app can be, and the doc now says so. |

**The minimum window is now 880 × 800, and CastGood requires a 1080p display** *(founder, 2026-09-04)*. The tallest state the app holds persistently — a film playing with the subtitle panel closed — measures **735 px of content**, which the old 720 px floor clipped. Rather than add a browser to the test stack to measure overflow, the user chose to **prevent** it: the display requirement is stated in the README, and the window cannot be dragged below a size the layout fits in. Criterion 22b is satisfied by construction. **A new panel in the main column owes that arithmetic again** — the sum is in `src/main/main.ts` beside the number.

**Two code changes were owed by the 2026-08-30 correction, and M4 step 2 made both** *(2026-09-04)*: `minHeight` is now **720** in `src/main/main.ts`, and the dead `max-[840px]` branch is gone from `src/renderer/components/AppWindow.tsx`. The app's floor is **880 × 720**, the size every M4 design is drawn for, and there is exactly one layout in the bundle. `test/design/overflow.test.ts` asserts the height, having been written to fail on the day it changed.

**What this correction supersedes elsewhere in this file:** §7's note that `AppWindow` *"owns the `.narrow` breakpoint at 840 px"*, §8's *"240 px fixed above the breakpoint"*, and §10's type-token clause putting the status headline at *"24 px below the 840 px breakpoint"*. All three are updated in place. The last one is worth saying out loud: with the breakpoint gone, the status headline is **28 px at every reachable size**, which is what story 22's own floor already required of it.

**The rule the four regions exist to enforce:** there is exactly one place that answers "what is happening right now" — the StatusRegion. Nothing else is allowed to announce anything. No second banner, no growl, no red dot in a corner. If it's worth saying, it's worth saying in the one place the user is already looking.

**Resolved 2026-08-30 — the user chose in-window, and §1 now means what it says.** Step 0 found that the **closing question** — one question asked before the app closes, in three variants — was an Electron message box, and therefore the single modal in a product whose §1, §7 and §10 all say there are none. The contradiction was not M4's: the ADR of **2026-08-18** that created the question says it in its own consequences. Put to the user, the ruling was **"make it in-window, no modals"**. The question is now a state in the window like `ConfirmLongPrepare`, answered where it is asked; `dialog.showMessageBox` appears nowhere under `src/`, and a test fails the build if it returns. See the ADR of 2026-08-30 in `docs/DECISIONS.md`. **The three variants in `docs/mockups/state-map.html` are still drawn as the old overlay and are owed a redraw before M4 step 4.**

*One standing carve-out, and it is not a modal of ours:* Windows' own **file pickers** (`showOpenDialog`) are OS surfaces raised by the operating system, not CastGood screens. They are not in scope for this rule and never were.

---

## 2. State vocabulary

These are the names to use in code, in logs, in QA, and in conversation with the user. The engine's state machine enum matches column 1; column 2 is what the user is ever shown.

### Setting up
| Engine state | Founder-facing | Kind |
|---|---|---|
| `IdleSearching` | Nothing chosen yet / *Looking…* in the device column | steady |
| `IdleNoDevices` | No devices found on this network | steady, self-clearing |
| `IdleDevices` | Nothing chosen yet | steady |
| `Checking` | Checking what this file needs… | transient ≤3 s |
| `ReadyNative` | Ready to cast | steady |
| `ReadyPrepared` | Ready to cast — *prepared on 3 August* | steady |
| `NeedsRepackage` | Ready in about 20 seconds | steady |
| `NeedsConvert` | Needs converting — about 6 minutes | steady |
| `NeedsConvertLong` | Needs converting — about 1 hour 20 minutes | steady |
| `ConfirmLongPrepare` | That's a long job — about 1 hour 20 minutes | steady (a decision) |
| `Impossible` | This file can't be cast | needs you |

### Getting it on the TV
| Engine state | Founder-facing | Kind |
|---|---|---|
| `Connecting` | Connecting to *Living Room TV*… | transient |
| `ConnectFailed` | Couldn't reach *Living Room TV* | needs you |
| `FirewallBlocked` | Windows Firewall is blocking CastGood | needs you |
| `Repackaging` | Preparing — about 20 seconds left | transient, measured |
| `Converting` | Converting — about 5 minutes left | transient, measured |
| `Loading` | Starting on *Living Room TV*… | transient ≤5 s |
| `DiskFull` | Not enough space to prepare this file | needs you |
| `PrepareFailed` | Couldn't prepare *&lt;file&gt;* | needs you |

### Watching
| Engine state | Founder-facing | Kind |
|---|---|---|
| `Buffering` | Buffering… | transient |
| `Playing` | Playing on *Living Room TV* | steady |
| `PlayingUnprepared` | Playing on *Living Room TV* + *Still converting — 61%* | steady |
| `Paused` | Paused | steady, indefinite |
| `Seeking` | Seeking… | transient ≤2 s |
| `FrontierHold` | Still preparing — back in about 40 seconds | transient, self-clearing |
| `WaitingForConversion` | Still preparing — this film will play when the conversion is done, in about 12 minutes | transient, self-clearing |
| `Ended` | Ready to cast — **the screen the app opens on** | steady |
| `Stopped` | Stopped | steady |

### When it goes wrong
| Engine state | Founder-facing | Kind |
|---|---|---|
| `Reconnecting` | Reconnecting to *Living Room TV*… | transient, self-healing |
| `LostConnection` | Lost connection to *Living Room TV* | needs you |
| `Yielded` | *Living Room TV* is now playing YouTube | needs a decision |
| `NetworkDown` | This PC has lost its network connection | transient, then offers help |
| `SourceGone` | The original file is no longer where it was | needs you |
| `Reattaching` | Picking up where you left off on *Living Room TV*… | transient ≤5 s |

**The two held-picture states** *(M3b, 2026-08-21)* are the guard holding the film while the
conversion catches up (criterion 10i) and the same guard when the conversion cannot catch up
at all (10f). They are one state to the user — *Still preparing* — and two names in code
so QA can tell "it comes back by itself" from "it comes back when the job is done".

**Their sentences are the engine's and are rendered verbatim**, because they carry an
estimate that restates itself as it changes and one number must not be rounded in two
places. The founder chose the wording on 2026-08-21 over *Waiting for the converter to catch
up*: "preparing" is the vocabulary the rest of the app already uses for this work, so a held
picture reads as the same job continuing rather than a new kind of problem. It is
deliberately **never *Buffering*** — criterion 11e turns a *Buffering* longer than 10 s into
a reconnection attempt, and a hold is routinely longer than that, so that word here would
tear down a healthy connection to fix a problem that was never the network's.

### Subtitles *(M3c — added 2026-08-30, and owed since M3c shipped)*

The four groups above predate M3c, so until today none of M3c's eight surfaces had a name here. That is what made eight of M4's forty-five designs unbuildable: a screen cannot be restyled against a vocabulary that does not mention it. These rows close that, and they add **no behaviour and no copy** — every sentence below is already on screen today.

| Engine state | Founder-facing | Kind |
|---|---|---|
| `SubtitlesOffered` | **Off** — the film's own text tracks, any file beside it, and *Choose a file…* behind it | steady |
| `SubtitlesNoneFound` | **Off** — and only *Choose a file…* behind it | steady |
| `SubtitlesPictureOnly` | *Track 3 — These subtitles are pictures rather than words, so they can't be sent to a television.* | steady (a stated refusal) |
| `SubtitlesPreparing` | Preparing subtitles… | transient ≤5 s |
| `SubtitlesOn` | *Subtitles: English* | steady |
| `SubtitlesTiming` | Timing: in sync · Timing: +0.6 s · Timing: +0.6 s, as you set it last time | steady (a setting) |
| `SubtitlesUnreadable` | CastGood couldn't read that subtitle file. | steady (a refusal) |
| `SubtitlesNotLoaded` | Subtitles didn't load. | steady |

**These eight are surfaces of the subtitle panel, not members of the session enum**, and this is the one place in §2 where column 1 is not a state-machine name. The opening sentence of this section — *"the engine's state machine enum matches column 1"* — holds for the thirty-four rows above and cannot hold here, because **M3c added no session state**. Each name is instead a **predicate over `SubtitlesSnapshot`** (`src/engine/protocol/snapshot.ts`), written out so a checker that enumerates the engine can reach these the way it reaches the rest, rather than trusting a hand-kept list:

| Name | True when |
|---|---|
| `SubtitlesOffered` | `options.length > 0` · `selectedId === null` · `preparing === false` · `problem === null` |
| `SubtitlesNoneFound` | `options.length === 0` · `unavailable.length === 0` |
| `SubtitlesPictureOnly` | `unavailable.length > 0` — each entry carries its own finished `why` |
| `SubtitlesPreparing` | `preparing === true` |
| `SubtitlesOn` | `selectedId !== null`; and `session.subtitleLabel !== null` once the film is on the television |
| `SubtitlesTiming` | `selectedId !== null` — the timing control exists exactly when a source does |
| `SubtitlesUnreadable` | `problem !== null` · `canRetry === false` |
| `SubtitlesNotLoaded` | `problem !== null` · `canRetry === true` |

**None of the eight is *needs you*, and that is a decision rather than an oversight.** *Needs you* is defined below as *"the app has genuinely failed and cannot proceed alone"*, and its treatment is a heavier border **on the StatusRegion**. No subtitle surface ever occupies the StatusRegion — §1's single-speaker rule is about what is happening to *the film*, and in all eight of these the film is either ready to cast or playing perfectly. A subtitle that cannot be used costs the user one press to choose another; it does not cost them the evening. This is the row-level grading of criterion 21g, and it is why §10's `--error` list stays at seven states and gains none of these.

**`SubtitlesUnreadable` is one row and four sentences.** The engine picks between them by failure kind and renders each verbatim; the design treatment is identical for all four, which is what makes them one row rather than four:

- *CastGood couldn't read that subtitle file.* — `unreadable`
- *There are no subtitles in that file.* — `no-cues`
- *CastGood couldn't get those subtitles out of this film.* — `extract-failed`
- *Those subtitles are no longer where they were.* — `source-missing` (18f)

A fifth failure kind, `cancelled`, says **nothing at all**: the user chose something else, and reporting their own action back to them as a problem would be a fault.

***Moving the subtitles…*** **is not a ninth surface.** It is the sub-line that `SubtitlesOn` and `SubtitlesTiming` both grow while a change is costing one reload at the user's place — `SubtitlesSnapshot.reloading`, true for exactly two things: a source chosen mid-film, and an offset past the ±3 s the declared ladder covers. It is transient, it is **stated rather than hidden** (the condition the user accepted the reload under, 2026-08-26), and it never changes the kind of the row it appears in.

**`SubtitlesNoneFound` says nothing, and that is settled — user's ruling, 2026-08-30:** *"Dont bother showing anything if there are no subtitles, just the ability to add one should I be bothered to find my own file for it."*

So a film with no text tracks and nothing beside it shows exactly what every other film shows — a control reading **Off**, with *Choose a file…* behind it. **No sentence, no empty state, no hint, no greyed row.** The absence *is* the design, for the reason §6 already gives: *"No subtitles found"* is failure language for a fact that is not a failure, and it would make an ordinary film look as though something had gone wrong with it. This row is therefore the one surface in the product whose entire design is **that nothing is added**, and a future pass that "fills the gap" with a helpful line would be undoing a decision rather than improving a screen.

**Three kinds, and they are visually distinguishable at a glance:**

- **Transient** — the app is working. Pulsing dot beside the headline; an indeterminate hairline or a real progress bar; at most a Cancel button.
- **Steady** — nothing is happening until the user acts. No motion at all. One primary button.
- **Needs you** — the app has genuinely failed and cannot proceed alone. Heavier border on the StatusRegion; at least two buttons, one of which is the obvious next move.

There is no fourth kind. In particular there is no "error" kind, because *Yielded* and *SourceGone* are not errors and must not look like them.

---

## 3. Waiting and progress

The most-used part of this document. A waiting screen that lies is worse than a slow app.

1. **No unqualified spinners, anywhere.** Every wait names the activity and, where possible, its end.
2. **Under 3 seconds → text only.** One line ("Checking Interstellar.mkv…") plus a pulsing dot. No progress bar — a bar that fills in two seconds is decoration.
3. **Over 3 seconds with a measurable end → determinate bar.** Percentage on the left of the bar, what happens next on the right ("Casting starts automatically", "Ready up to 1:12:40"). Plus a coarse time remaining in the headline.
4. **No measurable end → named activity + hairline + a promise.** "Reconnecting to Living Room TV… Your place is held at 0:32:10." The founder must always be able to read what will happen if it works.
5. **Estimates are coarse and only ever count down.** `about 1 hour 20 minutes` → `about 6 minutes` → `about a minute` → `about 20 seconds` → `a few seconds`. Never `4:37 remaining`. If the underlying number rises, hold the last one shown rather than climbing. Precision is proportional to size: under a minute rounds to 5 seconds, minutes round to 1 minute, anything over 45 minutes rounds to 5 minutes.
6. **If an estimate is overrun**, say so once and re-estimate ("Taking longer than expected — about 2 more minutes"). Never freeze at 99 %.
7. **Anything over 2 seconds is cancellable**, and cancel is instantaneous and leaves nothing behind.
8. **Long waits are backgroundable.** The window title carries the percentage (`CastGood — Converting 34%`) so a minimised app still reports itself in the taskbar.
9. **When a wait ends well, say so for ~2 seconds** ("Back on Living Room TV") before returning to the normal state. Silence after a wait reads as a crash.
10. **Two numbers, when a conversion has a head start.** *"Converting — about 25 minutes left"* is when the **job** ends; *"Watching starts in about 4 minutes"* is when the **film** does, and on a long film they are twenty minutes apart. Both are said during the wait, and the second is the one the user is actually waiting for. It is said only when it is honest — a repackage, a job too young to have measured a speed and a film shorter than the head start all have nothing to say here, and say nothing.
11. **A wait that has become a problem gets a number or a button, never both absent.** `FrontierHold` shows a countdown; `NetworkDown` grows a "Open Windows network settings" button after 30 seconds.

### The long-preparation threshold

**Preparation is one press, unless the estimate exceeds 20 minutes — then it is one press plus one confirmation.**

Why 20 minutes: below it, preparation is an audio-only fix running at roughly 25–30× real time, the head start arrives within about half a minute, and you are watching almost immediately — a confirmation there is pure friction on the common path. Above it, the job is a genuine picture re-encode at 1.5–3× real time, which means three things change character at once: it runs for a large part of the evening, it occupies several GB of disk while it works, and — the one that actually matters — **the head start itself now takes minutes, so you sit and wait before anything appears on the TV.** 20 minutes of total estimate is where that crossover happens (a 10-minute head start at under ~6× real time is over 100 seconds of waiting). The threshold is really "you will have to wait before you see a picture", expressed as the number the user can check.

The confirmation is a **state, not a dialog** — this product has no modals. `NeedsConvertLong` carries a trailing-ellipsis primary ("Prepare and cast…", the standard signal that another step follows) and leads to `ConfirmLongPrepare`, which states the only three things that decide the answer:

1. when you can start watching,
2. how much disk it will use while it works,
3. that cancelling means starting again.

"Not now" returns to the verdict with the file still chosen. Nothing is written to disk before "Start converting".

`LONG_PREP`, like `HEAD_START` and the frontier margin, is a named constant in one file.

---

## 4. Recovery

The single biggest contributor to whether this app feels reliable.

**The governing rule (PRD):** recover silently first; tell the user only if recovery fails.

- **Recovery keeps the screen still.** During `Reconnecting`, everything — file name, device, scrubber, position — stays exactly where it was. Only the StatusRegion headline changes. Nothing is cleared, nothing moves, nothing turns red, nothing opens on top.
- **Recovery is stated, not dramatised.** A pulsing dot and a hairline. No warning triangles, no error colour, no sound, no shake.
- **Retry counts are never shown.** "Attempt 2 of 3" makes a working recovery look like a struggle. The engine retries twice on connect and backs off for 30 s on a dropped socket; the UI says one thing throughout.
- **The position is always stated as a number** in any recovery or failure message. "Your place is held at 0:32:10" is the sentence that stops the user feeling they've lost the evening.
- **Escalation is time-based and single-step.** Working → (30 s) → needs you. There is no middle warning state.
- **Success gets a two-second acknowledgement** and then disappears.
- **Never fight for a device.** If another app takes it, yield immediately and say so as a fact.
- **Never empty a list to signal a problem.** During a PC network outage the device list dims; it does not clear. Clearing it would make a 5-second blip look like the whole house vanished.

---

## 5. Moving around the film — skip, drag, and the conversion frontier

The scrubber has to communicate a limit that only exists sometimes, without the limit feeling like a fault.

Anatomy, back to front:

| Layer | Meaning |
|---|---|
| Track | The **true** full duration, always — read from ffprobe, never from the receiver, which under-reports while a playlist grows |
| Prepared fill (mid-grey) | How much has been converted so far |
| Hatched region | Not converted yet — visually inert, `cursor: not-allowed` |
| Limit tick (solid hairline) | The furthest you may jump: **frontier − 2 minutes** |
| Played fill (dark) | Current position |
| Handle | Current position |

Behaviour:

- **The handle clamps at the limit.** Dragging into the hatched region moves the handle to the tick and no further. It stops feeling like a rejected instruction and starts feeling like the end of what exists — which is the truth. **The *handle* clamps here; the *value* is clamped by the engine** (M3b, 2026-08-21): the release sends where the user actually pointed, the engine refuses anything past `frontier − 2 min` and reports the refusal, and that report is what sharpens the line below. One authority on where a seek may land, and the receiver's own live-edge clamp behind it.
- **One line of explanation sits under the scrubber**, permanently while the region exists: *"You can jump ahead to 1:10:20 for now — the rest is still converting. This moves as it goes."* On an attempted overshoot it becomes the sharper *"That part isn't ready yet…"* for four seconds.
- **The limit visibly moves.** The founder can watch it travel to the right. That single fact is what turns the limit from a bug into a mechanism.
- **Dragging sends nothing.** Only the position on release is issued; a further release while a seek is in flight replaces the single pending target.
- **The readout holds the requested position** until the device confirms or 2 seconds elapse. It must never flick back to the old position — that reads as a failed seek even when the seek succeeded.
- **Seeking while paused stays paused.**

### Skip: back 30 seconds / forward 30 seconds

Two buttons flanking Play/Pause, in the order **Back 30s · Play/Pause · Forward 30s · Stop**. (This is the one place a primary button is not leftmost — the transport cluster is ordered by spatial metaphor, not by priority.) Discrete jumps only; there is no press-and-hold rewind or fast-forward, and no other skip sizes.

**Coalescing — the reliability-critical part.** Every seek is a network round trip to the TV. Four quick taps firing four seeks is how casting apps stutter and land in the wrong place, so taps never issue commands directly:

- A tap adds ±30 s to a single **pending target**, clamped, and starts a **400 ms settle timer**. Each further tap replaces the target and restarts the timer.
- After 400 ms of quiet, **one** `SEEK` is issued for the final target. Four taps = one two-minute jump, one round trip.
- Taps arriving while a seek is already in flight open a new pending target rather than queueing a second command — the same single-pending-target slot the drag path uses.
- 400 ms is chosen because deliberate repeated tapping runs at roughly 150–250 ms intervals, so it reliably catches a run without extending it, and it is small next to the 2 s the seek itself is allowed to take. It is a named constant (`SETTLE`).

**Feedback while taps accumulate** — the user must be able to see where they are heading before it commits:

| Element | During accumulation |
|---|---|
| Position readout | Shows the **destination**, not the current position |
| Delta chip | Appears beside it: `+1:30`, `−2:00` — the running total of this run of taps |
| Scrubber handle | Moves to the destination |
| Played fill | Stays where the TV actually is |
| Band between them | Hatched — that's the jump you've asked for and haven't sent yet |
| Status region | Unchanged. It does **not** flip to *Seeking* per tap; that would be four state changes for one action |

On commit the state becomes `Seeking` (≤2 s) exactly as a drag-release does, then returns to whatever it was — playing to playing, paused to paused.

**Clamping.** Skip clamps at both ends and a clamped press must never read as a malfunction:

- **Forward into the unconverted region** lands you exactly *on* the limit (frontier − 2 min). The delta chip shows the real jump (`+18s`, not `+30s`) and the line under the scrubber says *"Jumped as far as it's converted — 1:10:20. The limit moves as it goes."* The press visibly did something, and the smaller-than-asked amount is explained rather than silently swallowed.
- **Back below zero** lands at 0:00 with *"Back to the start."* Never an error, never a no-op.
- **Forward past the end** of a fully-prepared file lands at the end.

**Availability by state** — stated, not implied:

| State | Back 30s | Forward 30s | Reason |
|---|---|---|---|
| `Playing`, `PlayingUnprepared` | ✅ | ✅ (clamps at frontier) | — |
| `Paused` | ✅ | ✅ | Moves the position, stays paused |
| `Buffering` | ✅ | ✅ | Deliberate. Jumping away is the most effective escape from a bad buffer; removing it at the moment it is most wanted would be perverse |
| `Seeking` (in flight) | ✅ | ✅ | Required for coalescing to work at all — taps join a new pending target |
| `FrontierHold`, `WaitingForConversion` | ✅ | 🚫 *"Still preparing"* | Back is a real escape and resolves the hold instantly; forward is precisely the thing that can't work — during a hold everything ahead is inside the margin the guard is defending, so a forward jump would clamp *backwards*, into film already watched. Play/Pause is unavailable for the same span (*"It starts again by itself"*); **Stop stays live throughout** |
| `Reconnecting`, `LostConnection`, `Yielded`, `NetworkDown` | 🚫 | 🚫 | No connection to send a seek over. Skips are **refused, not queued** — promising a jump we can't send yet would be a lie about what will happen. The reason already sits beside the transport row |
| `Ended`, `Stopped`, `SourceGone` | hidden | hidden | The TV has been released; there is no session to skip inside. Getting back into the film is *Play again* / *Resume from 0:32:10*'s job |
| Idle and verdict states | not rendered | not rendered | No transport row at all |

**Unavailable ≠ unavailable.** Two different treatments, and the distinction matters here more than anywhere else in the app:

- **Momentarily unavailable** (forward at the frontier, back at 0:00) → `aria-disabled="true"` plus muted styling, click is a no-op, **keeps keyboard focus and its place in the tab order**. The frontier advances continuously, so this control flickers in and out of reach; a control that drops out of the tab order under the user's finger is worse than one that says no.
- **Structurally unavailable** (Pause and Stop during a dropout) → real `disabled`.

### Keyboard

These get used constantly, so they work anywhere in the window rather than needing a control focused first.

| Key | Does |
|---|---|
| `←` / `→` | Back / forward 30 s — same coalescing, same clamping, same feedback as the buttons |
| `Shift` + `←` / `→` | ± 5 minutes |
| `Space` | Play / pause (suppressed when a button has focus, so it doesn't double-fire) |
| `Home` / `End` | Jump to start / end — scrubber only, when focused |

Arrow keys are owned by the window handler, not the scrubber, so there is exactly one implementation and the two can't drift apart.

---

## 6. Voice and tone

**Plain, calm, specific, and short.** The founder is a product manager at 9 pm with a film to watch, not a person reading a manual.

- Write in the second person to the user, and in the third person about devices: *"Living Room TV is now playing YouTube."*
- **Name the device, every time.** "Connecting to Living Room TV" — not "Connecting to device". The name is what makes it feel real and local.
- **Lead with the outcome, not the mechanism.** *"Ready in about 20 seconds"*, not *"Remuxing container"*. Mechanism goes in one explanatory sentence underneath, in ordinary words, or nowhere.
- **Never show a codec, a container name, a file path, a port, an IP, an error code, or an ffmpeg line.** Those go to the log. The single exception is a drive letter in a disk-space message, because the user needs it to act.
- **State facts as facts.** "Someone else is using the TV" is not a failure and does not get failure language.
- **Say what happens next, in the same breath as the problem.** Every message that reports something is followed by the thing that fixes it.
- No exclamation marks. No apologies ("Sorry!", "Oops"). No blame ("You must first…"). No jokes. No emoji.
- Contractions yes ("Couldn't reach", "isn't ready yet").
- British English: *"recognise"*, *"colour"*.
- Numbers: durations as `H:MM:SS`; sizes in GB to one decimal; estimates always in words, never digits with a colon.

**Copy patterns**

| Situation | Shape | Example |
|---|---|---|
| Working, measurable | *Verb — time left* | "Converting — about 4 minutes left" |
| Working, not measurable | *Verb + device… / place held* | "Reconnecting to Living Room TV… Your place is held at 0:32:10." |
| Fact, not a fault | *Subject + what it's doing now* | "Living Room TV is now playing YouTube." |
| Genuine failure | *What failed + one reason + what you can do* | "Couldn't prepare Dune.mkv — the file looks damaged from about 48 minutes in." |
| Refusal (known ahead) | *Plain no + one reason + alternative* | "This file can't be cast. Its video is in a format CastGood can't convert." |
| Blocked control | *Greyed control + reason beside it* | "Choose a different video…  *Choosing another file would cancel this conversion*" |

---

## 7. Component inventory

React components under `src/renderer/components/`. All are pure functions of the engine snapshot pushed over IPC; none holds playback state.

| Component | Props (shape) | Notes |
|---|---|---|
| `AppWindow` | `snapshot` | Layout shell. **No breakpoint** — the 840 px stacked layout was retired on 2026-08-30 (§1) as unreachable, and its dead branch was deleted in M4 step 2 |
| `TitleBar` | `title, progressLabel?` | Appends `— Converting 34%` so a minimised app still reports itself |
| `FilePanel` | `file?, pickDisabledReason?` | Empty (dashed) or chosen; name, duration, size, folder |
| `StatusRegion` | `tone, headline, sub?, progress?, hairline?, actions[]` | **The only place the app speaks.** `tone: 'info' \| 'working' \| 'needsYou'`. `role="status" aria-live="polite"` |
| `ProgressBar` | `pct, leftLabel, rightLabel` | Determinate only. Never rendered without a real percentage |
| `Hairline` | — | Indeterminate; only ever alongside a named activity |
| `ActionRow` | `actions[]` | Max one `primary`; a `link`-styled action is always last and never load-bearing |
| `TransportPanel` | `position, duration, state, pendingTarget?, disabled?, disabledReason?` | Times + delta chip, `Scrubber`, `SkipButton` ×2, Play/Pause, Stop |
| `Scrubber` | `positionSec, durationSec, percent, canDrag, frontierPercent?, limitPercent?, seekLimitSec?, onSeek, onSkip` | Section 5. The **handle** clamps here; the value is clamped by the engine |
| `SkipButton` | `direction, seconds, available, unavailableReason?` | `aria-disabled` when momentarily unavailable — never real `disabled` |
| `SeekCoalescer` | hook: `useCoalescedSeek(settleMs, limit)` | Owns the pending target and the 400 ms settle timer. **The only thing allowed to issue a seek**, from buttons, keys and drag-release alike |
| `VolumeControl` | `level, muted, pending, stepInterval, available, unavailableReason?` | **§11.** Lives at the right-hand end of the `TransportPanel`'s button row, after the transport cluster. `level: number \| null` is the last level a receiver status reported and the **only** thing that positions the handle; `pending: number \| null` is the outstanding ask and draws the tick, never the handle. Real `disabled` only — it never takes the `aria-disabled` treatment |
| `MuteButton` | `muted, disabled` | **Its own control, never the slider at zero** (founder, 2026-09-07, question 42). 44 × 44, inline-SVG speaker at 24 × 24, `aria-label="Mute"` + `aria-pressed`. Same glyph rules as `SkipButton` |
| `DevicePanel` | `devices[], selectedId, discovery, dimmed?` | Radio group |
| `DeviceRow` | `device, selected, busyWith?` | 44 px min height; name + model + status tag |
| `EmptyDeviceState` | `networkName` | The two-item checklist; shows the PC's current wifi name |
| `DisabledReason` | `text` | Small muted text placed beside, never instead of, a disabled control |

**Not in the inventory, and never to be added without a new decision:** modal dialogs, toasts/snackbars, tooltips carrying required information, badge counters, a settings screen, a log viewer, tabs, a sidebar nav.

*`VolumeControl` and `MuteButton` were added on 2026-09-07 for M5a. **This needed no overrule** — the list above has never contained a volume control, which is why the PRD's build order asks for an inventory entry and nothing else. §11 is that entry.*

---

## 8. Layout primitives

Placeholder-era, but these survive the M4 restyle because they're structure, not decoration.

- **Spacing scale:** 4 / 8 / 12 / 16 / 24 / 32. Panel padding 12–16; gap between panels 14.
- **Regions** are bordered boxes with a single radius token. The StatusRegion has a minimum height (**184 px**, raised from 132 px by the user on 2026-08-30 when M4 was approved; 132 px was measured at the placeholder type scale and does not hold at M4's) so the layout does not jump as messages change length — states must not make the window twitch.
- **Line length** for explanatory text is capped at 62 characters.
- **Device column** is 240 px fixed at every size the app can be *(§1, corrected 2026-08-30 — there is no breakpoint below it any more)*.
- **One primary button per screen**, always the leftmost in the action row, always the thing the user most likely wants. *Exception:* the transport cluster orders by spatial metaphor (back · play · forward · stop), not by priority.
- **A primary button whose press leads to a further step ends in an ellipsis** — "Prepare and cast…", "Choose video…". A press that starts something irreversible never does.
- **Motion** is limited to two things: the pulsing dot and the sliding hairline. Both respect `prefers-reduced-motion`. Nothing else animates — no transitions between states, because a state change must be instantly legible, not eased.

## 9. Accessibility (applies now, not in M4)

- Every interactive control ≥ 44 px in its primary dimension.
- Visible focus ring on everything focusable; never `outline: none`.
- The StatusRegion is `role="status" aria-live="polite"` — and is only re-rendered when its text actually changes, so a 4 Hz position update never re-announces it or steals focus.
- The scrubber is a real `role="slider"` with `aria-valuenow`/`aria-valuetext`, full keyboard support, and an `aria-valuetext` that includes the pending jump (`"…Jumping +1:30"`) and the conversion limit when one exists.
- Skip buttons carry explicit `aria-label`s ("Back 30 seconds", "Forward 30 seconds") — the visible text is placeholder wording and will become a glyph in M4, at which point the label is the only thing a screen reader has.
- The accumulating jump is announced through the slider's `aria-valuetext` only, never as a separate live region — one action must not produce four announcements.
- The device list is a `radiogroup` of `radio`s.
- Disabled controls stay in the tab order's reading context with their reason adjacent, so the explanation is available to a screen reader.
- All state must be legible without colour, since colour carries no meaning today and must not start carrying it alone in M4.

---

## 10. Milestone 4 — the visual pass

*Filled in 2026-08-30 against the direction the user chose the same day: **"dark surface · warm accent · big type"**, over "quiet utility" (flat grey, near-invisible chrome) and "Windows-native" (Fluent/Mica/system accent). Audience: **"friends and family, if they ask"** — it must look deliberate, and it must not look alarming. No brand identity, no logo, no marketing surface.*

**Mockup: <https://claude.ai/code/artifact/97288e08-ccd9-4521-87cc-00e734ce43e4>** — six states, the real copy, theme-aware, plus the token, type, glyph and greyscale-proof panels. *The HTML source is written but not yet in the tree; it lands as `docs/mockups/m4-living-room-warm.html` in the PR that carries this pass, beside `state-map.html`.* Where the mockup and this section disagree, one of them is a bug report against the other — the same rule the state map already carries.

### Direction

**Living-room warm** — a dark, warm-neutral surface with one ember accent and type sized to be read from the sofa, so CastGood looks like something you watch films with rather than a utility you configure.

Three consequences, so the direction is testable rather than a mood:

1. **The window is dark by default in both themes' resting state and never has a large light area.** No white cards, no full-bleed brand panels, no lit chrome.
2. **Legibility is bought with size, not with light.** The status headline is 28 px; there is exactly one place the app speaks, so there is exactly one thing to grow.
3. **Neutrals are warm** (hue ≈ 35°, chroma held low), which is what stops a dark UI reading as "developer tool" without adding a single decorative element.

### The dark-room problem, and how it is resolved

The founder watches films in a dark room. The window must not glare, and the status line must still be readable at a glance from across the room. Those pull in opposite directions only if you assume readability comes from brightness. It does not — it comes from **angular size, stroke weight and the number of things competing for the eye**. So:

| Pressure | Resolution | Measured |
|---|---|---|
| The window must not glare | The largest area on screen is `--bg`, at **L\* 4.0** — about 0.45 % of the luminance of white. It never lightens; there is no state that fills the window with a lighter surface. | `--bg` relative luminance 0.0045 |
| …but it must still look like a designed object, not a black rectangle | Depth is a **three-step surface ramp** — L\* 4.0 → 10.6 → 15.2 — plus a 1 px hairline. Perceptually spaced steps, none of them bright. This is the line between "living-room warm" and the "quiet utility" direction that was rejected. | L\* steps of 6.6 and 4.6 |
| The status line must read from the sofa | It is the only line at `--text-xl` (28 px / 600), it sits at the top of the only region allowed to speak, and it measures **14.4:1** on its own surface. | — |
| …without a white blaze | Nothing in the dark theme is `#FFFFFF`. `--text` tops out at `#F4ECE1` (L 0.847), which removes the hard white edge that halates in the dark while still measuring 14.4:1. | — |
| The saturated accent must not become a lamp | `--brand` only ever appears as **one** filled button per screen (section 8's one-primary rule already guarantees this), plus the played fill of the scrubber, which is 10 px tall. | Lit pixels are a low single-digit % of the window |
| Dim things must still be reachable | `--text-muted` is held at **5.4:1**, not at an opacity. **No control and no sentence in this app is rendered by lowering opacity** — disabled states change colour token, never alpha, because a 42 % ghost in a dark room is unreadable at any distance. | — |

**The one thing this costs, stated plainly:** the light theme is the secondary theme. It is complete, it passes everything below, and it exists because Windows can be set to light and the app must not look broken there — but the design is drawn for the dark one.

### Colour tokens

One brand, one accent, a warm neutral ramp, three semantics. Everything else derives.

**Dark** (the default the direction is drawn for):

| Token | Value | Use | Measured contrast |
|---|---|---|---|
| `--bg` | `#100E0A` | Window ground, title bar | L\* 4.0 |
| `--surface` | `#211C15` | Panels: FilePanel, StatusRegion, TransportPanel, DevicePanel | L\* 10.6 (6.6 L\* above `--bg`) |
| `--surface-2` | `#2C251C` | The `needsYou` StatusRegion; the scrubber track bed | L\* 15.2 (4.6 L\* above `--surface`) |
| `--line` | `#3B3227` | Decorative separation only — panel edges, rules | 1.35:1 on `--surface` · **never the only thing identifying a control** |
| `--line-strong` | `#8A7C6A` | Any border that identifies a control or carries state | **4.17:1** on `--surface` · **3.72:1** on `--surface-2` |
| `--text` | `#F4ECE1` | Headline, body, file name, handle, limit tick | **14.44:1** on `--surface` · **16.46:1** on `--bg` · **12.92:1** on `--surface-2` |
| `--text-muted` | `#9C9084` | Meta, disabled reasons, bar right-label, travel hatch | **5.43:1** on `--surface` · **6.18:1** on `--bg` · **4.85:1** on `--surface-2` |
| `--brand` | `#E9A33F` | Primary action fill, progress fill, played fill | **7.87:1** on `--surface` · **8.97:1** on `--bg` · **7.04:1** on `--track` |
| `--on-brand` | `#1A1409` | Label on a `--brand` fill | **8.52:1** on `--brand` |
| `--accent` | `#FFC97A` | Focus ring, selected device row | **11.19:1** on `--surface` · **12.75:1** on `--bg` |
| `--success` | `#86C98D` | The 2-second acknowledgement (section 4), and nothing else | **8.66:1** on `--surface` |
| `--warn` | `#E3B341` | The overrun re-estimate (section 3, rule 6), and nothing else | **8.69:1** on `--surface` |
| `--error` | `#F2938A` | **`needsYou` only** — the 2 px StatusRegion border. Never `Yielded`, `NetworkDown` or `Reconnecting` | **6.71:1** on `--surface-2` · 7.50:1 on `--surface` |
| `--track` | `#2C251C` | Scrubber / progress bed | — |
| `--track-prepared` | `#7E7161` | Prepared fill, unconverted hatch stroke | **3.19:1** on `--track` |

**Light:**

| Token | Value | Use | Measured contrast |
|---|---|---|---|
| `--bg` | `#F6F1E9` | Window ground | L\* 95.3 |
| `--surface` | `#FFFDF9` | Panels | L\* 99.4 |
| `--surface-2` | `#EFE7DA` | `needsYou` region; track bed | L\* 91.9 |
| `--line` | `#E2DACC` | Decorative separation only | 1.37:1 on `--surface` |
| `--line-strong` | `#8C8071` | Control-identifying and state-carrying borders | **3.80:1** on `--surface` · **3.43:1** on `--bg` |
| `--text` | `#201B14` | Headline, body, file name | **16.83:1** on `--surface` · **15.21:1** on `--bg` · **13.93:1** on `--surface-2` |
| `--text-muted` | `#6B6053` | Meta, disabled reasons | **6.04:1** on `--surface` · **5.46:1** on `--bg` · **5.00:1** on `--surface-2` |
| `--brand` | `#9A4A10` | Primary fill, progress fill, played fill | **6.15:1** on `--surface` · **5.56:1** on `--bg` · **4.82:1** on `--track` |
| `--on-brand` | `#FFFFFF` | Label on a `--brand` fill | **6.25:1** on `--brand` |
| `--accent` | `#C25A12` | Focus ring, selected device row | **4.34:1** on `--surface` · **3.92:1** on `--bg` |
| `--success` | `#1F6B34` | The 2-second acknowledgement | **6.44:1** on `--surface` |
| `--warn` | `#8A5A00` | The overrun re-estimate | **5.83:1** on `--surface` |
| `--error` | `#A32015` | **`needsYou` only** | **6.17:1** on `--surface-2` · 7.45:1 on `--surface` |
| `--track` | `#E9E1D4` | Scrubber / progress bed | — |
| `--track-prepared` | `#857866` | Prepared fill, unconverted hatch stroke | **3.32:1** on `--track` |

**How these were arrived at, and how to check them.** Every ratio above is computed from the WCAG 2.1 relative-luminance formula (`0.2126R + 0.7152G + 0.0722B` over linearised sRGB) at the exact hex values in the table — not eyeballed, and not "AA-ish". The mockup carries the same arithmetic in a live panel so any future change to a token can be re-measured rather than re-argued.

Three rules that fall out of the numbers and are law:

- **Nothing in this app relies on the 3:1 "large text" allowance.** Every piece of text, at every size, is ≥ 4.5:1 against whatever it sits on. The allowance exists; we do not spend it.
- **`--line` is decorative and may never be the only thing identifying a control or a state — with exactly one exemption.** Anything load-bearing uses `--line-strong` (≥ 3:1) or a token above it. This is why the `needsYou` border is 2 px `--error` *and* a surface step, and why a secondary button's outline is `--line-strong`. **The exemption is the disabled control** *(founder, 2026-09-04)*: its 1 px `--line` boundary measures 1.35:1 and stays that way. What identifies a disabled control is **the sentence beside it** at `--text-sm`/`--text-muted`, 5.4:1, which §9 requires and which the app never omits — *"the app never shows a control that doesn't work; it disables it and says why"*. A dead control that shouts is worse than one that recedes, and criterion 21d was amended to match rather than the table being overruled.
- **Disabled means a different colour token, never a lower opacity.** `opacity` on a dark surface destroys measured contrast and cannot be stated in a table.

Two surfaces adjacent to each other (`--bg` / `--surface`) are separated by an L\* step and a hairline, not by a WCAG ratio — the standard requires no ratio between two decorative surfaces, and at these luminances the ratio is not the useful measure. The L\* steps are stated so the ramp can be checked.

### Type

Windows-only app, no network at runtime, so: **the system stack, at sizes chosen for a sofa.** No webfont, no self-hosted font, no icon font.

```
--font:      "Segoe UI Variable Text", "Segoe UI", system-ui, ui-sans-serif,
             Roboto, Helvetica, Arial, sans-serif
--font-mono: "Cascadia Mono", ui-monospace, Consolas, "Segoe UI Mono", monospace
```

*Segoe UI Variable is not the rejected "Windows-native" direction returning by the back door.* That direction was rejected for its **chrome** — Mica, Fluent controls, the system accent colour. None of those are here. The text face is simply the best-hinted face already on every machine this app will ever run on, and shipping a font file to render six sentences would be waste.

| Token | Size / line-height / weight | Use |
|---|---|---|
| `--text-xl` | **28 px** / 1.25 / 600, `-0.01em` | Status headline. **28 px everywhere** — the *"24 px below the 840 px breakpoint"* clause went with the breakpoint on 2026-08-30 (§1), and it was below story 22's own 28 px floor anyway |
| `--text-lg` | **20 px** / 1.35 / 600 | File name; the transport position readout (mono, tabular) |
| `--text-base` | **17 px** / 1.55 / 400 | Body, sub-lines, **primary** button labels |
| `--text-sm` | **15 px** / 1.45 / 400 | Meta, disabled reasons, progress bar labels, device model, duration readout, **secondary (`small`) button labels** *(founder, 2026-09-04 — *Search again*, *Cancel*, *Try again*, *Earlier · Later · Reset*: pressed at the PC, not read from the sofa. The mockup was approved drawn this way and criterion 22a was narrowed to match.)* |

- **`--text-base` is 17 px, not 16.** 16 is the floor; the direction is "big type"; one point of headroom costs nothing and is felt at three metres.
- **Timecodes are mono and `font-variant-numeric: tabular-nums`,** everywhere they appear, so a running position does not jitter its own width 4 times a second.
- **The `--text-sm` line is never the only carrier of an instruction.** Disabled reasons live at 15 px *beside* the control they explain, at 5.4:1 — they are short, adjacent and in the tab order's reading context (section 9), which is what makes 15 px acceptable for them and for nothing else.

### Shape and depth

**Radius: `--r: 8px`** — every region, panel and button. **`--r-pill: 999px`** for the scrubber track, the progress bar, the delta chip and the device radio; these are shapes, not a second radius step.

**Elevation: none.** No shadows anywhere. Depth is one step of surface luminance plus a 1 px `--line` hairline. In a dark room a shadow on a dark surface reads as a smudge, and the window has nothing overlapping anything — there are no modals, no menus over content, no toasts. The one control that opens over its own panel (the subtitle source list) opens *in flow*, pushing the panel taller, exactly as it does today.

### Motion — the two that exist, given parameters

No new motion. Section 8's two are parameterised so they can be built identically twice:

| | Parameters |
|---|---|
| **Pulsing dot** | 9 px, `--text`, `--r-pill`, `opacity 0.5 → 1.0 → 0.5` over 1.1 s `ease-in-out`. **The dim end is 4.58:1 against `--surface`** (dark) / 3.29:1 (light) — the trough is still legible, which is the point of a dot that says "working". `prefers-reduced-motion` → no animation, resting opacity 0.75 |
| **Sliding hairline** | 3 px, `--track` bed, a 32 %-wide runner in `--text-muted`, 1.5 s `ease-in-out`, left to right. `prefers-reduced-motion` → no animation, full-width runner at 50 % |

Nothing else animates. No transitions between states, no eased colour changes, no easing on the progress bar beyond the 0.18 s linear width it already has (which is smoothing a sampled number, not decoration).

### The two items parked under "Waiting for M4" — resolved

#### 1. The skip buttons become glyphs

Both become the conventional **circular arrow enclosing "30"**, drawn as **inline SVG**, 24 × 24 in a 44 × 44 button:

- One `<svg viewBox="0 0 24 24">`, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap="round"`. Back 30 is the anticlockwise arrow with its head at the top left; Forward 30 is its mirror. The two are **mirror images of each other**, so "which way does this go" is answered by shape at any size.
- The numeral is a real `<text>` element inside the SVG at `font-size: 10`, `text-anchor: middle`, in `--font`, `font-variant-numeric: tabular-nums` — not a path. It inherits the font stack and scales with the button, which is sized in `rem`, so a raised Windows text size grows the glyph with everything else.
- `aria-hidden="true"` on the `<svg>`. **The `aria-label`s are unchanged** — `"Back 30 seconds"` and `"Forward 30 seconds"` — and are now the only thing a screen reader has, exactly as section 9 anticipated.
- `currentColor` throughout, so the two unavailability treatments below need no second glyph.

**The two unavailability treatments, still distinguishable, still without colour** (section 5's *Unavailable ≠ unavailable*):

| | Fill | Border | Glyph | Focus |
|---|---|---|---|---|
| Available | none | 1 px `--line-strong` | `--text` | in tab order |
| **Momentarily** unavailable (`aria-disabled`) | none | 1 px `--line` | `--text-muted` (5.4:1 — still readable) | **stays in tab order**, still shows a ring |
| **Structurally** unavailable (real `disabled`) | **fill removed if it had one** | 1 px `--line` | `--text-muted` | out of tab order |

The colour-independent signal is the **presence or absence of a fill**: a disabled Pause loses its `--brand` fill and becomes an outline, so a dead primary can never look pressable. That is the one fault this project has already fixed twice, and it must not come back wearing a glyph.

The reason text (`DisabledReason`, `--text-sm`, `--text-muted`) stays beside the transport cluster where it is today. A glyph-only button makes that sentence more load-bearing, not less: it is what tells the user *"Converted as far as 1:10:20"* when the forward arrow goes quiet.

#### 2. The delta chip, the travel band and the unconverted region

All three carry meaning, so all three are drawn so that **turning the screen greyscale loses nothing**:

| Element | Drawn as | What identifies it without colour |
|---|---|---|
| **Delta chip** | Pill, `--r-pill`, 1 px `--line-strong`, `--text` label, mono tabular, 15 px, `+1:30` / `−2:00` | It **only exists while a jump is pending** — the resting transport row has no pill in it — and it always leads with a sign glyph. Position (immediately right of the readout) + border + sign |
| **Travel band** — the jump asked for and not yet sent, between where the TV is and where you are heading | **45° hatch**, 3 px stroke / 3 px gap, `--text-muted` over `--track` (**4.85:1**) | Hatch **angle**, and it always terminates in the **handle** at its leading edge |
| **Unconverted region** — not converted yet, `cursor: not-allowed` | **135° hatch** — the opposite diagonal — 4 px stroke / 4 px gap, `--track-prepared` over `--track` (**3.19:1**) | Hatch **angle**, and it always begins at the **solid 2 px limit tick**, which is `--text` at 12.9:1 |

The two hatches are the **opposite diagonal from each other and never share an angle**, because during a forward skip inside a conversion they are on screen at the same time, six pixels apart. Each also has a distinct terminator — a round handle at one end of the travel band, a solid straight tick at the start of the unconverted region — so the pair is separable by three independent cues: angle, stripe pitch, and terminator shape. None of them is hue.

Prepared fill (`--track-prepared`, solid) sits under both and reads as the third texture: solid, mid-luminance, 3.19:1 against the bed. Played fill is `--brand`, solid, 7.04:1 against the bed and 2.6:1 against prepared fill — which is why prepared fill is **solid and played fill is solid but the boundary between them is the handle**, never a colour edge alone.

### The three kinds, restated in M4 terms

Section 2's rule is unchanged; this is only what it now looks like. **Every signal below is non-chromatic**; colour is redundant in all three rows.

| Kind | StatusRegion | Non-colour signal | Colour, redundantly |
|---|---|---|---|
| **Transient** | `--surface`, 1 px `--line` | **Pulsing dot** before the headline, plus a hairline or a determinate bar beneath it | none — the dot is `--text` |
| **Steady** | `--surface`, 1 px `--line` | **No dot, no bar, no motion.** One primary button | none |
| **Needs you** | **`--surface-2`, 2 px border** | **Border weight doubles and the region's surface steps up** — two structural changes, visible in greyscale and at three metres | border is `--error` |

The `needsYou` **headline stays `--text`**, never `--error`. It is the sentence the user has to read; it keeps maximum contrast, and the failure is announced by the region, not by tinting the words. This also means the state kind survives a greyscale screenshot, a colour-blind reader and a badly calibrated television-adjacent monitor.

**`--error` appears on exactly seven states** — `Impossible`, `ConnectFailed`, `FirewallBlocked`, `DiskFull`, `PrepareFailed`, `LostConnection`, `SourceGone` — and nowhere else in the product. In particular:

- **`Yielded`** is `steady`. *"Living Room TV is now playing YouTube"* is a fact with two buttons under it. No border weight change, no `--error`, no icon.
- **`NetworkDown`** is `transient`. Pulsing dot, hairline, and the device list dims — by swapping `--text` for `--text-muted` on the rows, **not** by lowering their opacity.
- **`Reconnecting`** is `transient`. Section 4 governs: the screen is still, only the headline changes, nothing turns red.

### State coverage

Every state in section 2 is designed by its kind plus the components in section 7. These are the ones that need something the kind does not already say:

| State | What is specific to it |
|---|---|
| `IdleSearching` / `IdleNoDevices` | The searching note and the two-item checklist live in the DevicePanel at `--text-sm`/`--text-muted`. The **StatusRegion is unaffected** — searching is not an event |
| `ReadyPrepared` | *"prepared on 3 August"* is `--text-muted` in the sub-line. No badge, no icon; the date is the whole signal |
| `NeedsConvertLong` | Primary reads *"Prepare and cast…"*. The ellipsis is the signal (section 8) — it gets no extra weight or colour |
| `ConfirmLongPrepare` | **Steady, not `needsYou`.** `--surface`, 1 px border. The disk figure and the duration are `--warn` **text** inside an otherwise ordinary region — the only place `--warn` appears outside rule 6's re-estimate. It is a decision, and it must not be dressed as a warning |
| `Repackaging` / `Converting` | Determinate `ProgressBar`: 10 px, `--r-pill`, `--track` bed, `--brand` fill. Percentage left in `--text`, next-thing right in `--text-muted`. The TitleBar percentage is `--text` against `--bg` |
| `Converting` (two numbers) | Rule 10's second number is a second sentence in the sub-line, not a second bar. One bar per screen, ever |
| `PlayingUnprepared` | *"Still converting — 61%"* is a sub-line, not a second progress bar. The bar's job is now the scrubber's prepared fill |
| `FrontierHold` / `WaitingForConversion` | Transient: dot + hairline + countdown. **Forward 30 goes to the momentarily-unavailable treatment; Play/Pause goes to the structural one** (its fill is removed); Stop stays fully live. The three treatments are visibly different without colour |
| `Buffering` | Transient, **but the transport keeps its full appearance** — nothing dims, because everything except dragging still works |
| `Seeking` | Transient ≤ 2 s. The readout holds the requested position in `--text`; the delta chip has already gone |
| `Ended` / `Stopped` | Transport row present but inert (`.off`): skip buttons **hidden**, not muted. The remembered position lives on the button label |
| `Reconnecting` | **Nothing moves except the headline and the hairline.** Scrubber, position, file name, device list all hold their exact pixels. Transport controls take the structural treatment with *"Waiting for Living Room TV"* beside them |
| `Yielded` | Steady. The device row for the taken TV gets *"· in use by YouTube"* at `--text-sm`/`--text-muted` — a fact in the list, not a badge |
| `NetworkDown` | Device rows swap to `--text-muted`; the list is never emptied. The settings button appears after 30 s as a **secondary** button — the primary slot stays empty because there is nothing the user should be told to press yet |
| `SourceGone` | `needsYou`. Two buttons, both opening the picker. Never a path on screen |
| `Reattaching` | Transient ≤ 5 s. Hairline, no bar |

**Gap, flagged here on 2026-08-30 and closed the same day by M4's step 0:** section 2 predated M3c and carried no rows for the subtitle states. It now has them — **§2 § *Subtitles*, eight rows**: `SubtitlesOffered` · `SubtitlesNoneFound` · `SubtitlesPictureOnly` · `SubtitlesPreparing` · `SubtitlesOn` · `SubtitlesTiming` · `SubtitlesUnreadable` · `SubtitlesNotLoaded`. They were derived from the PRD's *States built in M3c* list, the M3c acceptance criteria and the subsection below, and cross-checked against `SubtitlesSnapshot` so no name exists that no state produces. The edit was made as its own pass with the PRD's wording in front of it, exactly as this flag asked — not inside the visual pass, which changed no law. The eight also now have screens in `docs/mockups/state-map.html`, which is what makes them restylable at all.

### The subtitle surface (M3c), designed

It is a panel below the transport row, not a menu bar and not a settings screen. Copy is the engine's and the view-model's, verbatim. **The eight surfaces this table dresses are named in §2 § *Subtitles*** as of 2026-08-30; every row below belongs to one of those eight.

| Element | Treatment |
|---|---|
| Panel | `--surface`, 1 px `--line`, `--r`. Label *Subtitles* at `--text-sm`/`--text-muted` |
| The control | A secondary button reading the current source — **`Off` on every film, every time** — 44 px, 1 px `--line-strong`, `aria-expanded` |
| The source list | Opens **in flow**, pushing the panel taller. Rows are 44 px, 1 px `--line-strong`, `--surface-2` — they must look pressable, which is a founder-found defect from 2026-08-27 and is now a rule. Selection is a **filled `--accent` dot plus `aria-selected`**, never the row's colour alone |
| Picture-only tracks (18k) | Listed **below** the list, `--text-sm`/`--text-muted`, with the engine's sentence. Visibly refused, never hidden |
| `Preparing subtitles…` | The **pulsing dot** beside it and a Cancel — the same transient vocabulary as everywhere else, in its own panel rather than in the StatusRegion, because the film is not waiting on it |
| Timing control | *Timing: in sync* / *Timing: +0.6 s* / *Timing: +0.6 s, as you set it last time* at `--text-base`, then **Earlier · Later · Reset**, three 44 px secondary buttons. The reading is `--text`, never `--warn` — an offset is a setting, not a problem |
| `Moving the subtitles…` | `--text-sm`/`--text-muted` beside the buttons while a reload is in flight. Said out loud, not hidden |
| `Subtitles didn't load` / `This subtitle file can't be read` | One sentence at `--text-base` in the **subtitle panel**, with *Try again* beside it where there is something to retry. **It never touches the StatusRegion** — section 1's single-speaker rule is about *what is happening to the film*, and the film is playing fine |

The timing control is the one place in the product with three peer buttons and no primary. That is correct: *Earlier*, *Later* and *Reset* are a nudge, not a decision, and promoting one would be a lie about which the user wants.

### What this pass asks of section 8 — one number, **approved 2026-08-30 and now applied in section 8**

Section 8 sets the StatusRegion minimum height at **132 px**, measured at the placeholder type scale. At the M4 scale the tallest ordinary message — a one-line headline at 28 px, a two-line sub at 17 px, and a 44 px action row, with 12 px gaps and 14 px padding — measures **178 px**. 132 px still holds (it is a floor, and nothing shrinks below it), but it no longer does its job: the region would visibly jump between a short message and a long one, which is the exact thing the number exists to prevent.

**Amendment, approved by the user 2026-08-30 and applied in section 8: the StatusRegion minimum is 184 px.** It was proposed rather than applied, because sections 1–9 are law and this was a measurement taken during the visual pass, not a decision the visual pass gets to make alone. The founder approved it having seen it at both window sizes in *The minimum window* mockup (`docs/mockups/m4-minimum-window.html`). *(That mockup drew the floor at 760 × 560, and the arithmetic in this paragraph was written against the same number — 396 px of main column below the FilePanel. Later the same day §1's correction established that **760 × 560 was never the real minimum**: the app has always enforced 880 wide, and the floor is now **880 × 720**, which gives about **556 px**. So the amendment got cheaper, not dearer, and the 184 px floor is in fact the reason the height floor moved — see §1. The mockup has since been redrawn at the corrected 880 × 720 and 1100 × 720, because its job is to answer whether a state fits the *real* floor, and it measures its own overflow rather than estimating it.)* It is the difference between a still window and a twitching one.

### M4 constraints (non-negotiable, agreed before the pass — and how each was met)

- **No behaviour changes.** Nothing above adds, removes or merges a state, changes a sentence, changes what a button does, or changes what is available when. ✅
- **Every state in section 2 gets designed.** Covered by kind, plus the exceptions table. The M3c subtitle states were designed here and flagged as missing from section 2; **that flag was closed on 2026-08-30 by M4's step 0**, which gave them eight rows in §2 and eight screens in the state map. ✅
- **The three state kinds stay distinguishable without colour.** Dot / nothing / border-weight-plus-surface-step. Verified as a greyscale panel in the mockup. ✅
- **No new motion.** The same two, parameterised. ✅
- **Nothing may become modal.** `ConfirmLongPrepare` remains a state; the subtitle list opens in flow; there are no shadows because there is nothing to float. ✅ *(Step 0 found on 2026-08-30 that one already **was** — the closing question, since 2026-08-18. The founder ruled it in-window the same day, so this is now true of the whole product rather than only of M4.)*
- **`--error` is only for `needsYou`.** Seven states, named. Never `Yielded`, `NetworkDown` or `Reconnecting`. ✅

---

## 11. Milestone 5a — the volume control

*Drawn 2026-09-07, before any feature code, as the PRD's M5a build order step 0 requires. **Mockup: <https://claude.ai/code/artifact/10c7f3b8-136a-49a1-83a3-d2869b20b897>** — the control in every state it can be in, at the app's real floor, in the shipped dark palette. The HTML source is `docs/mockups/m5a-volume.html`, beside `state-map.html`. Where the mockup and this section disagree, one of them is a bug report against the other.*

**Two components — `VolumeControl` and `MuteButton` — and nothing else.** No state in §2, no sentence in the StatusRegion, no entry in the TitleBar, no announcement, no token, no motion, no type size, nothing modal. 21i applies unamended and this section spends none of it.

### Where it lives, and why not in the device rail

**In the `TransportPanel`, at the right-hand end of the button row, after a gap.** The order across the row is **Back 30 · Play/Pause · Forward 30 · Stop ⟶ *gap* ⟶ Mute · slider · readout**. The four on the left act on the film; the two on the right act on what CastGood is sending. The gap is the seam, and it is `margin-left: auto` rather than a rule or a divider — §10 has no divider and does not need one here.

**It is not in the `DevicePanel`, and the reason is a promise rather than a preference.** A slider sitting in the list of televisions reads as a per-television setting the app keeps, which is exactly what M5a's *Deliberately not* list forbids: nothing about volume is persisted, per device or otherwise. The control belongs to the session and vanishes with it (23i), so it is drawn where the session's other controls are.

**It costs the window no height, and that is checked rather than asserted.** It joins a row that is already 44 px tall. **The transport button row does not wrap** — `flex-wrap: nowrap`, with the slider as the single flexible element (`flex: 1 1 164px`, `min-width: 96px`, `max-width: 180px`) — because a wrap would add 44 px in a window whose floor has 33 px of headroom, and 22b would fail in the state the app spends its life in. `src/main/main.ts`'s height arithmetic is **unchanged and unowed**: no panel was added to the main column. The mockup measures both windows on load rather than estimating.

⚠️ **A stale sentence found while doing this, flagged rather than fixed here:** §1 says *"the app's floor is 880 × 720"* two paragraphs after it says *"the minimum window is now 880 × 800"*. `main.ts` enforces **880 × 800** and opens at **1100 × 900**. §11 is drawn against 880 × 800. The correction belongs to §1 and is owed there.

### The rule the whole design exists to serve

**The app never shows a level it was not told** (M5a rule 1 / criterion 23b). There is no optimistic readout, which means **the handle cannot follow your finger** — and the honest question is what the control looks like in the 85–222 ms before the television answers.

It looks like the scrubber already does, because the scrubber has been answering this exact question since M2. **The volume control borrows §10's travel-band vocabulary unchanged** rather than inventing a second one:

| Mark | Drawn as | Means |
|---|---|---|
| **The bed** | `--track`, 10 px, `--r-pill` | The full range, always |
| **The level** | Solid `--brand` fill from 0 | **The last level a receiver status reported**, and nothing else, ever. Same token and same meaning as the scrubber's played fill — *where the television actually is* |
| **The handle** | 18 px `--text` circle at the end of the fill | The reported level. **It moves for a receiver status and for nothing else** |
| **The ask** | 2 px solid `--text` tick, 6 px overhang top and bottom | Where the user pointed. **Exists only while a `SET_VOLUME` is unanswered** |
| **The gap** | 45° hatch, 3 px stroke / 3 px gap, `--text-muted` over `--track` (**4.85:1**) | Asked for, not confirmed. **§10's travel band at its exact angle and pitch** |
| **The step ladder** | 90° gaps cut in `--bg`, one per step the device reports | How many positions this television actually has |

**The one deliberate inversion from the scrubber, stated so nobody 'fixes' it.** On the scrubber the round handle leads the travel band, because a pending seek is a place you are going to occupy and 4d permits that optimism. Here the handle **trails** and a tick leads, because 23b forbids the optimism and *the round handle is the one thing in this control that is always true*. The two bands can never be on screen at once — you cannot drag two sliders — and each keeps its own terminator, which §10 already names as one of the three cues that separate its hatches.

**What this buys, and it is the whole milestone in one picture:** a television that ignored us entirely leaves the tick standing and the handle exactly where it was. A control that painted the ask would look identical on a working set and on a lying one. This one cannot pretend.

**The ask tick is cleared by the device's *answer*, not by the answer *matching*.** A set that quantises 62% to 60% has answered; the tick goes, the handle lands on 60%, and nothing is retried (23d). A tick that persisted until the numbers agreed would nag for ever on a 20-step set.

**Nothing about this control animates.** The handle is repainted where the device said it is — it never slides, glides or eases, including when somebody else's remote moves it. §8's two animations remain the only two, so M4's motion checker stays green with no exemption added, which is what 23k requires.

### Granularity is the television's, not ours

**SPIKE-5, 2026-09-07, on the user's own three sets:**

| Device | `controlType` | `stepInterval` | Positions | Round trip |
|---|---|---|---|---|
| AI PONT (Cast built into the set) | `master` | 0.01 | **100** | 85–222 ms · median **140** |
| Chromecast Ultra | `attenuation` | 0.05 | **20** | — |
| Chromecast | `attenuation` | 0.05 | **20** | — |

**Two of the three move in 5% steps, so a continuous-looking slider would visibly snap under the finger on the majority of this house's hardware.** The design answers it rather than hiding it: **the track draws one segment per step the device reports**, as gaps cut in `--bg` across the whole bed so the positions are countable *before* the drag rather than discovered during it. On a 164 px track, 20 steps is 8.2 px each — legible; 100 steps is 1.6 px — not.

**So the ladder is conditional, and the condition is derived rather than chosen: it is drawn when one step is wider than the 3 px stripe pitch §10 already uses for its hatches, and the bar is continuous below that.** Reusing a number the design system already owns is what stops this being a magic threshold. `stepInterval` reaches the renderer in the snapshot like every other observed truth; **the control has no constant number of steps and must never be built with one.**

### It shows CastGood's level. It is never a mirror of the television's volume.

This is a labelling law, not a nicety, and all three sets prove it independently:

- On the two Chromecasts the number is the **dongle's own attenuation**, with the television's volume sitting downstream of it, invisible to us.
- On the AI PONT the number is the set's master volume — but **the set's own remote moves its amplifier directly and Cast is never told**, so the two drift apart the moment anybody picks the remote up.

Three things fall out, and they are the whole of the copy rule:

1. **A television is never named beside the number.** This is a deliberate, single carve-out from §6's *name the device, every time*, and it is narrow: §6 governs **sentences the app says**, and this control says nothing. Naming a set beside a level would claim the level is that set's, which is false on all three.
2. **The one exception is 23h's `DisabledReason`, which names a device precisely because it exists to state the separation:** *"Guest room TV keeps its own volume."* That is the **only sentence M5a adds to the product** — one line, §6's *refusal known ahead* shape, a plain fact with the alternative implied.
3. **The readout is `--text-sm`, mono, tabular** — deliberately the smallest number in the transport panel, against the position readout's `--text-lg`. An on-screen-display-sized number would read as the television's own bar. It is `--text` (a live value, not meta), right-aligned in a fixed 54 px slot so `37%`, `100%`, `Muted` and `—` never shift the row.

**There is no permanent sentence explaining any of this, and the absence is the design** — the `SubtitlesNoneFound` precedent of 2026-08-30. A standing line under a slider is the app talking about volume, which rule 3 forbids, and it costs height in the state the app is in most of the time. *Flagged for the user in the mockup as the one decision here worth revisiting after an evening's use.*

### The mute control — its own control, never the slider at zero

*Founder's ruling, 2026-09-07, question 42.*

A 44 × 44 button immediately left of the slider, `--r`, 1 px `--line-strong`, glyph 24 × 24. **Inline SVG, `fill="none"`, `stroke="currentColor"`, `stroke-width="1.75"`, `stroke-linecap`/`linejoin="round"`, `aria-hidden="true"`** — the `SkipButton` glyph spec verbatim, `currentColor` throughout so the disabled treatment needs no second glyph. Not muted: a speaker cone with two arcs. Muted: the same cone with a cross. `aria-label="Mute"` is constant and `aria-pressed` carries the state, which is the only thing a screen reader has.

**Muted changes three things at once, and none of them is a hue:**

| | Not muted | Muted |
|---|---|---|
| Glyph | Cone + two arcs | Cone + cross |
| Level fill | `--brand` | **`--track-prepared`** — solid, mid-luminance, 3.19:1 on the bed |
| Readout | `37%` | `Muted` |
| Handle | `--text` | **`--text` — unchanged** |

`--track-prepared` is borrowed on purpose: in the scrubber it means *real, prepared, not playing*, which is exactly a muted level. **The handle staying bright and staying put is the design argument for 23f**: the level was never zeroed, the television still holds it, and unmuting therefore needs nothing remembered. The founder can see what the room is coming back to. **CastGood stores no pre-mute level, and this control gives it nowhere to hide one.**

### Unavailable — one treatment, and it is always the structural one

**There is no `aria-disabled` volume control.** §5's *Unavailable ≠ unavailable* distinction exists for controls that flicker in and out of reach as the frontier advances; nothing about volume flickers. 23h and 23i both say **really `disabled`**, so the component has exactly one unavailable treatment and cannot drift into two.

| Situation | What is drawn | The reason beside it |
|---|---|---|
| **`Reconnecting`, `LostConnection`, `NetworkDown`, `Yielded`** (23i) | **Not one pixel moves.** The last reported level and mute hold their exact positions; the tokens dim — fill `--brand` → `--track-prepared`, handle and readout `--text` → `--text-muted`, mute button border `--line-strong` → `--line` and glyph `--text-muted`. Out of the tab order | **None. M5a writes no sentence for these.** *"Waiting for Living Room TV"* already sits beside the transport row (§10, `Reconnecting`) and already explains the volume |
| **A television that will not take a volume** (23h) | The slider collapses to a 60 px stub — a dead slider needs no length — with no fill and no handle; the mute button is disabled; the readout is replaced by the sentence, which takes the freed width and wraps to at most three lines inside the row | **`DisabledReason`, `--text-sm`/`--text-muted`, ≤ 34ch:** *"Guest room TV keeps its own volume."* |
| **No level reported yet** — the second between joining a television and its first status, and `Reattaching` | Disabled, empty bed, **no handle**, readout `—` | **None**, deliberately: a sentence that appears and vanishes inside one poll interval is worse than a dash. `aria-valuetext="Not reported yet"` |
| **`Ended`, `Stopped`, `SourceGone`, and every idle and verdict state** | **Not rendered.** Not greyed — absent | — |

**The dim is a token swap, never an opacity and never a clear.** §4's rules govern: recovery keeps the screen still, and a list is never emptied to signal a problem. `NetworkDown` already dims the device rows by swapping `--text` for `--text-muted`; this is the same move on a slider.

**Muted and disabled both carry a `--track-prepared` fill, and they are separated by three independent cues** — the glyph (cross vs arcs), the handle's luminance (`--text` vs `--text-muted`), and the presence of a `DisabledReason`, which §10 already names as *the* thing that identifies a disabled control. Verified as a greyscale panel in the mockup.

**Why `--line` on a disabled mute button is allowed to measure 1.35:1**: the user's exemption of 2026-09-04, unchanged. What identifies a dead control is the sentence beside it, and a dead control that shouts is worse than one that recedes.

**`--error`, `--warn` and `--success` appear nowhere in this component.** A television with its own volume is a fact, not a fault; a quantised answer is not a warning; a level that arrived is not an achievement. §10's seven `--error` states gain none.

### Accessibility contract

- **The slider is a real `role="slider"`** with `aria-label="Volume"` — never *"TV volume"* or a device's name — `aria-valuemin="0"`, `aria-valuemax="100"`, `aria-valuenow` = **the reported level**, and `aria-valuetext` carrying the whole of the value: `"37%"` · `"Muted, 37%"` · `"37%, asking for 62%"` · `"Not reported yet"` · `"Not available"`. The pending ask rides the `aria-valuetext` exactly as the scrubber's accumulating jump does (§9), **never as a live region** — 23k forbids a second announcement and §1 forbids a second speaker.
- `aria-valuenow` is **omitted** when no level has been reported. There is no honest number to put there and 0 is not one.
- **The `aria-valuetext` is re-rendered only when the value actually changes**, so a 1 Hz `GET_STATUS` reporting the same level never re-announces — §9's existing rule for the StatusRegion, applied to the one other thing that updates on a poll.
- **Keyboard, and it does not take `←`/`→` from the window's seek handler.** §5 owns those globally on purpose. With the slider focused: **`↑`/`↓` ask for the next drawn position** — one step where the ladder is drawn, five percentage points where the bar is continuous — `PageUp`/`PageDown` move five of those, `Home`/`End` ask for silent and full. `Space` stays play/pause, suppressed on the mute button so it does not double-fire (§5's existing rule for buttons).
- **Every press issues immediately**; there is no settle timer. 23a's throttle is the device's own round trip — one command in flight, one pending value that replaces rather than queues — so a held `↑` produces the same honest trailing handle a drag does. **The pending value lives in the engine snapshot, not in the renderer**, which is what keeps the renderer a pure view and keeps 23b's *"no second copy of the level"* true: `pending` is an outstanding request, not a level.
- **Targets:** mute button 44 × 44; the slider's hit area is 44 px tall over a 10 px track, the `Scrubber`'s existing geometry.
- **Focus** is `--accent`, 2 px, offset 2 — unchanged, and visible on both controls including while disabled-adjacent siblings are not.
- **Legible without colour**, verified greyscale: fill luminance, glyph shape, hatch angle, handle brightness, ladder segmentation and the word in the readout. Hue is redundant in every state.
- **Rounding, and it is the only arithmetic this control does to a device's number:** a level is a fraction and the readout is a percentage, rounded half-up — **except that any level above silent shows at least 1%.** A set at 0.004 rounding to *0%* would claim to be silent when it is not.

### What this section does not add

No state in §2. No row in §10's state-coverage table. No sentence in the StatusRegion, the TitleBar or a live region. No token, no animation, no type size, no surface that floats above another. No persisted value. No device name beside a number. **One sentence, one component, two rows in §7.**
