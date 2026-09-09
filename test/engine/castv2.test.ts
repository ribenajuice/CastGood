import { describe, expect, it } from 'vitest';
import {
  CastProtocolError,
  decodeCastMessage,
  encodeCastMessage,
} from '../../src/engine/cast/castv2/proto.js';
import {
  createFrameReader,
  encodeFrame,
  MAX_FRAME_BYTES,
} from '../../src/engine/cast/castv2/packet-stream.js';

/**
 * The protocol layer is the one part of the product where "it looked right" is not
 * available: a byte wrong here is a TV that ignores us with no error anywhere. So the
 * codec is tested against its own inverse, against hostile input, and against the
 * chunk boundaries a real socket produces.
 */

const message = {
  sourceId: 'sender-0',
  destinationId: 'receiver-0',
  namespace: 'urn:x-cast:com.google.cast.receiver',
  data: JSON.stringify({ type: 'LAUNCH', appId: 'CC1AD845', requestId: 1 }),
};

describe('CastMessage codec', () => {
  it('round-trips a message', () => {
    expect(decodeCastMessage(encodeCastMessage(message))).toEqual(message);
  });

  it('round-trips non-ASCII payloads (a TV called "Family room TV — Küche")', () => {
    const unicode = { ...message, data: JSON.stringify({ name: 'Küche — 家' }) };
    expect(decodeCastMessage(encodeCastMessage(unicode))).toEqual(unicode);
  });

  it('encodes the field order and tags the protocol specifies', () => {
    const encoded = encodeCastMessage(message);
    // field 1 (protocol_version) as a varint, then field 2 (source_id) length-delimited.
    expect(encoded[0]).toBe(0x08);
    expect(encoded[1]).toBe(0x00);
    expect(encoded[2]).toBe(0x12);
  });

  it('skips unknown fields rather than failing', () => {
    // A field 9 varint that no version of the message we know about defines.
    const withUnknown = Buffer.concat([encodeCastMessage(message), Buffer.from([0x48, 0x2a])]);
    expect(decodeCastMessage(withUnknown)).toEqual(message);
  });

  it('rejects a message missing a required field', () => {
    expect(() => decodeCastMessage(Buffer.from([0x08, 0x00]))).toThrow(CastProtocolError);
  });

  it('rejects a truncated length-delimited field instead of reading past the buffer', () => {
    const encoded = encodeCastMessage(message);
    expect(() => decodeCastMessage(encoded.subarray(0, encoded.length - 5))).toThrow(
      CastProtocolError,
    );
  });
});

describe('frame reader', () => {
  it('reassembles a frame split across chunks, including inside the length prefix', () => {
    const reader = createFrameReader();
    const frame = encodeFrame(encodeCastMessage(message));

    expect(reader.push(frame.subarray(0, 2))).toEqual([]);
    expect(reader.push(frame.subarray(2, 6))).toEqual([]);
    const frames = reader.push(frame.subarray(6));
    expect(frames).toHaveLength(1);
    expect(decodeCastMessage(frames[0] as Buffer)).toEqual(message);
    expect(reader.pendingBytes()).toBe(0);
  });

  it('returns several frames arriving in one chunk, in order', () => {
    const reader = createFrameReader();
    const first = encodeFrame(encodeCastMessage({ ...message, data: 'one' }));
    const second = encodeFrame(encodeCastMessage({ ...message, data: 'two' }));
    const frames = reader.push(Buffer.concat([first, second]));
    expect(frames.map((frame) => decodeCastMessage(frame).data)).toEqual(['one', 'two']);
  });

  it('refuses an absurd frame length instead of allocating for it', () => {
    const reader = createFrameReader();
    const header = Buffer.alloc(4);
    header.writeUInt32BE(MAX_FRAME_BYTES + 1, 0);
    expect(() => reader.push(header)).toThrow(CastProtocolError);
  });
});
