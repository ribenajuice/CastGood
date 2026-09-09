# CastGood

CastGood plays video files from your Windows PC on the Chromecast devices around your house. Pick a file, pick a television, press one button.

**The one thing that makes it different: CastGood gets a file ready *before* it starts playing, instead of converting it while you watch.** Converting underneath playback is why films from other casting tools stutter, refuse to seek, and drop out halfway through the evening. If your film needs work, CastGood does the work first, tells you roughly how long it will take, and only starts casting once it is far enough ahead that playback cannot catch it up.

It is personal software for one household. **No accounts, no cloud, no telemetry, and no internet access at all** — everything happens between your PC and your own televisions, on your own wifi.

Two things to know before you read further:

- **CastGood only runs on Windows.**
- **There is no published release yet.** Build the installer from this repository — see [Build it yourself](#build-it-yourself). When the first release is cut, it will appear on this repository's Releases page.

---

## What you need

- **Windows.** CastGood never runs anywhere else.
- **A 1080p display or larger.** The window will not shrink below 880 × 800, because every screen is drawn to fit that size and no smaller. On a smaller display the window would be bigger than the screen.
- **Your televisions and this PC on the same wifi.** Chromecast discovery is local-network only.
- **Nothing else.** ffmpeg ships inside the installer. There is nothing to install alongside it and nothing to sign in to.

## Install it

You will have an installer called `CastGood-Setup-1.0.1.exe`. Double-click it.

**Two things happen that look alarming and are not.**

1. **Windows says *"Windows protected your PC"*.** Click **More info → Run anyway**. The installer is **unsigned by decision** — a code-signing certificate costs $200–400 a year and is not worth it for household software. It is not a virus warning; Windows simply does not recognise who made it.
2. **Windows asks for permission to change something.** Say yes. That is one firewall rule, as narrow as it can be: this program only, private networks only, incoming only. Saying no is safe and the install still finishes — but then Windows shows its own firewall prompt at first launch, and if you dismiss *that* one, CastGood finds no televisions and cannot explain why.

It installs per-user, with no admin rights beyond that one prompt, and adds Start-menu and desktop shortcuts.

`CastGood-Setup-1.0.1.exe /NOFIREWALL` skips the firewall step entirely.

## Use it

[**Using CastGood**](docs/USING-CASTGOOD.md) is the whole guide, in plain language: what happens the first time you open it, how to cast a film, what the four possible answers about your file mean, subtitles, and what happens when the evening goes wrong. It is the page to hand to whoever you gave the installer to.

The short version:

1. Open CastGood. It starts looking for televisions straight away, listed under the names you gave them in Google Home.
2. Pick a television, then press **Choose video…** and pick a file.
3. CastGood checks that file against *that* television and tells you one of four things: **Ready to cast**, **Ready in about 20 seconds** (rewrap only, no quality lost), **Needs converting — about 6 minutes**, or **This file can't be cast**.
4. Press the button. The app then becomes the remote: play, pause, back 30, forward 30, drag to jump, stop.

If a conversion is running, you do not have to wait for it. Once ten minutes of film are ready and being converted faster than you can watch them, CastGood starts casting by itself and the rest converts behind you.

## Build it yourself

**On Windows**, with Node 22 or newer:

```
npm ci
npm run build:win
```

The installer lands in `dist/installer/`. This is the same command the release workflow runs on a `windows-latest` runner.

**From WSL**, which is where CastGood is developed, one script does the whole thing — it mirrors the tree to `C:\CastGood`, builds there, and copies the `.exe` back:

```bash
npm install              # first time only
scripts/win-build.sh     # takes a few minutes the first time
```

Either way the result is `dist/installer/CastGood-Setup-1.0.1.exe`. Copy it to the Windows side and double-click it.

`scripts/deploy.sh --tag` tags a version, and a GitHub workflow builds the installer and attaches it to a Release page. That is the entire distribution story: there is no server and nothing to deploy anywhere.

## Working on it

**The app only ever runs on Windows.** Development happens in WSL2, but CastGood itself never starts there: discovery is mDNS multicast and the television has to open a TCP connection back to your PC, and both fight WSL2's NAT. `npm run dev` exists in `package.json` and is a trap in WSL — use `scripts/win-run.sh`, which starts the app on the Windows side.

That is why there are two copies of the project on purpose. `~/CastGood` in WSL is the real one — git, editing, lint, typecheck, tests. `C:\CastGood` is a disposable mirror holding the Windows `node_modules`, Electron, the running app and the installer; only `scripts/win-sync.sh` writes there. Electron and ffmpeg are Windows binaries while esbuild and vitest are Linux ones, so one shared `node_modules` would break both.

| Command | What it does |
| --- | --- |
| `npm test` | Engine tests. Headless, no Chromecast needed, runs in WSL. |
| `npm run lint` / `npm run typecheck` | Static checks. `npm run format` runs Prettier. |
| `npm run build` | Builds the app bundles (not the installer). Works in WSL. |
| `scripts/win-run.sh` | Runs the app. A window appears on the **Windows** desktop; nothing appears in WSL. |
| `scripts/win-stop.sh` | Kills anything still running from `C:\CastGood`. |
| `scripts/win-logs.sh` | Follows the engine's log from WSL. |
| `scripts/win-test.sh` | Runs the selftest against a real Chromecast and prints the verdict here. |
| `scripts/win-firewall.sh` | Checks whether the Windows Firewall rule actually landed (`--add` / `--remove` to fix it). |
| `scripts/win-build.sh` | Builds the installer into `dist/installer/`. |
| `scripts/win-sync.sh` | Mirrors WSL → Windows. The other scripts do this for you. |

If you start the app in the background or with a timeout, **it keeps running on Windows after your command returns.** Ctrl-C only reaches it from an interactive terminal. Always finish with `scripts/win-stop.sh`.

[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) is how it is put together, including the Cast-protocol research behind it. The layout:

```
src/engine/       All the logic, as a plain Node library with zero Electron imports.
                  That is what makes it testable headlessly — a test enforces it.
src/main/         Thin Electron host.
src/renderer/     React UI. A pure view of state pushed from the engine.
test/             Vitest. Engine, architecture and design rules, driven against a fake
                  television that never fetches the video. It has been caught being
                  kinder than a real Chromecast four times, each time hiding a real
                  defect — when hardware misbehaves, suspect the fake first.
scripts/          The WSL↔Windows scripts above, plus selftest.mjs, deploy.sh, bundlers.
```

## Proving it actually works

**A passing test proves the logic, never the product.** No CI runner has a Chromecast, and design checkers read the source, so they cannot see a CSS rule that loses in the browser's cascade — that is how every corner in the app shipped square for a day. There are three ways to find out what really happened, and `npm test` is not one of them.

**1. Read the log.** The engine writes one JSON object per event to `%LOCALAPPDATA%\CastGood\logs\engine-<date>.jsonl`. `scripts/win-logs.sh` follows it live from WSL.

**2. Run the selftest against a real device.** It drives the same engine the app drives, through the same intents, with no window and no human, and prints one JSON verdict naming every assertion's target *and* its measured value:

```bash
scripts/win-test.sh --device "<your TV's name>" \
                    --file "C:\Users\you\Videos\something.mp4" \
                    --scenario m1     # or m2, m3, m3c
```

Scenarios, by milestone. `m1`, `m2`, `m3` and `m3c` each run their own list in order:

| | |
| --- | --- |
| **M1** | `discovery` · `cast` · `transport` · `position` |
| **M2** | `seek` · `skip` · `recover` · `reattach` · `sourcegone` · `finish` · `resume` · `takeover` |
| **M3** | `check` · `remux` · `prepared` · `convert` · `headstart` · `prepfail` |
| **M3c** | `subtitles` (run three ways: plain, `--timing`, `--broken`) |

An aggregate checks what it can know in advance before it casts anything — how long the film is, and whether a scenario has somewhere to write — so a film too short for the scenarios asked for stops the run at the start rather than four legs in. The M3 scenarios **build their own fixtures** with the bundled ffmpeg, in a scratch folder they remove afterwards; your films folder is never written to.

The exit code is the whole point:

| Exit | Means |
| --- | --- |
| `0` | Every assertion met its target. A real device really played real video. |
| `1` | An assertion missed its target. The verdict says which one and by how much. |
| `2` | **The run could not happen at all** — device not found in 30 s, file missing or too short, port busy, run from the wrong OS, or a scenario that could not produce its own condition. Nothing was proved. |

A run that never reached a device exits `2`, never `0`. That guarantee is why the selftest is worth anything: it is impossible to report success without a television having played a film.

**3. Watch a television.** For the things nothing can automate — what is on the screen, pulling the wifi out, grabbing the set from a phone.

## Where this is up to

**All four milestones are built and merged**: casting (M1), an evening that survives being interrupted (M2), the preparation pipeline and subtitles (M3a / M3b / M3c), and the visual design pass (M4). The app is feature-complete for v1. [`CHANGELOG.md`](CHANGELOG.md) says what each of those gave you.

**What has been proved on three real Chromecast devices**, with dates:

| Run | Result | When, and on what |
|---|---|---|
| `m1` — casting | 43/43 | 2026-08-28, `AI PONT` (third-party set, Cast built in) |
| `m2` — interruptions | 108/108 | 2026-09-03, `Chromecast` |
| `m3` — preparation and head start | 53/53 | 2026-08-29, `AI PONT` |
| `m3c` — subtitles | 85/85 | 2026-08-29, `AI PONT` |
| `discovery` · `cast` · `transport` | every assertion | 2026-09-04, `Chromecast Ultra`, on current code |

**What is not proved, stated plainly:**

- **`m3` has never passed on current code.** Its last clean run predates the design pass and the Electron upgrade. It also needs a film the chosen television cannot play natively, at least 15 minutes long and never prepared before — and **a film that passes `m3` acquires a prepared sibling and is thereafter disqualified**, so each run burns its film.
- **`m1` and `m2` have not been re-run end to end since the design pass.** The 2026-09-04 `m1` attempt scored 40/43 for want of a long enough film, not for want of a working product; that case now correctly reports "this run could not happen" instead of "a promise was broken".
- **`takeover` cannot be graded on every television, and there is a named example.** On 2026-09-04 a `Chromecast Ultra` ended `m2` at that leg — *"this device does not report one the way a phone does"* — after meeting **94 of 94** promises in the seven legs before it. Run alone on a plain `Chromecast` the same evening, `takeover` passed **14/14**. A set that will not be taken over programmatically ends the run honestly rather than passing. It is deliberately last in `m2` so an expected abort strands nothing behind it. Separately, one set takes 46 seconds to say *what* took it over, against the 15 seconds the app waits — so CastGood names the television, never the app that grabbed it.
- **Nothing has actually cast under Electron 44.** The upgrade was read and run on Windows — window up in 993 ms, 288 discovery sweeps with both televisions answering every one — but the headless selftest drives the engine under plain Node, not Electron, so it cannot answer this question. Only a person watching a television can.
- **With the subtitle source list open, the layout overflows at the minimum window size.** Every screen the app holds *persistently* fits; that one transient list does not. It is owed a height cap with its own scroll.
- **Two design criteria (21a and 21c) have no checker** and are recorded as ungraded rather than reported green.

## What CastGood deliberately does not do

These are settled noes, not a roadmap:

- **One television at a time.** No group casting.
- **Local video files only.** No library, no folder scanning, no posters, no playlists, no YouTube or Netflix.
- **No accounts, no sign-in, no telemetry, no analytics, no crash reports, no auto-update.**
- **No internet access at all**, which also means no downloading subtitles and no translation.
- **No quality, bitrate or encoder settings.** CastGood decides; you never tune an encoder.
- **No managing prepared files from inside the app.** They sit beside the original, named so you can spot them (`Cars.mkv` → `Cars (CastGood).mp4`), and they stay until you delete them. Explorer is the manager.
- **No image-based subtitles** (PGS, VobSub). They are pictures, not text, and putting them on a television means re-encoding every frame of a film that otherwise needs no work — the exact thing this app exists to avoid. CastGood names that in one sentence rather than trying.
- **No phone remote, no access from outside the house, no photos or music.**

## Licence

**CastGood's own source is MIT** — see [`LICENSE`](LICENSE). Use it, change it, ship it.

**The installer is not all MIT, and the difference matters.** It bundles **ffmpeg, which is
GPL-3.0-or-later**. CastGood never links it: ffmpeg is spawned as a separate program over a
command-line boundary, which is what lets this repo carry a permissive licence while the
installer ships a GPL binary next to it. Change that to linking and the licence is the first
thing that has to change with it — [`test/architecture/licenses.test.ts`](test/architecture/licenses.test.ts)
exists so nobody can do it quietly.

What an installed copy carries beside the executable:

| File | What it is |
| --- | --- |
| `LICENSE.txt` | CastGood's MIT terms, and the ffmpeg carve-out |
| `THIRD-PARTY-NOTICES.txt` | Every bundled npm package and its licence |
| `resources/bin/LICENSE.ffmpeg.txt` | ffmpeg's full GPL-3.0 text |
| `resources/bin/BUILD.ffmpeg.txt` | Exactly how that ffmpeg was built |
| `resources/bin/ffmpeg-build.json` | Its version, builder, and upstream commit — the corresponding source |

`THIRD-PARTY-NOTICES.txt` is **generated, never edited by hand**: `npm run notices` writes it
from the production dependency tree, `npm run build:win` regenerates it before packaging, and
`npm run notices:check` (which the test suite runs) fails if the committed copy has gone stale.
Adding a dependency therefore costs one regenerated file, and forgetting is caught by a test
rather than remembered by a person.
