import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  contentTypeFor,
  createMediaServer,
  type MediaServer,
} from '../../src/engine/media-server/index.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';

/**
 * The media server is one half of the whole product (we tell the TV what to do; it
 * fetches the bytes from us). These tests drive the real `node:http` server over a real
 * socket — no mocking — because the failures that matter here are protocol-level.
 */

let directory: string;
let filePath: string;
let server: MediaServer;
let sink: ReturnType<typeof createMemorySink>;
const CONTENT = Buffer.from('0123456789'.repeat(100)); // 1000 bytes

async function get(url: string, init?: RequestInit): Promise<Response> {
  return fetch(url, init);
}

beforeEach(async () => {
  directory = await fs.mkdtemp(path.join(os.tmpdir(), 'castgood-media-'));
  filePath = path.join(directory, 'Bluey - The Sign.mp4');
  await fs.writeFile(filePath, CONTENT);
  sink = createMemorySink();
  server = createMediaServer({ logger: createLogger({ sink, level: 'debug' }), preferredPort: 0 });
  await server.start();
});

afterEach(async () => {
  await server.stop();
  await fs.rm(directory, { recursive: true, force: true });
});

function url(mountToken: string, name = 'Bluey%20-%20The%20Sign.mp4'): string {
  return `http://127.0.0.1:${String(server.port)}/m/${mountToken}/${name}`;
}

describe('what this server says a file IS — the header a receiver believes', () => {
  it('serves a subtitle track as text/vtt, not as an anonymous blob', () => {
    // **M3c's second content type, and the reason it is declared rather than discovered.**
    // Without an entry here `.vtt` falls to `application/octet-stream`, and SPIKE-3 measured
    // what that looks like on all three televisions (2026-08-26): every one accepted the
    // switch and carried on playing. A receiver that refuses words while reporting nothing
    // wrong is the diagnostic-free failure this project has been bitten by repeatedly, and
    // an octet-stream track is a way to reach it that costs one line to close.
    expect(contentTypeFor('/films/Cars.eng.vtt')).toBe('text/vtt');
    expect(contentTypeFor('/films/CARS.EN.VTT')).toBe('text/vtt');
  });

  it('still falls back for anything genuinely unknown, rather than guessing', () => {
    expect(contentTypeFor('/films/notes.xyz')).toBe('application/octet-stream');
  });

  it('has not moved the types the video path already depends on', () => {
    expect(contentTypeFor('/f.mp4')).toBe('video/mp4');
    // The HLS pair the 2026-08-19 finding is about: the LOAD metadata and this header have
    // to agree, and a disagreement is another diagnostic-free refusal.
    expect(contentTypeFor('/f.m3u8')).toBe('application/vnd.apple.mpegurl');
    expect(contentTypeFor('/f.ts')).toBe('video/mp2t');
  });
});

