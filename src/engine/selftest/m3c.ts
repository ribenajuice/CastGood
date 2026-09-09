import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { SUBTITLES, PREPARATION, SELFTEST, SKIP, TIMING } from '../config.js';
import { buildLadder, LADDER_STEP_MS } from '../subtitles/ladder.js';
import { cueAt, parseCues, type Cue } from '../subtitles/cues.js';
import { assertion, observation, SelftestAbort, type Assertion } from './kit.js';
import type { Context } from './index.js';
import { chooseAndCheck, contentsOf } from './m3.js';

/**
 * **M3c's `subtitles` scenario** — the words go out, and *Off* still means silence.
 *
 * What this proves that no headless test can: a **real television** fetched a track from a
 * URL CastGood declared, over the wire, with the film still playing. And the half that
 * matters more — that a founder who never touches the control gets the app they had before
 * (19a) — measured against the same device rather than asserted from the inside.
 *
 * **What it deliberately does not claim.** It never asserts that words appeared on a screen,
 * or that they were in time with the film. Only a person can read a television, 18g says so
 * in as many words, and the checklist owns it. An instrument that claimed otherwise would be
 * the most expensive lie available in this milestone.
 *
 * **19a's two halves, and where each lives.** The *byte-for-byte* half — that the LOAD is
 * identical to a recording taken from `main` before M3c existed — is measured in
 * `test/engine/m3c-load-golden.test.ts`, headless, against three shapes, with a negative
 * control. It belongs there because it needs no device and a device would only add noise.
 * What is measured **here** is the other half, the one only a television can answer:
 * *"no track URL served, nothing extracted"* — zero `.vtt` mounts, zero subtitle HTTP
 * requests, zero extractions, on a real cast to a real set.
 *
 * **The exit-code contract, applied.** A film with no text track inside it and no sidecar
 * beside it cannot produce the condition this scenario exists to test, so it exits **2**,
 * never 0. A subtitle test that quietly became an ordinary cast and went green would be
 * exactly the failure M3's selftest clause was written to forbid.
 */

/** A mount is CastGood's own subtitle working copy iff it is the `.vtt` one. */
function isTrackMount(name: unknown): boolean {
  return typeof name === 'string' && name.toLowerCase().endsWith('.vtt');
}

/**
 * Tokens of every `.vtt` mount made so far, newest last — optionally only since an instant.
 *
 * **`afterMono` exists because of the `m3c` aggregate, and it is a fault in the instrument
 * rather than a change to what anything promises.** Every reader here but one wants the
 * newest mount and is unaffected by history; the one that counts them — 19a's *"pressing
 * Cast without touching the control serves no track URL at all"* — was counting mounts
 * from the beginning of the **run**, not from the cast it is about. Alone that is the same
 * number, because nothing has been mounted yet when it is taken. Run second in an
 * aggregate, behind a leg that legitimately served three, it read 3 against a target of 0
 * and reported a defect that was the harness's own bookkeeping.
 */
function trackTokens(context: Context, afterMono?: number): string[] {
  return context
    .samples('media.mounted', afterMono)
    .filter((record) => isTrackMount(record['name']))
    .map((record) => String(record['token']));
}

/**
 * Did the television actually come and fetch this mount?
 *
 * **`media.first_request`, not `media.request`.** The latter is logged at `debug` and the
 * engine's default level is `info`, so counting it measured the **logger's threshold** and
 * never the television — it read 0 on the first run of this scenario, and "0 fetches" is
 * exactly what a real failure looks like. That is the fault SPIKE-3 caught in itself on
 * 2026-08-26, where two probes rode a path that produced no fetches at all and the reader
 * could easily have filed the silence as a CORS finding. `media.first_request` is `info`,
 * fires once per mount, and exists to answer precisely this question.
 */
function wasFetched(context: Context, token: string): boolean {
  return context.samples('media.first_request').some((record) => String(record['token']) === token);
}

/**
 * The **name** the last cast handed the television — the last segment of the media URL.
 *
 * Deliberately not the whole URL. Every cast mounts afresh and a mount token is random per
 * session, so two URLs from two casts differ in the token whatever else is true; comparing
 * them reports a difference on every run and says nothing at all about subtitles. What 18e
 * promises is that **the video sent is unchanged** — the same file, cast the same way — and
 * the name is what carries that.
 */
function lastVideoName(context: Context): string | null {
  const loads = context.samples('session.loading');
  const last = loads[loads.length - 1];
  if (last === undefined) return null;
  const url = String(last['url']);
  return url.slice(url.lastIndexOf('/') + 1);
}

/**
 * How long to let a cast reach the picture before calling the run impossible.
 *
 * **Generous on purpose, and it is not a cast-speed promise** — nothing here grades how fast
 * a film starts; `m1` does that. It is a *precondition*, and it has to tolerate the film
 * needing preparing first, because on the founder's own library **every film with an
 * embedded subtitle track is a Matroska** and no Chromecast takes Matroska: each one is at
 * least a lossless repackage away from playing. A tighter bound made this scenario exit 2 on
 * every film that could exercise the extraction path, which would have left the whole
 * embedded half of the milestone provable only in WSL.
 *
 * A film that needs a full re-encode still exceeds this, and still exits 2 rather than
 * failing — that is the right answer, and it is what the run against a 5.1 HEVC film did.
 */
const REACH_PICTURE_MS = 6 * 60_000;

async function castAndPlay(context: Context, what: string): Promise<void> {
  context.engine.dispatch({ type: 'cast.start' });
  await context.waitForState('playing', PREPARATION.checkBudgetMs + REACH_PICTURE_MS).catch(() => {
    throw new SelftestAbort(
      `the television never reached playing ${what} within ${String(Math.round(REACH_PICTURE_MS / 60_000))} minutes. ` +
        `If this film needs a full conversion for this television, pass one it can play with at most a repackage — ` +
        `nothing measured after this point would be a fact about subtitles`,
    );
  });
}

/**
 * Where the **device** says it is, from its own status arrivals.
 *
 * The same rule every M2 scenario is graded by, and for the same reason: our readout leads
 * the device through a seek by design (6e), so grading a jump against our own screen would
 * measure nothing but our own confidence.
 */
function deviceSecAfter(context: Context, afterMono: number): number | null {
  const sample = [...context.samples('position.sample', afterMono)]
    .reverse()
    .find((record) => typeof record['deviceSec'] === 'number' && record['heldForSeek'] !== true);
  return sample === undefined ? null : Number(sample['deviceSec']);
}

/** Waits until the television itself reports a position near `targetSec`. */
async function waitForDeviceNear(
  context: Context,
  targetSec: number,
  toleranceSec: number,
  timeoutMs: number,
): Promise<number | null> {
  const from = context.mono();
  const deadline = from + timeoutMs;
  for (;;) {
    const at = deviceSecAfter(context, from);
    if (at !== null && Math.abs(at - targetSec) <= toleranceSec) return at;
    if (context.mono() >= deadline) return deviceSecAfter(context, from);
    await context.sleep(100);
  }
}

/**
 * **The words the television is holding**, fetched back off our own media server.
 *
 * Not a copy of what we think we sent: the rung the set is showing is a URL, and this is a
 * GET of that URL. It is the only way a headless run can ask *"which line belongs at this
 * position"* about the same bytes the device is rendering — and it re-proves 20g on the way
 * past, because those bytes exist nowhere but in this response.
 */
