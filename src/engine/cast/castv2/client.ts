import net from 'node:net';
import tls from 'node:tls';
import { createFrameReader, encodeFrame } from './packet-stream.js';
import { decodeCastMessage, encodeCastMessage, type CastMessage } from './proto.js';

/**
 * The socket half of CASTV2: connect, frame, unframe, close.
 *
 * Nothing here knows what a namespace means — that is `src/engine/cast/index.ts`.
 * What this layer does own is the one fact the rest of the product depends on:
 * **`localAddress`, the IP the OS actually chose to reach this device.** Every media
 * URL we hand a TV is built from it. Enumerating network interfaces and guessing is
 * the single most common failure in this class of app (VPN adapter, second NIC, WSL's
 * vEthernet); asking the live socket is correct by construction.
 *
 * Cast devices present a self-signed certificate, so `rejectUnauthorized` is false.
 * That is not a shortcut: there is no CA to check against, the peer is on the LAN and
 * addressed by IP, and the alternative — refusing to talk to any Chromecast ever made —
 * is not one. Nothing secret travels over this socket.
 */

export interface CastTransport {
  /** The local IP the OS chose for this connection. Goes straight into the media URL. */
  readonly localAddress: string;
  send(message: CastMessage): void;
  close(): void;
  readonly closed: boolean;
}

export interface TransportHandlers {
  onMessage(message: CastMessage): void;
  /** Fires exactly once, for any reason the socket ended: error, FIN, or our own close(). */
  onClose(reason: string): void;
}

export interface TransportOptions {
  readonly host: string;
  readonly port: number;
  readonly timeoutMs: number;
}

export type TransportFactory = (
  options: TransportOptions,
  handlers: TransportHandlers,
) => Promise<CastTransport>;

function wrapSocket(socket: net.Socket, handlers: TransportHandlers): CastTransport {
  const reader = createFrameReader();
  let closed = false;

  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    socket.destroy();
    handlers.onClose(reason);
  };

  socket.on('data', (chunk: Buffer) => {
    let frames: Buffer[];
    try {
      frames = reader.push(chunk);
    } catch (error) {
      finish(`protocol error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    for (const frame of frames) {
      try {
        handlers.onMessage(decodeCastMessage(frame));
      } catch (error) {
        // One undecodable frame is not worth dropping a film for: skip it and carry on.
        // A stream of them will be noticed as missing status, and the heartbeat will act.
        void error;
      }
    }
  });

  socket.on('error', (error: Error) => finish(`socket error: ${error.message}`));
  socket.on('close', () => finish('socket closed'));
  socket.on('end', () => finish('socket ended by peer'));

  return {
    localAddress: socket.localAddress ?? '',
    send(message: CastMessage) {
      if (closed) return;
      socket.write(encodeFrame(encodeCastMessage(message)));
    },
    close() {
      finish('closed locally');
    },
    get closed() {
      return closed;
    },
  };
}

function awaitConnection(
  socket: net.Socket,
  event: 'connect' | 'secureConnect',
  options: TransportOptions,
  handlers: TransportHandlers,
): Promise<CastTransport> {
  return new Promise<CastTransport>((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`timed out connecting to ${options.host}:${options.port}`));
    }, options.timeoutMs);
    timer.unref?.();

    const onError = (error: Error): void => {
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    };

    socket.once('error', onError);
    socket.once(event, () => {
      clearTimeout(timer);
      socket.removeListener('error', onError);
      socket.setNoDelay(true);
      resolve(wrapSocket(socket, handlers));
    });
  });
}

/** The real thing: TLS on port 8009, which is the only transport a Chromecast speaks. */
export const tlsTransportFactory: TransportFactory = (options, handlers) => {
  const socket = tls.connect({
    host: options.host,
    port: options.port,
    rejectUnauthorized: false,
  });
  return awaitConnection(socket, 'secureConnect', options, handlers);
};

/**
 * Plain TCP, for the scripted fake receiver in `test/engine/fake-receiver/`.
 *
 * It exists so the framing, the namespaces and every transport/reconciliation rule can
 * be exercised headlessly in WSL without a private key checked into the repository.
 * It is never used by the app or by the selftest — those always use TLS against a real
 * device, and TLS is the one line of this file that only real hardware can prove.
 */
export const tcpTransportFactory: TransportFactory = (options, handlers) => {
  const socket = net.connect({ host: options.host, port: options.port });
  return awaitConnection(socket, 'connect', options, handlers);
};

export type { CastMessage } from './proto.js';
export { CastProtocolError, decodeCastMessage, encodeCastMessage } from './proto.js';
export { createFrameReader, encodeFrame, MAX_FRAME_BYTES } from './packet-stream.js';
