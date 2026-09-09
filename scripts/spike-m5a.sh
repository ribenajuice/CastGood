#!/usr/bin/env bash
# SPIKE-5 — THROWAWAY. Whose volume is it, and does the television actually move it?
#
# Delete this script, scripts/spike-m5a.mjs and src/engine/spike/m5a*.ts once M5a's volume
# control is built. It is not an npm script and not in CI on purpose.
#
# M5a's build order puts this at step 0, before any feature code, because story 23's premise
# — "volume is native to the Cast protocol" — is true of the PROTOCOL and not necessarily of
# a TELEVISION. The founder's main set is an AI PONT with Cast built in, which may route
# volume through its own amplifier or HDMI-CEC, and may refuse, clamp or quantise us. A
# control that is dead on their main television is a different product from story 23's.
#
#   scripts/spike-m5a.sh --device "<device name>" --file "D:\Movies\Something.mp4"
#   scripts/spike-m5a.sh --device "<device name>" --file "..." --remote-wait 0
#
#   --device NAME        the television, exactly as named in Google Home (required)
#   --file PATH          a film this set plays NATIVELY (required — question 2 is answered
#                        by an ear, and an ear needs sound)
#   --max-level 0..1     nothing louder than this is ever asked for (default 0.5)
#   --upper-clamp        also ask for 1.5. ⚠️ CAN SET THE ROOM TO MAXIMUM. Off by default.
#   --remote-wait MS     how long to wait for a person with the set's own remote
#                        (default 45000; 0 skips that leg and the report says so)
#   --external-wait MS   how long to listen, without polling, for a second connection
#   --settle MS          how long the film plays before anything is touched
#   --leg NAME           repeatable: volume-object, set-level, stream-volume, external,
#                        remote, mute (default: all)
#   --no-sync            skip the mirror to C:\CastGood
#   --json FILE          also write the JSON report to FILE on the WSL side
#
# **BE IN THE ROOM.** Two of the six questions cannot be answered by any instrument here:
# whether the SOUND changed when the number did, and which volume the set's OWN REMOTE
# moves. The spike prompts you when it needs you.
#
# ⚠️ THE PROMPTS GO TO THIS RUN'S STDERR, WHICH IS NOT NECESSARILY WHERE THE PERSON IS
# LOOKING. On 2026-09-07 that cost a wrong finding: nobody saw "pick up the remote", the
# leg read no change, the leg was marked `unmeasured` and exit 3 was returned — and the
# unmeasured leg was written up as a finding anyway ("this set's remote is invisible to
# Cast"), narrowing an approved criterion before a read of the receiver disproved it an
# hour later. If you are running this on somebody else's behalf, TELL THEM THE TIMING
# BEFORE YOU START, and never convert a leg the report calls `unmeasured` into a fact
# because a person said something adjacent to it afterwards.
#
# ⚠️ IT PUTS THE LEVEL AND THE MUTE BACK on every exit path, Ctrl-C included. A volume is
# the founder's television: it is permanent and it outlives CastGood. If the summary says
# the restore was NOT CONFIRMED, check that television by hand.
#
# EXIT CODES
#   0  every leg asked for produced its reading
#   2  it could not run — nothing was observed
#   3  it ran, but a leg could not be measured. A set that refuses a volume lands here:
#      that is a real finding about the television, not a broken run.
# There is no 1: a spike has findings, not promises.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

COULD_NOT_RUN=2

log()  { printf '\033[36m[spike-m5a]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[spike-m5a] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() { sed -n '2,54p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

sync=1
json_out=""
saw_device=0
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
    --device|--address)
      [ $# -ge 2 ] || fail "$1 needs a value"
      saw_device=1
      passthrough+=("$1" "$2"); shift 2 ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

[ "$saw_device" = "1" ] || fail "--device is required — the name exactly as it appears in Google Home"
[ "$saw_file" = "1" ] || fail "--file is required — pass a film this television plays natively"

command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."
[ -d /mnt/c ] || fail "/mnt/c is not mounted — this script only makes sense inside WSL2."

if [ "$sync" = "1" ]; then
  "$HERE/win-sync.sh" >&2 || fail "sync failed — fix that before touching a television"
else
  log "--no-sync: running whatever is already in $WIN_DEST"
fi

[ -d "$DEST/node_modules" ] || fail "no node_modules in $DEST. Run: scripts/win-sync.sh"
[ -f "$DEST/scripts/spike-m5a.mjs" ] || fail \
  "the copy in $WIN_DEST has no scripts/spike-m5a.mjs — it is out of date. Run: scripts/win-sync.sh"

# Two rules for every Windows command (CLAUDE.md): never launch cmd.exe from a
# \\wsl.localhost\ path, and work in C:\CastGood.
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

report_file="$(mktemp -t castgood-spike-m5a-XXXXXX.json)"
trap 'rm -f "$report_file"' EXIT

log "running SPIKE-5 on Windows ($WIN_DEST):"
log "  node scripts\\spike-m5a.mjs ${passthrough[*]}"
log "this drives a real television and takes a couple of minutes."
log "close CastGood first — nothing else should be casting while this runs."
log ""
log "LISTEN TO THE ROOM. The spike records levels, echoes and round trips; only your ears"
log "can answer whether the SOUND changed when the number did. It will prompt you."

status=0
( cd "$DEST" && cmd.exe /d /c node scripts\\spike-m5a.mjs "${passthrough[@]}" ) \
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
  0) printf '\033[32m[spike-m5a] RECORDED — every leg produced its reading; the engine log has every frame (scripts/win-logs.sh)\033[0m\n' >&2 ;;
  3) printf '\033[33m[spike-m5a] RECORDED, WITH GAPS — see "READINGS THIS RUN DID NOT TAKE" above. Do not quote a number for those legs.\033[0m\n' >&2 ;;
  2) printf '\033[31m[spike-m5a] COULD NOT RUN — nothing was observed\033[0m\n' >&2 ;;
  *) printf '\033[31m[spike-m5a] unexpected exit %s — treat as nothing observed\033[0m\n' "$status" >&2 ;;
esac

exit "$status"
