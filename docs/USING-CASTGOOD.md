# Using CastGood

CastGood plays video files from your Windows PC on the Chromecast devices around your house. You pick a file, pick a television, and press one button.

Most casting tools convert a film *while it plays*, which is why they stutter, refuse to jump to a scene, and give up halfway through the evening. **CastGood gets the file ready first, then casts it.** If your film needs work, it does the work up front and tells you how long it will take.

## Before you start

- **Windows.** CastGood does not run on anything else.
- **A 1080p screen or bigger.** The window will not shrink below 880 × 800.
- **Your PC and your televisions on the same wifi.**

Nothing else. There is no account to create, nothing to sign in to, and no other software to install.

## Installing it

You will have a file called something like `CastGood-Setup-0.1.0.exe`, either handed to you or downloaded. Double-click it.

**Two things will happen that look alarming and are not.**

**1. Windows says "Windows protected your PC".** Click **More info**, then **Run anyway**.

Windows says this about any program that has not been signed with a paid certificate. CastGood has not been, on purpose — a certificate costs a few hundred dollars a year and this is software for one household. It is not a virus warning and nothing has been scanned and found wanting; Windows simply does not recognise who made it.

**2. Windows asks for permission to change something.** Say yes.

That is CastGood adding one firewall rule so your televisions can talk back to your PC. The rule is as narrow as it can be: this program only, private networks only, incoming only. If you say no, the install still works — but CastGood will find no televisions and will not be able to explain why.

The installer asks where to put CastGood; the answer it suggests is fine. It installs for you alone, in your own user folder, and puts CastGood on the Start menu and the desktop.

## Casting a film

1. **Open CastGood.** It starts looking for televisions immediately. They appear in the list under the names you gave them in Google Home. Nothing is pressed and nothing is sent.
2. **Pick a television.** If you used one last time, it is already selected.
3. **Press "Choose video…"** and pick a file.
4. **Read the answer.** CastGood checks the file against *that* television and tells you one of four things (see below). Choosing a different television re-runs the check, because the answer depends on which set the film is going to.
5. **Press the button.** It is one press either way — the button says *Cast to \<your TV\>* if the film is ready, and *Prepare and cast* if it needs work first.
6. **Watch.** The app becomes the remote: play, pause, back 30 seconds, forward 30 seconds, drag the progress bar to jump, and stop.

## The four answers

| What it says | What it means | What it costs you |
| --- | --- | --- |
| **Ready to cast** | This television can play the file as it is. | Nothing. |
| **Ready in about 20 seconds** | The video and sound are fine; only the wrapper around them is wrong. CastGood rewraps it without touching the picture, so nothing loses quality. | Seconds. |
| **Needs converting — about 6 minutes** | Something inside the file genuinely does not suit this television. CastGood converts only the part that needs it. | Minutes, with a progress bar and a live estimate. You can cancel. If the job is going to take more than 20 minutes, CastGood asks once before starting. |
| **This file can't be cast** | Nothing CastGood can do will make this file play here, and it says so rather than trying. | Nothing. Pick another file. |

**You do not have to wait for a conversion to finish.** Once enough of the film is ready — ten minutes of it, being converted faster than you can watch it — CastGood starts casting by itself and the rest converts behind you. The film cannot catch up with the conversion; that is the rule the whole app is built around.

## Where converted files go

A converted or rewrapped film is saved **next to the original**, with the name changed so you can see what it is: `Cars.mkv` becomes `Cars (CastGood).mp4`.

- It stays there until **you** delete it. CastGood never tidies up after itself.
- CastGood only ever touches files it named itself. Your own files are never moved, renamed or changed.
- The next time you cast that film, CastGood uses the copy it already made. **No film is ever prepared twice.**

## Subtitles

Subtitles are **off** unless you turn them on. When you choose a film, CastGood offers you:

- any text subtitle tracks inside the film,
- any subtitle file sitting beside it with a matching name (`Cars.srt`, `Cars.en.srt`, `Cars.vtt`),
- **Choose a file…**, for a subtitle file kept anywhere else.

Pick one and it appears on the television. You can turn the chosen track on and off while the film is playing.

**If the words are out of time**, nudge them earlier or later with the controls beside them, while you watch, until they land. *Reset* puts them back. The correction sticks to that film — it survives a wifi hiccup, closing the app, and coming back to it later. **Your own subtitle file is never modified.**

Two things CastGood will not do, and says so rather than failing quietly: subtitles that are pictures rather than text (common inside downloaded remuxes), and downloading subtitles from the internet.

## When something goes wrong

CastGood is built for the evening not going to plan. In most cases you do nothing.

- **The wifi hiccups.** It says *Reconnecting to \<your TV\>…*, keeps your place, and puts the film back within a couple of seconds. Nothing turns red and nothing pops up.
- **Your PC loses its network.** It tells you it is *this PC* that is offline, rather than blaming the television.
- **Someone casts from their phone.** CastGood steps aside straight away — it never fights for the television — and remembers your place. Press **Take it back** when they are done.
- **You close CastGood mid-film.** It asks whether to leave the film playing. Reopen it and it picks the film back up where it was.
- **You move or delete the file mid-film.** It says nothing while the picture is fine. Only when playback ends does it tell you, and offer to help you find the file again — keeping your place.
- **Windows Firewall is in the way.** It names the problem instead of spinning forever, and gives you a button that fixes it. Press it, approve Windows' prompt, and the film starts by itself.

When a film reaches its end, the television goes back to its own home screen, nothing plays next by itself, and CastGood returns to how it looked when you opened it — same film still selected, ready to cast again.

## What CastGood never does

- **It has no accounts and no sign-in.**
- **It sends nothing anywhere.** No telemetry, no analytics, no crash reports, no "usage data".
- **It does not use the internet at all.** Everything happens between your PC and your own televisions on your own wifi.
- **It does not touch your files** except the copies it made itself, which it names so you can spot them.

## If it misbehaves

CastGood keeps a plain log of what it did, in `%LOCALAPPDATA%\CastGood\logs`. Sending the newest file in that folder to whoever gave you the app, or attaching it to an issue on the repository, is the single most useful thing you can do.

Two known limits, so they are not a surprise:

- Only **one television at a time**. There is no group casting.
- Only **video files already on your PC**. There is no library, no playlist, and nothing from YouTube or Netflix.
