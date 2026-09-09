/**
 * **The run that stalled** — the recorded evidence criterion 10j calibrates the stall
 * detector against, and the only trace in this repository of a real television failing the
 * way story 10 exists to prevent.
 *
 * Extracted verbatim from `%LOCALAPPDATA%\\CastGood\\logs\\engine-2026-08-20.jsonl`, the
 * `--rate 0.7` run against the `AI PONT` that started at 2026-08-20T14:44:01Z — 00:14 on
 * 2026-08-21 in the founder's own timezone, which is the date STATUS records it under. The
 * conversion published at 0.7× playback from a 29.5-second head start, so the frontier
 * closed on the playhead instead of fleeing it: **deliberately outside the head-start gate
 * on both counts**, which is why this run validates the gate rather than threatening the
 * feature.
 *
 * Each sample is one `MEDIA_STATUS` as it arrived off the socket: the device's own
 * `currentTime`, the device's own `playerState`, and the monotonic millisecond it landed.
 * Nothing here is our extrapolation, our guard's opinion, or the spike's summary — that
 * summary said *"confirmed"* twice about this very run.
 *
 * `commands` are the things the spike pressed, so a freeze that a pause or a seek caused is
 * not counted as a stall — the same exclusion the `headstart` scenario applies to a live run.
 *
 * **On this trace the exclusions change nothing, and saying otherwise was an overstatement.**
 * All five commands land at 316–342 s, after the last stall at 199.9 s, so the detector
 * reports 6 stalls / 66.8 s / 25.6 s with them and without them (QA, 2026-08-21). They are
 * kept because a live run's commands land wherever the founder puts them and the fixture
 * should be read the way a run is; the case that actually exercises the exclusion is the
 * scripted one in `stall-detector.test.ts` — *"does not count a picture that was paused,
 * sought or stopped on purpose"* — where removing it turns a clean run into a stall.
 *
 * **Do not regenerate this file.** It is evidence.
 */
