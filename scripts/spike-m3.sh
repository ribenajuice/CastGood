#!/usr/bin/env bash
# SPIKE-1 — THROWAWAY. Does a real television play a film that is still being converted?
#
# Delete this script, scripts/spike-m3.mjs and src/engine/spike/ once M3's preparation
# pipeline exists. It is not an npm script and not in CI on purpose.
#
# It answers the riskiest question in the product, and the only one still resting on a
# document rather than on a television. PRD story 10 says a converting film can be watched
# now; the 2026-08-13 ADR says how (a growing HLS EVENT playlist) and admits in as many
# words that it is "confirmed by documentation, not by observation". The documentation is
# Google's, about Google's receiver — and the founder's main TV reports as `AI PONT`.
#
#   scripts/spike-m3.sh --fixture-make "C:\path\to\Cars.mp4"   # once, ~1 min
#   scripts/spike-m3.sh                                                      # then run it
#   scripts/spike-m3.sh --address 192.0.2.10                                  # a Chromecast Ultra
#   scripts/spike-m3.sh --rate 0.7                                           # starve it
#
#   --fixture-make FILE  chop FILE into HLS segments with ffmpeg, once, and exit.
#                        Installs ffmpeg via winget if it is not already there.
#   --fixture DIR        where the segments live (default C:\CastGood\.fixture)
#   --address IP         the television (required)
#   --head-start N       segments published before the TV is told anything (default 3)
#   --rate N             conversion speed vs playback. 1.5 = comfortably ahead;
#                        below 1.0 the frontier creeps toward the playhead, which is the
#                        case the PRD's 2-minute margin exists for.
#   --watch MS           how long to watch before writing ENDLIST (default 300000)
#   --no-sync            skip the mirror to C:\CastGood
#   --json FILE          also write the JSON report to FILE on the WSL side
#
# EXIT CODES
#   0  it ran and recorded what it saw
#   2  it could not run
# There is no 1: a spike has findings, not promises. A television doing something we did
# not expect is the whole point.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${CASTGOOD_WIN_DIR:-/mnt/c/CastGood}"
WIN_DEST="${CASTGOOD_WIN_PATH:-C:\\CastGood}"

DEFAULT_ADDRESS=""
DEFAULT_FIXTURE="$WIN_DEST\\.fixture"

COULD_NOT_RUN=2

log()  { printf '\033[36m[spike-m3]\033[0m %s\n' "$*" >&2; }
fail() { printf '\033[31m[spike-m3] %s\033[0m\n' "$*" >&2; exit "$COULD_NOT_RUN"; }

usage() { sed -n '2,34p' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//' >&2; }

sync=1
json_out=""
make_from=""
saw_address=0
saw_fixture=0
passthrough=()

# A WSL path is the natural thing to type here and always wrong: everything runs on the
# Windows side, where /mnt/c/... does not exist.
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
    --fixture-make)
      [ $# -ge 2 ] || fail "--fixture-make needs a video file"
      make_from="$(to_windows "$2")"; shift 2 ;;
    --address) saw_address=1; passthrough+=("$1"); shift ;;
    --fixture)
      [ $# -ge 2 ] || fail "--fixture needs a directory"
      saw_fixture=1
      passthrough+=("--fixture" "$(to_windows "$2")"); shift 2 ;;
    *) passthrough+=("$1"); shift ;;
  esac
done

if [ "$saw_address" != "1" ]; then
  [ -n "$DEFAULT_ADDRESS" ] || fail "--address is required (the television's IP, e.g. 192.0.2.10)"
  passthrough+=("--address" "$DEFAULT_ADDRESS")
fi
[ "$saw_fixture" = "1" ] || passthrough+=("--fixture" "$DEFAULT_FIXTURE")

command -v cmd.exe >/dev/null 2>&1 || fail \
  "cmd.exe is not callable from WSL (interop off?). Check /proc/sys/fs/binfmt_misc/WSLInterop."
[ -d /mnt/c ] || fail "/mnt/c is not mounted — this script only makes sense inside WSL2."

