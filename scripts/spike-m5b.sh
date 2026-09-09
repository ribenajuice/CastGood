#!/usr/bin/env bash
# SPIKE-4 — M5b step 0, run from WSL against a real television.
#
# ONE QUESTION: does a second LOAD into a session we are already running start the
# next film WITHOUT relaunching the receiver? If it does not, criterion 24m becomes
# "the television returns to its home screen briefly between films" — slower, visibly
# different, and something the founder should see before a queue is built on the
# opposite assumption rather than after.
#
#   scripts/spike-m5b.sh --device "<name>" \
#                        --first  "C:\path\to\one.mp4" \
#                        --second "C:\path\to\two.mp4"
#
#   --device <name>       the television, by the name it shows (required)
#   --address <ip>        skip discovery (e.g. 192.0.2.10)
#   --first <path>        the film that is already playing (required)
#   --second <path>       the film loaded over it (required)
#   --hls-segments <dir>  a directory of .ts segments, published one at a time, to
#                         measure the GROWING-PLAYLIST handover as well
#   --no-sync             skip the mirror to C:\CastGood
#
# ⚠️ WITHOUT --hls-segments THE VERDICT IS `inconclusive`, ON PURPOSE. 24y makes the
# second film a growing playlist whenever its conversion is unfinished, and a receiver
# already playing a film is not a state SPIKE-1 ever handed a playlist to. An MP4-only
# run measures the easy half; reporting the assumption as holding on the strength of it
# is the lying instrument this project keeps finding.
#
# NOBODY NEEDS TO BE IN THE ROOM. Every question here is answered on the wire — the
# transportId, whether a LAUNCH was sent, whether applications went empty, and the gap.
# Unlike SPIKE-5, none of it needs an ear.
#
# EXIT CODES
#   0  the run happened and the report was printed
#   2  the run could not happen — no device, missing file, refused load, wrong OS
# There is no exit 1: a spike has findings, not failures.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

COULD_NOT_RUN=2

log()  { printf '\033[36m[spike-m5b]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[spike-m5b] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() { sed -n '2,54p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

sync=1
json_out=""
saw_device=0
saw_first=0
saw_second=0
passthrough=()

# A WSL path is the natural thing to type here and always wrong: everything runs on the
# Windows side, where /mnt/c/... and /mnt/d/... do not exist.
to_windows() {
  case "$1" in
    /*)
      command -v wslpath >/dev/null 2>&1 || fail "cannot convert '$1' — wslpath is missing"
      wslpath -w "$1" 2>/dev/null || fail "'$1' looks like a WSL path but could not be converted"
      ;;
    *) printf '%s' "$1" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-sync) sync=0; shift ;;
    --json)
      [ $# -ge 2 ] || fail "--json needs a file path"
      json_out="$2"; shift 2 ;;
    --first)
      [ $# -ge 2 ] || fail "--first needs a video file"
      saw_first=1
      passthrough+=("--first" "$(to_windows "$2")"); shift 2 ;;
    --second)
      [ $# -ge 2 ] || fail "--second needs a video file"
      saw_second=1
      passthrough+=("--second" "$(to_windows "$2")"); shift 2 ;;
    --hls-segments)
      [ $# -ge 2 ] || fail "--hls-segments needs a directory of .ts files"
      passthrough+=("--hls-segments" "$(to_windows "$2")"); shift 2 ;;
    --device|--address)
      [ $# -ge 2 ] || fail "$1 needs a value"
      saw_device=1
      passthrough+=("$1" "$2"); shift 2 ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

[ "$saw_device" = "1" ] || fail "--device is required — the name exactly as it appears in Google Home"
[ "$saw_first" = "1" ] || fail "--first is required — the film that is already playing"
[ "$saw_second" = "1" ] || fail "--second is required — the film loaded over it. This measures a HANDOVER; one film measures nothing."

command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."
[ -d /mnt/c ] || fail "/mnt/c is not mounted — this script only makes sense inside WSL2."

if [ "$sync" = "1" ]; then
  "$HERE/win-sync.sh" >&2 || fail "sync failed — fix that before touching a television"
else
  log "--no-sync: running whatever is already in $WIN_DEST"
fi

[ -d "$DEST/node_modules" ] || fail "no node_modules in $DEST. Run: scripts/win-sync.sh"
[ -f "$DEST/scripts/spike-m5b.mjs" ] || fail \
  "the copy in $WIN_DEST has no scripts/spike-m5b.mjs — it is out of date. Run: scripts/win-sync.sh"

# Two rules for every Windows command (CLAUDE.md): never launch cmd.exe from a
# \\wsl.localhost\ path, and work in C:\CastGood.
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

report_file="$(mktemp -t castgood-spike-m5b-XXXXXX.json)"
trap 'rm -f "$report_file"' EXIT

log "running SPIKE-4 on Windows ($WIN_DEST):"
log "  node scripts\\spike-m5b.mjs ${passthrough[*]}"
log "this drives a real television and takes a couple of minutes."
log "close CastGood first — nothing else should be casting while this runs."
log ""
log "LISTEN TO THE ROOM. The spike records levels, echoes and round trips; only your ears"
log "can answer whether the SOUND changed when the number did. It will prompt you."

status=0
( cd "$DEST" && cmd.exe /d /c node scripts\\spike-m5b.mjs "${passthrough[@]}" ) \
  >"$report_file" || status=$?

if [ -n "$json_out" ] && [ -s "$report_file" ]; then
  cp -f "$report_file" "$json_out"
  log "report written to $json_out"
fi

if [ -s "$report_file" ]; then
  cat "$report_file"
else
  log "no JSON report came back on stdout."
fi

case "$status" in
  0) printf '\033[32m[spike-m5b] RECORDED — every leg produced its reading; the engine log has every frame (scripts/win-logs.sh)\033[0m\n' >&2 ;;
  3) printf '\033[33m[spike-m5b] RECORDED, WITH GAPS — see "READINGS THIS RUN DID NOT TAKE" above. Do not quote a number for those legs.\033[0m\n' >&2 ;;
  2) printf '\033[31m[spike-m5b] COULD NOT RUN — nothing was observed\033[0m\n' >&2 ;;
  *) printf '\033[31m[spike-m5b] unexpected exit %s — treat as nothing observed\033[0m\n' "$status" >&2 ;;
esac

exit "$status"