async function servedCues(context: Context, offsetMs: number): Promise<Cue[] | null> {
  const tokens = trackTokens(context);
  const token = tokens[tokens.length - 1];
  const port = context.engine.mediaServerPort;
  if (token === undefined || port === null) return null;
  const url = `http://127.0.0.1:${String(port)}/m/${token}/sub/${String(offsetMs)}.vtt`;
  const body = await new Promise<string | null>((resolve) => {
    const request = http.get(url, (response) => {
      if (response.statusCode !== 200) {
        response.resume();
        resolve(null);
        return;
      }
      let text = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => (text += chunk));
      response.on('end', () => resolve(text));
      response.on('error', () => resolve(null));
    });
    request.on('error', () => resolve(null));
    request.end();
  });
  return body === null ? null : parseCues(body);
}

/** The line a television showing these cues would have on screen at this instant. */
function lineAt(cues: readonly Cue[], atMs: number): string {
  return cueAt(cues, atMs)?.text.replace(/\s+/g, ' ').trim() ?? '(no line)';
}

/**
 * A cue worth jumping to: **long range from where we are, and wide enough to land in**.
 *
 * A one-frame cue could be passed by luck and failed by rounding, and a cue in the opening
 * seconds is not a jump. `null` means this subtitle file cannot produce the condition 18i
 * exists to test on this film, which is exit 2 rather than a pass.
 */
function jumpTargetFor(
  cues: readonly Cue[],
  fromSec: number,
  durationSec: number,
): { atSec: number; text: string } | null {
  let best: { atSec: number; text: string } | null = null;
  let bestDistance = 0;
  for (const cue of cues) {
    if (cue.endMs - cue.startMs < 1_500) continue;
    const atSec = (cue.startMs + cue.endMs) / 2_000;
    if (atSec < 30 || (durationSec > 0 && atSec > durationSec - 60)) continue;
    const distance = Math.abs(atSec - fromSec);
    if (distance < 60 || distance <= bestDistance) continue;
    bestDistance = distance;
    best = { atSec, text: cue.text.replace(/\s+/g, ' ').trim() };
  }
  return best;
}

/**
 * Every file in the founder's folder, as bytes and modification times — **20g's evidence**.
 *
 * Names alone are not the criterion: *"byte-for-byte unchanged, its modified time is
 * unchanged, and no new file appears beside it."* Subtitle-shaped files are hashed, because
 * they are the ones this feature reads and the ones the criterion is about; everything else
 * — the film itself, a prepared copy — is compared by size and mtime, because hashing a
 * 4 GB remux on every run would cost more than the assertion is worth.
 */
async function folderFingerprint(dir: string): Promise<Map<string, string>> {
  const marks = new Map<string, string>();
  for (const name of await contentsOf(dir)) {
    const full = path.join(dir, name);
    try {
      const stat = await fsp.stat(full);
      if (!stat.isFile()) continue;
      const subtitleShaped = /\.(srt|vtt|ass|ssa|sub|idx)$/i.test(name);
      const digest = subtitleShaped
        ? crypto
            .createHash('sha256')
            .update(await fsp.readFile(full))
            .digest('hex')
            .slice(0, 16)
        : 'not-hashed';
      marks.set(
        name,
        `${String(stat.size)}B mtime=${String(Math.round(stat.mtimeMs))} sha=${digest}`,
      );
    } catch {
      marks.set(name, 'unreadable');
    }
  }
  return marks;
}

/** What changed between two fingerprints, in the founder's own words: file names. */
function changedFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changes: string[] = [];
  for (const [name, mark] of after) {
    const was = before.get(name);
    if (was === undefined) changes.push(`${name} (new)`);
    else if (was !== mark) changes.push(`${name} (changed)`);
  }
  for (const name of before.keys()) if (!after.has(name)) changes.push(`${name} (gone)`);
  return changes;
}

async function stopAndSettle(context: Context): Promise<void> {
  context.engine.dispatch({ type: 'cast.stop' });
  await context
    .waitFor(
      'the television to be released',
      10_000,
      (snapshot) => snapshot.session.state !== 'playing',
    )
    .catch(() => undefined);
  await context.sleep(500);
}

/**
 * **The four shapes 18j names, as bytes** — written by the run, chosen through the app's own
 * picker route, and never mocked.
 *
 * The fourth is the one worth reading twice: **UTF-16 with no byte-order mark**. A file with
 * a BOM is a perfectly ordinary Windows subtitle and is decoded and used; one without has
 * nothing in it that says what encoding it is and half its bytes are NULs. That is *"an
 * encoding we cannot decode"*, and it has to be refused rather than turned into a track of
 * replacement characters that a television would happily display.
 */
function utf16NoBom(text: string): Buffer {
  const bytes = Buffer.alloc(text.length * 2);
  for (let at = 0; at < text.length; at += 1) bytes.writeUInt16LE(text.charCodeAt(at), at * 2);
  return bytes;
}

const BROKEN_FIXTURES: readonly { readonly name: string; readonly bytes: Buffer }[] = [
  { name: 'empty.srt', bytes: Buffer.alloc(0) },
  { name: 'binary.srt', bytes: Buffer.from([0x1f, 0x8b, 0x08, 0x00, 0x02, 0xff, 0x00, 0x13]) },
  {
    name: 'not-found.srt',
    bytes: Buffer.from(
      '<!DOCTYPE html>\n<html><head><title>404 Not Found</title></head><body>That subtitle is gone.</body></html>\n',
      'utf8',
    ),
  },
  {
    name: 'utf16-no-bom.srt',
    bytes: utf16NoBom('1\n00:00:01,000 --> 00:00:03,000\nHello.\n'),
  },
];

