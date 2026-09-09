import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createCastClient, tcpTransportFactory } from '../../src/engine/cast/index.js';
import type { CastConnection, DisconnectInfo, MediaStatus } from '../../src/engine/cast/index.js';
import { createLogger, createMemorySink } from '../../src/engine/logging/index.js';
import { startFakeReceiver, type FakeReceiver } from './fake-receiver/index.js';

/**
 * Who ended the session — and it has to be right, not nearly right.
 *
 * In M1 both answers land in the same place: the session stops with the position kept. In
 * M2 they diverge completely. "The device ended it" means the founder stopped it from the
 * TV, or something else took it, and we yield without a fuss. "We lost it" means wifi
 * blipped or the TV was unplugged, and reconnect-and-resume is the entire point of the
 * milestone. Getting this backwards means the app quietly decides the founder meant to
 * stop, and does not come back — which is precisely the evening this product exists to
 * prevent.
 *
 * The founder's log had `{reason: "closed by engine", deviceInitiated: true}` on one line:
 * a contradiction, because a receiver reports "no applications running" both when someone
 * stops playback on the TV *and* when it is doing exactly as we just told it.
 */

let receiver: FakeReceiver;
let sink: ReturnType<typeof createMemorySink>;

beforeEach(async () => {
  receiver = await startFakeReceiver({ durationSec: 90 });
  sink = createMemorySink();
});

afterEach(async () => {
  await receiver.close();
});

interface Ended {
  connection: CastConnection;
  ended: Promise<DisconnectInfo>;
}

async function connect(): Promise<Ended> {
  const client = createCastClient({
    logger: createLogger({ sink, level: 'debug' }),
    transport: tcpTransportFactory,
  });
  let settle: (info: DisconnectInfo) => void = () => undefined;
  const ended = new Promise<DisconnectInfo>((resolve) => {
    settle = resolve;
  });
  const connection = await client.connect(receiver.device, {
    onMediaStatus: (_status: MediaStatus) => undefined,
    onReceiverStatus: () => undefined,
    onDisconnected: (info) => settle(info),
  });
  return { connection, ended };
}

function disconnectRecords(): Record<string, unknown>[] {
  return sink.lines
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((record) => record['event'] === 'cast.disconnected');
}

describe('who ended the session', () => {
  it('never logs an engine-initiated close as device-initiated', async () => {
    const { connection, ended } = await connect();
    await connection.launchDefaultReceiver();
    await connection.load({
      contentUrl: 'http://127.0.0.1:1/m/token/x.mp4',
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      startPositionSec: 0,
      autoplay: true,
    });

    // The TV quits our app but leaves the socket up — so "the device ended it" is armed
    // legitimately. We then close the connection ourselves, and *that* line must not claim
    // the device did it: `closed by engine` and `deviceInitiated: true` are a contradiction.
    receiver.stopFromTv({ closeConnection: false });
    await new Promise((resolve) => setTimeout(resolve, 100));
    await connection.close();

    const info = await ended;
    expect(info.reason).toContain('closed by engine');
    expect(info.deviceInitiated).toBe(false);

    // The cheap invariant, asserted directly: these two can never appear together.
    for (const record of disconnectRecords()) {
      if (String(record['reason']).includes('closed by engine')) {
        expect(record['deviceInitiated']).toBe(false);
      }
    }
  }, 15_000);

  it('does not call our own stop a device decision, though the TV says the same thing', async () => {
    // A receiver answers our STOP with the same empty `applications` list the founder's own
    // Stop produces. Only we know which of us started it.
    const { connection, ended } = await connect();
    await connection.launchDefaultReceiver();
    await connection.load({
      contentUrl: 'http://127.0.0.1:1/m/token/x.mp4',
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      startPositionSec: 0,
      autoplay: true,
    });

    await connection.stop();
    await connection.close();

    expect((await ended).deviceInitiated).toBe(false);
  }, 15_000);

  it('reports a lost socket as lost, even after a pre-launch "nothing is running"', async () => {
    // The sequence that bit us. A receiver status with no applications arrives before our
    // app is launched — ordinary, and it used to latch the flag for the whole session.
    const { connection, ended } = await connect();
    receiver.announceReceiverStatus();
    await new Promise((resolve) => setTimeout(resolve, 50));

    await connection.launchDefaultReceiver();
    await connection.load({
      contentUrl: 'http://127.0.0.1:1/m/token/x.mp4',
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      startPositionSec: 0,
      autoplay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Wifi drops, or the TV is unplugged, mid-film.
    receiver.dropConnections();

    const info = await ended;
    expect(info.deviceInitiated, 'a lost connection must never read as a deliberate end').toBe(
      false,
    );
  }, 15_000);

  it('reports a lost socket as lost, even if a poll mid-film said nothing was running', async () => {
    // **The M5a-shaped version of the test above, and the reason it needed writing.**
    //
    // Its sibling covers a *pre-launch* empty `applications` list, which arrives unsolicited
    // and before there is a film. This is the same flag reached through a different door: a
    // television answering an **explicit `GET_STATUS`** with an empty list **while the film
    // is playing**. Before M5a nothing asked for a receiver status during playback, so that
    // door did not exist. The volume poll now asks once a second — 23c has no other route on
    // any of the founder's three sets — which turns one odd answer into ~7,200 chances a film.
    //
    // What the founder would see if the flag latched: the wifi wobbles, and instead of
    // *Reconnecting*, the app says the television ended the session. The film does not come
    // back on its own. 11a promises the opposite.
    const { connection, ended } = await connect();
    await connection.launchDefaultReceiver();
    await connection.load({
      contentUrl: 'http://127.0.0.1:1/m/token/x.mp4',
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      startPositionSec: 0,
      autoplay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // One answer that forgets what it is running — the film itself is untouched.
    receiver.forgetAppsOnce();
    await connection.getReceiverStatus();
    expect(receiver.launched, 'the film must still be playing — this is a lie, not a stop').toBe(
      true,
    );

    // ...and now the wifi drops, exactly as in the sibling test.
    receiver.dropConnections();

    const info = await ended;
    expect(
      info.deviceInitiated,
      'one odd answer to a poll must not turn a lost socket into "the TV ended it"',
    ).toBe(false);
  }, 15_000);

  it('still reports a stop from the TV itself as device-initiated', async () => {
    // The positive control: the fix must not make everything look like a failure.
    const { connection, ended } = await connect();
    await connection.launchDefaultReceiver();
    await connection.load({
      contentUrl: 'http://127.0.0.1:1/m/token/x.mp4',
      contentType: 'video/mp4',
      streamType: 'BUFFERED',
      startPositionSec: 0,
      autoplay: true,
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    receiver.stopFromTv();

    expect((await ended).deviceInitiated).toBe(true);
  }, 15_000);
});
