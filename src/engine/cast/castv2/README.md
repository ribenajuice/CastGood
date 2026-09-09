# `castv2` — the CASTV2 protocol layer

The **low-level Cast protocol**: TLS socket, length-prefixed framing, the `CastMessage`
protobuf. No namespace in here knows what a receiver or a media session is — that is
`src/engine/cast/index.ts`.

## What landed in M1 (and how it differs from the plan)

| File | What it is |
|---|---|
| `proto.ts` | `CastMessage` encode/decode, hand-written. Seven scalar fields, ~140 lines. |
| `packet-stream.ts` | 4-byte big-endian length prefix; reassembles frames across chunk boundaries. |
| `client.ts` | TLS connect (`rejectUnauthorized: false`), `localAddress`, send/receive, close. |

Two deliberate differences from the ADR's sketch:

1. **Reimplemented from the wire format, not copied from upstream.** `thibauts/node-castv2`
   (MIT) was read as a reference, but nothing was vendored verbatim: the parts we need are
   one protobuf message and a length prefix, and a hand-written version we fully understand
   is smaller than the vendored one plus its `protobufjs` dependency. There is therefore no
   upstream commit to record — the specification is the wire format itself, which has not
   changed since 2013.
2. **PING/PONG lives one layer up**, in `cast/index.ts`, because the heartbeat is a message
   on the `tp.heartbeat` namespace and needs the clock and logger that the connection owns.
   This file stays free of anything that has an opinion about time.

## Why not the npm package

Verified on npm on 2026-08-13:

| Package | Latest | Last published | Verdict |
|---|---|---|---|
| `castv2` | 0.1.10 | 2022-06-13 | Frame codec is finished, not abandoned. Reference, not dependency. |
| `castv2-client` | — | 2021 | **Do not use.** Abandoned wrapper; its session abstraction hides exactly the reconnect behaviour we must control. |
| `bonjour-service` | 1.4.4 | 2026-07-28 | Actively maintained. Used as a normal dependency for discovery. |

CASTV2 is a frozen protocol — `pychromecast`, the actively maintained Python reference
behind Home Assistant, has made no protocol-level changes in a year. A 2022 publish date
means "finished", not "broken". But a dependency we cannot patch the same day is a risk to
the north star, and this is a few hundred lines we can own.

## Tests

`test/engine/castv2.test.ts` covers the codec and the framing directly — round trips,
non-ASCII payloads, unknown fields, truncated buffers, splits inside the length prefix, and
an absurd frame length. `test/engine/cast-session.test.ts` drives this code over a real
socket against `test/engine/fake-receiver/`.

**TLS itself is the one thing no headless test covers.** The fake receiver speaks plain TCP
so that no private key has to live in this repository; the transport is swapped by
injection (`tcpTransportFactory` vs `tlsTransportFactory`) and nothing above it changes.
TLS against a self-signed device certificate is proved only by the selftest on real
hardware.

Behavioural reference when the protocol is ambiguous:
<https://github.com/home-assistant-libs/pychromecast>.
Wire-format reference: <https://github.com/thibauts/node-castv2> (MIT).