export async function scenarioSubtitles(context: Context): Promise<Assertion[]> {
  // **A different run, not an extra block on this one.** `--broken` proves the refusals and
  // nothing else: the ordinary run's own preconditions — a track that works, a jump with a
  // cue to land on — have nothing to do with what happens when a subtitle fails.
  if (context.subtitleBroken) return await brokenRun(context);
  const assertions: Assertion[] = [];
  const folder = path.dirname(context.filePath);
  const before = await contentsOf(folder);
  // 20g asks for **byte-for-byte**, not "no new names", so the bytes and the modification
  // times are taken now and compared at the end. See `folderFingerprint`.
  const marksBefore = await folderFingerprint(folder);

  // --- 18a: the list, inside 7a's budget rather than on top of it -------------
  const { elapsedMs } = await chooseAndCheck(context, context.filePath);
  const listed = context.snapshot().subtitles;

  if (listed.options.length === 0) {
    // The condition this scenario exists to test does not exist on this film. Exit 2.
    throw new SelftestAbort(
      `“${path.basename(context.filePath)}” has no text subtitle track inside it and no subtitle file beside it, ` +
        `so there is nothing for this scenario to send. Pass a film with an embedded text track (SubRip, ASS or mov_text) ` +
        `or one with a matching .srt/.vtt sibling. ${String(listed.unavailable.length)} picture-only track(s) were listed and refused (18k).`,
    );
  }

  assertions.push(
    assertion(
      'checkWithListMs',
      'lte',
      PREPARATION.checkBudgetMs,
      elapsedMs === null ? null : Math.round(elapsedMs),
      'ms',
      'PRD 18a: the subtitle list arrives inside the same 3 s check budget as 7a, not on top of it',
    ),
    assertion(
      'subtitlesOffAfterCheck',
      'eq',
      'off',
      listed.selectedId === null ? 'off' : `selected: ${listed.selectedId}`,
      'state',
      'PRD 19a: whatever the film contains, the control reads Off when the check completes',
    ),
    observation(
      'sourcesOffered',
      listed.options.map((option) => option.label).join(' · '),
      'labels',
      'what the founder would read in the menu — 18a forbids codec names, stream indices and file paths here',
    ),
    observation(
      'pictureTracksRefused',
      listed.unavailable.length,
      'tracks',
      'PRD 18k: picture subtitles are listed and refused, never re-encoded and never hidden',
    ),
  );

  // 18a in as many words: **no codec names, no stream indices, no file paths.**
  const menu = JSON.stringify(listed.options.map((option) => option.label)).toLowerCase();
  const leaked = ['h264', 'hevc', 'subrip', 'mov_text', 'ffmpeg', 'stream', ':\\\\', '/'].filter(
    (word) => menu.includes(word.toLowerCase()),
  );
  assertions.push(
    assertion(
      'noTechnicalDetailInMenu',
      'eq',
      'none',
      leaked.length === 0 ? 'none' : leaked.join(', '),
      'terms',
      'PRD 18a: no codec name, no stream index and no file path appears in the subtitle menu',
    ),
  );

  // --- 19a on the wire: press Cast without touching the control ---------------
  const beforeOffCast = context.mono();
  await castAndPlay(context, 'with subtitles off');
  await context.sleep(3_000);

  // **Since this cast**, not since the run began: see `trackTokens`. What 19a promises is
  // that *this* Cast press served no track, and in an aggregate the legs before it have
  // legitimately served plenty.
  const offTrackMounts = trackTokens(context, beforeOffCast).length;
  const offExtractions = context.samples('subtitle.prepared', beforeOffCast).length;
  const videoNameOff = lastVideoName(context);

  assertions.push(
    assertion(
      'declaredTracksWhenOff',
      'eq',
      0,
      offTrackMounts,
      'mounts',
      'PRD 19a: pressing Cast without touching the control serves no track URL at all',
    ),
    assertion(
      'extractionsWhenOff',
      'eq',
      0,
      offExtractions,
      'extractions',
      'PRD 19a: nothing is extracted for a film whose subtitles were never turned on',
    ),
  );

  await stopAndSettle(context);

  // --- 18d: choosing one source costs exactly one extraction -----------------
  const chosen = listed.options[0];
  if (chosen === undefined) throw new SelftestAbort('the subtitle list emptied between two reads');

  const beforeChoose = context.mono();
  context.engine.dispatch({ type: 'subtitles.select', sourceId: chosen.id });
  await context
    .waitFor(
      'the subtitle to be prepared',
      SUBTITLES.prepareBudgetMs + 60_000,
      (snapshot) => !snapshot.subtitles.preparing,
    )
    .catch(() => {
      throw new SelftestAbort(
        'the subtitle preparation never finished, so there is nothing to send',
      );
    });

  const afterChoice = context.snapshot().subtitles;
  if (afterChoice.selectedId !== chosen.id) {
    throw new SelftestAbort(
      `“${chosen.label}” could not be prepared${afterChoice.problem === null ? '' : `: ${afterChoice.problem}`} — ` +
        `so this run never had a track to send, which is a condition that did not happen rather than a promise that failed`,
    );
  }

  const prepared = context.samples('subtitle.prepared', beforeChoose);
  const prepMs = prepared[0]?.['elapsedMs'];

  assertions.push(
    assertion(
      'preparationsForOneChoice',
      'eq',
      1,
      prepared.length,
      'preparations',
      'PRD 18d: only the chosen source is read — a film with six language tracks costs exactly one preparation, not six. `preparedRoute` below says whether ffmpeg was needed at all: a .srt or .vtt sidecar costs zero processes',
    ),
    assertion(
      'subtitlePrepMs',
      'lte',
      SUBTITLES.prepareBudgetMs,
      typeof prepMs === 'number' ? Math.round(prepMs) : null,
      'ms',
      'PRD 18d: extract and convert one track within 5 s, or it appears as its own named step',
    ),
    observation(
      'preparedRoute',
      String(prepared[0]?.['route'] ?? 'unknown'),
      'route',
      'how the words were obtained: parse (already text), extract (a stream inside the film) or convert (ASS/SSA)',
    ),
    observation(
      'preparedCues',
      Number(prepared[0]?.['cues'] ?? 0),
      'cues',
      'how many cues came out — a track that parsed to none is never served and never declared (18j’s floor)',
    ),
  );

  // --- 18e: the track is served, and the video is unchanged ------------------
  const beforeOnCast = context.mono();
  await castAndPlay(context, 'with a subtitle chosen');
  await context.sleep(5_000);

  const tokens = trackTokens(context);
  const token = tokens[tokens.length - 1];
  const fetched = token !== undefined && wasFetched(context, token);
  const videoNameOn = lastVideoName(context);

  assertions.push(
    assertion(
      'trackFetchedByDevice',
      'eq',
      'fetched',
      token === undefined ? 'no track was mounted at all' : fetched ? 'fetched' : 'never fetched',
      'fetch',
      'PRD 18e: the television actually came and got the declared track from CastGood’s own media server. This is the one thing here no headless test can stand in for',
    ),
    assertion(
      'videoUnchangedByASubtitle',
      'eq',
      'identical',
      videoNameOff === null || videoNameOn === null
        ? null
        : videoNameOff === videoNameOn
          ? 'identical'
          : `${videoNameOff} → ${videoNameOn}`,
      'media',
      'PRD 18e: choosing a subtitle never changes which file is cast — same file, cast the same way, with and without a track',
    ),
    assertion(
      'filmStillPlayingWithTrack',
      'eq',
      'playing',
      context.snapshot().session.state,
      'state',
      'PRD 18g’s precondition: the film is playing with the track declared. Whether the words are legible and in time is checklist item 1',
    ),
    observation(
      'subtitleLabelOnScreen',
      String(context.snapshot().session.subtitleLabel ?? 'none'),
      'label',
      'PRD 18g: what the app says is on, so the founder can tell without looking at the television',
    ),
    observation(
      'preparationsAfterOneCast',
      context.samples('subtitle.prepared', beforeOnCast).length,
      'extractions',
      'casting a prepared track must not extract it a second time',
    ),
  );

  // --- 18i and 18h: the words keep up, and they survive being interrupted -----
  assertions.push(...(await seekingAssertions(context)));
  assertions.push(...(await survivalAssertions(context)));

  // --- Story 20, and only when it was asked for: `--timing` -------------------
  //
  // **A separate run because it is a separate promise.** The block above proves a track
  // reaches a television; this one proves it can be *moved* while the film is playing, which
  // is what SPIKE-3 bought and what step 4 built. It runs on the session that is still up —
  // stopping first would throw away the very thing under test.
  if (context.subtitleTiming) assertions.push(...(await timingAssertions(context)));

  await stopAndSettle(context);

  // --- 20f: the correction is still there next time, in a **second engine run** -
  //
  // Two runs, because one proves nothing about surviving a restart: a single process can
  // "remember" an offset by never having forgotten it. The engine below is a new one
  // reading the settings file this one wrote.
  if (context.subtitleTiming) {
    assertions.push(...(await rememberedOffsetAssertions(context, chosen)));
  }

  // --- 18c / 20g: the subtitle feature wrote nothing beside the founder's film -
  //
  // **Preparation artifacts are excluded, and the distinction is the whole assertion.**
  // Casting a Matroska legitimately produces `<stem> (CastGood).mp4` beside the source —
  // the founder's own 2026-08-19 ruling — and M3a's criterion **8e** writes the film's
  // subtitle tracks out beside it as `<stem> (CastGood).<lang>.vtt`, so that a lossless
  // repackage never silently throws a subtitle away. Both are `prepare/`'s work and both
  // predate this milestone. What **20g** forbids is *this* feature adding anything: the
  // chosen track's working copy is CastGood's own and belongs in the app's directory.
  // A flat before/after comparison conflates the two and fails on any film that needed
  // preparing — which, on this library, is every film with an embedded track.
  const preparationArtifact = (name: string): boolean => name.includes('(CastGood)');
  const added = (await contentsOf(folder)).filter(
    (name) => !before.includes(name) && !preparationArtifact(name),
  );
  const marksAfter = await folderFingerprint(folder);
  assertions.push(
    assertion(
      'nothingWrittenBesideTheFilm',
      'eq',
      'nothing',
      added.length === 0 ? 'nothing' : added.join(' | '),
      'files',
      'PRD 18c and 20g: choosing a subtitle moves, copies and renames nothing, and adds no file of its own beside the film. Preparation artifacts — `(CastGood)` — are 8e’s and are excluded by name',
    ),
    assertion(
      'sourceFolderByteForByteUnchanged',
      'eq',
      'unchanged',
      (() => {
        const changed = changedFiles(marksBefore, marksAfter).filter(
          (entry) => !preparationArtifact(entry),
        );
        return changed.length === 0 ? 'unchanged' : changed.join(' | ');
      })(),
      'files',
      'PRD 20g: the founder’s own subtitle file is byte-for-byte unchanged and its modified time is unchanged — asserted on content and mtime, not on file names, because a rewrite in place changes neither the listing nor the count. 8e’s `(CastGood)` artifacts are preparation’s and are excluded by name',
    ),
    observation(
      'preparationArtifactsBesideFilm',
      (await contentsOf(folder)).filter(
        (name) => !before.includes(name) && preparationArtifact(name),
      ).length,
      'files',
      'what preparation left beside the source on this run — 8e’s subtitle preservation and the prepared copy itself. Not this milestone’s, and reported rather than asserted',
    ),
  );

  return assertions;
}

