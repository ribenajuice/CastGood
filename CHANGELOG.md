# Changelog

All user-visible changes, in plain language, newest first.

<!-- ## YYYY-MM-DD
- You can now … -->

## 2026-09-08 — CastGood has a licence, and the installer says what it carries

**CastGood is now MIT licensed.** Anyone can use the code, change it, or build on it. Until
today the project had no licence at all, which technically meant nobody could legally do any
of those things.

**The installer now tells you what is inside it.** Alongside the app you will find its licence
and a notices file listing every piece of third-party software it bundles. Nothing about how
the app behaves has changed.

**One important distinction, in plain terms:** CastGood's own code is MIT, but the video engine
it ships — ffmpeg — is under a different licence (GPL) and always has been. CastGood runs it as
a separate program rather than building it in, which is what keeps the two licences apart. The
full ffmpeg licence, the exact build, and a pointer to its source all travel inside the
installer.


## 2026-09-04 — CastGood stops looking like a wireframe

**Every screen in the app has now been drawn properly.** Until today CastGood worked, but it was wearing placeholder styling — the design pass was deliberately held back until the app genuinely cast, so that nobody spent a week painting screens that might not survive. This is that week.

**Nothing about how it behaves has changed.** The words on screen are the same words, the buttons do the same things, and the engine underneath was not touched at all.

What you will notice:

- **The corners are round.** They were supposed to have been round already, and they were not: every panel, button, television row and subtitle row in the app was shipping with square left corners and a single rounded right edge. Two rules with the same name were fighting and the wrong one won. Nothing automatic noticed — the build was green and all 63 design checks passed. A person reading the app screen by screen found it.
- **The whole app is dark**, in one deliberate appearance. It does not follow Windows' own light/dark setting, because a light version is one nobody has approved yet.
- **Back 30s and Forward 30s are arrows with the number inside them** instead of words. From three metres away a word is only a shape. This is the one place the design pass changed *what* is on screen rather than how it looks.
- **The progress bar keeps up.** It had been taking half a second to slide across after every change; it now moves in under a fifth of one.
- **A button you cannot press no longer just fades.** It changes colour, and a main button that is unavailable loses its fill altogether — so nothing in the app can look pressable while doing nothing. That exact fault has been reported here twice.
- **The question before a long conversion is no longer red.** You press *Prepare and cast*, and the app was answering with the same red border it uses when something has broken. Nothing had broken. It is a question, and it now looks like one.
- **The subtitle controls moved below the playback controls.** They had been sitting above the one line the app uses to talk to you, pushing it down the window on every screen with a film chosen.
- **Smaller things you would only feel**: the chosen subtitle gets the same filled dot the television list uses, so it is obvious which one is on; *Preparing subtitles* now has the pulsing dot every other wait has; the progress bar can be reached from the keyboard and shows a proper focus ring; and the television list stops twitching by a pixel when you select something.
- **The window will not shrink below 880 × 800**, the size every screen is drawn to fit. CastGood needs a 1080p display or larger, and that is now enforced rather than assumed.

Also in this release, from the last few days:

- **A film that ends puts the app back exactly as it opens** — same film still selected, *Ready to cast*, one button. There is no separate *Finished* screen any more. (Your ruling, 2026-09-03.)
- **Stopped names the television you have selected now**, not the one the film happened to stop on. Your own report: *"there was no obvious button that felt safe to click."* The button was always right; the sentence was not.
- **Closing CastGood while a film is playing asks you inside the window.** That was the last pop-up dialog anywhere in the product, and it is gone.
- **A subtitle timing correction now belongs to the film**, not to the connection that happened to be carrying it — so it survives a wifi blip, a reconnect, and closing and reopening the app.
- **Under the hood**: Electron 44, and a fix so that an automatic check which *could not run* says so instead of reporting broken promises. A 36-second clip made the app look like it had three faults; it had none, and the file was too short.

Honest about what isn't proven:

