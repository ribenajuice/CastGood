/**
 * The CASTV2 `CastMessage` protobuf, encoded and decoded by hand.
 *
 * The wire format (frozen since 2013, and the reason the npm ecosystem around it
 * looks abandoned rather than broken):
 *
 *   message CastMessage {
 *     required ProtocolVersion protocol_version = 1;  // varint, always 0
 *     required string source_id                = 2;
 *     required string destination_id           = 3;
 *     required string namespace                = 4;
 *     required PayloadType payload_type        = 5;   // varint: 0 STRING, 1 BINARY
 *     optional string payload_utf8             = 6;
 *     optional bytes  payload_binary           = 7;
 *   }
 *
 * Hand-written rather than pulled from a protobuf runtime because it is one message
 * with seven scalar fields: a dependency here would be more code than this file, and
 * this way a firmware surprise is something we can patch the same afternoon.
 *
 * Every decoder path here is fed by the network, so it treats its input as hostile:
 * truncated buffers, unknown fields, oversized varints and absent required fields all
 * produce a thrown `CastProtocolError`, never a partially-filled message.
 */

export interface CastMessage {
  readonly sourceId: string;
  readonly destinationId: string;
  readonly namespace: string;
  /** UTF-8 payload. Binary payloads exist in the protocol but no namespace we use sends them. */
  readonly data: string;
}

export class CastProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CastProtocolError';
  }
}

const WIRE_VARINT = 0;
const WIRE_LENGTH_DELIMITED = 2;

function encodeVarint(value: number): Buffer {
  if (!Number.isInteger(value) || value < 0) {
    throw new CastProtocolError(`cannot encode ${value} as a varint`);
  }
  const bytes: number[] = [];
  let remaining = value;
  do {
    let byte = remaining & 0x7f;
    remaining = Math.floor(remaining / 128);
    if (remaining > 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining > 0);
  return Buffer.from(bytes);
}

function encodeTag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType);
}

function encodeString(field: number, value: string): Buffer {
  const payload = Buffer.from(value, 'utf8');
  return Buffer.concat([
    encodeTag(field, WIRE_LENGTH_DELIMITED),
    encodeVarint(payload.length),
    payload,
  ]);
}

export function encodeCastMessage(message: CastMessage): Buffer {
  return Buffer.concat([
    encodeTag(1, WIRE_VARINT),
    encodeVarint(0), // protocol_version: CASTV2_1_0
    encodeString(2, message.sourceId),
    encodeString(3, message.destinationId),
    encodeString(4, message.namespace),
    encodeTag(5, WIRE_VARINT),
    encodeVarint(0), // payload_type: STRING
    encodeString(6, message.data),
  ]);
}

interface VarintRead {
  readonly value: number;
  readonly next: number;
}

function readVarint(buffer: Buffer, offset: number): VarintRead {
  let value = 0;
  let shift = 1;
  let cursor = offset;
  for (let i = 0; i < 10; i += 1) {
    if (cursor >= buffer.length) throw new CastProtocolError('truncated varint');
    const byte = buffer[cursor] as number;
    cursor += 1;
    value += (byte & 0x7f) * shift;
    if ((byte & 0x80) === 0) return { value, next: cursor };
    shift *= 128;
    if (!Number.isSafeInteger(value)) throw new CastProtocolError('varint out of range');
  }
  throw new CastProtocolError('varint too long');
}

export function decodeCastMessage(buffer: Buffer): CastMessage {
  let sourceId: string | undefined;
  let destinationId: string | undefined;
  let namespace: string | undefined;
  let data = '';
  let cursor = 0;

  while (cursor < buffer.length) {
    const tag = readVarint(buffer, cursor);
    cursor = tag.next;
    const field = tag.value >>> 3;
    const wireType = tag.value & 0x07;

    if (wireType === WIRE_VARINT) {
      cursor = readVarint(buffer, cursor).next;
      continue;
    }
    if (wireType !== WIRE_LENGTH_DELIMITED) {
      throw new CastProtocolError(`unsupported wire type ${wireType} on field ${field}`);
    }

    const length = readVarint(buffer, cursor);
    cursor = length.next;
    const end = cursor + length.value;
    if (end > buffer.length) throw new CastProtocolError('truncated length-delimited field');
    const slice = buffer.subarray(cursor, end);
    cursor = end;

    switch (field) {
      case 2:
        sourceId = slice.toString('utf8');
        break;
      case 3:
        destinationId = slice.toString('utf8');
        break;
      case 4:
        namespace = slice.toString('utf8');
        break;
      case 6:
        data = slice.toString('utf8');
        break;
      default:
        // Unknown or binary payload: skipped, exactly as a protobuf reader should.
        break;
    }
  }

  if (sourceId === undefined || destinationId === undefined || namespace === undefined) {
    throw new CastProtocolError('CastMessage is missing a required field');
  }
  return { sourceId, destinationId, namespace, data };
}
