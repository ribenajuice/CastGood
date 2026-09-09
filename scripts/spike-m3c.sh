#!/usr/bin/env bash
# SPIKE-3 — THROWAWAY. Can a television be given subtitles, and can they be CHANGED mid-film?
#
# Delete this script, scripts/spike-m3c.mjs and src/engine/spike/m3c*.ts once M3c's subtitle
# pipeline exists. It is not an npm script and not in CI on purpose.
#
# M3c's build order puts this at step 0, before any feature code, because five assumptions
# decide the shape of the milestone and not one of them is knowable from documentation. The
# fifth is founder-visible: if a text track can be swapped for a differently-timed one
# mid-film, story 20's timing control is NUDGE BUTTONS. If it cannot, it is SET-THEN-APPLY.
#
#   scripts/spike-m3c.sh --file "D:\Movies\Something (CastGood).mp4"        # a television that must convert it
#   scripts/spike-m3c.sh --file "..." --address 192.0.2.10                   # a Chromecast Ultra
#
#   --file PATH          a film this television plays NATIVELY (required). The film is only
#                        a carrier — the track is what is under test — so pass something
#                        that needs no conversion. A prepared "(CastGood).mp4" is ideal.
#   --address IP         the television (required)
#   --settle MS          how long the film runs before the first toggle (default 8000)
#   --no-sync            skip the mirror to C:\CastGood
#   --json FILE          also write the JSON report to FILE on the WSL side
#
# The two WebVTT tracks are written by the spike into a temp folder. There is no fixture to
# make, and nothing of the founder's is read or written.
#
# **WATCH THE TELEVISION WHILE IT RUNS.** This spike can see fetches, states and timings;
# only a person can see whether the WORDS appeared, which track they came from, and whether
# they were in sync. Cue one of each track names itself — "TRACK A" or "TRACK B".
#
# EXIT CODES
#   0  it ran and recorded what it saw
#   2  it could not run
# There is no 1: a spike has findings, not promises.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

DEFAULT_ADDRESS=""

COULD_NOT_RUN=2

log()  { printf '\033[36m[spike-m3c]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[spike-m3c] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() { sed -n '2,33p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

sync=1
json_out=""
saw_address=0
saw_file=0
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
    --file)
      [ $# -ge 2 ] || fail "--file needs a video file"
      saw_file=1
      passthrough+=("--file" "$(to_windows "$2")"); shift 2 ;;
    --address) saw_address=1; passthrough+=("$1"); shift ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

[ "$saw_file" = "1" ] || fail "--file is required — pass a film this television plays natively"
if [ "$saw_address" != "1" ]; then
  [ -n "$DEFAULT_ADDRESS" ] || fail "--address is required (the television's IP, e.g. 192.0.2.10)"
  passthrough+=("--address" "$DEFAULT_ADDRESS")
fi

command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."
[ -d /mnt/c ] || fail "/mnt/c is not mounted — this script only makes sense inside WSL2."

if [ "$sync" = "1" ]; then
  "$HERE/win-sync.sh" >&2 || fail "sync failed — fix that before touching a television"
else
  log "--no-sync: running whatever is already in $WIN_DEST"
fi

[ -d "$DEST/node_modules" ] || fail "no node_modules in $DEST. Run: scripts/win-sync.sh"
[ -f "$DEST/scripts/spike-m3c.mjs" ] || fail \
  "the copy in $WIN_DEST has no scripts/spike-m3c.mjs — it is out of date. Run: scripts/win-sync.sh"

# Two rules for every Windows command (CLAUDE.md): never launch cmd.exe from a
# \\wsl.localhost\ path, and work in C:\CastGood.
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

report_file="$(mktemp -t castgood-spike-m3c-XXXXXX.json)"
trap 'rm -f "$report_file"' EXIT

log "running SPIKE-3 on Windows ($WIN_DEST):"
log "  node scripts\\spike-m3c.mjs ${passthrough[*]}"
log "this drives a real television and takes a couple of minutes."
log "close CastGood first — nothing else should be casting while this runs."
log ""
log "WATCH THE SCREEN. The spike records fetches and states; only you can see the WORDS."
log "  Cue one of each track names itself: TRACK A, or TRACK B six seconds later."

status=0
( cd "$DEST" && cmd.exe /d /c node scripts\\spike-m3c.mjs "${passthrough[@]}" ) \
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
  0) printf '\033[32m[spike-m3c] RECORDED — findings above; the engine log has every frame (scripts/win-logs.sh)\033[0m\n' >&2 ;;
  2) printf '\033[31m[spike-m3c] COULD NOT RUN — nothing was observed\033[0m\n' >&2 ;;
  *) printf '\033[31m[spike-m3c] unexpected exit %s — treat as nothing observed\033[0m\n' "$status" >&2 ;;
esac

exit "$status"
