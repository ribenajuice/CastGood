#!/usr/bin/env node
// SPIKE-5 — THROWAWAY. Is NVENC's picture as good as libx264's, at the same file size?
//
// Delete this with scripts/spike-encode.mjs once the encoder question is settled.
//
// WHY IT EXISTS
// -------------
// SPIKE-4 measured `h264_nvenc` at roughly twice `libx264 -preset veryfast`, which would
// take a two-hour 1080p film from ~20 minutes to ~10. The obvious move is to adopt it, and
// the reason we have not is that **the speed number alone cannot decide it**: prepared files
// live beside the founder's source for years with no cleanup policy, so a permanently
// larger or softer picture is a cost paid every time the film is watched, against ten
// minutes saved once.
//
// SPIKE-4 reported nvenc's output as 1.68x larger at 1080p, and that comparison is
// **meaningless as it stands** — `-crf 20` and `-cq 23` are different scales, so the bigger
// file might be better, worse or identical. Comparing an encoder honestly means holding one
// axis still. This holds **size** still and measures the picture.
//
// HOW
// ---
// 1. Encode the reference clip with libx264 at the shipping settings. That is the baseline,
//    and its file size is the budget.
// 2. Encode with nvenc at several quality levels, and keep the one whose size lands closest
//    to that budget — same bytes on the founder's disk, so the only question left is which
//    picture those bytes buy.
// 3. Score both against the **original source** with VMAF, which is built to predict what a
//    person sitting in front of a television would say. Netflix's rule of thumb: a
//    difference under ~1 VMAF point is invisible, ~6 points is where people start noticing.
// 4. Keep both files so the founder can look at them, because a metric is evidence and not
//    a verdict.
//
// USAGE
//   node scripts/spike-quality.mjs --file "C:\\...\\film.mkv" [--seconds 60] [--keep DIR]

import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const FFMPEG = path.join(process.cwd(), 'resources', 'bin', 'ffmpeg.exe');

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

/** The quality knob is `-cq`; lower is better and bigger. A spread wide enough to bracket. */
const NVENC_CQ = [19, 21, 23, 25, 27];

function run(args) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (c) => {
      // **Keep the tail, not the head.** ffmpeg's interesting lines — a codec's refusal, and
      // libvmaf's score — come at the *end*, after however many hundred progress lines it
      // felt like printing. Capping from the front truncated the VMAF score away and made
      // every comparison read "no score on stderr", which is how a working measurement
      // looked broken for two runs.
      err = (err + c).slice(-20000);
    });
    child.on('error', (e) => resolve({ code: -1, err: String(e), ms: Date.now() - started }));
    child.on('close', (code) => resolve({ code, err, ms: Date.now() - started }));
  });
}

/**
 * VMAF of `encoded` against `reference`.
 *
 * Both are decoded and compared frame by frame, so the reference must be the **source**
 * rather than another encode — scoring one encoder against the other would measure how
 * alike they are, not how good either is.
 */
async function vmaf(reference, encoded, seconds) {
  // **No `log_path`.** It takes a filter-graph argument, so a Windows path — with a colon
  // after the drive letter and spaces in a film's name — has to survive two levels of
  // escaping, and it did not: every score came back as a parse error. libvmaf prints the
  // pooled score on stderr anyway, which needs no quoting at all.
  const r = await run([
    '-hide_banner',
    '-nostdin',
    '-i',
    encoded,
    '-i',
    reference,
    '-t',
    String(seconds),
    // `-nostats` silences the per-frame progress; the score is logged at info level, so
    // `-loglevel error` would silence that too and is the wrong tool here.
    '-nostats',
    '-lavfi',
    '[0:v]setpts=PTS-STARTPTS[d];[1:v]setpts=PTS-STARTPTS[r];[d][r]libvmaf',
    '-f',
    'null',
    '-',
  ]);
  const found = /VMAF score:\s*([0-9.]+)/.exec(r.err);
  if (found === null) {
    return {
      error: (
        r.err.split('\n').filter((l) => /error|Error|Invalid|No option/.test(l))[0] ??
        'no VMAF score on stderr'
      ).slice(0, 200),
    };
  }
  return { mean: Math.round(Number(found[1]) * 100) / 100 };
}

