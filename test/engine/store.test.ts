import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createStore,
  DEFAULT_SETTINGS,
  MAX_REMEMBERED_OFFSETS,
  SCHEMA_VERSION,
  type SessionRecord,
} from '../../src/engine/store/index.js';
import { createLogger, createMemorySink, createTestClock } from '../../src/engine/logging/index.js';
import { resolveAppPaths, type AppPaths } from '../../src/engine/paths.js';
import type { DeviceId, SessionToken } from '../../src/engine/types.js';

/**
 * The settings file — the only thing in CastGood that outlives the process.
 *
 * It had no test at all, which mattered twice over. It is the whole of story 12's
 * dependency on disk: when the window closes the media server closes with it, and the
 * television is left fetching a URL that has stopped answering. Reattaching works *only*
 * if the reopened app republishes the identical URL — same port, same token — which is
 * exactly what this file remembers.
 *
 * And it is the one place the founder's 2026-08-15 ruling can be broken by accident. That
 * ruling put last-used-device memory and prepared-file memory in **M3**, and M3a has now
 * taken the first of them — `lastDeviceId` (9f) — plus the permanent record of what a
 * television has refused (7e). What has *not* changed is the property that keeps the
 * session record honest: it is **cleared the moment a session ends**, so it can never
 * become "the TV you used last night" by the back door, and the deliberate memory sits in
 * its own field where it can be seen. Prepared-file memory is still not here at all: the
 * 2026-08-19 sibling ADR makes the prepared file its own record on disk. All three are
 * properties of behaviour rather than of good intentions, so all three are pinned below.
 */

let directory: string;
let paths: AppPaths;
const sink = createMemorySink();

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-store-'));
  paths = resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: directory } });
  sink.lines.length = 0;
});

afterEach(async () => {
  await fs.rm(directory, { recursive: true, force: true });
});

function makeStore() {
  const logger = createLogger({ sink, clock: createTestClock(1_700_000_000_000, 0) });
  return createStore({ logger, paths });
}

function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    deviceId: 'device-abc' as DeviceId,
    filePath: 'C:\\Users\\Darren\\Desktop\\Cars.mp4',
    fileName: 'Cars.mp4',
    token: 'a1b2c3d4e5f60718' as SessionToken,
    mediaPort: 8_010,
    mediaSessionId: 3,
    positionSec: 1_560.25,
    savedAtWall: 1_700_000_000_000,
    // 18h, M3c step 5: what was on the television, and `null` for the ordinary session
    // where the founder never turned subtitles on — which is what this fixture is.
    subtitle: null,
    ...overrides,
  };
}

function downgrade() {
  return {
    at: 1_700_000_000_000,
    signature: {
      container: 'mp4' as const,
      videoCodec: 'hevc',
      videoProfile: 'Main 10',
      videoLevel: 51,
      width: 3_840,
      height: 2_160,
      frameRate: 24,
      audioCodecs: ['eac3'],
    },
    steps: [{ kind: 'drop-video-codec' as const, codec: 'hevc' as const }],
  };
}

async function readFileJson(): Promise<Record<string, unknown>> {
  return JSON.parse(await fs.readFile(paths.settingsFile, 'utf8')) as Record<string, unknown>;
}

