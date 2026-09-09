import { CastProtocolError } from './proto.js';

/**
 * CASTV2 framing: every message on the wire is a 4-byte big-endian length followed by
 * that many bytes of `CastMessage` protobuf.
 *
 * TCP gives us a byte stream, not messages, so this reassembles frames across chunk
 * boundaries. It is a pure buffer transform with no socket in it, which is why it can
 * be tested exhaustively — including the split-in-the-middle-of-the-length-prefix case
 * that only shows up on a real network at 2am.
 */

/** A frame this large is not something a Cast device sends; it is a bug or an attack. */
export const MAX_FRAME_BYTES = 1024 * 1024;

export function encodeFrame(payload: Buffer): Buffer {
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export interface FrameReader {
  /** Returns every complete frame made available by this chunk, in order. */
  push(chunk: Buffer): Buffer[];
  /** Bytes held back waiting for the rest of a frame. */
  pendingBytes(): number;
}

export function createFrameReader(): FrameReader {
  // Explicitly `ArrayBufferLike`: chunks off a socket carry that wider type, and the
  // narrower `Buffer<ArrayBuffer>` inferred from `Buffer.alloc` would not accept them.
  let buffered: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  return {
    push(chunk: Buffer): Buffer[] {
      buffered = buffered.length === 0 ? chunk : Buffer.concat([buffered, chunk]);
      const frames: Buffer[] = [];

      for (;;) {
        if (buffered.length < 4) break;
        const length = buffered.readUInt32BE(0);
        if (length > MAX_FRAME_BYTES) {
          throw new CastProtocolError(
            `frame of ${length} bytes exceeds the ${MAX_FRAME_BYTES} byte limit`,
          );
        }
        if (buffered.length < 4 + length) break;
        frames.push(buffered.subarray(4, 4 + length));
        buffered = buffered.subarray(4 + length);
      }

      return frames;
    },
    pendingBytes: () => buffered.length,
  };
}
