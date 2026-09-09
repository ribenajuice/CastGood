#!/usr/bin/env node
// Fetch the exact FFmpeg source the bundled binaries were built from, so it can be
// published beside the installer.
//
// WHY THIS EXISTS
// ---------------
// The bundled ffmpeg is GPL-3.0-or-later, and the GPL's whole point is that whoever
// receives the binary can get its source. GPL v3 section 6(d) — the clause that fits
// a download page — asks for the Corresponding Source to be offered "from the same
// place" as the object code, at no further charge.
//
// Pointing at FFmpeg's own repository is what most projects do and it is defensible,
// but it is not what 6(d) says: the source then lives somewhere else, maintained by
// somebody else, and a commit that is reachable today is not a promise about a URL
// nobody here controls. Attaching the tarball to the same GitHub Release as the .exe
// costs one file and removes the argument entirely.
//
// ⚠️ THE COMMIT IS READ, NEVER TYPED. `resources/bin/ffmpeg-build.json` is written by
// fetch-ffmpeg.mjs from the build that was actually downloaded, so the source this
// fetches is the source those binaries came from. A hard-coded commit here would
// silently drift the day ffmpeg is bumped and start shipping the source of a
// different build — which is worse than shipping none, because it looks compliant.
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

const BUILD_JSON = path.join('resources', 'bin', 'ffmpeg-build.json');
const OUT_DIR = path.join('dist', 'installer');

function die(message) {
  console.error(`[ffmpeg-source] ${message}`);
  process.exit(1);
}

const raw = await readFile(BUILD_JSON, 'utf8').catch(() =>
  die(`${BUILD_JSON} is missing — run scripts/fetch-ffmpeg.mjs first, which writes it`),
);

let build;
try {
  build = JSON.parse(raw);
} catch {
  die(`${BUILD_JSON} is not valid JSON`);
}

// The licence recorded beside the binaries decides whether source is owed at all. If a
// future build is LGPL or something else, this should be reconsidered rather than
// silently keep publishing a GPL tarball.
if (typeof build.license !== 'string' || !/GPL/i.test(build.license)) {
  console.log(
    `[ffmpeg-source] recorded licence is "${build.license}" — no GPL source obligation, nothing to do`,
  );
  process.exit(0);
}

const match = /\/commit\/([0-9a-f]{7,40})/i.exec(String(build.upstreamSource ?? ''));
if (match === null) {
  die(
    `could not read an upstream commit out of ${BUILD_JSON} ("${String(build.upstreamSource)}").\n` +
      `    The GPL source cannot be published without knowing which commit the binaries came from,\n` +
      `    and guessing is worse than failing: it would ship the wrong source and look compliant.`,
  );
}

const commit = match[1];
const version = String(build.version ?? 'unknown');
const url = `https://codeload.github.com/FFmpeg/FFmpeg/tar.gz/${commit}`;
const outFile = path.join(OUT_DIR, `ffmpeg-${version}-source-${commit}.tar.gz`);

await mkdir(OUT_DIR, { recursive: true });

console.log(`[ffmpeg-source] licence ${build.license}`);
console.log(`[ffmpeg-source] commit  ${commit} (ffmpeg ${version})`);
console.log(`[ffmpeg-source] fetching ${url}`);

const response = await fetch(url, { redirect: 'follow' });
if (!response.ok || response.body === null) {
  die(`download failed: HTTP ${String(response.status)} from ${url}`);
}
await pipeline(Readable.fromWeb(response.body), createWriteStream(outFile));

const { size } = await stat(outFile);
// A tarball this small is an error page or a truncated stream, not FFmpeg.
if (size < 1_000_000) {
  die(`the downloaded file is only ${String(size)} bytes — that is not the FFmpeg source`);
}
console.log(`[ffmpeg-source] wrote ${outFile} (${(size / 1048576).toFixed(1)} MB)`);
