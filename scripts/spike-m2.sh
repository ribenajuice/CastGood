#!/usr/bin/env bash
# SPIKE-2 — THROWAWAY. Run the M2 hardware spike on Windows from a WSL shell.
#
# Delete this script, scripts/spike-m2.mjs and src/engine/spike/ once M2's session
# supervisor exists. It is not an npm script and not in CI on purpose.
#
# It answers four questions no documentation can, against a real television, before
# any M2 behaviour is designed around a guess (PRD, M2 build order step 1):
#
#   1. socket          our TCP socket dies mid-film — does the TV carry on, can we rejoin
#                      the same media session, is the position right, how long does it take
#   2. takeover        another app takes the TV — what exactly do we receive
#   3. reattach-*      our process exits and a fresh one rejoins the running session
#   4. seek            20-minute seeks in both directions: latency, accuracy, rebuffering
#
#   scripts/spike-m2.sh                             # socket + seek, ~3 minutes, no human
#   scripts/spike-m2.sh --probe seek
#   scripts/spike-m2.sh --probe takeover            # launches YouTube from a second socket
#   scripts/spike-m2.sh --probe takeover --takeover-human   # you cast from your phone
#   scripts/spike-m2.sh --probe reattach-start      # leaves the TV playing, then:
#   scripts/spike-m2.sh --probe reattach-join       # a second process rejoins it
#
# Defaults are none: --address and --file are both required
# file on their desktop. Both can be overridden. Every argument is passed through
# untouched; see `--help` for the full list.
#
#   --no-sync    skip the mirror to C:\CastGood
#   --json FILE  also write the JSON report to FILE on the WSL side
#
# EXIT CODES
#   0  it ran and recorded what it saw
#   2  it could not run
# There is no 1: a spike has findings, not promises. A television doing something we
# did not expect is the whole point.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

DEFAULT_ADDRESS=""
DEFAULT_FILE=""

COULD_NOT_RUN=2

log()  { printf '\033[36m[spike-m2]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[spike-m2] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() { sed -n '2,40p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

sync=1
json_out=""
saw_address=0
saw_file=0
passthrough=()

while [ $# -gt 0 ]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --no-sync) sync=0; shift ;;
    --json)
      [ $# -ge 2 ] || fail "--json needs a file path"
      json_out="$2"; shift 2 ;;
    --address) saw_address=1; passthrough+=("$1"); shift ;;
    --file)
      # A WSL path here is the natural thing to type and always wrong: the spike runs
      # on the Windows side, where /mnt/c/... does not exist.
      [ $# -ge 2 ] || fail "--file needs a path"
      saw_file=1
      file_arg="$2"
      case "$file_arg" in
        /*)
          if command -v wslpath >/dev/null 2>&1 && converted="$(wslpath -w "$file_arg" 2>/dev/null)"; then
            log "translated --file to the Windows path: $converted"
            file_arg="$converted"
          else
            fail "--file looks like a WSL path but could not be converted: $file_arg"
          fi ;;
      esac
      passthrough+=("--file" "$file_arg"); shift 2 ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

# ⚠️ **No default television and no default film.** These used to default to one
# address and one file on the author's own network, which is both a household detail
# in a public repository and a way to cast into somebody else's evening by running a
# script with no arguments. Missing is now a refusal, not a guess.
if [ "$saw_address" != "1" ]; then
  [ -n "$DEFAULT_ADDRESS" ] || fail "--address is required (the television's IP, e.g. 192.0.2.10)"
  passthrough+=("--address" "$DEFAULT_ADDRESS")
fi
if [ "$saw_file" != "1" ]; then
  [ -n "$DEFAULT_FILE" ] || fail "--file is required (a Windows path, e.g. 'C:\\path\\to\\film.mp4')"
  passthrough+=("--file" "$DEFAULT_FILE")
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
[ -f "$DEST/scripts/spike-m2.mjs" ] || fail \
  "the copy in $WIN_DEST has no scripts/spike-m2.mjs — it is out of date. Run: scripts/win-sync.sh"

# Two rules for every Windows command (CLAUDE.md): never launch cmd.exe from a
# \\wsl.localhost\ path, and work in C:\CastGood. Setting the working directory on the
# WSL side gets both, and lets each argument keep its spaces — the same approach
# win-test.sh arrived at, for the same reason (a file name with spaces in it).
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

report_file="$(mktemp -t castgood-spike-XXXXXX.json)"
trap 'rm -f "$report_file"' EXIT

log "running SPIKE-2 on Windows ($WIN_DEST):"
log "  node scripts\\spike-m2.mjs ${passthrough[*]}"
log "this drives a real television. Do not touch the TV unless a probe asks you to."
log "close CastGood first: two media servers fight for port 8010, and the reattach probe"
log "needs the second process to re-publish the *same* URL the TV is already fetching."

status=0
( cd "$DEST" && cmd.exe /d /c node scripts\\spike-m2.mjs "${passthrough[@]}" ) \
  >"$report_file" || status=$?

if [ -n "$json_out" ] && [ -s "$report_file" ]; then
  cp -f "$report_file" "$json_out"
  log "report written to $json_out"
fi

# The readable summary already went to stderr while it ran. What lands on stdout is the
# machine-readable report, printed here so a piped run still produces it.
if [ -s "$report_file" ]; then
  cat "$report_file"
else
  log "no JSON report came back on stdout."
fi

case "$status" in
  0) printf '\033[32m[spike-m2] RECORDED — findings above; the engine log has every frame (scripts/win-logs.sh)\033[0m\n' >&2 ;;
  2) printf '\033[31m[spike-m2] COULD NOT RUN — nothing was observed\033[0m\n' >&2 ;;
  *) printf '\033[31m[spike-m2] unexpected exit %s — treat as nothing observed\033[0m\n' "$status" >&2 ;;
esac

exit "$status"
