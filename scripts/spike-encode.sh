#!/usr/bin/env bash
# SPIKE-4 — THROWAWAY. How fast does this PC really convert a film?
#
# Delete this and scripts/spike-encode.mjs once the answer is in config.ts and an ADR.
#
#   scripts/spike-encode.sh --file "C:\path\to\Cars.mp4" \
#                           --file "C:\path\to\Bluey - The Sign.mkv"
#
#   --file FILE     a real film. Give two of different resolutions — that is the whole
#                   point, because encode time is pixel-bound and the current estimate
#                   is not.
#   --seconds N     how much of each to convert (default 60)
#   --keep DIR      leave the outputs somewhere so they can be watched (quality is eyes,
#                   not arithmetic)
#   --no-sync       run whatever is already in C:\CastGood
#   --json FILE     also write the report to FILE on the WSL side
#
# It touches no television and casts nothing. It needs Windows only because that is where
# the founder's ffmpeg and the founder's GPU are.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST=/mnt/c/CastGood
WIN_DEST='C:\CastGood'

log() { printf '\033[36m[spike-encode]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[spike-encode]\033[0m %s\n' "$*" >&2; exit 2; }

sync=1
json_out=""
passthrough=()
while [ $# -gt 0 ]; do
  case "$1" in
    --no-sync) sync=0; shift ;;
    --json) [ $# -ge 2 ] || fail "--json needs a file path"; json_out="$2"; shift 2 ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."

if [ "$sync" = "1" ]; then
  "$HERE/win-sync.sh" >&2 || fail "sync failed"
else
  log "--no-sync: running whatever is already in $WIN_DEST"
fi

[ -f "$DEST/scripts/spike-encode.mjs" ] || fail \
  "the copy in $WIN_DEST has no scripts/spike-encode.mjs — run: scripts/win-sync.sh"
[ -f "$DEST/resources/bin/ffmpeg.exe" ] || fail \
  "no ffmpeg in $WIN_DEST/resources/bin — run: node scripts/fetch-ffmpeg.mjs"

# Two rules for every Windows command (CLAUDE.md): never launch cmd.exe from a
# \\wsl.localhost\ path, and work in C:\CastGood.
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

report_file="$(mktemp -t castgood-spike-encode-XXXXXX.json)"
trap 'rm -f "$report_file"' EXIT

log "measuring on Windows ($WIN_DEST). No television is touched."
log "each encoder converts every film, so this takes a few minutes."

status=0
( cd "$DEST" && cmd.exe /d /c node scripts\\spike-encode.mjs "${passthrough[@]}" ) \
  >"$report_file" || status=$?

if [ -n "$json_out" ] && [ -s "$report_file" ]; then
  cp -f "$report_file" "$json_out"
  log "report written to $json_out"
fi

[ -s "$report_file" ] && cat "$report_file"
exit "$status"
