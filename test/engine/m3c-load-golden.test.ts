import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createEngine, type Engine, type GuardTicker } from '../../src/engine/index.js';
import type { StateSnapshot } from '../../src/engine/protocol/index.js';
import type { Mdns, MdnsHandlers, MdnsService } from '../../src/engine/discovery/index.js';
import { tcpTransportFactory } from '../../src/engine/cast/index.js';
import { createMemorySink, systemClock, type Clock } from '../../src/engine/logging/index.js';
import type { LogRecord } from '../../src/engine/logging/index.js';
import { resolveAppPaths } from '../../src/engine/paths.js';
import type { FfprobeRunner } from '../../src/engine/media/inspection.js';
import { HLS_PUBLISHED_PLAYLIST } from '../../src/engine/media-server/hls.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';
import { audioStream, probeOf, report, videoStream } from './fixtures/ffprobe.js';
import { createFakeSpawn, type FakeChild, type FakeSpawn } from './fixtures/spawn.js';

/**
 * **Criterion 19a, as bytes** — *"the LOAD message is byte-for-byte what it would have been
 * before M3c existed"*.
 *
 * This is the one check in the milestone that can only be made by recording the wire
 * **before** the code changes and comparing against the recording afterwards. Everything
 * else about subtitles-off can be asserted from the inside, and every one of those
 * assertions is written by the same person who wrote the thing being asserted. A recording
 * taken from a commit that had never heard of subtitles cannot be talked into agreeing.
 *
 * Three rules make it worth having, and each of them is a way this test could have been
 * worthless:
 *
 *  1. **Three goldens, not one.** A single MP4 recording would let a `tracks` key leak into
 *     the HLS path unseen — the two loads are built by the same function but carry different
 *     content types, different mount kinds and different names — and a resume would let one
 *     leak in only when `currentTime` is non-zero. So: a plain file, a growing playlist, and
 *     a resume at 10:00.
 *  2. **The string, not the object.** `{a,b}` and `{b,a}` parse to the same object and are
 *     different messages. `ReceivedMessage.raw` is what arrived, before `JSON.parse`.
 *  3. **Two exact substitutions and no regular expressions.** The mount token is random per
 *     run and the port is whatever the OS handed out, so those two — and only those two —
 *     are replaced, by `String.split`/`join` on a literal built from the values this run
 *     actually used. A pattern loose enough to be convenient here is a pattern loose enough
 *     to swallow the very key this file exists to catch.
 */

const FIXTURE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures',
  'load-golden.txt',
);

/** `CASTGOOD_UPDATE_GOLDEN=1 npx vitest run …` rewrites the recording. Never in CI. */
const UPDATING = process.env['CASTGOOD_UPDATE_GOLDEN'] === '1';

const HEADER = `# CastGood — the recorded LOAD payloads that criterion 19a is measured against.
#
# Equivalent to main @ 47d3bae (2026-08-27), the last commit before M3c step 3 touched
# src/engine/cast/index.ts. Recorded by test/engine/m3c-load-golden.test.ts driving the
# real engine through real intents against test/engine/fake-receiver.
#
# The shape that produced each one:
#   plain   Cars.mp4    — H.264 High 4.1 1080p + stereo AAC, Tier 1, cast untouched
#   hls     Cars.mkv    — 4K HEVC + DTS, Tier 3, head start, growing playlist
#   resume  Cars.mp4    — the same Tier 1 file, cast again at 0:10:00 (16c)
# Device: the fake receiver's "Family room TV" (md=Chromecast), on 127.0.0.1.
#
# Substituted, exactly and only: the per-session mount token and the media server port.
# Everything else is the bytes. If this file has to change, the change is a wire change,
# and 19a is a promise that it does not happen by accident.
`;

interface FakeMdns extends Mdns {
  up(service: MdnsService): void;
}

function createFakeMdns(): FakeMdns {
  const active = new Set<MdnsHandlers>();
  const seen: MdnsService[] = [];
  return {
    browse(handlers) {
      active.add(handlers);
      for (const service of seen) handlers.onUp(service);
      return { stop: () => void active.delete(handlers) };
    },
    destroy: () => Promise.resolve(),
    up(service) {
      seen.push(service);
      for (const handlers of [...active]) handlers.onUp(service);
    },
  };
}

interface ShiftingClock extends Clock {
  shift(ms: number): void;
}

function createShiftingClock(): ShiftingClock {
  let offset = 0;
  return {
    wallMs: () => Date.now() + offset,
    monoMs: () => systemClock.monoMs() + offset,
    shift(ms) {
      offset += ms;
    },
  };
}