export const STARVED_RUN = {
  samples: [
    {
      monoMs: 7930,
      positionSec: 0,
      playerState: 'IDLE',
    },
    {
      monoMs: 8517,
      positionSec: 0,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 8574,
      positionSec: 0,
      playerState: 'PLAYING',
    },
    {
      monoMs: 9046,
      positionSec: 0,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 10271,
      positionSec: 0.065,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 10337,
      positionSec: 0.285,
      playerState: 'PLAYING',
    },
    {
      monoMs: 11969,
      positionSec: 1.628,
      playerState: 'PLAYING',
    },
    {
      monoMs: 12018,
      positionSec: 1.67,
      playerState: 'PLAYING',
    },
    {
      monoMs: 17129,
      positionSec: 6.793,
      playerState: 'PLAYING',
    },
    {
      monoMs: 22245,
      positionSec: 11.91,
      playerState: 'PLAYING',
    },
    {
      monoMs: 27366,
      positionSec: 17.028,
      playerState: 'PLAYING',
    },
    {
      monoMs: 32484,
      positionSec: 22.148,
      playerState: 'PLAYING',
    },
    {
      monoMs: 37610,
      positionSec: 27.269,
      playerState: 'PLAYING',
    },
    {
      monoMs: 42727,
      positionSec: 32.389,
      playerState: 'PLAYING',
    },
    {
      monoMs: 47759,
      positionSec: 37.422,
      playerState: 'PLAYING',
    },
    {
      monoMs: 52868,
      positionSec: 42.527,
      playerState: 'PLAYING',
    },
    {
      monoMs: 57932,
      positionSec: 47.598,
      playerState: 'PLAYING',
    },
    {
      monoMs: 63000,
      positionSec: 52.664,
      playerState: 'PLAYING',
    },
    {
      monoMs: 68040,
      positionSec: 57.703,
      playerState: 'PLAYING',
    },
    {
      monoMs: 72219,
      positionSec: 61.304,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 73067,
      positionSec: 61.304,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 74186,
      positionSec: 61.78,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 74231,
      positionSec: 61.782,
      playerState: 'PLAYING',
    },
    {
      monoMs: 78158,
      positionSec: 65.203,
      playerState: 'PLAYING',
    },
    {
      monoMs: 83275,
      positionSec: 70.323,
      playerState: 'PLAYING',
    },
    {
      monoMs: 84222,
      positionSec: 70.797,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 88397,
      positionSec: 70.797,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 93515,
      positionSec: 70.797,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 98551,
      positionSec: 70.797,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 100454,
      positionSec: 71.168,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 100721,
      positionSec: 71.2,
      playerState: 'PLAYING',
    },
    {
      monoMs: 103658,
      positionSec: 73.812,
      playerState: 'PLAYING',
    },
    {
      monoMs: 108779,
      positionSec: 78.932,
      playerState: 'PLAYING',
    },
    {
      monoMs: 113888,
      positionSec: 84.05,
      playerState: 'PLAYING',
    },
    {
      monoMs: 118933,
      positionSec: 89.081,
      playerState: 'PLAYING',
    },
    {
      monoMs: 123973,
      positionSec: 94.132,
      playerState: 'PLAYING',
    },
    {
      monoMs: 126260,
      positionSec: 95.716,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 126719,
      positionSec: 96.159,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 126879,
      positionSec: 96.164,
      playerState: 'PLAYING',
    },
    {
      monoMs: 129010,
      positionSec: 97.908,
      playerState: 'PLAYING',
    },
    {
      monoMs: 134066,
      positionSec: 102.971,
      playerState: 'PLAYING',
    },
    {
      monoMs: 139005,
      positionSec: 107.229,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 139083,
      positionSec: 107.229,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 139879,
      positionSec: 107.698,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 139961,
      positionSec: 107.701,
      playerState: 'PLAYING',
    },
    {
      monoMs: 144210,
      positionSec: 111.483,
      playerState: 'PLAYING',
    },
    {
      monoMs: 149250,
      positionSec: 116.518,
      playerState: 'PLAYING',
    },
    {
      monoMs: 150437,
      positionSec: 117.209,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 152541,
      positionSec: 117.781,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 152990,
      positionSec: 117.973,
      playerState: 'PLAYING',
    },
    {
      monoMs: 154275,
      positionSec: 118.975,
      playerState: 'PLAYING',
    },
    {
      monoMs: 159302,
      positionSec: 124.008,
      playerState: 'PLAYING',
    },
    {
      monoMs: 160090,
      positionSec: 124.119,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 164379,
      positionSec: 124.119,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 165655,
      positionSec: 124.693,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 166006,
      positionSec: 124.765,
      playerState: 'PLAYING',
    },
    {
      monoMs: 169406,
      positionSec: 127.863,
      playerState: 'PLAYING',
    },
    {
      monoMs: 174516,
      positionSec: 132.975,
      playerState: 'PLAYING',
    },
    {
      monoMs: 176052,
      positionSec: 133.714,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 179636,
      positionSec: 133.714,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 184767,
      positionSec: 133.714,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 189978,
      positionSec: 133.714,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 192010,
      positionSec: 134.123,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 192147,
      positionSec: 134.123,
      playerState: 'PLAYING',
    },
    {
      monoMs: 195000,
      positionSec: 136.605,
      playerState: 'PLAYING',
    },
    {
      monoMs: 200049,
      positionSec: 141.65,
      playerState: 'PLAYING',
    },
    {
      monoMs: 205082,
      positionSec: 146.686,
      playerState: 'PLAYING',
    },
    {
      monoMs: 210150,
      positionSec: 151.755,
      playerState: 'PLAYING',
    },
    {
      monoMs: 215283,
      positionSec: 156.882,
      playerState: 'PLAYING',
    },
    {
      monoMs: 220392,
      positionSec: 161.996,
      playerState: 'PLAYING',
    },
    {
      monoMs: 225516,
      positionSec: 167.116,
      playerState: 'PLAYING',
    },
    {
      monoMs: 226622,
      positionSec: 167.576,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 230548,
      positionSec: 167.576,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 231481,
      positionSec: 168.046,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 231648,
      positionSec: 168.063,
      playerState: 'PLAYING',
    },
    {
      monoMs: 235580,
      positionSec: 171.605,
      playerState: 'PLAYING',
    },
    {
      monoMs: 240609,
      positionSec: 176.634,
      playerState: 'PLAYING',
    },
    {
      monoMs: 245642,
      positionSec: 181.671,
      playerState: 'PLAYING',
    },
    {
      monoMs: 250670,
      positionSec: 186.693,
      playerState: 'PLAYING',
    },
    {
      monoMs: 251673,
      positionSec: 187.276,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 255696,
      positionSec: 187.276,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 257441,
      positionSec: 187.819,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 257684,
      positionSec: 187.854,
      playerState: 'PLAYING',
    },
    {
      monoMs: 260730,
      positionSec: 190.567,
      playerState: 'PLAYING',
    },
    {
      monoMs: 265750,
      positionSec: 195.588,
      playerState: 'PLAYING',
    },
    {
      monoMs: 270706,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 270784,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 275895,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 281012,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 286127,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 291259,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 296286,
      positionSec: 199.92,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 296819,
      positionSec: 200.411,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 297367,
      positionSec: 200.613,
      playerState: 'PLAYING',
    },
    {
      monoMs: 301389,
      positionSec: 204.436,
      playerState: 'PLAYING',
    },
    {
      monoMs: 306511,
      positionSec: 209.555,
      playerState: 'PLAYING',
    },
    {
      monoMs: 311625,
      positionSec: 214.674,
      playerState: 'PLAYING',
    },
    {
      monoMs: 316773,
      positionSec: 219.812,
      playerState: 'PAUSED',
    },
    {
      monoMs: 319819,
      positionSec: 219.812,
      playerState: 'PAUSED',
    },
    {
      monoMs: 319893,
      positionSec: 220.377,
      playerState: 'PLAYING',
    },
    {
      monoMs: 319919,
      positionSec: 220.391,
      playerState: 'PLAYING',
    },
    {
      monoMs: 323004,
      positionSec: 222.947,
      playerState: 'PLAYING',
    },
    {
      monoMs: 323115,
      positionSec: 192.947,
      playerState: 'PLAYING',
    },
    {
      monoMs: 323593,
      positionSec: 192.947,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 324088,
      positionSec: 192.947,
      playerState: 'BUFFERING',
    },
    {
      monoMs: 324615,
      positionSec: 193.395,
      playerState: 'PLAYING',
    },
    {
      monoMs: 328216,
      positionSec: 196.569,
      playerState: 'PLAYING',
    },
    {
      monoMs: 328277,
      positionSec: 200.364,
      playerState: 'PLAYING',
    },
    {
      monoMs: 336417,
      positionSec: 207.671,
      playerState: 'PLAYING',
    },
    {
      monoMs: 342561,
      positionSec: 213.814,
      playerState: 'PLAYING',
    },
  ],
  commands: [
    {
      monoMs: 316635,
      type: 'PAUSE',
    },
    {
      monoMs: 319819,
      type: 'PLAY',
    },
    {
      monoMs: 323005,
      type: 'SEEK',
    },
    {
      monoMs: 328217,
      type: 'SEEK',
    },
    {
      monoMs: 342561,
      type: 'STOP',
    },
  ],
} as const;