const args = process.argv.slice(2);
let file = null,
  seconds = 60,
  keep = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--file') file = args[++i];
  else if (args[i] === '--seconds') seconds = Number(args[++i]);
  else if (args[i] === '--keep') keep = args[++i];
}
if (file === null) {
  process.stderr.write('spike-quality: need --file "C:\\path\\to\\film"\n');
  process.exit(2);
}

const dir = keep ?? (await mkdtemp(path.join(tmpdir(), 'castgood-quality-')));
if (keep) await mkdir(keep, { recursive: true });
const clip = (name) => path.join(dir, `${path.parse(file).name}.${name}.mp4`);

const common = [
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
];

const report = { file: path.basename(file), seconds, baseline: null, nvenc: [], chosen: null };

// --- 1. The baseline, and the size budget it sets.
const baseFile = clip('libx264-crf20');
const base = await run([...common, ...X264, '-movflags', '+faststart', '-f', 'mp4', baseFile]);
if (base.code !== 0) {
  process.stderr.write(`libx264 failed: ${base.err.slice(0, 400)}\n`);
  process.exit(2);
}
const baseBytes = (await stat(baseFile)).size;
report.baseline = {
  encoder: 'libx264 veryfast crf20',
  bytes: baseBytes,
  wallMs: base.ms,
  vmaf: await vmaf(file, baseFile, seconds),
};

// --- 2. nvenc across the quality range.
for (const cq of NVENC_CQ) {
  const f = clip(`nvenc-cq${cq}`);
  const r = await run([
    ...common,
    '-c:v',
    'h264_nvenc',
    '-preset',
    'p4',
    '-cq',
    String(cq),
    '-profile:v',
    'high',
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-f',
    'mp4',
    f,
  ]);
  if (r.code !== 0) {
    report.nvenc.push({
      cq,
      ran: false,
      reason: (r.err.split('\n').find((l) => l.trim()) ?? '').slice(0, 200),
    });
    continue;
  }
  const bytes = (await stat(f)).size;
  report.nvenc.push({
    cq,
    ran: true,
    bytes,
    wallMs: r.ms,
    sizeVsBaseline: Math.round((bytes / baseBytes) * 100) / 100,
    vmaf: await vmaf(file, f, seconds),
    path: f,
  });
}

// --- 3. The fair comparison: the nvenc setting closest to the baseline's size.
const ran = report.nvenc.filter((n) => n.ran);
if (ran.length > 0) {
  const closest = ran.reduce((a, b) =>
    Math.abs(b.bytes - baseBytes) < Math.abs(a.bytes - baseBytes) ? b : a,
  );
  // **A missing score is not a score of zero.** The first run of this spike had every VMAF
  // call fail on a filter-path escape, defaulted both sides to 0, subtracted them, and
  // reported "indistinguishable (<1 VMAF point)" — a verdict of *no difference* produced by
  // measuring nothing at all. That is the exact shape of vacuous pass this project keeps
  // being caught by, so the reading refuses to speak unless both scores are real.
  const mine = closest.vmaf?.mean;
  const theirs = report.baseline.vmaf?.mean;
  const measured = typeof mine === 'number' && typeof theirs === 'number';
  const dv = measured ? mine - theirs : null;
  report.chosen = {
    cq: closest.cq,
    sizeVsBaseline: closest.sizeVsBaseline,
    vmafDelta: dv === null ? null : Math.round(dv * 100) / 100,
    // Netflix's own guidance on the scale, stated so the number is not read as a percentage.
    reading:
      dv === null
        ? 'NOT MEASURED — VMAF did not produce a score for both files, so nothing here is a quality comparison'
        : Math.abs(dv) < 1
          ? 'indistinguishable (<1 VMAF point)'
          : Math.abs(dv) < 6
            ? `${dv > 0 ? 'nvenc better' : 'nvenc worse'}, but below the ~6 points where people begin to notice`
            : `${dv > 0 ? 'nvenc clearly better' : 'nvenc clearly worse'} — over the ~6 point noticing threshold`,
    speedup: Math.round((report.baseline.wallMs / closest.wallMs) * 100) / 100,
  };
}

if (!keep) await rm(dir, { recursive: true, force: true }).catch(() => {});
else report.keptIn = dir;
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