- **Nothing has actually cast under Electron 44.** The upgrade was read line by line and then run on Windows — the window came up in under a second, and both televisions answered 288 discovery sweeps in a row — but the automatic check drives the engine without Electron around it, so it cannot answer this question. Only watching a television can.
- **The long hardware checks have not been re-run since the redesign.** Discovery, casting and the transport controls passed every assertion on the new build on 2026-09-04. The rest need a film, and there is no film on the PC. **One file closes all of it**: 90 minutes or more, HEVC, never cast through CastGood before, with a subtitle file beside it.
- **One thing still overflows at the smallest window size**: the list you pick a subtitle source from, while it is open. Every screen the app *holds* fits; that one, while you are choosing, does not.

## 2026-08-30 — Subtitles

**A film with mumbled dialogue, or one in a language you don't speak, is now watchable.** Subtitles are off unless you ask for them — if you never touch the control, you have exactly the app you had before.

What you can now do:

- **Turn subtitles on from any of three places**: a text track inside the film itself, a subtitle file sitting beside it (`Cars.srt`, `Cars.en.srt` or `Cars.vtt` beside `Cars.mkv`), or any file you go and pick. They are listed by name — no codec names, no file paths, no stream numbers.
- **Turn the chosen track on and off mid-film**, without the film reloading. Measured at **68 milliseconds** on an `AI PONT` television against a two-second target, with the film still playing throughout.
- **Nudge them into time while you watch.** A downloaded subtitle file is very often timed for a *different release* of the same film, which makes a film watchable-but-wrong for its whole length. Press Earlier or Later until the words land; Reset puts them back. There is no dialog and no Apply button, and the film does not reload for a nudge.
- **The correction sticks to the film.** Verified surviving a network outage, a reconnect and a complete restart of the app, with its +1.0 second correction still applied.
- **Your own subtitle file is never modified.** Nothing at all is written beside your film.
- **A subtitle that won't load does not take the film with it.** One sentence — *Subtitles didn't load* — seventeen seconds in, with the film still playing and nothing else disturbed.
- **A film with forty language tracks does not cost you forty jobs.** One chosen track, one extraction.

Measured: **85 of 85 checks on an `AI PONT` television**, including every timing case and the deliberately-broken one.

Not in here, on purpose: downloading subtitles from the internet, translation, generated or auto-transcribed subtitles, styling controls, two tracks at once, and **subtitle tracks that are pictures rather than text** — common inside downloaded remuxes. Putting those on a television means re-encoding every frame of a film that otherwise needs no work at all, which is the exact thing this app exists to avoid. CastGood names that in one sentence and offers you *Choose a file…* instead.

## 2026-08-26 — You no longer wait for the conversion

**When a film needs converting, you don't wait for the whole job any more.** CastGood starts converting, and starts the film as soon as it is safely far enough ahead.

- **Casting begins once ten minutes of the film are ready and the conversion is outrunning you** — on your PC it was running at nearly **ten times** real time when the film started. The rest converts behind you while you watch.
- **The film can never catch up with the conversion.** Zero stalls across 360 measurements on a real television.
- **If the whole job finishes first, the film simply plays.** A short film is never held up by a rule written for a long one.

Why the rule is that strict: it was measured going wrong first. A film started deliberately *outside* the rule, on a conversion running slower than real time, gave **six frozen pictures and 66.8 seconds of stopped screen in a six-minute run** — the worst single freeze 25.6 seconds. That is the evening this rule exists to prevent, and it is the reason CastGood would rather make you wait ten minutes than start early.

## 2026-08-25 — Films with surround sound now play in every room

**If a film had 5.1 surround sound, some of your televisions showed a fraction of a second of picture and then gave up.** Nothing on screen said why. The plain `Chromecast` did it worst: every HEVC film on the drive has surround sound, so *"any film plays"* — the whole promise of the last milestone — was not true on that set, and had not been since it shipped. Worse, it happened to films the app had called **Ready to cast**, and to films you had already waited through a conversion for.

