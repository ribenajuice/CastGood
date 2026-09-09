import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createMediaServer, type MediaServer } from '../../src/engine/media-server/index.js';
import {
  buildPlaylist,
  existingSegments,
  parseHlsIndex,
  publishedSeconds,
  targetDurationFor,
  HLS_PUBLISHED_PLAYLIST,
  HLS_SOURCE_PLAYLIST,
} from '../../src/engine/media-server/hls.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';

/**
 * The second serving shape (10a, 10c, 10e, P5), and **every assertion here is a fault SPIKE-1
 * actually hit**.
 *
 * The reason this file is long for what it covers: an HLS load that a Chromecast refuses
 * arrives as a bare `LOAD_FAILED` with **no reason attached** — the same message a genuine
 * codec refusal sends. Relative segment URLs cost one evening's run; missing CORS headers and
 * an untrue `TARGETDURATION` cost another. Nothing about either was diagnosable from the
 * wire, so each of them is pinned here instead.
 */

const sink = createMemorySink();
let server: MediaServer;
let dir: string;
let token: string;

/** ffmpeg's own playlist, with the quirk that matters: `TARGETDURATION` is not the truth. */
const FFMPEG_INDEX = `#EXTM3U
#EXT-X-VERSION:3
#EXT-X-TARGETDURATION:4
#EXT-X-MEDIA-SEQUENCE:0
#EXT-X-PLAYLIST-TYPE:EVENT
#EXTINF:4.004000,
segment00000.ts
#EXTINF:12.262256,
segment00001.ts
#EXTINF:3.962000,
segment00002.ts
`;

beforeEach(async () => {
  sink.lines.length = 0;
  dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'castgood-hls-'));
  await fsp.writeFile(path.join(dir, HLS_SOURCE_PLAYLIST), FFMPEG_INDEX);
  for (const name of ['segment00000.ts', 'segment00001.ts', 'segment00002.ts']) {
    await fsp.writeFile(path.join(dir, name), Buffer.alloc(64, 9));
  }
  server = createMediaServer({ logger: createLogger({ sink, bindings: {} }) });
  await server.start(0);
  const mount = server.mount({ path: dir, kind: 'hls' });
  token = mount.token;
  // The address the television would have been given, read off the live Cast socket in a
  // real run. It is what makes the published segment URLs absolute.
  server.urlFor(mount, '10.1.1.230');
});

afterEach(async () => {
  await server.stop();
  await fsp.rm(dir, { recursive: true, force: true });
});

function url(pathname: string): string {
  return `http://127.0.0.1:${String(server.port)}${pathname}`;
}

describe('the playlist we emit (10a)', () => {
  it('declares a target duration the segments actually keep', () => {
    const index = parseHlsIndex(FFMPEG_INDEX);
    // ffmpeg asked for 4 and produced a 12.262256 s segment. Declaring 4 next to it is
    // invalid HLS and a candidate cause of a refused load.
    expect(targetDurationFor(index.segments)).toBe(13);
    expect(publishedSeconds(index.segments)).toBeCloseTo(20.228, 3);
  });

  it('names every segment absolutely, because a relative name was refused', () => {
    const body = buildPlaylist({
      segments: parseHlsIndex(FFMPEG_INDEX).segments,
      baseUrl: 'http://10.1.1.230:8010/m/abc/',
      ended: false,
    });
    for (const line of body.split('\n').filter((entry) => entry.endsWith('.ts'))) {
      expect(line.startsWith('http://10.1.1.230:8010/m/abc/')).toBe(true);
    }
  });

  it('withholds ENDLIST while it is growing, because ENDLIST alone decides live-vs-VOD', () => {
    const segments = parseHlsIndex(FFMPEG_INDEX).segments;
    expect(buildPlaylist({ segments, baseUrl: '/', ended: false })).not.toContain('ENDLIST');
    expect(buildPlaylist({ segments, baseUrl: '/', ended: false })).toContain(
      '#EXT-X-PLAYLIST-TYPE:EVENT',
    );
    expect(buildPlaylist({ segments, baseUrl: '/', ended: true })).toContain('#EXT-X-ENDLIST');
  });

  it('never publishes a segment that is not on the disk', () => {
    const segments = parseHlsIndex(FFMPEG_INDEX).segments;
    const present = new Set(['segment00000.ts', 'segment00002.ts']);
    // Publishing a name that 404s is the stall the PRD forbids, arriving as our own fault.
    expect(existingSegments(segments, present).map((s) => s.name)).toEqual([
      'segment00000.ts',
      'segment00002.ts',
    ]);
  });

  it('drops a segment line it has no measured duration for', () => {
    // A duration we invented would be a playlist no receiver has ever seen.
    const parsed = parseHlsIndex('#EXTM3U\nmystery.ts\n#EXTINF:4.0,\nreal.ts\n');
    expect(parsed.segments).toEqual([{ name: 'real.ts', durationSec: 4 }]);
  });
});

