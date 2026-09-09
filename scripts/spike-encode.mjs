#!/usr/bin/env node
// SPIKE-4 — THROWAWAY. How fast does *this* PC convert a film, really?
//
// Delete this and scripts/spike-encode.sh once the answer is in config.ts and an ADR.
// Not an npm script and not in CI, on purpose: it is a measurement of one machine.
//
// WHY IT EXISTS
// -------------
// `PREPARATION.throughput.videoConvertSpeed` is **1.5× real time**, and it is a seed — a
// number written down before anything had been measured. M3a's first hardware runs put a
// 20-second clip through a real conversion at **17.5×**, which would make the app announce
// 78 minutes for a job of about 7. That is wrong in the safe direction and wrong enough to
// change what the founder decides to do with their evening.
//
// But a 20-second clip is not evidence about a two-hour film, and — more importantly — the
// current model is `durationSec / speed`, which is **blind to resolution**. A 4K film and a
// 480p film get the same estimate, and x264 does not work that way at all: encode time
// tracks *pixels*, so a 1080p film is roughly three times the work of the founder's
// 1280×528 `Cars.mp4` per second of video. One number cannot be right for both.
//
// So this measures **pixels per second**, on real films, at the exact settings the product
// uses, with every encoder this machine can actually run.
//
// **A CLIP IS NOT A FILM — READ THIS BEFORE TRUSTING ANY NUMBER BELOW**
// ---------------------------------------------------------------------
// The first run of this spike used 60-second clips, measured 393-413 Mpx/s, and the seed
// was set to 350 as a "cautious" 15% below it. The founder then converted a real
// 113-minute film and it managed **258.8 and 298.8 Mpx/s** — so the app announced fifteen
// minutes for a job that took twenty-one, which is the one direction criterion 8b forbids.
//
// A 60-second clip of that *same* film measured 362 Mpx/s, so the source codec was not the
// cause. **Length was.** A short clip enjoys burst clocks, an idle machine and warm caches;
// a twenty-minute encode has none of them, and the gap is about a third.
//
// So: `--seconds 60` is for *comparing encoders to each other*, which it does well and
// cheaply. It must never be used to set a seed. For that, run `--seconds` at the full
// length of a real film and accept that it takes as long as the conversion takes, because
// that is the number the founder actually lives with.
//
// WHAT IT REFUSES TO DO
// ---------------------
// **No synthetic input.** An early version of this measurement used ffmpeg's `testsrc`
// pattern and reported 4.8× for libx264 at 1080p. `testsrc` is flat colour and simple
// motion; a real film is neither, and the number was meaningless. Every measurement here
// decodes the founder's own video, which also charges the decode cost the product really
// pays.
//
// **No claim about quality.** Speed is measurable here; whether `h264_mf` looks as good as
// x264 at the same settings is a thing for eyes on a television. The output files are kept
// so they can be watched.
//
// USAGE
//   node scripts/spike-encode.mjs --file "C:\...\Cars.mp4" --file "C:\...\Bluey.mkv"
//     --seconds N     how much of each film to convert (default 60)
//     --keep DIR      where to leave the outputs (default: a temp dir, removed)

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FFMPEG = path.join(process.cwd(), 'resources', 'bin', 'ffmpeg.exe');
const FFPROBE = path.join(process.cwd(), 'resources', 'bin', 'ffprobe.exe');

/**
 * The output settings the product actually uses, from `src/engine/prepare/output-profiles.ts`.
 *
 * Copied rather than imported: this script runs from plain Node against the built tree, and
 * a spike that measured *different* settings from the ones we ship would answer a question
 * nobody asked. If `BASELINE_OUTPUT` changes, this has to change with it — which is one more
 * reason this file is throwaway.
 */
const X264 = [
  '-c:v',
  'libx264',
  '-preset',
  'veryfast',
  '-crf',
  '20',
  '-profile:v',
  'high',
  '-level',
  '4.1',
  '-pix_fmt',
  'yuv420p',
  '-g',
  '96',
];

/**
 * The candidates, in the order the 2026-08-19 encoder ADR names them.
 *
 * Each carries what it needs to produce the *same shape* of output as the software path —
 * H.264 High, 8-bit 4:2:0 — because an encoder that is fast and produces something a
 * television refuses has measured nothing.
 */
const ENCODERS = [
  { id: 'libx264-veryfast', args: X264, note: 'what CastGood ships today' },
  {
    id: 'h264_nvenc',
    args: [
      '-c:v',
      'h264_nvenc',
      '-preset',
      'p4',
      '-cq',
      '23',
      '-profile:v',
      'high',
      '-pix_fmt',
      'yuv420p',
    ],
    note: 'NVIDIA',
  },
  {
    id: 'h264_qsv',
    args: ['-c:v', 'h264_qsv', '-global_quality', '23', '-profile:v', 'high', '-pix_fmt', 'nv12'],
    note: 'Intel Quick Sync',
  },
  {
    id: 'h264_amf',
    args: ['-c:v', 'h264_amf', '-quality', 'balanced', '-profile:v', 'high', '-pix_fmt', 'yuv420p'],
    note: 'AMD',
  },
  {
    id: 'h264_mf',
    // **No `-profile:v`.** Media Foundation rejects the option outright ("Error setting
    // option profile to value high") and picks its own — which turns out to be Constrained
    // Baseline, so the profile it produces is recorded below rather than assumed.
    args: ['-c:v', 'h264_mf'],
    note: 'Windows Media Foundation — whatever the OS routes it to',
  },
];