CastGood now checks a film's sound against what the chosen television can actually decode, not just what *kind* of sound it is. When the sound is more than a set can handle, the app folds it to stereo — copying the picture untouched, so it is quick — and the film plays. You are not asked anything and nothing new appears on screen; films that used to die simply work now.

What this changes for you:

- **The plain `Chromecast` plays your surround-sound films.** Verified on it directly: a film goes in with 6-channel sound, the prepared file comes out with 2, and the television plays it. Checked by measuring the finished file itself rather than trusting what the app meant to do.
- **Films prepared before this fix are quietly repaired.** If CastGood made you a file back when it got this wrong, it notices the next time you pick that film, makes it once more, and never bothers you about it again. It does not go hunting across your drive — it fixes them as you meet them.
- **The `AI PONT` television keeps its surround sound.** It is the one set in the house that genuinely handles it, and it was measured doing so.
- **A film that dies mid-way is no longer reported as finished.** The app used to show *Finished* and *Play again* for a film that had collapsed two seconds in. It now tells you it stopped and keeps your place.

**One correction worth knowing about**, because it changed what the app does: we had assumed the Chromecast Ultra and the Google TV could handle surround sound, on the strength of the formats their profiles listed. Measured, the Ultra died on a 5.1 film in **81 milliseconds** — while the third-party `AI PONT` set played the same film for two minutes without a stumble. The two devices we had marked as the capable ones were the two that could not do it. Both now fold to stereo.

## 2026-08-20 — Any film plays

**Until now CastGood could only cast files your televisions already understood.** Anything else was your problem. This is the milestone that changes that, and it is the reason the whole app exists.

What you can now do:

- **Find out what a film needs before you commit to anything.** Pick a film and a television and CastGood tells you one of four things: *Ready to cast*, *Ready in about 20 seconds*, *Needs converting — about 6 minutes*, or *This file can't be cast*. Change the television and it checks again, because the answer depends entirely on which set the film is going to.
- **A film that only needs rewrapping takes seconds and loses nothing.** The picture and the sound are copied across untouched; only the box around them changes.
- **A film that genuinely needs converting converts only the part that needs it**, with a progress bar and a live estimate. You can cancel. If the job is going to run over 20 minutes, one question stands between your press and the work.
- **It casts by itself when the job finishes.** One press does the whole thing; you never press Cast twice.
- **No film is ever prepared twice.** The result is saved beside the original as `Cars (CastGood).mp4`, stays there until *you* delete it, and is used next time you pick that film.
- **Your own files are never moved, renamed or changed.** CastGood only ever touches files it named itself.
- **Your graphics card does the converting where it can** — the same file size and the same picture at **1.8× the speed** of the processor, and it falls back to the processor when the card can't help.

Measured: **32 of 32 checks** on a plain `Chromecast`, with M1 (43/43) and M2 (107/107) re-run on the same build to prove nothing older broke.

Not in here yet: watching a film before its conversion has finished, and subtitles. Both arrived within a fortnight.

## 2026-08-19 — Milestone 2, the evening that survives being interrupted

**M1 proved CastGood could put a film on a television. M2 is about what happens when the evening doesn't go to plan** — you want to jump to a different scene, someone grabs the TV, the wifi hiccups, you close the window by accident, or the file moves. Every one of those used to end the evening. None of them do now.

Everything below was measured on your own three TVs unless it says otherwise. The full automatic check scored **107 out of 107** on real hardware, and M1's original 43 checks still pass on the same build — nothing that worked before was broken to get here.

What you can now do:

- **Drag the progress bar and land where you dropped it.** Grab the scrubber, let go, and the film is playing at the new spot. On your TV a 25-minute jump forward landed dead on target in 47 milliseconds, and a 23-minute jump backwards in 67. Nothing is sent to the TV while you're still dragging — only the place you let go of. The readout shows where you're *going* while you drag, not where you were.
- **Back 30s and Forward 30s.** Tap as fast as you like: four taps inside half a second become **one** two-minute jump and one message to the TV, with a running `+2:00` on screen while they add up. Under 30 seconds into a film, Back 30s takes you to the start and says so rather than being a dead button. They stay live while the film is buffering — jumping away is the best escape from a bad buffer.
- **Lose the connection and get it back without touching anything.** If the link to the TV dies, the app says *Reconnecting to \<name\>…*, keeps your place, and puts the film back **within 2 seconds of where it dropped**. Nothing turns red and no dialog opens. Only after about 30 seconds of failing does it admit defeat — and then it tells you your place as a number.
- **Unplug your PC's network cable and be told the truth.** The app says *this PC is offline* rather than blaming the television. Proven by actually pulling the cable: 19 checks out of 19, back to playing **483 milliseconds** after the network returned, 0.004 seconds off where it had been. This matters more than it sounds — your PC has virtual network adapters that make it *look* online when the real cable is out, and an earlier version was fooled by exactly that.
- **Close CastGood mid-film and reopen it.** It picks the film back up on the TV where it was rather than starting it again. And closing the window while something is playing now *asks* whether to leave it playing.
- **Have someone take the TV, and get it back.** Cast from a phone and CastGood steps aside immediately — it never fights for the television. Your place is remembered, and taking it back put the film on screen at the right spot **6.6 seconds** after asking.
- **See a proper ending.** A film that reaches its end now gets its own *Finished* screen — the TV is back on its own home screen and nothing plays next by itself. And pressing Stop now offers **Resume from 0:32:10** as the main button, which loads the film already at that point instead of playing the opening titles first.
- **Move or delete the file mid-film without being nagged.** While the picture is fine, the app says nothing at all. Only when playback actually ends does it tell you the file moved, and offer to find it again — which opens the folder it used to be in and keeps your place.
- **Be told when Windows Firewall is the problem, and fix it in one press.** A TV that accepts the video but can never reach your PC used to be an endless spinner. Now it's named — *"Windows Firewall is blocking CastGood"* — **14.5 seconds** after you press Cast, with a button that fixes it. Press it, approve Windows' prompt, and **the film starts by itself** three seconds later. No re-picking the file or the TV.
- **Watch a full-length film without the clock drifting.** Two hours on a plain `Chromecast`: the position never wandered, and the trend across the whole run was flat.

Found by testing it like a person, not like a program:

Four faults survived 397 automated tests and were caught by sitting in front of the television — a *Choose video* button that silently did nothing, a *Find it again* that found your film and then threw away your place, a screen that told you to press a button it didn't have, and Windows' own firewall rule quietly outranking the button meant to fix it. All four are fixed, and each now has a test that fails without the fix.

Honest about what isn't proven:

- **Two ways of losing the television were deliberately not tested** — switching the router off, and leaving the TV unreachable for a full minute. A deliberate call, and a reasonable one, but it means two of the reconnection promises are proven in software and not on a TV.
- **A phone taking the television can't be named.** The `AI PONT` television takes **46 seconds** to admit what it's playing, against the 15 seconds the app is willing to wait — so it says *"\<name\> is playing something else"* rather than naming the app. Naming it is a bonus when the TV volunteers it, never a promise.
- **Nothing about preparing files exists yet.** No compatibility checking, no converting, no starting a film before the conversion finishes. That's Milestone 3.

## 2026-08-19 — Milestone 1, the casting skeleton *(merged 2026-08-18; released with M2)*

**It casts.** You have now put video on all three of your Chromecasts, more than once, from this build. Every number below was measured on your own TVs, not on a stand-in. Where something has only been tested inside the computer, it says so.

**Merged and released.** This is version 0.1.0, on `main`, with an installer cut from it.

What you can now do:

- **Find your Chromecasts without pressing anything.** Open the app and the list fills in. All three of your TVs appeared, under the names you gave them in Google Home, in about a quarter of a second — well inside the 3-second target for the first one. Switch a TV off and it drops out; switch it on and it comes back. Across a full session the list held steady: 43 checks, not one device wrongly dropped. (An earlier session ran 466 with the same result.)
- **Pick a video and see what you picked.** Choose a file and the app shows its name and how long it runs. Nothing is sent to any TV until you press Cast.
- **Cast it.** Press Cast and you get *Connecting* → *Starting* → *Buffering* → *Playing on \<TV name\>*. Picture on screen took 9.0 and 7.4 seconds in the two measured casts. The target is now 10 seconds, not 5 — because 7 to 9 of those seconds are the Chromecast starting up its own player, and nothing we write makes that faster. Better to have a target your TV can actually meet.
- **Pause, play and stop.** Pause lands in 45 milliseconds and resume in 105 — both far inside target. Stop hands the TV back to itself: your television is on its own home screen within about half a second, and any other app can use it straight away. Stop also remembers where you were and shows it as text.
- **See where you are, honestly.** Over 1,195 measurements the app's clock never drifted more than 0.28 seconds from what the TV itself reported, and it was just as accurate late in the file as early. Pause from the TV's own remote and the app follows.
- **Fail in plain words** *(tested in the lab, not yet on your TVs)*. A TV that is off or unreachable gets "Couldn't reach \<name\>" and a Try again, after two quiet retries you never see. A file the TV refuses gets "Couldn't play this file", the TV is released, and you are back where you started with your file and TV still chosen. No file paths, no codec names, no spinner that never ends.
- **Install without a firewall fight.** The installer asks once for permission to let CastGood through Windows Firewall, as narrowly as it can — this app only, your home network only, incoming only. This has now been checked on a real installation: the rules are there and they are correct. Say no and the install still works; you just get Windows' own popup at first launch instead.
- **See your own artwork on it.** CastGood now carries the icon you drew — on the installer, on the program itself, and on the Start-menu and desktop shortcuts.
- **Prove it yourself, without watching.** One command drives a real TV end to end with no window and no human, and prints its numbers: `scripts/win-test.sh --device "<TV name>" --file "<C:\path\to\video.mp4>" --scenario m1`. It cannot claim success without a real device having played real video — if it never reached a TV, it says so instead of passing.

Two things that had never been tested at all are now settled: the app can hold an encrypted conversation with a Chromecast, and a TV really can pull a 347 MB film off your PC across your own network. Those were the two biggest risks in the whole project.

Still to settle:

- **A clean run of the full automatic check against this build.** The last complete run scored 37 out of 43 — but it was testing an older build, and both things it complained about (the old 5-second target, and one position error) have since been dealt with. That needs re-running before anyone calls M1 finished.
- **A whole 2-hour film, start to end, with the clock watched throughout.** The accuracy above is excellent but it covers minutes, not a feature film.
- **Anything that goes wrong mid-film.** Dropped wifi, a sleeping PC, someone else grabbing the TV from their phone — none of that is built yet, let alone tested. That is the next milestone.

Still not in here, on purpose: seeking, the ±30 second skip buttons, *Resume from where I left off*, the *Finished* screen, recovery from interruptions, remembering your last device, and anything to do with checking or preparing files a TV cannot play as-is. Those are the next two milestones.

## 2026-08-14 — 0.1.0

**This version does not cast anything yet.** It is the foundation everything else gets built on. You can install it and open it, and that is all it does on purpose.

- You can now install CastGood on Windows from a normal installer and open it. A window appears, and the app records what it did to a log file so we can check it behaved.
- You can now click through the whole app before it exists: a clickable state map shows every screen CastGood will have, including the 30-second skip buttons and the warning before a long conversion.
- The plan is written down, including how the app is put together — see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

**Not in this release:** finding your Chromecast, picking a file, casting, play, pause, stop, seeking, or preparing files. None of that is written yet — those parts of the app deliberately refuse to run rather than pretend to work. Casting starts in the next milestone.