/**
 * **`subtitles --broken` — the refusal paths, on a real television.** 18j, 18k, 18l.
 *
 * The other two runs of this scenario prove that subtitles *work*. This one proves that when
 * they cannot, the founder is told once and the film is left alone — which is the promise
 * that decides whether this milestone is safe to have on at all.
 *
 * Three conditions, produced rather than described:
 *
 *  1. **Four files that cannot be read**, written here as real bytes and chosen through the
 *     app's own picker route (18c) — an empty file, a binary, an HTML page saved as `.srt`,
 *     and a UTF-16 file with no byte-order mark to say what it is. Each must be refused
 *     **before Cast**, in one sentence, with no file path in it.
 *  2. **A picture-only track**, which is the film's business rather than ours: it is graded
 *     when the film has one and reported as absent when it does not (18k's own hardware
 *     evidence is checklist item 5, which is a person reading a television).
 *  3. **A declared track the television never fetches** — the one that needed a new harness
 *     verb. A real set always tries, so the track is declared at a **port this PC does not
 *     answer on**: the film keeps arriving from the port it was given, and the words are
 *     genuinely unreachable. Nothing about the measurement is faked; `hasServedRequest` is
 *     false because no request ever arrived.
 *
 * **The exit-code contract, applied twice.** A film with no subtitle source at all cannot
 * produce condition 3, and a run in which the television *did* fetch the withheld track did
 * not produce it either. Both exit **2**. A refusal run that quietly became an ordinary
 * successful cast and went green is the most expensive lie available in this milestone.
 */