describe('media server', () => {
  it('serves a whole file with the headers the receiver needs', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token));

    expect(response.status).toBe(200);
    expect(response.headers.get('accept-ranges')).toBe('bytes');
    expect(response.headers.get('content-type')).toBe('video/mp4');
    expect(response.headers.get('content-length')).toBe(String(CONTENT.length));
    expect(response.headers.get('access-control-allow-origin')).toBe('*');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT);
  });

  it('answers a suffix range — the trailing-moov case — with 206 and the tail only', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { headers: { Range: 'bytes=-20' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 980-999/1000');
    expect(response.headers.get('content-length')).toBe('20');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT.subarray(980));
  });

  it('answers an open-ended range with 206', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { headers: { Range: 'bytes=990-' } });

    expect(response.status).toBe(206);
    expect(response.headers.get('content-range')).toBe('bytes 990-999/1000');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT.subarray(990));
  });

  it('answers HEAD with the length and no body', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { method: 'HEAD' });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-length')).toBe('1000');
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('returns 416 with a Content-Range for an unsatisfiable range', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { headers: { Range: 'bytes=5000-6000' } });

    expect(response.status).toBe(416);
    expect(response.headers.get('content-range')).toBe('bytes */1000');
  });

  it('echoes the request Origin back, because a wildcard is rejected on some paths', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { headers: { Origin: 'https://tv.local' } });
    expect(response.headers.get('access-control-allow-origin')).toBe('https://tv.local');
    expect(response.headers.get('access-control-allow-headers')).toContain('Range');
  });

  it('answers a CORS preflight', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { method: 'OPTIONS' });
    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-methods')).toContain('GET');
  });

  it('builds an absolute URL from the address the Cast socket reported', () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    expect(server.urlFor(mount, '192.168.1.23')).toBe(
      `http://192.168.1.23:${String(server.port)}/m/${mount.token}/${encodeURIComponent('Bluey - The Sign.mp4')}`,
    );
  });

  it('reports whether the device has actually fetched anything', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    expect(server.hasServedRequest(mount.token)).toBe(false);
    await get(url(mount.token), { method: 'HEAD' });
    expect(server.hasServedRequest(mount.token)).toBe(true);
  });

  it('logs the byte range served, so a slow cast can be diagnosed from the log', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    await get(url(mount.token), { headers: { Range: 'bytes=-20' } });
    const request = sink.lines
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .find((record) => record['event'] === 'media.request');
    expect(request).toMatchObject({ start: 980, end: 999, bytes: 20, status: 206 });
  });

  it('refuses an unknown token, and says nothing about why', async () => {
    const response = await get(url('deadbeef'));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe('');
  });

  it('refuses to serve anything after the mount is released', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    server.unmount(mount.token);
    expect((await get(url(mount.token))).status).toBe(404);
  });

  it('refuses a path that climbs out of a directory mount', async () => {
    const secret = path.join(directory, 'secret.txt');
    await fs.writeFile(secret, 'not yours');
    const inner = path.join(directory, 'hls');
    await fs.mkdir(inner);
    await fs.writeFile(path.join(inner, 'index.m3u8'), '#EXTM3U');

    const mount = server.mount({ path: inner, kind: 'directory' });
    expect((await get(url(mount.token, 'index.m3u8'))).status).toBe(200);
    expect((await get(url(mount.token, '..%2Fsecret.txt'))).status).toBe(404);
  });

  it('answers a malformed percent-escape with 404, not 500', async () => {
    const inner = path.join(directory, 'hls');
    await fs.mkdir(inner);
    const mount = server.mount({ path: inner, kind: 'directory' });

    // `decodeURIComponent('%')` throws. On a server anything on the LAN can reach, that
    // has to read as "no such file", not as the server itself having broken.
    const response = await get(url(mount.token, '%'));
    expect(response.status).toBe(404);
    const events = sink.lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(events.some((record) => record['event'] === 'media.handler_failed')).toBe(false);
  });

  it('sends the whole file when the range is invalid rather than aborting playback', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { headers: { Range: 'bytes=200-100' } });

    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT);
  });

  it('returns 404 rather than crashing when the source file has vanished', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    await fs.rm(filePath);
    expect((await get(url(mount.token))).status).toBe(404);
  });

  /**
   * Re-publishing a URL a device is already fetching is the only reason a caller may
   * choose the token: after the app was closed and reopened, the TV is still asking for
   * the *old* URL, and a fresh random token would 404 every one of those requests.
   */
  it('re-publishes an existing URL when the token is supplied', async () => {
    const first = server.mount({ path: filePath, kind: 'file' });
    server.unmount(first.token);
    expect((await get(url(first.token))).status).toBe(404);

    const again = server.mount({ path: filePath, kind: 'file', token: first.token });
    expect(again.token).toBe(first.token);
    const response = await get(url(first.token));
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer())).toEqual(CONTENT);
  });

  it('invents a different random token for every ordinary mount', () => {
    const a = server.mount({ path: filePath, kind: 'file' });
    const b = server.mount({ path: filePath, kind: 'file' });
    expect(a.token).not.toBe(b.token);
    expect(a.token).toMatch(/^[0-9a-f]{32}$/);
  });

  it('rejects methods it does not implement', async () => {
    const mount = server.mount({ path: filePath, kind: 'file' });
    const response = await get(url(mount.token), { method: 'DELETE' });
    expect(response.status).toBe(405);
  });
});