describe('what the server answers (10a, and the two refused runs)', () => {
  it('serves our playlist and never ffmpeg’s own', async () => {
    const response = await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`));
    expect(response.status).toBe(200);
    const body = await response.text();
    // Recomputed from the segments, not copied from the file we read.
    expect(body).toContain('#EXT-X-TARGETDURATION:13');
    expect(body).toContain(`http://10.1.1.230:${String(server.port)}/m/${token}/segment00000.ts`);
    expect(response.headers.get('content-type')).toBe('application/vnd.apple.mpegurl');
    // A cached playlist never grows, and the whole point is that it grows.
    expect(response.headers.get('cache-control')).toBe('no-store');
  });

  it('puts CORS on every response of every shape, including the ones that fail', async () => {
    // The failure this prevents has **no diagnostic at all**: the playlist fetches 200, not
    // one segment is ever requested, and the sender sees a bare LOAD_FAILED.
    const checks = [
      await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`)),
      await fetch(url(`/m/${token}/segment00000.ts`)),
      await fetch(url(`/m/${token}/nothing-here.ts`)),
      await fetch(url('/m/not-a-token/stream.m3u8')),
      await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`), { method: 'HEAD' }),
    ];
    for (const response of checks) {
      expect(response.headers.get('access-control-allow-origin')).not.toBeNull();
      await response.arrayBuffer();
    }
    expect(checks[2]?.status).toBe(404);
    expect(checks[3]?.status).toBe(404);
  });

  it('answers an OPTIONS preflight 204, with the headers on it', async () => {
    const response = await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`), {
      method: 'OPTIONS',
      headers: { origin: 'https://www.gstatic.com' },
    });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.gstatic.com');
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('answers HEAD with the same headers and no body', async () => {
    const head = await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`), { method: 'HEAD' });
    const get = await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`));
    const body = await get.text();
    expect(head.status).toBe(200);
    expect(head.headers.get('content-length')).toBe(String(Buffer.byteLength(body)));
    expect(await head.text()).toBe('');
  });

  it('serves segments as MPEG-TS', async () => {
    const response = await fetch(url(`/m/${token}/segment00001.ts`));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('video/mp2t');
    expect((await response.arrayBuffer()).byteLength).toBe(64);
  });

  it('grows: a playlist read again names the segments written since', async () => {
    await fsp.appendFile(
      path.join(dir, HLS_SOURCE_PLAYLIST),
      '#EXTINF:4.001000,\nsegment00003.ts\n#EXT-X-ENDLIST\n',
    );
    await fsp.writeFile(path.join(dir, 'segment00003.ts'), Buffer.alloc(64, 9));
    const body = await (await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`))).text();
    expect(body).toContain('segment00003.ts');
    // ENDLIST arrived with it: the same artifact is now an ordinary, fully seekable film.
    expect(body).toContain('#EXT-X-ENDLIST');
  });

  it('refuses to walk out of the segment folder', async () => {
    const response = await fetch(url(`/m/${token}/..%2F..%2Fetc%2Fpasswd`));
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).not.toBeNull();
  });

  it('404s the playlist honestly before the first segment exists', async () => {
    await fsp.rm(path.join(dir, HLS_SOURCE_PLAYLIST));
    const response = await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`));
    expect(response.status).toBe(404);
    expect(response.headers.get('access-control-allow-origin')).not.toBeNull();
  });

  it('says so in the log when a television reads the playlist and asks for nothing', async () => {
    for (let read = 0; read < 3; read += 1) {
      await (await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`))).text();
    }
    const records = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const unused = records.filter((record) => record['event'] === 'media.playlist_unused');
    // Three playlists, no segments: the signature of a television that read the list and
    // could not use it. It is a *serving* fault — the only diagnostic that exists for one —
    // and it must never narrow a device's capability profile.
    expect(unused).toHaveLength(1);
    expect(unused[0]).toMatchObject({ playlistsServed: 3, segmentsServed: 0 });
  });

  it('says nothing of the kind when the television is actually fetching segments', async () => {
    for (let read = 0; read < 3; read += 1) {
      await (await fetch(url(`/m/${token}/${HLS_PUBLISHED_PLAYLIST}`))).text();
      await (await fetch(url(`/m/${token}/segment00000.ts`))).arrayBuffer();
    }
    const records = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(records.filter((record) => record['event'] === 'media.playlist_unused')).toHaveLength(0);
  });
});