async function brokenRun(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const work = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-broken-'));

  try {
    const { elapsedMs } = await chooseAndCheck(context, context.filePath);
    const listed = context.snapshot().subtitles;

    assertions.push(
      observation(
        'checkWithListMs',
        elapsedMs === null ? null : Math.round(elapsedMs),
        'ms',
        'how long the check took on this pairing — 18a owns the 3 s budget and the ordinary run grades it; here it only says the list was ready',
      ),
    );

    // --- 18j: four files that cannot be read, refused before Cast --------------
    const readyBefore = JSON.stringify(context.snapshot().file);
    let refused = 0;
    let leaks: string[] = [];
    const sentences: string[] = [];

    for (const fixture of BROKEN_FIXTURES) {
      const file = path.join(work, fixture.name);
      await fsp.writeFile(file, fixture.bytes);
      context.engine.dispatch({ type: 'subtitles.chooseFile', path: file });
      await context
        .waitFor(
          `${fixture.name} to be read`,
          SUBTITLES.prepareBudgetMs + 30_000,
          (snapshot) => !snapshot.subtitles.preparing,
        )
        .catch(() => undefined);

      const after = context.snapshot();
      const problem = after.subtitles.problem;
      if (after.subtitles.selectedId === null && problem !== null) refused += 1;
      if (problem !== null) {
        sentences.push(problem);
        // 18j says it twice: **no parser output and no file path**. Checked against the
        // path the founder just pointed at, which is the only path that can leak.
        leaks = leaks.concat(
          [file, work, fixture.name, '\\', '/', 'parse', 'cue', 'utf', 'ffmpeg'].filter((term) =>
            problem.toLowerCase().includes(term.toLowerCase()),
          ),
        );
      }
    }

    assertions.push(
      assertion(
        'unreadableFilesRefusedBeforeCast',
        'eq',
        BROKEN_FIXTURES.length,
        refused,
        'files',
        'PRD 18j: an empty file, a binary, an HTML page saved as .srt and an undecodable encoding are each refused at the moment they are chosen, with the control back at Off. Never a failed cast, and never a film that plays with a blank track',
      ),
      assertion(
        'refusalSaysNothingTechnical',
        'eq',
        'none',
        leaks.length === 0 ? 'none' : [...new Set(leaks)].join(', '),
        'terms',
        'PRD 18j, twice over: no parser output and no file path ever reaches the founder. The sentence is checked against the path they just pointed at',
      ),
      assertion(
        'filmStillReadyAfterARefusal',
        'eq',
        'unchanged',
        JSON.stringify(context.snapshot().file) === readyBefore ? 'unchanged' : 'changed',
        'verdict',
        'PRD 18j: the film stays exactly as ready to cast as it was, without subtitles',
      ),
      observation(
        'refusalSentences',
        [...new Set(sentences)].join(' · '),
        'sentences',
        'what the founder actually reads when a file cannot be used — eyes on the wording, exactly as 18a asks of the menu',
      ),
      // 18k. The film's own business: a library of remuxes has these and a clean library
      // does not, so it is graded when the condition exists and named when it does not.
      observation(
        'pictureTracksListedAndRefused',
        listed.unavailable.length,
        'tracks',
        'PRD 18k: picture subtitles are listed as unavailable with one line saying why, never hidden and never re-encoded. Zero here means this film has none — the sentence itself is checklist item 5, which only a person can read',
      ),
      observation(
        'pictureTrackSentences',
        listed.unavailable.map((entry) => `${entry.label}: ${entry.why}`).join(' · ') || 'none',
        'sentences',
        'the one line each picture-only track is refused with',
      ),
    );

    // --- 18l: a track the television cannot fetch ------------------------------
    const source = listed.options[0];
    if (source === undefined) {
      throw new SelftestAbort(
        `“${path.basename(context.filePath)}” has no text subtitle track inside it and no subtitle file beside it, ` +
          `so this run has no track to declare and 18l cannot be produced. Pass a film with an embedded text track ` +
          `or a matching .srt/.vtt sibling. The 18j half of this run needs no film and passed above.`,
      );
    }

    context.engine.dispatch({ type: 'subtitles.select', sourceId: source.id });
    await context
      .waitFor(
        'the subtitle to be prepared',
        SUBTITLES.prepareBudgetMs + 60_000,
        (snapshot) => !snapshot.subtitles.preparing,
      )
      .catch(() => undefined);
    if (context.snapshot().subtitles.selectedId !== source.id) {
      throw new SelftestAbort(
        `“${source.label}” could not be prepared, so this run never had a good track to withhold — ` +
          `a condition that did not happen rather than a promise that failed`,
      );
    }

    // **The words are put out of reach and the film is not.** See `withholdTracks`.
    context.withholdTracks(true);
    const beforeCast = context.mono();
    await castAndPlay(context, 'with a track the television cannot fetch');
    const loadsAfterCast = context.samples('session.loading', beforeCast).length;
    const positionAtFailure = context.snapshot().session.positionSec;

    const toldAt = await context
      .waitFor(
        'the founder to be told the track did not load',
        TIMING.firewallDiagnosisMs + 20_000,
        (snapshot) => snapshot.subtitles.canRetry,
      )
      .catch(() => null);

    const track = trackTokens(context).at(-1);
    // **The honesty gate.** If the set fetched the track anyway, this run did not produce
    // the condition 18l is about, and a green verdict would be a lie about a promise that
    // was never tested.
    if (track !== undefined && wasFetched(context, track)) {
      throw new SelftestAbort(
        'the television fetched the withheld track anyway, so “a declared track it never fetched” never happened on this run',
      );
    }

    assertions.push(
      assertion(
        'subtitlesDidNotLoadSaid',
        'eq',
        'said',
        toldAt === null ? 'nothing was said' : 'said',
        'sentence',
        'PRD 18l: the television accepted the film and never fetched the track, and the app says so rather than leaving the founder watching a film with no words and no explanation',
      ),
      assertion(
        'subtitlesDidNotLoadMs',
        'lte',
        TIMING.firewallDiagnosisMs + SELFTEST.stateWaitMs,
        toldAt === null ? null : Math.round(toldAt - beforeCast),
        'ms',
        'PRD: “the same window as the firewall diagnosis (17a)” — an existing budget reused rather than a new number invented. Measured from the Cast press, so the television’s own boot time is inside it',
      ),
      assertion(
        'filmStillPlayingAfterASubtitleFailure',
        'eq',
        'playing',
        context.snapshot().session.state,
        'state',
        'PRD 18l, and the whole point of it: subtitles never take a working film down with them',
      ),
      assertion(
        'loadsCausedByASubtitleFailure',
        'eq',
        0,
        Math.max(0, context.samples('session.loading', beforeCast).length - loadsAfterCast),
        'loads',
        'PRD 18l: nothing about a track that failed may stop, reload or re-LOAD a film that is playing',
      ),
      assertion(
        'repairsCausedByASubtitleFailure',
        'eq',
        0,
        context.samples('media.path_repairing', beforeCast).length,
        'repairs',
        'defect D2’s repair exists for the **film’s** bytes. A text track nobody fetched is not a dead film delivery, and must never arm or trip it',
      ),
      assertion(
        'firewallBlamedForASubtitle',
        'eq',
        'never',
        context.samples('session.media_never_fetched', beforeCast).length === 0
          ? 'never'
          : 'the film was reported as never fetched',
        'diagnosis',
        '17a is about the film’s own bytes, and they arrived. A subtitle must never be able to accuse the founder’s firewall',
      ),
      assertion(
        'tryAgainOffered',
        'eq',
        'offered',
        context.snapshot().subtitles.canRetry ? 'offered' : 'not offered',
        'action',
        'PRD 18l: “Subtitles didn’t load” with **Try again** beside it — a way out, not a dead end',
      ),
      observation(
        'subtitleFailureSentence',
        String(context.snapshot().subtitles.problem ?? 'nothing was said'),
        'sentence',
        'what the founder reads while the film carries on playing behind it',
      ),
    );

    // --- Try again, with the way back open ------------------------------------
    context.withholdTracks(false);
    const beforeRetry = context.mono();
    context.engine.dispatch({ type: 'subtitles.retry' });
    await context
      .waitFor(
        'the film to be playing again after the retry',
        SELFTEST.stateWaitMs + 30_000,
        (snapshot) => snapshot.session.state === 'playing' && !snapshot.subtitles.reloading,
      )
      .catch(() => undefined);
    // Let the reload's own re-buffer happen, and then let it *finish*.
    //
    // **A blind sleep here is what made 2026-08-28's run fail on hardware.** Try again
    // re-declares the track, which is the new-track reload path, and a reload re-buffers —
    // a stated consequence the founder accepted on 2026-08-28, not a fault. The set went
    // `playing` 62 ms after the LOAD, dipped into that normal buffer, and this assertion
    // sampled the dip: the run then stopped the cast 1.32 s later, while the same
    // television had taken 2.05 s to clear an identical buffer earlier in the same run.
    // So sleep to let the dip *start*, then wait for it to clear rather than guessing how
    // long it takes. It can still fail — a film that stopped, or one still buffering when
    // the wait runs out, is graded exactly as it was before.
    await context.sleep(3_000);
    await context
      .waitFor(
        'the film to settle back into playing after the retry’s reload',
        SELFTEST.stateWaitMs,
        (snapshot) => snapshot.session.state === 'playing' && !snapshot.subtitles.reloading,
      )
      .catch(() => undefined);

    const retried = trackTokens(context).at(-1);
    assertions.push(
      assertion(
        'trackFetchedAfterTryAgain',
        'eq',
        'fetched',
        retried === undefined
          ? 'no track was declared at all'
          : wasFetched(context, retried)
            ? 'fetched'
            : 'never fetched',
        'fetch',
        'PRD 18l: one press of Try again puts the words back — the only way a television takes a text track is a LOAD, so this is one stated reload at the founder’s place',
      ),
      assertion(
        'filmStillPlayingAfterTryAgain',
        'eq',
        'playing',
        context.snapshot().session.state,
        'state',
        'PRD 18l: the way out of a failed subtitle is never a film that stopped. Try again costs **one reload**, so the picture re-buffers briefly on the way — accepted by the founder on 2026-08-28 — and this grades where the film *ends up*, not the dip in the middle of it',
      ),
      observation(
        'positionKeptAcrossTryAgainS',
        Math.round((context.snapshot().session.positionSec - positionAtFailure) * 10) / 10,
        's',
        'how far the film moved across the retry — a reload at the remembered position, not a jump back to the opening titles',
      ),
      observation(
        'tryAgainMs',
        Math.round(context.mono() - beforeRetry),
        'ms',
        'how long the founder waits between pressing Try again and the film playing again with the words declared',
      ),
    );

    await stopAndSettle(context);
    return assertions;
  } finally {
    // 13e: whatever happened, the fixtures go and the tracks are reachable again.
    context.withholdTracks(false);
    await fsp
      .rm(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
      .catch(() => undefined);
  }
}

/** How long to give one track switch before calling it missed. 20b promises 2 s. */
const SWAP_BUDGET_MS = 2_000;

/**
 * **18i — the line keeps up with a jump**, in both directions and at long range.
 *
 * Runs against a film that is already playing with a track declared. The comparison is
 * between the line that belongs at the position the founder *asked for* and the line that
 * belongs at the position the **television reports having reached** — read off the cues the
 * set is actually holding, fetched back from the URL it was handed.
 *
 * **What it does not claim** is that a person saw the right words. Only a person can read a
 * television (18g), and 18i's own hardware half rides on checklist item 1. What is measured
 * here is that the words and the picture agree about where the film is — the failure this
 * criterion is really about, which is a track that plays on from where it was.
 */
async function seekingAssertions(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const offsetMs = context.snapshot().subtitles.offsetMs;
  const cues = await servedCues(context, offsetMs);
  if (cues === null || cues.length === 0) {
    // The track this run chose cannot answer the question the block exists to ask.
    throw new SelftestAbort(
      'the declared subtitle track could not be read back from the media server, so nothing here ' +
        'would be a fact about which line belongs where',
    );
  }

  const durationSec = context.snapshot().session.durationSec;
  const fromSec = deviceSecAfter(context, 0) ?? context.snapshot().session.positionSec;
  const target = jumpTargetFor(cues, fromSec, durationSec);
  if (target === null) {
    throw new SelftestAbort(
      `“${path.basename(context.filePath)}” has no subtitle cue at least a minute away from where the film is ` +
        `and at least 1.5 s long, so a jump has nothing to land on: 18i could not be produced on this pairing. ` +
        `The track held ${String(cues.length)} cue(s).`,
    );
  }

  // --- The long jump ---------------------------------------------------------
  context.engine.dispatch({ type: 'playback.seek', positionSec: target.atSec });
  const landedSec = await waitForDeviceNear(
    context,
    target.atSec,
    TIMING.seekToleranceSec,
    SELFTEST.stateWaitMs,
  );

  assertions.push(
    assertion(
      'seekWithATrackPositionErrorS',
      'lte',
      1,
      landedSec === null ? null : Math.round(Math.abs(landedSec - target.atSec) * 1_000) / 1_000,
      's',
      'PRD 18i, which reuses 5a’s accuracy rule: the television lands within 1 s of where the founder asked for. The line assertion below is only meaningful inside this bound',
    ),
    assertion(
      'lineAfterALongSeek',
      'eq',
      target.text,
      landedSec === null ? null : lineAt(cues, Math.round(landedSec * 1_000)),
      'line',
      'PRD 18i: the line belonging at the position the device reached is the line belonging at the position the founder aimed at — measured on the cues the set is holding, fetched back from the URL it was handed. Whether a person read them is checklist item 1',
    ),
    assertion(
      'reloadsForASeekWithSubtitlesOn',
      'eq',
      0,
      context.samples('subtitle.reloading', context.mono() - 30_000).length,
      'reloads',
      'PRD 18i: seeking is the film’s business and the words ride along — a jump never re-declares, re-fetches or reloads the track',
    ),
    observation(
      'trackCuesServed',
      cues.length,
      'cues',
      'how many lines the television is holding for the rung it is showing — the whole file, shifted, from one derived URL (20g)',
    ),
  );

  // --- And back, by a skip rather than a drag (6f) ----------------------------
  const beforeSkip = deviceSecAfter(context, 0) ?? target.atSec;
  context.engine.dispatch({ type: 'playback.skip', deltaSec: -SKIP.stepSeconds });
  const skipTargetSec = Math.max(0, beforeSkip - SKIP.stepSeconds);
  const afterSkipSec = await waitForDeviceNear(
    context,
    skipTargetSec,
    TIMING.seekToleranceSec,
    SELFTEST.stateWaitMs,
  );

  assertions.push(
    assertion(
      'lineAfterASkipBack',
      'eq',
      lineAt(cues, Math.round(skipTargetSec * 1_000)),
      afterSkipSec === null ? null : lineAt(cues, Math.round(afterSkipSec * 1_000)),
      'line',
      'PRD 18i, the other direction: a ±30 s skip lands on the line that belongs there. `(no line)` on both sides is a pass and a real one — a gap between cues is a gap on the television too',
    ),
    observation(
      'skipWithATrackPositionErrorS',
      afterSkipSec === null
        ? null
        : Math.round(Math.abs(afterSkipSec - skipTargetSec) * 1_000) / 1_000,
      's',
      'how far from the skip target the television actually landed — 6f owns this number; it is here to say whether the line comparison above was asked about the right instant',
    ),
  );

  return assertions;
}

/**
 * **18h — the subtitles come back with the film**, through everything M2 can do to it.
 *
 * The gap this closes has been carried since M3b: the film, the position and the device
 * have survived a blip, a reopen and a resume since M2, and the *words* had nothing
 * watching them at all. Every leg below runs **with a track on and an offset set**, because
 * the criterion is explicit that a subtitle that *"comes back 0.6 s out again"* has failed
 * exactly as badly as one that vanishes.
 *
 * The four interruptions the criterion names are 11a, 12a, 14c and 16c. Three of them run
 * here. **14c is the same intent as 16c** — *Take it back* and *Resume from \<position\>*
 * are both `cast.resume` through `startCast` — and producing a real takeover needs the
 * second connection the `takeover` scenario owns, so it is proved headlessly against a real
 * takeover in `test/engine/m3c-step5.test.ts` and named here rather than faked.
 */
async function survivalAssertions(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const label = context.snapshot().subtitles.selectedLabel;

  // A correction to carry through all of it. One press, inside the ladder, so nothing here
  // costs a reload and any reload that does happen is a finding.
  context.engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);
  const offsetMs = context.snapshot().subtitles.offsetMs;
  if (offsetMs === 0 || label === null) {
    throw new SelftestAbort(
      'this run could not get a subtitle on with a correction applied, so nothing below would be ' +
        'about surviving an interruption',
    );
  }

  // --- 11a: the wifi blips ---------------------------------------------------
  const beforeBlip = context.mono();
  context.sever();
  const rejoined = await context
    .waitFor(
      'the session to come back after the outage',
      TIMING.reconnectBudgetMs + SELFTEST.stateWaitMs,
      (snapshot) =>
        !snapshot.session.flags.reconnecting &&
        (snapshot.session.state === 'playing' || snapshot.session.state === 'paused'),
    )
    .then(() => true)
    .catch(() => false);
  await context.sleep(1_000);

  const afterBlip = context.snapshot().subtitles;
  assertions.push(
    assertion(
      'subtitleSourceAfterAnOutage',
      'eq',
      label,
      rejoined ? (afterBlip.selectedLabel ?? 'none') : 'the session never came back',
      'source',
      'PRD 18h: after a wifi blip the subtitles come back with the film, **from the same source**',
    ),
    assertion(
      'subtitleOffsetAfterAnOutage',
      'eq',
      offsetMs,
      afterBlip.offsetMs,
      'ms',
      'PRD 18h: …and with any timing correction still applied. A subtitle that comes back 0.6 s out again is the same failure as one that vanishes',
    ),
    assertion(
      'deactivationsDuringAnOutage',
      'eq',
      0,
      context.samples('subtitle.deactivated', beforeBlip).length,
      'messages',
      'PRD 18h: nothing turned the words off on the way through — recovery rejoins the session the television is already running',
    ),
  );

  // The ladder has to still be *ours*: one more press must be a switch, not a reload.
  const beforePress = context.mono();
  context.engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);
  assertions.push(
    assertion(
      'nudgeAfterAnOutageIsStillASwitch',
      'eq',
      1,
      context.samples('subtitle.switched', beforePress).length,
      'messages',
      'PRD 18h with 20b: the recovered session still knows what the television is holding, so a press costs one track switch rather than one reload of the film',
    ),
    assertion(
      'reloadsAfterAnOutage',
      'eq',
      0,
      context.samples('subtitle.reloading', beforePress).length,
      'reloads',
      'the other half of the same measurement, said as a number the founder would feel: no reload, no re-buffer',
    ),
  );

  // --- 12a: the window is closed and reopened --------------------------------
  const carriedOffsetMs = context.snapshot().subtitles.offsetMs;
  const closedAt = context.mono();
  await context.restart();
  const cameBack = await context
    .waitFor(
      'the reopened app to have the words back',
      TIMING.reattachBudgetMs + SUBTITLES.prepareBudgetMs + SELFTEST.stateWaitMs,
      (snapshot) =>
        snapshot.session.state === 'playing' &&
        snapshot.subtitles.selectedLabel !== null &&
        !snapshot.subtitles.preparing,
    )
    .then(() => true)
    .catch(() => false);
  await context.sleep(500);

  const afterReattach = context.snapshot().subtitles;
  assertions.push(
    assertion(
      'subtitleSourceAfterAReattach',
      'eq',
      label,
      cameBack ? (afterReattach.selectedLabel ?? 'none') : 'the words never came back',
      'source',
      'PRD 18h: reopening the app brings the subtitles back with the film — this is the gap that has been open since M3b',
    ),
    assertion(
      'subtitleOffsetAfterAReattach',
      'eq',
      carriedOffsetMs,
      afterReattach.offsetMs,
      'ms',
      'PRD 18h: at the same rung the television is already showing, taken back rather than re-decided',
    ),
    assertion(
      'loadsDuringAReattachWithSubtitles',
      'eq',
      0,
      context.samples('session.loading', closedAt).length,
      'loads',
      'PRD 12a is not weakened to get there: a reattach still issues no LOAD at all, so the film is never restarted to get its words back',
    ),
  );

  // The one a kinder harness would miss: the thirteen URLs the set is holding name a mount
  // that died with the old process, so a press now has to find a media server answering on
  // the republished token.
  const beforeAdoptedPress = context.mono();
  context.engine.dispatch({ type: 'subtitles.nudge', steps: -1 });
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);
  assertions.push(
    assertion(
      'nudgeAfterAReattachIsStillASwitch',
      'eq',
      1,
      context.samples('subtitle.switched', beforeAdoptedPress).length,
      'messages',
      'PRD 18h: the reopened app took the ladder back — including republishing the track’s own URL under the same token, which is the argument SPIKE-2 made about the film’s URL applied to the words',
    ),
    assertion(
      'reloadsAfterAReattach',
      'eq',
      0,
      context.samples('subtitle.reloading', beforeAdoptedPress).length,
      'reloads',
      'a reopened app that had forgotten the ladder would answer this press by reloading the film — the failure this assertion exists to catch',
    ),
  );

  // --- 16c: Stop, then Resume from <position> --------------------------------
  const resumeOffsetMs = context.snapshot().subtitles.offsetMs;
  await stopAndSettle(context);
  const beforeResume = context.mono();
  context.engine.dispatch({ type: 'cast.resume' });
  const resumed = await context
    .waitForState('playing', PREPARATION.checkBudgetMs + REACH_PICTURE_MS)
    .then(() => true)
    .catch(() => false);
  await context.sleep(1_000);

  const serving = context.samples('cast.serving', beforeResume).at(-1);
  assertions.push(
    assertion(
      'subtitleSourceAfterAResume',
      'eq',
      label,
      resumed ? (context.snapshot().subtitles.selectedLabel ?? 'none') : 'the film never resumed',
      'source',
      'PRD 18h with 16c: *Resume from <position>* brings the words back with the film. **14c, *Take it back*, is the same intent and the same path** — a real takeover needs the second connection the `takeover` scenario owns, and it is proved headlessly in `test/engine/m3c-step5.test.ts`',
    ),
    assertion(
      'subtitleOffsetOnTheResumedLoad',
      'eq',
      resumeOffsetMs,
      serving === undefined ? null : Number(serving['subtitleOffsetMs'] ?? 0),
      'ms',
      'PRD 18h: the resumed LOAD declares the ladder around the correction the founder had set, so the words come back in time rather than back at zero',
    ),
  );

  // **Put the control back to *in sync* before anything else is measured.** Story 20's
  // block below starts from the founder's own zero and reads the displayed number after
  // one press; leaving this block's correction behind would have it grade `+1.0 s` against
  // a promise about `+0.5 s` and report a defect that was the harness's.
  context.engine.dispatch({ type: 'subtitles.resetTiming' });
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);
  assertions.push(
    observation(
      'timingAfterTheSurvivalBlock',
      context.snapshot().subtitles.timing,
      'label',
      'the control is returned to in sync before story 20 is measured, so every number below is one this run produced',
    ),
  );

  return assertions;
}