function run(exe, args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(exe, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let out = '',
      err = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (c) => {
      out += c;
    });
    child.stderr.on('data', (c) => {
      if (err.length < 8000) err += c;
    });
    child.on('error', (e) => resolve({ code: -1, out, err: String(e), ms: Date.now() - started }));
    child.on('close', (code) => resolve({ code, out, err, ms: Date.now() - started }));
  });
}

async function probe(file) {
  const r = await run(FFPROBE, [
    '-v',
    'error',
    '-print_format',
    'json',
    '-show_format',
    '-show_streams',
    '-select_streams',
    'v:0',
    file,
  ]);
  if (r.code !== 0) return null;
  const j = JSON.parse(r.out);
  const s = j.streams?.[0];
  if (!s) return null;
  const [n, d] = String(s.avg_frame_rate ?? s.r_frame_rate ?? '0/1')
    .split('/')
    .map(Number);
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    fps: d ? n / d : 0,
    codec: s.codec_name,
    profile: s.profile,
    durationSec: Number(j.format?.duration) || 0,
    sizeBytes: Number(j.format?.size) || 0,
  };
}

const args = process.argv.slice(2);
const files = [];
let seconds = 60;
let keep = null;
/** Narrow the run to named encoders — a full-length measurement of one is the useful shape. */
const only = [];
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--file') files.push(args[++i]);
  else if (args[i] === '--seconds') seconds = Number(args[++i]);
  else if (args[i] === '--keep') keep = args[++i];
  else if (args[i] === '--encoder') only.push(args[++i]);
}
if (files.length === 0) {
  process.stderr.write('spike-encode: need at least one --file "C:\\path\\to\\film"\n');
  process.exit(2);
}

const dir = keep ?? (await mkdtemp(path.join(tmpdir(), 'castgood-encode-')));
if (keep) await mkdir(keep, { recursive: true });

const report = {
  startedAt: new Date().toISOString(),
  seconds,
  // Stamped into the report so a number can never be read later without the caveat that
  // decides whether it is usable. See the header.
  sustained: seconds >= 1800,
  usableForSeeding:
    seconds >= 1800
      ? 'yes — long enough to include throttling'
      : 'NO — a clip overstates sustained throughput by about a third',
  films: [],
};

for (const file of files) {
  const info = await probe(file);
  if (!info) {
    report.films.push({ file, error: 'ffprobe could not read it' });
    continue;
  }
  const pixelsPerSecondOfVideo = info.width * info.height * info.fps;
  const film = {
    file: path.basename(file),
    source: info,
    pixelsPerSecondOfVideo,
    results: [],
  };

  for (const enc of ENCODERS.filter((e) => only.length === 0 || only.includes(e.id))) {
    const out = path.join(dir, `${path.parse(file).name}.${enc.id}.mp4`);
    // `-t` after `-i` so the clip is decoded from the start rather than seeked — a seek
    // would skip the decode cost the product actually pays, and this is a decode+encode
    // measurement, not an encode one.
    const r = await run(FFMPEG, [
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      '-i',
      file,
      '-t',
      String(seconds),
      '-map',
      '0:v:0',
      '-an',
      '-sn',
      ...enc.args,
      '-movflags',
      '+faststart',
      '-f',
      'mp4',
      out,
    ]);

    if (r.code !== 0) {
      // Why it could not run is the useful half. The nvenc driver-version refusal is a
      // whole finding on its own, and a bare "failed" would have hidden it.
      const reason = (
        r.err.split('\n').find((l) => /error|not support|minimum|unknown|Unrecognized/i.test(l)) ??
        r.err.split('\n')[0] ??
        ''
      ).trim();
      film.results.push({
        encoder: enc.id,
        note: enc.note,
        ran: false,
        reason: reason.slice(0, 220),
      });
      continue;
    }
    const size = (await stat(out).catch(() => null))?.size ?? 0;
    // **What did it actually produce?** The comment above says an encoder that is fast and
    // makes something a television refuses has measured nothing — and the first version of
    // this script asserted that and never checked it. `h264_mf` is exactly the case: it
    // ignores `-profile:v` and emits Constrained Baseline, which every Chromecast plays and
    // which is far less efficient than High.
    const produced = await probe(out);
    const realTimeX = seconds / (r.ms / 1000);
    film.results.push({
      encoder: enc.id,
      note: enc.note,
      ran: true,
      wallMs: r.ms,
      realTimeX: Math.round(realTimeX * 100) / 100,
      // The number the estimate should actually be built from: encode throughput is
      // pixel-bound, so this is the figure that transfers between resolutions.
      megapixelsPerSecond:
        Math.round(((pixelsPerSecondOfVideo * seconds) / (r.ms / 1000) / 1e6) * 10) / 10,
      outputBytes: size,
      producedProfile: produced ? `${produced.codec} ${produced.profile}` : 'unreadable',
      outputPath: keep ? out : undefined,
    });
    if (!keep) await rm(out, { force: true }).catch(() => {});
  }
  report.films.push(film);
}

if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