function createManualTicker(): { ticker: GuardTicker; tick(times?: number): Promise<void> } {
  let onTick: (() => void) | null = null;
  return {
    ticker: {
      start(_intervalMs, tick) {
        onTick = tick;
        return () => {
          onTick = null;
        };
      },
    },
    async tick(times = 1) {
      for (let count = 0; count < times; count += 1) {
        onTick?.();
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    },
  };
}

const FILM_SEC = 7_200;
/** Where the resume golden starts. Exact, because a golden cannot compare a drifting number. */
const RESUME_SEC = 600;

/** Tier 1: the file every milestone before M3c cast untouched. */
const TIER1 = () =>
  report({
    durationSec: FILM_SEC,
    sizeBytes: 4_000_000_000,
    streams: [videoStream({}), audioStream({})],
  });

/** Tier 3: nothing in the model table plays 4K HEVC with DTS, so the picture is re-encoded. */
const TIER3 = () =>
  report({
    durationSec: FILM_SEC,
    sizeBytes: 8_000_000_000,
    streams: [
      videoStream({
        codec_name: 'hevc',
        profile: 'Main 10',
        width: 3_840,
        height: 2_160,
        coded_width: 3_840,
        coded_height: 2_160,
      }),
      audioStream({ codec_name: 'dts', profile: 'DTS-HD MA' }),
    ],
  });

let root: string;
let films: string;
let engine: Engine;
let receiver: FakeReceiver;
let mdns: FakeMdns;
let fake: FakeSpawn;
let clock: ShiftingClock;
let guard: ReturnType<typeof createManualTicker>;
let sink: ReturnType<typeof createMemorySink>;

function probes(answers: Record<string, unknown>): FfprobeRunner {
  return (filePath) => {
    const json = answers[path.basename(filePath)];
    return Promise.resolve(
      json === undefined
        ? { ok: false as const, failure: 'unreadable' as const }
        : { ok: true as const, probe: probeOf(json) },
    );
  };
}

async function build(answers: Record<string, unknown>): Promise<void> {
  fake = createFakeSpawn();
  sink = createMemorySink();
  mdns = createFakeMdns();
  clock = createShiftingClock();
  guard = createManualTicker();
  engine = createEngine({
    paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: root } }),
    logSink: sink,
    logLevel: 'debug',
    clock,
    transport: tcpTransportFactory,
    mdns,
    mediaPort: 0,
    ffprobe: probes(answers),
    ffmpeg: { ffmpeg: 'ffmpeg', ffprobe: 'ffprobe' },
    videoEncoder: 'libx264',
    freeBytes: () => Promise.resolve(4_000_000_000_000),
    spawn: fake.spawn,
    guardTicker: guard.ticker,
  });
  await engine.start();
  mdns.up({
    id: receiver.device.id,
    friendlyName: receiver.device.friendlyName,
    model: receiver.device.model,
    address: '127.0.0.1',
    port: receiver.port,
  });
}

function records(): LogRecord[] {
  return sink.lines.flatMap((line) => {
    try {
      return [JSON.parse(line) as LogRecord];
    } catch {
      return [];
    }
  });
}

async function waitFor(
  predicate: (snapshot: StateSnapshot) => boolean,
  what = 'condition',
  timeoutMs = 8_000,
): Promise<StateSnapshot> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate(engine.snapshot())) return engine.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * The tokens this run's media server actually published, newest first.
 *
 * Read from the engine's own `media.mounted` log line rather than guessed at, so the
 * substitution below is an exact string and not a pattern.
 */
function mountTokens(): string[] {
  return records()
    .filter((record) => record['event'] === 'media.mounted')
    .map((record) => String(record['token']))
    .reverse();
}

/**
 * The LOAD exactly as it went out, with the two per-run values named rather than matched.
 *
 * `split`/`join` on a literal: there is no regular expression anywhere in this file, which
 * is the point. The token and the port are the only two things that cannot be the same
 * twice, and both are read back from this run.
 */
function recordLoad(): string {
  const load = receiver.received.filter((message) => message.type === 'LOAD').at(-1);
  if (load === undefined) throw new Error('no LOAD reached the receiver');
  const port = engine.mediaServerPort;
  if (port === null) throw new Error('the media server never bound a port');
  let text = load.raw;
  for (const token of mountTokens()) {
    text = text
      .split(`http://127.0.0.1:${String(port)}/m/${token}/`)
      .join('http://<HOST>/m/<TOKEN>/');
  }
  return text;
}

function parseFixture(text: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | null = null;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      current = line.slice(3).trim();
      continue;
    }
    if (current === null || line.trim() === '') continue;
    sections[current] = line;
  }
  return sections;
}

function formatFixture(sections: Record<string, string>): string {
  const parts = [HEADER];
  for (const name of ['plain', 'hls', 'resume']) {
    parts.push(`\n## ${name}\n${sections[name] ?? ''}\n`);
  }
  return parts.join('');
}