/**
 * **20f — the correction is still there next week**, measured across two engine runs.
 *
 * *"A subtitle source corrected by +0.6 s, chosen again — next week, after reopening the
 * app, after restarting the PC — gets its correction applied and stated."* One process
 * cannot answer that: it could "remember" by never having forgotten. So this nudges, tears
 * the engine down, builds another against the same settings file, and chooses the same
 * source again.
 *
 * **19a is asserted on the way past, and it is the assertion that matters most here.** The
 * reopened app must show the film at **Off** before anything is chosen. A remembered
 * correction that could put words on a television would break the ruling the whole milestone
 * rests on, and this is where that would show up.
 */
async function rememberedOffsetAssertions(
  context: Context,
  chosen: { readonly id: string; readonly label: string },
): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const label = chosen.label;

  // **The television has been let go by now, and that is the point.** Everything below is
  // about a founder sitting in front of the app with nothing playing: choosing a source,
  // nudging it, closing the app, and choosing it again. No device is needed for any of it,
  // and `castsWhileRememberingTheOffset` asserts that none was reached.
  if (context.snapshot().subtitles.selectedId !== chosen.id) {
    context.engine.dispatch({ type: 'subtitles.select', sourceId: chosen.id });
    const chose = await context
      .waitFor(
        'the subtitle to be chosen again',
        SUBTITLES.prepareBudgetMs + 60_000,
        (snapshot) => !snapshot.subtitles.preparing && snapshot.subtitles.selectedId === chosen.id,
      )
      .then(() => true)
      .catch(() => false);
    if (!chose) {
      throw new SelftestAbort(
        `“${label}” could not be chosen again, so 20f had nothing to correct and nothing to remember`,
      );
    }
  }

  // Two presses, so the number is unmistakable in the verdict and cannot be confused with
  // a single default step that happened to be lying around.
  context.engine.dispatch({ type: 'subtitles.nudge', steps: 2 });
  await context.sleep(TIMING.seekSettleMs + 200);
  const setOffsetMs = context.snapshot().subtitles.offsetMs;
  const setReading = context.snapshot().subtitles.timing;
  if (setOffsetMs === 0) {
    throw new SelftestAbort('the offset would not move, so 20f had no correction to remember');
  }

  // **The second engine run.** Honestly: a second engine *instance* in this process, not a
  // second OS process — the same statement the `reattach` scenario makes about itself. What
  // it genuinely exercises is the part that matters: the settings file is written, closed,
  // and read again by an engine that has never seen this evening.
  await context.restart();
  await chooseAndCheck(context, context.filePath);
  const reopened = context.snapshot().subtitles;

  assertions.push(
    assertion(
      'reopenedFilmIsStillOff',
      'eq',
      'off',
      reopened.selectedId === null ? 'off' : `selected: ${reopened.selectedId}`,
      'state',
      'PRD 19a, with a remembered correction sitting in the store: the control still reads Off on every film, every time. A memory that could turn subtitles on would break the ruling the whole milestone rests on',
    ),
    assertion(
      'reopenedFilmSaysNothingAboutTiming',
      'eq',
      'nothing stated',
      reopened.timingRemembered ? 'stated a remembered correction' : 'nothing stated',
      'state',
      'PRD 20f fires **downstream of a deliberate choice**: before the founder chooses that source again there is nothing to state',
    ),
  );

  const offered = reopened.options.find((option) => option.label === label);
  if (offered === undefined) {
    throw new SelftestAbort(
      `“${label}” was not offered again after the app reopened, so 20f could not be asked: the ` +
        `condition this block exists to test did not exist`,
    );
  }

  context.engine.dispatch({ type: 'subtitles.select', sourceId: offered.id });
  const ready = await context
    .waitFor(
      'the same subtitle to be chosen again',
      SUBTITLES.prepareBudgetMs + 60_000,
      (snapshot) => !snapshot.subtitles.preparing && snapshot.subtitles.selectedId !== null,
    )
    .then(() => true)
    .catch(() => false);
  const after = context.snapshot().subtitles;

  assertions.push(
    assertion(
      'rememberedOffsetAcrossTwoEngineRuns',
      'eq',
      setOffsetMs,
      ready ? after.offsetMs : null,
      'ms',
      'PRD 20f: the correction set in the previous engine run is applied when the founder chooses that same source again. Two runs, because a single-process assertion proves nothing about surviving a restart',
    ),
    assertion(
      'rememberedOffsetIsStated',
      'eq',
      'stated',
      after.timingRemembered ? 'stated' : 'applied silently',
      'state',
      'PRD 20f: applied **and stated** — the screen reads "Timing: +0.6 s, as you set it last time", with Reset beside it. An offset is real data rather than a cache, which is why it is never applied silently',
    ),
    assertion(
      'rememberedOffsetReading',
      'eq',
      setReading,
      after.timing,
      'label',
      'PRD 20a: and it reads back as the same signed number the founder left it at',
    ),
    assertion(
      'castsWhileRememberingTheOffset',
      'eq',
      0,
      context.samples('session.loading', context.mono() - 10_000).length,
      'loads',
      'nothing was cast to get here: choosing a source and reading a remembered correction reaches no television at all',
    ),
  );

  // Leave the house as it was found: Reset forgets, which is the founder saying "these
  // words are in time" and is the only thing that clears the memory (13e's spirit, applied
  // to the one thing in this milestone that outlives the run).
  context.engine.dispatch({ type: 'subtitles.resetTiming' });
  await context.sleep(TIMING.seekSettleMs + 200);
  assertions.push(
    observation(
      'offsetLeftBehindByThisRun',
      context.snapshot().subtitles.timing,
      'label',
      'PRD 13e, applied to the one thing here that outlives the run: the correction this scenario set is reset before it ends, so a graded run leaves nothing on the founder’s PC that a later one would inherit',
    ),
  );

  return assertions;
}