describe('what survives a restart', () => {
  it('round-trips the session record exactly', async () => {
    const first = makeStore();
    await first.load();
    await first.rememberSession(record());
    await first.flush();

    const second = makeStore();
    await second.load();
    expect(second.settings.session).toEqual(record());
  });

  it('keeps the port and the token — the two halves of the URL a reattach republishes', async () => {
    // SPIKE-2's reattach worked *only* because the second process republished an
    // identical URL. Both halves were random per run and neither survived a restart, and
    // a television left fetching a dead address plays on out of its buffer and then stalls
    // — the failure nothing in the app can see.
    const first = makeStore();
    await first.load();
    await first.setMediaPort(41_337);
    await first.rememberSession(
      record({ mediaPort: 41_337, token: 'ffee00112233' as SessionToken }),
    );
    await first.flush();

    const reopened = makeStore();
    await reopened.load();
    expect(reopened.settings.mediaPort).toBe(41_337);
    expect(reopened.settings.session?.mediaPort).toBe(41_337);
    expect(reopened.settings.session?.token).toBe('ffee00112233');
  });

  it('writes atomically and leaves no temp file behind', async () => {
    const store = makeStore();
    await store.load();
    await store.rememberSession(record());
    await store.flush();

    const written = await fs.readdir(directory);
    expect(written.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect((await readFileJson())['schemaVersion']).toBe(SCHEMA_VERSION);
  });

  it('serialises writes, so the last one asked for is the one on disk', async () => {
    // The record for the session that just ended must never land *after* the one that
    // ended it. Two fire-and-forget writes racing is how that happens.
    const store = makeStore();
    await store.load();
    void store.rememberSession(record({ positionSec: 1 }));
    void store.rememberSession(record({ positionSec: 2 }));
    void store.forgetSession();
    await store.flush();

    expect(store.settings.session).toBeNull();
    expect((await readFileJson())['session']).toBeNull();
  });
});

describe('the founder’s ruling, held by behaviour rather than by intention', () => {
  it('clears the record when the session ends, so it cannot become last-used-device memory', async () => {
    // Remembered devices are M3 (founder, 2026-08-15). This file stays inside that ruling
    // only because nothing it holds outlives the session it describes: after a stop there
    // is no device, no file and no port left on disk to preselect anything from.
    const store = makeStore();
    await store.load();
    await store.rememberSession(record());
    await store.forgetSession();
    await store.flush();

    expect(store.settings.session).toBeNull();
    const onDisk = await readFileJson();
    expect(onDisk['session']).toBeNull();
    expect(JSON.stringify(onDisk)).not.toContain('device-abc');
    expect(JSON.stringify(onDisk)).not.toContain('Cars.mp4');
  });

  it('remembers nothing but the port once a session has ended', async () => {
    const store = makeStore();
    await store.load();
    await store.setMediaPort(8_010);
    await store.rememberSession(record());
    await store.forgetSession();
    await store.flush();

    const reopened = makeStore();
    await reopened.load();
    // **The guard on the ruling, and it has now been widened once, on purpose.** M3a added
    // `lastDeviceId` (9f) and `devices` (7e's permanent record of what a television
    // refused), which is exactly the growth the founder's 2026-08-15 ruling authorised for
    // M3. Prepared-file memory is *not* here and must not appear: the 2026-08-19 sibling
    // ADR makes the prepared file its own record on disk. Anything else arriving in this
    // list is a decision somebody takes deliberately, with the founder, rather than a line
    // in a diff nobody reads.
    expect(Object.keys(reopened.settings).sort()).toEqual([
      'devices',
      'lastDeviceId',
      'mediaPort',
      'schemaVersion',
      'session',
      // M3c step 5, and the deliberate decision this test exists to force: **20f** is the
      // first thing in this file that is data rather than a cache — a timing correction
      // cannot be re-derived from the file the way a port can be rebound or a prepared
      // artifact re-probed. Keyed by subtitle source, written on the founder's own press,
      // and stated on screen when it is applied.
      'subtitleOffsets',
    ]);
    expect(reopened.settings.session).toBeNull();
    // The port is not a memory of anything the founder chose: it is this PC's own port,
    // and it exists so a television can find its way back to it.
    expect(reopened.settings.mediaPort).toBe(8_010);
  });

  it('remembers the television the founder chose, and only when they chose it (9f)', async () => {
    const store = makeStore();
    await store.load();
    expect(store.settings.lastDeviceId).toBeNull();

    await store.rememberDevice('tv-1' as DeviceId, 'Family room TV', 'AI PONT');
    await store.flush();

    const reopened = makeStore();
    await reopened.load();
    expect(reopened.settings.lastDeviceId).toBe('tv-1');
    expect(reopened.settings.devices['tv-1']?.friendlyName).toBe('Family room TV');
  });

  it('keeps a refusal permanently, and keeps it through a rename (7e)', async () => {
    // Narrowing is monotone and the capability ADR requires the fact to outlive the
    // session. A device that "recovered" between runs would put the founder back in front
    // of the exact failure the safety net exists to remove.
    const store = makeStore();
    await store.load();
    await store.rememberDevice('tv-1' as DeviceId, 'Family room TV', 'AI PONT');
    const after = await store.recordDowngrade('tv-1' as DeviceId, downgrade());
    expect(after).toHaveLength(1);
    // Read back before the write has landed: the next plan depends on this being the
    // *queued* value, which is the defect `forgetSession` was once caught by.
    expect(store.downgradesFor('tv-1' as DeviceId)).toHaveLength(1);

    // The founder renames the television. That is a fact about a name, not about hardware.
    await store.rememberDevice('tv-1' as DeviceId, 'Lounge TV', 'AI PONT');
    await store.flush();

    const reopened = makeStore();
    await reopened.load();
    expect(reopened.settings.devices['tv-1']?.friendlyName).toBe('Lounge TV');
    expect(reopened.downgradesFor('tv-1' as DeviceId)).toHaveLength(1);
    expect(reopened.downgradesFor('tv-1' as DeviceId)[0]?.steps).toEqual(downgrade().steps);
  });

  it('pins the exact field set of the remembered session', async () => {
    // **The guard on the ruling.** The store was authorised as "the minimum story 12
    // cannot work without": media port and session token, plus enough to know which
    // session it was. A future milestone that wants remembered devices, prepared-file
    // memory, watch history or a resume list will add a field here first — and this test
    // is what makes that a decision somebody takes deliberately, with the founder, rather
    // than a line in a diff nobody reads.
    const store = makeStore();
    await store.load();
    await store.rememberSession(record());
    await store.flush();

    const session = (await readFileJson())['session'] as Record<string, unknown>;
    expect(Object.keys(session).sort()).toEqual(
      [
        'deviceId',
        'fileName',
        'filePath',
        'mediaPort',
        'mediaSessionId',
        'positionSec',
        'savedAtWall',
        'token',
        // 18h: the subtitle that was on the television when the app closed, or `null`.
        'subtitle',
      ].sort(),
    );
  });
});

describe('a settings file written by another version', () => {
  it('carries a version-1 file forward instead of throwing it away', async () => {
    // The upgrade the founder would actually experience: close CastGood mid-film on the
    // M2 build, install M3a, reopen. Discarding the file here costs them the reattach
    // (12a) — a television still playing and an app that has forgotten about it — for no
    // reason, because every field version 2 added is optional.
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(
      paths.settingsFile,
      JSON.stringify({ schemaVersion: 1, mediaPort: 8_010, session: record() }),
    );

    const store = makeStore();
    await store.load();
    expect(store.settings.session).toEqual(record());
    expect(store.settings.mediaPort).toBe(8_010);
    expect(store.settings.lastDeviceId).toBeNull();
    expect(store.settings.devices).toEqual({});
    expect(sink.lines.join('')).not.toContain('store.corrupt');

    // And the next write stamps the current version, so this only happens once.
    await store.setMediaPort(8_011);
    await store.flush();
    expect((await readFileJson())['schemaVersion']).toBe(SCHEMA_VERSION);
  });

  it('starts fresh on a file from a newer version, whose fields could mean anything', async () => {
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(
      paths.settingsFile,
      JSON.stringify({ schemaVersion: 99, mediaPort: 8_010, session: record() }),
    );

    const store = makeStore();
    await store.load();
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(sink.lines.join('')).toContain('store.schema_from_the_future');
  });
});

describe('a file on disk is not trusted input', () => {
  it('starts from defaults when there is no file at all — the ordinary first run', async () => {
    const store = makeStore();
    await store.load();
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(sink.lines.join('')).not.toContain('store.corrupt');
  });

  it('does not crash on a half-written file, and keeps it as evidence', async () => {
    // A power cut mid-write, or a hand-edit. Losing a reattach is a cost worth paying;
    // refusing to start is not.
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(paths.settingsFile, '{"schemaVersion": 1, "mediaPort": 8010, "sess');

    const store = makeStore();
    await expect(store.load()).resolves.toBeUndefined();
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    // Moved aside rather than deleted: it is still the only evidence of what went wrong.
    await expect(fs.readFile(`${paths.settingsFile}.corrupt`, 'utf8')).resolves.toContain('sess');
    expect(sink.lines.join('')).toContain('store.corrupt');
  });

  it('treats a partial record as absent rather than half-believing it', async () => {
    // A session record with no token cannot republish a URL, and a port of 0 is not a
    // port. Adopting either would mean reattaching to an address the television is not
    // fetching — a reattach that looks perfect and stalls the film a minute later.
    for (const broken of [
      { schemaVersion: 1, mediaPort: 8_010, session: { ...record(), token: undefined } },
      { schemaVersion: 1, mediaPort: 8_010, session: { ...record(), mediaPort: 0 } },
      { schemaVersion: 1, mediaPort: 8_010, session: { ...record(), positionSec: 'half way' } },
      { schemaVersion: 1, mediaPort: 70_000, session: null },
      { schemaVersion: 1, mediaPort: 8_010, session: { ...record(), token: 'not hex at all' } },
    ]) {
      await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
      await fs.writeFile(paths.settingsFile, JSON.stringify(broken));
      const store = makeStore();
      await store.load();
      expect(store.settings, JSON.stringify(broken)).toEqual(DEFAULT_SETTINGS);
      await fs.rm(`${paths.settingsFile}.corrupt`, { force: true });
    }
  });

  it('starts fresh on a file from a version that is not this one', async () => {
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(
      paths.settingsFile,
      JSON.stringify({ schemaVersion: SCHEMA_VERSION + 1, mediaPort: 8_010, session: record() }),
    );
    const store = makeStore();
    await store.load();
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
  });

  it('never lets a failed write take the session with it', async () => {
    // The data directory is a file: every write will fail. Playback must not care.
    const blocked = path.join(directory, 'blocked');
    await fs.writeFile(blocked, 'not a directory');
    const logger = createLogger({ sink, clock: createTestClock(1_700_000_000_000, 0) });
    const store = createStore({
      logger,
      paths: resolveAppPaths({ platform: 'linux', env: { CASTGOOD_DATA_DIR: blocked } }),
    });

    await store.load();
    await expect(store.rememberSession(record())).resolves.toBeUndefined();
    await expect(store.flush()).resolves.toBeUndefined();
    // The in-memory value stands, so the running session is unaffected; only the next
    // run's reattach is lost, and the log says so.
    expect(store.settings.session).toEqual(record());
    expect(sink.lines.join('')).toContain('store.write_failed');
  });
});

describe('20f: the remembered timing correction', () => {
  const key = 'file:d:/films/cars.en.srt';
  const correction = {
    offsetMs: 600,
    fingerprint: '842:1000:7190000',
    savedAtWall: 1_700_000_000_000,
  };

  it('survives the process it was set in', async () => {
    const store = makeStore();
    await store.load();
    await store.rememberSubtitleOffset(key, correction);
    await store.flush();

    // The whole of 20f's *"next week, after reopening the app, after restarting the PC"* —
    // a second store reading the same file off the same disk.
    const reopened = makeStore();
    await reopened.load();
    expect(reopened.subtitleOffsetFor(key)).toEqual(correction);
    expect(reopened.subtitleOffsetFor('file:d:/films/cars.fr.srt')).toBeNull();
  });

  it('answers with what was just asked for, before the write has landed', async () => {
    // The same hazard `downgradesFor` was fixed for: choosing a source twice in one
    // evening must see the correction set half a second ago, not the one on disk.
    const store = makeStore();
    await store.load();
    void store.rememberSubtitleOffset(key, correction);
    expect(store.subtitleOffsetFor(key)?.offsetMs).toBe(600);
    await store.flush();
  });

  it('forgets rather than stores a zero, because Reset means "these are in time"', async () => {
    const store = makeStore();
    await store.load();
    await store.rememberSubtitleOffset(key, correction);
    await store.rememberSubtitleOffset(key, { ...correction, offsetMs: 0 });
    await store.flush();

    expect(store.subtitleOffsetFor(key)).toBeNull();
    const onDisk = (await readFileJson())['subtitleOffsets'] as Record<string, unknown>;
    expect(Object.keys(onDisk)).toHaveLength(0);
  });

  it('keeps the newest and drops the oldest past the bound, reading and writing', async () => {
    // An over-full file is **trimmed, not thrown away** — the founder's corrections are
    // data, and discarding all of them because there are too many would be the expensive
    // way to enforce a bound that exists to keep a settings file small.
    const crowded: Record<string, unknown> = {};
    for (let index = 0; index < MAX_REMEMBERED_OFFSETS + 5; index += 1) {
      crowded[`file:/subs/${String(index)}.srt`] = {
        ...correction,
        savedAtWall: 1_700_000_000_000 + index,
      };
    }
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(
      paths.settingsFile,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        mediaPort: null,
        session: null,
        subtitleOffsets: crowded,
      }),
    );

    const store = makeStore();
    await store.load();
    expect(Object.keys(store.settings.subtitleOffsets)).toHaveLength(MAX_REMEMBERED_OFFSETS);
    // The oldest went; the newest stayed. The cost when this fires is the oldest re-nudge
    // in the house.
    expect(store.subtitleOffsetFor('file:/subs/0.srt')).toBeNull();
    expect(
      store.subtitleOffsetFor(`file:/subs/${String(MAX_REMEMBERED_OFFSETS + 4)}.srt`),
    ).not.toBeNull();

    // And the bound holds on the way out as well as on the way in.
    await store.rememberSubtitleOffset('file:/subs/tonight.srt', {
      ...correction,
      savedAtWall: 1_800_000_000_000,
    });
    await store.flush();
    const reopened = makeStore();
    await reopened.load();
    expect(Object.keys(reopened.settings.subtitleOffsets)).toHaveLength(MAX_REMEMBERED_OFFSETS);
    expect(reopened.subtitleOffsetFor('file:/subs/tonight.srt')?.offsetMs).toBe(600);
  });

  it('treats a hand-edited entry as absent rather than believing it', async () => {
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(
      paths.settingsFile,
      JSON.stringify({
        schemaVersion: SCHEMA_VERSION,
        mediaPort: 8_010,
        session: null,
        subtitleOffsets: { [key]: { offsetMs: 'ages', fingerprint: 1, savedAtWall: 0 } },
      }),
    );
    const store = makeStore();
    await store.load();
    // A file on disk is not trusted input. The whole document is treated as unusable rather
    // than the bad entry being patched up into something plausible.
    expect(store.settings).toEqual(DEFAULT_SETTINGS);
    expect(sink.lines.join('')).toContain('store.corrupt');
  });

  it('reads a version-2 file as one belonging to a founder who never nudged anything', async () => {
    await fs.mkdir(path.dirname(paths.settingsFile), { recursive: true });
    await fs.writeFile(
      paths.settingsFile,
      JSON.stringify({ schemaVersion: 2, mediaPort: 8_010, session: null, devices: {} }),
    );
    const store = makeStore();
    await store.load();
    expect(store.settings.subtitleOffsets).toEqual({});
    expect(sink.lines.join('')).not.toContain('store.corrupt');
  });
});

describe('18h: the subtitle that was on the television', () => {
  it('comes back with the session record, and only when there was one', async () => {
    const store = makeStore();
    await store.load();
    await store.rememberSession(
      record({
        subtitle: {
          sourceId: 'sidecar:D:\\Films\\Cars.srt',
          label: 'Cars.srt',
          language: '',
          offsetMs: 600,
          token: 'a1b2c3d4e5f60718',
        },
      }),
    );
    await store.flush();

    const reopened = makeStore();
    await reopened.load();
    expect(reopened.settings.session?.subtitle?.offsetMs).toBe(600);
    // The token is what makes the thirteen rung URLs the television is still holding
    // answer again — the same argument SPIKE-2 made about the film's own URL.
    expect(reopened.settings.session?.subtitle?.token).toBe('a1b2c3d4e5f60718');

    await reopened.forgetSession();
    await reopened.flush();
    expect(reopened.settings.session).toBeNull();
  });
});