/** What the goldens recorded, filled in by the three cases below and written once. */
const captured: Record<string, string> = {};

/**
 * Compare one recording against its section of the fixture — or, in update mode, keep it.
 *
 * Compared **per case** rather than once at the end, so a load that moved names itself.
 */
async function expectGolden(name: string): Promise<void> {
  captured[name] = recordLoad();
  if (UPDATING) return;
  const golden = parseFixture(await fsp.readFile(FIXTURE, 'utf8'));
  expect(captured[name], `the ${name} LOAD no longer matches the recording`).toBe(golden[name]);
}

async function selectAndCheck(filmPath: string): Promise<void> {
  engine.dispatch({ type: 'file.select', path: filmPath });
  await waitFor((s) => s.file !== null && s.check === null, 'the check');
}

/** Drive a Tier 3 conversion far enough past the gate that a television is told about it. */
async function openTheGate(child: FakeChild): Promise<void> {
  const advance = async (frontierSec: number, wallSec: number): Promise<void> => {
    clock.shift(wallSec * 1000);
    child.progress({ outTimeSec: frontierSec, speed: 2 });
    await new Promise((resolve) => setTimeout(resolve, 10));
  };
  await advance(0, 0);
  await advance(400, 200);
  await advance(700, 150);
  await waitFor((s) => s.headStart !== null, 'the head start to be serving');
}

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: FILM_SEC });
  root = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-golden-'));
  films = path.join(root, 'Films');
  await fsp.mkdir(films, { recursive: true });
});

afterEach(async () => {
  await engine.stop();
  await receiver.close();
  await fsp.rm(root, { recursive: true, force: true });
});

afterAll(async () => {
  if (!UPDATING) return;
  await fsp.writeFile(FIXTURE, formatFixture(captured), 'utf8');
});

describe('19a: the LOAD is byte-for-byte what it was before M3c existed', () => {
  it('a plain file cast is unchanged on the wire', async () => {
    const film = path.join(films, 'Cars.mp4');
    await fsp.writeFile(film, Buffer.alloc(4_096, 1));
    await build({ 'Cars.mp4': TIER1() });
    await selectAndCheck(film);
    expect(engine.snapshot().file?.verdict?.kind).toBe('ready');

    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');
    await expectGolden('plain');

    // The recording is only worth anything if it is a recording of the real thing.
    expect(captured['plain']).toContain('"contentType":"video/mp4"');
    expect(captured['plain']).toContain('"currentTime":0');
  });

  it('a growing playlist is unchanged on the wire', async () => {
    const film = path.join(films, 'Cars.mkv');
    await fsp.writeFile(film, Buffer.alloc(4_096, 1));
    await build({ 'Cars.mkv': TIER3(), 'Cars (CastGood).mp4': TIER1() });
    await selectAndCheck(film);
    expect(engine.snapshot().file?.verdict?.kind).toBe('convert');

    engine.dispatch({ type: 'cast.start' });
    if (engine.snapshot().file?.verdict?.requiresConfirmation === true) {
      await waitFor((s) => s.file?.verdict?.confirmation != null, 'the confirmation');
      engine.dispatch({ type: 'preparation.confirm' });
    }
    const child = await fake.waitForChild(fake.children.length + 1);
    await openTheGate(child);
    await waitFor((s) => s.session.state === 'playing', 'the film to play');
    await expectGolden('hls');

    expect(captured['hls']).toContain('"contentType":"application/vnd.apple.mpegurl"');
    expect(captured['hls']).toContain(HLS_PUBLISHED_PLAYLIST);
  });

  it('a resume at a remembered position is unchanged on the wire', async () => {
    const film = path.join(films, 'Cars.mp4');
    await fsp.writeFile(film, Buffer.alloc(4_096, 1));
    await build({ 'Cars.mp4': TIER1() });
    await selectAndCheck(film);

    engine.dispatch({ type: 'cast.start' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play');
    // Paused first, so the playhead stops moving and the position the founder is resuming
    // from is a number rather than a moving target. A golden cannot compare a drift.
    engine.dispatch({ type: 'playback.pause' });
    await waitFor((s) => s.session.state === 'paused', 'the pause');
    engine.dispatch({ type: 'playback.seek', positionSec: RESUME_SEC });
    await waitFor(
      (s) => Math.round(s.session.positionSec) === RESUME_SEC && s.session.seek === null,
      'the seek to land',
    );
    engine.dispatch({ type: 'cast.stop' });
    await waitFor((s) => s.session.resumePositionSec === RESUME_SEC, 'the remembered place');

    engine.dispatch({ type: 'cast.resume' });
    await waitFor((s) => s.session.state === 'playing', 'the film to play again');
    await expectGolden('resume');

    expect(captured['resume']).toContain(`"currentTime":${String(RESUME_SEC)}`);
  });
});