/**
 * **Story 20 on a real television** — 19b, 20b, 20c, 20e.
 *
 * Runs against a film that is already playing with a track declared, and measures the four
 * things only a device can answer. **What it never claims is 20b's own half**: *"only a
 * person can see a word land on a face"* is checklist item 6, and nothing here stands in for
 * it. What this grades is everything up to the screen — the right message, once, naming the
 * right track, with the film still playing afterwards.
 *
 * `subtitle.switched` is the instrument, and it is `info` on purpose: `media.request` is
 * `debug` and counting it once measured the logger's own threshold rather than a television
 * (2026-08-27). A swap that never happened leaves no record here, which reads as a miss —
 * the right way round for a harness that has been lied to by its own instruments three times.
 */
async function timingAssertions(context: Context): Promise<Assertion[]> {
  const assertions: Assertion[] = [];
  const rungs = buildLadder().length;
  const stateBefore = context.snapshot().session.state;

  assertions.push(
    observation(
      'declaredRungs',
      rungs,
      'tracks',
      'how many shifted variants of the one chosen track went out on the LOAD — every offset a press can reach, because a television takes text tracks only there (SPIKE-3)',
    ),
  );

  // --- 20b: one press, one swap, and the film never stops ---------------------
  const beforeOnePress = context.mono();
  context.engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
  const shownAfterPress = context.snapshot().subtitles.timing;
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);

  const swaps = context.samples('subtitle.switched', beforeOnePress);
  const firstSwap = swaps[0];
  const swapMs = firstSwap === undefined ? null : Number(firstSwap['elapsedMs']);

  assertions.push(
    assertion(
      'displayedOffsetMovedOnPress',
      'eq',
      `+${(LADDER_STEP_MS / 1_000).toFixed(1)} s`,
      shownAfterPress,
      'label',
      'PRD 20c: the number on the screen moves on the press, before anything reaches the wire',
    ),
    assertion(
      'trackSwapsSentForOnePress',
      'eq',
      1,
      swaps.length,
      'messages',
      'PRD 20b: one press produces exactly one track switch on the wire',
    ),
    assertion(
      'trackSwapMs',
      'lte',
      SWAP_BUDGET_MS,
      swapMs === null ? null : Math.round(swapMs),
      'ms',
      'PRD 20b: the television has the new track within 2 s of the settled press. SPIKE-3 measured 11–36 ms on all three sets; anything near the bound is worth reading twice',
    ),
    assertion(
      'filmStillPlayingAfterSwap',
      'eq',
      'playing',
      context.snapshot().session.state,
      'state',
      'PRD 20b: the film keeps playing — no re-buffer, no black frame, no lost position. Whether a word landed on a face is checklist item 6',
    ),
    assertion(
      'reloadsForAnInLadderNudge',
      'eq',
      0,
      context.samples('subtitle.reloading', beforeOnePress).length,
      'reloads',
      'PRD 20b: a nudge inside ±3 s is a track switch and nothing else — the whole reason the ladder is declared up front',
    ),
  );

  // --- 20c: four presses inside the settle window are one message -------------
  const beforeBurst = context.mono();
  for (let press = 0; press < 4; press += 1) {
    context.engine.dispatch({ type: 'subtitles.nudge', steps: 1 });
    await context.sleep(40);
  }
  const shownAfterBurst = context.snapshot().subtitles.timing;
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);

  assertions.push(
    assertion(
      'trackSwapsSentForFourPresses',
      'eq',
      1,
      context.samples('subtitle.switched', beforeBurst).length,
      'messages',
      'PRD 20c: four presses inside 400 ms produce exactly one swap, for the summed offset — the same SETTLE window and the same rule the ±30 s skips use',
    ),
    observation(
      'displayedOffsetAfterBurst',
      String(shownAfterBurst),
      'label',
      'what the founder is reading after five presses in total — the displayed number moves on every one of them',
    ),
  );

  // --- 20e: Reset, in one press and one swap ----------------------------------
  const beforeReset = context.mono();
  context.engine.dispatch({ type: 'subtitles.resetTiming' });
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);

  assertions.push(
    assertion(
      'resetSwaps',
      'eq',
      1,
      context.samples('subtitle.switched', beforeReset).length,
      'messages',
      'PRD 20e: Reset returns to in sync in one press and one swap — a founder who has nudged themselves into a mess is always one press from where they started',
    ),
    assertion(
      'resetReadsInSync',
      'eq',
      'in sync',
      context.snapshot().subtitles.timing,
      'label',
      'PRD 20a: at zero it reads in sync, never +0.0 s',
    ),
  );

  // --- 19b: off mid-film, and the film does not flinch ------------------------
  const beforeOff = context.mono();
  context.engine.dispatch({ type: 'subtitles.clear' });
  await context.sleep(TIMING.seekSettleMs + SWAP_BUDGET_MS);

  assertions.push(
    assertion(
      'loadsWhileTurningSubtitlesOff',
      'eq',
      0,
      context.samples('session.loading', beforeOff).length,
      'loads',
      'PRD 19b: turning subtitles off never reloads the film — the promise the criterion keeps exactly as written, because turning a declared track off is the one thing a television accepts',
    ),
    assertion(
      'filmStillPlayingAfterOff',
      'eq',
      'playing',
      context.snapshot().session.state,
      'state',
      'PRD 19b: the words stop and the picture does not — no reload, no re-buffer, no lost position',
    ),
    assertion(
      'sessionNeverLeftPlaying',
      'eq',
      'playing',
      stateBefore,
      'state',
      'the precondition every assertion above rests on: this whole block ran against a film that was already playing',
    ),
    observation(
      'deactivations',
      context.samples('subtitle.deactivated', beforeOff).length,
      'messages',
      'how many times the track was turned off on the wire — one press, one message',
    ),
  );

  return assertions;
}