describe('the derived response — a subtitle and every shifted version of it', () => {
  /**
   * The third kind of response this server has (`docs/ARCHITECTURE.md`), and the only one
   * that is computed rather than read off a disk. Story 20's ladder is thirteen URLs on
   * **one** mount, each shifting the same in-memory cue list by the offset named in its own
   * path — which is what keeps distinct content behind distinct URLs, the property a
   * television's own cache took away from every other approach SPIKE-3 tried.
   */
  const CUES = [
    { startMs: 1_000, endMs: 3_500, text: 'Hello.', id: null, settings: null },
    { startMs: 4_000, endMs: 6_000, text: 'Goodbye.', id: null, settings: null },
  ];

  function subtitleUrl(token: string, offsetMs: number): string {
    return `http://127.0.0.1:${String(server.port)}/m/${token}/sub/${String(offsetMs)}.vtt`;
  }

  function mountTrack() {
    return server.mount({ kind: 'subtitles', cues: CUES, name: 'English.vtt' });
  }

  it('shifts by exactly the offset in the URL, and nothing is written to disk', async () => {
    const mount = mountTrack();
    const before = await fs.readdir(directory);

    const inSync = await (await get(subtitleUrl(mount.token, 0))).text();
    expect(inSync).toContain('00:00:01.000 --> 00:00:03.500');

    const late = await (await get(subtitleUrl(mount.token, 1_500))).text();
    expect(late).toContain('00:00:02.500 --> 00:00:05.000');
    expect(late).toContain('00:00:05.500 --> 00:00:07.500');

    const early = await (await get(subtitleUrl(mount.token, -2_000))).text();
    // Clipped at the front rather than moved: a cue straddling 0:00 keeps its true end.
    expect(early).toContain('00:00:00.000 --> 00:00:01.500');

    // A derived mount has nothing behind it, which is the whole point of building it this
    // way rather than as thirteen files (2026-08-27 ADR).
    expect(mount.path).toBe('');
    expect(await fs.readdir(directory)).toEqual(before);
  });

  it('carries the headers a receiver’s own JavaScript needs, and an exact length', async () => {
    const mount = mountTrack();
    const response = await get(subtitleUrl(mount.token, 500), {
      headers: { Origin: 'https://www.gstatic.com' },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/vtt');
    // The 2026-08-19 CORS finding, applied to the third serving shape this server has.
    expect(response.headers.get('access-control-allow-origin')).toBe('https://www.gstatic.com');
    // Never cached: the ladder's whole design is that content and URL move together, and a
    // cached track is the failure SPIKE-3 watched a television produce with a straight face.
    expect(response.headers.get('cache-control')).toBe('no-store');
    const body = await response.text();
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')));
  });

  it('counts bytes rather than characters, so an accent cannot truncate a cue', async () => {
    const mount = server.mount({
      kind: 'subtitles',
      cues: [{ startMs: 0, endMs: 1_000, text: 'Café — naïve', id: null, settings: null }],
      name: 'French.vtt',
    });
    const response = await get(subtitleUrl(mount.token, 0));
    const body = await response.text();
    expect(body).toContain('Café — naïve');
    // A television handed a short `Content-Length` stops reading mid-word, and every one of
    // these characters is more than one byte.
    expect(Number(response.headers.get('content-length'))).toBeGreaterThan(body.length);
    expect(response.headers.get('content-length')).toBe(String(Buffer.byteLength(body, 'utf8')));
  });

  it('answers HEAD, and offers no byte ranges — there is no file to seek in', async () => {
    const mount = mountTrack();
    const head = await get(subtitleUrl(mount.token, 0), { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    expect(head.headers.get('content-length')).not.toBe('0');
    expect(head.headers.get('accept-ranges')).toBeNull();

    // A Range header is not honoured and not refused — the whole track goes out, which is
    // what a receiver fetching a few tens of kilobytes of text actually wants.
    const ranged = await get(subtitleUrl(mount.token, 0), { headers: { Range: 'bytes=0-9' } });
    expect(ranged.status).toBe(200);
  });

  it('refuses an offset past ±30 s rather than clamping it to one that works', async () => {
    const mount = mountTrack();
    // Clamping would put identical bytes behind two different URLs, and "distinct content,
    // distinct URL" is the one property this shape rests on. Nothing outside the range is
    // ever handed out, so anything asking for one is a mistake or a guess.
    expect((await get(subtitleUrl(mount.token, 99_999))).status).toBe(404);
    expect((await get(subtitleUrl(mount.token, -99_999))).status).toBe(404);
    expect((await get(subtitleUrl(mount.token, 30_000))).status).toBe(200);
  });

  it('refuses anything that is not a rung of this mount', async () => {
    const mount = mountTrack();
    const base = `http://127.0.0.1:${String(server.port)}/m/${mount.token}`;
    expect((await get(`${base}/sub/half.vtt`)).status).toBe(404);
    expect((await get(`${base}/sub/500.srt`)).status).toBe(404);
    expect((await get(`${base}/500.vtt`)).status).toBe(404);
    expect((await get(`${base}/sub/500.vtt/extra`)).status).toBe(404);
    // Nothing on disk stands behind this mount, so a path that would escape one cannot
    // reach anything either.
    expect((await get(`${base}/sub/..%2F..%2Fetc%2Fpasswd`)).status).toBe(404);
  });

  it('builds a rung URL that names its own offset', () => {
    const mount = mountTrack();
    expect(server.subtitleUrlFor(mount, '10.1.1.5', 0)).toBe(
      `http://10.1.1.5:${String(server.port)}/m/${mount.token}/sub/0.vtt`,
    );
    expect(server.subtitleUrlFor(mount, '10.1.1.5', -1_500)).toBe(
      `http://10.1.1.5:${String(server.port)}/m/${mount.token}/sub/-1500.vtt`,
    );
    // Clamped through the same function the displayed number goes through, so a URL can
    // never name an offset the control could not have reached — and the route below would
    // otherwise 404 it mid-film.
    expect(server.subtitleUrlFor(mount, '10.1.1.5', 99_999)).toBe(
      `http://10.1.1.5:${String(server.port)}/m/${mount.token}/sub/30000.vtt`,
    );
  });
});