# --- Making the fixture, which happens once ----------------------------------------
#
# ffmpeg is used HERE and nowhere else in the spike. The question is about the receiver,
# not about conversion, so the segments are a fixture: made once by hand, then republished
# on a timer as if a conversion were producing them. That keeps ffmpeg, the classifier and
# the tier planner entirely out of the answer.
if [ -n "$make_from" ]; then
  fixture_dir="$DEST/.fixture"
  win_fixture="$WIN_DEST\\.fixture"

  # Resolve ffmpeg to an absolute path rather than trusting PATH.
  #
  # winget's shim lives in %LOCALAPPDATA%\Microsoft\WinGet\Links, which it adds to the
  # *user* PATH — and a cmd.exe launched from WSL inherits the environment as it was when
  # the WSL session started, so a freshly installed ffmpeg is invisible until the terminal
  # is restarted. The first run of this script hits that every time. Finding the .exe is
  # both faster and more honest than telling the founder to open a new terminal.
  find_ffmpeg() {
    local appdata packages link
    appdata="$(wslpath -u "$( cd /mnt/c && cmd.exe /d /c "echo %LOCALAPPDATA%" 2>/dev/null | tr -d '\r' )" 2>/dev/null || true)"
    [ -n "$appdata" ] || return 1
    link="$appdata/Microsoft/WinGet/Links/ffmpeg.exe"
    [ -x "$link" ] && { printf '%s' "$link"; return 0; }
    packages="$(find "$appdata/Microsoft/WinGet/Packages" -maxdepth 4 -name ffmpeg.exe 2>/dev/null | head -1)"
    [ -n "$packages" ] && { printf '%s' "$packages"; return 0; }
    return 1
  }

  ffmpeg_exe="$(find_ffmpeg || true)"
  if [ -z "$ffmpeg_exe" ] && ! ( cd /mnt/c && cmd.exe /d /c "where ffmpeg" >/dev/null 2>&1 ); then
    log "ffmpeg is not installed on Windows. Installing it with winget…"
    log "(this is for the fixture only — it is NOT how M3 will ship ffmpeg)"
    ( cd /mnt/c && cmd.exe /d /c "winget install --id Gyan.FFmpeg -e --accept-source-agreements --accept-package-agreements" ) >&2 \
      || fail "winget could not install ffmpeg. Install it by hand and re-run."
    ffmpeg_exe="$(find_ffmpeg || true)"
  fi
  [ -n "$ffmpeg_exe" ] || fail "ffmpeg is installed but could not be found on disk."
  log "using ffmpeg at $(wslpath -w "$ffmpeg_exe")"

  rm -rf "$fixture_dir"
  mkdir -p "$fixture_dir"
  log "chopping into 4-second segments (stream copy, so this is fast and lossless):"
  log "  $make_from"
  # -c copy: no re-encoding. The segments only have to be *segments*; whether the codec
  # suits the television is M3's classifier problem, not this spike's.
  # Run the Windows .exe **directly from WSL**, not through `cmd.exe /c "…"`.
  #
  # A nested command line — outer quotes around `cd /d X && "C:\path with spaces\ffmpeg.exe"
  # -i "film.mp4"` — is mangled by cmd.exe's own quote handling, which is the same class of
  # fault that broke the elevated firewall command twice (see src/main/main.ts). WSL interop
  # executes Windows binaries directly, so each argument keeps its spaces and there is no
  # second layer of quoting to get wrong. The working directory is a real Windows path
  # under /mnt/c, which interop translates, so ffmpeg writes its segments where we expect.
  ( cd "$fixture_dir" && "$ffmpeg_exe" -hide_banner -loglevel error \
      -i "$make_from" -c copy -f hls -hls_time 4 -hls_list_size 0 \
      -hls_playlist_type vod -hls_segment_filename '%03d.ts' source.m3u8 ) >&2 \
    || fail "ffmpeg could not segment that file."

  count="$(find "$fixture_dir" -name '*.ts' | wc -l)"
  [ "$count" -gt 0 ] || fail "ffmpeg wrote no segments."
  log "fixture ready: $count segments in $win_fixture"
  log "now run:  scripts/spike-m3.sh"
  exit 0
fi

if [ "$sync" = "1" ]; then
  "$HERE/win-sync.sh" >&2 || fail "sync failed — fix that before touching a television"
else
  log "--no-sync: running whatever is already in $WIN_DEST"
fi

[ -d "$DEST/node_modules" ] || fail "no node_modules in $DEST. Run: scripts/win-sync.sh"
[ -f "$DEST/scripts/spike-m3.mjs" ] || fail \
  "the copy in $WIN_DEST has no scripts/spike-m3.mjs — it is out of date. Run: scripts/win-sync.sh"
[ -f "$DEST/.fixture/source.m3u8" ] || fail \
  "no fixture yet. Make one once:  scripts/spike-m3.sh --fixture-make \"C:\\path\\to\\film.mp4\""

# Two rules for every Windows command (CLAUDE.md): never launch cmd.exe from a
# \\wsl.localhost\ path, and work in C:\CastGood.
cwd_seen="$( cd "$DEST" && cmd.exe /d /c cd 2>/dev/null | tr -d '\r' )"
shopt -s nocasematch
[[ "$cwd_seen" == "$WIN_DEST" ]] || fail \
  "Windows commands would run in '${cwd_seen:-nowhere}', not $WIN_DEST — refusing to run."
shopt -u nocasematch

report_file="$(mktemp -t castgood-spike-m3-XXXXXX.json)"
trap 'rm -f "$report_file"' EXIT

log "running SPIKE-1 on Windows ($WIN_DEST):"
log "  node scripts\\spike-m3.mjs ${passthrough[*]}"
log "this drives a real television and takes several minutes. Do not touch the TV."
log "close CastGood first — nothing else should be casting while this runs."

status=0
( cd "$DEST" && cmd.exe /d /c node scripts\\spike-m3.mjs "${passthrough[@]}" ) \
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
  0) printf '\033[32m[spike-m3] RECORDED — findings above; the engine log has every frame (scripts/win-logs.sh)\033[0m\n' >&2 ;;
  2) printf '\033[31m[spike-m3] COULD NOT RUN — nothing was observed\033[0m\n' >&2 ;;
  *) printf '\033[31m[spike-m3] unexpected exit %s — treat as nothing observed\033[0m\n' "$status" >&2 ;;
esac

exit "$status"
